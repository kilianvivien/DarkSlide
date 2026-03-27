import { ColorProfileId } from '../types';

const D50_WHITE_POINT: [number, number, number] = [0.9642, 1, 0.8249];
const D65_WHITE_POINT: [number, number, number] = [0.95047, 1, 1.08883];
const BRADFORD = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
] as const;
const BRADFORD_INVERSE = [
  0.9869929, -0.1470543, 0.1599627,
  0.4323053, 0.5183603, 0.0492912,
  -0.0085287, 0.0400428, 0.9684867,
] as const;

const PROFILE_DESCRIPTIONS: Record<ColorProfileId, string> = {
  srgb: 'sRGB IEC61966-2.1',
  'display-p3': 'Display P3',
  'adobe-rgb': 'Adobe RGB (1998)',
};

const PROFILE_COPYRIGHTS: Record<ColorProfileId, string> = {
  srgb: 'DarkSlide generated sRGB profile',
  'display-p3': 'DarkSlide generated Display P3 profile',
  'adobe-rgb': 'DarkSlide generated Adobe RGB (1998) profile',
};

const LINEAR_TO_XYZ_D65: Record<ColorProfileId, readonly number[]> = {
  srgb: [
    0.4124564, 0.3575761, 0.1804375,
    0.2126729, 0.7151522, 0.0721750,
    0.0193339, 0.1191920, 0.9503041,
  ],
  'display-p3': [
    0.48657095, 0.26566769, 0.19821729,
    0.22897456, 0.69173852, 0.07928691,
    0.00000000, 0.04511338, 1.04394437,
  ],
  'adobe-rgb': [
    0.5767309, 0.1855540, 0.1881852,
    0.2973769, 0.6273491, 0.0752741,
    0.0270343, 0.0706872, 0.9911085,
  ],
};

const XYZ_D65_TO_LINEAR: Record<ColorProfileId, readonly number[]> = {
  srgb: [
    3.2404542, -1.5371385, -0.4985314,
    -0.9692660, 1.8760108, 0.0415560,
    0.0556434, -0.2040259, 1.0572252,
  ],
  'display-p3': [
    2.49349691, -0.93138362, -0.40271078,
    -0.82948897, 1.76266406, 0.02362469,
    0.03584583, -0.07617239, 0.95688452,
  ],
  'adobe-rgb': [
    2.0413690, -0.5649464, -0.3446944,
    -0.9692660, 1.8760108, 0.0415560,
    0.0134474, -0.1183897, 1.0154096,
  ],
};

const iccProfileCache = new Map<ColorProfileId, Uint8Array>();
let displayP3Support: boolean | null = null;

function multiplyMatrix3x3Vector(matrix: readonly number[], vector: readonly number[]) {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ] as [number, number, number];
}

function multiplyMatrix3x3(left: readonly number[], right: readonly number[]) {
  return [
    left[0] * right[0] + left[1] * right[3] + left[2] * right[6],
    left[0] * right[1] + left[1] * right[4] + left[2] * right[7],
    left[0] * right[2] + left[1] * right[5] + left[2] * right[8],
    left[3] * right[0] + left[4] * right[3] + left[5] * right[6],
    left[3] * right[1] + left[4] * right[4] + left[5] * right[7],
    left[3] * right[2] + left[4] * right[5] + left[5] * right[8],
    left[6] * right[0] + left[7] * right[3] + left[8] * right[6],
    left[6] * right[1] + left[7] * right[4] + left[8] * right[7],
    left[6] * right[2] + left[7] * right[5] + left[8] * right[8],
  ] as [number, number, number, number, number, number, number, number, number];
}

function chromaticAdaptationMatrix(fromWhitePoint: readonly number[], toWhitePoint: readonly number[]) {
  const sourceCone = multiplyMatrix3x3Vector(BRADFORD, fromWhitePoint);
  const destCone = multiplyMatrix3x3Vector(BRADFORD, toWhitePoint);
  const scale = [
    destCone[0] / sourceCone[0], 0, 0,
    0, destCone[1] / sourceCone[1], 0,
    0, 0, destCone[2] / sourceCone[2],
  ] as const;
  return multiplyMatrix3x3(BRADFORD_INVERSE, multiplyMatrix3x3(scale, BRADFORD));
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function encodeText(value: string) {
  return new TextEncoder().encode(value);
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
  const fixed = Math.round(value * 65_536);
  writeUint32(bytes, offset, fixed >>> 0);
}

function buildTextTag(text: string) {
  const value = encodeText(text);
  const bytes = new Uint8Array(8 + value.length);
  bytes.set(encodeText('text'), 0);
  bytes.set(value, 8);
  return bytes;
}

function buildDescTag(text: string) {
  const value = encodeText(`${text}\0`);
  const bytes = new Uint8Array(90 + value.length);
  bytes.set(encodeText('desc'), 0);
  writeUint32(bytes, 8, value.length);
  bytes.set(value, 12);
  writeUint32(bytes, 12 + value.length, 0);
  writeUint32(bytes, 16 + value.length, 0);
  writeUint16(bytes, 20 + value.length, 0);
  bytes[22 + value.length] = 0;
  return bytes;
}

function buildXyzTag(x: number, y: number, z: number) {
  const bytes = new Uint8Array(20);
  bytes.set(encodeText('XYZ '), 0);
  writeS15Fixed16(bytes, 8, x);
  writeS15Fixed16(bytes, 12, y);
  writeS15Fixed16(bytes, 16, z);
  return bytes;
}

function buildGammaCurveTag(gamma: number) {
  const bytes = new Uint8Array(14);
  bytes.set(encodeText('curv'), 0);
  writeUint32(bytes, 8, 1);
  writeUint16(bytes, 12, Math.round(gamma * 256));
  return bytes;
}

function align4(value: number) {
  return (value + 3) & ~3;
}

function createIccProfile(profileId: ColorProfileId) {
  const description = PROFILE_DESCRIPTIONS[profileId];
  const colorantMatrix = multiplyMatrix3x3(
    chromaticAdaptationMatrix(D65_WHITE_POINT, D50_WHITE_POINT),
    LINEAR_TO_XYZ_D65[profileId],
  );
  const gamma = profileId === 'adobe-rgb' ? 2.19921875 : 2.2;
  const tags = [
    { signature: 'desc', data: buildDescTag(description) },
    { signature: 'cprt', data: buildTextTag(PROFILE_COPYRIGHTS[profileId]) },
    { signature: 'wtpt', data: buildXyzTag(D50_WHITE_POINT[0], D50_WHITE_POINT[1], D50_WHITE_POINT[2]) },
    { signature: 'rXYZ', data: buildXyzTag(colorantMatrix[0], colorantMatrix[3], colorantMatrix[6]) },
    { signature: 'gXYZ', data: buildXyzTag(colorantMatrix[1], colorantMatrix[4], colorantMatrix[7]) },
    { signature: 'bXYZ', data: buildXyzTag(colorantMatrix[2], colorantMatrix[5], colorantMatrix[8]) },
    { signature: 'rTRC', data: buildGammaCurveTag(gamma) },
    { signature: 'gTRC', data: buildGammaCurveTag(gamma) },
    { signature: 'bTRC', data: buildGammaCurveTag(gamma) },
  ];

  const tagTableLength = 4 + tags.length * 12;
  let offset = 128 + tagTableLength;
  const tagEntries = tags.map((tag) => {
    const currentOffset = offset;
    offset = align4(offset + tag.data.length);
    return { ...tag, offset: currentOffset };
  });

  const bytes = new Uint8Array(offset);
  writeUint32(bytes, 0, bytes.length);
  bytes.set(encodeText('DSLD'), 4);
  bytes[8] = 0x02;
  bytes[9] = 0x30;
  bytes.set(encodeText('mntr'), 12);
  bytes.set(encodeText('RGB '), 16);
  bytes.set(encodeText('XYZ '), 20);
  bytes.set(encodeText('acsp'), 36);
  bytes.set(encodeText('DSLD'), 80);
  writeS15Fixed16(bytes, 68, D50_WHITE_POINT[0]);
  writeS15Fixed16(bytes, 72, D50_WHITE_POINT[1]);
  writeS15Fixed16(bytes, 76, D50_WHITE_POINT[2]);

  writeUint32(bytes, 128, tagEntries.length);
  tagEntries.forEach((tag, index) => {
    const entryOffset = 132 + index * 12;
    bytes.set(encodeText(tag.signature), entryOffset);
    writeUint32(bytes, entryOffset + 4, tag.offset);
    writeUint32(bytes, entryOffset + 8, tag.data.length);
    bytes.set(tag.data, tag.offset);
  });

  return bytes;
}

function bytesToAscii(bytes: Uint8Array) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

function normalizeProfileSearchText(value: string) {
  return value.replace(/\0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function readUint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }

  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function sliceBytes(bytes: Uint8Array, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    return null;
  }

  return bytes.subarray(offset, offset + length);
}

function decodeUtf16Be(bytes: Uint8Array) {
  let result = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    result += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  }
  return result;
}

function extractDescTagText(tagBytes: Uint8Array) {
  const asciiLength = readUint32(tagBytes, 8);
  if (!asciiLength || asciiLength <= 1) {
    return [];
  }

  const asciiBytes = sliceBytes(tagBytes, 12, asciiLength - 1);
  return asciiBytes ? [bytesToAscii(asciiBytes)] : [];
}

function extractMlucTagText(tagBytes: Uint8Array) {
  const recordCount = readUint32(tagBytes, 8);
  const recordSize = readUint32(tagBytes, 12);
  if (!recordCount || !recordSize || recordSize < 12) {
    return [];
  }

  const texts: string[] = [];
  const safeRecordCount = Math.min(recordCount, 16);
  for (let index = 0; index < safeRecordCount; index += 1) {
    const recordOffset = 16 + index * recordSize;
    const textLength = readUint32(tagBytes, recordOffset + 4);
    const textOffset = readUint32(tagBytes, recordOffset + 8);
    if (!textLength || textOffset === null) {
      continue;
    }

    const textBytes = sliceBytes(tagBytes, textOffset, textLength);
    if (!textBytes || textBytes.length < 2) {
      continue;
    }

    const decoded = decodeUtf16Be(textBytes).replace(/\0/g, ' ').trim();
    if (decoded) {
      texts.push(decoded);
    }
  }

  return texts;
}

function extractIccProfileLabels(iccBytes: Uint8Array | null | undefined) {
  if (!iccBytes || iccBytes.length < 144) {
    return [];
  }

  const tagCount = readUint32(iccBytes, 128);
  if (!tagCount) {
    return [];
  }

  const labels: string[] = [];
  const safeTagCount = Math.min(tagCount, 32);
  for (let index = 0; index < safeTagCount; index += 1) {
    const entryOffset = 132 + index * 12;
    const tagOffset = readUint32(iccBytes, entryOffset + 4);
    const tagLength = readUint32(iccBytes, entryOffset + 8);
    if (tagOffset === null || tagLength === null || tagLength < 12) {
      continue;
    }

    const tagBytes = sliceBytes(iccBytes, tagOffset, tagLength);
    if (!tagBytes) {
      continue;
    }

    const tagType = bytesToAscii(tagBytes.subarray(0, 4));
    if (tagType === 'desc') {
      labels.push(...extractDescTagText(tagBytes));
    } else if (tagType === 'mluc') {
      labels.push(...extractMlucTagText(tagBytes));
    }
  }

  return labels;
}

export function getColorProfileDescription(profileId: ColorProfileId) {
  return PROFILE_DESCRIPTIONS[profileId];
}

export function getColorProfileIcc(profileId: ColorProfileId) {
  const cached = iccProfileCache.get(profileId);
  if (cached) {
    return cached;
  }

  const generated = createIccProfile(profileId);
  iccProfileCache.set(profileId, generated);
  return generated;
}

export function getColorProfileIdFromName(name: string | null | undefined): ColorProfileId | null {
  if (!name) {
    return null;
  }

  const normalized = normalizeProfileSearchText(name);
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (
    normalized.includes('display p3')
    || normalized.includes('display-p3')
    || normalized.includes('dci p3')
    || normalized.includes('dci(p3)')
    || compact.includes('displayp3')
    || compact.includes('dcip3')
  ) {
    return 'display-p3';
  }
  if (normalized.includes('adobe rgb') || compact.includes('adobergb')) {
    return 'adobe-rgb';
  }
  if (normalized.includes('srgb') || normalized.includes('iec61966-2.1') || compact.includes('iec6196621')) {
    return 'srgb';
  }
  return null;
}

export function identifyIccProfile(iccBytes: Uint8Array | null | undefined, fallbackName?: string | null) {
  if ((!iccBytes || iccBytes.length === 0) && !fallbackName) {
    return { profileId: null, profileName: null };
  }

  const candidates = [
    ...(fallbackName ? [{ value: fallbackName, preserveName: true }] : []),
    ...extractIccProfileLabels(iccBytes).map((value) => ({ value, preserveName: true })),
    ...(iccBytes ? [{ value: bytesToAscii(iccBytes), preserveName: false }] : []),
  ];

  const match = candidates.find((candidate) => getColorProfileIdFromName(candidate.value));
  const profileId = match ? getColorProfileIdFromName(match.value) : null;
  return {
    profileId,
    profileName: profileId
      ? (match?.preserveName ? match.value : PROFILE_DESCRIPTIONS[profileId])
      : (fallbackName ?? null),
  };
}

function decodeChannel(profileId: ColorProfileId, value: number) {
  const normalized = clamp01(value);
  if (profileId === 'adobe-rgb') {
    return normalized ** 2.19921875;
  }
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

function encodeChannel(profileId: ColorProfileId, value: number) {
  const normalized = clamp01(value);
  if (profileId === 'adobe-rgb') {
    return normalized ** (1 / 2.19921875);
  }
  if (normalized <= 0.0031308) {
    return normalized * 12.92;
  }
  return 1.055 * (normalized ** (1 / 2.4)) - 0.055;
}

export function getTransferMode(profileId: ColorProfileId) {
  return profileId === 'adobe-rgb' ? 1 : 0;
}

export function getLinearTransformMatrix(fromProfileId: ColorProfileId, toProfileId: ColorProfileId) {
  if (fromProfileId === toProfileId) {
    return [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ] as const;
  }

  return multiplyMatrix3x3(XYZ_D65_TO_LINEAR[toProfileId], LINEAR_TO_XYZ_D65[fromProfileId]);
}

export function convertRgbBetweenProfiles(
  r: number,
  g: number,
  b: number,
  fromProfileId: ColorProfileId,
  toProfileId: ColorProfileId,
): [number, number, number] {
  if (fromProfileId === toProfileId) {
    return [clamp01(r), clamp01(g), clamp01(b)];
  }

  const linear = [
    decodeChannel(fromProfileId, r),
    decodeChannel(fromProfileId, g),
    decodeChannel(fromProfileId, b),
  ] as const;
  const matrix = getLinearTransformMatrix(fromProfileId, toProfileId);
  const transformed = multiplyMatrix3x3Vector(matrix, linear);

  return [
    clamp01(encodeChannel(toProfileId, transformed[0])),
    clamp01(encodeChannel(toProfileId, transformed[1])),
    clamp01(encodeChannel(toProfileId, transformed[2])),
  ];
}

export function convertImageDataColorProfile(
  imageData: ImageData,
  fromProfileId: ColorProfileId,
  toProfileId: ColorProfileId,
) {
  if (fromProfileId === toProfileId) {
    return imageData;
  }

  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = convertRgbBetweenProfiles(
      data[index] / 255,
      data[index + 1] / 255,
      data[index + 2] / 255,
      fromProfileId,
      toProfileId,
    );
    data[index] = Math.round(r * 255);
    data[index + 1] = Math.round(g * 255);
    data[index + 2] = Math.round(b * 255);
  }

  return imageData;
}

export function supportsDisplayP3Canvas() {
  if (displayP3Support !== null) {
    return displayP3Support;
  }

  const globalScope = globalThis as typeof globalThis & {
    document?: {
      createElement: (tagName: 'canvas') => {
        getContext: (contextId: '2d', options?: { colorSpace?: string }) => unknown;
      };
    };
  };

  if (!globalScope.document) {
    displayP3Support = false;
    return displayP3Support;
  }

  try {
    const canvas = globalScope.document.createElement('canvas');
    const context = canvas.getContext('2d', { colorSpace: 'display-p3' });
    displayP3Support = context !== null;
  } catch {
    displayP3Support = false;
  }

  return displayP3Support;
}

export function getPreferredPreviewDisplayProfile() {
  const globalScope = globalThis as typeof globalThis & {
    matchMedia?: (query: string) => { matches: boolean };
  };

  if (typeof globalScope.matchMedia !== 'function') {
    return 'srgb' as const;
  }

  return globalScope.matchMedia('(color-gamut: p3)').matches && supportsDisplayP3Canvas()
    ? 'display-p3'
    : 'srgb';
}
