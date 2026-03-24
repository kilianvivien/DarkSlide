import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';
import { FilmProfile, PresetFolder } from '../types';

const presetStoreState = vi.hoisted(() => ({
  loadPresetStore: vi.fn(),
  loadPresetFolders: vi.fn(),
  loadPresetStoreAsync: vi.fn(),
  savePresetStore: vi.fn(),
}));

vi.mock('../utils/presetStore', () => ({
  loadPresetStore: presetStoreState.loadPresetStore,
  loadPresetFolders: presetStoreState.loadPresetFolders,
  loadPresetStoreAsync: presetStoreState.loadPresetStoreAsync,
  savePresetStore: presetStoreState.savePresetStore,
}));

import { useCustomPresets } from './useCustomPresets';

function createPreset(id: string, name: string, folderId: string | null = null): FilmProfile {
  return {
    id,
    version: 1,
    name,
    type: 'color',
    description: 'Custom DarkSlide preset',
    defaultSettings: createDefaultSettings(),
    folderId,
    isCustom: true,
  };
}

describe('useCustomPresets', () => {
  beforeEach(() => {
    presetStoreState.loadPresetStore.mockReset();
    presetStoreState.loadPresetFolders.mockReset();
    presetStoreState.loadPresetStoreAsync.mockReset();
    presetStoreState.savePresetStore.mockReset();
  });

  it('replaces the existing custom preset library and preserves folder relationships', async () => {
    const initialFolder: PresetFolder = { id: 'folder-old', name: 'Old Folder' };
    const nextFolder: PresetFolder = { id: 'folder-new', name: 'New Folder' };
    const initialPreset = createPreset('custom-old', 'Old Preset', initialFolder.id);
    const nextPreset = createPreset('custom-new', 'New Preset', nextFolder.id);

    presetStoreState.loadPresetStore.mockReturnValue([initialPreset]);
    presetStoreState.loadPresetFolders.mockReturnValue([initialFolder]);
    presetStoreState.loadPresetStoreAsync.mockResolvedValue({
      presets: [initialPreset],
      folders: [initialFolder],
    });

    let hookValue: ReturnType<typeof useCustomPresets> | null = null;
    function Harness() {
      hookValue = useCustomPresets();
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      expect(hookValue?.customPresets).toHaveLength(1);
      expect(hookValue?.folders).toHaveLength(1);
    });

    act(() => {
      hookValue?.replaceLibrary([nextPreset], [nextFolder]);
    });

    expect(hookValue?.customPresets).toEqual([
      expect.objectContaining({
        id: 'custom-new',
        name: 'New Preset',
        folderId: 'folder-new',
        isCustom: true,
      }),
    ]);
    expect(hookValue?.folders).toEqual([nextFolder]);
    expect(presetStoreState.savePresetStore).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'custom-new',
          folderId: 'folder-new',
          isCustom: true,
        }),
      ],
      [nextFolder],
    );
  });

  it('clears the custom preset library when an empty backup is imported', async () => {
    const initialFolder: PresetFolder = { id: 'folder-old', name: 'Old Folder' };
    const initialPreset = createPreset('custom-old', 'Old Preset', initialFolder.id);

    presetStoreState.loadPresetStore.mockReturnValue([initialPreset]);
    presetStoreState.loadPresetFolders.mockReturnValue([initialFolder]);
    presetStoreState.loadPresetStoreAsync.mockResolvedValue({
      presets: [initialPreset],
      folders: [initialFolder],
    });

    let hookValue: ReturnType<typeof useCustomPresets> | null = null;
    function Harness() {
      hookValue = useCustomPresets();
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      expect(hookValue?.customPresets).toHaveLength(1);
      expect(hookValue?.folders).toHaveLength(1);
    });

    act(() => {
      hookValue?.replaceLibrary([], []);
    });

    expect(hookValue?.customPresets).toEqual([]);
    expect(hookValue?.folders).toEqual([]);
    expect(presetStoreState.savePresetStore).toHaveBeenCalledWith([], []);
  });
});
