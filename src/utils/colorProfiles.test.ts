import { describe, expect, it } from 'vitest';
import {
  ColorProfileConversionError,
  convertImageDataColorProfile,
  getColorProfileDescription,
  getColorProfileIdFromName,
  identifyIccProfile,
  parseInputIccProfile,
  tagPreviewImageDataColorSpace,
} from './colorProfiles';

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function writeUint16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeS15Fixed16(bytes: Uint8Array, offset: number, value: number) {
  writeUint32(bytes, offset, Math.round(value * 65_536) >>> 0);
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

function align4(value: number) {
  return (value + 3) & ~3;
}

function buildDescTag(label: string) {
  const labelBytes = new TextEncoder().encode(`${label}\0`);
  const bytes = new Uint8Array(12 + labelBytes.length);
  writeAscii(bytes, 0, 'desc');
  writeUint32(bytes, 8, labelBytes.length);
  bytes.set(labelBytes, 12);
  return bytes;
}

function buildXyzTag(vector: [number, number, number]) {
  const bytes = new Uint8Array(20);
  writeAscii(bytes, 0, 'XYZ ');
  writeS15Fixed16(bytes, 8, vector[0]);
  writeS15Fixed16(bytes, 12, vector[1]);
  writeS15Fixed16(bytes, 16, vector[2]);
  return bytes;
}

function buildGammaTag(gamma: number) {
  const bytes = new Uint8Array(14);
  writeAscii(bytes, 0, 'curv');
  writeUint32(bytes, 8, 1);
  writeUint16(bytes, 12, Math.round(gamma * 256));
  return bytes;
}

function buildMatrixTrcIcc(options: {
  label: string;
  gamma: number;
  colorantsD50?: {
    red: [number, number, number];
    green: [number, number, number];
    blue: [number, number, number];
  };
}) {
  const sRgbD50 = {
    red: [0.4360657, 0.2224884, 0.0139160] as [number, number, number],
    green: [0.3851471, 0.7168732, 0.0970764] as [number, number, number],
    blue: [0.1430664, 0.0606079, 0.7140961] as [number, number, number],
  };
  const colorants = options.colorantsD50 ?? sRgbD50;
  const tags = [
    { signature: 'desc', data: buildDescTag(options.label) },
    { signature: 'rXYZ', data: buildXyzTag(colorants.red) },
    { signature: 'gXYZ', data: buildXyzTag(colorants.green) },
    { signature: 'bXYZ', data: buildXyzTag(colorants.blue) },
    { signature: 'rTRC', data: buildGammaTag(options.gamma) },
    { signature: 'gTRC', data: buildGammaTag(options.gamma) },
    { signature: 'bTRC', data: buildGammaTag(options.gamma) },
  ];

  let offset = 128 + 4 + tags.length * 12;
  const entries = tags.map((tag) => {
    const tagOffset = offset;
    offset = align4(offset + tag.data.length);
    return { ...tag, offset: tagOffset };
  });
  const bytes = new Uint8Array(offset);
  writeUint32(bytes, 0, bytes.length);
  writeAscii(bytes, 12, 'mntr');
  writeAscii(bytes, 16, 'RGB ');
  writeAscii(bytes, 20, 'XYZ ');
  writeAscii(bytes, 36, 'acsp');
  writeUint32(bytes, 128, entries.length);
  entries.forEach((entry, index) => {
    const entryOffset = 132 + index * 12;
    writeAscii(bytes, entryOffset, entry.signature);
    writeUint32(bytes, entryOffset + 4, entry.offset);
    writeUint32(bytes, entryOffset + 8, entry.data.length);
    bytes.set(entry.data, entry.offset);
  });
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

  it('exposes Linear RGB as a manual input profile option', () => {
    expect(getColorProfileDescription('linear')).toBe('Linear RGB (gamma 1.0)');
  });

  it('maps gamma-1 matrix ICC profiles onto the built-in linear input profile', () => {
    const profile = parseInputIccProfile(buildMatrixTrcIcc({
      label: 'Lab Scanner Gamma 1',
      gamma: 1,
    }));

    expect(profile.profileName).toBe('Lab Scanner Gamma 1');
    expect(profile.profileId).toBe('linear');
    expect(profile.parsedProfile).toBeNull();
  });

  it('parses custom matrix plus gamma ICC profiles numerically when they are not built-ins', () => {
    const profile = parseInputIccProfile(buildMatrixTrcIcc({
      label: 'Scanner Custom Gamma 1.8',
      gamma: 1.8,
      colorantsD50: {
        red: [0.4860657, 0.2224884, 0.0139160],
        green: [0.3351471, 0.7168732, 0.0970764],
        blue: [0.1430664, 0.0606079, 0.7140961],
      },
    }));

    expect(profile.profileId).toBeNull();
    expect(profile.profileName).toBe('Scanner Custom Gamma 1.8');
    expect(profile.parsedProfile).toMatchObject({
      kind: 'parsed-icc',
      name: 'Scanner Custom Gamma 1.8',
      colorSpace: 'rgb',
      trc: { type: 'gamma' },
    });
    expect(profile.parsedProfile?.trc.type === 'gamma' ? profile.parsedProfile.trc.gamma : null).toBeCloseTo(1.8, 2);
    expect(profile.parsedProfile?.toXyzD65).toHaveLength(9);
  });

  it('throws a typed error for unknown profile pairs instead of silently passing pixels through', () => {
    const data = new Uint8ClampedArray([255, 128, 64, 255]);
    const imageData = new ImageData(data, 1, 1);
    expect(() => convertImageDataColorProfile(
      imageData,
      'srgb',
      'totally-bogus-profile' as never,
    )).toThrow(ColorProfileConversionError);
  });

  it('tags converted preview bytes with the canvas color space', () => {
    const source = new ImageData(new Uint8ClampedArray([25, 90, 180, 255]), 1, 1);
    const tagged = tagPreviewImageDataColorSpace(source, 'display-p3');

    expect(tagged.colorSpace).toBe('display-p3');
    expect(tagged.data).toEqual(source.data);
  });
});
