import { ColorManagementSettings, ColorMatrix, ConversionSettings, CropSettings, CropTab, Curves, ExportOptions, FilmProfile, NotificationSettings, TonalCharacter } from './types';

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

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'image/jpeg',
  quality: 0.92,
  filenameBase: 'darkslide-converted',
  embedMetadata: true,
  outputProfileId: 'srgb',
  embedOutputProfile: true,
};

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
  return {
    exposure: 0,
    contrast: 10,
    saturation: 100,
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
  'ektar-100': { shadowLift: 0.03, highlightRolloff: 0.3, midtoneAnchor: 0 },
  'gold-200': { shadowLift: 0.08, highlightRolloff: 0.4, midtoneAnchor: 0.02 },
  'fuji-400h': { shadowLift: 0.1, highlightRolloff: 0.55, midtoneAnchor: -0.01 },
  'superia-400': { shadowLift: 0.06, highlightRolloff: 0.4, midtoneAnchor: 0 },
  'cinestill-800t': { shadowLift: 0.12, highlightRolloff: 0.6, midtoneAnchor: 0 },
  'generic-bw': { shadowLift: 0.04, highlightRolloff: 0.5, midtoneAnchor: 0 },
  hp5: { shadowLift: 0.08, highlightRolloff: 0.5, midtoneAnchor: 0 },
  'tri-x': { shadowLift: 0.05, highlightRolloff: 0.35, midtoneAnchor: 0 },
  'delta-3200': { shadowLift: 0.02, highlightRolloff: 0.25, midtoneAnchor: -0.02 },
};

const COLOR_MATRICES: Record<string, ColorMatrix> = {
  'generic-color': IDENTITY_COLOR_MATRIX,
  'portra-400': [1.15, -0.1, -0.05, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08],
  'portra-160': [1.12, -0.08, -0.04, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07],
  'ektar-100': [1.2, -0.12, -0.08, -0.05, 1.1, -0.05, -0.03, -0.08, 1.11],
  'gold-200': [1.18, -0.11, -0.07, -0.05, 1.09, -0.04, -0.03, -0.07, 1.1],
  'fuji-400h': [1.1, -0.06, -0.04, -0.02, 1.05, -0.03, -0.01, -0.04, 1.05],
  'superia-400': [1.12, -0.07, -0.05, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07],
  'cinestill-800t': [1.08, -0.05, -0.03, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04],
};

export const FILM_PROFILES: FilmProfile[] = [
  {
    id: 'generic-bw',
    version: 1,
    name: 'Generic B&W',
    type: 'bw',
    description: 'Neutral black and white inversion with restrained contrast.',
    defaultSettings: createDefaultSettings({
      saturation: 0,
      contrast: 14,
      highlightProtection: 25,
    }),
    tonalCharacter: TONAL_CHARACTERS['generic-bw'],
  },
  {
    id: 'generic-color',
    version: 1,
    name: 'Generic Color',
    type: 'color',
    description: 'Balanced color-negative starting point for most consumer scans.',
    defaultSettings: createDefaultSettings({
      contrast: 15,
      redBalance: 1.12,
      blueBalance: 0.9,
      highlightProtection: 26,
    }),
    colorMatrix: COLOR_MATRICES['generic-color'],
    tonalCharacter: TONAL_CHARACTERS['generic-color'],
  },
  {
    id: 'hp5',
    version: 1,
    name: 'Ilford HP5 Plus',
    type: 'bw',
    description: 'Classic high-speed B&W profile with punchier midtones.',
    defaultSettings: createDefaultSettings({
      saturation: 0,
      contrast: 24,
      highlightProtection: 30,
      blackPoint: 12,
    }),
    tonalCharacter: TONAL_CHARACTERS.hp5,
  },
  {
    id: 'tri-x',
    version: 1,
    name: 'Kodak Tri-X 400',
    type: 'bw',
    description: 'Distinctive grain and crisp contrast for documentary scans.',
    defaultSettings: createDefaultSettings({
      saturation: 0,
      contrast: 34,
      highlightProtection: 22,
      blackPoint: 14,
    }),
    tonalCharacter: TONAL_CHARACTERS['tri-x'],
  },
  {
    id: 'portra-400',
    version: 1,
    name: 'Kodak Portra 400',
    type: 'color',
    description: 'Warm skin tones with gentle contrast and protected highlights.',
    defaultSettings: createDefaultSettings({
      exposure: 4,
      contrast: 11,
      saturation: 108,
      temperature: 4,
      tint: -2,
      redBalance: 1.14,
      blueBalance: 0.88,
      highlightProtection: 34,
    }),
    maskTuning: {
      highlightProtectionBias: 0.08,
      blackPointBias: -0.02,
    },
    colorMatrix: COLOR_MATRICES['portra-400'],
    tonalCharacter: TONAL_CHARACTERS['portra-400'],
  },
  {
    id: 'ektar-100',
    version: 1,
    name: 'Kodak Ektar 100',
    type: 'color',
    description: 'Higher saturation and slightly firmer contrast for vivid negatives.',
    defaultSettings: createDefaultSettings({
      contrast: 20,
      saturation: 130,
      redBalance: 1.08,
      blueBalance: 0.92,
      highlightProtection: 18,
    }),
    colorMatrix: COLOR_MATRICES['ektar-100'],
    tonalCharacter: TONAL_CHARACTERS['ektar-100'],
  },
  {
    id: 'fuji-400h',
    version: 1,
    name: 'Fujifilm Pro 400H',
    type: 'color',
    description: 'Cooler palette with softer contrast and green-friendly balance.',
    defaultSettings: createDefaultSettings({
      exposure: 8,
      contrast: 6,
      saturation: 96,
      temperature: -5,
      tint: 4,
      greenBalance: 1.08,
      blueBalance: 1.14,
      highlightProtection: 30,
    }),
    colorMatrix: COLOR_MATRICES['fuji-400h'],
    tonalCharacter: TONAL_CHARACTERS['fuji-400h'],
  },
  {
    id: 'portra-160',
    version: 1,
    name: 'Kodak Portra 160',
    type: 'color',
    description: 'Fine-grained portrait stock with neutral, slightly cool rendering.',
    defaultSettings: createDefaultSettings({
      exposure: 2,
      contrast: 8,
      saturation: 104,
      temperature: 2,
      tint: -1,
      redBalance: 1.10,
      blueBalance: 0.92,
      highlightProtection: 30,
      blackPoint: 6,
    }),
    maskTuning: {
      highlightProtectionBias: 0.06,
      blackPointBias: -0.01,
    },
    colorMatrix: COLOR_MATRICES['portra-160'],
    tonalCharacter: TONAL_CHARACTERS['portra-160'],
  },
  {
    id: 'gold-200',
    version: 1,
    name: 'Kodak Gold 200',
    type: 'color',
    description: 'Warm, saturated consumer stock with golden highlights.',
    defaultSettings: createDefaultSettings({
      exposure: 6,
      contrast: 18,
      saturation: 125,
      temperature: 8,
      tint: -2,
      redBalance: 1.16,
      blueBalance: 0.86,
      highlightProtection: 20,
      blackPoint: 10,
    }),
    colorMatrix: COLOR_MATRICES['gold-200'],
    tonalCharacter: TONAL_CHARACTERS['gold-200'],
  },
  {
    id: 'superia-400',
    version: 1,
    name: 'Fujifilm Superia 400',
    type: 'color',
    description: 'Punchy colors with vibrant greens and cool-leaning palette.',
    defaultSettings: createDefaultSettings({
      exposure: 4,
      contrast: 16,
      saturation: 118,
      temperature: -3,
      tint: 3,
      redBalance: 1.06,
      greenBalance: 1.06,
      blueBalance: 0.96,
      highlightProtection: 22,
    }),
    colorMatrix: COLOR_MATRICES['superia-400'],
    tonalCharacter: TONAL_CHARACTERS['superia-400'],
  },
  {
    id: 'cinestill-800t',
    version: 1,
    name: 'CineStill 800T',
    type: 'color',
    description: 'Tungsten-balanced cinema stock with cool shadows and warm highlights.',
    defaultSettings: createDefaultSettings({
      exposure: 8,
      contrast: 12,
      saturation: 112,
      temperature: -8,
      tint: 2,
      redBalance: 1.18,
      blueBalance: 1.08,
      highlightProtection: 35,
      blackPoint: 6,
      whitePoint: 240,
    }),
    maskTuning: {
      highlightProtectionBias: 0.10,
      blackPointBias: -0.03,
    },
    colorMatrix: COLOR_MATRICES['cinestill-800t'],
    tonalCharacter: TONAL_CHARACTERS['cinestill-800t'],
  },
  {
    id: 'delta-3200',
    version: 1,
    name: 'Ilford Delta 3200',
    type: 'bw',
    description: 'Ultra high-speed B&W with dramatic contrast and punchy tones.',
    defaultSettings: createDefaultSettings({
      saturation: 0,
      contrast: 40,
      highlightProtection: 18,
      blackPoint: 18,
      whitePoint: 240,
    }),
    tonalCharacter: TONAL_CHARACTERS['delta-3200'],
  },
];
