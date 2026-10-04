import { memo } from 'react';
import { Building2, Crop, Maximize, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import type { ZoomLevel } from '../types';

interface CanvasToolbarProps {
  profileName: string;
  labStyleName: string | null;
  comparisonMode: 'processed' | 'original';
  isCropOverlayVisible: boolean;
  zoom: ZoomLevel;
  fitScale: number;
  onSetComparisonMode: (mode: 'processed' | 'original') => void;
  onRotateClockwise: () => void;
  onToggleCrop: () => void;
  onZoomToFit: () => void;
  onZoomTo100: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom: (level: ZoomLevel) => void;
}

const SEGMENT = 'rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors';
const ICON_BUTTON = 'flex h-7 items-center justify-center gap-1.5 rounded-lg px-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100';

/** Floating controls for the image itself: compare, orientation, crop and zoom. */
export const CanvasToolbar = memo(function CanvasToolbar({
  profileName,
  labStyleName,
  comparisonMode,
  isCropOverlayVisible,
  zoom,
  fitScale,
  onSetComparisonMode,
  onRotateClockwise,
  onToggleCrop,
  onZoomToFit,
  onZoomTo100,
  onZoomIn,
  onZoomOut,
  onSetZoom,
}: CanvasToolbarProps) {
  const zoomPercent = Math.round((zoom === 'fit' ? fitScale : zoom) * 100);
  const showingOriginal = comparisonMode === 'original';

  return (
    <div role="toolbar" aria-label="Image" className="flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-950/90 p-1 shadow-2xl shadow-black/40 backdrop-blur-md">
      <span className="hidden max-w-[180px] truncate px-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500 xl:inline" title={profileName}>
        {profileName}
      </span>
      {labStyleName && (
        <span className="hidden items-center gap-1 px-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500 xl:flex" title={labStyleName}>
          <Building2 size={11} /> {labStyleName}
        </span>
      )}
      <span className="mx-1 hidden h-4 w-px bg-zinc-800 xl:block" />

      <div className="flex items-center rounded-xl bg-zinc-900/80 p-0.5">
        <button
          type="button"
          aria-pressed={!showingOriginal}
          onClick={() => onSetComparisonMode('processed')}
          className={`${SEGMENT} ${!showingOriginal ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          Converted
        </button>
        <button
          type="button"
          aria-pressed={showingOriginal}
          aria-label={showingOriginal ? 'Return to processed view' : 'Toggle before and after'}
          data-tip={showingOriginal ? 'Showing Original — click to return' : 'Toggle Before/After'}
          onClick={() => onSetComparisonMode(showingOriginal ? 'processed' : 'original')}
          className={`${SEGMENT} ${showingOriginal ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          Negative
        </button>
      </div>

      <span className="mx-1 h-4 w-px bg-zinc-800" />
      <button type="button" onClick={onRotateClockwise} aria-label="Rotate 90° clockwise" data-tip="Rotate 90° clockwise" className={ICON_BUTTON}>
        <RotateCw size={14} />
      </button>
      <button
        type="button"
        onClick={onToggleCrop}
        aria-pressed={isCropOverlayVisible}
        aria-label={isCropOverlayVisible ? 'Hide crop overlay' : 'Show crop overlay'}
        data-tip="Crop (C)"
        className={`${ICON_BUTTON} ${isCropOverlayVisible ? 'bg-zinc-100 text-zinc-950 hover:bg-white hover:text-zinc-950' : ''}`}
      >
        <Crop size={14} />
      </button>

      <span className="mx-1 h-4 w-px bg-zinc-800" />
      <button type="button" onClick={onZoomOut} aria-label="Zoom out" data-tip="Zoom out (⌘−)" className={ICON_BUTTON}>
        <ZoomOut size={14} />
      </button>
      <button
        type="button"
        onClick={onZoomToFit}
        aria-label="Fit to view"
        aria-pressed={zoom === 'fit'}
        data-tip="Fit to view (⌘0)"
        className={`${ICON_BUTTON} ${zoom === 'fit' ? 'text-zinc-100' : ''}`}
      >
        <Maximize size={13} />
      </button>
      {([1, 2] as const).map((level) => (
        <button
          key={level}
          type="button"
          onClick={() => (level === 1 ? onZoomTo100() : onSetZoom(level))}
          aria-label={`Zoom to ${level * 100}%`}
          aria-pressed={zoom === level}
          className={`${ICON_BUTTON} font-mono text-[10px] ${zoom === level ? 'bg-zinc-800 text-zinc-100' : ''}`}
        >
          {level * 100}%
        </button>
      ))}
      <button type="button" onClick={onZoomIn} aria-label="Zoom in" data-tip="Zoom in (⌘=)" className={ICON_BUTTON}>
        <ZoomIn size={14} />
      </button>
      <span className="min-w-[3rem] px-1 text-right font-mono text-[10px] tabular-nums text-zinc-500" aria-live="polite">
        {zoomPercent}%
      </span>
    </div>
  );
});
