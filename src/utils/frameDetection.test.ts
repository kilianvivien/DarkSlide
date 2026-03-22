import { describe, expect, it } from 'vitest';
import { detectFrame } from './frameDetection';

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

describe('detectFrame', () => {
  it('detects a clean frame within 1 percent tolerance', () => {
    const width = 200;
    const height = 150;
    const pixels = createImage(width, height, 0);
    drawFilledRect(pixels, width, height, 30, 20, 120, 90, [255, 255, 255]);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.left).toBeCloseTo(30 / (width - 1), 2);
    expect(result?.top).toBeCloseTo(20 / (height - 1), 2);
    expect(result?.right).toBeCloseTo(149 / (width - 1), 2);
    expect(result?.bottom).toBeCloseTo(109 / (height - 1), 2);
  });

  it('detects a roughly 2 degree rotated frame', () => {
    const width = 240;
    const height = 180;
    const pixels = createImage(width, height, 0);
    drawRotatedRect(pixels, width, height, 120, 90, 140, 90, 2, [255, 255, 255]);

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.angle).toBeGreaterThan(0.5);
    expect(result?.angle).toBeLessThan(3.5);
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
    drawFilledRect(pixels, width, height, 36, 24, 144, 96, [255, 255, 255]);

    const sprocketSpacing = Math.round(width / 24);
    for (let x = 42; x < 180; x += sprocketSpacing) {
      drawFilledRect(pixels, width, height, x, 18, Math.max(3, Math.round(sprocketSpacing * 0.45)), 8, [255, 255, 255]);
    }

    const result = detectFrame(pixels, width, height);

    expect(result).not.toBeNull();
    expect(result?.top).toBeGreaterThan(24 / (height - 1));
  });
});
