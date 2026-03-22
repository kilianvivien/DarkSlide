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
  void syncRecentFilesToMenu();
}

export function clearRecentFiles(): void {
  localStorage.removeItem(STORAGE_KEY);
  void syncRecentFilesToMenu();
}

export async function syncRecentFilesToMenu(): Promise<void> {
  try {
    const { isTauri, invoke } = await import('@tauri-apps/api/core');
    if (!isTauri()) return;

    const entries = loadRecentFiles()
      .filter((entry): entry is RecentFileEntry & { path: string } => entry.path !== null);

    await invoke('update_recent_files_menu', {
      entries: entries.map((entry) => ({ name: entry.name, path: entry.path })),
    });
  } catch {
    // Best-effort; ignore failures in non-Tauri environments or tests.
  }
}
