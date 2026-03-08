import {
  CancelTileJobRequest,
  ConversionSettings,
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  PrepareTileJobRequest,
  PreparedTileJobResult,
  ReadTileRequest,
  ReadTileResult,
  RenderBackendDiagnostics,
  RenderRequest,
  RenderResult,
  SampleRequest,
  TileSourceKind,
} from '../types';
import { appendDiagnostic } from './diagnostics';
import { accumulateHistogram, buildEmptyHistogram, getExtensionFromFormat, sanitizeFilenameBase } from './imagePipeline';
import { WebGPUPipeline } from './gpu/WebGPUPipeline';

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
  | {
    id: string;
    ok: true;
    payload:
      | DecodedImage
      | RenderResult
      | PreparedTileJobResult
      | ReadTileResult
      | ExportResult
      | FilmBaseSample
      | { disposed: true }
      | { cancelled: true };
  }
  | { id: string; ok: false; error: WorkerError };

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
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

  private isTerminated = false;

  private gpuPipeline: WebGPUPipeline | null = null;

  private gpuInitAttempted = false;

  private gpuEnabled = true;

  private gpuDisabledReason: RenderBackendDiagnostics['gpuDisabledReason'] = null;

  private lastGPUError: string | null = null;

  private backendMode: RenderBackendDiagnostics['backendMode'] = 'cpu-worker';

  private sourceKind: TileSourceKind | null = null;

  private tileSize: number | null = null;

  private halo: number | null = null;

  private tileCount: number | null = null;

  private intermediateFormat: RenderBackendDiagnostics['intermediateFormat'] = null;

  private usedCpuFallback = false;

  private fallbackReason: string | null = null;

  private jobDurationMs: number | null = null;

  private activePreviewJobId: string | null = null;

  constructor(options: { gpuEnabled?: boolean } = {}) {
    this.gpuEnabled = options.gpuEnabled ?? true;
    this.gpuDisabledReason = this.gpuEnabled ? null : 'user';
    this.worker = this.createWorker();
  }

  private createWorker() {
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

  private resetGPU(reason: RenderBackendDiagnostics['gpuDisabledReason'], error?: unknown, allowRetry = false) {
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;
    this.gpuDisabledReason = reason;
    this.gpuInitAttempted = allowRetry ? false : this.gpuInitAttempted;
    this.lastGPUError = error instanceof Error ? error.message : (typeof error === 'string' ? error : this.lastGPUError);
  }

  private updateBackendState(update: Partial<Pick<
    RenderBackendDiagnostics,
    'backendMode'
    | 'sourceKind'
    | 'tileSize'
    | 'halo'
    | 'tileCount'
    | 'intermediateFormat'
    | 'usedCpuFallback'
    | 'fallbackReason'
    | 'jobDurationMs'
  >>) {
    if (update.backendMode !== undefined) this.backendMode = update.backendMode;
    if (update.sourceKind !== undefined) this.sourceKind = update.sourceKind;
    if (update.tileSize !== undefined) this.tileSize = update.tileSize;
    if (update.halo !== undefined) this.halo = update.halo;
    if (update.tileCount !== undefined) this.tileCount = update.tileCount;
    if (update.intermediateFormat !== undefined) this.intermediateFormat = update.intermediateFormat;
    if (update.usedCpuFallback !== undefined) this.usedCpuFallback = update.usedCpuFallback;
    if (update.fallbackReason !== undefined) this.fallbackReason = update.fallbackReason;
    if (update.jobDurationMs !== undefined) this.jobDurationMs = update.jobDurationMs;
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
      this.resetGPU('device-lost', 'WebGPU device was lost.', true);
    }

    if (this.gpuPipeline) {
      this.gpuDisabledReason = null;
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
      return null;
    }

    this.gpuDisabledReason = null;
    this.lastGPUError = null;
    return this.gpuPipeline;
  }

  private handleGPUFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /device was lost/i.test(message) ? 'device-lost' : 'initialization-failed';
    this.resetGPU(reason, message, true);
  }

  private canAttemptGPU() {
    return this.gpuEnabled && typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  private async cancelTileJob(documentId: string, jobId: string | null, logCancellation = false) {
    if (!jobId) return;
    try {
      await this.request<{ cancelled: true }>('cancel-job', { documentId, jobId });
      if (logCancellation) {
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
      tileSize: null,
      halo: null,
      tileCount: null,
      intermediateFormat: null,
      usedCpuFallback,
      fallbackReason,
      jobDurationMs: null,
    });
  }

  setGPUEnabled(enabled: boolean) {
    this.gpuEnabled = enabled;

    if (!enabled) {
      this.gpuInitAttempted = false;
      this.resetGPU('user');
      this.markCpuWorkerBackend('preview');
      return;
    }

    this.gpuDisabledReason = null;
    this.lastGPUError = null;
    this.gpuInitAttempted = false;
  }

  async getGPUDiagnostics(): Promise<RenderBackendDiagnostics> {
    const gpu = this.canAttemptGPU() ? await this.ensureGPU() : null;

    return {
      gpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
      gpuEnabled: this.gpuEnabled,
      gpuActive: gpu !== null,
      gpuAdapterName: gpu?.adapterName ?? null,
      backendMode: this.backendMode,
      sourceKind: this.sourceKind,
      tileSize: this.tileSize,
      halo: this.halo,
      tileCount: this.tileCount,
      intermediateFormat: this.intermediateFormat,
      usedCpuFallback: this.usedCpuFallback,
      fallbackReason: this.fallbackReason,
      jobDurationMs: this.jobDurationMs,
      maxStorageBufferBindingSize: gpu?.limits.maxStorageBufferBindingSize ?? null,
      maxBufferSize: gpu?.limits.maxBufferSize ?? null,
      gpuDisabledReason: this.gpuDisabledReason,
      lastError: this.lastGPUError,
    };
  }

  decode(payload: DecodeRequest) {
    return this.request<DecodedImage>('decode', payload);
  }

  async render(payload: RenderRequest) {
    await this.cancelTileJob(payload.documentId, this.activePreviewJobId, true);

    const jobId = this.createJobId(payload.documentId, payload.revision, 'preview');
    this.activePreviewJobId = jobId;

    if (payload.comparisonMode === 'processed') {
      if (!this.canAttemptGPU()) {
        this.markCpuWorkerBackend('preview');
        return this.request<RenderResult>('render', payload);
      }

      const gpu = await this.ensureGPU();
      if (!gpu) {
        this.markCpuWorkerBackend('preview', this.lastGPUError ?? 'WebGPU unavailable.', true);
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
        return this.request<RenderResult>('render', payload);
      }
    }

    const startedAt = performance.now();
    appendDiagnostic({
      level: 'info',
      code: 'GPU_TILE_JOB_STARTED',
      message: payload.documentId,
      context: {
        documentId: payload.documentId,
        jobId,
        sourceKind: 'preview',
      },
    });

    try {
      const prepared = await this.prepareTileJob({
        documentId: payload.documentId,
        jobId,
        sourceKind: 'preview',
        settings: payload.settings,
        comparisonMode: payload.comparisonMode,
        targetMaxDimension: payload.targetMaxDimension,
      });

      const assembled = await this.assembleTileJob(
        prepared,
        payload.settings,
        payload.isColor,
        payload.comparisonMode,
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );
      await this.cancelTileJob(payload.documentId, jobId);
      if (this.activePreviewJobId === jobId) {
        this.activePreviewJobId = null;
      }

      const jobDurationMs = Math.round(performance.now() - startedAt);
      this.updateBackendState({
        backendMode: payload.comparisonMode === 'processed' ? 'gpu-tiled-render' : 'cpu-worker',
        sourceKind: 'preview',
        tileSize: prepared.tileSize,
        halo: prepared.halo,
        tileCount: assembled.tileCount,
        intermediateFormat: payload.comparisonMode === 'processed' ? 'rgba16float' : null,
        usedCpuFallback: false,
        fallbackReason: null,
        jobDurationMs,
      });

      appendDiagnostic({
        level: 'info',
        code: 'GPU_TILE_JOB_COMPLETED',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          halo: prepared.halo,
          jobDurationMs,
          jobId,
          sourceKind: 'preview',
          tileCount: assembled.tileCount,
          tileSize: prepared.tileSize,
        },
      });

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
      if (this.activePreviewJobId === jobId) {
        this.activePreviewJobId = null;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('JOB_CANCELLED')) {
        throw error;
      }

      this.handleGPUFailure(error);
      this.markCpuWorkerBackend('preview', message, true);
      appendDiagnostic({
        level: 'info',
        code: 'GPU_FALLBACK_CPU',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
          jobId,
          reason: message,
          sourceKind: 'preview',
        },
      });
      return this.request<RenderResult>('render', payload);
    }
  }

  sampleFilmBase(payload: SampleRequest) {
    return this.request<FilmBaseSample>('sample-film-base', payload);
  }

  async export(payload: ExportRequest) {
    if (!this.canAttemptGPU()) {
      this.markCpuWorkerBackend('source');
      return this.request<ExportResult>('export', payload);
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
      return this.request<ExportResult>('export', payload);
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
      this.updateBackendState({
        backendMode: 'gpu-tiled-render',
        sourceKind: 'source',
        tileSize: prepared.tileSize,
        halo: prepared.halo,
        tileCount: assembled.tileCount,
        intermediateFormat: 'rgba16float',
        usedCpuFallback: false,
        fallbackReason: null,
        jobDurationMs,
      });

      appendDiagnostic({
        level: 'info',
        code: 'GPU_EXPORT_TILED_COMPLETED',
        message: payload.documentId,
        context: {
          documentId: payload.documentId,
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
      this.handleGPUFailure(error);
      this.markCpuWorkerBackend('source', message, true);
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
      return this.request<ExportResult>('export', payload);
    }
  }

  disposeDocument(documentId: string) {
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
