import { memo, useCallback, useMemo } from 'react';
import { Eraser, FlaskConical, Paintbrush, Sparkles } from 'lucide-react';
import { DustRemovalSettings } from '../types';
import { Slider } from './Slider';
import { PANEL_BUTTON, panelToggleButton, SECTION_TITLE, SEGMENT_TRACK, segmentItem } from './ui';

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
    <div className="space-y-7">

      {/* ── Manual ── */}
      <section>
        <h2 className={SECTION_TITLE}>
          <Paintbrush size={12} /> Manual
        </h2>
        <button
          type="button"
          onClick={() => onBrushActiveChange(!brushActive)}
          aria-pressed={brushActive}
          className={`mb-4 ${panelToggleButton(brushActive)}`}
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
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
          Paint over dust or scratches directly on the image. Click a manual mark to resize it with the brush shortcuts. <span className="text-zinc-600">Alt-click removes a mark, and Backspace removes the last manual one.</span>
        </p>
        {manualCount > 0 && (
          <button
            type="button"
            onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'manual') })}
            className="mt-3 flex items-center gap-2 rounded-md px-1 py-0.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <Eraser size={11} />
            Clear {manualCount} manual {manualCount === 1 ? 'mark' : 'marks'}
          </button>
        )}
      </section>

      {/* ── Auto Detection (Beta) ── */}
      <section>
        <h2 className={SECTION_TITLE}>
          <Sparkles size={12} /> Auto Detection
          <span className="ml-auto flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">
            <FlaskConical size={8} /> Beta
          </span>
        </h2>

        <div className="space-y-4">
          <div className={`${SEGMENT_TRACK} grid-cols-3`}>
            {([
              ['spots', 'Spots'],
              ['scratches', 'Scratches'],
              ['both', 'Both'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => updateDustRemoval({ autoDetectMode: value })}
                aria-pressed={dustRemoval.autoDetectMode === value}
                className={segmentItem(dustRemoval.autoDetectMode === value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-0.5">
            <Slider
              label="Detection Bias"
              value={dustRemoval.autoSensitivity}
              min={0}
              max={100}
              onChange={(value) => updateDustRemoval({ autoSensitivity: value })}
              onInteractionStart={onInteractionStart}
              onInteractionEnd={onInteractionEnd}
            />
            <p className="-mt-1 text-[11px] leading-relaxed text-zinc-500">
              Lower favors precision. Higher tries to catch more defects.
            </p>
          </div>

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

          <button
            type="button"
            onClick={onDetectNow}
            disabled={isDetecting}
            className={PANEL_BUTTON}
          >
            <Sparkles size={13} />
            {isDetecting ? 'Detecting…' : 'Detect Now'}
          </button>

          {(autoCount > 0 || dustRemoval.autoEnabled) && (
            <div className="flex items-center justify-between gap-3">
              <span>
                {autoCount > 0 ? (
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                    {autoSpotCount} spots · {autoPathCount} paths
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">Runs automatically when enabled below.</span>
                )}
              </span>
              {autoCount > 0 && (
                <button
                  type="button"
                  onClick={() => updateDustRemoval({ marks: dustRemoval.marks.filter((mark) => mark.source !== 'auto') })}
                  className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 font-semibold text-zinc-500 transition-all hover:text-zinc-300"
                >
                  <Eraser size={11} />
                  Clear
                </button>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dustRemoval.autoEnabled}
              onChange={(event) => updateDustRemoval({ autoEnabled: event.target.checked })}
            />
            <span className="text-[11px] text-zinc-400">Auto-detect on image load</span>
          </label>
        </div>
      </section>

    </div>
  );
});
