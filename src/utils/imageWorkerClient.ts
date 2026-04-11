import {
  AutoAnalyzeRequest,
  AutoAnalyzeResult,
  ColorProfileId,
  ContactSheetRequest,
  ContactSheetResult,
  ConversionSettings,
  DecodeRequest,
  DensityBalance,
  DecodedImage,
  DetectedFrame,
  DustMark,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  HistogramData,
  HistogramMode,
  InteractionQuality,
  PreparedPreviewBitmapResult,
  PrepareTileJobRequest,
  PreparedTileJobResult,
  PreviewMode,
  ReadTileRequest,
  ReadTileResult,
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
import UTIF from 'utif';
import { appendDiagnostic } from './diagnostics';
import { accumulateHistogram, buildEmptyHistogram, computeHighlightDensity, getExtensionFromFormat, sanitizeFilenameBase } from './imagePipeline';
import { getBlobUrlDiagnostics } from './blobUrlTracker';
import { convertImageDataColorProfile, getPreferredPreviewDisplayProfile } from './colorProfiles';
import { WebGPUPipeline } from './gpu/WebGPUPipeline';
import { finalizeExportBlob } from './imageMetadata';
import { WorkerMessage, WorkerRequest, WorkerResponse } from './workerProtocol';

type ImageWorkerClientOptions = {
  gpuEnabled?: boolean;
  onBackendDiagnosticsChange?: (diagnostics: RenderBackendDiagnostics) => void;
  onGPUDeviceLost?: (message: string) => void;
};

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number | null;
};

type CachedDecodeRequest = {
  payload: DecodeRequest;
  estimatedFilmBaseSample: FilmBaseSample | null;
  estimatedDensityBalance: DensityBalance | null;
  workerEpoch: number;
  evictionTimeout: number | null;
};

type ActiveFlatFieldState = {
  name: string;
  size: number;
  data: Float32Array;
} | null;

const MISSING_DOCUMENT_MESSAGE = 'The image document is no longer available.';
const DECODE_CACHE_TTL_MS = 60_000;
const WORKER_REQUEST_TIMEOUT_MS: Record<WorkerRequest['type'], number> = {
  decode: 15_000,
  render: 10_000,
  'auto-analyze': 10_000,
  'prepare-tile-job': 10_000,
  'prepare-preview-bitmap': 10_000,
  'read-tile': 10_000,
  'cancel-job': 5_000,
  'sample-film-base': 10_000,
  'detect-frame': 10_000,
  'compute-flare': 10_000,
  'load-flat-field': 10_000,
  'clear-flat-field': 5_000,
  'dust-detect': 10_000,
  export: 30_000,
  'contact-sheet': 30_000,
  diagnostics: 5_000,
  dispose: 5_000,
  'evict-previews': 5_000,
};

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

export class ImageWorkerClient {
  private worker: Worker | null = null;

  private pending = new Map<string, PendingResolver>();

  private decodeCache = new Map<string, CachedDecodeRequest>();

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

  private gpuDeviceLostNotified = false;

  private activeFlatField: ActiveFlatFieldState = null;

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

    if (this.activeFlatField) {
      const payload = {
        name: this.activeFlatField.name,
        size: this.activeFlatField.size,
        data: new Float32Array(this.activeFlatField.data.buffer.slice(0)),
      };
      const id = `load-flat-field-${crypto.randomUUID()}`;
      worker.postMessage({
        id,
        epoch: this.workerEpoch,
        type: 'load-flat-field',
        payload,
      } as WorkerMessage, [payload.data.buffer]);
    }

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
    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }

        appendDiagnostic({
          level: 'error',
          code: 'WORKER_REQUEST_TIMEOUT',
          message: type,
          context: {
            requestId: id,
            requestType: type,
            timeoutMs,
          },
        });

        this.handleWorkerFailure(new WorkerRequestTimeoutError(type, timeoutMs));
      }, timeoutMs);

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
      rawDimensions: payload.rawDimensions ? { ...payload.rawDimensions } : undefined,
      precomputedFilmBaseSample: payload.precomputedFilmBaseSample ? { ...payload.precomputedFilmBaseSample } : payload.precomputedFilmBaseSample,
    };
  }

  private isMissingDocumentError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(MISSING_DOCUMENT_MESSAGE);
  }

  private async recoverDocument(documentId: string) {
    const cached = this.decodeCache.get(documentId);
    if (!cached) {
      throw new Error(MISSING_DOCUMENT_MESSAGE);
    }

    const existingRecovery = this.documentRecovery.get(documentId);
    if (existingRecovery) {
      await existingRecovery;
      return;
    }

    const recovery = this.request<DecodedImage>('decode', this.cloneDecodeRequest(cached.payload))
      .then(() => {
        this.decodeCache.set(documentId, {
          payload: cached.payload,
          estimatedFilmBaseSample: cached.estimatedFilmBaseSample,
          estimatedDensityBalance: cached.estimatedDensityBalance,
          workerEpoch: this.workerEpoch,
          evictionTimeout: null,
        });
        this.scheduleDecodeCacheEviction(documentId);
      })
      .finally(() => {
        this.documentRecovery.delete(documentId);
      });

    this.documentRecovery.set(documentId, recovery);
    await recovery;
  }

  private async ensureDocumentLoaded(documentId: string) {
    const cached = this.decodeCache.get(documentId);
    if (!cached || cached.workerEpoch === this.workerEpoch) {
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
    if (this.activeFlatField) {
      this.gpuPipeline.loadFlatFieldTexture?.(this.activeFlatField.data, this.activeFlatField.size);
    } else {
      this.gpuPipeline.clearFlatFieldTexture?.();
    }
    this.emitBackendDiagnosticsChange();
    return this.gpuPipeline;
  }

  private handleGPUFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const lostInfo = this.gpuPipeline?.getLostInfo();
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

  private async assembleTileJob(
    prepared: PreparedTileJobResult,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    inputProfileId: ColorProfileId,
    outputProfileId: ColorProfileId,
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
    advancedInversion?: RenderRequest['advancedInversion'],
    estimatedFilmBaseSample?: RenderRequest['estimatedFilmBaseSample'],
    estimatedDensityBalance?: RenderRequest['estimatedDensityBalance'],
    flareFloor?: RenderRequest['flareFloor'],
    lightSourceBias?: RenderRequest['lightSourceBias'],
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
          filmType,
          advancedInversion,
          estimatedFilmBaseSample,
          estimatedDensityBalance,
          flareFloor,
          lightSourceBias,
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
    inputProfileId: ColorProfileId,
    outputProfileId: ColorProfileId,
    displayProfileId: ColorProfileId,
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
    advancedInversion?: RenderRequest['advancedInversion'],
    estimatedFilmBaseSample?: RenderRequest['estimatedFilmBaseSample'],
    estimatedDensityBalance?: RenderRequest['estimatedDensityBalance'],
    flareFloor?: RenderRequest['flareFloor'],
    lightSourceBias?: RenderRequest['lightSourceBias'],
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
        filmType,
        advancedInversion,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        flareFloor,
        lightSourceBias,
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
      highlightDensity: computeHighlightDensity(histogram),
      tileCount: 1,
      phaseTimings,
    };
  }

  private async createBlobFromImageData(
    imageData: ImageData,
    format: ExportRequest['options']['format'],
    quality: number,
    targetMaxDimension: number | null,
  ) {
    const longestEdge = Math.max(imageData.width, imageData.height);
    const scale = targetMaxDimension && targetMaxDimension < longestEdge
      ? targetMaxDimension / longestEdge
      : 1;
    const targetWidth = Math.max(1, Math.round(imageData.width * scale));
    const targetHeight = Math.max(1, Math.round(imageData.height * scale));

    if (format === 'image/tiff') {
      const sourceCanvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(imageData.width, imageData.height)
        : document.createElement('canvas');
      sourceCanvas.width = imageData.width;
      sourceCanvas.height = imageData.height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sourceContext) {
        throw new Error('Could not create TIFF export canvas.');
      }
      sourceContext.putImageData(imageData, 0, 0);

      const resizedCanvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(targetWidth, targetHeight)
        : document.createElement('canvas');
      resizedCanvas.width = targetWidth;
      resizedCanvas.height = targetHeight;
      const resizedContext = resizedCanvas.getContext('2d', { willReadFrequently: true });
      if (!resizedContext) {
        throw new Error('Could not create TIFF resize canvas.');
      }
      resizedContext.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
      const resizedImageData = resizedContext.getImageData(0, 0, targetWidth, targetHeight);
      const encoded = UTIF.encodeImage(new Uint8Array(resizedImageData.data), targetWidth, targetHeight);
      return new Blob([encoded], { type: 'image/tiff' });
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        throw new Error('Could not create export canvas.');
      }
      if (scale === 1) {
        context.putImageData(imageData, 0, 0);
      } else {
        const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
        const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
        if (!sourceContext) {
          throw new Error('Could not create source export canvas.');
        }
        sourceContext.putImageData(imageData, 0, 0);
        context.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
      }
      return canvas.convertToBlob({
        type: format,
        quality: format === 'image/png' ? undefined : quality,
      });
    }

    if (typeof document === 'undefined') {
      throw new Error('Canvas export is unavailable in this environment.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not create export canvas.');
    }
    if (scale === 1) {
      context.putImageData(imageData, 0, 0);
    } else {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = imageData.width;
      sourceCanvas.height = imageData.height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sourceContext) {
        throw new Error('Could not create source export canvas.');
      }
      sourceContext.putImageData(imageData, 0, 0);
      context.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
    }

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not encode export image.'));
          return;
        }
        resolve(blob);
      }, format, format === 'image/png' ? undefined : quality);
    });
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

  async decode(payload: DecodeRequest) {
    const cachedPayload = this.cloneDecodeRequest(payload);
    const decoded = await this.request<DecodedImage>('decode', payload, [payload.buffer]);
    this.decodeCache.set(payload.documentId, {
      payload: cachedPayload,
      estimatedFilmBaseSample: decoded.estimatedFilmBaseSample ?? null,
      estimatedDensityBalance: decoded.estimatedDensityBalance ?? null,
      workerEpoch: this.workerEpoch,
      evictionTimeout: null,
    });
    this.scheduleDecodeCacheEviction(payload.documentId);
    return decoded;
  }

  async render(payload: RenderRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    return this.renderInternal(payload, true);
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
    const result = await this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<RenderResult>('render', payload),
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
    const cachedDecode = this.decodeCache.get(payload.documentId);
    const estimatedFilmBaseSample = payload.estimatedFilmBaseSample ?? cachedDecode?.estimatedFilmBaseSample ?? null;
    const estimatedDensityBalance = payload.estimatedDensityBalance ?? cachedDecode?.estimatedDensityBalance ?? null;
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
      const prepareStartedAt = performance.now();
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'preview',
        settings: payload.settings,
        comparisonMode: payload.comparisonMode,
        flatFieldHandledInWorker: false,
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
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
        payload.labStyleToneCurve,
        payload.labStyleChannelCurves,
        payload.labTonalCharacterOverride,
        payload.labSaturationBias,
        payload.labTemperatureBias,
        payload.highlightDensityEstimate,
        payload.filmType,
        payload.advancedInversion,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        payload.flareFloor,
        payload.lightSourceBias,
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

  async autoAnalyze(payload: AutoAnalyzeRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    return this.requestWithDocumentRecovery(
      payload.documentId,
      () => this.request<AutoAnalyzeResult>('auto-analyze', payload),
      true,
    );
  }

  async detectFrame(documentId: string) {
    await this.ensureDocumentLoaded(documentId);
    return this.requestWithDocumentRecovery<DetectedFrame | null>(
      documentId,
      () => this.request<DetectedFrame | null>('detect-frame', { documentId }),
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

  async detectDust(documentId: string, sensitivity: number, maxRadius: number, mode: 'spots' | 'scratches' | 'both'): Promise<DustMark[]> {
    await this.ensureDocumentLoaded(documentId);
    const result = await this.requestWithDocumentRecovery<{ type: 'dust-detect'; detectedMarks: DustMark[] }>(
      documentId,
      () => this.request<{ type: 'dust-detect'; detectedMarks: DustMark[] }>(
        'dust-detect',
        { documentId, sensitivity, maxRadius, mode },
      ),
      true,
    );
    return result.detectedMarks;
  }

  async loadFlatField(name: string, data: Float32Array, size: number) {
    this.activeFlatField = {
      name,
      size,
      data: new Float32Array(data.buffer.slice(0)),
    };
    const payload = {
      name,
      size,
      data: new Float32Array(data.buffer.slice(0)),
    };
    const result = await this.request<{ loaded: true }>('load-flat-field', payload, [payload.data.buffer]);
    this.gpuPipeline?.loadFlatFieldTexture?.(this.activeFlatField.data, this.activeFlatField.size);
    return result;
  }

  async clearFlatField() {
    this.activeFlatField = null;
    const result = await this.request<{ cleared: true }>('clear-flat-field', {});
    this.gpuPipeline?.clearFlatFieldTexture?.();
    return result;
  }

  async export(payload: ExportRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    const result = await this.exportInternal(payload, true);
    return finalizeExportBlob(result, payload.options, payload.sourceExif);
  }

  async contactSheet(payload: ContactSheetRequest) {
    const result = await this.request<ContactSheetResult>('contact-sheet', payload);
    return finalizeExportBlob(result, payload.exportOptions);
  }

  private async exportInternal(payload: ExportRequest, allowRecovery: boolean): Promise<ExportResult> {
    const cachedDecode = this.decodeCache.get(payload.documentId);
    const estimatedFilmBaseSample = cachedDecode?.estimatedFilmBaseSample ?? null;
    const estimatedDensityBalance = payload.estimatedDensityBalance ?? cachedDecode?.estimatedDensityBalance ?? null;
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
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'source',
        settings: payload.settings,
        comparisonMode: 'processed',
        flatFieldHandledInWorker: false,
      });
      const assembled = await this.assembleTileJob(
        prepared,
        payload.settings,
        payload.isColor,
        'processed',
        payload.inputProfileId ?? 'srgb',
        payload.outputProfileId ?? 'srgb',
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
        payload.labStyleToneCurve,
        payload.labStyleChannelCurves,
        payload.labTonalCharacterOverride,
        payload.labSaturationBias,
        payload.labTemperatureBias,
        payload.highlightDensityEstimate,
        payload.filmType,
        payload.advancedInversion,
        estimatedFilmBaseSample,
        estimatedDensityBalance,
        payload.flareFloor,
        payload.lightSourceBias,
      );
      await this.cancelTileJob(payload.documentId, jobId);

      const blob = await this.createBlobFromImageData(
        assembled.imageData,
        payload.options.format,
        payload.options.quality,
        payload.options.targetMaxDimension,
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
        blob,
        filename: `${sanitizeFilenameBase(payload.options.filenameBase)}.${getExtensionFromFormat(payload.options.format)}`,
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
    const cached = this.decodeCache.get(documentId);
    if (cached?.evictionTimeout != null) {
      window.clearTimeout(cached.evictionTimeout);
    }
    this.decodeCache.delete(documentId);
    this.documentRecovery.delete(documentId);
    this.activePreviewJobIds.delete(documentId);
    return this.request<{ disposed: true }>('dispose', { documentId });
  }

  evictPreviews(documentId: string) {
    return this.request<{ evicted: true }>('evict-previews', { documentId });
  }

  trimResidentDocuments(maxResidentDocuments: number | null, preserveDocumentId?: string | null) {
    return this.request<{ evicted: true }>('evict-previews', {
      maxResidentDocuments,
      preserveDocumentId: preserveDocumentId ?? null,
    });
  }

  terminate() {
    this.isTerminated = true;
    this.rejectPending(new Error('Image worker terminated.'));
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
