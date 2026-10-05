import type { WorkspaceDocument } from '../types';

export interface FilmstripThumbnail {
  url: string;
  /** Identifies the edit state the thumbnail was captured from. */
  key: string;
}

export const FILMSTRIP_THUMBNAIL_SIZE = 192;

/** Everything that changes how a frame renders. */
export function getThumbnailKey(document: Pick<WorkspaceDocument, 'settings' | 'profileId' | 'labStyleId' | 'lightSourceId' | 'colorManagement'>) {
  return JSON.stringify([
    document.settings,
    document.profileId,
    document.labStyleId ?? null,
    document.lightSourceId ?? null,
    document.colorManagement?.outputProfileId ?? null,
  ]);
}

/**
 * Downscales the rendered preview into a small JPEG data URL. Thumbnails are
 * captured from previews the app already rendered, so the filmstrip never
 * adds worker renders or reloads evicted documents.
 */
export function captureThumbnail(
  source: CanvasImageSource & { width: number; height: number },
  maxSize = FILMSTRIP_THUMBNAIL_SIZE,
): string | null {
  if (!source.width || !source.height || typeof document === 'undefined') {
    return null;
  }

  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  try {
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}
