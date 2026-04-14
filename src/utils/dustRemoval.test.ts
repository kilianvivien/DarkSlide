import { describe, expect, it } from 'vitest';
import { applyDustRemoval } from './dustRemoval';

describe('applyDustRemoval', () => {
  it('blends a bright dust speck back toward its surroundings', () => {
    const width = 11;
    const height = 11;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 120;
      data[index + 1] = 120;
      data[index + 2] = 120;
      data[index + 3] = 255;
    }

    const center = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
    data[center] = 255;
    data[center + 1] = 255;
    data[center + 2] = 255;

    const imageData = new ImageData(data, width, height);
    applyDustRemoval(imageData, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [{
        id: 'manual-1',
        kind: 'spot',
        cx: 0.5,
        cy: 0.5,
        radius: 2 / Math.hypot(width, height),
        source: 'manual',
      }],
    });

    expect(imageData.data[center]).toBeLessThan(190);
    expect(imageData.data[center]).toBeGreaterThanOrEqual(110);
    expect(imageData.data[center + 3]).toBe(255);
  });

  it('softens a thin bright defect when covered by overlapping manual spot marks', () => {
    const width = 40;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 110;
      data[index + 1] = 110;
      data[index + 2] = 110;
      data[index + 3] = 255;
    }

    for (let x = 10; x <= 29; x += 1) {
      const y = 10 + Math.round(Math.sin(x / 4));
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 245;
      data[pixelIndex + 1] = 245;
      data[pixelIndex + 2] = 245;
    }

    const imageData = new ImageData(data, width, height);
    applyDustRemoval(imageData, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [
        { id: 'm1', kind: 'spot', cx: 0.35, cy: 0.5, radius: 4 / Math.hypot(width, height), source: 'manual' },
        { id: 'm2', kind: 'spot', cx: 0.5, cy: 0.52, radius: 4 / Math.hypot(width, height), source: 'manual' },
        { id: 'm3', kind: 'spot', cx: 0.65, cy: 0.5, radius: 4 / Math.hypot(width, height), source: 'manual' },
      ],
    });

    const centerIndex = ((10 * width) + 20) * 4;
    expect(imageData.data[centerIndex]).toBeLessThan(145);
    expect(imageData.data[centerIndex + 1]).toBeLessThan(145);
    expect(imageData.data[centerIndex + 2]).toBeLessThan(145);
  });

  it('repairs a long hair continuously from a single path mark', () => {
    const width = 80;
    const height = 48;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = 130;
      data[index + 1] = 128;
      data[index + 2] = 126;
      data[index + 3] = 255;
    }

    for (let x = 16; x < 64; x += 1) {
      const y = 22 + Math.round(Math.sin(x / 6) * 3);
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = 18;
      data[pixelIndex + 1] = 18;
      data[pixelIndex + 2] = 18;
    }

    const imageData = new ImageData(data, width, height);
    applyDustRemoval(imageData, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [{
        id: 'hair-1',
        kind: 'path',
        points: [
          { x: 16 / width, y: 20 / height },
          { x: 32 / width, y: 24 / height },
          { x: 48 / width, y: 20 / height },
          { x: 64 / width, y: 25 / height },
        ],
        radius: 2.5 / Math.hypot(width, height),
        source: 'auto',
      }],
    });

    const sampleBefore = 18;
    const sampleAfterIndex = ((22 * width) + 40) * 4;
    expect(imageData.data[sampleAfterIndex]).toBeGreaterThan(sampleBefore + 40);
    expect(imageData.data[sampleAfterIndex + 1]).toBeGreaterThan(sampleBefore + 40);
    expect(imageData.data[sampleAfterIndex + 2]).toBeGreaterThan(sampleBefore + 40);
  });
});
