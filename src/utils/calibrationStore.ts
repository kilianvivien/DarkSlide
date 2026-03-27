import { isDesktopShell } from './fileBridge';

const DB_NAME = 'darkslide_calibration';
const STORE_NAME = 'flatfield_profiles';
export const ACTIVE_FLAT_FIELD_PROFILE_KEY = 'darkslide_active_flatfield_profile';
const DESKTOP_DIR_NAME = 'calibration';

type StoredFlatFieldRecord = {
  name: string;
  size: number;
  data: ArrayBuffer;
};

export async function saveFlatFieldProfile(
  name: string,
  data: Float32Array,
  size: number,
): Promise<void> {
  if (isDesktopShell()) {
    await saveDesktopProfile(name, data, size);
    return;
  }

  const db = await openCalibrationDb();
  await withRequest(
    db.transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .put({ name, size, data: data.buffer.slice(0) } satisfies StoredFlatFieldRecord),
  );
}

export async function loadFlatFieldProfile(
  name: string,
): Promise<{ data: Float32Array; size: number } | null> {
  if (isDesktopShell()) {
    return loadDesktopProfile(name);
  }

  const db = await openCalibrationDb();
  const record = await withRequest<StoredFlatFieldRecord | undefined>(
    db.transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .get(name),
  );

  if (!record) {
    return null;
  }

  return {
    size: record.size,
    data: new Float32Array(record.data.slice(0)),
  };
}

export async function deleteFlatFieldProfile(name: string): Promise<void> {
  if (isDesktopShell()) {
    await deleteDesktopProfile(name);
    return;
  }

  const db = await openCalibrationDb();
  await withRequest(
    db.transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .delete(name),
  );
}

export async function listFlatFieldProfiles(): Promise<string[]> {
  if (isDesktopShell()) {
    return listDesktopProfiles();
  }

  const db = await openCalibrationDb();
  const names = await withRequest<IDBValidKey[]>(
    db.transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .getAllKeys(),
  );

  return names.map(String).sort((left, right) => left.localeCompare(right));
}

function openCalibrationDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open calibration store.'));
  });
}

function withRequest<T = void>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

async function saveDesktopProfile(name: string, data: Float32Array, size: number) {
  const [{ appDataDir }, { mkdir, writeFile }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const baseDir = `${await appDataDir()}${DESKTOP_DIR_NAME}`;
  const path = buildDesktopProfilePath(baseDir, name);
  const payload = new Uint8Array(
    new Uint32Array([size]).byteLength + data.byteLength,
  );
  payload.set(new Uint8Array(new Uint32Array([size]).buffer), 0);
  payload.set(new Uint8Array(data.buffer.slice(0)), 4);
  await mkdir(baseDir, { recursive: true });
  await writeFile(path, payload);
}

async function loadDesktopProfile(name: string) {
  const [{ appDataDir }, { readFile }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const baseDir = `${await appDataDir()}${DESKTOP_DIR_NAME}`;

  try {
    const bytes = await readFile(buildDesktopProfilePath(baseDir, name));
    const size = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 4))[0] ?? 0;
    const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 4, bytes.byteOffset + bytes.byteLength));
    return { data, size };
  } catch {
    return null;
  }
}

async function deleteDesktopProfile(name: string) {
  const [{ appDataDir }, { remove }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const baseDir = `${await appDataDir()}${DESKTOP_DIR_NAME}`;
  await remove(buildDesktopProfilePath(baseDir, name)).catch(() => undefined);
}

async function listDesktopProfiles() {
  const [{ appDataDir }, { readDir }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const baseDir = `${await appDataDir()}${DESKTOP_DIR_NAME}`;

  try {
    const entries = await readDir(baseDir);
    return entries
      .map((entry) => entry.name ?? '')
      .filter((name) => name.endsWith('.ffcal'))
      .map((name) => name.replace(/\.ffcal$/i, ''))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function buildDesktopProfilePath(baseDir: string, name: string) {
  const safeName = name.trim().replace(/[^\w.-]+/g, '-');
  return `${baseDir}/${safeName}.ffcal`;
}
