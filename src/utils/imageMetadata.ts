import piexif from 'piexifjs';
import { ColorProfileId, ExifMetadata, ExportOptions, ExportResult } from '../types';
import { getColorProfileDescription, getColorProfileIcc, identifyIccProfile } from './colorProfiles';
import { embedIccInBlob } from './iccEmbed';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_TEXT_TYPE = 'tEXt';
const PNG_IDAT_TYPE = 'IDAT';
const PNG_IEND_TYPE = 'IEND';
const WEBP_RIFF = 'RIFF';
const WEBP_FILE = 'WEBP';
const PNG_ICCP_TYPE = 'iCCP';
const JPEG_ICC_SIGNATURE = new TextEncoder().encode('ICC_PROFILE\0');
const DARKSLIDE_SOFTWARE_TAG = 'DarkSlide';
const BINARY_STRING_CHUNK_SIZE = 0x8000;

function arrayBufferToBinaryString(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let result = '';

  for (let index = 0; index < bytes.length; index += BINARY_STRING_CHUNK_SIZE) {
    const chunk = bytes.subarray(index, index + BINARY_STRING_CHUNK_SIZE);
    result += String.fromCharCode(...chunk);
  }

  return result;
}

async function blobToBinaryString(blob: Blob) {
  return arrayBufferToBinaryString(await blob.arrayBuffer());
}

function binaryStringToUint8Array(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function binaryStringToBlob(value: string, type: string) {
  return new Blob([binaryStringToUint8Array(value)], { type });
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(target: Uint8Array, offset: number) {
  return (
    (target[offset] << 24)
    | (target[offset + 1] << 16)
    | (target[offset + 2] << 8)
    | target[offset + 3]
  ) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }

  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createPngTextChunkBytes(key: string, value: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${key}\0${value}`);
  const type = encoder.encode(PNG_TEXT_TYPE);
  const chunk = new Uint8Array(4 + type.length + data.length + 4);

  writeUint32(chunk, 0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  writeUint32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));

  return chunk;
}

function getExifField(data: Record<number, unknown>, key: number) {
  const value = data[key];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function readUint16(target: Uint8Array, offset: number) {
  return ((target[offset] << 8) | target[offset + 1]) >>> 0;
}

function bytesToAscii(bytes: Uint8Array) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

function extractJpegIccProfile(bytes: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let expectedChunkCount = 0;
  let offset = 2;

  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const segmentLength = readUint16(bytes, offset + 2);
    const nextOffset = offset + 2 + segmentLength;
    if (nextOffset > bytes.length || segmentLength < 2) {
      break;
    }

    const isIccSegment = marker === 0xe2
      && segmentLength >= JPEG_ICC_SIGNATURE.length + 4
      && JPEG_ICC_SIGNATURE.every((byte, index) => bytes[offset + 4 + index] === byte);

    if (isIccSegment) {
      const chunkIndex = bytes[offset + 4 + JPEG_ICC_SIGNATURE.length] ?? 1;
      const chunkCount = bytes[offset + 5 + JPEG_ICC_SIGNATURE.length] ?? 1;
      const dataStart = offset + 6 + JPEG_ICC_SIGNATURE.length;
      chunks[chunkIndex - 1] = bytes.subarray(dataStart, nextOffset);
      expectedChunkCount = Math.max(expectedChunkCount, chunkCount);
    }

    offset = nextOffset;
  }

  if (!chunks.length || (expectedChunkCount > 0 && chunks.filter(Boolean).length !== expectedChunkCount)) {
    return null;
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0);
  const result = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    result.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return result;
}

function extractPngIccProfileName(bytes: Uint8Array) {
  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32(bytes, offset);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.length) {
      break;
    }

    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );

    if (chunkType === PNG_ICCP_TYPE) {
      const dataStart = offset + 8;
      let nameEnd = dataStart;
      while (nameEnd < dataStart + chunkLength && bytes[nameEnd] !== 0) {
        nameEnd += 1;
      }
      return new TextDecoder().decode(bytes.subarray(dataStart, nameEnd));
    }

    offset = nextOffset;
  }

  return null;
}

function readWebpChunkLength(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function extractWebpIccProfile(bytes: Uint8Array) {
  if (bytes.length < 16 || bytesToAscii(bytes.subarray(0, 4)) !== WEBP_RIFF || bytesToAscii(bytes.subarray(8, 12)) !== WEBP_FILE) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytesToAscii(bytes.subarray(offset, offset + 4));
    const chunkLength = readWebpChunkLength(bytes, offset + 4);
    const dataStart = offset + 8;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (dataStart + chunkLength > bytes.length) {
      break;
    }

    if (chunkType === 'ICCP') {
      return bytes.subarray(dataStart, dataStart + chunkLength);
    }

    offset = dataStart + paddedLength;
  }

  return null;
}

export function extractRasterColorProfile(
  buffer: ArrayBuffer,
  mime: string,
  extension: string,
): { profileId: ColorProfileId | null; profileName: string | null; unsupportedProfileName: string | null } {
  const bytes = new Uint8Array(buffer);
  const normalizedMime = mime.toLowerCase();
  const normalizedExtension = extension.toLowerCase();
  let iccProfile: Uint8Array | null = null;
  let profileName: string | null = null;

  if (normalizedExtension === '.jpg' || normalizedExtension === '.jpeg' || normalizedMime === 'image/jpeg') {
    iccProfile = extractJpegIccProfile(bytes);
  } else if (normalizedExtension === '.png' || normalizedMime === 'image/png') {
    profileName = extractPngIccProfileName(bytes);
  } else if (normalizedExtension === '.webp' || normalizedMime === 'image/webp') {
    iccProfile = extractWebpIccProfile(bytes);
  }

  const identified = identifyIccProfile(iccProfile, profileName);
  return {
    profileId: identified.profileId,
    profileName: identified.profileName ?? profileName,
    unsupportedProfileName: identified.profileId ? null : (profileName ?? (iccProfile ? 'Embedded ICC profile' : null)),
  };
}

export function extractExifMetadata(buffer: ArrayBuffer): ExifMetadata | undefined {
  try {
    const exif = piexif.load(arrayBufferToBinaryString(buffer));
    const zeroth = exif['0th'] ?? {};
    const exifIfd = exif.Exif ?? {};
    const orientation = getExifField(zeroth, piexif.ImageIFD.Orientation);
    const dateTimeOriginal = getExifField(exifIfd, piexif.ExifIFD.DateTimeOriginal);
    const make = getExifField(zeroth, piexif.ImageIFD.Make);
    const model = getExifField(zeroth, piexif.ImageIFD.Model);
    const software = getExifField(zeroth, piexif.ImageIFD.Software);

    const metadata: ExifMetadata = {
      ...(typeof orientation === 'number' ? { orientation } : {}),
      ...(typeof dateTimeOriginal === 'string' ? { dateTimeOriginal } : {}),
      ...(typeof make === 'string' ? { make } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof software === 'string' ? { software } : {}),
    };

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    return undefined;
  }
}

export async function injectExifIntoJpeg(blob: Blob, sourceExif?: ExifMetadata): Promise<Blob> {
  const exifData: Record<string, Record<number, unknown>> = {
    '0th': {
      [piexif.ImageIFD.Orientation]: 1,
      [piexif.ImageIFD.Software]: DARKSLIDE_SOFTWARE_TAG,
    },
    Exif: {},
  };

  if (sourceExif?.dateTimeOriginal) {
    exifData.Exif[piexif.ExifIFD.DateTimeOriginal] = sourceExif.dateTimeOriginal;
  }
  if (sourceExif?.make) {
    exifData['0th'][piexif.ImageIFD.Make] = sourceExif.make;
  }
  if (sourceExif?.model) {
    exifData['0th'][piexif.ImageIFD.Model] = sourceExif.model;
  }

  const exifBytes = piexif.dump(exifData);
  const binary = await blobToBinaryString(blob);
  return binaryStringToBlob(piexif.insert(exifBytes, binary), 'image/jpeg');
}

export async function injectPngTextChunk(blob: Blob, key: string, value: string): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return blob;
  }

  let offset = PNG_SIGNATURE.length;
  let insertOffset = bytes.length;

  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const chunkType = String.fromCharCode(
      bytes[typeOffset],
      bytes[typeOffset + 1],
      bytes[typeOffset + 2],
      bytes[typeOffset + 3],
    );

    if (chunkType === PNG_IDAT_TYPE || chunkType === PNG_IEND_TYPE) {
      insertOffset = offset;
      break;
    }

    offset = dataOffset + chunkLength + 4;
  }

  const textChunk = createPngTextChunkBytes(key, value);
  const result = new Uint8Array(bytes.length + textChunk.length);
  result.set(bytes.subarray(0, insertOffset), 0);
  result.set(textChunk, insertOffset);
  result.set(bytes.subarray(insertOffset), insertOffset + textChunk.length);
  return new Blob([result], { type: 'image/png' });
}

export async function finalizeExportBlob(
  result: ExportResult,
  options: ExportOptions,
  sourceExif?: ExifMetadata,
): Promise<ExportResult> {
  let blob = result.blob;

  if (options.embedMetadata) {
    try {
      if (options.format === 'image/jpeg') {
        blob = await injectExifIntoJpeg(blob, sourceExif);
      } else if (options.format === 'image/png') {
        blob = await injectPngTextChunk(blob, 'Software', DARKSLIDE_SOFTWARE_TAG);
      }
    } catch {
      blob = result.blob;
    }
  }

  if (options.embedOutputProfile) {
    // No silent fallback. If the ICC blob is malformed or the embed fails for
    // any other reason, we surface it to the export-path catch site (which
    // emits a diagnostic and a user toast) instead of writing a file without
    // a profile — that would leave the user with a color-corrupt archive
    // they never get warned about.
    blob = await embedIccInBlob(
      blob,
      getColorProfileIcc(options.outputProfileId),
      options.format,
      getColorProfileDescription(options.outputProfileId),
    );
  }

  return {
    ...result,
    blob,
  };
}

export const __testExports = {
  arrayBufferToBinaryString,
  blobToBinaryString,
  extractJpegIccProfile,
  extractPngIccProfileName,
  extractWebpIccProfile,
};
