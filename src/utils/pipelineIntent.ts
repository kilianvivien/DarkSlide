import type { ConversionSettings, FilmProfile, WorkspaceDocument } from '../types';

const RAW_EXTENSIONS = new Set(['.dng', '.cr3', '.nef', '.arw', '.raf', '.rw2']);

export function usesColorChannelPipeline(
  profile: Pick<FilmProfile, 'type'>,
) {
  return profile.type === 'color';
}

export function rendersMonochrome(
  profile: Pick<FilmProfile, 'type'>,
  settings: Pick<ConversionSettings, 'blackAndWhite'>,
) {
  return profile.type === 'bw' || settings.blackAndWhite.enabled;
}

export function isRawWorkspaceDocument(
  document: Pick<WorkspaceDocument, 'source' | 'rawImportProfile'>,
) {
  return document.source.mime === 'image/x-raw-rgba'
    || Boolean(document.rawImportProfile)
    || RAW_EXTENSIONS.has(document.source.extension.toLowerCase());
}

export function shouldUseDirectRawFilmBase(
  isRawDocument: boolean,
  profile: Pick<FilmProfile, 'type' | 'filmType'>,
  settings: Pick<ConversionSettings, 'blackAndWhite'>,
) {
  return isRawDocument
    && usesColorChannelPipeline(profile)
    && (profile.filmType ?? 'negative') === 'negative'
    && !rendersMonochrome(profile, settings);
}
