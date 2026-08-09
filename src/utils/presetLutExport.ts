import {
  CUBE_LUT_EXPORT_SIZE,
  createDefaultSettings,
  LAB_STYLE_PROFILES_MAP,
  LIGHT_SOURCE_PROFILES,
} from '../constants';
import type { ConversionSettings, CubeLut, FilmProfile } from '../types';
import { isInvertingCubeLut } from './cubeLut';
import { processFloatRaster } from './imagePipeline';
import { usesColorChannelPipeline } from './pipelineIntent';

/**
 * Builds a custom preset around an imported .cube LUT.
 *
 * The sliders start neutral on purpose: the LUT stands in for the conversion,
 * so applying DarkSlide's usual default contrast and clipping on top would make
 * the preset look different here than the same LUT does in Resolve or Premiere.
 */
export function createProfileFromCubeLut(lut: CubeLut, fallbackName: string): FilmProfile {
  const name = (lut.title || fallbackName).trim() || 'Imported LUT';

  return {
    id: `lut-${Date.now()}`,
    version: 1,
    name,
    type: 'color',
    filmType: 'negative',
    description: `Imported from a ${lut.size}×${lut.size}×${lut.size} .cube LUT.`,
    defaultSettings: createDefaultSettings({
      contrast: 0,
      blackPoint: 0,
      whitePoint: 255,
      highlightProtection: 0,
    }),
    lut,
    isCustom: true,
    tags: ['color', 'lut'],
  };
}

/**
 * A LUT that does not map black to a bright value is a look, not a conversion.
 * Since DarkSlide runs the LUT in place of its inversion stage, such a LUT will
 * leave a negative scan un-inverted — worth warning about at import.
 */
export function cubeLutPerformsInversion(lut: CubeLut) {
  return isInvertingCubeLut(lut);
}

/**
 * Strips the stages that cannot be represented by a colour lookup table.
 *
 * Geometry (rotation, crop, level angle) and the spatial filters (sharpen,
 * noise reduction, dust removal) are not per-pixel colour operations, so they
 * are excluded from a baked .cube by definition.
 */
function toColorOnlySettings(settings: ConversionSettings): ConversionSettings {
  return {
    ...settings,
    sharpen: { ...settings.sharpen, enabled: false },
    noiseReduction: { ...settings.noiseReduction, enabled: false },
    dustRemoval: settings.dustRemoval ? { ...settings.dustRemoval, marks: [] } : undefined,
  };
}

/**
 * Bakes a preset's full conversion — inversion, film-base compensation and
 * every tonal/colour stage — into a 3D LUT, by pushing an identity lattice
 * through the real pipeline rather than reimplementing it.
 *
 * The image-adaptive inputs the pipeline normally measures per frame (estimated
 * film base, flare floor, residual base offset, highlight density) are baked at
 * their neutral values; only what the preset itself stores is represented. A
 * preset that already carries an imported LUT bakes that LUT plus its slider
 * stages, so import → export round-trips.
 */
export function bakePresetToCubeLut(
  profile: FilmProfile,
  size = CUBE_LUT_EXPORT_SIZE,
): CubeLut {
  const entries = size ** 3;
  const data = new Float32Array(entries * 3);
  const last = size - 1;

  // .cube ordering is red-fastest.
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const index = (r + g * size + b * size * size) * 3;
        data[index] = r / last;
        data[index + 1] = g / last;
        data[index + 2] = b / last;
      }
    }
  }

  const lightSourceBias = (profile.lightSourceId
    ? LIGHT_SOURCE_PROFILES.find((candidate) => candidate.id === profile.lightSourceId)?.spectralBias
    : undefined) ?? [1, 1, 1];
  const labStyle = profile.labStyleId ? LAB_STYLE_PROFILES_MAP[profile.labStyleId] ?? null : null;

  processFloatRaster(
    { width: entries, height: 1, data, channels: 3 },
    toColorOnlySettings(profile.defaultSettings),
    usesColorChannelPipeline({ type: profile.type }),
    'processed',
    profile.maskTuning,
    profile.colorMatrix,
    profile.tonalCharacter,
    labStyle?.toneCurve,
    labStyle?.channelCurves,
    labStyle?.tonalCharacterOverride,
    labStyle?.saturationBias ?? 0,
    labStyle?.temperatureBias ?? 0,
    0,
    'srgb',
    'srgb',
    profile.id,
    profile.filmType ?? 'negative',
    null,
    null,
    lightSourceBias,
    null,
    null,
    profile.lut ?? null,
  );

  return {
    size,
    title: profile.name,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
  };
}
