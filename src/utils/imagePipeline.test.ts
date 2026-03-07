import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { processImageData } from './imagePipeline';

function createPixel(r: number, g: number, b: number) {
  return new ImageData(new Uint8ClampedArray([r, g, b, 255]), 1, 1);
}

describe('processImageData', () => {
  it('applies sampled film-base compensation before B&W conversion', () => {
    const baseSettings = createDefaultSettings({
      blackPoint: 0,
      whitePoint: 255,
      contrast: 0,
      highlightProtection: 0,
    });

    const withoutSample = createPixel(30, 80, 130);
    const withSample = createPixel(30, 80, 130);

    processImageData(withoutSample, baseSettings, false, 'processed');
    processImageData(withSample, {
      ...baseSettings,
      filmBaseSample: {
        r: 220,
        g: 110,
        b: 55,
      },
    }, false, 'processed');

    const [plainR, plainG, plainB] = withoutSample.data;
    const [sampledR, sampledG, sampledB] = withSample.data;

    expect(plainR).toBe(plainG);
    expect(plainG).toBe(plainB);
    expect(sampledR).toBe(sampledG);
    expect(sampledG).toBe(sampledB);
    expect(sampledR).not.toBe(plainR);
  });
});
