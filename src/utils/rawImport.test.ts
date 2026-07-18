import { describe, expect, it } from 'vitest';
import { createDefaultSettings, FILM_BASE_CONFIDENCE } from '../constants';
import { processImageData } from './imagePipeline';
import { buildRawInitialSettings, createRawImportProfile, createWorkerDecodeRequestFromRaw, estimateFilmBase, estimateFilmBase16, estimateFilmBaseSample, estimateFilmBaseSampleFromRgba, getFilmBaseChannelBalance, getFilmBaseCorrectionSettings, getFilmBaseExposure, mirrorFromExifOrientation, RAW_IMPORT_PROFILE_ID, rgb16ToRgba8, rgbToRgba, rotationFromExifOrientation } from './rawImport';

// Build an RGB Uint8Array by evaluating a per-pixel function. Pixel coordinates
// are passed so fixtures can paint edge bands, rebate strips, etc.
function buildRgb(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const [r, g, b] = pixel(x, y);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
    }
  }
  return data;
}

function edgeDistance(x: number, y: number, width: number, height: number) {
  return Math.min(x, y, width - 1 - x, height - 1 - y);
}

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

  it('maps mirrored EXIF orientations to a baked horizontal flip plus rotation', () => {
    expect(mirrorFromExifOrientation(2)).toBe(true);
    expect(mirrorFromExifOrientation(4)).toBe(true);
    expect(mirrorFromExifOrientation(5)).toBe(true);
    expect(mirrorFromExifOrientation(7)).toBe(true);
    expect(mirrorFromExifOrientation(1)).toBe(false);
    expect(mirrorFromExifOrientation(6)).toBe(false);
    expect(mirrorFromExifOrientation(null)).toBe(false);

    expect(rotationFromExifOrientation(2)).toBe(0);
    expect(rotationFromExifOrientation(4)).toBe(180);
    expect(rotationFromExifOrientation(5)).toBe(270);
    expect(rotationFromExifOrientation(7)).toBe(90);
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

  it('starts from neutral channel balances when the film-base estimate is low confidence', () => {
    const base = createDefaultSettings({ redBalance: 1.12, blueBalance: 0.9 });
    const rgb = createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]);
    const lowConfidence = {
      sample: { r: 40, g: 44, b: 30 },
      source: 'low-confidence' as const,
      confidence: 0,
      rejectedCandidates: 3,
      clamped: true,
    };

    const settings = buildRawInitialSettings(base, rgb, 64, 48, 1, lowConfidence);
    // No base-derived tilt: the distrusted estimate is not allowed to seed WB.
    expect(settings.redBalance).toBeCloseTo(1.12);
    expect(settings.greenBalance).toBeCloseTo(1);
    expect(settings.blueBalance).toBeCloseTo(0.9);
  });

  it('builds a worker decode request from RAW decoder output', () => {
    const rawResult = {
      width: 64,
      height: 48,
      data: Uint16Array.from(createRawRgb(64, 48, [160, 150, 140], [40, 60, 120]), (value) => value * 257),
      color_space: 'Adobe RGB (1998)',
      bitDepth: 16 as const,
      transfer: 'srgb' as const,
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
      highDepthRawBitDepth: 16,
      highDepthRawTransfer: 'srgb',
      declaredColorProfileName: 'Adobe RGB (1998)',
      declaredColorProfileId: 'adobe-rgb',
      precomputedFilmBaseSample: {
        r: 160,
        g: 150,
        b: 140,
      },
    });
    expect(Array.from(new Uint8Array(request.buffer).slice(0, 8))).toEqual([160, 150, 140, 255, 160, 150, 140, 255]);
    expect(Array.from(new Uint16Array(request.highDepthRawBuffer!).slice(0, 6))).toEqual([41120, 38550, 35980, 41120, 38550, 35980]);
  });

  it('expands RGB RAW pixels to RGBA for the worker', () => {
    expect(Array.from(rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1))).toEqual([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);
  });

  it('downconverts RGB16 RAW pixels to an 8-bit RGBA preview', () => {
    expect(Array.from(rgb16ToRgba8(new Uint16Array([0, 32_768, 65_535]), 1, 1))).toEqual([
      0, 128, 255, 255,
    ]);
  });
});

describe('estimateFilmBase (confidence-scored)', () => {
  it('reports high confidence and outer-border provenance for a clean bright border', () => {
    const border: [number, number, number] = [168, 151, 134];
    const rgb = buildRgb(160, 120, (x, y) => (
      edgeDistance(x, y, 160, 120) < 2 ? border : [40, 60, 120]
    ));

    const estimate = estimateFilmBase(rgb, 160, 120, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('outer-border');
    expect(estimate!.confidence).toBeGreaterThan(FILM_BASE_CONFIDENCE.accept);
    expect(estimate!.sample.r).toBeCloseTo(border[0], -1);
    expect(estimate!.sample.g).toBeCloseTo(border[1], -1);
    expect(estimate!.sample.b).toBeCloseTo(border[2], -1);
  });

  it('finds the bright rebate strip when the outer edge is dark holder (Img2322 shape)', () => {
    const rebate: [number, number, number] = [150, 210, 180];
    const rgb = buildRgb(200, 150, (x, y) => {
      const distance = edgeDistance(x, y, 200, 150);
      if (distance < 3) return [28, 28, 28];   // dark holder at the literal edge
      if (distance < 10) return rebate;         // clear rebate strip inset ~5%
      return [46, 40, 30];                      // dense image content
    });

    const estimate = estimateFilmBase(rgb, 200, 150, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('frame-rebate');
    expect(estimate!.sample.r).toBeCloseTo(rebate[0], -1);
    expect(estimate!.sample.g).toBeCloseTo(rebate[1], -1);
    expect(estimate!.sample.b).toBeCloseTo(rebate[2], -1);
  });

  it('falls back to a bright-percentile sample with zero confidence for a fully dark frame', () => {
    const rgb = buildRgb(160, 120, () => [22, 20, 24]);

    const estimate = estimateFilmBase(rgb, 160, 120, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('low-confidence');
    expect(estimate!.confidence).toBe(0);
    // The conservative sample never latches onto a dark population as a hard base.
    expect(estimate!.sample.r).toBeGreaterThanOrEqual(1);
  });

  it('picks the film cluster instead of averaging a mixed holder/film border', () => {
    const film: [number, number, number] = [150, 120, 90];
    const rgb = buildRgb(200, 150, (x, y) => {
      if (edgeDistance(x, y, 200, 150) >= 10) return [46, 40, 30];
      return x < 100 ? film : [8, 8, 8]; // left half clear film, right half black holder
    });

    const estimate = estimateFilmBase(rgb, 200, 150, 3);
    expect(estimate).not.toBeNull();
    // Sample tracks the film cluster, not the midpoint between film and black.
    expect(estimate!.sample.r).toBeCloseTo(film[0], -1);
    expect(estimate!.sample.g).toBeCloseTo(film[1], -1);
    expect(estimate!.sample.b).toBeCloseTo(film[2], -1);
  });

  it('produces the same sample for a horizontally mirrored frame (orientation-invariant)', () => {
    const film: [number, number, number] = [150, 120, 90];
    const pixel = (x: number, y: number): [number, number, number] => {
      if (edgeDistance(x, y, 200, 150) >= 10) return [46, 40, 30];
      return x < 100 ? film : [8, 8, 8];
    };
    const rgb = buildRgb(200, 150, pixel);
    const mirrored = buildRgb(200, 150, (x, y) => pixel(200 - 1 - x, y));

    const original = estimateFilmBase(rgb, 200, 150, 3);
    const flipped = estimateFilmBase(mirrored, 200, 150, 3);
    expect(original).not.toBeNull();
    expect(flipped).not.toBeNull();
    expect(flipped!.sample).toEqual(original!.sample);
  });

  it('estimates the base from a 16-bit RGB buffer (high-depth analysis path)', () => {
    // 41120 = 160 * 257, which maps to exactly 160 in the 0..255 analysis space.
    const border16: [number, number, number] = [160 * 257, 151 * 257, 134 * 257];
    const rgb16 = new Uint16Array(160 * 120 * 3);
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 160; x += 1) {
        const index = (y * 160 + x) * 3;
        const clear = edgeDistance(x, y, 160, 120) < 2;
        rgb16[index] = clear ? border16[0] : 40 * 257;
        rgb16[index + 1] = clear ? border16[1] : 60 * 257;
        rgb16[index + 2] = clear ? border16[2] : 120 * 257;
      }
    }

    const estimate = estimateFilmBase16(rgb16, 160, 120);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('outer-border');
    expect(estimate!.sample).toEqual({ r: 160, g: 151, b: 134 });
  });

  it('estimates a borderless scan from the brightest low-texture in-frame patch', () => {
    const patch: [number, number, number] = [190, 170, 150];
    const rgb = buildRgb(320, 240, (x, y) => {
      if (edgeDistance(x, y, 320, 240) < 29) return [30, 30, 30]; // no rebate anywhere
      const inPatch = x >= 120 && x < 200 && y >= 100 && y < 160;
      return inPatch ? patch : [40, 60, 120]; // dark image content elsewhere
    });

    const estimate = estimateFilmBase(rgb, 320, 240, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('in-frame');
    expect(estimate!.sample.r).toBeCloseTo(patch[0], -1);
    expect(estimate!.sample.g).toBeCloseTo(patch[1], -1);
    expect(estimate!.sample.b).toBeCloseTo(patch[2], -1);
    // Always used-but-flagged: above the reject gate, below the accept gate.
    expect(estimate!.confidence).toBeGreaterThan(FILM_BASE_CONFIDENCE.reject);
    expect(estimate!.confidence).toBeLessThan(FILM_BASE_CONFIDENCE.accept);
  });

  it('rejects a blown-out in-frame patch and falls back to the percentile sample', () => {
    const rgb = buildRgb(320, 240, (x, y) => {
      if (edgeDistance(x, y, 320, 240) < 29) return [30, 30, 30];
      const inPatch = x >= 120 && x < 200 && y >= 100 && y < 160;
      return inPatch ? [255, 255, 255] : [40, 60, 120]; // specular blowout, not base
    });

    const estimate = estimateFilmBase(rgb, 320, 240, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('low-confidence');
    expect(estimate!.confidence).toBe(0);
  });

  it('rejects a bright but textured in-frame region via the texture gate', () => {
    const rgb = buildRgb(320, 240, (x, y) => {
      if (edgeDistance(x, y, 320, 240) < 29) return [30, 30, 30];
      const inPatch = x >= 120 && x < 200 && y >= 100 && y < 160;
      if (!inPatch) return [40, 60, 120];
      return (x + y) % 2 === 0 ? [225, 225, 225] : [55, 55, 55];
    });

    const estimate = estimateFilmBase(rgb, 320, 240, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.source).toBe('low-confidence');
    expect(estimate!.confidence).toBe(0);
  });

  it('prefers the frame rebate over any in-frame patch when a rebate exists', () => {
    const rebate: [number, number, number] = [150, 210, 180];
    const brightPatch = (x: number, y: number) => x >= 120 && x < 200 && y >= 100 && y < 160;
    const withPatch = buildRgb(320, 240, (x, y) => {
      const distance = edgeDistance(x, y, 320, 240);
      if (distance < 4) return [28, 28, 28];
      if (distance < 16) return rebate;
      return brightPatch(x, y) ? [230, 230, 230] : [46, 40, 30];
    });
    const withoutPatch = buildRgb(320, 240, (x, y) => {
      const distance = edgeDistance(x, y, 320, 240);
      if (distance < 4) return [28, 28, 28];
      if (distance < 16) return rebate;
      return [46, 40, 30];
    });

    const estimateWith = estimateFilmBase(withPatch, 320, 240, 3);
    const estimateWithout = estimateFilmBase(withoutPatch, 320, 240, 3);
    expect(estimateWith).not.toBeNull();
    expect(estimateWith!.source).toBe('frame-rebate');
    // Interior content must not perturb a successful border estimate at all.
    expect(estimateWith!.sample).toEqual(estimateWithout!.sample);
    expect(estimateWith!.confidence).toBe(estimateWithout!.confidence);
  });

  it('rejects a bright but heavily textured border via the texture gate', () => {
    // Large enough that each analysis cell spans multiple pixels, so a
    // high-frequency checkerboard produces a high per-cell std-dev.
    const rgb = buildRgb(320, 240, (x, y) => {
      if (edgeDistance(x, y, 320, 240) >= 24) return [46, 40, 30];
      return (x + y) % 2 === 0 ? [225, 225, 225] : [55, 55, 55];
    });

    const estimate = estimateFilmBase(rgb, 320, 240, 3);
    expect(estimate).not.toBeNull();
    // No smooth clear-base region survives, so the estimator refuses rather
    // than trusting the textured border.
    expect(estimate!.source).toBe('low-confidence');
    expect(estimate!.confidence).toBe(0);
  });
});
