import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES } from '../constants';
import type { BatchProgressEvent } from '../types';
import { runBatch, runBatchConcurrent, type BatchJobEntry } from './batchProcessor';

const fileBridgeState = vi.hoisted(() => ({
  saveExportBlob: vi.fn(async () => 'saved' as const),
  saveToDirectory: vi.fn(async () => 'saved' as const),
  isDesktopShell: vi.fn(() => false),
}));
const rawImportState = vi.hoisted(() => ({
  decodeDesktopRawForWorker: vi.fn(),
}));

vi.mock('./fileBridge', () => ({
  saveExportBlob: fileBridgeState.saveExportBlob,
  saveToDirectory: fileBridgeState.saveToDirectory,
  isDesktopShell: fileBridgeState.isDesktopShell,
}));

vi.mock('./rawImport', async (importOriginal) => ({
  ...await importOriginal<typeof import('./rawImport')>(),
  decodeDesktopRawForWorker: rawImportState.decodeDesktopRawForWorker,
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
    rawImportState.decodeDesktopRawForWorker.mockReset();
  });

  it('returns to profile white balance when batch auto-analysis finds no neutral candidates', async () => {
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
    expect(workerClient.autoAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id,
      settings: expect.objectContaining({
        exposure: 0,
        temperature: 0,
        tint: 0,
      }),
    }));
    expect(exportCalls[0]?.settings).toMatchObject({
      exposure: 4,
      blackPoint: 3,
      whitePoint: 240,
      temperature: profile.defaultSettings.temperature,
      tint: profile.defaultSettings.tint,
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
        whiteBalanceGains: { red: 0.9, green: 1, blue: 1.1 },
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
      temperature: profile.defaultSettings.temperature,
      tint: profile.defaultSettings.tint,
      redBalance: profile.defaultSettings.redBalance * 0.9,
      greenBalance: profile.defaultSettings.greenBalance,
      blueBalance: profile.defaultSettings.blueBalance * 1.1,
    });
    expect(exportCalls[1]?.settings).toMatchObject({
      exposure: 7,
      blackPoint: 5,
      whitePoint: 236,
      temperature: profile.defaultSettings.temperature,
      tint: profile.defaultSettings.tint,
      redBalance: profile.defaultSettings.redBalance * 0.9,
      greenBalance: profile.defaultSettings.greenBalance,
      blueBalance: profile.defaultSettings.blueBalance * 1.1,
    });
  });

  it('passes the selected profile and captured density calibration through batch rendering and export', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'kodak-gold-200')
      ?? FILM_PROFILES.find((candidate) => candidate.id === 'generic-color')
      ?? FILM_PROFILES[0];
    const estimatedDensityBalance = {
      scaleR: 1.08,
      scaleG: 0.99,
      scaleB: 0.93,
      source: 'manual' as const,
    };
    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => null),
      render: vi.fn(async (payload: { documentId: string; revision: number }) => ({
        documentId: payload.documentId,
        revision: payload.revision,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
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
        estimatedDensityBalance,
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

    expect(workerClient.render).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id,
      estimatedDensityBalance,
    }));
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id,
      estimatedDensityBalance,
    }));
  });

  it('pins an open RAW tab calibration when a dedicated batch worker reloads the file', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const estimatedFilmBaseSample = { r: 224, g: 142, b: 92 };
    const estimatedFilmBase = {
      sample: estimatedFilmBaseSample,
      source: 'frame-rebate' as const,
      confidence: 0.94,
      rejectedCandidates: 1,
      clamped: false,
    };
    const estimatedDensityBalance = {
      scaleR: 1.04,
      scaleG: 1,
      scaleB: 0.96,
      source: 'manual' as const,
    };
    rawImportState.decodeDesktopRawForWorker.mockResolvedValue({
      rawResult: { width: 4, height: 3 },
      decodeRequest: {
        documentId: 'raw-doc',
        buffer: new ArrayBuffer(4 * 3 * 4),
        fileName: 'P1075820.RW2',
        mime: 'image/x-raw-rgba',
        size: 1,
        rawDimensions: { width: 4, height: 3 },
      },
    });
    const decode = vi.fn(async (request: {
      precomputedFilmBase?: typeof estimatedFilmBase | null;
      precomputedFilmBaseSample?: typeof estimatedFilmBaseSample | null;
      precomputedDensityBalance?: typeof estimatedDensityBalance | null;
    }) => ({
      metadata: createSourceMetadata('raw-doc'),
      estimatedFlare: [2, 3, 4] as [number, number, number],
      estimatedFilmBaseSample: request.precomputedFilmBaseSample,
      estimatedFilmBase: request.precomputedFilmBase,
      estimatedDensityBalance: request.precomputedDensityBalance,
    }));
    const workerClient = {
      decode,
      detectFrame: vi.fn(async () => null),
      render: vi.fn(async (payload: { documentId: string; revision: number }) => ({
        documentId: payload.documentId,
        revision: payload.revision,
        width: 4,
        height: 3,
        previewLevelId: 'source',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
      })),
      export: vi.fn(async () => ({
        blob: new Blob(['ok'], { type: 'image/jpeg' }),
        filename: 'P1075820.jpg',
      })),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
      disposeDocument: vi.fn(async () => ({ disposed: true })),
    } as const;
    fileBridgeState.isDesktopShell.mockReturnValue(true);

    await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'raw-doc',
        kind: 'file',
        nativePath: '/film1/P1075820.RW2',
        sourceMetadata: createSourceMetadata('raw-doc'),
        filename: 'P1075820.RW2',
        size: 1,
        status: 'pending',
        estimatedFlare: [8, 7, 6],
        estimatedFilmBaseSample,
        estimatedFilmBase,
        estimatedDensityBalance,
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

    expect(decode).toHaveBeenCalledWith(expect.objectContaining({
      precomputedFilmBase: estimatedFilmBase,
      precomputedFilmBaseSample: estimatedFilmBaseSample,
      precomputedDensityBalance: estimatedDensityBalance,
    }));
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id,
      estimatedDensityBalance,
      flareFloor: [8, 7, 6],
    }));
  });

  it('forwards the shared light source bias into auto-analysis and export', async () => {
    const sharedSettings = createDefaultSettings();
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

  it('keeps the color-channel pipeline for a B&W-toggled color profile', async () => {
    const sharedSettings = createDefaultSettings({
      blackAndWhite: { enabled: true, redMix: 0, greenMix: 0, blueMix: 0, tone: 0 },
    });
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    expect(profile.type).toBe('color');

    const workerClient = {
      detectFrame: vi.fn(async () => null),
      computeFlare: vi.fn(async () => null),
      render: vi.fn(async () => ({
        documentId: 'doc-1',
        revision: 1,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
      })),
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
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoMode: 'per-image' },
    ));

    // A B&W toggle on a color profile must still route through the color-channel
    // pipeline (isColor: true) so channel balance, the B&W mixer, residual base
    // correction, and density balance match the single-image preview/export.
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({ isColor: true }));
    expect(workerClient.render).toHaveBeenCalledWith(expect.objectContaining({ isColor: true }));
    expect(workerClient.autoAnalyze).toHaveBeenCalledWith(expect.objectContaining({ isColor: true }));
  });

  it('preserves each open tab rotation, level, and crop during batch export', async () => {
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const workerClient = {
      computeFlare: vi.fn(async () => null),
      render: vi.fn(async () => ({
        documentId: 'rotated',
        revision: 1,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
      })),
      export: vi.fn(async () => ({
        blob: new Blob(['ok'], { type: 'image/jpeg' }),
        filename: 'rotated.jpg',
      })),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    } as const;
    const crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6, aspectRatio: null };

    await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'rotated',
        kind: 'open-tab',
        documentId: 'rotated',
        sourceMetadata: createSourceMetadata('rotated'),
        filename: 'rotated.tiff',
        size: 1,
        status: 'pending',
        geometry: { rotation: 90, levelAngle: 1.5, crop },
      }],
      createDefaultSettings(),
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoCrop: false },
    ));

    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        rotation: 90,
        levelAngle: 1.5,
        crop,
      }),
    }));
  });

  it('runs independent entries on three workers and emits one completion event', async () => {
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    let activeExports = 0;
    let maximumActiveExports = 0;
    let releaseExports: (() => void) | undefined;
    const exportGate = new Promise<void>((resolve) => {
      releaseExports = resolve;
    });
    const createWorker = () => ({
      computeFlare: vi.fn(async () => null),
      render: vi.fn(async (payload: { documentId: string }) => ({
        documentId: payload.documentId,
        revision: 1,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
      })),
      export: vi.fn(async () => {
        activeExports += 1;
        maximumActiveExports = Math.max(maximumActiveExports, activeExports);
        if (activeExports === 3) releaseExports?.();
        await exportGate;
        activeExports -= 1;
        return { blob: new Blob(['ok'], { type: 'image/jpeg' }), filename: 'frame.jpg' };
      }),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    });
    const entries: BatchJobEntry[] = Array.from({ length: 6 }, (_, index) => ({
      id: `doc-${index}`,
      kind: 'open-tab',
      documentId: `doc-${index}`,
      sourceMetadata: createSourceMetadata(`doc-${index}`),
      filename: `doc-${index}.tiff`,
      size: 1,
      status: 'pending',
    }));

    const events = await collectEvents(runBatchConcurrent(
      [createWorker(), createWorker(), createWorker()] as never,
      entries,
      createDefaultSettings(),
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoCrop: false },
    ));

    expect(maximumActiveExports).toBe(3);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(6);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  });

  it('stops a cancelled active export without saving or marking the entry as failed', async () => {
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const cancelToken = { cancelled: false };
    const workerClient = {
      computeFlare: vi.fn(async () => null),
      render: vi.fn(async (payload: { documentId: string }) => ({
        documentId: payload.documentId,
        revision: 1,
        width: 100,
        height: 100,
        previewLevelId: 'preview-1024',
        imageData: new ImageData(1, 1),
        histogram: createHistogramWithHighlightRatio(0.2),
        highlightDensity: 0.2,
      })),
      export: vi.fn(async () => {
        cancelToken.cancelled = true;
        const error = new Error('The image export was cancelled.');
        error.name = 'ImageExportCancelledError';
        throw error;
      }),
      evictPreviews: vi.fn(async () => ({ evicted: true })),
    };

    const events = await collectEvents(runBatch(
      workerClient as never,
      [{
        id: 'doc-cancelled',
        kind: 'open-tab',
        documentId: 'doc-cancelled',
        sourceMetadata: createSourceMetadata('doc-cancelled'),
        filename: 'doc-cancelled.tiff',
        size: 1,
        status: 'pending',
      }],
      createDefaultSettings(),
      profile,
      null,
      DEFAULT_COLOR_MANAGEMENT,
      null,
      DEFAULT_EXPORT_OPTIONS,
      null,
      cancelToken,
      { autoCrop: false },
    ));

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(fileBridgeState.saveExportBlob).not.toHaveBeenCalled();
  });

});
