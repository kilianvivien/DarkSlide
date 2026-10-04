import type { HistogramData } from '../types';

export type HistogramChannel = 'l' | 'r' | 'g' | 'b';

export interface ClippingStats {
  /** Fraction of pixels whose value sits exactly at the endpoint bin. */
  r: number;
  g: number;
  b: number;
  l: number;
  /** Largest per-channel fraction. Luminance can read 0 while a channel clips. */
  worstChannel: number;
}

export interface HistogramAnalysis {
  total: number;
  /** Luminance percentiles; null when the histogram is empty. */
  p1: number | null;
  median: number | null;
  p99: number | null;
  shadows: ClippingStats;
  highlights: ClippingStats;
}

/** Above this share of pixels, an endpoint is flagged as clipped. */
export const CLIPPING_WARNING_FRACTION = 0.001;

function sum(bins: readonly number[]) {
  let total = 0;
  for (const value of bins) total += value;
  return total;
}

export function histogramPercentile(bins: readonly number[], fraction: number): number | null {
  const total = sum(bins);
  if (total <= 0) return null;
  const target = total * fraction;
  let seen = 0;
  for (let index = 0; index < bins.length; index += 1) {
    seen += bins[index];
    if (seen >= target && bins[index] > 0) return index;
  }
  return bins.length - 1;
}

function clippingAt(data: HistogramData, bin: number, total: number): ClippingStats {
  const fraction = (channel: HistogramChannel) => (total > 0 ? (data[channel][bin] ?? 0) / total : 0);
  const r = fraction('r');
  const g = fraction('g');
  const b = fraction('b');
  return { r, g, b, l: fraction('l'), worstChannel: Math.max(r, g, b) };
}

/**
 * Summarizes an output histogram. Clipping counts only the exact endpoint
 * bins (0 and 255) and is reported per channel: a pixel can clip in one RGB
 * channel while its luminance stays inside the range.
 */
export function analyzeHistogram(data: HistogramData): HistogramAnalysis {
  const total = sum(data.l);
  return {
    total,
    p1: histogramPercentile(data.l, 0.01),
    median: histogramPercentile(data.l, 0.5),
    p99: histogramPercentile(data.l, 0.99),
    shadows: clippingAt(data, 0, total),
    highlights: clippingAt(data, 255, total),
  };
}

export function formatClippingFraction(fraction: number) {
  if (fraction <= 0) return '0%';
  const percent = fraction * 100;
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

export function buildHistogramPath(
  bins: readonly number[],
  max: number,
  height: number,
  scale: 'linear' | 'log',
) {
  if (max <= 0) return '';
  const denominator = scale === 'log' ? Math.log1p(max) : max;
  let path = `M 0 ${height}`;
  for (let index = 0; index < 256; index += 1) {
    const value = bins[index] ?? 0;
    const normalized = scale === 'log' ? Math.log1p(value) / denominator : value / denominator;
    path += ` L ${index} ${height - normalized * height}`;
  }
  return `${path} L 256 ${height} Z`;
}
