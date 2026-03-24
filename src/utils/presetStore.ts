import { DarkslidePresetFile, FilmProfile, PresetFolder, VersionedPresetStore } from '../types';

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

  // Write to localStorage synchronously for immediate availability
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full — IDB will be the source of truth
  }

  // Write to IndexedDB asynchronously
  void idbPut(STORAGE_KEY, payload).catch(() => {
    // IDB write failed — localStorage is the fallback
  });
}
