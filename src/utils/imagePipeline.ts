import {
  ConversionSettings,
  CurvePoint,
  CropSettings,
  ExportFormat,
  FilmBaseSample,
  HistogramData,
  PreviewLevel,
} from '../types';
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../constants';

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getExtensionFromFormat(format: ExportFormat) {
  switch (format) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'jpg';
  }
}

export function sanitizeFilenameBase(name: string) {
  const cleaned = name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'darkslide-converted';
}

export function getFileExtension(fileName: string) {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : '';
}

export function assertSupportedDimensions(width: number, height: number) {
  if (width < 1 || height < 1) {
    throw new Error('Image has invalid dimensions.');
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Image exceeds the supported maximum dimension of ${MAX_IMAGE_DIMENSION}px.`);
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image exceeds the supported ${Math.round(MAX_IMAGE_PIXELS / 1_000_000)} MP limit for the browser build.`);
  }
}

function getCurveValue(points: CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  if (points.length === 1) return points[0].y;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];

    if (x >= current.x && x <= next.x) {
      const span = next.x - current.x || 1;
      const t = (x - current.x) / span;
      return current.y + t * (next.y - current.y);
    }
  }

  if (x < points[0].x) return points[0].y;
  return points[points.length - 1].y;
}

export function createCurveLut(points: CurvePoint[]) {
  const lut = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    lut[index] = clamp(Math.round(getCurveValue(points, index)), 0, 255);
  }
  return lut;
}

export function normalizeCrop(settings: ConversionSettings) {
  const crop = settings.crop;
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);

  return {
    ...crop,
    x,
    y,
    width,
    height,
  };
}

export function normalizeAngle(angle: number) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getTransformedDimensions(width: number, height: number, angle: number) {
  const normalizedAngle = normalizeAngle(angle);
  const radians = (normalizedAngle * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians)) < 1e-10 ? 0 : Math.cos(radians);
  const sine = Math.abs(Math.sin(radians)) < 1e-10 ? 0 : Math.sin(radians);

  return {
    width: Math.max(1, Math.ceil(Math.abs(width * cosine) + Math.abs(height * sine))),
    height: Math.max(1, Math.ceil(Math.abs(width * sine) + Math.abs(height * cosine))),
  };
}

export function getRotatedDimensions(width: number, height: number, rotation: number) {
  const normalizedRotation = normalizeAngle(rotation);
  const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
  return {
    width: isQuarterTurn ? height : width,
    height: isQuarterTurn ? width : height,
  };
}

export function getNormalizedAspectRatio(aspectRatio: number, imageWidth: number, imageHeight: number) {
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);
  return aspectRatio / (safeWidth / safeHeight);
}

export function createCenteredAspectCrop(aspectRatio: number, imageWidth: number, imageHeight: number): CropSettings {
  const normalizedAspectRatio = getNormalizedAspectRatio(aspectRatio, imageWidth, imageHeight);
  const width = normalizedAspectRatio > 1 ? 1 : normalizedAspectRatio;
  const height = normalizedAspectRatio > 1 ? 1 / normalizedAspectRatio : 1;

  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    aspectRatio,
  };
}

export function rotateCropClockwise(crop: CropSettings): CropSettings {
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);

  return {
    x: y,
    y: 1 - x - width,
    width: height,
    height: width,
    aspectRatio: crop.aspectRatio ? 1 / crop.aspectRatio : null,
  };
}

export function selectPreviewLevel(levels: PreviewLevel[], targetMaxDimension: number) {
  const ordered = [...levels].sort((a, b) => a.maxDimension - b.maxDimension);
  return ordered.find((level) => level.maxDimension >= targetMaxDimension) ?? ordered[ordered.length - 1];
}

function applyWhiteBlackPoint(value: number, blackPoint: number, whitePoint: number) {
  const range = Math.max(1, whitePoint - blackPoint);
  return ((value - blackPoint) / range) * 255;
}

function applyHighlightProtection(value: number, amount: number) {
  if (amount <= 0 || value <= 200) return value;
  const protection = clamp(amount / 100, 0, 0.95);
  const shoulder = (value - 200) / 55;
  return 200 + shoulder * 55 * (1 - protection * shoulder);
}

function getFilmBaseBalance(sample: FilmBaseSample | null) {
  if (!sample) {
    return { red: 1, green: 1, blue: 1 };
  }

  const safeR = Math.max(sample.r, 1);
  const safeG = Math.max(sample.g, 1);
  const safeB = Math.max(sample.b, 1);
  return {
    red: safeG / safeR,
    green: 1,
    blue: safeG / safeB,
  };
}

export function buildEmptyHistogram(): HistogramData {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    l: new Array(256).fill(0),
  };
}

function gaussianBlur1D(
  src: Uint8ClampedArray,
  dst: Float32Array,
  width: number,
  height: number,
  horizontal: boolean,
  kernelRadius: number,
): void {
  const size = Math.max(1, Math.round(kernelRadius));
  const kernelSize = size * 2 + 1;
  const kernel = new Float32Array(kernelSize);
  const sigma = kernelRadius * 0.65 + 0.35;
  let kernelSum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const d = i - size;
    kernel[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    kernelSum += kernel[i];
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= kernelSum;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0, sumG = 0, sumB = 0;
      for (let k = -size; k <= size; k++) {
        const sx = horizontal ? clamp(x + k, 0, width - 1) : x;
        const sy = horizontal ? y : clamp(y + k, 0, height - 1);
        const idx = (sy * width + sx) * 4;
        const w = kernel[k + size];
        sumR += src[idx] * w;
        sumG += src[idx + 1] * w;
        sumB += src[idx + 2] * w;
      }
      const dIdx = (y * width + x) * 4;
      dst[dIdx] = sumR;
      dst[dIdx + 1] = sumG;
      dst[dIdx + 2] = sumB;
    }
  }
}

function separableGaussianBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const len = width * height * 4;
  const temp = new Uint8ClampedArray(len);
  const hPass = new Float32Array(len);
  gaussianBlur1D(data, hPass, width, height, true, radius);
  for (let i = 0; i < len; i++) temp[i] = clamp(Math.round(hPass[i]), 0, 255);
  const result = new Float32Array(len);
  gaussianBlur1D(temp, result, width, height, false, radius);
  return result;
}

function applyNoiseReduction(imageData: ImageData, strength: number): void {
  if (strength <= 0) return;
  const { data, width, height } = imageData;
  const factor = strength / 100;
  const blurred = separableGaussianBlur(data, width, height, 1.5);

  for (let i = 0; i < data.length; i += 4) {
    const lumOrig = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const lumBlur = 0.299 * blurred[i] + 0.587 * blurred[i + 1] + 0.114 * blurred[i + 2];
    const lumNew = lumOrig + (lumBlur - lumOrig) * factor;
    const lumScale = lumOrig > 0.001 ? lumNew / lumOrig : 1;
    data[i] = clamp(Math.round(data[i] * lumScale), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] * lumScale), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] * lumScale), 0, 255);
  }
}

function applySharpen(imageData: ImageData, radius: number, amount: number): void {
  if (amount <= 0) return;
  const { data, width, height } = imageData;
  const factor = amount / 100;
  const blurred = separableGaussianBlur(data, width, height, radius);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(Math.round(data[i] + factor * (data[i] - blurred[i])), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] + factor * (data[i + 1] - blurred[i + 1])), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] + factor * (data[i + 2] - blurred[i + 2])), 0, 255);
  }
}

export interface MaskTuning {
  highlightProtectionBias: number;
  blackPointBias: number;
}

export function processImageData(
  imageData: ImageData,
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
  maskTuning?: MaskTuning,
): HistogramData {
  const effectiveSettings = maskTuning ? {
    ...settings,
    highlightProtection: clamp(settings.highlightProtection + maskTuning.highlightProtectionBias * 100, 0, 100),
    blackPoint: clamp(settings.blackPoint + maskTuning.blackPointBias * 100, 0, 80),
  } : settings;

  const data = imageData.data;
  const lutRGB = createCurveLut(effectiveSettings.curves.rgb);
  const lutR = createCurveLut(effectiveSettings.curves.red);
  const lutG = createCurveLut(effectiveSettings.curves.green);
  const lutB = createCurveLut(effectiveSettings.curves.blue);
  const histogram = buildEmptyHistogram();
  const exposureFactor = Math.pow(2, effectiveSettings.exposure / 50);
  const contrastFactor = (259 * (effectiveSettings.contrast + 255)) / (255 * (259 - effectiveSettings.contrast));
  const saturationFactor = effectiveSettings.saturation / 100;
  const filmBaseBalance = getFilmBaseBalance(effectiveSettings.filmBaseSample);

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index];
    let g = data[index + 1];
    let b = data[index + 2];

    if (comparisonMode === 'processed') {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;

      r *= filmBaseBalance.red;
      g *= filmBaseBalance.green;
      b *= filmBaseBalance.blue;

      if (isColor) {
        r *= effectiveSettings.redBalance;
        g *= effectiveSettings.greenBalance;
        b *= effectiveSettings.blueBalance;
        r += effectiveSettings.temperature;
        b -= effectiveSettings.temperature;
        g += effectiveSettings.tint;
      } else {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray;
        g = gray;
        b = gray;
      }

      r *= exposureFactor;
      g *= exposureFactor;
      b *= exposureFactor;

      r = applyWhiteBlackPoint(r, effectiveSettings.blackPoint, effectiveSettings.whitePoint);
      g = applyWhiteBlackPoint(g, effectiveSettings.blackPoint, effectiveSettings.whitePoint);
      b = applyWhiteBlackPoint(b, effectiveSettings.blackPoint, effectiveSettings.whitePoint);

      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;

      r = applyHighlightProtection(r, effectiveSettings.highlightProtection);
      g = applyHighlightProtection(g, effectiveSettings.highlightProtection);
      b = applyHighlightProtection(b, effectiveSettings.highlightProtection);

      if (isColor) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * saturationFactor;
        g = gray + (g - gray) * saturationFactor;
        b = gray + (b - gray) * saturationFactor;
      } else {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray;
        g = gray;
        b = gray;
      }

      const mappedR = clamp(Math.round(r), 0, 255);
      const mappedG = clamp(Math.round(g), 0, 255);
      const mappedB = clamp(Math.round(b), 0, 255);

      r = lutR[lutRGB[mappedR]];
      g = lutG[lutRGB[mappedG]];
      b = lutB[lutRGB[mappedB]];
    }

    const finalR = clamp(Math.round(r), 0, 255);
    const finalG = clamp(Math.round(g), 0, 255);
    const finalB = clamp(Math.round(b), 0, 255);

    data[index] = finalR;
    data[index + 1] = finalG;
    data[index + 2] = finalB;
  }

  // Spatial operations (after per-pixel pipeline)
  if (comparisonMode === 'processed') {
    if (effectiveSettings.noiseReduction.enabled && effectiveSettings.noiseReduction.luminanceStrength > 0) {
      applyNoiseReduction(imageData, effectiveSettings.noiseReduction.luminanceStrength);
    }
    if (effectiveSettings.sharpen.enabled && effectiveSettings.sharpen.amount > 0) {
      applySharpen(imageData, effectiveSettings.sharpen.radius, effectiveSettings.sharpen.amount);
    }
  }

  // Build histogram from final pixel data
  for (let index = 0; index < data.length; index += 4) {
    histogram.r[data[index]] += 1;
    histogram.g[data[index + 1]] += 1;
    histogram.b[data[index + 2]] += 1;
    histogram.l[Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2])] += 1;
  }

  return histogram;
}
