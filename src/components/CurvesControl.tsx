import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const CHANNEL_COLORS: Record<Channel, string> = {
  rgb: 'white',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
};

function buildPath(channelPoints: CurvePoint[], size: number) {
  return channelPoints.reduce((acc, point, index) => {
    const pointX = (point.x / 255) * size;
    const pointY = size - (point.y / 255) * size;
    return acc + (index === 0 ? `M ${pointX} ${pointY}` : ` L ${pointX} ${pointY}`);
  }, '');
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
  const [draftCurves, setDraftCurves] = useState(curves);
  const svgRef = useRef<SVGSVGElement>(null);
  const draftCurvesRef = useRef(curves);
  const onChangeRef = useRef(onChange);
  const onInteractionEndRef = useRef(onInteractionEnd);
  const draggingPointRef = useRef<number | null>(null);
  const pendingCurvesRef = useRef<Curves | null>(null);
  const changeFrameRef = useRef<number | null>(null);

  onChangeRef.current = onChange;
  onInteractionEndRef.current = onInteractionEnd;
  draggingPointRef.current = draggingPoint;

  const points = draftCurves[activeChannel];
  const size = 200;
  const gridPositions = useMemo(() => [size / 4, size / 2, (size * 3) / 4], [size]);

  useEffect(() => {
    if (draggingPoint === null && pendingCurvesRef.current === null) {
      draftCurvesRef.current = curves;
      setDraftCurves(curves);
    }
  }, [curves, draggingPoint]);

  const flushPendingChange = useCallback(() => {
    if (changeFrameRef.current !== null) {
      window.cancelAnimationFrame(changeFrameRef.current);
      changeFrameRef.current = null;
    }
    const pendingCurves = pendingCurvesRef.current;
    pendingCurvesRef.current = null;
    if (pendingCurves) onChangeRef.current(pendingCurves);
  }, []);

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

  const handleMouseDown = (index: number) => {
    onInteractionStart?.();
    setDraggingPoint(index);
  };

  const handleMouseMove = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (draggingPoint === null || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = clamp(Math.round(((e.clientX - rect.left) / rect.width) * 255), 0, 255);
    let y = clamp(Math.round(255 - ((e.clientY - rect.top) / rect.height) * 255), 0, 255);
    if (e.shiftKey) {
      y = clamp(Math.round(y / 16) * 16, 0, 255);
    }

    const currentCurves = draftCurvesRef.current;
    const currentPoints = currentCurves[activeChannel];
    const newPoints = [...currentPoints];

    if (draggingPoint === 0) {
      newPoints[0] = {
        x: clamp(x, 0, newPoints[1].x - 1),
        y,
      };
    } else if (draggingPoint === currentPoints.length - 1) {
      newPoints[currentPoints.length - 1] = {
        x: clamp(x, newPoints[draggingPoint - 1].x + 1, 255),
        y,
      };
    } else {
      const prevX = currentPoints[draggingPoint - 1].x;
      const nextX = currentPoints[draggingPoint + 1].x;
      newPoints[draggingPoint] = { x: clamp(x, prevX + 1, nextX - 1), y };
    }

    scheduleChange({ ...currentCurves, [activeChannel]: newPoints });
  }, [activeChannel, draggingPoint, scheduleChange]);

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

  const handleMouseUp = useCallback(() => {
    const hadPendingChange = pendingCurvesRef.current !== null;
    pendingEndRef.current = true;
    flushPendingChange();
    setDraggingPoint(null);
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

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 255);
    const y = Math.round(255 - ((e.clientY - rect.top) / rect.height) * 255);

    // Find where to insert
    let insertIndex = -1;
    for (let i = 0; i < points.length - 1; i++) {
      if (x > points[i].x && x < points[i + 1].x) {
        insertIndex = i + 1;
        break;
      }
    }

    if (insertIndex !== -1) {
      const newPoints = [...points];
      newPoints.splice(insertIndex, 0, { x, y });
      commitChange({ ...draftCurvesRef.current, [activeChannel]: newPoints });
    }
  };

  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) return;
    const newPoints = [...points];
    newPoints.splice(index, 1);
    commitChange({ ...draftCurvesRef.current, [activeChannel]: newPoints });
  };

  useEffect(() => {
    if (draggingPoint !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingPoint, handleMouseMove, handleMouseUp]);

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

  const pathData = useMemo(() => buildPath(points, size), [points, size]);

  const activeColor = activeChannel === 'rgb' ? rgbAccent : CHANNEL_COLORS[activeChannel];

  return (
    <div className={`flex flex-col ${compact ? 'gap-1.5' : 'gap-4'}`}>
      <div className={`flex gap-1 ${compact ? '' : 'rounded-lg border border-zinc-800 bg-zinc-900/40 p-1'}`}>
        {(['rgb', 'red', 'green', 'blue'] as Channel[]).map((ch) => {
          if (!isColor && ch !== 'rgb') return null;
          return (
            <button
              key={ch}
              onClick={() => setActiveChannel(ch)}
              className={`flex-1 rounded-md ${compact ? 'py-1' : 'py-1.5'} text-[10px] uppercase tracking-widest transition-all ${
                activeChannel === ch ? (compact ? 'bg-accent-400 text-zinc-950' : 'bg-zinc-100 text-zinc-950') : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
              }`}
            >
              {ch}
            </button>
          );
        })}
      </div>

      <div className={`group relative w-full select-none overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${compact ? 'aspect-[2.15/1]' : 'aspect-square'}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size} ${size}`}
          preserveAspectRatio={compact ? 'none' : undefined}
          className="w-full h-full cursor-crosshair select-none"
          onDoubleClick={handleDoubleClick}
        >
          {/* Grid */}
          {gridPositions.map((position) => (
            <React.Fragment key={position}>
              <line x1="0" y1={position} x2={size} y2={position} stroke="#27272a" strokeWidth="1" />
              <line x1={position} y1="0" x2={position} y2={size} stroke="#27272a" strokeWidth="1" />
            </React.Fragment>
          ))}

          {/* Curve Path */}
          <path
            d={pathData}
            fill="none"
            stroke={activeColor}
            strokeWidth="2"
            className="transition-colors duration-300"
          />

          {activeChannel !== 'rgb' && (Object.entries(draftCurves) as [Channel, CurvePoint[]][]).map(([channel, channelPoints]) => {
            if (channel === 'rgb' || channel === activeChannel) {
              return null;
            }

            return (
              <path
                key={channel}
                d={buildPath(channelPoints, size)}
                fill="none"
                stroke={CHANNEL_COLORS[channel]}
                strokeWidth="1"
                opacity="0.15"
              />
            );
          })}

          {/* Points */}
          {points.map((p, i) => (
            <g key={i}>
              <circle
                cx={(p.x / 255) * size}
                cy={size - (p.y / 255) * size}
                r={12}
                fill="transparent"
                className="cursor-pointer"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleMouseDown(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  removePoint(i);
                }}
              />
              <circle
                cx={(p.x / 255) * size}
                cy={size - (p.y / 255) * size}
                r={draggingPoint === i ? 7 : 5}
                fill={activeColor}
                stroke="#09090b"
                strokeWidth="2"
                className="pointer-events-none transition-all"
              />
            </g>
          ))}

          {draggingPoint !== null && (
            <text
              x={Math.min(size - 4, ((points[draggingPoint].x / 255) * size) + 8)}
              y={Math.max(12, size - ((points[draggingPoint].y / 255) * size) - 8)}
              fill="white"
              fontSize="10"
              className="pointer-events-none select-none"
            >
              {points[draggingPoint].x}, {points[draggingPoint].y}
            </text>
          )}
        </svg>
        
        <div className="pointer-events-none absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 select-none">
          <span className="select-none text-[9px] text-zinc-600 bg-zinc-950/80 px-1.5 py-0.5 rounded border border-zinc-800">
            Double-click to add point • Right-click to remove
          </span>
        </div>
      </div>
    </div>
  );
});
