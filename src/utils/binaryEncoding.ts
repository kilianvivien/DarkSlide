export function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

export function readUint16Be(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

export function writeUint16Be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

export function writeUint16Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUint32Be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function readUint32Be(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

export function writeUint32Le(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
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

export function crc32(data: Uint8Array) {
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

export function deflateStore(data: Uint8Array) {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;

  while (offset < data.length) {
    const chunkLength = Math.min(65_535, data.length - offset);
    const isFinalBlock = offset + chunkLength >= data.length;
    const block = new Uint8Array(5 + chunkLength);

    block[0] = isFinalBlock ? 0x01 : 0x00;
    writeUint16Le(block, 1, chunkLength);
    writeUint16Le(block, 3, (~chunkLength) & 0xffff);
    block.set(data.subarray(offset, offset + chunkLength), 5);

    blocks.push(block);
    offset += chunkLength;
  }

  const checksum = new Uint8Array(4);
  writeUint32Be(checksum, 0, adler32(data));
  blocks.push(checksum);

  return concatUint8Arrays(blocks);
}

export function buildPngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(4 + typeBytes.length + data.length + 4);

  writeUint32Be(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32Be(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));

  return chunk;
}
