export type FilmType = 'color' | 'bw';
export type CropTab = 'Film' | 'Print' | 'Social' | 'Digital';
export type ScannerType = 'flatbed' | 'camera' | 'dedicated' | 'smartphone';

export interface CurvePoint {
  x: number;
  y: number;
}

export interface Curves {
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface CropSettings {
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: number | null;
}

export type ExportFormat = 'image/jpeg' | 'image/png' | 'image/webp';
export type TileSourceKind = 'preview' | 'source';
export type PreviewMode = 'draft' | 'settled';
export type RenderBackendMode = 'gpu-preview' | 'gpu-tiled-render' | 'cpu-worker';
export type InteractionQuality = 'balanced' | 'ultra-smooth';
export type HistogramMode = 'full' | 'throttled';

export interface FilmBaseSample {
  r: number;
  g: number;
  b: number;
}

export type ColorMatrix = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface TonalCharacter {
  shadowLift: number;
  highlightRolloff: number;
  midtoneAnchor: number;
}

export interface MaskTuning {
  highlightProtectionBias: number;
  blackPointBias: number;
}

export interface SharpenSettings {
  enabled: boolean;
  radius: number;   // 0.5 - 3.0
  amount: number;    // 0 - 200
}

export interface NoiseReductionSettings {
  enabled: boolean;
  luminanceStrength: number; // 0 - 100
}

export interface ConversionSettings {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  redBalance: number;
  greenBalance: number;
  blueBalance: number;
  blackPoint: number;
  whitePoint: number;
  highlightProtection: number;
  curves: Curves;
  rotation: number;
  levelAngle: number;
  crop: CropSettings;
  filmBaseSample: FilmBaseSample | null;
  sharpen: SharpenSettings;
  noiseReduction: NoiseReductionSettings;
}

export interface ExportOptions {
  format: ExportFormat;
  quality: number;
  filenameBase: string;
}

export interface FilmProfile {
  id: string;
  version: number;
  name: string;
  type: FilmType;
  description: string;
  defaultSettings: ConversionSettings;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  isCustom?: boolean;
  tags?: string[];
  filmStock?: string | null;
  scannerType?: ScannerType | null;
}

export interface DarkslidePresetFile {
  darkslideVersion: string;
  profile: FilmProfile;
}

export interface HistogramData {
  r: number[];
  g: number[];
  b: number[];
  l: number[];
}

export interface PreviewLevel {
  id: string;
  width: number;
  height: number;
  maxDimension: number;
}

export interface SourceMetadata {
  id: string;
  name: string;
  mime: string;
  extension: string;
  size: number;
  width: number;
  height: number;
}

export interface DecodedImage {
  metadata: SourceMetadata;
  previewLevels: PreviewLevel[];
}

export interface WorkspaceDocument {
  id: string;
  source: SourceMetadata;
  previewLevels: PreviewLevel[];
  settings: ConversionSettings;
  rawImportProfile?: FilmProfile | null;
  profileId: string;
  exportOptions: ExportOptions;
  histogram: HistogramData | null;
  renderRevision: number;
  status: 'idle' | 'loading' | 'ready' | 'processing' | 'exporting' | 'error';
  dirty: boolean;
  errorCode?: string;
}

export interface DecodeRequest {
  documentId: string;
  buffer: ArrayBuffer;
  fileName: string;
  mime: string;
  size: number;
  rawDimensions?: { width: number; height: number };
}

export interface RenderRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  revision: number;
  targetMaxDimension: number;
  comparisonMode: 'processed' | 'original';
  previewMode?: PreviewMode;
  interactionQuality?: InteractionQuality | null;
  histogramMode?: HistogramMode;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  skipProcessing?: boolean;
}

export interface RenderResult {
  documentId: string;
  revision: number;
  width: number;
  height: number;
  previewLevelId: string;
  imageData: ImageData;
  histogram: HistogramData;
}

export interface ExportRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  options: ExportOptions;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  skipProcessing?: boolean;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

export interface RawExportResult {
  imageData: ImageData;
  width: number;
  height: number;
  filename: string;
  format: ExportFormat;
  quality: number;
}

export interface PrepareTileJobRequest {
  documentId: string;
  jobId: string;
  sourceKind: TileSourceKind;
  settings: ConversionSettings;
  comparisonMode: 'processed' | 'original';
  targetMaxDimension?: number;
}

export interface PreparedTileJobResult {
  documentId: string;
  jobId: string;
  sourceKind: TileSourceKind;
  width: number;
  height: number;
  previewLevelId: string | null;
  tileSize: number;
  halo: number;
  geometryCacheHit: boolean;
}

export interface ReadTileRequest {
  documentId: string;
  jobId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReadTileResult {
  documentId: string;
  jobId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  haloLeft: number;
  haloTop: number;
  haloRight: number;
  haloBottom: number;
  imageData: ImageData;
}

export interface CancelTileJobRequest {
  documentId: string;
  jobId: string;
}

export interface RenderJobDiagnosticsSnapshot {
  backendMode: RenderBackendMode;
  sourceKind: TileSourceKind;
  previewMode: PreviewMode | null;
  previewLevelId: string | null;
  interactionQuality: InteractionQuality | null;
  histogramMode: HistogramMode | null;
  tileSize: number | null;
  halo: number | null;
  tileCount: number | null;
  intermediateFormat: 'rgba16float' | null;
  usedCpuFallback: boolean;
  fallbackReason: string | null;
  jobDurationMs: number | null;
  geometryCacheHit: boolean | null;
}

export interface RenderBackendDiagnostics {
  gpuAvailable: boolean;
  gpuEnabled: boolean;
  gpuActive: boolean;
  gpuAdapterName: string | null;
  backendMode: RenderBackendMode;
  sourceKind: TileSourceKind | null;
  previewMode: PreviewMode | null;
  previewLevelId: string | null;
  interactionQuality: InteractionQuality | null;
  histogramMode: HistogramMode | null;
  tileSize: number | null;
  halo: number | null;
  tileCount: number | null;
  intermediateFormat: 'rgba16float' | null;
  usedCpuFallback: boolean;
  fallbackReason: string | null;
  jobDurationMs: number | null;
  geometryCacheHit: boolean | null;
  coalescedPreviewRequests: number;
  cancelledPreviewJobs: number;
  previewBackend: RenderBackendMode | null;
  lastPreviewJob: RenderJobDiagnosticsSnapshot | null;
  lastExportJob: RenderJobDiagnosticsSnapshot | null;
  maxStorageBufferBindingSize: number | null;
  maxBufferSize: number | null;
  gpuDisabledReason: 'user' | 'unsupported' | 'initialization-failed' | 'device-lost' | null;
  lastError: string | null;
}

export interface SampleRequest {
  documentId: string;
  settings: ConversionSettings;
  targetMaxDimension: number;
  x: number;
  y: number;
}

export interface DiagnosticsEntry {
  id: string;
  level: 'info' | 'error';
  code: string;
  message: string;
  timestamp: string;
  context?: Record<string, string | number | boolean | null>;
}

export interface VersionedPresetStore {
  version: 1;
  presets: FilmProfile[];
}
