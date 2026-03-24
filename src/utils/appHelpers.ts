import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, SUPPORTED_EXTENSIONS } from '../constants';
import {
  ColorManagementSettings,
  ColorMatrix,
  ColorProfileId,
  ConversionSettings,
  FilmProfile,
  HistogramMode,
  InteractionQuality,
  MaskTuning,
  SourceMetadata,
  TonalCharacter,
} from '../types';
import { getFileExtension } from './imagePipeline';
import { supportsDisplayP3Canvas } from './colorProfiles';
import { isRawExtension } from './rawImport';

export function resolveAutoInputProfileId(source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>): ColorProfileId {
  return source.decoderColorProfileId ?? source.embeddedColorProfileId ?? 'srgb';
}

export function getResolvedInputProfileId(
  source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>,
  colorManagement: Pick<ColorManagementSettings, 'inputMode' | 'inputProfileId'>,
) {
  return colorManagement.inputMode === 'override'
    ? colorManagement.inputProfileId
    : resolveAutoInputProfileId(source);
}

export function createDocumentColorManagement(
  source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>,
  exportOptions = DEFAULT_EXPORT_OPTIONS,
): ColorManagementSettings {
  return {
    ...DEFAULT_COLOR_MANAGEMENT,
    inputProfileId: resolveAutoInputProfileId(source),
    outputProfileId: exportOptions.outputProfileId,
    embedOutputProfile: exportOptions.embedOutputProfile,
  };
}

export function formatError(error: unknown, options?: { preservePrefix?: boolean }) {
  const message = error instanceof Error ? error.message : String(error);
  if (options?.preservePrefix) {
    return message || 'Unknown error.';
  }
  const readable = message.includes(': ') ? message.split(': ').slice(1).join(': ') : message;
  return readable || 'Unknown error.';
}

export function getOpenInEditorErrorContext(error: unknown): Record<string, string | null> | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const details = error as {
    savedPath?: unknown;
    destinationDirectory?: unknown;
    editorPath?: unknown;
  };

  const savedPath = typeof details.savedPath === 'string' ? details.savedPath : null;
  const destinationDirectory = typeof details.destinationDirectory === 'string' ? details.destinationDirectory : null;
  const editorPath = typeof details.editorPath === 'string' ? details.editorPath : null;

  if (!savedPath && !destinationDirectory && !editorPath) {
    return null;
  }

  return {
    savedPath,
    destinationDirectory,
    editorPath,
  };
}

export function getErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':')[0]?.trim();
  return code || null;
}

export function isIgnorableRenderError(error: unknown) {
  if (error instanceof Error) {
    return error.message.startsWith('JOB_CANCELLED')
      || error.message.startsWith('JOB_MISSING')
      || error.message.includes('The tile job was cancelled.')
      || error.message.includes('The requested tile job is no longer available.')
      || error.message.includes('The image document is no longer available.');
  }

  if (typeof error === 'string') {
    return error.startsWith('JOB_CANCELLED')
      || error.startsWith('JOB_MISSING')
      || error.includes('The tile job was cancelled.')
      || error.includes('The requested tile job is no longer available.')
      || error.includes('The image document is no longer available.');
  }

  return false;
}

export function isSupportedFile(file: File) {
  const extension = getFileExtension(file.name);
  return SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number]);
}

export function isRawFile(file: File) {
  return isRawExtension(getFileExtension(file.name));
}

export function getPresetTags(
  settings: ConversionSettings,
  profileType: FilmProfile['type'],
  extension: string,
) {
  return [
    settings.blackAndWhite.enabled || profileType === 'bw' ? 'bw' : 'color',
    isRawExtension(extension) ? 'raw' : 'non-raw',
  ];
}

export function normalizePreviewImageData(imageData: ImageData, width: number, height: number) {
  if (imageData.width === width && imageData.height === height) {
    return imageData;
  }

  return new ImageData(new Uint8ClampedArray(imageData.data), width, height);
}

export function getCanvas2dContext(canvas: HTMLCanvasElement) {
  if (supportsDisplayP3Canvas()) {
    return canvas.getContext('2d', {
      willReadFrequently: true,
      colorSpace: 'display-p3',
    } as CanvasRenderingContext2DSettings) ?? canvas.getContext('2d');
  }

  return canvas.getContext('2d', { willReadFrequently: true }) ?? canvas.getContext('2d');
}

export function getNativePathFromFile(file: File): string | null {
  const candidate = (file as File & { path?: string }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export function waitForNextPaint() {
  if (typeof window === 'undefined' || (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

export type QueuedPreviewRender = {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  filmType?: 'negative' | 'slide';
  comparisonMode: 'processed' | 'original';
  targetMaxDimension: number;
  previewMode: 'draft' | 'settled';
  interactionQuality: InteractionQuality | null;
  histogramMode: HistogramMode;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
  labStyleToneCurve?: FilmProfile['toneCurve'];
  labStyleChannelCurves?: { r?: FilmProfile['toneCurve']; g?: FilmProfile['toneCurve']; b?: FilmProfile['toneCurve'] };
  labTonalCharacterOverride?: Partial<TonalCharacter>;
  labSaturationBias?: number;
  labTemperatureBias?: number;
  highlightDensityEstimate?: number;
  flareFloor?: [number, number, number] | null;
  lightSourceBias?: [number, number, number];
};

export type BlockingOverlayState = {
  title: string;
  detail: string;
};

export type TransientNoticeState = {
  message: string;
  tone?: 'warning' | 'success';
};

export function formatMemoryBadge(bytes: number | null) {
  if (bytes === null) {
    return 'Worker memory unavailable';
  }

  const gib = bytes / (1024 ** 3);
  if (gib >= 1) {
    return `${gib.toFixed(2)} GiB worker memory`;
  }

  const mib = bytes / (1024 ** 2);
  return `${mib.toFixed(0)} MiB worker memory`;
}

export function getMemoryBadgeTone(bytes: number | null) {
  if (bytes === null || bytes < 512 * 1024 * 1024) {
    return 'emerald';
  }
  if (bytes < 1024 * 1024 * 1024) {
    return 'amber';
  }
  return 'red';
}
