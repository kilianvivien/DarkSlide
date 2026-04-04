import { useCallback, useMemo, useState } from 'react';
import { DocumentTab, FilmBaseSample, Roll } from '../types';

const STORAGE_KEY = 'darkslide_rolls_v2';
const LEGACY_STORAGE_KEY = 'darkslide_rolls_v1';

type StoredRollsV1 = {
  version: 1;
  rolls: Roll[];
};

type StoredRollsV2 = {
  version: 2;
  rolls: Roll[];
};

type StoredRolls = StoredRollsV1 | StoredRollsV2;

function readStoredRolls(raw: string | null) {
  if (!raw) {
    return new Map<string, Roll>();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredRolls>;
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.rolls)) {
      return new Map<string, Roll>();
    }
    return new Map(parsed.rolls.map((roll) => [roll.id, roll] as const));
  } catch {
    return new Map<string, Roll>();
  }
}

function loadStoredRolls() {
  if (typeof window === 'undefined') {
    return new Map<string, Roll>();
  }

  const currentRaw = window.localStorage.getItem(STORAGE_KEY);
  if (currentRaw !== null) {
    return readStoredRolls(currentRaw);
  }

  const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw !== null) {
    return readStoredRolls(legacyRaw);
  }

  return new Map<string, Roll>();
}

function persistRolls(rolls: Map<string, Roll>) {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: StoredRollsV2 = {
    version: 2,
    rolls: Array.from(rolls.values()),
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
}

type UseRollsOptions = {
  tabs?: DocumentTab[];
  updateTabById?: (tabId: string, updater: (tab: DocumentTab) => DocumentTab) => void;
};

export function useRolls({
  tabs = [],
  updateTabById,
}: UseRollsOptions = {}) {
  const [rolls, setRolls] = useState<Map<string, Roll>>(() => loadStoredRolls());

  const writeRolls = useCallback((updater: (current: Map<string, Roll>) => Map<string, Roll>) => {
    setRolls((current) => {
      const next = updater(current);
      persistRolls(next);
      return next;
    });
  }, []);

  const createRoll = useCallback((name: string, directory?: string) => {
    const roll: Roll = {
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `roll-${Date.now()}`,
      name,
      filmStock: null,
      profileId: null,
      camera: null,
      date: null,
      notes: '',
      filmBaseSample: null,
      createdAt: Date.now(),
      directory: directory ?? null,
    };

    writeRolls((current) => {
      const next = new Map(current);
      next.set(roll.id, roll);
      return next;
    });

    return roll;
  }, [writeRolls]);

  const updateRoll = useCallback((id: string, updates: Partial<Roll>) => {
    writeRolls((current) => {
      const existing = current.get(id);
      if (!existing) {
        return current;
      }
      const next = new Map(current);
      next.set(id, {
        ...existing,
        ...updates,
      });
      return next;
    });
  }, [writeRolls]);

  const deleteRoll = useCallback((id: string) => {
    writeRolls((current) => {
      if (!current.has(id)) {
        return current;
      }
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, [writeRolls]);

  const getDocumentsInRoll = useCallback((rollId: string) => (
    tabs.filter((tab) => tab.rollId === rollId).map((tab) => tab.id)
  ), [tabs]);

  const assignToRoll = useCallback((documentIds: string[], rollId: string | null) => {
    if (!updateTabById) {
      return;
    }

    documentIds.forEach((documentId) => {
      updateTabById(documentId, (tab) => ({
        ...tab,
        rollId,
        document: {
          ...tab.document,
          rollId,
          dirty: true,
        },
      }));
    });
  }, [updateTabById]);

  const syncSettingsToRoll = useCallback((sourceDocId: string, rollId: string) => {
    if (!updateTabById) {
      return;
    }

    const sourceTab = tabs.find((tab) => tab.id === sourceDocId);
    if (!sourceTab) {
      return;
    }

    tabs.forEach((tab) => {
      if (tab.id === sourceDocId || tab.rollId !== rollId) {
        return;
      }

      updateTabById(tab.id, (currentTab) => ({
        ...currentTab,
        document: {
          ...currentTab.document,
          settings: structuredClone(sourceTab.document.settings),
          labStyleId: sourceTab.document.labStyleId,
          lightSourceId: sourceTab.document.lightSourceId,
          dirty: true,
        },
      }));
    });

    updateRoll(rollId, { profileId: sourceTab.document.profileId });
  }, [tabs, updateRoll, updateTabById]);

  const applyFilmBaseToRoll = useCallback((filmBase: FilmBaseSample, rollId: string) => {
    writeRolls((current) => {
      const existing = current.get(rollId);
      if (!existing) {
        return current;
      }

      const next = new Map(current);
      next.set(rollId, {
        ...existing,
        filmBaseSample: structuredClone(filmBase),
      });
      return next;
    });

    if (!updateTabById) {
      return;
    }

    tabs.forEach((tab) => {
      if (tab.rollId !== rollId) {
        return;
      }

      updateTabById(tab.id, (currentTab) => ({
        ...currentTab,
        document: {
          ...currentTab.document,
          settings: {
            ...currentTab.document.settings,
            filmBaseSample: structuredClone(filmBase),
          },
          dirty: true,
        },
      }));
    });
  }, [tabs, updateTabById, writeRolls]);

  const rollsByDirectory = useMemo(() => {
    const map = new Map<string, Roll>();
    rolls.forEach((roll) => {
      if (roll.directory) {
        map.set(roll.directory, roll);
      }
    });
    return map;
  }, [rolls]);

  const ensureRollForDirectory = useCallback((directoryPath: string) => {
    const existing = rollsByDirectory.get(directoryPath);
    if (existing) {
      return existing;
    }

    const normalized = directoryPath.replace(/\\/g, '/');
    const name = normalized.split('/').filter(Boolean).pop() ?? 'Untitled Roll';
    return createRoll(name, directoryPath);
  }, [createRoll, rollsByDirectory]);

  return {
    rolls,
    createRoll,
    updateRoll,
    deleteRoll,
    assignToRoll,
    getDocumentsInRoll,
    syncSettingsToRoll,
    applyFilmBaseToRoll,
    ensureRollForDirectory,
  };
}
