import type { HistogramData } from '../types';
import { clamp } from './math';

export interface AutoAnalysisResult {
  exposure: number;
  blackPoint: number;
  whitePoint: number;
  temperature: number;
  tint: number;
}

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

function weightedMean(bins: number[], start = 0, end = 255) {
  let weighted = 0;
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    weighted += bins[index] * index;
    count += bins[index];
  }
  return count > 0 ? weighted / count : 127.5;
}

export function analyzeExposure(histogram: HistogramData): Pick<AutoAnalysisResult, 'exposure' | 'blackPoint' | 'whitePoint'> {
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

export function analyzeColorBalance(histogram: HistogramData): Pick<AutoAnalysisResult, 'temperature' | 'tint'> {
  const meanR = weightedMean(histogram.r, 64, 192);
  const meanG = weightedMean(histogram.g, 64, 192);
  const meanB = weightedMean(histogram.b, 64, 192);
  const meanL = weightedMean(histogram.l, 64, 192);

  const tempBias = ((meanR - meanB) / 255) * 100;
  const tintBias = ((meanG - meanL) / 255) * 200;

  return {
    temperature: clamp(Math.round(tempBias), -100, 100),
    tint: clamp(Math.round(-tintBias), -100, 100),
  };
}

export function autoAnalyze(histogram: HistogramData): AutoAnalysisResult {
  return {
    ...analyzeExposure(histogram),
    ...analyzeColorBalance(histogram),
  };
}
