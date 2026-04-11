import { AdvancedInversionProfile, ColorManagementSettings, ColorMatrix, ConversionSettings, CropSettings, CropTab, Curves, DensityBalance, DustRemovalSettings, ExportOptions, FilmProfile, InversionMethod, LabStyleProfile, LightSourceProfile, NotificationSettings, QuickExportPreset, TonalCharacter } from './types';

const DEFAULT_CROP: CropSettings = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspectRatio: null,
};

const DEFAULT_CURVES: Curves = {
  rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
};

export const DEFAULT_DUST_REMOVAL: DustRemovalSettings = {
  autoEnabled: false,
  autoDetectMode: 'both',
  autoSensitivity: 50,
  autoMaxRadius: 8,
  manualBrushRadius: 10,
  marks: [],
};

export function resolveDustRemovalSettings(dustRemoval?: Partial<DustRemovalSettings> | null): DustRemovalSettings {
  return {
    autoEnabled: dustRemoval?.autoEnabled ?? DEFAULT_DUST_REMOVAL.autoEnabled,
    autoDetectMode: dustRemoval?.autoDetectMode ?? DEFAULT_DUST_REMOVAL.autoDetectMode,
    autoSensitivity: dustRemoval?.autoSensitivity ?? DEFAULT_DUST_REMOVAL.autoSensitivity,
    autoMaxRadius: dustRemoval?.autoMaxRadius ?? DEFAULT_DUST_REMOVAL.autoMaxRadius,
    manualBrushRadius: dustRemoval?.manualBrushRadius ?? DEFAULT_DUST_REMOVAL.manualBrushRadius,
    marks: structuredClone(dustRemoval?.marks ?? DEFAULT_DUST_REMOVAL.marks),
  };
}

export const DEFAULT_COLOR_NEGATIVE_INVERSION: InversionMethod = 'standard';

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'image/jpeg',
  quality: 0.92,
  filenameBase: 'darkslide-converted',
  embedMetadata: true,
  outputProfileId: 'srgb',
  embedOutputProfile: true,
  saveSidecar: false,
  targetMaxDimension: null,
};

export const BUILTIN_QUICK_EXPORT_PRESETS: QuickExportPreset[] = [
  {
    id: 'quick-web',
    name: 'Web',
    format: 'image/jpeg',
    quality: 0.85,
    outputProfileId: 'srgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: 2048,
    suffix: '_web',
    cropToSquare: false,
    saveSidecar: false,
    isBuiltIn: true,
  },
  {
    id: 'quick-archive',
    name: 'Archive',
    format: 'image/tiff',
    quality: 1,
    outputProfileId: 'adobe-rgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: null,
    suffix: '',
    cropToSquare: false,
    saveSidecar: true,
    isBuiltIn: true,
  },
  {
    id: 'quick-instagram',
    name: 'Instagram',
    format: 'image/jpeg',
    quality: 0.9,
    outputProfileId: 'srgb',
    embedMetadata: false,
    embedOutputProfile: false,
    maxDimension: 1080,
    suffix: '_ig',
    cropToSquare: true,
    saveSidecar: false,
    isBuiltIn: true,
  },
  {
    id: 'quick-print',
    name: 'Print',
    format: 'image/tiff',
    quality: 1,
    outputProfileId: 'adobe-rgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: null,
    suffix: '_print',
    cropToSquare: false,
    saveSidecar: true,
    isBuiltIn: true,
  },
];

export const DEFAULT_COLOR_MANAGEMENT: ColorManagementSettings = {
  inputMode: 'auto',
  inputProfileId: 'srgb',
  outputProfileId: DEFAULT_EXPORT_OPTIONS.outputProfileId,
  embedOutputProfile: DEFAULT_EXPORT_OPTIONS.embedOutputProfile,
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  exportComplete: true,
  batchComplete: true,
  contactSheetComplete: true,
};

export function createDefaultSettings(overrides: Partial<ConversionSettings> = {}): ConversionSettings {
  const resolvedDustRemoval = resolveDustRemovalSettings(overrides.dustRemoval);
  return {
    inversionMethod: DEFAULT_COLOR_NEGATIVE_INVERSION,
    exposure: 0,
    contrast: 10,
    saturation: 100,
    shadowRecovery: 0,
    midtoneContrast: 0,
    flareCorrection: 50,
    flatFieldEnabled: false,
    temperature: 0,
    tint: 0,
    redBalance: 1,
    greenBalance: 1,
    blueBalance: 1,
    blackPoint: 8,
    whitePoint: 245,
    highlightProtection: 20,
    curves: structuredClone(DEFAULT_CURVES),
    rotation: 0,
    levelAngle: 0,
    crop: structuredClone(DEFAULT_CROP),
    filmBaseSample: null,
    residualBaseCorrection: true,
    blackAndWhite: {
      enabled: false,
      redMix: 0,
      greenMix: 0,
      blueMix: 0,
      tone: 0,
    },
    sharpen: { enabled: false, radius: 1.0, amount: 50 },
    noiseReduction: { enabled: false, luminanceStrength: 0 },
    ...overrides,
    dustRemoval: resolvedDustRemoval,
  };
}

export const SUPPORTED_EXTENSIONS = ['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.webp'] as const;
export const RAW_EXTENSIONS = ['.dng', '.cr3', '.nef', '.arw', '.raf', '.rw2'] as const;
export const MAX_IMAGE_PIXELS = 120_000_000;
export const MAX_IMAGE_DIMENSION = 18_000;
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
export const MAX_OPEN_TABS = 8;
export const PREVIEW_LEVELS = [512, 1024, 2048, 4096];
export const DIAGNOSTICS_LIMIT = 100;
export const DARKSLIDE_PRESET_FILE_VERSION = '1.0.0';

export interface AspectRatioEntry {
  name: string;
  value: number | null;
  category?: CropTab;
  format?: string;
  gauge?: '35mm' | 'Medium Format';
}

export const ASPECT_RATIOS: AspectRatioEntry[] = [
  { name: 'Free', value: null },
  { name: '2:3', value: 2 / 3, category: 'Film', format: '35mm', gauge: '35mm' },
  { name: '3:2', value: 3 / 2, category: 'Film', format: '35mm', gauge: '35mm' },
  { name: '3:4', value: 3 / 4, category: 'Film', format: 'Half-frame', gauge: '35mm' },
  { name: '4:3', value: 4 / 3, category: 'Film', format: 'Half-frame', gauge: '35mm' },
  { name: '4:5', value: 4 / 5, category: 'Film', format: '6×4.5', gauge: 'Medium Format' },
  { name: '5:4', value: 5 / 4, category: 'Film', format: '6×4.5', gauge: 'Medium Format' },
  { name: '1:1', value: 1, category: 'Film', format: '6×6', gauge: 'Medium Format' },
  { name: '6:7', value: 6 / 7, category: 'Film', format: '6×7', gauge: 'Medium Format' },
  { name: '7:6', value: 7 / 6, category: 'Film', format: '6×7', gauge: 'Medium Format' },
  { name: '2:3', value: 2 / 3, category: 'Film', format: '6×9', gauge: 'Medium Format' },
  { name: '3:2', value: 3 / 2, category: 'Film', format: '6×9', gauge: 'Medium Format' },
  { name: '2:3', value: 2 / 3, category: 'Print' },
  { name: '3:2', value: 3 / 2, category: 'Print' },
  { name: '3:4', value: 3 / 4, category: 'Print' },
  { name: '4:3', value: 4 / 3, category: 'Print' },
  { name: '5:7', value: 5 / 7, category: 'Print' },
  { name: '1:1', value: 1, category: 'Social' },
  { name: '4:5', value: 4 / 5, category: 'Social' },
  { name: '9:16', value: 9 / 16, category: 'Social' },
  { name: '16:9', value: 16 / 9, category: 'Digital' },
];

const IDENTITY_COLOR_MATRIX: ColorMatrix = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

const TONAL_CHARACTERS: Record<string, TonalCharacter> = {
  'generic-color': { shadowLift: 0.05, highlightRolloff: 0.5, midtoneAnchor: 0 },
  'portra-400': { shadowLift: 0.15, highlightRolloff: 0.7, midtoneAnchor: 0.01 },
  'portra-160': { shadowLift: 0.12, highlightRolloff: 0.65, midtoneAnchor: 0 },
  'portra-800': { shadowLift: 0.18, highlightRolloff: 0.72, midtoneAnchor: 0.02 },
  'ektar-100': { shadowLift: 0.03, highlightRolloff: 0.3, midtoneAnchor: 0 },
  'gold-200': { shadowLift: 0.08, highlightRolloff: 0.4, midtoneAnchor: 0.02 },
  'gold-100': { shadowLift: 0.09, highlightRolloff: 0.44, midtoneAnchor: 0.02 },
  'ultramax-400': { shadowLift: 0.06, highlightRolloff: 0.38, midtoneAnchor: 0.02 },
  'colorplus-200': { shadowLift: 0.07, highlightRolloff: 0.42, midtoneAnchor: 0.01 },
  'fuji-400h': { shadowLift: 0.1, highlightRolloff: 0.55, midtoneAnchor: -0.01 },
  'fujifilm-200': { shadowLift: 0.08, highlightRolloff: 0.50, midtoneAnchor: -0.01 },
  'superia-400': { shadowLift: 0.06, highlightRolloff: 0.4, midtoneAnchor: 0 },
  'cinestill-800t': { shadowLift: 0.12, highlightRolloff: 0.6, midtoneAnchor: 0 },
  'lomo-400': { shadowLift: 0.04, highlightRolloff: 0.35, midtoneAnchor: 0.01 },
  'lomo-800': { shadowLift: 0.05, highlightRolloff: 0.4, midtoneAnchor: 0.01 },
  'generic-bw': { shadowLift: 0.04, highlightRolloff: 0.5, midtoneAnchor: 0 },
  hp5: { shadowLift: 0.08, highlightRolloff: 0.5, midtoneAnchor: 0 },
  'tri-x': { shadowLift: 0.05, highlightRolloff: 0.35, midtoneAnchor: 0 },
  'delta-3200': { shadowLift: 0.02, highlightRolloff: 0.25, midtoneAnchor: -0.02 },
  'delta-400': { shadowLift: 0.04, highlightRolloff: 0.40, midtoneAnchor: -0.01 },
  'delta-100': { shadowLift: 0.05, highlightRolloff: 0.48, midtoneAnchor: 0 },
  'xp2-super': { shadowLift: 0.10, highlightRolloff: 0.60, midtoneAnchor: 0 },
  'sfx-200': { shadowLift: 0.03, highlightRolloff: 0.35, midtoneAnchor: -0.01 },
  'double-x': { shadowLift: 0.06, highlightRolloff: 0.40, midtoneAnchor: 0 },
  'plus-x': { shadowLift: 0.06, highlightRolloff: 0.50, midtoneAnchor: 0 },
  'fomapan-100': { shadowLift: 0.06, highlightRolloff: 0.45, midtoneAnchor: 0 },
  'fomapan-200': { shadowLift: 0.07, highlightRolloff: 0.48, midtoneAnchor: 0 },
  'fomapan-400': { shadowLift: 0.08, highlightRolloff: 0.50, midtoneAnchor: 0.01 },
  'rpx-25': { shadowLift: 0.04, highlightRolloff: 0.40, midtoneAnchor: 0 },
  'rpx-100': { shadowLift: 0.05, highlightRolloff: 0.44, midtoneAnchor: 0 },
  'rpx-400': { shadowLift: 0.07, highlightRolloff: 0.48, midtoneAnchor: 0.01 },
  'panf-50': { shadowLift: 0.04, highlightRolloff: 0.38, midtoneAnchor: 0 },
  fp4: { shadowLift: 0.07, highlightRolloff: 0.52, midtoneAnchor: 0 },
  'tmax-100': { shadowLift: 0.06, highlightRolloff: 0.55, midtoneAnchor: 0 },
  'tmax-400': { shadowLift: 0.05, highlightRolloff: 0.45, midtoneAnchor: 0 },
};

const COLOR_MATRICES: Record<string, ColorMatrix> = {
  'generic-color': IDENTITY_COLOR_MATRIX,
  'portra-400': [1.15, -0.1, -0.05, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08],
  'portra-160': [1.12, -0.08, -0.04, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07],
  'portra-800': [1.16, -0.11, -0.05, -0.04, 1.09, -0.05, -0.02, -0.07, 1.09],
  'ektar-100': [1.2, -0.12, -0.08, -0.05, 1.1, -0.05, -0.03, -0.08, 1.11],
  'gold-200': [1.18, -0.11, -0.07, -0.05, 1.09, -0.04, -0.03, -0.07, 1.1],
  'gold-100': [1.16, -0.10, -0.06, -0.04, 1.08, -0.04, -0.03, -0.06, 1.09],
  'ultramax-400': [1.20, -0.12, -0.08, -0.06, 1.10, -0.04, -0.03, -0.08, 1.11],
  'colorplus-200': [1.14, -0.09, -0.05, -0.04, 1.07, -0.03, -0.02, -0.06, 1.08],
  'fuji-400h': [1.1, -0.06, -0.04, -0.02, 1.05, -0.03, -0.01, -0.04, 1.05],
  'fujifilm-200': [1.10, -0.06, -0.04, -0.02, 1.05, -0.03, -0.01, -0.04, 1.06],
  'superia-400': [1.12, -0.07, -0.05, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07],
  'cinestill-800t': [1.08, -0.05, -0.03, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04],
  'lomo-400': [1.22, -0.13, -0.09, -0.06, 1.11, -0.05, -0.04, -0.09, 1.13],
  'lomo-800': [1.20, -0.12, -0.08, -0.05, 1.10, -0.05, -0.03, -0.08, 1.11],
};

const ADVANCED_INVERSION_PROFILES: Record<string, AdvancedInversionProfile> = {
  'generic-color': { gamma: [0.62, 0.65, 0.58], baseDensityFallback: [0.72, 0.58, 0.33] },
  'portra-400': { gamma: [0.60, 0.65, 0.55], baseDensityFallback: [0.78, 0.62, 0.35] },
  'portra-160': { gamma: [0.58, 0.63, 0.53], baseDensityFallback: [0.75, 0.60, 0.33] },
  'ektar-100': { gamma: [0.70, 0.75, 0.65], baseDensityFallback: [0.85, 0.68, 0.38] },
  'gold-200': { gamma: [0.62, 0.67, 0.58], baseDensityFallback: [0.72, 0.58, 0.32] },
  'fuji-400h': { gamma: [0.61, 0.65, 0.58], baseDensityFallback: [0.68, 0.55, 0.30] },
  'superia-400': { gamma: [0.64, 0.68, 0.60], baseDensityFallback: [0.70, 0.55, 0.30] },
  'cinestill-800t': { gamma: [0.63, 0.68, 0.58], baseDensityFallback: [0.77, 0.61, 0.35] },
  'ultramax-400': { gamma: [0.63, 0.68, 0.58], baseDensityFallback: [0.74, 0.60, 0.34] },
  'colorplus-200': { gamma: [0.60, 0.65, 0.56], baseDensityFallback: [0.70, 0.56, 0.30] },
  'gold-100': { gamma: [0.61, 0.66, 0.57], baseDensityFallback: [0.71, 0.57, 0.31] },
  'portra-800': { gamma: [0.62, 0.67, 0.57], baseDensityFallback: [0.79, 0.63, 0.36] },
  'pro-image-100': { gamma: [0.59, 0.64, 0.54], baseDensityFallback: [0.73, 0.58, 0.32] },
  'vision3-250d': { gamma: [0.60, 0.64, 0.56], baseDensityFallback: [0.74, 0.59, 0.33] },
  'vision3-500t': { gamma: [0.63, 0.68, 0.59], baseDensityFallback: [0.79, 0.63, 0.37] },
  'fuji-c200': { gamma: [0.61, 0.65, 0.57], baseDensityFallback: [0.67, 0.53, 0.29] },
  'superia-xtra-400': { gamma: [0.64, 0.68, 0.60], baseDensityFallback: [0.71, 0.56, 0.31] },
  'pro-160ns': { gamma: [0.58, 0.63, 0.55], baseDensityFallback: [0.69, 0.56, 0.30] },
  'cinestill-50d': { gamma: [0.58, 0.63, 0.55], baseDensityFallback: [0.72, 0.58, 0.32] },
  'cinestill-400d': { gamma: [0.61, 0.66, 0.57], baseDensityFallback: [0.75, 0.60, 0.34] },
  'lomo-400': { gamma: [0.65, 0.70, 0.62], baseDensityFallback: [0.76, 0.61, 0.35] },
  'lomo-800': { gamma: [0.66, 0.71, 0.63], baseDensityFallback: [0.78, 0.62, 0.36] },
  'fujifilm-200': { gamma: [0.63, 0.66, 0.58], baseDensityFallback: [0.68, 0.54, 0.29] },
};

export const FILM_STOCK_DENSITY_PRESETS: Record<string, Omit<DensityBalance, 'source'>> = {
  'generic-color': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'portra-160': { scaleR: 1, scaleG: 1, scaleB: 0.63 },
  'portra-400': { scaleR: 1, scaleG: 1, scaleB: 0.62 },
  'portra-800': { scaleR: 1, scaleG: 1, scaleB: 0.61 },
  'ektar-100': { scaleR: 1, scaleG: 1, scaleB: 0.58 },
  'gold-200': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'gold-100': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'ultramax-400': { scaleR: 1, scaleG: 1, scaleB: 0.59 },
  'colorplus-200': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'fuji-400h': { scaleR: 1, scaleG: 1, scaleB: 0.53 },
  'superia-400': { scaleR: 1, scaleG: 1, scaleB: 0.55 },
  'cinestill-800t': { scaleR: 1, scaleG: 1, scaleB: 0.68 },
  'cinestill-50d': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'cinestill-400d': { scaleR: 1, scaleG: 1, scaleB: 0.62 },
  'lomo-400': { scaleR: 1, scaleG: 1, scaleB: 0.58 },
  'lomo-800': { scaleR: 1, scaleG: 1, scaleB: 0.59 },
  'pro-image-100': { scaleR: 1, scaleG: 1, scaleB: 0.61 },
  'vision3-250d': { scaleR: 1, scaleG: 1, scaleB: 0.6 },
  'vision3-500t': { scaleR: 1, scaleG: 1, scaleB: 0.66 },
  'fuji-c200': { scaleR: 1, scaleG: 1, scaleB: 0.57 },
  'superia-xtra-400': { scaleR: 1, scaleG: 1, scaleB: 0.55 },
  'pro-160ns': { scaleR: 1, scaleG: 1, scaleB: 0.54 },
  'fujifilm-200': { scaleR: 1, scaleG: 1, scaleB: 0.57 },
};

export const LIGHT_SOURCE_PROFILES: LightSourceProfile[] = [
  { id: 'auto', name: 'Auto (no correction)', colorTemperature: 0, spectralBias: [1, 1, 1], flareCharacteristic: 'medium' },
  { id: 'daylight', name: 'Generic daylight LED panel', colorTemperature: 5500, spectralBias: [1.0, 0.98, 0.95], flareCharacteristic: 'low' },
  // CineStill publishes the original CS-LITE as a three-mode 3200-9000K source.
  // Biases are normalized from those mode temperatures so Cool stays blue-heavy,
  // White lands near daylight, and Warm behaves like a tungsten-balanced source.
  // We keep the legacy `cs-lite` id on the neutral White mode for saved defaults/docs.
  { id: 'cs-lite-cool', name: 'CineStill CS-LITE Cool (Color Negative)', colorTemperature: 9000, spectralBias: [0.82, 0.87, 1.0], flareCharacteristic: 'low' },
  { id: 'cs-lite', name: 'CineStill CS-LITE White (B&W)', colorTemperature: 5600, spectralBias: [1.0, 0.94, 0.88], flareCharacteristic: 'low' },
  { id: 'cs-lite-warm', name: 'CineStill CS-LITE Warm (Slide)', colorTemperature: 3200, spectralBias: [1.0, 0.72, 0.48], flareCharacteristic: 'low' },
  { id: 'skier', name: 'Skier Sunray Copy Box 3', colorTemperature: 5600, spectralBias: [1.0, 0.97, 0.93], flareCharacteristic: 'low' },
  { id: 'valoi', name: 'VALOI easy35 / Pluto LED', colorTemperature: 5000, spectralBias: [1.0, 0.94, 0.87], flareCharacteristic: 'medium' },
  { id: 'kaiser', name: 'Kaiser Slimlite Plano', colorTemperature: 5300, spectralBias: [1.0, 0.96, 0.91], flareCharacteristic: 'low' },
  { id: 'lomo', name: 'Lomography DigitaLIZA+ LED', colorTemperature: 6000, spectralBias: [0.92, 0.96, 1.0], flareCharacteristic: 'medium' },
  { id: 'tablet', name: 'iPad / tablet backlight', colorTemperature: 6500, spectralBias: [0.88, 0.94, 1.0], flareCharacteristic: 'high' },
];

type BuiltinProfileOptions = Omit<FilmProfile, 'version'>;

const CS_LITE_LIGHT_SOURCE_IDS = ['cs-lite-cool', 'cs-lite', 'cs-lite-warm'] as const;

type CsLiteLightSourceId = typeof CS_LITE_LIGHT_SOURCE_IDS[number];

export function isCsLiteLightSourceId(lightSourceId: string | null | undefined): lightSourceId is CsLiteLightSourceId {
  return typeof lightSourceId === 'string'
    && (CS_LITE_LIGHT_SOURCE_IDS as readonly string[]).includes(lightSourceId);
}

export function getSuggestedCsLiteLightSourceId(
  profile: Pick<FilmProfile, 'type' | 'filmType'>,
  options?: { blackAndWhiteEnabled?: boolean },
): CsLiteLightSourceId {
  if (profile.type === 'bw' || options?.blackAndWhiteEnabled) {
    return 'cs-lite';
  }

  if (profile.filmType === 'slide') {
    return 'cs-lite-warm';
  }

  return 'cs-lite-cool';
}

export function resolveLightSourceIdForProfile(
  profile: Pick<FilmProfile, 'type' | 'filmType'>,
  lightSourceId: string | null | undefined,
  options?: { blackAndWhiteEnabled?: boolean },
): string | null {
  if (!lightSourceId || lightSourceId === 'auto') {
    return null;
  }

  if (isCsLiteLightSourceId(lightSourceId)) {
    return getSuggestedCsLiteLightSourceId(profile, options);
  }

  return lightSourceId;
}

function createBuiltinProfile(profile: BuiltinProfileOptions): FilmProfile {
  return {
    version: 1,
    advancedInversion: profile.advancedInversion
      ?? (profile.type === 'color' && (profile.filmType ?? 'negative') === 'negative'
        ? ADVANCED_INVERSION_PROFILES[profile.id]
        : undefined),
    ...profile,
  };
}

export const FILM_PROFILES: FilmProfile[] = [
  createBuiltinProfile({
    id: 'generic-bw',
    name: 'Generic B&W',
    type: 'bw',
    filmType: 'negative',
    category: 'Generic',
    description: 'Neutral black and white inversion with restrained contrast.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 14, highlightProtection: 25 }),
    tonalCharacter: TONAL_CHARACTERS['generic-bw'],
  }),
  createBuiltinProfile({
    id: 'generic-color',
    name: 'Generic Color',
    type: 'color',
    filmType: 'negative',
    category: 'Generic',
    description: 'Balanced color-negative starting point for most consumer scans.',
    defaultSettings: createDefaultSettings({ contrast: 15, redBalance: 1.12, blueBalance: 0.9, highlightProtection: 26 }),
    colorMatrix: COLOR_MATRICES['generic-color'],
    tonalCharacter: TONAL_CHARACTERS['generic-color'],
  }),
  createBuiltinProfile({
    id: 'hp5',
    name: 'Ilford HP5 Plus',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Classic high-speed B&W profile with punchier midtones.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 24, highlightProtection: 30, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS.hp5,
  }),
  createBuiltinProfile({
    id: 'tri-x',
    name: 'Kodak Tri-X 400',
    type: 'bw',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Distinctive grain and crisp contrast for documentary scans.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 34, highlightProtection: 22, blackPoint: 14 }),
    tonalCharacter: TONAL_CHARACTERS['tri-x'],
  }),
  createBuiltinProfile({
    id: 'delta-3200',
    name: 'Ilford Delta 3200',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Ultra high-speed B&W with dramatic contrast and punchy tones.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 40, highlightProtection: 18, blackPoint: 18, whitePoint: 240 }),
    tonalCharacter: TONAL_CHARACTERS['delta-3200'],
  }),
  createBuiltinProfile({
    id: 'portra-400',
    name: 'Kodak Portra 400',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Warm skin tones with gentle contrast and protected highlights.',
    defaultSettings: createDefaultSettings({ exposure: 4, contrast: 11, saturation: 108, temperature: 4, tint: -2, redBalance: 1.14, blueBalance: 0.88, highlightProtection: 34 }),
    maskTuning: { highlightProtectionBias: 0.08, blackPointBias: -0.02 },
    colorMatrix: COLOR_MATRICES['portra-400'],
    tonalCharacter: TONAL_CHARACTERS['portra-400'],
  }),
  createBuiltinProfile({
    id: 'portra-160',
    name: 'Kodak Portra 160',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Fine-grained portrait stock with neutral, slightly cool rendering.',
    defaultSettings: createDefaultSettings({ exposure: 2, contrast: 8, saturation: 104, temperature: 2, tint: -1, redBalance: 1.10, blueBalance: 0.92, highlightProtection: 30, blackPoint: 6 }),
    maskTuning: { highlightProtectionBias: 0.06, blackPointBias: -0.01 },
    colorMatrix: COLOR_MATRICES['portra-160'],
    tonalCharacter: TONAL_CHARACTERS['portra-160'],
  }),
  createBuiltinProfile({
    id: 'ektar-100',
    name: 'Kodak Ektar 100',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Higher saturation and slightly firmer contrast for vivid negatives.',
    defaultSettings: createDefaultSettings({ contrast: 20, saturation: 130, redBalance: 1.08, blueBalance: 0.92, highlightProtection: 18 }),
    colorMatrix: COLOR_MATRICES['ektar-100'],
    tonalCharacter: TONAL_CHARACTERS['ektar-100'],
  }),
  createBuiltinProfile({
    id: 'gold-200',
    name: 'Kodak Gold 200',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Warm, saturated consumer stock with golden highlights.',
    defaultSettings: createDefaultSettings({ exposure: 6, contrast: 18, saturation: 125, temperature: 8, tint: -2, redBalance: 1.16, blueBalance: 0.86, highlightProtection: 20, blackPoint: 10 }),
    colorMatrix: COLOR_MATRICES['gold-200'],
    tonalCharacter: TONAL_CHARACTERS['gold-200'],
  }),
  createBuiltinProfile({
    id: 'fuji-400h',
    name: 'Fujifilm Pro 400H',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Cooler palette with softer contrast and green-friendly balance.',
    defaultSettings: createDefaultSettings({ exposure: 8, contrast: 6, saturation: 96, temperature: -5, tint: 4, greenBalance: 1.08, blueBalance: 1.14, highlightProtection: 30 }),
    colorMatrix: COLOR_MATRICES['fuji-400h'],
    tonalCharacter: TONAL_CHARACTERS['fuji-400h'],
  }),
  createBuiltinProfile({
    id: 'superia-400',
    name: 'Fujifilm Superia 400',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Punchy colors with vibrant greens and cool-leaning palette.',
    defaultSettings: createDefaultSettings({ exposure: 4, contrast: 16, saturation: 118, temperature: -3, tint: 3, redBalance: 1.06, greenBalance: 1.06, blueBalance: 0.96, highlightProtection: 22 }),
    colorMatrix: COLOR_MATRICES['superia-400'],
    tonalCharacter: TONAL_CHARACTERS['superia-400'],
  }),
  createBuiltinProfile({
    id: 'cinestill-800t',
    name: 'CineStill 800T',
    type: 'color',
    filmType: 'negative',
    category: 'CineStill',
    description: 'Tungsten-balanced cinema stock with cool shadows and warm highlights.',
    defaultSettings: createDefaultSettings({ exposure: 8, contrast: 12, saturation: 112, temperature: -8, tint: 2, redBalance: 1.18, blueBalance: 1.08, highlightProtection: 35, blackPoint: 6, whitePoint: 240 }),
    maskTuning: { highlightProtectionBias: 0.10, blackPointBias: -0.03 },
    colorMatrix: COLOR_MATRICES['cinestill-800t'],
    tonalCharacter: TONAL_CHARACTERS['cinestill-800t'],
  }),
  createBuiltinProfile({
    id: 'ultramax-400',
    name: 'Kodak UltraMax 400',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Saturated consumer stock with warm daylight rendering.',
    defaultSettings: createDefaultSettings({ exposure: 5, contrast: 17, saturation: 126, temperature: 6, tint: -1, redBalance: 1.14, blueBalance: 0.88, highlightProtection: 22 }),
    colorMatrix: COLOR_MATRICES['ultramax-400'],
    tonalCharacter: TONAL_CHARACTERS['ultramax-400'],
  }),
  createBuiltinProfile({
    id: 'colorplus-200',
    name: 'Kodak ColorPlus 200',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Warm budget color negative with easy contrast.',
    defaultSettings: createDefaultSettings({ exposure: 5, contrast: 16, saturation: 118, temperature: 7, tint: -1, redBalance: 1.12, blueBalance: 0.9, highlightProtection: 22 }),
    colorMatrix: COLOR_MATRICES['colorplus-200'],
    tonalCharacter: TONAL_CHARACTERS['colorplus-200'],
  }),
  createBuiltinProfile({
    id: 'gold-100',
    name: 'Kodak Gold 100',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Warm low-speed consumer stock with fine grain.',
    defaultSettings: createDefaultSettings({ exposure: 3, contrast: 15, saturation: 120, temperature: 7, tint: -1, redBalance: 1.14, blueBalance: 0.89, highlightProtection: 24, blackPoint: 8 }),
    colorMatrix: COLOR_MATRICES['gold-100'],
    tonalCharacter: TONAL_CHARACTERS['gold-100'],
  }),
  createBuiltinProfile({
    id: 'portra-800',
    name: 'Kodak Portra 800',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Fast portrait stock with soft highlights and lifted shadows.',
    defaultSettings: createDefaultSettings({ exposure: 7, contrast: 9, saturation: 106, temperature: 3, tint: -1, redBalance: 1.13, blueBalance: 0.9, highlightProtection: 36, blackPoint: 7 }),
    maskTuning: { highlightProtectionBias: 0.08, blackPointBias: -0.02 },
    colorMatrix: COLOR_MATRICES['portra-800'],
    tonalCharacter: TONAL_CHARACTERS['portra-800'],
  }),
  createBuiltinProfile({
    id: 'pro-image-100',
    name: 'Kodak Pro Image 100',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Neutral warm pro stock aimed at natural skin tones.',
    defaultSettings: createDefaultSettings({ exposure: 3, contrast: 10, saturation: 104, temperature: 3, tint: -1, redBalance: 1.1, blueBalance: 0.92, highlightProtection: 30, blackPoint: 7 }),
    colorMatrix: COLOR_MATRICES['portra-160'],
    tonalCharacter: TONAL_CHARACTERS['portra-160'],
  }),
  createBuiltinProfile({
    id: 'vision3-250d',
    name: 'Kodak Vision3 250D',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Cinema daylight stock with soft shoulder and broad exposure latitude.',
    defaultSettings: createDefaultSettings({ exposure: 6, contrast: 8, saturation: 98, temperature: 2, tint: -1, redBalance: 1.08, blueBalance: 0.95, highlightProtection: 40, blackPoint: 6 }),
    maskTuning: { highlightProtectionBias: 0.1, blackPointBias: -0.03 },
    colorMatrix: COLOR_MATRICES['portra-160'],
    tonalCharacter: { shadowLift: 0.16, highlightRolloff: 0.78, midtoneAnchor: -0.01 },
  }),
  createBuiltinProfile({
    id: 'vision3-500t',
    name: 'Kodak Vision3 500T',
    type: 'color',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Cinema tungsten stock with cool shadows and a very forgiving shoulder.',
    defaultSettings: createDefaultSettings({ exposure: 8, contrast: 8, saturation: 100, temperature: -6, tint: 1, redBalance: 1.14, blueBalance: 1.02, highlightProtection: 42, blackPoint: 6 }),
    maskTuning: { highlightProtectionBias: 0.12, blackPointBias: -0.03 },
    colorMatrix: COLOR_MATRICES['cinestill-800t'],
    tonalCharacter: { shadowLift: 0.18, highlightRolloff: 0.82, midtoneAnchor: -0.01 },
  }),
  createBuiltinProfile({
    id: 'fuji-c200',
    name: 'Fujifilm C200',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Budget Fujifilm stock with lively greens and cooler balance.',
    defaultSettings: createDefaultSettings({ exposure: 4, contrast: 14, saturation: 112, temperature: -2, tint: 2, greenBalance: 1.04, blueBalance: 1.02, highlightProtection: 22 }),
    colorMatrix: COLOR_MATRICES['fuji-400h'],
    tonalCharacter: TONAL_CHARACTERS['fuji-400h'],
  }),
  createBuiltinProfile({
    id: 'superia-xtra-400',
    name: 'Fuji Superia X-TRA 400',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Punchy consumer stock with vivid greens and crisp contrast.',
    defaultSettings: createDefaultSettings({ exposure: 4, contrast: 17, saturation: 122, temperature: -3, tint: 3, greenBalance: 1.08, blueBalance: 1.02, highlightProtection: 22 }),
    colorMatrix: COLOR_MATRICES['superia-400'],
    tonalCharacter: TONAL_CHARACTERS['superia-400'],
  }),
  createBuiltinProfile({
    id: 'pro-160ns',
    name: 'Fuji Pro 160NS',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Natural-skin portrait stock with soft contrast and cool neutrality.',
    defaultSettings: createDefaultSettings({ exposure: 3, contrast: 7, saturation: 98, temperature: -3, tint: 2, greenBalance: 1.05, blueBalance: 1.06, highlightProtection: 34, blackPoint: 6 }),
    colorMatrix: COLOR_MATRICES['fuji-400h'],
    tonalCharacter: { shadowLift: 0.12, highlightRolloff: 0.68, midtoneAnchor: -0.01 },
  }),
  createBuiltinProfile({
    id: 'cinestill-50d',
    name: 'CineStill 50D',
    type: 'color',
    filmType: 'negative',
    category: 'CineStill',
    description: 'Daylight-balanced cinema-derived stock with clean color and restrained contrast.',
    defaultSettings: createDefaultSettings({ exposure: 3, contrast: 9, saturation: 102, temperature: 1, tint: -1, redBalance: 1.08, blueBalance: 0.96, highlightProtection: 36, blackPoint: 6 }),
    maskTuning: { highlightProtectionBias: 0.1, blackPointBias: -0.02 },
    colorMatrix: COLOR_MATRICES['portra-160'],
    tonalCharacter: { shadowLift: 0.14, highlightRolloff: 0.76, midtoneAnchor: -0.01 },
  }),
  createBuiltinProfile({
    id: 'cinestill-400d',
    name: 'CineStill 400D',
    type: 'color',
    filmType: 'negative',
    category: 'CineStill',
    description: 'Punchier daylight cinema stock with flexible highlights.',
    defaultSettings: createDefaultSettings({ exposure: 5, contrast: 11, saturation: 108, temperature: 1, tint: -1, redBalance: 1.1, blueBalance: 0.96, highlightProtection: 38, blackPoint: 7 }),
    maskTuning: { highlightProtectionBias: 0.1, blackPointBias: -0.02 },
    colorMatrix: COLOR_MATRICES['portra-400'],
    tonalCharacter: { shadowLift: 0.15, highlightRolloff: 0.78, midtoneAnchor: -0.01 },
  }),
  createBuiltinProfile({
    id: 'lomo-400',
    name: 'Lomography CN 400',
    type: 'color',
    filmType: 'negative',
    category: 'Lomography',
    description: 'Saturated, contrasty Lomography color negative with punchy reds.',
    defaultSettings: createDefaultSettings({ exposure: 4, contrast: 20, saturation: 130, temperature: 4, tint: 1, redBalance: 1.12, blueBalance: 0.92, highlightProtection: 18, blackPoint: 10 }),
    colorMatrix: COLOR_MATRICES['lomo-400'],
    tonalCharacter: TONAL_CHARACTERS['lomo-400'],
  }),
  createBuiltinProfile({
    id: 'lomo-800',
    name: 'Lomography CN 800',
    type: 'color',
    filmType: 'negative',
    category: 'Lomography',
    description: 'High-speed Lomography stock with bold contrast and strong color.',
    defaultSettings: createDefaultSettings({ exposure: 6, contrast: 18, saturation: 128, temperature: 4, tint: 1, redBalance: 1.12, blueBalance: 0.94, highlightProtection: 24, blackPoint: 10 }),
    colorMatrix: COLOR_MATRICES['lomo-800'],
    tonalCharacter: TONAL_CHARACTERS['lomo-800'],
  }),
  createBuiltinProfile({
    id: 'velvia-50',
    name: 'Fuji Velvia 50',
    type: 'color',
    filmType: 'slide',
    category: 'Fuji',
    description: 'Ultra-saturated slide profile with deep contrast and punchy color.',
    defaultSettings: createDefaultSettings({ exposure: 0, contrast: 22, saturation: 145, temperature: -1, tint: 1, highlightProtection: 10, blackPoint: 8, whitePoint: 248, filmBaseSample: { r: 255, g: 255, b: 255 } }),
    colorMatrix: [1.18, -0.1, -0.08, -0.04, 1.09, -0.03, -0.02, -0.04, 1.14],
    tonalCharacter: { shadowLift: 0.02, highlightRolloff: 0.22, midtoneAnchor: 0.01 },
  }),
  createBuiltinProfile({
    id: 'provia-100f',
    name: 'Fuji Provia 100F',
    type: 'color',
    filmType: 'slide',
    category: 'Fuji',
    description: 'Neutral slide profile with clean color and a restrained shoulder.',
    defaultSettings: createDefaultSettings({ exposure: 0, contrast: 14, saturation: 112, temperature: 0, tint: 0, highlightProtection: 12, blackPoint: 6, whitePoint: 248, filmBaseSample: { r: 255, g: 255, b: 255 } }),
    colorMatrix: [1.08, -0.05, -0.03, -0.02, 1.04, -0.02, -0.01, -0.03, 1.05],
    tonalCharacter: { shadowLift: 0.03, highlightRolloff: 0.28, midtoneAnchor: 0 },
  }),
  createBuiltinProfile({
    id: 'tmax-100',
    name: 'Kodak T-Max 100',
    type: 'bw',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Fine-grain tabular black and white with smooth tonality.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 18, highlightProtection: 28, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['tmax-100'],
  }),
  createBuiltinProfile({
    id: 'tmax-400',
    name: 'Kodak T-Max 400',
    type: 'bw',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Versatile tabular black and white with crisp mids.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 24, highlightProtection: 24, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS['tmax-400'],
  }),
  createBuiltinProfile({
    id: 'fp4',
    name: 'Ilford FP4 Plus',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Classic medium-speed black and white with open shadows.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 18, highlightProtection: 28, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS.fp4,
  }),
  createBuiltinProfile({
    id: 'panf-50',
    name: 'Ilford Pan F Plus 50',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Ultra-fine grain black and white with strong crispness.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 26, highlightProtection: 22, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS['panf-50'],
  }),
  // --- Kodak slides ---
  createBuiltinProfile({
    id: 'ektachrome-e100',
    name: 'Kodak Ektachrome E100',
    type: 'color',
    filmType: 'slide',
    category: 'Kodak',
    description: 'Modern Kodak slide film with neutral-warm palette and tight shoulder.',
    defaultSettings: createDefaultSettings({ exposure: 0, contrast: 16, saturation: 118, highlightProtection: 10, blackPoint: 6, whitePoint: 248, filmBaseSample: { r: 255, g: 255, b: 255 } }),
    colorMatrix: [1.10, -0.06, -0.04, -0.03, 1.06, -0.03, -0.01, -0.04, 1.08],
    tonalCharacter: { shadowLift: 0.02, highlightRolloff: 0.25, midtoneAnchor: 0 },
  }),
  // --- Kodak B&W additions ---
  createBuiltinProfile({
    id: 'double-x',
    name: 'Kodak Double-X 5222',
    type: 'bw',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Classic cinema B&W stock with bold contrast and gritty texture.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 30, highlightProtection: 20, blackPoint: 14 }),
    tonalCharacter: TONAL_CHARACTERS['double-x'],
  }),
  createBuiltinProfile({
    id: 'plus-x',
    name: 'Kodak Plus-X 125',
    type: 'bw',
    filmType: 'negative',
    category: 'Kodak',
    description: 'Medium-speed classic B&W with smooth tonality and open shadows.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 20, highlightProtection: 26, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['plus-x'],
  }),
  // --- Fuji additions ---
  createBuiltinProfile({
    id: 'fujifilm-200',
    name: 'Fujifilm 200',
    type: 'color',
    filmType: 'negative',
    category: 'Fuji',
    description: 'Current-production Fuji consumer stock with lively greens and cool balance.',
    defaultSettings: createDefaultSettings({ exposure: 3, contrast: 13, saturation: 110, temperature: -2, tint: 2, greenBalance: 1.04, blueBalance: 1.02, highlightProtection: 24 }),
    colorMatrix: COLOR_MATRICES['fujifilm-200'],
    tonalCharacter: TONAL_CHARACTERS['fujifilm-200'],
  }),
  createBuiltinProfile({
    id: 'astia-100f',
    name: 'Fuji Astia 100F',
    type: 'color',
    filmType: 'slide',
    category: 'Fuji',
    description: 'Neutral portrait slide with soft contrast and faithful skin tones.',
    defaultSettings: createDefaultSettings({ exposure: 0, contrast: 12, saturation: 106, highlightProtection: 12, blackPoint: 6, whitePoint: 248, filmBaseSample: { r: 255, g: 255, b: 255 } }),
    colorMatrix: [1.06, -0.04, -0.02, -0.02, 1.03, -0.01, -0.01, -0.02, 1.04],
    tonalCharacter: { shadowLift: 0.03, highlightRolloff: 0.30, midtoneAnchor: 0 },
  }),
  // --- Ilford additions ---
  createBuiltinProfile({
    id: 'xp2-super',
    name: 'Ilford XP2 Super',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'C-41 process B&W with smooth grain and wide exposure latitude.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 16, highlightProtection: 30, blackPoint: 8 }),
    tonalCharacter: TONAL_CHARACTERS['xp2-super'],
  }),
  createBuiltinProfile({
    id: 'delta-100',
    name: 'Ilford Delta 100',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Fine-grain modern B&W with clean tonality and subtle contrast.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 20, highlightProtection: 26, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['delta-100'],
  }),
  createBuiltinProfile({
    id: 'delta-400',
    name: 'Ilford Delta 400',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Mid-speed tabular B&W with crisp mids and controlled grain.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 26, highlightProtection: 22, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS['delta-400'],
  }),
  createBuiltinProfile({
    id: 'sfx-200',
    name: 'Ilford SFX 200',
    type: 'bw',
    filmType: 'negative',
    category: 'Ilford',
    description: 'Extended-red sensitivity B&W with deep blacks and dramatic contrast.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 28, highlightProtection: 18, blackPoint: 14 }),
    tonalCharacter: TONAL_CHARACTERS['sfx-200'],
  }),
  // --- Foma ---
  createBuiltinProfile({
    id: 'fomapan-100',
    name: 'Fomapan 100',
    type: 'bw',
    filmType: 'negative',
    category: 'Foma',
    description: 'Czech budget B&W with classic grain and honest tonality.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 22, highlightProtection: 24, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['fomapan-100'],
  }),
  createBuiltinProfile({
    id: 'fomapan-200',
    name: 'Fomapan 200',
    type: 'bw',
    filmType: 'negative',
    category: 'Foma',
    description: 'Unique mid-speed B&W with open shadows and moderate grain.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 20, highlightProtection: 26, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['fomapan-200'],
  }),
  createBuiltinProfile({
    id: 'fomapan-400',
    name: 'Fomapan 400',
    type: 'bw',
    filmType: 'negative',
    category: 'Foma',
    description: 'High-speed budget B&W with visible grain and punchy midtones.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 22, highlightProtection: 22, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS['fomapan-400'],
  }),
  // --- Rollei ---
  createBuiltinProfile({
    id: 'rpx-25',
    name: 'Rollei RPX 25',
    type: 'bw',
    filmType: 'negative',
    category: 'Rollei',
    description: 'Ultra-fine grain B&W with exceptional detail and smooth tones.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 24, highlightProtection: 24, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['rpx-25'],
  }),
  createBuiltinProfile({
    id: 'rpx-100',
    name: 'Rollei RPX 100',
    type: 'bw',
    filmType: 'negative',
    category: 'Rollei',
    description: 'Fine-grain B&W with balanced contrast and clean shadows.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 22, highlightProtection: 24, blackPoint: 10 }),
    tonalCharacter: TONAL_CHARACTERS['rpx-100'],
  }),
  createBuiltinProfile({
    id: 'rpx-400',
    name: 'Rollei RPX 400',
    type: 'bw',
    filmType: 'negative',
    category: 'Rollei',
    description: 'Versatile high-speed B&W with pronounced grain and firm contrast.',
    defaultSettings: createDefaultSettings({ saturation: 0, contrast: 24, highlightProtection: 20, blackPoint: 12 }),
    tonalCharacter: TONAL_CHARACTERS['rpx-400'],
  }),
];

export const LAB_STYLE_PROFILES: LabStyleProfile[] = [
  {
    id: 'lab-frontier-classic',
    name: 'Lab: Frontier Classic',
    description: 'Warm, saturated color with lifted blacks and a gentle shoulder.',
    toneCurve: [
      { x: 0, y: 10 },
      { x: 24, y: 28 },
      { x: 72, y: 84 },
      { x: 132, y: 150 },
      { x: 196, y: 214 },
      { x: 255, y: 246 },
    ],
    channelCurves: {
      r: [{ x: 0, y: 4 }, { x: 128, y: 132 }, { x: 255, y: 255 }],
      g: [{ x: 0, y: 0 }, { x: 120, y: 118 }, { x: 255, y: 248 }],
      b: [{ x: 0, y: 0 }, { x: 128, y: 122 }, { x: 255, y: 244 }],
    },
    tonalCharacterOverride: { shadowLift: 0.12, highlightRolloff: 0.7, midtoneAnchor: 0.01 },
    saturationBias: 10,
    temperatureBias: 8,
  },
  {
    id: 'lab-frontier-modern',
    name: 'Lab: Frontier Modern',
    description: 'Cleaner highlights with a lighter Frontier-style color signature.',
    toneCurve: [
      { x: 0, y: 6 },
      { x: 36, y: 38 },
      { x: 96, y: 104 },
      { x: 160, y: 170 },
      { x: 220, y: 228 },
      { x: 255, y: 250 },
    ],
    channelCurves: {
      r: [{ x: 0, y: 2 }, { x: 128, y: 130 }, { x: 255, y: 253 }],
      g: [{ x: 0, y: 0 }, { x: 128, y: 126 }, { x: 255, y: 250 }],
    },
    tonalCharacterOverride: { shadowLift: 0.08, highlightRolloff: 0.58 },
    saturationBias: 3,
    temperatureBias: 3,
  },
  {
    id: 'lab-noritsu',
    name: 'Lab: Noritsu',
    description: 'Cooler, straighter midtones with slightly firmer contrast.',
    toneCurve: [
      { x: 0, y: 2 },
      { x: 48, y: 44 },
      { x: 116, y: 114 },
      { x: 184, y: 188 },
      { x: 255, y: 252 },
    ],
    tonalCharacterOverride: { shadowLift: 0.04, highlightRolloff: 0.42, midtoneAnchor: -0.005 },
    saturationBias: -2,
    temperatureBias: -5,
  },
  {
    id: 'lab-neutral',
    name: 'Lab: Neutral',
    description: 'Minimal transfer curve and color bias for manual grading.',
    toneCurve: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    tonalCharacterOverride: { shadowLift: 0.02, highlightRolloff: 0.35 },
    saturationBias: 0,
    temperatureBias: 0,
  },
  {
    id: 'lab-agfa',
    name: 'Lab: Agfa d-Lab',
    description: 'Cooler midtones with muted saturation and slight green bias.',
    toneCurve: [
      { x: 0, y: 4 },
      { x: 40, y: 38 },
      { x: 100, y: 100 },
      { x: 170, y: 176 },
      { x: 230, y: 234 },
      { x: 255, y: 250 },
    ],
    channelCurves: {
      g: [{ x: 0, y: 2 }, { x: 128, y: 132 }, { x: 255, y: 252 }],
      b: [{ x: 0, y: 2 }, { x: 128, y: 130 }, { x: 255, y: 250 }],
    },
    tonalCharacterOverride: { shadowLift: 0.06, highlightRolloff: 0.48, midtoneAnchor: -0.005 },
    saturationBias: -4,
    temperatureBias: -3,
  },
];

export const LAB_STYLE_PROFILES_MAP: Record<string, LabStyleProfile> = Object.fromEntries(
  LAB_STYLE_PROFILES.map((profile) => [profile.id, profile]),
);
