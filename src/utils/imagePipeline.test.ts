import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { createCenteredAspectCrop, getRotatedDimensions, getTransformedDimensions, processImageData, rotateCropClockwise } from './imagePipeline';

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

describe('createCenteredAspectCrop', () => {
  it('fits a 4:5 crop against a portrait image using the full image width', () => {
    const crop = createCenteredAspectCrop(4 / 5, 4032, 6048);
    const renderedAspectRatio = (crop.width * 4032) / (crop.height * 6048);

    expect(crop.width).toBeCloseTo(1, 5);
    expect(crop.height).toBeCloseTo(5 / 6, 5);
    expect(crop.x).toBeCloseTo(0, 5);
    expect(crop.y).toBeCloseTo(1 / 12, 5);
    expect(renderedAspectRatio).toBeCloseTo(4 / 5, 5);
  });

  it('uses rotated dimensions when building a centered aspect crop', () => {
    const rotated = getRotatedDimensions(4032, 6048, 90);
    const crop = createCenteredAspectCrop(4 / 5, rotated.width, rotated.height);
    const renderedAspectRatio = (crop.width * rotated.width) / (crop.height * rotated.height);

    expect(crop.width).toBeCloseTo(8 / 15, 5);
    expect(crop.height).toBeCloseTo(1, 5);
    expect(crop.x).toBeCloseTo(7 / 30, 5);
    expect(crop.y).toBeCloseTo(0, 5);
    expect(renderedAspectRatio).toBeCloseTo(4 / 5, 5);
  });
});

describe('rotateCropClockwise', () => {
  it('rotates the crop rectangle with the image and inverts the locked aspect ratio', () => {
    const rotated = rotateCropClockwise({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.5,
      aspectRatio: 4 / 5,
    });

    expect(rotated.x).toBeCloseTo(0.2, 5);
    expect(rotated.y).toBeCloseTo(0.6, 5);
    expect(rotated.width).toBeCloseTo(0.5, 5);
    expect(rotated.height).toBeCloseTo(0.3, 5);
    expect(rotated.aspectRatio).toBeCloseTo(5 / 4, 5);
  });
});

describe('getTransformedDimensions', () => {
  it('expands the image bounds for arbitrary leveling angles', () => {
    const transformed = getTransformedDimensions(4032, 6048, 2.5);

    expect(transformed.width).toBeGreaterThan(4032);
    expect(transformed.height).toBeGreaterThan(6048);
  });
});
