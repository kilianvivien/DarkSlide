import { describe, expect, it } from 'vitest';
import { getColorProfileIdFromName, identifyIccProfile } from './colorProfiles';

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function encodeUtf16Be(value: string) {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    bytes[index * 2] = (codePoint >>> 8) & 0xff;
    bytes[index * 2 + 1] = codePoint & 0xff;
  }
  return bytes;
}

function buildAppleStyleMlucIcc(label: string) {
  const labelBytes = encodeUtf16Be(label);
  const tagOffset = 144;
  const tagLength = 28 + labelBytes.length;
  const bytes = new Uint8Array(tagOffset + tagLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, bytes.length);
  view.setUint32(128, 1);
  writeAscii(bytes, 132, 'desc');
  view.setUint32(136, tagOffset);
  view.setUint32(140, tagLength);

  writeAscii(bytes, tagOffset, 'mluc');
  view.setUint32(tagOffset + 8, 1);
  view.setUint32(tagOffset + 12, 12);
  writeAscii(bytes, tagOffset + 16, 'enUS');
  view.setUint32(tagOffset + 20, labelBytes.length);
  view.setUint32(tagOffset + 24, 28);
  bytes.set(labelBytes, tagOffset + 28);

  return bytes;
}

describe('color profile detection', () => {
  it('matches common profile names with punctuation variations', () => {
    expect(getColorProfileIdFromName('Display P3')).toBe('display-p3');
    expect(getColorProfileIdFromName('DCI(P3) RGB')).toBe('display-p3');
    expect(getColorProfileIdFromName('AdobeRGB1998')).toBe('adobe-rgb');
    expect(getColorProfileIdFromName('IEC 61966-2.1')).toBe('srgb');
  });

  it('detects Display P3 from Apple-style mluc ICC labels', () => {
    const profile = identifyIccProfile(buildAppleStyleMlucIcc('Display P3'));

    expect(profile).toEqual({
      profileId: 'display-p3',
      profileName: 'Display P3',
    });
  });
});
