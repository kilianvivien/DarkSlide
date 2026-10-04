import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CropSettings } from '../types';
import { formatAspectRatio } from '../utils/aspectRatio';
import { getNormalizedAspectRatio } from '../utils/imagePipeline';
import { clamp } from '../utils/math';

interface CropOverlayProps {
  crop: CropSettings;
  imageWidth: number;
  imageHeight: number;
  levelAngle?: number;
  straightenActive?: boolean;
  onChange: (crop: CropSettings) => void;
  onLevelAngleChange?: (levelAngle: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type DragMode = 'move' | 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const RESIZE_HANDLES: Array<{
  mode: Exclude<DragMode, 'move'>;
  label: string;
  hitAreaClass: string;
  gripClass: string;
}> = [
  {
    mode: 'nw',
    label: 'Resize crop from top left',
    hitAreaClass: 'left-0 top-0 h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
    gripClass: 'left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border-l-2 border-t-2',
  },
  {
    mode: 'n',
    label: 'Resize crop from top',
    hitAreaClass: 'left-1/2 top-0 h-6 w-12 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
    gripClass: 'left-1/2 top-1/2 h-1 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-50',
  },
  {
    mode: 'ne',
    label: 'Resize crop from top right',
    hitAreaClass: 'right-0 top-0 h-7 w-7 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
    gripClass: 'left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border-r-2 border-t-2',
  },
  {
    mode: 'e',
    label: 'Resize crop from right',
    hitAreaClass: 'right-0 top-1/2 h-12 w-6 -translate-y-1/2 translate-x-1/2 cursor-ew-resize',
    gripClass: 'left-1/2 top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-50',
  },
  {
    mode: 'se',
    label: 'Resize crop from bottom right',
    hitAreaClass: 'bottom-0 right-0 h-7 w-7 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
    gripClass: 'left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border-b-2 border-r-2',
  },
  {
    mode: 's',
    label: 'Resize crop from bottom',
    hitAreaClass: 'bottom-0 left-1/2 h-6 w-12 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
    gripClass: 'left-1/2 top-1/2 h-1 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-50',
  },
  {
    mode: 'sw',
    label: 'Resize crop from bottom left',
    hitAreaClass: 'bottom-0 left-0 h-7 w-7 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
    gripClass: 'left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border-b-2 border-l-2',
  },
  {
    mode: 'w',
    label: 'Resize crop from left',
    hitAreaClass: 'left-0 top-1/2 h-12 w-6 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
    gripClass: 'left-1/2 top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-50',
  },
];

interface DragState {
  mode: DragMode;
  pointerId: number;
  startX: number;
  startY: number;
  origin: CropSettings;
  lockedAspectRatio: number | null;
}

interface StraightenLine {
  pointerId: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

function getStraightenDeviation(startX: number, startY: number, endX: number, endY: number) {
  const angle = (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI;
  return ((angle + 45) % 90 + 90) % 90 - 45;
}

function getClampedPointerPosition(frame: HTMLDivElement, clientX: number, clientY: number) {
  const rect = frame.getBoundingClientRect();

  return {
    x: clamp(clientX, rect.left, rect.right),
    y: clamp(clientY, rect.top, rect.bottom),
  };
}

export const CropOverlay = memo(function CropOverlay({
  crop,
  imageWidth,
  imageHeight,
  levelAngle = 0,
  straightenActive = false,
  onChange,
  onLevelAngleChange,
  onInteractionStart,
  onInteractionEnd,
}: CropOverlayProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const pendingCropRef = useRef<CropSettings | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [straightenLine, setStraightenLine] = useState<StraightenLine | null>(null);

  const flushPendingCrop = useCallback(() => {
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }

    if (pendingCropRef.current) {
      onChange(pendingCropRef.current);
      pendingCropRef.current = null;
    }
  }, [onChange]);

  const scheduleCropChange = useCallback((nextCrop: CropSettings) => {
    pendingCropRef.current = nextCrop;
    if (frameRequestRef.current !== null) {
      return;
    }

    frameRequestRef.current = window.requestAnimationFrame(() => {
      frameRequestRef.current = null;
      if (pendingCropRef.current) {
        onChange(pendingCropRef.current);
        pendingCropRef.current = null;
      }
    });
  }, [onChange]);

  useEffect(() => {
    if (!dragState) return;

    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) return;
      const frame = frameRef.current;
      if (!frame) return;

      const rect = frame.getBoundingClientRect();
      const dx = (event.clientX - dragState.startX) / rect.width;
      const dy = (event.clientY - dragState.startY) / rect.height;
      const next = { ...dragState.origin };

      if (dragState.mode === 'move') {
        next.x = clamp(dragState.origin.x + dx, 0, 1 - dragState.origin.width);
        next.y = clamp(dragState.origin.y + dy, 0, 1 - dragState.origin.height);
      } else {
        const handleResize = () => {
          if (dragState.mode?.includes('w')) {
            const nextX = clamp(dragState.origin.x + dx, 0, dragState.origin.x + dragState.origin.width - 0.05);
            next.width = dragState.origin.width + (dragState.origin.x - nextX);
            next.x = nextX;
          }

          if (dragState.mode?.includes('e')) {
            next.width = clamp(dragState.origin.width + dx, 0.05, 1 - dragState.origin.x);
          }

          if (dragState.mode?.includes('n')) {
            const nextY = clamp(dragState.origin.y + dy, 0, dragState.origin.y + dragState.origin.height - 0.05);
            next.height = dragState.origin.height + (dragState.origin.y - nextY);
            next.y = nextY;
          }

          if (dragState.mode?.includes('s')) {
            next.height = clamp(dragState.origin.height + dy, 0.05, 1 - dragState.origin.y);
          }
        };

        handleResize();

        const normalizedAspectRatio = dragState.lockedAspectRatio
          ?? (event.shiftKey
            ? dragState.origin.width / dragState.origin.height
            : dragState.origin.aspectRatio
              ? getNormalizedAspectRatio(dragState.origin.aspectRatio, imageWidth, imageHeight)
              : null);

        if (normalizedAspectRatio) {

          if (dragState.mode === 'w' || dragState.mode === 'e') {
            const centerY = dragState.origin.y + (dragState.origin.height / 2);
            const maxHeight = 2 * Math.min(centerY, 1 - centerY);

            next.height = next.width / normalizedAspectRatio;
            if (next.height > maxHeight) {
              next.height = maxHeight;
              next.width = next.height * normalizedAspectRatio;
              if (dragState.mode === 'w') {
                next.x = dragState.origin.x + dragState.origin.width - next.width;
              }
            }
            next.y = centerY - (next.height / 2);
          } else if (dragState.mode === 'n' || dragState.mode === 's') {
            const centerX = dragState.origin.x + (dragState.origin.width / 2);
            const maxWidth = 2 * Math.min(centerX, 1 - centerX);

            next.width = next.height * normalizedAspectRatio;
            if (next.width > maxWidth) {
              next.width = maxWidth;
              next.height = next.width / normalizedAspectRatio;
              if (dragState.mode === 'n') {
                next.y = dragState.origin.y + dragState.origin.height - next.height;
              }
            }
            next.x = centerX - (next.width / 2);
          } else if (dragState.mode === 'nw' || dragState.mode === 'se') {
            const maxHeight = dragState.mode === 'nw'
              ? dragState.origin.y + dragState.origin.height
              : 1 - dragState.origin.y;

            next.height = clamp(next.width / normalizedAspectRatio, 0.05, maxHeight);
            next.width = next.height * normalizedAspectRatio;
          } else {
            const maxWidth = dragState.mode === 'sw'
              ? dragState.origin.x + dragState.origin.width
              : 1 - dragState.origin.x;

            next.width = clamp(next.height * normalizedAspectRatio, 0.05, maxWidth);
            next.height = next.width / normalizedAspectRatio;
          }

          if (dragState.mode?.includes('w')) {
            next.x = clamp(dragState.origin.x + dragState.origin.width - next.width, 0, 1 - next.width);
          }

          if (dragState.mode?.includes('n')) {
            next.y = clamp(dragState.origin.y + dragState.origin.height - next.height, 0, 1 - next.height);
          }
        }

        next.width = clamp(next.width, 0.05, 1 - next.x);
        next.height = clamp(next.height, 0.05, 1 - next.y);
      }

      scheduleCropChange(next);
    };

    const handleUp = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) return;
      flushPendingCrop();
      setDragState(null);
      onInteractionEnd?.();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragState, flushPendingCrop, imageHeight, imageWidth, onInteractionEnd, scheduleCropChange]);

  useEffect(() => () => {
    flushPendingCrop();
  }, [flushPendingCrop]);

  const frameStyle = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
    boxShadow: '0 0 0 1px rgba(9,9,11,0.95), 0 2px 14px rgba(0,0,0,0.45)',
  };

  const beginDrag = (mode: DragMode) => (event: React.PointerEvent) => {
    if (straightenActive || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onInteractionStart?.();
    setDragState({
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: crop,
      lockedAspectRatio: mode !== 'move' && event.shiftKey
        ? crop.width / crop.height
        : null,
    });
  };

  const beginReposition = (event: React.PointerEvent) => {
    if (straightenActive || event.button !== 0) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const centerX = (event.clientX - rect.left) / rect.width;
    const centerY = (event.clientY - rect.top) / rect.height;
    const next = {
      ...crop,
      x: clamp(centerX - crop.width / 2, 0, 1 - crop.width),
      y: clamp(centerY - crop.height / 2, 0, 1 - crop.height),
    };

    event.preventDefault();
    event.stopPropagation();
    onInteractionStart?.();
    onChange(next);
    setDragState({
      mode: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: next,
      lockedAspectRatio: null,
    });
  };

  const beginStraighten = (event: React.PointerEvent) => {
    if (!straightenActive || event.button !== 0) return;
    const frame = frameRef.current;
    if (!frame) return;
    const { x, y } = getClampedPointerPosition(frame, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
    onInteractionStart?.();
    setStraightenLine({ pointerId: event.pointerId, startX: x, startY: y, endX: x, endY: y });
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Some webviews reject pointer capture. The overlay handlers still track the drag.
    }
  };

  const updateStraighten = (event: React.PointerEvent) => {
    if (!straightenLine || event.pointerId !== straightenLine.pointerId) return;
    const frame = frameRef.current;
    if (!frame) return;
    const position = getClampedPointerPosition(frame, event.clientX, event.clientY);
    setStraightenLine((current) => current ? {
      ...current,
      endX: position.x,
      endY: position.y,
    } : null);
  };

  const finishStraighten = (event: React.PointerEvent) => {
    if (!straightenLine || event.pointerId !== straightenLine.pointerId) return;
    const frame = frameRef.current;
    const position = frame ? getClampedPointerPosition(frame, event.clientX, event.clientY) : null;
    const endX = position?.x ?? straightenLine.endX;
    const endY = position?.y ?? straightenLine.endY;
    const distance = Math.hypot(endX - straightenLine.startX, endY - straightenLine.startY);

    if (distance >= 12) {
      const deviation = getStraightenDeviation(
        straightenLine.startX,
        straightenLine.startY,
        endX,
        endY,
      );
      onLevelAngleChange?.(clamp(Number((levelAngle - deviation).toFixed(1)), -10, 10));
    }

    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The pointer may already have been released by the webview.
    }
    setStraightenLine(null);
    onInteractionEnd?.();
  };

  const cancelStraighten = (event: React.PointerEvent) => {
    if (!straightenLine || event.pointerId !== straightenLine.pointerId) return;
    setStraightenLine(null);
    onInteractionEnd?.();
  };

  const handleKeyboardMove = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (straightenActive || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const xStep = (event.shiftKey ? 10 : 1) / Math.max(1, imageWidth);
    const yStep = (event.shiftKey ? 10 : 1) / Math.max(1, imageHeight);
    const next = { ...crop };
    if (event.key === 'ArrowLeft') next.x = clamp(crop.x - xStep, 0, 1 - crop.width);
    if (event.key === 'ArrowRight') next.x = clamp(crop.x + xStep, 0, 1 - crop.width);
    if (event.key === 'ArrowUp') next.y = clamp(crop.y - yStep, 0, 1 - crop.height);
    if (event.key === 'ArrowDown') next.y = clamp(crop.y + yStep, 0, 1 - crop.height);
    event.preventDefault();
    onChange(next);
  };

  const shadeClassName = `pointer-events-auto absolute bg-zinc-700/60 backdrop-grayscale backdrop-brightness-[.55] ${straightenActive ? 'cursor-crosshair' : 'cursor-move'}`;
  const straightenDeviation = straightenLine
    ? getStraightenDeviation(straightenLine.startX, straightenLine.startY, straightenLine.endX, straightenLine.endY)
    : 0;

  return (
    <div
      ref={frameRef}
      className={`absolute inset-0 touch-none ${straightenActive ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
      onPointerDown={beginStraighten}
      onPointerMove={updateStraighten}
      onPointerUp={finishStraighten}
      onPointerCancel={cancelStraighten}
    >
      <div
        data-crop-shade="top"
        className={shadeClassName}
        style={{ inset: `0 0 auto 0`, height: `${crop.y * 100}%` }}
        onPointerDown={beginReposition}
      />
      <div
        data-crop-shade="left"
        className={shadeClassName}
        style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }}
        onPointerDown={beginReposition}
      />
      <div
        data-crop-shade="right"
        className={shadeClassName}
        style={{ left: `${(crop.x + crop.width) * 100}%`, right: 0, top: `${crop.y * 100}%`, height: `${crop.height * 100}%` }}
        onPointerDown={beginReposition}
      />
      <div
        data-crop-shade="bottom"
        className={shadeClassName}
        style={{ inset: `auto 0 0 0`, height: `${(1 - crop.y - crop.height) * 100}%` }}
        onPointerDown={beginReposition}
      />
      <div
        style={frameStyle}
        className={`group absolute touch-none border-[3px] border-white pointer-events-auto ${straightenActive ? 'cursor-crosshair' : dragState?.mode === 'move' ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <button
          type="button"
          tabIndex={straightenActive ? -1 : 0}
          aria-label="Crop area. Drag to move, or use the arrow keys for precise positioning."
          className={`absolute inset-0 z-0 border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${straightenActive ? 'pointer-events-none cursor-crosshair' : dragState?.mode === 'move' ? 'cursor-grabbing' : 'cursor-grab'}`}
          onKeyDown={handleKeyboardMove}
          onPointerDown={beginDrag('move')}
        />
        <div data-testid="crop-rule-of-thirds" className={`pointer-events-none absolute inset-0 transition-opacity ${dragState || straightenActive ? 'opacity-90' : 'opacity-55'}`} aria-hidden="true">
          <span className="absolute inset-y-0 left-1/3 w-px bg-white/65 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
          <span className="absolute inset-y-0 left-2/3 w-px bg-white/65 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
          <span className="absolute inset-x-0 top-1/3 h-px bg-white/65 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
          <span className="absolute inset-x-0 top-2/3 h-px bg-white/65 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
        </div>

        {!straightenActive && !dragState && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border border-white/20 bg-zinc-950/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-white/80 opacity-0 shadow-lg backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <span className="text-sm leading-none">↕</span> Move crop
          </div>
        )}

        {dragState && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-zinc-950/85 px-2.5 py-1.5 font-mono text-[13px] font-medium tabular-nums text-zinc-100 shadow-lg" aria-live="polite">
            {Math.round(crop.width * imageWidth)} × {Math.round(crop.height * imageHeight)} px
            <span className="ml-2 text-accent-300">
              {formatAspectRatio(crop.width * imageWidth, crop.height * imageHeight)}
            </span>
          </div>
        )}

        {RESIZE_HANDLES.map((handle) => (
          <button
            key={handle.mode}
            type="button"
            aria-label={handle.label}
            className={`absolute z-10 border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ${straightenActive ? 'pointer-events-none opacity-0' : ''} ${handle.hitAreaClass}`}
            onPointerDown={beginDrag(handle.mode)}
          >
            <span className={`pointer-events-none absolute border-zinc-50 drop-shadow-[0_1px_1px_rgba(0,0,0,0.95)] ${handle.gripClass}`} />
          </button>
        ))}
      </div>

      {straightenActive && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          {[25, 50, 75].map((position) => (
            <React.Fragment key={position}>
              <span className="absolute inset-y-0 w-px bg-accent-300/25" style={{ left: `${position}%` }} />
              <span className="absolute inset-x-0 h-px bg-accent-300/25" style={{ top: `${position}%` }} />
            </React.Fragment>
          ))}
        </div>
      )}

      {straightenLine && createPortal(
        <div
          data-testid="straighten-line"
          className="pointer-events-none fixed z-[100] h-0.5 origin-left bg-accent-300 shadow-[0_0_0_1px_rgba(0,0,0,0.65),0_0_12px_var(--accent-300)]"
          style={{
            left: straightenLine.startX,
            top: straightenLine.startY,
            width: Math.hypot(straightenLine.endX - straightenLine.startX, straightenLine.endY - straightenLine.startY),
            transform: `rotate(${Math.atan2(straightenLine.endY - straightenLine.startY, straightenLine.endX - straightenLine.startX)}rad)`,
          }}
        >
          <span className="absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-950/90 px-2 py-1 font-mono text-[10px] text-accent-200 shadow-lg">
            {straightenDeviation > 0 ? '+' : ''}{straightenDeviation.toFixed(1)}°
          </span>
        </div>,
        document.body,
      )}
    </div>
  );
});
