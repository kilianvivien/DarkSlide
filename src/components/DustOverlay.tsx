import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversionSettings, DustMark, PathDustMark } from '../types';
import { getDustGeometry, projectDustMarkFromTransformedSpace, projectDustMarksToTransformedSpace } from '../utils/dustGeometry';

interface DustOverlayProps {
  settings: ConversionSettings;
  sourceWidth: number;
  sourceHeight: number;
  brushActive: boolean;
  marks: DustMark[];
  manualBrushRadiusPx: number;
  selectedMarkId: string | null;
  onSelectedMarkIdChange: (markId: string | null) => void;
  onChange: (marks: DustMark[]) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type DragState =
  | { mode: 'paint' }
  | { mode: 'move'; markId: string };

function distancePointToSegment(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  const dx = endX - startX;
  const dy = endY - startY;
  if (dx === 0 && dy === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const t = Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy)));
  const projX = startX + dx * t;
  const projY = startY + dy * t;
  return Math.hypot(pointX - projX, pointY - projY);
}

function distancePointToPath(point: { x: number; y: number }, mark: PathDustMark) {
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < mark.points.length; index += 1) {
    bestDistance = Math.min(
      bestDistance,
      distancePointToSegment(
        point.x,
        point.y,
        mark.points[index - 1].x,
        mark.points[index - 1].y,
        mark.points[index].x,
        mark.points[index].y,
      ),
    );
  }
  return bestDistance;
}

function buildPath(mark: PathDustMark) {
  return mark.points.map((point) => `${point.x},${point.y}`).join(' ');
}

export const DustOverlay = memo(function DustOverlay({
  settings,
  sourceWidth,
  sourceHeight,
  brushActive,
  marks,
  manualBrushRadiusPx,
  selectedMarkId,
  onSelectedMarkIdChange,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: DustOverlayProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const pendingMarksRef = useRef<DustMark[] | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const lastPaintPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null);
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null);
  const transformedMarks = useMemo(
    () => projectDustMarksToTransformedSpace(marks, settings, sourceWidth, sourceHeight),
    [marks, settings, sourceHeight, sourceWidth],
  );
  const geometry = useMemo(
    () => getDustGeometry(settings, sourceWidth, sourceHeight),
    [settings, sourceHeight, sourceWidth],
  );
  const currentBrushRadius = manualBrushRadiusPx / geometry.transformedDiagonal;

  const flushPending = useCallback(() => {
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
    if (pendingMarksRef.current) {
      onChange(pendingMarksRef.current);
      pendingMarksRef.current = null;
    }
  }, [onChange]);

  const getLatestMarks = useCallback(() => pendingMarksRef.current ?? marks, [marks]);

  const scheduleMarksChange = useCallback((nextMarks: DustMark[]) => {
    pendingMarksRef.current = nextMarks;
    if (frameRequestRef.current !== null) {
      return;
    }

    frameRequestRef.current = window.requestAnimationFrame(() => {
      frameRequestRef.current = null;
      if (pendingMarksRef.current) {
        onChange(pendingMarksRef.current);
        pendingMarksRef.current = null;
      }
    });
  }, [onChange]);

  const mutateMarks = useCallback((updater: (current: DustMark[]) => DustMark[]) => {
    scheduleMarksChange(updater(getLatestMarks()));
  }, [getLatestMarks, scheduleMarksChange]);

  const getNormalizedPoint = useCallback((clientX: number, clientY: number) => {
    const frame = frameRef.current;
    if (!frame) {
      return null;
    }

    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }, []);

  const getLatestTransformedMarks = useCallback(() => (
    projectDustMarksToTransformedSpace(getLatestMarks(), settings, sourceWidth, sourceHeight)
  ), [getLatestMarks, settings, sourceHeight, sourceWidth]);

  const findMarkAtPoint = useCallback((point: { x: number; y: number }) => {
    let bestMatch: { mark: DustMark; score: number } | null = null;

    for (const mark of getLatestTransformedMarks()) {
      const distance = mark.kind === 'path'
        ? distancePointToPath(point, mark)
        : Math.hypot(point.x - mark.cx, point.y - mark.cy);
      const effectiveRadius = mark.radius * (mark.kind === 'path' ? 1.2 : 1);
      const score = distance / Math.max(effectiveRadius, 0.001);
      if (score > 1) {
        continue;
      }
      if (!bestMatch || score < bestMatch.score) {
        bestMatch = { mark, score };
      }
    }

    return bestMatch?.mark ?? null;
  }, [getLatestTransformedMarks]);

  const upsertManualMarkAtPoint = useCallback((point: { x: number; y: number }) => {
    const lastPaintPoint = lastPaintPointRef.current;
    const minSpacing = Math.max(currentBrushRadius * 0.28, 0.0015);
    if (lastPaintPoint && Math.hypot(point.x - lastPaintPoint.x, point.y - lastPaintPoint.y) < minSpacing) {
      return;
    }

    const nextMark = projectDustMarkFromTransformedSpace({
      id: `dust-manual-${crypto.randomUUID()}`,
      kind: 'spot',
      cx: point.x,
      cy: point.y,
      radius: currentBrushRadius * 1.18,
      source: 'manual',
    }, settings, sourceWidth, sourceHeight);
    lastPaintPointRef.current = point;
    onSelectedMarkIdChange(nextMark.id);
    mutateMarks((current) => [...current, nextMark]);
  }, [currentBrushRadius, mutateMarks, onSelectedMarkIdChange, settings, sourceHeight, sourceWidth]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const point = getNormalizedPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      setHoverPoint(point);
      setHoveredMarkId(findMarkAtPoint(point)?.id ?? null);
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      if (dragState.mode === 'paint') {
        upsertManualMarkAtPoint(point);
        return;
      }

      const targetMark = getLatestTransformedMarks().find((mark) => mark.id === dragState.markId);
      if (!targetMark || targetMark.kind !== 'spot') {
        return;
      }

      const nextMark = projectDustMarkFromTransformedSpace({
        ...targetMark,
        cx: point.x,
        cy: point.y,
      }, settings, sourceWidth, sourceHeight);

      mutateMarks((current) => current.map((mark) => (mark.id === dragState.markId ? nextMark : mark)));
    };

    const handleUp = () => {
      if (!dragStateRef.current) {
        return;
      }
      flushPending();
      dragStateRef.current = null;
      lastPaintPointRef.current = null;
      onInteractionEnd?.();
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [
    findMarkAtPoint,
    flushPending,
    getLatestTransformedMarks,
    getNormalizedPoint,
    mutateMarks,
    onInteractionEnd,
    settings,
    sourceHeight,
    sourceWidth,
    upsertManualMarkAtPoint,
  ]);

  useEffect(() => () => {
    flushPending();
  }, [flushPending]);

  const handleOverlayMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const point = getNormalizedPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    const hitMark = findMarkAtPoint(point);
    if (hitMark) {
      onSelectedMarkIdChange(hitMark.source === 'manual' ? hitMark.id : null);

      if (event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        onInteractionStart?.();
        onChange(getLatestMarks().filter((mark) => mark.id !== hitMark.id));
        onInteractionEnd?.();
        return;
      }

      if (brushActive && event.button === 0 && hitMark.source === 'manual' && hitMark.kind === 'spot') {
        event.preventDefault();
        event.stopPropagation();
        onInteractionStart?.();
        dragStateRef.current = { mode: 'move', markId: hitMark.id };
      }
      return;
    }

    onSelectedMarkIdChange(null);

    if (!brushActive || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onInteractionStart?.();
    dragStateRef.current = { mode: 'paint' };
    lastPaintPointRef.current = null;
    upsertManualMarkAtPoint(point);
  }, [
    brushActive,
    findMarkAtPoint,
    getLatestMarks,
    getNormalizedPoint,
    onChange,
    onInteractionEnd,
    onInteractionStart,
    onSelectedMarkIdChange,
    upsertManualMarkAtPoint,
  ]);

  const handleOverlayContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!brushActive) {
      return;
    }

    event.preventDefault();
    const point = getNormalizedPoint(event.clientX, event.clientY);
    const hitMark = point ? findMarkAtPoint(point) : null;
    if (!hitMark || hitMark.source !== 'manual') {
      return;
    }

    onInteractionStart?.();
    onChange(getLatestMarks().filter((mark) => mark.id !== hitMark.id));
    if (selectedMarkId === hitMark.id) {
      onSelectedMarkIdChange(null);
    }
    onInteractionEnd?.();
  }, [brushActive, findMarkAtPoint, getLatestMarks, getNormalizedPoint, onChange, onInteractionEnd, onInteractionStart, onSelectedMarkIdChange, selectedMarkId]);

  return (
    <div
      ref={frameRef}
      data-testid="dust-overlay"
      className={`absolute inset-0 ${brushActive ? 'cursor-none' : 'pointer-events-auto'}`}
      onMouseDown={handleOverlayMouseDown}
      onMouseMove={(event) => {
        const point = getNormalizedPoint(event.clientX, event.clientY);
        setHoverPoint(point);
        setHoveredMarkId(point ? findMarkAtPoint(point)?.id ?? null : null);
      }}
      onMouseLeave={() => {
        setHoverPoint(null);
        setHoveredMarkId(null);
      }}
      onContextMenu={handleOverlayContextMenu}
    >
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <defs>
          <filter id="dust-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="0.003" floodColor="rgba(0,0,0,0.6)" />
          </filter>
        </defs>
        {transformedMarks.map((mark) => {
          const isAuto = mark.source === 'auto';
          const isSelected = mark.id === selectedMarkId;
          const isHovered = mark.id === hoveredMarkId;
          const stroke = isSelected
            ? 'rgba(250,204,21,0.95)'
            : (isAuto ? 'rgba(125,211,252,0.85)' : 'rgba(252,165,165,0.8)');
          const fill = isAuto ? 'rgba(125,211,252,0.12)' : 'none';
          const strokeWidth = mark.kind === 'path'
            ? `${Math.max(mark.radius * 2, 0.0024)}`
            : (isSelected ? '0.0022' : (isAuto ? '0.002' : '0.0014'));

          if (mark.kind === 'path') {
            return (
              <polyline
                key={mark.id}
                points={buildPath(mark)}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={isAuto ? '0.012 0.008' : undefined}
                vectorEffect="non-scaling-stroke"
                opacity={isHovered ? 1 : 0.92}
                filter="url(#dust-shadow)"
              />
            );
          }

          return (
            <circle
              key={mark.id}
              cx={mark.cx}
              cy={mark.cy}
              r={mark.radius}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={isAuto ? '0.008 0.005' : undefined}
              vectorEffect="non-scaling-stroke"
              opacity={isHovered ? 1 : 0.92}
              filter="url(#dust-shadow)"
            />
          );
        })}
      </svg>

      {brushActive && hoverPoint && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${hoverPoint.x * 100}%`,
            top: `${hoverPoint.y * 100}%`,
            width: `${currentBrushRadius * 200}%`,
            height: `${currentBrushRadius * 200}%`,
            border: '1px solid rgba(255,255,255,0.8)',
            boxShadow: '0 0 0 0.5px rgba(0,0,0,0.5)',
          }}
        >
          <div className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" style={{ boxShadow: '0 0 0 0.5px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  );
});
