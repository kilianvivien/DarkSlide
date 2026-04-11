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
        cx: 0.5,
        cy: 0.5,
        radius: 2 / Math.hypot(width, height),
        source: 'manual',
      }],
    });

    expect(imageData.data[center]).toBeLessThan(200);
    expect(imageData.data[center]).toBeGreaterThanOrEqual(110);
    expect(imageData.data[center + 3]).toBe(255);
  });

  it('softens a thin bright defect when covered by overlapping manual marks', () => {
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
        { id: 'm1', cx: 0.35, cy: 0.5, radius: 4 / Math.hypot(width, height), source: 'manual' },
        { id: 'm2', cx: 0.5, cy: 0.52, radius: 4 / Math.hypot(width, height), source: 'manual' },
        { id: 'm3', cx: 0.65, cy: 0.5, radius: 4 / Math.hypot(width, height), source: 'manual' },
      ],
    });

    const centerIndex = ((10 * width) + 20) * 4;
    expect(imageData.data[centerIndex]).toBeLessThan(145);
    expect(imageData.data[centerIndex + 1]).toBeLessThan(145);
    expect(imageData.data[centerIndex + 2]).toBeLessThan(145);
  });
});
