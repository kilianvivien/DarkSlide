import type {
  CancelTileJobRequest,
  ContactSheetRequest,
  ContactSheetResult,
  DecodeRequest,
  DecodedImage,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  PrepareTileJobRequest,
  PreparedTileJobResult,
  RawExportResult,
  ReadTileRequest,
  ReadTileResult,
  RenderRequest,
  RenderResult,
  SampleRequest,
  WorkerMemoryDiagnostics,
} from '../types';

export interface DisposePayload {
  documentId: string;
}

export interface EvictPreviewsPayload {
  documentId?: string | null;
  preserveDocumentId?: string | null;
  maxResidentDocuments?: number | null;
}

export interface WorkerError {
  code: string;
  message: string;
}

export type WorkerRequest =
  | { type: 'decode'; payload: DecodeRequest }
  | { type: 'render'; payload: RenderRequest }
  | { type: 'prepare-tile-job'; payload: PrepareTileJobRequest }
  | { type: 'read-tile'; payload: ReadTileRequest }
  | { type: 'cancel-job'; payload: CancelTileJobRequest }
  | { type: 'sample-film-base'; payload: SampleRequest }
  | { type: 'export'; payload: ExportRequest }
  | { type: 'contact-sheet'; payload: ContactSheetRequest }
  | { type: 'diagnostics'; payload: Record<string, never> }
  | { type: 'dispose'; payload: DisposePayload }
  | { type: 'evict-previews'; payload: EvictPreviewsPayload };

export type WorkerSuccessPayload =
  | DecodedImage
  | RenderResult
  | PreparedTileJobResult
  | ReadTileResult
  | ExportResult
  | RawExportResult
  | ContactSheetResult
  | FilmBaseSample
  | WorkerMemoryDiagnostics
  | { disposed: true }
  | { cancelled: true }
  | { evicted: true };

export type WorkerRequestType = WorkerRequest['type'];

export type WorkerMessage<T extends WorkerRequestType = WorkerRequestType> = T extends WorkerRequestType
  ? {
    id: string;
    epoch: number;
    type: T;
    payload: Extract<WorkerRequest, { type: T }>['payload'];
  }
  : never;

export type WorkerResponse =
  | { id: string; epoch: number; ok: true; payload: WorkerSuccessPayload }
  | { id: string; epoch: number; ok: false; error: WorkerError };
