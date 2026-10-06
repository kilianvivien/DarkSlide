// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import type { ColorProfileId, FilmProfileType } from '../types';
import { ImageKernels, setImageKernels } from './imageKernels';
import { processFloatRaster } from './imagePipeline';
import { applyFlatField, type FlatFieldProfile } from './flatField';

let kernels: ImageKernels;
beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('./wasm/image_kernels.wasm', import.meta.url)));
  kernels = new ImageKernels(instance);
});
afterEach(() => setImageKernels(null));

describe('Rust image kernel parity', () => {
  it('matches every flat-field sample, including padded edges and the last partial batch', () => {
    const width = 73; const height = 45;
    const profile: FlatFieldProfile = { version: 1, name: 'parity', width, height,
      gridWidth: 4, gridHeight: 4, maxCorrectionStops: 1, createdAt: 0,
      gains: Array.from({ length: 4 * 4 * 3 }, (_, i) => 0.7 + (i % 11) / 15),
    };
    const source = Uint16Array.from({ length: width * height * 3 }, (_, i) => (i * 7919) % 65536);
    const expected = source.slice(); const actual = source.slice();
    setImageKernels(null); applyFlatField(expected, width, height, profile);
    setImageKernels(kernels); applyFlatField(actual, width, height, profile);
    expect(actual).toEqual(expected);
  });
  it.each<ColorProfileId>(['srgb', 'linear', 'display-p3', 'adobe-rgb'])('preserves high-depth colors and tone in %s', (output) => {
    for (const film of ['negative', 'slide'] as FilmProfileType[]) {
      for (const input of ['srgb', 'display-p3'] as const) {
      for (const bw of [false, true]) {
        const settings = createDefaultSettings({ exposure: 12, temperature: 17, tint: -8,
          contrast: 42, highlightProtection: 63, shadowRecovery: 19, midtoneContrast: -12,
          saturation: 116, redBalance: 1.07, blueBalance: 0.96,
          blackAndWhite: { enabled: bw, redMix: 45, greenMix: -20, blueMix: 65, tone: -15 },
          filmBaseSample: { r: 210.25, g: 181.5, b: 128.75 },
          curves: { rgb: [{ x: 0, y: 0 }, { x: 98, y: 113 }, { x: 255, y: 255 }], red: [{ x: 0, y: 0 }, { x: 255, y: 245 }], green: [{ x: 0, y: 0 }, { x: 255, y: 255 }], blue: [{ x: 0, y: 10 }, { x: 255, y: 255 }] },
        });
        const samples = Float32Array.from({ length: 9000 }, (_, i) => ((i * 7919) % 65536) / 65535);
        const run = () => processFloatRaster({ width: 100, height: 30, data: samples.slice() }, settings, true, 'processed',
          undefined, [1.05, -0.03, -0.02, -0.02, 1.04, -0.02, 0.01, -0.03, 1.02],
          { shadowLift: 0.12, midtoneAnchor: 0.03, highlightRolloff: 0.45 },
          undefined, undefined, undefined, 0, 0, 0.37, input, output, null, film,
          [0.001, 0.002, 0.003], [1, 2, 3], [0.91, 1, 0.82]).data;
        setImageKernels(null); const expected = run();
        setImageKernels(kernels); const actual = run();
        let error = 0;
        for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - expected[i]));
        expect(error, `${input}, ${film}, bw=${bw}`).toBeLessThan(1 / 65535);
      }
      }
    }
  });
  it('keeps identity geometry exact and uses the same bilinear edge behavior', () => {
    const source = Uint16Array.from({ length: 7 * 5 * 3 }, (_, i) => (i * 613) % 65536);
    const actual = kernels.transform(source, 7, 5, 7, 5, [0, 0, 7, 5, 1, 0, 0]);
    expect(actual).toEqual(Float32Array.from(source, (v) => v / 65535));
    const shifted = kernels.transform(source, 7, 5, 7, 5, [0.5, 0, 7, 5, 1, 0, 0]);
    expect(shifted[0]).toBeCloseTo((source[0] + source[3]) / (2 * 65535), 7);
    expect(Array.from(shifted.slice(18, 21))).toEqual([0, 0, 0]);
  });
});
