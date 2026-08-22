import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { captureInstantPreviewBaseline, createInstantCurvePreviewTables, createInstantPreviewFilter } from './instantPreviewFilter';

describe('createInstantPreviewFilter', () => {
  it('does nothing when the visible pixels already match the controls', () => {
    const settings = createDefaultSettings({ exposure: 12, contrast: 20, saturation: 115 });

    expect(createInstantPreviewFilter(
      captureInstantPreviewBaseline(settings, 'processed'),
      settings,
      'processed',
    )).toBe('none');
  });

  it('expresses exposure, contrast, and saturation as deltas from the visible frame', () => {
    const baselineSettings = createDefaultSettings({ exposure: 0, contrast: 0, saturation: 100 });
    const currentSettings = createDefaultSettings({ exposure: 50, contrast: 50, saturation: 150 });

    expect(createInstantPreviewFilter(
      captureInstantPreviewBaseline(baselineSettings, 'processed'),
      currentSettings,
      'processed',
    )).toBe('brightness(2.0000) contrast(1.4822) saturate(1.5000)');
  });

  it('does not alter an original-comparison frame', () => {
    const baselineSettings = createDefaultSettings();
    const currentSettings = createDefaultSettings({ contrast: 80 });

    expect(createInstantPreviewFilter(
      captureInstantPreviewBaseline(baselineSettings, 'original'),
      currentSettings,
      'original',
    )).toBe('none');
  });

  it('ignores edits inside disabled tone and color groups', () => {
    const baselineSettings = createDefaultSettings({
      toneEnabled: false,
      colorControlsEnabled: false,
      exposure: 25,
      contrast: 30,
      saturation: 140,
    });
    const currentSettings = createDefaultSettings({
      toneEnabled: false,
      colorControlsEnabled: false,
      exposure: 80,
      contrast: 75,
      saturation: 20,
    });

    expect(createInstantPreviewFilter(
      captureInstantPreviewBaseline(baselineSettings, 'processed'),
      currentSettings,
      'processed',
    )).toBe('none');
  });

  it('creates per-channel transfer tables for a curve edit', () => {
    const baselineSettings = createDefaultSettings();
    const currentSettings = createDefaultSettings({
      curves: {
        ...baselineSettings.curves,
        red: [{ x: 0, y: 0 }, { x: 128, y: 180 }, { x: 255, y: 255 }],
      },
    });

    const tables = createInstantCurvePreviewTables(
      captureInstantPreviewBaseline(baselineSettings, 'processed'),
      currentSettings,
      'processed',
    );

    expect(tables).not.toBeNull();
    expect(tables?.red.split(' ')).toHaveLength(256);
    expect(Number(tables?.red.split(' ')[128])).toBeCloseTo(180 / 255, 4);
    expect(Number(tables?.green.split(' ')[128])).toBeCloseTo(128 / 255, 4);
    expect(Number(tables?.blue.split(' ')[128])).toBeCloseTo(128 / 255, 4);
  });

  it('skips the SVG curve filter when the visible curve is current', () => {
    const settings = createDefaultSettings();

    expect(createInstantCurvePreviewTables(
      captureInstantPreviewBaseline(settings, 'processed'),
      settings,
      'processed',
    )).toBeNull();
  });
});
