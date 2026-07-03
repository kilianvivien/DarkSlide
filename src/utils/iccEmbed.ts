import { ExportFormat } from '../types';
import { buildPngChunk, concatUint8Arrays, deflateStore, readUint32Le, writeUint32Le } from './binaryEncoding';

const JPEG_SOI_MARKER = 0xffd8;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IHDR = 'IHDR';
const JPEG_ICC_SIGNATURE = new TextEncoder().encode('ICC_PROFILE\0');
const MAX_JPEG_ICC_CHUNK = 65_519;
const TIFF_ICC_TAG = 34675;

function readUint16(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
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

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function writeUint16Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function stripExistingJpegIccSegments(bytes: Uint8Array) {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const segmentLength = readUint16(bytes, offset + 2);
    const nextOffset = offset + 2 + segmentLength;
    if (nextOffset > bytes.length || segmentLength < 2) {
      return bytes;
    }

    const isIccSegment = marker === 0xe2
      && segmentLength >= 16
      && JPEG_ICC_SIGNATURE.every((byte, index) => bytes[offset + 4 + index] === byte);

    if (!isIccSegment) {
      parts.push(bytes.subarray(offset, nextOffset));
    }

    offset = nextOffset;
  }

  parts.push(bytes.subarray(offset));
  return concatUint8Arrays(parts);
}

function stripExistingPngIccChunks(bytes: Uint8Array) {
  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32(bytes, offset);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.length) {
      return bytes;
    }

    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );

    if (chunkType !== 'iCCP') {
      parts.push(bytes.subarray(offset, nextOffset));
    }

    offset = nextOffset;
  }

  return concatUint8Arrays(parts);
}

export async function embedIccInJpeg(jpegBlob: Blob, iccProfile: Uint8Array) {
  const sourceBytes = stripExistingJpegIccSegments(new Uint8Array(await jpegBlob.arrayBuffer()));
  if (sourceBytes.length < 2 || readUint16(sourceBytes, 0) !== JPEG_SOI_MARKER) {
    return jpegBlob;
  }

  const chunkCount = Math.ceil(iccProfile.length / MAX_JPEG_ICC_CHUNK);
  const segments: Uint8Array[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunk = iccProfile.subarray(
      chunkIndex * MAX_JPEG_ICC_CHUNK,
      (chunkIndex + 1) * MAX_JPEG_ICC_CHUNK,
    );
    const payload = new Uint8Array(JPEG_ICC_SIGNATURE.length + 2 + chunk.length);
    payload.set(JPEG_ICC_SIGNATURE, 0);
    payload[JPEG_ICC_SIGNATURE.length] = chunkIndex + 1;
    payload[JPEG_ICC_SIGNATURE.length + 1] = chunkCount;
    payload.set(chunk, JPEG_ICC_SIGNATURE.length + 2);

    const segment = new Uint8Array(4 + payload.length);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    writeUint16(segment, 2, payload.length + 2);
    segment.set(payload, 4);
    segments.push(segment);
  }

  const result = concatUint8Arrays([
    sourceBytes.subarray(0, 2),
    ...segments,
    sourceBytes.subarray(2),
  ]);

  return new Blob([result], { type: 'image/jpeg' });
}

export async function embedIccInPng(pngBlob: Blob, iccProfile: Uint8Array, profileName = 'ICC Profile') {
  const sourceBytes = stripExistingPngIccChunks(new Uint8Array(await pngBlob.arrayBuffer()));
  if (sourceBytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => sourceBytes[index] === byte)) {
    return pngBlob;
  }

  const offset = PNG_SIGNATURE.length;
  if (offset + 12 > sourceBytes.length) {
    return pngBlob;
  }

  const ihdrLength = readUint32(sourceBytes, offset);
  const ihdrType = String.fromCharCode(
    sourceBytes[offset + 4],
    sourceBytes[offset + 5],
    sourceBytes[offset + 6],
    sourceBytes[offset + 7],
  );
  if (ihdrType !== PNG_IHDR) {
    return pngBlob;
  }

  const ihdrEnd = offset + 12 + ihdrLength;
  const encodedProfileName = new TextEncoder().encode(`${profileName}\0`);
  const compressedProfile = deflateStore(iccProfile);
  const chunkData = new Uint8Array(encodedProfileName.length + 1 + compressedProfile.length);
  chunkData.set(encodedProfileName, 0);
  chunkData[encodedProfileName.length] = 0;
  chunkData.set(compressedProfile, encodedProfileName.length + 1);
  const iccChunk = buildPngChunk('iCCP', chunkData);

  const result = concatUint8Arrays([
    sourceBytes.subarray(0, ihdrEnd),
    iccChunk,
    sourceBytes.subarray(ihdrEnd),
  ]);

  return new Blob([result], { type: 'image/png' });
}

function getTiffEndian(bytes: Uint8Array) {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x49 && bytes[1] === 0x49) return 'le' as const;
  if (bytes[0] === 0x4d && bytes[1] === 0x4d) return 'be' as const;
  return null;
}

function readTiffUint16(bytes: Uint8Array, offset: number, endian: 'le' | 'be') {
  return endian === 'le' ? readUint16Le(bytes, offset) : readUint16(bytes, offset);
}

function readTiffUint32(bytes: Uint8Array, offset: number, endian: 'le' | 'be') {
  return endian === 'le' ? readUint32Le(bytes, offset) : readUint32(bytes, offset);
}

function writeTiffUint16(bytes: Uint8Array, offset: number, value: number, endian: 'le' | 'be') {
  if (endian === 'le') {
    writeUint16Le(bytes, offset, value);
  } else {
    writeUint16(bytes, offset, value);
  }
}

function writeTiffUint32(bytes: Uint8Array, offset: number, value: number, endian: 'le' | 'be') {
  if (endian === 'le') {
    writeUint32Le(bytes, offset, value);
  } else {
    writeUint32(bytes, offset, value);
  }
}

export async function embedIccInTiff(tiffBlob: Blob, iccProfile: Uint8Array) {
  const sourceBytes = new Uint8Array(await tiffBlob.arrayBuffer());
  const endian = getTiffEndian(sourceBytes);
  if (!endian) {
    throw new IccEmbedValidationError('TIFF ICC embedding requires a valid TIFF byte-order marker.', 'image/tiff');
  }
  if (readTiffUint16(sourceBytes, 2, endian) !== 42) {
    throw new IccEmbedValidationError('TIFF ICC embedding requires a baseline TIFF header.', 'image/tiff');
  }

  const ifdOffset = readTiffUint32(sourceBytes, 4, endian);
  if (ifdOffset + 2 > sourceBytes.length) {
    throw new IccEmbedValidationError('TIFF ICC embedding could not read the first IFD.', 'image/tiff');
  }

  const entryCount = readTiffUint16(sourceBytes, ifdOffset, endian);
  const entriesStart = ifdOffset + 2;
  const entriesEnd = entriesStart + entryCount * 12;
  if (entriesEnd + 4 > sourceBytes.length) {
    throw new IccEmbedValidationError('TIFF ICC embedding found a truncated IFD.', 'image/tiff');
  }

  const entries: Uint8Array[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesStart + index * 12;
    if (readTiffUint16(sourceBytes, entryOffset, endian) !== TIFF_ICC_TAG) {
      entries.push(sourceBytes.slice(entryOffset, entryOffset + 12));
    }
  }

  const newIfdOffset = sourceBytes.length;
  const newEntryCount = entries.length + 1;
  const newIfdLength = 2 + newEntryCount * 12 + 4;
  const iccOffset = newIfdOffset + newIfdLength;
  const newIfd = new Uint8Array(newIfdLength + iccProfile.length);
  writeTiffUint16(newIfd, 0, newEntryCount, endian);

  const iccEntry = new Uint8Array(12);
  writeTiffUint16(iccEntry, 0, TIFF_ICC_TAG, endian);
  writeTiffUint16(iccEntry, 2, 7, endian);
  writeTiffUint32(iccEntry, 4, iccProfile.length, endian);
  writeTiffUint32(iccEntry, 8, iccOffset, endian);
  entries.push(iccEntry);
  entries.sort((left, right) => readTiffUint16(left, 0, endian) - readTiffUint16(right, 0, endian));

  entries.forEach((entry, index) => {
    newIfd.set(entry, 2 + index * 12);
  });
  writeTiffUint32(newIfd, 2 + newEntryCount * 12, 0, endian);
  newIfd.set(iccProfile, newIfdLength);

  const result = concatUint8Arrays([sourceBytes, newIfd]);
  writeTiffUint32(result, 4, newIfdOffset, endian);
  return new Blob([result], { type: 'image/tiff' });
}

function readFourCc(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function createWebpChunk(type: string, payload: Uint8Array) {
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  chunk.set(new TextEncoder().encode(type), 0);
  writeUint32Le(chunk, 4, payload.length);
  chunk.set(payload, 8);
  return chunk;
}

export async function embedIccInWebp(webpBlob: Blob, iccProfile: Uint8Array) {
  const sourceBytes = new Uint8Array(await webpBlob.arrayBuffer());
  if (
    sourceBytes.length < 12
    || readFourCc(sourceBytes, 0) !== 'RIFF'
    || readFourCc(sourceBytes, 8) !== 'WEBP'
  ) {
    throw new IccEmbedValidationError('WebP ICC embedding requires a valid RIFF WEBP container.', 'image/webp');
  }

  const chunks: Uint8Array[] = [sourceBytes.subarray(12, 12)];
  let offset = 12;
  while (offset + 8 <= sourceBytes.length) {
    const chunkSize = readUint32Le(sourceBytes, offset + 4);
    const nextOffset = offset + 8 + chunkSize + (chunkSize % 2);
    if (nextOffset > sourceBytes.length) {
      throw new IccEmbedValidationError('WebP ICC embedding found a truncated chunk.', 'image/webp');
    }
    if (readFourCc(sourceBytes, offset) !== 'ICCP') {
      chunks.push(sourceBytes.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }

  const body = concatUint8Arrays([createWebpChunk('ICCP', iccProfile), ...chunks.slice(1)]);
  const result = new Uint8Array(12 + body.length);
  result.set(new TextEncoder().encode('RIFF'), 0);
  writeUint32Le(result, 4, result.length - 8);
  result.set(new TextEncoder().encode('WEBP'), 8);
  result.set(body, 12);
  return new Blob([result], { type: 'image/webp' });
}

// Minimum-length sanity checks on an ICC v2/v4 profile blob. Returns null if
// the blob is acceptable, or a human-readable reason otherwise. We don't try
// to fully parse the tag table — we just confirm it isn't trivially malformed
// before stamping it into the output container, where a bad profile would
// produce a file that looks valid but has wrong colors.
//
// Layout reference: ICC.1:2010, section 7.2 (profile header).
function validateIccProfile(iccProfile: Uint8Array): string | null {
  if (iccProfile.length < 132) {
    return 'ICC profile is too short (must be at least 132 bytes for the header).';
  }
  const declaredSize = (
    (iccProfile[0] << 24)
    | (iccProfile[1] << 16)
    | (iccProfile[2] << 8)
    | iccProfile[3]
  ) >>> 0;
  if (declaredSize !== iccProfile.length) {
    return `ICC profile size header (${declaredSize}) does not match buffer length (${iccProfile.length}).`;
  }
  // Bytes 36..39 must be the ASCII tag "acsp".
  if (
    iccProfile[36] !== 0x61
    || iccProfile[37] !== 0x63
    || iccProfile[38] !== 0x73
    || iccProfile[39] !== 0x70
  ) {
    return 'ICC profile is missing the "acsp" signature at offset 36.';
  }
  return null;
}

export class IccEmbedValidationError extends Error {
  constructor(message: string, readonly format: ExportFormat) {
    super(message);
    this.name = 'IccEmbedValidationError';
  }
}

export async function embedIccInBlob(blob: Blob, iccProfile: Uint8Array, format: ExportFormat, profileName?: string) {
  const reason = validateIccProfile(iccProfile);
  if (reason) {
    throw new IccEmbedValidationError(reason, format);
  }

  if (format === 'image/jpeg') {
    return embedIccInJpeg(blob, iccProfile);
  }

  if (format === 'image/png') {
    return embedIccInPng(blob, iccProfile, profileName);
  }

  if (format === 'image/tiff') {
    return embedIccInTiff(blob, iccProfile);
  }

  if (format === 'image/webp') {
    return embedIccInWebp(blob, iccProfile);
  }

  return blob;
}
