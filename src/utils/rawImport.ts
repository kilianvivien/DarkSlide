import { RAW_EXTENSIONS } from '../constants';
import { ConversionSettings, DecodeRequest, FilmBaseSample, FilmProfile, RawDecodeResult } from '../types';
import { getColorProfileIdFromName } from './colorProfiles';
import { clamp } from './math';

export const RAW_IMPORT_PROFILE_ID = 'raw-import-result';

export interface DesktopRawDecodeForWorkerOptions {
  documentId: string;
  fileName: string;
  path: string;
  size: number;
}

export function isRawExtension(extension: string) {
  return RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number]);
}

export function rotationFromExifOrientation(orientation: number | null | undefined) {
  switch (orientation) {
    case 3:
    case 4:
      return 180;
    case 5:
    case 6:
      return 90;
    case 7:
    case 8:
      return 270;
    default:
      return 0;
  }
}

export function rgbToRgba(rgb: ArrayLike<number>, width: number, height: number) {
  const expectedLength = width * height * 3;
  if (rgb.length !== expectedLength) {
    throw new Error(`RAW decode returned ${rgb.length} RGB bytes for a ${width}x${height} image.`);
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < rgb.length; sourceIndex += 3, targetIndex += 4) {
    rgba[targetIndex] = rgb[sourceIndex] ?? 0;
    rgba[targetIndex + 1] = rgb[sourceIndex + 1] ?? 0;
    rgba[targetIndex + 2] = rgb[sourceIndex + 2] ?? 0;
    rgba[targetIndex + 3] = 255;
  }
  return rgba;
}

export function createWorkerDecodeRequestFromRaw(
  documentId: string,
  fileName: string,
  size: number,
  rawResult: RawDecodeResult,
): DecodeRequest {
  const precomputedFilmBaseSample = estimateFilmBaseSample(rawResult.data, rawResult.width, rawResult.height);

  return {
    documentId,
    buffer: rgbToRgba(rawResult.data, rawResult.width, rawResult.height).buffer,
    fileName,
    mime: 'image/x-raw-rgba',
    size,
    rawDimensions: {
      width: rawResult.width,
      height: rawResult.height,
    },
    precomputedFilmBaseSample,
    declaredColorProfileName: rawResult.color_space,
    declaredColorProfileId: getColorProfileIdFromName(rawResult.color_space),
  };
}

export async function decodeDesktopRawForWorker(options: DesktopRawDecodeForWorkerOptions) {
  const { invoke } = await import('@tauri-apps/api/core');
  const rawResult = await invoke<RawDecodeResult>('decode_raw', { path: options.path });

  return {
    rawResult,
    decodeRequest: createWorkerDecodeRequestFromRaw(
      options.documentId,
      options.fileName,
      options.size,
      rawResult,
    ),
  };
}

function estimateFilmBaseSampleWithStride(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  stride: 3 | 4,
): FilmBaseSample | null {
  if (width < 8 || height < 8 || pixels.length < width * height * stride) {
    return null;
  }

  const BIN_COUNT = 64;
  const BIN_WIDTH = 256 / BIN_COUNT;
  const CLUSTER_RADIUS = 10;
  const MIN_CLUSTER_SIZE = 12;
  const borderThickness = Math.max(8, Math.min(160, Math.round(Math.min(width, height) * 0.03)));
  const borderPixels = width * borderThickness * 2 + Math.max(0, height - borderThickness * 2) * borderThickness * 2;
  const step = Math.max(1, Math.round(Math.sqrt(borderPixels / 4096)));
  const samples: Array<{ lum: number; r: number; g: number; b: number }> = [];

  const pushSample = (x: number, y: number) => {
    const index = (y * width + x) * stride;
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    samples.push({
      lum: 0.299 * r + 0.587 * g + 0.114 * b,
      r,
      g,
      b,
    });
  };

  for (let y = 0; y < borderThickness; y += step) {
    for (let x = 0; x < width; x += step) {
      pushSample(x, y);
      pushSample(x, height - 1 - y);
    }
  }

  for (let y = borderThickness; y < height - borderThickness; y += step) {
    for (let x = 0; x < borderThickness; x += step) {
      pushSample(x, y);
      pushSample(width - 1 - x, y);
    }
  }

  if (samples.length < 24) {
    return null;
  }

  const candidateSamples = [...samples]
    .sort((left, right) => right.lum - left.lum)
    .slice(0, Math.max(24, Math.min(512, Math.round(samples.length * 0.2))));
  const result = { r: 0, g: 0, b: 0 } satisfies FilmBaseSample;

  for (const channel of ['r', 'g', 'b'] as const) {
    const bins = new Uint32Array(BIN_COUNT);
    for (const sample of candidateSamples) {
      const bin = Math.min(BIN_COUNT - 1, Math.floor(sample[channel] / BIN_WIDTH));
      bins[bin] += 1;
    }

    let modeBin = 0;
    for (let index = 1; index < BIN_COUNT; index += 1) {
      if (bins[index] > bins[modeBin]) {
        modeBin = index;
      }
    }

    const modeCenter = (modeBin + 0.5) * BIN_WIDTH;
    let sum = 0;
    let count = 0;

    for (const sample of candidateSamples) {
      if (Math.abs(sample[channel] - modeCenter) <= CLUSTER_RADIUS) {
        sum += sample[channel];
        count += 1;
      }
    }

    if (count < MIN_CLUSTER_SIZE) {
      const takeCount = Math.max(24, Math.min(256, Math.round(samples.length * 0.12)));
      const topSamples = [...samples].sort((left, right) => right.lum - left.lum).slice(0, takeCount);
      const sums = topSamples.reduce((acc, sample) => ({
        r: acc.r + sample.r,
        g: acc.g + sample.g,
        b: acc.b + sample.b,
      }), { r: 0, g: 0, b: 0 });

      return {
        r: clamp(Math.round(sums.r / topSamples.length), 1, 255),
        g: clamp(Math.round(sums.g / topSamples.length), 1, 255),
        b: clamp(Math.round(sums.b / topSamples.length), 1, 255),
      };
    }

    result[channel] = clamp(Math.round(sum / count), 1, 255);
  }

  if (Math.min(result.r, result.g, result.b) < 5) {
    return null;
  }

  return result;
}

export function estimateFilmBaseSample(rgb: ArrayLike<number>, width: number, height: number): FilmBaseSample | null {
  return estimateFilmBaseSampleWithStride(rgb, width, height, 3);
}

export function estimateFilmBaseSampleFromRgba(rgba: ArrayLike<number>, width: number, height: number): FilmBaseSample | null {
  return estimateFilmBaseSampleWithStride(rgba, width, height, 4);
}

export function getFilmBaseChannelBalance(sample: FilmBaseSample | null) {
  if (!sample) {
    return {
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
    };
  }

  const safeR = Math.max(255 - sample.r, 1);
  const safeG = Math.max(255 - sample.g, 1);
  const safeB = Math.max(255 - sample.b, 1);

  return {
    redBalance: safeG / safeR,
    greenBalance: 1,
    blueBalance: safeG / safeB,
  };
}

export function getFilmBaseCorrectionSettings(sample: FilmBaseSample | null) {
  return {
    filmBaseSample: null,
    temperature: 0,
    tint: 0,
    ...getFilmBaseChannelBalance(sample),
  } satisfies Pick<ConversionSettings, 'filmBaseSample' | 'temperature' | 'tint' | 'redBalance' | 'greenBalance' | 'blueBalance'>;
}

export function getFilmBaseExposure(sample: FilmBaseSample | null, targetWhitePoint = 245 / 255) {
  if (!sample) {
    return 0;
  }

  const positiveGreen = clamp((255 - sample.g) / 255, 1 / 255, 1);
  const target = clamp(targetWhitePoint, 1 / 255, 1);
  return clamp(Math.round(50 * Math.log2(target / positiveGreen)), -100, 100);
}

export function buildRawInitialSettings(
  baseSettings: ConversionSettings,
  rgb: ArrayLike<number>,
  width: number,
  height: number,
  orientation: number | null | undefined,
  estimatedFilmBaseSample: FilmBaseSample | null = estimateFilmBaseSample(rgb, width, height),
) {
  const nextSettings = structuredClone(baseSettings);

  if (nextSettings.inversionMethod === 'advanced-hd') {
    return {
      ...nextSettings,
      rotation: rotationFromExifOrientation(orientation),
    } satisfies ConversionSettings;
  }

  return {
    ...nextSettings,
    ...getFilmBaseCorrectionSettings(estimatedFilmBaseSample),
    exposure: getFilmBaseExposure(estimatedFilmBaseSample),
    rotation: rotationFromExifOrientation(orientation),
  } satisfies ConversionSettings;
}

export function createRawImportProfile(baseProfile: FilmProfile, settings: ConversionSettings): FilmProfile {
  return {
    ...baseProfile,
    id: RAW_IMPORT_PROFILE_ID,
    name: 'Raw Import Result',
    description: 'Exact starting point produced during RAW import.',
    defaultSettings: structuredClone(settings),
  } satisfies FilmProfile;
}
