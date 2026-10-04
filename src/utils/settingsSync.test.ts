import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { mergeSyncedSettings } from './settingsSync';

describe('mergeSyncedSettings', () => {
  it('copies the look but keeps each frame\'s geometry and dust repairs', () => {
    const source = createDefaultSettings({
      exposure: 25,
      temperature: -8,
      rotation: 90,
      levelAngle: 1.5,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, aspectRatio: null },
      dustRemoval: { autoEnabled: true, autoDetectMode: 'both', autoSensitivity: 70, autoMaxRadius: 12, manualBrushRadius: 9, marks: [{ id: 's', cx: 0.1, cy: 0.1, radius: 0.01, source: 'manual' }] as never },
    });
    const target = createDefaultSettings({
      rotation: 0,
      levelAngle: -0.4,
      crop: { x: 0.2, y: 0.05, width: 0.7, height: 0.8, aspectRatio: null },
      dustRemoval: { autoEnabled: false, autoDetectMode: 'spots', autoSensitivity: 40, autoMaxRadius: 6, manualBrushRadius: 4, marks: [{ id: 't', cx: 0.5, cy: 0.5, radius: 0.02, source: 'manual' }] as never },
    });

    const merged = mergeSyncedSettings(source, target);
    expect(merged.exposure).toBe(25);
    expect(merged.temperature).toBe(-8);
    expect(merged.rotation).toBe(0);
    expect(merged.levelAngle).toBe(-0.4);
    expect(merged.crop).toEqual(target.crop);
    expect(merged.dustRemoval?.autoSensitivity).toBe(70);
    expect(merged.dustRemoval?.marks).toEqual(target.dustRemoval?.marks);
    // No shared references with either input.
    expect(merged.crop).not.toBe(target.crop);
    expect(merged.dustRemoval?.marks).not.toBe(target.dustRemoval?.marks);
  });
});
