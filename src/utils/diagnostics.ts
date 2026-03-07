import { DIAGNOSTICS_LIMIT } from '../constants';
import { DiagnosticsEntry } from '../types';

const STORAGE_KEY = 'darkslide_diagnostics_v1';

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DiagnosticsEntry[]) : [];
  } catch {
    return [];
  }
}

function persistEntries(entries: DiagnosticsEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-DIAGNOSTICS_LIMIT)));
}

export function appendDiagnostic(entry: Omit<DiagnosticsEntry, 'id' | 'timestamp'>) {
  const entries = loadEntries();
  const nextEntry: DiagnosticsEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  persistEntries([...entries, nextEntry]);
  return nextEntry;
}

export function getDiagnosticsReport() {
  return loadEntries();
}
