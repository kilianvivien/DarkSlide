import { describe, expect, it } from 'vitest';
import {
  ASPECT_RATIOS,
  FILM_PROFILES,
  FILM_STOCK_DENSITY_PRESETS,
  LIGHT_SOURCE_PROFILES,
  createDefaultSettings,
  getSuggestedCsLiteLightSourceId,
  isCsLiteLightSourceId,
  resolveLightSourceIdForProfile,
} from './constants';

const CURRENT_STOCK_ADDITION_IDS = [
  'ektacolor-pro-160',
  'ektacolor-pro-400',
  'ektacolor-pro-800',
  'ektapan-100',
  'ektapan-400',
  'ektapan-p3200',
  'vision3-50d',
  'vision3-200t',
  'verita-200d',
  'ortho-plus',
  'kentmere-100',
  'harman-phoenix-200',
  'harman-red-125',
  'harman-switch-azure',
  'lomo-metropolis',
  'lomo-purple',
  'lomo-turquoise',
  'lomo-classicolor-200',
  'lomo-redscale-xr',
  'lomo-potsdam-100',
  'lomo-berlin-400',
  'cinestill-bwxx',
] as const;

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
    expect(createDefaultSettings()).toMatchObject({
      toneEnabled: true,
      toneRangeEnabled: true,
      whiteBalanceEnabled: true,
      colorControlsEnabled: true,
    });
  });
});

describe('ASPECT_RATIOS', () => {
  it('matches named film formats to their nominal width-to-height ratios', () => {
    const filmRatios = ASPECT_RATIOS.filter((ratio) => ratio.category === 'Film');

    expect(filmRatios).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: '35mm', value: 2 / 3 }),
      expect.objectContaining({ format: '35mm', value: 3 / 2 }),
      expect.objectContaining({ format: 'Half-frame', value: 3 / 4 }),
      expect.objectContaining({ format: 'Half-frame', value: 4 / 3 }),
      expect.objectContaining({ format: '6×4.5', value: 4.5 / 6 }),
      expect.objectContaining({ format: '6×4.5', value: 6 / 4.5 }),
      expect.objectContaining({ format: '6×6', value: 1 }),
      expect.objectContaining({ format: '6×7', value: 6 / 7 }),
      expect.objectContaining({ format: '6×7', value: 7 / 6 }),
      expect.objectContaining({ format: '6×9', value: 6 / 9 }),
      expect.objectContaining({ format: '6×9', value: 9 / 6 }),
    ]));
  });
});

describe('FILM_PROFILES', () => {
  it('includes current manufacturer-backed stock additions', () => {
    const profileIds = FILM_PROFILES.map((profile) => profile.id);

    expect(profileIds).toEqual(expect.arrayContaining([...CURRENT_STOCK_ADDITION_IDS]));
  });

  it('uses unique ids for built-in film profiles', () => {
    const profileIds = FILM_PROFILES.map((profile) => profile.id);

    expect(new Set(profileIds).size).toBe(profileIds.length);
  });

  it('provides density presets for every color negative stock', () => {
    const colorNegativeProfiles = FILM_PROFILES.filter((profile) => (
      profile.type === 'color'
      && (profile.filmType ?? 'negative') === 'negative'
    ));

    for (const profile of colorNegativeProfiles) {
      expect(FILM_STOCK_DENSITY_PRESETS[profile.id], profile.id).toBeTruthy();
    }
  });

  it('keeps Kodak Gold blue density in range instead of collapsing it', () => {
    expect(FILM_STOCK_DENSITY_PRESETS['gold-200']).toEqual({
      scaleR: 2.2,
      scaleG: 1,
      scaleB: 0.86,
    });
  });

  it('keeps built-in profile settings and tonal behavior bounded', () => {
    for (const profile of FILM_PROFILES) {
      expect(profile.defaultSettings.blackPoint, profile.id).toBeGreaterThanOrEqual(0);
      expect(profile.defaultSettings.blackPoint, profile.id).toBeLessThanOrEqual(80);
      expect(profile.defaultSettings.whitePoint, profile.id).toBeGreaterThanOrEqual(180);
      expect(profile.defaultSettings.whitePoint, profile.id).toBeLessThanOrEqual(255);
      expect(profile.defaultSettings.saturation, profile.id).toBeGreaterThanOrEqual(0);
      expect(profile.defaultSettings.saturation, profile.id).toBeLessThanOrEqual(160);
      expect(profile.defaultSettings.highlightProtection, profile.id).toBeGreaterThanOrEqual(0);
      expect(profile.defaultSettings.highlightProtection, profile.id).toBeLessThanOrEqual(100);
      expect(profile.tonalCharacter, profile.id).toBeTruthy();
    }
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
