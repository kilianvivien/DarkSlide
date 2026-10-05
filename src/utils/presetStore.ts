import { DARKSLIDE_PRESET_FILE_VERSION } from '../constants';
import { DarkslidePresetBackupFile, DarkslidePresetFile, FilmProfile, PresetFolder, VersionedPresetStore } from '../types';
import { deserializeCubeLutFromJson, isValidCubeLut, serializeCubeLutForJson } from './cubeLut';

const STORAGE_KEY = 'darkslide_custom_presets_v1';
const IDB_NAME = 'darkslide';
const IDB_VERSION = 1;
const IDB_STORE = 'presets';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

function isValidPresetFolder(value: unknown): value is PresetFolder {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.name === 'string';
}

function isValidProfile(value: unknown): value is FilmProfile {
  if (!isRecord(value)) return false;
  const defaultSettings = value.defaultSettings;
  const densityBalance = isRecord(defaultSettings) ? defaultSettings.densityBalance : null;
  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && (value.type === 'color' || value.type === 'bw')
    && isValidScannerType(value.scannerType)
    && (value.lightSourceId === undefined || value.lightSourceId === null || typeof value.lightSourceId === 'string')
    && (value.lut == null || isValidCubeLut(value.lut))
    && isRecord(defaultSettings)
    && typeof defaultSettings.exposure === 'number'
    && typeof defaultSettings.contrast === 'number'
    && (defaultSettings.filmBaseSampleProfileId === undefined
      || ['srgb', 'display-p3', 'adobe-rgb', 'linear'].includes(String(defaultSettings.filmBaseSampleProfileId)))
    && (densityBalance == null || (
      isRecord(densityBalance)
      && ['scaleR', 'scaleG', 'scaleB'].every((key) => (
        typeof densityBalance[key] === 'number'
        && Number.isFinite(densityBalance[key])
        && densityBalance[key] > 0
      ))
      && ['auto-histogram', 'camera-measured', 'film-stock-preset', 'manual', 'clamp-rejected'].includes(String(densityBalance.source))
    ))
  );
}

/**
 * Replaces a profile's live `lut` (a Float32Array) with its JSON-safe encoding
 * so it can travel inside a .darkslide file.
 */
export function encodeProfileForTransport(profile: FilmProfile): Record<string, unknown> {
  const { lut, ...rest } = profile;
  const encoded: Record<string, unknown> = { ...structuredClone(rest) };

  if (lut) {
    encoded.lut = serializeCubeLutForJson(lut);
  }

  return encoded;
}

/**
 * Inverse of `encodeProfileForTransport`. A LUT that fails to decode is dropped
 * rather than left in a half-valid state — `isValidProfile` would reject the
 * whole preset otherwise, losing the settings along with it.
 */
export function decodeProfileFromTransport(raw: unknown): unknown {
  if (!isRecord(raw) || raw.lut == null) {
    return raw;
  }

  // Already a live LUT (same-session structured clone rather than JSON).
  if (isValidCubeLut(raw.lut)) {
    return raw;
  }

  const decoded = deserializeCubeLutFromJson(raw.lut);
  if (!decoded) {
    const { lut: _dropped, ...rest } = raw;
    return rest;
  }

  return { ...raw, lut: decoded };
}

/**
 * Drops LUT payloads before a profile is mirrored into localStorage. A single
 * 35³ table is ~500 KB of Float32 and would exhaust the 5 MB quota; IndexedDB
 * stores the array natively and stays the source of truth for LUT presets.
 */
function stripLutForLocalStorage(presets: FilmProfile[]): FilmProfile[] {
  return presets.map((preset) => {
    if (!preset.lut) {
      return preset;
    }

    const { lut: _lut, ...rest } = preset;
    return rest;
  });
}

export function validateDarkslideFile(raw: unknown): DarkslidePresetFile | null {
  if (!isRecord(raw)) {
    return null;
  }

  const profile = decodeProfileFromTransport(raw.profile);
  if (typeof raw.darkslideVersion !== 'string' || !isValidProfile(profile)) {
    return null;
  }

  return { ...raw, profile } as unknown as DarkslidePresetFile;
}

export function createPresetBackupFile(
  presets: FilmProfile[],
  folders: PresetFolder[],
  exportedAt = new Date().toISOString(),
): DarkslidePresetBackupFile {
  return {
    darkslideVersion: DARKSLIDE_PRESET_FILE_VERSION,
    kind: 'preset-backup',
    version: 1,
    exportedAt,
    presets: presets.map(encodeProfileForTransport) as unknown as FilmProfile[],
    folders: structuredClone(folders),
  };
}

export function validatePresetBackupFile(raw: unknown): DarkslidePresetBackupFile | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (
    typeof raw.darkslideVersion !== 'string'
    || raw.kind !== 'preset-backup'
    || raw.version !== 1
    || typeof raw.exportedAt !== 'string'
    || !Array.isArray(raw.presets)
    || !Array.isArray(raw.folders)
  ) {
    return null;
  }

  const presets = raw.presets.map(decodeProfileFromTransport);
  if (!presets.every(isValidProfile) || !raw.folders.every(isValidPresetFolder)) {
    return null;
  }

  const folderIds = new Set(raw.folders.map((folder) => folder.id));
  const allPresetFoldersExist = presets.every((preset) => preset.folderId == null || folderIds.has(preset.folderId));
  if (!allPresetFoldersExist) {
    return null;
  }

  return { ...raw, presets } as unknown as DarkslidePresetBackupFile;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Synchronous localStorage fallback (used for initial load)
// ---------------------------------------------------------------------------

function loadFromLocalStorage(): VersionedPresetStore | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isValidPresetStore(parsed)) return null;
    return parsed as VersionedPresetStore;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronous initial load from localStorage (for first render),
 * then async migration/load from IndexedDB.
 */
export function loadPresetStore(): FilmProfile[] {
  const store = loadFromLocalStorage();
  return store ? store.presets.filter(isValidProfile) : [];
}

export function loadPresetFolders(): PresetFolder[] {
  const store = loadFromLocalStorage();
  return store?.folders ?? [];
}

/**
 * Async load from IndexedDB — returns the full store.
 * Falls back to localStorage if IDB is unavailable.
 * Automatically migrates localStorage data to IDB on first call.
 */
export async function loadPresetStoreAsync(): Promise<{ presets: FilmProfile[]; folders: PresetFolder[] }> {
  try {
    const stored = await idbGet<VersionedPresetStore>(STORAGE_KEY);
    if (stored && isValidPresetStore(stored)) {
      return {
        presets: stored.presets.filter(isValidProfile),
        folders: stored.folders ?? [],
      };
    }

    // Migrate from localStorage if IDB is empty
    const lsStore = loadFromLocalStorage();
    if (lsStore) {
      await idbPut(STORAGE_KEY, lsStore);
      return {
        presets: lsStore.presets.filter(isValidProfile),
        folders: lsStore.folders ?? [],
      };
    }

    return { presets: [], folders: [] };
  } catch {
    // IDB unavailable — fall back to localStorage
    const store = loadFromLocalStorage();
    return {
      presets: store ? store.presets.filter(isValidProfile) : [],
      folders: store?.folders ?? [],
    };
  }
}

/**
 * Save to both IndexedDB (primary) and localStorage (fallback).
 */
export function savePresetStore(presets: FilmProfile[], folders?: PresetFolder[]) {
  const payload: VersionedPresetStore = {
    version: 1,
    presets,
    folders,
  };

  // Write to localStorage synchronously for immediate availability, minus any
  // LUT payloads (see stripLutForLocalStorage). LUT presets therefore render
  // without their table for the moment between first paint and the IDB load.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...payload,
      presets: stripLutForLocalStorage(presets),
    }));
  } catch {
    // localStorage full — IDB will be the source of truth
  }

  // Write to IndexedDB asynchronously
  void idbPut(STORAGE_KEY, payload).catch(() => {
    // IDB write failed — localStorage is the fallback
  });
}
