import {
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  RawExportResult,
  RenderBackendDiagnostics,
  RenderRequest,
  RenderResult,
  SampleRequest,
} from '../types';
import { WebGPUPipeline } from './gpu/WebGPUPipeline';

type WorkerRequest =
  | { id: string; type: 'decode'; payload: DecodeRequest }
  | { id: string; type: 'render'; payload: RenderRequest }
  | { id: string; type: 'sample-film-base'; payload: SampleRequest }
  | { id: string; type: 'export'; payload: ExportRequest }
  | { id: string; type: 'dispose'; payload: { documentId: string } };

type WorkerError = { code: string; message: string };

type WorkerResponse =
  | { id: string; ok: true; payload: DecodedImage | RenderResult | ExportResult | RawExportResult | FilmBaseSample | { disposed: true } }
  | { id: string; ok: false; error: WorkerError };

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

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
        const workerError = response.error;
        entry.reject(new Error(`${workerError.code}: ${workerError.message}`));
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

  setGPUEnabled(enabled: boolean) {
    this.gpuEnabled = enabled;

    if (!enabled) {
      this.gpuInitAttempted = false;
      this.resetGPU('user');
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
      maxStorageBufferBindingSize: gpu?.limits.maxStorageBufferBindingSize ?? null,
      maxBufferSize: gpu?.limits.maxBufferSize ?? null,
      gpuDisabledReason: this.gpuDisabledReason,
      lastError: this.lastGPUError,
    };
  }

  private async createBlobFromImageData(result: RawExportResult) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(result.width, result.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        throw new Error('Could not create export canvas.');
      }
      context.putImageData(result.imageData, 0, 0);
      return canvas.convertToBlob({
        type: result.format,
        quality: result.format === 'image/png' ? undefined : result.quality,
      });
    }

    if (typeof document === 'undefined') {
      throw new Error('Canvas export is unavailable in this environment.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not create export canvas.');
    }
    context.putImageData(result.imageData, 0, 0);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Could not encode export image.'));
            return;
          }
          resolve(blob);
        },
        result.format,
        result.format === 'image/png' ? undefined : result.quality,
      );
    });
  }

  decode(payload: DecodeRequest) {
    return this.request<DecodedImage>('decode', payload);
  }

  async render(payload: RenderRequest) {
    if (!this.canAttemptGPU()) {
      return this.request<RenderResult>('render', payload);
    }

    const gpu = await this.ensureGPU();
    if (!gpu) {
      return this.request<RenderResult>('render', payload);
    }

    const rawResult = await this.request<RenderResult>('render', { ...payload, skipProcessing: true });

    try {
      const histogram = await gpu.processImageData(
        rawResult.imageData,
        payload.settings,
        payload.isColor,
        payload.comparisonMode,
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );

      return {
        ...rawResult,
        histogram,
      };
    } catch (error) {
      this.handleGPUFailure(error);
      return this.request<RenderResult>('render', payload);
    }
  }

  sampleFilmBase(payload: SampleRequest) {
    return this.request<FilmBaseSample>('sample-film-base', payload);
  }

  async export(payload: ExportRequest) {
    if (!this.canAttemptGPU()) {
      return this.request<ExportResult>('export', payload);
    }

    const gpu = await this.ensureGPU();
    if (!gpu) {
      return this.request<ExportResult>('export', payload);
    }

    const rawResult = await this.request<RawExportResult>('export', { ...payload, skipProcessing: true });

    try {
      await gpu.processImageData(
        rawResult.imageData,
        payload.settings,
        payload.isColor,
        'processed',
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );

      return {
        blob: await this.createBlobFromImageData(rawResult),
        filename: rawResult.filename,
      } satisfies ExportResult;
    } catch (error) {
      this.handleGPUFailure(error);
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
