import { beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerMessage = { id: string; type: string; payload: unknown };

const gpuState = vi.hoisted(() => ({
  create: vi.fn(),
  instance: {
    adapterName: 'Mock GPU',
    limits: {
      maxStorageBufferBindingSize: 512 * 1024 * 1024,
      maxBufferSize: 1024 * 1024 * 1024,
    },
    processTile: vi.fn(),
    destroy: vi.fn(),
    isLost: vi.fn(() => false),
  },
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

describe('ImageWorkerClient', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWorker.instances = [];
    gpuState.create.mockReset();
    gpuState.create.mockResolvedValue(null);
    gpuState.instance.processTile.mockReset();
    gpuState.instance.processTile.mockResolvedValue(new ImageData(new Uint8ClampedArray(4), 1, 1));
    gpuState.instance.destroy.mockReset();
    gpuState.instance.isLost.mockReset();
    gpuState.instance.isLost.mockReturnValue(false);
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
        sharpen: { enabled: false, radius: 1.0, amount: 50 },
        noiseReduction: { enabled: false, luminanceStrength: 0 },
      },
      isColor: true,
      revision: 1,
      targetMaxDimension: 1024,
      comparisonMode: 'processed',
    });

    await flushAsyncWork(8);
    firstWorker.onmessageerror?.({} as MessageEvent);

    await expect(pending).rejects.toBeInstanceOf(FatalImageWorkerError);
    expect(MockWorker.instances).toHaveLength(2);
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
    gpuState.instance.processTile.mockResolvedValueOnce(
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
    expect(gpuState.instance.processTile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the CPU worker render when GPU processing fails', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    gpuState.create.mockResolvedValue(gpuState.instance);
    gpuState.instance.processTile.mockRejectedValueOnce(new Error('gpu exploded'));

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
});
