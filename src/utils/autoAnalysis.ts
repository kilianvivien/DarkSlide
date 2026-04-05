import type { AutoAnalyzeResult, HistogramData } from '../types';
import { clamp } from './math';

const WB_MARGIN_RATIO = 0.04;
const WB_MARGIN_MIN = 8;
const WB_MARGIN_MAX = 48;
const WB_LUMA_MIN = 72;
const WB_LUMA_MAX = 196;
const WB_CHANNEL_MIN = 12;
const WB_CHANNEL_MAX = 243;
const WB_MAX_CHROMA = 36;
const WB_MIN_SAMPLE_COUNT = 256;
const WB_MIN_SAMPLE_RATIO = 0.0005;
const WB_SAMPLE_STRIDE = 2;
const FLOOR_THRESHOLD = 20;
const FLOOR_SPREAD_THRESHOLD = 15;
const FLOOR_PERCENTILE = 0.01;
const MIDTONE_COMPRESSION_THRESHOLD = 0.35;
const MIDTONE_MAX_BOOST = 25;
const WB_MAX_CHROMA_RELAXED = 56;
const WB_WARM_NUDGE = 5;
const MONO_MARGIN_RATIO = 0.05;
const MONO_MARGIN_MIN = 8;
const MONO_MARGIN_MAX = 64;
const MONO_LUMA_MIN = 16;
const MONO_LUMA_MAX = 239;
const MONO_MIN_SAMPLE_COUNT = 256;
const MONO_SAMPLE_STRIDE = 3;
const MONO_LOW_CHROMA_MAX = 12;
const MONO_HIGH_CHROMA_MIN = 28;
const MONO_MEAN_CHROMA_MAX = 16;
const MONO_LOW_CHROMA_RATIO_MIN = 0.6;
const MONO_HIGH_CHROMA_RATIO_MAX = 0.12;
const MONO_LOW_RESIDUAL_MAX = 0.24;
const MONO_HIGH_RESIDUAL_MIN = 0.5;
const MONO_MEAN_RESIDUAL_MAX = 0.2;
const MONO_LOW_RESIDUAL_RATIO_MIN = 0.82;
const MONO_HIGH_RESIDUAL_RATIO_MAX = 0.08;

export type MonochromeSuggestionAnalysis = {
  isLikelyMonochrome: boolean;
  sampleCount: number;
  meanChroma: number;
  lowChromaRatio: number;
  highChromaRatio: number;
  meanNormalizedResidual: number;
  lowResidualRatio: number;
  highResidualRatio: number;
};

function total(bins: number[]) {
  return bins.reduce((sum, value) => sum + value, 0);
}

function percentile(bins: number[], fraction: number) {
  const count = total(bins);
  if (count <= 0) {
    return fraction <= 0.5 ? 0 : 255;
  }

  const target = count * fraction;
  let seen = 0;
  for (let index = 0; index < bins.length; index += 1) {
    seen += bins[index];
    if (seen >= target) {
      return index;
    }
  }

  return bins.length - 1;
}

export function analyzeExposure(histogram: HistogramData): Pick<AutoAnalyzeResult, 'exposure' | 'blackPoint' | 'whitePoint'> {
  const p1 = percentile(histogram.l, 0.01);
  const p99 = percentile(histogram.l, 0.99);
  const midpoint = (p1 + p99) / 2;
  const normalizedShift = 0.5 - midpoint / 255;

  return {
    exposure: clamp(Math.round(normalizedShift * 200), -100, 100),
    blackPoint: clamp(Math.round((p1 / 255) * 80), 0, 80),
    whitePoint: clamp(Math.round(p99), 180, 255),
  };
}

export function analyzeChannelFloors(imageData: ImageData): {
  redFloor: number | null;
  greenFloor: number | null;
  blueFloor: number | null;
} {
  const { data } = imageData;
  const rHist = new Array<number>(256).fill(0);
  const gHist = new Array<number>(256).fill(0);
  const bHist = new Array<number>(256).fill(0);

  for (let i = 0; i < data.length; i += 4) {
    rHist[data[i]] += 1;
    gHist[data[i + 1]] += 1;
    bHist[data[i + 2]] += 1;
  }

  const rFloor = percentile(rHist, FLOOR_PERCENTILE);
  const gFloor = percentile(gHist, FLOOR_PERCENTILE);
  const bFloor = percentile(bHist, FLOOR_PERCENTILE);

  const maxFloor = Math.max(rFloor, gFloor, bFloor);
  const minFloor = Math.min(rFloor, gFloor, bFloor);

  if (maxFloor < FLOOR_THRESHOLD || (maxFloor - minFloor) < FLOOR_SPREAD_THRESHOLD) {
    return { redFloor: null, greenFloor: null, blueFloor: null };
  }

  return {
    redFloor: rFloor > FLOOR_THRESHOLD ? rFloor : null,
    greenFloor: gFloor > FLOOR_THRESHOLD ? gFloor : null,
    blueFloor: bFloor > FLOOR_THRESHOLD ? bFloor : null,
  };
}

export function analyzeMidtoneContrast(histogram: HistogramData): {
  contrast: number | null;
  midtoneBoostPoint: { x: number; y: number } | null;
} {
  const p25 = percentile(histogram.l, 0.25);
  const p50 = percentile(histogram.l, 0.5);
  const p75 = percentile(histogram.l, 0.75);
  const p1 = percentile(histogram.l, 0.01);
  const p99 = percentile(histogram.l, 0.99);
  const range = Math.max(1, p99 - p1);
  const iqr = p75 - p25;
  const compression = iqr / range;

  let contrast: number | null = null;
  if (compression < MIDTONE_COMPRESSION_THRESHOLD) {
    const boost = clamp(Math.round((MIDTONE_COMPRESSION_THRESHOLD - compression) * 60), 0, MIDTONE_MAX_BOOST);
    contrast = boost > 0 ? boost : null;
  }

  let midtoneBoostPoint: { x: number; y: number } | null = null;
  if (p50 < 128) {
    const liftAmount = clamp(Math.round((135 - p50) * 1.1), 15, 65);
    const anchorX = clamp(Math.round((p50 * 0.35 + 128 * 0.65)), 95, 135);
    midtoneBoostPoint = { x: anchorX, y: clamp(anchorX + liftAmount, anchorX, 255) };
  }

  return { contrast, midtoneBoostPoint };
}

function sampleColorBalance(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxChroma: number,
): { temperature: number; tint: number; sampleCount: number } | null {
  const margin = clamp(
    Math.round(Math.min(width, height) * WB_MARGIN_RATIO),
    WB_MARGIN_MIN,
    WB_MARGIN_MAX,
  );
  const left = Math.min(width, margin);
  const top = Math.min(height, margin);
  const right = Math.max(left, width - margin);
  const bottom = Math.max(top, height - margin);

  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let weightSum = 0;
  let sampleCount = 0;

  for (let y = top; y < bottom; y += WB_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += WB_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];

      if (
        r <= WB_CHANNEL_MIN || g <= WB_CHANNEL_MIN || b <= WB_CHANNEL_MIN
        || r >= WB_CHANNEL_MAX || g >= WB_CHANNEL_MAX || b >= WB_CHANNEL_MAX
      ) {
        continue;
      }

      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const chroma = maxChannel - minChannel;
      if (chroma > maxChroma) {
        continue;
      }

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < WB_LUMA_MIN || luma > WB_LUMA_MAX) {
        continue;
      }

      const neutralityWeight = 1 - chroma / maxChroma;
      const midtoneWeight = 1 - Math.abs(luma - 127.5) / 127.5;
      const weight = Math.max(0, neutralityWeight) * Math.max(0, neutralityWeight) * Math.max(0.05, midtoneWeight);
      if (weight <= 0) {
        continue;
      }

      weightedR += r * weight;
      weightedG += g * weight;
      weightedB += b * weight;
      weightSum += weight;
      sampleCount += 1;
    }
  }

  const minimumSamples = Math.max(
    WB_MIN_SAMPLE_COUNT,
    Math.round(((right - left) * (bottom - top) * WB_MIN_SAMPLE_RATIO) / (WB_SAMPLE_STRIDE * WB_SAMPLE_STRIDE)),
  );
  if (sampleCount < minimumSamples || weightSum <= 0) {
    return null;
  }

  const meanR = weightedR / weightSum;
  const meanG = weightedG / weightSum;
  const meanB = weightedB / weightSum;
  const rbAvg = (meanR + meanB) / 2;

  return {
    temperature: clamp(Math.round((meanB - meanR) * 0.4), -100, 100),
    tint: clamp(Math.round((rbAvg - meanG) * 0.4), -100, 100),
    sampleCount,
  };
}

export function analyzeColorBalance(imageData: ImageData, isColorNegative = false): Pick<AutoAnalyzeResult, 'temperature' | 'tint'> {
  const { data, width, height } = imageData;
  if (width <= 0 || height <= 0) {
    return { temperature: null, tint: null };
  }

  const firstPass = sampleColorBalance(data, width, height, WB_MAX_CHROMA);

  if (firstPass && Math.abs(firstPass.temperature) <= 15) {
    let temperature = firstPass.temperature;
    if (isColorNegative && temperature < 8) {
      temperature = clamp(temperature + WB_WARM_NUDGE, -100, 100);
    }
    return { temperature, tint: firstPass.tint };
  }

  const secondPass = firstPass === null || Math.abs(firstPass.temperature) > 15
    ? sampleColorBalance(data, width, height, WB_MAX_CHROMA_RELAXED)
    : null;

  const result = secondPass ?? firstPass;
  if (!result) {
    return { temperature: null, tint: null };
  }

  let temperature = result.temperature;
  if (isColorNegative && temperature < 8) {
    temperature = clamp(temperature + WB_WARM_NUDGE, -100, 100);
  }
  return { temperature, tint: result.tint };
}

export function analyzeMonochromeSuggestion(imageData: ImageData): MonochromeSuggestionAnalysis {
  const { data, width, height } = imageData;
  if (width <= 0 || height <= 0) {
    return {
      isLikelyMonochrome: false,
      sampleCount: 0,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const margin = clamp(
    Math.round(Math.min(width, height) * MONO_MARGIN_RATIO),
    MONO_MARGIN_MIN,
    MONO_MARGIN_MAX,
  );
  const left = Math.min(width, margin);
  const top = Math.min(height, margin);
  const right = Math.max(left, width - margin);
  const bottom = Math.max(top, height - margin);

  let weightedChroma = 0;
  let weightSum = 0;
  let lowChromaCount = 0;
  let highChromaCount = 0;
  let sampleCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSqR = 0;
  let sumSqG = 0;
  let sumSqB = 0;

  for (let y = top; y < bottom; y += MONO_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += MONO_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma < MONO_LUMA_MIN || luma > MONO_LUMA_MAX) {
        continue;
      }

      sampleCount += 1;
      sumR += r;
      sumG += g;
      sumB += b;
      sumSqR += r * r;
      sumSqG += g * g;
      sumSqB += b * b;
    }
  }

  if (sampleCount < MONO_MIN_SAMPLE_COUNT) {
    return {
      isLikelyMonochrome: false,
      sampleCount,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const meanR = sumR / sampleCount;
  const meanG = sumG / sampleCount;
  const meanB = sumB / sampleCount;
  const neutralMean = (meanR + meanG + meanB) / 3;
  const offsetR = neutralMean - meanR;
  const offsetG = neutralMean - meanG;
  const offsetB = neutralMean - meanB;
  const varianceR = Math.max(sumSqR / sampleCount - meanR * meanR, 1);
  const varianceG = Math.max(sumSqG / sampleCount - meanG * meanG, 1);
  const varianceB = Math.max(sumSqB / sampleCount - meanB * meanB, 1);
  const stdR = Math.sqrt(varianceR);
  const stdG = Math.sqrt(varianceG);
  const stdB = Math.sqrt(varianceB);
  let weightedResidual = 0;
  let lowResidualCount = 0;
  let highResidualCount = 0;

  for (let y = top; y < bottom; y += MONO_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += MONO_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma < MONO_LUMA_MIN || luma > MONO_LUMA_MAX) {
        continue;
      }

      const castCorrectedR = clamp(r + offsetR, 0, 255);
      const castCorrectedG = clamp(g + offsetG, 0, 255);
      const castCorrectedB = clamp(b + offsetB, 0, 255);
      const castCorrectedMax = Math.max(castCorrectedR, castCorrectedG, castCorrectedB);
      const castCorrectedMin = Math.min(castCorrectedR, castCorrectedG, castCorrectedB);
      const chroma = castCorrectedMax - castCorrectedMin;
      const normalizedR = (r - meanR) / stdR;
      const normalizedG = (g - meanG) / stdG;
      const normalizedB = (b - meanB) / stdB;
      const residual = (
        Math.abs(normalizedR - normalizedG)
        + Math.abs(normalizedG - normalizedB)
        + Math.abs(normalizedR - normalizedB)
      ) / 3;
      const midtoneWeight = 1 - Math.abs(luma - 127.5) / 127.5;
      const weight = Math.max(0.2, midtoneWeight);

      weightedChroma += chroma * weight;
      weightedResidual += residual * weight;
      weightSum += weight;

      if (chroma <= MONO_LOW_CHROMA_MAX) {
        lowChromaCount += 1;
      }
      if (chroma >= MONO_HIGH_CHROMA_MIN) {
        highChromaCount += 1;
      }
      if (residual <= MONO_LOW_RESIDUAL_MAX) {
        lowResidualCount += 1;
      }
      if (residual >= MONO_HIGH_RESIDUAL_MIN) {
        highResidualCount += 1;
      }
    }
  }

  if (weightSum <= 0) {
    return {
      isLikelyMonochrome: false,
      sampleCount,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const meanChroma = weightedChroma / weightSum;
  const lowChromaRatio = lowChromaCount / sampleCount;
  const highChromaRatio = highChromaCount / sampleCount;
  const meanNormalizedResidual = weightedResidual / weightSum;
  const lowResidualRatio = lowResidualCount / sampleCount;
  const highResidualRatio = highResidualCount / sampleCount;

  return {
    isLikelyMonochrome: (
      meanChroma <= MONO_MEAN_CHROMA_MAX
      && lowChromaRatio >= MONO_LOW_CHROMA_RATIO_MIN
      && highChromaRatio <= MONO_HIGH_CHROMA_RATIO_MAX
    ) || (
      meanNormalizedResidual <= MONO_MEAN_RESIDUAL_MAX
      && lowResidualRatio >= MONO_LOW_RESIDUAL_RATIO_MIN
      && highResidualRatio <= MONO_HIGH_RESIDUAL_RATIO_MAX
      && meanChroma <= 24
      && highChromaRatio <= 0.18
    ),
    sampleCount,
    meanChroma,
    lowChromaRatio,
    highChromaRatio,
    meanNormalizedResidual,
    lowResidualRatio,
    highResidualRatio,
  };
}

export function autoAnalyze(histogram: HistogramData, imageData: ImageData, isColorNegative = false): AutoAnalyzeResult {
  const channelFloors = analyzeChannelFloors(imageData);
  const hasSuggestedCurves = channelFloors.redFloor !== null
    || channelFloors.greenFloor !== null
    || channelFloors.blueFloor !== null;
  const midtone = analyzeMidtoneContrast(histogram);

  return {
    ...analyzeExposure(histogram),
    ...analyzeColorBalance(imageData, isColorNegative),
    contrast: midtone.contrast,
    midtoneBoostPoint: midtone.midtoneBoostPoint,
    suggestedCurves: hasSuggestedCurves ? channelFloors : null,
  };
}
