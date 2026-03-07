import {
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  RenderRequest,
  RenderResult,
  SampleRequest,
} from '../types';

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

  constructor() {
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

  decode(payload: DecodeRequest) {
    return this.request<DecodedImage>('decode', payload);
  }

  render(payload: RenderRequest) {
    return this.request<RenderResult>('render', payload);
  }

  sampleFilmBase(payload: SampleRequest) {
    return this.request<FilmBaseSample>('sample-film-base', payload);
  }

  export(payload: ExportRequest) {
    return this.request<ExportResult>('export', payload);
  }

  disposeDocument(documentId: string) {
    return this.request<{ disposed: true }>('dispose', { documentId });
  }

  terminate() {
    this.isTerminated = true;
    this.rejectPending(new Error('Image worker terminated.'));
    this.worker?.terminate();
    this.worker = null;
  }
}
