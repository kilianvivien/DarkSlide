import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_OPTIONS } from '../constants';
import { loadPreferences, savePreferences, UserPreferences } from './preferenceStore';

const VALID_PREFS: UserPreferences = {
  version: 1,
  lastProfileId: 'portra-400',
  exportOptions: { format: 'image/png', quality: 0.85, filenameBase: 'test', embedMetadata: false, iccEmbedMode: 'none' },
  sidebarTab: 'export',
  cropTab: 'Social',
  isLeftPaneOpen: false,
  isRightPaneOpen: true,
  gpuRendering: false,
  ultraSmoothDrag: true,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('loadPreferences', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadPreferences()).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    localStorage.setItem('darkslide_preferences_v1', 'not-json{{{');
    expect(loadPreferences()).toBeNull();
  });

  it('returns null for wrong version', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({ version: 2, lastProfileId: 'x' }));
    expect(loadPreferences()).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({ version: 1 }));
    expect(loadPreferences()).toBeNull();
  });

  it('returns null when boolean fields have wrong type', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({
      version: 1,
      lastProfileId: 'x',
      exportOptions: DEFAULT_EXPORT_OPTIONS,
      sidebarTab: 'adjust',
      isLeftPaneOpen: 'yes',  // wrong type
      isRightPaneOpen: true,
    }));
    expect(loadPreferences()).toBeNull();
  });

  it('defaults gpuRendering to true for older stored preferences', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({
      version: 1,
      lastProfileId: 'x',
      exportOptions: DEFAULT_EXPORT_OPTIONS,
      sidebarTab: 'adjust',
      isLeftPaneOpen: true,
      isRightPaneOpen: false,
    }));

    expect(loadPreferences()).toMatchObject({
      cropTab: 'Film',
      gpuRendering: true,
    });
  });

  it('defaults ultraSmoothDrag to false for older stored preferences', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({
      version: 1,
      lastProfileId: 'x',
      exportOptions: DEFAULT_EXPORT_OPTIONS,
      sidebarTab: 'adjust',
      isLeftPaneOpen: true,
      isRightPaneOpen: false,
      gpuRendering: true,
    }));

    expect(loadPreferences()).toMatchObject({
      cropTab: 'Film',
      ultraSmoothDrag: false,
    });
  });

  it('defaults embedMetadata to true for older stored preferences', () => {
    localStorage.setItem('darkslide_preferences_v1', JSON.stringify({
      version: 1,
      lastProfileId: 'x',
      exportOptions: {
        format: 'image/jpeg',
        quality: 0.92,
        filenameBase: 'scan',
      },
      sidebarTab: 'adjust',
      isLeftPaneOpen: true,
      isRightPaneOpen: false,
    }));

    expect(loadPreferences()).toMatchObject({
      exportOptions: expect.objectContaining({
        embedMetadata: true,
        iccEmbedMode: 'srgb',
      }),
    });
  });
});

describe('savePreferences + loadPreferences round-trip', () => {
  it('persists and restores all fields accurately', () => {
    savePreferences(VALID_PREFS);
    const loaded = loadPreferences();

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.lastProfileId).toBe('portra-400');
    expect(loaded!.sidebarTab).toBe('export');
    expect(loaded!.cropTab).toBe('Social');
    expect(loaded!.isLeftPaneOpen).toBe(false);
    expect(loaded!.isRightPaneOpen).toBe(true);
    expect(loaded!.gpuRendering).toBe(false);
    expect(loaded!.ultraSmoothDrag).toBe(true);
    expect(loaded!.exportOptions.format).toBe('image/png');
    expect(loaded!.exportOptions.quality).toBe(0.85);
    expect(loaded!.exportOptions.embedMetadata).toBe(false);
    expect(loaded!.exportOptions.iccEmbedMode).toBe('none');
  });

  it('overwrites previous preferences on save', () => {
    savePreferences(VALID_PREFS);
    savePreferences({ ...VALID_PREFS, lastProfileId: 'ektar-100', sidebarTab: 'curves' });
    const loaded = loadPreferences();

    expect(loaded!.lastProfileId).toBe('ektar-100');
    expect(loaded!.sidebarTab).toBe('curves');
  });
});
