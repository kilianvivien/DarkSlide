import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  BarChart3,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FolderOutput,
  Info,
  Loader2,
  Pipette,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings2,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { ColorManagementSettings, ColorProfileId, ConversionSettings, CropTab, Curves, ExportFormat, ExportOptions, FilmBaseEstimate, FilmProfile, HistogramData, LabStyleProfile, LightSourceProfile, PointPickerMode, QuickExportPreset, SourceMetadata } from '../types';
import { CropPane } from './CropPane';
import { CurvesControl } from './CurvesControl';
import { Histogram } from './Histogram';
import { Slider } from './Slider';
import { DustPane } from './DustPane';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { createDefaultSettings, DEFAULT_DUST_REMOVAL, FILM_BASE_CONFIDENCE, resolveDustRemovalSettings } from '../constants';
import { rotateCropClockwise } from '../utils/imagePipeline';
import { SHORTCUT_ALT_MODIFIER, SHORTCUT_MODIFIER } from '../utils/shortcutHelp';

const ADJUST_PANE_INITIAL = { opacity: 0, x: -10 };
const ADJUST_PANE_ANIMATE = { opacity: 1, x: 0 };
const ADJUST_PANE_EXIT = { opacity: 0, x: 10 };
const CURVES_PANE_INITIAL = { opacity: 0, x: 10 };
const CURVES_PANE_ANIMATE = { opacity: 1, x: 0 };
const CURVES_PANE_EXIT = { opacity: 0, x: -10 };
const VERTICAL_PANE_INITIAL = { opacity: 0, y: 10 };
const VERTICAL_PANE_ANIMATE = { opacity: 1, y: 0 };
const VERTICAL_PANE_EXIT = { opacity: 0, y: -10 };
const FALLBACK_RESET_SETTINGS = createDefaultSettings();

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
  filmProfiles?: FilmProfile[];
  onProfileChange?: (profile: FilmProfile) => void;
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
  onCancelExport?: () => void;
  onQuickExport: (preset: QuickExportPreset) => void;
  onSaveQuickExportPreset: () => void;
  onDeleteQuickExportPreset: (presetId: string) => void;
  onOpenBatchExport: () => void;
  onPreviousImage?: () => void;
  onNextImage?: () => void;
  canPreviousImage?: boolean;
  canNextImage?: boolean;
  isExporting: boolean;
  contentScrollTop?: number;
  onContentScrollTopChange?: (scrollTop: number) => void;
  activeTab: 'adjust' | 'curves' | 'crop' | 'dust' | 'export';
  onTabChange: (tab: 'adjust' | 'profiles' | 'curves' | 'crop' | 'dust' | 'export') => void;
  cropTab: CropTab;
  onCropTabChange: (tab: CropTab) => void;
  onRedetectFrame?: () => void;
  onAutoLensDistortion?: () => void;
  isEstimatingLensDistortion?: boolean;
  onCropDone: () => void;
  onResetCrop: () => void;
  activePointPicker: PointPickerMode | null;
  onSetPointPicker: (mode: PointPickerMode | null) => void;
  onOpenSettings: () => void;
  onLightSourceChange?: (lightSourceId: string | null) => void;
  onLabStyleChange?: (labStyleId: string | null) => void;
  onAutoAdjust?: () => void;
  onAutoWhiteBalance?: () => void;
  adjustView?: 'basic' | 'advanced';
  onAdjustViewChange?: (view: 'basic' | 'advanced') => void;
  showAdjustmentViewToggle?: boolean;
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
  straightenActive = false,
  onStraightenActiveChange,
  onSettingsChange,
  onExportOptionsChange,
  onColorManagementChange,
  onInteractionStart,
  onInteractionEnd,
  activeProfile,
  filmProfiles = [],
  onProfileChange,
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
  onCancelExport = () => {},
  onQuickExport,
  onSaveQuickExportPreset,
  onDeleteQuickExportPreset,
  isExporting,
  activeTab,
  onTabChange,
  cropTab,
  onCropTabChange,
  onRedetectFrame,
  onAutoLensDistortion,
  isEstimatingLensDistortion = false,
  onCropDone,
  onResetCrop,
  activePointPicker,
  onSetPointPicker,
  onLightSourceChange,
  onLabStyleChange,
  onAutoAdjust,
  onAutoWhiteBalance,
  adjustView: controlledAdjustView,
  onAdjustViewChange,
  showAdjustmentViewToggle = true,
  onDustRemovalChange,
  onDetectDust,
  isDetectingDust = false,
  dustBrushActive = false,
  onDustBrushActiveChange,
  onOpenBatchExport,
  contentScrollTop = 0,
  onContentScrollTopChange,
}: SidebarProps) {
  const isColor = activeProfile?.type === 'color';
  const resetDefaults = activeProfile?.defaultSettings ?? FALLBACK_RESET_SETTINGS;
  const contentRef = useRef<HTMLDivElement>(null);
  const [histogramOpen, setHistogramOpen] = useState(true);
  const [internalAdjustView, setInternalAdjustView] = useState<'basic' | 'advanced'>('basic');
  const adjustView = controlledAdjustView ?? internalAdjustView;
  const setAdjustView = onAdjustViewChange ?? setInternalAdjustView;
  const [sourceControlsOpen, setSourceControlsOpen] = useState(false);
  const [toneOpen, setToneOpen] = useState(true);
  const [toneRangeOpen, setToneRangeOpen] = useState(true);
  const [whiteBalanceOpen, setWhiteBalanceOpen] = useState(true);
  const [colorControlsOpen, setColorControlsOpen] = useState(false);
  const [detailControlsOpen, setDetailControlsOpen] = useState(true);
  const [sharpenOpen, setSharpenOpen] = useState(true);
  const [noiseReductionOpen, setNoiseReductionOpen] = useState(false);
  const [autoCropEnabled, setAutoCropEnabled] = useState(cropSource === 'auto');
  const [lensFineTuneOpen, setLensFineTuneOpen] = useState(false);
  const autoCroppedSourceIdRef = useRef<string | null>(cropSource === 'auto' ? sourceMetadata?.id ?? null : null);
  void estimatedFlare;
  const filmBaseInstruction = isPickingFilmBase
    ? 'Click an unexposed film-base area…'
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
    if (!autoCropEnabled || !sourceMetadata || !onRedetectFrame) return;
    if (sourceMetadata.width <= 0 || sourceMetadata.height <= 0) return;
    if (autoCroppedSourceIdRef.current === sourceMetadata.id) return;

    autoCroppedSourceIdRef.current = sourceMetadata.id;
    if (cropSource !== 'auto') onRedetectFrame();
  }, [autoCropEnabled, cropSource, onRedetectFrame, sourceMetadata]);

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

  const handleQuickRotate = useCallback((direction: 'clockwise' | 'counterclockwise') => {
    const turns = direction === 'clockwise' ? 1 : 3;
    let crop = settings.crop;
    for (let turn = 0; turn < turns; turn += 1) {
      crop = rotateCropClockwise(crop);
    }
    onSettingsChange({
      rotation: (settings.rotation + (direction === 'clockwise' ? 90 : 270)) % 360,
      crop,
    });
  }, [onSettingsChange, settings.crop, settings.rotation]);

  const handleResetChannelBalance = useCallback(() => {
    onSettingsChange({
      redBalance: resetDefaults.redBalance,
      greenBalance: resetDefaults.greenBalance,
      blueBalance: resetDefaults.blueBalance,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetColorBalance = useCallback(() => {
    onSettingsChange({
      saturation: resetDefaults.saturation,
      redBalance: resetDefaults.redBalance,
      greenBalance: resetDefaults.greenBalance,
      blueBalance: resetDefaults.blueBalance,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetDevelop = useCallback(() => {
    onSettingsChange({
      exposure: resetDefaults.exposure,
      contrast: resetDefaults.contrast,
      saturation: resetDefaults.saturation,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetTone = useCallback(() => {
    onSettingsChange({
      exposure: resetDefaults.exposure,
      contrast: resetDefaults.contrast,
      highlightProtection: resetDefaults.highlightProtection,
      shadowRecovery: resetDefaults.shadowRecovery ?? 0,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetToneRange = useCallback(() => {
    onSettingsChange({
      blackPoint: resetDefaults.blackPoint,
      whitePoint: resetDefaults.whitePoint,
      midtoneContrast: resetDefaults.midtoneContrast ?? 0,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetWhiteBalance = useCallback(() => {
    onSettingsChange({
      temperature: resetDefaults.temperature,
      tint: resetDefaults.tint,
    });
  }, [onSettingsChange, resetDefaults]);

  const handleResetGeometry = useCallback(() => {
    onSettingsChange({
      rotation: 0,
      levelAngle: 0,
      lensDistortion: 0,
      crop: { x: 0, y: 0, width: 1, height: 1, aspectRatio: null },
    });
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

  const isWebpExport = exportOptions.format === 'image/webp';
  const showQualityControl = exportOptions.format !== 'image/png' && exportOptions.format !== 'image/tiff';
  const showBitDepthControl = exportOptions.format === 'image/png' || exportOptions.format === 'image/tiff';
  const exportFormatLabel = exportOptions.format.split('/')[1]?.toUpperCase() ?? exportOptions.format;
  const exportDetailLabel = showQualityControl
    ? `${Math.round(exportOptions.quality * 100)}% quality`
    : `${exportOptions.bitDepth}-bit`;
  const exportSizeLabel = exportOptions.targetMaxDimension
    ? `${exportOptions.targetMaxDimension}px max`
    : 'Original size';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-zinc-950">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/20">
        <button
          type="button"
          onClick={() => setHistogramOpen((current) => !current)}
          className="flex h-10 w-full items-center gap-2 px-6 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600 transition-colors hover:text-zinc-400"
          aria-expanded={histogramOpen}
        >
          <BarChart3 size={12} /> Histogram
          <ChevronDown size={13} className={`ml-auto transition-transform ${histogramOpen ? 'rotate-180' : ''}`} />
        </button>
        {histogramOpen && <div className="px-5 pb-4"><Histogram data={histogramData} blackPoint={settings.blackPoint} whitePoint={settings.whitePoint} /></div>}
      </div>

      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto custom-scrollbar"
        onScroll={(event) => onContentScrollTopChange?.(event.currentTarget.scrollTop)}
      >
        <div className={`space-y-6 ${activeTab === 'adjust' && adjustView === 'basic' ? 'p-5' : 'p-6'}`}>
          <AnimatePresence mode="wait">
            {activeTab === 'adjust' ? (
              <motion.div
                key="adjust"
                initial={ADJUST_PANE_INITIAL}
                animate={ADJUST_PANE_ANIMATE}
                exit={ADJUST_PANE_EXIT}
                className={adjustView === 'basic' ? 'space-y-5' : 'space-y-6'}
              >
                {showAdjustmentViewToggle && <div className="grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-1" aria-label="Adjustment view">
                  {(['basic', 'advanced'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      aria-pressed={adjustView === view}
                      onClick={() => setAdjustView(view)}
                      className={`rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                        adjustView === view
                          ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {view}
                    </button>
                  ))}
                </div>}

                {adjustView === 'basic' ? (
                  <div className="space-y-5 pb-3">
                    {activeProfile && filmProfiles.length > 0 && (
                      <section aria-labelledby="basic-preset-heading">
                        <BasicSectionHeading id="basic-preset-heading" label="Film profile" />
                        <select
                          aria-label="Film profile"
                          value={activeProfile.id}
                          onChange={(event) => {
                            const profile = filmProfiles.find((candidate) => candidate.id === event.target.value);
                            if (profile) onProfileChange?.(profile);
                          }}
                          className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 text-[11px] font-medium text-zinc-300 outline-none transition-colors hover:border-zinc-700 focus:border-amber-400"
                        >
                          {filmProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>{profile.name}</option>
                          ))}
                        </select>
                      </section>
                    )}
                    <section aria-labelledby="basic-develop-heading">
                      <BasicSectionHeading
                        id="basic-develop-heading"
                        label="Develop"
                        secondaryActionLabel="Automatically adjust tone controls"
                        secondaryActionText="Auto"
                        secondaryActionShortcut="A"
                        onSecondaryAction={onAutoAdjust}
                        secondaryActionDisabled={!onAutoAdjust || !histogramData}
                        actionLabel="Reset develop adjustments"
                        actionText="Reset"
                        onAction={handleResetDevelop}
                      />
                      <div className="space-y-3" aria-label="Basic tone controls">
                        {([
                          { label: 'Contrast', shortcut: `${SHORTCUT_ALT_MODIFIER}↑↓`, value: settings.contrast, min: -100, max: 100, neutral: -100, valueLabel: (1 + settings.contrast / 100).toFixed(2), displayMin: 0, displayMax: 2, displayStep: 0.01, onDisplayChange: (value: number) => scalarSliderHandlers.contrast((value - 1) * 100), onChange: scalarSliderHandlers.contrast },
                          { label: 'Density', shortcut: '↑↓', value: settings.exposure, min: -100, max: 100, neutral: -100, valueLabel: (1 + settings.exposure / 100).toFixed(2), displayMin: 0, displayMax: 2, displayStep: 0.01, onDisplayChange: (value: number) => scalarSliderHandlers.exposure((value - 1) * 100), onChange: scalarSliderHandlers.exposure },
                          { label: 'Saturation', shortcut: `${SHORTCUT_MODIFIER}↑↓`, value: settings.saturation, min: 0, max: 200, neutral: 100, valueLabel: ((settings.saturation - 100) / 100).toFixed(2), displayMin: -1, displayMax: 1, displayStep: 0.01, onDisplayChange: (value: number) => scalarSliderHandlers.saturation(100 + value * 100), onChange: scalarSliderHandlers.saturation },
                        ] as const).map((control) => (
                          <BasicReferenceSlider
                            key={control.label}
                            {...control}
                            step={1}
                            accent="#fbbf24"
                            onInteractionStart={onInteractionStart}
                            onInteractionEnd={onInteractionEnd}
                          />
                        ))}
                      </div>
                    </section>

                    {isColor && !settings.blackAndWhite.enabled && (
                      <section aria-labelledby="basic-balance-heading">
                        <BasicSectionHeading
                          id="basic-balance-heading"
                          label="Balance"
                          actionLabel="Auto white balance"
                          actionText="Auto WB"
                          onAction={onAutoWhiteBalance}
                          actionDisabled={!onAutoWhiteBalance || !histogramData}
                        />
                        <div className="space-y-3" aria-label="Basic color balance controls">
                          {([
                            { label: 'Cyan', value: 1 - settings.redBalance, startColor: '#a94f3d', endColor: '#22d3ee', onChange: (value: number) => scalarSliderHandlers.redBalance(1 - value) },
                            { label: 'Magenta', value: 1 - settings.greenBalance, startColor: '#30934a', endColor: '#ec4899', onChange: (value: number) => scalarSliderHandlers.greenBalance(1 - value) },
                            { label: 'Yellow', value: 1 - settings.blueBalance, startColor: '#4f5bd5', endColor: '#fde047', onChange: (value: number) => scalarSliderHandlers.blueBalance(1 - value) },
                          ] as const).map((control) => (
                            <BasicReferenceSlider
                              key={control.label}
                              label={control.label}
                              value={control.value}
                              min={-0.5}
                              max={0.5}
                              neutral={0}
                              step={0.01}
                              valueLabel={control.value.toFixed(2)}
                              displayMin={-0.5}
                              displayMax={0.5}
                              displayStep={0.01}
                              startColor={control.startColor}
                              endColor={control.endColor}
                              swatchColor={control.endColor}
                              onChange={control.onChange}
                              onInteractionStart={onInteractionStart}
                              onInteractionEnd={onInteractionEnd}
                            />
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={handleResetChannelBalance}
                          className="mt-2 text-[9px] uppercase tracking-[0.14em] text-zinc-600 transition-colors hover:text-zinc-300"
                        >
                          Reset balance
                        </button>
                      </section>
                    )}

                    <section aria-labelledby="basic-geometry-heading">
                      <BasicSectionHeading id="basic-geometry-heading" label="Geometry" />
                      <div className="grid grid-cols-4 gap-1.5">
                        <BasicGeometryButton label="Rotate left" shortcut="⇧R" onClick={() => handleQuickRotate('counterclockwise')} icon={<RotateCcw size={15} />} />
                        <BasicGeometryButton label="Rotate right" shortcut="R" onClick={() => handleQuickRotate('clockwise')} icon={<RotateCw size={15} />} />
                        <BasicGeometryButton label="Reset geometry" onClick={handleResetGeometry} icon={<RefreshCw size={15} />} />
                        <BasicGeometryButton label="Crop" shortcut="C" onClick={() => onTabChange('crop')} text="Crop" />
                      </div>
                      <div className="mt-3 rounded-lg border border-zinc-800/70 bg-zinc-900/35 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium text-zinc-300">Lens correction</p>
                            <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">
                              Finds curved straight lines and leaves the image unchanged when evidence is weak.
                            </p>
                          </div>
                          {onAutoLensDistortion && (
                            <button
                              type="button"
                              aria-label="Detect lens distortion automatically"
                              onClick={onAutoLensDistortion}
                              disabled={isEstimatingLensDistortion}
                              className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-400/10 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-300 transition-colors hover:border-amber-400 hover:bg-amber-400/20 disabled:cursor-wait disabled:opacity-60"
                            >
                              {isEstimatingLensDistortion ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
                              {isEstimatingLensDistortion ? 'Analyzing' : 'Auto'}
                            </button>
                          )}
                        </div>

                        {onAutoLensDistortion && (
                          <div className="mt-2 flex items-center justify-between border-t border-zinc-800/70 pt-2">
                            <span className="font-mono text-[9px] tabular-nums text-zinc-500">
                              {(settings.lensDistortion ?? 0) === 0
                                ? 'No correction'
                                : `${(settings.lensDistortion ?? 0) > 0 ? '+' : ''}${(settings.lensDistortion ?? 0).toFixed(0)} applied`}
                            </span>
                            <button
                              type="button"
                              aria-expanded={lensFineTuneOpen}
                              onClick={() => setLensFineTuneOpen((current) => !current)}
                              className="flex items-center gap-1 text-[9px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
                            >
                              Fine tune
                              <ChevronDown size={11} className={`transition-transform ${lensFineTuneOpen ? 'rotate-180' : ''}`} />
                            </button>
                          </div>
                        )}

                        {(!onAutoLensDistortion || lensFineTuneOpen) && (
                          <div className="mt-3">
                            <BasicReferenceSlider
                              label="Lens distortion"
                              value={settings.lensDistortion ?? 0}
                              valueLabel={(settings.lensDistortion ?? 0).toFixed(0)}
                              min={-100}
                              max={100}
                              neutral={0}
                              step={1}
                              onChange={(lensDistortion) => onSettingsChange({ lensDistortion })}
                              onInteractionStart={onInteractionStart}
                              onInteractionEnd={onInteractionEnd}
                            />
                          </div>
                        )}
                      </div>
                      <div className="mt-2 space-y-1.5">
                        <BasicSwitchRow
                          label="Auto crop"
                          shortcut="⇧C"
                          checked={autoCropEnabled}
                          onClick={() => {
                            autoCroppedSourceIdRef.current = null;
                            if (autoCropEnabled) onRedetectFrame?.();
                            setAutoCropEnabled((current) => !current);
                          }}
                          disabled={!onRedetectFrame}
                        />
                        <BasicSwitchRow
                          label="Monochrome"
                          checked={settings.blackAndWhite.enabled}
                          onClick={() => onSettingsChange({
                            blackAndWhite: { ...settings.blackAndWhite, enabled: !settings.blackAndWhite.enabled },
                          })}
                        />
                      </div>
                    </section>
                  </div>
                ) : (
                  <>
                <BasicSectionHeading
                  id="advanced-source-scanning-heading"
                  label="Source and scanning"
                  open={sourceControlsOpen}
                  onToggle={() => setSourceControlsOpen((current) => !current)}
                />
                {sourceControlsOpen && <div className="space-y-8 pb-2">
                <section aria-labelledby="advanced-film-base-heading">
                  <BasicSectionHeading
                    id="advanced-film-base-heading"
                    label="Film base"
                    trailing={(
                    <button
                      type="button"
                      data-tip="Sample an unexposed area of the negative to neutralize the film base using color balance."
                      aria-label="Film base sampling help"
                      className="text-zinc-700 transition-colors hover:text-zinc-500"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                    )}
                  />
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

                <section aria-labelledby="advanced-scanning-heading">
                  <BasicSectionHeading
                    id="advanced-scanning-heading"
                    label="Scanning corrections"
                    trailing={(
                    <button
                      type="button"
                      data-tip="Correct for light source color cast, lab-specific color shifts, and lens flare from the scanner or enlarger."
                      aria-label="Scanning corrections help"
                      className="text-zinc-700 transition-colors hover:text-zinc-500"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                    )}
                  />
                  <div className="mb-4 flex items-center gap-3">
                    <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-400">Light Source</span>
                    <select
                      value={lightSourceId ?? 'auto'}
                      onChange={(event) => handleLightSourceSelect(event.target.value)}
                      className="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 outline-none transition-colors focus:border-zinc-500"
                    >
                      {lightSourceProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="mb-4 flex items-center gap-3">
                    <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-400">Lab Style</span>
                    <select
                      value={activeLabStyleId ?? 'none'}
                      onChange={(event) => onLabStyleChange?.(event.target.value === 'none' ? null : event.target.value)}
                      className="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 outline-none transition-colors focus:border-zinc-500"
                    >
                      <option value="none">None</option>
                      {labStyleProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name}</option>
                      ))}
                    </select>
                  </div>

                    <BasicReferenceSlider
                      label="Flare Correction"
                      value={settings.flareCorrection ?? 50}
                      valueLabel={String(settings.flareCorrection ?? 50)}
                      min={0}
                      max={100}
                      neutral={50}
                      step={1}
                      onChange={(value) => onSettingsChange({ flareCorrection: value })}
                      onInteractionStart={onInteractionStart}
                      onInteractionEnd={onInteractionEnd}
                    />

                </section>
                </div>}

                <section>
                  <BasicSectionHeading
                    id="advanced-tone-heading"
                    label="Tone"
                    open={toneOpen}
                    onToggle={() => setToneOpen((current) => !current)}
                    enabled={settings.toneEnabled !== false}
                    onEnabledChange={(toneEnabled) => onSettingsChange({ toneEnabled })}
                    secondaryActionLabel="Automatically adjust tone controls"
                    secondaryActionText="Auto"
                    secondaryActionShortcut="A"
                    onSecondaryAction={onAutoAdjust}
                    secondaryActionDisabled={!onAutoAdjust || !histogramData}
                    actionLabel="Reset tone adjustments"
                    actionText="Reset"
                    onAction={handleResetTone}
                  />
                  {toneOpen && <div className="space-y-3" aria-labelledby="advanced-tone-heading">
                    <BasicReferenceSlider label="Exposure" shortcut="↑↓" value={settings.exposure} valueLabel={String(settings.exposure)} min={-100} max={100} neutral={0} step={1} onChange={scalarSliderHandlers.exposure} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Contrast" shortcut={`${SHORTCUT_ALT_MODIFIER}↑↓`} value={settings.contrast} valueLabel={String(settings.contrast)} min={-100} max={100} neutral={0} step={1} onChange={scalarSliderHandlers.contrast} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Highlight Protection" value={settings.highlightProtection} valueLabel={String(settings.highlightProtection)} min={0} max={100} neutral={0} step={1} onChange={scalarSliderHandlers.highlightProtection} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Shadow Recovery" value={settings.shadowRecovery ?? 0} valueLabel={String(settings.shadowRecovery ?? 0)} min={0} max={100} neutral={0} step={1} onChange={(value) => onSettingsChange({ shadowRecovery: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </div>}
                </section>

                <BasicSectionHeading
                  id="advanced-tone-range-heading"
                  label="Tone range"
                  open={toneRangeOpen}
                  onToggle={() => setToneRangeOpen((current) => !current)}
                  enabled={settings.toneRangeEnabled !== false}
                  onEnabledChange={(toneRangeEnabled) => onSettingsChange({ toneRangeEnabled })}
                  actionLabel="Reset tone range adjustments"
                  actionText="Reset"
                  onAction={handleResetToneRange}
                />

                {toneRangeOpen && (
                  <section className="space-y-3 pb-2">
                    <BasicReferenceSlider label="Black Point" value={settings.blackPoint} valueLabel={String(settings.blackPoint)} min={0} max={80} neutral={0} step={1} onChange={scalarSliderHandlers.blackPoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="White Point" value={settings.whitePoint} valueLabel={String(settings.whitePoint)} min={180} max={255} neutral={255} step={1} onChange={scalarSliderHandlers.whitePoint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Midtone Contrast" value={settings.midtoneContrast ?? 0} valueLabel={String(settings.midtoneContrast ?? 0)} min={-100} max={100} neutral={0} step={1} onChange={(value) => onSettingsChange({ midtoneContrast: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && !settings.blackAndWhite.enabled && (
                  <BasicSectionHeading
                    id="advanced-white-balance-heading"
                    label="White balance"
                    open={whiteBalanceOpen}
                    onToggle={() => setWhiteBalanceOpen((current) => !current)}
                    enabled={settings.whiteBalanceEnabled !== false}
                    onEnabledChange={(whiteBalanceEnabled) => onSettingsChange({ whiteBalanceEnabled })}
                    actionLabel="Reset white balance"
                    actionText="Reset"
                    onAction={handleResetWhiteBalance}
                  />
                )}

                {isColor && !settings.blackAndWhite.enabled && whiteBalanceOpen && (
                  <section className="space-y-3 pb-2">
                    {onAutoWhiteBalance && histogramData && (
                      <button
                        type="button"
                        onClick={onAutoWhiteBalance}
                        data-tip="Auto-sets temperature and tint from a neutral-balance analysis of the image"
                        className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-300 transition-all hover:bg-zinc-800 hover:text-zinc-100"
                      >
                        <Wand2 size={10} />
                        Auto white balance
                      </button>
                    )}
                    <BasicReferenceSlider label="Temperature" value={settings.temperature} valueLabel={String(settings.temperature)} min={-100} max={100} neutral={0} step={1} startColor="#3b82f6" endColor="#f59e0b" onChange={scalarSliderHandlers.temperature} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Tint" value={settings.tint} valueLabel={String(settings.tint)} min={-100} max={100} neutral={0} step={1} startColor="#22c55e" endColor="#ec4899" onChange={scalarSliderHandlers.tint} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && (
                  <BasicSectionHeading
                    id="advanced-color-controls-heading"
                    label="Color controls"
                    open={colorControlsOpen}
                    onToggle={() => setColorControlsOpen((current) => !current)}
                    enabled={settings.colorControlsEnabled !== false}
                    onEnabledChange={(colorControlsEnabled) => onSettingsChange({ colorControlsEnabled })}
                  />
                )}

                {isColor && colorControlsOpen && (
                  <section className="space-y-3">
                    <BasicSectionHeading id="advanced-color-heading" label="Color balance" actionLabel="Reset color balance" actionText="Reset" onAction={handleResetColorBalance} />
                    {!settings.blackAndWhite.enabled && (
                      <BasicReferenceSlider label="Saturation" shortcut={`${SHORTCUT_MODIFIER}↑↓`} value={settings.saturation} valueLabel={String(settings.saturation)} min={0} max={200} neutral={100} step={1} onChange={scalarSliderHandlers.saturation} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    )}
                    <BasicReferenceSlider label="Cyan" value={1 - settings.redBalance} valueLabel={(1 - settings.redBalance).toFixed(2)} min={-0.5} max={0.5} neutral={0} step={0.01} startColor="#a94f3d" endColor="#22d3ee" swatchColor="#22d3ee" onChange={(value) => scalarSliderHandlers.redBalance(1 - value)} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Magenta" value={1 - settings.greenBalance} valueLabel={(1 - settings.greenBalance).toFixed(2)} min={-0.5} max={0.5} neutral={0} step={0.01} startColor="#30934a" endColor="#ec4899" swatchColor="#ec4899" onChange={(value) => scalarSliderHandlers.greenBalance(1 - value)} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <BasicReferenceSlider label="Yellow" value={1 - settings.blueBalance} valueLabel={(1 - settings.blueBalance).toFixed(2)} min={-0.5} max={0.5} neutral={0} step={0.01} startColor="#4f5bd5" endColor="#fde047" swatchColor="#fde047" onChange={(value) => scalarSliderHandlers.blueBalance(1 - value)} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                {isColor && colorControlsOpen && (
                  <section>
                    <BasicSectionHeading id="advanced-monochrome-heading" label="Monochrome" />
                    <BasicSwitchRow label="Convert to Black and White" checked={settings.blackAndWhite.enabled} onClick={() => onSettingsChange({ blackAndWhite: { ...settings.blackAndWhite, enabled: !settings.blackAndWhite.enabled } })} />
                    {settings.blackAndWhite.enabled && (
                      <div className="mt-3 space-y-3">
                        <BasicReferenceSlider label="Red" value={settings.blackAndWhite.redMix} valueLabel={String(settings.blackAndWhite.redMix)} min={-100} max={100} neutral={0} step={1} onChange={handleBlackAndWhiteRedChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <BasicReferenceSlider label="Green" value={settings.blackAndWhite.greenMix} valueLabel={String(settings.blackAndWhite.greenMix)} min={-100} max={100} neutral={0} step={1} onChange={handleBlackAndWhiteGreenChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <BasicReferenceSlider label="Blue" value={settings.blackAndWhite.blueMix} valueLabel={String(settings.blackAndWhite.blueMix)} min={-100} max={100} neutral={0} step={1} onChange={handleBlackAndWhiteBlueChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                        <BasicReferenceSlider label="Tone" value={settings.blackAndWhite.tone} valueLabel={String(settings.blackAndWhite.tone)} min={-100} max={100} neutral={0} step={1} onChange={handleBlackAndWhiteToneChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      </div>
                    )}
                  </section>
                )}

                <BasicSectionHeading
                  id="advanced-detail-controls-heading"
                  label="Detail controls"
                  open={detailControlsOpen}
                  onToggle={() => setDetailControlsOpen((current) => !current)}
                />

                {detailControlsOpen && <div className="space-y-6 pb-2">
                <section>
                  <BasicSectionHeading
                    id="advanced-sharpen-heading"
                    label="Sharpen"
                    open={sharpenOpen}
                    onToggle={() => setSharpenOpen((current) => !current)}
                    enabled={settings.sharpen.enabled}
                    onEnabledChange={(enabled) => onSettingsChange({ sharpen: { ...settings.sharpen, enabled } })}
                  />
                  {sharpenOpen && (
                    <div className="mt-3 space-y-3">
                      <BasicReferenceSlider label="Amount" value={settings.sharpen.amount} valueLabel={String(settings.sharpen.amount)} min={0} max={200} neutral={0} step={1} onChange={handleSharpenAmountChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <BasicReferenceSlider label="Radius" value={settings.sharpen.radius} valueLabel={settings.sharpen.radius.toFixed(1)} min={0.5} max={3} neutral={1} step={0.1} onChange={handleSharpenRadiusChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </div>
                  )}
                </section>

                <section>
                  <BasicSectionHeading
                    id="advanced-noise-reduction-heading"
                    label="Noise reduction"
                    open={noiseReductionOpen}
                    onToggle={() => setNoiseReductionOpen((current) => !current)}
                    enabled={settings.noiseReduction.enabled}
                    onEnabledChange={(enabled) => onSettingsChange({ noiseReduction: { ...settings.noiseReduction, enabled } })}
                  />
                  {noiseReductionOpen && (
                    <div className="mt-3">
                      <BasicReferenceSlider label="Luminance" value={settings.noiseReduction.luminanceStrength} valueLabel={String(settings.noiseReduction.luminanceStrength)} min={0} max={100} neutral={0} step={1} onChange={handleNoiseReductionStrengthChange} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </div>
                  )}
                </section>
                </div>}
                  </>
                )}
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
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
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
                        aria-label="Auto balance from histogram"
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
                        aria-label={`Set ${label} point`}
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
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
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

                <button
                  type="button"
                  onClick={onOpenBatchExport}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-[11px] font-medium text-zinc-400 transition-all hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <FolderOutput size={13} />
                  Batch Export…
                </button>

                <section className="border-t border-zinc-800/70 pt-6">
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Settings2 size={12} /> Custom Export
                  </h2>

                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Format</label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'] as ExportFormat[]).map((format) => (
                          <button
                            key={format}
                            onClick={() => onExportOptionsChange({ format })}
                            className={`px-1.5 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-tighter transition-all border ${
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

                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Filename</label>
                      <input
                        type="text"
                        value={exportOptions.filenameBase}
                        onChange={handleFilenameChange}
                        className="w-full select-text px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 outline-none focus:border-zinc-600"
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
                        <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Bit Depth</label>
                        <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
                          {([8, 16] as const).map((bitDepth) => (
                            <button
                              key={bitDepth}
                              type="button"
                              onClick={() => onExportOptionsChange({ bitDepth })}
                              className={`rounded-md px-2 py-1.5 text-[10px] font-bold uppercase transition-all ${
                                exportOptions.bitDepth === bitDepth
                                  ? 'bg-zinc-100 text-zinc-950'
                                  : 'text-zinc-500 hover:text-zinc-300'
                              }`}
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
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Output Profile</label>
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

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5" aria-label="Export summary">
                  <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-zinc-400">
                    <span className="font-semibold text-zinc-200">{exportFormatLabel}</span>
                    <span>{exportDetailLabel}</span>
                    <span>{getColorProfileDescription(exportOptions.outputProfileId)}</span>
                    <span>{exportSizeLabel}</span>
                  </div>
                  <p className="mt-1.5 text-[10px] text-zinc-500">
                    {exportOptions.embedMetadata ? 'Metadata included' : 'Metadata removed'}
                    {exportOptions.saveSidecar ? ' · Settings sidecar included' : ''}
                  </p>
                </section>

                <button
                  onClick={isExporting ? onCancelExport : onExport}
                  className={`grid w-full grid-cols-[1rem_auto] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-lg shadow-black/20 transition-colors ${isExporting
                    ? 'border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20'
                    : 'bg-zinc-100 text-zinc-950 hover:bg-white'
                  }`}
                  aria-busy={isExporting}
                >
                  {isExporting ? (
                    <>
                      <X size={15} className="shrink-0" />
                      <span className="whitespace-nowrap">Cancel export</span>
                    </>
                  ) : (
                    <>
                      <Download size={15} className="shrink-0" />
                      <span className="whitespace-nowrap">Export Image</span>
                    </>
                  )}
                </button>

              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

    </div>
  );
});

type BasicReferenceSliderProps = {
  label: string;
  shortcut?: string;
  value: number;
  valueLabel: string;
  displayMin?: number;
  displayMax?: number;
  displayStep?: number;
  min: number;
  max: number;
  neutral: number;
  step: number;
  accent?: string;
  startColor?: string;
  endColor?: string;
  swatchColor?: string;
  onChange: (value: number) => void;
  onDisplayChange?: (value: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
};

function BasicReferenceSlider({
  label,
  shortcut,
  value,
  valueLabel,
  min,
  max,
  neutral,
  step,
  displayMin = min,
  displayMax = max,
  displayStep = step,
  accent = '#fbbf24',
  startColor,
  endColor,
  swatchColor,
  onChange,
  onDisplayChange = onChange,
  onInteractionStart,
  onInteractionEnd,
}: BasicReferenceSliderProps) {
  const [draftValue, setDraftValue] = useState(valueLabel);
  const editingRef = useRef(false);
  const cancelledRef = useRef(false);
  const position = ((value - min) / (max - min)) * 100;
  const neutralPosition = ((neutral - min) / (max - min)) * 100;
  const track = startColor && endColor
    ? `linear-gradient(to right, ${startColor} 0%, #29292d 50%, ${endColor} 100%)`
    : `linear-gradient(to right, #3f3f46 0 ${Math.min(position, neutralPosition)}%, ${accent} ${Math.min(position, neutralPosition)}% ${Math.max(position, neutralPosition)}%, #27272a ${Math.max(position, neutralPosition)}% 100%)`;
  const rangeStyle = {
    '--reference-track': track,
  } as React.CSSProperties;

  useEffect(() => {
    if (!editingRef.current) setDraftValue(valueLabel);
  }, [valueLabel]);

  const finishValueEdit = useCallback(() => {
    editingRef.current = false;

    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraftValue(valueLabel);
      onInteractionEnd?.();
      return;
    }

    const parsed = Number(draftValue);
    if (draftValue.trim() !== '' && Number.isFinite(parsed)) {
      const clamped = Math.min(displayMax, Math.max(displayMin, parsed));
      onDisplayChange(clamped);
    } else {
      setDraftValue(valueLabel);
    }
    onInteractionEnd?.();
  }, [displayMax, displayMin, draftValue, onDisplayChange, onInteractionEnd, valueLabel]);

  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)_52px] items-center gap-2.5" role="group" aria-label={`${label} adjustment`}>
      <span className="flex min-w-0 items-center gap-2 truncate text-[11px] font-medium text-zinc-400">
        {swatchColor && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: swatchColor }} />}
        <span className="truncate">{label}</span>
        {shortcut && <kbd className="ml-auto shrink-0 font-mono text-[8px] text-zinc-700">{shortcut}</kbd>}
      </span>
        <input
          type="range"
          aria-label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerDown={onInteractionStart}
          onPointerUp={onInteractionEnd}
          onPointerCancel={onInteractionEnd}
          onKeyDown={onInteractionStart}
          onKeyUp={onInteractionEnd}
          onBlur={onInteractionEnd}
          className="reference-adjustment-range min-w-0 w-full"
          style={rangeStyle}
        />
      <input
        type="number"
        aria-label={`${label} value`}
        value={draftValue}
        min={displayMin}
        max={displayMax}
        step={displayStep}
        inputMode="decimal"
        onFocus={(event) => {
          editingRef.current = true;
          onInteractionStart?.();
          event.currentTarget.select();
        }}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={finishValueEdit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            cancelledRef.current = true;
            event.currentTarget.blur();
          }
        }}
        className="reference-value-input h-7 w-full rounded-md border border-transparent bg-transparent px-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-200 transition-colors hover:border-zinc-800 hover:bg-zinc-950 focus:border-amber-400 focus:bg-zinc-950 focus:outline-none focus:ring-1 focus:ring-amber-400/25"
      />
    </div>
  );
}

function BasicSectionHeading({
  id,
  label,
  trailing,
  open,
  onToggle,
  enabled,
  onEnabledChange,
  actionText,
  actionLabel,
  onAction,
  actionDisabled = false,
  secondaryActionText,
  secondaryActionLabel,
  secondaryActionShortcut,
  onSecondaryAction,
  secondaryActionDisabled = false,
}: {
  id: string;
  label: string;
  trailing?: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  actionText?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  secondaryActionText?: string;
  secondaryActionLabel?: string;
  secondaryActionShortcut?: string;
  onSecondaryAction?: () => void;
  secondaryActionDisabled?: boolean;
}) {
  const isCollapsible = open !== undefined && onToggle !== undefined;
  const supportsEnabledState = enabled !== undefined && onEnabledChange !== undefined;

  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 id={id} className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {isCollapsible ? (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
            data-tip={`${open ? 'Collapse' : 'Expand'} the ${label.toLowerCase()} section.`}
            className="group -ml-1 flex h-5 items-center gap-1 px-1 transition-colors hover:text-zinc-200"
          >
            <ChevronDown
              size={12}
              className={`text-zinc-700 transition-transform group-hover:text-zinc-300 ${open ? 'rotate-180' : ''}`}
            />
            <span>{label}</span>
          </button>
        ) : label}
      </h2>
      <span className="h-px flex-1 bg-zinc-800" />
      {trailing && <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">{trailing}</span>}
      {supportsEnabledState && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`}
          data-tip={`${enabled ? 'Disable' : 'Enable'} the ${label.toLowerCase()} effect on the image.`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEnabledChange(!enabled);
          }}
          className={`flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors ${
            enabled
              ? 'text-zinc-400 hover:text-zinc-100'
              : 'text-zinc-700 hover:text-zinc-400'
          }`}
        >
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
          {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      )}
      {secondaryActionText && (
        <button
          type="button"
          aria-label={secondaryActionLabel ?? secondaryActionText}
          onClick={onSecondaryAction}
          disabled={secondaryActionDisabled}
          className="shrink-0 rounded-md border border-amber-500/60 bg-amber-400/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-300 transition-colors hover:border-amber-400 hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {secondaryActionText}
          {secondaryActionShortcut && <kbd className="ml-1.5 text-[8px] text-amber-200/60">{secondaryActionShortcut}</kbd>}
        </button>
      )}
      {actionText && (
        <button
          type="button"
          aria-label={actionLabel ?? actionText}
          onClick={onAction}
          disabled={actionDisabled}
          className="shrink-0 rounded-md border border-zinc-800 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {actionText}
        </button>
      )}
    </div>
  );
}

function BasicGeometryButton({
  label,
  icon,
  text,
  shortcut,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  text?: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative flex h-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/50 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {icon ?? text}
      {shortcut && <kbd className="absolute bottom-1 right-1.5 font-mono text-[7px] text-zinc-600">{shortcut}</kbd>}
    </button>
  );
}

function BasicSwitchRow({
  label,
  shortcut,
  checked,
  onClick,
  disabled = false,
}: {
  label: string;
  shortcut?: string;
  checked: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 w-full items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {label}
      <span className="flex items-center gap-2">
        {shortcut && <kbd className="font-mono text-[8px] text-zinc-600">{shortcut}</kbd>}
        <span className={`relative h-6 w-10 rounded-full transition-colors ${checked ? 'bg-amber-400' : 'bg-zinc-800'}`}>
          <span className={`absolute top-1 h-4 w-4 rounded-full transition-all ${checked ? 'left-5 bg-zinc-950' : 'left-1 bg-zinc-500'}`} />
        </span>
      </span>
    </button>
  );
}
