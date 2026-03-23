import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { validateDarkslideFile } from './presetStore';

describe('validateDarkslideFile', () => {
  it('accepts a valid preset file payload', () => {
    expect(validateDarkslideFile({
      darkslideVersion: '1.0.0',
      profile: {
        id: 'custom-1',
        version: 1,
        name: 'Portra 400 Push',
        type: 'color',
        description: 'Custom DarkSlide preset',
        defaultSettings: createDefaultSettings(),
        tags: ['color'],
        filmStock: 'Kodak Portra 400',
        scannerType: 'flatbed',
      },
    })).toMatchObject({
      darkslideVersion: '1.0.0',
      profile: {
        id: 'custom-1',
        name: 'Portra 400 Push',
      },
    });
  });

  it('accepts smartphone scanner metadata in preset files', () => {
    expect(validateDarkslideFile({
      darkslideVersion: '1.0.0',
      profile: {
        id: 'custom-2',
        version: 1,
        name: 'Phone Scan',
        type: 'color',
        description: 'Custom DarkSlide preset',
        defaultSettings: createDefaultSettings(),
        scannerType: 'smartphone',
      },
    })).toMatchObject({
      profile: {
        scannerType: 'smartphone',
      },
    });
  });

  it('accepts embedded light source metadata in preset files', () => {
    expect(validateDarkslideFile({
      darkslideVersion: '1.0.0',
      profile: {
        id: 'custom-3',
        version: 1,
        name: 'CS-LITE Scan',
        type: 'color',
        description: 'Custom DarkSlide preset',
        defaultSettings: createDefaultSettings(),
        lightSourceId: 'cs-lite-cool',
      },
    })).toMatchObject({
      profile: {
        lightSourceId: 'cs-lite-cool',
      },
    });
  });

  it('rejects payloads missing the required profile settings', () => {
    expect(validateDarkslideFile({
      darkslideVersion: '1.0.0',
      profile: {
        id: 'custom-1',
        name: 'Broken',
        type: 'color',
        defaultSettings: {
          contrast: 10,
        },
      },
    })).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(validateDarkslideFile('not-json')).toBeNull();
  });
});
