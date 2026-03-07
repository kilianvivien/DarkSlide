import { ConversionSettings, CropSettings, Curves, ExportOptions, FilmProfile } from './types';

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
    crop: structuredClone(DEFAULT_CROP),
    filmBaseSample: null,
    ...overrides,
  };
}

export const SUPPORTED_EXTENSIONS = ['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.webp'] as const;
export const RAW_EXTENSIONS = ['.dng', '.cr3', '.nef', '.arw', '.raf', '.rw2'] as const;
export const MAX_IMAGE_PIXELS = 120_000_000;
export const MAX_IMAGE_DIMENSION = 18_000;
export const PREVIEW_LEVELS = [512, 1024, 2048];
export const DIAGNOSTICS_LIMIT = 100;

export const ASPECT_RATIOS = [
  { name: 'Free', value: null },
  { name: '1:1', value: 1, category: 'Social' },
  { name: '4:5', value: 0.8, category: 'Social' },
  { name: '9:16', value: 0.5625, category: 'Social' },
  { name: '3:2', value: 1.5, category: 'Print' },
  { name: '4:3', value: 4 / 3, category: 'Print' },
  { name: '5:7', value: 5 / 7, category: 'Print' },
  { name: '16:9', value: 16 / 9, category: 'Digital' },
];

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
  },
];
