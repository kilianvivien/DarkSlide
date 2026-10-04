import { memo, useMemo, useState } from 'react';
import {
  ChevronDown,
  Crop as CropIcon,
  Film,
  Image as ImageIcon,
  Monitor,
  RectangleHorizontal,
  RectangleVertical,
  RotateCw,
  Ruler,
  ScanLine,
  Smartphone,
  Square,
} from 'lucide-react';
import { ASPECT_RATIOS, AspectRatioEntry } from '../constants';
import { CropSettings, CropTab } from '../types';
import { formatAspectRatio } from '../utils/aspectRatio';
import { createCenteredAspectCrop, rotateCropClockwise } from '../utils/imagePipeline';
import { Slider } from './Slider';
import { ARMED, SECTION_TITLE } from './ui';

type Orientation = 'landscape' | 'portrait';

// A free or auto crop within this relative error of a preset is shown as that
// preset, so the pane reflects what the crop already is.
const CROP_RATIO_MATCH_TOLERANCE = 0.035;

type RatioGroup = {
  key: string;
  label: string;
  category: CropTab;
  gauge?: '35mm' | 'Medium Format';
  iconEntry: AspectRatioEntry;
  portrait: number;
  landscape: number;
  square: boolean;
};

const CROP_TABS: CropTab[] = ['Film', 'Print', 'Social', 'Digital'];
const FILM_GAUGES: Array<'35mm' | 'Medium Format'> = ['35mm', 'Medium Format'];

function buildRatioGroups() {
  const groups: RatioGroup[] = [];
  const seenKeys = new Set<string>();

  for (const ratio of ASPECT_RATIOS) {
    if (ratio.value === null || !ratio.category) {
      continue;
    }

    const key = ratio.category === 'Film'
      ? `Film:${ratio.gauge}:${ratio.format}`
      : `${ratio.category}:${Math.min(ratio.value, 1 / ratio.value).toFixed(5)}`;

    if (seenKeys.has(key)) {
      continue;
    }

    const square = Math.abs(ratio.value - 1) < 0.0001;
    const landscape = square ? 1 : Math.max(ratio.value, 1 / ratio.value);
    const portrait = square ? 1 : Math.min(ratio.value, 1 / ratio.value);

    groups.push({
      key,
      label: ratio.format ?? ratio.name,
      category: ratio.category,
      gauge: ratio.gauge,
      iconEntry: ratio,
      portrait,
      landscape,
      square,
    });
    seenKeys.add(key);
  }

  return groups;
}

const RATIO_GROUPS = buildRatioGroups();

interface CropPaneProps {
  crop: CropSettings;
  cropSource?: 'auto' | 'manual' | null;
  rotation: number;
  levelAngle: number;
  imageWidth: number;
  imageHeight: number;
  cropTab: CropTab;
  onCropTabChange: (tab: CropTab) => void;
  onCropChange: (crop: CropSettings) => void;
  onRotate: (rotation: number, crop: CropSettings) => void;
  onLevelAngleChange: (levelAngle: number) => void;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  straightenActive?: boolean;
  onStraightenActiveChange?: (active: boolean) => void;
  onRedetectFrame?: () => void;
  onDone: () => void;
  onResetCrop: () => void;
}

export const CropPane = memo(function CropPane({
  crop,
  cropSource,
  rotation,
  levelAngle,
  imageWidth,
  imageHeight,
  cropTab,
  onCropTabChange,
  onCropChange,
  onRotate,
  onLevelAngleChange,
  onLevelInteractionChange,
  straightenActive = false,
  onStraightenActiveChange,
  onRedetectFrame,
  onDone,
  onResetCrop,
}: CropPaneProps) {
  const [customWidth, setCustomWidth] = useState('2');
  const [customHeight, setCustomHeight] = useState('3');
  const [isCustomRatioOpen, setIsCustomRatioOpen] = useState(false);
  const [orientationMap, setOrientationMap] = useState<Record<string, Orientation>>({});

  const ratioGroupsByTab = useMemo(() => {
    const grouped = {
      Film: [] as RatioGroup[],
      Print: [] as RatioGroup[],
      Social: [] as RatioGroup[],
      Digital: [] as RatioGroup[],
    };

    for (const ratioGroup of RATIO_GROUPS) {
      grouped[ratioGroup.category].push(ratioGroup);
    }

    return grouped;
  }, []);

  const currentCropAspect = useMemo(() => {
    const cropWidth = crop.width * imageWidth;
    const cropHeight = crop.height * imageHeight;
    return cropHeight > 0 ? cropWidth / cropHeight : null;
  }, [crop.height, crop.width, imageHeight, imageWidth]);

  // Only crops DarkSlide set or the user drew (not the untouched full frame)
  // are matched to a preset.
  const selectedCurrentRatioGroup = useMemo(() => {
    if (!cropSource || !currentCropAspect) return null;

    let closest: { group: RatioGroup; orientation: Orientation; error: number } | null = null;
    for (const group of ratioGroupsByTab[cropTab]) {
      const candidates: Array<{ orientation: Orientation; value: number }> = group.square
        ? [{ orientation: 'landscape', value: 1 }]
        : [
          { orientation: 'landscape', value: group.landscape },
          { orientation: 'portrait', value: group.portrait },
        ];

      for (const candidate of candidates) {
        const error = Math.abs(currentCropAspect - candidate.value) / candidate.value;
        if (!closest || error < closest.error) {
          closest = { group, orientation: candidate.orientation, error };
        }
      }
    }

    return closest && closest.error <= CROP_RATIO_MATCH_TOLERANCE ? closest : null;
  }, [cropSource, cropTab, currentCropAspect, ratioGroupsByTab]);

  const handleRotate = () => {
    const nextRotation = (rotation + 90) % 360;
    onRotate(nextRotation, rotateCropClockwise(crop));
  };

  const handleAspectChange = (aspect: number | null) => {
    const newCrop: CropSettings = { ...crop, aspectRatio: aspect };

    if (aspect) {
      Object.assign(newCrop, createCenteredAspectCrop(aspect, imageWidth, imageHeight));
    } else {
      newCrop.x = 0;
      newCrop.y = 0;
      newCrop.width = 1;
      newCrop.height = 1;
    }

    onCropChange(newCrop);
  };

  const getIcon = (entry: AspectRatioEntry) => {
    if (entry.category === 'Film') return <Film size={14} />;

    switch (entry.name) {
      case '1:1':
        return <Square size={14} />;
      case '9:16':
        return <Smartphone size={14} />;
      case '16:9':
        return <Monitor size={14} />;
      default:
        return <ImageIcon size={14} />;
    }
  };

  const isAspectSelected = (preset: number) => (
    crop.aspectRatio !== null && Math.abs(crop.aspectRatio - preset) < 0.0001
  );

  const isFreeSelected = crop.aspectRatio === null && selectedCurrentRatioGroup === null;

  const isGroupSelected = (group: RatioGroup) => (
    crop.aspectRatio !== null
      ? isAspectSelected(group.landscape) || isAspectSelected(group.portrait)
      : selectedCurrentRatioGroup?.group.key === group.key
  );

  const getGroupOrientation = (group: RatioGroup) => {
    if (selectedCurrentRatioGroup?.group.key === group.key) {
      return selectedCurrentRatioGroup.orientation;
    }

    if (orientationMap[group.key]) {
      return orientationMap[group.key];
    }

    if (isAspectSelected(group.portrait)) {
      return 'portrait';
    }

    return 'landscape';
  };

  const getGroupAspectValue = (group: RatioGroup) => (
    getGroupOrientation(group) === 'portrait' ? group.portrait : group.landscape
  );

  const handleGroupSelect = (group: RatioGroup) => {
    handleAspectChange(getGroupAspectValue(group));
  };

  const handleToggleOrientation = (group: RatioGroup) => {
    if (group.square) {
      return;
    }

    const nextOrientation = getGroupOrientation(group) === 'landscape' ? 'portrait' : 'landscape';
    setOrientationMap((current) => ({
      ...current,
      [group.key]: nextOrientation,
    }));

    if (isGroupSelected(group)) {
      handleAspectChange(nextOrientation === 'portrait' ? group.portrait : group.landscape);
    }
  };

  const handleCustomAspectApply = () => {
    const width = Number(customWidth);
    const height = Number(customHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }

    handleAspectChange(width / height);
  };

  const renderRatioButton = (group: RatioGroup) => {
    const selected = isGroupSelected(group);
    const orientation = getGroupOrientation(group);
    const sharedClassName = selected
      ? 'bg-zinc-100 text-zinc-950 border-white shadow-lg'
      : 'bg-zinc-900/50 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200';

    return (
      <div
        key={group.key}
        className={`flex overflow-hidden rounded-lg border transition-all ${sharedClassName}`}
      >
        <button
          type="button"
          onClick={() => handleGroupSelect(group)}
          className="flex flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
        >
          <span className="opacity-60">{getIcon(group.iconEntry)}</span>
          <div className="flex flex-col items-start leading-tight">
            <span className="font-medium">{group.label}</span>
            <span className={`text-[9px] uppercase tracking-wider opacity-50 ${selected ? 'text-zinc-700' : 'text-zinc-500'}`}>
              {orientation}
            </span>
          </div>
        </button>
        {!group.square && (
          <button
            type="button"
            aria-label={`${group.label} ${orientation === 'landscape' ? 'switch to portrait' : 'switch to landscape'}`}
            onClick={() => handleToggleOrientation(group)}
            className={`flex items-center justify-center border-l px-3 transition-colors ${
              selected
                ? 'border-zinc-300/70 hover:bg-zinc-200'
                : 'border-zinc-800 hover:bg-zinc-700/60'
            }`}
          >
            {orientation === 'landscape' ? <RectangleHorizontal size={14} /> : <RectangleVertical size={14} />}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-7">
      <section>
        <h2 className={SECTION_TITLE}>
          <RotateCw size={12} /> Orientation
        </h2>
        <button
          onClick={handleRotate}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[13px] font-medium text-zinc-200 transition-[color,background-color,border-color,transform] duration-150 hover:border-zinc-700 hover:bg-zinc-800 active:scale-[0.99]"
        >
          <RotateCw size={14} className="text-zinc-400" />
          <span>Rotate 90° Clockwise</span>
          <span className="ml-auto rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
            {rotation}°
          </span>
        </button>
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/35 p-3">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-zinc-300">Straighten</p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                Draw along a horizon or vertical edge in the photo to level it.
              </p>
            </div>
            {onStraightenActiveChange && (
              <button
                type="button"
                aria-pressed={straightenActive}
                onClick={() => onStraightenActiveChange(!straightenActive)}
                className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  straightenActive
                    ? ARMED
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <Ruler size={12} /> {straightenActive ? 'Drawing' : 'Draw line'}
              </button>
            )}
          </div>
          <Slider
            label="Level"
            value={levelAngle}
            min={-10}
            max={10}
            step={0.1}
            fineStep={0.1}
            valueLabel={`${levelAngle.toFixed(1)}°`}
            onChange={onLevelAngleChange}
            onInteractionStart={() => onLevelInteractionChange?.(true)}
            onInteractionEnd={() => onLevelInteractionChange?.(false)}
          />
          <button
            type="button"
            onClick={() => onLevelAngleChange(0)}
            disabled={Math.abs(levelAngle) < 0.05}
            className="mt-0.5 rounded-md px-1 py-0.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-200 disabled:cursor-default disabled:text-zinc-700"
          >
            Reset Level
          </button>
        </div>
      </section>

      <section>
        <h2 className={SECTION_TITLE}>
          <CropIcon size={12} /> Aspect Ratio Presets
        </h2>
        {imageWidth > 0 && imageHeight > 0 && (
          <p className="-mt-2 mb-3 font-mono text-[10px] tabular-nums text-zinc-500" data-testid="crop-current-size">
            {Math.round(crop.width * imageWidth)} × {Math.round(crop.height * imageHeight)} px
            <span className="ml-2 text-zinc-400">{formatAspectRatio(crop.width * imageWidth, crop.height * imageHeight)}</span>
          </p>
        )}

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handleAspectChange(null)}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-all ${
              isFreeSelected
                ? 'bg-zinc-100 text-zinc-950 border-white shadow-lg'
                : 'bg-zinc-900/50 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            <span className="opacity-60"><CropIcon size={14} /></span>
            <div className="flex flex-col items-start leading-tight">
              <span className="font-medium">Free</span>
              <span className={`text-[9px] uppercase tracking-wider opacity-50 ${isFreeSelected ? 'text-zinc-700' : 'text-zinc-500'}`}>
                Unlocked
              </span>
            </div>
          </button>
          {onRedetectFrame && (
            <button
              type="button"
              onClick={onRedetectFrame}
              className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-sm font-medium text-zinc-400 transition-all hover:bg-zinc-800 hover:text-zinc-200"
            >
              <ScanLine size={14} className="shrink-0 opacity-60" />
              <div className="flex flex-col items-start leading-tight">
                <span className="font-medium">Auto Crop</span>
                <span className="text-[9px] uppercase tracking-wider opacity-50 text-zinc-500">Detect</span>
              </div>
            </button>
          )}
        </div>

        <div className="flex gap-4 border-b border-zinc-800">
          {CROP_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onCropTabChange(tab)}
              className={`pb-2 text-[11px] font-semibold uppercase tracking-widest border-b-2 transition-all ${
                cropTab === tab ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {cropTab === 'Film' ? (
            FILM_GAUGES.map((gauge) => (
              <div key={gauge} className="space-y-2">
                <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">{gauge}</h3>
                <div className="space-y-2">
                  {ratioGroupsByTab.Film.filter((group) => group.gauge === gauge).map(renderRatioButton)}
                </div>
              </div>
            ))
          ) : (
            <div className="space-y-2">
              {ratioGroupsByTab[cropTab].map(renderRatioButton)}
            </div>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/70 bg-zinc-900/30">
          <button
            type="button"
            onClick={() => setIsCustomRatioOpen((current) => !current)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-900/40"
          >
            <h3 className="text-sm font-medium text-zinc-200">Custom Ratio</h3>
            <ChevronDown
              size={16}
              className={`shrink-0 text-zinc-500 transition-transform ${isCustomRatioOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isCustomRatioOpen && (
            <div className="border-t border-zinc-800/70 p-4">
              <div className="mb-3 flex items-center justify-end">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  Width / Height
                </span>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <input
                  aria-label="Custom crop width"
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={customWidth}
                  onChange={(event) => setCustomWidth(event.target.value)}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                />
                <span className="text-sm text-zinc-500">×</span>
                <div className="min-w-0">
                  <input
                    aria-label="Custom crop height"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={customHeight}
                    onChange={(event) => setCustomHeight(event.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-500"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleCustomAspectApply}
                className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-medium text-zinc-200 transition-all hover:bg-zinc-900 hover:text-white"
              >
                Apply Custom Ratio
              </button>
            </div>
          )}
        </div>
      </section>

      {cropSource === 'auto' && (
        <p className="flex items-center gap-2 px-1 text-[11px] text-zinc-500">
          <ScanLine size={12} className="shrink-0" /> Crop set by auto detection
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={onResetCrop}
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[13px] font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
        >
          Reset Crop
        </button>
        <button
          onClick={onDone}
          className="flex-1 rounded-lg bg-zinc-100 px-4 py-2.5 text-[13px] font-semibold text-zinc-950 shadow-lg shadow-black/20 transition-colors hover:bg-white"
        >
          Done
        </button>
      </div>
    </div>
  );
});
