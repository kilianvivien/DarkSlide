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

  it('forwards shared roll calibration into auto-analysis and export', async () => {
    const sharedSettings = createDefaultSettings();
    const profile = FILM_PROFILES.find((candidate) => candidate.id === 'generic-color') ?? FILM_PROFILES[0];
    const sharedRollCalibration = {
      enabled: true,
      baseSample: { r: 245, g: 245, b: 245 },
      neutralSamples: [],
      slopes: [1.1, 1, 0.9] as [number, number, number],
      offsets: [0.05, 0, -0.03] as [number, number, number],
      updatedAt: Date.now(),
    };
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
      sharedRollCalibration,
      DEFAULT_EXPORT_OPTIONS,
      null,
      { cancelled: false },
      { autoMode: 'per-image' },
    ));

    expect(workerClient.autoAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      rollCalibration: sharedRollCalibration,
    }));
    expect(workerClient.export).toHaveBeenCalledWith(expect.objectContaining({
      rollCalibration: sharedRollCalibration,
    }));
  });
});
