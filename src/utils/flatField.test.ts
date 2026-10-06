import { describe, expect, it } from 'vitest';
import { applyFlatField, buildFlatFieldProfile, type FlatFieldProfile } from './flatField';

function srgbEncode(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function srgbDecode(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// Lens-style falloff that also tints the corners (an uneven, warm-edged panel).
function falloff(x: number, y: number, width: number, height: number, channel: number) {
  const dx = (x + 0.5) / width - 0.5;
  const dy = (y + 0.5) / height - 0.5;
  const radius2 = dx * dx + dy * dy;
  return 1 - [0.9, 1.1, 1.4][channel] * radius2;
}

function makeImage(width: number, height: number, linear: (x: number, y: number, channel: number) => number) {
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        data[(y * width + x) * 3 + channel] = Math.round(srgbEncode(Math.min(1, linear(x, y, channel))) * 65535);
      }
    }
  }
  return data;
}

const WIDTH = 600;
const HEIGHT = 400;
const PANEL = [0.6, 0.5, 0.35];

function buildReference() {
  const reference = makeImage(WIDTH, HEIGHT, (x, y, channel) => PANEL[channel] * falloff(x, y, WIDTH, HEIGHT, channel));
  const result = buildFlatFieldProfile(reference, WIDTH, HEIGHT, 'flat.nef');
  if (!result.ok) throw new Error(result.reason);
  return result.profile;
}

describe('flat-field correction', () => {
  it('evens out falloff and its colour while keeping the centre unchanged', () => {
    const profile = buildReference();
    // A uniform film base seen through the same falloff.
    const base = [0.2, 0.12, 0.03];
    const scan = makeImage(WIDTH, HEIGHT, (x, y, channel) => base[channel] * falloff(x, y, WIDTH, HEIGHT, channel));
    const before = Array.from(scan);

    expect(applyFlatField(scan, WIDTH, HEIGHT, profile)).toBe(true);

    const at = (x: number, y: number, channel: number) => srgbDecode(scan[(y * WIDTH + x) * 3 + channel] / 65535);
    for (const [x, y] of [[2, 2], [WIDTH - 3, 1], [10, HEIGHT - 5], [WIDTH - 1, HEIGHT - 1], [WIDTH / 4, HEIGHT / 3]]) {
      for (let channel = 0; channel < 3; channel += 1) {
        // Corners match the centre within 1% (0.015 stop) after a falloff of
        // up to 1.7 stops.
        expect(Math.abs(at(x, y, channel) / at(WIDTH / 2, HEIGHT / 2, channel) - 1)).toBeLessThan(0.01);
      }
    }
    // The map is normalized to the central area, so the centre barely moves.
    const centre = ((HEIGHT / 2) * WIDTH + WIDTH / 2) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(srgbDecode(scan[centre + channel] / 65535) / srgbDecode(before[centre + channel] / 65535) - 1)).toBeLessThan(0.025);
    }
    expect(profile.maxCorrectionStops).toBeGreaterThan(0.3);
  });

  it('leaves every 16-bit code untouched under a unit map', () => {
    const width = 256;
    const height = 256;
    const profile: FlatFieldProfile = {
      version: 1,
      name: 'unit',
      width,
      height,
      gridWidth: 4,
      gridHeight: 4,
      gains: new Array(4 * 4 * 3).fill(1),
      maxCorrectionStops: 0,
      createdAt: 0,
    };
    const data = new Uint16Array(width * height * 3);
    for (let index = 0; index < 65536; index += 1) data[index] = index;
    const before = data.slice();

    applyFlatField(data, width, height, profile);

    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('does not touch a scan from another camera', () => {
    const profile = buildReference();
    const scan = makeImage(WIDTH + 2, HEIGHT, () => 0.2);
    const before = scan.slice();

    expect(applyFlatField(scan, WIDTH + 2, HEIGHT, profile)).toBe(false);
    expect(scan).toEqual(before);
  });

  it('ignores a dust speck on the light source', () => {
    const clean = buildReference();
    const dusty = makeImage(WIDTH, HEIGHT, (x, y, channel) => {
      // A defocused speck: about one cell across, half as bright.
      const speck = Math.hypot(x - 160, y - 120) < 5 ? 0.5 : 1;
      return PANEL[channel] * falloff(x, y, WIDTH, HEIGHT, channel) * speck;
    });
    const result = buildFlatFieldProfile(dusty, WIDTH, HEIGHT, 'dusty.nef');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const maxDifference = result.profile.gains.reduce(
      (max, gain, index) => Math.max(max, Math.abs(gain / clean.gains[index] - 1)),
      0,
    );
    expect(maxDifference).toBeLessThan(0.02);
  });

  it('refuses references that are not a bare, well-exposed light source', () => {
    const clipped = makeImage(WIDTH, HEIGHT, () => 1);
    const dark = makeImage(WIDTH, HEIGHT, () => 0.004);
    // A negative or a picture: strong detail at the grid's scale.
    const picture = makeImage(WIDTH, HEIGHT, (x, y) => (Math.floor(x / 19) + Math.floor(y / 19)) % 2 === 0 ? 0.5 : 0.1);

    expect(buildFlatFieldProfile(clipped, WIDTH, HEIGHT, 'a')).toEqual({ ok: false, reason: 'clipped' });
    expect(buildFlatFieldProfile(dark, WIDTH, HEIGHT, 'b')).toEqual({ ok: false, reason: 'too-dark' });
    expect(buildFlatFieldProfile(picture, WIDTH, HEIGHT, 'c')).toEqual({ ok: false, reason: 'not-uniform' });
  });
});
