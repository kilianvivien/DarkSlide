import {
  ContactSheetRequest,
  ContactSheetResult,
  CancelTileJobRequest,
  ConversionSettings,
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  HistogramData,
  HistogramMode,
  InteractionQuality,
  PrepareTileJobRequest,
  PreparedTileJobResult,
  PreviewMode,
  ReadTileRequest,
  ReadTileResult,
  RenderBackendMode,
  RenderBackendDiagnostics,
  RenderJobDiagnosticsSnapshot,
  RenderRequest,
  RenderResult,
  SampleRequest,
  TileSourceKind,
  WorkerMemoryDiagnostics,
} from '../types';
import { appendDiagnostic } from './diagnostics';
import { accumulateHistogram, buildEmptyHistogram, getExtensionFromFormat, sanitizeFilenameBase } from './imagePipeline';
import { getBlobUrlDiagnostics } from './blobUrlTracker';
import { WebGPUPipeline } from './gpu/WebGPUPipeline';
import { finalizeExportBlob } from './imageMetadata';

type WorkerRequest =
  | { id: string; type: 'decode'; payload: DecodeRequest }
  | { id: string; type: 'render'; payload: RenderRequest }
  | { id: string; type: 'prepare-tile-job'; payload: PrepareTileJobRequest }
  | { id: string; type: 'read-tile'; payload: ReadTileRequest }
  | { id: string; type: 'cancel-job'; payload: CancelTileJobRequest }
  | { id: string; type: 'sample-film-base'; payload: SampleRequest }
  | { id: string; type: 'export'; payload: ExportRequest }
  | { id: string; type: 'contact-sheet'; payload: ContactSheetRequest }
  | { id: string; type: 'diagnostics'; payload: Record<string, never> }
  | { id: string; type: 'dispose'; payload: { documentId: string } };

type WorkerError = { code: string; message: string };

type WorkerResponse =
  | {
    id: string;
    ok: true;
    payload:
      | DecodedImage
      | RenderResult
      | PreparedTileJobResult
      | ReadTileResult
      | ExportResult
      | ContactSheetResult
      | FilmBaseSample
      | WorkerMemoryDiagnostics
      | { disposed: true }
      | { cancelled: true };
  }
  | { id: string; ok: false; error: WorkerError };

type ImageWorkerClientOptions = {
  gpuEnabled?: boolean;
  onBackendDiagnosticsChange?: (diagnostics: RenderBackendDiagnostics) => void;
  onGPUDeviceLost?: (message: string) => void;
};

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type CachedDecodeRequest = {
  payload: DecodeRequest;
  workerEpoch: number;
};

const MISSING_DOCUMENT_MESSAGE = 'The image document is no longer available.';

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

  private coalescedPreviewRequests = 0;

  private cancelledPreviewJobs = 0;

  private previewBackend: RenderBackendMode | null = null;

  private lastPreviewJob: RenderJobDiagnosticsSnapshot | null = null;

  private lastExportJob: RenderJobDiagnosticsSnapshot | null = null;

  private activePreviewJobIds = new Map<string, string>();

  private lastDraftHistogram: HistogramData | null = null;

  private lastDraftHistogramAt = 0;

  private lastDraftHistogramDocumentId: string | null = null;

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
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);

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
    this.pending.forEach((entry) => entry.reject(error));
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

  private request<T>(type: WorkerRequest['type'], payload: WorkerRequest['payload']) {
    if (!this.worker) {
      return Promise.reject<T>(new FatalImageWorkerError('The image worker is unavailable.'));
    }

    const id = `${type}-${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, type, payload } as WorkerRequest);
    });
  }

  private cloneDecodeRequest(payload: DecodeRequest): DecodeRequest {
    return {
      ...payload,
      buffer: payload.buffer.slice(0),
      rawDimensions: payload.rawDimensions ? { ...payload.rawDimensions } : undefined,
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
          workerEpoch: this.workerEpoch,
        });
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
    this.emitBackendDiagnosticsChange();
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
    maskTuning?: RenderRequest['maskTuning'],
    colorMatrix?: RenderRequest['colorMatrix'],
    tonalCharacter?: RenderRequest['tonalCharacter'],
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
        ? await this.gpuPipeline.processTile(rawTile, settings, isColor, comparisonMode, maskTuning, colorMatrix, tonalCharacter)
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
    maskTuning?: RenderRequest['maskTuning'],
    colorMatrix?: RenderRequest['colorMatrix'],
    tonalCharacter?: RenderRequest['tonalCharacter'],
  ) {
    const rawPreview = await this.readTile({
      documentId: prepared.documentId,
      jobId: prepared.jobId,
      x: 0,
      y: 0,
      width: prepared.width,
      height: prepared.height,
    });

    const imageData = comparisonMode === 'processed' && this.gpuPipeline
      ? await this.gpuPipeline.processPreviewImage(
        rawPreview.imageData,
        settings,
        isColor,
        comparisonMode,
        maskTuning,
        colorMatrix,
        tonalCharacter,
      )
      : trimTileImageData(rawPreview);

    let histogram: HistogramData;
    if (
      histogramMode === 'throttled'
      && this.lastDraftHistogram
      && this.lastDraftHistogramDocumentId === prepared.documentId
      && performance.now() - this.lastDraftHistogramAt < 150
    ) {
      histogram = cloneHistogram(this.lastDraftHistogram);
    } else {
      histogram = buildEmptyHistogram();
      accumulateHistogram(histogram, imageData.data);
      if (histogramMode === 'throttled') {
        this.lastDraftHistogram = cloneHistogram(histogram);
        this.lastDraftHistogramAt = performance.now();
        this.lastDraftHistogramDocumentId = prepared.documentId;
      }
    }

    return {
      imageData,
      histogram,
      tileCount: 1,
    };
  }

  private async createBlobFromImageData(
    imageData: ImageData,
    format: ExportRequest['options']['format'],
    quality: number,
  ) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(imageData.width, imageData.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        throw new Error('Could not create export canvas.');
      }
      context.putImageData(imageData, 0, 0);
      return canvas.convertToBlob({
        type: format,
        quality: format === 'image/png' ? undefined : quality,
      });
    }

    if (typeof document === 'undefined') {
      throw new Error('Canvas export is unavailable in this environment.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not create export canvas.');
    }
    context.putImageData(imageData, 0, 0);

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
    const decoded = await this.request<DecodedImage>('decode', payload);
    this.decodeCache.set(payload.documentId, {
      payload: this.cloneDecodeRequest(payload),
      workerEpoch: this.workerEpoch,
    });
    return decoded;
  }

  async render(payload: RenderRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    return this.renderInternal(payload, true);
  }

  private async renderInternal(payload: RenderRequest, allowRecovery: boolean) {
    const activePreviewJobId = this.activePreviewJobIds.get(payload.documentId) ?? null;
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
        );
        this.emitBackendDiagnosticsChange();
        if (this.activePreviewJobIds.get(payload.documentId) === jobId) {
          this.activePreviewJobIds.delete(payload.documentId);
        }
        return this.requestWithDocumentRecovery(
          payload.documentId,
          () => this.request<RenderResult>('render', payload),
          allowRecovery,
        );
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
        return this.requestWithDocumentRecovery(
          payload.documentId,
          () => this.request<RenderResult>('render', payload),
          allowRecovery,
        );
      }
    }

    const startedAt = performance.now();
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
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'preview',
        settings: payload.settings,
        comparisonMode: payload.comparisonMode,
        targetMaxDimension: payload.targetMaxDimension,
      });

      const assembled = await this.assemblePreviewJob(
        prepared,
        payload.settings,
        payload.isColor,
        payload.comparisonMode,
        payload.histogramMode ?? 'full',
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );
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
      });
      this.previewBackend = backendMode;
      this.lastPreviewJob = snapshot;
      this.emitBackendDiagnosticsChange();

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
      return this.requestWithDocumentRecovery(
        payload.documentId,
        () => this.request<RenderResult>('render', payload),
        false,
      );
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

  async export(payload: ExportRequest) {
    await this.ensureDocumentLoaded(payload.documentId);
    const result = await this.exportInternal(payload, true);
    return finalizeExportBlob(result, payload.options, payload.sourceExif);
  }

  async contactSheet(payload: ContactSheetRequest) {
    const result = await this.request<ContactSheetResult>('contact-sheet', payload);
    return finalizeExportBlob(result, payload.exportOptions);
  }

  private async exportInternal(payload: ExportRequest, allowRecovery: boolean) {
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
      });
      const assembled = await this.assembleTileJob(
        prepared,
        payload.settings,
        payload.isColor,
        'processed',
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );
      await this.cancelTileJob(payload.documentId, jobId);

      const blob = await this.createBlobFromImageData(
        assembled.imageData,
        payload.options.format,
        payload.options.quality,
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
    this.decodeCache.delete(documentId);
    this.documentRecovery.delete(documentId);
    this.activePreviewJobIds.delete(documentId);
    return this.request<{ disposed: true }>('dispose', { documentId });
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
