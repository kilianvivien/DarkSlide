import { ExportBitDepth, ExportFormat, ExportOptions, QuickExportPreset } from '../types';

export function getDefaultBitDepthForFormat(_format: ExportFormat): ExportBitDepth {
  // 16-bit output requires a high-depth render buffer that no export path
  // produces yet, so an unspecified bit depth normalizes to 8-bit — the depth
  // that actually round-trips. Callers can still explicitly request 16-bit for
  // PNG/TIFF; that path degrades gracefully with a warning until a float export
  // pipeline exists.
  return 8;
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
