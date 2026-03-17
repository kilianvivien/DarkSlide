import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../constants';
import { prepareGeometryCacheEntry } from './workerGeometryCache';

describe('prepareGeometryCacheEntry', () => {
  it('reuses the rotation cache when only the crop changes', () => {
    const rotationCache = new Map<string, { id: string }>();
    const cropCache = new Map<string, { transformedCanvas: { id: string } }>();
    let rotationCreates = 0;

    const createEntry = (crop: { x: number; y: number; width: number; height: number }) => prepareGeometryCacheEntry({
      rotationCache,
      cropCache,
      sourceKind: 'preview',
      previewLevelId: 'preview-1024',
      settings: createDefaultSettings({
        crop: {
          ...crop,
          aspectRatio: null,
        },
      }),
      createRotation: () => ({ id: `rotation-${++rotationCreates}` }),
      createCrop: (rotationCanvas) => ({ transformedCanvas: rotationCanvas }),
    });

    const first = createEntry({ x: 0, y: 0, width: 1, height: 1 });
    const second = createEntry({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });

    expect(rotationCreates).toBe(1);
    expect(first.rotationCacheHit).toBe(false);
    expect(second.rotationCacheHit).toBe(true);
    expect(first.cropJob.transformedCanvas).toBe(second.cropJob.transformedCanvas);
  });

  it('invalidates the rotation cache when rotation changes', () => {
    const rotationCache = new Map<string, { id: string }>();
    const cropCache = new Map<string, { transformedCanvas: { id: string } }>();
    let rotationCreates = 0;

    const first = prepareGeometryCacheEntry({
      rotationCache,
      cropCache,
      sourceKind: 'preview',
      previewLevelId: 'preview-1024',
      settings: createDefaultSettings(),
      createRotation: () => ({ id: `rotation-${++rotationCreates}` }),
      createCrop: (rotationCanvas) => ({ transformedCanvas: rotationCanvas }),
    });
    const second = prepareGeometryCacheEntry({
      rotationCache,
      cropCache,
      sourceKind: 'preview',
      previewLevelId: 'preview-1024',
      settings: createDefaultSettings({ rotation: 90 }),
      createRotation: () => ({ id: `rotation-${++rotationCreates}` }),
      createCrop: (rotationCanvas) => ({ transformedCanvas: rotationCanvas }),
    });

    expect(rotationCreates).toBe(2);
    expect(second.rotationCacheHit).toBe(false);
    expect(first.cropJob.transformedCanvas).not.toBe(second.cropJob.transformedCanvas);
  });

  it('evicts cache entries beyond current plus previous per source kind', () => {
    const rotationCache = new Map<string, { id: string }>();
    const cropCache = new Map<string, { transformedCanvas: { id: string } }>();

    const entries = [0, 90, 180].map((rotation) => prepareGeometryCacheEntry({
      rotationCache,
      cropCache,
      sourceKind: 'source',
      previewLevelId: null,
      settings: createDefaultSettings({ rotation }),
      createRotation: () => ({ id: `rotation-${rotation}` }),
      createCrop: (rotationCanvas) => ({ transformedCanvas: rotationCanvas }),
    }));

    expect(rotationCache.size).toBe(2);
    expect(cropCache.size).toBe(2);
    expect(entries[2].evictedRotations).toHaveLength(1);
    expect(entries[2].evictedCrops).toHaveLength(1);
    expect(entries[2].evictedRotations[0]).toMatchObject({ id: 'rotation-0' });
  });
});
