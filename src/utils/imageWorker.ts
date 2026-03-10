/// <reference lib="webworker" />

import UTIF from 'utif';
import {
  CancelTileJobRequest,
  ConversionSettings,
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  PreparedTileJobResult,
  PreviewLevel,
  PrepareTileJobRequest,
  RawExportResult,
  ReadTileRequest,
  ReadTileResult,
  RenderRequest,
  RenderResult,
  SampleRequest,
  SourceMetadata,
  TileSourceKind,
} from '../types';
import {
  assertSupportedDimensions,
  clamp,
  buildEmptyHistogram,
  getExtensionFromFormat,
  getFileExtension,
  getCropPixelBounds,
  getTransformedDimensions,
  normalizeCrop,
  processImageData,
  sanitizeFilenameBase,
  selectPreviewLevel,
} from './imagePipeline';
import { PREVIEW_LEVELS, RAW_EXTENSIONS } from '../constants';
import { decodeTiffRaster, TiffDecodeError } from './tiff';

type WorkerRequest =
  | { id: string; type: 'decode'; payload: DecodeRequest }
  | { id: string; type: 'render'; payload: RenderRequest }
  | { id: string; type: 'prepare-tile-job'; payload: PrepareTileJobRequest }
  | { id: string; type: 'read-tile'; payload: ReadTileRequest }
  | { id: string; type: 'cancel-job'; payload: CancelTileJobRequest }
  | { id: string; type: 'sample-film-base'; payload: SampleRequest }
  | { id: string; type: 'export'; payload: ExportRequest }
  | { id: string; type: 'dispose'; payload: { documentId: string } };

type WorkerError = { code: string; message: string };

type WorkerResponse =
  | { id: string; ok: true; payload: DecodedImage | RenderResult | PreparedTileJobResult | ReadTileResult | ExportResult | RawExportResult | FilmBaseSample | { disposed: true } | { cancelled: true } }
  | { id: string; ok: false; error: WorkerError };

interface StoredPreview {
  level: PreviewLevel;
  canvas: OffscreenCanvas;
}

interface StoredDocument {
  metadata: SourceMetadata;
  sourceCanvas: OffscreenCanvas;
  previews: StoredPreview[];
  previewGeometryCache: Map<string, StoredTileJob>;
  sourceGeometryCache: Map<string, StoredTileJob>;
}

interface StoredTileJob {
  documentId: string;
  sourceKind: TileSourceKind;
  previewLevelId: string | null;
  transformedCanvas: OffscreenCanvas;
  width: number;
  height: number;
  halo: number;
}

const documents = new Map<string, StoredDocument>();
const tileJobs = new Map<string, StoredTileJob>();
const cancelledJobs = new Set<string>();
let rotateCanvas: OffscreenCanvas | null = null;
let outputCanvas: OffscreenCanvas | null = null;
const TILE_SIZE = 1024;

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
  const decoded = decodeTiffRaster(buffer, UTIF);
  const { width, height, data } = decoded;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create TIFF canvas.');

  const imageData = new ImageData(data, width, height);
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
  const rotation = settings.rotation + settings.levelAngle;
  const { width: rotatedWidth, height: rotatedHeight } = getTransformedDimensions(
    sourceCanvas.width,
    sourceCanvas.height,
    rotation,
  );
  const cropBounds = getCropPixelBounds(normalizeCrop(settings), rotatedWidth, rotatedHeight);

  rotateCanvas = ensureCanvas(rotateCanvas, rotatedWidth, rotatedHeight);
  const rotateCtx = rotateCanvas.getContext('2d', { willReadFrequently: true });
  if (!rotateCtx) throw new Error('Could not create rotation canvas.');

  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  rotateCtx.clearRect(0, 0, rotatedWidth, rotatedHeight);
  rotateCtx.translate(rotatedWidth / 2, rotatedHeight / 2);
  rotateCtx.rotate((rotation * Math.PI) / 180);
  rotateCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2, sourceCanvas.width, sourceCanvas.height);
  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);

  outputCanvas = ensureCanvas(outputCanvas, cropBounds.width, cropBounds.height);
  const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputCtx) throw new Error('Could not create output canvas.');
  outputCtx.clearRect(0, 0, cropBounds.width, cropBounds.height);
  outputCtx.drawImage(
    rotateCanvas,
    cropBounds.x,
    cropBounds.y,
    cropBounds.width,
    cropBounds.height,
    0,
    0,
    cropBounds.width,
    cropBounds.height,
  );

  return {
    canvas: outputCanvas,
    width: cropBounds.width,
    height: cropBounds.height,
  };
}

function renderTransformedCanvasForJob(sourceCanvas: OffscreenCanvas, settings: ConversionSettings) {
  const rotation = settings.rotation + settings.levelAngle;
  const { width: rotatedWidth, height: rotatedHeight } = getTransformedDimensions(
    sourceCanvas.width,
    sourceCanvas.height,
    rotation,
  );
  const cropBounds = getCropPixelBounds(normalizeCrop(settings), rotatedWidth, rotatedHeight);

  const localRotateCanvas = new OffscreenCanvas(rotatedWidth, rotatedHeight);
  const rotateCtx = localRotateCanvas.getContext('2d', { willReadFrequently: true });
  if (!rotateCtx) throw new Error('Could not create rotation canvas.');

  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  rotateCtx.clearRect(0, 0, rotatedWidth, rotatedHeight);
  rotateCtx.translate(rotatedWidth / 2, rotatedHeight / 2);
  rotateCtx.rotate((rotation * Math.PI) / 180);
  rotateCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2, sourceCanvas.width, sourceCanvas.height);
  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);

  const localOutputCanvas = new OffscreenCanvas(cropBounds.width, cropBounds.height);
  const outputCtx = localOutputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputCtx) throw new Error('Could not create output canvas.');
  outputCtx.clearRect(0, 0, cropBounds.width, cropBounds.height);
  outputCtx.drawImage(
    localRotateCanvas,
    cropBounds.x,
    cropBounds.y,
    cropBounds.width,
    cropBounds.height,
    0,
    0,
    cropBounds.width,
    cropBounds.height,
  );

  return {
    canvas: localOutputCanvas,
    width: cropBounds.width,
    height: cropBounds.height,
  };
}

function getStoredDocument(documentId: string) {
  const document = documents.get(documentId);
  if (!document) {
    throw new Error('The image document is no longer available.');
  }
  return document;
}

function getHalo(settings: ConversionSettings, comparisonMode: 'processed' | 'original') {
  if (comparisonMode === 'original') {
    return 0;
  }

  const sharpenHalo = settings.sharpen.enabled && settings.sharpen.amount > 0
    ? Math.ceil(settings.sharpen.radius)
    : 0;
  const noiseHalo = settings.noiseReduction.enabled && settings.noiseReduction.luminanceStrength > 0
    ? 2
    : 0;

  return Math.max(sharpenHalo, noiseHalo);
}

function getTileSource(document: StoredDocument, payload: PrepareTileJobRequest) {
  if (payload.sourceKind === 'source') {
    return {
      canvas: document.sourceCanvas,
      previewLevelId: null,
    };
  }

  const level = selectPreviewLevel(
    document.previews.map((preview) => preview.level),
    payload.targetMaxDimension ?? Math.max(document.metadata.width, document.metadata.height),
  );
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  return {
    canvas: preview.canvas,
    previewLevelId: preview.level.id,
  };
}

function createGeometryCacheKey(
  sourceKind: TileSourceKind,
  previewLevelId: string | null,
  settings: ConversionSettings,
) {
  const crop = normalizeCrop(settings);
  return JSON.stringify({
    sourceKind,
    previewLevelId,
    crop,
    rotation: settings.rotation,
    levelAngle: settings.levelAngle,
  });
}

function getGeometryCache(document: StoredDocument, sourceKind: TileSourceKind) {
  return sourceKind === 'preview' ? document.previewGeometryCache : document.sourceGeometryCache;
}

function clearTileJob(jobId: string) {
  tileJobs.delete(jobId);
  cancelledJobs.delete(jobId);
}

async function handleDecode(payload: DecodeRequest) {
  if (payload.mime === 'image/x-raw-rgba') {
    if (!payload.rawDimensions) {
      throw createError('RAW_INVALID', 'RAW decode payload is missing dimensions.');
    }

    const { width, height } = payload.rawDimensions;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Could not create RAW decode canvas.');
    }

    const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), width, height);
    ctx.putImageData(imageData, 0, 0);

    assertSupportedDimensions(canvas.width, canvas.height);

    const previewStore = buildPreviewLevels(canvas);
    const metadata: SourceMetadata = {
      id: payload.documentId,
      name: payload.fileName,
      mime: payload.mime,
      extension: getFileExtension(payload.fileName),
      size: payload.size,
      width: canvas.width,
      height: canvas.height,
    };

    documents.set(payload.documentId, {
      metadata,
      sourceCanvas: canvas,
      previews: previewStore,
      previewGeometryCache: new Map(),
      sourceGeometryCache: new Map(),
    });

    return {
      metadata,
      previewLevels: previewStore.map((preview) => preview.level),
    } satisfies DecodedImage;
  }

  const extension = getFileExtension(payload.fileName);
  if (RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number])) {
    throw createError('RAW_UNSUPPORTED', 'RAW import is reserved for the future desktop decode path. Use TIFF, JPEG, PNG, or WebP in the browser build.');
  }

  const isTiff = extension === '.tif' || extension === '.tiff' || payload.mime === 'image/tiff';
  let decodedCanvas: OffscreenCanvas;

  try {
    decodedCanvas = isTiff ? decodeTiff(payload.buffer) : await decodeRasterBlob(payload.buffer, payload.mime);
  } catch (error) {
    if (error instanceof TiffDecodeError) {
      throw createError(error.code, error.message);
    }
    throw error;
  }

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
    previewGeometryCache: new Map(),
    sourceGeometryCache: new Map(),
  });

  return {
    metadata,
    previewLevels: previewStore.map((preview) => preview.level),
  } satisfies DecodedImage;
}

function handlePrepareTileJob(payload: PrepareTileJobRequest) {
  const document = getStoredDocument(payload.documentId);
  clearTileJob(payload.jobId);
  const source = getTileSource(document, payload);
  const cache = getGeometryCache(document, payload.sourceKind);
  const geometryCacheKey = createGeometryCacheKey(payload.sourceKind, source.previewLevelId, payload.settings);
  let storedJob = cache.get(geometryCacheKey);
  let geometryCacheHit = true;

  if (!storedJob) {
    const transformed = renderTransformedCanvasForJob(source.canvas, payload.settings);
    storedJob = {
      documentId: payload.documentId,
      sourceKind: payload.sourceKind,
      previewLevelId: source.previewLevelId,
      transformedCanvas: transformed.canvas,
      width: transformed.width,
      height: transformed.height,
      halo: 0,
    };
    cache.clear();
    cache.set(geometryCacheKey, storedJob);
    geometryCacheHit = false;
  }

  const halo = getHalo(payload.settings, payload.comparisonMode);
  tileJobs.set(payload.jobId, {
    ...storedJob,
    halo,
  });

  return {
    documentId: payload.documentId,
    jobId: payload.jobId,
    sourceKind: payload.sourceKind,
    width: storedJob.width,
    height: storedJob.height,
    previewLevelId: source.previewLevelId,
    tileSize: TILE_SIZE,
    halo,
    geometryCacheHit,
  } satisfies PreparedTileJobResult;
}

function handleReadTile(payload: ReadTileRequest) {
  if (cancelledJobs.has(payload.jobId)) {
    throw createError('JOB_CANCELLED', 'The tile job was cancelled.');
  }

  const job = tileJobs.get(payload.jobId);
  if (!job || job.documentId !== payload.documentId) {
    throw createError('JOB_MISSING', 'The requested tile job is no longer available.');
  }

  const ctx = job.transformedCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read tile canvas.');

  const haloLeft = Math.min(job.halo, payload.x);
  const haloTop = Math.min(job.halo, payload.y);
  const haloRight = Math.min(job.halo, Math.max(0, job.width - (payload.x + payload.width)));
  const haloBottom = Math.min(job.halo, Math.max(0, job.height - (payload.y + payload.height)));

  const readX = payload.x - haloLeft;
  const readY = payload.y - haloTop;
  const readWidth = payload.width + haloLeft + haloRight;
  const readHeight = payload.height + haloTop + haloBottom;
  const imageData = ctx.getImageData(readX, readY, readWidth, readHeight);

  if (cancelledJobs.has(payload.jobId)) {
    throw createError('JOB_CANCELLED', 'The tile job was cancelled.');
  }

  return {
    documentId: payload.documentId,
    jobId: payload.jobId,
    x: payload.x,
    y: payload.y,
    width: payload.width,
    height: payload.height,
    haloLeft,
    haloTop,
    haloRight,
    haloBottom,
    imageData,
  } satisfies ReadTileResult;
}

function handleCancelJob(payload: CancelTileJobRequest) {
  cancelledJobs.add(payload.jobId);
  tileJobs.delete(payload.jobId);
  return { cancelled: true } as const;
}

function handleRender(payload: RenderRequest) {
  const document = getStoredDocument(payload.documentId);
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), payload.targetMaxDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read rendered preview.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const histogram = payload.skipProcessing
    ? buildEmptyHistogram()
    : processImageData(
      imageData,
      payload.settings,
      payload.isColor,
      payload.comparisonMode,
      payload.maskTuning,
      payload.colorMatrix,
      payload.tonalCharacter,
    );

  if (!payload.skipProcessing) {
    ctx.putImageData(imageData, 0, 0);
  }

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
  const radius = clamp(Math.round(Math.min(transformed.width, transformed.height) / 512), 1, 4);
  const left = clamp(sampleX - radius, 0, Math.max(transformed.width - 1, 0));
  const top = clamp(sampleY - radius, 0, Math.max(transformed.height - 1, 0));
  const right = clamp(sampleX + radius, 0, Math.max(transformed.width - 1, 0));
  const bottom = clamp(sampleY + radius, 0, Math.max(transformed.height - 1, 0));
  const area = ctx.getImageData(left, top, right - left + 1, bottom - top + 1).data;

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let index = 0; index < area.length; index += 4) {
    totalR += area[index];
    totalG += area[index + 1];
    totalB += area[index + 2];
    count += 1;
  }

  return {
    r: count > 0 ? Math.round(totalR / count) : 0,
    g: count > 0 ? Math.round(totalG / count) : 0,
    b: count > 0 ? Math.round(totalB / count) : 0,
  } satisfies FilmBaseSample;
}

async function handleExport(payload: ExportRequest) {
  const document = getStoredDocument(payload.documentId);
  const transformed = renderTransformedCanvas(document.sourceCanvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create export canvas.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const filename = `${sanitizeFilenameBase(payload.options.filenameBase)}.${getExtensionFromFormat(payload.options.format)}`;

  if (payload.skipProcessing) {
    return {
      imageData,
      width: transformed.width,
      height: transformed.height,
      filename,
      format: payload.options.format,
      quality: payload.options.quality,
    } satisfies RawExportResult;
  }

  processImageData(
    imageData,
    payload.settings,
    payload.isColor,
    'processed',
    payload.maskTuning,
    payload.colorMatrix,
    payload.tonalCharacter,
  );
  ctx.putImageData(imageData, 0, 0);

  const blob = await transformed.canvas.convertToBlob({
    type: payload.options.format,
    quality: payload.options.format === 'image/png' ? undefined : payload.options.quality,
  });

  return {
    blob,
    filename,
  } satisfies ExportResult;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === 'dispose') {
      documents.delete(request.payload.documentId);
      Array.from(tileJobs.entries())
        .filter(([, job]) => job.documentId === request.payload.documentId)
        .forEach(([jobId]) => clearTileJob(jobId));
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

    if (request.type === 'prepare-tile-job') {
      reply({ id: request.id, ok: true, payload: handlePrepareTileJob(request.payload) });
      return;
    }

    if (request.type === 'read-tile') {
      reply({ id: request.id, ok: true, payload: handleReadTile(request.payload) });
      return;
    }

    if (request.type === 'cancel-job') {
      reply({ id: request.id, ok: true, payload: handleCancelJob(request.payload) });
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
