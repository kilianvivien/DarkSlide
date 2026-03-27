import React from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { ZoomLevel } from '../types';

interface ZoomBarProps {
  zoom: ZoomLevel;
  fitScale: number;
  onZoomToFit: () => void;
  onZoomTo100: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom: (level: ZoomLevel) => void;
}

export const ZoomBar: React.FC<ZoomBarProps> = ({
  zoom,
  fitScale,
  onZoomToFit,
  onZoomTo100,
  onZoomIn,
  onZoomOut,
  onSetZoom,
}) => {
  const zoomLabel = `${Math.round((zoom === 'fit' ? fitScale : zoom) * 100)}%`;
  const btnClass = (active: boolean) =>
    `px-2 py-1 text-[10px] font-mono uppercase tracking-wider rounded-lg transition-all ${
      active
        ? 'bg-zinc-700/90 text-zinc-100'
        : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/90'
    }`;

  return (
    <div className="group relative flex h-[30px] w-[36px] items-center overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/92 shadow-2xl backdrop-blur-md transition-[width] duration-200 ease-out hover:w-[320px] focus-within:w-[320px]">
      {/* Expanding buttons — slide in from the left on hover */}
      <div className="flex max-w-0 items-center gap-1 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover:max-w-[284px] group-hover:opacity-100 group-focus-within:max-w-[284px] group-focus-within:opacity-100">
        <div className="flex items-center gap-1 pl-1.5">
          <button onClick={onZoomOut} aria-label="Zoom out" className={btnClass(false)} data-tip="Zoom Out">
            <ZoomOut size={14} />
          </button>
          <button onClick={onZoomToFit} aria-label="Fit to view" className={btnClass(zoom === 'fit')} data-tip="Fit to View">
            <Maximize size={14} />
          </button>
          <button onClick={() => onSetZoom(0.5)} aria-label="Zoom to 50%" className={btnClass(zoom === 0.5)} data-tip="50%">
            50%
          </button>
          <button onClick={onZoomTo100} aria-label="Zoom to 100%" className={btnClass(zoom === 1)} data-tip="100%">
            100%
          </button>
          <button onClick={() => onSetZoom(2)} aria-label="Zoom to 200%" className={btnClass(zoom === 2)} data-tip="200%">
            200%
          </button>
          <button onClick={onZoomIn} aria-label="Zoom in" className={btnClass(false)} data-tip="Zoom In">
            <ZoomIn size={14} />
          </button>
          <div className="mx-1 h-4 w-px shrink-0 bg-zinc-800/80" />
        </div>
      </div>

      {/* Trigger — absolutely pinned to the right, always 36px wide and perfectly centered */}
      <div className="absolute inset-y-0 right-0 flex w-[36px] shrink-0 items-center justify-center">
        <button
          type="button"
          aria-label={`Zoom controls (${zoomLabel})`}
          className="flex items-center justify-center rounded-xl bg-zinc-900/80 p-1.5 text-zinc-200 transition-colors hover:bg-zinc-800/90 group-focus-within:bg-zinc-800/90"
        >
          <ZoomIn size={13} />
        </button>
      </div>
    </div>
  );
};
