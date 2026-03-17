import React, { memo, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  BarChart3,
  Circle,
  Download,
  Eraser,
  Focus,
  Info,
  Pipette,
  Settings,
  Settings2,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react';
import { ConversionSettings, CropTab, Curves, ExportFormat, ExportOptions, FilmProfile, HistogramData } from '../types';
import { CropPane } from './CropPane';
import { CurvesControl } from './CurvesControl';
import { Histogram } from './Histogram';
import { Slider } from './Slider';

const ADJUST_PANE_INITIAL = { opacity: 0, x: -10 };
const ADJUST_PANE_ANIMATE = { opacity: 1, x: 0 };
const ADJUST_PANE_EXIT = { opacity: 0, x: 10 };
const CURVES_PANE_INITIAL = { opacity: 0, x: 10 };
const CURVES_PANE_ANIMATE = { opacity: 1, x: 0 };
const CURVES_PANE_EXIT = { opacity: 0, x: -10 };
const VERTICAL_PANE_INITIAL = { opacity: 0, y: 10 };
const VERTICAL_PANE_ANIMATE = { opacity: 1, y: 0 };
const VERTICAL_PANE_EXIT = { opacity: 0, y: -10 };

const POINT_PICKERS = [
  { mode: 'black' as const, label: 'Black', swatchClass: 'bg-zinc-950 border-zinc-700' },
  { mode: 'grey' as const, label: 'Grey', swatchClass: 'bg-zinc-500 border-zinc-400' },
  { mode: 'white' as const, label: 'White', swatchClass: 'bg-white border-zinc-300' },
];

type ScalarSliderKey =
  | 'exposure'
  | 'contrast'
  | 'blackPoint'
  | 'whitePoint'
  | 'highlightProtection'
  | 'saturation'
  | 'temperature'
  | 'tint'
  | 'redBalance'
  | 'greenBalance'
  | 'blueBalance';

const SCALAR_SLIDER_KEYS: ScalarSliderKey[] = [
  'exposure',
  'contrast',
  'blackPoint',
  'whitePoint',
  'highlightProtection',
  'saturation',
  'temperature',
  'tint',
  'redBalance',
  'greenBalance',
  'blueBalance',
];

function histPercentile(bins: number[], p: number): number {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return p < 0.5 ? 0 : 255;
  const target = total * p;
  let cumsum = 0;
  for (let i = 0; i < bins.length; i += 1) {
    cumsum += bins[i];
    if (cumsum >= target) return i;
  }
  return bins.length - 1;
}

function computeAutoBalance(data: HistogramData, isColor: boolean): Curves {
  const lo_l = histPercentile(data.l, 0.001);
  const hi_l = histPercentile(data.l, 0.999);
  const safeRgb = hi_l > lo_l
    ? [{ x: lo_l, y: 0 }, { x: hi_l, y: 255 }]
    : [{ x: 0, y: 0 }, { x: 255, y: 255 }];

  if (!isColor) {
    return {
      rgb: safeRgb,
      red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    };
  }

  const lo_r = histPercentile(data.r, 0.001);
  const hi_r = histPercentile(data.r, 0.999);
  const lo_g = histPercentile(data.g, 0.001);
  const hi_g = histPercentile(data.g, 0.999);
  const lo_b = histPercentile(data.b, 0.001);
  const hi_b = histPercentile(data.b, 0.999);

  return {
    rgb: safeRgb,
    red: hi_r > lo_r ? [{ x: lo_r, y: 0 }, { x: hi_r, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    green: hi_g > lo_g ? [{ x: lo_g, y: 0 }, { x: hi_g, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    blue: hi_b > lo_b ? [{ x: lo_b, y: 0 }, { x: hi_b, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  };
}

interface SidebarProps {
  settings: ConversionSettings;
  exportOptions: ExportOptions;
  cropImageWidth: number;
  cropImageHeight: number;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  onSettingsChange: (settings: Partial<ConversionSettings>) => void;
  onExportOptionsChange: (options: Partial<ExportOptions>) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  activeProfile: FilmProfile | null;
  histogramData: HistogramData | null;
  isPickingFilmBase: boolean;
  onTogglePicker: () => void;
  onExport: () => void;
  isExporting: boolean;
  activeTab: 'adjust' | 'curves' | 'crop' | 'export';
  onTabChange: (tab: 'adjust' | 'curves' | 'crop' | 'export') => void;
  cropTab: CropTab;
  onCropTabChange: (tab: CropTab) => void;
  onCropDone: () => void;
  onResetCrop: () => void;
  activePointPicker: 'black' | 'white' | 'grey' | null;
  onSetPointPicker: (mode: 'black' | 'white' | 'grey' | null) => void;
  onOpenSettings: () => void;
}

export const Sidebar = memo(function Sidebar({
  settings,
  exportOptions,
  cropImageWidth,
  cropImageHeight,
  onLevelInteractionChange,
  onSettingsChange,
  onExportOptionsChange,
  onInteractionStart,
  onInteractionEnd,
  activeProfile,
  histogramData,
  isPickingFilmBase,
  onTogglePicker,
  onExport,
  isExporting,
  activeTab,
  onTabChange,
  cropTab,
  onCropTabChange,
  onCropDone,
  onResetCrop,
  activePointPicker,
  onSetPointPicker,
  onOpenSettings,
}: SidebarProps) {
  const isColor = activeProfile?.type === 'color';
  const filmBaseInstruction = isPickingFilmBase
    ? 'Click an unexposed film-base area…'
    : 'Sample Film Base';

  const scalarSliderHandlers = useMemo(() => {
    const entries = SCALAR_SLIDER_KEYS.map((key) => [
      key,
      (value: number) => onSettingsChange({ [key]: value } as Pick<ConversionSettings, typeof key>),
    ]);
    return Object.fromEntries(entries) as Record<ScalarSliderKey, (value: number) => void>;
  }, [onSettingsChange]);

  const handleBlackAndWhiteEnabledChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        enabled: event.target.checked,
      },
    });
  }, [onSettingsChange, settings.blackAndWhite]);

  const handleBlackAndWhiteRedChange = useCallback((value: number) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        redMix: value,
      },
    });
  }, [onSettingsChange, settings.blackAndWhite]);

  const handleBlackAndWhiteGreenChange = useCallback((value: number) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        greenMix: value,
      },
    });
  }, [onSettingsChange, settings.blackAndWhite]);

  const handleBlackAndWhiteBlueChange = useCallback((value: number) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        blueMix: value,
      },
    });
  }, [onSettingsChange, settings.blackAndWhite]);

  const handleBlackAndWhiteToneChange = useCallback((value: number) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        tone: value,
      },
    });
  }, [onSettingsChange, settings.blackAndWhite]);

  const handleSharpenEnabledChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({
      sharpen: {
        ...settings.sharpen,
        enabled: event.target.checked,
      },
    });
  }, [onSettingsChange, settings.sharpen]);

  const handleSharpenAmountChange = useCallback((value: number) => {
    onSettingsChange({
      sharpen: {
        ...settings.sharpen,
        amount: value,
      },
    });
  }, [onSettingsChange, settings.sharpen]);

  const handleSharpenRadiusChange = useCallback((value: number) => {
    onSettingsChange({
      sharpen: {
        ...settings.sharpen,
        radius: value,
      },
    });
  }, [onSettingsChange, settings.sharpen]);

  const handleNoiseReductionEnabledChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onSettingsChange({
      noiseReduction: {
        ...settings.noiseReduction,
        enabled: event.target.checked,
      },
    });
  }, [onSettingsChange, settings.noiseReduction]);

  const handleNoiseReductionStrengthChange = useCallback((value: number) => {
    onSettingsChange({
      noiseReduction: {
        ...settings.noiseReduction,
        luminanceStrength: value,
      },
    });
  }, [onSettingsChange, settings.noiseReduction]);

  const handleCurvesChange = useCallback((curves: Curves) => {
    onSettingsChange({ curves });
  }, [onSettingsChange]);

  const handleAutoBalance = useCallback(() => {
    if (!histogramData) {
      return;
    }
    onSettingsChange({ curves: computeAutoBalance(histogramData, isColor) });
  }, [histogramData, isColor, onSettingsChange]);

  const handleCropChange = useCallback((crop: ConversionSettings['crop']) => {
    onSettingsChange({ crop });
  }, [onSettingsChange]);

  const handleCropRotate = useCallback((rotation: number, crop: ConversionSettings['crop']) => {
    onSettingsChange({ rotation, crop });
  }, [onSettingsChange]);

  const handleLevelAngleChange = useCallback((levelAngle: number) => {
    onSettingsChange({ levelAngle });
  }, [onSettingsChange]);

  const handleExportQualityChange = useCallback((value: number) => {
    onExportOptionsChange({ quality: value / 100 });
  }, [onExportOptionsChange]);

  const handleFilenameChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onExportOptionsChange({ filenameBase: event.target.value });
  }, [onExportOptionsChange]);

  const handleEmbedMetadataChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onExportOptionsChange({ embedMetadata: event.target.checked });
  }, [onExportOptionsChange]);

  const handlePointPickerToggle = useCallback((mode: 'black' | 'white' | 'grey') => {
    onSetPointPicker(activePointPicker === mode ? null : mode);
  }, [activePointPicker, onSetPointPicker]);

  return (
    <div className="w-80 h-full bg-zinc-950 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-800 bg-zinc-900/20 shrink-0">
        <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-3 flex items-center gap-2">
          <BarChart3 size={12} /> Histogram
        </h2>
        <Histogram data={histogramData} />
      </div>

      <div className="flex px-6 pt-4 gap-4 shrink-0">
        {(['adjust', 'curves', 'crop', 'export'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`pb-2 text-[11px] uppercase tracking-widest font-semibold border-b-2 transition-all ${
              activeTab === tab ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="p-6 space-y-8">
          <AnimatePresence mode="wait">
            {activeTab === 'adjust' ? (
              <motion.div
                key="adjust"
                initial={ADJUST_PANE_INITIAL}
                animate={ADJUST_PANE_ANIMATE}
                exit={ADJUST_PANE_EXIT}
                className="space-y-8"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Pipette size={12} /> Film Base
                    <button
                      data-tip="Sample an unexposed area of the negative to neutralize the film base using color balance."
                      className="ml-1 text-zinc-700 hover:text-zinc-500 transition-colors"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                  </h2>
                  <button
                    onClick={onTogglePicker}
                    className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                      isPickingFilmBase
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-800'
                    }`}
                  >
                    <Pipette size={16} className={isPickingFilmBase ? 'animate-pulse' : ''} />
                    <span className="text-sm font-medium">{filmBaseInstruction}</span>
                  </button>
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <SlidersHorizontal size={12} /> Basic Adjustments
                  </h2>

                  <Slider label="Exposure" value={settings.exposure} min={-100} max={100} onChange={scalarSliderHandlers.exposure} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="Contrast" value={settings.contrast} min={-100} max={100} onChange={scalarSliderHandlers.contrast} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="Black Point" value={settings.blackPoint} min={0} max={80} onChange={scalarSliderHandlers.blackPoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="White Point" value={settings.whitePoint} min={180} max={255} onChange={scalarSliderHandlers.whitePoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider
                    label="Highlight Protection"
                    value={settings.highlightProtection}
                    min={0}
                    max={100}
                    onChange={scalarSliderHandlers.highlightProtection}
                    unit="%"
                    onInteractionStart={onInteractionStart}
                    onInteractionEnd={onInteractionEnd}
                  />

                  {isColor && !settings.blackAndWhite.enabled && (
                    <>
                      <Slider label="Saturation" value={settings.saturation} min={0} max={200} onChange={scalarSliderHandlers.saturation} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Temperature" value={settings.temperature} min={-100} max={100} onChange={scalarSliderHandlers.temperature} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Tint" value={settings.tint} min={-100} max={100} onChange={scalarSliderHandlers.tint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </>
                  )}
                </section>

                {isColor && (
                  <section>
                    <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                      <Settings2 size={12} /> Color Balance
                    </h2>
                    <Slider label="Red Balance" value={settings.redBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.redBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Green Balance" value={settings.greenBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.greenBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Blue Balance" value={settings.blueBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.blueBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && (
                  <section>
                    <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                      <Circle size={12} /> Convert to Black and White
                    </h2>
                    <label className="flex items-center gap-2 mb-4 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.blackAndWhite.enabled}
                        onChange={handleBlackAndWhiteEnabledChange}
                        className="accent-zinc-200"
                      />
                      <span className="text-[11px] text-zinc-400">Enable</span>
                    </label>
                    {settings.blackAndWhite.enabled && (
                      <>
                        <Slider label="Red" value={settings.blackAndWhite.redMix} min={-100} max={100} onChange={handleBlackAndWhiteRedChange} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <Slider label="Green" value={settings.blackAndWhite.greenMix} min={-100} max={100} onChange={handleBlackAndWhiteGreenChange} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <Slider label="Blue" value={settings.blackAndWhite.blueMix} min={-100} max={100} onChange={handleBlackAndWhiteBlueChange} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <Slider label="Tone" value={settings.blackAndWhite.tone} min={-100} max={100} onChange={handleBlackAndWhiteToneChange} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      </>
                    )}
                  </section>
                )}

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Focus size={12} /> Sharpen
                  </h2>
                  <label className="flex items-center gap-2 mb-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.sharpen.enabled}
                      onChange={handleSharpenEnabledChange}
                      className="accent-zinc-200"
                    />
                    <span className="text-[11px] text-zinc-400">Enable</span>
                  </label>
                  {settings.sharpen.enabled && (
                    <>
                      <Slider label="Amount" value={settings.sharpen.amount} min={0} max={200} onChange={handleSharpenAmountChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Radius" value={settings.sharpen.radius} min={0.5} max={3} step={0.1} onChange={handleSharpenRadiusChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </>
                  )}
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Eraser size={12} /> Noise Reduction
                  </h2>
                  <label className="flex items-center gap-2 mb-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.noiseReduction.enabled}
                      onChange={handleNoiseReductionEnabledChange}
                      className="accent-zinc-200"
                    />
                    <span className="text-[11px] text-zinc-400">Enable</span>
                  </label>
                  {settings.noiseReduction.enabled && (
                    <Slider label="Luminance" value={settings.noiseReduction.luminanceStrength} min={0} max={100} onChange={handleNoiseReductionStrengthChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  )}
                </section>
              </motion.div>
            ) : activeTab === 'curves' ? (
              <motion.div
                key="curves"
                initial={CURVES_PANE_INITIAL}
                animate={CURVES_PANE_ANIMATE}
                exit={CURVES_PANE_EXIT}
                className="space-y-6"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <Activity size={12} /> RGB Curves
                  </h2>
                  <CurvesControl curves={settings.curves} onChange={handleCurvesChange} isColor={isColor} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Pipette size={12} /> Point Pickers</span>
                    {histogramData && (
                      <button
                        data-tip="Auto-balance: stretch levels to histogram data range, correct color balance"
                        onClick={handleAutoBalance}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 text-[10px] font-semibold uppercase tracking-widest transition-all"
                      >
                        <Wand2 size={10} />
                        Auto
                      </button>
                    )}
                  </h2>
                  <div className="flex gap-2">
                    {POINT_PICKERS.map(({ mode, label, swatchClass }) => (
                      <button
                        key={mode}
                        data-tip={`Set ${label} Point — click a pixel on the image`}
                        onClick={() => handlePointPickerToggle(mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border text-[11px] font-medium transition-all ${
                          activePointPicker === mode
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <span className={`inline-block w-2.5 h-2.5 rounded-full border shrink-0 ${swatchClass}`} />
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
              </motion.div>
            ) : activeTab === 'crop' ? (
              <motion.div
                key="crop"
                initial={VERTICAL_PANE_INITIAL}
                animate={VERTICAL_PANE_ANIMATE}
                exit={VERTICAL_PANE_EXIT}
              >
                <CropPane
                  crop={settings.crop}
                  rotation={settings.rotation}
                  levelAngle={settings.levelAngle}
                  imageWidth={cropImageWidth}
                  imageHeight={cropImageHeight}
                  cropTab={cropTab}
                  onCropTabChange={onCropTabChange}
                  onCropChange={handleCropChange}
                  onRotate={handleCropRotate}
                  onLevelAngleChange={handleLevelAngleChange}
                  onLevelInteractionChange={onLevelInteractionChange}
                  onDone={onCropDone}
                  onResetCrop={onResetCrop}
                />
              </motion.div>
            ) : (
              <motion.div
                key="export"
                initial={VERTICAL_PANE_INITIAL}
                animate={VERTICAL_PANE_ANIMATE}
                exit={VERTICAL_PANE_EXIT}
                className="space-y-8"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <Download size={12} /> Export Settings
                  </h2>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Format</label>
                      <div className="grid grid-cols-3 gap-2">
                        {(['image/jpeg', 'image/png', 'image/webp'] as ExportFormat[]).map((format) => (
                          <button
                            key={format}
                            onClick={() => onExportOptionsChange({ format })}
                            className={`px-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-tighter transition-all border ${
                              exportOptions.format === format
                                ? 'bg-zinc-100 text-zinc-950 border-white shadow-lg'
                                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-300'
                            }`}
                          >
                            {format.split('/')[1]}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Filename</label>
                      <input
                        type="text"
                        value={exportOptions.filenameBase}
                        onChange={handleFilenameChange}
                        className="w-full select-text px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 outline-none focus:border-zinc-600"
                        placeholder="darkslide-converted"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </div>

                    {exportOptions.format !== 'image/png' && (
                      <Slider
                        label="Quality"
                        value={Math.round(exportOptions.quality * 100)}
                        min={10}
                        max={100}
                        onChange={handleExportQualityChange}
                        unit="%"
                      />
                    )}

                    <label
                      className="flex items-center gap-2 text-xs text-zinc-400"
                      data-tip="Include camera info, date, and a DarkSlide software tag in the exported file. Disable for privacy."
                    >
                      <input
                        type="checkbox"
                        checked={exportOptions.embedMetadata}
                        onChange={handleEmbedMetadataChange}
                        className="rounded border-zinc-600 bg-zinc-800"
                      />
                      Embed metadata
                    </label>
                  </div>
                </section>

                <button
                  onClick={onExport}
                  disabled={isExporting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zinc-100 text-zinc-950 rounded-xl text-sm font-semibold hover:bg-white transition-all shadow-lg shadow-black/20 disabled:opacity-50"
                >
                  {isExporting ? (
                    <>
                      <Download size={16} className="animate-bounce" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Download size={16} />
                      Export Image
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="shrink-0 px-6 py-3 border-t border-zinc-800/50 flex items-center justify-end">
        <button
          onClick={onOpenSettings}
          data-tip="Settings (⌘,)"
          className="p-1.5 text-zinc-700 hover:text-zinc-400 hover:bg-zinc-800 rounded-lg transition-all"
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
});
