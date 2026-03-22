import { describe, expect, it } from 'vitest';
import { applyFlatFieldCorrection, processFlatFieldReference } from './flatField';

function createPixels(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = rgb[0];
    pixels[index + 1] = rgb[1];
    pixels[index + 2] = rgb[2];
    pixels[index + 3] = 255;
  }
  return pixels;
}

describe('flatField', () => {
  it('normalizes a uniform reference', () => {
    const pixels = createPixels(4, 4, [200, 150, 100]);
    const result = processFlatFieldReference(pixels, 4, 4, 2);

    expect(Array.from(result)).toEqual([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]);
  });

  it('leaves pixels unchanged for a uniform flat-field', () => {
    const pixels = createPixels(2, 2, [100, 80, 60]);
    const flatField = new Float32Array([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]);

    applyFlatFieldCorrection(pixels, 2, 2, flatField, 2);
    expect(Array.from(pixels.slice(0, 12))).toEqual([100, 80, 60, 255, 100, 80, 60, 255, 100, 80, 60, 255]);
  });

  it('brightens pixels in darker flat-field regions', () => {
    const pixels = createPixels(2, 2, [100, 100, 100]);
    const flatField = new Float32Array([
      1, 1, 1,
      0.5, 0.5, 0.5,
      1, 1, 1,
      0.5, 0.5, 0.5,
    ]);

    applyFlatFieldCorrection(pixels, 2, 2, flatField, 2);
    expect(pixels[4]).toBeGreaterThan(100);
    expect(pixels[0]).toBe(100);
  });

  it('clamps near-zero flat-field values safely', () => {
    const pixels = createPixels(1, 1, [100, 90, 80]);
    const flatField = new Float32Array([0, 0.01, 0.001]);

    applyFlatFieldCorrection(pixels, 1, 1, flatField, 1);
    expect(Number.isFinite(pixels[0])).toBe(true);
    expect(Number.isFinite(pixels[1])).toBe(true);
    expect(Number.isFinite(pixels[2])).toBe(true);
  });
});
