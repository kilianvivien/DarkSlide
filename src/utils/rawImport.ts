import { RAW_EXTENSIONS } from '../constants';
import { ConversionSettings, FilmBaseSample } from '../types';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function isRawExtension(extension: string) {
  return RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number]);
}

export function rotationFromExifOrientation(orientation: number | null | undefined) {
  switch (orientation) {
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}

export function estimateFilmBaseSample(rgb: ArrayLike<number>, width: number, height: number): FilmBaseSample | null {
  if (width < 8 || height < 8 || rgb.length < width * height * 3) {
    return null;
  }

  const borderThickness = Math.max(8, Math.min(160, Math.round(Math.min(width, height) * 0.03)));
  const borderPixels = width * borderThickness * 2 + Math.max(0, height - borderThickness * 2) * borderThickness * 2;
  const step = Math.max(1, Math.round(Math.sqrt(borderPixels / 4096)));
  const samples: Array<{ lum: number; r: number; g: number; b: number }> = [];

  const pushSample = (x: number, y: number) => {
    const index = (y * width + x) * 3;
    const r = rgb[index] ?? 0;
    const g = rgb[index + 1] ?? 0;
    const b = rgb[index + 2] ?? 0;
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

  samples.sort((left, right) => right.lum - left.lum);
  const takeCount = Math.max(24, Math.min(256, Math.round(samples.length * 0.12)));
  const topSamples = samples.slice(0, takeCount);

  const sums = topSamples.reduce((acc, sample) => ({
    r: acc.r + sample.r,
    g: acc.g + sample.g,
    b: acc.b + sample.b,
  }), { r: 0, g: 0, b: 0 });

  const average = {
    r: sums.r / topSamples.length,
    g: sums.g / topSamples.length,
    b: sums.b / topSamples.length,
  };

  const averageDeviation = topSamples.reduce((acc, sample) => (
    acc + (
      Math.abs(sample.r - average.r)
      + Math.abs(sample.g - average.g)
      + Math.abs(sample.b - average.b)
    ) / 3
  ), 0) / topSamples.length;

  if (averageDeviation > 24) {
    return null;
  }

  return {
    r: clamp(Math.round(average.r), 1, 255),
    g: clamp(Math.round(average.g), 1, 255),
    b: clamp(Math.round(average.b), 1, 255),
  };
}

export function getFilmBaseChannelBalance(sample: FilmBaseSample | null) {
  if (!sample) {
    return {
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
    };
  }

  const safeR = Math.max(sample.r, 1);
  const safeG = Math.max(sample.g, 1);
  const safeB = Math.max(sample.b, 1);

  return {
    redBalance: safeG / safeR,
    greenBalance: 1,
    blueBalance: safeG / safeB,
  };
}

export function buildRawInitialSettings(
  baseSettings: ConversionSettings,
  _rgb: ArrayLike<number>,
  _width: number,
  _height: number,
  orientation: number | null | undefined,
) {
  return {
    ...structuredClone(baseSettings),
    rotation: rotationFromExifOrientation(orientation),
  } satisfies ConversionSettings;
}
