import { ExportFormat } from '../types';

const JPEG_SOI_MARKER = 0xffd8;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IHDR = 'IHDR';
const ICC_CHUNK_PROFILE_NAME = 'sRGB';
const JPEG_ICC_SIGNATURE = new TextEncoder().encode('ICC_PROFILE\0');
const MAX_JPEG_ICC_CHUNK = 65_519;

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

function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
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

function adler32(data: Uint8Array) {
  let a = 1;
  let b = 0;

  for (let index = 0; index < data.length; index += 1) {
    a = (a + data[index]) % 65_521;
    b = (b + a) % 65_521;
  }

  return ((b << 16) | a) >>> 0;
}

function deflateStore(data: Uint8Array) {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;

  while (offset < data.length) {
    const chunkLength = Math.min(65_535, data.length - offset);
    const isFinalBlock = offset + chunkLength >= data.length;
    const block = new Uint8Array(5 + chunkLength);

    block[0] = isFinalBlock ? 0x01 : 0x00;
    writeUint16(block, 1, chunkLength);
    writeUint16(block, 3, (~chunkLength) & 0xffff);
    block.set(data.subarray(offset, offset + chunkLength), 5);

    blocks.push(block);
    offset += chunkLength;
  }

  const checksum = new Uint8Array(4);
  writeUint32(checksum, 0, adler32(data));
  blocks.push(checksum);

  return concatUint8Arrays(blocks);
}

function buildPngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(4 + typeBytes.length + data.length + 4);

  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));

  return chunk;
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

export async function embedIccInPng(pngBlob: Blob, iccProfile: Uint8Array) {
  const sourceBytes = stripExistingPngIccChunks(new Uint8Array(await pngBlob.arrayBuffer()));
  if (sourceBytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => sourceBytes[index] === byte)) {
    return pngBlob;
  }

  let offset = PNG_SIGNATURE.length;
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
  const profileName = new TextEncoder().encode(`${ICC_CHUNK_PROFILE_NAME}\0`);
  const compressedProfile = deflateStore(iccProfile);
  const chunkData = new Uint8Array(profileName.length + 1 + compressedProfile.length);
  chunkData.set(profileName, 0);
  chunkData[profileName.length] = 0;
  chunkData.set(compressedProfile, profileName.length + 1);
  const iccChunk = buildPngChunk('iCCP', chunkData);

  const result = concatUint8Arrays([
    sourceBytes.subarray(0, ihdrEnd),
    iccChunk,
    sourceBytes.subarray(ihdrEnd),
  ]);

  return new Blob([result], { type: 'image/png' });
}

export async function embedIccInBlob(blob: Blob, iccProfile: Uint8Array, format: ExportFormat) {
  if (format === 'image/jpeg') {
    return embedIccInJpeg(blob, iccProfile);
  }

  if (format === 'image/png') {
    return embedIccInPng(blob, iccProfile);
  }

  return blob;
}
