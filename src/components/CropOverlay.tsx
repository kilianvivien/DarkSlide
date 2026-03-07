import React, { useEffect, useRef, useState } from 'react';
import { CropSettings } from '../types';

interface CropOverlayProps {
  crop: CropSettings;
  onChange: (crop: CropSettings) => void;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  origin: CropSettings;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export const CropOverlay: React.FC<CropOverlayProps> = ({ crop, onChange }) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

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
          if (dragState.mode === 'nw' || dragState.mode === 'se') {
            next.height = clamp(next.width / aspectRatio, 0.05, 1);
          } else {
            next.width = clamp(next.height * aspectRatio, 0.05, 1);
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

      onChange(next);
    };

    const handleUp = () => {
      setDragState(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragState, onChange]);

  const frameStyle = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
  };

  const beginDrag = (mode: DragMode) => (event: React.MouseEvent) => {
    event.stopPropagation();
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
            nw: '-left-2 -top-2 cursor-nwse-resize',
            ne: '-right-2 -top-2 cursor-nesw-resize',
            sw: '-left-2 -bottom-2 cursor-nesw-resize',
            se: '-right-2 -bottom-2 cursor-nwse-resize',
          }[handle];

          return (
            <button
              key={handle}
              type="button"
              className={`absolute h-4 w-4 rounded-full border border-zinc-950 bg-zinc-100 ${positionClasses}`}
              onMouseDown={beginDrag(handle)}
            />
          );
        })}
      </div>
    </div>
  );
};
