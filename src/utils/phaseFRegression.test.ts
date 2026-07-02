import { describe, expect, it } from 'vitest';
import { createDefaultSettings, DENSITY_TO_POSITIVE_GAMMA } from '../constants';
import { deltaE, srgbToLab } from './colorScience';
import { encodeTiff, FloatExportRaster } from './exportEncoder';
import { processImageData } from './imagePipeline';

function srgbEncode(value: number) {
  if (value <= 0.0031308) {
    return value * 12.92;
  }
  return 1.055 * (value ** (1 / 2.4)) - 0.055;
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24);
}

function getTiffTagValue(bytes: Uint8Array, tag: number) {
  const ifdOffset = readUint32Le(bytes, 4);
  const count = readUint16Le(bytes, ifdOffset);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (readUint16Le(bytes, entryOffset) === tag) {
      return readUint32Le(bytes, entryOffset + 8);
    }
  }
  return null;
}

function positiveToSyntheticNegativeChannel(value: number) {
  const positive = value / 255;
  const transmittance = (1 - positive) ** DENSITY_TO_POSITIVE_GAMMA;
  return Math.round(srgbEncode(transmittance) * 255);
}

describe('Phase F regression safety net', () => {
  it('round-trips a synthetic density-model negative within DeltaE tolerance', () => {
    const positives: Array<[number, number, number]> = [
      [32, 48, 64],
      [96, 128, 160],
      [180, 132, 84],
      [225, 218, 206],
    ];
    const data = new Uint8ClampedArray(positives.length * 4);
    positives.forEach((positive, index) => {
      data[index * 4] = positiveToSyntheticNegativeChannel(positive[0]);
      data[index * 4 + 1] = positiveToSyntheticNegativeChannel(positive[1]);
      data[index * 4 + 2] = positiveToSyntheticNegativeChannel(positive[2]);
      data[index * 4 + 3] = 255;
    });

    const imageData = new ImageData(data, positives.length, 1);
    processImageData(
      imageData,
      createDefaultSettings({
        blackPoint: 0,
        whitePoint: 255,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        highlightProtection: 0,
      }),
      true,
      'processed',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      0,
      0,
      'srgb',
      'srgb',
      null,
      'negative',
      null,
      null,
      [1, 1, 1],
      null,
      null,
    );

    const deltas = positives.map((positive, index) => {
      const actual: [number, number, number] = [
        imageData.data[index * 4],
        imageData.data[index * 4 + 1],
        imageData.data[index * 4 + 2],
      ];
      return deltaE(srgbToLab(...positive), srgbToLab(...actual));
    });

    expect(Math.max(...deltas)).toBeLessThanOrEqual(2.5);
  });

  it('preserves every level of a 16-bit TIFF ramp', () => {
    const width = 65_536;
    const data = new Float32Array(width * 3);
    for (let index = 0; index < width; index += 1) {
      const value = index / 65_535;
      data[index * 3] = value;
      data[index * 3 + 1] = value;
      data[index * 3 + 2] = value;
    }
    const raster: FloatExportRaster = { width, height: 1, data };
    const bytes = encodeTiff(raster, 16);
    const stripOffset = getTiffTagValue(bytes, 273);

    expect(stripOffset).not.toBeNull();
    for (let index = 0; index < width; index += 1) {
      expect(readUint16Le(bytes, stripOffset! + index * 6)).toBe(index);
    }
  });
});
