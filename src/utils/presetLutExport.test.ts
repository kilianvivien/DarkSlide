import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import type { FilmProfile } from '../types';
import { parseCubeLut, sampleCubeLut } from './cubeLut';
import { processImageData } from './imagePipeline';
import { bakePresetToCubeLut } from './presetLutExport';

// Settings that leave the LUT output untouched, so a round-trip can be
// compared against the imported table directly.
const NEUTRAL_SETTINGS = createDefaultSettings({
  blackPoint: 0,
  whitePoint: 255,
  contrast: 0,
  highlightProtection: 0,
  saturation: 100,
  temperature: 0,
  tint: 0,
  redBalance: 1,
  greenBalance: 1,
  blueBalance: 1,
});

function buildProfile(overrides: Partial<FilmProfile> = {}): FilmProfile {
  return {
    id: 'test-profile',
    version: 1,
    name: 'Test Preset',
    type: 'color',
    description: '',
    defaultSettings: createDefaultSettings(),
    ...overrides,
  };
}

function processPixel(profile: FilmProfile, r: number, g: number, b: number) {
  const imageData = new ImageData(new Uint8ClampedArray([r, g, b, 255]), 1, 1);
  processImageData(
    imageData,
    profile.defaultSettings,
    true,
    'processed',
    profile.maskTuning,
    profile.colorMatrix,
    profile.tonalCharacter,
    undefined,
    undefined,
    undefined,
    0,
    0,
    0,
    'srgb',
    'srgb',
    profile.id,
    profile.filmType ?? 'negative',
    null,
    null,
    [1, 1, 1],
    null,
    null,
    profile.lut ?? null,
  );
  return [imageData.data[0], imageData.data[1], imageData.data[2]];
}

describe('bakePresetToCubeLut', () => {
  it('produces a well-formed table of the requested size', () => {
    const lut = bakePresetToCubeLut(buildProfile(), 9);

    expect(lut.size).toBe(9);
    expect(lut.data).toHaveLength(9 ** 3 * 3);
    expect(lut.title).toBe('Test Preset');
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    expect(Array.from(lut.data).every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('bakes the inversion — a dark negative input becomes a bright positive', () => {
    const lut = bakePresetToCubeLut(buildProfile(), 17);

    const [darkR, darkG, darkB] = sampleCubeLut(lut, 0.1, 0.1, 0.1);
    const [brightR, brightG, brightB] = sampleCubeLut(lut, 0.9, 0.9, 0.9);

    expect(darkR + darkG + darkB).toBeGreaterThan(brightR + brightG + brightB);
  });

  it('matches what the pipeline renders for the same input', () => {
    const profile = buildProfile({
      defaultSettings: { ...createDefaultSettings(), contrast: 25, saturation: 120 },
    });
    // A dense lattice keeps trilinear interpolation error small enough to
    // compare against the real per-pixel path.
    const lut = bakePresetToCubeLut(profile, 65);

    for (const [r, g, b] of [[64, 64, 64], [200, 120, 90], [30, 180, 210]]) {
      const rendered = processPixel(profile, r, g, b);
      const sampled = sampleCubeLut(lut, r / 255, g / 255, b / 255)
        .map((value) => Math.round(value * 255));

      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(sampled[channel] - rendered[channel])).toBeLessThanOrEqual(3);
      }
    }
  });

  it('bakes an imported LUT back out, so import → export round-trips', () => {
    const imported = parseCubeLut(
      readFileSync(resolve(__dirname, '../../Resources/PhoenixII.cube'), 'utf-8'),
    );
    const profile = buildProfile({
      name: 'PhoenixII',
      lut: imported,
      defaultSettings: structuredClone(NEUTRAL_SETTINGS),
    });
    const baked = bakePresetToCubeLut(profile, 35);

    // With neutral sliders the baked table reproduces the imported one at its
    // own lattice points.
    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75], [0.5, 0.5, 0.5]]) {
      const original = sampleCubeLut(imported, r, g, b);
      const rebaked = sampleCubeLut(baked, r, g, b);

      for (let channel = 0; channel < 3; channel += 1) {
        expect(rebaked[channel]).toBeCloseTo(original[channel], 2);
      }
    }
  });

  it('excludes spatial stages that a colour LUT cannot represent', () => {
    const sharpened = buildProfile({
      defaultSettings: {
        ...createDefaultSettings(),
        sharpen: { enabled: true, radius: 2, amount: 200 },
        noiseReduction: { enabled: true, luminanceStrength: 80 },
      },
    });

    const withSpatial = bakePresetToCubeLut(sharpened, 9);
    const withoutSpatial = bakePresetToCubeLut(buildProfile(), 9);

    expect(Array.from(withSpatial.data)).toEqual(Array.from(withoutSpatial.data));
  });
});

describe('LUT presets in the render pipeline', () => {
  const imported = parseCubeLut(
    readFileSync(resolve(__dirname, '../../Resources/PhoenixII.cube'), 'utf-8'),
  );

  it('replaces the built-in inversion rather than layering on top of it', () => {
    const withLut = buildProfile({ lut: imported });
    const withoutLut = buildProfile();

    // PhoenixII maps black to white. With the LUT standing in for the inversion
    // stage, a black input must come out bright.
    const [r, g, b] = processPixel(withLut, 0, 0, 0);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);

    expect(processPixel(withLut, 128, 128, 128)).not.toEqual(processPixel(withoutLut, 128, 128, 128));
  });

  it('still applies the parametric stages on top of the LUT', () => {
    const neutral = buildProfile({ lut: imported, defaultSettings: structuredClone(NEUTRAL_SETTINGS) });
    const brightened = buildProfile({
      lut: imported,
      defaultSettings: { ...structuredClone(NEUTRAL_SETTINGS), exposure: 40 },
    });

    // A mid-density negative input the LUT maps well clear of both clipping
    // points, so exposure has room to move it.
    const neutralPixel = processPixel(neutral, 40, 90, 140);
    const brightPixel = processPixel(brightened, 40, 90, 140);

    expect(Math.max(...neutralPixel)).toBeGreaterThan(0);
    expect(brightPixel[1]).toBeGreaterThan(neutralPixel[1]);
  });
});
