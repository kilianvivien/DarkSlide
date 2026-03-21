import React from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { ZoomLevel } from '../hooks/useViewportZoom';

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
  const displayPercent = zoom === 'fit'
    ? Math.round(fitScale * 100)
    : Math.round(zoom * 100);

  const btnClass = (active: boolean) =>
    `px-2 py-1 text-[10px] font-mono uppercase tracking-wider rounded-lg transition-all ${
      active
        ? 'bg-zinc-700/90 text-zinc-100'
        : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/90'
    }`;

  return (
    <div className="group flex w-[88px] justify-end overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/92 shadow-2xl backdrop-blur-md transition-[width] duration-200 ease-out hover:w-[340px] focus-within:w-[340px]">
      <div className="flex items-center gap-1 whitespace-nowrap px-2 py-1.5">
        <div className="flex max-w-0 items-center gap-1 overflow-hidden opacity-0 transition-all duration-200 ease-out group-hover:max-w-[260px] group-hover:opacity-100 group-focus-within:max-w-[260px] group-focus-within:opacity-100">
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

        <button
          type="button"
          aria-label="Zoom controls"
          className="relative z-10 flex shrink-0 items-center gap-2 rounded-xl bg-zinc-900/80 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-200 transition-colors hover:bg-zinc-800/90 group-focus-within:bg-zinc-800/90"
        >
          <ZoomIn size={13} />
          <span className="min-w-[2.5rem] text-center">{displayPercent}%</span>
        </button>
      </div>
    </div>
  );
};
