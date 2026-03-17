import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_SIZE_BYTES } from './constants';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const workerState = vi.hoisted(() => ({
  decode: vi.fn(),
  render: vi.fn(),
  export: vi.fn(),
  sampleFilmBase: vi.fn(),
  disposeDocument: vi.fn(async () => ({ disposed: true })),
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
}));

const coreState = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  openImageFile: vi.fn(),
  openImageFileByPath: vi.fn(),
  saveExportBlob: vi.fn<(...args: unknown[]) => Promise<'saved' | 'cancelled'>>(),
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

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({
    exportOptions,
    onInteractionStart,
    onInteractionEnd,
    onOpenSettings,
    onSettingsChange,
    onExportOptionsChange,
    onExport,
    onTogglePicker,
  }: {
    exportOptions: { filenameBase: string };
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    onOpenSettings: () => void;
    onSettingsChange: (settings: { exposure?: number }) => void;
    onExportOptionsChange: (options: { filenameBase?: string }) => void;
    onExport: () => void;
    onTogglePicker: () => void;
  }) => {
    const [exposure, setExposure] = React.useState(0);

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
  }: {
    builtinProfiles?: Array<{ id: string; name: string }>;
    customPresets?: Array<{ id: string; name: string }>;
    onStockChange: (profile: { id: string; name: string }) => void;
  }) => (
    <div data-testid="presets">
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreState.invoke,
}));

vi.mock('./hooks/useCustomPresets', () => ({
  useCustomPresets: () => ({
    customPresets: [],
    savePreset: vi.fn(),
    importPreset: vi.fn(),
    deletePreset: vi.fn(),
  }),
}));

vi.mock('./utils/imageWorkerClient', () => ({
  ImageWorkerClient: class MockImageWorkerClient {
    constructor(options: Record<string, unknown> = {}) {
      workerState.constructorOptions.push(options);
    }

    decode = workerState.decode;

    render = workerState.render;

    export = workerState.export;

    sampleFilmBase = workerState.sampleFilmBase;

    disposeDocument = workerState.disposeDocument;

    setGPUEnabled = workerState.setGPUEnabled;

    getGPUDiagnostics = workerState.getGPUDiagnostics;

    noteCoalescedPreviewRequest = vi.fn();

    cancelActivePreviewRender = vi.fn(async () => undefined);

    terminate = vi.fn();
  },
}));

vi.mock('./utils/fileBridge', () => ({
  isDesktopShell: fileBridgeState.isDesktopShell,
  openImageFile: fileBridgeState.openImageFile,
  openImageFileByPath: fileBridgeState.openImageFileByPath,
  saveExportBlob: fileBridgeState.saveExportBlob,
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
    coreState.invoke.mockReset();
    workerState.decode.mockReset();
    workerState.render.mockReset();
    workerState.export.mockReset();
    workerState.sampleFilmBase.mockReset();
    workerState.disposeDocument.mockClear();
    workerState.setGPUEnabled.mockReset();
    workerState.getGPUDiagnostics.mockClear();
    workerState.constructorOptions = [];
    fileBridgeState.isDesktopShell.mockReturnValue(false);
    fileBridgeState.openImageFile.mockReset();
    fileBridgeState.openImageFileByPath.mockReset();
    fileBridgeState.saveExportBlob.mockReset();
    fileBridgeState.saveExportBlob.mockResolvedValue('saved');

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
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
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      putImageData,
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

    expect(putImageData).toHaveBeenCalledTimes(2);
    expect((putImageData.mock.calls.at(-1)?.[0] as ImageData).width).toBe(77);
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
      fireEvent.click(screen.getByRole('switch', { name: 'Ultra Smooth Drag' }));
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

  it('does not redraw a closed document when an in-flight render finishes late', async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      putImageData,
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
    expect(putImageData).not.toHaveBeenCalled();
  });

  it('rebuilds preview image data when the worker-cloned dimensions are zero', async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      putImageData,
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

    expect(putImageData).toHaveBeenCalledTimes(1);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).width).toBe(80);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).height).toBe(60);
  });

  it('falls back to a plain 2d context when WebKit rejects willReadFrequently', async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId, options) => {
      if (contextId !== '2d') {
        return null;
      }

      if (options && typeof options === 'object' && 'willReadFrequently' in options) {
        return null;
      }

      return {
        clearRect: vi.fn(),
        putImageData,
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

    expect(putImageData).toHaveBeenCalledTimes(1);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).width).toBe(80);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).height).toBe(60);
  });

  it('retries preview drawing when the first canvas context acquisition misses', async () => {
    const putImageData = vi.fn();
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
        putImageData,
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

    expect(putImageData).toHaveBeenCalledTimes(1);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).width).toBe(80);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).height).toBe(60);
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
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.queryByText(/Export failed/i)).not.toBeInTheDocument();
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
