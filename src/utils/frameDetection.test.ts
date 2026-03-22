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
