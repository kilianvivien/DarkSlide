import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { buildRawInitialSettings, estimateFilmBaseSample, getFilmBaseChannelBalance, getFilmBaseExposure, rotationFromExifOrientation } from './rawImport';

function createRawRgb(width: number, height: number, border: [number, number, number], center: [number, number, number]) {
  const data = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const pixel = x < 8 || y < 8 || x >= width - 8 || y >= height - 8 ? border : center;
      data[index] = pixel[0];
      data[index + 1] = pixel[1];
      data[index + 2] = pixel[2];
    }
  }

  return data;
}

describe('rawImport', () => {
  it('estimates the film base from bright border pixels', () => {
    const rgb = createRawRgb(64, 48, [168, 151, 134], [40, 60, 120]);

    expect(estimateFilmBaseSample(rgb, 64, 48)).toEqual({
      r: 168,
      g: 151,
      b: 134,
    });
  });

  it('converts EXIF orientation values to canvas rotations', () => {
    expect(rotationFromExifOrientation(6)).toBe(90);
    expect(rotationFromExifOrientation(8)).toBe(270);
    expect(rotationFromExifOrientation(3)).toBe(180);
    expect(rotationFromExifOrientation(1)).toBe(0);
  });

  it('builds RAW startup settings with film-base and rotation defaults', () => {
    const base = createDefaultSettings();
    const rgb = createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]);

    expect(buildRawInitialSettings(base, rgb, 64, 48, 6)).toMatchObject({
      rotation: 90,
      filmBaseSample: {
        r: 160,
        g: 150,
        b: 140,
      },
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
    });
  });

  it('derives channel balances from the sampled film base', () => {
    expect(getFilmBaseChannelBalance({ r: 168, g: 151, b: 134 })).toEqual({
      redBalance: (255 - 151) / (255 - 168),
      greenBalance: 1,
      blueBalance: (255 - 151) / (255 - 134),
    });
  });

  it('derives a white-reference exposure from the sampled film base', () => {
    expect(getFilmBaseExposure({ r: 168, g: 151, b: 134 })).toBe(
      Math.round(50 * Math.log2((245 / 255) / ((255 - 151) / 255))),
    );
  });
});
