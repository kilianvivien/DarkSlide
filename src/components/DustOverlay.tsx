import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversionSettings, DustMark } from '../types';
import { getDustGeometry, projectDustMarkFromTransformedSpace, projectDustMarksToTransformedSpace } from '../utils/dustGeometry';

interface DustOverlayProps {
  settings: ConversionSettings;
  sourceWidth: number;
  sourceHeight: number;
  brushActive: boolean;
  marks: DustMark[];
  manualBrushRadiusPx: number;
  onChange: (marks: DustMark[]) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type DragState =
  | { mode: 'paint' }
  | { mode: 'move'; markId: string };

export const DustOverlay = memo(function DustOverlay({
  settings,
  sourceWidth,
  sourceHeight,
  brushActive,
  marks,
  manualBrushRadiusPx,
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

  const upsertManualMarkAtPoint = useCallback((point: { x: number; y: number }) => {
    const lastPaintPoint = lastPaintPointRef.current;
    const minSpacing = Math.max(currentBrushRadius * 0.28, 0.0015);
    if (lastPaintPoint && Math.hypot(point.x - lastPaintPoint.x, point.y - lastPaintPoint.y) < minSpacing) {
      return;
    }

    const nextMark = projectDustMarkFromTransformedSpace({
      id: `dust-manual-${crypto.randomUUID()}`,
      cx: point.x,
      cy: point.y,
      radius: currentBrushRadius * 1.18,
      source: 'manual',
    }, settings, sourceWidth, sourceHeight);
    lastPaintPointRef.current = point;
    scheduleMarksChange([...marks, nextMark]);
  }, [currentBrushRadius, marks, scheduleMarksChange, settings, sourceHeight, sourceWidth]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const point = getNormalizedPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      setHoverPoint(point);
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      if (dragState.mode === 'paint') {
        upsertManualMarkAtPoint(point);
        return;
      }

      const targetMark = transformedMarks.find((mark) => mark.id === dragState.markId);
      if (!targetMark) {
        return;
      }

      const nextMark = projectDustMarkFromTransformedSpace({
        ...targetMark,
        cx: point.x,
        cy: point.y,
      }, settings, sourceWidth, sourceHeight);

      scheduleMarksChange(marks.map((mark) => (mark.id === dragState.markId ? nextMark : mark)));
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
    flushPending,
    getNormalizedPoint,
    marks,
    onInteractionEnd,
    scheduleMarksChange,
    settings,
    sourceHeight,
    sourceWidth,
    transformedMarks,
    upsertManualMarkAtPoint,
  ]);

  useEffect(() => () => {
    flushPending();
  }, [flushPending]);

  const handleOverlayMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!brushActive || event.button !== 0) {
      return;
    }

    const point = getNormalizedPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onInteractionStart?.();
    dragStateRef.current = { mode: 'paint' };
    lastPaintPointRef.current = null;
    upsertManualMarkAtPoint(point);
  }, [brushActive, getNormalizedPoint, onInteractionStart, upsertManualMarkAtPoint]);

  const handleOverlayContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!brushActive) {
      return;
    }

    event.preventDefault();
    const manualMarks = marks.filter((mark) => mark.source === 'manual');
    const lastManual = manualMarks[manualMarks.length - 1];
    if (!lastManual) {
      return;
    }

    onInteractionStart?.();
    onChange(marks.filter((mark) => mark.id !== lastManual.id));
    onInteractionEnd?.();
  }, [brushActive, marks, onChange, onInteractionEnd, onInteractionStart]);

  const handleMarkMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>, mark: DustMark) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.altKey) {
      onInteractionStart?.();
      onChange(marks.filter((candidate) => candidate.id !== mark.id));
      onInteractionEnd?.();
      return;
    }

    if (!brushActive || mark.source !== 'manual') {
      return;
    }

    onInteractionStart?.();
    dragStateRef.current = { mode: 'move', markId: mark.id };
  }, [brushActive, marks, onChange, onInteractionEnd, onInteractionStart]);

  return (
    <div
      ref={frameRef}
      className={`absolute inset-0 ${brushActive ? 'cursor-none' : 'pointer-events-none'}`}
      onMouseDown={handleOverlayMouseDown}
      onMouseMove={(event) => {
        const point = getNormalizedPoint(event.clientX, event.clientY);
        setHoverPoint(point);
      }}
      onMouseLeave={() => setHoverPoint(null)}
      onContextMenu={handleOverlayContextMenu}
    >
      {/* SVG layer — visuals only, no pointer events */}
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
          return (
            <circle
              key={mark.id}
              cx={mark.cx}
              cy={mark.cy}
              r={mark.radius}
              fill={isAuto ? 'rgba(125,211,252,0.12)' : 'none'}
              stroke={isAuto ? 'rgba(125,211,252,0.85)' : 'rgba(252,165,165,0.8)'}
              strokeWidth={isAuto ? '0.002' : '0.0014'}
              strokeDasharray={isAuto ? '0.008 0.005' : undefined}
              vectorEffect="non-scaling-stroke"
              filter="url(#dust-shadow)"
            />
          );
        })}
      </svg>

      {/* Invisible hit targets for interaction */}
      {transformedMarks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          onMouseDown={(event) => handleMarkMouseDown(event, mark)}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${mark.cx * 100}%`,
            top: `${mark.cy * 100}%`,
            width: `${mark.radius * 200}%`,
            height: `${mark.radius * 200}%`,
            pointerEvents: 'auto',
            background: 'transparent',
            border: 'none',
          }}
        />
      ))}

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
