import { useEffect, useState } from 'react';
import { FilmProfile, ConversionSettings, FilmType } from '../types';
import { loadPresetStore, savePresetStore } from '../utils/presetStore';

export function useCustomPresets() {
  const [customPresets, setCustomPresets] = useState<FilmProfile[]>([]);

  useEffect(() => {
    setCustomPresets(loadPresetStore());
  }, []);

  const persist = (nextPresets: FilmProfile[]) => {
    setCustomPresets(nextPresets);
    savePresetStore(nextPresets);
  };

  const savePreset = (name: string, type: FilmType, settings: ConversionSettings) => {
    const newPreset: FilmProfile = {
      id: `custom-${Date.now()}`,
      version: 1,
      name,
      type,
      description: 'Custom DarkSlide preset',
      defaultSettings: structuredClone(settings),
      isCustom: true,
    };

    const nextPresets = [...customPresets, newPreset];
    persist(nextPresets);
    return newPreset;
  };

  const deletePreset = (id: string) => {
    persist(customPresets.filter((preset) => preset.id !== id));
  };

  return { customPresets, savePreset, deletePreset };
}
