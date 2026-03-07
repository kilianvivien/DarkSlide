import { VersionedPresetStore, FilmProfile } from '../types';

const STORAGE_KEY = 'darkslide_custom_presets_v1';

function isValidPresetStore(value: unknown): value is VersionedPresetStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<VersionedPresetStore>;
  return store.version === 1 && Array.isArray(store.presets);
}

export function loadPresetStore(): FilmProfile[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!isValidPresetStore(parsed)) return [];
    return parsed.presets.filter((preset) => Boolean(preset?.id && preset?.name && preset?.defaultSettings));
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
