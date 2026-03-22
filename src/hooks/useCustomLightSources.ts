import { useCallback, useMemo, useState } from 'react';
import { LightSourceProfile } from '../types';

const STORAGE_KEY = 'darkslide_custom_light_sources';

type LightSourceDraft = {
  id?: string | null;
  name: string;
  colorTemperature: number;
  spectralBias: [number, number, number];
  flareCharacteristic: LightSourceProfile['flareCharacteristic'];
};

function loadStoredLightSources(): LightSourceProfile[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStoredLightSource);
  } catch {
    return [];
  }
}

function persistLightSources(profiles: LightSourceProfile[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

function isStoredLightSource(value: unknown): value is LightSourceProfile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<LightSourceProfile>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.colorTemperature === 'number'
    && Array.isArray(candidate.spectralBias)
    && candidate.spectralBias.length === 3
    && (candidate.flareCharacteristic === 'low' || candidate.flareCharacteristic === 'medium' || candidate.flareCharacteristic === 'high');
}

function sanitizeLightSourceId(name: string) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'light-source';
  return `custom-${base}`;
}

export function useCustomLightSources() {
  const [customLightSources, setCustomLightSources] = useState<LightSourceProfile[]>(() => loadStoredLightSources());

  const lightSourcesById = useMemo(() => {
    const map = new Map(customLightSources.map((profile) => [profile.id, profile] as const));
    return map;
  }, [customLightSources]);

  const saveCustomLightSource = useCallback((draft: LightSourceDraft) => {
    const safeName = draft.name.trim() || 'Custom Light Source';
    const nextProfile: LightSourceProfile = {
      id: draft.id && lightSourcesById.has(draft.id) ? draft.id : sanitizeLightSourceId(safeName),
      name: safeName,
      colorTemperature: Math.max(1000, Math.round(draft.colorTemperature || 5500)),
      spectralBias: [
        draft.spectralBias[0],
        draft.spectralBias[1],
        draft.spectralBias[2],
      ],
      flareCharacteristic: draft.flareCharacteristic,
    };

    setCustomLightSources((current) => {
      const withoutPrevious = current.filter((profile) => profile.id !== nextProfile.id);
      const next = [...withoutPrevious, nextProfile].sort((left, right) => left.name.localeCompare(right.name));
      persistLightSources(next);
      return next;
    });

    return nextProfile;
  }, [lightSourcesById]);

  const deleteCustomLightSource = useCallback((id: string) => {
    setCustomLightSources((current) => {
      const next = current.filter((profile) => profile.id !== id);
      persistLightSources(next);
      return next;
    });
  }, []);

  return {
    customLightSources,
    saveCustomLightSource,
    deleteCustomLightSource,
  };
}
