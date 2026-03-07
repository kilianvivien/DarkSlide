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

export class ImageWorkerClient {
  private worker: Worker;

  private pending = new Map<string, PendingResolver>();

  constructor() {
    this.worker = new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
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
  }

  private request<T>(type: WorkerRequest['type'], payload: WorkerRequest['payload']) {
    const id = `${type}-${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload } as WorkerRequest);
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
    this.pending.forEach((entry) => entry.reject(new Error('Image worker terminated.')));
    this.pending.clear();
    this.worker.terminate();
  }
}
