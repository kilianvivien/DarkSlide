import { describe, expect, it } from 'vitest';
import { detectDustMarks } from './dustDetection';

describe('detectDustMarks', () => {
  it('detects bright dust-like specks in a flat field', () => {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 80;
      data[index + 1] = 70;
      data[index + 2] = 60;
      data[index + 3] = 255;
    }

    const spots = [
      { x: 18, y: 22 },
      { x: 44, y: 38 },
    ];
    for (const spot of spots) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const x = spot.x + offsetX;
          const y = spot.y + offsetY;
          const pixelIndex = (y * width + x) * 4;
          data[pixelIndex] = 245;
          data[pixelIndex + 1] = 245;
          data[pixelIndex + 2] = 245;
        }
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 70, 6, 'spots');

    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks.every((mark) => mark.source === 'auto')).toBe(true);

    const hasSpotNear = (targetX: number, targetY: number) => marks.some((mark) => {
      const cx = mark.cx * width;
      const cy = mark.cy * height;
      return Math.hypot(cx - targetX, cy - targetY) < 4;
    });

    expect(hasSpotNear(18, 22)).toBe(true);
    expect(hasSpotNear(44, 38)).toBe(true);
  });

  it('detects long scratch-like fragments when scratch mode is enabled', () => {
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 96;
      data[index + 1] = 88;
      data[index + 2] = 82;
      data[index + 3] = 255;
    }

    for (let x = 12; x < 82; x += 1) {
      const y = 40 + Math.round(Math.sin(x / 8) * 2);
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 230;
      data[pixelIndex + 1] = 230;
      data[pixelIndex + 2] = 230;
    }

    const grainPixels = [
      { x: 14, y: 14 },
      { x: 72, y: 20 },
      { x: 66, y: 76 },
    ];
    for (const grain of grainPixels) {
      const pixelIndex = (grain.y * width + grain.x) * 4;
      data[pixelIndex] = 220;
      data[pixelIndex + 1] = 220;
      data[pixelIndex + 2] = 220;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 55, 8, 'scratches');

    expect(marks.length).toBeGreaterThanOrEqual(4);
    expect(marks.some((mark) => {
      const cx = mark.cx * width;
      const cy = mark.cy * height;
      return cx > 20 && cx < 70 && cy > 34 && cy < 46;
    })).toBe(true);
  });

  it('also detects long scratch-like fragments in both mode', () => {
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 96;
      data[index + 1] = 88;
      data[index + 2] = 82;
      data[index + 3] = 255;
    }

    for (let x = 16; x < 80; x += 1) {
      const y = 30 + Math.round(Math.sin(x / 7) * 3);
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 230;
      data[pixelIndex + 1] = 230;
      data[pixelIndex + 2] = 230;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 55, 8, 'both');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.some((mark) => {
      const cx = mark.cx * width;
      const cy = mark.cy * height;
      return cx > 20 && cx < 75 && cy > 24 && cy < 38;
    })).toBe(true);
  });

  it('does not turn isolated grain into scratch marks in scratch mode', () => {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 96;
      data[index + 1] = 88;
      data[index + 2] = 82;
      data[index + 3] = 255;
    }

    const grainPixels = [
      { x: 14, y: 14 },
      { x: 20, y: 18 },
      { x: 44, y: 24 },
      { x: 28, y: 41 },
    ];
    for (const grain of grainPixels) {
      const pixelIndex = (grain.y * width + grain.x) * 4;
      data[pixelIndex] = 220;
      data[pixelIndex + 1] = 220;
      data[pixelIndex + 2] = 220;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 55, 8, 'scratches');
    expect(marks).toHaveLength(0);
  });
});
