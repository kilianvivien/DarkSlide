import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  BarChart3,
  Circle,
  Download,
  Eraser,
  Focus,
  FolderOutput,
  Info,
  Loader2,
  Pipette,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Thermometer,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react';
import { ColorManagementSettings, ColorProfileId, ConversionSettings, CropTab, Curves, EditorTool, ExportFormat, ExportOptions, FilmBaseEstimate, FilmProfile, HistogramData, LabStyleProfile, LightSourceProfile, PointPickerMode, QuickExportPreset, SourceMetadata } from '../types';
import { CropPane } from './CropPane';
import { CurvesControl } from './CurvesControl';
import { Histogram } from './Histogram';
import { Slider } from './Slider';
import { GroupSwitch } from './GroupSwitch';
import { ExportFramesControl, FrameExportProgress } from './ExportFramesControl';
import { ARMED, FIELD_LABEL, HEADER_ACTION, PANEL_BUTTON, panelToggleButton, SECTION_TITLE, SEGMENT_TRACK, SELECT_INPUT, segmentItem } from './ui';

const noop = () => undefined;

// A switched-off group stays editable but reads as inactive.
const GROUP_DISABLED_CLASS = 'opacity-45 transition-opacity hover:opacity-80';
import { DustPane } from './DustPane';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { DEFAULT_DUST_REMOVAL, FILM_BASE_CONFIDENCE, resolveDustRemovalSettings } from '../constants';

// Pane switches wait for the old pane to leave, so both halves stay short and
// use tweens: motion's default spring on x took several hundred ms to settle
// and made every tool switch feel slow.
const PANE_ENTER_TRANSITION = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };
const PANE_EXIT_TRANSITION = { duration: 0.08, ease: 'easeIn' as const };
const ADJUST_PANE_INITIAL = { opacity: 0, x: -8 };
const ADJUST_PANE_ANIMATE = { opacity: 1, x: 0, transition: PANE_ENTER_TRANSITION };
const ADJUST_PANE_EXIT = { opacity: 0, x: 8, transition: PANE_EXIT_TRANSITION };
const CURVES_PANE_INITIAL = { opacity: 0, x: 8 };
const CURVES_PANE_ANIMATE = { opacity: 1, x: 0, transition: PANE_ENTER_TRANSITION };
const CURVES_PANE_EXIT = { opacity: 0, x: -8, transition: PANE_EXIT_TRANSITION };
const VERTICAL_PANE_INITIAL = { opacity: 0, y: 8 };
const VERTICAL_PANE_ANIMATE = { opacity: 1, y: 0, transition: PANE_ENTER_TRANSITION };
const VERTICAL_PANE_EXIT = { opacity: 0, y: -8, transition: PANE_EXIT_TRANSITION };

const POINT_PICKERS = [
  { mode: 'black' as const, label: 'Black', swatchClass: 'bg-zinc-950 border-zinc-700' },
  { mode: 'grey' as const, label: 'Grey', swatchClass: 'bg-zinc-500 border-zinc-400' },
  { mode: 'white' as const, label: 'White', swatchClass: 'bg-white border-zinc-300' },
];

const COLOR_PROFILE_IDS: ColorProfileId[] = ['srgb', 'display-p3', 'adobe-rgb', 'linear'];

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
  quickExportPresets: QuickExportPreset[];
  colorManagement: ColorManagementSettings;
  sourceMetadata: SourceMetadata | null;
  cropImageWidth: number;
  cropImageHeight: number;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  straightenActive?: boolean;
  onStraightenActiveChange?: (active: boolean) => void;
  onSettingsChange: (settings: Partial<ConversionSettings>) => void;
  onExportOptionsChange: (options: Partial<ExportOptions>) => void;
  onColorManagementChange: (options: Partial<ColorManagementSettings>) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  activeProfile: FilmProfile | null;
  activeLabStyleId?: string | null;
  labStyleProfiles?: LabStyleProfile[];
  estimatedFlare?: [number, number, number] | null;
  lightSourceId?: string | null;
  cropSource?: 'auto' | 'manual' | null;
  lightSourceProfiles?: LightSourceProfile[];
  histogramData: HistogramData | null;
  isPickingFilmBase: boolean;
  isReanalyzingFilmBase?: boolean;
  estimatedFilmBase?: FilmBaseEstimate | null;
  filmBaseSampleSource?: 'manual' | 'roll' | null;
  onTogglePicker: () => void;
  onReanalyzeFilmBase?: () => void;
  onExport: () => void;
  onQuickExport: (preset: QuickExportPreset) => void;
  onSaveQuickExportPreset: () => void;
  onDeleteQuickExportPreset: (presetId: string) => void;
  onOpenBatchExport: () => void;
  frameSelectionCount?: number;
  frameCount?: number;
  frameExportProgress?: FrameExportProgress | null;
  onExportFrames?: (scope: 'selected' | 'all') => void;
  onCancelFrameExport?: () => void;
  isExporting: boolean;
  contentScrollTop?: number;
  onContentScrollTopChange?: (scrollTop: number) => void;
  activeTab: EditorTool;
  cropTab: CropTab;
  onCropTabChange: (tab: CropTab) => void;
  onRedetectFrame?: () => void;
  onCropDone: () => void;
  onResetCrop: () => void;
  activePointPicker: PointPickerMode | null;
  onSetPointPicker: (mode: PointPickerMode | null) => void;
  onLightSourceChange?: (lightSourceId: string | null) => void;
  onLabStyleChange?: (labStyleId: string | null) => void;
  onAutoAdjust?: () => void;
  onAutoWhiteBalance?: () => void;
  onDustRemovalChange?: (dustRemoval: ConversionSettings['dustRemoval']) => void;
  onDetectDust?: () => void;
  isDetectingDust?: boolean;
  dustBrushActive?: boolean;
  onDustBrushActiveChange?: (active: boolean) => void;
}

export const Sidebar = memo(function Sidebar({
  settings,
  exportOptions,
  quickExportPresets,
  colorManagement,
  sourceMetadata,
  cropImageWidth,
  cropImageHeight,
  onLevelInteractionChange,
  straightenActive,
  onStraightenActiveChange,
  onSettingsChange,
  onExportOptionsChange,
  onColorManagementChange,
  onInteractionStart,
  onInteractionEnd,
  activeProfile,
  activeLabStyleId = null,
  labStyleProfiles = [],
  estimatedFlare,
  lightSourceId = null,
  cropSource = null,
  lightSourceProfiles = [],
  histogramData,
  isPickingFilmBase,
  isReanalyzingFilmBase = false,
  estimatedFilmBase = null,
  filmBaseSampleSource = null,
  onTogglePicker,
  onReanalyzeFilmBase,
  onExport,
  onQuickExport,
  onSaveQuickExportPreset,
  onDeleteQuickExportPreset,
  isExporting,
  activeTab,
  cropTab,
  onCropTabChange,
  onRedetectFrame,
  onCropDone,
  onResetCrop,
  activePointPicker,
  onSetPointPicker,
  onLightSourceChange,
  onLabStyleChange,
  onAutoAdjust,
  onAutoWhiteBalance,
  onDustRemovalChange,
  onDetectDust,
  isDetectingDust = false,
  dustBrushActive = false,
  onDustBrushActiveChange,
  onOpenBatchExport,
  frameSelectionCount = 1,
  frameCount = 1,
  frameExportProgress = null,
  onExportFrames = noop,
  onCancelFrameExport = noop,
  contentScrollTop = 0,
  onContentScrollTopChange,
}: SidebarProps) {
  const isColor = activeProfile?.type === 'color';
  const contentRef = useRef<HTMLDivElement>(null);
  void sourceMetadata;
  void estimatedFlare;
  const filmBaseInstruction = isPickingFilmBase
    ? 'Click a clear film-base area…'
    : 'Sample Film Base';
  const filmBaseLowConfidence = filmBaseSampleSource === null
    && estimatedFilmBase !== null
    && (estimatedFilmBase.confidence < FILM_BASE_CONFIDENCE.accept || estimatedFilmBase.source === 'low-confidence');
  const filmBaseStatus = filmBaseSampleSource === 'manual'
    ? 'Manual sample'
    : filmBaseSampleSource === 'roll'
      ? 'Roll sample'
      : estimatedFilmBase
        ? `${estimatedFilmBase.source === 'frame-rebate' ? 'Frame rebate' : estimatedFilmBase.source === 'in-frame' ? 'In-frame estimate' : estimatedFilmBase.source === 'low-confidence' ? 'Conservative fallback' : 'Automatic estimate'} · ${Math.round(estimatedFilmBase.confidence * 100)}%`
        : 'No base reference';

  useEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }

    if (Math.abs(element.scrollTop - contentScrollTop) > 1) {
      element.scrollTop = contentScrollTop;
    }
  }, [contentScrollTop]);

  const scalarSliderHandlers = useMemo(() => {
    const entries = SCALAR_SLIDER_KEYS.map((key) => [
      key,
      (value: number) => onSettingsChange({ [key]: value } as Pick<ConversionSettings, typeof key>),
    ]);
    return Object.fromEntries(entries) as Record<ScalarSliderKey, (value: number) => void>;
  }, [onSettingsChange]);

  const handleBlackAndWhiteEnabledChange = useCallback((enabled: boolean) => {
    onSettingsChange({
      blackAndWhite: {
        ...settings.blackAndWhite,
        enabled,
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

  const handleSharpenEnabledChange = useCallback((enabled: boolean) => {
    onSettingsChange({
      sharpen: {
        ...settings.sharpen,
        enabled,
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

  const handleNoiseReductionEnabledChange = useCallback((enabled: boolean) => {
    onSettingsChange({
      noiseReduction: {
        ...settings.noiseReduction,
        enabled,
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


  const handleOutputProfileChange = useCallback((outputProfileId: ColorProfileId) => {
    onColorManagementChange({ outputProfileId });
  }, [onColorManagementChange]);

  const handleEmbedOutputProfileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onColorManagementChange({ embedOutputProfile: event.target.checked });
  }, [onColorManagementChange]);

  const handlePointPickerToggle = useCallback((mode: 'black' | 'white' | 'grey') => {
    onSetPointPicker(activePointPicker === mode ? null : mode);
  }, [activePointPicker, onSetPointPicker]);

  const handleLightSourceSelect = useCallback((value: string) => {
    onLightSourceChange?.(value === 'auto' ? null : value);
  }, [onLightSourceChange]);
  const dustRemoval = useMemo(
    () => resolveDustRemovalSettings(settings.dustRemoval ?? DEFAULT_DUST_REMOVAL),
    [settings.dustRemoval],
  );

  const toneEnabled = settings.toneEnabled !== false;
  const toneRangeEnabled = settings.toneRangeEnabled !== false;
  const whiteBalanceEnabled = settings.whiteBalanceEnabled !== false;
  const colorControlsEnabled = settings.colorControlsEnabled !== false;

  // The histogram guides tone and color work; other tools get the space back.
  const showHistogram = activeTab === 'adjust' || activeTab === 'curves';

  const isWebpExport = exportOptions.format === 'image/webp';
  const showQualityControl = exportOptions.format !== 'image/png' && exportOptions.format !== 'image/tiff';
  const showBitDepthControl = exportOptions.format === 'image/png' || exportOptions.format === 'image/tiff';

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-zinc-950">
      {showHistogram && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/20 px-5 py-3">
          <Histogram data={histogramData} variant={isColor && !settings.blackAndWhite.enabled ? 'color' : 'neutral'} />
        </div>
      )}


      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto custom-scrollbar"
        onScroll={(event) => onContentScrollTopChange?.(event.currentTarget.scrollTop)}
      >
        <div className="space-y-7 px-5 py-5">
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
                  <h2 className={SECTION_TITLE}>
                    <Pipette size={12} /> Film Base
                    <button
                      data-tip="Sample an unexposed area of the negative to neutralize the film base using color balance."
                      aria-label="Film base sampling help"
                      className="ml-1 text-zinc-700 hover:text-zinc-500 transition-colors"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                  </h2>
                  <button
                    onClick={onTogglePicker}
                    aria-pressed={isPickingFilmBase}
                    className={panelToggleButton(isPickingFilmBase)}
                  >
                    <Pipette size={14} className={isPickingFilmBase ? 'animate-pulse' : ''} />
                    <span>{filmBaseInstruction}</span>
                  </button>
                  <div className="mt-2 flex min-w-0 items-center gap-2 px-0.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${filmBaseLowConfidence ? 'bg-amber-500/70' : 'bg-zinc-600'}`} />
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Base</span>
                    <span role="status" className={`min-w-0 flex-1 truncate text-[11px] ${filmBaseLowConfidence ? 'text-amber-300/80' : 'text-zinc-500'}`}>{filmBaseStatus}</span>
                    {onReanalyzeFilmBase && filmBaseSampleSource === null && (
                      <button
                        type="button"
                        onClick={onReanalyzeFilmBase}
                        disabled={isReanalyzingFilmBase}
                        className="inline-flex shrink-0 items-center gap-1 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:text-zinc-300 disabled:cursor-wait disabled:opacity-50"
                        aria-label="Re-analyze film base outside the current crop"
                        data-tip="Look for clear film base outside the current crop. Large changes require confirmation."
                      >
                        {isReanalyzingFilmBase ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                        {isReanalyzingFilmBase ? 'Analyzing…' : 'Re-analyze'}
                      </button>
                    )}
                  </div>
                  {filmBaseLowConfidence && (
                    <p className="mt-1.5 pl-5 text-[10px] leading-relaxed text-amber-300/55">
                      Low confidence — sample a clear area if the conversion looks wrong.
                    </p>
                  )}
                </section>

                <section>
                  <h2 className={SECTION_TITLE}>
                    <Settings2 size={12} /> Scanning Corrections
                    <button
                      data-tip="Correct for light source color cast, lab-specific color shifts, and lens flare from the scanner or enlarger."
                      aria-label="Scanning corrections help"
                      className="ml-1 text-zinc-700 hover:text-zinc-500 transition-colors"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                  </h2>
                  <div className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-1">
                    <label htmlFor="develop-light-source" className={FIELD_LABEL}>Light Source</label>
                    <select
                      id="develop-light-source"
                      value={lightSourceId ?? 'auto'}
                      onChange={(event) => handleLightSourceSelect(event.target.value)}
                      className={SELECT_INPUT}
                    >
                      {lightSourceProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                      ))}
                    </select>
                    <label htmlFor="develop-lab-style" className={FIELD_LABEL}>Lab Style</label>
                    <select
                      id="develop-lab-style"
                      value={activeLabStyleId ?? 'none'}
                      onChange={(event) => onLabStyleChange?.(event.target.value === 'none' ? null : event.target.value)}
                      className={SELECT_INPUT}
                    >
                      <option value="none">None</option>
                      {labStyleProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                      ))}
                    </select>
                  </div>

                    <Slider
                      label="Flare Correction"
                      value={settings.flareCorrection ?? 50}
                      min={0}
                      max={100}
                      onChange={(value) => onSettingsChange({ flareCorrection: value })}
                      onInteractionStart={onInteractionStart}
                      onInteractionEnd={onInteractionEnd}
                    />

                </section>

                <section className={toneEnabled ? undefined : GROUP_DISABLED_CLASS}>
                  <h2 className={SECTION_TITLE}>
                    <GroupSwitch label="Tone" enabled={toneEnabled} onChange={(enabled) => onSettingsChange({ toneEnabled: enabled })} />
                    <SlidersHorizontal size={12} /> Tone
                    {histogramData && (
                      <button
                        type="button"
                        onClick={onAutoAdjust}
                        data-tip="Auto-sets exposure, contrast, black point, and white point from the image histogram"
                        className={HEADER_ACTION}
                      >
                        <Wand2 size={10} />
                        Auto
                      </button>
                    )}
                  </h2>

                  <Slider label="Exposure" fineStep={1} value={settings.exposure} min={-100} max={100} onChange={scalarSliderHandlers.exposure} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="Contrast" fineStep={1} value={settings.contrast} min={-100} max={100} onChange={scalarSliderHandlers.contrast} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
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
                  <Slider
                    label="Shadow Recovery"
                    value={settings.shadowRecovery ?? 0}
                    min={0}
                    max={100}
                    onChange={(value) => onSettingsChange({ shadowRecovery: value })}
                    unit="%"
                    onInteractionStart={onInteractionStart}
                    onInteractionEnd={onInteractionEnd}
                  />
                  <Slider
                    label="Midtone Contrast"
                    value={settings.midtoneContrast ?? 0}
                    min={-100}
                    max={100}
                    onChange={(value) => onSettingsChange({ midtoneContrast: value })}
                    onInteractionStart={onInteractionStart}
                    onInteractionEnd={onInteractionEnd}
                  />
                </section>

                <section className={toneRangeEnabled ? undefined : GROUP_DISABLED_CLASS}>
                  <h2 className={SECTION_TITLE}>
                    <GroupSwitch label="Range" enabled={toneRangeEnabled} onChange={(enabled) => onSettingsChange({ toneRangeEnabled: enabled })} />
                    <BarChart3 size={12} /> Range
                  </h2>
                  <Slider label="Black Point" fineStep={1} value={settings.blackPoint} min={0} max={80} onChange={scalarSliderHandlers.blackPoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="White Point" fineStep={1} value={settings.whitePoint} min={180} max={255} onChange={scalarSliderHandlers.whitePoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                </section>

                {isColor && !settings.blackAndWhite.enabled && (
                  <section className={whiteBalanceEnabled ? undefined : GROUP_DISABLED_CLASS}>
                    <h2 className={SECTION_TITLE}>
                      <GroupSwitch label="White Balance" enabled={whiteBalanceEnabled} onChange={(enabled) => onSettingsChange({ whiteBalanceEnabled: enabled })} />
                      <Thermometer size={12} /> White Balance
                      {onAutoWhiteBalance && histogramData && (
                        <button
                          type="button"
                          onClick={onAutoWhiteBalance}
                          data-tip="Auto-sets temperature and tint from a neutral-balance analysis of the image"
                          className={HEADER_ACTION}
                        >
                          <Wand2 size={10} />
                          Auto WB
                        </button>
                      )}
                    </h2>
                    <Slider label="Temperature" fineStep={1} value={settings.temperature} min={-100} max={100} onChange={scalarSliderHandlers.temperature} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Tint" fineStep={1} value={settings.tint} min={-100} max={100} onChange={scalarSliderHandlers.tint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && (
                  <section className={colorControlsEnabled ? undefined : GROUP_DISABLED_CLASS}>
                    <h2 className={SECTION_TITLE}>
                      <GroupSwitch label="Color" enabled={colorControlsEnabled} onChange={(enabled) => onSettingsChange({ colorControlsEnabled: enabled })} />
                      <Settings2 size={12} /> Color
                    </h2>
                    {!settings.blackAndWhite.enabled && (
                      <Slider label="Saturation" fineStep={1} value={settings.saturation} min={0} max={200} onChange={scalarSliderHandlers.saturation} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    )}
                    <Slider label="Red Balance" fineStep={0.01} value={settings.redBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.redBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Green Balance" fineStep={0.01} value={settings.greenBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.greenBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Blue Balance" fineStep={0.01} value={settings.blueBalance} min={0.5} max={1.5} step={0.01} onChange={scalarSliderHandlers.blueBalance} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && (
                  <section>
                    <h2 className={SECTION_TITLE}>
                      <GroupSwitch label="Black and white" enabled={settings.blackAndWhite.enabled} onChange={handleBlackAndWhiteEnabledChange} />
                      <Circle size={12} /> Black &amp; White
                    </h2>
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
                  <h2 className={SECTION_TITLE}>
                    <GroupSwitch label="Sharpen" enabled={settings.sharpen.enabled} onChange={handleSharpenEnabledChange} />
                    <Focus size={12} /> Sharpen
                  </h2>
                  {settings.sharpen.enabled && (
                    <>
                      <Slider label="Amount" value={settings.sharpen.amount} min={0} max={200} onChange={handleSharpenAmountChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Radius" value={settings.sharpen.radius} min={0.5} max={3} step={0.1} onChange={handleSharpenRadiusChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </>
                  )}
                </section>

                <section>
                  <h2 className={SECTION_TITLE}>
                    <GroupSwitch label="Noise reduction" enabled={settings.noiseReduction.enabled} onChange={handleNoiseReductionEnabledChange} />
                    <Eraser size={12} /> Noise Reduction
                  </h2>
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
                  <h2 className={SECTION_TITLE}>
                    <Activity size={12} /> RGB Curves
                  </h2>
                  <CurvesControl curves={settings.curves} onChange={handleCurvesChange} isColor={isColor} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                </section>

                <section>
                  <h2 className={`${SECTION_TITLE} justify-between`}>
                    <span className="flex items-center gap-2"><Pipette size={12} /> Point Pickers</span>
                    {histogramData && (
                      <button
                        data-tip="Auto-balance: stretch levels to histogram data range, correct color balance"
                        aria-label="Auto balance from histogram"
                        onClick={handleAutoBalance}
                        className={HEADER_ACTION}
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
                        aria-label={`Set ${label} point`}
                        onClick={() => handlePointPickerToggle(mode)}
                        aria-pressed={activePointPicker === mode}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors ${
                          activePointPicker === mode
                            ? ARMED
                            : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200'
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
                  cropSource={cropSource}
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
                  straightenActive={straightenActive}
                  onStraightenActiveChange={onStraightenActiveChange}
                  onRedetectFrame={onRedetectFrame}
                  onDone={onCropDone}
                  onResetCrop={onResetCrop}
                />
              </motion.div>
            ) : activeTab === 'dust' ? (
              <motion.div
                key="dust"
                initial={VERTICAL_PANE_INITIAL}
                animate={VERTICAL_PANE_ANIMATE}
                exit={VERTICAL_PANE_EXIT}
              >
                <DustPane
                  dustRemoval={dustRemoval}
                  onSettingsChange={(nextDustRemoval) => onDustRemovalChange?.(nextDustRemoval)}
                  onDetectNow={() => onDetectDust?.()}
                  isDetecting={isDetectingDust}
                  onInteractionStart={onInteractionStart}
                  onInteractionEnd={onInteractionEnd}
                  brushActive={dustBrushActive}
                  onBrushActiveChange={(active) => onDustBrushActiveChange?.(active)}
                />
              </motion.div>
            ) : (
              <motion.div
                key="export"
                initial={VERTICAL_PANE_INITIAL}
                animate={VERTICAL_PANE_ANIMATE}
                exit={VERTICAL_PANE_EXIT}
                className="space-y-6"
              >
                <ExportFramesControl
                  selectedCount={frameSelectionCount}
                  totalCount={frameCount}
                  isExporting={isExporting}
                  progress={frameExportProgress}
                  onExportCurrent={onExport}
                  onExportFrames={onExportFrames}
                  onCancel={onCancelFrameExport}
                />

                <section>
                  <h2 className={SECTION_TITLE}>
                    <Zap size={12} /> Quick Export
                  </h2>

                  <div className="space-y-1">
                    {quickExportPresets.map((preset) => {
                      const formatLabel = preset.format.replace('image/', '').toUpperCase();
                      return (
                        <div key={preset.id} className="group relative">
                          <button
                            type="button"
                            onClick={() => onQuickExport(preset)}
                            className="flex w-full items-center gap-2.5 rounded-lg border border-zinc-800/60 bg-zinc-900/80 px-2.5 py-2 text-left transition-all hover:border-zinc-600 hover:bg-zinc-800/80 active:scale-[0.98]"
                          >
                            <span className="flex h-6 w-7 shrink-0 items-center justify-center rounded bg-zinc-800 text-[8px] font-black tracking-tight text-zinc-400">
                              {formatLabel}
                            </span>
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-[11px] font-semibold text-zinc-200">{preset.name}</span>
                              <span className="block truncate text-[10px] leading-tight text-zinc-500">
                                {preset.maxDimension ? `${preset.maxDimension}px` : 'Full size'} · {getColorProfileDescription(preset.outputProfileId)}
                              </span>
                            </div>
                            <Download size={12} className="shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-400" />
                          </button>
                          {!preset.isBuiltIn && (
                            <button
                              type="button"
                              onClick={() => onDeleteQuickExportPreset(preset.id)}
                              className="absolute right-8 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-600 opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                              aria-label={`Delete ${preset.name}`}
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={onSaveQuickExportPreset}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-700/60 px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 transition-all hover:border-zinc-500 hover:text-zinc-300"
                    >
                      <Plus size={11} />
                      Save Current Settings
                    </button>
                  </div>
                </section>


                <section className="border-t border-zinc-800/70 pt-6">
                  <h2 className={SECTION_TITLE}>
                    <Settings2 size={12} /> Custom Export
                  </h2>

                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className={`block ${FIELD_LABEL}`}>Format</label>
                      <div className={`${SEGMENT_TRACK} grid-cols-4`}>
                        {(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'] as ExportFormat[]).map((format) => (
                          <button
                            key={format}
                            type="button"
                            aria-pressed={exportOptions.format === format}
                            onClick={() => onExportOptionsChange({ format })}
                            className={`${segmentItem(exportOptions.format === format)} uppercase`}
                          >
                            {format.split('/')[1]}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className={`block ${FIELD_LABEL}`}>Filename</label>
                      <input
                        type="text"
                        value={exportOptions.filenameBase}
                        onChange={handleFilenameChange}
                        className="w-full select-text rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition-colors focus:border-zinc-500"
                        placeholder="darkslide-converted"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </div>

                    {showQualityControl && (
                      <Slider
                        label="Quality"
                        value={Math.round(exportOptions.quality * 100)}
                        min={10}
                        max={100}
                        onChange={handleExportQualityChange}
                        unit="%"
                      />
                    )}

                    {showBitDepthControl && (
                      <div className="space-y-1.5">
                        <label className={`block ${FIELD_LABEL}`}>Bit Depth</label>
                        <div className={`${SEGMENT_TRACK} grid-cols-2`}>
                          {([8, 16] as const).map((bitDepth) => (
                            <button
                              key={bitDepth}
                              type="button"
                              onClick={() => onExportOptionsChange({ bitDepth })}
                              className={segmentItem(exportOptions.bitDepth === bitDepth)}
                            >
                              {bitDepth}-bit
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <label
                        className="flex items-center gap-2 text-[11px] text-zinc-400"
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

                      <label
                        className="flex items-center gap-2 text-[11px] text-zinc-400"
                        data-tip="Save a .darkslide JSON file alongside the export with all conversion settings, so you can re-import and restore them later."
                      >
                        <input
                          type="checkbox"
                          checked={exportOptions.saveSidecar}
                          onChange={(event) => onExportOptionsChange({ saveSidecar: event.target.checked })}
                          className="rounded border-zinc-600 bg-zinc-800"
                        />
                        Save settings sidecar
                      </label>
                    </div>

                    <div className="space-y-2">
                      <label className={`block ${FIELD_LABEL}`}>Output Profile</label>
                      {COLOR_PROFILE_IDS.map((profileId) => (
                        <label key={profileId} className={`flex items-center gap-2 text-[11px] ${isWebpExport && profileId !== 'srgb' ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          <input
                            type="radio"
                            checked={colorManagement.outputProfileId === profileId}
                            onChange={() => handleOutputProfileChange(profileId)}
                            disabled={isWebpExport && profileId !== 'srgb'}
                            className="rounded border-zinc-600 bg-zinc-800"
                          />
                          {getColorProfileDescription(profileId)}
                        </label>
                      ))}
                      <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                        <input
                          type="checkbox"
                          checked={colorManagement.embedOutputProfile}
                          onChange={handleEmbedOutputProfileChange}
                          className="rounded border-zinc-600 bg-zinc-800"
                        />
                        Embed ICC profile
                      </label>
                      {isWebpExport && (
                        <p className="text-[10px] text-zinc-500">
                          WebP export is limited to sRGB.
                        </p>
                      )}
                    </div>
                  </div>
                </section>


                <button
                  type="button"
                  onClick={onOpenBatchExport}
                  data-tip="Apply one shared recipe to files that aren't open, or build a contact sheet"
                  className={PANEL_BUTTON}
                >
                  <FolderOutput size={13} />
                  Convert Files &amp; Contact Sheets…
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

    </div>
  );
});
