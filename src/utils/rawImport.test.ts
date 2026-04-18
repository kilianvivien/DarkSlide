import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { processImageData } from './imagePipeline';
import { buildRawInitialSettings, createRawImportProfile, createWorkerDecodeRequestFromRaw, estimateFilmBaseSample, estimateFilmBaseSampleFromRgba, getFilmBaseChannelBalance, getFilmBaseCorrectionSettings, getFilmBaseExposure, RAW_IMPORT_PROFILE_ID, rgbToRgba, rotationFromExifOrientation } from './rawImport';

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

function setRgbPixel(data: Uint8Array, width: number, x: number, y: number, pixel: [number, number, number]) {
  const index = (y * width + x) * 3;
  data[index] = pixel[0];
  data[index + 1] = pixel[1];
  data[index + 2] = pixel[2];
}

function createRawNegativeScene(width: number, height: number, border: [number, number, number]) {
  const data = createRawRgb(width, height, border, [142, 136, 98]);
  const usableWidth = Math.max(1, width - 16);
  const usableHeight = Math.max(1, height - 16);

  for (let y = 8; y < height - 8; y += 1) {
    for (let x = 8; x < width - 8; x += 1) {
      const nx = (x - 8) / usableWidth;
      const ny = (y - 8) / usableHeight;
      const shadowBias = (1 - nx) * 8 + (1 - ny) * 5;
      const pixel: [number, number, number] = [
        Math.max(20, Math.min(255, Math.round(174 - nx * 56 - ny * 20 + shadowBias))),
        Math.max(20, Math.min(255, Math.round(168 - nx * 46 - (1 - ny) * 18 + shadowBias * 0.8))),
        Math.max(10, Math.min(255, Math.round(118 - nx * 36 + ny * 12))),
      ];
      setRgbPixel(data, width, x, y, pixel);
    }
  }

  return data;
}

function sumBins(bins: number[]) {
  return bins.reduce((sum, value) => sum + value, 0);
}

function meanInnerChannels(imageData: ImageData, margin = 8) {
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = margin; y < imageData.height - margin; y += 1) {
    for (let x = margin; x < imageData.width - margin; x += 1) {
      const index = (y * imageData.width + x) * 4;
      totalR += imageData.data[index];
      totalG += imageData.data[index + 1];
      totalB += imageData.data[index + 2];
      count += 1;
    }
  }

  return {
    r: totalR / count,
    g: totalG / count,
    b: totalB / count,
  };
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

  it('estimates the film base from RGBA border pixels too', () => {
    const rgba = rgbToRgba(createRawRgb(64, 48, [168, 151, 134], [40, 60, 120]), 64, 48);

    expect(estimateFilmBaseSampleFromRgba(rgba, 64, 48)).toEqual({
      r: 168,
      g: 151,
      b: 134,
    });
  });

  it('ignores bright border outliers when estimating the film base', () => {
    const clean = createRawRgb(128, 96, [168, 151, 134], [40, 60, 120]);
    const withOutlier = clean.slice();

    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        setRgbPixel(withOutlier, 128, x, y, [255, 255, 255]);
      }
    }

    expect(estimateFilmBaseSample(clean, 128, 96)).toEqual({
      r: 168,
      g: 151,
      b: 134,
    });
    expect(estimateFilmBaseSample(withOutlier, 128, 96)).toEqual({
      r: 168,
      g: 151,
      b: 134,
    });
  });

  it('still finds the bright film base when much of the border is dark carrier', () => {
    const rgb = createRawRgb(128, 96, [168, 151, 134], [40, 60, 120]);

    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        setRgbPixel(rgb, 128, x, y, [8, 8, 8]);
        setRgbPixel(rgb, 128, 127 - x, y, [8, 8, 8]);
      }
    }

    expect(estimateFilmBaseSample(rgb, 128, 96)).toEqual({
      r: 168,
      g: 151,
      b: 134,
    });
  });

  it('returns null when the image is too small for reliable border estimation', () => {
    const rgb = createRawRgb(7, 7, [168, 151, 134], [40, 60, 120]);

    expect(estimateFilmBaseSample(rgb, 7, 7)).toBeNull();
  });

  it('converts EXIF orientation values to canvas rotations', () => {
    expect(rotationFromExifOrientation(6)).toBe(90);
    expect(rotationFromExifOrientation(8)).toBe(270);
    expect(rotationFromExifOrientation(3)).toBe(180);
    expect(rotationFromExifOrientation(1)).toBe(0);
  });

  it('builds RAW startup settings with derived balance and rotation defaults', () => {
    const base = createDefaultSettings();
    const rgb = createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]);

    expect(buildRawInitialSettings(base, rgb, 64, 48, 6)).toMatchObject({
      rotation: 90,
      filmBaseSample: null,
      exposure: base.exposure,
      redBalance: (255 - 150) / (255 - 160),
      greenBalance: 1,
      blueBalance: (255 - 150) / (255 - 140),
    });
  });

  it('keeps stock-specific tuning while layering border-derived balance correction on top', () => {
    const base = createDefaultSettings({
      exposure: 6,
      temperature: 8,
      tint: -2,
      redBalance: 1.16,
      blueBalance: 0.86,
      filmBaseSample: { r: 200, g: 180, b: 150 },
    });
    const rgb = createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]);

    expect(buildRawInitialSettings(base, rgb, 64, 48, 6)).toMatchObject({
      rotation: 90,
      filmBaseSample: null,
      exposure: 6,
      temperature: 8,
      tint: -2,
      redBalance: 1.16 * ((255 - 150) / (255 - 160)),
      greenBalance: 1,
      blueBalance: 0.86 * ((255 - 150) / (255 - 140)),
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

  it('uses RAW startup settings that avoid subtractive film-base startup while keeping a controlled channel balance', () => {
    const width = 80;
    const height = 56;
    const estimatedFilmBaseSample = { r: 76, g: 73, b: 68 } as const;
    const rgb = createRawNegativeScene(width, height, [estimatedFilmBaseSample.r, estimatedFilmBaseSample.g, estimatedFilmBaseSample.b]);
    const baseSettings = createDefaultSettings({ contrast: 15, redBalance: 1.12, blueBalance: 0.9, highlightProtection: 26 });
    const startupSettings = buildRawInitialSettings(baseSettings, rgb, width, height, 1, estimatedFilmBaseSample);
    const legacySettings = createDefaultSettings({
      contrast: 15,
      redBalance: 1.12,
      blueBalance: 0.9,
      highlightProtection: 26,
      filmBaseSample: estimatedFilmBaseSample,
    });
    const startupImage = new ImageData(new Uint8ClampedArray(rgbToRgba(rgb, width, height)), width, height);
    const legacyImage = new ImageData(new Uint8ClampedArray(rgbToRgba(rgb, width, height)), width, height);

    const startupHistogram = processImageData(startupImage, startupSettings, true, 'processed');
    const legacyHistogram = processImageData(legacyImage, legacySettings, true, 'processed');
    const startupMeans = meanInnerChannels(startupImage);

    expect(startupSettings.exposure).toBe(baseSettings.exposure);
    expect(startupSettings.redBalance).toBeCloseTo(1.12 * ((255 - 73) / (255 - 76)));
    expect(startupSettings.blueBalance).toBeCloseTo(0.9 * ((255 - 73) / (255 - 68)));
    expect(sumBins(startupHistogram.l.slice(240))).toBeLessThanOrEqual(sumBins(legacyHistogram.l.slice(240)));
    expect(startupMeans.b / Math.max(startupMeans.r, 1)).toBeLessThan(1.35);
    expect(startupMeans.b / Math.max(startupMeans.g, 1)).toBeLessThan(1.35);
  });

  it('builds a worker decode request from RAW decoder output', () => {
    const rawResult = {
      width: 64,
      height: 48,
      data: createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]),
      color_space: 'Adobe RGB (1998)',
    };

    const request = createWorkerDecodeRequestFromRaw('doc-1', 'scan.nef', 1234, rawResult);

    expect(request).toMatchObject({
      documentId: 'doc-1',
      fileName: 'scan.nef',
      mime: 'image/x-raw-rgba',
      size: 1234,
      rawDimensions: {
        width: 64,
        height: 48,
      },
      declaredColorProfileName: 'Adobe RGB (1998)',
      declaredColorProfileId: 'adobe-rgb',
      precomputedFilmBaseSample: {
        r: 160,
        g: 150,
        b: 140,
      },
    });
    expect(Array.from(new Uint8Array(request.buffer).slice(0, 8))).toEqual([160, 150, 140, 255, 160, 150, 140, 255]);
  });

  it('expands RGB RAW pixels to RGBA for the worker', () => {
    expect(Array.from(rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1))).toEqual([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);
  });
});
