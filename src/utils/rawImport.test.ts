import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { buildRawInitialSettings, createRawImportProfile, createWorkerDecodeRequestFromRaw, estimateFilmBaseSample, getFilmBaseChannelBalance, getFilmBaseCorrectionSettings, getFilmBaseExposure, RAW_IMPORT_PROFILE_ID, rgbToRgba, rotationFromExifOrientation } from './rawImport';

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

  it('builds a transient profile for the import-time RAW result', () => {
    const settings = createDefaultSettings({ rotation: 90, filmBaseSample: { r: 160, g: 150, b: 140 } });

    expect(createRawImportProfile({
      id: 'generic-color',
      version: 1,
      name: 'Generic Color',
      type: 'color',
      description: 'Balanced color-negative starting point for most consumer scans.',
      defaultSettings: createDefaultSettings(),
    }, settings)).toMatchObject({
      id: RAW_IMPORT_PROFILE_ID,
      name: 'Raw Import Result',
      type: 'color',
      defaultSettings: settings,
    });
  });

  it('derives channel balances from the sampled film base', () => {
    expect(getFilmBaseChannelBalance({ r: 168, g: 151, b: 134 })).toEqual({
      redBalance: (255 - 151) / (255 - 168),
      greenBalance: 1,
      blueBalance: (255 - 151) / (255 - 134),
    });
  });

  it('builds manual film-base correction settings without lifting exposure', () => {
    expect(getFilmBaseCorrectionSettings({ r: 168, g: 151, b: 134 })).toEqual({
      filmBaseSample: null,
      temperature: 0,
      tint: 0,
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

  it('builds a worker decode request from RAW decoder output', () => {
    const rawResult = {
      width: 2,
      height: 1,
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
      color_space: 'Adobe RGB (1998)',
    };

    const request = createWorkerDecodeRequestFromRaw('doc-1', 'scan.nef', 1234, rawResult);

    expect(request).toMatchObject({
      documentId: 'doc-1',
      fileName: 'scan.nef',
      mime: 'image/x-raw-rgba',
      size: 1234,
      rawDimensions: {
        width: 2,
        height: 1,
      },
      declaredColorProfileName: 'Adobe RGB (1998)',
      declaredColorProfileId: 'adobe-rgb',
    });
    expect(Array.from(new Uint8Array(request.buffer))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('expands RGB RAW pixels to RGBA for the worker', () => {
    expect(Array.from(rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1))).toEqual([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);
  });
});
