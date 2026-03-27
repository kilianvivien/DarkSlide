import { useCallback, useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isDesktopShell } from '../utils/fileBridge';
import type { ScanningSessionState } from './useScanningSession';

type ScanningCommand = {
  command: string;
  payload?: unknown;
};

type UseScanningSessionWindowOptions = {
  session: ScanningSessionState;
  onPickWatchPath: () => void;
  onToggleWatching: () => void;
  onToggleAutoExport: (enabled: boolean) => void;
  onPickAutoExportPath: () => void;
  onSelectTab: (tabId: string) => void;
  onClearQueue: () => void;
};

export function useScanningSessionWindow({
  session,
  onPickWatchPath,
  onToggleWatching,
  onToggleAutoExport,
  onPickAutoExportPath,
  onSelectTab,
  onClearQueue,
}: UseScanningSessionWindowOptions) {
  const isDesktop = isDesktopShell();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Emit state to scanning window whenever session changes.
  useEffect(() => {
    if (!isDesktop) return;

    void emit('scanning://state-update', {
      watchPath: session.watchPath,
      isWatching: session.isWatching,
      autoExport: session.autoExport,
      autoExportPath: session.autoExportPath,
      queue: session.queue,
    });
  }, [isDesktop, session]);

  // Listen for state requests from the scanning window.
  useEffect(() => {
    if (!isDesktop) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen('scanning://request-state', () => {
        if (cancelled) return;
        const current = sessionRef.current;
        void emit('scanning://state-update', {
          watchPath: current.watchPath,
          isWatching: current.isWatching,
          autoExport: current.autoExport,
          autoExportPath: current.autoExportPath,
          queue: current.queue,
        });
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isDesktop]);

  // Listen for commands from the scanning window.
  useEffect(() => {
    if (!isDesktop) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<ScanningCommand>('scanning://command', (event) => {
        if (cancelled) return;

        switch (event.payload.command) {
          case 'pick-watch-path':
            onPickWatchPath();
            break;
          case 'toggle-watching':
            onToggleWatching();
            break;
          case 'toggle-auto-export':
            onToggleAutoExport(event.payload.payload as boolean);
            break;
          case 'pick-export-path':
            onPickAutoExportPath();
            break;
          case 'select-tab':
            onSelectTab(event.payload.payload as string);
            break;
          case 'clear-queue':
            onClearQueue();
            break;
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isDesktop, onClearQueue, onPickAutoExportPath, onPickWatchPath, onSelectTab, onToggleAutoExport, onToggleWatching]);

  const openScanningWindow = useCallback(async () => {
    if (!isDesktop) return;

    // If the scanning window already exists, treat the action as a true toggle.
    const existing = await WebviewWindow.getByLabel('scanning');
    if (existing) {
      await existing.close();
      return;
    }

    // Create a new scanning session window.
    void new WebviewWindow('scanning', {
      url: '/?window=scanning',
      title: 'Scanning Session',
      width: 420,
      height: 600,
      minWidth: 360,
      minHeight: 400,
      resizable: true,
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      center: true,
    });
  }, [isDesktop]);

  const toggleScanningWindow = useCallback(() => {
    void openScanningWindow();
  }, [openScanningWindow]);

  return { toggleScanningWindow };
}
