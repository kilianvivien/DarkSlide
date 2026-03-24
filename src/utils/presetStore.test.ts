import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { createPresetBackupFile, validateDarkslideFile, validatePresetBackupFile } from './presetStore';

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

describe('validatePresetBackupFile', () => {
  it('accepts a valid preset backup payload', () => {
    const payload = createPresetBackupFile([
      {
        id: 'custom-1',
        version: 1,
        name: 'Portra 400 Push',
        type: 'color',
        description: 'Custom DarkSlide preset',
        defaultSettings: createDefaultSettings(),
        folderId: 'folder-1',
      },
    ], [
      { id: 'folder-1', name: 'Color Negative' },
    ], '2026-03-24T10:00:00.000Z');

    expect(validatePresetBackupFile(payload)).toMatchObject({
      kind: 'preset-backup',
      version: 1,
      presets: [
        expect.objectContaining({
          id: 'custom-1',
          folderId: 'folder-1',
        }),
      ],
      folders: [
        { id: 'folder-1', name: 'Color Negative' },
      ],
    });
  });

  it('rejects payloads with an invalid shape', () => {
    expect(validatePresetBackupFile({
      darkslideVersion: '1.0.0',
      kind: 'preset-backup',
      version: 1,
      exportedAt: '2026-03-24T10:00:00.000Z',
      presets: {},
      folders: [],
    })).toBeNull();
  });

  it('rejects backups whose presets reference missing folders', () => {
    expect(validatePresetBackupFile({
      darkslideVersion: '1.0.0',
      kind: 'preset-backup',
      version: 1,
      exportedAt: '2026-03-24T10:00:00.000Z',
      presets: [
        {
          id: 'custom-1',
          version: 1,
          name: 'Broken Folder Link',
          type: 'color',
          description: 'Custom DarkSlide preset',
          defaultSettings: createDefaultSettings(),
          folderId: 'folder-missing',
        },
      ],
      folders: [],
    })).toBeNull();
  });

  it('rejects non-object backup payloads', () => {
    expect(validatePresetBackupFile('not-json')).toBeNull();
  });
});
