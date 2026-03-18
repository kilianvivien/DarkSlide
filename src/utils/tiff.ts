import UTIF from 'utif';

type TiffFrame = {
  width?: number;
  height?: number;
  t256?: ArrayLike<number>;
  t257?: ArrayLike<number>;
  t274?: ArrayLike<number>;
  t34675?: ArrayLike<number>;
};

type TiffDecoder = {
  decode: (buffer: ArrayBuffer) => TiffFrame[];
  decodeImage: (buffer: ArrayBuffer, ifd: TiffFrame) => void;
  toRGBA8: (ifd: TiffFrame) => ArrayLike<number>;
};

export class TiffDecodeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TiffDecodeError';
    this.code = code;
  }
}

export interface DecodedTiffRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  frameIndex: number;
  frameCount: number;
  orientation?: number;
  iccProfile?: Uint8Array;
}

function normalizeRgbaBuffer(rgba: ArrayLike<number>) {
  if (!ArrayBuffer.isView(rgba)) {
    return Uint8ClampedArray.from(rgba);
  }

  const view = rgba as ArrayBufferView;
  return new Uint8ClampedArray(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function normalizeByteBuffer(buffer: ArrayLike<number> | undefined) {
  if (!buffer) {
    return undefined;
  }

  if (!ArrayBuffer.isView(buffer)) {
    return Uint8Array.from(buffer);
  }

  const view = buffer as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function getFrameDimension(frame: TiffFrame | undefined, key: 'width' | 'height') {
  const directValue = Number(frame?.[key]);
  if (Number.isFinite(directValue) && directValue >= 1) {
    return directValue;
  }

  const tag = key === 'width' ? frame?.t256 : frame?.t257;
  const taggedValue = Number(tag?.[0]);
  if (Number.isFinite(taggedValue) && taggedValue >= 1) {
    return taggedValue;
  }

  return null;
}

function isUsableFrame(frame: TiffFrame | undefined) {
  const width = getFrameDimension(frame, 'width');
  const height = getFrameDimension(frame, 'height');
  return Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1;
}

export function decodeTiffRaster(buffer: ArrayBuffer, decoder: TiffDecoder = UTIF): DecodedTiffRaster {
  let frames: TiffFrame[];

  try {
    frames = decoder.decode(buffer);
  } catch {
    throw new TiffDecodeError('TIFF_INVALID', 'The TIFF file could not be parsed.');
  }

  if (!Array.isArray(frames) || frames.length === 0) {
    throw new TiffDecodeError('TIFF_EMPTY', 'The TIFF file does not contain any readable frames.');
  }

  let decodeFailure: unknown = null;

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    if (!isUsableFrame(frame)) continue;

    try {
      decoder.decodeImage(buffer, frame);
      const width = getFrameDimension(frame, 'width');
      const height = getFrameDimension(frame, 'height');
      if (!width || !height) {
        throw new TiffDecodeError('TIFF_UNSUPPORTED', 'The TIFF frame is missing valid dimensions.');
      }
      const rgba = normalizeRgbaBuffer(decoder.toRGBA8(frame));
      const expectedLength = width * height * 4;

      if (rgba.length !== expectedLength) {
        throw new TiffDecodeError('TIFF_UNSUPPORTED', 'The TIFF frame could not be converted into RGBA pixel data.');
      }

      return {
        width,
        height,
        data: rgba,
        frameIndex,
        frameCount: frames.length,
        orientation: Number.isFinite(Number(frame.t274?.[0])) ? Number(frame.t274?.[0]) : undefined,
        iccProfile: normalizeByteBuffer(frame.t34675),
      };
    } catch (error) {
      decodeFailure = error;
    }
  }

  if (decodeFailure instanceof TiffDecodeError) {
    throw decodeFailure;
  }

  throw new TiffDecodeError('TIFF_UNSUPPORTED', 'The TIFF file uses an unsupported layout for browser import.');
}
