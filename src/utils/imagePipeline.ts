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

export function processImageData(
  imageData: ImageData,
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
): HistogramData {
  const data = imageData.data;
  const lutRGB = createCurveLut(settings.curves.rgb);
  const lutR = createCurveLut(settings.curves.red);
  const lutG = createCurveLut(settings.curves.green);
  const lutB = createCurveLut(settings.curves.blue);
  const histogram = buildEmptyHistogram();
  const exposureFactor = Math.pow(2, settings.exposure / 50);
  const contrastFactor = (259 * (settings.contrast + 255)) / (255 * (259 - settings.contrast));
  const saturationFactor = settings.saturation / 100;
  const filmBaseBalance = getFilmBaseBalance(settings.filmBaseSample);

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
        r *= settings.redBalance;
        g *= settings.greenBalance;
        b *= settings.blueBalance;
        r += settings.temperature;
        b -= settings.temperature;
        g += settings.tint;
      } else {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray;
        g = gray;
        b = gray;
      }

      r *= exposureFactor;
      g *= exposureFactor;
      b *= exposureFactor;

      r = applyWhiteBlackPoint(r, settings.blackPoint, settings.whitePoint);
      g = applyWhiteBlackPoint(g, settings.blackPoint, settings.whitePoint);
      b = applyWhiteBlackPoint(b, settings.blackPoint, settings.whitePoint);

      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;

      r = applyHighlightProtection(r, settings.highlightProtection);
      g = applyHighlightProtection(g, settings.highlightProtection);
      b = applyHighlightProtection(b, settings.highlightProtection);

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

    histogram.r[finalR] += 1;
    histogram.g[finalG] += 1;
    histogram.b[finalB] += 1;
    histogram.l[Math.round(0.299 * finalR + 0.587 * finalG + 0.114 * finalB)] += 1;
  }

  return histogram;
}
