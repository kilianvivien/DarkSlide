import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFrame, getAutoFrameCrop, stabilizeRollFrames } from '../src/utils/frameDetection';

type Entry = { name: string; width: number; height: number; rgba_path: string };
const output = '/tmp/darkslide-film1-evaluation';
const entries = JSON.parse(readFileSync(`${output}/manifest.json`, 'utf8')) as Entry[];

describe('film1 RAW auto-crop evaluation', () => {
  for (const entry of entries) it(entry.name, () => {
    const pixels = new Uint8ClampedArray(readFileSync(entry.rgba_path));
    const frame = detectFrame(pixels, entry.width, entry.height);
    expect(frame).not.toBeNull();
    if (!frame) return;
    const aspect = ((frame.right - frame.left) * entry.width) / ((frame.bottom - frame.top) * entry.height);
    const canonicalAspect = Math.max(aspect, 1 / aspect);
    const area = (frame.right - frame.left) * (frame.bottom - frame.top);
    process.stdout.write(`${entry.name}\t${entry.width}x${entry.height}\tL${frame.left.toFixed(3)} T${frame.top.toFixed(3)} R${frame.right.toFixed(3)} B${frame.bottom.toFixed(3)}\taspect ${canonicalAspect.toFixed(3)}\tarea ${area.toFixed(3)}\n`);

    const ppm = [`P6\n${entry.width} ${entry.height}\n255\n`];
    const rgb = Buffer.alloc(entry.width * entry.height * 3);
    const left = Math.round(frame.left * (entry.width - 1));
    const right = Math.round(frame.right * (entry.width - 1));
    const top = Math.round(frame.top * (entry.height - 1));
    const bottom = Math.round(frame.bottom * (entry.height - 1));
    for (let y = 0; y < entry.height; y++) for (let x = 0; x < entry.width; x++) {
      const source = (y * entry.width + x) * 4;
      const target = (y * entry.width + x) * 3;
      const edge = (x === left || x === right) && y >= top && y <= bottom || (y === top || y === bottom) && x >= left && x <= right;
      rgb[target] = edge ? 255 : pixels[source];
      rgb[target + 1] = edge ? 0 : pixels[source + 1];
      rgb[target + 2] = edge ? 0 : pixels[source + 2];
    }
    writeFileSync(`${output}/${entry.name}.ppm`, Buffer.concat([Buffer.from(ppm[0]), rgb]));
    expect(canonicalAspect).toBeGreaterThan(1.35);
    expect(canonicalAspect).toBeLessThan(1.65);
    expect(area).toBeGreaterThan(0.45);
    for (const rotation of [0, 90, 180, 270]) {
      const crop = getAutoFrameCrop(frame, rotation);
      expect(crop.width * crop.height).toBeCloseTo(area, 8);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1.000001);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1.000001);
    }
  });

  it.each(['P1075774', 'P1075784'])('keeps the full exposed gate for %s', (name) => {
    const entry = entries.find((candidate) => candidate.name === name);
    expect(entry).toBeDefined();
    if (!entry) return;
    const frame = detectFrame(
      new Uint8ClampedArray(readFileSync(entry.rgba_path)),
      entry.width,
      entry.height,
    );
    expect(frame).not.toBeNull();
    if (!frame) return;
    expect(frame.top).toBeGreaterThan(0.075);
    expect(frame.top).toBeLessThan(0.095);
    expect(frame.bottom).toBeGreaterThan(0.86);
    expect(frame.bottom).toBeLessThan(0.88);
  });

  it('stabilizes the complete roll to one crop area', () => {
    const frames = entries.map((entry) => {
      const pixels = new Uint8ClampedArray(readFileSync(entry.rgba_path));
      return detectFrame(pixels, entry.width, entry.height);
    });
    expect(frames.every((frame) => frame !== null)).toBe(true);
    const stabilized = stabilizeRollFrames(frames.filter((frame) => frame !== null));
    const areas = stabilized.map((frame) => (frame.right - frame.left) * (frame.bottom - frame.top));
    expect(Math.max(...areas) - Math.min(...areas)).toBeLessThan(1e-10);
  });
});
