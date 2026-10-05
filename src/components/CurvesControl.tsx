import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { CurvePoint, Curves } from '../types';
import { clamp } from '../utils/math';

interface CurvesControlProps {
  curves: Curves;
  onChange: (curves: Curves) => void;
  isColor: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  compact?: boolean;
  rgbAccent?: string;
}

type Channel = keyof Curves;
const CHANNELS: Channel[] = ['rgb', 'red', 'green', 'blue'];
const CHANNEL_COLORS: Record<Channel, string> = {
  rgb: 'white',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
};
const CHANNEL_LABELS: Record<Channel, string> = { rgb: 'RGB', red: 'Red', green: 'Green', blue: 'Blue' };
const IDENTITY: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

const SIZE = 200;
/** Dragging with Alt/Option held moves the point at this fraction of the pointer. */
const FINE_DRAG_FACTOR = 0.2;
/** Pressing on the graph this close to the curve (in levels) grabs it. */
const GRAB_DISTANCE = 18;
const MORPH_MS = 200;

const toX = (value: number) => (value / 255) * SIZE;
const toY = (value: number) => SIZE - (value / 255) * SIZE;

/** The curve is linear between points, like the pipeline's lookup table. */
function curveValueAt(points: CurvePoint[], x: number) {
  if (points.length === 0) return x;
  if (x <= points[0].x) return points[0].y;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (x <= next.x) {
      const span = next.x - current.x || 1;
      return current.y + ((x - current.x) / span) * (next.y - current.y);
    }
  }
  return points[points.length - 1].y;
}

function buildPath(points: CurvePoint[]) {
  return points.reduce((acc, point, index) => (
    `${acc}${index === 0 ? 'M' : ' L'} ${toX(point.x).toFixed(2)} ${toY(point.y).toFixed(2)}`
  ), '');
}

/**
 * A short morph between two curves: both are sampled on the same x positions
 * (a coarse grid plus every point of either curve), so the end state is the
 * target curve exactly.
 */
function morphCurves(from: CurvePoint[], to: CurvePoint[], t: number): CurvePoint[] {
  const xs = new Set<number>();
  for (let x = 0; x <= 255; x += 15) xs.add(x);
  from.forEach((point) => xs.add(point.x));
  to.forEach((point) => xs.add(point.x));
  return Array.from(xs)
    .sort((left, right) => left - right)
    .map((x) => {
      const start = curveValueAt(from, x);
      return { x, y: start + (curveValueAt(to, x) - start) * t };
    });
}

function samePoints(left: CurvePoint[], right: CurvePoint[]) {
  return left === right || (left.length === right.length
    && left.every((point, index) => point.x === right[index].x && point.y === right[index].y));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keeps the drawn curve gliding to its new shape when it changes outside a
 * drag (reset, undo, presets, auto, switching channel). Drags draw directly.
 */
function useMorphedPoints(target: CurvePoint[], instant: boolean) {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const from = shownRef.current;
    if (instant || samePoints(from, target) || prefersReducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const progress = clamp((now - start) / MORPH_MS, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      const next = progress >= 1 ? target : morphCurves(from, target, eased);
      shownRef.current = next;
      setShown(next);
      frameRef.current = progress >= 1 ? null : window.requestAnimationFrame(step);
    };
    frameRef.current = window.requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [instant, target]);

  return shown;
}

function movePoint(points: CurvePoint[], index: number, x: number, y: number): CurvePoint[] {
  const next = [...points];
  const last = points.length - 1;
  const minX = index === 0 ? 0 : points[index - 1].x + 1;
  const maxX = index === last ? 255 : points[index + 1].x - 1;
  next[index] = {
    x: clamp(Math.round(x), minX, maxX),
    y: clamp(Math.round(y), 0, 255),
  };
  return next;
}

interface DragState {
  index: number;
  pointerX: number;
  pointerY: number;
  pointX: number;
  pointY: number;
  fine: boolean;
}

export const CurvesControl = memo(function CurvesControl({
  curves,
  onChange,
  isColor,
  onInteractionStart,
  onInteractionEnd,
  compact = false,
  rgbAccent = 'white',
}: CurvesControlProps) {
  const [activeChannel, setActiveChannel] = useState<Channel>('rgb');
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [draftCurves, setDraftCurves] = useState(curves);
  const svgRef = useRef<SVGSVGElement>(null);
  const draftCurvesRef = useRef(curves);
  const onChangeRef = useRef(onChange);
  const onInteractionEndRef = useRef(onInteractionEnd);
  const draggingPointRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingCurvesRef = useRef<Curves | null>(null);
  const changeFrameRef = useRef<number | null>(null);

  onChangeRef.current = onChange;
  onInteractionEndRef.current = onInteractionEnd;
  draggingPointRef.current = draggingPoint;

  const points = draftCurves[activeChannel];
  const gridPositions = useMemo(() => [SIZE / 4, SIZE / 2, (SIZE * 3) / 4], []);

  useEffect(() => {
    if (draggingPoint === null && pendingCurvesRef.current === null) {
      draftCurvesRef.current = curves;
      setDraftCurves(curves);
    }
  }, [curves, draggingPoint]);

  // A selection that no longer exists (point removed, curve reset) clears.
  useEffect(() => {
    if (selectedPoint !== null && selectedPoint >= points.length) setSelectedPoint(null);
  }, [points.length, selectedPoint]);

  const flushPendingChange = useCallback(() => {
    if (changeFrameRef.current !== null) {
      window.cancelAnimationFrame(changeFrameRef.current);
      changeFrameRef.current = null;
    }
    const pendingCurves = pendingCurvesRef.current;
    pendingCurvesRef.current = null;
    if (pendingCurves) onChangeRef.current(pendingCurves);
  }, []);

  // The curve redraws on every pointer move; the image update is coalesced
  // to one per frame.
  const scheduleChange = useCallback((nextCurves: Curves) => {
    draftCurvesRef.current = nextCurves;
    setDraftCurves(nextCurves);
    pendingCurvesRef.current = nextCurves;
    if (changeFrameRef.current !== null) return;

    changeFrameRef.current = window.requestAnimationFrame(() => {
      changeFrameRef.current = null;
      const pendingCurves = pendingCurvesRef.current;
      pendingCurvesRef.current = null;
      if (pendingCurves) onChangeRef.current(pendingCurves);
    });
  }, []);

  const commitChange = useCallback((nextCurves: Curves) => {
    pendingCurvesRef.current = nextCurves;
    draftCurvesRef.current = nextCurves;
    setDraftCurves(nextCurves);
    flushPendingChange();
  }, [flushPendingChange]);

  const toCurveSpace = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * 255,
      y: 255 - ((clientY - rect.top) / rect.height) * 255,
      scaleX: 255 / rect.width,
      scaleY: 255 / rect.height,
    };
  }, []);

  const startDrag = useCallback((index: number, event: React.PointerEvent | React.MouseEvent, pointsAtStart: CurvePoint[]) => {
    onInteractionStart?.();
    dragRef.current = {
      index,
      pointerX: event.clientX,
      pointerY: event.clientY,
      pointX: pointsAtStart[index].x,
      pointY: pointsAtStart[index].y,
      fine: event.altKey,
    };
    setSelectedPoint(index);
    setDraggingPoint(index);
  }, [onInteractionStart]);

  const handlePointerMove = useCallback((event: PointerEvent | MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const space = toCurveSpace(event.clientX, event.clientY);
    if (!space) return;

    // Alt/Option switches to fine moves from where the point is now, so
    // pressing or releasing it mid-drag never makes the point jump.
    if (event.altKey !== drag.fine) {
      const current = draftCurvesRef.current[activeChannel][drag.index];
      drag.pointerX = event.clientX;
      drag.pointerY = event.clientY;
      drag.pointX = current.x;
      drag.pointY = current.y;
      drag.fine = event.altKey;
    }

    const factor = drag.fine ? FINE_DRAG_FACTOR : 1;
    const x = drag.pointX + (event.clientX - drag.pointerX) * space.scaleX * factor;
    let y = drag.pointY - (event.clientY - drag.pointerY) * space.scaleY * factor;
    if (event.shiftKey) {
      y = Math.round(y / 16) * 16;
    }

    const currentCurves = draftCurvesRef.current;
    scheduleChange({
      ...currentCurves,
      [activeChannel]: movePoint(currentCurves[activeChannel], drag.index, x, y),
    });
  }, [activeChannel, scheduleChange, toCurveSpace]);

  // The parent commits history from its current render, so after flushing
  // the last coalesced change the interaction must end once that change has
  // rendered. Ending it immediately would record the previous frame.
  const pendingEndRef = useRef(false);
  const endTimerRef = useRef<number | null>(null);
  const finishInteraction = useCallback(() => {
    if (!pendingEndRef.current) return;
    pendingEndRef.current = false;
    if (endTimerRef.current !== null) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    onInteractionEndRef.current?.();
  }, []);

  useEffect(() => {
    finishInteraction();
  }, [curves, finishInteraction]);

  const endInteraction = useCallback(() => {
    const hadPendingChange = pendingCurvesRef.current !== null;
    pendingEndRef.current = true;
    flushPendingChange();
    if (!hadPendingChange) {
      finishInteraction();
      return;
    }
    // Fallback if the parent ignores the change and never re-renders.
    endTimerRef.current = window.setTimeout(() => {
      endTimerRef.current = null;
      finishInteraction();
    }, 0);
  }, [finishInteraction, flushPendingChange]);

  const handlePointerUp = useCallback(() => {
    // pointerup and mouseup both arrive; only the first ends the drag.
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingPoint(null);
    endInteraction();
  }, [endInteraction]);

  useEffect(() => {
    if (draggingPoint === null) return undefined;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    };
  }, [draggingPoint, handlePointerMove, handlePointerUp]);

  useEffect(() => () => {
    if (endTimerRef.current !== null) {
      window.clearTimeout(endTimerRef.current);
    }
    if (changeFrameRef.current !== null) {
      window.cancelAnimationFrame(changeFrameRef.current);
      changeFrameRef.current = null;
    }
    pendingCurvesRef.current = null;
    if (draggingPointRef.current !== null) onInteractionEndRef.current?.();
  }, []);

  const insertPoint = useCallback((x: number, y: number) => {
    const currentPoints = draftCurvesRef.current[activeChannel];
    const roundedX = Math.round(x);
    for (let index = 0; index < currentPoints.length - 1; index += 1) {
      if (roundedX > currentPoints[index].x && roundedX < currentPoints[index + 1].x) {
        const nextPoints = [...currentPoints];
        nextPoints.splice(index + 1, 0, { x: roundedX, y: clamp(Math.round(y), 0, 255) });
        return { nextPoints, index: index + 1 };
      }
    }
    return null;
  }, [activeChannel]);

  // Pressing on the curve grabs it: a point is added there and follows the
  // pointer straight away.
  const handleSurfacePointerDown = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    const space = toCurveSpace(event.clientX, event.clientY);
    if (!space) return;
    const onCurve = curveValueAt(points, space.x);
    if (Math.abs(onCurve - space.y) > GRAB_DISTANCE) {
      setSelectedPoint(null);
      return;
    }
    const inserted = insertPoint(space.x, onCurve);
    if (!inserted) return;
    event.preventDefault();
    const nextCurves = { ...draftCurvesRef.current, [activeChannel]: inserted.nextPoints };
    draftCurvesRef.current = nextCurves;
    setDraftCurves(nextCurves);
    startDrag(inserted.index, event, inserted.nextPoints);
    scheduleChange(nextCurves);
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    const space = toCurveSpace(event.clientX, event.clientY);
    if (!space) return;
    const inserted = insertPoint(space.x, space.y);
    if (!inserted) return;
    commitChange({ ...draftCurvesRef.current, [activeChannel]: inserted.nextPoints });
    setSelectedPoint(inserted.index);
  };

  const removePoint = useCallback((index: number) => {
    const currentPoints = draftCurvesRef.current[activeChannel];
    if (index === 0 || index === currentPoints.length - 1) return;
    const nextPoints = [...currentPoints];
    nextPoints.splice(index, 1);
    onInteractionStart?.();
    commitChange({ ...draftCurvesRef.current, [activeChannel]: nextPoints });
    pendingEndRef.current = true;
    endTimerRef.current = window.setTimeout(() => {
      endTimerRef.current = null;
      finishInteraction();
    }, 0);
    setSelectedPoint(null);
  }, [activeChannel, commitChange, finishInteraction, onInteractionStart]);

  // Keyboard and field edits record one history step each.
  const setPointValue = useCallback((index: number, x: number, y: number) => {
    const currentPoints = draftCurvesRef.current[activeChannel];
    if (!currentPoints[index]) return;
    const nextPoints = movePoint(currentPoints, index, x, y);
    if (nextPoints[index].x === currentPoints[index].x && nextPoints[index].y === currentPoints[index].y) return;
    onInteractionStart?.();
    commitChange({ ...draftCurvesRef.current, [activeChannel]: nextPoints });
    pendingEndRef.current = true;
    endTimerRef.current = window.setTimeout(() => {
      endTimerRef.current = null;
      finishInteraction();
    }, 0);
  }, [activeChannel, commitChange, finishInteraction, onInteractionStart]);

  const handlePointKeyDown = (index: number, event: React.KeyboardEvent) => {
    const point = points[index];
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setPointValue(index, point.x + move[0], point.y + move[1]);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removePoint(index);
    }
  };

  const resetChannel = () => {
    onInteractionStart?.();
    commitChange({ ...draftCurvesRef.current, [activeChannel]: IDENTITY });
    pendingEndRef.current = true;
    endTimerRef.current = window.setTimeout(() => {
      endTimerRef.current = null;
      finishInteraction();
    }, 0);
    setSelectedPoint(null);
  };

  const shownPoints = useMorphedPoints(points, draggingPoint !== null);
  const pathData = useMemo(() => buildPath(shownPoints), [shownPoints]);
  const activeColor = activeChannel === 'rgb' ? rgbAccent : CHANNEL_COLORS[activeChannel];
  const isIdentity = points.length === 2
    && points[0].x === 0 && points[0].y === 0 && points[1].x === 255 && points[1].y === 255;
  const focusPoint = draggingPoint ?? selectedPoint;
  const focused = focusPoint !== null ? points[focusPoint] : null;
  const readoutX = focused ? focused.x : hoverX;
  const readoutY = focused ? focused.y : hoverX !== null ? Math.round(curveValueAt(points, hoverX)) : null;

  return (
    <div className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-3'}`}>
      <div className={`flex gap-1 ${compact ? '' : 'rounded-lg border border-zinc-800 bg-zinc-900/40 p-1'}`}>
        {CHANNELS.map((channel) => {
          if (!isColor && channel !== 'rgb') return null;
          const active = activeChannel === channel;
          return (
            <button
              key={channel}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setActiveChannel(channel);
                setSelectedPoint(null);
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md ${compact ? 'py-1' : 'py-1.5'} text-[10px] uppercase tracking-widest transition-colors duration-150 ${
                active ? (compact ? 'bg-accent-400 text-zinc-950' : 'bg-zinc-100 text-zinc-950') : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
              }`}
            >
              {channel !== 'rgb' && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CHANNEL_COLORS[channel] }} />}
              {channel}
            </button>
          );
        })}
      </div>

      <div className={`group relative w-full select-none overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${compact ? 'aspect-[2.15/1]' : 'aspect-square'}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          preserveAspectRatio={compact ? 'none' : undefined}
          className="h-full w-full touch-none select-none"
          style={{ cursor: draggingPoint !== null ? 'grabbing' : 'crosshair' }}
          onPointerDown={handleSurfacePointerDown}
          onDoubleClick={handleDoubleClick}
          onPointerMove={(event) => {
            if (dragRef.current) return;
            const space = toCurveSpace(event.clientX, event.clientY);
            setHoverX(space ? clamp(Math.round(space.x), 0, 255) : null);
          }}
          onPointerLeave={() => setHoverX(null)}
        >
          {gridPositions.map((position) => (
            <React.Fragment key={position}>
              <line x1="0" y1={position} x2={SIZE} y2={position} stroke="#27272a" strokeWidth="1" />
              <line x1={position} y1="0" x2={position} y2={SIZE} stroke="#27272a" strokeWidth="1" />
            </React.Fragment>
          ))}
          <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="#3f3f46" strokeWidth="1" strokeDasharray="2 3" />

          {activeChannel !== 'rgb' && (Object.entries(draftCurves) as [Channel, CurvePoint[]][]).map(([channel, channelPoints]) => {
            if (channel === 'rgb' || channel === activeChannel) return null;
            return (
              <path key={channel} d={buildPath(channelPoints)} fill="none" stroke={CHANNEL_COLORS[channel]} strokeWidth="1" opacity="0.18" />
            );
          })}

          {/* Guides from the point being moved (or hovered) to both axes. */}
          {readoutX !== null && readoutY !== null && (
            <g className="pointer-events-none" opacity={focused ? 0.55 : 0.3}>
              <line x1={toX(readoutX)} y1={toY(readoutY)} x2={toX(readoutX)} y2={SIZE} stroke={activeColor} strokeWidth="0.75" strokeDasharray="2 2" />
              <line x1="0" y1={toY(readoutY)} x2={toX(readoutX)} y2={toY(readoutY)} stroke={activeColor} strokeWidth="0.75" strokeDasharray="2 2" />
            </g>
          )}

          {/* A soft glow under the curve while it is being shaped. */}
          <path
            d={pathData}
            fill="none"
            stroke={activeColor}
            strokeWidth="6"
            strokeLinejoin="round"
            className="pointer-events-none transition-opacity duration-200"
            opacity={draggingPoint !== null ? 0.18 : 0}
          />
          <path
            d={pathData}
            fill="none"
            stroke={activeColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="pointer-events-none"
          />

          {points.map((point, index) => {
            const active = draggingPoint === index;
            const selected = selectedPoint === index;
            return (
              <g
                key={index}
                style={{
                  transform: `translate(${toX(point.x)}px, ${toY(point.y)}px)`,
                  transition: draggingPoint !== null ? 'none' : `transform ${MORPH_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                }}
              >
                <circle
                  r={12}
                  fill="transparent"
                  tabIndex={0}
                  role="slider"
                  aria-label={`${CHANNEL_LABELS[activeChannel]} curve point ${index + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={255}
                  aria-valuenow={point.y}
                  aria-valuetext={`Input ${point.x}, output ${point.y}`}
                  className="cursor-grab outline-none"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    event.preventDefault();
                    startDrag(index, event, points);
                  }}
                  onMouseDown={(event) => {
                    // Pointer events start the drag; this keeps environments
                    // that only send mouse events working.
                    if (event.button !== 0 || dragRef.current) return;
                    event.stopPropagation();
                    startDrag(index, event, points);
                  }}
                  onFocus={() => setSelectedPoint(index)}
                  onKeyDown={(event) => handlePointKeyDown(index, event)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    removePoint(index);
                  }}
                />
                <circle
                  r={selected || active ? 9 : 0}
                  fill={activeColor}
                  opacity={0.18}
                  className="pointer-events-none transition-[r] duration-150"
                />
                <circle
                  r={active ? 6 : selected ? 5.5 : 4.5}
                  fill={selected || active ? activeColor : '#09090b'}
                  stroke={activeColor}
                  strokeWidth="2"
                  className="pointer-events-none transition-[r,fill] duration-150"
                />
              </g>
            );
          })}
        </svg>

        <div className="pointer-events-none absolute right-2 top-2 select-none opacity-0 transition-opacity group-hover:opacity-100">
          <span className="select-none whitespace-nowrap rounded border border-zinc-800 bg-zinc-950/80 px-1.5 py-0.5 text-[9px] text-zinc-500">
            Drag the curve to add a point · ⌥ fine · right-click removes
          </span>
        </div>
      </div>

      {!compact && (
        <div className="flex items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1.5 text-zinc-500">
            In
            <input
              type="number"
              aria-label="Point input"
              min={0}
              max={255}
              disabled={selectedPoint === null}
              value={focused ? focused.x : readoutX ?? ''}
              onChange={(event) => {
                if (selectedPoint === null || event.target.value === '') return;
                setPointValue(selectedPoint, Number(event.target.value), points[selectedPoint].y);
              }}
              className="w-12 rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-200 outline-none transition-colors focus:border-zinc-500 disabled:text-zinc-500"
            />
          </label>
          <label className="flex items-center gap-1.5 text-zinc-500">
            Out
            <input
              type="number"
              aria-label="Point output"
              min={0}
              max={255}
              disabled={selectedPoint === null}
              value={focused ? focused.y : readoutY ?? ''}
              onChange={(event) => {
                if (selectedPoint === null || event.target.value === '') return;
                setPointValue(selectedPoint, points[selectedPoint].x, Number(event.target.value));
              }}
              className="w-12 rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-200 outline-none transition-colors focus:border-zinc-500 disabled:text-zinc-500"
            />
          </label>
          <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-600">
            {selectedPoint !== null ? 'Arrows nudge, ⇧ ×10' : 'Click a point to edit it'}
          </span>
          <button
            type="button"
            onClick={resetChannel}
            disabled={isIdentity}
            aria-label={`Reset ${CHANNEL_LABELS[activeChannel]} curve`}
            data-tip={`Reset ${CHANNEL_LABELS[activeChannel]} curve`}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      )}
    </div>
  );
});
