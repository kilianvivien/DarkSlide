import { memo, useCallback, useMemo } from 'react';
import { Eraser, Paintbrush, Sparkles } from 'lucide-react';
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
  const manualCount = dustRemoval.marks.length - autoCount;

  const updateDustRemoval = useCallback((next: Partial<DustRemovalSettings>) => {
    onSettingsChange({
      ...dustRemoval,
      ...next,
    });
  }, [dustRemoval, onSettingsChange]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
          <Sparkles size={12} /> Auto Detection
        </h2>
        <label className="mb-4 flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={dustRemoval.autoEnabled}
            onChange={(event) => updateDustRemoval({ autoEnabled: event.target.checked })}
            className="accent-zinc-200"
          />
          Auto enabled
        </label>
        <div className="mb-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">Detection Mode</p>
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
          label="Sensitivity"
          value={dustRemoval.autoSensitivity}
          min={0}
          max={100}
          onChange={(value) => updateDustRemoval({ autoSensitivity: value })}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />
        <Slider
          label="Max Spot Size"
          value={dustRemoval.autoMaxRadius}
          min={1}
          max={30}
          unit="px"
          onChange={(value) => updateDustRemoval({ autoMaxRadius: value })}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDetectNow}
            disabled={isDetecting}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] font-medium text-zinc-200 transition-all hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
          >
            <Sparkles size={13} />
            {isDetecting ? 'Detecting…' : 'Detect Now'}
          </button>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">
            {autoCount} found
          </span>
        </div>
        <button
          type="button"
          onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'auto') })}
          disabled={autoCount === 0}
          className="mt-3 flex items-center gap-2 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 transition-all hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eraser size={11} />
          Clear Auto Marks
        </button>
      </section>

      <section>
        <h2 className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">
          <Paintbrush size={12} /> Manual
        </h2>
        <button
          type="button"
          onClick={() => onBrushActiveChange(!brushActive)}
          className={`mb-4 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition-all ${
            brushActive
              ? 'border-red-500 bg-red-500/15 text-red-300'
              : 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          <Paintbrush size={13} />
          {brushActive ? 'Brush Active' : 'Activate Brush'}
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
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Click or drag to add marks. Drag along a hair or scratch to lay down overlapping repairs. Hold Alt and click a mark to remove it. Press Backspace to remove the last manual mark.
        </p>
        <button
          type="button"
          onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'manual') })}
          disabled={manualCount === 0}
          className="mt-3 flex items-center gap-2 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 transition-all hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eraser size={11} />
          Clear Manual Marks
        </button>
      </section>

      <section className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">Summary</h2>
        <p className="text-sm text-zinc-300">{autoCount} auto + {manualCount} manual marks</p>
        <button
          type="button"
          onClick={() => updateDustRemoval({ marks: [] })}
          disabled={dustRemoval.marks.length === 0}
          className="mt-3 flex items-center gap-2 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 transition-all hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eraser size={11} />
          Clear All
        </button>
      </section>
    </div>
  );
});
