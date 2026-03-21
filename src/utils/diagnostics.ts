import { DIAGNOSTICS_LIMIT } from '../constants';
import { DiagnosticsEntry } from '../types';

const STORAGE_KEY = 'darkslide_diagnostics_v1';
let bufferedEntries: DiagnosticsEntry[] = [];
let flushScheduled = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

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

function flushDiagnostics() {
  flushScheduled = false;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (bufferedEntries.length === 0) {
    return;
  }

  const entries = loadEntries();
  persistEntries([...entries, ...bufferedEntries]);
  bufferedEntries = [];
}

function scheduleFlush() {
  if (flushScheduled) {
    return;
  }

  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    bufferedEntries.length > 0 && flushDiagnostics();
    return;
  }

  flushScheduled = true;

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(flushDiagnostics, { timeout: 2000 });
    return;
  }

  flushTimer = setTimeout(flushDiagnostics, 200);
}

export function appendDiagnostic(entry: Omit<DiagnosticsEntry, 'id' | 'timestamp'>) {
  const nextEntry: DiagnosticsEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  bufferedEntries.push(nextEntry);
  scheduleFlush();
  return nextEntry;
}

export function getDiagnosticsReport() {
  flushDiagnostics();
  return loadEntries();
}
