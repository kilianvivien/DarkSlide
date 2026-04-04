export type FilmType = 'color' | 'bw';
export type CropTab = 'Film' | 'Print' | 'Social' | 'Digital';
export type ScannerType = 'flatbed' | 'camera' | 'dedicated' | 'smartphone';
export type ColorProfileId = 'srgb' | 'display-p3' | 'adobe-rgb';
export type FilmProfileType = 'negative' | 'slide';
export type FilmProfileCategory = 'Kodak' | 'Fuji' | 'Ilford' | 'CineStill' | 'Lomography' | 'Foma' | 'Rollei' | 'Generic';
export type CropSource = 'auto' | 'manual';
export type UpdateChannel = 'stable' | 'beta';
export type ZoomLevel = number | 'fit';
export type InversionMethod = 'standard' | 'advanced-hd';

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

export interface DetectedFrame {
  top: number;
  left: number;
  bottom: number;
  right: number;
  angle: number;
  confidence: number;
}

export interface ExifMetadata {
  orientation?: number;
  dateTimeOriginal?: string;
  make?: string;
  model?: string;
  software?: string;
  iccProfileName?: string;
}

export type ExportFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/tiff';
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

export type PointPickerMode = 'black' | 'white' | 'grey';

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

export interface AdvancedInversionProfile {
  gamma: [number, number, number];
  baseDensityFallback: [number, number, number];
}

export interface LabStyleProfile {
  id: string;
  name: string;
  description: string;
  toneCurve: CurvePoint[];
  channelCurves?: {
    r?: CurvePoint[];
    g?: CurvePoint[];
    b?: CurvePoint[];
  };
  tonalCharacterOverride?: Partial<TonalCharacter>;
  saturationBias: number;
  temperatureBias: number;
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

export interface BlackAndWhiteSettings {
  enabled: boolean;
  redMix: number; // -100 - 100
  greenMix: number; // -100 - 100
  blueMix: number; // -100 - 100
  tone: number; // -100 - 100
}

export interface LightSourceProfile {
  id: string;
  name: string;
  colorTemperature: number;
  spectralBias: [number, number, number];
  flareCharacteristic: 'low' | 'medium' | 'high';
}

export interface ConversionSettings {
  inversionMethod: InversionMethod;
  exposure: number;
  contrast: number;
  saturation: number;
  shadowRecovery?: number;
  midtoneContrast?: number;
  flareCorrection?: number;
  flatFieldEnabled?: boolean;
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
  blackAndWhite: BlackAndWhiteSettings;
  sharpen: SharpenSettings;
  noiseReduction: NoiseReductionSettings;
}

export interface ColorManagementSettings {
  inputMode: 'auto' | 'override';
  inputProfileId: ColorProfileId;
  outputProfileId: ColorProfileId;
  embedOutputProfile: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  exportComplete: boolean;
  batchComplete: boolean;
  contactSheetComplete: boolean;
}

export interface ExportOptions {
  format: ExportFormat;
  quality: number;
  filenameBase: string;
  embedMetadata: boolean;
  outputProfileId: ColorProfileId;
  embedOutputProfile: boolean;
  saveSidecar: boolean;
  targetMaxDimension: number | null;
}

export interface QuickExportPreset {
  id: string;
  name: string;
  format: ExportFormat;
  quality: number;
  outputProfileId: ColorProfileId;
  embedMetadata: boolean;
  embedOutputProfile: boolean;
  maxDimension: number | null;
  suffix: string;
  cropToSquare: boolean;
  saveSidecar: boolean;
  isBuiltIn: boolean;
}

export interface Roll {
  id: string;
  name: string;
  filmStock: string | null;
  profileId: string | null;
  camera: string | null;
  date: string | null;
  notes: string;
  filmBaseSample: FilmBaseSample | null;
  createdAt: number;
  directory: string | null;
}

export interface SidecarFile {
  version: 1;
  generator: string;
  createdAt: string;
  sourceFile: {
    name: string;
    size: number;
    dimensions: { width: number; height: number };
    hash?: string;
  };
  settings: ConversionSettings;
  profileId: string;
  profileName: string;
  isColor: boolean;
  colorManagement: ColorManagementSettings;
  exportOptions: ExportOptions;
  roll?: {
    name: string;
    filmStock: string | null;
    camera: string | null;
    date: string | null;
    notes: string;
  };
  flatFieldProfileId?: string;
  lightSourceProfileId?: string;
  labStyleId?: string;
}

export interface FilmProfile {
  id: string;
  version: number;
  name: string;
  type: FilmType;
  filmType?: FilmProfileType;
  category?: FilmProfileCategory;
  description: string;
  defaultSettings: ConversionSettings;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  advancedInversion?: AdvancedInversionProfile;
  toneCurve?: CurvePoint[];
  isCustom?: boolean;
  tags?: string[];
  filmStock?: string | null;
  scannerType?: ScannerType | null;
  lightSourceId?: string | null;
  folderId?: string | null;
  labStyleId?: string | null;
}

export interface DarkslidePresetFile {
  darkslideVersion: string;
  profile: FilmProfile;
}

export interface DarkslidePresetBackupFile {
  darkslideVersion: string;
  kind: 'preset-backup';
  version: 1;
  exportedAt: string;
  presets: FilmProfile[];
  folders: PresetFolder[];
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
  exif?: ExifMetadata;
  embeddedColorProfileName?: string | null;
  embeddedColorProfileId?: ColorProfileId | null;
  decoderColorProfileName?: string | null;
  decoderColorProfileId?: ColorProfileId | null;
  unsupportedColorProfileName?: string | null;
  nativePath?: string | null;
}

export interface DecodedImage {
  metadata: SourceMetadata;
  previewLevels: PreviewLevel[];
  estimatedFlare?: [number, number, number] | null;
  estimatedFilmBaseSample?: FilmBaseSample | null;
}

export interface RawDecodeResult {
  width: number;
  height: number;
  data: ArrayLike<number>;
  color_space: string;
  white_balance?: [number, number, number] | null;
  orientation?: number | null;
}

export interface WorkspaceDocument {
  id: string;
  source: SourceMetadata;
  previewLevels: PreviewLevel[];
  settings: ConversionSettings;
  colorManagement: ColorManagementSettings;
  estimatedFlare?: [number, number, number] | null;
  estimatedFilmBaseSample?: FilmBaseSample | null;
  lightSourceId?: string | null;
  cropSource?: CropSource | null;
  rawImportProfile?: FilmProfile | null;
  profileId: string;
  labStyleId: string | null;
  rollId: string | null;
  exportOptions: ExportOptions;
  histogram: HistogramData | null;
  renderRevision: number;
  status: 'idle' | 'loading' | 'ready' | 'processing' | 'exporting' | 'error';
  dirty: boolean;
  errorCode?: string;
}

export interface DocumentHistoryEntry {
  settings: ConversionSettings;
  labStyleId: string | null;
}

export interface DocumentTab {
  id: string;
  document: WorkspaceDocument;
  rollId: string | null;
  historyStack: DocumentHistoryEntry[];
  historyIndex: number;
  zoom: ZoomLevel;
  pan: { x: number; y: number };
  sidebarScrollTop: number;
}

export interface DecodeRequest {
  documentId: string;
  buffer: ArrayBuffer;
  fileName: string;
  mime: string;
  size: number;
  displayScaleFactor?: number;
  rawDimensions?: { width: number; height: number };
  declaredColorProfileName?: string | null;
  declaredColorProfileId?: ColorProfileId | null;
}

export interface RenderRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  filmType?: FilmProfileType;
  advancedInversion?: AdvancedInversionProfile | null;
  estimatedFilmBaseSample?: FilmBaseSample | null;
  inputProfileId?: ColorProfileId;
  outputProfileId?: ColorProfileId;
  revision: number;
  targetMaxDimension: number;
  comparisonMode: 'processed' | 'original';
  previewMode?: PreviewMode;
  interactionQuality?: InteractionQuality | null;
  histogramMode?: HistogramMode;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  labStyleToneCurve?: CurvePoint[];
  labStyleChannelCurves?: { r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };
  labTonalCharacterOverride?: Partial<TonalCharacter>;
  labSaturationBias?: number;
  labTemperatureBias?: number;
  highlightDensityEstimate?: number;
  flareFloor?: [number, number, number] | null;
  lightSourceBias?: [number, number, number];
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
  highlightDensity: number;
}

export interface PreparePreviewBitmapRequest {
  documentId: string;
  revision: number;
  imageData: ImageData;
}

export interface PreparedPreviewBitmapResult {
  documentId: string;
  revision: number;
  imageBitmap: ImageBitmap;
}

export interface ExportRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  filmType?: FilmProfileType;
  advancedInversion?: AdvancedInversionProfile | null;
  inputProfileId?: ColorProfileId;
  outputProfileId?: ColorProfileId;
  options: ExportOptions;
  sourceExif?: ExifMetadata;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  labStyleToneCurve?: CurvePoint[];
  labStyleChannelCurves?: { r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };
  labTonalCharacterOverride?: Partial<TonalCharacter>;
  labSaturationBias?: number;
  labTemperatureBias?: number;
  highlightDensityEstimate?: number;
  flareFloor?: [number, number, number] | null;
  lightSourceBias?: [number, number, number];
  skipProcessing?: boolean;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

export interface ContactSheetCell {
  documentId: string;
  label: string;
}

export interface ContactSheetRequest {
  cells: ContactSheetCell[];
  columns: number;
  cellMaxDimension: number;
  margin: number;
  backgroundColor: [number, number, number];
  showCaptions: boolean;
  captionFontSize: number;
  exportOptions: ExportOptions;
  settingsPerCell: ConversionSettings[];
  profilePerCell: FilmProfile[];
  colorManagementPerCell: ColorManagementSettings[];
  estimatedFilmBaseSamplePerCell?: Array<FilmBaseSample | null>;
  flareFloorPerCell?: Array<[number, number, number] | null>;
  lightSourceBiasPerCell?: Array<[number, number, number]>;
}

export interface ContactSheetResult {
  blob: Blob;
  width: number;
  height: number;
  filename: string;
}

export type BatchProgressEvent =
  | { type: 'start'; entryId: string }
  | { type: 'progress'; entryId: string; progress: number }
  | { type: 'done'; entryId: string }
  | { type: 'error'; entryId: string; message: string }
  | { type: 'complete' };

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
  flatFieldHandledInWorker?: boolean;
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
  phaseTimings: RenderPhaseTimings | null;
}

export interface RenderPhaseTimings {
  geometryPrepareMs: number | null;
  gpuProcessReadbackMs: number | null;
  histogramBuildMs: number | null;
  previewDisplayColorConversionMs: number | null;
  workerBitmapPrepMs: number | null;
  createImageBitmapMs: number | null;
  canvasDrawMs: number | null;
  endToEndDurationMs: number | null;
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
  phaseTimings: RenderPhaseTimings | null;
  coalescedPreviewRequests: number;
  cancelledPreviewJobs: number;
  previewBackend: RenderBackendMode | null;
  lastPreviewJob: RenderJobDiagnosticsSnapshot | null;
  lastExportJob: RenderJobDiagnosticsSnapshot | null;
  maxStorageBufferBindingSize: number | null;
  maxBufferSize: number | null;
  gpuDisabledReason: 'user' | 'unsupported' | 'initialization-failed' | 'device-lost' | null;
  lastError: string | null;
  workerMemory: WorkerMemoryDiagnostics | null;
  activeBlobUrlCount: number | null;
  oldestActiveBlobUrlAgeMs: number | null;
}

export interface AutoAnalyzeRequest {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  filmType?: FilmProfileType;
  advancedInversion?: AdvancedInversionProfile | null;
  inputProfileId?: ColorProfileId;
  outputProfileId?: ColorProfileId;
  targetMaxDimension: number;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  labStyleToneCurve?: CurvePoint[];
  labStyleChannelCurves?: { r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };
  labTonalCharacterOverride?: Partial<TonalCharacter>;
  labSaturationBias?: number;
  labTemperatureBias?: number;
  highlightDensityEstimate?: number;
  flareFloor?: [number, number, number] | null;
  lightSourceBias?: [number, number, number];
}

export interface AutoAnalyzeResult {
  exposure: number;
  blackPoint: number;
  whitePoint: number;
  temperature: number | null;
  tint: number | null;
}

export interface SampleRequest {
  documentId: string;
  settings: ConversionSettings;
  inputProfileId?: ColorProfileId;
  outputProfileId?: ColorProfileId;
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

export interface WorkerMemoryDiagnostics {
  documentCount: number;
  totalPreviewCanvases: number;
  tileJobCount: number;
  cancelledJobCount: number;
  estimatedMemoryBytes: number;
}

export interface PresetFolder {
  id: string;
  name: string;
}

export interface VersionedPresetStore {
  version: 1;
  presets: FilmProfile[];
  folders?: PresetFolder[];
}
