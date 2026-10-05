import { describe, expect, it } from 'vitest';
import { createDustScene, scoreDustScene } from '../test/dustScene';
import { detectDustMarks } from './dustDetection';

function createFlatField(width: number, height: number, value = 96) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value - 6;
    data[index + 2] = value - 12;
    data[index + 3] = 255;
  }
  return data;
}

function hasSpotNear(marks: ReturnType<typeof detectDustMarks>, width: number, height: number, targetX: number, targetY: number) {
  return marks.some((mark) => (
    mark.kind === 'spot'
    && Math.hypot(mark.cx * width - targetX, mark.cy * height - targetY) < 5
  ));
}

describe('detectDustMarks', () => {
  it('detects bright dust-like specks on a flat field as spot marks', () => {
    const width = 64;
    const height = 64;
    const data = createFlatField(width, height, 84);

    for (const spot of [{ x: 18, y: 22 }, { x: 44, y: 38 }]) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const x = spot.x + offsetX;
          const y = spot.y + offsetY;
          const pixelIndex = (y * width + x) * 4;
          data[pixelIndex] = 240;
          data[pixelIndex + 1] = 240;
          data[pixelIndex + 2] = 240;
        }
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 68, 6, 'spots');

    expect(marks.every((mark) => mark.source === 'auto')).toBe(true);
    expect(marks.filter((mark) => mark.kind === 'spot').length).toBeGreaterThanOrEqual(2);
    expect(hasSpotNear(marks, width, height, 18, 22)).toBe(true);
    expect(hasSpotNear(marks, width, height, 44, 38)).toBe(true);
  });

  it('rejects a strong image edge instead of flagging it as dust', () => {
    const width = 96;
    const height = 96;
    const data = createFlatField(width, height, 80);

    for (let y = 0; y < height; y += 1) {
      for (let x = 48; x < width; x += 1) {
        const pixelIndex = (y * width + x) * 4;
        data[pixelIndex] = 220;
        data[pixelIndex + 1] = 215;
        data[pixelIndex + 2] = 210;
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 45, 8, 'spots');
    expect(marks).toHaveLength(0);
  });

  it('detects a long straight scratch as a single path mark', () => {
    const width = 120;
    const height = 120;
    const data = createFlatField(width, height, 96);

    for (let x = 18; x < 102; x += 1) {
      const y = 58 + Math.round(Math.sin(x / 12));
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 232;
      data[pixelIndex + 1] = 232;
      data[pixelIndex + 2] = 232;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 52, 8, 'scratches');
    const pathMarks = marks.filter((mark) => mark.kind === 'path');

    expect(pathMarks.length).toBeGreaterThanOrEqual(1);
    expect(pathMarks.some((mark) => (
      mark.points[0].x < 0.3
      && mark.points[mark.points.length - 1].x > 0.7
    ))).toBe(true);
  });

  it('detects a curved border-near hair as a path mark', () => {
    const width = 110;
    const height = 110;
    const data = createFlatField(width, height, 90);

    for (let y = 16; y < 94; y += 1) {
      const x = 8 + Math.round(Math.sin(y / 10) * 5);
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 18;
      data[pixelIndex + 1] = 18;
      data[pixelIndex + 2] = 18;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 58, 9, 'scratches');
    expect(marks.some((mark) => (
      mark.kind === 'path'
      && mark.points.some((point) => point.x < 0.15)
    ))).toBe(true);
  });

  it('rejects pure grain as dust, even at high sensitivity', () => {
    // A flat field with pseudo-random per-pixel grain should produce no
    // detections — every grain "peak" looks like every other one. The
    // fallback peak detector used to fire on these and is the dominant
    // false-positive source on real scans.
    const width = 96;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);
    const base = 110;
    const amplitude = 22;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const noise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const offset = (noise - Math.floor(noise) - 0.5) * amplitude;
        const value = Math.max(0, Math.min(255, Math.round(base + offset)));
        const pixelIndex = (y * width + x) * 4;
        data[pixelIndex] = value;
        data[pixelIndex + 1] = value;
        data[pixelIndex + 2] = value;
        data[pixelIndex + 3] = 255;
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 80, 6, 'both');
    expect(marks).toHaveLength(0);
  });

  it('preserves subtle speck detection on high-resolution scans after downsampling', () => {
    const width = 4096;
    const height = 3072;
    const data = createFlatField(width, height, 82);
    const centerX = 1740;
    const centerY = 1290;

    for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        const pixelIndex = ((centerY + offsetY) * width + centerX + offsetX) * 4;
        data[pixelIndex] = 240;
        data[pixelIndex + 1] = 240;
        data[pixelIndex + 2] = 240;
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 70, 10, 'spots');
    expect(hasSpotNear(marks, width, height, centerX, centerY)).toBe(true);
  });

  function paintBlock(data: Uint8ClampedArray, width: number, x: number, y: number, size: number, color: [number, number, number]) {
    for (let offsetY = 0; offsetY < size; offsetY += 1) {
      for (let offsetX = 0; offsetX < size; offsetX += 1) {
        const pixelIndex = ((y + offsetY) * width + x + offsetX) * 4;
        data[pixelIndex] = color[0];
        data[pixelIndex + 1] = color[1];
        data[pixelIndex + 2] = color[2];
      }
    }
  }

  it('looks for dark specks on slides and ignores them on negatives', () => {
    const width = 64;
    const height = 64;
    const data = createFlatField(width, height, 150);
    paintBlock(data, width, 20, 20, 3, [10, 10, 10]);
    paintBlock(data, width, 42, 40, 3, [10, 10, 10]);

    const slideMarks = detectDustMarks(new ImageData(new Uint8ClampedArray(data), width, height), 50, 6, 'spots', { polarity: 'dark' });
    expect(hasSpotNear(slideMarks, width, height, 21, 21)).toBe(true);
    expect(hasSpotNear(slideMarks, width, height, 43, 41)).toBe(true);

    const negativeMarks = detectDustMarks(new ImageData(new Uint8ClampedArray(data), width, height), 50, 6, 'spots', { polarity: 'bright' });
    expect(negativeMarks).toHaveLength(0);
  });

  it('leaves small coloured highlights such as lit windows alone', () => {
    const width = 80;
    const height = 80;
    const data = createFlatField(width, height, 60);
    for (let y = 10; y < 70; y += 12) {
      for (let x = 10; x < 70; x += 12) {
        paintBlock(data, width, x, y, 4, [235, 205, 120]);
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 75, 6, 'both');
    expect(marks).toHaveLength(0);
  });

  it('leaves soft, lens-blurred highlights alone', () => {
    const width = 64;
    const height = 64;
    const data = createFlatField(width, height, 70);
    for (const center of [{ x: 20, y: 22 }, { x: 44, y: 40 }]) {
      for (let y = center.y - 8; y <= center.y + 8; y += 1) {
        for (let x = center.x - 8; x <= center.x + 8; x += 1) {
          const amount = 170 * Math.exp(-((x - center.x) ** 2 + (y - center.y) ** 2) / (2 * 2 * 2));
          const pixelIndex = (y * width + x) * 4;
          data[pixelIndex] += amount;
          data[pixelIndex + 1] += amount;
          data[pixelIndex + 2] += amount;
        }
      }
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 50, 6, 'spots');
    expect(marks).toHaveLength(0);
  });

  it('detects a diagonal scratch end to end', () => {
    const width = 120;
    const height = 120;
    const data = createFlatField(width, height, 90);
    for (let step = 0; step < 80; step += 1) {
      const pixelIndex = ((20 + step) * width + 20 + step) * 4;
      data[pixelIndex] = 225;
      data[pixelIndex + 1] = 225;
      data[pixelIndex + 2] = 225;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 50, 6, 'scratches');
    const path = marks.find((mark) => mark.kind === 'path');
    expect(path?.kind).toBe('path');
    if (path?.kind !== 'path') return;
    const start = path.points[0];
    const end = path.points[path.points.length - 1];
    expect(start.x).toBeLessThan(0.25);
    expect(start.y).toBeLessThan(0.25);
    expect(end.x).toBeGreaterThan(0.75);
    expect(end.y).toBeGreaterThan(0.75);
  });

  it('keeps a wavy dark branch on a negative but takes a straight dark scratch', () => {
    const width = 140;
    const height = 140;
    const data = createFlatField(width, height, 150);
    for (let y = 15; y < 125; y += 1) {
      const x = 35 + Math.round(Math.sin(y / 9) * 6);
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 30;
      data[pixelIndex + 1] = 30;
      data[pixelIndex + 2] = 30;
    }
    for (let y = 15; y < 125; y += 1) {
      const pixelIndex = (y * width + 100) * 4;
      data[pixelIndex] = 30;
      data[pixelIndex + 1] = 30;
      data[pixelIndex + 2] = 30;
    }

    const marks = detectDustMarks(new ImageData(data, width, height), 50, 6, 'scratches', { polarity: 'bright' });
    const paths = marks.filter((mark) => mark.kind === 'path');
    expect(paths.some((mark) => mark.points.every((point) => Math.abs(point.x * width - 100.5) < 2))).toBe(true);
    expect(paths.some((mark) => mark.points.some((point) => point.x * width < 50))).toBe(false);
  });

  it('finds most defects on a realistic scene without flagging picture detail', () => {
    // Grain, foliage texture, building edges, lit windows, soft highlights
    // and dark branches, with known dust, hairs and scratches on top.
    for (const polarity of ['bright', 'dark'] as const) {
      const scene = createDustScene({ seed: 1, polarity });
      const marks = detectDustMarks(new ImageData(scene.data, scene.width, scene.height), 50, 6, 'both', { polarity });
      const score = scoreDustScene(scene, marks);
      expect(score.precision).toBeGreaterThanOrEqual(0.85);
      expect(score.spotRecall).toBeGreaterThanOrEqual(polarity === 'bright' ? 0.75 : 0.55);
      expect(score.lineRecall).toBeGreaterThanOrEqual(0.6);
    }
  });
});
