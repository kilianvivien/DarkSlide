import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { buildCurveLutBuffer, FLOAT_CURVE_TABLE_SIZE, processFloatRaster, processImageData } from './imagePipeline';

describe('conversion backend consistency', () => {
  it('uses the same steep composed curves in 8-bit CPU output, GPU tables, and floating export', () => {
    const settings = createDefaultSettings({
      blackPoint: 0, whitePoint: 255, contrast: 0, highlightProtection: 0,
      curves: {
        rgb: [{ x: 0, y: 0 }, { x: 126, y: 129.3 }, { x: 144, y: 140.8 }, { x: 255, y: 255 }],
        red: [{ x: 0, y: 0 }, { x: 129, y: 40 }, { x: 141, y: 215 }, { x: 255, y: 255 }],
        green: [{ x: 0, y: 0 }, { x: 132, y: 220 }, { x: 255, y: 255 }],
        blue: [{ x: 0, y: 0 }, { x: 135, y: 70 }, { x: 255, y: 255 }],
      },
    });
    const labCurve = [{ x: 0, y: 0 }, { x: 130, y: 127.8 }, { x: 255, y: 255 }];
    const labChannels = { r: [{ x: 0, y: 0 }, { x: 134, y: 133.3 }, { x: 255, y: 255 }] };
    const rgb = new Float32Array(256 * 3);
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i += 1) {
      rgb.set([i / 255, i / 255, i / 255], i * 3);
      rgba.set([i, i, i, 255], i * 4);
    }
    const expected = processFloatRaster({ width: 256, height: 1, data: rgb }, settings, true, 'processed',
      undefined, undefined, undefined, labCurve, labChannels, undefined, 0, 0, 0, 'srgb', 'srgb', null, 'slide').data;
    const cpu = new ImageData(rgba, 256, 1);
    processImageData(cpu, settings, true, 'processed', undefined, undefined, undefined,
      labCurve, labChannels, undefined, 0, 0, 0, 'srgb', 'srgb', null, 'slide');
    const gpu = buildCurveLutBuffer(settings, labCurve, labChannels);
    expect(gpu.length).toBe(FLOAT_CURVE_TABLE_SIZE * 3);
    for (let i = 0; i < 256; i += 1) {
      const position = (i / 255) * (FLOAT_CURVE_TABLE_SIZE - 1);
      const lower = Math.floor(position);
      const upper = Math.min(lower + 1, FLOAT_CURVE_TABLE_SIZE - 1);
      for (let channel = 0; channel < 3; channel += 1) {
        const offset = channel * FLOAT_CURVE_TABLE_SIZE;
        // Shader interpolation, using the same input coordinate as the slide.
        const mapped = gpu[offset + lower] + (gpu[offset + upper] - gpu[offset + lower]) * (position - lower);
        expect(Math.abs(cpu.data[i * 4 + channel] - Math.round(expected[i * 3 + channel] * 255))).toBeLessThanOrEqual(1);
        expect(Math.abs(mapped - expected[i * 3 + channel])).toBeLessThan(0.000002);
      }
    }
  });
});
