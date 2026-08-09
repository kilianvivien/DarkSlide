import { CUBE_LUT_MAX_SIZE, CUBE_LUT_MIN_SIZE } from '../constants';
import type { CubeLut } from '../types';
import { clamp } from './math';

// ---------------------------------------------------------------------------
// .cube (Adobe/Iridas Cube LUT) parsing and serialization.
//
// Data rows are stored red-fastest: index = r + g * size + b * size * size.
// Only 3D LUTs are supported — a 1D LUT (LUT_1D_SIZE) cannot express the
// channel cross-talk that a negative conversion needs, so it is rejected
// rather than silently upsampled.
// ---------------------------------------------------------------------------

export class CubeLutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeLutParseError';
  }
}

const TITLE_PATTERN = /^TITLE\s+(.*)$/i;
const MAX_TITLE_LENGTH = 120;

function parseTriplet(tokens: string[], keyword: string): [number, number, number] {
  if (tokens.length !== 3) {
    throw new CubeLutParseError(`${keyword} needs three numbers.`);
  }

  const values = tokens.map((token) => Number.parseFloat(token));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new CubeLutParseError(`${keyword} contains a value that is not a number.`);
  }

  return [values[0], values[1], values[2]];
}

function sanitizeTitle(raw: string) {
  // TITLE values are conventionally quoted; strip the quotes and any control
  // characters so the string is safe to use as a preset name.
  const unquoted = raw.trim().replace(/^"(.*)"$/, '$1');
  // eslint-disable-next-line no-control-regex
  return unquoted.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * Parses a .cube file into a 3D LUT.
 *
 * Throws `CubeLutParseError` with a user-facing message when the file is not a
 * usable 3D LUT.
 */
export function parseCubeLut(text: string): CubeLut {
  let size: number | null = null;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let entryCount = 0;

  const lines = text.split(/\r\n|\r|\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const titleMatch = TITLE_PATTERN.exec(trimmed);
    if (titleMatch) {
      title = sanitizeTitle(titleMatch[1]) || undefined;
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    const keyword = tokens[0].toUpperCase();

    if (keyword === 'LUT_1D_SIZE') {
      throw new CubeLutParseError('This is a 1D LUT. DarkSlide needs a 3D LUT (LUT_3D_SIZE).');
    }

    if (keyword === 'LUT_3D_SIZE') {
      const parsed = Number.parseInt(tokens[1] ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < CUBE_LUT_MIN_SIZE || parsed > CUBE_LUT_MAX_SIZE) {
        throw new CubeLutParseError(
          `LUT_3D_SIZE must be between ${CUBE_LUT_MIN_SIZE} and ${CUBE_LUT_MAX_SIZE}.`,
        );
      }
      if (size !== null) {
        throw new CubeLutParseError('The file declares LUT_3D_SIZE more than once.');
      }

      size = parsed;
      data = new Float32Array(parsed * parsed * parsed * 3);
      continue;
    }

    if (keyword === 'DOMAIN_MIN') {
      domainMin = parseTriplet(tokens.slice(1), 'DOMAIN_MIN');
      continue;
    }

    if (keyword === 'DOMAIN_MAX') {
      domainMax = parseTriplet(tokens.slice(1), 'DOMAIN_MAX');
      continue;
    }

    if (keyword === 'LUT_3D_INPUT_RANGE' || keyword === 'LUT_1D_INPUT_RANGE') {
      // Legacy Iridas spelling of the domain; two values applied to all channels.
      const values = tokens.slice(1).map((token) => Number.parseFloat(token));
      if (values.length === 2 && values.every((value) => Number.isFinite(value))) {
        domainMin = [values[0], values[0], values[0]];
        domainMax = [values[1], values[1], values[1]];
      }
      continue;
    }

    // Anything else must be a data row.
    if (size === null || data === null) {
      throw new CubeLutParseError('Table data appears before LUT_3D_SIZE.');
    }

    const triplet = parseTriplet(tokens, `Line ${lineIndex + 1}`);
    if (entryCount >= size * size * size) {
      throw new CubeLutParseError(`The table has more than the ${size ** 3} rows LUT_3D_SIZE declares.`);
    }

    data[entryCount * 3] = triplet[0];
    data[entryCount * 3 + 1] = triplet[1];
    data[entryCount * 3 + 2] = triplet[2];
    entryCount += 1;
  }

  if (size === null || data === null) {
    throw new CubeLutParseError('No LUT_3D_SIZE found — this is not a 3D .cube LUT.');
  }

  if (entryCount !== size * size * size) {
    throw new CubeLutParseError(
      `The table has ${entryCount} rows but LUT_3D_SIZE ${size} needs ${size ** 3}.`,
    );
  }

  for (let channel = 0; channel < 3; channel += 1) {
    if (!(domainMax[channel] > domainMin[channel])) {
      throw new CubeLutParseError('DOMAIN_MAX must be greater than DOMAIN_MIN on every channel.');
    }
  }

  return { size, title, domainMin, domainMax, data };
}

/**
 * Samples a 3D LUT with trilinear interpolation. Inputs outside the domain are
 * clamped to the edge of the cube, matching how .cube LUTs are applied by
 * Resolve and Premiere.
 */
export function sampleCubeLut(
  lut: CubeLut,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const { size, data, domainMin, domainMax } = lut;
  const last = size - 1;

  const normalizedR = clamp((r - domainMin[0]) / (domainMax[0] - domainMin[0]), 0, 1) * last;
  const normalizedG = clamp((g - domainMin[1]) / (domainMax[1] - domainMin[1]), 0, 1) * last;
  const normalizedB = clamp((b - domainMin[2]) / (domainMax[2] - domainMin[2]), 0, 1) * last;

  const r0 = Math.min(Math.floor(normalizedR), last);
  const g0 = Math.min(Math.floor(normalizedG), last);
  const b0 = Math.min(Math.floor(normalizedB), last);
  const r1 = Math.min(r0 + 1, last);
  const g1 = Math.min(g0 + 1, last);
  const b1 = Math.min(b0 + 1, last);

  const fr = normalizedR - r0;
  const fg = normalizedG - g0;
  const fb = normalizedB - b0;

  // Red is the fastest-varying axis in .cube ordering.
  const planeStride = size * size;
  const base000 = (r0 + g0 * size + b0 * planeStride) * 3;
  const base100 = (r1 + g0 * size + b0 * planeStride) * 3;
  const base010 = (r0 + g1 * size + b0 * planeStride) * 3;
  const base110 = (r1 + g1 * size + b0 * planeStride) * 3;
  const base001 = (r0 + g0 * size + b1 * planeStride) * 3;
  const base101 = (r1 + g0 * size + b1 * planeStride) * 3;
  const base011 = (r0 + g1 * size + b1 * planeStride) * 3;
  const base111 = (r1 + g1 * size + b1 * planeStride) * 3;

  const out: [number, number, number] = [0, 0, 0];

  for (let channel = 0; channel < 3; channel += 1) {
    const c00 = data[base000 + channel] * (1 - fr) + data[base100 + channel] * fr;
    const c10 = data[base010 + channel] * (1 - fr) + data[base110 + channel] * fr;
    const c01 = data[base001 + channel] * (1 - fr) + data[base101 + channel] * fr;
    const c11 = data[base011 + channel] * (1 - fr) + data[base111 + channel] * fr;

    const c0 = c00 * (1 - fg) + c10 * fg;
    const c1 = c01 * (1 - fg) + c11 * fg;

    out[channel] = c0 * (1 - fb) + c1 * fb;
  }

  return out;
}

/**
 * A short content signature, used to keep render caches keyed by profile id
 * honest when a preset is overwritten with a different LUT under the same id.
 * FNV-1a over a strided sample of the table — cheap enough to run per render.
 */
export function cubeLutSignature(lut: CubeLut): string {
  let hash = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(lut.data.length / 4096));

  for (let index = 0; index < lut.data.length; index += stride) {
    hash ^= Math.round(lut.data[index] * 65535) & 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }

  return `${lut.size}:${lut.domainMin.join(',')}:${lut.domainMax.join(',')}:${(hash >>> 0).toString(36)}`;
}

/**
 * True when the LUT maps black to a bright value — the signature of a
 * negative-to-positive conversion LUT.
 */
export function isInvertingCubeLut(lut: CubeLut) {
  const [r, g, b] = sampleCubeLut(lut, lut.domainMin[0], lut.domainMin[1], lut.domainMin[2]);
  return (r + g + b) / 3 > 0.5;
}

function formatComponent(value: number) {
  return value.toFixed(6);
}

export function serializeCubeLut(lut: CubeLut, generatorComment?: string): string {
  const lines: string[] = [];

  if (generatorComment) {
    lines.push(`# ${generatorComment}`);
  }

  if (lut.title) {
    lines.push(`TITLE "${lut.title.replace(/"/g, '')}"`);
  }

  lines.push('');
  lines.push(`LUT_3D_SIZE ${lut.size}`);
  lines.push(`DOMAIN_MIN ${lut.domainMin.map(formatComponent).join(' ')}`);
  lines.push(`DOMAIN_MAX ${lut.domainMax.map(formatComponent).join(' ')}`);
  lines.push('');

  const entries = lut.size ** 3;
  for (let index = 0; index < entries; index += 1) {
    lines.push([
      formatComponent(lut.data[index * 3]),
      formatComponent(lut.data[index * 3 + 1]),
      formatComponent(lut.data[index * 3 + 2]),
    ].join(' '));
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON transport (.darkslide preset files cannot carry a Float32Array).
// Values are quantized to 16 bits, which is finer than any display or export
// path DarkSlide has, and keeps a 35³ LUT around 250 KB before base64.
// ---------------------------------------------------------------------------

export interface SerializedCubeLut {
  size: number;
  title?: string;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  encoding: 'uint16-base64';
  /** Quantization range: stored value = round((v - offset) / scale * 65535). */
  offset: number;
  scale: number;
  data: string;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function serializeCubeLutForJson(lut: CubeLut): SerializedCubeLut {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < lut.data.length; index += 1) {
    const value = lut.data[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  // LUTs are usually 0..1; widening the range only when a file exceeds it keeps
  // the common case at full 16-bit precision over the useful interval.
  const offset = Math.min(0, min);
  const scale = Math.max(1, max - offset);

  const quantized = new Uint16Array(lut.data.length);
  for (let index = 0; index < lut.data.length; index += 1) {
    quantized[index] = clamp(Math.round(((lut.data[index] - offset) / scale) * 65535), 0, 65535);
  }

  return {
    size: lut.size,
    title: lut.title,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
    encoding: 'uint16-base64',
    offset,
    scale,
    data: bytesToBase64(new Uint8Array(quantized.buffer)),
  };
}

function isTriplet(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function deserializeCubeLutFromJson(raw: unknown): CubeLut | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Partial<SerializedCubeLut>;
  if (
    typeof value.size !== 'number'
    || !Number.isInteger(value.size)
    || value.size < CUBE_LUT_MIN_SIZE
    || value.size > CUBE_LUT_MAX_SIZE
    || value.encoding !== 'uint16-base64'
    || typeof value.data !== 'string'
    || typeof value.offset !== 'number'
    || typeof value.scale !== 'number'
    || !Number.isFinite(value.offset)
    || !Number.isFinite(value.scale)
    || value.scale <= 0
    || !isTriplet(value.domainMin)
    || !isTriplet(value.domainMax)
  ) {
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value.data);
  } catch {
    return null;
  }

  const expectedLength = value.size ** 3 * 3;
  if (bytes.length !== expectedLength * 2) {
    return null;
  }

  const quantized = new Uint16Array(bytes.buffer, bytes.byteOffset, expectedLength);
  const data = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    data[index] = (quantized[index] / 65535) * value.scale + value.offset;
  }

  for (let channel = 0; channel < 3; channel += 1) {
    if (!(value.domainMax[channel] > value.domainMin[channel])) {
      return null;
    }
  }

  return {
    size: value.size,
    title: typeof value.title === 'string' ? sanitizeTitle(value.title) || undefined : undefined,
    domainMin: value.domainMin,
    domainMax: value.domainMax,
    data,
  };
}

/**
 * Structural check for a LUT rehydrated from IndexedDB, where the payload
 * survives as a real Float32Array.
 */
export function isValidCubeLut(value: unknown): value is CubeLut {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const lut = value as Partial<CubeLut>;
  return (
    typeof lut.size === 'number'
    && Number.isInteger(lut.size)
    && lut.size >= CUBE_LUT_MIN_SIZE
    && lut.size <= CUBE_LUT_MAX_SIZE
    && isTriplet(lut.domainMin)
    && isTriplet(lut.domainMax)
    && lut.data instanceof Float32Array
    && lut.data.length === lut.size ** 3 * 3
  );
}
