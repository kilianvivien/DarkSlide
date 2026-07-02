import { describe, expect, it } from 'vitest';
import { embedIccInBlob, IccEmbedValidationError } from './iccEmbed';
import { encodeTiff, FloatExportRaster } from './exportEncoder';

function buildMinimalValidIccProfile(size = 132): Uint8Array {
  // Just enough bytes to satisfy the header sanity checks: declared size
  // matches buffer length and the "acsp" signature is at offset 36.
  const profile = new Uint8Array(Math.max(size, 132));
  const view = new DataView(profile.buffer);
  view.setUint32(0, profile.length);
  profile[36] = 0x61; // 'a'
  profile[37] = 0x63; // 'c'
  profile[38] = 0x73; // 's'
  profile[39] = 0x70; // 'p'
  return profile;
}

describe('embedIccInBlob ICC validation', () => {
  it('rejects a too-short ICC profile', async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
    const tiny = new Uint8Array(40);

    await expect(embedIccInBlob(blob, tiny, 'image/jpeg')).rejects.toBeInstanceOf(IccEmbedValidationError);
  });

  it('rejects an ICC profile whose size header does not match the buffer length', async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
    const profile = buildMinimalValidIccProfile(200);
    // Lie about the size in the header.
    new DataView(profile.buffer).setUint32(0, 999_999);

    await expect(embedIccInBlob(blob, profile, 'image/jpeg')).rejects.toMatchObject({
      name: 'IccEmbedValidationError',
    });
  });

  it('rejects an ICC profile missing the "acsp" signature', async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
    const profile = buildMinimalValidIccProfile(200);
    profile[36] = 0; // smash signature

    await expect(embedIccInBlob(blob, profile, 'image/jpeg')).rejects.toMatchObject({
      message: expect.stringContaining('acsp'),
    });
  });

  it('passes through unrelated blob formats without validating', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/tiff' });
    // ICC bytes are deliberately invalid — for non-jpeg/png formats the
    // function should still validate (the validation is the contract).
    const tiny = new Uint8Array(40);

    await expect(embedIccInBlob(blob, tiny, 'image/tiff')).rejects.toBeInstanceOf(IccEmbedValidationError);
  });

  it('embeds TIFF ICC data in tag 34675', async () => {
    const raster: FloatExportRaster = {
      width: 1,
      height: 1,
      data: new Float32Array([0.25, 0.5, 0.75]),
    };
    const tiff = new Blob([encodeTiff(raster, 8)], { type: 'image/tiff' });
    const profile = buildMinimalValidIccProfile(200);

    const embedded = new Uint8Array(await (await embedIccInBlob(tiff, profile, 'image/tiff')).arrayBuffer());
    const ifdOffset = embedded[4] | (embedded[5] << 8) | (embedded[6] << 16) | (embedded[7] << 24);
    const count = embedded[ifdOffset] | (embedded[ifdOffset + 1] << 8);
    let iccCount = 0;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = embedded[entryOffset] | (embedded[entryOffset + 1] << 8);
      if (tag === 34675) {
        iccCount = embedded[entryOffset + 4]
          | (embedded[entryOffset + 5] << 8)
          | (embedded[entryOffset + 6] << 16)
          | (embedded[entryOffset + 7] << 24);
      }
    }

    expect(iccCount).toBe(profile.length);
  });

  it('replaces WebP ICC chunks while preserving RIFF WEBP structure', async () => {
    const oldProfile = buildMinimalValidIccProfile(160);
    const newProfile = buildMinimalValidIccProfile(220);
    const vp8Payload = new Uint8Array([1, 2, 3, 4]);
    const oldIccChunk = buildWebpChunk('ICCP', oldProfile);
    const vp8Chunk = buildWebpChunk('VP8 ', vp8Payload);
    const bodyLength = 4 + oldIccChunk.length + vp8Chunk.length;
    const webp = new Uint8Array(8 + bodyLength);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    writeUint32Le(webp, 4, bodyLength);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    webp.set(oldIccChunk, 12);
    webp.set(vp8Chunk, 12 + oldIccChunk.length);

    const embedded = new Uint8Array(await (await embedIccInBlob(
      new Blob([webp], { type: 'image/webp' }),
      newProfile,
      'image/webp',
    )).arrayBuffer());

    expect(String.fromCharCode(...embedded.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...embedded.subarray(8, 12))).toBe('WEBP');
    expect(String.fromCharCode(...embedded.subarray(12, 16))).toBe('ICCP');
    expect(readUint32Le(embedded, 16)).toBe(newProfile.length);
    expect(String.fromCharCode(...embedded.subarray(20 + newProfile.length + (newProfile.length % 2), 24 + newProfile.length + (newProfile.length % 2)))).toBe('VP8 ');
  });
});

function writeUint32Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24);
}

function buildWebpChunk(type: string, payload: Uint8Array) {
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  chunk.set(new TextEncoder().encode(type), 0);
  writeUint32Le(chunk, 4, payload.length);
  chunk.set(payload, 8);
  return chunk;
}
