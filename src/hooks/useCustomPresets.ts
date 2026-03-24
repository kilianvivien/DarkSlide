import { useEffect, useState } from 'react';
import { FilmProfile, PresetFolder } from '../types';
import { loadPresetStore, loadPresetFolders, loadPresetStoreAsync, savePresetStore } from '../utils/presetStore';

function createCustomPresetId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `custom-${crypto.randomUUID()}`;
  }

  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createFolderId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `folder-${crypto.randomUUID()}`;
  }

  return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useCustomPresets() {
  const [customPresets, setCustomPresets] = useState<FilmProfile[]>([]);
  const [folders, setFolders] = useState<PresetFolder[]>([]);

  useEffect(() => {
    // Synchronous load for first render
    setCustomPresets(loadPresetStore());
    setFolders(loadPresetFolders());

    // Async load from IndexedDB (may have newer data after migration)
    void loadPresetStoreAsync().then(({ presets, folders: f }) => {
      setCustomPresets(presets);
      setFolders(f);
    });
  }, []);

  const persist = (nextPresets: FilmProfile[], nextFolders?: PresetFolder[]) => {
    const f = nextFolders ?? folders;
    setCustomPresets(nextPresets);
    setFolders(f);
    savePresetStore(nextPresets, f);
  };

  const savePreset = (preset: FilmProfile) => {
    const nextPresets = [...customPresets, { ...structuredClone(preset), isCustom: true }];
    persist(nextPresets);
    return nextPresets[nextPresets.length - 1];
  };

  const importPreset = (
    preset: FilmProfile,
    options: { overwriteId?: string; renameTo?: string } = {},
  ) => {
    const importedPreset: FilmProfile = {
      ...structuredClone(preset),
      id: options.overwriteId ?? createCustomPresetId(),
      name: options.renameTo?.trim() || preset.name,
      isCustom: true,
    };

    const nextPresets = options.overwriteId
      ? customPresets.map((existingPreset) => (
        existingPreset.id === options.overwriteId
          ? importedPreset
          : existingPreset
      ))
      : [...customPresets, importedPreset];

    persist(nextPresets);
    return importedPreset;
  };

  const deletePreset = (id: string) => {
    persist(customPresets.filter((preset) => preset.id !== id));
  };

  const createFolder = (name: string) => {
    const folder: PresetFolder = { id: createFolderId(), name: name.trim() };
    const nextFolders = [...folders, folder];
    persist(customPresets, nextFolders);
    return folder;
  };

  const renameFolder = (id: string, name: string) => {
    const nextFolders = folders.map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
    persist(customPresets, nextFolders);
  };

  const deleteFolder = (id: string) => {
    // Unassign presets from the deleted folder
    const nextPresets = customPresets.map((p) =>
      p.folderId === id ? { ...p, folderId: null } : p,
    );
    const nextFolders = folders.filter((f) => f.id !== id);
    persist(nextPresets, nextFolders);
  };

  const movePresetToFolder = (presetId: string, folderId: string | null) => {
    const nextPresets = customPresets.map((p) =>
      p.id === presetId ? { ...p, folderId } : p,
    );
    persist(nextPresets);
  };

  const replaceLibrary = (nextPresets: FilmProfile[], nextFolders: PresetFolder[]) => {
    persist(
      nextPresets.map((preset) => ({ ...structuredClone(preset), isCustom: true })),
      structuredClone(nextFolders),
    );
  };

  return {
    customPresets,
    folders,
    savePreset,
    importPreset,
    deletePreset,
    createFolder,
    renameFolder,
    deleteFolder,
    movePresetToFolder,
    replaceLibrary,
  };
}
