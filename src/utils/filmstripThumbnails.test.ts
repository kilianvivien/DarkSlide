import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT } from '../constants';
import { captureThumbnail, FILMSTRIP_THUMBNAIL_SIZE, getThumbnailKey } from './filmstripThumbnails';

describe('captureThumbnail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downscales the preview to the thumbnail size and keeps its aspect ratio', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage, imageSmoothingQuality: 'low' }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');

    const source = { width: 1200, height: 800 } as HTMLCanvasElement;
    expect(captureThumbnail(source)).toBe('data:image/jpeg;base64,AAAA');
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, FILMSTRIP_THUMBNAIL_SIZE, 128);
  });

  it('never upscales small previews and skips empty ones', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:x');

    captureThumbnail({ width: 100, height: 50 } as HTMLCanvasElement);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 50);
    expect(captureThumbnail({ width: 0, height: 0 } as HTMLCanvasElement)).toBeNull();
  });
});

describe('getThumbnailKey', () => {
  const base = {
    settings: createDefaultSettings(),
    profileId: 'generic-color',
    labStyleId: null,
    lightSourceId: null,
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
  };

  it('changes when anything that affects the render changes', () => {
    const key = getThumbnailKey(base);
    expect(getThumbnailKey({ ...base })).toBe(key);
    expect(getThumbnailKey({ ...base, settings: createDefaultSettings({ exposure: 10 }) })).not.toBe(key);
    expect(getThumbnailKey({ ...base, profileId: 'portra-400' })).not.toBe(key);
    expect(getThumbnailKey({ ...base, labStyleId: 'frontier' })).not.toBe(key);
  });
});
