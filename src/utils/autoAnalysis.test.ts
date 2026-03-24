import { describe, expect, it } from 'vitest';
import { analyzeColorBalance, analyzeExposure, autoAnalyze } from './autoAnalysis';
import type { HistogramData } from '../types';

function createHistogramData(): HistogramData {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    l: new Array(256).fill(0),
  };
}

describe('autoAnalysis', () => {
  it('raises exposure for a dark-biased histogram', () => {
    const histogram = createHistogramData();
    histogram.l[24] = 200;
    histogram.l[48] = 100;

    expect(analyzeExposure(histogram).exposure).toBeGreaterThan(0);
  });

  it('cools warm-biased histograms', () => {
    const histogram = createHistogramData();
    histogram.r[180] = 120;
    histogram.g[128] = 120;
    histogram.b[96] = 120;
    histogram.l[128] = 120;

    expect(analyzeColorBalance(histogram).temperature).toBeGreaterThan(0);
  });

  it('returns a complete auto-analysis payload within slider bounds', () => {
    const histogram = createHistogramData();
    histogram.r[110] = 80;
    histogram.g[120] = 80;
    histogram.b[130] = 80;
    histogram.l[118] = 80;

    const result = autoAnalyze(histogram);
    expect(result.exposure).toBeGreaterThanOrEqual(-100);
    expect(result.exposure).toBeLessThanOrEqual(100);
    expect(result.blackPoint).toBeGreaterThanOrEqual(0);
    expect(result.blackPoint).toBeLessThanOrEqual(80);
    expect(result.whitePoint).toBeGreaterThanOrEqual(180);
    expect(result.whitePoint).toBeLessThanOrEqual(255);
    expect(result.temperature).toBeGreaterThanOrEqual(-100);
    expect(result.temperature).toBeLessThanOrEqual(100);
    expect(result.tint).toBeGreaterThanOrEqual(-100);
    expect(result.tint).toBeLessThanOrEqual(100);
  });
});
