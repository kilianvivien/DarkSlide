import { ConversionSettings, CropSettings, FilmProfile } from '../types';

export const FULL_FRAME_CROP: CropSettings = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspectRatio: null,
};

const EPSILON = 0.000001;

function isCloseTo(value: number, target: number) {
  return Math.abs(value - target) <= EPSILON;
}

export function isFullFrameCrop(crop: CropSettings) {
  return isCloseTo(crop.x, FULL_FRAME_CROP.x)
    && isCloseTo(crop.y, FULL_FRAME_CROP.y)
    && isCloseTo(crop.width, FULL_FRAME_CROP.width)
    && isCloseTo(crop.height, FULL_FRAME_CROP.height)
    && crop.aspectRatio === FULL_FRAME_CROP.aspectRatio;
}

export function hasEmbeddedCropOrRotation(settings: Pick<ConversionSettings, 'rotation' | 'levelAngle' | 'crop'>) {
  return !isCloseTo(settings.rotation, 0)
    || !isCloseTo(settings.levelAngle, 0)
    || !isFullFrameCrop(settings.crop);
}

export function customProfileHasEmbeddedCropOrRotation(profile: FilmProfile | null | undefined) {
  return Boolean(profile && hasEmbeddedCropOrRotation(profile.defaultSettings));
}

export function getBatchEffectiveSettings(settings: ConversionSettings, ignoreCropAndRotation: boolean) {
  const effectiveSettings = structuredClone(settings);

  if (!ignoreCropAndRotation) {
    return effectiveSettings;
  }

  effectiveSettings.rotation = 0;
  effectiveSettings.levelAngle = 0;
  effectiveSettings.crop = structuredClone(FULL_FRAME_CROP);
  return effectiveSettings;
}
