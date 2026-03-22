import { describe, expect, it } from 'vitest';
import { estimateFlare } from './flareEstimation';

function createSolidImage(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = rgb[0];
    pixels[index + 1] = rgb[1];
    pixels[index + 2] = rgb[2];
    pixels[index + 3] = 255;
  }

  return pixels;
}

describe('estimateFlare', () => {
  it('returns the same values for a uniform image', () => {
    const pixels = createSolidImage(16, 16, [100, 80, 60]);
    expect(estimateFlare(pixels, 16, 16)).toEqual([100, 80, 60]);
  });

  it('tracks the dark floor near the 0.5 percentile', () => {
    const pixels = createSolidImage(10, 10, [200, 180, 160]);

    for (let pixel = 0; pixel < 1; pixel += 1) {
      const offset = pixel * 4;
      pixels[offset] = 10;
      pixels[offset + 1] = 5;
      pixels[offset + 2] = 3;
    }

    expect(estimateFlare(pixels, 10, 10)).toEqual([10, 5, 3]);
  });

  it('returns zeros for a black image', () => {
    const pixels = createSolidImage(8, 8, [0, 0, 0]);
    expect(estimateFlare(pixels, 8, 8)).toEqual([0, 0, 0]);
  });
});
