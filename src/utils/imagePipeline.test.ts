import { describe, expect, it } from 'vitest';
import { createDefaultSettings, FILM_PROFILES } from '../constants';
import { createCenteredAspectCrop, getCropPixelBounds, getRotatedDimensions, getTransformedDimensions, processImageData, rotateCropClockwise } from './imagePipeline';

function createPixel(r: number, g: number, b: number) {
  return new ImageData(new Uint8ClampedArray([r, g, b, 255]), 1, 1);
}

function createGrid(size: number, pixels: Array<[number, number, number]>) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = pixels[i % pixels.length];
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, size, size);
}

function luminance(imageData: ImageData, index = 0) {
  const i = index * 4;
  return 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
}

function midpointDeviation(imageData: ImageData, target = 128) {
  return Math.abs(luminance(imageData) - target);
}

// Neutral settings that isolate a single parameter
const neutralSettings = createDefaultSettings({
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

describe('exposure slider', () => {
  it('produces monotonically increasing luminance as exposure increases', () => {
    // Input (200,200,200) → after inversion: (55,55,55) — dark pixel, easy to distinguish exposure levels
    const low = createPixel(200, 200, 200);
    const mid = createPixel(200, 200, 200);
    const high = createPixel(200, 200, 200);

    processImageData(low, { ...neutralSettings, exposure: -50 }, true, 'processed');
    processImageData(mid, { ...neutralSettings, exposure: 0 }, true, 'processed');
    processImageData(high, { ...neutralSettings, exposure: 50 }, true, 'processed');

    expect(luminance(low)).toBeLessThan(luminance(mid));
    expect(luminance(mid)).toBeLessThan(luminance(high));
  });
});

describe('contrast slider', () => {
  it('pushes dark values further below midpoint as contrast increases', () => {
    const none = createPixel(200, 200, 200);
    const medium = createPixel(200, 200, 200);
    const high = createPixel(200, 200, 200);

    processImageData(none, { ...neutralSettings, contrast: 0 }, true, 'processed');
    processImageData(medium, { ...neutralSettings, contrast: 40 }, true, 'processed');
    processImageData(high, { ...neutralSettings, contrast: 80 }, true, 'processed');

    expect(luminance(high)).toBeLessThan(luminance(medium));
    expect(luminance(medium)).toBeLessThan(luminance(none));
  });

  it('leaves midpoint pixel unchanged at contrast=0', () => {
    const pixel = createPixel(127, 127, 127);
    processImageData(pixel, { ...neutralSettings, contrast: 0 }, true, 'processed');
    expect(midpointDeviation(pixel)).toBeLessThanOrEqual(2);
  });
});

describe('blackPoint and whitePoint sliders', () => {
  it('blackPoint=20 maps a dark pixel (~20) to near zero', () => {
    const pixel = createPixel(235, 235, 235);
    processImageData(pixel, { ...neutralSettings, blackPoint: 20, whitePoint: 255 }, true, 'processed');
    expect(luminance(pixel)).toBeLessThan(5);
  });

  it('blackPoint=0 leaves a dark pixel at its natural level', () => {
    const pixel = createPixel(235, 235, 235);
    processImageData(pixel, { ...neutralSettings, blackPoint: 0, whitePoint: 255 }, true, 'processed');
    expect(luminance(pixel)).toBeCloseTo(20, 0);
  });

  it('whitePoint=200 clips a bright pixel to full', () => {
    const pixel = createPixel(50, 50, 50);
    processImageData(pixel, { ...neutralSettings, blackPoint: 0, whitePoint: 200 }, true, 'processed');
    expect(luminance(pixel)).toBe(255);
  });
});

describe('highlightProtection slider', () => {
  it('pulls bright values down when protection is applied', () => {
    const unprotected = createPixel(30, 30, 30);
    const protected_ = createPixel(30, 30, 30);

    processImageData(unprotected, { ...neutralSettings, highlightProtection: 0 }, true, 'processed');
    processImageData(protected_, { ...neutralSettings, highlightProtection: 80 }, true, 'processed');

    expect(luminance(protected_)).toBeLessThan(luminance(unprotected));
  });

  it('leaves pixels below the threshold unchanged', () => {
    const unprotected = createPixel(230, 230, 230);
    const protected_ = createPixel(230, 230, 230);

    processImageData(unprotected, { ...neutralSettings, highlightProtection: 0 }, true, 'processed');
    processImageData(protected_, { ...neutralSettings, highlightProtection: 80 }, true, 'processed');

    expect(luminance(protected_)).toBe(luminance(unprotected));
  });
});

describe('saturation slider', () => {
  it('saturation=0 produces a grayscale result', () => {
    // Colored pixel (after inversion): red-shifted
    const pixel = createPixel(50, 180, 180);
    processImageData(pixel, { ...neutralSettings, saturation: 0 }, true, 'processed');
    // After saturation=0: r, g, b should all equal the luminance of the pixel
    expect(pixel.data[0]).toBe(pixel.data[1]);
    expect(pixel.data[1]).toBe(pixel.data[2]);
  });

  it('saturation=200 produces more vivid result than saturation=100', () => {
    // Input with color difference: (150, 50, 150) → inverted: (105, 205, 105) — green-dominant
    const normal = createPixel(150, 50, 150);
    const vivid = createPixel(150, 50, 150);

    processImageData(normal, { ...neutralSettings, saturation: 100 }, true, 'processed');
    processImageData(vivid, { ...neutralSettings, saturation: 200 }, true, 'processed');

    // Green channel (index 1) should be further from gray at saturation=200
    const grayNormal = luminance(normal);
    const grayVivid = luminance(vivid);
    const devNormal = Math.abs(normal.data[1] - grayNormal);
    const devVivid = Math.abs(vivid.data[1] - grayVivid);
    expect(devVivid).toBeGreaterThan(devNormal);
  });
});

describe('temperature and tint sliders', () => {
  it('positive temperature shifts red up and blue down (color mode)', () => {
    // Neutral inverted input: (127,127,127) → (128,128,128)
    const warm = createPixel(127, 127, 127);
    const neutral = createPixel(127, 127, 127);

    processImageData(neutral, { ...neutralSettings, temperature: 0 }, true, 'processed');
    processImageData(warm, { ...neutralSettings, temperature: 15 }, true, 'processed');

    expect(warm.data[0]).toBeGreaterThan(neutral.data[0]); // red up
    expect(warm.data[2]).toBeLessThan(neutral.data[2]);    // blue down
  });

  it('positive tint shifts green up (color mode)', () => {
    const tinted = createPixel(127, 127, 127);
    const neutral = createPixel(127, 127, 127);

    processImageData(neutral, { ...neutralSettings, tint: 0 }, true, 'processed');
    processImageData(tinted, { ...neutralSettings, tint: 15 }, true, 'processed');

    expect(tinted.data[1]).toBeGreaterThan(neutral.data[1]); // green up
  });
});

describe('curves', () => {
  it('a curve pulled down from identity produces a darker result', () => {
    const identity = createPixel(127, 127, 127);
    const darkened = createPixel(127, 127, 127);

    const darkenedCurves = {
      rgb: [{ x: 0, y: 0 }, { x: 128, y: 80 }, { x: 255, y: 255 }],
      red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    };

    processImageData(identity, neutralSettings, true, 'processed');
    processImageData(darkened, { ...neutralSettings, curves: darkenedCurves }, true, 'processed');

    expect(luminance(darkened)).toBeLessThan(luminance(identity));
  });
});

describe('color science profile hooks', () => {
  it('color matrices reduce residual channel spread on orange-masked pixels', () => {
    const withoutMatrix = createPixel(215, 185, 150);
    const withMatrix = createPixel(215, 185, 150);

    processImageData(withoutMatrix, neutralSettings, true, 'processed');
    processImageData(
      withMatrix,
      neutralSettings,
      true,
      'processed',
      undefined,
      [0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0],
    );

    const spreadWithout = Math.max(withoutMatrix.data[0], withoutMatrix.data[1], withoutMatrix.data[2])
      - Math.min(withoutMatrix.data[0], withoutMatrix.data[1], withoutMatrix.data[2]);
    const spreadWith = Math.max(withMatrix.data[0], withMatrix.data[1], withMatrix.data[2])
      - Math.min(withMatrix.data[0], withMatrix.data[1], withMatrix.data[2]);

    expect(spreadWith).toBeLessThan(spreadWithout);
  });

  it('tonal character can lift deep shadows without changing profile settings', () => {
    const flat = createPixel(200, 200, 200);
    const lifted = createPixel(200, 200, 200);

    processImageData(flat, neutralSettings, true, 'processed');
    processImageData(
      lifted,
      neutralSettings,
      true,
      'processed',
      undefined,
      undefined,
      { shadowLift: 0.2, highlightRolloff: 0.5, midtoneAnchor: 0 },
    );

    expect(luminance(lifted)).toBeGreaterThan(luminance(flat));
  });
});

describe('noise reduction', () => {
  it('smooths a checkerboard pattern (lower neighbor variance after processing)', () => {
    // 4×4 checkerboard: alternating (220,220,220) and (30,30,30)
    // After inversion: alternating (35,35,35) and (225,225,225)
    const imageData = createGrid(4, [[220, 220, 220], [30, 30, 30]]);

    processImageData(imageData, {
      ...neutralSettings,
      noiseReduction: { enabled: true, luminanceStrength: 80 },
    }, true, 'processed');

    // Compute variance between adjacent pixels
    let totalDiff = 0;
    const { data, width } = imageData;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 3; x++) {
        const i = (y * width + x) * 4;
        const j = (y * width + x + 1) * 4;
        totalDiff += Math.abs(data[i] - data[j]);
      }
    }

    // Without noise reduction, diff would be ~190 (35 vs 225). With NR it should be much smaller.
    expect(totalDiff).toBeLessThan(700);
  });
});

describe('sharpen', () => {
  it('amplifies edge contrast on a checkerboard pattern', () => {
    const withoutSharpen = createGrid(4, [[220, 220, 220], [30, 30, 30]]);
    const withSharpen = createGrid(4, [[220, 220, 220], [30, 30, 30]]);

    processImageData(withoutSharpen, {
      ...neutralSettings,
      sharpen: { enabled: false, radius: 1.0, amount: 0 },
    }, true, 'processed');

    processImageData(withSharpen, {
      ...neutralSettings,
      sharpen: { enabled: true, radius: 0.5, amount: 150 },
    }, true, 'processed');

    // With sharpen: bright pixels pushed brighter, dark pushed darker → higher total range
    const maxWithout = Math.max(...Array.from(withoutSharpen.data).filter((_, i) => i % 4 !== 3));
    const maxWith = Math.max(...Array.from(withSharpen.data).filter((_, i) => i % 4 !== 3));
    const minWithout = Math.min(...Array.from(withoutSharpen.data).filter((_, i) => i % 4 !== 3));
    const minWith = Math.min(...Array.from(withSharpen.data).filter((_, i) => i % 4 !== 3));

    expect(maxWith - minWith).toBeGreaterThanOrEqual(maxWithout - minWithout);
  });
});

describe('profile round-trips', () => {
  // 2×2 test image with varied colors (before inversion)
  const testImagePixels: Array<[number, number, number]> = [
    [210, 180, 165],  // typical orange-masked highlight
    [128, 120, 115],  // mid-tone
    [60,  55,  50],   // shadow
    [200, 190, 185],  // near-highlight
  ];

  for (const profile of FILM_PROFILES) {
    it(`${profile.name} — processImageData with default settings produces stable output`, () => {
      const imageData = createGrid(2, testImagePixels);
      processImageData(
        imageData,
        profile.defaultSettings,
        profile.type === 'color',
        'processed',
        profile.maskTuning,
        profile.colorMatrix,
        profile.tonalCharacter,
      );

      // Snapshot the RGBA output so regressions are caught
      expect(Array.from(imageData.data)).toMatchSnapshot();
    });
  }
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

describe('getCropPixelBounds', () => {
  it('rounds crop edges so the selected region matches the overlay more closely', () => {
    const bounds = getCropPixelBounds(
      {
        x: 0.0833,
        y: 0.0829,
        width: 0.8334,
        height: 0.8342,
        aspectRatio: 4 / 5,
      },
      4032,
      6048,
    );

    expect(bounds.x).toBe(336);
    expect(bounds.y).toBe(501);
    expect(bounds.width).toBe(3360);
    expect(bounds.height).toBe(5046);
  });
});

describe('getTransformedDimensions', () => {
  it('expands the image bounds for arbitrary leveling angles', () => {
    const transformed = getTransformedDimensions(4032, 6048, 2.5);

    expect(transformed.width).toBeGreaterThan(4032);
    expect(transformed.height).toBeGreaterThan(6048);
  });
});
