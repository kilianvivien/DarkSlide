import type { FlatFieldProfile } from './flatField';

// The flat-field reference belongs to the capture setup (camera, lens, light
// source), not to a document, so it lives in its own store. RAW decoding reads
// it directly, which keeps import, batch export and contact sheets in step.
const STORAGE_KEY = 'darkslide_flat_field_v1';

export interface FlatFieldState {
  enabled: boolean;
  profile: FlatFieldProfile | null;
}

type StoredFlatField = FlatFieldState & { version: 1 };

const EMPTY_STATE: FlatFieldState = { enabled: false, profile: null };

let state: FlatFieldState | null = null;
const listeners = new Set<() => void>();

// The worker bundle imports this module through rawImport and has no window.
function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isValidProfile(value: unknown): value is FlatFieldProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<FlatFieldProfile>;
  return profile.version === 1
    && typeof profile.name === 'string'
    && Number.isInteger(profile.width) && profile.width! > 0
    && Number.isInteger(profile.height) && profile.height! > 0
    && Number.isInteger(profile.gridWidth) && profile.gridWidth! > 1
    && Number.isInteger(profile.gridHeight) && profile.gridHeight! > 1
    && Array.isArray(profile.gains)
    && profile.gains.length === profile.gridWidth! * profile.gridHeight! * 3
    && profile.gains.every((gain) => typeof gain === 'number' && Number.isFinite(gain) && gain > 0)
    && typeof profile.maxCorrectionStops === 'number'
    && typeof profile.createdAt === 'number';
}

function load(): FlatFieldState {
  const storage = getStorage();
  if (!storage) return EMPTY_STATE;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<StoredFlatField>;
    if (parsed.version !== 1 || !isValidProfile(parsed.profile)) return EMPTY_STATE;
    return { enabled: parsed.enabled === true, profile: parsed.profile };
  } catch {
    return EMPTY_STATE;
  }
}

function save(next: FlatFieldState) {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (!next.profile) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...next } satisfies StoredFlatField));
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}

export function getFlatFieldState(): FlatFieldState {
  if (!state) state = load();
  return state;
}

function update(next: FlatFieldState) {
  state = next;
  save(next);
  listeners.forEach((listener) => listener());
}

export function setFlatFieldProfile(profile: FlatFieldProfile) {
  update({ enabled: true, profile });
}

export function setFlatFieldEnabled(enabled: boolean) {
  const current = getFlatFieldState();
  if (!current.profile) return;
  update({ ...current, enabled });
}

export function clearFlatField() {
  update(EMPTY_STATE);
}

// The profile to apply to new RAW decodes, or null when correction is off.
export function getActiveFlatFieldProfile(): FlatFieldProfile | null {
  const current = getFlatFieldState();
  return current.enabled ? current.profile : null;
}

export function subscribeFlatField(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetFlatFieldStoreForTests() {
  state = null;
  listeners.clear();
}
