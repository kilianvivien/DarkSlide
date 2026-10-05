import { memo, useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { SEGMENT_TRACK, segmentItem } from './ui';

export type ExportScope = 'current' | 'selected' | 'all';

export interface FrameExportProgress {
  done: number;
  total: number;
  currentName: string | null;
}

interface ExportFramesControlProps {
  selectedCount: number;
  totalCount: number;
  isExporting: boolean;
  progress: FrameExportProgress | null;
  onExportCurrent: () => void;
  onExportFrames: (scope: Exclude<ExportScope, 'current'>) => void;
  onCancel: () => void;
}

/**
 * The Export panel's main action. Every frame is exported with its own look;
 * the panel's format, size and colour settings apply to all of them.
 */
export const ExportFramesControl = memo(function ExportFramesControl({
  selectedCount,
  totalCount,
  isExporting,
  progress,
  onExportCurrent,
  onExportFrames,
  onCancel,
}: ExportFramesControlProps) {
  const [scope, setScope] = useState<ExportScope>(selectedCount > 1 ? 'selected' : 'current');

  // Follow the filmstrip: a new multi-selection becomes the natural scope,
  // and a scope that no longer applies falls back to this frame.
  useEffect(() => {
    if (selectedCount > 1) {
      setScope('selected');
    } else {
      setScope((current) => (current === 'selected' ? 'current' : current));
    }
  }, [selectedCount]);

  useEffect(() => {
    if (totalCount <= 1) setScope((current) => (current === 'all' ? 'current' : current));
  }, [totalCount]);

  const count = scope === 'current' ? 1 : scope === 'selected' ? selectedCount : totalCount;
  const busy = isExporting || progress !== null;
  const options: Array<{ id: ExportScope; label: string; disabled: boolean }> = [
    { id: 'current', label: 'This frame', disabled: false },
    { id: 'selected', label: `Selected${selectedCount > 1 ? ` (${selectedCount})` : ''}`, disabled: selectedCount < 2 },
    { id: 'all', label: `All (${totalCount})`, disabled: totalCount < 2 },
  ];

  return (
    <section aria-label="Export frames" className="space-y-2.5">
      <div role="radiogroup" aria-label="Frames to export" className={`${SEGMENT_TRACK} grid-cols-3`}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={scope === option.id}
            disabled={option.disabled || busy}
            onClick={() => setScope(option.id)}
            className={segmentItem(scope === option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {progress ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-2 text-zinc-300">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              <span className="truncate">
                Exporting {Math.min(progress.done + 1, progress.total)} of {progress.total}
                {progress.currentName ? ` · ${progress.currentName}` : ''}
              </span>
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X size={11} /> Cancel
            </button>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full rounded-full bg-accent-400 transition-all duration-300" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => (scope === 'current' ? onExportCurrent() : onExportFrames(scope))}
          disabled={busy}
          aria-busy={isExporting}
          className="grid w-full grid-cols-[1rem_auto] items-center justify-center gap-2 rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-black/20 transition-colors hover:bg-white disabled:opacity-50"
        >
          {isExporting ? <Loader2 size={15} className="shrink-0 animate-spin" /> : <Download size={15} className="shrink-0" />}
          <span className="whitespace-nowrap">
            {isExporting ? 'Exporting...' : count === 1 ? 'Export Image' : `Export ${count} Frames`}
          </span>
        </button>
      )}
      {scope !== 'current' && !progress && (
        <p className="text-[10px] leading-relaxed text-zinc-500">
          Each frame keeps its own look and file name; the Custom Export format, size and colour settings apply to all of them.
        </p>
      )}
    </section>
  );
});
