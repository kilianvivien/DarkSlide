import type {
  AutoAnalyzeRequest,
  AutoAnalyzeResult,
  CancelTileJobRequest,
  ContactSheetRequest,
  ContactSheetResult,
  DecodeRequest,
  DecodedImage,
  DetectedFrame,
  DustDetectRequest,
  DustDetectResult,
  ExportRequest,
  ExportResult,
  FilmBaseSample,
  PreparePreviewBitmapRequest,
  PreparedPreviewBitmapResult,
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

export interface DetectFramePayload {
  documentId: string;
}

export interface ComputeFlarePayload {
  documentId: string;
}

export interface WorkerError {
  code: string;
  message: string;
}

export type WorkerRequest =
  | { type: 'decode'; payload: DecodeRequest }
  | { type: 'render'; payload: RenderRequest }
  | { type: 'auto-analyze'; payload: AutoAnalyzeRequest }
  | { type: 'prepare-tile-job'; payload: PrepareTileJobRequest }
  | { type: 'prepare-preview-bitmap'; payload: PreparePreviewBitmapRequest }
  | { type: 'read-tile'; payload: ReadTileRequest }
  | { type: 'cancel-job'; payload: CancelTileJobRequest }
  | { type: 'sample-film-base'; payload: SampleRequest }
  | { type: 'detect-frame'; payload: DetectFramePayload }
  | { type: 'compute-flare'; payload: ComputeFlarePayload }
  | { type: 'dust-detect'; payload: DustDetectRequest }
  | { type: 'export'; payload: ExportRequest }
  | { type: 'contact-sheet'; payload: ContactSheetRequest }
  | { type: 'diagnostics'; payload: Record<string, never> }
  | { type: 'dispose'; payload: DisposePayload }
  | { type: 'evict-previews'; payload: EvictPreviewsPayload };

export type WorkerSuccessPayload =
  | DecodedImage
  | RenderResult
  | AutoAnalyzeResult
  | DustDetectResult
  | PreparedTileJobResult
  | PreparedPreviewBitmapResult
  | ReadTileResult
  | ExportResult
  | RawExportResult
  | ContactSheetResult
  | FilmBaseSample
  | DetectedFrame
  | [number, number, number]
  | WorkerMemoryDiagnostics
  | null
  | { loaded: true }
  | { cleared: true }
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
