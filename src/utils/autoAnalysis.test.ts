import { describe, expect, it } from 'vitest';
import {
  analyzeColorBalance,
  analyzeExposure,
  analyzeMidtoneContrast,
  analyzeMonochromeSuggestion,
  autoAnalyze,
  calculateWhiteBalanceOffsets,
  createAutoAdjustmentPatch,
  createAutoAnalysisSettings,
} from './autoAnalysis';
import type { HistogramData } from '../types';
import { createDefaultSettings } from '../constants';

function createHistogramData(): HistogramData {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    l: new Array(256).fill(0),
  };
}

function createImageData(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return new ImageData(data, width, height);
}

describe('autoAnalysis', () => {
  it('builds the same neutral analysis pass regardless of existing adjustments', () => {
    const profileDefaults = createDefaultSettings({
      exposure: 8,
      contrast: 24,
      temperature: 6,
      tint: -2,
      redBalance: 1.14,
      blueBalance: 0.88,
    });
    const current = createDefaultSettings({
      exposure: -42,
      contrast: 70,
      temperature: 38,
      tint: 19,
      blackPoint: 34,
      whitePoint: 211,
      rotation: 90,
      levelAngle: 1.4,
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6, aspectRatio: null },
      filmBaseSample: { r: 220, g: 156, b: 102 },
      blackAndWhite: { enabled: true, redMix: 24, greenMix: -8, blueMix: 17, tone: 32 },
    });

    const first = createAutoAnalysisSettings(current, profileDefaults);
    const afterAnotherAuto = createAutoAnalysisSettings({
      ...current,
      exposure: 27,
      contrast: 5,
      temperature: -31,
      tint: -12,
      blackPoint: 4,
      whitePoint: 239,
    }, profileDefaults);

    expect(afterAnotherAuto).toEqual(first);
    expect(first).toMatchObject({
      exposure: 0,
      contrast: 0,
      saturation: 100,
      temperature: 0,
      tint: 0,
      blackPoint: 0,
      whitePoint: 255,
      highlightProtection: 0,
      redBalance: 1.14,
      blueBalance: 0.88,
      rotation: 90,
      levelAngle: 1.4,
      crop: current.crop,
      filmBaseSample: current.filmBaseSample,
      blackAndWhite: { ...profileDefaults.blackAndWhite, enabled: true },
    });
  });

  it('resets Auto-owned fields to the profile baseline when no correction is suggested', () => {
    const profileDefaults = createDefaultSettings({ contrast: 18, temperature: 4, tint: -2 });
    const patch = createAutoAdjustmentPatch(profileDefaults, {
      exposure: 3,
      blackPoint: 5,
      whitePoint: 244,
      temperature: null,
      tint: null,
      contrast: null,
      midtoneBoostPoint: null,
      suggestedCurves: null,
    });

    expect(patch).toEqual({
      exposure: 3,
      blackPoint: 5,
      whitePoint: 244,
      temperature: 4,
      tint: -2,
      contrast: 18,
      curves: profileDefaults.curves,
    });
  });

  it('raises exposure for a dark-biased histogram', () => {
    const histogram = createHistogramData();
    histogram.l[24] = 200;
    histogram.l[48] = 100;

    expect(analyzeExposure(histogram).exposure).toBe(30);
  });

  it('coordinates density and tone range without a second midtone lift', () => {
    const histogram = createHistogramData();
    histogram.l[32] = 20;
    histogram.l[96] = 960;
    histogram.l[216] = 20;

    const exposure = analyzeExposure(histogram);
    const midtone = analyzeMidtoneContrast(histogram);

    expect(exposure.exposure).toBe(2);
    expect(exposure.blackPoint).toBe(8);
    expect(exposure.whitePoint).toBe(239);
    expect(midtone.contrast).toBeGreaterThan(0);
    expect(midtone.midtoneBoostPoint).toBeNull();
  });

  it('leaves a balanced density range near the profile baseline', () => {
    const histogram = createHistogramData();
    histogram.l[20] = 20;
    histogram.l[128] = 960;
    histogram.l[235] = 20;

    expect(analyzeExposure(histogram)).toEqual({
      exposure: 0,
      blackPoint: 5,
      whitePoint: 245,
    });
  });

  it('warms blue-biased neutral candidates', () => {
    const imageData = createImageData(80, 80, () => [118, 122, 148]);

    expect(analyzeColorBalance(imageData).temperature).toBeGreaterThan(0);
  });

  it('solves the additive temperature and tint controls for a neutral sample', () => {
    expect(calculateWhiteBalanceOffsets(100, 90, 140)).toEqual({
      temperature: 20,
      tint: 30,
    });
  });

  it('accepts a plausible neutral with a cast that the old absolute-chroma cutoff rejected', () => {
    const imageData = createImageData(80, 80, () => [82, 110, 142]);

    expect(analyzeColorBalance(imageData)).toEqual({
      temperature: 30,
      tint: 2,
    });
  });

  it('does not let blue-dominant scene color drive the frame colder', () => {
    const imageData = createImageData(96, 96, (x, y) => {
      if (x > 28 && x < 68 && y > 28 && y < 68) {
        return [130, 132, 138];
      }

      return [96, 140, 220];
    });

    const result = analyzeColorBalance(imageData);
    expect(result.temperature).not.toBeNull();
    expect(result.temperature).toBeGreaterThanOrEqual(0);
  });

  it('returns no white-balance adjustment when there are no reliable neutral candidates', () => {
    const imageData = createImageData(80, 80, () => [40, 100, 240]);

    expect(analyzeColorBalance(imageData)).toEqual({
      temperature: null,
      tint: null,
    });
  });

  it('returns a complete auto-analysis payload with nullable white balance', () => {
    const histogram = createHistogramData();
    histogram.l[118] = 80;
    histogram.l[126] = 120;

    const imageData = createImageData(80, 80, () => [126, 129, 140]);
    const result = autoAnalyze(histogram, imageData);
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

  it('suggests black and white conversion for a near-neutral monochrome scan', () => {
    const imageData = createImageData(120, 120, (x, y) => {
      const base = 40 + ((x + y) % 80);
      return [base, base + 2, base + 4];
    });

    const result = analyzeMonochromeSuggestion(imageData);
    expect(result.isLikelyMonochrome).toBe(true);
    expect(result.meanChroma).toBeLessThanOrEqual(11);
    expect(result.meanNormalizedResidual).toBeLessThanOrEqual(0.2);
  });

  it('still suggests black and white conversion when the monochrome scan has a strong global tint', () => {
    const imageData = createImageData(120, 120, (x, y) => {
      const base = 36 + ((x + y) % 96);
      return [base + 20, base + 2, base + 32];
    });

    const result = analyzeMonochromeSuggestion(imageData);
    expect(result.isLikelyMonochrome).toBe(true);
    expect(result.meanNormalizedResidual).toBeLessThanOrEqual(0.2);
  });

  it('does not suggest black and white conversion for a muted but clearly color image', () => {
    const imageData = createImageData(120, 120, (x, y) => {
      if (x > 36 && x < 84 && y > 30 && y < 90) {
        return [122, 126, 132];
      }
      if (x < 40) {
        return [88, 132, 176];
      }
      if (y > 82) {
        return [156, 112, 98];
      }

      return [116, 148, 98];
    });

    const result = analyzeMonochromeSuggestion(imageData);
    expect(result.isLikelyMonochrome).toBe(false);
    expect(result.highChromaRatio).toBeGreaterThan(0.12);
  });
});
