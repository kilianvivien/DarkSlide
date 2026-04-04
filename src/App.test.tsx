import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_SIZE_BYTES } from './constants';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

class MockImageBitmap {
  width: number;

  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  close() {}
}

const workerState = vi.hoisted(() => ({
  decode: vi.fn(),
  detectFrame: vi.fn(),
  render: vi.fn(),
  autoAnalyze: vi.fn(),
  export: vi.fn(),
  contactSheet: vi.fn(),
  sampleFilmBase: vi.fn(),
  disposeDocument: vi.fn(async () => ({ disposed: true })),
  evictPreviews: vi.fn(async () => ({ evicted: true })),
  trimResidentDocuments: vi.fn(async () => ({ evicted: true })),
  cancelActivePreviewRender: vi.fn(async () => undefined),
  noteCoalescedPreviewRequest: vi.fn(),
  preparePreviewBitmap: vi.fn(),
  recordPreviewPresentationTimings: vi.fn(),
  setGPUEnabled: vi.fn(),
  getGPUDiagnostics: vi.fn(async () => ({
    gpuAvailable: false,
    gpuEnabled: true,
    gpuActive: false,
    gpuAdapterName: null,
    backendMode: 'cpu-worker',
    sourceKind: null,
    previewMode: null,
    previewLevelId: null,
    interactionQuality: null,
    histogramMode: null,
    tileSize: null,
    halo: null,
    tileCount: null,
    intermediateFormat: null,
    usedCpuFallback: false,
    fallbackReason: null,
    jobDurationMs: null,
    geometryCacheHit: null,
    phaseTimings: null,
    coalescedPreviewRequests: 0,
    cancelledPreviewJobs: 0,
    previewBackend: null,
    lastPreviewJob: null,
    lastExportJob: null,
    maxStorageBufferBindingSize: null,
    maxBufferSize: null,
    gpuDisabledReason: 'unsupported',
    lastError: null,
    workerMemory: null,
    activeBlobUrlCount: null,
    oldestActiveBlobUrlAgeMs: null,
  })),
  constructorOptions: [] as Array<Record<string, unknown>>,
  terminate: vi.fn(),
}));

const coreState = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const tauriEventState = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const webviewWindowState = vi.hoisted(() => ({
  getByLabel: vi.fn(),
  constructorCalls: [] as Array<{ label: string; options: unknown }>,
}));

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  openImageFile: vi.fn(),
  openImageFileByPath: vi.fn(),
  openMultipleImageFiles: vi.fn(),
  openPresetBackupFile: vi.fn(),
  openDirectory: vi.fn(),
  openInExternalEditor: vi.fn(),
  chooseApplicationPath: vi.fn(),
  confirmDiscard: vi.fn(),
  confirmReplacePresetLibrary: vi.fn(),
  saveToDirectory: vi.fn(),
  saveExportBlob: vi.fn<(...args: unknown[]) => Promise<'saved' | 'cancelled'>>(),
  savePresetBackupFile: vi.fn<(...args: unknown[]) => Promise<'saved' | 'cancelled'>>(),
  registerBeforeUnloadGuard: vi.fn(() => vi.fn()),
}));

const exportNotificationState = vi.hoisted(() => ({
  notifyExportFinished: vi.fn(),
  primeExportNotificationsPermission: vi.fn(),
}));

const customPresetState = vi.hoisted(() => ({
  presets: [] as Array<Record<string, unknown>>,
  folders: [] as Array<{ id: string; name: string }>,
}));

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy({}, {
      get: (_, tag: string) => ReactModule.forwardRef((
        props: { children?: React.ReactNode } & Record<string, unknown>,
        ref,
      ) => {
        const { children, ...rest } = props;
        return ReactModule.createElement(tag, { ...rest, ref }, children);
      }),
    }),
  };
});

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

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({
    exportOptions,
    lightSourceId,
    onInteractionStart,
    onInteractionEnd,
    onOpenSettings,
    onSettingsChange,
    onLightSourceChange,
    onAutoAdjust,
    onExportOptionsChange,
    onExport,
    onTogglePicker,
  }: {
    exportOptions: { filenameBase: string };
    lightSourceId?: string | null;
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    onOpenSettings: () => void;
    onSettingsChange: (settings: Record<string, unknown>) => void;
    onLightSourceChange?: (lightSourceId: string | null) => void;
    onAutoAdjust?: () => void;
    onExportOptionsChange: (options: { filenameBase?: string }) => void;
    onExport: () => void;
    onTogglePicker: () => void;
  }) => {
    const [, setExposure] = React.useState(0);
    const [, setBlackAndWhiteEnabled] = React.useState(false);

    return (
      <div data-testid="sidebar">
        <input
          aria-label="Filename"
          value={exportOptions.filenameBase}
          onChange={(event) => onExportOptionsChange({ filenameBase: event.target.value })}
        />
        <button type="button" onClick={onExport}>
          Sidebar Export
        </button>
        <button type="button" onClick={onOpenSettings}>
          Open Settings
        </button>
        <button type="button" onClick={onTogglePicker}>
          Toggle Film Base Picker
        </button>
        <div>Current Light Source: {lightSourceId ?? 'auto'}</div>
        <button type="button" onClick={() => onLightSourceChange?.(null)}>
          Select Auto Light Source
        </button>
        <button type="button" onClick={() => onLightSourceChange?.('daylight')}>
          Select Daylight Light Source
        </button>
        <button type="button" onClick={onAutoAdjust}>
          Auto
        </button>
        <button
          type="button"
          onClick={() => {
            setBlackAndWhiteEnabled((current) => {
              const nextEnabled = !current;
              onSettingsChange({
                blackAndWhite: {
                  enabled: nextEnabled,
                  redMix: 0,
                  greenMix: 0,
                  blueMix: 0,
                  tone: 0,
                },
              });
              return nextEnabled;
            });
          }}
        >
          Toggle Black And White
        </button>
        <button type="button" onClick={onInteractionStart}>
          Start Drag
        </button>
        <button
          type="button"
          onClick={() => {
            setExposure((current) => {
              const nextExposure = current + 1;
              onSettingsChange({ exposure: nextExposure });
              return nextExposure;
            });
          }}
        >
          Nudge Exposure
        </button>
        <button type="button" onClick={onInteractionEnd}>
          End Drag
        </button>
      </div>
    );
  },
}));

vi.mock('./components/PresetsPane', () => ({
  PresetsPane: ({
    builtinProfiles = [],
    customPresets = [],
    onStockChange,
    onSavePreset,
  }: {
    builtinProfiles?: Array<{ id: string; name: string }>;
    customPresets?: Array<{ id: string; name: string }>;
    onStockChange: (profile: { id: string; name: string }) => void;
    onSavePreset?: (name: string) => void;
  }) => (
    <div data-testid="presets">
      <button type="button" onClick={() => onSavePreset?.('Saved Custom Preset')}>
        Save Custom Preset
      </button>
      {[...builtinProfiles, ...customPresets].map((profile) => (
        <button
          key={profile.id}
          type="button"
          onClick={() => onStockChange(profile)}
        >
          {profile.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./components/CropOverlay', () => ({
  CropOverlay: () => <div data-testid="crop-overlay" />,
}));

vi.mock('./components/TabBar', () => ({
  TabBar: ({
    tabs = [],
    activeTabId,
    onSelectTab,
  }: {
    tabs?: Array<{ id: string; document: { source: { name: string } } }>;
    activeTabId?: string | null;
    onSelectTab?: (tabId: string) => void;
  }) => (
    <div data-testid="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={tab.id === activeTabId}
          onClick={() => onSelectTab?.(tab.id)}
        >
          {tab.document.source.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./components/BatchModal', () => ({
  BatchModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="batch-modal" /> : null),
}));

vi.mock('./components/ContactSheetModal', () => ({
  ContactSheetModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="contact-sheet-modal" /> : null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreState.invoke,
}));

vi.mock('./hooks/useCustomPresets', async () => {
  const ReactModule = await import('react');

  return {
    useCustomPresets: () => {
      const [customPresets, setCustomPresets] = ReactModule.useState(customPresetState.presets as Array<Record<string, unknown>>);
      const [folders, setFolders] = ReactModule.useState(customPresetState.folders as Array<{ id: string; name: string }>);

      return {
        customPresets,
        folders,
        savePreset: (preset: Record<string, unknown>) => {
          const savedPreset = { ...structuredClone(preset), isCustom: true };
          const nextPresets = [...customPresetState.presets, savedPreset];
          customPresetState.presets = nextPresets;
          setCustomPresets(nextPresets);
          return savedPreset;
        },
        importPreset: (preset: Record<string, unknown>, options: { overwriteId?: string; renameTo?: string } = {}) => {
          const importedPreset = {
            ...structuredClone(preset),
            id: options.overwriteId ?? String(preset.id),
            name: options.renameTo?.trim() || String(preset.name),
            isCustom: true,
          };
          const nextPresets = options.overwriteId
            ? customPresetState.presets.map((existingPreset) => (
              existingPreset.id === options.overwriteId ? importedPreset : existingPreset
            ))
            : [...customPresetState.presets, importedPreset];
          customPresetState.presets = nextPresets;
          setCustomPresets(nextPresets);
          return importedPreset;
        },
        deletePreset: (id: string) => {
          const nextPresets = customPresetState.presets.filter((preset) => preset.id !== id);
          customPresetState.presets = nextPresets;
          setCustomPresets(nextPresets);
        },
        replaceLibrary: (presets: Array<Record<string, unknown>>, nextFolders: Array<{ id: string; name: string }>) => {
          customPresetState.presets = presets;
          customPresetState.folders = nextFolders;
          setCustomPresets(presets);
          setFolders(nextFolders);
        },
      };
    },
  };
});

vi.mock('./utils/imageWorkerClient', () => ({
  ImageWorkerClient: class MockImageWorkerClient {
    constructor(options: Record<string, unknown> = {}) {
      workerState.constructorOptions.push(options);
    }

    decode(...args: Parameters<typeof workerState.decode>) {
      return workerState.decode(...args);
    }

    detectFrame(...args: Parameters<typeof workerState.detectFrame>) {
      return workerState.detectFrame(...args);
    }

    render(...args: Parameters<typeof workerState.render>) {
      return workerState.render(...args);
    }

    autoAnalyze(...args: Parameters<typeof workerState.autoAnalyze>) {
      return workerState.autoAnalyze(...args);
    }

    export(...args: Parameters<typeof workerState.export>) {
      return workerState.export(...args);
    }

    contactSheet(...args: Parameters<typeof workerState.contactSheet>) {
      return workerState.contactSheet(...args);
    }

    sampleFilmBase(...args: Parameters<typeof workerState.sampleFilmBase>) {
      return workerState.sampleFilmBase(...args);
    }

    disposeDocument(...args: Parameters<typeof workerState.disposeDocument>) {
      return workerState.disposeDocument(...args);
    }

    evictPreviews(...args: Parameters<typeof workerState.evictPreviews>) {
      return workerState.evictPreviews(...args);
    }

    trimResidentDocuments(...args: Parameters<typeof workerState.trimResidentDocuments>) {
      return workerState.trimResidentDocuments(...args);
    }

    setGPUEnabled(...args: Parameters<typeof workerState.setGPUEnabled>) {
      return workerState.setGPUEnabled(...args);
    }

    getGPUDiagnostics(...args: Parameters<typeof workerState.getGPUDiagnostics>) {
      return workerState.getGPUDiagnostics(...args);
    }

    noteCoalescedPreviewRequest(...args: Parameters<typeof workerState.noteCoalescedPreviewRequest>) {
      return workerState.noteCoalescedPreviewRequest(...args);
    }

    preparePreviewBitmap(...args: Parameters<typeof workerState.preparePreviewBitmap>) {
      return workerState.preparePreviewBitmap(...args);
    }

    recordPreviewPresentationTimings(...args: Parameters<typeof workerState.recordPreviewPresentationTimings>) {
      return workerState.recordPreviewPresentationTimings(...args);
    }

    cancelActivePreviewRender(...args: Parameters<typeof workerState.cancelActivePreviewRender>) {
      return workerState.cancelActivePreviewRender(...args);
    }

    terminate(...args: Parameters<typeof workerState.terminate>) {
      return workerState.terminate(...args);
    }
  },
}));

vi.mock('./utils/fileBridge', () => ({
  isDesktopShell: fileBridgeState.isDesktopShell,
  openImageFile: fileBridgeState.openImageFile,
  openImageFileByPath: fileBridgeState.openImageFileByPath,
  openMultipleImageFiles: fileBridgeState.openMultipleImageFiles,
  openPresetBackupFile: fileBridgeState.openPresetBackupFile,
  openDirectory: fileBridgeState.openDirectory,
  openInExternalEditor: fileBridgeState.openInExternalEditor,
  chooseApplicationPath: fileBridgeState.chooseApplicationPath,
  confirmDiscard: fileBridgeState.confirmDiscard,
  confirmReplacePresetLibrary: fileBridgeState.confirmReplacePresetLibrary,
  saveToDirectory: fileBridgeState.saveToDirectory,
  saveExportBlob: fileBridgeState.saveExportBlob,
  savePresetBackupFile: fileBridgeState.savePresetBackupFile,
  registerBeforeUnloadGuard: fileBridgeState.registerBeforeUnloadGuard,
}));

vi.mock('./utils/exportNotifications', () => ({
  notifyExportFinished: exportNotificationState.notifyExportFinished,
  primeExportNotificationsPermission: exportNotificationState.primeExportNotificationsPermission,
}));

import App from './App';

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createFile(name: string, type: string) {
  const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer),
  });
  return file;
}

function createDecodedImage(width: number, height: number, options: { exifOrientation?: number; mime?: string; extension?: string } = {}) {
  return {
    metadata: {
      id: `metadata-${width}-${height}`,
      name: `scan-${width}x${height}${options.extension ?? '.tiff'}`,
      mime: options.mime ?? 'image/tiff',
      extension: options.extension ?? '.tiff',
      size: width * height,
      width,
      height,
      ...(options.exifOrientation ? {
        exif: {
          orientation: options.exifOrientation,
        },
      } : {}),
    },
    previewLevels: [
      {
        id: 'preview-1024',
        width,
        height,
        maxDimension: Math.max(width, height),
      },
    ],
  };
}

function createRenderResult(documentId: string, revision: number, width: number, height: number) {
  return {
    documentId,
    revision,
    width,
    height,
    previewLevelId: 'preview-1024',
    imageData: new ImageData(new Uint8ClampedArray(width * height * 4), width, height),
    histogram: {
      r: new Array(256).fill(0),
      g: new Array(256).fill(0),
      b: new Array(256).fill(0),
      l: new Array(256).fill(0),
    },
    highlightDensity: 0,
  };
}

async function uploadFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();

  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('App import and preview pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    customPresetState.presets = [];
    customPresetState.folders = [];
    coreState.invoke.mockReset();
    tauriEventState.emit.mockClear();
    tauriEventState.listen.mockClear();
    webviewWindowState.getByLabel.mockReset();
    webviewWindowState.constructorCalls.length = 0;
    workerState.decode.mockReset();
    workerState.detectFrame.mockReset();
    workerState.render.mockReset();
    workerState.autoAnalyze.mockReset();
    workerState.export.mockReset();
    workerState.contactSheet.mockReset();
    workerState.sampleFilmBase.mockReset();
    workerState.disposeDocument.mockClear();
    workerState.evictPreviews.mockClear();
    workerState.trimResidentDocuments.mockClear();
    workerState.cancelActivePreviewRender.mockReset();
    workerState.noteCoalescedPreviewRequest.mockClear();
    workerState.preparePreviewBitmap.mockReset();
    workerState.recordPreviewPresentationTimings.mockClear();
    workerState.setGPUEnabled.mockReset();
    workerState.getGPUDiagnostics.mockClear();
    workerState.terminate.mockClear();
    workerState.constructorOptions = [];
    fileBridgeState.isDesktopShell.mockReturnValue(false);
    fileBridgeState.openImageFile.mockReset();
    fileBridgeState.openImageFileByPath.mockReset();
    fileBridgeState.openMultipleImageFiles.mockReset();
    fileBridgeState.openPresetBackupFile.mockReset();
    fileBridgeState.openDirectory.mockReset();
    fileBridgeState.openInExternalEditor.mockReset();
    fileBridgeState.chooseApplicationPath.mockReset();
    fileBridgeState.confirmDiscard.mockReset();
    fileBridgeState.confirmReplacePresetLibrary.mockReset();
    fileBridgeState.saveToDirectory.mockReset();
    fileBridgeState.saveExportBlob.mockReset();
    fileBridgeState.savePresetBackupFile.mockReset();
    fileBridgeState.saveExportBlob.mockResolvedValue('saved');
    fileBridgeState.savePresetBackupFile.mockResolvedValue('saved');
    exportNotificationState.notifyExportFinished.mockReset();
    exportNotificationState.primeExportNotificationsPermission.mockReset();
    exportNotificationState.notifyExportFinished.mockResolvedValue(undefined);
    exportNotificationState.primeExportNotificationsPermission.mockResolvedValue(undefined);
    vi.stubGlobal('createImageBitmap', vi.fn(async (source: ImageData | { width: number; height: number }) => (
      new MockImageBitmap(source.width, source.height)
    )));
    workerState.preparePreviewBitmap.mockImplementation(async (_documentId: string, _revision: number, imageData: ImageData) => (
      new MockImageBitmap(imageData.width, imageData.height)
    ));
    fileBridgeState.openInExternalEditor.mockResolvedValue({
      savedPath: '/Users/tester/Downloads/scan.jpg',
      destinationDirectory: '/Users/tester/Downloads',
    });
    fileBridgeState.confirmDiscard.mockResolvedValue(true);
    fileBridgeState.confirmReplacePresetLibrary.mockResolvedValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => undefined),
      },
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('does not render while loading and only renders once after import settles', async () => {
    const decodeRequest = deferred<ReturnType<typeof createDecodedImage>>();
    workerState.decode.mockReturnValueOnce(decodeRequest.promise);
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 64, 48)
    ));

    render(<App />);
    await uploadFile(createFile('scan-a.tiff', 'image/tiff'));

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(workerState.render).not.toHaveBeenCalled();

    decodeRequest.resolve(createDecodedImage(4032, 6048));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/4,?032 × 6,?048 px/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);
  });

  it('keeps single-image imports full-frame and does not auto-run frame detection', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(4032, 6048));
    workerState.detectFrame.mockResolvedValue({
      left: 0.1,
      top: 0.1,
      right: 0.9,
      bottom: 0.9,
      angle: 1.2,
      confidence: 4,
    });
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 64, 48)
    ));

    render(<App />);

    await uploadFile(createFile('scan-a.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.detectFrame).not.toHaveBeenCalled();
    expect(workerState.render).toHaveBeenCalledTimes(1);
    expect(workerState.render.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      settings: expect.objectContaining({
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
      }),
    }));
    expect(screen.queryByText(/Auto-crop skipped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Frame detected and crop applied/i)).not.toBeInTheDocument();
  });

  it('shows the desktop-only RAW error in the browser build', async () => {
    render(<App />);

    await uploadFile(createFile('scan.dng', 'application/octet-stream'));

    expect(workerState.decode).not.toHaveBeenCalled();
    expect(screen.getByText(/RAW files \(.dng, .cr3, .nef, .arw, .raf, .rw2\) require the DarkSlide desktop app\./)).toBeInTheDocument();
  });

  it('rejects oversized raster files before reading them into an ArrayBuffer', async () => {
    render(<App />);

    const file = createFile('huge-scan.tiff', 'image/tiff');
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: MAX_FILE_SIZE_BYTES + 1,
    });

    await uploadFile(file);

    expect((file.arrayBuffer as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(workerState.decode).not.toHaveBeenCalled();
    expect(screen.getByText(/File is too large/)).toBeInTheDocument();
  });

  it('routes desktop RAW imports through the Tauri decode command before handing RGBA to the worker', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    const rawFile = createFile('scan.dng', 'application/octet-stream');
    fileBridgeState.openImageFile.mockResolvedValue({
      file: rawFile,
      path: '/Users/tester/Desktop/scan.dng',
      size: 12_345_678,
    });
    coreState.invoke.mockResolvedValue({
      width: 2,
      height: 1,
      data: [10, 20, 30, 40, 50, 60],
      color_space: 'sRGB',
      white_balance: [2, 1, 1.5],
    });
    workerState.decode.mockResolvedValue(createDecodedImage(2, 1));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 2, 1)
    ));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Select Files'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    expect(coreState.invoke).toHaveBeenCalledWith('decode_raw', { path: '/Users/tester/Desktop/scan.dng' });
    expect(workerState.decode).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'scan.dng',
      mime: 'image/x-raw-rgba',
      rawDimensions: { width: 2, height: 1 },
      size: 12_345_678,
    }));

    const rawDecodeRequest = workerState.decode.mock.calls[0]?.[0] as { buffer: ArrayBuffer };
    expect(Array.from(new Uint8Array(rawDecodeRequest.buffer))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(screen.getByText(/2 × 1 px/)).toBeInTheDocument();

    const diagnostics = JSON.parse(localStorage.getItem('darkslide_diagnostics_v1') ?? '[]') as Array<{ code: string; message: string }>;
    expect(diagnostics.some((entry) => entry.code === 'RAW_DECODED' && entry.message.includes('scan.dng'))).toBe(true);
  });

  it('saves then opens the exported file for desktop open-in-editor', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({
      file: createFile('scan.tiff', 'image/tiff'),
      path: '/Users/tester/Desktop/scan.tiff',
      size: 12_345,
    });
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));
    workerState.export.mockResolvedValue({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      filename: 'scan.jpg',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Select Files'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-tip="Open in External Editor"]') as Element);
    });
    await flushMicrotasks();

    expect(workerState.export).toHaveBeenCalledTimes(1);
    expect(fileBridgeState.openInExternalEditor).toHaveBeenCalledWith(
      expect.any(Blob),
      'scan.jpg',
      null,
      null,
    );
    expect(screen.getByText(/Saved to \/Users\/tester\/Downloads\/scan\.jpg and opened in default app/)).toBeInTheDocument();

    const diagnostics = JSON.parse(localStorage.getItem('darkslide_diagnostics_v1') ?? '[]') as Array<{ code: string; message: string }>;
    expect(diagnostics.some((entry) => entry.code === 'OPEN_IN_EDITOR_SUCCESS' && entry.message === '/Users/tester/Downloads/scan.jpg')).toBe(true);
  });

  it('auto-applies EXIF orientation for raster imports exactly once', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200, {
      exifOrientation: 6,
      mime: 'image/jpeg',
      extension: '.jpg',
    }));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));

    render(<App />);

    await uploadFile(createFile('scan.jpg', 'image/jpeg'));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        rotation: number;
      };
    };

    expect(latestRenderCall.settings.rotation).toBe(90);
  });

  it('keeps the RAW import result available as a profile after switching away', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({
      file: createFile('scan.dng', 'application/octet-stream'),
      path: '/Users/tester/Desktop/scan.dng',
      size: 12_345_678,
    });
    coreState.invoke.mockResolvedValue({
      width: 8,
      height: 8,
      data: Array.from({ length: 8 * 8 * 3 }, (_, index) => [200, 180, 150][index % 3]),
      color_space: 'sRGB',
      orientation: 6,
    });
    workerState.decode.mockResolvedValue(createDecodedImage(8, 8));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 8, 8)
    ));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Select Files'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    expect(within(screen.getByTestId('presets')).getByRole('button', { name: 'Raw Import Result' })).toBeInTheDocument();

    const renderCallsAfterImport = workerState.render.mock.calls.length;
    fireEvent.click(within(screen.getByTestId('presets')).getByRole('button', { name: 'Generic Color' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();
    expect(workerState.render.mock.calls.length).toBeGreaterThan(renderCallsAfterImport);

    let latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        filmBaseSample: { r: number; g: number; b: number } | null;
        rotation: number;
      };
    };
    expect(latestRenderCall.settings.filmBaseSample).toBeNull();
    expect(latestRenderCall.settings.rotation).toBe(0);

    const renderCallsAfterGeneric = workerState.render.mock.calls.length;
    fireEvent.click(within(screen.getByTestId('presets')).getByRole('button', { name: 'Raw Import Result' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();
    expect(workerState.render.mock.calls.length).toBeGreaterThan(renderCallsAfterGeneric);

    latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        filmBaseSample: { r: number; g: number; b: number } | null;
        rotation: number;
      };
    };
    expect(latestRenderCall.settings.filmBaseSample).toEqual({ r: 200, g: 180, b: 150 });
    expect(latestRenderCall.settings.rotation).toBe(90);
  });

  it('auto-maps CS-LITE to cool, white, and warm modes as film profiles change', async () => {
    localStorage.setItem('darkslide_default_light_source', 'cs-lite');
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));

    render(<App />);

    await uploadFile(createFile('scan.jpg', 'image/jpeg'));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    let latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(latestRenderCall.lightSourceBias).toEqual([0.82, 0.87, 1]);

    fireEvent.click(within(screen.getByTestId('presets')).getByRole('button', { name: 'Generic B&W' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(latestRenderCall.lightSourceBias).toEqual([1, 0.94, 0.88]);

    fireEvent.click(within(screen.getByTestId('presets')).getByRole('button', { name: 'Fuji Provia 100F' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(latestRenderCall.lightSourceBias).toEqual([1, 0.72, 0.48]);
  });

  it('lets the user select Auto without overwriting the saved default light source', async () => {
    localStorage.setItem('darkslide_default_light_source', 'cs-lite');
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));

    render(<App />);

    await uploadFile(createFile('scan.jpg', 'image/jpeg'));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    expect(screen.getByText('Current Light Source: cs-lite-cool')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select Auto Light Source' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(latestRenderCall.lightSourceBias).toEqual([1, 1, 1]);
    expect(screen.getByText('Current Light Source: auto')).toBeInTheDocument();
    expect(localStorage.getItem('darkslide_default_light_source')).toBe('cs-lite');
  });

  it('saves and reapplies the embedded light source with a custom preset', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));

    render(<App />);

    await uploadFile(createFile('scan.jpg', 'image/jpeg'));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Select Daylight Light Source' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Save Custom Preset' }));
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Select Auto Light Source' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();
    expect(screen.getByText('Current Light Source: auto')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('presets')).getByRole('button', { name: 'Saved Custom Preset' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(screen.getByText('Current Light Source: daylight')).toBeInTheDocument();
    expect(latestRenderCall.lightSourceBias).toEqual([1, 0.98, 0.95]);
  });

  it('switches CS-LITE to the white mode when black-and-white conversion is enabled', async () => {
    localStorage.setItem('darkslide_default_light_source', 'cs-lite');
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));

    render(<App />);

    await uploadFile(createFile('scan.jpg', 'image/jpeg'));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Black And White' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      lightSourceBias: [number, number, number];
    };
    expect(latestRenderCall.lightSourceBias).toEqual([1, 0.94, 0.88]);
  });

  it('shows the RAW decoding overlay while the native decode is still running', async () => {
    const rawDecode = deferred<{
      width: number;
      height: number;
      data: number[];
      color_space: string;
      orientation?: number;
    }>();

    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({
      file: createFile('scan.nef', 'application/octet-stream'),
      path: '/Users/tester/Desktop/scan.nef',
      size: 30_955_119,
    });
    coreState.invoke.mockReturnValue(rawDecode.promise);

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Select Files'));
    });
    await flushMicrotasks();

    expect(screen.getByText('RAW import underway')).toBeInTheDocument();
    expect(screen.getByText(/Decoding the RAW file and preparing the first preview\./)).toBeInTheDocument();
  });

  it('ignores stale imports that resolve after a newer file wins', async () => {
    const firstDecode = deferred<ReturnType<typeof createDecodedImage>>();
    const secondDecode = deferred<ReturnType<typeof createDecodedImage>>();

    workerState.decode
      .mockReturnValueOnce(firstDecode.promise)
      .mockReturnValueOnce(secondDecode.promise);
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 80, 60)
    ));

    render(<App />);
    await uploadFile(createFile('old.tiff', 'image/tiff'));
    await uploadFile(createFile('new.tiff', 'image/tiff'));

    secondDecode.resolve(createDecodedImage(20, 20));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(screen.getByText(/20 × 20 px/)).toBeInTheDocument();

    firstDecode.resolve(createDecodedImage(10, 10));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(screen.getByText(/20 × 20 px/)).toBeInTheDocument();
    expect(screen.queryByText(/10 × 10 px/)).not.toBeInTheDocument();
    expect(workerState.render).toHaveBeenCalledTimes(1);
  });

  it('queues only the latest preview render while another render is in flight', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      drawImage,
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);

    const firstRender = deferred<ReturnType<typeof createRenderResult>>();
    const secondRender = deferred<ReturnType<typeof createRenderResult>>();

    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render
      .mockReturnValueOnce(firstRender.promise)
      .mockReturnValueOnce(secondRender.promise);

    render(<App />);
    await uploadFile(createFile('stale-render.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-tip="Toggle Before/After"]') as Element);
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);

    const [firstPayload] = workerState.render.mock.calls.map(([payload]) => payload);
    firstRender.resolve(createRenderResult(firstPayload.documentId, firstPayload.revision, 55, 44));
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);

    const secondPayload = workerState.render.mock.calls[1]?.[0];
    secondRender.resolve(createRenderResult(secondPayload.documentId, secondPayload.revision, 77, 55));
    await flushMicrotasks();

    expect(drawImage).toHaveBeenCalledTimes(2);
    expect((drawImage.mock.calls.at(-1)?.[0] as { width: number }).width).toBe(77);
    expect(document.querySelector('[data-tip="Showing Original — click to return"]')).toBeTruthy();
  });

  it('applies film-base sampling as a color-balance correction without changing exposure', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number; settings: { exposure: number } }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));
    workerState.sampleFilmBase.mockResolvedValue({ r: 168, g: 151, b: 134 });

    render(<App />);
    await uploadFile(createFile('film-base-sample.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByText('Toggle Film Base Picker'));

    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();

    await act(async () => {
      fireEvent.click(canvas as HTMLCanvasElement, { clientX: 100, clientY: 50 });
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.sampleFilmBase).toHaveBeenCalledWith(expect.objectContaining({
      x: 0.5,
      y: 0.5,
    }));

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        exposure: number;
        temperature: number;
        tint: number;
        redBalance: number;
        greenBalance: number;
        blueBalance: number;
        filmBaseSample: null;
      };
    };

    expect(latestRenderCall.settings.exposure).toBe(0);
    expect(latestRenderCall.settings.temperature).toBe(0);
    expect(latestRenderCall.settings.tint).toBe(0);
    expect(latestRenderCall.settings.filmBaseSample).toBeNull();
    expect(latestRenderCall.settings.redBalance).toBeCloseTo((255 - 151) / (255 - 168));
    expect(latestRenderCall.settings.greenBalance).toBe(1);
    expect(latestRenderCall.settings.blueBalance).toBeCloseTo((255 - 151) / (255 - 134));
  });

  it('keeps advanced inversion auto mode and applies the film-base picker as a standard color-balance correction', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      settings: {
        exposure: number;
        inversionMethod: string;
      };
      advancedInversion?: unknown;
    }) => createRenderResult(payload.documentId, payload.revision, 300, 200));
    workerState.sampleFilmBase.mockResolvedValue({ r: 168, g: 151, b: 134 });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'advanced-hd' } });
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('advanced-film-base-sample.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByText('Toggle Film Base Picker'));

    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();

    await act(async () => {
      fireEvent.click(canvas as HTMLCanvasElement, { clientX: 100, clientY: 50 });
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        exposure: number;
        inversionMethod: string;
        temperature: number;
        tint: number;
        redBalance: number;
        greenBalance: number;
        blueBalance: number;
        filmBaseSample: null;
      };
      advancedInversion?: unknown;
    };

    expect(latestRenderCall.settings.inversionMethod).toBe('advanced-hd');
    expect(latestRenderCall.advancedInversion).toEqual(expect.any(Object));
    expect(latestRenderCall.settings.exposure).toBe(0);
    expect(latestRenderCall.settings.temperature).toBe(0);
    expect(latestRenderCall.settings.tint).toBe(0);
    expect(latestRenderCall.settings.filmBaseSample).toBeNull();
    expect(latestRenderCall.settings.redBalance).toBeCloseTo((255 - 151) / (255 - 168));
    expect(latestRenderCall.settings.greenBalance).toBe(1);
    expect(latestRenderCall.settings.blueBalance).toBeCloseTo((255 - 151) / (255 - 134));
  });

  it('applies worker auto-analysis results from the Auto button', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number; settings: { exposure: number; blackPoint: number; whitePoint: number; temperature: number; tint: number } }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));
    workerState.autoAnalyze.mockResolvedValue({
      exposure: 6,
      blackPoint: 4,
      whitePoint: 238,
      temperature: 22,
      tint: 3,
    });

    render(<App />);
    await uploadFile(createFile('auto-basic.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.autoAnalyze).toHaveBeenCalledTimes(1);
    expect(
      (workerState.autoAnalyze.mock.calls[0]?.[0] as { targetMaxDimension: number }).targetMaxDimension,
    ).toBeLessThanOrEqual(1024);

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        exposure: number;
        blackPoint: number;
        whitePoint: number;
        temperature: number;
        tint: number;
      };
    };

    expect(latestRenderCall.settings.exposure).toBe(6);
    expect(latestRenderCall.settings.blackPoint).toBe(4);
    expect(latestRenderCall.settings.whitePoint).toBe(238);
    expect(latestRenderCall.settings.temperature).toBe(22);
    expect(latestRenderCall.settings.tint).toBe(3);
  });

  it('preserves white balance and shows a notice when auto-analysis finds no neutral candidates', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number; settings: { exposure: number; blackPoint: number; whitePoint: number; temperature: number; tint: number } }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));
    workerState.autoAnalyze.mockResolvedValue({
      exposure: 2,
      blackPoint: 5,
      whitePoint: 240,
      temperature: null,
      tint: null,
    });

    render(<App />);
    await uploadFile(createFile('auto-no-neutrals.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const latestRenderCall = workerState.render.mock.calls.at(-1)?.[0] as {
      settings: {
        exposure: number;
        blackPoint: number;
        whitePoint: number;
        temperature: number;
        tint: number;
      };
    };

    expect(latestRenderCall.settings.exposure).toBe(2);
    expect(latestRenderCall.settings.blackPoint).toBe(5);
    expect(latestRenderCall.settings.whitePoint).toBe(240);
    expect(latestRenderCall.settings.temperature).toBe(0);
    expect(latestRenderCall.settings.tint).toBe(0);
  });

  it('ignores stale auto-analysis results after the active document changes', async () => {
    const autoRequest = deferred<{
      exposure: number;
      blackPoint: number;
      whitePoint: number;
      temperature: number;
      tint: number;
    }>();
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 300, 200)
    ));
    workerState.autoAnalyze.mockReturnValue(autoRequest.promise);

    render(<App />);
    await uploadFile(createFile('auto-stale-1.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    await flushMicrotasks();

    await uploadFile(createFile('auto-stale-2.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const renderCountBeforeResolution = workerState.render.mock.calls.length;
    autoRequest.resolve({
      exposure: 9,
      blackPoint: 6,
      whitePoint: 236,
      temperature: 18,
      tint: 4,
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.length).toBe(renderCountBeforeResolution);
  });

  it('schedules slider drag preview at most once per animation frame in balanced mode', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
      previewMode?: 'draft' | 'settled';
      interactionQuality?: 'balanced' | 'ultra-smooth' | null;
      histogramMode?: 'full' | 'throttled';
      settings: { exposure: number };
    }) => (
      createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension)
    ));

    render(<App />);
    await uploadFile(createFile('drag-balanced.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('Start Drag'));
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Nudge Exposure'));
      fireEvent.click(screen.getByText('Nudge Exposure'));
      fireEvent.click(screen.getByText('Nudge Exposure'));
    });

    expect(workerState.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(16);
      vi.runOnlyPendingTimers();
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);
    expect(workerState.render.mock.calls[1]?.[0]).toMatchObject({
      previewMode: 'draft',
      interactionQuality: 'balanced',
      histogramMode: 'full',
      targetMaxDimension: 512,
    });

    await act(async () => {
      fireEvent.click(screen.getByText('End Drag'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.advanceTimersByTime(140);
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(3);
    expect(workerState.render.mock.calls[2]?.[0]).toMatchObject({
      previewMode: 'settled',
      interactionQuality: null,
      histogramMode: 'full',
    });
  });

  it('persists ultra smooth drag and uses the 512px preview tier during drag', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Smoother Dragging' }));
    });

    expect(JSON.parse(localStorage.getItem('darkslide_preferences_v1') ?? '{}')).toMatchObject({
      ultraSmoothDrag: true,
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('drag-ultra.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Start Drag'));
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Nudge Exposure'));
      vi.advanceTimersByTime(16);
      vi.runOnlyPendingTimers();
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);
    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      previewMode: 'draft',
      interactionQuality: 'ultra-smooth',
      histogramMode: 'throttled',
      targetMaxDimension: 512,
    });
  });

  it('applies the advanced inversion preference only to future color-negative documents', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'advanced-hd' } });
    });

    expect(JSON.parse(localStorage.getItem('darkslide_preferences_v1') ?? '{}')).toMatchObject({
      defaultColorNegativeInversion: 'advanced-hd',
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('advanced-default.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({ inversionMethod: 'advanced-hd' }),
      advancedInversion: expect.any(Object),
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'standard' } });
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(JSON.parse(localStorage.getItem('darkslide_preferences_v1') ?? '{}')).toMatchObject({
      defaultColorNegativeInversion: 'standard',
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Nudge Exposure'));
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({ inversionMethod: 'advanced-hd' }),
      advancedInversion: expect.any(Object),
    });

    await uploadFile(createFile('standard-default.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({ inversionMethod: 'standard' }),
    });
  });

  it('restores advanced inversion payloads when switching back to an earlier tab', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
      settings: { inversionMethod: string };
      advancedInversion?: unknown;
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'advanced-hd' } });
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('first-advanced.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await uploadFile(createFile('second-advanced.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const renderCallsBeforeSwitch = workerState.render.mock.calls.length;
    const tabButtons = screen.getAllByRole('button', { name: 'scan-300x200.tiff' });
    expect(tabButtons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(tabButtons[0]!);
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.length).toBeGreaterThan(renderCallsBeforeSwitch);
    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({ inversionMethod: 'advanced-hd' }),
      advancedInversion: expect.any(Object),
    });
  });

  it('reverts advanced inversion to standard when enabling black and white conversion', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
      settings: {
        inversionMethod: string;
        blackAndWhite: { enabled: boolean };
      };
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'advanced-hd' } });
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('advanced-bw.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({
        inversionMethod: 'advanced-hd',
        blackAndWhite: expect.objectContaining({ enabled: false }),
      }),
      advancedInversion: expect.any(Object),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Toggle Black And White' }));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runAllTimers();
    });
    await flushMicrotasks();

    expect(workerState.render.mock.calls.at(-1)?.[0]).toMatchObject({
      settings: expect.objectContaining({
        inversionMethod: 'standard',
        blackAndWhite: expect.objectContaining({ enabled: true }),
      }),
    });
  });

  it('copies debug info with the resolved color inversion pipeline summary', async () => {
    workerState.decode.mockResolvedValue({
      ...createDecodedImage(300, 200),
      estimatedFilmBaseSample: {
        r: 192,
        g: 185,
        b: 188,
      },
    });
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
      settings: { inversionMethod: string };
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Color' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Advanced inversion'), { target: { value: 'advanced-hd' } });
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await uploadFile(createFile('advanced-default.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Open Settings'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Debug Info' }));
    });

    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText).toHaveBeenCalledTimes(1);

    const report = JSON.parse(writeText.mock.calls[0]?.[0] as string);
    expect(report.pipeline.colorInversion).toMatchObject({
      requestedMethod: 'advanced-hd',
      resolvedMethod: 'advanced-hd',
      activePipeline: 'advanced-hd',
      advancedSupportedByProfile: true,
      baseSampleSource: 'auto-estimated-border-sample',
    });
  });

  it('does not enqueue a second settled render when only histogram state changes', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => {
      const result = createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension);
      result.histogram.l[250] = 10;
      result.highlightDensity = 0;
      return result;
    });

    render(<App />);
    await uploadFile(createFile('settled-once.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);
  });

  it('runs at most one settled highlight-density follow-up for the same stable preview input', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
      highlightDensityEstimate?: number;
    }) => {
      const result = createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension);
      if (payload.revision === 1) {
        expect(payload.highlightDensityEstimate ?? 0).toBe(0);
        result.highlightDensity = 0.25;
      } else if (payload.revision === 2) {
        expect(payload.highlightDensityEstimate).toBeCloseTo(0.25, 5);
        result.highlightDensity = 0.25;
      }
      return result;
    });

    render(<App />);
    await uploadFile(createFile('settled-follow-up.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);
    expect(workerState.render.mock.calls[1]?.[0]).toMatchObject({
      previewMode: 'settled',
      interactionQuality: null,
    });
  });

  it('evicts inactive document previews when worker memory crosses the high-water mark', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);
    await uploadFile(createFile('first-memory.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const firstDocumentId = workerState.render.mock.calls[0]?.[0]?.documentId as string;

    await uploadFile(createFile('second-memory.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const baseDiagnostics = await workerState.getGPUDiagnostics.mock.results[0]?.value;
    const onBackendDiagnosticsChange = workerState.constructorOptions[0]?.onBackendDiagnosticsChange as
      | ((diagnostics: Record<string, unknown>) => void)
      | undefined;

    await act(async () => {
      onBackendDiagnosticsChange?.({
        ...baseDiagnostics,
        workerMemory: {
          documentCount: 2,
          totalPreviewCanvases: 10,
          tileJobCount: 0,
          cancelledJobCount: 0,
          estimatedMemoryBytes: 800 * 1024 * 1024,
        },
      });
    });
    await flushMicrotasks();

    expect(workerState.evictPreviews).toHaveBeenCalledWith(firstDocumentId);
    const secondDocumentId = workerState.render.mock.calls.at(-1)?.[0]?.documentId as string;
    expect(workerState.evictPreviews).not.toHaveBeenCalledWith(secondDocumentId);
  });

  it('attaches wheel zoom after an image loads and commits a settled zoom render', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(5000, 3000));
    workerState.render.mockImplementation(async (payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension));

    render(<App />);
    await uploadFile(createFile('wheel-zoom.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);
    const initialTargetDimension = workerState.render.mock.calls[0]?.[0]?.targetMaxDimension as number;

    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(canvas as HTMLCanvasElement, {
        deltaY: -100,
        clientX: 100,
        clientY: 50,
      });
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);
    expect(workerState.render.mock.calls[1]?.[0]).toMatchObject({
      previewMode: 'settled',
      interactionQuality: null,
      histogramMode: 'full',
    });
    expect((workerState.render.mock.calls[1]?.[0]?.targetMaxDimension as number)).toBeGreaterThan(initialTargetDimension);
  });

  it('shows a rendering indicator for heavier settled preview renders', async () => {
    const settledRender = deferred<ReturnType<typeof createRenderResult>>();
    workerState.decode.mockResolvedValue(createDecodedImage(5000, 3000));
    workerState.render.mockImplementation((payload: {
      documentId: string;
      revision: number;
      targetMaxDimension: number;
    }) => {
      if (payload.revision === 2) {
        return settledRender.promise;
      }

      return Promise.resolve(
        createRenderResult(payload.documentId, payload.revision, payload.targetMaxDimension, payload.targetMaxDimension),
      );
    });

    render(<App />);
    await uploadFile(createFile('render-indicator.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(canvas as HTMLCanvasElement, {
        deltaY: -100,
        clientX: 100,
        clientY: 50,
      });
    });
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    await flushMicrotasks();

    expect(screen.getByText('Rendering...')).toBeInTheDocument();

    await act(async () => {
      const secondPayload = workerState.render.mock.calls[1]?.[0] as {
        documentId: string;
        revision: number;
        targetMaxDimension: number;
      };
      settledRender.resolve(createRenderResult(
        secondPayload.documentId,
        secondPayload.revision,
        secondPayload.targetMaxDimension,
        secondPayload.targetMaxDimension,
      ));
    });
    await flushMicrotasks();
    expect(screen.queryByText('Rendering...')).not.toBeInTheDocument();
  });

  it('uses worker-prepared bitmaps for large settled previews instead of main-thread createImageBitmap', async () => {
    const createImageBitmapMock = vi.mocked(globalThis.createImageBitmap);
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 4000, 3000)
    ));

    render(<App />);
    await uploadFile(createFile('large-worker-bitmap.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.preparePreviewBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(workerState.recordPreviewPresentationTimings).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        workerBitmapPrepMs: expect.any(Number),
      }),
    );
  });

  it('keeps smaller settled previews on the main-thread createImageBitmap path', async () => {
    const createImageBitmapMock = vi.mocked(globalThis.createImageBitmap);
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 2048, 1365)
    ));

    render(<App />);
    await uploadFile(createFile('small-main-thread-bitmap.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.preparePreviewBitmap).not.toHaveBeenCalled();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to main-thread createImageBitmap when worker bitmap preparation fails', async () => {
    const createImageBitmapMock = vi.mocked(globalThis.createImageBitmap);
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.preparePreviewBitmap.mockRejectedValueOnce(new Error('bitmap prep unavailable'));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 4000, 3000)
    ));

    render(<App />);
    await uploadFile(createFile('worker-bitmap-fallback.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.preparePreviewBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
  });

  it('retains preview image data for redraws after a worker-prepared bitmap render', async () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context);

    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 4000, 3000)
    ));

    render(<App />);
    await uploadFile(createFile('worker-bitmap-redraw.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(context.drawImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-tip="Toggle Before/After"]') as Element);
    });
    await flushMicrotasks();

    expect(context.putImageData).toHaveBeenCalled();
  });

  it('does not redraw a closed document when an in-flight render finishes late', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      drawImage,
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);

    const renderRequest = deferred<ReturnType<typeof createRenderResult>>();
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockReturnValueOnce(renderRequest.promise);

    render(<App />);
    await uploadFile(createFile('close-me.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-tip="Close Image"]') as Element);
    });

    const [payload] = workerState.render.mock.calls[0];
    renderRequest.resolve(createRenderResult(payload.documentId, payload.revision, 88, 66));
    await flushMicrotasks();

    expect(screen.getByText('Drop your negatives here')).toBeInTheDocument();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('closes worker-prepared bitmaps when a large preview result becomes stale after the document closes', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      drawImage,
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);

    const preparePreviewBitmapRequest = deferred<ImageBitmap>();
    const close = vi.fn();
    const preparedBitmap = {
      width: 4000,
      height: 3000,
      close,
    } as unknown as ImageBitmap;
    workerState.preparePreviewBitmap.mockReturnValueOnce(preparePreviewBitmapRequest.promise);

    const renderRequest = deferred<ReturnType<typeof createRenderResult>>();
    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockReturnValueOnce(renderRequest.promise);

    render(<App />);
    await uploadFile(createFile('close-large-worker-bitmap.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    const [payload] = workerState.render.mock.calls[0];
    renderRequest.resolve(createRenderResult(payload.documentId, payload.revision, 4000, 3000));
    await flushMicrotasks();
    expect(workerState.preparePreviewBitmap).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-tip="Close Image"]') as Element);
    });
    preparePreviewBitmapRequest.resolve(preparedBitmap);
    await flushMicrotasks();

    expect(screen.getByText('Drop your negatives here')).toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('rebuilds preview image data when the worker-cloned dimensions are zero', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      drawImage,
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);

    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => ({
      documentId: payload.documentId,
      revision: payload.revision,
      width: 80,
      height: 60,
      previewLevelId: 'preview-1024',
      imageData: {
        data: new Uint8ClampedArray(80 * 60 * 4),
        width: 0,
        height: 0,
      } as ImageData,
      histogram: {
        r: new Array(256).fill(0),
        g: new Array(256).fill(0),
        b: new Array(256).fill(0),
        l: new Array(256).fill(0),
      },
    }));

    render(<App />);
    await uploadFile(createFile('webkit-preview.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect((drawImage.mock.calls[0]?.[0] as { width: number }).width).toBe(80);
    expect((drawImage.mock.calls[0]?.[0] as { height: number }).height).toBe(60);
  });

  it('falls back to a plain 2d context when WebKit rejects willReadFrequently', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId, options) => {
      if (contextId !== '2d') {
        return null;
      }

      if (options && typeof options === 'object' && 'willReadFrequently' in options) {
        return null;
      }

      return {
        clearRect: vi.fn(),
        drawImage,
        putImageData: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 80, 60)
    ));

    render(<App />);
    await uploadFile(createFile('webkit-context.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect((drawImage.mock.calls[0]?.[0] as { width: number }).width).toBe(80);
    expect((drawImage.mock.calls[0]?.[0] as { height: number }).height).toBe(60);
  });

  it('retries preview drawing when the first canvas context acquisition misses', async () => {
    const drawImage = vi.fn();
    let getContextAttempts = 0;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId) => {
      if (contextId !== '2d') {
        return null;
      }

      getContextAttempts += 1;
      if (getContextAttempts <= 2) {
        return null;
      }

      return {
        clearRect: vi.fn(),
        drawImage,
        putImageData: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    workerState.decode.mockResolvedValue(createDecodedImage(300, 200));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 80, 60)
    ));

    render(<App />);
    await uploadFile(createFile('second-open-race.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect((drawImage.mock.calls[0]?.[0] as { width: number }).width).toBe(80);
    expect((drawImage.mock.calls[0]?.[0] as { height: number }).height).toBe(60);
  });

  it('opens files through the native dialog when running in the desktop shell', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({ file: createFile('desktop-open.tiff', 'image/tiff'), path: '/Users/tester/desktop-open.tiff' });
    workerState.decode.mockResolvedValue(createDecodedImage(640, 480));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 64, 48)
    ));

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Import'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(fileBridgeState.openImageFile).toHaveBeenCalledTimes(1);
    expect(workerState.decode).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/640 × 480 px/)).toBeInTheDocument();
  });

  it('returns to ready when a native export is cancelled', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({ file: createFile('export-cancel.tiff', 'image/tiff'), path: '/Users/tester/export-cancel.tiff' });
    fileBridgeState.saveExportBlob.mockResolvedValue('cancelled');
    workerState.decode.mockResolvedValue(createDecodedImage(512, 512));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 80, 80)
    ));
    workerState.export.mockResolvedValue({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      filename: 'export-cancel.jpg',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Import'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });
    await flushMicrotasks();

    expect(workerState.export).toHaveBeenCalledTimes(1);
    expect(fileBridgeState.saveExportBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      'export-cancel.jpg',
      'image/jpeg',
    );
    expect(exportNotificationState.notifyExportFinished).not.toHaveBeenCalled();
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.queryByText(/Export failed/i)).not.toBeInTheDocument();
  });

  it('notifies after a successful export save completes', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue({ file: createFile('notify.tiff', 'image/tiff'), path: '/Users/tester/notify.tiff' });
    workerState.decode.mockResolvedValue(createDecodedImage(512, 512));
    workerState.render.mockImplementation(async (payload: { documentId: string; revision: number }) => (
      createRenderResult(payload.documentId, payload.revision, 80, 80)
    ));
    workerState.export.mockResolvedValue({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      filename: 'notify.jpg',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByText('Import'));
    });
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });
    await flushMicrotasks();

    expect(exportNotificationState.primeExportNotificationsPermission).toHaveBeenCalledTimes(1);
    expect(exportNotificationState.notifyExportFinished).toHaveBeenCalledWith({
      kind: 'export',
      filename: 'notify.jpg',
    });
  });

  it('passes an edited export filename to the worker export request', async () => {
    workerState.decode.mockResolvedValue(createDecodedImage(4032, 6048));
    workerState.render.mockResolvedValue(createRenderResult('doc-1', 1, 64, 48));
    workerState.export.mockResolvedValue({
      blob: new Blob(['ok'], { type: 'image/jpeg' }),
      filename: 'renamed.jpg',
    });

    render(<App />);
    await uploadFile(createFile('scan-a.tiff', 'image/tiff'));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    fireEvent.change(screen.getByLabelText('Filename'), { target: { value: 'renamed-export' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sidebar Export' }));
    });

    expect(workerState.export).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        filenameBase: 'renamed-export',
      }),
    }));
  });
});
