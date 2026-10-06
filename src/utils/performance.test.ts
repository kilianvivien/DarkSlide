// @vitest-environment node
/* eslint-disable no-console -- Opt-in benchmark emits machine-readable timings. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { decodeRawIpcPayload } from './rawImport';
import { ImageKernels, setImageKernels } from './imageKernels';
import { processFloatRaster } from './imagePipeline';
import { decodeTiffRaster } from './tiff';
import { parseInputIccProfile } from './colorProfiles';

it.skipIf(!process.env.DARKSLIDE_PERFORMANCE_RAW)('benchmarks real scan CPU processing against the reference', async () => {
  const file = await readFile(process.env.DARKSLIDE_PERFORMANCE_RAW!);
  const raw = decodeRawIpcPayload(file);
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('./wasm/image_kernels.wasm', import.meta.url)));
  const kernels = new ImageKernels(instance);
  const samples = Float32Array.from(raw.data, (v) => v / 65535);
  const settings = createDefaultSettings({ filmBaseSample: { r: 210, g: 190, b: 160 } });
  const run = (rust: boolean) => {
    setImageKernels(rust ? kernels : null);
    const data = samples.slice();
    const start = performance.now();
    processFloatRaster({ width: raw.width, height: raw.height, data }, settings, true, 'processed');
    return { data, ms: performance.now() - start };
  };
  const reference = run(false);
  const rust = run(true);
  let maximumError = 0;
  for (let i = 0; i < samples.length; i++) maximumError = Math.max(maximumError, Math.abs(reference.data[i] - rust.data[i]));
  expect(maximumError).toBeLessThan(1 / 65535);
  console.log(JSON.stringify({ file: process.env.DARKSLIDE_PERFORMANCE_RAW, width: raw.width, height: raw.height,
    referenceMs: reference.ms, rustMs: rust.ms, speedup: reference.ms / rust.ms, maximumError }));
  if (process.env.DARKSLIDE_PERFORMANCE_TIFF) {
    const bytes = await readFile(process.env.DARKSLIDE_PERFORMANCE_TIFF);
    const start = performance.now();
    const decoded = decodeTiffRaster(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    console.log(JSON.stringify({ file: process.env.DARKSLIDE_PERFORMANCE_TIFF, width: decoded.width, height: decoded.height, profile: parseInputIccProfile(decoded.iccProfile), decodeMs: performance.now() - start }));
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4);
  }
  setImageKernels(null);
}, 120_000);
