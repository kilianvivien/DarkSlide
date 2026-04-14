import { memo, useCallback, useMemo } from 'react';
import { Eraser, FlaskConical, Paintbrush, Sparkles } from 'lucide-react';
import { DustRemovalSettings } from '../types';
import { Slider } from './Slider';

interface DustPaneProps {
  dustRemoval: DustRemovalSettings;
  onSettingsChange: (settings: DustRemovalSettings) => void;
  onDetectNow: () => void;
  isDetecting: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  brushActive: boolean;
  onBrushActiveChange: (active: boolean) => void;
}

export const DustPane = memo(function DustPane({
  dustRemoval,
  onSettingsChange,
  onDetectNow,
  isDetecting,
  onInteractionStart,
  onInteractionEnd,
  brushActive,
  onBrushActiveChange,
}: DustPaneProps) {
  const autoCount = useMemo(
    () => dustRemoval.marks.filter((mark) => mark.source === 'auto').length,
    [dustRemoval.marks],
  );
  const autoSpotCount = useMemo(
    () => dustRemoval.marks.filter((mark) => mark.source === 'auto' && mark.kind === 'spot').length,
    [dustRemoval.marks],
  );
  const autoPathCount = useMemo(
    () => dustRemoval.marks.filter((mark) => mark.source === 'auto' && mark.kind === 'path').length,
    [dustRemoval.marks],
  );
  const manualCount = dustRemoval.marks.length - autoCount;

  const updateDustRemoval = useCallback((next: Partial<DustRemovalSettings>) => {
    onSettingsChange({
      ...dustRemoval,
      ...next,
    });
  }, [dustRemoval, onSettingsChange]);

  return (
    <div className="space-y-8">

      {/* ── Manual ── */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
          <Paintbrush size={12} /> Manual
        </h2>
        <button
          type="button"
          onClick={() => onBrushActiveChange(!brushActive)}
          className={`mb-4 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-medium transition-all ${
            brushActive
              ? 'border-red-500 bg-red-500/15 text-red-300'
              : 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          <Paintbrush size={13} />
          {brushActive ? 'Brush Active — click to deactivate' : 'Activate Brush'}
        </button>
        <Slider
          label="Brush Radius"
          value={dustRemoval.manualBrushRadius}
          min={2}
          max={50}
          unit="px"
          onChange={(value) => updateDustRemoval({ manualBrushRadius: value })}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Paint over dust or scratches, then click a manual mark to fine-tune it with the same brush-size shortcuts. <span className="text-zinc-600">Alt-click removes a mark, and Backspace removes the last manual one.</span>
        </p>
        {manualCount > 0 && (
          <button
            type="button"
            onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'manual') })}
            className="mt-3 flex items-center gap-2 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 transition-all hover:text-zinc-300"
          >
            <Eraser size={11} />
            Clear {manualCount} manual {manualCount === 1 ? 'mark' : 'marks'}
          </button>
        )}
      </section>

      {/* ── Auto Detection (Experimental) ── */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
          <Sparkles size={12} /> Auto Detection
          <span className="ml-1 flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">
            <FlaskConical size={8} /> Experimental
          </span>
        </h2>

        <div className="mb-4">
          <div className="grid grid-cols-3 gap-2">
            {([
              ['spots', 'Spots'],
              ['scratches', 'Scratches'],
              ['both', 'Both'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => updateDustRemoval({ autoDetectMode: value })}
                className={`rounded-lg border px-2 py-2 text-[10px] font-semibold uppercase tracking-widest transition-all ${
                  dustRemoval.autoDetectMode === value
                    ? 'border-sky-400/60 bg-sky-400/10 text-sky-200'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <Slider
          label="Detection Bias"
          value={dustRemoval.autoSensitivity}
          min={0}
          max={100}
          onChange={(value) => updateDustRemoval({ autoSensitivity: value })}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />
        <p className="mt-2 text-[10px] uppercase tracking-widest text-zinc-500">
          Conservative on the left, aggressive on the right.
        </p>
        <Slider
          label="Maximum Defect Width"
          value={dustRemoval.autoMaxRadius}
          min={1}
          max={30}
          unit="px"
          onChange={(value) => updateDustRemoval({ autoMaxRadius: value })}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />

        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={onDetectNow}
            disabled={isDetecting}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] font-medium text-zinc-200 transition-all hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
          >
            <Sparkles size={13} />
            {isDetecting ? 'Detecting…' : 'Detect Now'}
          </button>
          {autoCount > 0 && (
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">
              {autoSpotCount} spots · {autoPathCount} paths
            </span>
          )}
        </div>

        {autoCount > 0 && (
          <button
            type="button"
            onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'auto') })}
            className="mt-3 flex items-center gap-2 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 transition-all hover:text-zinc-300"
          >
            <Eraser size={11} />
            Clear {autoCount} auto {autoCount === 1 ? 'mark' : 'marks'}
          </button>
        )}

        <label className="mt-4 flex items-center gap-2 text-[11px] text-zinc-500">
          <input
            type="checkbox"
            checked={dustRemoval.autoEnabled}
            onChange={(event) => updateDustRemoval({ autoEnabled: event.target.checked })}
            className="accent-zinc-200"
          />
          Auto-detect on image load
        </label>
      </section>

    </div>
  );
});
