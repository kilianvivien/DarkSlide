import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  openImageFile: vi.fn(),
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
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock('./components/PresetsPane', () => ({
  PresetsPane: () => <div data-testid="presets" />,
}));

vi.mock('./components/CropOverlay', () => ({
  CropOverlay: () => <div data-testid="crop-overlay" />,
}));

vi.mock('./hooks/useCustomPresets', () => ({
  useCustomPresets: () => ({
    customPresets: [],
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
  }),
}));

vi.mock('./utils/imageWorkerClient', () => ({
  ImageWorkerClient: class MockImageWorkerClient {
    decode = workerState.decode;

    render = workerState.render;

    export = workerState.export;

    sampleFilmBase = workerState.sampleFilmBase;

    disposeDocument = workerState.disposeDocument;

    terminate = vi.fn();
  },
}));

vi.mock('./utils/fileBridge', () => ({
  isDesktopShell: fileBridgeState.isDesktopShell,
  openImageFile: fileBridgeState.openImageFile,
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

function createDecodedImage(width: number, height: number) {
  return {
    metadata: {
      id: `metadata-${width}-${height}`,
      name: `scan-${width}x${height}.tiff`,
      mime: 'image/tiff',
      extension: '.tiff',
      size: width * height,
      width,
      height,
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
    workerState.decode.mockReset();
    workerState.render.mockReset();
    workerState.export.mockReset();
    workerState.sampleFilmBase.mockReset();
    workerState.disposeDocument.mockClear();
    fileBridgeState.isDesktopShell.mockReturnValue(false);
    fileBridgeState.openImageFile.mockReset();
    fileBridgeState.saveExportBlob.mockReset();
    fileBridgeState.saveExportBlob.mockResolvedValue('saved');

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(screen.getByText('4032×6048')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(1);
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

    expect(screen.getByText('20×20')).toBeInTheDocument();

    firstDecode.resolve(createDecodedImage(10, 10));
    await flushMicrotasks();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    await flushMicrotasks();

    expect(screen.getByText('20×20')).toBeInTheDocument();
    expect(screen.queryByText('10×10')).not.toBeInTheDocument();
    expect(workerState.render).toHaveBeenCalledTimes(1);
  });

  it('drops stale render revisions when a newer preview finishes first', async () => {
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
      fireEvent.click(screen.getByTitle('Toggle Before/After'));
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    await flushMicrotasks();

    expect(workerState.render).toHaveBeenCalledTimes(2);

    const [firstPayload, secondPayload] = workerState.render.mock.calls.map(([payload]) => payload);
    secondRender.resolve(createRenderResult(secondPayload.documentId, secondPayload.revision, 77, 55));
    await flushMicrotasks();

    firstRender.resolve(createRenderResult(firstPayload.documentId, firstPayload.revision, 55, 44));
    await flushMicrotasks();

    expect(putImageData).toHaveBeenCalledTimes(1);
    expect((putImageData.mock.calls[0]?.[0] as ImageData).width).toBe(77);
    expect(screen.getByText('Original')).toBeInTheDocument();
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
      fireEvent.click(screen.getByTitle('Close Image'));
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
    fileBridgeState.openImageFile.mockResolvedValue(createFile('desktop-open.tiff', 'image/tiff'));
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
    expect(screen.getByText('640×480')).toBeInTheDocument();
  });

  it('returns to ready when a native export is cancelled', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openImageFile.mockResolvedValue(createFile('export-cancel.tiff', 'image/tiff'));
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
});
