import { describe, expect, it } from 'vitest';
import {
  LIGHT_SOURCE_PROFILES,
  createDefaultSettings,
  getSuggestedCsLiteLightSourceId,
  isCsLiteLightSourceId,
  resolveLightSourceIdForProfile,
} from './constants';

describe('createDefaultSettings', () => {
  it('starts with a full-frame crop so imports are not auto-cropped', () => {
    expect(createDefaultSettings().crop).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: null,
    });
    expect(createDefaultSettings().levelAngle).toBe(0);
  });
});

describe('LIGHT_SOURCE_PROFILES', () => {
  it('includes the three CineStill CS-LITE scanning modes', () => {
    expect(LIGHT_SOURCE_PROFILES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cs-lite-cool',
        name: 'CineStill CS-LITE Cool (Color Negative)',
        colorTemperature: 9000,
        spectralBias: [0.82, 0.87, 1.0],
      }),
      expect.objectContaining({
        id: 'cs-lite',
        name: 'CineStill CS-LITE White (B&W)',
        colorTemperature: 5600,
        spectralBias: [1.0, 0.94, 0.88],
      }),
      expect.objectContaining({
        id: 'cs-lite-warm',
        name: 'CineStill CS-LITE Warm (Slide)',
        colorTemperature: 3200,
        spectralBias: [1.0, 0.72, 0.48],
      }),
    ]));
  });

  it('maps film presets to the matching CS-LITE mode and leaves other lights alone', () => {
    expect(isCsLiteLightSourceId('cs-lite-cool')).toBe(true);
    expect(isCsLiteLightSourceId('daylight')).toBe(false);

    expect(getSuggestedCsLiteLightSourceId({ type: 'color', filmType: 'negative' })).toBe('cs-lite-cool');
    expect(getSuggestedCsLiteLightSourceId({ type: 'color', filmType: 'negative' }, { blackAndWhiteEnabled: true })).toBe('cs-lite');
    expect(getSuggestedCsLiteLightSourceId({ type: 'bw', filmType: 'negative' })).toBe('cs-lite');
    expect(getSuggestedCsLiteLightSourceId({ type: 'color', filmType: 'slide' })).toBe('cs-lite-warm');

    expect(resolveLightSourceIdForProfile({ type: 'color', filmType: 'negative' }, 'cs-lite')).toBe('cs-lite-cool');
    expect(resolveLightSourceIdForProfile({ type: 'color', filmType: 'negative' }, 'cs-lite-cool', { blackAndWhiteEnabled: true })).toBe('cs-lite');
    expect(resolveLightSourceIdForProfile({ type: 'bw', filmType: 'negative' }, 'cs-lite-cool')).toBe('cs-lite');
    expect(resolveLightSourceIdForProfile({ type: 'color', filmType: 'slide' }, 'cs-lite')).toBe('cs-lite-warm');
    expect(resolveLightSourceIdForProfile({ type: 'color', filmType: 'negative' }, 'daylight')).toBe('daylight');
    expect(resolveLightSourceIdForProfile({ type: 'color', filmType: 'negative' }, 'auto')).toBeNull();
  });
});
