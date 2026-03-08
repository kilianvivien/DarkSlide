export type FilmType = 'color' | 'bw';

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
}

export interface RenderRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  revision: number;
  targetMaxDimension: number;
  comparisonMode: 'processed' | 'original';
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

export interface RenderBackendDiagnostics {
  gpuAvailable: boolean;
  gpuEnabled: boolean;
  gpuActive: boolean;
  gpuAdapterName: string | null;
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
