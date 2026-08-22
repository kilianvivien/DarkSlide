import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import UTIF from 'utif';
import { describe, expect, it } from 'vitest';
import {
  deltaE00,
  evaluateDataset,
  formatMarkdown,
  samplePatch,
  srgbToLabD50,
} from './color-accuracy.mjs';

describe('CIEDE2000', () => {
  const publishedPairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
    [[50, -0.001, 2.49], [50, 0.0012, -2.49], 4.7461],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1],
    [[50, 2.5, 0], [50, 3.2972, 0], 1],
    [[50, 2.5, 0], [50, 1.8634, 0.5757], 1],
    [[50, 2.5, 0], [50, 3.2592, 0.335], 1],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  ];

  it.each(publishedPairs)('matches the Sharma reference pair', (first, second, expected) => {
    expect(deltaE00(first, second)).toBeCloseTo(expected, 4);
  });
});

describe('sRGB to D50 Lab', () => {
  it('maps white to neutral L* 100', () => {
    const [l, a, b] = srgbToLabD50([255, 255, 255]);
    expect(l).toBeCloseTo(100, 3);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it('uses the D50-adapted sRGB red reference', () => {
    const lab = srgbToLabD50([255, 0, 0]);
    expect(lab[0]).toBeCloseTo(54.29, 1);
    expect(lab[1]).toBeCloseTo(80.81, 1);
    expect(lab[2]).toBeCloseTo(69.89, 1);
  });
});

describe('evaluation report', () => {
  it('summarizes patches and enforces dataset thresholds', async () => {
    const report = await evaluateDataset({
      schemaVersion: 1,
      id: 'unit-test',
      referenceWhite: 'D50',
      referenceObserver: '2-degree',
      capture: {
        filmStock: 'Test stock',
        profileId: 'test-profile',
        profileVersion: 1,
        profileIntent: 'technical',
        filmBaseMode: 'locked',
        settingsSource: 'profile-defaults',
        lightSourceId: null,
        labStyleId: null,
      },
      thresholds: { meanDeltaE00: 0.5, maxDeltaE00: 0.5 },
      patches: [
        { id: 'gray', category: 'neutral', referenceLab: [50, 0, 0], observedLab: [50, 0, 0] },
        { id: 'red', category: 'color', referenceLab: [54.29, 80.81, 69.89], observedSrgb: [255, 0, 0] },
      ],
    });
    expect(report.summary.patchCount).toBe(2);
    expect(report.summary.neutralMeanDeltaE00).toBe(0);
    expect(report.passed).toBe(true);
    expect(formatMarkdown(report)).toContain('Mean CIEDE2000');
    expect(formatMarkdown(report)).toContain('test-profile v1');
  });

  it('averages TIFF samples in linear light and ignores transparent pixels', () => {
    const sample = samplePatch({
      width: 3,
      height: 1,
      rgba: new Uint8Array([
        0, 0, 0, 255,
        255, 255, 255, 255,
        255, 0, 0, 0,
      ]),
    }, [0, 0, 1, 1]);
    expect(sample.sampledPixels).toBe(2);
    expect(sample.observedSrgb[0]).toBeCloseTo(187.5, 1);
    expect(sample.observedLab[0]).toBeCloseTo(76.07, 1);
    expect(sample.observedLab[1]).toBeCloseTo(0, 1);
  });

  it('reads and measures an exported TIFF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'darkslide-color-'));
    const filename = join(directory, 'chart.tif');
    try {
      const rgba = new Uint8Array([
        255, 0, 0, 255,
        255, 0, 0, 255,
        255, 0, 0, 255,
        255, 0, 0, 255,
      ]);
      await writeFile(filename, new Uint8Array(UTIF.encodeImage(rgba, 2, 2)));
      const report = await evaluateDataset({
        schemaVersion: 1,
        id: 'tiff-test',
        referenceWhite: 'D50',
        referenceObserver: '2-degree',
        patches: [{
          id: 'red',
          category: 'color',
          referenceLab: [54.29, 80.81, 69.89],
          sampleRect: [0, 0, 1, 1],
        }],
      }, { image: filename });
      expect(report.patches[0].sampledPixels).toBe(4);
      expect(report.patches[0].deltaE00).toBeLessThan(0.01);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
