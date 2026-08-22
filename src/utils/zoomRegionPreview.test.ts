import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { createRegionSettings, getVisiblePreviewRect, planRawZoomRegion } from './zoomRegionPreview';

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}

describe('getVisiblePreviewRect', () => {
  it('returns the visible canvas area with bounded overscan', () => {
    const visible = getVisiblePreviewRect(rect(-500, 0, 2000, 1000), rect(0, 0, 1000, 1000));
    expect(visible?.x).toBeCloseTo(0.175, 8);
    expect(visible?.y).toBe(0);
    expect(visible?.width).toBeCloseTo(0.65, 8);
    expect(visible?.height).toBe(1);
  });
});

describe('planRawZoomRegion', () => {
  it('maps an output crop back to a padded source rectangle', () => {
    const settings = createDefaultSettings();
    const plan = planRawZoomRegion({
      sourceWidth: 6000,
      sourceHeight: 4000,
      settings,
      displayRect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });

    expect(plan.sourceRegion).toEqual({ x: 1404, y: 904, width: 3192, height: 2192 });
    expect(plan.localCrop.x).toBeCloseTo(96 / 3192, 6);
    expect(plan.localCrop.y).toBeCloseTo(96 / 2192, 6);
    expect(plan.localCrop.width).toBeCloseTo(3000 / 3192, 6);
    expect(plan.localCrop.height).toBeCloseTo(2000 / 2192, 6);
  });

  it('maps a rotated output rectangle into source space', () => {
    const settings = createDefaultSettings({ rotation: 90 });
    const plan = planRawZoomRegion({
      sourceWidth: 6000,
      sourceHeight: 4000,
      settings,
      displayRect: { x: 0, y: 0, width: 0.5, height: 1 },
    });

    expect(plan.sourceRegion.x).toBe(0);
    expect(plan.sourceRegion.width).toBe(6000);
    expect(plan.sourceRegion.y).toBeLessThanOrEqual(2000);
    expect(plan.sourceRegion.y + plan.sourceRegion.height).toBe(4000);
    expect(plan.localCrop.width).toBeLessThan(1);
  });
});

describe('createRegionSettings', () => {
  it('rebases source-space dust marks into the downloaded region', () => {
    const settings = createDefaultSettings({
      dustRemoval: {
        autoEnabled: false,
        autoDetectMode: 'both',
        autoSensitivity: 50,
        autoMaxRadius: 8,
        manualBrushRadius: 10,
        marks: [{ id: 'center', kind: 'spot', cx: 0.5, cy: 0.5, radius: 0.01, source: 'manual' }],
      },
    });
    const plan = planRawZoomRegion({
      sourceWidth: 6000,
      sourceHeight: 4000,
      settings,
      displayRect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });
    const regionSettings = createRegionSettings(settings, 6000, 4000, plan);
    const mark = regionSettings.dustRemoval?.marks[0];

    expect(mark?.kind).toBe('spot');
    if (mark?.kind === 'spot') {
      expect(mark.cx).toBeCloseTo(0.5, 6);
      expect(mark.cy).toBeCloseTo(0.5, 6);
      expect(mark.radius).toBeGreaterThan(0.01);
    }
  });
});
