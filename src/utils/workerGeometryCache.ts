import { ConversionSettings, TileSourceKind } from '../types';
import { normalizeCrop } from './imagePipeline';

const MAX_CACHE_ENTRIES_PER_SOURCE_KIND = 2;

function createSourcePrefix(sourceKind: TileSourceKind) {
  return `${sourceKind}|`;
}

export function createRotationCacheKey(
  sourceKind: TileSourceKind,
  previewLevelId: string | null,
  rotation: number,
  levelAngle: number,
) {
  return `${sourceKind}|${previewLevelId ?? ''}|${rotation}|${levelAngle}`;
}

export function createCropCacheKey(
  sourceKind: TileSourceKind,
  previewLevelId: string | null,
  settings: ConversionSettings,
) {
  const crop = normalizeCrop(settings);
  return `${createRotationCacheKey(sourceKind, previewLevelId, settings.rotation, settings.levelAngle)}|${crop.x},${crop.y},${crop.width},${crop.height}`;
}

export function setBoundedCacheEntry<T>(
  cache: Map<string, T>,
  sourceKind: TileSourceKind,
  key: string,
  value: T,
) {
  const evicted: T[] = [];
  const previous = cache.get(key);
  if (previous !== undefined) {
    cache.delete(key);
    if (previous !== value) {
      evicted.push(previous);
    }
  }

  cache.set(key, value);

  const prefix = createSourcePrefix(sourceKind);
  const matchingKeys = Array.from(cache.keys()).filter((cacheKey) => cacheKey.startsWith(prefix));
  while (matchingKeys.length > MAX_CACHE_ENTRIES_PER_SOURCE_KIND) {
    const oldestKey = matchingKeys.shift();
    if (!oldestKey) {
      break;
    }
    const evictedValue = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (evictedValue !== undefined) {
      evicted.push(evictedValue);
    }
  }

  return evicted;
}

export function prepareGeometryCacheEntry<TRotationCanvas, TCropJob>(options: {
  rotationCache: Map<string, TRotationCanvas>;
  cropCache: Map<string, TCropJob>;
  sourceKind: TileSourceKind;
  previewLevelId: string | null;
  settings: ConversionSettings;
  createRotation: () => TRotationCanvas;
  createCrop: (rotationCanvas: TRotationCanvas) => TCropJob;
}) {
  const {
    rotationCache,
    cropCache,
    sourceKind,
    previewLevelId,
    settings,
    createRotation,
    createCrop,
  } = options;

  const rotationKey = createRotationCacheKey(
    sourceKind,
    previewLevelId,
    settings.rotation,
    settings.levelAngle,
  );
  let rotationCanvas = rotationCache.get(rotationKey);
  let rotationCacheHit = true;
  let evictedRotations: TRotationCanvas[] = [];

  if (!rotationCanvas) {
    rotationCanvas = createRotation();
    evictedRotations = setBoundedCacheEntry(rotationCache, sourceKind, rotationKey, rotationCanvas);
    rotationCacheHit = false;
  }

  const cropKey = createCropCacheKey(sourceKind, previewLevelId, settings);
  let cropJob = cropCache.get(cropKey);
  let geometryCacheHit = true;
  let evictedCrops: TCropJob[] = [];

  if (!cropJob) {
    cropJob = createCrop(rotationCanvas);
    evictedCrops = setBoundedCacheEntry(cropCache, sourceKind, cropKey, cropJob);
    geometryCacheHit = false;
  }

  return {
    cropJob,
    geometryCacheHit,
    rotationCacheHit,
    evictedRotations,
    evictedCrops,
  };
}
