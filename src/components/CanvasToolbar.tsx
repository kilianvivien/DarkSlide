import { memo, ReactNode } from 'react';
import { motion } from 'motion/react';
import { Building2, Crop, Maximize, Minus, Plus, RotateCw } from 'lucide-react';
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

const ICON_BUTTON_BASE = 'flex h-8 min-w-8 items-center justify-center rounded-full px-2 transition-[color,background-color,transform] duration-150 active:scale-95';
const ICON_BUTTON = `${ICON_BUTTON_BASE} text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100`;
const ICON_BUTTON_ON = `${ICON_BUTTON_BASE} bg-accent-400/15 text-accent-300 hover:bg-accent-400/25 hover:text-accent-200`;
const PILL_SPRING = { type: 'spring', bounce: 0.15, duration: 0.35 } as const;

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-white/[0.08]" />;
}

/** One option of a segmented group; the active pill slides between options. */
function SegmentButton({
  group,
  active,
  onClick,
  children,
  ...rest
}: {
  group: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'data-tip'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-7 rounded-full px-3 text-[11px] font-medium transition-colors duration-150 ${
        active ? 'text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'
      }`}
      {...rest}
    >
      {active && (
        <motion.span
          layoutId={`canvas-toolbar-${group}`}
          transition={PILL_SPRING}
          className="absolute inset-0 rounded-full bg-zinc-100 shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
        />
      )}
      <span className="relative tabular-nums">{children}</span>
    </button>
  );
}

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
    <div
      role="toolbar"
      aria-label="Image"
      className="flex flex-wrap items-center justify-center gap-1 rounded-full border border-white/[0.07] bg-zinc-900/75 p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
    >
      <span
        className="hidden min-w-0 max-w-[220px] items-center gap-2 pl-3 pr-1.5 text-[11px] text-zinc-300 xl:flex"
        title={labStyleName ? `${profileName} · ${labStyleName}` : profileName}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
        <span className="truncate font-medium">{profileName}</span>
        {labStyleName && (
          <span className="flex min-w-0 items-center gap-1 text-zinc-500">
            <Building2 size={11} className="shrink-0" />
            <span className="truncate">{labStyleName}</span>
          </span>
        )}
      </span>
      <span className="hidden xl:contents"><Divider /></span>

      <div className="flex items-center rounded-full bg-black/30 p-0.5">
        <SegmentButton
          group="compare"
          active={!showingOriginal}
          aria-pressed={!showingOriginal}
          onClick={() => onSetComparisonMode('processed')}
        >
          Converted
        </SegmentButton>
        <SegmentButton
          group="compare"
          active={showingOriginal}
          aria-pressed={showingOriginal}
          aria-label={showingOriginal ? 'Return to processed view' : 'Toggle before and after'}
          data-tip={showingOriginal ? 'Showing the negative — click to return' : 'Compare with the negative'}
          onClick={() => onSetComparisonMode(showingOriginal ? 'processed' : 'original')}
        >
          Negative
        </SegmentButton>
      </div>

      <Divider />
      <button type="button" onClick={onRotateClockwise} aria-label="Rotate 90° clockwise" data-tip="Rotate 90° clockwise" className={ICON_BUTTON}>
        <RotateCw size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={onToggleCrop}
        aria-pressed={isCropOverlayVisible}
        aria-label={isCropOverlayVisible ? 'Hide crop overlay' : 'Show crop overlay'}
        data-tip="Crop (C)"
        className={isCropOverlayVisible ? ICON_BUTTON_ON : ICON_BUTTON}
      >
        <Crop size={15} strokeWidth={1.8} />
      </button>

      <Divider />
      <div className="flex items-center rounded-full bg-black/30 p-0.5">
        <SegmentButton
          group="zoom"
          active={zoom === 'fit'}
          aria-label="Fit to view"
          aria-pressed={zoom === 'fit'}
          data-tip="Fit to view (⌘0)"
          onClick={onZoomToFit}
        >
          <Maximize size={12} strokeWidth={2} className="inline -mt-px" />
        </SegmentButton>
        {([1, 2] as const).map((level) => (
          <SegmentButton
            key={level}
            group="zoom"
            active={zoom === level}
            aria-label={`Zoom to ${level * 100}%`}
            aria-pressed={zoom === level}
            onClick={() => (level === 1 ? onZoomTo100() : onSetZoom(level))}
          >
            {level * 100}%
          </SegmentButton>
        ))}
      </div>
      <div className="flex items-center">
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" data-tip="Zoom out (⌘−)" className={ICON_BUTTON}>
          <Minus size={14} strokeWidth={2} />
        </button>
        <span className="min-w-[2.75rem] text-center font-mono text-[11px] tabular-nums text-zinc-300" aria-live="polite">
          {zoomPercent}%
        </span>
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" data-tip="Zoom in (⌘=)" className={`${ICON_BUTTON} mr-0.5`}>
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
});
