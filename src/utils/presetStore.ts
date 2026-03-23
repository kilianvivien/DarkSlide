import { DarkslidePresetFile, FilmProfile, VersionedPresetStore } from '../types';

const STORAGE_KEY = 'darkslide_custom_presets_v1';

function isValidPresetStore(value: unknown): value is VersionedPresetStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<VersionedPresetStore>;
  return store.version === 1 && Array.isArray(store.presets);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isValidScannerType(value: unknown) {
  return value == null || value === 'flatbed' || value === 'camera' || value === 'dedicated' || value === 'smartphone';
}

function isValidProfile(value: unknown): value is FilmProfile {
  if (!isRecord(value)) return false;
  const defaultSettings = value.defaultSettings;
  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && (value.type === 'color' || value.type === 'bw')
    && isValidScannerType(value.scannerType)
    && (value.lightSourceId === undefined || value.lightSourceId === null || typeof value.lightSourceId === 'string')
    && isRecord(defaultSettings)
    && typeof defaultSettings.exposure === 'number'
    && typeof defaultSettings.contrast === 'number'
  );
}

export function validateDarkslideFile(raw: unknown): DarkslidePresetFile | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.darkslideVersion !== 'string' || !isValidProfile(raw.profile)) {
    return null;
  }

  return raw as unknown as DarkslidePresetFile;
}

export function loadPresetStore(): FilmProfile[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!isValidPresetStore(parsed)) return [];
    return parsed.presets.filter(isValidProfile);
  } catch {
    return [];
  }
}

export function savePresetStore(presets: FilmProfile[]) {
  const payload: VersionedPresetStore = {
    version: 1,
    presets,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
