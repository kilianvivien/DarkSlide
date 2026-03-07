import { beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerMessage = { id: string; type: string; payload: unknown };

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

Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: MockWorker,
});

describe('ImageWorkerClient', () => {
  beforeEach(() => {
    vi.resetModules();
    MockWorker.instances = [];
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

    firstWorker.onmessageerror?.({} as MessageEvent);

    await expect(pending).rejects.toBeInstanceOf(FatalImageWorkerError);
    expect(MockWorker.instances).toHaveLength(2);
  });
});
