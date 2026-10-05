import { createDefaultSettings, FILM_PROFILES, FILM_STOCK_DENSITY_PRESETS, resolveLightSourceIdForProfile } from '../constants';
import type { ConversionSettings, FilmProfile, ScannerType, WorkspaceDocument } from '../types';
import { isRawWorkspaceDocument } from './pipelineIntent';

export function preserveProfileCalibration(settings: ConversionSettings, profile: FilmProfile): ConversionSettings {
  const stockBalance = FILM_STOCK_DENSITY_PRESETS[profile.id];
  return {
    ...structuredClone(settings),
    ...(settings.densityBalance
      ? { densityBalance: structuredClone(settings.densityBalance) }
      : stockBalance ? { densityBalance: { ...stockBalance, source: 'film-stock-preset' as const } } : {}),
  };
}

const BUILTIN_PROFILE_IDS = new Set(FILM_PROFILES.map((profile) => profile.id));

// The built-in profiles' red/green/blue balances were tuned on RAW decoded
// through the camera matrix with a fixed stock density preset. A RAW is now
// inverted in camera-native RGB with a density balance measured on the scan,
// and stacking those gains on top of it tinted every frame warm. A preset the
// user saved keeps the balances they chose.
export function withCameraRawChannelGains(settings: ConversionSettings, profile: Pick<FilmProfile, 'id'>): ConversionSettings {
  if (!BUILTIN_PROFILE_IDS.has(profile.id)) {
    return settings;
  }
  return { ...settings, redBalance: 1, greenBalance: 1, blueBalance: 1 };
}

export function buildProfileSettingsForDocument(profile: FilmProfile, document: WorkspaceDocument | null) {
  const rawProfile = document?.rawImportProfile;
  const isRawStartup = Boolean(rawProfile && profile.id === rawProfile.id);
  let next = createDefaultSettings(structuredClone(isRawStartup ? rawProfile!.defaultSettings : profile.defaultSettings));

  if (document && isRawWorkspaceDocument(document) && !isRawStartup) {
    next = withCameraRawChannelGains(next, profile);
    // An automatic estimate stays in worker analysis, with its confidence.
    // Only an explicitly picked/shared reference can be carried forward.
    if ((profile.filmType ?? 'negative') === 'negative') {
      if (!next.filmBaseSample && document.settings.filmBaseSample) {
        next.filmBaseSample = structuredClone(document.settings.filmBaseSample);
        next.filmBaseSampleSource = document.settings.filmBaseSampleSource;
        next.filmBaseSampleProfileId = document.settings.filmBaseSampleProfileId;
      }
    } else {
      next.filmBaseSample = null;
      delete next.filmBaseSampleSource;
      delete next.filmBaseSampleProfileId;
    }
  }
  if (profile.includesFraming === false && document) {
    next.crop = structuredClone(document.settings.crop);
    next.rotation = document.settings.rotation;
    next.levelAngle = document.settings.levelAngle;
  }
  if (document && profile.includesImageRepairs === false && next.dustRemoval) {
    next.dustRemoval.marks = structuredClone(document.settings.dustRemoval?.marks ?? []);
  }
  return next;
}

// Everything applying a profile changes on a document. A profile that names a
// light source or lab style sets it (null clears it); one that leaves the key
// out keeps the document's, adapting a CS-Lite light source to the film type.
export function resolveProfileApplication(profile: FilmProfile, document: WorkspaceDocument | null) {
  const hasOwn = (key: 'lightSourceId' | 'labStyleId') => Object.prototype.hasOwnProperty.call(profile, key);
  return {
    settings: buildProfileSettingsForDocument(profile, document),
    lightSourceId: hasOwn('lightSourceId')
      ? (profile.lightSourceId ?? null)
      : resolveLightSourceIdForProfile(profile, document?.lightSourceId),
    labStyleId: hasOwn('labStyleId')
      ? (profile.labStyleId ?? null)
      : (document?.labStyleId ?? null),
  };
}

export function createPresetRecipe(
  document: WorkspaceDocument,
  profile: FilmProfile,
  metadata: { id: string; name: string; filmStock?: string; scannerType?: ScannerType | null; folderId?: string | null; saveFraming?: boolean },
  tags: string[],
): FilmProfile {
  const settings = preserveProfileCalibration(document.settings, profile);
  if (!metadata.saveFraming) {
    settings.crop = { x: 0, y: 0, width: 1, height: 1, aspectRatio: null };
    settings.rotation = 0;
    settings.levelAngle = 0;
  }
  // Repair coordinates belong to the source image, never to a reusable look.
  if (settings.dustRemoval) settings.dustRemoval.marks = [];
  return {
    ...structuredClone(profile),
    id: metadata.id,
    version: 1,
    name: metadata.name,
    description: 'Custom DarkSlide preset',
    defaultSettings: settings,
    lut: profile.lut ?? null,
    isCustom: true,
    tags: profile.lut ? [...tags, 'lut'] : tags,
    filmStock: metadata.filmStock?.trim() || null,
    scannerType: metadata.scannerType ?? null,
    includesFraming: Boolean(metadata.saveFraming),
    includesImageRepairs: false,
    lightSourceId: document.lightSourceId ?? null,
    labStyleId: document.labStyleId ?? null,
    folderId: metadata.folderId ?? null,
  };
}

export function resolveDocumentProfile(document: WorkspaceDocument, profiles: ReadonlyMap<string, FilmProfile>, fallback: FilmProfile) {
  // Every RAW document owns a different startup recipe under the same UI ID.
  return document.rawImportProfile?.id === document.profileId
    ? document.rawImportProfile
    : profiles.get(document.profileId) ?? fallback;
}
