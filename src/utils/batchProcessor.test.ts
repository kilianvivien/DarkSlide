import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES } from '../constants';
import type { BatchProgressEvent } from '../types';
import { runBatch, type BatchJobEntry } from './batchProcessor';

const fileBridgeState = vi.hoisted(() => ({
  saveExportBlob: vi.fn(async () => 'saved' as const),
  saveToDirectory: vi.fn(async () => 'saved' as const),
  isDesktopShell: vi.fn(() => false),
}));

vi.mock('./fileBridge', () => ({
  saveExportBlob: fileBridgeState.saveExportBlob,
  saveToDirectory: fileBridgeState.saveToDirectory,
  isDesktopShell: fileBridgeState.isDesktopShell,
}));

function createSourceMetadata(id: string) {
  return {
    id,
    name: `${id}.tiff`,
    mime: 'image/tiff',
    extension: '.tiff',
    size: 1,
    width: 300,
    height: 200,
    embeddedColorProfileId: 'srgb' as const,
  };
}

function createHistogramWithHighlightRatio(ratio: number) {
  const total = 1000;
  const highlightCount = Math.round(total * ratio);
  const shadowCount = total - highlightCount;

  return {
    r: Array.from({ length: 256 }, (_, index) => (index >= 240 ? Math.round(highlightCount / 16) : index === 0 ? shadowCount : 0)),
    g: Array.from({ length: 256 }, (_, index) => (index >= 240 ? Math.round(highlightCount / 16) : index === 0 ? shadowCount : 0)),
    b: Array.from({ length: 256 }, (_, index) => (index >= 240 ? Math.round(highlightCount / 16) : index === 0 ? shadowCount : 0)),
    l: Array.from({ length: 256 }, (_, index) => (index >= 240 ? Math.round(highlightCount / 16) : index === 0 ? shadowCount : 0)),
  };
}

async function collectEvents(generator: AsyncGenerator<BatchProgressEvent>) {
  const events: BatchProgressEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe('runBatch auto-analysis', () => {
  beforeEach(() => {
    fileBridgeState.saveExportBlob.mockClear();
    fileBridgeState.saveToDirectory.mockClear();
    fileBridgeState.isDesktopShell.mockReturnValue(false);
  });

  it('keeps temperature and tint unchanged when batch auto-analysis finds no neutral candidates', async () => {
    const sharedSettings = createDefaultSettings({ temperature: 12, tint: 6 });
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const exportCalls: Array<{ settings: typeof sharedSettings }> = [];
    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => null),
      autoAnalyze: vi.fn(async () => ({
        exposure: 4,
        blackPoint: 3,
        whitePoint: 240,
        temperature: null,
        tint: null,
      })),
      export: vi.fn(async (payload: { settings: typeof sharedSettings }) => {
        exportCalls.push(payload);
        return {
          blob: new Blob(['ok'], { type: 'image/jpeg' }),
          filename: 'frame.jpg',
        };
      }),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    } as const;

    const entries: BatchJobEntry[] = [{
      id: 'doc-1',
      kind: 'open-tab',
      documentId: 'doc-1',
      sourceMetadata: createSourceMetadata('doc-1'),
      filename: 'doc-1.tiff',
      size: 1,
      status: 'pending',
    }];

    const events = await collectEvents(runBatch(
      workerClient as never,
      entries,
      sharedSettings,
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoMode: 'per-image' },
    ));

    expect(workerClient.autoAnalyze).toHaveBeenCalledTimes(1);
    expect(exportCalls[0]?.settings).toMatchObject({
      exposure: 4,
      blackPoint: 3,
      whitePoint: 240,
      temperature: 12,
      tint: 6,
    });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('reuses first-frame auto-analysis for later entries', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const exportCalls: Array<{ documentId: string; settings: typeof sharedSettings }> = [];
    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => null),
      autoAnalyze: vi.fn(async () => ({
        exposure: 7,
        blackPoint: 5,
        whitePoint: 236,
        temperature: 18,
        tint: 4,
      })),
      export: vi.fn(async (payload: { documentId: string; settings: typeof sharedSettings }) => {
        exportCalls.push(payload);
        return {
          blob: new Blob(['ok'], { type: 'image/jpeg' }),
          filename: `${payload.documentId}.jpg`,
        };
      }),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    } as const;

    const entries: BatchJobEntry[] = [
      {
        id: 'doc-1',
        kind: 'open-tab',
        documentId: 'doc-1',
        sourceMetadata: createSourceMetadata('doc-1'),
        filename: 'doc-1.tiff',
        size: 1,
        status: 'pending',
      },
      {
        id: 'doc-2',
        kind: 'open-tab',
        documentId: 'doc-2',
        sourceMetadata: createSourceMetadata('doc-2'),
        filename: 'doc-2.tiff',
        size: 1,
        status: 'pending',
      },
    ];

    await collectEvents(runBatch(
      workerClient as never,
      entries,
      sharedSettings,
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoMode: 'first-frame' },
    ));

    expect(workerClient.autoAnalyze).toHaveBeenCalledTimes(1);
    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[0]?.settings).toMatchObject({
      exposure: 7,
      blackPoint: 5,
      whitePoint: 236,
      temperature: 18,
      tint: 4,
    });
    expect(exportCalls[1]?.settings).toMatchObject({
      exposure: 7,
      blackPoint: 5,
      whitePoint: 236,
      temperature: 18,
      tint: 4,
    });
  });

  it('forwards the shared light source bias into auto-analysis and export', async () => {
    const sharedSettings = createDefaultSettings({ inversionMethod: 'advanced-hd' });
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const sharedLightSourceBias: [number, number, number] = [0.92, 0.96, 1];
    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => null),
      autoAnalyze: vi.fn(async () => ({
        exposure: 0,
        blackPoint: 0,
        whitePoint: 255,
        temperature: 0,
        tint: 0,
      })),
      export: vi.fn(async () => ({
        blob: new Blob(['ok'], { type: 'image/jpeg' }),
        filename: 'frame.jpg',
      })),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    } as const;

    await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'doc-1',
        kind: 'open-tab',
        documentId: 'doc-1',
        sourceMetadata: createSourceMetadata('doc-1'),
        filename: 'doc-1.tiff',
        size: 1,
        status: 'pending',
      }],
      sharedSettings,
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      sharedLightSourceBias,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoMode: 'per-image' },
    ));

    expect(workerClient.autoAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      lightSourceBias: sharedLightSourceBias,
    }));
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      lightSourceBias: sharedLightSourceBias,
    }));
  });

  it('reuses the open tab flare and highlight density for batch export', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const estimatedFlare: [number, number, number] = [12, 8, 4];
    const histogram = createHistogramWithHighlightRatio(0.24);
    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => [0, 0, 0] as [number, number, number]),
      autoAnalyze: vi.fn(async () => ({
        exposure: 0,
        blackPoint: 0,
        whitePoint: 255,
        temperature: 0,
        tint: 0,
      })),
      export: vi.fn(async () => ({
        blob: new Blob(['ok'], { type: 'image/jpeg' }),
        filename: 'frame.jpg',
      })),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    } as const;

    await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'doc-1',
        kind: 'open-tab',
        documentId: 'doc-1',
        sourceMetadata: createSourceMetadata('doc-1'),
        filename: 'doc-1.tiff',
        size: 1,
        status: 'pending',
        histogram,
        estimatedFlare,
      }],
      sharedSettings,
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoCrop: false },
    ));

    expect(workerClient.computeFlare).not.toHaveBeenCalled();
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      flareFloor: estimatedFlare,
      highlightDensityEstimate: expect.closeTo(0.24, 2),
    }));
  });

  it('runs highlight analysis for file entries before export', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const workerClient = {
      decode: vi.fn(async () => ({
        metadata: createSourceMetadata('decoded-1'),
        estimatedFlare: [0, 0, 0] as [number, number, number],
      })),
      render: vi.fn(async () => ({
        documentId: 'doc-1',
        revision: 1,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.31),
        highlightDensity: 0.31,
      })),
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => [0, 0, 0] as [number, number, number]),
      autoAnalyze: vi.fn(async () => ({
        exposure: 0,
        blackPoint: 0,
        whitePoint: 255,
        temperature: 0,
        tint: 0,
      })),
      export: vi.fn(async () => ({
        blob: new Blob(['ok'], { type: 'image/jpeg' }),
        filename: 'frame.jpg',
      })),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
      disposeDocument: vi.fn(async () => ({ disposed: true })),
    } as const;

    await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'doc-1',
        kind: 'file',
        file: new File(['abc'], 'doc-1.tiff', { type: 'image/tiff' }),
        filename: 'doc-1.tiff',
        size: 3,
        status: 'pending',
      }],
      sharedSettings,
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoCrop: false },
    ));

    expect(workerClient.render).toHaveBeenCalled();
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      highlightDensityEstimate: expect.closeTo(0.31, 2),
    }));
  });

});
