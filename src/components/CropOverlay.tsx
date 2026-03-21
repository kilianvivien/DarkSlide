import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CropSettings } from '../types';
import { getNormalizedAspectRatio } from '../utils/imagePipeline';
import { clamp } from '../utils/math';

interface CropOverlayProps {
  crop: CropSettings;
  imageWidth: number;
  imageHeight: number;
  onChange: (crop: CropSettings) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  origin: CropSettings;
}

export const CropOverlay = memo(function CropOverlay({
  crop,
  imageWidth,
  imageHeight,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: CropOverlayProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const pendingCropRef = useRef<CropSettings | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

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

    const handleMove = (event: MouseEvent) => {
      const frame = frameRef.current;
      if (!frame) return;

      const rect = frame.getBoundingClientRect();
      const dx = (event.clientX - dragState.startX) / rect.width;
      const dy = (event.clientY - dragState.startY) / rect.height;
      const aspectRatio = dragState.origin.aspectRatio;
      let next = { ...dragState.origin };

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

        if (aspectRatio) {
          const normalizedAspectRatio = getNormalizedAspectRatio(aspectRatio, imageWidth, imageHeight);

          if (dragState.mode === 'nw' || dragState.mode === 'se') {
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

    const handleUp = () => {
      flushPendingCrop();
      setDragState(null);
      onInteractionEnd?.();
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
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
  };

  const beginDrag = (mode: DragMode) => (event: React.MouseEvent) => {
    event.stopPropagation();
    onInteractionStart?.();
    setDragState({
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: crop,
    });
  };

  return (
    <div ref={frameRef} className="absolute inset-0 pointer-events-none">
      <div className="absolute inset-0 bg-black/35" />
      <div
        style={frameStyle}
        className="absolute border border-zinc-100 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] pointer-events-auto"
        onMouseDown={beginDrag('move')}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
          const positionClasses = {
            nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
            ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
            sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
            se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
          }[handle];

          return (
            <button
              key={handle}
              type="button"
              className={`absolute z-10 h-[92px] w-[92px] rounded-full border-2 border-zinc-950 bg-zinc-100 shadow-lg shadow-black/40 outline-none before:absolute before:-inset-2 before:content-[''] ${positionClasses}`}
              onMouseDown={beginDrag(handle)}
            />
          );
        })}
      </div>
    </div>
  );
});
