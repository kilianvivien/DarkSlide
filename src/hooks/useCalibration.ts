import { MutableRefObject, useCallback, useEffect, useState } from 'react';
import { decodeTiffRaster } from '../utils/tiff';
import {
  ACTIVE_FLAT_FIELD_PROFILE_KEY,
  deleteFlatFieldProfile,
  listFlatFieldProfiles,
  loadFlatFieldProfile,
  saveFlatFieldProfile,
} from '../utils/calibrationStore';
import { processFlatFieldReference } from '../utils/flatField';
import { ImageWorkerClient } from '../utils/imageWorkerClient';

const TARGET_FLAT_FIELD_SIZE = 1024;

type FlatFieldPreviewData = {
  data: Float32Array;
  size: number;
};

export function useCalibration(
  workerClientRef: MutableRefObject<ImageWorkerClient | null>,
  workerReadyVersion = 0,
) {
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);
  const [activeProfileLoaded, setActiveProfileLoaded] = useState(false);
  const [activeProfilePreview, setActiveProfilePreview] = useState<FlatFieldPreviewData | null>(null);

  const refreshProfiles = useCallback(async () => {
    try {
      const nextNames = await listFlatFieldProfiles();
      setProfileNames(nextNames);
      return nextNames;
    } catch {
      setProfileNames([]);
      return [];
    }
  }, []);

  const loadIntoWorker = useCallback(async (profileName: string | null) => {
    const worker = workerClientRef.current;
    if (!worker) {
      setActiveProfileLoaded(false);
      return;
    }

    if (!profileName) {
      await worker.clearFlatField().catch(() => undefined);
      setActiveProfileLoaded(false);
      setActiveProfilePreview(null);
      return;
    }

    let loaded: { data: Float32Array; size: number } | null = null;
    try {
      loaded = await loadFlatFieldProfile(profileName);
    } catch {
      loaded = null;
    }
    if (!loaded) {
      await worker.clearFlatField().catch(() => undefined);
      setActiveProfileLoaded(false);
      setActiveProfilePreview(null);
      return;
    }

    await worker.loadFlatField(profileName, loaded.data, loaded.size);
    setActiveProfileLoaded(true);
    setActiveProfilePreview(loaded);
  }, [workerClientRef]);

  useEffect(() => {
    void (async () => {
      try {
        const names = await refreshProfiles();
        const saved = typeof window !== 'undefined'
          ? window.localStorage.getItem(ACTIVE_FLAT_FIELD_PROFILE_KEY)
          : null;
        const nextActive = saved && names.includes(saved) ? saved : null;
        setActiveProfileName(nextActive);
        await loadIntoWorker(nextActive);
      } catch {
        setActiveProfileName(null);
        setActiveProfileLoaded(false);
        setActiveProfilePreview(null);
      }
    })();
  }, [loadIntoWorker, refreshProfiles, workerReadyVersion]);

  const selectActiveProfile = useCallback(async (name: string | null) => {
    setActiveProfileName(name);
    if (typeof window !== 'undefined') {
      if (name) {
        window.localStorage.setItem(ACTIVE_FLAT_FIELD_PROFILE_KEY, name);
      } else {
        window.localStorage.removeItem(ACTIVE_FLAT_FIELD_PROFILE_KEY);
      }
    }
    await loadIntoWorker(name);
  }, [loadIntoWorker]);

  const importFlatFieldFile = useCallback(async (file: File, profileName?: string) => {
    const decoded = await decodeReferenceFile(file);
    const name = sanitizeProfileName(profileName ?? file.name.replace(/\.[^.]+$/, ''));
    const data = processFlatFieldReference(decoded.data, decoded.width, decoded.height, TARGET_FLAT_FIELD_SIZE);
    await saveFlatFieldProfile(name, data, TARGET_FLAT_FIELD_SIZE);
    await refreshProfiles();
    await selectActiveProfile(name);
    return name;
  }, [refreshProfiles, selectActiveProfile]);

  const removeProfile = useCallback(async (name: string) => {
    await deleteFlatFieldProfile(name);
    const nextNames = await refreshProfiles();
    if (name === activeProfileName) {
      const nextActive = nextNames[0] ?? null;
      await selectActiveProfile(nextActive);
    }
  }, [activeProfileName, refreshProfiles, selectActiveProfile]);

  const renameProfile = useCallback(async (currentName: string, nextName: string) => {
    const sanitizedName = sanitizeProfileName(nextName);
    if (!sanitizedName) {
      throw new Error('Choose a name for the flat-field profile.');
    }
    if (sanitizedName === currentName) {
      return sanitizedName;
    }
    if (profileNames.includes(sanitizedName)) {
      throw new Error(`A flat-field profile named "${sanitizedName}" already exists.`);
    }

    const loaded = await loadFlatFieldProfile(currentName);
    if (!loaded) {
      throw new Error('The selected flat-field profile could not be loaded.');
    }

    await saveFlatFieldProfile(sanitizedName, loaded.data, loaded.size);
    await deleteFlatFieldProfile(currentName);
    await refreshProfiles();

    if (activeProfileName === currentName) {
      await selectActiveProfile(sanitizedName);
    }

    return sanitizedName;
  }, [activeProfileName, profileNames, refreshProfiles, selectActiveProfile]);

  const reloadActiveProfile = useCallback(async () => {
    await loadIntoWorker(activeProfileName);
  }, [activeProfileName, loadIntoWorker]);

  return {
    profileNames,
    activeProfileName,
    activeProfileLoaded,
    activeProfilePreview,
    refreshProfiles,
    selectActiveProfile,
    importFlatFieldFile,
    removeProfile,
    renameProfile,
    reloadActiveProfile,
  };
}

async function decodeReferenceFile(file: File) {
  const extension = file.name.toLowerCase();
  if (extension.endsWith('.tif') || extension.endsWith('.tiff')) {
    const buffer = await file.arrayBuffer();
    const decoded = decodeTiffRaster(buffer);
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    };
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not decode the calibration image.');
    }
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    };
  } finally {
    bitmap.close();
  }
}

function sanitizeProfileName(name: string) {
  return name.trim().replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'Flat-field';
}
