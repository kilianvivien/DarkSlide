import { describe, expect, it } from 'vitest';
import { createDefaultSettings, DENSITY_TO_POSITIVE_GAMMA } from '../constants';
import type { ColorProfileId, ConversionSettings, InputProfileSpec } from '../types';
import { decodeProfileChannel, encodeProfileChannel } from './colorProfiles';
import { applyLightSourceCorrection, buildProcessingUniforms, computeDensityBalance, computeRawDensityBalance, processFloatRaster, resolveDensityInversionParams } from './imagePipeline';
import { rgb16ToRgba8 } from './rawImport';

const base = { r: 180.25, g: 150.5, b: 90.125 };
const calibration = { scaleR: 0.88, scaleG: 1, scaleB: 0.61, source: 'film-stock-preset' as const };
const neutral = createDefaultSettings({ blackPoint: 0, whitePoint: 255, contrast: 0, highlightProtection: 0, filmBaseSample: base, densityBalance: calibration });

function convert(data: Float32Array, settings: ConversionSettings, profile: ColorProfileId, bias: [number, number, number], flare: [number, number, number] | null = null) {
  return processFloatRaster({ width: data.length / 3, height: 1, data }, settings, true, 'processed',
    undefined, undefined, undefined, undefined, undefined, undefined, 0, 0, 0,
    profile, profile, null, 'negative', null, flare, bias).data;
}

describe('RAW radiometric accuracy', () => {
  it('applies illuminant correction in linear light', () => {
    const corrected = applyLightSourceCorrection(0.4, 0.5, 'srgb');
    expect(decodeProfileChannel('srgb', corrected)).toBeCloseTo(decodeProfileChannel('srgb', 0.4) / 0.5, 12);
  });

  it('uses the corrected illuminant reference for conservative monochrome estimates too', () => {
    const settings = { ...neutral, filmBaseSample: null };
    const params = resolveDensityInversionParams(settings, false, 'negative', null,
      { sample: { r: 127.5, g: 102, b: 76.5 }, source: 'low-confidence', confidence: 0, rejectedCandidates: 0, clamped: false },
      null, 'linear', 'linear', null, 0, [1, 0.5, 0.6]);
    const expectedDensity = -Math.log10(0.299 * 0.5 + 0.587 * 0.8 + 0.114 * 0.5);
    params.baseDensity.forEach((density) => expect(density).toBeCloseTo(expectedDensity, 12));
    expect(params.lowConfidence).toBe(true);
  });

  it.each<ColorProfileId>(['srgb', 'display-p3', 'adobe-rgb', 'linear'])('maps the exact fractional film base to black with flare and an illuminant in %s', (profile) => {
    const bias: [number, number, number] = [0.82, 0.87, 1];
    const data = convert(new Float32Array([base.r / 255, base.g / 255, base.b / 255]), neutral, profile, bias, [2, 3, 1]);
    for (const value of data) expect(value).toBeLessThan(0.000001);
    // The GPU receives the same corrected reference, including fractional RGB.
    const uniforms = buildProcessingUniforms(neutral, true, 'processed', undefined, undefined, undefined,
      undefined, 0, 0, 0, profile, profile, null, 'negative', null, [2, 3, 1], bias);
    expect(uniforms[76]).toBeCloseTo(-Math.log10(decodeProfileChannel(profile,
      applyLightSourceCorrection(base.r / 255 - (2 / 255) * 0.5, bias[0], profile))), 6);
    expect(Array.from(uniforms.slice(80, 83))).toEqual(Array.from(new Float32Array([calibration.scaleR, calibration.scaleG, calibration.scaleB])));
  });

  it.each<ColorProfileId>(['srgb', 'display-p3', 'adobe-rgb', 'linear'])('recovers known synthetic density-model colors with a colored base and illuminant in %s', (profile) => {
    const positives = [0.15, 0.32, 0.5, 0.65, 0.8, 0.9];
    const bases = [base.r, base.g, base.b];
    const scales = [calibration.scaleR, calibration.scaleG, calibration.scaleB];
    const source = Float32Array.from(positives, (value, index) => {
      const channel = index % 3;
      const linearBase = decodeProfileChannel(profile, bases[channel] / 255);
      return encodeProfileChannel(profile, linearBase * (1 - value) ** (DENSITY_TO_POSITIVE_GAMMA / scales[channel]));
    });
    const recovered = convert(source, neutral, profile, [1, 0.94, 0.88]);
    recovered.forEach((value, index) => expect(value).toBeCloseTo(positives[index], 5));
  });

  it('retains base precision when an automatic reference is transformed to a different output space', () => {
    const data = new Float32Array([base.r / 255, base.g / 255, base.b / 255]);
    const result = processFloatRaster({ width: 1, height: 1, data }, { ...neutral, filmBaseSample: null }, true, 'processed',
      undefined, undefined, undefined, undefined, undefined, undefined, 0, 0, 0,
      'srgb', 'adobe-rgb', null, 'negative', null, null, [1, 1, 1],
      { sample: base, source: 'outer-border', confidence: 1, rejectedCandidates: 0, clamped: false });
    for (const value of result.data) expect(value).toBeLessThan(0.000001);
  });

  it.each<ColorProfileId>(['display-p3', 'adobe-rgb', 'linear'])('retains a manually picked sRGB base when exporting to %s', (output) => {
    const settings = { ...neutral, filmBaseSampleProfileId: 'srgb' as const };
    const data = new Float32Array([base.r / 255, base.g / 255, base.b / 255]);
    const result = processFloatRaster({ width: 1, height: 1, data }, settings, true, 'processed',
      undefined, undefined, undefined, undefined, undefined, undefined, 0, 0, 0,
      'srgb', output, null, 'negative', null, null, [1, 0.94, 0.88]);
    for (const value of result.data) expect(value).toBeLessThan(0.000001);
  });

  it('measures dye contrast from 16-bit source samples more accurately than the quantized preview', () => {
    const reference = { r: 200, g: 180, b: 150 };
    const expected = [0.83, 1, 1.12];
    const bases = [reference.r, reference.g, reference.b];
    const rgb = new Uint16Array(40 * 40 * 3);
    for (let pixel = 0; pixel < 40 * 40; pixel += 1) {
      const density = 0.12 + (pixel % 40) / 120;
      for (let channel = 0; channel < 3; channel += 1) {
        const linear = decodeProfileChannel('srgb', bases[channel] / 255) * 10 ** (-density / expected[channel]);
        rgb[pixel * 3 + channel] = Math.round(encodeProfileChannel('srgb', linear) * 65535);
      }
    }
    const raw = computeRawDensityBalance(rgb, 40, 40, reference);
    const preview = computeDensityBalance(new ImageData(new Uint8ClampedArray(rgb16ToRgba8(rgb, 40, 40)), 40, 40), reference);
    const error = (r: number, b: number) => Math.abs(r - expected[0]) + Math.abs(b - expected[2]);
    expect(raw.source).toBe('auto-histogram');
    expect(error(raw.scaleR, raw.scaleB)).toBeLessThan(0.0001);
    expect(error(raw.scaleR, raw.scaleB)).toBeLessThan(error(preview.scaleR, preview.scaleB));
  });

  it.each<InputProfileSpec>(['srgb', 'adobe-rgb', 'linear', {
    kind: 'parsed-icc', name: 'Scanner gamma 1.8', colorSpace: 'rgb',
    trc: { type: 'gamma', gamma: 1.8 }, toXyzD65: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  }])('measures dye contrast using the source transfer curve %j', (profile) => {
    const reference = { r: 200, g: 180, b: 150 };
    const expected = [0.83, 1, 1.12];
    const bases = [reference.r, reference.g, reference.b];
    const data = new Uint16Array(40 * 40 * 3);
    for (let pixel = 0; pixel < 1600; pixel += 1) {
      const density = 0.12 + (pixel % 40) / 120;
      for (let channel = 0; channel < 3; channel += 1) {
        const transmittance = decodeProfileChannel(profile, bases[channel] / 255) * 10 ** (-density / expected[channel]);
        data[pixel * 3 + channel] = Math.round(encodeProfileChannel(profile, transmittance) * 65535);
      }
    }
    const measured = computeRawDensityBalance(data, 40, 40, reference, profile);
    expect(measured.source).toBe('auto-histogram');
    expect(measured.scaleR).toBeCloseTo(expected[0], 3);
    expect(measured.scaleB).toBeCloseTo(expected[2], 3);
  });
});
