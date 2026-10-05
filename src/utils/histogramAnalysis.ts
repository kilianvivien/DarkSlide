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

/**
 * Tallest bin to scale the chart against, ignoring the endpoint bins. Clipped
 * pixels pile up at 0 and 255 and would otherwise flatten the rest of the
 * chart; the clipping readouts report them instead.
 */
export function histogramDisplayPeak(data: HistogramData, channels: Iterable<HistogramChannel>) {
  let inner = 0;
  let all = 0;
  for (const channel of channels) {
    const bins = data[channel];
    for (let index = 0; index < bins.length; index += 1) {
      const value = bins[index] ?? 0;
      if (value > all) all = value;
      if (index > 0 && index < 255 && value > inner) inner = value;
    }
  }
  return inner > 0 ? inner : all;
}

const SMOOTHING_KERNEL = [1, 4, 6, 4, 1];

/**
 * Builds a filled area and its outline for one channel. Bins are lightly
 * smoothed so 8-bit quantization gaps don't show as comb teeth, values above
 * the peak are clamped to the top, and the outline is a monotone curve
 * through bin centres.
 */
export function buildHistogramShape(
  bins: readonly number[],
  peak: number,
  height: number,
  scale: 'linear' | 'log',
) {
  if (peak <= 0) return { area: '', line: '' };
  const denominator = scale === 'log' ? Math.log1p(peak) : peak;
  const points: Array<[number, number]> = [];
  for (let index = 0; index < 256; index += 1) {
    let weighted = 0;
    let weight = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighbour = index + offset;
      if (neighbour < 0 || neighbour > 255) continue;
      // Endpoint bins hold clipped pixels; don't smear them into their neighbours.
      if ((neighbour === 0 || neighbour === 255) && neighbour !== index) continue;
      const k = SMOOTHING_KERNEL[offset + 2];
      weighted += (bins[neighbour] ?? 0) * k;
      weight += k;
    }
    const value = weight > 0 ? weighted / weight : 0;
    const normalized = Math.min(1, scale === 'log' ? Math.log1p(value) / denominator : value / denominator);
    points.push([index + 0.5, height - normalized * height]);
  }

  const format = (value: number) => Number(value.toFixed(2));
  let line = `M 0 ${format(points[0][1])} L ${points[0][0]} ${format(points[0][1])}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const midX = (x0 + x1) / 2;
    line += ` C ${midX} ${format(y0)} ${midX} ${format(y1)} ${x1} ${format(y1)}`;
  }
  line += ` L 256 ${format(points[255][1])}`;
  const area = `M 0 ${height} L ${line.slice(2)} L 256 ${height} Z`;
  return { area, line };
}
