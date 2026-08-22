import { describe, expect, it } from 'vitest';
import {
  createDetectedFrameAnalysisSettings,
  detectFrame,
  expandFrameToAspect,
  getAutoFrameCrop,
  getLeveledFrameCrop,
  getOrientedFrameCrop,
  stabilizeRollFrames,
} from './frameDetection';
import { createDefaultSettings } from '../constants';
import { rotateCropClockwise } from './imagePipeline';

function createImage(width: number, height: number, fill = 0) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = fill;
    pixels[index + 1] = fill;
    pixels[index + 2] = fill;
    pixels[index + 3] = 255;
  }
  return pixels;
}

function setPixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  rgb: [number, number, number],
) {
  if (x < 0 || y < 0) {
    return;
  }

  const offset = (y * width + x) * 4;
  pixels[offset] = rgb[0];
  pixels[offset + 1] = rgb[1];
  pixels[offset + 2] = rgb[2];
}

function drawFilledRect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  top: number,
  rectWidth: number,
  rectHeight: number,
  rgb: [number, number, number],
) {
  const right = Math.min(width, left + rectWidth);
  const bottom = Math.min(height, top + rectHeight);

  for (let y = Math.max(0, top); y < bottom; y += 1) {
    for (let x = Math.max(0, left); x < right; x += 1) {
      setPixel(pixels, width, x, y, rgb);
    }
  }
}

function drawRotatedRect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  rectWidth: number,
  rectHeight: number,
  angleDegrees: number,
  rgb: [number, number, number],
) {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const halfWidth = rectWidth / 2;
  const halfHeight = rectHeight / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;

      if (Math.abs(rx) <= halfWidth && Math.abs(ry) <= halfHeight) {
        setPixel(pixels, width, x, y, rgb);
      }
    }
  }
}

function addHorizontalLightingRamp(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const change = Math.round(amount * (x / Math.max(1, width - 1) - 0.5));
      pixels[offset] = Math.max(0, Math.min(255, pixels[offset] + change));
      pixels[offset + 1] = Math.max(0, Math.min(255, pixels[offset + 1] + change));
      pixels[offset + 2] = Math.max(0, Math.min(255, pixels[offset + 2] + change));
    }
  }
}

function drawThinBorderPortraitScene(width: number, height: number) {
  const pixels = createImage(width, height, 236);
  const frame = {
    left: Math.round(width * 0.12),
    top: Math.round(height * 0.08),
    width: Math.round(width * 0.76),
    height: Math.round(height * 0.84),
  };

  drawFilledRect(pixels, width, height, frame.left, frame.top, frame.width, frame.height, [154, 176, 188]);
  drawFilledRect(pixels, width, height, frame.left, frame.top, 4, frame.height, [248, 246, 240]);
  drawFilledRect(pixels, width, height, frame.left + frame.width - 4, frame.top, 4, frame.height, [247, 245, 239]);

  // Keep the top and bottom borders intentionally faint so the detector has to work harder.
  drawFilledRect(pixels, width, height, frame.left, frame.top, frame.width, 2, [214, 220, 224]);
  drawFilledRect(pixels, width, height, frame.left, frame.top + frame.height - 2, frame.width, 2, [210, 216, 220]);

  for (let index = 0; index < 6; index += 1) {
    const y = frame.top + 18 + index * 10;
    const x = frame.left + 8 + (index % 2) * 10;
    const stripeWidth = frame.width - 28 - (index % 3) * 8;
    const stripeColor: [number, number, number] = index % 2 === 0 ? [184, 198, 206] : [132, 154, 164];
    drawFilledRect(pixels, width, height, x, y, stripeWidth, 3, stripeColor);
  }

  drawFilledRect(
    pixels,
    width,
    height,
    frame.left + Math.round(frame.width * 0.53),
    frame.top + Math.round(frame.height * 0.12),
    Math.max(8, Math.round(frame.width * 0.08)),
    Math.round(frame.height * 0.58),
    [120, 138, 142],
  );

  for (let index = 0; index < 5; index += 1) {
    const blockWidth = Math.round(frame.width * 0.12) + index * 4;
    const blockHeight = Math.round(frame.height * 0.08) + (index % 2) * 6;
    drawFilledRect(
      pixels,
      width,
      height,
      frame.left + 10 + index * (blockWidth - 6),
      frame.top + frame.height - blockHeight - 8,
      blockWidth,
      blockHeight,
      index % 2 === 0 ? [128, 142, 148] : [172, 184, 190],
    );
  }

  return {
    pixels,
    frame: {
      left: frame.left,
      top: frame.top,
      right: frame.left + frame.width - 1,
      bottom: frame.top + frame.height - 1,
    },
  };
}

function downsampleImage(
  pixels: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const result = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceYStart = Math.floor((y * sourceHeight) / targetHeight);
    const sourceYEnd = Math.max(sourceYStart + 1, Math.floor(((y + 1) * sourceHeight) / targetHeight));

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceXStart = Math.floor((x * sourceWidth) / targetWidth);
      const sourceXEnd = Math.max(sourceXStart + 1, Math.floor(((x + 1) * sourceWidth) / targetWidth));
      const targetOffset = (y * targetWidth + x) * 4;

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let sy = sourceYStart; sy < sourceYEnd; sy += 1) {
        for (let sx = sourceXStart; sx < sourceXEnd; sx += 1) {
          const sourceOffset = (sy * sourceWidth + sx) * 4;
          r += pixels[sourceOffset];
          g += pixels[sourceOffset + 1];
          b += pixels[sourceOffset + 2];
          count += 1;
        }
      }

      result[targetOffset] = Math.round(r / Math.max(count, 1));
      result[targetOffset + 1] = Math.round(g / Math.max(count, 1));
      result[targetOffset + 2] = Math.round(b / Math.max(count, 1));
      result[targetOffset + 3] = 255;
    }
  }

  return result;
}

describe('detectFrame', () => {
  it('detects a clean frame within 1 percent tolerance', () => {
    const width = 200;
    const height = 150;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 12, 9, 176, 132, [255, 255, 255]);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(12 / (width - 1), 2);
    expect(result?.top).toBeCloseTo(9 / (height - 1), 2);
    expect(result?.right).toBeCloseTo(187 / (width - 1), 2);
    expect(result?.bottom).toBeCloseTo(140 / (height - 1), 2);
  });

  it('detects a portrait frame with faint horizontal borders and busy interior detail', () => {
    const width = 240;
    const height = 360;
    const { pixels, frame } = drawThinBorderPortraitScene(width, height);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(frame.left / (width - 1), 1);
    expect(result?.top).toBeCloseTo(frame.top / (height - 1), 1);
    expect(result?.right).toBeCloseTo(frame.right / (width - 1), 1);
    expect(result?.bottom).toBeCloseTo(frame.bottom / (height - 1), 1);
  });

  it('keeps detecting the same portrait frame after downsampling to the analysis-preview scale', () => {
    const sourceWidth = 720;
    const sourceHeight = 1080;
    const { pixels, frame } = drawThinBorderPortraitScene(sourceWidth, sourceHeight);
    const width = 240;
    const height = 360;
    const downsampled = downsampleImage(pixels, sourceWidth, sourceHeight, width, height);

    const result = detectFrame(downsampled, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo((frame.left / (sourceWidth - 1)), 1);
    expect(result?.top).toBeCloseTo((frame.top / (sourceHeight - 1)), 1);
    expect(result?.right).toBeCloseTo((frame.right / (sourceWidth - 1)), 1);
    expect(result?.bottom).toBeCloseTo((frame.bottom / (sourceHeight - 1)), 1);
  });

  it('detects a roughly 2 degree rotated frame', () => {
    const width = 240;
    const height = 180;
    const pixels = createImage(width, height, 0);
    drawRotatedRect(pixels, width, height, 120, 90, 190, 140, 2, [255, 255, 255]);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.angle).toBeGreaterThan(-3.5);
    expect(result?.angle).toBeLessThan(-0.5);
  });

  it('levels against the continuous film edge instead of brighter sprocket holes', () => {
    const width = 300;
    const height = 200;
    const pixels = createImage(width, height, 0);
    drawRotatedRect(pixels, width, height, 150, 100, 250, 156, 1.7, [115, 115, 115]);

    // High-contrast holes sit close enough to the top and bottom edge to fool
    // point-wise strongest-gradient sampling, especially after downsampling.
    for (let x = 45; x < 270; x += 30) {
      drawFilledRect(pixels, width, height, x, 29, 13, 10, [255, 255, 255]);
      drawFilledRect(pixels, width, height, x + 8, 163, 13, 10, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.angle).toBeGreaterThan(-2.5);
    expect(result?.angle).toBeLessThan(-1);
  });

  it('crops to the inner image edge when a film rebate surrounds the frame', () => {
    const width = 300;
    const height = 200;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 20, 14, 260, 172, [105, 105, 105]);
    drawFilledRect(pixels, width, height, 28, 24, 242, 150, [185, 185, 185]);
    for (let x = 38; x < 265; x += 30) {
      drawFilledRect(pixels, width, height, x, 15, 12, 7, [255, 255, 255]);
      drawFilledRect(pixels, width, height, x, 178, 12, 7, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(28 / (width - 1), 1);
    expect(result?.top).toBeCloseTo(24 / (height - 1), 1);
    expect(result?.right).toBeCloseTo(269 / (width - 1), 1);
    expect(result?.bottom).toBeCloseTo(173 / (height - 1), 1);
  });

  it('levels a clockwise film strip with sprockets on both edges', () => {
    const width = 320;
    const height = 210;
    const pixels = createImage(width, height, 8);
    drawRotatedRect(pixels, width, height, 160, 105, 270, 170, -2.3, [112, 112, 112]);
    for (let x = 36; x < 290; x += 28) {
      drawFilledRect(pixels, width, height, x, 22, 11, 9, [250, 250, 250]);
      drawFilledRect(pixels, width, height, x + 7, 178, 11, 9, [250, 250, 250]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.angle).toBeGreaterThan(1.2);
    expect(result?.angle).toBeLessThan(3.2);
  });

  it('finds the frame under a strong left-to-right lighting falloff', () => {
    const width = 300;
    const height = 200;
    const pixels = createImage(width, height, 12);
    drawFilledRect(pixels, width, height, 20, 15, 260, 170, [104, 104, 104]);
    drawFilledRect(pixels, width, height, 29, 25, 242, 149, [162, 162, 162]);
    addHorizontalLightingRamp(pixels, width, height, 90);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeGreaterThanOrEqual(27 / (width - 1));
    expect(result?.right).toBeLessThanOrEqual(272 / (width - 1));
    expect(Math.abs(result?.angle ?? 10)).toBeLessThan(0.7);
  });

  it('does not follow strong horizontal scene detail near the film edge', () => {
    const width = 320;
    const height = 210;
    const pixels = createImage(width, height, 5);
    drawRotatedRect(pixels, width, height, 160, 105, 270, 170, 1.4, [120, 120, 120]);
    for (let x = 45; x < 280; x += 48) {
      drawFilledRect(pixels, width, height, x, 48 + (x % 3) * 3, 34, 4, [245, 245, 245]);
      drawFilledRect(pixels, width, height, x - 10, 146 - (x % 4) * 2, 40, 5, [15, 15, 15]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.angle).toBeGreaterThan(-2.2);
    expect(result?.angle).toBeLessThan(-0.7);
  });

  it('prefers the first image-gate edge over stronger detail inside the exposure', () => {
    const width = 320;
    const height = 210;
    const pixels = createImage(width, height, 4);
    drawFilledRect(pixels, width, height, 20, 14, 280, 182, [215, 215, 215]);
    drawFilledRect(pixels, width, height, 29, 31, 262, 148, [105, 105, 105]);
    // A high-contrast scene boundary spans the image and is stronger than the
    // actual gate edge, but it must not become the crop boundary.
    drawFilledRect(pixels, width, height, 29, 49, 262, 7, [250, 250, 250]);
    drawFilledRect(pixels, width, height, 29, 154, 262, 8, [8, 8, 8]);
    for (let x = 38; x < 290; x += 30) {
      drawFilledRect(pixels, width, height, x, 16, 12, 9, [255, 255, 255]);
      drawFilledRect(pixels, width, height, x + 5, 181, 12, 9, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result!.top).toBeLessThan(40 / (height - 1));
    expect(result!.bottom).toBeGreaterThan(170 / (height - 1));
  });

  it('handles sprockets visible on only one side of the strip', () => {
    const width = 300;
    const height = 200;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 20, 15, 260, 170, [110, 110, 110]);
    drawFilledRect(pixels, width, height, 29, 25, 242, 150, [175, 175, 175]);
    for (let x = 32; x < 275; x += 13) {
      drawFilledRect(pixels, width, height, x, 16, 6, 8, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    // Keep a narrow safety margin at a one-sided sprocket boundary without
    // forcing the crop all the way to the synthetic inner transition.
    expect(result?.top).toBeGreaterThanOrEqual(22 / (height - 1));
    expect(result?.bottom).toBeLessThanOrEqual(179 / (height - 1));
  });

  it('recognizes the eight-to-ten sprocket spacing of a full 35mm frame', () => {
    const width = 320;
    const height = 210;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 22, 14, 276, 182, [225, 225, 225]);
    drawFilledRect(pixels, width, height, 31, 34, 258, 142, [120, 120, 120]);
    for (let x = 45; x < 292; x += 35) {
      drawFilledRect(pixels, width, height, x, 17, 18, 13, [255, 255, 255]);
      drawFilledRect(pixels, width, height, x + 5, 180, 18, 13, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result!.top).toBeGreaterThan(30 / (height - 1));
    expect(result!.bottom).toBeLessThan(180 / (height - 1));
  });

  it('keeps a borderless 3:2 frame instead of applying the film-rebate inset', () => {
    const width = 300;
    const height = 200;
    const pixels = createImage(width, height, 4);
    drawFilledRect(pixels, width, height, 18, 14, 264, 172, [205, 205, 205]);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(18 / (width - 1), 2);
    expect(result?.top).toBeCloseTo(14 / (height - 1), 2);
    expect(result?.right).toBeCloseTo(281 / (width - 1), 2);
    expect(result?.bottom).toBeCloseTo(185 / (height - 1), 2);
  });

  it('crops a portrait 35mm frame inside rebates and side sprockets', () => {
    const width = 210;
    const height = 320;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 14, 15, 182, 290, [235, 235, 235]);
    drawFilledRect(pixels, width, height, 25, 40, 160, 240, [105, 105, 105]);
    drawFilledRect(pixels, width, height, 31, 47, 148, 226, [170, 170, 170]);
    for (let y = 50; y < 275; y += 28) {
      drawFilledRect(pixels, width, height, 16, y, 8, 13, [5, 5, 5]);
      drawFilledRect(pixels, width, height, 186, y + 7, 8, 13, [5, 5, 5]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(31 / (width - 1), 1);
    expect(result?.right).toBeCloseTo(178 / (width - 1), 1);
    expect(result?.right).toBeLessThan(0.89);
    expect(result?.top).toBeCloseTo(47 / (height - 1), 1);
    expect(result?.bottom).toBeCloseTo(272 / (height - 1), 1);
  });

  it('returns null for a low-contrast frame', () => {
    const width = 160;
    const height = 120;
    const pixels = createImage(width, height, 100);
    drawFilledRect(pixels, width, height, 24, 20, 100, 70, [107, 107, 107]);

    expect(detectFrame(pixels, width, height)).toBeNull();
  });

  it('returns null when the frame fills more than 98 percent of the image', () => {
    const width = 160;
    const height = 120;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 0, 0, 160, 120, [255, 255, 255]);

    expect(detectFrame(pixels, width, height)).toBeNull();
  });

  it('applies sprocket-side exclusion for a 35mm-like frame', () => {
    const width = 240;
    const height = 160;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 16, 24, 192, 120, [255, 255, 255]);

    const sprocketSpacing = Math.round(width / 24);
    for (let x = 24; x < 198; x += sprocketSpacing) {
      drawFilledRect(pixels, width, height, x, 14, Math.max(3, Math.round(sprocketSpacing * 0.45)), 8, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.top).toBeGreaterThan(24 / (height - 1));
  });
});

describe('getLeveledFrameCrop', () => {
  it('inscribes the crop after leveling so rotated frame corners stay outside', () => {
    const crop = getLeveledFrameCrop({
      left: 0.1,
      top: 0.12,
      right: 0.9,
      bottom: 0.88,
      angle: -2,
      confidence: 5,
    }, 300, 200);

    expect(crop.x).toBeGreaterThan(0.1);
    expect(crop.y).toBeGreaterThan(0.12);
    expect(crop.width).toBeLessThan(0.8);
    expect(crop.height).toBeLessThan(0.76);
  });

  it('keeps an axis-aligned crop unchanged when no leveling is needed', () => {
    const crop = getLeveledFrameCrop({
      left: 0.1,
      top: 0.12,
      right: 0.9,
      bottom: 0.88,
      angle: 0,
      confidence: 5,
    }, 300, 200);

    expect(crop).toEqual({ x: 0.1, y: 0.12, width: 0.8, height: 0.76, aspectRatio: null });
  });
});

describe('getOrientedFrameCrop', () => {
  it('maps a source-space crop into a 90-degree clockwise portrait view', () => {
    const crop = getOrientedFrameCrop({
      left: 0.1,
      top: 0.11,
      right: 0.9,
      bottom: 0.85,
      angle: 0,
      confidence: 7,
    }, 6000, 4000, 90);

    expect(crop.x).toBeCloseTo(0.15);
    expect(crop.y).toBeCloseTo(0.1);
    expect(crop.width).toBeCloseTo(0.74);
    expect(crop.height).toBeCloseTo(0.8);
    expect(crop.aspectRatio).toBeNull();
  });

  it('maps the crop through a 270-degree rotation', () => {
    const crop = getOrientedFrameCrop({
      left: 0.1,
      top: 0.11,
      right: 0.9,
      bottom: 0.85,
      angle: 0,
      confidence: 7,
    }, 6000, 4000, 270);

    expect(crop.x).toBeCloseTo(0.11);
    expect(crop.y).toBeCloseTo(0.1);
    expect(crop.width).toBeCloseTo(0.74);
    expect(crop.height).toBeCloseTo(0.8);
  });

  it('returns to the same source crop after all four clockwise orientations', () => {
    const frame = {
      left: 0.07,
      top: 0.13,
      right: 0.91,
      bottom: 0.82,
      angle: 0,
      confidence: 8,
    };
    const sourceCrop = getOrientedFrameCrop(frame, 6000, 4000, 0);
    let rotatedCrop = sourceCrop;

    for (const rotation of [90, 180, 270] as const) {
      rotatedCrop = rotateCropClockwise(rotatedCrop);
      expect(rotatedCrop).toEqual(getOrientedFrameCrop(frame, 6000, 4000, rotation));
    }

    const fullTurnCrop = rotateCropClockwise(rotatedCrop);
    expect(fullTurnCrop.x).toBeCloseTo(sourceCrop.x);
    expect(fullTurnCrop.y).toBeCloseTo(sourceCrop.y);
    expect(fullTurnCrop.width).toBeCloseTo(sourceCrop.width);
    expect(fullTurnCrop.height).toBeCloseTo(sourceCrop.height);
  });
});

describe('getAutoFrameCrop', () => {
  it('ignores a fine-angle estimate and keeps the full detected gate', () => {
    const crop = getAutoFrameCrop({
      left: 0.1,
      top: 0.12,
      right: 0.9,
      bottom: 0.88,
      angle: 4.5,
      confidence: 4,
    }, 0);

    expect(crop).toEqual({ x: 0.1, y: 0.12, width: 0.8, height: 0.76, aspectRatio: null });
  });

  it('maps every detected edge to the correct side at each quarter turn', () => {
    const frame = {
      top: 0.1,
      left: 0.2,
      bottom: 0.7,
      right: 0.9,
      angle: 0,
      confidence: 10,
    };

    const expected = [
      { x: 0.2, y: 0.1, width: 0.7, height: 0.6 },
      { x: 0.3, y: 0.2, width: 0.6, height: 0.7 },
      { x: 0.1, y: 0.3, width: 0.7, height: 0.6 },
      { x: 0.1, y: 0.1, width: 0.6, height: 0.7 },
    ];
    [0, 90, 180, 270].forEach((rotation, index) => {
      const crop = getAutoFrameCrop(frame, rotation);
      expect(crop.x).toBeCloseTo(expected[index].x, 10);
      expect(crop.y).toBeCloseTo(expected[index].y, 10);
      expect(crop.width).toBeCloseTo(expected[index].width, 10);
      expect(crop.height).toBeCloseTo(expected[index].height, 10);
    });
  });

  it('maps the conservative crop through a 270-degree rotation', () => {
    const crop = getAutoFrameCrop({
      left: 0.1,
      top: 0.2,
      right: 0.85,
      bottom: 0.9,
      angle: -3,
      confidence: 5,
    }, 270);

    expect(crop.x).toBeCloseTo(0.2);
    expect(crop.y).toBeCloseTo(0.15);
    expect(crop.width).toBeCloseTo(0.7);
    expect(crop.height).toBeCloseTo(0.75);
  });
});

describe('film format guard', () => {
  it('recovers image width to 3:2 by expanding instead of trimming height', () => {
    const guarded = expandFrameToAspect(
      { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 },
      { left: 0.08, top: 0.06, right: 0.92, bottom: 0.94 },
      300,
      200,
      3 / 2,
    );

    expect(guarded.left).toBeCloseTo(0.1);
    expect(guarded.right).toBeCloseTo(0.9);
    expect(guarded.top).toBe(0.1);
    expect(guarded.bottom).toBe(0.9);
  });

  it('never expands beyond the detected outer film boundary', () => {
    const guarded = expandFrameToAspect(
      { left: 0.25, top: 0.1, right: 0.75, bottom: 0.9 },
      { left: 0.18, top: 0.06, right: 0.82, bottom: 0.94 },
      300,
      200,
      3 / 2,
    );

    expect(guarded.left).toBeGreaterThanOrEqual(0.18);
    expect(guarded.right).toBeLessThanOrEqual(0.82);
    expect(guarded.top).toBe(0.1);
    expect(guarded.bottom).toBe(0.9);
  });

  it('expands height for an overly wide crop rather than removing its sides', () => {
    const guarded = expandFrameToAspect(
      { left: 0.1, top: 0.3, right: 0.9, bottom: 0.7 },
      { left: 0.06, top: 0.08, right: 0.94, bottom: 0.92 },
      300,
      200,
      3 / 2,
    );

    expect(guarded.left).toBe(0.1);
    expect(guarded.right).toBe(0.9);
    expect(guarded.top).toBeCloseTo(0.1);
    expect(guarded.bottom).toBeCloseTo(0.9);
  });
});

describe('roll frame consensus', () => {
  const frame = (left: number, top: number, width: number, height: number): import('../types').DetectedFrame => ({
    left, top, right: left + width, bottom: top + height, angle: 0, confidence: 6,
  });

  it('uses robust shared dimensions while retaining per-frame translation', () => {
    const stabilized = stabilizeRollFrames([
      frame(0.1, 0.1, 0.8, 0.75),
      frame(0.11, 0.09, 0.8, 0.75),
      frame(0.12, 0.1, 0.74, 0.75),
      frame(0.09, 0.11, 0.8, 0.75),
    ]);

    expect(stabilized.every((item) => Math.abs((item.right - item.left) - 0.8) < 1e-8)).toBe(true);
    expect((stabilized[0].left + stabilized[0].right) / 2).not.toBeCloseTo(
      (stabilized[1].left + stabilized[1].right) / 2,
    );
  });

  it('does not mix different film-format clusters', () => {
    const stabilized = stabilizeRollFrames([
      frame(0.1, 0.1, 0.8, 0.75),
      frame(0.1, 0.1, 0.79, 0.75),
      frame(0.1, 0.1, 0.81, 0.75),
      frame(0.2, 0.1, 0.6, 0.75),
      frame(0.2, 0.1, 0.61, 0.75),
      frame(0.2, 0.1, 0.59, 0.75),
    ]);

    expect(stabilized.slice(0, 3).map((item) => item.right - item.left)).toEqual([0.8, 0.8, 0.8]);
    expect(stabilized.slice(3).every((item) => Math.abs((item.right - item.left) - 0.6) < 1e-8)).toBe(true);
  });
});

describe('createDetectedFrameAnalysisSettings', () => {
  it('uses detected geometry for analysis without mutating the visible crop', () => {
    const settings = createDefaultSettings({
      rotation: 0,
      levelAngle: 0,
      crop: {
        x: 0.25,
        y: 0.2,
        width: 0.5,
        height: 0.6,
        aspectRatio: null,
      },
    });
    const originalCrop = structuredClone(settings.crop);

    const analysisSettings = createDetectedFrameAnalysisSettings(settings, {
      left: 0.1,
      top: 0.12,
      right: 0.9,
      bottom: 0.88,
      angle: 0,
      confidence: 6,
    }, 300, 200);

    expect(analysisSettings).not.toBe(settings);
    expect(analysisSettings.crop).toEqual({
      x: 0.1,
      y: 0.12,
      width: 0.8,
      height: 0.76,
      aspectRatio: null,
    });
    expect(analysisSettings.levelAngle).toBe(0);
    expect(settings.crop).toEqual(originalCrop);
  });

  it('preserves manual leveling instead of applying the detected angle', () => {
    const settings = createDefaultSettings({ levelAngle: 1.5 });

    const analysisSettings = createDetectedFrameAnalysisSettings(settings, {
      left: 0.1,
      top: 0.12,
      right: 0.9,
      bottom: 0.88,
      angle: -2,
      confidence: 6,
    }, 300, 200);

    expect(analysisSettings.levelAngle).toBe(1.5);
    expect(settings.levelAngle).toBe(1.5);
  });
});
