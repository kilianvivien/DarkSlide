import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS } from '../constants';
import { useDocumentTabs } from '../hooks/useDocumentTabs';
import type { CropSource, DetectedFrame, WorkspaceDocument } from '../types';
import { applyStabilizedFrameToTab, planRollFrames, RollFrameMeasurement } from './rollCropStabilization';

function frame(left: number, top: number, width: number, height: number): DetectedFrame {
  return { left, top, right: left + width, bottom: top + height, angle: 0, confidence: 6 };
}

function measurement(id: string, detected: DetectedFrame | null, sourceWidth = 6000, sourceHeight = 4000): RollFrameMeasurement {
  return { id, frame: detected, sourceWidth, sourceHeight };
}

function makeDocument(id: string, options: { rotation?: number; cropSource?: CropSource | null } = {}): WorkspaceDocument {
  return {
    id,
    source: { id, name: `${id}.tiff`, extension: '.tiff', mime: 'image/tiff', size: 100, width: 6000, height: 4000 },
    previewLevels: [],
    settings: createDefaultSettings({ rotation: options.rotation ?? 0 }),
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    profileId: 'generic-color',
    labStyleId: null,
    rollId: 'roll',
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    histogram: null,
    renderRevision: 1,
    status: 'ready',
    dirty: false,
    cropSource: options.cropSource ?? null,
  };
}

describe('planRollFrames', () => {
  it('shares robust median sizes within a group while keeping each measured centre', () => {
    const plan = planRollFrames([
      measurement('a', frame(0.05, 0.06, 0.9, 0.88)),
      measurement('b', frame(0.07, 0.05, 0.86, 0.9)),
      measurement('c', frame(0.04, 0.07, 0.9, 0.88)),
      // A scene edge pulled one detection inward; the median ignores it.
      measurement('d', frame(0.1, 0.06, 0.82, 0.88)),
    ]);

    const b = plan.frames.get('b')!;
    expect(b.right - b.left).toBeCloseTo(0.88, 6);
    expect(b.bottom - b.top).toBeCloseTo(0.88, 6);
    expect((b.left + b.right) / 2).toBeCloseTo(0.07 + 0.86 / 2, 6);
    expect((b.top + b.bottom) / 2).toBeCloseTo(0.05 + 0.9 / 2, 6);
  });

  it('never shares a crop model across scans of different pixel sizes', () => {
    const plan = planRollFrames([
      measurement('a', frame(0.05, 0.05, 0.9, 0.9), 6000, 4000),
      measurement('b', frame(0.06, 0.05, 0.86, 0.9), 6000, 4000),
      measurement('c', frame(0.05, 0.06, 0.9, 0.88), 6000, 4000),
      // Same normalized size, but a portrait scan at a different scale.
      measurement('p', frame(0.2, 0.1, 0.87, 0.89), 4000, 6000),
    ]);

    const portrait = plan.frames.get('p')!;
    expect(portrait.right - portrait.left).toBeCloseTo(0.87, 6);
    expect(portrait.bottom - portrait.top).toBeCloseTo(0.89, 6);
  });

  it('leaves small groups untouched and reports frames without detections', () => {
    const plan = planRollFrames([
      measurement('a', frame(0.05, 0.05, 0.9, 0.9)),
      measurement('b', frame(0.1, 0.1, 0.7, 0.7)),
      measurement('none', null),
    ]);

    expect(plan.frames.get('b')).toMatchObject({ left: 0.1, top: 0.1 });
    expect(plan.frames.get('b')!.right).toBeCloseTo(0.8, 10);
    expect(plan.frames.has('none')).toBe(false);
    expect(plan.undetectedIds).toEqual(['none']);
  });

  it('does not mix different film formats within the same scan size', () => {
    const plan = planRollFrames([
      measurement('a', frame(0.05, 0.05, 0.9, 0.6)),
      measurement('b', frame(0.06, 0.05, 0.9, 0.6)),
      measurement('c', frame(0.05, 0.06, 0.9, 0.6)),
      measurement('square', frame(0.2, 0.05, 0.6, 0.9)),
    ]);

    const square = plan.frames.get('square')!;
    expect(square.right - square.left).toBeCloseTo(0.6, 6);
    expect(square.bottom - square.top).toBeCloseTo(0.9, 6);
  });
});

describe('applyStabilizedFrameToTab', () => {
  it('maps the frame through the tab rotation as one undoable step', () => {
    const { result } = renderHook(() => useDocumentTabs());
    act(() => {
      result.current.openDocument(makeDocument('a', { rotation: 90 }));
    });

    act(() => {
      result.current.updateTabById('a', (tab) => applyStabilizedFrameToTab(tab, frame(0.1, 0.2, 0.7, 0.6), false));
    });
    const tab = result.current.tabs[0];
    expect(tab.document.cropSource).toBe('auto');
    expect(tab.document.settings.crop.x).toBeCloseTo(0.2, 6);
    expect(tab.document.settings.crop.y).toBeCloseTo(0.1, 6);
    expect(tab.document.settings.crop.width).toBeCloseTo(0.6, 6);
    expect(tab.document.settings.crop.height).toBeCloseTo(0.7, 6);
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.tabs[0].document.settings.crop).toEqual(createDefaultSettings().crop);
  });

  it('records an uncommitted earlier edit before the stabilized crop', () => {
    const { result } = renderHook(() => useDocumentTabs());
    act(() => {
      result.current.openDocument(makeDocument('a'));
    });
    // An edit that never reached history (e.g. the tab lost focus first).
    act(() => {
      result.current.updateTabById('a', (tab) => ({
        ...tab,
        document: { ...tab.document, settings: { ...tab.document.settings, exposure: 12 } },
      }));
    });
    act(() => {
      result.current.updateTabById('a', (tab) => applyStabilizedFrameToTab(tab, frame(0.1, 0.1, 0.8, 0.8), false));
    });
    act(() => {
      result.current.undo();
    });

    const restored = result.current.tabs[0].document.settings;
    expect(restored.exposure).toBe(12);
    expect(restored.crop).toEqual(createDefaultSettings().crop);
  });

  it('protects manual crops unless they are explicitly included', () => {
    const { result } = renderHook(() => useDocumentTabs());
    act(() => {
      result.current.openDocument(makeDocument('manual', { cropSource: 'manual' }));
    });
    const original = result.current.tabs[0];

    act(() => {
      result.current.updateTabById('manual', (tab) => applyStabilizedFrameToTab(tab, frame(0.1, 0.1, 0.8, 0.8), false));
    });
    expect(result.current.tabs[0]).toBe(original);

    act(() => {
      result.current.updateTabById('manual', (tab) => applyStabilizedFrameToTab(tab, frame(0.1, 0.1, 0.8, 0.8), true));
    });
    expect(result.current.tabs[0].document.cropSource).toBe('auto');
    expect(result.current.tabs[0].document.settings.crop.width).toBeCloseTo(0.8, 6);
  });
});
