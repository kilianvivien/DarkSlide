import { describe, expect, it } from 'vitest';
import { formatAspectRatio } from './aspectRatio';

describe('formatAspectRatio', () => {
  it('uses familiar whole-number ratios when dimensions match them', () => {
    expect(formatAspectRatio(3840, 5120)).toBe('3:4');
    expect(formatAspectRatio(800, 400)).toBe('2:1');
    expect(formatAspectRatio(900, 600)).toBe('3:2');
  });

  it('uses a compact decimal for arbitrary dimensions', () => {
    expect(formatAspectRatio(137, 100)).toBe('1.37:1');
  });
});
