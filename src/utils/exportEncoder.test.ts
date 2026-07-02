import { describe, expect, it } from 'vitest';
import { getColorProfileIcc } from './colorProfiles';
import { encodeExportRaster, encodePng, encodeTiff, HighBitDepthExportUnavailableError, FloatExportRaster } from './exportEncoder';

function readUint32Be(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function getPngChunks(bytes: Uint8Array) {
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function inflateStorePayload(bytes: Uint8Array) {
  const parts: Uint8Array[] = [];
  let offset = 2;
  while (offset + 5 <= bytes.length - 4) {
    const header = bytes[offset];
    const length = bytes[offset + 1] | (bytes[offset + 2] << 8);
    parts.push(bytes.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    if ((header & 1) === 1) break;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let writeOffset = 0;
  for (const part of parts) {
    result.set(part, writeOffset);
    writeOffset += part.length;
  }
  return result;
}

function getTiffEntries(bytes: Uint8Array) {
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe('II');
  expect(readUint16Le(bytes, 2)).toBe(42);
  const ifdOffset = readUint32Le(bytes, 4);
  const count = readUint16Le(bytes, ifdOffset);
  const entries = new Map<number, { type: number; count: number; value: number }>();
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    entries.set(readUint16Le(bytes, offset), {
      type: readUint16Le(bytes, offset + 2),
      count: readUint32Le(bytes, offset + 4),
      value: readUint32Le(bytes, offset + 8),
    });
  }
  return entries;
}

const floatRaster: FloatExportRaster = {
  width: 2,
  height: 1,
  data: new Float32Array([
    0, 0.5, 1,
    1 / 65_535, 32_768 / 65_535, 65_534 / 65_535,
  ]),
};

describe('exportEncoder', () => {
  it('encodes 16-bit RGB PNG with iCCP and big-endian samples', () => {
    const bytes = encodePng(floatRaster, 16, getColorProfileIcc('linear'), 'Linear RGB');
    expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const chunks = getPngChunks(bytes);
    const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
    expect(ihdr).toBeTruthy();
    expect(readUint32Be(ihdr!, 0)).toBe(2);
    expect(readUint32Be(ihdr!, 4)).toBe(1);
    expect(ihdr![8]).toBe(16);
    expect(ihdr![9]).toBe(2);
    expect(chunks.some((chunk) => chunk.type === 'iCCP')).toBe(true);

    const idat = chunks.find((chunk) => chunk.type === 'IDAT')?.data;
    const scanline = inflateStorePayload(idat!);
    expect(scanline[0]).toBe(0);
    expect(Array.from(scanline.subarray(1, 7))).toEqual([0, 0, 0x80, 0, 0xff, 0xff]);
  });

  it('encodes 16-bit baseline TIFF with ICC tag and little-endian samples', () => {
    const icc = getColorProfileIcc('adobe-rgb');
    const bytes = encodeTiff(floatRaster, 16, icc);
    const entries = getTiffEntries(bytes);

    expect(entries.get(256)?.value).toBe(2);
    expect(entries.get(257)?.value).toBe(1);
    expect(entries.get(258)?.count).toBe(3);
    expect(entries.get(34675)?.count).toBe(icc.length);

    const stripOffset = entries.get(273)?.value;
    expect(stripOffset).toBeTruthy();
    expect(readUint16Le(bytes, stripOffset!)).toBe(0);
    expect(readUint16Le(bytes, stripOffset! + 2)).toBe(32_768);
    expect(readUint16Le(bytes, stripOffset! + 4)).toBe(65_535);
  });

  it('does not allow 16-bit export from 8-bit ImageData', async () => {
    const imageData = new ImageData(new Uint8ClampedArray([0, 128, 255, 255]), 1, 1);

    await expect(encodeExportRaster(imageData, {
      format: 'image/png',
      bitDepth: 16,
      quality: 1,
      filenameBase: 'scan',
      embedMetadata: false,
      outputProfileId: 'srgb',
      embedOutputProfile: false,
      saveSidecar: false,
      targetMaxDimension: null,
    })).rejects.toBeInstanceOf(HighBitDepthExportUnavailableError);
  });
});
