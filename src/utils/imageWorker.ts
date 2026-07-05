/// <reference lib="webworker" />

import UTIF from 'utif';
import {
  AutoAnalyzeRequest,
  AutoAnalyzeResult,
  ColorProfileId,
  CancelTileJobRequest,
  ContactSheetRequest,
  ContactSheetResult,
  ConversionAnalysisRequest,
  ConversionAnalysisResult,
  ConversionParametersDebug,
  ConversionSettings,
  DecodeRequest,
  DensityBalance,
  DecodedImage,
  DustDetectRequest,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  FilmBaseEstimate,
  FilmProfileType,
  InputProfileSpec,
  PreparePreviewBitmapRequest,
  ParsedInputProfile,
  PreparedPreviewBitmapResult,
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
  WorkerMemoryDiagnostics,
} from '../types';
import {
  applyCrushGuard,
  applyInversionStage,
  assertSupportedDimensions,
  buildEmptyHistogram,
  computeResidualBaseOffset,
  computeDensityBalance,
  computeHighlightDensity,
  getExtensionFromFormat,
  getFilmBaseBalance,
  getFileExtension,
  getCropPixelBounds,
  getTransformedDimensions,
  normalizeCrop,
  normalizeFilmBaseEstimate,
  processImageData,
  processFloatRaster,
  releaseScratchBuffers,
  resolveDensityInversionParams,
  sanitizeFilenameBase,
  selectPreviewLevel,
} from './imagePipeline';
import { analyzeChannelFloors, analyzeColorBalance, analyzeExposure, analyzeMidtoneContrast } from './autoAnalysis';
import { MAX_FILE_SIZE_BYTES, PREVIEW_LEVELS, RAW_EXTENSIONS, resolveDustRemovalSettings } from '../constants';
import { decodeTiffRaster, TiffDecodeError } from './tiff';
import { convertImageDataColorProfile, getColorProfileIdFromName, parseInputIccProfile } from './colorProfiles';
import { extractExifMetadata, extractRasterColorProfile } from './imageMetadata';
import { detectDustMarks } from './dustDetection';
import { detectFrame } from './frameDetection';
import { estimateFlare } from './flareEstimation';
import { applyDustRemoval } from './dustRemoval';
import { projectDustMarkFromTransformedSpace } from './dustGeometry';
import {
  prepareGeometryCacheEntry,
} from './workerGeometryCache';
import { clamp } from './math';
import { computeBrightPercentileSample, estimateFilmBase, mirrorFromExifOrientation } from './rawImport';
import { usesColorChannelPipeline } from './pipelineIntent';
import { encodeExportRaster } from './exportEncoder';
import {
  WorkerError,
  WorkerMessage,
  WorkerResponse,
  WorkerSuccessPayload,
} from './workerProtocol';

interface StoredPreview {
  level: PreviewLevel;
  canvas: OffscreenCanvas;
}

interface HighDepthRawSource {
  width: number;
  height: number;
  data: Uint16Array;
  bitDepth: 16;
  transfer: 'srgb';
}

interface StoredDocument {
  metadata: SourceMetadata;
  sourceCanvas: OffscreenCanvas;
  highDepthRawSource?: HighDepthRawSource;
  previews: StoredPreview[];
  rotationCache: Map<string, OffscreenCanvas>;
  cropCache: Map<string, StoredTileJob>;
  estimatedFilmBaseSample: FilmBaseSample | null;
  estimatedFilmBase: FilmBaseEstimate | null;
  estimatedDensityBalance: DensityBalance | null;
  // Pinned conversion analysis (audit Phase C): memoized so preview, tiles,
  // dust detection, and export all consume identical numbers.
  residualBaseCache: Map<string, [number, number, number] | null>;
  highlightDensityCache: Map<string, number>;
  lastAccessedAt: number;
}

const ANALYSIS_CACHE_LIMIT = 16;
const RESIDUAL_ANALYSIS_MAX_DIMENSION = 1024;
const HIGHLIGHT_ANALYSIS_MAX_DIMENSION = 512;

interface StoredTileJob {
  documentId: string;
  sourceKind: TileSourceKind;
  previewLevelId: string | null;
  transformedCanvas: OffscreenCanvas;
  width: number;
  height: number;
  halo: number;
  comparisonMode?: 'processed' | 'original';
}

const documents = new Map<string, StoredDocument>();
const tileJobs = new Map<string, StoredTileJob>();
const cancelledJobs = new Map<string, number>();
let rotateCanvas: OffscreenCanvas | null = null;
let outputCanvas: OffscreenCanvas | null = null;
let previewPresentationCanvas: OffscreenCanvas | null = null;
const TILE_SIZE = 1024;
const CANCELLED_JOB_TTL_MS = 2_000;

function reply(
  request: WorkerMessage,
  payload: WorkerSuccessPayload,
  transfer: Transferable[] = [],
) {
  self.postMessage({
    id: request.id,
    epoch: request.epoch,
    ok: true,
    payload,
  } satisfies WorkerResponse, transfer);
}

function replyError(request: WorkerMessage, error: WorkerError) {
  self.postMessage({
    id: request.id,
    epoch: request.epoch,
    ok: false,
    error,
  } satisfies WorkerResponse);
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

function releaseCanvas(canvas: OffscreenCanvas) {
  try {
    canvas.width = 1;
    canvas.height = 1;
  } catch {
    // Ignore detached canvas cleanup failures.
  }
}

function releaseCanvasIfUnreferenced(canvas: OffscreenCanvas) {
  const stillReferencedByCache = Array.from(documents.values()).some((document) => (
    Array.from(document.rotationCache.values()).some((entry) => entry === canvas)
    || Array.from(document.cropCache.values()).some((job) => job.transformedCanvas === canvas)
  ));
  const stillReferencedByTileJob = Array.from(tileJobs.values()).some((job) => job.transformedCanvas === canvas);

  if (!stillReferencedByCache && !stillReferencedByTileJob) {
    releaseCanvas(canvas);
  }
}

function pruneCancelledJobs(now = performance.now()) {
  for (const [jobId, cancelledAt] of cancelledJobs.entries()) {
    if (now - cancelledAt > CANCELLED_JOB_TTL_MS) {
      cancelledJobs.delete(jobId);
    }
  }
}

function isRecentlyCancelledJob(jobId: string) {
  pruneCancelledJobs();
  return cancelledJobs.has(jobId);
}

function mirrorCanvasHorizontal(source: OffscreenCanvas) {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create mirror canvas.');
  ctx.translate(source.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);
  releaseCanvas(source);
  return canvas;
}

async function decodeRasterBlob(buffer: ArrayBuffer, mime: string) {
  const blob = new Blob([buffer], { type: mime || 'image/png' });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create decode canvas.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function estimateCanvasFilmBase(canvas: OffscreenCanvas): FilmBaseEstimate | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return estimateFilmBase(imageData.data, canvas.width, canvas.height, 4);
}

function estimateCanvasDensityBalance(canvas: OffscreenCanvas, filmBaseSample: FilmBaseSample | null) {
  if (!filmBaseSample) {
    return null;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return computeDensityBalance(imageData, filmBaseSample);
}

// Catastrophic-base guard (diagnosis §"Clamp catastrophic base choices"). Run
// the resolved base through the density inversion against the smallest preview
// level; if it would crush most of the frame to black, demote the estimate to a
// conservative bright-percentile reference and recompute the density balance so
// a distrusted sample can never become the hard density zero point.
function guardFilmBaseAgainstCrush(
  estimate: FilmBaseEstimate | null,
  previews: StoredPreview[],
  priorDensityBalance: DensityBalance | null,
): { estimate: FilmBaseEstimate | null; densityBalance: DensityBalance | null } {
  if (!estimate || previews.length === 0) {
    return { estimate, densityBalance: priorDensityBalance };
  }

  const smallest = previews.reduce(
    (min, preview) => (preview.level.maxDimension < min.level.maxDimension ? preview : min),
    previews[0],
  );
  const ctx = smallest.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { estimate, densityBalance: priorDensityBalance };
  }

  const imageData = ctx.getImageData(0, 0, smallest.canvas.width, smallest.canvas.height);
  const conservative = computeBrightPercentileSample(imageData.data, smallest.canvas.width, smallest.canvas.height, 4);
  return applyCrushGuard(estimate, imageData, conservative, priorDensityBalance);
}

function decodeTiff(buffer: ArrayBuffer) {
  const decoded = decodeTiffRaster(buffer, UTIF);
  const { width, height, data } = decoded;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create TIFF canvas.');

  const imageData = new ImageData(data, width, height);
  ctx.putImageData(imageData, 0, 0);
  return {
    canvas,
    orientation: decoded.orientation,
    iccProfile: decoded.iccProfile,
  };
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

function buildPreviewLevels(sourceCanvas: OffscreenCanvas, displayScaleFactor = 1): StoredPreview[] {
  const shouldInclude4096 = displayScaleFactor > 1 || Math.max(sourceCanvas.width, sourceCanvas.height) > 4096;
  const previews = PREVIEW_LEVELS
    .filter((maxDimension) => maxDimension < 4096 || shouldInclude4096)
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

function getOrCreatePreviewByMaxDimension(document: StoredDocument, maxDimension: number) {
  const existing = document.previews.find((preview) => preview.level.maxDimension === maxDimension);
  if (existing) {
    return existing;
  }

  const canvas = buildPreviewCanvas(document.sourceCanvas, maxDimension);
  const preview = {
    level: {
      id: `preview-${maxDimension}`,
      width: canvas.width,
      height: canvas.height,
      maxDimension,
    },
    canvas,
  } satisfies StoredPreview;

  document.previews.push(preview);
  document.previews.sort((left, right) => left.level.maxDimension - right.level.maxDimension);
  return preview;
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

function rememberAnalysisResult<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= ANALYSIS_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

// Pinned residual-base analysis: always computed on the untransformed
// 1024px analysis preview so preview, tiles, dust detection, and export
// receive identical numbers regardless of the resolution being rendered.
function getPinnedResidualBaseOffset(
  document: StoredDocument,
  settings: ConversionSettings,
  isColor: boolean,
  filmType: FilmProfileType = 'negative',
  inputProfileId: InputProfileSpec = 'srgb',
  outputProfileId: ColorProfileId = 'srgb',
  lightSourceBias: [number, number, number] = [1, 1, 1],
  flareFloor: [number, number, number] | null = null,
  profileId: string | null = null,
) {
  if (!isColor || filmType !== 'negative' || settings.residualBaseCorrection === false) {
    return null;
  }

  const cacheKey = JSON.stringify([
    settings.filmBaseSample,
    settings.flareCorrection ?? 50,
    isColor,
    filmType,
    inputProfileId,
    outputProfileId,
    lightSourceBias,
    flareFloor,
    profileId,
  ]);
  const cached = document.residualBaseCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const preview = getOrCreatePreviewByMaxDimension(document, RESIDUAL_ANALYSIS_MAX_DIMENSION);
  const context = preview.canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not read residual base analysis canvas.');
  }

  const offset = computeResidualBaseOffset(
    context.getImageData(0, 0, preview.canvas.width, preview.canvas.height),
    settings,
    isColor,
    filmType,
    inputProfileId,
    outputProfileId,
    lightSourceBias,
    flareFloor,
    profileId,
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
  );

  return rememberAnalysisResult(document.residualBaseCache, cacheKey, offset);
}

// Pinned highlight-density analysis: replaces the previous feedback loop
// where each render consumed the highlight share of the *previous* preview
// histogram and export approximated with a stale value. Measured at a fixed
// 512px with highlight protection disabled, so preview and export agree.
function getPinnedHighlightDensity(
  document: StoredDocument,
  payload: Omit<ConversionAnalysisRequest, 'documentId'>,
  residualBaseOffset: [number, number, number] | null,
) {
  // The analysis neutralizes highlightProtection, sharpen, and noiseReduction
  // before measuring, so key the cache on the neutralized settings — otherwise
  // nudging those sliders busts the (clear-all-eviction) cache and recomputes an
  // identical result.
  const analysisSettings: ConversionSettings = {
    ...payload.settings,
    highlightProtection: 0,
    sharpen: { ...payload.settings.sharpen, enabled: false },
    noiseReduction: { ...payload.settings.noiseReduction, enabled: false },
  };
  const cacheKey = JSON.stringify([
    analysisSettings,
    payload.isColor,
    payload.profileId ?? null,
    payload.filmType ?? 'negative',
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.lightSourceBias ?? null,
    payload.flareFloor ?? null,
    payload.maskTuning ?? null,
    payload.colorMatrix ?? null,
    payload.tonalCharacter ?? null,
    payload.labStyleToneCurve ?? null,
    payload.labStyleChannelCurves ?? null,
    payload.labTonalCharacterOverride ?? null,
    payload.labSaturationBias ?? 0,
    payload.labTemperatureBias ?? 0,
  ]);
  const cached = document.highlightDensityCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const preview = getOrCreatePreviewByMaxDimension(document, HIGHLIGHT_ANALYSIS_MAX_DIMENSION);
  // Use job-local canvases: the shared renderTransformedCanvas output may
  // still be in use by the render/export that requested this analysis.
  const rotatedCanvas = renderRotatedCanvasForJob(preview.canvas, analysisSettings);
  const transformed = renderCroppedCanvasForJob(rotatedCanvas, analysisSettings);
  releaseCanvas(rotatedCanvas);
  const context = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not read highlight analysis canvas.');
  }
  const analysisImageData = context.getImageData(0, 0, transformed.width, transformed.height);
  releaseCanvas(transformed.canvas);

  const histogram = processImageData(
    analysisImageData,
    analysisSettings,
    payload.isColor,
    'processed',
    payload.maskTuning,
    payload.colorMatrix,
    payload.tonalCharacter,
    payload.labStyleToneCurve,
    payload.labStyleChannelCurves,
    payload.labTonalCharacterOverride,
    payload.labSaturationBias ?? 0,
    payload.labTemperatureBias ?? 0,
    0,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.profileId ?? null,
    payload.filmType ?? 'negative',
    residualBaseOffset,
    payload.flareFloor ?? null,
    payload.lightSourceBias ?? [1, 1, 1],
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
  );

  return rememberAnalysisResult(document.highlightDensityCache, cacheKey, computeHighlightDensity(histogram));
}

function buildConversionParametersDebug(
  document: StoredDocument,
  payload: Omit<ConversionAnalysisRequest, 'documentId'>,
  residualBaseOffset: [number, number, number] | null,
  highlightDensity: number,
): ConversionParametersDebug {
  const densityInversion = resolveDensityInversionParams(
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    payload.profileId ?? null,
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.flareFloor ?? null,
    (payload.settings.flareCorrection ?? 50) / 100,
  );

  return {
    baseSampleSource: densityInversion.baseSampleSource,
    baseDensity: densityInversion.baseDensity,
    densityScale: densityInversion.densityScale,
    densityScaleSource: densityInversion.densityScaleSource,
    baseConfidence: densityInversion.baseConfidence,
    lowConfidence: densityInversion.lowConfidence,
    resolvedSample: payload.settings.filmBaseSample ?? document.estimatedFilmBase?.sample ?? null,
    estimatedSample: document.estimatedFilmBase?.sample ?? null,
    estimatorRejectedCandidates: document.estimatedFilmBase?.rejectedCandidates ?? 0,
    crushGuardTriggered: document.estimatedFilmBase?.clamped ?? false,
    inputProfileId: payload.inputProfileId ?? 'srgb',
    outputProfileId: payload.outputProfileId ?? 'srgb',
    flareFloor: payload.flareFloor ?? null,
    residualBaseOffset,
    highlightDensity,
  };
}

function handleConversionAnalysis(payload: ConversionAnalysisRequest): ConversionAnalysisResult {
  const document = getStoredDocument(payload.documentId);
  const residualBaseOffset = getPinnedResidualBaseOffset(
    document,
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.lightSourceBias ?? [1, 1, 1],
    payload.flareFloor ?? null,
    payload.profileId ?? null,
  );
  const highlightDensity = getPinnedHighlightDensity(document, payload, residualBaseOffset);

  return {
    type: 'conversion-analysis',
    residualBaseOffset,
    highlightDensity,
    debug: buildConversionParametersDebug(document, payload, residualBaseOffset, highlightDensity),
  };
}

function mirrorHighDepthRawSource(source: HighDepthRawSource): HighDepthRawSource {
  const data = new Uint16Array(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceIndex = (y * source.width + x) * 3;
      const targetIndex = (y * source.width + (source.width - 1 - x)) * 3;
      data[targetIndex] = source.data[sourceIndex];
      data[targetIndex + 1] = source.data[sourceIndex + 1];
      data[targetIndex + 2] = source.data[sourceIndex + 2];
    }
  }
  return { ...source, data };
}

function sampleHighDepthRaw(source: HighDepthRawSource, x: number, y: number, channel: number) {
  if (x < 0 || y < 0 || x > source.width - 1 || y > source.height - 1) {
    return 0;
  }

  const x0 = clamp(Math.floor(x), 0, source.width - 1);
  const y0 = clamp(Math.floor(y), 0, source.height - 1);
  const x1 = clamp(x0 + 1, 0, source.width - 1);
  const y1 = clamp(y0 + 1, 0, source.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const sample = (sampleX: number, sampleY: number) => source.data[(sampleY * source.width + sampleX) * 3 + channel] / 65_535;
  const top = sample(x0, y0) * (1 - fx) + sample(x1, y0) * fx;
  const bottom = sample(x0, y1) * (1 - fx) + sample(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function transformHighDepthRawSource(source: HighDepthRawSource, settings: ConversionSettings) {
  const rotation = settings.rotation + settings.levelAngle;
  const { width: rotatedWidth, height: rotatedHeight } = getTransformedDimensions(
    source.width,
    source.height,
    rotation,
  );
  const cropBounds = getCropPixelBounds(normalizeCrop(settings), rotatedWidth, rotatedHeight);
  const data = new Float32Array(cropBounds.width * cropBounds.height * 3);
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  for (let y = 0; y < cropBounds.height; y += 1) {
    for (let x = 0; x < cropBounds.width; x += 1) {
      const rotatedX = cropBounds.x + x + 0.5 - rotatedWidth / 2;
      const rotatedY = cropBounds.y + y + 0.5 - rotatedHeight / 2;
      const sourceX = cosine * rotatedX + sine * rotatedY + source.width / 2 - 0.5;
      const sourceY = -sine * rotatedX + cosine * rotatedY + source.height / 2 - 0.5;
      const targetIndex = (y * cropBounds.width + x) * 3;
      data[targetIndex] = sampleHighDepthRaw(source, sourceX, sourceY, 0);
      data[targetIndex + 1] = sampleHighDepthRaw(source, sourceX, sourceY, 1);
      data[targetIndex + 2] = sampleHighDepthRaw(source, sourceX, sourceY, 2);
    }
  }

  return {
    width: cropBounds.width,
    height: cropBounds.height,
    data,
    channels: 3 as const,
  };
}

function renderRotatedCanvasForJob(sourceCanvas: OffscreenCanvas, settings: ConversionSettings) {
  const rotation = settings.rotation + settings.levelAngle;
  const { width: rotatedWidth, height: rotatedHeight } = getTransformedDimensions(
    sourceCanvas.width,
    sourceCanvas.height,
    rotation,
  );

  const localRotateCanvas = new OffscreenCanvas(rotatedWidth, rotatedHeight);
  const rotateCtx = localRotateCanvas.getContext('2d', { willReadFrequently: true });
  if (!rotateCtx) throw new Error('Could not create rotation canvas.');

  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  rotateCtx.clearRect(0, 0, rotatedWidth, rotatedHeight);
  rotateCtx.translate(rotatedWidth / 2, rotatedHeight / 2);
  rotateCtx.rotate((rotation * Math.PI) / 180);
  rotateCtx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2, sourceCanvas.width, sourceCanvas.height);
  rotateCtx.setTransform(1, 0, 0, 1, 0, 0);

  return localRotateCanvas;
}

function renderCroppedCanvasForJob(rotatedCanvas: OffscreenCanvas, settings: ConversionSettings) {
  const cropBounds = getCropPixelBounds(normalizeCrop(settings), rotatedCanvas.width, rotatedCanvas.height);

  const localOutputCanvas = new OffscreenCanvas(cropBounds.width, cropBounds.height);
  const outputCtx = localOutputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputCtx) throw new Error('Could not create output canvas.');
  outputCtx.clearRect(0, 0, cropBounds.width, cropBounds.height);
  outputCtx.drawImage(
    rotatedCanvas,
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
  document.lastAccessedAt = Date.now();
  return document;
}

function resolveStoredInputProfileId(document: StoredDocument, inputMode: 'auto' | 'override', inputProfileId: ColorProfileId): InputProfileSpec {
  if (inputMode === 'override') {
    return inputProfileId;
  }

  return document.metadata.decoderColorProfileId ?? document.metadata.embeddedColorProfileId ?? document.metadata.embeddedParsedProfile ?? 'srgb';
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

function clearTileJob(jobId: string, preserveCancellation = false) {
  const job = tileJobs.get(jobId);
  tileJobs.delete(jobId);
  if (!preserveCancellation) {
    cancelledJobs.delete(jobId);
  }
  if (job) {
    releaseCanvasIfUnreferenced(job.transformedCanvas);
  }
}

function estimateMemoryBytes() {
  let total = 0;

  for (const document of documents.values()) {
    total += document.sourceCanvas.width * document.sourceCanvas.height * 4;
    total += document.highDepthRawSource?.data.byteLength ?? 0;

    for (const preview of document.previews) {
      if (preview.canvas !== document.sourceCanvas) {
        total += preview.canvas.width * preview.canvas.height * 4;
      }
    }

    for (const canvas of document.rotationCache.values()) {
      total += canvas.width * canvas.height * 4;
    }

    for (const job of document.cropCache.values()) {
      total += job.width * job.height * 4;
    }
  }

  for (const job of tileJobs.values()) {
    total += job.width * job.height * 4;
  }

  if (rotateCanvas) total += rotateCanvas.width * rotateCanvas.height * 4;
  if (outputCanvas) total += outputCanvas.width * outputCanvas.height * 4;

  return total;
}

function handleDiagnostics() {
  pruneCancelledJobs();
  let totalPreviewCanvases = 0;
  for (const document of documents.values()) {
    totalPreviewCanvases += document.previews.length;
  }

  return {
    documentCount: documents.size,
    totalPreviewCanvases,
    tileJobCount: tileJobs.size,
    cancelledJobCount: cancelledJobs.size,
    estimatedMemoryBytes: estimateMemoryBytes(),
  } satisfies WorkerMemoryDiagnostics;
}

function releaseEvictedRotationCanvases(canvases: OffscreenCanvas[]) {
  canvases.forEach((canvas) => releaseCanvasIfUnreferenced(canvas));
}

function releaseEvictedCropJobs(jobs: StoredTileJob[]) {
  jobs.forEach((job) => releaseCanvasIfUnreferenced(job.transformedCanvas));
}

function handleDispose(documentId: string) {
  const document = documents.get(documentId);
  if (!document) {
    return { disposed: true } as const;
  }

  Array.from(tileJobs.entries())
    .filter(([, job]) => job.documentId === documentId)
    .forEach(([jobId]) => clearTileJob(jobId));

  for (const [cacheKey, canvas] of Array.from(document.rotationCache.entries())) {
    document.rotationCache.delete(cacheKey);
    releaseCanvasIfUnreferenced(canvas);
  }

  for (const [cacheKey, job] of Array.from(document.cropCache.entries())) {
    document.cropCache.delete(cacheKey);
    releaseCanvasIfUnreferenced(job.transformedCanvas);
  }

  documents.delete(documentId);

  for (const preview of document.previews) {
    if (preview.canvas !== document.sourceCanvas) {
      releaseCanvas(preview.canvas);
    }
  }
  releaseCanvas(document.sourceCanvas);

  if (documents.size === 0) {
    if (rotateCanvas) {
      releaseCanvas(rotateCanvas);
      rotateCanvas = null;
    }
    if (outputCanvas) {
      releaseCanvas(outputCanvas);
      outputCanvas = null;
    }
    if (previewPresentationCanvas) {
      releaseCanvas(previewPresentationCanvas);
      previewPresentationCanvas = null;
    }
    releaseScratchBuffers();
  }

  return { disposed: true } as const;
}

function evictDocumentPreviews(documentId: string) {
  const document = documents.get(documentId);
  if (!document) {
    return false;
  }

  Array.from(tileJobs.entries())
    .filter(([, job]) => job.documentId === documentId)
    .forEach(([jobId]) => clearTileJob(jobId));

  for (const preview of document.previews) {
    if (preview.canvas !== document.sourceCanvas) {
      releaseCanvas(preview.canvas);
    }
  }

  document.previews = [{
    level: {
      id: 'preview-source',
      width: document.sourceCanvas.width,
      height: document.sourceCanvas.height,
      maxDimension: Math.max(document.sourceCanvas.width, document.sourceCanvas.height),
    },
    canvas: document.sourceCanvas,
  }];

  for (const canvas of document.rotationCache.values()) {
    releaseCanvasIfUnreferenced(canvas);
  }
  document.rotationCache.clear();

  for (const job of document.cropCache.values()) {
    releaseCanvasIfUnreferenced(job.transformedCanvas);
  }
  document.cropCache.clear();

  return true;
}

function handleEvictPreviews(payload: { documentId?: string | null; preserveDocumentId?: string | null; maxResidentDocuments?: number | null }) {
  if (payload.documentId) {
    evictDocumentPreviews(payload.documentId);
    return { evicted: true } as const;
  }

  if (payload.maxResidentDocuments === null || payload.maxResidentDocuments === undefined) {
    return { evicted: true } as const;
  }

  const keepLimit = Math.max(1, payload.maxResidentDocuments);
  const preserveDocumentId = payload.preserveDocumentId ?? null;
  const sortedDocuments = Array.from(documents.entries())
    .sort(([, left], [, right]) => right.lastAccessedAt - left.lastAccessedAt);

  const keepIds = new Set<string>();
  if (preserveDocumentId && documents.has(preserveDocumentId)) {
    keepIds.add(preserveDocumentId);
  }

  for (const [documentId] of sortedDocuments) {
    if (keepIds.size >= keepLimit) {
      break;
    }
    keepIds.add(documentId);
  }

  for (const [documentId] of sortedDocuments) {
    if (!keepIds.has(documentId)) {
      evictDocumentPreviews(documentId);
    }
  }

  return { evicted: true } as const;
}

function readAnalysisPreview(documentId: string) {
  const document = getStoredDocument(documentId);
  const preview = getOrCreatePreviewByMaxDimension(document, 1024);
  const context = preview.canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not read analysis preview.');
  }

  return context.getImageData(0, 0, preview.canvas.width, preview.canvas.height);
}

function handleDetectFrame(documentId: string) {
  const start = performance.now();
  const preview = readAnalysisPreview(documentId);
  const detected = detectFrame(preview.data, preview.width, preview.height);
  const durationMs = performance.now() - start;
  void durationMs;
  return detected;
}

function handleComputeFlare(documentId: string) {
  const start = performance.now();
  const preview = readAnalysisPreview(documentId);
  const flare = estimateFlare(preview.data, preview.width, preview.height);
  const durationMs = performance.now() - start;
  void durationMs;
  return flare;
}

function handlePreparePreviewBitmap(payload: PreparePreviewBitmapRequest) {
  previewPresentationCanvas = ensureCanvas(
    previewPresentationCanvas,
    payload.imageData.width,
    payload.imageData.height,
  );
  const context = previewPresentationCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw createError('PREVIEW_BITMAP_PREP_FAILED', 'Could not create preview presentation canvas.');
  }

  context.putImageData(payload.imageData, 0, 0);

  if (typeof previewPresentationCanvas.transferToImageBitmap !== 'function') {
    throw createError('PREVIEW_BITMAP_UNSUPPORTED', 'Worker preview bitmap preparation is unavailable.');
  }

  return {
    documentId: payload.documentId,
    revision: payload.revision,
    imageBitmap: previewPresentationCanvas.transferToImageBitmap(),
  } satisfies PreparedPreviewBitmapResult;
}

function applyDustRemovalIfNeeded(
  imageData: ImageData,
  settings: ConversionSettings,
) {
  const dustRemoval = resolveDustRemovalSettings(settings.dustRemoval);
  if (dustRemoval.marks.length === 0) {
    return;
  }
  applyDustRemoval(imageData, dustRemoval);
}

function cloneCanvas(sourceCanvas: OffscreenCanvas) {
  const canvas = new OffscreenCanvas(sourceCanvas.width, sourceCanvas.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not clone canvas.');
  }
  context.drawImage(sourceCanvas, 0, 0);
  return canvas;
}

function createDustRemovedCanvas(sourceCanvas: OffscreenCanvas, settings: ConversionSettings) {
  const dustRemoval = resolveDustRemovalSettings(settings.dustRemoval);
  if (dustRemoval.marks.length === 0) {
    return sourceCanvas;
  }

  const canvas = cloneCanvas(sourceCanvas);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not read dust removal canvas.');
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  applyDustRemovalIfNeeded(imageData, settings);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

interface AnalysisInversionOptions {
  settings: ConversionSettings;
  isColor: boolean;
  profileId?: string | null;
  filmType?: FilmProfileType;
  flareFloor?: [number, number, number] | null;
  lightSourceBias?: [number, number, number];
}

// Shared front-half of the conversion pipeline for analysis passes (auto
// white balance, dust detection). Mirrors processImageData up to the
// channel-balance stage so analysis sees the same positives as rendering.
function applyAnalysisInversionStage(
  imageData: ImageData,
  options: AnalysisInversionOptions,
  inputProfileId: InputProfileSpec,
  outputProfileId: ColorProfileId,
  document: StoredDocument,
  residualBaseOffset: [number, number, number] | null,
) {
  convertImageDataColorProfile(imageData, inputProfileId, outputProfileId);

  const { data } = imageData;
  const filmType = options.filmType ?? 'negative';
  const filmBaseBalance = getFilmBaseBalance(options.settings.filmBaseSample);
  const lightSourceBias = options.lightSourceBias ?? [1, 1, 1];
  const flareStrength = (options.settings.flareCorrection ?? 50) / 100;
  const flareFloorNormalized: [number, number, number] = options.flareFloor
    ? [options.flareFloor[0] / 255, options.flareFloor[1] / 255, options.flareFloor[2] / 255]
    : [0, 0, 0];
  const densityInversion = resolveDensityInversionParams(
    options.settings,
    options.isColor,
    filmType,
    options.profileId ?? null,
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
    inputProfileId,
    outputProfileId,
    options.flareFloor ?? null,
    flareStrength,
  );

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index] / 255;
    let g = data[index + 1] / 255;
    let b = data[index + 2] / 255;

    [r, g, b] = applyInversionStage(
      r,
      g,
      b,
      filmType,
      outputProfileId,
      filmBaseBalance,
      densityInversion,
      flareFloorNormalized,
      flareStrength,
      lightSourceBias,
      residualBaseOffset,
    );

    r *= options.settings.redBalance;
    g *= options.settings.greenBalance;
    b *= options.settings.blueBalance;

    data[index] = clamp(Math.round(clamp(r, 0, 1) * 255), 0, 255);
    data[index + 1] = clamp(Math.round(clamp(g, 0, 1) * 255), 0, 255);
    data[index + 2] = clamp(Math.round(clamp(b, 0, 1) * 255), 0, 255);
  }
}

function handleDustDetect(payload: DustDetectRequest) {
  const document = getStoredDocument(payload.documentId);
  const analysisTargetDimension = 1600;
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), analysisTargetDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const context = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not read transformed image for dust detection.');
  }

  const imageData = context.getImageData(0, 0, transformed.width, transformed.height);
  const residualBaseOffset = getPinnedResidualBaseOffset(
    document,
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    'srgb',
    'srgb',
    payload.lightSourceBias ?? [1, 1, 1],
    payload.flareFloor ?? null,
    payload.profileId ?? null,
  );
  applyAnalysisInversionStage(
    imageData,
    payload,
    'srgb',
    'srgb',
    document,
    residualBaseOffset,
  );
  const detectedMarks = detectDustMarks(imageData, payload.sensitivity, payload.maxRadius, payload.mode)
    .map((mark) => projectDustMarkFromTransformedSpace(
      mark,
      payload.settings,
      document.sourceCanvas.width,
      document.sourceCanvas.height,
    ));

  return {
    type: 'dust-detect',
    detectedMarks,
  } as const;
}

async function handleDecode(payload: DecodeRequest) {
  if (payload.mime === 'image/x-raw-rgba') {
    if (!payload.rawDimensions) {
      throw createError('RAW_INVALID', 'RAW decode payload is missing dimensions.');
    }

    const { width, height } = payload.rawDimensions;
    let canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Could not create RAW decode canvas.');
    }

    let highDepthRawSource: HighDepthRawSource | undefined = payload.highDepthRawBuffer
      ? {
        width,
        height,
        data: new Uint16Array(payload.highDepthRawBuffer),
        bitDepth: 16,
        transfer: payload.highDepthRawTransfer ?? 'srgb',
      }
      : undefined;
    const imageData = new ImageData(new Uint8ClampedArray(payload.buffer), width, height);
    ctx.putImageData(imageData, 0, 0);

    if (payload.mirrorHorizontal) {
      canvas = mirrorCanvasHorizontal(canvas);
      if (highDepthRawSource) {
        highDepthRawSource = mirrorHighDepthRawSource(highDepthRawSource);
      }
    }

    assertSupportedDimensions(canvas.width, canvas.height);

    const previewStore = buildPreviewLevels(canvas, payload.displayScaleFactor);
    const rawEstimate = payload.precomputedFilmBase
      ?? normalizeFilmBaseEstimate(payload.precomputedFilmBaseSample ?? estimateCanvasFilmBase(canvas));
    const priorDensityBalance = estimateCanvasDensityBalance(canvas, rawEstimate?.sample ?? null);
    const guarded = guardFilmBaseAgainstCrush(rawEstimate, previewStore, priorDensityBalance);
    const estimatedFilmBase = guarded.estimate;
    const estimatedFilmBaseSample = estimatedFilmBase?.sample ?? null;
    const estimatedDensityBalance = guarded.densityBalance;
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
      highDepthRawSource,
      previews: previewStore,
      rotationCache: new Map(),
      cropCache: new Map(),
      residualBaseCache: new Map(),
      highlightDensityCache: new Map(),
      estimatedFilmBaseSample,
      estimatedFilmBase,
      estimatedDensityBalance,
      lastAccessedAt: Date.now(),
    });

    const estimatedFlare = handleComputeFlare(payload.documentId);

    return {
      metadata,
      previewLevels: previewStore.map((preview) => preview.level),
      estimatedFlare,
      estimatedFilmBaseSample,
      estimatedFilmBase,
      estimatedDensityBalance,
    } satisfies DecodedImage;
  }

  if (payload.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw createError(
      'FILE_TOO_LARGE',
      `File size (${Math.round(payload.buffer.byteLength / 1024 / 1024)} MB) exceeds the ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB limit. Try a smaller scan or reduce the scan resolution.`,
    );
  }

  const extension = getFileExtension(payload.fileName);
  if (RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number])) {
    throw createError('RAW_UNSUPPORTED', 'RAW import is reserved for the future desktop decode path. Use TIFF, JPEG, PNG, or WebP in the browser build.');
  }

  const isTiff = extension === '.tif' || extension === '.tiff' || payload.mime === 'image/tiff';
  let decodedCanvas: OffscreenCanvas;
  let exif: SourceMetadata['exif'];
  let embeddedColorProfileName: string | null = null;
  let embeddedColorProfileId: ColorProfileId | null = null;
  let embeddedParsedProfile: ParsedInputProfile | null = null;
  let unsupportedColorProfileName: string | null = null;

  try {
    if (isTiff) {
      const decodedTiff = decodeTiff(payload.buffer);
      decodedCanvas = decodedTiff.canvas;
      exif = decodedTiff.orientation ? { orientation: decodedTiff.orientation } : undefined;
      const identified = parseInputIccProfile(decodedTiff.iccProfile);
      embeddedColorProfileName = identified.profileName;
      embeddedColorProfileId = identified.profileId;
      embeddedParsedProfile = identified.parsedProfile;
      unsupportedColorProfileName = identified.profileId || identified.parsedProfile ? null : (decodedTiff.iccProfile ? 'Embedded ICC profile' : null);
    } else {
      decodedCanvas = await decodeRasterBlob(payload.buffer, payload.mime);
      const isJpeg = extension === '.jpg' || extension === '.jpeg' || payload.mime === 'image/jpeg';
      exif = isJpeg ? extractExifMetadata(payload.buffer) : undefined;
      const extractedProfile = extractRasterColorProfile(payload.buffer, payload.mime, extension);
      embeddedColorProfileName = extractedProfile.profileName;
      embeddedColorProfileId = extractedProfile.profileId;
      embeddedParsedProfile = extractedProfile.parsedProfile;
      unsupportedColorProfileName = extractedProfile.unsupportedProfileName;
    }
  } catch (error) {
    if (error instanceof TiffDecodeError) {
      throw createError(error.code, error.message);
    }
    throw error;
  }

  if (mirrorFromExifOrientation(exif?.orientation)) {
    decodedCanvas = mirrorCanvasHorizontal(decodedCanvas);
  }

  assertSupportedDimensions(decodedCanvas.width, decodedCanvas.height);

  const previewStore = buildPreviewLevels(decodedCanvas, payload.displayScaleFactor);
  const rasterEstimate = normalizeFilmBaseEstimate(estimateCanvasFilmBase(decodedCanvas));
  const rasterPriorDensityBalance = estimateCanvasDensityBalance(decodedCanvas, rasterEstimate?.sample ?? null);
  const rasterGuarded = guardFilmBaseAgainstCrush(rasterEstimate, previewStore, rasterPriorDensityBalance);
  const estimatedFilmBase = rasterGuarded.estimate;
  const estimatedFilmBaseSample = estimatedFilmBase?.sample ?? null;
  const estimatedDensityBalance = rasterGuarded.densityBalance;
  const decoderColorProfileId = payload.declaredColorProfileId ?? getColorProfileIdFromName(payload.declaredColorProfileName);
  const declaredUnsupportedColorProfileName = payload.declaredColorProfileName && !decoderColorProfileId
    ? payload.declaredColorProfileName
    : null;
  const metadata: SourceMetadata = {
    id: payload.documentId,
    name: payload.fileName,
    mime: payload.mime || (isTiff ? 'image/tiff' : 'image/*'),
    extension,
    size: payload.size,
    width: decodedCanvas.width,
    height: decodedCanvas.height,
    ...(exif ? { exif } : {}),
    ...(embeddedColorProfileName ? { embeddedColorProfileName } : {}),
    ...(embeddedColorProfileId ? { embeddedColorProfileId } : {}),
    ...(embeddedParsedProfile ? { embeddedParsedProfile } : {}),
    ...(payload.declaredColorProfileName ? { decoderColorProfileName: payload.declaredColorProfileName } : {}),
    ...(decoderColorProfileId ? { decoderColorProfileId } : {}),
    ...((unsupportedColorProfileName ?? declaredUnsupportedColorProfileName) ? { unsupportedColorProfileName: unsupportedColorProfileName ?? declaredUnsupportedColorProfileName } : {}),
  };

  documents.set(payload.documentId, {
    metadata,
    sourceCanvas: decodedCanvas,
    previews: previewStore,
    rotationCache: new Map(),
    cropCache: new Map(),
    residualBaseCache: new Map(),
    highlightDensityCache: new Map(),
    estimatedFilmBaseSample,
    estimatedFilmBase,
    estimatedDensityBalance,
    lastAccessedAt: Date.now(),
  });

  const estimatedFlare = handleComputeFlare(payload.documentId);

  return {
    metadata,
    previewLevels: previewStore.map((preview) => preview.level),
    estimatedFlare,
    estimatedFilmBaseSample,
    estimatedFilmBase,
    estimatedDensityBalance,
  } satisfies DecodedImage;
}

function handlePrepareTileJob(payload: PrepareTileJobRequest) {
  const document = getStoredDocument(payload.documentId);
  clearTileJob(payload.jobId);
  const source = getTileSource(document, payload);
  const hasDustRemoval = payload.comparisonMode === 'processed'
    && resolveDustRemovalSettings(payload.settings.dustRemoval).marks.length > 0;

  if (hasDustRemoval) {
    const dustCleanedCanvas = createDustRemovedCanvas(source.canvas, payload.settings);
    const rotatedCanvas = renderRotatedCanvasForJob(dustCleanedCanvas, payload.settings);
    const transformed = renderCroppedCanvasForJob(rotatedCanvas, payload.settings);
    releaseCanvas(dustCleanedCanvas);
    releaseCanvas(rotatedCanvas);
    tileJobs.set(payload.jobId, {
      documentId: payload.documentId,
      sourceKind: payload.sourceKind,
      previewLevelId: source.previewLevelId,
      transformedCanvas: transformed.canvas,
      width: transformed.width,
      height: transformed.height,
      halo: getHalo(payload.settings, payload.comparisonMode),
      comparisonMode: payload.comparisonMode,
    });

    return {
      documentId: payload.documentId,
      jobId: payload.jobId,
      sourceKind: payload.sourceKind,
      width: transformed.width,
      height: transformed.height,
      previewLevelId: source.previewLevelId,
      tileSize: TILE_SIZE,
      halo: getHalo(payload.settings, payload.comparisonMode),
      geometryCacheHit: false,
    } satisfies PreparedTileJobResult;
  }

  const prepared = prepareGeometryCacheEntry({
    rotationCache: document.rotationCache,
    cropCache: document.cropCache,
    sourceKind: payload.sourceKind,
    previewLevelId: source.previewLevelId,
    settings: payload.settings,
    createRotation: () => renderRotatedCanvasForJob(source.canvas, payload.settings),
    createCrop: (rotationCanvas) => {
      const transformed = renderCroppedCanvasForJob(rotationCanvas, payload.settings);
      return {
        documentId: payload.documentId,
        sourceKind: payload.sourceKind,
        previewLevelId: source.previewLevelId,
        transformedCanvas: transformed.canvas,
        width: transformed.width,
        height: transformed.height,
        halo: 0,
        comparisonMode: payload.comparisonMode,
      } satisfies StoredTileJob;
    },
  });
  releaseEvictedRotationCanvases(prepared.evictedRotations);
  releaseEvictedCropJobs(prepared.evictedCrops);

  const halo = getHalo(payload.settings, payload.comparisonMode);
  tileJobs.set(payload.jobId, {
    ...prepared.cropJob,
    halo,
  });

  return {
    documentId: payload.documentId,
    jobId: payload.jobId,
    sourceKind: payload.sourceKind,
    width: prepared.cropJob.width,
    height: prepared.cropJob.height,
    previewLevelId: source.previewLevelId,
    tileSize: TILE_SIZE,
    halo,
    geometryCacheHit: prepared.geometryCacheHit,
  } satisfies PreparedTileJobResult;
}

function handleReadTile(payload: ReadTileRequest) {
  if (isRecentlyCancelledJob(payload.jobId)) {
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

  if (isRecentlyCancelledJob(payload.jobId)) {
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
  pruneCancelledJobs();
  cancelledJobs.set(payload.jobId, performance.now());
  clearTileJob(payload.jobId, true);
  return { cancelled: true } as const;
}

function sampleRegionFromTransformedCanvas(
  transformed: { canvas: OffscreenCanvas; width: number; height: number },
  payload: SampleRequest,
) {
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not sample image region.');
  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  convertImageDataColorProfile(imageData, payload.inputProfileId ?? 'srgb', payload.outputProfileId ?? 'srgb');
  ctx.putImageData(imageData, 0, 0);

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

function handleAutoAnalyze(payload: AutoAnalyzeRequest) {
  const document = getStoredDocument(payload.documentId);
  const analysisTargetDimension = Math.min(payload.targetMaxDimension, 1024);
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), analysisTargetDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not analyze auto adjustments.');

  const toneImageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const residualBaseOffset = getPinnedResidualBaseOffset(
    document,
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.lightSourceBias ?? [1, 1, 1],
    payload.flareFloor ?? null,
    payload.profileId ?? null,
  );
  const toneHistogram = processImageData(
    toneImageData,
    payload.settings,
    payload.isColor,
    'processed',
    payload.maskTuning,
    payload.colorMatrix,
    payload.tonalCharacter,
    payload.labStyleToneCurve,
    payload.labStyleChannelCurves,
    payload.labTonalCharacterOverride,
    payload.labSaturationBias ?? 0,
    payload.labTemperatureBias ?? 0,
    payload.highlightDensityEstimate ?? 0,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.profileId ?? null,
    payload.filmType ?? 'negative',
    residualBaseOffset,
    payload.flareFloor ?? null,
    payload.lightSourceBias ?? [1, 1, 1],
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
  );

  const whiteBalanceImageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  applyAnalysisInversionStage(
    whiteBalanceImageData,
    payload,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    document,
    residualBaseOffset,
  );

  const isColorNegative = payload.isColor && (payload.filmType ?? 'negative') === 'negative';
  const channelFloors = analyzeChannelFloors(whiteBalanceImageData);
  const hasSuggestedCurves = channelFloors.redFloor !== null
    || channelFloors.greenFloor !== null
    || channelFloors.blueFloor !== null;
  const midtone = analyzeMidtoneContrast(toneHistogram);

  return {
    ...analyzeExposure(toneHistogram),
    ...analyzeColorBalance(whiteBalanceImageData, isColorNegative),
    contrast: midtone.contrast,
    midtoneBoostPoint: midtone.midtoneBoostPoint,
    suggestedCurves: hasSuggestedCurves ? channelFloors : null,
  } satisfies AutoAnalyzeResult;
}

function handleRender(payload: RenderRequest) {
  const document = getStoredDocument(payload.documentId);
  const level = selectPreviewLevel(document.previews.map((preview) => preview.level), payload.targetMaxDimension);
  const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
  const previewSource = payload.comparisonMode === 'processed'
    ? createDustRemovedCanvas(preview.canvas, payload.settings)
    : preview.canvas;
  const transformed = renderTransformedCanvas(previewSource, payload.settings);
  if (previewSource !== preview.canvas) {
    releaseCanvas(previewSource);
  }
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read rendered preview.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const usesProcessedPipeline = !payload.skipProcessing && payload.comparisonMode === 'processed';
  const residualBaseOffset = usesProcessedPipeline
    ? getPinnedResidualBaseOffset(
      document,
      payload.settings,
      payload.isColor,
      payload.filmType ?? 'negative',
      payload.inputProfileId ?? 'srgb',
      payload.outputProfileId ?? 'srgb',
      payload.lightSourceBias ?? [1, 1, 1],
      payload.flareFloor ?? null,
      payload.profileId ?? null,
    )
    : null;
  const pinnedHighlightDensity = usesProcessedPipeline
    ? getPinnedHighlightDensity(document, payload, residualBaseOffset)
    : 0;
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
      payload.labStyleToneCurve,
      payload.labStyleChannelCurves,
      payload.labTonalCharacterOverride,
      payload.labSaturationBias ?? 0,
      payload.labTemperatureBias ?? 0,
      pinnedHighlightDensity,
      payload.inputProfileId ?? 'srgb',
      payload.outputProfileId ?? 'srgb',
      payload.profileId ?? null,
      payload.filmType ?? 'negative',
      residualBaseOffset,
      payload.flareFloor ?? null,
      payload.lightSourceBias ?? [1, 1, 1],
      document.estimatedFilmBase,
      document.estimatedDensityBalance,
    );
  const highlightDensity = usesProcessedPipeline ? pinnedHighlightDensity : computeHighlightDensity(histogram);

  if (!payload.skipProcessing) {
    ctx.putImageData(imageData, 0, 0);
  }

  // Resolve the base provenance/confidence the render actually used so the main
  // thread can raise a one-time low-confidence notice without recomputing.
  const densityInversion = resolveDensityInversionParams(
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    payload.profileId ?? null,
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.flareFloor ?? null,
    (payload.settings.flareCorrection ?? 50) / 100,
  );

  return {
    documentId: payload.documentId,
    revision: payload.revision,
    width: transformed.width,
    height: transformed.height,
    previewLevelId: preview.level.id,
    imageData,
    histogram,
    highlightDensity,
    baseSampleSource: densityInversion.baseSampleSource,
    lowConfidence: densityInversion.lowConfidence,
  } satisfies RenderResult;
}

function handleSampleFilmBase(payload: SampleRequest) {
  const document = getStoredDocument(payload.documentId);
  // Sample from the source-resolution canvas: preview levels are resampled
  // (anti-aliased), which biases the picked base value (audit 2.8).
  const transformed = renderTransformedCanvas(document.sourceCanvas, payload.settings);
  return sampleRegionFromTransformedCanvas(transformed, payload);
}

function canUseHighDepthRawExport(document: StoredDocument, payload: ExportRequest) {
  return Boolean(
    document.highDepthRawSource
    && payload.options.bitDepth === 16
    && (payload.options.format === 'image/tiff' || payload.options.format === 'image/png')
    && resolveDustRemovalSettings(payload.settings.dustRemoval).marks.length === 0,
  );
}

async function handleExport(payload: ExportRequest) {
  const document = getStoredDocument(payload.documentId);
  const filename = `${sanitizeFilenameBase(payload.options.filenameBase)}.${getExtensionFromFormat(payload.options.format)}`;

  if (canUseHighDepthRawExport(document, payload) && document.highDepthRawSource) {
    const transformed = transformHighDepthRawSource(document.highDepthRawSource, payload.settings);
    const residualBaseOffset = getPinnedResidualBaseOffset(
      document,
      payload.settings,
      payload.isColor,
      payload.filmType ?? 'negative',
      payload.inputProfileId ?? 'srgb',
      payload.outputProfileId ?? 'srgb',
      payload.lightSourceBias ?? [1, 1, 1],
      payload.flareFloor ?? null,
      payload.profileId ?? null,
    );
    const pinnedHighlightDensity = getPinnedHighlightDensity(document, payload, residualBaseOffset);

    if (!payload.skipProcessing) {
      processFloatRaster(
        transformed,
        payload.settings,
        payload.isColor,
        'processed',
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
        payload.labStyleToneCurve,
        payload.labStyleChannelCurves,
        payload.labTonalCharacterOverride,
        payload.labSaturationBias ?? 0,
        payload.labTemperatureBias ?? 0,
        pinnedHighlightDensity,
        payload.inputProfileId ?? 'srgb',
        payload.outputProfileId ?? 'srgb',
        payload.profileId ?? null,
        payload.filmType ?? 'negative',
        residualBaseOffset,
        payload.flareFloor ?? null,
        payload.lightSourceBias ?? [1, 1, 1],
        document.estimatedFilmBase,
        document.estimatedDensityBalance,
      );
    }

    const encoded = await encodeExportRaster(transformed, payload.options);

    return {
      blob: encoded.blob,
      filename,
      bitDepthDowngraded: encoded.bitDepthDowngraded,
    } satisfies ExportResult;
  }

  const exportSource = createDustRemovedCanvas(document.sourceCanvas, payload.settings);
  const transformed = renderTransformedCanvas(exportSource, payload.settings);
  if (exportSource !== document.sourceCanvas) {
    releaseCanvas(exportSource);
  }
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create export canvas.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);
  const residualBaseOffset = getPinnedResidualBaseOffset(
    document,
    payload.settings,
    payload.isColor,
    payload.filmType ?? 'negative',
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.lightSourceBias ?? [1, 1, 1],
    payload.flareFloor ?? null,
    payload.profileId ?? null,
  );
  const pinnedHighlightDensity = getPinnedHighlightDensity(document, payload, residualBaseOffset);

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
    payload.labStyleToneCurve,
    payload.labStyleChannelCurves,
    payload.labTonalCharacterOverride,
    payload.labSaturationBias ?? 0,
    payload.labTemperatureBias ?? 0,
    pinnedHighlightDensity,
    payload.inputProfileId ?? 'srgb',
    payload.outputProfileId ?? 'srgb',
    payload.profileId ?? null,
    payload.filmType ?? 'negative',
    residualBaseOffset,
    payload.flareFloor ?? null,
    payload.lightSourceBias ?? [1, 1, 1],
    document.estimatedFilmBase,
    document.estimatedDensityBalance,
  );
  ctx.putImageData(imageData, 0, 0);

  const encoded = await encodeExportRaster(imageData, payload.options);

  return {
    blob: encoded.blob,
    filename,
    bitDepthDowngraded: encoded.bitDepthDowngraded,
    bitDepthDowngradeReason: encoded.bitDepthDowngraded && document.highDepthRawSource && resolveDustRemovalSettings(payload.settings.dustRemoval).marks.length > 0
      ? 'dust-removal'
      : (encoded.bitDepthDowngraded ? 'missing-high-depth-source' : undefined),
  } satisfies ExportResult;
}

async function handleContactSheet(payload: ContactSheetRequest) {
  const columns = clamp(Math.round(payload.columns), 1, 8);
  const rows = Math.max(1, Math.ceil(payload.cells.length / columns));
  const captionHeight = payload.showCaptions ? payload.captionFontSize + 8 : 0;
  const totalWidth = columns * payload.cellMaxDimension + (columns + 1) * payload.margin;
  const totalHeight = rows * (payload.cellMaxDimension + captionHeight) + (rows + 1) * payload.margin;
  const canvas = new OffscreenCanvas(totalWidth, totalHeight);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not create contact sheet canvas.');
  }

  context.fillStyle = `rgb(${payload.backgroundColor[0]} ${payload.backgroundColor[1]} ${payload.backgroundColor[2]})`;
  context.fillRect(0, 0, totalWidth, totalHeight);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.font = `${payload.captionFontSize}px monospace`;
  context.fillStyle = payload.backgroundColor[0] + payload.backgroundColor[1] + payload.backgroundColor[2] > 382 ? '#111111' : '#f4f4f5';

  for (let index = 0; index < payload.cells.length; index += 1) {
    const cell = payload.cells[index];
    const settings = payload.settingsPerCell[index];
    const profile = payload.profilePerCell[index];
    const document = getStoredDocument(cell.documentId);
    const colorManagement = payload.colorManagementPerCell[index];
    const level = selectPreviewLevel(
      document.previews.map((preview) => preview.level),
      payload.cellMaxDimension,
    );
    const preview = document.previews.find((candidate) => candidate.level.id === level.id) ?? document.previews[document.previews.length - 1];
    const previewSource = createDustRemovedCanvas(preview.canvas, settings);
    const transformed = renderTransformedCanvas(previewSource, settings);
    if (previewSource !== preview.canvas) {
      releaseCanvas(previewSource);
    }
    const sourceContext = transformed.canvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) {
      throw new Error('Could not render contact sheet cell.');
    }

    const imageData = sourceContext.getImageData(0, 0, transformed.width, transformed.height);
    const cellInputProfileId = resolveStoredInputProfileId(document, colorManagement?.inputMode ?? 'auto', colorManagement?.inputProfileId ?? 'srgb');
    const cellAnalysisArgs = {
      settings,
      isColor: usesColorChannelPipeline(profile),
      profileId: profile.id,
      filmType: profile.filmType ?? 'negative',
      inputProfileId: cellInputProfileId,
      outputProfileId: payload.exportOptions.outputProfileId,
      lightSourceBias: payload.lightSourceBiasPerCell?.[index] ?? [1, 1, 1] as [number, number, number],
      flareFloor: payload.flareFloorPerCell?.[index] ?? null,
      maskTuning: profile.maskTuning,
      colorMatrix: profile.colorMatrix,
      tonalCharacter: profile.tonalCharacter,
      labStyleToneCurve: payload.labStyleToneCurvePerCell?.[index],
      labStyleChannelCurves: payload.labStyleChannelCurvesPerCell?.[index],
      labTonalCharacterOverride: payload.labTonalCharacterOverridePerCell?.[index],
      labSaturationBias: payload.labSaturationBiasPerCell?.[index] ?? 0,
      labTemperatureBias: payload.labTemperatureBiasPerCell?.[index] ?? 0,
    };
    const residualBaseOffset = getPinnedResidualBaseOffset(
      document,
      settings,
      cellAnalysisArgs.isColor,
      cellAnalysisArgs.filmType,
      cellInputProfileId,
      payload.exportOptions.outputProfileId,
      cellAnalysisArgs.lightSourceBias,
      cellAnalysisArgs.flareFloor,
      profile.id,
    );
    const cellHighlightDensity = getPinnedHighlightDensity(document, cellAnalysisArgs, residualBaseOffset);
    processImageData(
      imageData,
      settings,
      cellAnalysisArgs.isColor,
      'processed',
      profile.maskTuning,
      profile.colorMatrix,
      profile.tonalCharacter,
      payload.labStyleToneCurvePerCell?.[index],
      payload.labStyleChannelCurvesPerCell?.[index],
      payload.labTonalCharacterOverridePerCell?.[index],
      payload.labSaturationBiasPerCell?.[index] ?? 0,
      payload.labTemperatureBiasPerCell?.[index] ?? 0,
      cellHighlightDensity,
      cellInputProfileId,
      payload.exportOptions.outputProfileId,
      profile.id,
      profile.filmType ?? 'negative',
      residualBaseOffset,
      payload.flareFloorPerCell?.[index] ?? null,
      payload.lightSourceBiasPerCell?.[index] ?? [1, 1, 1],
      document.estimatedFilmBase,
      document.estimatedDensityBalance,
    );

    const col = index % columns;
    const row = Math.floor(index / columns);
    const cellX = payload.margin + col * (payload.cellMaxDimension + payload.margin);
    const cellY = payload.margin + row * (payload.cellMaxDimension + captionHeight + payload.margin);
    const scale = Math.min(payload.cellMaxDimension / imageData.width, payload.cellMaxDimension / imageData.height, 1);
    const drawWidth = Math.max(1, Math.round(imageData.width * scale));
    const drawHeight = Math.max(1, Math.round(imageData.height * scale));
    const drawX = cellX + Math.round((payload.cellMaxDimension - drawWidth) / 2);
    const drawY = cellY + Math.round((payload.cellMaxDimension - drawHeight) / 2);

    const cellCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const cellContext = cellCanvas.getContext('2d', { willReadFrequently: true });
    if (!cellContext) {
      throw new Error('Could not compose contact sheet cell.');
    }
    cellContext.putImageData(imageData, 0, 0);
    context.drawImage(cellCanvas, drawX, drawY, drawWidth, drawHeight);

    if (payload.showCaptions) {
      context.fillText(
        cell.label,
        cellX + payload.cellMaxDimension / 2,
        cellY + payload.cellMaxDimension + 8,
        payload.cellMaxDimension,
      );
    }
  }

  const blob = await canvas.convertToBlob({
    type: payload.exportOptions.format,
    quality: payload.exportOptions.format === 'image/png' ? undefined : payload.exportOptions.quality,
  });

  return {
    blob,
    width: totalWidth,
    height: totalHeight,
    filename: `${sanitizeFilenameBase(payload.exportOptions.filenameBase)}.${getExtensionFromFormat(payload.exportOptions.format)}`,
  } satisfies ContactSheetResult;
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const request = event.data;
  pruneCancelledJobs();

  try {
    switch (request.type) {
      case 'dispose':
        reply(request, handleDispose(request.payload.documentId));
        return;
      case 'decode':
        reply(request, await handleDecode(request.payload));
        return;
      case 'render': {
        const result = handleRender(request.payload);
        reply(request, result, [result.imageData.data.buffer]);
        return;
      }
      case 'auto-analyze':
        reply(request, handleAutoAnalyze(request.payload));
        return;
      case 'prepare-tile-job':
        reply(request, handlePrepareTileJob(request.payload));
        return;
      case 'prepare-preview-bitmap': {
        const result = handlePreparePreviewBitmap(request.payload);
        reply(request, result, [result.imageBitmap]);
        return;
      }
      case 'read-tile': {
        const result = handleReadTile(request.payload);
        reply(request, result, [result.imageData.data.buffer]);
        return;
      }
      case 'cancel-job':
        reply(request, handleCancelJob(request.payload));
        return;
      case 'sample-film-base':
        reply(request, handleSampleFilmBase(request.payload));
        return;
      case 'conversion-analysis':
        reply(request, handleConversionAnalysis(request.payload));
        return;
      case 'detect-frame':
        reply(request, handleDetectFrame(request.payload.documentId));
        return;
      case 'compute-flare':
        reply(request, handleComputeFlare(request.payload.documentId));
        return;
      case 'dust-detect':
        reply(request, handleDustDetect(request.payload));
        return;
      case 'export':
        reply(request, await handleExport(request.payload));
        return;
      case 'contact-sheet':
        reply(request, await handleContactSheet(request.payload));
        return;
      case 'diagnostics':
        reply(request, handleDiagnostics());
        return;
      case 'evict-previews':
        reply(request, handleEvictPreviews(request.payload));
        return;
      default: {
        const exhaustiveCheck: never = request;
        throw createError('WORKER_UNKNOWN_REQUEST', `Unsupported worker request: ${String(exhaustiveCheck)}`);
      }
    }
  } catch (error) {
    const failure = error as Partial<WorkerError> & { message?: string };
    const isOOM = error instanceof RangeError
      || Boolean(failure.message && /invalid array length|out of memory|allocation failed/i.test(failure.message));
    replyError(request, createError(
      isOOM ? 'OUT_OF_MEMORY' : (failure.code ?? 'WORKER_ERROR'),
      isOOM
        ? 'Image too large for available memory. Try closing other tabs or using a smaller scan resolution.'
        : (failure.message ?? String(error)),
    ));
  }
};
