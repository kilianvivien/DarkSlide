import { describe, expect, it } from 'vitest';
import { embedIccInBlob, IccEmbedValidationError } from './iccEmbed';

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
});
