import { describe, expect, it } from 'vitest';
import { deltaE, labToSrgb, srgbToLab } from './colorScience';

describe('sRGB ↔ Lab conversion', () => {
  it('converts known sRGB values to Lab', () => {
    const [l, a, b] = srgbToLab(255, 0, 0);

    expect(l).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 1);
    expect(b).toBeCloseTo(67.2, 1);
  });

  it('round-trips without meaningful drift', () => {
    const original: [number, number, number] = [91, 132, 201];
    const [l, a, b] = srgbToLab(...original);
    const roundTripped = labToSrgb(l, a, b);

    expect(roundTripped[0]).toBeCloseTo(original[0], 0);
    expect(roundTripped[1]).toBeCloseTo(original[1], 0);
    expect(roundTripped[2]).toBeCloseTo(original[2], 0);
  });
});

describe('deltaE', () => {
  it('returns 0 for identical colors', () => {
    const color = srgbToLab(120, 140, 160);
    expect(deltaE(color, color)).toBe(0);
  });

  it('returns expected distance for known pairs', () => {
    const red = srgbToLab(255, 0, 0);
    const blue = srgbToLab(0, 0, 255);

    expect(deltaE(red, blue)).toBeCloseTo(176.3, 0);
  });
});
