import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQuickExportPresets, saveQuickExportPresets, createFromCurrentSettings } from './quickExportStore';
import { DEFAULT_EXPORT_OPTIONS } from '../constants';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('quickExportStore bit depth migration', () => {
  it('normalizes legacy custom presets without bitDepth', () => {
    localStorage.setItem('darkslide_quick_export_presets_v1', JSON.stringify({
      version: 1,
      presets: [{
        id: 'custom-archive',
        name: 'Custom Archive',
        format: 'image/tiff',
        quality: 1,
        outputProfileId: 'adobe-rgb',
        embedMetadata: true,
        embedOutputProfile: true,
        maxDimension: null,
        suffix: '_archive',
        cropToSquare: false,
        saveSidecar: true,
        isBuiltIn: false,
      }],
    }));

    expect(loadQuickExportPresets().find((preset) => preset.id === 'custom-archive')).toMatchObject({
      format: 'image/tiff',
      bitDepth: 16,
    });
  });

  it('saves custom preset bitDepth from current settings', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    const preset = createFromCurrentSettings('PNG 16', {
      ...DEFAULT_EXPORT_OPTIONS,
      format: 'image/png',
      bitDepth: 16,
    });

    saveQuickExportPresets([preset]);
    expect(loadQuickExportPresets().find((candidate) => candidate.id === preset.id)).toMatchObject({
      bitDepth: 16,
    });
  });
});
