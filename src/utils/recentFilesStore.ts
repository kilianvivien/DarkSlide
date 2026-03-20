const STORAGE_KEY = 'darkslide_recent_files_v1';
const MAX_ENTRIES = 5;

export interface RecentFileEntry {
  name: string;
  path: string | null;
  size: number;
  timestamp: number;
}

interface RecentFilesStore {
  version: 1;
  entries: RecentFileEntry[];
}

function isValidStore(value: unknown): value is RecentFilesStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<RecentFilesStore>;
  return store.version === 1 && Array.isArray(store.entries);
}

export function loadRecentFiles(): RecentFileEntry[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!isValidStore(parsed)) return [];
    return parsed.entries
      .filter(
        (entry): entry is RecentFileEntry =>
          Boolean(entry?.name && typeof entry.size === 'number' && typeof entry.timestamp === 'number'),
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function addRecentFile(entry: Omit<RecentFileEntry, 'timestamp'>): void {
  const existing = loadRecentFiles();
  const key = entry.path ?? entry.name;
  const filtered = existing.filter((e) => (e.path ?? e.name) !== key);
  const updated = [{ ...entry, timestamp: Date.now() }, ...filtered].slice(0, MAX_ENTRIES);
  const store: RecentFilesStore = { version: 1, entries: updated };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function clearRecentFiles(): void {
  localStorage.removeItem(STORAGE_KEY);
}
