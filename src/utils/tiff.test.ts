import { describe, expect, it } from 'vitest';
import { decodeTiffRaster, TiffDecodeError } from './tiff';

describe('decodeTiffRaster', () => {
  it('returns the first readable frame and skips unusable earlier entries', () => {
    const decoder = {
      decode: () => [
        { width: 0, height: 0 },
        { t256: [10], t257: [10] },
        { t256: [4], t257: [3] },
      ],
      decodeImage: (_buffer: ArrayBuffer, frame: { width?: number; height?: number; t256?: ArrayLike<number>; t257?: ArrayLike<number> }) => {
        frame.width = frame.width ?? frame.t256?.[0];
        frame.height = frame.height ?? frame.t257?.[0];
        if (frame.width === 10) {
          throw new Error('unsupported frame');
        }
      },
      toRGBA8: (frame: { width?: number; height?: number }) => new Uint8Array(Number(frame.width) * Number(frame.height) * 4),
    };

    const result = decodeTiffRaster(new ArrayBuffer(16), decoder);

    expect(result.width).toBe(4);
    expect(result.height).toBe(3);
    expect(result.frameIndex).toBe(2);
    expect(result.frameCount).toBe(3);
    expect(result.data).toHaveLength(4 * 3 * 4);
  });

  it('throws a parse error for malformed TIFF buffers', () => {
    const decoder = {
      decode: () => {
        throw new Error('bad header');
      },
      decodeImage: () => undefined,
      toRGBA8: () => new Uint8Array(),
    };

    expect(() => decodeTiffRaster(new ArrayBuffer(4), decoder)).toThrowError(
      new TiffDecodeError('TIFF_INVALID', 'The TIFF file could not be parsed.'),
    );
  });

  it('throws when no readable frames exist', () => {
    const decoder = {
      decode: () => [],
      decodeImage: () => undefined,
      toRGBA8: () => new Uint8Array(),
    };

    expect(() => decodeTiffRaster(new ArrayBuffer(4), decoder)).toThrowError(
      new TiffDecodeError('TIFF_EMPTY', 'The TIFF file does not contain any readable frames.'),
    );
  });

  it('throws a supported-layout error when the RGBA payload length is invalid', () => {
    const decoder = {
      decode: () => [{ width: 5, height: 5 }],
      decodeImage: () => undefined,
      toRGBA8: () => new Uint8Array(8),
    };

    expect(() => decodeTiffRaster(new ArrayBuffer(4), decoder)).toThrowError(
      new TiffDecodeError('TIFF_UNSUPPORTED', 'The TIFF frame could not be converted into RGBA pixel data.'),
    );
  });
});
