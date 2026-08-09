import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CubeLut } from '../types';
import {
  CubeLutParseError,
  deserializeCubeLutFromJson,
  isInvertingCubeLut,
  isValidCubeLut,
  parseCubeLut,
  sampleCubeLut,
  serializeCubeLut,
  serializeCubeLutForJson,
} from './cubeLut';

function buildIdentityLut(size: number): CubeLut {
  const data = new Float32Array(size ** 3 * 3);
  const last = size - 1;

  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const index = (r + g * size + b * size * size) * 3;
        data[index] = r / last;
        data[index + 1] = g / last;
        data[index + 2] = b / last;
      }
    }
  }

  return { size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

function serializeIdentity(size: number) {
  return serializeCubeLut(buildIdentityLut(size));
}

describe('parseCubeLut', () => {
  it('parses size, title and domain', () => {
    const lut = parseCubeLut([
      '# a comment',
      'TITLE "My Look"',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0.0 0.0 0.0',
      'DOMAIN_MAX 1.0 1.0 1.0',
      ...Array.from({ length: 8 }, () => '0.5 0.5 0.5'),
    ].join('\n'));

    expect(lut.size).toBe(2);
    expect(lut.title).toBe('My Look');
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    expect(lut.data).toHaveLength(24);
  });

  it('reads the table red-fastest', () => {
    // size 2, every entry marked with a distinct red value so the ordering of
    // the rows is observable through the sampler.
    const rows: string[] = [];
    for (let b = 0; b < 2; b += 1) {
      for (let g = 0; g < 2; g += 1) {
        for (let r = 0; r < 2; r += 1) {
          rows.push(`${r} ${g} ${b}`);
        }
      }
    }

    const lut = parseCubeLut(['LUT_3D_SIZE 2', ...rows].join('\n'));

    // The second row is r=1,g=0,b=0 — if the axis order were wrong this would
    // come back as blue or green.
    expect(sampleCubeLut(lut, 1, 0, 0)).toEqual([1, 0, 0]);
    expect(sampleCubeLut(lut, 0, 1, 0)).toEqual([0, 1, 0]);
    expect(sampleCubeLut(lut, 0, 0, 1)).toEqual([0, 0, 1]);
  });

  it('rejects 1D LUTs', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 32\n0 0 0')).toThrow(CubeLutParseError);
    expect(() => parseCubeLut('LUT_1D_SIZE 32\n0 0 0')).toThrow(/3D LUT/);
  });

  it('rejects a table whose row count does not match the declared size', () => {
    const text = ['LUT_3D_SIZE 2', ...Array.from({ length: 7 }, () => '0 0 0')].join('\n');
    expect(() => parseCubeLut(text)).toThrow(/7 rows/);
  });

  it('rejects extra rows beyond the declared size', () => {
    const text = ['LUT_3D_SIZE 2', ...Array.from({ length: 9 }, () => '0 0 0')].join('\n');
    expect(() => parseCubeLut(text)).toThrow(/more than the 8 rows/);
  });

  it('rejects a file with no LUT_3D_SIZE', () => {
    expect(() => parseCubeLut('# nothing here\n')).toThrow(/not a 3D .cube LUT/);
  });

  it('rejects data rows that appear before the size declaration', () => {
    expect(() => parseCubeLut('0.1 0.2 0.3\nLUT_3D_SIZE 2')).toThrow(/before LUT_3D_SIZE/);
  });

  it('rejects a degenerate domain', () => {
    const text = [
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 1.0 0.0 0.0',
      'DOMAIN_MAX 1.0 1.0 1.0',
      ...Array.from({ length: 8 }, () => '0 0 0'),
    ].join('\n');
    expect(() => parseCubeLut(text)).toThrow(/DOMAIN_MAX/);
  });

  it('rejects an out-of-range size', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 512')).toThrow(/LUT_3D_SIZE must be between/);
    expect(() => parseCubeLut('LUT_3D_SIZE 1')).toThrow(/LUT_3D_SIZE must be between/);
  });

  it('accepts CRLF line endings and blank lines', () => {
    const lut = parseCubeLut(`LUT_3D_SIZE 2\r\n\r\n${Array.from({ length: 8 }, () => '0.25 0.5 0.75').join('\r\n')}\r\n`);
    expect(lut.size).toBe(2);
    expect(sampleCubeLut(lut, 0.5, 0.5, 0.5)).toEqual([0.25, 0.5, 0.75]);
  });
});

describe('sampleCubeLut', () => {
  it('reproduces the input for an identity LUT', () => {
    const lut = buildIdentityLut(17);

    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.5, 0.25, 0.75], [0.13, 0.87, 0.42]]) {
      const [outR, outG, outB] = sampleCubeLut(lut, r, g, b);
      expect(outR).toBeCloseTo(r, 5);
      expect(outG).toBeCloseTo(g, 5);
      expect(outB).toBeCloseTo(b, 5);
    }
  });

  it('clamps inputs outside the domain to the edge of the cube', () => {
    const lut = buildIdentityLut(5);
    expect(sampleCubeLut(lut, -1, 2, 0.5)[0]).toBeCloseTo(0, 5);
    expect(sampleCubeLut(lut, -1, 2, 0.5)[1]).toBeCloseTo(1, 5);
  });

  it('honours a non-unit domain', () => {
    const lut: CubeLut = { ...buildIdentityLut(2), domainMin: [0, 0, 0], domainMax: [2, 2, 2] };
    // 1.0 sits at the midpoint of a 0..2 domain, so an identity table returns 0.5.
    expect(sampleCubeLut(lut, 1, 1, 1)[0]).toBeCloseTo(0.5, 5);
  });
});

describe('serializeCubeLut', () => {
  it('round-trips through the parser', () => {
    const original = buildIdentityLut(9);
    const reparsed = parseCubeLut(serializeCubeLut({ ...original, title: 'Round Trip' }));

    expect(reparsed.size).toBe(9);
    expect(reparsed.title).toBe('Round Trip');
    for (let index = 0; index < original.data.length; index += 1) {
      expect(reparsed.data[index]).toBeCloseTo(original.data[index], 5);
    }
  });

  it('writes exactly size^3 data rows', () => {
    const dataRows = serializeIdentity(5)
      .split('\n')
      .filter((line) => /^[\d.-]/.test(line.trim()));
    expect(dataRows).toHaveLength(125);
  });
});

describe('JSON transport', () => {
  it('round-trips a LUT through the .darkslide encoding', () => {
    const original = buildIdentityLut(11);
    const restored = deserializeCubeLutFromJson(serializeCubeLutForJson({ ...original, title: 'Encoded' }));

    expect(restored).not.toBeNull();
    expect(restored?.size).toBe(11);
    expect(restored?.title).toBe('Encoded');
    for (let index = 0; index < original.data.length; index += 1) {
      // 16-bit quantization: worst case error is 1/65535.
      expect(restored?.data[index]).toBeCloseTo(original.data[index], 4);
    }
  });

  it('preserves values outside 0..1', () => {
    const lut = buildIdentityLut(3);
    lut.data[0] = -0.4;
    lut.data[1] = 1.8;

    const restored = deserializeCubeLutFromJson(serializeCubeLutForJson(lut));
    expect(restored?.data[0]).toBeCloseTo(-0.4, 3);
    expect(restored?.data[1]).toBeCloseTo(1.8, 3);
  });

  it('rejects malformed payloads', () => {
    expect(deserializeCubeLutFromJson(null)).toBeNull();
    expect(deserializeCubeLutFromJson({ size: 4 })).toBeNull();
    expect(deserializeCubeLutFromJson({
      ...serializeCubeLutForJson(buildIdentityLut(3)),
      size: 4,
    })).toBeNull();
  });
});

describe('isValidCubeLut', () => {
  it('accepts a well-formed LUT and rejects a truncated one', () => {
    const lut = buildIdentityLut(4);
    expect(isValidCubeLut(lut)).toBe(true);
    expect(isValidCubeLut({ ...lut, data: lut.data.subarray(0, 12) })).toBe(false);
    expect(isValidCubeLut({ ...lut, data: Array.from(lut.data) })).toBe(false);
  });
});

describe('Resources/PhoenixII.cube', () => {
  const text = readFileSync(resolve(__dirname, '../../Resources/PhoenixII.cube'), 'utf-8');
  const lut = parseCubeLut(text);

  it('parses the real-world file', () => {
    expect(lut.size).toBe(35);
    expect(lut.title).toBe('PhoenixII');
    expect(lut.data).toHaveLength(35 ** 3 * 3);
  });

  it('is recognised as an inverting (negative→positive) LUT', () => {
    expect(isInvertingCubeLut(lut)).toBe(true);
    expect(sampleCubeLut(lut, 0, 0, 0)).toEqual([1, 1, 1]);
    expect(sampleCubeLut(lut, 1, 1, 1)).toEqual([0, 0, 0]);
  });

  it('survives a .cube round-trip unchanged', () => {
    const reparsed = parseCubeLut(serializeCubeLut(lut));
    expect(reparsed.size).toBe(lut.size);
    for (let index = 0; index < lut.data.length; index += 1) {
      expect(reparsed.data[index]).toBeCloseTo(lut.data[index], 5);
    }
  });
});
