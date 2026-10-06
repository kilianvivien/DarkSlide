// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePng, encodePngBlob, encodeTiff, encodeTiffBlob } from './exportEncoder';
import { getColorProfileIcc } from './colorProfiles';

function pngData(bytes: Uint8Array) {
  const parts: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(parts));
}

describe('streaming lossless exports', () => {
  const raster = { width: 512, height: 400, data: Float32Array.from({ length: 512 * 400 * 3 }, (_, i) => ((i % 3) + 1) / 4) };
  const icc = getColorProfileIcc('linear');
  it('compresses PNG scanlines without changing any 16-bit RGB sample', async () => {
    const expected = encodePng(raster, 16, icc, 'Linear RGB');
    const actual = new Uint8Array(await (await encodePngBlob(raster, 16, icc, 'Linear RGB')).arrayBuffer());
    expect(pngData(actual).equals(pngData(expected))).toBe(true);
    expect(actual.length).toBeLessThan(expected.length / 20);
  });
  it('keeps TIFF bytes identical across multiple bounded RGB strips', async () => {
    const expected = encodeTiff(raster, 16, icc);
    const actual = new Uint8Array(await encodeTiffBlob(raster, 16, icc).arrayBuffer());
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });
});
