import {
  AutoAnalyzeRequest,
  AutoAnalyzeResult,
  ApplyFilmBaseEstimateRequest,
  ColorProfileId,
  ContactSheetRequest,
  ContactSheetResult,
  ConversionAnalysisRequest,
  ConversionAnalysisResult,
  ConversionParametersDebug,
  ConversionSettings,
  CubeLut,
  DecodeRequest,
  DensityBalance,
  DecodedImage,
  DetectedFrame,
  DustMark,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  FilmBaseEstimate,
  FilmProfileType,
  HistogramData,
  HistogramMode,
  InputProfileSpec,
  InteractionQuality,
  LensDistortionEstimate,
  PreparedPreviewBitmapResult,
  PrepareTileJobRequest,
  PreparedTileJobResult,
  PreviewMode,
  ReadTileRequest,
  ReadTileResult,
  ReestimateFilmBaseRequest,
  ReestimateFilmBaseResult,
  RenderBackendMode,
  RenderBackendDiagnostics,
  RenderJobDiagnosticsSnapshot,
  RenderPhaseTimings,
  RenderRequest,
  RenderResult,
  SampleRequest,
  TileSourceKind,
  WorkerMemoryDiagnostics,
} from '../types';
import { appendDiagnostic } from './diagnostics';
import { pushToast } from './toastStore';
import { accumulateHistogram, buildEmptyHistogram, computeHighlightDensity, getExtensionFromFormat, sanitizeFilenameBase } from './imagePipeline';
import { getBlobUrlDiagnostics } from './blobUrlTracker';
import { convertImageDataColorProfile, getInputProfileLabel, getPreferredPreviewDisplayProfile } from './colorProfiles';
import { WebGPUPipeline } from './gpu/WebGPUPipeline';
import { finalizeExportBlob } from './imageMetadata';
import { WorkerMessage, WorkerRequest, WorkerResponse } from './workerProtocol';
import { encodeExportRaster } from './exportEncoder';

type ImageWorkerClientOptions = {
  gpuEnabled?: boolean;
  onBackendDiagnosticsChange?: (diagnostics: RenderBackendDiagnostics) => void;
  onGPUDeviceLost?: (message: string) => void;
  onExportStateChange?: (isExporting: boolean) => void;
};

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number | null;
};

type CachedDecodeRequest = {
  payload: DecodeRequest;
  estimatedFilmBaseSample: FilmBaseSample | null;
  estimatedFilmBase: FilmBaseEstimate | null;
  estimatedDensityBalance: DensityBalance | null;
  workerEpoch: number;
  evictionTimeout: number | null;
};

type DocumentCalibration = {
  estimatedFilmBaseSample: FilmBaseSample | null;
  estimatedFilmBase: FilmBaseEstimate | null;
  estimatedDensityBalance: DensityBalance | null;
};

type DecodeOptions = {
  retainRecoveryCache?: boolean;
};

export type DocumentReloaders = {
  preview: () => Promise<DecodeRequest>;
  full: () => Promise<DecodeRequest>;
};

type DocumentDecodeInfo = {
  mime: string;
  hasHighDepthRawSource: boolean;
};

type ThumbnailRenderWaiter = {
  resolve: (result: RenderResult) => void;
  reject: (reason?: unknown) => void;
};

type QueuedThumbnailRender = {
  payload: RenderRequest;
  waiters: ThumbnailRenderWaiter[];
};

export type CachedThumbnailPreview = {
  imageData: ImageData;
  settings: ConversionSettings;
  comparisonMode: 'processed' | 'original';
  labStyleToneCurve?: RenderRequest['labStyleToneCurve'];
  labStyleChannelCurves?: RenderRequest['labStyleChannelCurves'];
};

const MISSING_DOCUMENT_MESSAGE = 'The image document is no longer available.';
const DECODE_CACHE_TTL_MS = 60_000;
const CPU_INTERACTIVE_PREVIEW_MAX_DIMENSION = 512;
const WORKER_REQUEST_TIMEOUT_MS: Record<WorkerRequest['type'], number> = {
  decode: 15_000,
  render: 10_000,
  'auto-analyze': 10_000,
  'prepare-tile-job': 10_000,
  'prepare-preview-bitmap': 10_000,
  'read-tile': 10_000,
  'cancel-job': 5_000,
  'sample-film-base': 10_000,
  'reestimate-film-base': 10_000,
  'apply-film-base-estimate': 10_000,
  'conversion-analysis': 10_000,
  'detect-frame': 10_000,
  'estimate-lens-distortion': 15_000,
  'compute-flare': 10_000,
  'dust-detect': 10_000,
  export: 30_000,
  'contact-sheet': 30_000,
  diagnostics: 5_000,
  dispose: 5_000,
  'evict-previews': 5_000,
};

// The worker is single-threaded and processes messages in order, so anything
// posted while one of these is running is starved rather than stuck. Their own
// timeouts stay fatal — they remain the liveness check while they run.
const BLOCKING_REQUEST_TYPES = new Set<WorkerRequest['type']>(['export', 'contact-sheet']);

// Cancellation is advisory: callers already ignore its failures. A late reply
// must never take the worker down with every other job riding on it.
const NON_FATAL_TIMEOUT_REQUEST_TYPES = new Set<WorkerRequest['type']>(['cancel-job']);

function trimTileImageData(tile: ReadTileResult) {
  const { imageData, haloLeft, haloTop, haloRight, haloBottom } = tile;
  const width = imageData.width - haloLeft - haloRight;
  const height = imageData.height - haloTop - haloBottom;
  const result = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((row + haloTop) * imageData.width + haloLeft) * 4;
    const targetOffset = row * width * 4;
    result.set(imageData.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return new ImageData(result, width, height);
}

function blitTile(
  target: Uint8ClampedArray,
  targetWidth: number,
  tileX: number,
  tileY: number,
  tileImage: ImageData,
) {
  for (let row = 0; row < tileImage.height; row += 1) {
    const sourceOffset = row * tileImage.width * 4;
    const targetOffset = ((tileY + row) * targetWidth + tileX) * 4;
    target.set(tileImage.data.subarray(sourceOffset, sourceOffset + tileImage.width * 4), targetOffset);
  }
}

function buildTileRects(width: number, height: number, tileSize: number) {
  const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
      });
    }
  }
  return tiles;
}

function cloneHistogram(histogram: HistogramData): HistogramData {
  return {
    r: [...histogram.r],
    g: [...histogram.g],
    b: [...histogram.b],
    l: [...histogram.l],
  };
}

function createJobSnapshot(
  backendMode: RenderBackendMode,
  sourceKind: TileSourceKind,
  previewMode: PreviewMode | null,
  previewLevelId: string | null,
  interactionQuality: InteractionQuality | null,
  histogramMode: HistogramMode | null,
  tileSize: number | null,
  halo: number | null,
  tileCount: number | null,
  intermediateFormat: RenderBackendDiagnostics['intermediateFormat'],
  usedCpuFallback: boolean,
  fallbackReason: string | null,
  jobDurationMs: number | null,
  geometryCacheHit: boolean | null,
  phaseTimings: RenderPhaseTimings | null,
): RenderJobDiagnosticsSnapshot {
  return {
    backendMode,
    sourceKind,
    previewMode,
    previewLevelId,
    interactionQuality,
    histogramMode,
    tileSize,
    halo,
    tileCount,
    intermediateFormat,
    usedCpuFallback,
    fallbackReason,
    jobDurationMs,
    geometryCacheHit,
    phaseTimings,
  };
}

function createEmptyPhaseTimings(): RenderPhaseTimings {
  return {
    geometryPrepareMs: null,
    gpuProcessReadbackMs: null,
    histogramBuildMs: null,
    previewDisplayColorConversionMs: null,
    workerBitmapPrepMs: null,
    createImageBitmapMs: null,
    canvasDrawMs: null,
    endToEndDurationMs: null,
  };
}

export class FatalImageWorkerError extends Error {
  code: string;

  constructor(message = 'The image worker crashed and was restarted.') {
    super(message);
    this.name = 'FatalImageWorkerError';
    this.code = 'WORKER_FATAL';
  }
}

export class WorkerRequestTimeoutError extends FatalImageWorkerError {
  requestType: WorkerRequest['type'];

  timeoutMs: number;

  constructor(requestType: WorkerRequest['type'], timeoutMs: number) {
    super(`The image worker timed out after ${Math.round(timeoutMs / 1000)}s while processing "${requestType}" and was restarted.`);
    this.name = 'WorkerRequestTimeoutError';
    this.code = 'WORKER_TIMEOUT';
    this.requestType = requestType;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A single request the worker never answered in time, dropped without taking
 * the worker down. Not a `FatalImageWorkerError`: the worker is still alive and
 * every other in-flight job keeps running.
 */
export class WorkerRequestDroppedError extends Error {
  code: string;

  requestType: WorkerRequest['type'];

  timeoutMs: number;

  constructor(requestType: WorkerRequest['type'], timeoutMs: number) {
    super(`The image worker did not answer "${requestType}" within ${Math.round(timeoutMs / 1000)}s, so the request was dropped.`);
    this.name = 'WorkerRequestDroppedError';
    this.code = 'WORKER_REQUEST_DROPPED';
    this.requestType = requestType;
    this.timeoutMs = timeoutMs;
  }
}

export class ImageExportCancelledError extends Error {
  constructor() {
    super('The image export was cancelled.');
    this.name = 'ImageExportCancelledError';
  }
}

export function isImageExportCancelledError(error: unknown): error is ImageExportCancelledError {
  return error instanceof ImageExportCancelledError
    || (error instanceof Error && error.name === 'ImageExportCancelledError');
}

export class ImageWorkerClient {
  private worker: Worker | null = null;

  private pending = new Map<string, PendingResolver>();

  private decodeCache = new Map<string, CachedDecodeRequest>();

  // Calibration is tiny document state, not decode-recovery data. Keep it for
  // the document's full lifetime so evicting the potentially huge source
  // buffer after DECODE_CACHE_TTL_MS cannot silently change GPU conversion.
  private documentCalibration = new Map<string, DocumentCalibration>();

  private documentReloaders = new Map<string, DocumentReloaders>();

  private documentDecodeInfo = new Map<string, DocumentDecodeInfo>();

  private documentWorkerEpoch = new Map<string, number>();

  private documentLastAccessedAt = new Map<string, number>();

  private documentRecovery = new Map<string, Promise<void>>();

  private isTerminated = false;

  private workerEpoch = 0;

  private gpuPipeline: WebGPUPipeline | null = null;

  private gpuInitAttempted = false;

  private gpuEnabled = true;

  private gpuDisabledReason: RenderBackendDiagnostics['gpuDisabledReason'] = null;

  private lastGPUError: string | null = null;

  private workerMemory: WorkerMemoryDiagnostics | null = null;

  private activeBlobUrlCount: number | null = null;

  private oldestActiveBlobUrlAgeMs: number | null = null;

  private readonly onBackendDiagnosticsChange?: (diagnostics: RenderBackendDiagnostics) => void;

  private readonly onGPUDeviceLost?: (message: string) => void;

  private readonly onExportStateChange?: (isExporting: boolean) => void;

  // In-flight `export`/`contact-sheet` worker requests (the CPU path). Everything
  // queued behind one of these is starved by design, not hung.
  private blockingRequestDepth = 0;

  // In-flight exports of any kind (GPU-tiled included), used to tell the app it
  // should stop feeding preview work to the shared worker.
  private exportDepth = 0;

  private gpuDeviceLostNotified = false;

  private backendMode: RenderBackendDiagnostics['backendMode'] = 'cpu-worker';

  private sourceKind: TileSourceKind | null = null;

  private previewMode: PreviewMode | null = null;

  private previewLevelId: string | null = null;

  private interactionQuality: InteractionQuality | null = null;

  private histogramMode: HistogramMode | null = null;

  private tileSize: number | null = null;

  private halo: number | null = null;

  private tileCount: number | null = null;

  private intermediateFormat: RenderBackendDiagnostics['intermediateFormat'] = null;

  private usedCpuFallback = false;

  private fallbackReason: string | null = null;

  private jobDurationMs: number | null = null;

  private geometryCacheHit: boolean | null = null;

  private phaseTimings: RenderPhaseTimings | null = null;

  private coalescedPreviewRequests = 0;

  private cancelledPreviewJobs = 0;

  private previewBackend: RenderBackendMode | null = null;

  private lastPreviewJob: RenderJobDiagnosticsSnapshot | null = null;

  private lastExportJob: RenderJobDiagnosticsSnapshot | null = null;

  private activePreviewJobIds = new Map<string, string>();

  private activeExports = new Map<string, { cancelled: boolean; workerPending: boolean }>();

  private foregroundRenderDepth = 0;

  private thumbnailRenderQueue = new Map<string, QueuedThumbnailRender>();

  private thumbnailPreviewCache = new Map<string, CachedThumbnailPreview>();

  private disposedDocumentIds = new Set<string>();

  private thumbnailRenderInFlight = false;

  private thumbnailDrainTimer: number | null = null;

  private lastConversionAnalysis = new Map<string, ConversionAnalysisResult>();

  private lastConversionDebugJson = new Map<string, string>();

  private lastDraftHistogram: HistogramData | null = null;

  private lastDraftHistogramAt = 0;

  private lastDraftHistogramDocumentId: string | null = null;

  private pendingPreviewPresentation: {
    documentId: string;
    revision: number;
    startedAt: number;
    phaseTimings: RenderPhaseTimings;
  } | null = null;

  constructor(options: ImageWorkerClientOptions = {}) {
    this.gpuEnabled = options.gpuEnabled ?? true;
    this.gpuDisabledReason = this.gpuEnabled ? null : 'user';
    this.onBackendDiagnosticsChange = options.onBackendDiagnosticsChange;
    this.onGPUDeviceLost = options.onGPUDeviceLost;
    this.onExportStateChange = options.onExportStateChange;
    this.worker = this.createWorker();
  }

  private createWorker() {
    this.workerEpoch += 1;
    const worker = new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.epoch !== undefined && response.epoch !== this.workerEpoch) {
        return;
      }
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (entry.timeoutId !== null) {
        window.clearTimeout(entry.timeoutId);
      }

      if (response.ok === false) {
        entry.reject(new Error(`${response.error.code}: ${response.error.message}`));
        return;
      }

      entry.resolve(response.payload);
    };

    worker.onerror = (event) => {
      this.handleWorkerFailure(new FatalImageWorkerError(event.message || 'The image worker crashed unexpectedly.'));
      event.preventDefault();
    };

    worker.onmessageerror = () => {
      this.handleWorkerFailure(new FatalImageWorkerError('The image worker produced an unreadable message and was restarted.'));
    };

    return worker;
  }

  private rejectPending(error: Error) {
    this.pending.forEach((entry) => {
      if (entry.timeoutId !== null) {
        window.clearTimeout(entry.timeoutId);
      }
      entry.reject(error);
    });
    this.pending.clear();
  }

  private handleWorkerFailure(error: FatalImageWorkerError) {
    const failedWorker = this.worker;
    if (!failedWorker) return;

    this.worker = null;
    failedWorker.terminate();
    this.rejectPending(error);

    // The worker is restarted below, but the in-flight render/export this
    // failure aborted is gone — surface it to the user so they don't sit
    // looking at a frozen preview wondering why nothing updated.
    const diagnostic = appendDiagnostic({
      level: 'error',
      code: error.name === 'WorkerRequestTimeoutError'
        ? 'WORKER_REQUEST_TIMEOUT'
        : 'WORKER_FATAL',
      message: error.message,
      context: {},
    });
    pushToast({
      level: 'error',
      title: 'Image worker error',
      message: error.message,
      diagnosticId: diagnostic?.id,
    });

    if (!this.isTerminated) {
      this.worker = this.createWorker();
    }
  }

  private request<T>(
    type: WorkerRequest['type'],
    payload: WorkerRequest['payload'],
    transfer: Transferable[] = [],
  ) {
    if (!this.worker) {
      return Promise.reject<T>(new FatalImageWorkerError('The image worker is unavailable.'));
    }

    const id = `${type}-${crypto.randomUUID()}`;
    const timeoutMs = WORKER_REQUEST_TIMEOUT_MS[type];
    const isBlockingRequest = BLOCKING_REQUEST_TYPES.has(type);
    const promise = new Promise<T>((resolve, reject) => {
      let deadlineExtended = false;

      const handleTimeout = () => {
        const entry = this.pending.get(id);
        if (!entry) {
          return;
        }

        // A request sitting behind a full-resolution export is queued, not
        // hung: the worker cannot answer until the export finishes. Extending
        // the deadline keeps the export (and every other job on this worker)
        // alive; the blocking request's own fatal timeout still catches a
        // genuinely dead worker.
        if (!isBlockingRequest && this.blockingRequestDepth > 0) {
          if (!deadlineExtended) {
            deadlineExtended = true;
            appendDiagnostic({
              level: 'info',
              code: 'WORKER_REQUEST_DEADLINE_EXTENDED',
              message: type,
              context: {
                requestType: type,
                timeoutMs,
              },
            });
          }
          entry.timeoutId = window.setTimeout(handleTimeout, timeoutMs);
          return;
        }

        if (NON_FATAL_TIMEOUT_REQUEST_TYPES.has(type)) {
          this.pending.delete(id);
          appendDiagnostic({
            level: 'info',
            code: 'WORKER_REQUEST_DROPPED',
            message: type,
            context: {
              requestType: type,
              timeoutMs,
            },
          });
          entry.reject(new WorkerRequestDroppedError(type, timeoutMs));
          return;
        }

        // Diagnostic is appended by handleWorkerFailure; this path only
        // produces the worker-level failure record + toast. We pass the
        // request type via the error message so the centralized handler
        // surfaces it.
        this.handleWorkerFailure(new WorkerRequestTimeoutError(type, timeoutMs));
      };

      const timeoutId = window.setTimeout(handleTimeout, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });

      try {
        this.worker?.postMessage({
          id,
          epoch: this.workerEpoch,
          type,
          payload,
        } as WorkerMessage, transfer);
      } catch (error) {
        window.clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error);
      }
    });

    if (!isBlockingRequest) {
      return promise;
    }

    this.blockingRequestDepth += 1;
    return promise.finally(() => {
      this.blockingRequestDepth = Math.max(0, this.blockingRequestDepth - 1);
    });
  }

  private scheduleDecodeCacheEviction(documentId: string) {
    const cached = this.decodeCache.get(documentId);
    if (!cached) {
      return;
    }

    if (cached.evictionTimeout !== null) {
      window.clearTimeout(cached.evictionTimeout);
    }

    cached.evictionTimeout = window.setTimeout(() => {
      const current = this.decodeCache.get(documentId);
      if (current?.workerEpoch === cached.workerEpoch) {
        this.decodeCache.delete(documentId);
      }
    }, DECODE_CACHE_TTL_MS);
  }

  private cloneDecodeRequest(payload: DecodeRequest): DecodeRequest {
    return {
      ...payload,
      buffer: payload.buffer.slice(0),
      // The RAW high-depth buffer can be hundreds of MB. It is transferred to
      // the worker and intentionally not retained in the main-thread recovery
      // cache; after a worker restart the document can recover the preview path
      // and 16-bit export will gracefully fall back until the file is reopened.
      highDepthRawBuffer: undefined,
      rawDimensions: payload.rawDimensions ? { ...payload.rawDimensions } : undefined,
      sourceDimensions: payload.sourceDimensions ? { ...payload.sourceDimensions } : undefined,
      precomputedFilmBaseSample: payload.precomputedFilmBaseSample ? { ...payload.precomputedFilmBaseSample } : payload.precomputedFilmBaseSample,
      precomputedFilmBase: payload.precomputedFilmBase
        ? { ...payload.precomputedFilmBase, sample: { ...payload.precomputedFilmBase.sample } }
        : payload.precomputedFilmBase,
    };
  }

  private isMissingDocumentError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(MISSING_DOCUMENT_MESSAGE);
  }

  private async recoverDocument(documentId: string) {
    const cached = this.decodeCache.get(documentId);
    const reloader = this.documentReloaders.get(documentId);
    if (!cached && !reloader) {
      throw new Error(MISSING_DOCUMENT_MESSAGE);
    }

    const existingRecovery = this.documentRecovery.get(documentId);
    if (existingRecovery) {
      await existingRecovery;
      return;
    }

    const recovery = (reloader
      ? reloader.preview().then((payload) => this.decode(payload, { retainRecoveryCache: false })).then(() => undefined)
      : this.request<DecodedImage>('decode', this.cloneDecodeRequest(cached!.payload))
        .then(() => {
          this.documentWorkerEpoch.set(documentId, this.workerEpoch);
          this.decodeCache.set(documentId, {
            payload: cached!.payload,
            estimatedFilmBaseSample: cached!.estimatedFilmBaseSample,
            estimatedFilmBase: cached!.estimatedFilmBase,
            estimatedDensityBalance: cached!.estimatedDensityBalance,
            workerEpoch: this.workerEpoch,
            evictionTimeout: null,
          });
          this.scheduleDecodeCacheEviction(documentId);
        }))
      .finally(() => {
        this.documentRecovery.delete(documentId);
      });

    this.documentRecovery.set(documentId, recovery);
    await recovery;
  }

  private async ensureDocumentLoaded(documentId: string) {
    if (this.documentWorkerEpoch.get(documentId) === this.workerEpoch) {
      return;
    }
    const cached = this.decodeCache.get(documentId);
    if ((!cached && !this.documentReloaders.has(documentId)) || cached?.workerEpoch === this.workerEpoch) {
      return;
    }

    await this.recoverDocument(documentId);
  }

  private async requestWithDocumentRecovery<T>(
    documentId: string,
    operation: () => Promise<T>,
    allowRecovery: boolean,
  ) {
    try {
      return await operation();
    } catch (error) {
      if (!allowRecovery || !this.isMissingDocumentError(error)) {
        throw error;
      }

      await this.recoverDocument(documentId);
      return operation();
    }
  }

  private resetGPU(reason: RenderBackendDiagnostics['gpuDisabledReason'], error?: unknown, allowRetry = false) {
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;
    this.gpuDisabledReason = reason;
    this.gpuInitAttempted = allowRetry ? false : this.gpuInitAttempted;
    this.lastGPUError = error instanceof Error ? error.message : (typeof error === 'string' ? error : this.lastGPUError);
    this.emitBackendDiagnosticsChange();
  }

  private getCachedGPUDiagnostics(): RenderBackendDiagnostics {
    const blobDiagnostics = getBlobUrlDiagnostics();
    this.activeBlobUrlCount = blobDiagnostics.activeBlobUrlCount;
    this.oldestActiveBlobUrlAgeMs = blobDiagnostics.oldestActiveBlobUrlAgeMs;

    return {
      gpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
      gpuEnabled: this.gpuEnabled,
      gpuActive: this.gpuPipeline !== null,
      gpuAdapterName: this.gpuPipeline?.adapterName ?? null,
      backendMode: this.backendMode,
      sourceKind: this.sourceKind,
      previewMode: this.previewMode,
      previewLevelId: this.previewLevelId,
      interactionQuality: this.interactionQuality,
      histogramMode: this.histogramMode,
      tileSize: this.tileSize,
      halo: this.halo,
      tileCount: this.tileCount,
      intermediateFormat: this.intermediateFormat,
      usedCpuFallback: this.usedCpuFallback,
      fallbackReason: this.fallbackReason,
      jobDurationMs: this.jobDurationMs,
      geometryCacheHit: this.geometryCacheHit,
      phaseTimings: this.phaseTimings,
      coalescedPreviewRequests: this.coalescedPreviewRequests,
      cancelledPreviewJobs: this.cancelledPreviewJobs,
      previewBackend: this.previewBackend,
      lastPreviewJob: this.lastPreviewJob,
      lastExportJob: this.lastExportJob,
      maxStorageBufferBindingSize: this.gpuPipeline?.limits.maxStorageBufferBindingSize ?? null,
      maxBufferSize: this.gpuPipeline?.limits.maxBufferSize ?? null,
      gpuDisabledReason: this.gpuDisabledReason,
      lastError: this.lastGPUError,
      workerMemory: this.workerMemory,
      activeBlobUrlCount: this.activeBlobUrlCount,
      oldestActiveBlobUrlAgeMs: this.oldestActiveBlobUrlAgeMs,
    };
  }

  private emitBackendDiagnosticsChange() {
    this.onBackendDiagnosticsChange?.(this.getCachedGPUDiagnostics());
  }

  private updateBackendState(update: Partial<Pick<
    RenderBackendDiagnostics,
    'backendMode'
    | 'sourceKind'
    | 'previewMode'
    | 'previewLevelId'
    | 'interactionQuality'
    | 'histogramMode'
    | 'tileSize'
    | 'halo'
    | 'tileCount'
    | 'intermediateFormat'
    | 'usedCpuFallback'
    | 'fallbackReason'
    | 'jobDurationMs'
    | 'geometryCacheHit'
    | 'phaseTimings'
  >>) {
    if (update.backendMode !== undefined) this.backendMode = update.backendMode;
    if (update.sourceKind !== undefined) this.sourceKind = update.sourceKind;
    if (update.previewMode !== undefined) this.previewMode = update.previewMode;
    if (update.previewLevelId !== undefined) this.previewLevelId = update.previewLevelId;
    if (update.interactionQuality !== undefined) this.interactionQuality = update.interactionQuality;
    if (update.histogramMode !== undefined) this.histogramMode = update.histogramMode;
    if (update.tileSize !== undefined) this.tileSize = update.tileSize;
    if (update.halo !== undefined) this.halo = update.halo;
    if (update.tileCount !== undefined) this.tileCount = update.tileCount;
    if (update.intermediateFormat !== undefined) this.intermediateFormat = update.intermediateFormat;
    if (update.usedCpuFallback !== undefined) this.usedCpuFallback = update.usedCpuFallback;
    if (update.fallbackReason !== undefined) this.fallbackReason = update.fallbackReason;
    if (update.jobDurationMs !== undefined) this.jobDurationMs = update.jobDurationMs;
    if (update.geometryCacheHit !== undefined) this.geometryCacheHit = update.geometryCacheHit;
    if (update.phaseTimings !== undefined) this.phaseTimings = update.phaseTimings;
    this.emitBackendDiagnosticsChange();
  }

  private setPendingPreviewPresentation(
    documentId: string,
    revision: number,
    startedAt: number,
    phaseTimings: RenderPhaseTimings,
  ) {
    this.pendingPreviewPresentation = {
      documentId,
      revision,
      startedAt,
      phaseTimings: { ...phaseTimings },
    };
    this.updateBackendState({ phaseTimings: { ...phaseTimings } });
    if (this.lastPreviewJob) {
      this.lastPreviewJob = {
        ...this.lastPreviewJob,
        phaseTimings: { ...phaseTimings },
      };
      this.emitBackendDiagnosticsChange();
    }
  }

  recordPreviewPresentationTimings(
    documentId: string,
    revision: number,
    update: Partial<Pick<RenderPhaseTimings, 'workerBitmapPrepMs' | 'createImageBitmapMs' | 'canvasDrawMs'>>,
  ) {
    const pending = this.pendingPreviewPresentation;
    if (!pending || pending.documentId !== documentId || pending.revision !== revision) {
      return;
    }

    pending.phaseTimings = {
      ...pending.phaseTimings,
      ...update,
      endToEndDurationMs: Math.max(0, Math.round(performance.now() - pending.startedAt)),
    };
    this.updateBackendState({ phaseTimings: { ...pending.phaseTimings } });
    if (this.lastPreviewJob) {
      this.lastPreviewJob = {
        ...this.lastPreviewJob,
        phaseTimings: { ...pending.phaseTimings },
      };
      this.emitBackendDiagnosticsChange();
    }
  }

  private async ensureGPU() {
    if (!this.gpuEnabled) {
      this.gpuDisabledReason = 'user';
      return null;
    }

    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      this.gpuDisabledReason = 'unsupported';
      return null;
    }

    if (this.gpuPipeline?.isLost()) {
      const lostInfo = this.gpuPipeline.getLostInfo();
      this.resetGPU(
        'device-lost',
        lostInfo?.message ?? 'GPU device was lost. DarkSlide will retry on the next render.',
        true,
      );
    }

    if (this.gpuPipeline) {
      this.gpuDisabledReason = null;
      this.emitBackendDiagnosticsChange();
      return this.gpuPipeline;
    }

    if (this.gpuInitAttempted) {
      return null;
    }

    this.gpuInitAttempted = true;
    this.gpuPipeline = await WebGPUPipeline.create();
    if (!this.gpuPipeline) {
      this.gpuDisabledReason = 'initialization-failed';
      this.lastGPUError ??= 'Unable to initialize WebGPU.';
      this.emitBackendDiagnosticsChange();
      return null;
    }

    this.gpuDisabledReason = null;
    this.lastGPUError = null;
    this.gpuDeviceLostNotified = false;
    this.emitBackendDiagnosticsChange();
    return this.gpuPipeline;
  }

  private handleGPUFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // A destroyed pipeline yields `undefined`, not `null`, from the optional
    // call — without the coalesce every failure reported after the first reset
    // (one GPU fault can fail an export and a preview at once) looked like a
    // fresh device loss on an "unknown" adapter.
    const lostInfo = this.gpuPipeline?.getLostInfo() ?? null;
    const isDeviceLost = lostInfo !== null || /device was lost/i.test(message);
    const reason = isDeviceLost ? 'device-lost' : 'initialization-failed';
    const detail = lostInfo?.message ?? message;

    appendDiagnostic({
      level: 'error',
      code: isDeviceLost ? 'GPU_DEVICE_LOST' : 'GPU_FAILURE',
      message: isDeviceLost
        ? 'GPU device was lost. Falling back to CPU rendering.'
        : `GPU pipeline error: ${detail}`,
      context: {
        reason: lostInfo?.reason ?? reason,
        originalError: message,
        adapterName: this.gpuPipeline?.adapterName ?? 'unknown',
      },
    });

    if (isDeviceLost && !this.gpuDeviceLostNotified) {
      this.gpuDeviceLostNotified = true;
      this.onGPUDeviceLost?.(detail || 'GPU unavailable — retrying on the next render');
    }

    this.resetGPU(reason, detail, true);
  }

  private canAttemptGPU() {
    return this.gpuEnabled && typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  private async cancelTileJob(documentId: string, jobId: string | null, logCancellation = false) {
    if (!jobId) return;
    try {
      await this.request<{ cancelled: true }>('cancel-job', { documentId, jobId });
      if (logCancellation) {
        this.cancelledPreviewJobs += 1;
        appendDiagnostic({
          level: 'info',
          code: 'GPU_TILE_JOB_CANCELLED',
          message: jobId,
          context: {
            documentId,
            jobId,
          },
        });
      }
    } catch {
      // Ignore cancellation races.
    }
  }

  noteCoalescedPreviewRequest() {
    this.coalescedPreviewRequests += 1;
  }

  async cancelActivePreviewRender(documentId: string) {
    const jobId = this.activePreviewJobIds.get(documentId) ?? null;
    await this.cancelTileJob(documentId, jobId, true);
    if (jobId) {
      this.activePreviewJobIds.delete(documentId);
    }
  }

  private createJobId(documentId: string, revision: number | string, sourceKind: TileSourceKind) {
    return `${documentId}:${revision}:${sourceKind}`;
  }

  private async prepareTileJob(payload: PrepareTileJobRequest) {
    return this.request<PreparedTileJobResult>('prepare-tile-job', payload);
  }

  private async readTile(payload: ReadTileRequest) {
    return this.request<ReadTileResult>('read-tile', payload);
  }

  // Pinned conversion analysis (audit Phase C): the worker computes
  // residual-base and highlight-density once per (document, settings) at a
  // fixed resolution, so the GPU preview, GPU tiled export, and CPU worker
  // paths all consume identical numbers.
  private async fetchConversionAnalysis(payload: ConversionAnalysisRequest): Promise<ConversionAnalysisResult> {
    const result = await this.requestWithDocumentRecovery<ConversionAnalysisResult>(
      payload.documentId,
      () => this.request<ConversionAnalysisResult>('conversion-analysis', payload),
      true,
    );
    this.lastConversionAnalysis.set(payload.documentId, result);
    this.logConversionParametersIfChanged(payload.documentId, result.debug);
    return result;
  }

  private logConversionParametersIfChanged(documentId: string, debug: ConversionParametersDebug) {
    const serialized = JSON.stringify(debug);
    if (this.lastConversionDebugJson.get(documentId) === serialized) {
      return;
    }
    this.lastConversionDebugJson.set(documentId, serialized);
    appendDiagnostic({
      level: 'info',
      code: 'CONVERSION_PARAMETERS',
      message: documentId,
      context: {
        documentId,
        baseSampleSource: debug.baseSampleSource,
        baseDensity: debug.baseDensity.map((value) => value.toFixed(3)).join('/'),
        densityScale: debug.densityScale.map((value) => value.toFixed(3)).join('/'),
        densityScaleSource: debug.densityScaleSource,
        inputProfileId: getInputProfileLabel(debug.inputProfileId),
        outputProfileId: debug.outputProfileId,
        flareFloor: debug.flareFloor ? debug.flareFloor.map((value) => value.toFixed(1)).join('/') : null,
        residualBaseOffset: debug.residualBaseOffset
          ? debug.residualBaseOffset.map((value) => value.toFixed(4)).join('/')
          : null,
        highlightDensity: Number(debug.highlightDensity.toFixed(4)),
      },
    });
  }

  private buildConversionAnalysisRequest(payload: RenderRequest | ExportRequest): ConversionAnalysisRequest {
    return {
      documentId: payload.documentId,
      settings: payload.settings,
      isColor: payload.isColor,
      profileId: payload.profileId ?? null,
      filmType: payload.filmType,
      inputProfileId: payload.inputProfileId ?? 'srgb',
      outputProfileId: payload.outputProfileId ?? 'srgb',
      lightSourceBias: payload.lightSourceBias,
      flareFloor: payload.flareFloor,
      maskTuning: payload.maskTuning,
      colorMatrix: payload.colorMatrix,
      tonalCharacter: payload.tonalCharacter,
      cubeLut: payload.cubeLut,
      labStyleToneCurve: payload.labStyleToneCurve,
      labStyleChannelCurves: payload.labStyleChannelCurves,
      labTonalCharacterOverride: payload.labTonalCharacterOverride,
      labSaturationBias: payload.labSaturationBias,
      labTemperatureBias: payload.labTemperatureBias,
    };
  }

  private async assembleTileJob(
    prepared: PreparedTileJobResult,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    inputProfileId: InputProfileSpec,
    outputProfileId: ColorProfileId,
    profileId?: RenderRequest['profileId'],
    maskTuning?: RenderRequest['maskTuning'],
    colorMatrix?: RenderRequest['colorMatrix'],
    tonalCharacter?: RenderRequest['tonalCharacter'],
    labStyleToneCurve?: RenderRequest['labStyleToneCurve'],
    labStyleChannelCurves?: RenderRequest['labStyleChannelCurves'],
    labTonalCharacterOverride?: RenderRequest['labTonalCharacterOverride'],
    labSaturationBias?: RenderRequest['labSaturationBias'],
    labTemperatureBias?: RenderRequest['labTemperatureBias'],
    highlightDensityEstimate?: RenderRequest['highlightDensityEstimate'],
    filmType?: RenderRequest['filmType'],
    estimatedFilmBaseSample?: FilmBaseSample | FilmBaseEstimate | null,
    estimatedDensityBalance?: RenderRequest['estimatedDensityBalance'],
    residualBaseOffset?: [number, number, number] | null,
    flareFloor?: RenderRequest['flareFloor'],
    lightSourceBias?: RenderRequest['lightSourceBias'],
    cubeLut?: RenderRequest['cubeLut'],
  ) {
    const imageData = new ImageData(
      new Uint8ClampedArray(prepared.width * prepared.height * 4),
      prepared.width,
      prepared.height,
    );
    const histogram = buildEmptyHistogram();
    const tiles = buildTileRects(prepared.width, prepared.height, prepared.tileSize);
    const useGPU = comparisonMode === 'processed';

    for (const tile of tiles) {
      const rawTile = await this.readTile({
        documentId: prepared.documentId,
        jobId: prepared.jobId,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
      });

      const tileImage = useGPU && this.gpuPipeline
        ? await this.gpuPipeline.processTile(
          rawTile,
          settings,
          isColor,
          comparisonMode,
          maskTuning,
          colorMatrix,
          tonalCharacter,
          labStyleToneCurve,
          labStyleChannelCurves,
          labTonalCharacterOverride,
          labSaturationBias,
          labTemperatureBias,
          highlightDensityEstimate,
          inputProfileId,
          outputProfileId,
          profileId ?? null,
          filmType,
          estimatedFilmBaseSample,
          estimatedDensityBalance,
          residualBaseOffset ?? null,
          flareFloor,
          lightSourceBias,
          cubeLut ?? null,
        )
        : trimTileImageData(rawTile);

      blitTile(imageData.data, prepared.width, tile.x, tile.y, tileImage);
      accumulateHistogram(histogram, tileImage.data);
    }

    return {
      imageData,
      histogram,
      tileCount: tiles.length,
    };
  }

  private async assemblePreviewJob(
    prepared: PreparedTileJobResult,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    histogramMode: HistogramMode,
    inputProfileId: InputProfileSpec,
    outputProfileId: ColorProfileId,
    displayProfileId: ColorProfileId,
    profileId?: RenderRequest['profileId'],
    maskTuning?: RenderRequest['maskTuning'],
    colorMatrix?: RenderRequest['colorMatrix'],
    tonalCharacter?: RenderRequest['tonalCharacter'],
    labStyleToneCurve?: RenderRequest['labStyleToneCurve'],
    labStyleChannelCurves?: RenderRequest['labStyleChannelCurves'],
    labTonalCharacterOverride?: RenderRequest['labTonalCharacterOverride'],
    labSaturationBias?: RenderRequest['labSaturationBias'],
    labTemperatureBias?: RenderRequest['labTemperatureBias'],
    highlightDensityEstimate?: RenderRequest['highlightDensityEstimate'],
    filmType?: RenderRequest['filmType'],
    estimatedFilmBaseSample?: FilmBaseSample | FilmBaseEstimate | null,
    estimatedDensityBalance?: RenderRequest['estimatedDensityBalance'],
    residualBaseOffset?: [number, number, number] | null,
    flareFloor?: RenderRequest['flareFloor'],
    lightSourceBias?: RenderRequest['lightSourceBias'],
    cubeLut?: RenderRequest['cubeLut'],
  ) {
    const phaseTimings = createEmptyPhaseTimings();
    const rawPreview = await this.readTile({
      documentId: prepared.documentId,
      jobId: prepared.jobId,
      x: 0,
      y: 0,
      width: prepared.width,
      height: prepared.height,
    });

    let histogramSourceImageData: ImageData;
    let imageData: ImageData;
    // The pinned residual offset is fetched from the worker by the caller
    // (audit Phase C) — never recomputed here at preview resolution.
    const previewResidualBaseOffset = residualBaseOffset ?? null;

    if (comparisonMode === 'processed' && this.gpuPipeline) {
      const gpuStartedAt = performance.now();
      const processedImage = await this.gpuPipeline.processPreviewImage(
        rawPreview.imageData,
        settings,
        isColor,
        comparisonMode,
        maskTuning,
        colorMatrix,
        tonalCharacter,
        labStyleToneCurve,
        labStyleChannelCurves,
        labTonalCharacterOverride,
        labSaturationBias,
        labTemperatureBias,
        highlightDensityEstimate,
        inputProfileId,
        outputProfileId,
        profileId ?? null,
        filmType,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        previewResidualBaseOffset,
        flareFloor,
        lightSourceBias,
        cubeLut ?? null,
      );
      phaseTimings.gpuProcessReadbackMs = Math.round(performance.now() - gpuStartedAt);
      histogramSourceImageData = processedImage;
      imageData = processedImage;
      if (displayProfileId !== outputProfileId) {
        const displayConversionStartedAt = performance.now();
        imageData = await this.gpuPipeline.convertImageColorProfile(
          processedImage,
          settings,
          outputProfileId,
          displayProfileId,
        );
        phaseTimings.previewDisplayColorConversionMs = Math.round(performance.now() - displayConversionStartedAt);
      }
    } else {
      imageData = trimTileImageData(rawPreview);
      if (comparisonMode !== 'processed') {
        convertImageDataColorProfile(imageData, inputProfileId, outputProfileId);
      }
      histogramSourceImageData = imageData;
      if (displayProfileId !== outputProfileId) {
        const displayConversionStartedAt = performance.now();
        imageData = new ImageData(new Uint8ClampedArray(histogramSourceImageData.data), histogramSourceImageData.width, histogramSourceImageData.height);
        convertImageDataColorProfile(imageData, outputProfileId, displayProfileId);
        phaseTimings.previewDisplayColorConversionMs = Math.round(performance.now() - displayConversionStartedAt);
      }
    }

    let histogram: HistogramData;
    const histogramStartedAt = performance.now();
    if (
      histogramMode === 'throttled'
      && this.lastDraftHistogram
      && this.lastDraftHistogramDocumentId === prepared.documentId
      && performance.now() - this.lastDraftHistogramAt < 150
    ) {
      histogram = cloneHistogram(this.lastDraftHistogram);
    } else {
      histogram = buildEmptyHistogram();
      accumulateHistogram(histogram, histogramSourceImageData.data);
      if (histogramMode === 'throttled') {
        this.lastDraftHistogram = cloneHistogram(histogram);
        this.lastDraftHistogramAt = performance.now();
        this.lastDraftHistogramDocumentId = prepared.documentId;
      }
    }
    phaseTimings.histogramBuildMs = Math.round(performance.now() - histogramStartedAt);

    return {
      imageData,
      histogram,
      // Report the pinned estimate the frame was rendered with, so the
      // App-side adaptive state converges instead of chasing a stale value.
      highlightDensity: comparisonMode === 'processed'
        ? (highlightDensityEstimate ?? 0)
        : computeHighlightDensity(histogram),
      tileCount: 1,
      phaseTimings,
    };
  }

  private async createBlobFromImageData(
    imageData: ImageData,
    options: ExportRequest['options'],
  ) {
    return encodeExportRaster(imageData, options);
  }

  private markCpuWorkerBackend(sourceKind: TileSourceKind, fallbackReason: string | null = null, usedCpuFallback = false) {
    this.updateBackendState({
      backendMode: 'cpu-worker',
      sourceKind,
      previewMode: sourceKind === 'preview' ? this.previewMode : null,
      previewLevelId: null,
      interactionQuality: sourceKind === 'preview' ? this.interactionQuality : null,
      histogramMode: sourceKind === 'preview' ? this.histogramMode : null,
      tileSize: null,
      halo: null,
      tileCount: null,
      intermediateFormat: null,
      usedCpuFallback,
      fallbackReason,
      jobDurationMs: null,
      geometryCacheHit: null,
      phaseTimings: null,
    });
  }

  setGPUEnabled(enabled: boolean) {
    this.gpuEnabled = enabled;

    if (!enabled) {
      this.gpuInitAttempted = false;
      this.gpuDeviceLostNotified = false;
      this.resetGPU('user');
      this.markCpuWorkerBackend('preview');
      return;
    }

    this.gpuDisabledReason = null;
    this.lastGPUError = null;
    this.gpuInitAttempted = false;
    this.gpuDeviceLostNotified = false;
    this.emitBackendDiagnosticsChange();
  }

  async getGPUDiagnostics(): Promise<RenderBackendDiagnostics> {
    const gpu = this.canAttemptGPU() ? await this.ensureGPU() : null;
    if (gpu) {
      this.gpuDisabledReason = null;
    }

    try {
      this.workerMemory = await this.request<WorkerMemoryDiagnostics>('diagnostics', {});
    } catch {
      this.workerMemory = null;
    }

    const diagnostics = this.getCachedGPUDiagnostics();
    this.emitBackendDiagnosticsChange();
    return diagnostics;
  }

  registerDocumentReloaders(documentId: string, reloaders: DocumentReloaders) {
    this.documentReloaders.set(documentId, reloaders);
  }

  inheritPreviewAnalysis(sourceDocumentId: string, targetDocumentId: string) {
    const calibration = this.documentCalibration.get(sourceDocumentId);
    if (calibration) {
      this.documentCalibration.set(targetDocumentId, structuredClone(calibration));
    }
    const analysis = this.lastConversionAnalysis.get(sourceDocumentId);
    if (analysis) {
      this.lastConversionAnalysis.set(targetDocumentId, structuredClone(analysis));
    }
  }

  async decode(payload: DecodeRequest, options: DecodeOptions = {}) {
    this.disposedDocumentIds.delete(payload.documentId);
    const retainRecoveryCache = options.retainRecoveryCache ?? true;
    const cachedPayload = retainRecoveryCache ? this.cloneDecodeRequest(payload) : null;
    const transfer = payload.highDepthRawBuffer ? [payload.buffer, payload.highDepthRawBuffer] : [payload.buffer];
    const decoded = await this.request<DecodedImage>('decode', payload, transfer);
    this.documentLastAccessedAt.set(payload.documentId, Date.now());
    this.documentWorkerEpoch.set(payload.documentId, this.workerEpoch);
    this.documentDecodeInfo.set(payload.documentId, {
      mime: payload.mime,
      hasHighDepthRawSource: Boolean(payload.highDepthRawBuffer),
    });
    if (cachedPayload) {
      this.decodeCache.set(payload.documentId, {
        payload: cachedPayload,
        estimatedFilmBaseSample: decoded.estimatedFilmBaseSample ?? null,
        estimatedFilmBase: decoded.estimatedFilmBase ?? null,
        estimatedDensityBalance: decoded.estimatedDensityBalance ?? null,
        workerEpoch: this.workerEpoch,
        evictionTimeout: null,
      });
      this.scheduleDecodeCacheEviction(payload.documentId);
    } else {
      const cached = this.decodeCache.get(payload.documentId);
      if (cached?.evictionTimeout !== null && cached?.evictionTimeout !== undefined) {
        window.clearTimeout(cached.evictionTimeout);
      }
      this.decodeCache.delete(payload.documentId);
    }
    this.documentCalibration.set(payload.documentId, {
      estimatedFilmBaseSample: decoded.estimatedFilmBaseSample ?? null,
      estimatedFilmBase: decoded.estimatedFilmBase ?? null,
      estimatedDensityBalance: decoded.estimatedDensityBalance ?? null,
    });
    return decoded;
  }

  async render(payload: RenderRequest) {
    this.documentLastAccessedAt.set(payload.documentId, Date.now());
    this.foregroundRenderDepth += 1;
    try {
      await this.ensureDocumentLoaded(payload.documentId);
      return await this.renderInternal(payload, true);
    } finally {
      this.foregroundRenderDepth = Math.max(0, this.foregroundRenderDepth - 1);
      this.scheduleThumbnailDrain();
    }
  }

  renderThumbnail(payload: RenderRequest): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      const existing = this.thumbnailRenderQueue.get(payload.documentId);
      if (existing) {
        existing.payload = payload;
        existing.waiters.push({ resolve, reject });
      } else {
        this.thumbnailRenderQueue.set(payload.documentId, {
          payload,
          waiters: [{ resolve, reject }],
        });
      }
      this.scheduleThumbnailDrain();
    });
  }

  getCachedThumbnailPreview(documentId: string) {
    return this.thumbnailPreviewCache.get(documentId) ?? null;
  }

  private scheduleThumbnailDrain() {
    if (
      this.isTerminated
      || this.thumbnailDrainTimer !== null
      || this.thumbnailRenderInFlight
      || this.foregroundRenderDepth > 0
      || this.exportDepth > 0
      || this.thumbnailRenderQueue.size === 0
    ) {
      return;
    }

    this.thumbnailDrainTimer = window.setTimeout(() => {
      this.thumbnailDrainTimer = null;
      void this.drainThumbnailQueue();
    }, 24);
  }

  private async drainThumbnailQueue() {
    if (
      this.isTerminated
      || this.thumbnailRenderInFlight
      || this.foregroundRenderDepth > 0
      || this.exportDepth > 0
    ) {
      this.scheduleThumbnailDrain();
      return;
    }

    const next = this.thumbnailRenderQueue.entries().next();
    if (next.done) {
      return;
    }

    const [documentId, queued] = next.value;
    this.thumbnailRenderQueue.delete(documentId);
    this.thumbnailRenderInFlight = true;
    try {
      await this.ensureDocumentLoaded(queued.payload.documentId);
      const result = await this.renderInternal(queued.payload, true);
      if (!this.disposedDocumentIds.has(documentId)) {
        this.thumbnailPreviewCache.set(documentId, {
          imageData: result.imageData,
          settings: structuredClone(queued.payload.settings),
          comparisonMode: queued.payload.comparisonMode,
          labStyleToneCurve: queued.payload.labStyleToneCurve
            ? structuredClone(queued.payload.labStyleToneCurve)
            : undefined,
          labStyleChannelCurves: queued.payload.labStyleChannelCurves
            ? structuredClone(queued.payload.labStyleChannelCurves)
            : undefined,
        });
      }
      queued.waiters.forEach((waiter) => waiter.resolve(result));
    } catch (error) {
      queued.waiters.forEach((waiter) => waiter.reject(error));
    } finally {
      this.thumbnailRenderInFlight = false;
      this.scheduleThumbnailDrain();
    }
  }

  async preparePreviewBitmap(
    documentId: string,
    revision: number,
    imageData: ImageData,
  ) {
    const result = await this.request<PreparedPreviewBitmapResult>('prepare-preview-bitmap', {
      documentId,
      revision,
      imageData,
    });
    return result.imageBitmap;
  }

  private async renderPreviewWithCpuWorker(
    payload: RenderRequest,
    allowRecovery: boolean,
    usedCpuFallback: boolean,
    fallbackReason: string | null,
  ) {
    const startedAt = performance.now();
    const workerPayload = payload.previewMode === 'draft' && payload.interactionQuality !== null
      ? {
        ...payload,
        targetMaxDimension: Math.min(payload.targetMaxDimension, CPU_INTERACTIVE_PREVIEW_MAX_DIMENSION),
      }
      : payload;
    const result = await this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<RenderResult>('render', workerPayload),
      allowRecovery,
    );
    const phaseTimings = createEmptyPhaseTimings();
    const displayProfileId = getPreferredPreviewDisplayProfile();
    const displayConversionStartedAt = performance.now();
    convertImageDataColorProfile(result.imageData, payload.outputProfileId ?? 'srgb', displayProfileId);
    phaseTimings.previewDisplayColorConversionMs = Math.round(performance.now() - displayConversionStartedAt);

    const jobDurationMs = Math.round(performance.now() - startedAt);
    const snapshot = createJobSnapshot(
      'cpu-worker',
      'preview',
      payload.previewMode ?? 'settled',
      result.previewLevelId,
      payload.interactionQuality ?? null,
      payload.histogramMode ?? 'full',
      null,
      null,
      null,
      null,
      usedCpuFallback,
      fallbackReason,
      jobDurationMs,
      null,
      phaseTimings,
    );
    this.updateBackendState({
      backendMode: 'cpu-worker',
      sourceKind: 'preview',
      previewMode: payload.previewMode ?? 'settled',
      previewLevelId: result.previewLevelId,
      interactionQuality: payload.interactionQuality ?? null,
      histogramMode: payload.histogramMode ?? 'full',
      tileSize: null,
      halo: null,
      tileCount: null,
      intermediateFormat: null,
      usedCpuFallback,
      fallbackReason,
      jobDurationMs,
      geometryCacheHit: null,
      phaseTimings,
    });
    this.previewBackend = 'cpu-worker';
    this.lastPreviewJob = snapshot;
    this.setPendingPreviewPresentation(payload.documentId, payload.revision, startedAt, phaseTimings);
    return result;
  }

  private async renderInternal(payload: RenderRequest, allowRecovery: boolean): Promise<RenderResult> {
    const activePreviewJobId = this.activePreviewJobIds.get(payload.documentId) ?? null;
    const calibration = this.documentCalibration.get(payload.documentId);
    // Prefer the confidence-carrying estimate (source of truth from decode) so
    // the GPU uniforms resolve the same base density/provenance as the worker's
    // conversion analysis — the bare sample loses the confidence signal that
    // drives B&W luminance-first and conservative-fallback handling.
    const estimatedFilmBaseSample = calibration?.estimatedFilmBase
      ?? payload.estimatedFilmBaseSample
      ?? calibration?.estimatedFilmBaseSample
      ?? null;
    const estimatedDensityBalance = payload.estimatedDensityBalance ?? calibration?.estimatedDensityBalance ?? null;
    await this.cancelTileJob(payload.documentId, activePreviewJobId, true);

    const jobId = this.createJobId(payload.documentId, payload.revision, 'preview');
    this.activePreviewJobIds.set(payload.documentId, jobId);

    if (payload.comparisonMode === 'processed') {
      if (!this.canAttemptGPU()) {
        this.markCpuWorkerBackend('preview');
        this.previewBackend = 'cpu-worker';
        this.lastPreviewJob = createJobSnapshot(
          'cpu-worker',
          'preview',
          payload.previewMode ?? 'settled',
          null,
          payload.interactionQuality ?? null,
          payload.histogramMode ?? 'full',
          null,
          null,
          null,
          null,
          false,
          null,
          null,
          null,
          null,
        );
        this.emitBackendDiagnosticsChange();
        if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
          this.activePreviewJobIds.delete(payload.documentId);
        }
        return this.renderPreviewWithCpuWorker(payload, allowRecovery, false, null);
      }

      const gpu = await this.ensureGPU();
      if (!gpu) {
        this.markCpuWorkerBackend('preview', this.lastGPUError ?? 'WebGPU unavailable.', true);
        this.previewBackend = 'cpu-worker';
        this.lastPreviewJob = createJobSnapshot(
          'cpu-worker',
          'preview',
          payload.previewMode ?? 'settled',
          null,
          payload.interactionQuality ?? null,
          payload.histogramMode ?? 'full',
          null,
          null,
          null,
          null,
          true,
          this.lastGPUError ?? 'WebGPU unavailable.',
          null,
          null,
          null,
        );
        this.emitBackendDiagnosticsChange();
        if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
          this.activePreviewJobIds.delete(payload.documentId);
        }
        appendDiagnostic({
          level: 'info',
          code: 'GPU_FALLBACK_CPU',
          message: payload.documentId,
          context: {
            documentId: payload.documentId,
            jobId,
            reason: this.lastGPUError ?? 'WebGPU unavailable.',
            sourceKind: 'preview',
          },
        });
        return this.renderPreviewWithCpuWorker(payload, allowRecovery, true, this.lastGPUError ?? 'WebGPU unavailable.');
      }
    }

    const startedAt = performance.now();
    const phaseTimings = createEmptyPhaseTimings();
    const displayProfileId = getPreferredPreviewDisplayProfile();
    const shouldLogDraftFrameDiagnostics = !(payload.previewMode === 'draft' && payload.interactionQuality !== null);
    if (shouldLogDraftFrameDiagnostics) {
      appendDiagnostic({
        level: 'info',
        code: 'GPU_TILE_JOB_STARTED',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          jobId,
          previewMode: payload.previewMode ?? 'settled',
          sourceKind: 'preview',
        },
      });
    }

    try {
      // Draft (interactive) frames reuse the last pinned analysis to keep
      // slider drags responsive; settled frames always fetch fresh values.
      const isDraftPreview = payload.previewMode === 'draft';
      const canReuseAnalysis = isDraftPreview
        && this.lastConversionAnalysis.has(payload.documentId);
      const analysis = payload.comparisonMode === 'processed'
        ? (canReuseAnalysis
          ? this.lastConversionAnalysis.get(payload.documentId)!
          : (isDraftPreview
            ? null
            : await this.fetchConversionAnalysis(this.buildConversionAnalysisRequest(payload))))
        : null;
      const residualBaseOffset = analysis?.residualBaseOffset ?? null;
      const prepareStartedAt = performance.now();
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'preview',
        settings: payload.settings,
        comparisonMode: payload.comparisonMode,
        targetMaxDimension: payload.targetMaxDimension,
      });
      phaseTimings.geometryPrepareMs = Math.round(performance.now() - prepareStartedAt);

      const assembled = await this.assemblePreviewJob(
        prepared,
        payload.settings,
        payload.isColor,
        payload.comparisonMode,
        payload.histogramMode ?? 'full',
        payload.inputProfileId ?? 'srgb',
        payload.outputProfileId ?? 'srgb',
        displayProfileId,
        payload.profileId ?? null,
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
        payload.labStyleToneCurve,
        payload.labStyleChannelCurves,
        payload.labTonalCharacterOverride,
        payload.labSaturationBias,
        payload.labTemperatureBias,
        analysis?.highlightDensity ?? 0,
        payload.filmType,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        residualBaseOffset,
        payload.flareFloor,
        payload.lightSourceBias,
        payload.cubeLut ?? null,
      );
      phaseTimings.gpuProcessReadbackMs = assembled.phaseTimings.gpuProcessReadbackMs;
      phaseTimings.histogramBuildMs = assembled.phaseTimings.histogramBuildMs;
      phaseTimings.previewDisplayColorConversionMs = assembled.phaseTimings.previewDisplayColorConversionMs;
      await this.cancelTileJob(payload.documentId, jobId);
      if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
        this.activePreviewJobIds.delete(payload.documentId);
      }

      const jobDurationMs = Math.round(performance.now() - startedAt);
      const backendMode: RenderBackendMode = payload.comparisonMode === 'processed' ? 'gpu-preview' : 'cpu-worker';
      const snapshot = createJobSnapshot(
        backendMode,
        'preview',
        payload.previewMode ?? 'settled',
        prepared.previewLevelId,
        payload.interactionQuality ?? null,
        payload.histogramMode ?? 'full',
        prepared.tileSize,
        prepared.halo,
        assembled.tileCount,
        payload.comparisonMode === 'processed' ? 'rgba16float' : null,
        false,
        null,
        jobDurationMs,
        prepared.geometryCacheHit,
        phaseTimings,
      );
      this.updateBackendState({
        backendMode,
        sourceKind: 'preview',
        previewMode: payload.previewMode ?? 'settled',
        previewLevelId: prepared.previewLevelId,
        interactionQuality: payload.interactionQuality ?? null,
        histogramMode: payload.histogramMode ?? 'full',
        tileSize: prepared.tileSize,
        halo: prepared.halo,
        tileCount: assembled.tileCount,
        intermediateFormat: payload.comparisonMode === 'processed' ? 'rgba16float' : null,
        usedCpuFallback: false,
        fallbackReason: null,
        jobDurationMs,
        geometryCacheHit: prepared.geometryCacheHit,
        phaseTimings,
      });
      this.previewBackend = backendMode;
      this.lastPreviewJob = snapshot;
      this.setPendingPreviewPresentation(payload.documentId, payload.revision, startedAt, phaseTimings);

      if (shouldLogDraftFrameDiagnostics) {
        appendDiagnostic({
          level: 'info',
          code: 'GPU_TILE_JOB_COMPLETED',
          message: payload.documentId,
          context: {
            documentId: payload.documentId,
            geometryCacheHit: prepared.geometryCacheHit,
            halo: prepared.halo,
            jobDurationMs,
            jobId,
            previewMode: payload.previewMode ?? 'settled',
            sourceKind: 'preview',
            tileCount: assembled.tileCount,
            tileSize: prepared.tileSize,
          },
        });
      }

      return {
        documentId: payload.documentId,
        revision: payload.revision,
        width: prepared.width,
        height: prepared.height,
        previewLevelId: prepared.previewLevelId ?? 'preview-source',
        imageData: assembled.imageData,
        histogram: assembled.histogram,
        highlightDensity: assembled.highlightDensity,
        // Surfaced from the pinned conversion analysis so the low-confidence
        // notice fires for GPU-rendered previews too (the common path).
        baseSampleSource: analysis?.debug.baseSampleSource,
        lowConfidence: analysis?.debug.lowConfidence,
      } satisfies RenderResult;
    } catch (error) {
      await this.cancelTileJob(payload.documentId, jobId);
      if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
        this.activePreviewJobIds.delete(payload.documentId);
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('JOB_CANCELLED')) {
        throw error;
      }

      if (allowRecovery && this.isMissingDocumentError(error)) {
        await this.recoverDocument(payload.documentId);
        return this.renderInternal(payload, false);
      }

      this.handleGPUFailure(error);
      this.markCpuWorkerBackend('preview', message, true);
      this.previewBackend = 'cpu-worker';
      this.lastPreviewJob = createJobSnapshot(
        'cpu-worker',
        'preview',
        payload.previewMode ?? 'settled',
        null,
        payload.interactionQuality ?? null,
        payload.histogramMode ?? 'full',
        null,
        null,
        null,
        null,
        true,
        message,
        null,
        null,
        null,
      );
      this.emitBackendDiagnosticsChange();
      appendDiagnostic({
        level: 'info',
        code: 'GPU_FALLBACK_CPU',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          jobId,
          previewMode: payload.previewMode ?? 'settled',
          reason: message,
          sourceKind: 'preview',
        },
      });
      if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
        this.activePreviewJobIds.delete(payload.documentId);
      }
      return this.renderPreviewWithCpuWorker(payload, false, true, message);
    }
  }

  async sampleFilmBase(payload: SampleRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    return this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<FilmBaseSample>('sample-film-base', payload),
      true,
    );
  }

  async reestimateFilmBase(payload: ReestimateFilmBaseRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    const result = await this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<ReestimateFilmBaseResult>('reestimate-film-base', payload),
      true,
    );
    return result;
  }

  async applyFilmBaseEstimate(payload: ApplyFilmBaseEstimateRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    const result = await this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<ReestimateFilmBaseResult>('apply-film-base-estimate', payload),
      true,
    );
    this.documentCalibration.set(payload.documentId, {
      estimatedFilmBaseSample: result.estimatedFilmBaseSample,
      estimatedFilmBase: result.estimatedFilmBase,
      estimatedDensityBalance: result.estimatedDensityBalance,
    });
    this.lastConversionAnalysis.delete(payload.documentId);
    return result;
  }

  async autoAnalyze(payload: AutoAnalyzeRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    return this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<AutoAnalyzeResult>('auto-analyze', payload),
      true,
    );
  }

  async detectFrame(documentId: string, settings: ConversionSettings) {
    await this.ensureDocumentLoaded(documentId);
    return this.requestWithDocumentRecovery<DetectedFrame | null>(
      documentId,
      () => this.request<DetectedFrame | null>('detect-frame', { documentId, settings }),
      true,
    );
  }

  async estimateLensDistortion(documentId: string) {
    await this.ensureDocumentLoaded(documentId);
    return this.requestWithDocumentRecovery<LensDistortionEstimate | null>(
      documentId,
      () => this.request<LensDistortionEstimate | null>('estimate-lens-distortion', { documentId }),
      true,
    );
  }

  async computeFlare(documentId: string) {
    await this.ensureDocumentLoaded(documentId);
    return this.requestWithDocumentRecovery<[number, number, number]>(
      documentId,
      () => this.request<[number, number, number]>('compute-flare', { documentId }),
      true,
    );
  }

  async detectDust(payload: {
    documentId: string;
    settings: ConversionSettings;
    isColor: boolean;
    profileId?: string | null;
    filmType?: FilmProfileType;
    cubeLut?: CubeLut | null;
    flareFloor?: [number, number, number] | null;
    lightSourceBias?: [number, number, number];
    sensitivity: number;
    maxRadius: number;
    mode: 'spots' | 'scratches' | 'both';
  }): Promise<DustMark[]> {
    await this.ensureDocumentLoaded(payload.documentId);
    const result = await this.requestWithDocumentRecovery<{ type: 'dust-detect'; detectedMarks: DustMark[] }>(
      payload.documentId,
      () => this.request<{ type: 'dust-detect'; detectedMarks: DustMark[] }>(
        'dust-detect',
        payload,
      ),
      true,
    );
    return result.detectedMarks;
  }

  // Exports own the worker (and the GPU) for as long as they run. The app uses
  // this to hold back preview renders instead of racing them against the export
  // on a single worker thread.
  private noteExportStateChange(delta: number) {
    const wasExporting = this.exportDepth > 0;
    this.exportDepth = Math.max(0, this.exportDepth + delta);
    const isExporting = this.exportDepth > 0;
    if (isExporting !== wasExporting) {
      this.onExportStateChange?.(isExporting);
      if (!isExporting) this.scheduleThumbnailDrain();
    }
  }

  async export(payload: ExportRequest) {
    const cancellation = { cancelled: false, workerPending: true };
    this.activeExports.set(payload.documentId, cancellation);
    this.noteExportStateChange(1);
    const reloaders = this.documentReloaders.get(payload.documentId);
    try {
      if (reloaders) {
        const fullRequest = await reloaders.full();
        await this.decode(fullRequest, { retainRecoveryCache: false });
      } else {
        await this.ensureDocumentLoaded(payload.documentId);
      }
      if (cancellation.cancelled) throw new ImageExportCancelledError();
      const result = await this.exportInternal(payload, true);
      if (cancellation.cancelled) throw new ImageExportCancelledError();
      cancellation.workerPending = false;
      const finalized = await finalizeExportBlob(result, payload.options, payload.sourceExif);
      if (cancellation.cancelled) throw new ImageExportCancelledError();
      return finalized;
    } catch (error) {
      if (cancellation.cancelled && !isImageExportCancelledError(error)) {
        throw new ImageExportCancelledError();
      }
      throw error;
    } finally {
      if (reloaders && this.documentReloaders.get(payload.documentId) === reloaders) {
        try {
          const previewRequest = await reloaders.preview();
          await this.decode(previewRequest, { retainRecoveryCache: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = appendDiagnostic({
            level: 'error',
            code: 'RAW_PREVIEW_RESTORE_FAILED',
            message,
            context: { documentId: payload.documentId },
          });
          pushToast({
            level: 'error',
            title: 'Could not restore the RAW preview',
            message: 'Reopen the image to continue editing it.',
            diagnosticId: diagnostic?.id,
          });
        }
      }
      if (this.activeExports.get(payload.documentId) === cancellation) {
        this.activeExports.delete(payload.documentId);
      }
      this.noteExportStateChange(-1);
    }
  }

  cancelActiveExport(documentId?: string) {
    const cancellations = documentId
      ? [this.activeExports.get(documentId)].filter((value): value is { cancelled: boolean; workerPending: boolean } => Boolean(value))
      : Array.from(this.activeExports.values());
    const activeCancellations = cancellations.filter((cancellation) => !cancellation.cancelled);
    if (activeCancellations.length === 0) return false;

    activeCancellations.forEach((cancellation) => {
      cancellation.cancelled = true;
    });
    const activeWorker = activeCancellations.some((cancellation) => cancellation.workerPending)
      ? this.worker
      : null;
    if (activeWorker) {
      this.worker = null;
      activeWorker.terminate();
      this.rejectPending(new ImageExportCancelledError());
      if (!this.isTerminated) {
        this.worker = this.createWorker();
      }
    }
    return true;
  }

  async contactSheet(payload: ContactSheetRequest) {
    this.noteExportStateChange(1);
    try {
      const result = await this.request<ContactSheetResult>('contact-sheet', payload);
      return finalizeExportBlob(result, payload.exportOptions);
    } finally {
      this.noteExportStateChange(-1);
    }
  }

  private async exportInternal(payload: ExportRequest, allowRecovery: boolean): Promise<ExportResult> {
    const decodeInfo = this.documentDecodeInfo.get(payload.documentId);
    const calibration = this.documentCalibration.get(payload.documentId);
    // Prefer the confidence-carrying estimate so GPU-tiled export resolves the
    // same base as the worker analysis (matches the preview render path).
    const estimatedFilmBaseSample = calibration?.estimatedFilmBase ?? calibration?.estimatedFilmBaseSample ?? null;
    const estimatedDensityBalance = payload.estimatedDensityBalance ?? calibration?.estimatedDensityBalance ?? null;
    const wantsHighDepthRawExport = decodeInfo?.mime === 'image/x-raw-rgba'
      && decodeInfo.hasHighDepthRawSource
      && payload.options.bitDepth === 16
      && (payload.options.format === 'image/tiff' || payload.options.format === 'image/png');
    if (wantsHighDepthRawExport) {
      this.markCpuWorkerBackend('source');
      return this.requestWithDocumentRecovery(
        payload.documentId,
        () => this.request<ExportResult>('export', payload),
        allowRecovery,
      );
    }

    if (!this.canAttemptGPU()) {
      this.markCpuWorkerBackend('source');
      return this.requestWithDocumentRecovery(
        payload.documentId,
        () => this.request<ExportResult>('export', payload),
        allowRecovery,
      );
    }

    const gpu = await this.ensureGPU();
    if (!gpu) {
      this.markCpuWorkerBackend('source', this.lastGPUError ?? 'WebGPU unavailable.', true);
      appendDiagnostic({
        level: 'info',
        code: 'GPU_FALLBACK_CPU',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          reason: this.lastGPUError ?? 'WebGPU unavailable.',
          sourceKind: 'source',
        },
      });
      return this.requestWithDocumentRecovery(
        payload.documentId,
        () => this.request<ExportResult>('export', payload),
        allowRecovery,
      );
    }

    const jobId = this.createJobId(payload.documentId, `export-${crypto.randomUUID()}`, 'source');
    const startedAt = performance.now();
    appendDiagnostic({
      level: 'info',
      code: 'GPU_TILE_JOB_STARTED',
      message: payload.documentId,
      context: {
        documentId: payload.documentId,
        jobId,
        sourceKind: 'source',
      },
    });

    try {
      const analysis = await this.fetchConversionAnalysis(this.buildConversionAnalysisRequest(payload));
      const residualBaseOffset = analysis.residualBaseOffset;
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'source',
        settings: payload.settings,
        comparisonMode: 'processed',
      });
      const assembled = await this.assembleTileJob(
        prepared,
        payload.settings,
        payload.isColor,
        'processed',
        payload.inputProfileId ?? 'srgb',
        payload.outputProfileId ?? 'srgb',
        payload.profileId ?? null,
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
        payload.labStyleToneCurve,
        payload.labStyleChannelCurves,
        payload.labTonalCharacterOverride,
        payload.labSaturationBias,
        payload.labTemperatureBias,
        analysis.highlightDensity,
        payload.filmType,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        residualBaseOffset,
        payload.flareFloor,
        payload.lightSourceBias,
        payload.cubeLut ?? null,
      );
      await this.cancelTileJob(payload.documentId, jobId);

      const encoded = await this.createBlobFromImageData(
        assembled.imageData,
        payload.options,
      );
      const jobDurationMs = Math.round(performance.now() - startedAt);
      const snapshot = createJobSnapshot(
        'gpu-tiled-render',
        'source',
        null,
        prepared.previewLevelId,
        null,
        null,
        prepared.tileSize,
        prepared.halo,
        assembled.tileCount,
        'rgba16float',
        false,
        null,
        jobDurationMs,
        prepared.geometryCacheHit,
        null,
      );
      this.updateBackendState({
        backendMode: 'gpu-tiled-render',
        sourceKind: 'source',
        previewMode: null,
        previewLevelId: prepared.previewLevelId,
        interactionQuality: null,
        histogramMode: null,
        tileSize: prepared.tileSize,
        halo: prepared.halo,
        tileCount: assembled.tileCount,
        intermediateFormat: 'rgba16float',
        usedCpuFallback: false,
        fallbackReason: null,
        jobDurationMs,
        geometryCacheHit: prepared.geometryCacheHit,
        phaseTimings: null,
      });
      this.lastExportJob = snapshot;
      this.emitBackendDiagnosticsChange();

      appendDiagnostic({
        level: 'info',
        code: 'GPU_EXPORT_TILED_COMPLETED',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          geometryCacheHit: prepared.geometryCacheHit,
          halo: prepared.halo,
          jobDurationMs,
          jobId,
          sourceKind: 'source',
          tileCount: assembled.tileCount,
          tileSize: prepared.tileSize,
        },
      });

      return {
        blob: encoded.blob,
        filename: `${sanitizeFilenameBase(payload.options.filenameBase)}.${getExtensionFromFormat(payload.options.format)}`,
        bitDepthDowngraded: encoded.bitDepthDowngraded,
      } satisfies ExportResult;
    } catch (error) {
      await this.cancelTileJob(payload.documentId, jobId);
      const message = error instanceof Error ? error.message : String(error);
      if (allowRecovery && this.isMissingDocumentError(error)) {
        await this.recoverDocument(payload.documentId);
        return this.exportInternal(payload, false);
      }
      this.handleGPUFailure(error);
      this.markCpuWorkerBackend('source', message, true);
      this.lastExportJob = createJobSnapshot(
        'cpu-worker',
        'source',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        true,
        message,
        null,
        null,
        null,
      );
      this.emitBackendDiagnosticsChange();
      appendDiagnostic({
        level: 'info',
        code: 'GPU_FALLBACK_CPU',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          jobId,
          reason: message,
          sourceKind: 'source',
        },
      });
      return this.requestWithDocumentRecovery(
        payload.documentId,
        () => this.request<ExportResult>('export', payload),
        false,
      );
    }
  }

  disposeDocument(documentId: string) {
    this.disposedDocumentIds.add(documentId);
    const queuedThumbnail = this.thumbnailRenderQueue.get(documentId);
    if (queuedThumbnail) {
      const disposedError = new Error(MISSING_DOCUMENT_MESSAGE);
      queuedThumbnail.waiters.forEach((waiter) => waiter.reject(disposedError));
      this.thumbnailRenderQueue.delete(documentId);
    }
    const cached = this.decodeCache.get(documentId);
    if (cached?.evictionTimeout != null) {
      window.clearTimeout(cached.evictionTimeout);
    }
    this.decodeCache.delete(documentId);
    this.thumbnailPreviewCache.delete(documentId);
    this.documentCalibration.delete(documentId);
    this.lastConversionAnalysis.delete(documentId);
    this.lastConversionDebugJson.delete(documentId);
    this.documentReloaders.delete(documentId);
    this.documentDecodeInfo.delete(documentId);
    this.documentWorkerEpoch.delete(documentId);
    this.documentLastAccessedAt.delete(documentId);
    this.documentRecovery.delete(documentId);
    this.activePreviewJobIds.delete(documentId);
    return this.request<{ disposed: true }>('dispose', { documentId });
  }

  evictPreviews(documentId: string) {
    return this.request<{ evicted: true }>('evict-previews', { documentId });
  }

  async trimResidentDocuments(maxResidentDocuments: number | null, preserveDocumentId?: string | null) {
    if (maxResidentDocuments !== null) {
      const keepLimit = Math.max(1, maxResidentDocuments);
      const reloadableDocuments = Array.from(this.documentReloaders.keys())
        .sort((left, right) => (
          (this.documentLastAccessedAt.get(right) ?? 0)
          - (this.documentLastAccessedAt.get(left) ?? 0)
        ));
      const keepIds = new Set<string>();
      if (preserveDocumentId && this.documentReloaders.has(preserveDocumentId)) {
        keepIds.add(preserveDocumentId);
      }
      for (const documentId of reloadableDocuments) {
        if (keepIds.size >= keepLimit) break;
        keepIds.add(documentId);
      }

      const unloadIds = reloadableDocuments.filter((documentId) => (
        !keepIds.has(documentId)
        && this.documentWorkerEpoch.get(documentId) === this.workerEpoch
      ));
      await Promise.all(unloadIds.map(async (documentId) => {
        await this.request<{ disposed: true }>('dispose', { documentId });
        this.documentWorkerEpoch.delete(documentId);
        this.documentDecodeInfo.delete(documentId);
      }));
    }

    return this.request<{ evicted: true }>('evict-previews', {
      maxResidentDocuments,
      preserveDocumentId: preserveDocumentId ?? null,
    });
  }

  terminate() {
    this.isTerminated = true;
    if (this.thumbnailDrainTimer !== null) {
      window.clearTimeout(this.thumbnailDrainTimer);
      this.thumbnailDrainTimer = null;
    }
    const terminationError = new Error('Image worker terminated.');
    this.thumbnailRenderQueue.forEach((queued) => {
      queued.waiters.forEach((waiter) => waiter.reject(terminationError));
    });
    this.thumbnailRenderQueue.clear();
    this.thumbnailPreviewCache.clear();
    this.disposedDocumentIds.clear();
    this.rejectPending(new Error('Image worker terminated.'));
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
