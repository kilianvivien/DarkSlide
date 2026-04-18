import {
  ColorProfileId,
  ColorMatrix,
  ConversionSettings,
  DensityBalance,
  CurvePoint,
  CropSettings,
  ExportFormat,
  FilmBaseSample,
  FilmProfileType,
  HistogramData,
  MaskTuning,
  PreviewLevel,
  TonalCharacter,
} from '../types';
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../constants';
import { convertRgbBetweenProfiles, decodeProfileChannel, getLinearTransformMatrix, getTransferMode } from './colorProfiles';
import { clamp } from './math';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const DENSITY_EPSILON = 1e-6;
let scratchUint8: Uint8ClampedArray | null = null;
let scratchFloat32: Float32Array | null = null;
let scratchSize = 0;

type CurveChannelOverrides = {
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
};

type ResidualBaseOffset = [number, number, number];

export function getExtensionFromFormat(format: ExportFormat) {
  switch (format) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/tiff':
      return 'tiff';
    default:
      return 'jpg';
  }
}

export function sanitizeFilenameBase(name: string) {
  const cleaned = name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'darkslide-converted';
}

export function getFileExtension(fileName: string) {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : '';
}

export function assertSupportedDimensions(width: number, height: number) {
  if (width < 1 || height < 1) {
    throw new Error('Image has invalid dimensions.');
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Image exceeds the supported maximum dimension of ${MAX_IMAGE_DIMENSION}px.`);
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image exceeds the supported ${Math.round(MAX_IMAGE_PIXELS / 1_000_000)} MP limit for the browser build.`);
  }
}

function getCurveValue(points: CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  if (points.length === 1) return points[0].y;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];

    if (x >= current.x && x <= next.x) {
      const span = next.x - current.x || 1;
      const t = (x - current.x) / span;
      return current.y + t * (next.y - current.y);
    }
  }

  if (x < points[0].x) return points[0].y;
  return points[points.length - 1].y;
}

export function createCurveLut(points: CurvePoint[]) {
  const lut = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    lut[index] = clamp(Math.round(getCurveValue(points, index)), 0, 255);
  }
  return lut;
}

export function normalizeCrop(settings: ConversionSettings) {
  const crop = settings.crop;
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);

  return {
    ...crop,
    x,
    y,
    width,
    height,
  };
}

export function getCropPixelBounds(crop: CropSettings, imageWidth: number, imageHeight: number) {
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);

  const left = clamp(Math.round(x * safeWidth), 0, safeWidth - 1);
  const top = clamp(Math.round(y * safeHeight), 0, safeHeight - 1);
  const right = clamp(Math.round((x + width) * safeWidth), left + 1, safeWidth);
  const bottom = clamp(Math.round((y + height) * safeHeight), top + 1, safeHeight);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function normalizeAngle(angle: number) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getTransformedDimensions(width: number, height: number, angle: number) {
  const normalizedAngle = normalizeAngle(angle);
  const radians = (normalizedAngle * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians)) < 1e-10 ? 0 : Math.cos(radians);
  const sine = Math.abs(Math.sin(radians)) < 1e-10 ? 0 : Math.sin(radians);

  return {
    width: Math.max(1, Math.ceil(Math.abs(width * cosine) + Math.abs(height * sine))),
    height: Math.max(1, Math.ceil(Math.abs(width * sine) + Math.abs(height * cosine))),
  };
}

export function getRotatedDimensions(width: number, height: number, rotation: number) {
  const normalizedRotation = normalizeAngle(rotation);
  const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
  return {
    width: isQuarterTurn ? height : width,
    height: isQuarterTurn ? width : height,
  };
}

export function getNormalizedAspectRatio(aspectRatio: number, imageWidth: number, imageHeight: number) {
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);
  return aspectRatio / (safeWidth / safeHeight);
}

export function createCenteredAspectCrop(aspectRatio: number, imageWidth: number, imageHeight: number): CropSettings {
  const normalizedAspectRatio = getNormalizedAspectRatio(aspectRatio, imageWidth, imageHeight);
  const width = normalizedAspectRatio > 1 ? 1 : normalizedAspectRatio;
  const height = normalizedAspectRatio > 1 ? 1 / normalizedAspectRatio : 1;

  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    aspectRatio,
  };
}

export function rotateCropClockwise(crop: CropSettings): CropSettings {
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);

  return {
    x: y,
    y: 1 - x - width,
    width: height,
    height: width,
    aspectRatio: crop.aspectRatio ? 1 / crop.aspectRatio : null,
  };
}

export function selectPreviewLevel(levels: PreviewLevel[], targetMaxDimension: number) {
  const ordered = [...levels].sort((a, b) => a.maxDimension - b.maxDimension);
  return ordered.find((level) => level.maxDimension >= targetMaxDimension) ?? ordered[ordered.length - 1];
}

function applyWhiteBlackPoint(value: number, blackPoint: number, whitePoint: number) {
  const range = Math.max(1 / 255, whitePoint - blackPoint);
  return (value - blackPoint) / range;
}

function applyColorMatrix(
  r: number,
  g: number,
  b: number,
  matrix: ColorMatrix,
): [number, number, number] {
  return [
    matrix[0] * r + matrix[1] * g + matrix[2] * b,
    matrix[3] * r + matrix[4] * g + matrix[5] * b,
    matrix[6] * r + matrix[7] * g + matrix[8] * b,
  ];
}

function applyTonalCharacter(value: number, character?: TonalCharacter) {
  let next = value;

  if (character && character.shadowLift > 0 && next < 0.5) {
    const t = next / 0.5;
    const gamma = 1 - character.shadowLift * 0.6;
    next = 0.5 * Math.pow(clamp(t, 0, 1), gamma);
  }

  if (character?.midtoneAnchor) {
    next += character.midtoneAnchor;
  }

  return clamp(next, 0, 1);
}

function applyAdaptiveHighlightRecovery(
  value: number,
  highlightProtection: number,
  highlightDensityEstimate = 0,
  character?: TonalCharacter,
) {
  const toned = applyTonalCharacter(value, character);
  const threshold = 200 / 255;
  const effectiveRolloff = (character?.highlightRolloff ?? 0.5) * (1 + clamp(highlightDensityEstimate, 0, 1) * 0.5);
  if (highlightProtection <= 0 || toned <= threshold) {
    return clamp(toned, 0, 1);
  }

  const protection = clamp(highlightProtection / 100, 0, 0.95);
  const shoulder = (toned - threshold) / (1 - threshold);
  const softness = 1 - protection * Math.pow(clamp(shoulder, 0, 1), Math.max(effectiveRolloff, 0.05));
  return clamp(threshold + shoulder * (1 - threshold) * softness, 0, 1);
}

function applyShadowRecovery(value: number, strength: number) {
  if (value >= 0.25 || strength <= 0) {
    return value;
  }

  const normalizedStrength = clamp(strength / 100, 0, 1);
  const t = 1 - value / 0.25;
  return value + (0.25 - value) * normalizedStrength * t * t;
}

function applyMidtoneContrast(value: number, strength: number) {
  if (strength === 0) {
    return value;
  }

  const normalizedStrength = clamp(strength / 100, -1, 1);
  const weight = Math.max(0, 1 - 4 * (value - 0.5) * (value - 0.5));
  return 0.5 + (value - 0.5) * (1 + normalizedStrength * weight);
}

export function getFilmBaseBalance(sample: FilmBaseSample | null) {
  if (!sample) {
    return { red: 1, green: 1, blue: 1 };
  }

  return {
    red: clamp(sample.r / 255, 1 / 255, 1),
    green: clamp(sample.g / 255, 1 / 255, 1),
    blue: clamp(sample.b / 255, 1 / 255, 1),
  };
}

export function applyFilmBaseCompensation(value: number, sampleValue: number) {
  const invertedFilmBase = 1 - clamp(sampleValue, 1 / 255, 1);
  return clamp((value - invertedFilmBase) / Math.max(1 / 255, 1 - invertedFilmBase), 0, 1);
}

export function computeChannelShadowFloor(baseValue: number, maxBaseValue: number) {
  if (maxBaseValue <= 0.01 || baseValue >= maxBaseValue * 0.85) return 0;
  const ratio = baseValue / maxBaseValue;
  return clamp((0.85 - ratio) * 0.5, 0, 0.2);
}

function applyShadowFloorCorrection(value: number, floor: number) {
  if (floor <= 0) return value;
  return clamp((value - floor) / (1 - floor), 0, 1);
}

function mean(values: number[], start: number, end: number) {
  const safeStart = clamp(start, 0, values.length);
  const safeEnd = clamp(end, safeStart + 1, values.length);
  let sum = 0;
  for (let index = safeStart; index < safeEnd; index += 1) {
    sum += values[index];
  }
  return sum / Math.max(1, safeEnd - safeStart);
}

export function computeDensityBalance(
  imageData: ImageData,
  filmBaseSample: FilmBaseSample,
  profileId: ColorProfileId = 'srgb',
): DensityBalance {
  const { data, width, height } = imageData;
  const baseR = clamp(decodeProfileChannel(profileId, filmBaseSample.r / 255), DENSITY_EPSILON, 1);
  const baseG = clamp(decodeProfileChannel(profileId, filmBaseSample.g / 255), DENSITY_EPSILON, 1);
  const baseB = clamp(decodeProfileChannel(profileId, filmBaseSample.b / 255), DENSITY_EPSILON, 1);
  const densitiesR: number[] = [];
  const densitiesG: number[] = [];
  const densitiesB: number[] = [];
  const totalPixels = width * height;
  const sampleStride = Math.max(1, Math.floor(totalPixels / 50_000));

  for (let index = 0; index < data.length; index += 4 * sampleStride) {
    const r = decodeProfileChannel(profileId, data[index] / 255);
    const g = decodeProfileChannel(profileId, data[index + 1] / 255);
    const b = decodeProfileChannel(profileId, data[index + 2] / 255);

    if (r < 0.02 || g < 0.02 || b < 0.02) continue;
    if (r > 0.98 && g > 0.98 && b > 0.98) continue;

    const dR = -Math.log10(Math.max(r / baseR, DENSITY_EPSILON));
    const dG = -Math.log10(Math.max(g / baseG, DENSITY_EPSILON));
    const dB = -Math.log10(Math.max(b / baseB, DENSITY_EPSILON));

    if (dR > 0 && dG > 0 && dB > 0) {
      densitiesR.push(dR);
      densitiesG.push(dG);
      densitiesB.push(dB);
    }
  }

  if (densitiesR.length < 100) {
    return {
      scaleR: 1,
      scaleG: 1,
      scaleB: 0.6,
      source: 'auto-histogram',
    };
  }

  densitiesR.sort((left, right) => left - right);
  densitiesG.sort((left, right) => left - right);
  densitiesB.sort((left, right) => left - right);

  const lo = Math.floor(densitiesR.length * 0.2);
  const hi = Math.max(lo + 1, Math.floor(densitiesR.length * 0.8));
  const meanR = mean(densitiesR, lo, hi);
  const meanG = mean(densitiesG, lo, hi);
  const meanB = mean(densitiesB, lo, hi);

  return {
    scaleR: clamp(meanG / Math.max(meanR, DENSITY_EPSILON), 0.4, 2),
    scaleG: 1,
    scaleB: clamp(meanG / Math.max(meanB, DENSITY_EPSILON), 0.4, 2),
    source: 'auto-histogram',
  };
}

function applyFlareCorrection(value: number, floor: number, strength: number) {
  return Math.max(0, value - floor * strength);
}

export function applyLightSourceCorrection(value: number, bias: number) {
  return clamp(value / Math.max(bias, 0.05), 0, 1);
}

function applyInversionStage(
  r: number,
  g: number,
  b: number,
  filmType: FilmProfileType,
  filmBaseBalance: ReturnType<typeof getFilmBaseBalance>,
  redShadowFloor: number,
  greenShadowFloor: number,
  blueShadowFloor: number,
  flareFloorNormalized: [number, number, number],
  flareStrength: number,
  lightSourceBias: [number, number, number],
  residualBaseOffset: ResidualBaseOffset | null = null,
): [number, number, number] {
  r = applyFlareCorrection(r, flareFloorNormalized[0], flareStrength);
  g = applyFlareCorrection(g, flareFloorNormalized[1], flareStrength);
  b = applyFlareCorrection(b, flareFloorNormalized[2], flareStrength);

  r = applyLightSourceCorrection(r, lightSourceBias[0]);
  g = applyLightSourceCorrection(g, lightSourceBias[1]);
  b = applyLightSourceCorrection(b, lightSourceBias[2]);

  if (filmType !== 'slide') {
    r = 1 - r;
    g = 1 - g;
    b = 1 - b;
  }

  r = applyFilmBaseCompensation(r, filmBaseBalance.red);
  g = applyFilmBaseCompensation(g, filmBaseBalance.green);
  b = applyFilmBaseCompensation(b, filmBaseBalance.blue);

  r = applyShadowFloorCorrection(r, redShadowFloor);
  g = applyShadowFloorCorrection(g, greenShadowFloor);
  b = applyShadowFloorCorrection(b, blueShadowFloor);

  if (residualBaseOffset) {
    r = Math.max(0, r - residualBaseOffset[0]);
    g = Math.max(0, g - residualBaseOffset[1]);
    b = Math.max(0, b - residualBaseOffset[2]);
  }

  return [r, g, b];
}

export function computeResidualBaseOffset(
  imageData: ImageData,
  settings: ConversionSettings,
  isColor: boolean,
  filmType: FilmProfileType = 'negative',
  inputProfileId: ColorProfileId = 'srgb',
  outputProfileId: ColorProfileId = 'srgb',
  lightSourceBias: [number, number, number] = [1, 1, 1],
  flareFloor: [number, number, number] | null = null,
): ResidualBaseOffset | null {
  if (!isColor || filmType !== 'negative' || settings.residualBaseCorrection === false) {
    return null;
  }

  const { data, width, height } = imageData;
  const filmBaseBalance = getFilmBaseBalance(settings.filmBaseSample);
  const maxBase = Math.max(filmBaseBalance.red, filmBaseBalance.green, filmBaseBalance.blue);
  const redShadowFloor = computeChannelShadowFloor(filmBaseBalance.red, maxBase);
  const greenShadowFloor = computeChannelShadowFloor(filmBaseBalance.green, maxBase);
  const blueShadowFloor = computeChannelShadowFloor(filmBaseBalance.blue, maxBase);
  const flareStrength = (settings.flareCorrection ?? 50) / 100;
  const flareFloorNormalized: [number, number, number] = flareFloor
    ? [flareFloor[0] / 255, flareFloor[1] / 255, flareFloor[2] / 255]
    : [0, 0, 0];
  const sampleStride = Math.max(1, Math.floor((width * height) / 50_000));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  for (let index = 0; index < data.length; index += 4 * sampleStride) {
    let r = data[index] / 255;
    let g = data[index + 1] / 255;
    let b = data[index + 2] / 255;

    [r, g, b] = convertRgbBetweenProfiles(r, g, b, inputProfileId, outputProfileId);
    [r, g, b] = applyInversionStage(
      r,
      g,
      b,
      filmType,
      filmBaseBalance,
      redShadowFloor,
      greenShadowFloor,
      blueShadowFloor,
      flareFloorNormalized,
      flareStrength,
      lightSourceBias,
    );

    rs.push(r);
    gs.push(g);
    bs.push(b);
  }

  if (rs.length < 64) {
    return null;
  }

  rs.sort((left, right) => left - right);
  gs.sort((left, right) => left - right);
  bs.sort((left, right) => left - right);
  const p1Index = clamp(Math.floor(rs.length * 0.01), 0, rs.length - 1);

  return [rs[p1Index], gs[p1Index], bs[p1Index]];
}

function mixBlackAndWhiteChannels(r: number, g: number, b: number, redMix: number, greenMix: number, blueMix: number) {
  const baseGray = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return clamp(
    baseGray
      + (r - baseGray) * (redMix / 100)
      + (g - baseGray) * (greenMix / 100)
      + (b - baseGray) * (blueMix / 100),
    0,
    1,
  );
}

function applyBlackAndWhiteTone(gray: number, tone: number): [number, number, number] {
  const toneStrength = clamp(Math.abs(tone) / 100, 0, 1);

  if (toneStrength <= 0) {
    return [gray, gray, gray];
  }

  const toneColor = tone >= 0
    ? [1.08, 0.96, 0.82]
    : [0.84, 0.93, 1.08];
  const mixFactor = toneStrength;

  return [
    gray + (gray * toneColor[0] - gray) * mixFactor,
    gray + (gray * toneColor[1] - gray) * mixFactor,
    gray + (gray * toneColor[2] - gray) * mixFactor,
  ];
}

export function resolveEffectiveSettings(
  settings: ConversionSettings,
  maskTuning?: MaskTuning,
) {
  return maskTuning ? {
    ...settings,
    highlightProtection: clamp(settings.highlightProtection + maskTuning.highlightProtectionBias * 100, 0, 100),
    blackPoint: clamp(settings.blackPoint + maskTuning.blackPointBias * 100, 0, 80),
  } : settings;
}

function composeCurveLut(outer: Uint8Array, inner: Uint8Array) {
  const result = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    result[index] = outer[inner[index]];
  }
  return result;
}

function createIdentityCurveLut() {
  const identity = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    identity[index] = index;
  }
  return identity;
}

function buildComposedCurveLuts(
  settings: ConversionSettings,
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
) {
  const identity = createIdentityCurveLut();
  const labMaster = labStyleToneCurve ? createCurveLut(labStyleToneCurve) : identity;
  const labR = labStyleChannelCurves?.r ? createCurveLut(labStyleChannelCurves.r) : identity;
  const labG = labStyleChannelCurves?.g ? createCurveLut(labStyleChannelCurves.g) : identity;
  const labB = labStyleChannelCurves?.b ? createCurveLut(labStyleChannelCurves.b) : identity;
  const userMaster = createCurveLut(settings.curves.rgb);
  const userR = createCurveLut(settings.curves.red);
  const userG = createCurveLut(settings.curves.green);
  const userB = createCurveLut(settings.curves.blue);

  return {
    master: composeCurveLut(userMaster, labMaster),
    r: composeCurveLut(userR, labR),
    g: composeCurveLut(userG, labG),
    b: composeCurveLut(userB, labB),
  };
}

export function computeHighlightDensity(histogram: HistogramData) {
  const total = histogram.l.reduce((sum, count) => sum + count, 0);
  if (total <= 0) {
    return 0;
  }

  let highlightCount = 0;
  for (let index = 240; index < histogram.l.length; index += 1) {
    highlightCount += histogram.l[index];
  }

  return highlightCount / total;
}

export function buildProcessingUniforms(
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
  maskTuning?: MaskTuning,
  colorMatrix?: ColorMatrix,
  tonalCharacter?: TonalCharacter,
  labTonalCharacterOverride?: Partial<TonalCharacter>,
  labSaturationBias = 0,
  labTemperatureBias = 0,
  highlightDensityEstimate = 0,
  inputProfileId: ColorProfileId = 'srgb',
  outputProfileId: ColorProfileId = 'srgb',
  _profileId: string | null = null,
  filmType: FilmProfileType = 'negative',
  residualBaseOffset: ResidualBaseOffset | null = null,
  flareFloor: [number, number, number] | null = null,
  lightSourceBias: [number, number, number] = [1, 1, 1],
) {
  const effectiveSettings = resolveEffectiveSettings(settings, maskTuning);
  const effectiveTonalCharacter = tonalCharacter
    ? { ...tonalCharacter, ...labTonalCharacterOverride }
    : (labTonalCharacterOverride ? {
      shadowLift: labTonalCharacterOverride.shadowLift ?? 0,
      midtoneAnchor: labTonalCharacterOverride.midtoneAnchor ?? 0,
      highlightRolloff: labTonalCharacterOverride.highlightRolloff ?? 0.5,
    } : undefined);
  const filmBaseBalance = getFilmBaseBalance(effectiveSettings.filmBaseSample);
  const profileTransform = getLinearTransformMatrix(inputProfileId, outputProfileId);
  const flareCorrection = effectiveSettings.flareCorrection ?? 50;
  const maxBase = Math.max(filmBaseBalance.red, filmBaseBalance.green, filmBaseBalance.blue);
  const normalizedFlareFloor: [number, number, number] = flareFloor
    ? [flareFloor[0] / 255, flareFloor[1] / 255, flareFloor[2] / 255]
    : [0, 0, 0];

  return new Float32Array([
    comparisonMode === 'processed' ? 1 : 0,
    isColor ? 1 : 0,
    effectiveSettings.blackAndWhite.enabled ? 1 : 0,
    filmType === 'slide' ? 1 : 0,

    Math.pow(2, effectiveSettings.exposure / 50),
    (259 * (effectiveSettings.contrast + 255)) / (255 * (259 - effectiveSettings.contrast)),
    clamp((effectiveSettings.saturation + labSaturationBias) / 100, 0, 2),
    0,

    filmBaseBalance.red,
    filmBaseBalance.green,
    filmBaseBalance.blue,
    computeChannelShadowFloor(filmBaseBalance.red, maxBase),

    effectiveSettings.redBalance,
    effectiveSettings.greenBalance,
    effectiveSettings.blueBalance,
    0,

    clamp((effectiveSettings.temperature + labTemperatureBias) / 255, -1, 1),
    effectiveSettings.tint / 255,
    effectiveSettings.blackPoint / 255,
    effectiveSettings.whitePoint / 255,

    effectiveSettings.highlightProtection,
    effectiveTonalCharacter?.shadowLift ?? 0,
    effectiveTonalCharacter?.midtoneAnchor ?? 0,
    effectiveTonalCharacter?.highlightRolloff ?? 0.5,

    effectiveSettings.blackAndWhite.redMix / 100,
    effectiveSettings.blackAndWhite.greenMix / 100,
    effectiveSettings.blackAndWhite.blueMix / 100,
    effectiveSettings.blackAndWhite.tone / 100,

    (effectiveSettings.shadowRecovery ?? 0) / 100,
    (effectiveSettings.midtoneContrast ?? 0) / 100,
    clamp(highlightDensityEstimate, 0, 1),
    computeChannelShadowFloor(filmBaseBalance.green, maxBase),

    normalizedFlareFloor[0],
    normalizedFlareFloor[1],
    normalizedFlareFloor[2],
    flareCorrection / 100,

    colorMatrix?.[0] ?? 1,
    colorMatrix?.[1] ?? 0,
    colorMatrix?.[2] ?? 0,
    0,

    colorMatrix?.[3] ?? 0,
    colorMatrix?.[4] ?? 1,
    colorMatrix?.[5] ?? 0,
    0,

    colorMatrix?.[6] ?? 0,
    colorMatrix?.[7] ?? 0,
    colorMatrix?.[8] ?? 1,
    0,

    colorMatrix ? 1 : 0,
    getTransferMode(inputProfileId),
    getTransferMode(outputProfileId),
    0,

    profileTransform[0],
    profileTransform[1],
    profileTransform[2],
    0,

    profileTransform[3],
    profileTransform[4],
    profileTransform[5],
    0,

    profileTransform[6],
    profileTransform[7],
    profileTransform[8],
    0,

    lightSourceBias[0],
    lightSourceBias[1],
    lightSourceBias[2],
    settings.flatFieldEnabled ? 1 : 0,

    residualBaseOffset?.[0] ?? 0,
    residualBaseOffset?.[1] ?? 0,
    residualBaseOffset?.[2] ?? 0,
    computeChannelShadowFloor(filmBaseBalance.blue, maxBase),
  ]);
}

export function buildCurveLutBuffer(
  settings: ConversionSettings,
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
) {
  const lut = buildComposedCurveLuts(settings, labStyleToneCurve, labStyleChannelCurves);
  const result = new Float32Array(1024);

  for (let index = 0; index < 256; index += 1) {
    result[index] = lut.master[index] / 255;
    result[256 + index] = lut.r[index] / 255;
    result[512 + index] = lut.g[index] / 255;
    result[768 + index] = lut.b[index] / 255;
  }

  return result;
}

export function buildEmptyHistogram(): HistogramData {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    l: new Array(256).fill(0),
  };
}

export function accumulateHistogram(
  histogram: HistogramData,
  data: Uint8ClampedArray,
) {
  for (let index = 0; index < data.length; index += 4) {
    histogram.r[data[index]] += 1;
    histogram.g[data[index + 1]] += 1;
    histogram.b[data[index + 2]] += 1;
    histogram.l[Math.round(LUMA_R * data[index] + LUMA_G * data[index + 1] + LUMA_B * data[index + 2])] += 1;
  }
}

function gaussianBlur1D(
  src: Uint8ClampedArray,
  dst: Float32Array,
  width: number,
  height: number,
  horizontal: boolean,
  kernelRadius: number,
): void {
  const size = Math.max(1, Math.round(kernelRadius));
  const kernelSize = size * 2 + 1;
  const kernel = new Float32Array(kernelSize);
  const sigma = kernelRadius * 0.65 + 0.35;
  let kernelSum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const d = i - size;
    kernel[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    kernelSum += kernel[i];
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= kernelSum;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0, sumG = 0, sumB = 0;
      for (let k = -size; k <= size; k++) {
        const sx = horizontal ? clamp(x + k, 0, width - 1) : x;
        const sy = horizontal ? y : clamp(y + k, 0, height - 1);
        const idx = (sy * width + sx) * 4;
        const w = kernel[k + size];
        sumR += src[idx] * w;
        sumG += src[idx + 1] * w;
        sumB += src[idx + 2] * w;
      }
      const dIdx = (y * width + x) * 4;
      dst[dIdx] = sumR;
      dst[dIdx + 1] = sumG;
      dst[dIdx + 2] = sumB;
    }
  }
}

function getScratchBuffers(needed: number) {
  if (scratchSize < needed || !scratchUint8 || !scratchFloat32) {
    scratchUint8 = new Uint8ClampedArray(needed);
    scratchFloat32 = new Float32Array(needed);
    scratchSize = needed;
  }

  return {
    scratchUint8,
    scratchFloat32,
  };
}

function separableGaussianBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const len = width * height * 4;
  const { scratchUint8: temp, scratchFloat32: hPass } = getScratchBuffers(len);
  gaussianBlur1D(data, hPass, width, height, true, radius);
  for (let i = 0; i < len; i++) temp[i] = clamp(Math.round(hPass[i]), 0, 255);
  const result = new Float32Array(len);
  gaussianBlur1D(temp, result, width, height, false, radius);
  return result;
}

export function releaseScratchBuffers() {
  scratchUint8 = null;
  scratchFloat32 = null;
  scratchSize = 0;
}

function applyNoiseReduction(imageData: ImageData, strength: number): void {
  if (strength <= 0) return;
  const { data, width, height } = imageData;
  const factor = strength / 100;
  const blurred = separableGaussianBlur(data, width, height, 1.5);

  for (let i = 0; i < data.length; i += 4) {
    const lumOrig = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
    const lumBlur = LUMA_R * blurred[i] + LUMA_G * blurred[i + 1] + LUMA_B * blurred[i + 2];
    const lumNew = lumOrig + (lumBlur - lumOrig) * factor;
    const lumScale = lumOrig > 0.001 ? lumNew / lumOrig : 1;
    data[i] = clamp(Math.round(data[i] * lumScale), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] * lumScale), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] * lumScale), 0, 255);
  }
}

function applySharpen(imageData: ImageData, radius: number, amount: number): void {
  if (amount <= 0) return;
  const { data, width, height } = imageData;
  const factor = amount / 100;
  const blurred = separableGaussianBlur(data, width, height, radius);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(Math.round(data[i] + factor * (data[i] - blurred[i])), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] + factor * (data[i + 1] - blurred[i + 1])), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] + factor * (data[i + 2] - blurred[i + 2])), 0, 255);
  }
}

export function processImageData(
  imageData: ImageData,
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
  maskTuning?: MaskTuning,
  colorMatrix?: ColorMatrix,
  tonalCharacter?: TonalCharacter,
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
  labTonalCharacterOverride?: Partial<TonalCharacter>,
  labSaturationBias = 0,
  labTemperatureBias = 0,
  highlightDensityEstimate = 0,
  inputProfileId: ColorProfileId = 'srgb',
  outputProfileId: ColorProfileId = 'srgb',
  _profileId: string | null = null,
  filmType: FilmProfileType = 'negative',
  residualBaseOffset: ResidualBaseOffset | null = null,
  flareFloor: [number, number, number] | null = null,
  lightSourceBias: [number, number, number] = [1, 1, 1],
): HistogramData {
  const effectiveSettings = resolveEffectiveSettings(settings, maskTuning);
  const effectiveTonalCharacter = tonalCharacter
    ? { ...tonalCharacter, ...labTonalCharacterOverride }
    : (labTonalCharacterOverride ? {
      shadowLift: labTonalCharacterOverride.shadowLift ?? 0,
      midtoneAnchor: labTonalCharacterOverride.midtoneAnchor ?? 0,
      highlightRolloff: labTonalCharacterOverride.highlightRolloff ?? 0.5,
    } : undefined);

  const data = imageData.data;
  const lut = buildComposedCurveLuts(effectiveSettings, labStyleToneCurve, labStyleChannelCurves);
  const fusedR = new Float32Array(256);
  const fusedG = new Float32Array(256);
  const fusedB = new Float32Array(256);
  const histogram = buildEmptyHistogram();
  const exposureFactor = Math.pow(2, effectiveSettings.exposure / 50);
  const safeContrast = clamp(effectiveSettings.contrast, -255, 258);
  const contrastFactor = (259 * (safeContrast + 255)) / (255 * Math.max(1, 259 - safeContrast));
  const saturationFactor = clamp((effectiveSettings.saturation + labSaturationBias) / 100, 0, 2);
  const filmBaseBalance = getFilmBaseBalance(effectiveSettings.filmBaseSample);
  const blackPoint = effectiveSettings.blackPoint / 255;
  const whitePoint = effectiveSettings.whitePoint / 255;
  const temperatureShift = clamp((effectiveSettings.temperature + labTemperatureBias) / 255, -1, 1);
  const tintShift = clamp(effectiveSettings.tint / 255, -1, 1);
  const shouldUseBlackAndWhite = !isColor || effectiveSettings.blackAndWhite.enabled;
  const flareStrength = (effectiveSettings.flareCorrection ?? 50) / 100;
  const flareFloorNormalized: [number, number, number] = flareFloor
    ? [flareFloor[0] / 255, flareFloor[1] / 255, flareFloor[2] / 255]
    : [0, 0, 0];
  const maxBase = Math.max(filmBaseBalance.red, filmBaseBalance.green, filmBaseBalance.blue);
  const redShadowFloor = computeChannelShadowFloor(filmBaseBalance.red, maxBase);
  const greenShadowFloor = computeChannelShadowFloor(filmBaseBalance.green, maxBase);
  const blueShadowFloor = computeChannelShadowFloor(filmBaseBalance.blue, maxBase);

  for (let index = 0; index < 256; index += 1) {
    fusedR[index] = lut.r[lut.master[index]] / 255;
    fusedG[index] = lut.g[lut.master[index]] / 255;
    fusedB[index] = lut.b[lut.master[index]] / 255;
  }

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index] / 255;
    let g = data[index + 1] / 255;
    let b = data[index + 2] / 255;

    [r, g, b] = convertRgbBetweenProfiles(r, g, b, inputProfileId, outputProfileId);

    if (comparisonMode === 'processed') {
      [r, g, b] = applyInversionStage(
        r,
        g,
        b,
        filmType,
        filmBaseBalance,
        redShadowFloor,
        greenShadowFloor,
        blueShadowFloor,
        flareFloorNormalized,
        flareStrength,
        lightSourceBias,
        residualBaseOffset,
      );

      if (colorMatrix) {
        [r, g, b] = applyColorMatrix(r, g, b, colorMatrix);
      }

      if (isColor) {
        r *= effectiveSettings.redBalance;
        g *= effectiveSettings.greenBalance;
        b *= effectiveSettings.blueBalance;
        if (!effectiveSettings.blackAndWhite.enabled) {
          r += temperatureShift;
          b -= temperatureShift;
          g += tintShift;
        }
      }

      if (shouldUseBlackAndWhite) {
        const gray = isColor
          ? mixBlackAndWhiteChannels(
            r,
            g,
            b,
            effectiveSettings.blackAndWhite.redMix,
            effectiveSettings.blackAndWhite.greenMix,
            effectiveSettings.blackAndWhite.blueMix,
          )
          : LUMA_R * r + LUMA_G * g + LUMA_B * b;
        r = gray;
        g = gray;
        b = gray;
      }

      r *= exposureFactor;
      g *= exposureFactor;
      b *= exposureFactor;

      r = applyWhiteBlackPoint(r, blackPoint, whitePoint);
      g = applyWhiteBlackPoint(g, blackPoint, whitePoint);
      b = applyWhiteBlackPoint(b, blackPoint, whitePoint);

      r = contrastFactor * (r - 0.5) + 0.5;
      g = contrastFactor * (g - 0.5) + 0.5;
      b = contrastFactor * (b - 0.5) + 0.5;

      r = applyShadowRecovery(r, effectiveSettings.shadowRecovery ?? 0);
      g = applyShadowRecovery(g, effectiveSettings.shadowRecovery ?? 0);
      b = applyShadowRecovery(b, effectiveSettings.shadowRecovery ?? 0);

      r = applyMidtoneContrast(r, effectiveSettings.midtoneContrast ?? 0);
      g = applyMidtoneContrast(g, effectiveSettings.midtoneContrast ?? 0);
      b = applyMidtoneContrast(b, effectiveSettings.midtoneContrast ?? 0);

      r = applyAdaptiveHighlightRecovery(r, effectiveSettings.highlightProtection, highlightDensityEstimate, effectiveTonalCharacter);
      g = applyAdaptiveHighlightRecovery(g, effectiveSettings.highlightProtection, highlightDensityEstimate, effectiveTonalCharacter);
      b = applyAdaptiveHighlightRecovery(b, effectiveSettings.highlightProtection, highlightDensityEstimate, effectiveTonalCharacter);

      const gray = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      if (isColor && !effectiveSettings.blackAndWhite.enabled) {
        r = gray + (r - gray) * saturationFactor;
        g = gray + (g - gray) * saturationFactor;
        b = gray + (b - gray) * saturationFactor;
      } else {
        [r, g, b] = shouldUseBlackAndWhite
          ? applyBlackAndWhiteTone(gray, effectiveSettings.blackAndWhite.tone)
          : [gray, gray, gray];
      }

      const mappedR = clamp(Math.round(clamp(r, 0, 1) * 255), 0, 255);
      const mappedG = clamp(Math.round(clamp(g, 0, 1) * 255), 0, 255);
      const mappedB = clamp(Math.round(clamp(b, 0, 1) * 255), 0, 255);

      r = fusedR[mappedR];
      g = fusedG[mappedG];
      b = fusedB[mappedB];
    }

    const finalR = clamp(Math.round(r * 255), 0, 255);
    const finalG = clamp(Math.round(g * 255), 0, 255);
    const finalB = clamp(Math.round(b * 255), 0, 255);

    data[index] = finalR;
    data[index + 1] = finalG;
    data[index + 2] = finalB;
  }

  // Spatial operations (after per-pixel pipeline)
  if (comparisonMode === 'processed') {
    if (effectiveSettings.noiseReduction.enabled && effectiveSettings.noiseReduction.luminanceStrength > 0) {
      applyNoiseReduction(imageData, effectiveSettings.noiseReduction.luminanceStrength);
    }
    if (effectiveSettings.sharpen.enabled && effectiveSettings.sharpen.amount > 0) {
      applySharpen(imageData, effectiveSettings.sharpen.radius, effectiveSettings.sharpen.amount);
    }
  }

  accumulateHistogram(histogram, data);

  return histogram;
}
