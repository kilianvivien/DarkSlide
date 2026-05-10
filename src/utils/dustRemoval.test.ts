import { describe, expect, it } from 'vitest';
import { applyDustRemoval } from './dustRemoval';

const clampInt = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

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

  it('covers the full width of a thick hair when widthAlongPath is supplied', () => {
    // Defect is 5 px wide but mark.radius is set deliberately small (1 px).
    // Without widthAlongPath the old inpainter only covers ~1.25 px around the
    // path centerline, leaving the flanks of the defect untouched. With
    // widthAlongPath the coverage scales to the measured width.
    const width = 64;
    const height = 24;
    const background = 140;
    const defect = 20;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let index = 0; index < data.length; index += 4) {
      data[index] = background;
      data[index + 1] = background;
      data[index + 2] = background;
      data[index + 3] = 255;
    }

    // Horizontal hair at y=12, 5 pixels thick (y=10..14)
    for (let x = 8; x < 56; x += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const pixelIndex = ((12 + dy) * width + x) * 4;
        data[pixelIndex] = defect;
        data[pixelIndex + 1] = defect;
        data[pixelIndex + 2] = defect;
      }
    }

    const diagonal = Math.hypot(width, height);
    const flankIndex = ((10 * width) + 30) * 4; // top edge of the defect

    // Baseline: tiny radius, no widthAlongPath — flanks remain dark.
    const baseline = new ImageData(new Uint8ClampedArray(data), width, height);
    applyDustRemoval(baseline, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [{
        id: 'hair-narrow',
        kind: 'path',
        points: [
          { x: 8 / width, y: 12 / height },
          { x: 32 / width, y: 12 / height },
          { x: 56 / width, y: 12 / height },
        ],
        radius: 1 / diagonal,
        source: 'auto',
      }],
    });
    expect(baseline.data[flankIndex]).toBeLessThan(background - 50);

    // With widthAlongPath the inpainter covers the full 5 px chord.
    const widthAware = new ImageData(new Uint8ClampedArray(data), width, height);
    applyDustRemoval(widthAware, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [{
        id: 'hair-wide',
        kind: 'path',
        points: [
          { x: 8 / width, y: 12 / height },
          { x: 32 / width, y: 12 / height },
          { x: 56 / width, y: 12 / height },
        ],
        radius: 1 / diagonal,
        widthAlongPath: [5 / diagonal, 5 / diagonal, 5 / diagonal],
        source: 'auto',
      }],
    });
    expect(widthAware.data[flankIndex]).toBeGreaterThan(background - 25);
  });

  it('preserves grain texture when repairing a hair over a noisy background', () => {
    // The structure+texture donor copy should leave the inpainted region with
    // similar local variance to the surrounding background — the visible
    // failure mode otherwise is "blurry plug" patches with no grain.
    const width = 96;
    const height = 32;
    const baseValue = 130;
    const grainAmplitude = 30; // peak-to-peak grain
    const data = new Uint8ClampedArray(width * height * 4);

    // Deterministic grain via a hashed pseudo-random
    const grain = (x: number, y: number) => {
      const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      return (h - Math.floor(h) - 0.5) * grainAmplitude;
    };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = clampInt(baseValue + grain(x, y));
        const pixelIndex = (y * width + x) * 4;
        data[pixelIndex] = value;
        data[pixelIndex + 1] = value;
        data[pixelIndex + 2] = value;
        data[pixelIndex + 3] = 255;
      }
    }

    // Horizontal hair, 3 px thick (y=15..17), spanning the middle.
    const defectValue = 22;
    for (let x = 16; x < 80; x += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const pixelIndex = ((16 + dy) * width + x) * 4;
        data[pixelIndex] = defectValue;
        data[pixelIndex + 1] = defectValue;
        data[pixelIndex + 2] = defectValue;
      }
    }

    const diagonal = Math.hypot(width, height);
    const imageData = new ImageData(data, width, height);
    applyDustRemoval(imageData, {
      autoEnabled: true,
      autoDetectMode: 'both',
      autoSensitivity: 50,
      autoMaxRadius: 8,
      manualBrushRadius: 10,
      marks: [{
        id: 'hair-grain',
        kind: 'path',
        points: [
          { x: 16 / width, y: 16 / height },
          { x: 48 / width, y: 16 / height },
          { x: 80 / width, y: 16 / height },
        ],
        radius: 1 / diagonal,
        widthAlongPath: [3 / diagonal, 3 / diagonal, 3 / diagonal],
        source: 'auto',
      }],
    });

    // Local variance of the inpainted strip vs. an adjacent untouched strip.
    const variance = (rowStart: number, rowEnd: number, xStart: number, xEnd: number) => {
      const values: number[] = [];
      for (let y = rowStart; y < rowEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) {
          values.push(imageData.data[(y * width + x) * 4]);
        }
      }
      const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
      return values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
    };

    const repairedVariance = variance(15, 18, 24, 72);
    const referenceVariance = variance(4, 7, 24, 72); // clean strip far from defect

    // Defect is gone (no near-zero pixels remain in the repaired band).
    let minRepaired = 255;
    for (let y = 15; y < 18; y += 1) {
      for (let x = 24; x < 72; x += 1) {
        minRepaired = Math.min(minRepaired, imageData.data[(y * width + x) * 4]);
      }
    }
    expect(minRepaired).toBeGreaterThan(80);

    // Variance after repair must be at least 40% of the surrounding grain
    // variance — a pure low-pass blur drops this an order of magnitude.
    expect(repairedVariance).toBeGreaterThan(referenceVariance * 0.4);
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
