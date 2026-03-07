/// <reference lib="webworker" />

import UTIF from 'utif';
import {
  ConversionSettings,
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  PreviewLevel,
  RenderRequest,
  RenderResult,
  SampleRequest,
  SourceMetadata,
} from '../types';
import {
  assertSupportedDimensions,
  clamp,
  getExtensionFromFormat,
  getFileExtension,
  normalizeCrop,
  processImageData,
  sanitizeFilenameBase,
  selectPreviewLevel,
} from './imagePipeline';
import { PREVIEW_LEVELS, RAW_EXTENSIONS } from '../constants';

type WorkerRequest =
  | { id: string; type: 'decode'; payload: DecodeRequest }
  | { id: string; type: 'render'; payload: RenderRequest }
  | { id: string; type: 'sample-film-base'; payload: SampleRequest }
  | { id: string; type: 'export'; payload: ExportRequest }
  | { id: string; type: 'dispose'; payload: { documentId: string } };

type WorkerError = { code: string; message: string };

type WorkerResponse =
  | { id: string; ok: true; payload: DecodedImage | RenderResult | ExportResult | FilmBaseSample | { disposed: true } }
  | { id: string; ok: false; error: WorkerError };

interface StoredPreview {
  level: PreviewLevel;
  canvas: OffscreenCanvas;
}

interface StoredDocument {
  metadata: SourceMetadata;
  sourceCanvas: OffscreenCanvas;
  previews: StoredPreview[];
}

const documents = new Map<string, StoredDocument>();
let rotateCanvas: OffscreenCanvas | null = null;
let outputCanvas: OffscreenCanvas | null = null;

function reply(response: WorkerResponse) {
  self.postMessage(response);
}

function createError(code: string, message: string): WorkerError {
  return { code, message };
}

function ensureCanvas(canvas: OffscreenCanvas | null, width: number, height: number) {
  const next = canvas ?? new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  if (next.width !== Math.max(1, width)) next.width = Math.max(1, width);
  if (next.height !== Math.max(1, height)) next.height = Math.max(1, height);
  return next;
}

async function decodeRasterBlob(buffer: ArrayBuffer, mime: string) {
  const blob = new Blob([buffer], { type: mime || 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create decode canvas.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function decodeTiff(buffer: ArrayBuffer) {
  const ifds = UTIF.decode(buffer);
  const ifd = ifds[0];
  if (!ifd) {
    throw new Error('The TIFF file does not contain any readable frames.');
  }

  UTIF.decodeImage(buffer, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  const width = Number(ifd.width);
  const height = Number(ifd.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create TIFF canvas.');

  const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer.slice(0)), width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function buildPreviewCanvas(source: OffscreenCanvas, maxDimension: number) {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create preview canvas.');
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function buildPreviewLevels(sourceCanvas: OffscreenCanvas): StoredPreview[] {
  const previews = PREVIEW_LEVELS
    .map((maxDimension) => {
      const canvas = buildPreviewCanvas(sourceCanvas, maxDimension);
      return {
        level: {
          id: `preview-${maxDimension}`,
          width: canvas.width,
          height: canvas.height,
          maxDimension,
        },
        canvas,
      };
    })
    .filter((preview, index, items) => index === items.findIndex((candidate) => candidate.canvas.width === preview.canvas.width && candidate.canvas.height === preview.canvas.height));

  const sourceMax = Math.max(sourceCanvas.width, sourceCanvas.height);
  if (!previews.some((preview) => preview.level.maxDimension >= sourceMax)) {
    previews.push({
      level: {
        id: 'preview-source',
        width: sourceCanvas.width,
        height: sourceCanvas.height,
        maxDimension: sourceMax,
      },
      canvas: sourceCanvas,
    });
  }

  return previews;
}

function renderTransformedCanvas(sourceCanvas: OffscreenCanvas, settings: ConversionSettings) {
  const crop = normalizeCrop(settings);
  const rotation = settings.rotation % 360;
  const isQuarterTurn = rotation === 90 || rotation === 270;
  const rotatedWidth = isQuarterTurn ? sourceCanvas.height : sourceCanvas.width;
  const rotatedHeight = isQuarterTurn ? sourceCanvas.width : sourceCanvas.height;
  const cropX = Math.floor(crop.x * rotatedWidth);
  const cropY = Math.floor(crop.y * rotatedHeight);
  const cropWidth = Math.max(1, Math.floor(crop.width * rotatedWidth));
  const cropHeight = Math.max(1, Math.floor(crop.height * rotatedHeight));

  rotateCanvas = ensureCanvas(rotateCanvas, rotatedWidth, rotatedHeight);
  const rotateCtx = rotateCanvas.getContext('2d', { willReadFrequently: true });
  if (!rotateCtx) throw new Error('Could not create rotation canvas.');

  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  rotateCtx.clearRect(0, 0, rotatedWidth, rotatedHeight);
  rotateCtx.translate(rotatedWidth / 2, rotatedHeight / 2);
  rotateCtx.rotate((rotation * Math.PI) / 180);
  if (isQuarterTurn) {
    rotateCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2, sourceCanvas.width, sourceCanvas.height);
  } else {
    rotateCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  }
  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);

  outputCanvas = ensureCanvas(outputCanvas, cropWidth, cropHeight);
  const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputCtx) throw new Error('Could not create output canvas.');
  outputCtx.clearRect(0, 0, cropWidth, cropHeight);
  outputCtx.drawImage(rotateCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  return {
    canvas: outputCanvas,
    width: cropWidth,
    height: cropHeight,
  };
}

function getStoredDocument(documentId: string) {
  const document = documents.get(documentId);
  if (!document) {
    throw new Error('The image document is no longer available.');
  }
  return document;
}

async function handleDecode(payload: DecodeRequest) {
  const extension = getFileExtension(payload.fileName);
  if (RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number])) {
    throw createError('RAW_UNSUPPORTED', 'RAW import is reserved for the future desktop decode path. Use TIFF, JPEG, PNG, or WebP in the browser build.');
  }

  const isTiff = extension === '.tif' || extension === '.tiff' || payload.mime === 'image/tiff';
  const decodedCanvas = isTiff ? decodeTiff(payload.buffer) : await decodeRasterBlob(payload.buffer, payload.mime);
  assertSupportedDimensions(decodedCanvas.width, decodedCanvas.height);

  const previewStore = buildPreviewLevels(decodedCanvas);
  const metadata: SourceMetadata = {
    id: payload.documentId,
    name: payload.fileName,
    mime: payload.mime || (isTiff ? 'image/tiff' : 'image/*'),
    extension,
    size: payload.size,
    width: decodedCanvas.width,
    height: decodedCanvas.height,
  };

  documents.set(payload.documentId, {
    metadata,
    sourceCanvas: decodedCanvas,
    previews: previewStore,
  });

  return {
    metadata,
    previewLevels: previewStore.map((preview) => preview.level),
  } satisfies DecodedImage;
}

function handleRender(payload: RenderRequest) {
  const document = getStoredDocument(payload.documentId);
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), payload.targetMaxDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read rendered preview.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const histogram = processImageData(imageData, payload.settings, payload.isColor, payload.comparisonMode);
  ctx.putImageData(imageData, 0, 0);

  return {
    documentId: payload.documentId,
    revision: payload.revision,
    width: transformed.width,
    height: transformed.height,
    previewLevelId: preview.level.id,
    imageData,
    histogram,
  } satisfies RenderResult;
}

function handleSampleFilmBase(payload: SampleRequest) {
  const document = getStoredDocument(payload.documentId);
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), payload.targetMaxDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not sample film base.');

  const sampleX = clamp(Math.round(payload.x * (transformed.width - 1)), 0, Math.max(transformed.width - 1, 0));
  const sampleY = clamp(Math.round(payload.y * (transformed.height - 1)), 0, Math.max(transformed.height - 1, 0));
  const pixel = ctx.getImageData(sampleX, sampleY, 1, 1).data;

  return {
    r: pixel[0],
    g: pixel[1],
    b: pixel[2],
  } satisfies FilmBaseSample;
}

async function handleExport(payload: ExportRequest) {
  const document = getStoredDocument(payload.documentId);
  const transformed = renderTransformedCanvas(document.sourceCanvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create export canvas.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  processImageData(imageData, payload.settings, payload.isColor, 'processed');
  ctx.putImageData(imageData, 0, 0);

  const blob = await transformed.canvas.convertToBlob({
    type: payload.options.format,
    quality: payload.options.format === 'image/png' ? undefined : payload.options.quality,
  });

  return {
    blob,
    filename: `${sanitizeFilenameBase(payload.options.filenameBase)}.${getExtensionFromFormat(payload.options.format)}`,
  } satisfies ExportResult;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === 'dispose') {
      documents.delete(request.payload.documentId);
      reply({ id: request.id, ok: true, payload: { disposed: true } });
      return;
    }

    if (request.type === 'decode') {
      reply({ id: request.id, ok: true, payload: await handleDecode(request.payload) });
      return;
    }

    if (request.type === 'render') {
      reply({ id: request.id, ok: true, payload: handleRender(request.payload) });
      return;
    }

    if (request.type === 'sample-film-base') {
      reply({ id: request.id, ok: true, payload: handleSampleFilmBase(request.payload) });
      return;
    }

    if (request.type === 'export') {
      reply({ id: request.id, ok: true, payload: await handleExport(request.payload) });
    }
  } catch (error) {
    const failure = error as Partial<WorkerError> & { message?: string };
    reply({
      id: request.id,
      ok: false,
      error: createError(
        failure.code ?? 'WORKER_ERROR',
        failure.message ?? String(error),
      ),
    });
  }
};
