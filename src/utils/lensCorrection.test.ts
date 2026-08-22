import { describe, expect, it } from 'vitest';
import { correctLensDistortionImageData, estimateLensDistortion, mapLensCorrectedPoint, normalizeLensDistortion } from './lensCorrection';

function createGrid(width = 280, height = 200) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const line = x % 42 < 3 || y % 36 < 3;
      const index = (y * width + x) * 4;
      data[index] = line ? 235 : 24;
      data[index + 1] = line ? 235 : 24;
      data[index + 2] = line ? 235 : 24;
      data[index + 3] = 255;
    }
  }
  return new ImageData(data, width, height);
}

describe('lens correction', () => {
  it('keeps the center fixed and automatically trims positive correction', () => {
    const center = mapLensCorrectedPoint(49.5, 39.5, 100, 80, 100);
    const corner = mapLensCorrectedPoint(0, 0, 100, 80, 100);

    expect(center.x).toBeCloseTo(49.5);
    expect(center.y).toBeCloseTo(39.5);
    expect(corner.x).toBeGreaterThanOrEqual(0);
    expect(corner.y).toBeGreaterThanOrEqual(0);
  });

  it('leaves pixels unchanged at zero', () => {
    const image = new ImageData(new Uint8ClampedArray([
      10, 20, 30, 255,
      40, 50, 60, 255,
      70, 80, 90, 255,
      100, 110, 120, 255,
    ]), 2, 2);

    expect(correctLensDistortionImageData(image, 0)).toBe(image);
  });

  it('clamps persisted and manual values to the supported range', () => {
    expect(normalizeLensDistortion(-500)).toBe(-100);
    expect(normalizeLensDistortion(500)).toBe(100);
    expect(normalizeLensDistortion(undefined)).toBe(0);
  });

  it('estimates the correction that straightens a distorted grid', () => {
    const distorted = correctLensDistortionImageData(createGrid(), 58);
    const estimate = estimateLensDistortion(distorted);

    expect(estimate).not.toBeNull();
    expect(estimate!.amount).toBeLessThan(-20);
    expect(estimate!.confidence).toBeGreaterThan(0.25);
  });

  it('keeps an already straight grid close to zero', () => {
    const estimate = estimateLensDistortion(createGrid());

    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.amount)).toBeLessThanOrEqual(4);
  });

  it('refuses to guess when the image has no usable straight edges', () => {
    const flat = new ImageData(new Uint8ClampedArray(160 * 120 * 4).fill(128), 160, 120);
    expect(estimateLensDistortion(flat)).toBeNull();
  });
});
