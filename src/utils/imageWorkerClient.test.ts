import { beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerMessage = { id: string; type: string; payload: unknown };
type MockLostInfo = { reason?: string; message?: string } | null;

const gpuState = vi.hoisted(() => ({
  create: vi.fn(),
  instance: {
    adapterName: 'Mock GPU',
    limits: {
      maxStorageBufferBindingSize: 512 * 1024 * 1024,
      maxBufferSize: 1024 * 1024 * 1024,
    },
    processPreviewImage: vi.fn(),
    processTile: vi.fn(),
    destroy: vi.fn(),
    isLost: vi.fn(() => false),
    getLostInfo: vi.fn<() => MockLostInfo>(() => null),
  },
}));

const diagnosticsState = vi.hoisted(() => ({
  appendDiagnostic: vi.fn(),
}));

class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;

  onerror: ((event: ErrorEvent) => void) | null = null;

  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postedMessages: WorkerMessage[] = [];

  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: WorkerMessage) {
    this.postedMessages.push(message);
  }
}

async function flushAsyncWork(iterations = 4) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createRenderPayload() {
  return {
    documentId: 'doc-1',
    settings: {
      exposure: 0,
      contrast: 0,
      saturation: 100,
      temperature: 0,
      tint: 0,
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
      blackPoint: 0,
      whitePoint: 255,
      highlightProtection: 0,
      curves: {
        rgb: [],
        red: [],
        green: [],
        blue: [],
      },
      rotation: 0,
      levelAngle: 0,
      crop: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        aspectRatio: null,
      },
      filmBaseSample: null,
      blackAndWhite: {
        enabled: false,
        redMix: 0,
        greenMix: 0,
        blueMix: 0,
        tone: 0,
      },
      sharpen: { enabled: false, radius: 1.0, amount: 50 },
      noiseReduction: { enabled: false, luminanceStrength: 0 },
    },
    isColor: true,
    revision: 1,
    targetMaxDimension: 1024,
    comparisonMode: 'processed' as const,
  };
}

Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: MockWorker,
});

vi.mock('./gpu/WebGPUPipeline', () => ({
  WebGPUPipeline: {
    create: gpuState.create,
  },
}));

vi.mock('./diagnostics', () => ({
  appendDiagnostic: diagnosticsState.appendDiagnostic,
}));

describe('ImageWorkerClient', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    MockWorker.instances = [];
    gpuState.create.mockReset();
    gpuState.create.mockResolvedValue(null);
    gpuState.instance.processPreviewImage.mockReset();
    gpuState.instance.processPreviewImage.mockResolvedValue(new ImageData(new Uint8ClampedArray(4), 1, 1));
    gpuState.instance.processTile.mockReset();
    gpuState.instance.processTile.mockResolvedValue(new ImageData(new Uint8ClampedArray(4), 1, 1));
    gpuState.instance.destroy.mockReset();
    gpuState.instance.isLost.mockReset();
    gpuState.instance.isLost.mockReturnValue(false);
    gpuState.instance.getLostInfo.mockReset();
    gpuState.instance.getLostInfo.mockReturnValue(null);
    diagnosticsState.appendDiagnostic.mockReset();
    Reflect.deleteProperty(navigator, 'gpu');
  });

  it('rejects pending requests on worker crash and recreates the worker', async () => {
    const { FatalImageWorkerError, ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const firstWorker = MockWorker.instances[0];

    const pending = client.decode({
      documentId: 'doc-1',
      buffer: new ArrayBuffer(8),
      fileName: 'scan.tiff',
      mime: 'image/tiff',
      size: 8,
    });

    firstWorker.onerror?.({
      message: 'decoder exploded',
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);

    await expect(pending).rejects.toBeInstanceOf(FatalImageWorkerError);
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances).toHaveLength(2);

    const secondWorker = MockWorker.instances[1];
    const recovered = client.decode({
      documentId: 'doc-2',
      buffer: new ArrayBuffer(4),
      fileName: 'next.tiff',
      mime: 'image/tiff',
      size: 4,
    });
    const requestId = secondWorker.postedMessages[0]?.id;

    secondWorker.onmessage?.({
      data: {
        id: requestId,
        ok: true,
        payload: {
          metadata: {
            id: 'doc-2',
            name: 'next.tiff',
            mime: 'image/tiff',
            extension: '.tiff',
            size: 4,
            width: 10,
            height: 10,
          },
          previewLevels: [],
        },
      },
    } as MessageEvent);

    await expect(recovered).resolves.toMatchObject({
      metadata: {
        id: 'doc-2',
      },
    });
  });

  it('rejects pending requests on message deserialization failures and restarts cleanly', async () => {
    const { FatalImageWorkerError, ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const firstWorker = MockWorker.instances[0];

    const pending = client.render(createRenderPayload());

    await flushAsyncWork(8);
    firstWorker.onmessageerror?.({} as MessageEvent);

    await expect(pending).rejects.toBeInstanceOf(FatalImageWorkerError);
    expect(MockWorker.instances).toHaveLength(2);
  });

  it('times out hung worker requests, rejects the caller, and recreates the worker', async () => {
    vi.useFakeTimers();
    const { ImageWorkerClient, WorkerRequestTimeoutError } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const firstWorker = MockWorker.instances[0];

    const pending = client.render(createRenderPayload());
    const rejection = expect(pending).rejects.toBeInstanceOf(WorkerRequestTimeoutError);
    await flushAsyncWork(8);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances).toHaveLength(2);
  });

  it('re-decodes cached documents after a worker restart before rendering again', async () => {
    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const firstWorker = MockWorker.instances[0];

    const decodeBuffer = new ArrayBuffer(8);
    const decoded = client.decode({
      documentId: 'doc-1',
      buffer: decodeBuffer,
      fileName: 'scan.tiff',
      mime: 'image/tiff',
      size: 8,
    });

    const initialDecodeRequest = firstWorker.postedMessages[0];
    firstWorker.onmessage?.({
      data: {
        id: initialDecodeRequest?.id,
        ok: true,
        payload: {
          metadata: {
            id: 'doc-1',
            name: 'scan.tiff',
            mime: 'image/tiff',
            extension: '.tiff',
            size: 8,
            width: 10,
            height: 10,
          },
          previewLevels: [],
        },
      },
    } as MessageEvent);

    await expect(decoded).resolves.toMatchObject({
      metadata: {
        id: 'doc-1',
      },
    });

    firstWorker.onerror?.({
      message: 'worker restarted',
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);

    const secondWorker = MockWorker.instances[1];
    const pending = client.render({
      documentId: 'doc-1',
      settings: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        blackPoint: 0,
        whitePoint: 255,
        highlightProtection: 0,
        curves: {
          rgb: [],
          red: [],
          green: [],
          blue: [],
        },
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
        filmBaseSample: null,
        blackAndWhite: {
          enabled: false,
          redMix: 0,
          greenMix: 0,
          blueMix: 0,
          tone: 0,
        },
        sharpen: { enabled: false, radius: 1, amount: 0 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 2,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork(8);

    const recoveredDecodeRequest = secondWorker.postedMessages[0];
    expect(recoveredDecodeRequest?.type).toBe('decode');
    expect(recoveredDecodeRequest?.payload).toMatchObject({
      documentId: 'doc-1',
      fileName: 'scan.tiff',
      mime: 'image/tiff',
      size: 8,
    });

    secondWorker.onmessage?.({
      data: {
        id: recoveredDecodeRequest?.id,
        ok: true,
        payload: {
          metadata: {
            id: 'doc-1',
            name: 'scan.tiff',
            mime: 'image/tiff',
            extension: '.tiff',
            size: 8,
            width: 10,
            height: 10,
          },
          previewLevels: [],
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const renderRequest = secondWorker.postedMessages[1];
    expect(renderRequest?.type).toBe('render');
    secondWorker.onmessage?.({
      data: {
        id: renderRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          revision: 2,
          width: 8,
          height: 8,
          previewLevelId: 'preview-1024',
          imageData: new ImageData(new Uint8ClampedArray(256), 8, 8),
          histogram: {
            r: new Array(256).fill(1),
            g: new Array(256).fill(2),
            b: new Array(256).fill(3),
            l: new Array(256).fill(4),
          },
        },
      },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      documentId: 'doc-1',
      revision: 2,
      previewLevelId: 'preview-1024',
    });
  });

  it('retries a render after re-decoding when the worker reports a missing document', async () => {
    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const worker = MockWorker.instances[0];

    const decoded = client.decode({
      documentId: 'doc-1',
      buffer: new ArrayBuffer(8),
      fileName: 'scan.tiff',
      mime: 'image/tiff',
      size: 8,
    });

    const decodeRequest = worker.postedMessages[0];
    worker.onmessage?.({
      data: {
        id: decodeRequest?.id,
        ok: true,
        payload: {
          metadata: {
            id: 'doc-1',
            name: 'scan.tiff',
            mime: 'image/tiff',
            extension: '.tiff',
            size: 8,
            width: 10,
            height: 10,
          },
          previewLevels: [],
        },
      },
    } as MessageEvent);

    await decoded;

    const pending = client.render({
      documentId: 'doc-1',
      settings: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        blackPoint: 0,
        whitePoint: 255,
        highlightProtection: 0,
        curves: {
          rgb: [],
          red: [],
          green: [],
          blue: [],
        },
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
        filmBaseSample: null,
        blackAndWhite: {
          enabled: false,
          redMix: 0,
          greenMix: 0,
          blueMix: 0,
          tone: 0,
        },
        sharpen: { enabled: false, radius: 1, amount: 0 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 5,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork(8);

    const initialRenderRequest = worker.postedMessages[1];
    expect(initialRenderRequest?.type).toBe('render');
    worker.onmessage?.({
      data: {
        id: initialRenderRequest?.id,
        ok: false,
        error: {
          code: 'RENDER_ERROR',
          message: 'The image document is no longer available.',
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const recoveredDecodeRequest = worker.postedMessages[2];
    expect(recoveredDecodeRequest?.type).toBe('decode');
    worker.onmessage?.({
      data: {
        id: recoveredDecodeRequest?.id,
        ok: true,
        payload: {
          metadata: {
            id: 'doc-1',
            name: 'scan.tiff',
            mime: 'image/tiff',
            extension: '.tiff',
            size: 8,
            width: 10,
            height: 10,
          },
          previewLevels: [],
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const retriedRenderRequest = worker.postedMessages[3];
    expect(retriedRenderRequest?.type).toBe('render');
    worker.onmessage?.({
      data: {
        id: retriedRenderRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          revision: 5,
          width: 8,
          height: 8,
          previewLevelId: 'preview-1024',
          imageData: new ImageData(new Uint8ClampedArray(256), 8, 8),
          histogram: {
            r: new Array(256).fill(5),
            g: new Array(256).fill(6),
            b: new Array(256).fill(7),
            l: new Array(256).fill(8),
          },
        },
      },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      documentId: 'doc-1',
      revision: 5,
      previewLevelId: 'preview-1024',
    });
  });

  it('routes render results through the GPU pipeline when available', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    gpuState.create.mockResolvedValue(gpuState.instance);

    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const worker = MockWorker.instances[0];
    gpuState.instance.processPreviewImage.mockResolvedValueOnce(
      new ImageData(new Uint8ClampedArray([
        10, 20, 30, 255,
      ]), 1, 1),
    );

    const pending = client.render({
      documentId: 'doc-1',
      settings: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        blackPoint: 0,
        whitePoint: 255,
        highlightProtection: 0,
        curves: {
          rgb: [],
          red: [],
          green: [],
          blue: [],
        },
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
        filmBaseSample: null,
        blackAndWhite: {
          enabled: false,
          redMix: 0,
          greenMix: 0,
          blueMix: 0,
          tone: 0,
        },
        sharpen: { enabled: false, radius: 1, amount: 0 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 3,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork();

    const prepareRequest = worker.postedMessages[0];
    expect(prepareRequest?.type).toBe('prepare-tile-job');

    worker.onmessage?.({
      data: {
        id: prepareRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:3:preview',
          sourceKind: 'preview',
          width: 1,
          height: 1,
          previewLevelId: 'preview-1024',
          tileSize: 1024,
          halo: 0,
          geometryCacheHit: false,
        },
      },
    } as MessageEvent);

    await flushAsyncWork();

    const tileRequest = worker.postedMessages[1];
    expect(tileRequest?.type).toBe('read-tile');

    worker.onmessage?.({
      data: {
        id: tileRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:3:preview',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          haloLeft: 0,
          haloTop: 0,
          haloRight: 0,
          haloBottom: 0,
          imageData: new ImageData(new Uint8ClampedArray([
            0, 0, 0, 255,
          ]), 1, 1),
        },
      },
    } as MessageEvent);

    await flushAsyncWork();

    const cancelRequest = worker.postedMessages[2];
    expect(cancelRequest?.type).toBe('cancel-job');
    worker.onmessage?.({
      data: {
        id: cancelRequest?.id,
        ok: true,
        payload: {
          cancelled: true,
        },
      },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      documentId: 'doc-1',
      revision: 3,
      width: 1,
      height: 1,
      imageData: expect.any(ImageData),
    });
    expect(gpuState.instance.processPreviewImage).toHaveBeenCalledTimes(1);
  });

  it('throttles ultra smooth draft histograms and suppresses per-frame draft diagnostics', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    gpuState.create.mockResolvedValue(gpuState.instance);
    gpuState.instance.processPreviewImage
      .mockResolvedValueOnce(new ImageData(new Uint8ClampedArray([10, 10, 10, 255]), 1, 1))
      .mockResolvedValueOnce(new ImageData(new Uint8ClampedArray([50, 50, 50, 255]), 1, 1))
      .mockResolvedValueOnce(new ImageData(new Uint8ClampedArray([90, 90, 90, 255]), 1, 1));

    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const worker = MockWorker.instances[0];
    const settings = {
      exposure: 0,
      contrast: 0,
      saturation: 100,
      temperature: 0,
      tint: 0,
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
      blackPoint: 0,
      whitePoint: 255,
      highlightProtection: 0,
      curves: {
        rgb: [],
        red: [],
        green: [],
        blue: [],
      },
      rotation: 0,
      levelAngle: 0,
      crop: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        aspectRatio: null,
      },
      filmBaseSample: null,
      blackAndWhite: {
        enabled: false,
        redMix: 0,
        greenMix: 0,
        blueMix: 0,
        tone: 0,
      },
      sharpen: { enabled: false, radius: 1, amount: 0 },
      noiseReduction: { enabled: false, luminanceStrength: 0 },
    };

    const resolveRender = async (revision: number) => {
      const messageStart = worker.postedMessages.length;
      const pending = client.render({
        documentId: 'doc-1',
        settings,
        isColor: true,
        revision,
        targetMaxDimension: 512,
        comparisonMode: 'processed',
        previewMode: 'draft',
        interactionQuality: 'ultra-smooth',
        histogramMode: 'throttled',
      });

      await flushAsyncWork();

      const prepareRequest = worker.postedMessages[messageStart];
      worker.onmessage?.({
        data: {
          id: prepareRequest?.id,
          ok: true,
          payload: {
            documentId: 'doc-1',
            jobId: `doc-1:${revision}:preview`,
            sourceKind: 'preview',
            width: 1,
            height: 1,
            previewLevelId: 'preview-512',
            tileSize: 1024,
            halo: 0,
            geometryCacheHit: true,
          },
        },
      } as MessageEvent);

      await flushAsyncWork();

      const tileRequest = worker.postedMessages[messageStart + 1];
      worker.onmessage?.({
        data: {
          id: tileRequest?.id,
          ok: true,
          payload: {
            documentId: 'doc-1',
            jobId: `doc-1:${revision}:preview`,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            haloLeft: 0,
            haloTop: 0,
            haloRight: 0,
            haloBottom: 0,
            imageData: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
          },
        },
      } as MessageEvent);

      await flushAsyncWork();

      const cancelRequest = worker.postedMessages[messageStart + 2];
      worker.onmessage?.({
        data: {
          id: cancelRequest?.id,
          ok: true,
          payload: {
            cancelled: true,
          },
        },
      } as MessageEvent);

      return pending;
    };

    const result1 = await resolveRender(1);
    expect(result1.histogram.r[10]).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    const result2 = await resolveRender(2);
    expect(result2.histogram.r[10]).toBe(1);
    expect(result2.histogram.r[50]).toBe(0);

    await vi.advanceTimersByTimeAsync(151);
    const result3 = await resolveRender(3);
    expect(result3.histogram.r[90]).toBe(1);

    const diagnosticsPromise = client.getGPUDiagnostics();
    await flushAsyncWork();
    const diagnosticsRequest = worker.postedMessages.at(-1);
    expect(diagnosticsRequest?.type).toBe('diagnostics');
    worker.onmessage?.({
      data: {
        id: diagnosticsRequest?.id,
        ok: true,
        payload: {
          documentCount: 1,
          totalPreviewCanvases: 3,
          tileJobCount: 0,
          cancelledJobCount: 2,
          estimatedMemoryBytes: 1024,
        },
      },
    } as MessageEvent);

    const diagnostics = await diagnosticsPromise;
    expect(diagnostics.lastPreviewJob).toMatchObject({
      interactionQuality: 'ultra-smooth',
      histogramMode: 'throttled',
      previewLevelId: 'preview-512',
    });
    expect(diagnostics.workerMemory).toMatchObject({
      documentCount: 1,
      totalPreviewCanvases: 3,
      cancelledJobCount: 2,
    });
    expect(diagnosticsState.appendDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'GPU_TILE_JOB_STARTED' }));
    expect(diagnosticsState.appendDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'GPU_TILE_JOB_COMPLETED' }));
  });

  it('falls back to the CPU worker render when GPU processing fails', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    gpuState.create.mockResolvedValue(gpuState.instance);
    gpuState.instance.processPreviewImage.mockRejectedValueOnce(new Error('gpu exploded'));

    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient();
    const worker = MockWorker.instances[0];

    const pending = client.render({
      documentId: 'doc-1',
      settings: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        blackPoint: 0,
        whitePoint: 255,
        highlightProtection: 0,
        curves: {
          rgb: [],
          red: [],
          green: [],
          blue: [],
        },
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
        filmBaseSample: null,
        blackAndWhite: {
          enabled: false,
          redMix: 0,
          greenMix: 0,
          blueMix: 0,
          tone: 0,
        },
        sharpen: { enabled: false, radius: 1, amount: 0 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 4,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork();

    const prepareRequest = worker.postedMessages[0];
    worker.onmessage?.({
      data: {
        id: prepareRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:4:preview',
          sourceKind: 'preview',
          width: 1,
          height: 1,
          previewLevelId: 'preview-1024',
          tileSize: 1024,
          halo: 0,
          geometryCacheHit: true,
        },
      },
    } as MessageEvent);

    await flushAsyncWork();

    const tileRequest = worker.postedMessages[1];
    expect(tileRequest?.type).toBe('read-tile');

    worker.onmessage?.({
      data: {
        id: tileRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:4:preview',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          haloLeft: 0,
          haloTop: 0,
          haloRight: 0,
          haloBottom: 0,
          imageData: new ImageData(new Uint8ClampedArray([
            0, 0, 0, 255,
          ]), 1, 1),
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const cancelRequest = worker.postedMessages[2];
    expect(cancelRequest?.type).toBe('cancel-job');
    worker.onmessage?.({
      data: {
        id: cancelRequest?.id,
        ok: true,
        payload: {
          cancelled: true,
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const cpuRetryRequest = worker.postedMessages.find((message, index) => index > 2 && message.type === 'render');
    expect(cpuRetryRequest).toBeTruthy();

    worker.onmessage?.({
      data: {
        id: cpuRetryRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          revision: 4,
          width: 8,
          height: 8,
          previewLevelId: 'preview-1024',
          imageData: new ImageData(new Uint8ClampedArray(256), 8, 8),
          histogram: {
            r: new Array(256).fill(9),
            g: new Array(256).fill(8),
            b: new Array(256).fill(7),
            l: new Array(256).fill(6),
          },
        },
      },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      histogram: {
        r: expect.arrayContaining([9]),
        g: expect.arrayContaining([8]),
      },
    });
    expect(gpuState.instance.destroy).toHaveBeenCalledTimes(1);
  });

  it('notifies the UI immediately when the GPU device is lost and keeps CPU fallback enabled for the retry', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    gpuState.create.mockResolvedValue(gpuState.instance);
    gpuState.instance.getLostInfo.mockReturnValue({
      reason: 'destroyed',
      message: 'GPU device was lost. DarkSlide will retry on the next render.',
    });
    gpuState.instance.processPreviewImage.mockRejectedValueOnce(new Error('WebGPU device was lost.'));

    const onBackendDiagnosticsChange = vi.fn();
    const onGPUDeviceLost = vi.fn();
    const { ImageWorkerClient } = await import('./imageWorkerClient');
    const client = new ImageWorkerClient({
      onBackendDiagnosticsChange,
      onGPUDeviceLost,
    });
    const worker = MockWorker.instances[0];

    const pending = client.render({
      documentId: 'doc-1',
      settings: {
        exposure: 0,
        contrast: 0,
        saturation: 100,
        temperature: 0,
        tint: 0,
        redBalance: 1,
        greenBalance: 1,
        blueBalance: 1,
        blackPoint: 0,
        whitePoint: 255,
        highlightProtection: 0,
        curves: {
          rgb: [],
          red: [],
          green: [],
          blue: [],
        },
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
        filmBaseSample: null,
        blackAndWhite: {
          enabled: false,
          redMix: 0,
          greenMix: 0,
          blueMix: 0,
          tone: 0,
        },
        sharpen: { enabled: false, radius: 1, amount: 0 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 7,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork();

    const prepareRequest = worker.postedMessages[0];
    worker.onmessage?.({
      data: {
        id: prepareRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:7:preview',
          sourceKind: 'preview',
          width: 1,
          height: 1,
          previewLevelId: 'preview-1024',
          tileSize: 1024,
          halo: 0,
          geometryCacheHit: true,
        },
      },
    } as MessageEvent);

    await flushAsyncWork();

    const tileRequest = worker.postedMessages[1];
    worker.onmessage?.({
      data: {
        id: tileRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          jobId: 'doc-1:7:preview',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          haloLeft: 0,
          haloTop: 0,
          haloRight: 0,
          haloBottom: 0,
          imageData: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const cancelRequest = worker.postedMessages[2];
    worker.onmessage?.({
      data: {
        id: cancelRequest?.id,
        ok: true,
        payload: {
          cancelled: true,
        },
      },
    } as MessageEvent);

    await flushAsyncWork(8);

    const cpuRetryRequest = worker.postedMessages.find((message, index) => index > 2 && message.type === 'render');
    expect(cpuRetryRequest).toBeTruthy();

    worker.onmessage?.({
      data: {
        id: cpuRetryRequest?.id,
        ok: true,
        payload: {
          documentId: 'doc-1',
          revision: 7,
          width: 8,
          height: 8,
          previewLevelId: 'preview-1024',
          imageData: new ImageData(new Uint8ClampedArray(256), 8, 8),
          histogram: {
            r: new Array(256).fill(1),
            g: new Array(256).fill(1),
            b: new Array(256).fill(1),
            l: new Array(256).fill(1),
          },
        },
      },
    } as MessageEvent);

    await expect(pending).resolves.toMatchObject({
      revision: 7,
    });
    expect(onGPUDeviceLost).toHaveBeenCalledWith('GPU device was lost. DarkSlide will retry on the next render.');
    expect(onBackendDiagnosticsChange).toHaveBeenCalledWith(expect.objectContaining({
      gpuDisabledReason: 'device-lost',
    }));
    expect(diagnosticsState.appendDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: 'GPU_DEVICE_LOST',
      level: 'error',
    }));
  });
});
