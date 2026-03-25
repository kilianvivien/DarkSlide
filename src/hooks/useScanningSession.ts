import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopShell } from '../utils/fileBridge';

export type ScanQueueEntry = {
  path: string;
  filename: string;
  status: 'queued' | 'importing' | 'processing' | 'ready' | 'exported' | 'error';
  documentId?: string;
  error?: string;
  timestamp: number;
};

export type ScanningSessionState = {
  watchPath: string | null;
  isWatching: boolean;
  queue: ScanQueueEntry[];
  processedCount: number;
  errorCount: number;
  autoExport: boolean;
  autoExportPath: string | null;
};

type ProcessScanResult = {
  documentId: string | null;
  exported: boolean;
};

type UseScanningSessionOptions = {
  initialWatchPath?: string | null;
  initialAutoExport?: boolean;
  initialAutoExportPath?: string | null;
  processScan: (path: string, options: { autoExport: boolean; autoExportPath: string | null }) => Promise<ProcessScanResult>;
};

export function useScanningSession({
  initialWatchPath = null,
  initialAutoExport = false,
  initialAutoExportPath = null,
  processScan,
}: UseScanningSessionOptions) {
  const [watchPath, setWatchPath] = useState<string | null>(initialWatchPath);
  const [isWatching, setIsWatching] = useState(false);
  const [queue, setQueue] = useState<ScanQueueEntry[]>([]);
  const [autoExport, setAutoExportState] = useState(initialAutoExport);
  const [autoExportPath, setAutoExportPath] = useState<string | null>(initialAutoExportPath);
  const isDesktop = useMemo(() => isDesktopShell(), []);
  const processingRef = useRef(false);
  const seenBasenamesRef = useRef(new Set<string>());

  const stopWatching = useCallback(async () => {
    if (!isDesktop) {
      return;
    }

    await invoke('stop_watching');
    setIsWatching(false);
  }, [isDesktop]);

  const startWatching = useCallback(async (path: string) => {
    if (!isDesktop) {
      return;
    }

    await invoke('start_watching', { path });
    setWatchPath(path);
    setIsWatching(true);
  }, [isDesktop]);

  const clearQueue = useCallback(() => {
    setQueue([]);
    seenBasenamesRef.current.clear();
  }, []);

  const setAutoExport = useCallback((enabled: boolean, nextPath?: string | null) => {
    setAutoExportState(enabled);
    if (nextPath !== undefined) {
      setAutoExportPath(nextPath);
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const active = await invoke<boolean>('is_watching');
        if (!cancelled) {
          setIsWatching(active);
        }

        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) {
          return;
        }

        unlisten = await listen<{ path: string; filename: string }>('darkslide://new-scan', (event) => {
          const basename = event.payload.filename.toLowerCase();
          if (seenBasenamesRef.current.has(basename)) {
            if (typeof window !== 'undefined' && !window.confirm(`Import another copy of ${event.payload.filename}?`)) {
              return;
            }
          }

          seenBasenamesRef.current.add(basename);
          setQueue((current) => [...current, {
            path: event.payload.path,
            filename: event.payload.filename,
            status: 'queued',
            timestamp: Date.now(),
          }]);
        });
      } catch {
        // Ignore non-Tauri environments and missing watcher commands.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isDesktop]);

  useEffect(() => {
    if (processingRef.current) {
      return;
    }

    const nextEntry = queue.find((entry) => entry.status === 'queued');
    if (!nextEntry) {
      return;
    }

    processingRef.current = true;
    setQueue((current) => current.map((entry) => (
      entry.timestamp === nextEntry.timestamp
        ? { ...entry, status: 'importing' }
        : entry
    )));

    void (async () => {
      try {
        setQueue((current) => current.map((entry) => (
          entry.timestamp === nextEntry.timestamp
            ? { ...entry, status: 'processing' }
            : entry
        )));

        const result = await processScan(nextEntry.path, { autoExport, autoExportPath });
        setQueue((current) => current.map((entry) => (
          entry.timestamp === nextEntry.timestamp
            ? {
              ...entry,
              documentId: result.documentId ?? undefined,
              status: result.exported ? 'exported' : 'ready',
            }
            : entry
        )));
      } catch (error) {
        setQueue((current) => current.map((entry) => (
          entry.timestamp === nextEntry.timestamp
            ? {
              ...entry,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            }
            : entry
        )));
      } finally {
        processingRef.current = false;
      }
    })();
  }, [autoExport, autoExportPath, processScan, queue]);

  const session = useMemo<ScanningSessionState>(() => ({
    watchPath,
    isWatching,
    queue,
    processedCount: queue.filter((entry) => entry.status === 'exported' || entry.status === 'ready').length,
    errorCount: queue.filter((entry) => entry.status === 'error').length,
    autoExport,
    autoExportPath,
  }), [autoExport, autoExportPath, isWatching, queue, watchPath]);

  return {
    session,
    startWatching,
    stopWatching,
    setAutoExport,
    setWatchPath,
    setAutoExportPath,
    clearQueue,
  };
}
