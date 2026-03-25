import { BUILTIN_QUICK_EXPORT_PRESETS } from '../constants';
import { ExportOptions, QuickExportPreset } from '../types';

const STORAGE_KEY = 'darkslide_quick_export_presets_v1';
const MAX_CUSTOM_PRESETS = 12;

type StoredQuickExportPresets = {
  version: 1;
  presets: QuickExportPreset[];
};

function isValidPreset(value: unknown): value is QuickExportPreset {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const preset = value as Partial<QuickExportPreset>;
  return typeof preset.id === 'string'
    && typeof preset.name === 'string'
    && typeof preset.format === 'string'
    && typeof preset.quality === 'number'
    && typeof preset.outputProfileId === 'string'
    && typeof preset.embedMetadata === 'boolean'
    && typeof preset.embedOutputProfile === 'boolean'
    && (preset.maxDimension === null || typeof preset.maxDimension === 'number')
    && typeof preset.suffix === 'string'
    && typeof preset.cropToSquare === 'boolean'
    && typeof preset.saveSidecar === 'boolean'
    && typeof preset.isBuiltIn === 'boolean';
}

function isStoredPresets(value: unknown): value is StoredQuickExportPresets {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<StoredQuickExportPresets>;
  return payload.version === 1
    && Array.isArray(payload.presets)
    && payload.presets.every(isValidPreset);
}

export function mergeQuickExportPresets(customPresets: QuickExportPreset[] = []) {
  const merged = new Map<string, QuickExportPreset>();

  BUILTIN_QUICK_EXPORT_PRESETS.forEach((preset) => {
    merged.set(preset.id, { ...preset });
  });

  customPresets.forEach((preset) => {
    merged.set(preset.id, { ...preset, isBuiltIn: false });
  });

  return Array.from(merged.values());
}

export function loadQuickExportPresets() {
  if (typeof window === 'undefined') {
    return mergeQuickExportPresets();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return mergeQuickExportPresets();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isStoredPresets(parsed)) {
      return mergeQuickExportPresets();
    }
    return mergeQuickExportPresets(parsed.presets.slice(0, MAX_CUSTOM_PRESETS));
  } catch {
    return mergeQuickExportPresets();
  }
}

export function saveQuickExportPresets(presets: QuickExportPreset[]) {
  if (typeof window === 'undefined') {
    return;
  }

  const customPresets = presets
    .filter((preset) => !preset.isBuiltIn)
    .slice(0, MAX_CUSTOM_PRESETS)
    .map((preset) => ({ ...preset, isBuiltIn: false }));

  const payload: StoredQuickExportPresets = {
    version: 1,
    presets: customPresets,
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function createFromCurrentSettings(
  name: string,
  currentExportOptions: ExportOptions,
): QuickExportPreset {
  const normalizedName = name.trim() || 'Custom Export';
  return {
    id: `quick-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now()}`,
    name: normalizedName,
    format: currentExportOptions.format,
    quality: currentExportOptions.quality,
    outputProfileId: currentExportOptions.outputProfileId,
    embedMetadata: currentExportOptions.embedMetadata,
    embedOutputProfile: currentExportOptions.embedOutputProfile,
    maxDimension: currentExportOptions.targetMaxDimension,
    suffix: '',
    cropToSquare: false,
    saveSidecar: currentExportOptions.saveSidecar,
    isBuiltIn: false,
  };
}

export const QUICK_EXPORT_PRESET_LIMIT = MAX_CUSTOM_PRESETS;
