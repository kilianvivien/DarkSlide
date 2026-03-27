import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScanningSessionWindow } from './useScanningSessionWindow';
import type { ScanningSessionState } from './useScanningSession';

const tauriEventState = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const webviewWindowState = vi.hoisted(() => ({
  getByLabel: vi.fn(),
  constructorCalls: [] as Array<{ label: string; options: unknown }>,
}));

vi.mock('../utils/fileBridge', () => ({
  isDesktopShell: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: tauriEventState.emit,
  listen: tauriEventState.listen,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class MockWebviewWindow {
    constructor(label: string, options: unknown) {
      webviewWindowState.constructorCalls.push({ label, options });
    }

    static getByLabel(label: string) {
      return webviewWindowState.getByLabel(label);
    }
  },
}));

function createSession(): ScanningSessionState {
  return {
    watchPath: '/tmp/scans',
    isWatching: false,
    queue: [],
    processedCount: 0,
    errorCount: 0,
    autoExport: false,
    autoExportPath: null,
  };
}

describe('useScanningSessionWindow', () => {
  beforeEach(() => {
    tauriEventState.emit.mockClear();
    tauriEventState.listen.mockClear();
    webviewWindowState.getByLabel.mockReset();
    webviewWindowState.constructorCalls.length = 0;
  });

  it('creates the scanning window when it is not open yet', async () => {
    webviewWindowState.getByLabel.mockResolvedValue(null);

    let hookValue: ReturnType<typeof useScanningSessionWindow> | undefined;

    function Harness() {
      hookValue = useScanningSessionWindow({
        session: createSession(),
        onPickWatchPath: vi.fn(),
        onToggleWatching: vi.fn(),
        onToggleAutoExport: vi.fn(),
        onPickAutoExportPath: vi.fn(),
        onSelectTab: vi.fn(),
        onClearQueue: vi.fn(),
      });
      return null;
    }

    render(<Harness />);

    expect(hookValue).toBeDefined();
    hookValue?.toggleScanningWindow();

    await waitFor(() => {
      expect(webviewWindowState.constructorCalls).toHaveLength(1);
    });

    expect(webviewWindowState.constructorCalls[0]).toEqual(expect.objectContaining({
      label: 'scanning',
      options: expect.objectContaining({
        title: 'Scanning Session',
        url: '/?window=scanning',
      }),
    }));
  });

  it('closes the scanning window when it is already open', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    webviewWindowState.getByLabel.mockResolvedValue({ close });

    let hookValue: ReturnType<typeof useScanningSessionWindow> | undefined;

    function Harness() {
      hookValue = useScanningSessionWindow({
        session: createSession(),
        onPickWatchPath: vi.fn(),
        onToggleWatching: vi.fn(),
        onToggleAutoExport: vi.fn(),
        onPickAutoExportPath: vi.fn(),
        onSelectTab: vi.fn(),
        onClearQueue: vi.fn(),
      });
      return null;
    }

    render(<Harness />);

    expect(hookValue).toBeDefined();
    hookValue?.toggleScanningWindow();

    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });

    expect(webviewWindowState.constructorCalls).toHaveLength(0);
  });
});
