import { describe, expect, it } from 'vitest';
import { buildEmptyHistogram } from './imagePipeline';
import {
  analyzeHistogram,
  buildHistogramPath,
  formatClippingFraction,
  histogramPercentile,
} from './histogramAnalysis';

describe('analyzeHistogram', () => {
  it('reports null percentiles and zero clipping for an empty histogram', () => {
    const analysis = analyzeHistogram(buildEmptyHistogram());
    expect(analysis.total).toBe(0);
    expect(analysis.p1).toBeNull();
    expect(analysis.median).toBeNull();
    expect(analysis.p99).toBeNull();
    expect(analysis.shadows.worstChannel).toBe(0);
    expect(analysis.highlights.l).toBe(0);
  });

  it('computes luminance percentiles', () => {
    const histogram = buildEmptyHistogram();
    histogram.l[10] = 1;
    histogram.l[100] = 98;
    histogram.l[240] = 1;
    const analysis = analyzeHistogram(histogram);
    expect(analysis.p1).toBe(10);
    expect(analysis.median).toBe(100);
    expect(analysis.p99).toBe(100);
    expect(histogramPercentile(histogram.l, 1)).toBe(240);
  });

  it('keeps per-channel clipping distinct from luminance clipping', () => {
    // 100 saturated red pixels: R clips at 255 while luminance stays mid-range.
    const histogram = buildEmptyHistogram();
    histogram.r[255] = 100;
    histogram.g[0] = 100;
    histogram.b[0] = 100;
    histogram.l[54] = 100;

    const analysis = analyzeHistogram(histogram);
    expect(analysis.highlights.l).toBe(0);
    expect(analysis.highlights.r).toBe(1);
    expect(analysis.highlights.worstChannel).toBe(1);
    expect(analysis.shadows.l).toBe(0);
    expect(analysis.shadows.worstChannel).toBe(1);
  });

  it('only counts the exact endpoint bins as clipped', () => {
    const histogram = buildEmptyHistogram();
    for (const channel of ['r', 'g', 'b', 'l'] as const) {
      histogram[channel][1] = 50;
      histogram[channel][254] = 50;
    }
    const analysis = analyzeHistogram(histogram);
    expect(analysis.shadows.worstChannel).toBe(0);
    expect(analysis.highlights.worstChannel).toBe(0);
  });
});

describe('formatClippingFraction', () => {
  it('formats small and large fractions', () => {
    expect(formatClippingFraction(0)).toBe('0%');
    expect(formatClippingFraction(0.0004)).toBe('<0.1%');
    expect(formatClippingFraction(0.0123)).toBe('1.2%');
    expect(formatClippingFraction(0.42)).toBe('42%');
  });
});

describe('buildHistogramPath', () => {
  it('returns an empty path when there is nothing to draw', () => {
    expect(buildHistogramPath(new Array(256).fill(0), 0, 80, 'linear')).toBe('');
  });

  it('lifts small counts on the log scale', () => {
    const bins = new Array(256).fill(0);
    bins[0] = 1;
    bins[1] = 1000;
    const heightOfFirstBin = (path: string) => Number(path.split(' L ')[1].split(' ')[1]);
    const linear = heightOfFirstBin(buildHistogramPath(bins, 1000, 80, 'linear'));
    const log = heightOfFirstBin(buildHistogramPath(bins, 1000, 80, 'log'));
    // Lower y is taller in SVG coordinates.
    expect(log).toBeLessThan(linear);
  });
});
