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

export function analyzeColorBalance(imageData: ImageData): Pick<AutoAnalyzeResult, 'temperature' | 'tint'> {
  const { data, width, height } = imageData;
  if (width <= 0 || height <= 0) {
    return { temperature: null, tint: null };
  }

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
      if (chroma > WB_MAX_CHROMA) {
        continue;
      }

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < WB_LUMA_MIN || luma > WB_LUMA_MAX) {
        continue;
      }

      const neutralityWeight = 1 - chroma / WB_MAX_CHROMA;
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
    return { temperature: null, tint: null };
  }

  const meanR = weightedR / weightSum;
  const meanG = weightedG / weightSum;
  const meanB = weightedB / weightSum;
  const rbAvg = (meanR + meanB) / 2;

  return {
    temperature: clamp(Math.round((meanB - meanR) * 0.4), -100, 100),
    tint: clamp(Math.round((rbAvg - meanG) * 0.4), -100, 100),
  };
}

export function autoAnalyze(histogram: HistogramData, imageData: ImageData): AutoAnalyzeResult {
  return {
    ...analyzeExposure(histogram),
    ...analyzeColorBalance(imageData),
  };
}
