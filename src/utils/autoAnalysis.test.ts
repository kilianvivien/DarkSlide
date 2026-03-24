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
  it('raises exposure for a dark-biased histogram', () => {
    const histogram = createHistogramData();
    histogram.l[24] = 200;
    histogram.l[48] = 100;

    expect(analyzeExposure(histogram).exposure).toBeGreaterThan(0);
  });

  it('warms blue-biased neutral candidates', () => {
    const imageData = createImageData(80, 80, () => [118, 122, 148]);

    expect(analyzeColorBalance(imageData).temperature).toBeGreaterThan(0);
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
});
