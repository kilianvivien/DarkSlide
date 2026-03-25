import { useCallback, useMemo, useState } from 'react';
import { DocumentTab, FilmBaseSample, Roll } from '../types';

const STORAGE_KEY = 'darkslide_rolls_v1';

type StoredRolls = {
  version: 1;
  rolls: Roll[];
};

function loadStoredRolls() {
  if (typeof window === 'undefined') {
    return new Map<string, Roll>();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return new Map<string, Roll>();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredRolls>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rolls)) {
      return new Map<string, Roll>();
    }
    return new Map(parsed.rolls.map((roll) => [roll.id, roll] as const));
  } catch {
    return new Map<string, Roll>();
  }
}

function persistRolls(rolls: Map<string, Roll>) {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: StoredRolls = {
    version: 1,
    rolls: Array.from(rolls.values()),
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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
    updateRoll(rollId, { filmBaseSample: filmBase });

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
  }, [tabs, updateRoll, updateTabById]);

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
