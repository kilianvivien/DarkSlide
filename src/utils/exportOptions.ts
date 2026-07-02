import { ExportBitDepth, ExportFormat, ExportOptions, QuickExportPreset } from '../types';

export function getDefaultBitDepthForFormat(format: ExportFormat): ExportBitDepth {
  return format === 'image/png' || format === 'image/tiff' ? 16 : 8;
}

export function supportsExportBitDepth(format: ExportFormat, bitDepth: ExportBitDepth) {
  return bitDepth === 8 || format === 'image/png' || format === 'image/tiff';
}

export function normalizeExportBitDepth(format: ExportFormat, bitDepth?: ExportBitDepth | null): ExportBitDepth {
  const resolved = bitDepth ?? getDefaultBitDepthForFormat(format);
  return supportsExportBitDepth(format, resolved) ? resolved : 8;
}

export function normalizeExportOptions<T extends Partial<ExportOptions> & Pick<ExportOptions, 'format'>>(options: T): T & { bitDepth: ExportBitDepth } {
  return {
    ...options,
    bitDepth: normalizeExportBitDepth(options.format, options.bitDepth),
  };
}

export function normalizeQuickExportPreset<T extends Partial<QuickExportPreset> & Pick<QuickExportPreset, 'format'>>(preset: T): T & { bitDepth: ExportBitDepth } {
  return {
    ...preset,
    bitDepth: normalizeExportBitDepth(preset.format, preset.bitDepth),
  };
}
