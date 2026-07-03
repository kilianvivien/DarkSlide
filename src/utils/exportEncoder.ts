import { ExportBitDepth, ExportOptions } from '../types';
import {
  buildPngChunk,
  concatUint8Arrays,
  deflateStore,
  writeUint16Be,
  writeUint16Le,
  writeUint32Be,
  writeUint32Le,
} from './binaryEncoding';
import { getColorProfileDescription, getColorProfileIcc } from './colorProfiles';
import { normalizeExportBitDepth } from './exportOptions';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export interface FloatExportRaster {
  width: number;
  height: number;
  data: Float32Array;
  channels?: 3 | 4;
}

export type ExportRaster = ImageData | FloatExportRaster;

export class HighBitDepthExportUnavailableError extends Error {
  constructor(format: ExportOptions['format']) {
    super(`${format} 16-bit export requires a high-depth render buffer. The current export path only produced 8-bit ImageData.`);
    this.name = 'HighBitDepthExportUnavailableError';
  }
}

function isImageDataRaster(raster: ExportRaster): raster is ImageData {
  return typeof ImageData !== 'undefined' && raster instanceof ImageData;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function toUint8Sample(value: number) {
  return Math.round(clamp01(value) * 255);
}

function toUint16Sample(value: number) {
  return Math.round(clamp01(value) * 65_535);
}

function getRasterSample(raster: FloatExportRaster, x: number, y: number, channel: number) {
  const channels = raster.channels ?? 3;
  return raster.data[(y * raster.width + x) * channels + channel] ?? 0;
}

function resizeFloatRaster(raster: FloatExportRaster, targetWidth: number, targetHeight: number): FloatExportRaster {
  if (raster.width === targetWidth && raster.height === targetHeight) {
    return raster;
  }

  const channels = raster.channels ?? 3;
  const data = new Float32Array(targetWidth * targetHeight * channels);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = ((y + 0.5) * raster.height / targetHeight) - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(raster.height - 1, y0 + 1);
    const fy = sourceY - y0;

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = ((x + 0.5) * raster.width / targetWidth) - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(raster.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const targetIndex = (y * targetWidth + x) * channels;

      for (let channel = 0; channel < channels; channel += 1) {
        const top = getRasterSample(raster, x0, y0, channel) * (1 - fx) + getRasterSample(raster, x1, y0, channel) * fx;
        const bottom = getRasterSample(raster, x0, y1, channel) * (1 - fx) + getRasterSample(raster, x1, y1, channel) * fx;
        data[targetIndex + channel] = top * (1 - fy) + bottom * fy;
      }
    }
  }

  return { width: targetWidth, height: targetHeight, data, channels };
}

async function resizeImageData(raster: ImageData, targetWidth: number, targetHeight: number) {
  if (raster.width === targetWidth && raster.height === targetHeight) {
    return raster;
  }

  const documentRef = (globalThis as typeof globalThis & { document?: { createElement: (tag: string) => OffscreenCanvas } }).document;
  const sourceCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(raster.width, raster.height)
    : documentRef?.createElement('canvas');
  if (!sourceCanvas) {
    throw new Error('Canvas export is unavailable in this environment.');
  }
  sourceCanvas.width = raster.width;
  sourceCanvas.height = raster.height;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) {
    throw new Error('Could not create source export canvas.');
  }
  sourceContext.putImageData(raster, 0, 0);

  const targetCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(targetWidth, targetHeight)
    : documentRef?.createElement('canvas');
  if (!targetCanvas) {
    throw new Error('Canvas export is unavailable in this environment.');
  }
  targetCanvas.width = targetWidth;
  targetCanvas.height = targetHeight;
  const targetContext = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!targetContext) {
    throw new Error('Could not create export resize canvas.');
  }
  targetContext.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
  return targetContext.getImageData(0, 0, targetWidth, targetHeight);
}

function getTargetDimensions(width: number, height: number, targetMaxDimension: number | null) {
  const longestEdge = Math.max(width, height);
  const scale = targetMaxDimension && targetMaxDimension < longestEdge ? targetMaxDimension / longestEdge : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function prepareRaster(raster: ExportRaster, targetMaxDimension: number | null) {
  const target = getTargetDimensions(raster.width, raster.height, targetMaxDimension);
  if (isImageDataRaster(raster)) {
    return resizeImageData(raster, target.width, target.height);
  }
  return resizeFloatRaster(raster, target.width, target.height);
}

function rasterToRgbBytes(raster: ExportRaster, bitDepth: ExportBitDepth) {
  if (bitDepth === 16 && isImageDataRaster(raster)) {
    throw new HighBitDepthExportUnavailableError('image/png');
  }

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const result = new Uint8Array(raster.width * raster.height * 3 * bytesPerSample);

  if (isImageDataRaster(raster)) {
    let outputIndex = 0;
    for (let index = 0; index < raster.data.length; index += 4) {
      result[outputIndex] = raster.data[index];
      result[outputIndex + 1] = raster.data[index + 1];
      result[outputIndex + 2] = raster.data[index + 2];
      outputIndex += 3;
    }
    return result;
  }

  const channels = raster.channels ?? 3;
  let outputIndex = 0;
  for (let index = 0; index < raster.width * raster.height; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = raster.data[index * channels + channel] ?? 0;
      if (bitDepth === 16) {
        writeUint16Be(result, outputIndex, toUint16Sample(value));
        outputIndex += 2;
      } else {
        result[outputIndex] = toUint8Sample(value);
        outputIndex += 1;
      }
    }
  }

  return result;
}

function rasterToTiffRgbBytes(raster: ExportRaster, bitDepth: ExportBitDepth) {
  const bytes = rasterToRgbBytes(raster, bitDepth);
  if (bitDepth === 8) {
    return bytes;
  }

  for (let offset = 0; offset < bytes.length; offset += 2) {
    const high = bytes[offset];
    bytes[offset] = bytes[offset + 1];
    bytes[offset + 1] = high;
  }
  return bytes;
}

function createCanvasFromRaster(raster: ExportRaster) {
  const documentRef = (globalThis as typeof globalThis & { document?: { createElement: (tag: string) => OffscreenCanvas } }).document;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(raster.width, raster.height)
    : documentRef?.createElement('canvas');
  if (!canvas) {
    throw new Error('Canvas export is unavailable in this environment.');
  }
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not create export canvas.');
  }

  if (isImageDataRaster(raster)) {
    context.putImageData(raster, 0, 0);
  } else {
    const data = new Uint8ClampedArray(raster.width * raster.height * 4);
    const channels = raster.channels ?? 3;
    for (let index = 0; index < raster.width * raster.height; index += 1) {
      data[index * 4] = toUint8Sample(raster.data[index * channels] ?? 0);
      data[index * 4 + 1] = toUint8Sample(raster.data[index * channels + 1] ?? 0);
      data[index * 4 + 2] = toUint8Sample(raster.data[index * channels + 2] ?? 0);
      data[index * 4 + 3] = 255;
    }
    context.putImageData(new ImageData(data, raster.width, raster.height), 0, 0);
  }

  return canvas;
}

function canvasToBlob(
  canvas: OffscreenCanvas | { toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void },
  options: { type: string; quality?: number },
) {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob(options);
  }

  const htmlCanvas = canvas as { toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void };
  return new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob((blob: Blob | null) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode export image.'));
      }
    }, options.type, options.quality);
  });
}

function createIccPngChunk(iccProfile: Uint8Array, profileName = 'ICC Profile') {
  const encodedProfileName = new TextEncoder().encode(`${profileName}\0`);
  const compressedProfile = deflateStore(iccProfile);
  const chunkData = new Uint8Array(encodedProfileName.length + 1 + compressedProfile.length);
  chunkData.set(encodedProfileName, 0);
  chunkData[encodedProfileName.length] = 0;
  chunkData.set(compressedProfile, encodedProfileName.length + 1);
  return buildPngChunk('iCCP', chunkData);
}

export function encodePng(raster: ExportRaster, bitDepth: ExportBitDepth, iccProfile?: Uint8Array | null, profileName?: string | null) {
  const rgb = rasterToRgbBytes(raster, bitDepth);
  const bytesPerRow = raster.width * 3 * (bitDepth === 16 ? 2 : 1);
  const scanlines = new Uint8Array((bytesPerRow + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    const rowOffset = y * (bytesPerRow + 1);
    scanlines[rowOffset] = 0;
    scanlines.set(rgb.subarray(y * bytesPerRow, (y + 1) * bytesPerRow), rowOffset + 1);
  }

  const ihdr = new Uint8Array(13);
  writeUint32Be(ihdr, 0, raster.width);
  writeUint32Be(ihdr, 4, raster.height);
  ihdr[8] = bitDepth;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concatUint8Arrays([
    PNG_SIGNATURE,
    buildPngChunk('IHDR', ihdr),
    ...(iccProfile ? [createIccPngChunk(iccProfile, profileName ?? undefined)] : []),
    buildPngChunk('IDAT', deflateStore(scanlines)),
    buildPngChunk('IEND', new Uint8Array()),
  ]);
}

const TIFF_TYPE_BYTE = 1;
const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_RATIONAL = 5;
const TIFF_TYPE_UNDEFINED = 7;

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  value?: number;
  data?: Uint8Array;
}

function tiffTypeSize(type: number) {
  switch (type) {
    case TIFF_TYPE_BYTE:
    case TIFF_TYPE_ASCII:
    case TIFF_TYPE_UNDEFINED:
      return 1;
    case TIFF_TYPE_SHORT:
      return 2;
    case TIFF_TYPE_LONG:
      return 4;
    case TIFF_TYPE_RATIONAL:
      return 8;
    default:
      return 1;
  }
}

function writeTiffInlineValue(bytes: Uint8Array, offset: number, entry: TiffEntry) {
  if (entry.type === TIFF_TYPE_SHORT) {
    writeUint16Le(bytes, offset, entry.value ?? 0);
    writeUint16Le(bytes, offset + 2, 0);
  } else {
    writeUint32Le(bytes, offset, entry.value ?? 0);
  }
}

function createShortArray(values: number[]) {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((value, index) => writeUint16Le(bytes, index * 2, value));
  return bytes;
}

function createRational(numerator: number, denominator: number) {
  const bytes = new Uint8Array(8);
  writeUint32Le(bytes, 0, numerator);
  writeUint32Le(bytes, 4, denominator);
  return bytes;
}

export function encodeTiff(raster: ExportRaster, bitDepth: ExportBitDepth, iccProfile?: Uint8Array | null) {
  if (bitDepth === 16 && isImageDataRaster(raster)) {
    throw new HighBitDepthExportUnavailableError('image/tiff');
  }

  const rgb = rasterToTiffRgbBytes(raster, bitDepth);
  const entries: TiffEntry[] = [
    { tag: 256, type: TIFF_TYPE_LONG, count: 1, value: raster.width },
    { tag: 257, type: TIFF_TYPE_LONG, count: 1, value: raster.height },
    { tag: 258, type: TIFF_TYPE_SHORT, count: 3, data: createShortArray([bitDepth, bitDepth, bitDepth]) },
    { tag: 259, type: TIFF_TYPE_SHORT, count: 1, value: 1 },
    { tag: 262, type: TIFF_TYPE_SHORT, count: 1, value: 2 },
    { tag: 273, type: TIFF_TYPE_LONG, count: 1, value: 0 },
    { tag: 277, type: TIFF_TYPE_SHORT, count: 1, value: 3 },
    { tag: 278, type: TIFF_TYPE_LONG, count: 1, value: raster.height },
    { tag: 279, type: TIFF_TYPE_LONG, count: 1, value: rgb.length },
    { tag: 282, type: TIFF_TYPE_RATIONAL, count: 1, data: createRational(72, 1) },
    { tag: 283, type: TIFF_TYPE_RATIONAL, count: 1, data: createRational(72, 1) },
    { tag: 284, type: TIFF_TYPE_SHORT, count: 1, value: 1 },
    { tag: 296, type: TIFF_TYPE_SHORT, count: 1, value: 2 },
    ...(iccProfile ? [{ tag: 34675, type: TIFF_TYPE_UNDEFINED, count: iccProfile.length, data: iccProfile } satisfies TiffEntry] : []),
  ].sort((left, right) => left.tag - right.tag);

  const ifdOffset = 8;
  const ifdLength = 2 + entries.length * 12 + 4;
  let dataOffset = ifdOffset + ifdLength;
  const extraData: Array<{ offset: number; data: Uint8Array }> = [];

  const entriesWithOffsets = entries.map((entry) => {
    const byteCount = entry.count * tiffTypeSize(entry.type);
    if (entry.data && byteCount > 4) {
      const currentOffset = dataOffset;
      extraData.push({ offset: currentOffset, data: entry.data });
      dataOffset += entry.data.length;
      if (dataOffset % 2 !== 0) dataOffset += 1;
      return { ...entry, value: currentOffset };
    }
    return entry;
  });

  const stripOffset = dataOffset;
  const totalLength = stripOffset + rgb.length;
  const bytes = new Uint8Array(totalLength);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  writeUint16Le(bytes, 2, 42);
  writeUint32Le(bytes, 4, ifdOffset);
  writeUint16Le(bytes, ifdOffset, entriesWithOffsets.length);

  entriesWithOffsets.forEach((entry, index) => {
    const entryOffset = ifdOffset + 2 + index * 12;
    writeUint16Le(bytes, entryOffset, entry.tag);
    writeUint16Le(bytes, entryOffset + 2, entry.type);
    writeUint32Le(bytes, entryOffset + 4, entry.count);
    if (entry.tag === 273) {
      writeUint32Le(bytes, entryOffset + 8, stripOffset);
    } else if (entry.data && entry.count * tiffTypeSize(entry.type) <= 4) {
      bytes.set(entry.data, entryOffset + 8);
    } else {
      writeTiffInlineValue(bytes, entryOffset + 8, entry);
    }
  });

  writeUint32Le(bytes, ifdOffset + 2 + entriesWithOffsets.length * 12, 0);
  for (const part of extraData) {
    bytes.set(part.data, part.offset);
  }
  bytes.set(rgb, stripOffset);
  return bytes;
}

export interface EncodedExport {
  blob: Blob;
  /** The bit depth the blob was actually encoded at. */
  bitDepth: ExportBitDepth;
  /**
   * True when 16-bit output was requested but only an 8-bit ImageData source
   * was available, so the export was degraded to 8-bit instead of failing.
   */
  bitDepthDowngraded: boolean;
}

export async function encodeExportRaster(raster: ExportRaster, options: ExportOptions): Promise<EncodedExport> {
  const requestedBitDepth = normalizeExportBitDepth(options.format, options.bitDepth);
  const prepared = await prepareRaster(raster, options.targetMaxDimension);

  // 16-bit PNG/TIFF output can only be produced from a high-depth float raster.
  // Every current export path hands us 8-bit ImageData, so rather than throwing
  // HighBitDepthExportUnavailableError (which surfaced as a generic "Export
  // failed" toast) we degrade to 8-bit and report the downgrade to the caller.
  const bitDepthDowngraded = requestedBitDepth === 16 && isImageDataRaster(prepared);
  const bitDepth: ExportBitDepth = bitDepthDowngraded ? 8 : requestedBitDepth;

  const iccProfile = options.embedOutputProfile ? getColorProfileIcc(options.outputProfileId) : null;
  const profileName = options.embedOutputProfile ? getColorProfileDescription(options.outputProfileId) : null;

  if (options.format === 'image/png') {
    // 8-bit PNG goes through the canvas encoder for real deflate compression;
    // finalizeExportBlob re-embeds the output ICC profile afterwards. The manual
    // encoder (stored/uncompressed IDAT) is reserved for 16-bit float rasters.
    if (bitDepth === 8) {
      const canvas = createCanvasFromRaster(prepared);
      const blob = await canvasToBlob(canvas, { type: 'image/png' });
      return { blob, bitDepth, bitDepthDowngraded };
    }
    const blob = new Blob([encodePng(prepared, bitDepth, iccProfile, profileName)], { type: 'image/png' });
    return { blob, bitDepth, bitDepthDowngraded };
  }

  if (options.format === 'image/tiff') {
    const blob = new Blob([encodeTiff(prepared, bitDepth, iccProfile)], { type: 'image/tiff' });
    return { blob, bitDepth, bitDepthDowngraded };
  }

  const canvas = createCanvasFromRaster(prepared);
  const blob = await canvasToBlob(canvas, {
    type: options.format,
    quality: options.quality,
  });
  return { blob, bitDepth, bitDepthDowngraded };
}
