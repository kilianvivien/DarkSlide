import { useEffect, useState } from 'react';
import { FilmProfile } from '../types';
import { loadPresetStore, savePresetStore } from '../utils/presetStore';

function createCustomPresetId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `custom-${crypto.randomUUID()}`;
  }

  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useCustomPresets() {
  const [customPresets, setCustomPresets] = useState<FilmProfile[]>([]);

  useEffect(() => {
    setCustomPresets(loadPresetStore());
  }, []);

  const persist = (nextPresets: FilmProfile[]) => {
    setCustomPresets(nextPresets);
    savePresetStore(nextPresets);
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

  return { customPresets, savePreset, importPreset, deletePreset };
}
