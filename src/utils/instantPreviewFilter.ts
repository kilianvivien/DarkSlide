import type { ConversionSettings, CurvePoint } from '../types';
import { buildCurveLutBuffer, resolveEffectiveSettings } from './imagePipeline';
import { clamp } from './math';

export type InstantPreviewAdjustments = Pick<
  ConversionSettings,
  'exposure' | 'contrast' | 'saturation'
>;

export type InstantPreviewBaseline = InstantPreviewAdjustments & {
  comparisonMode: 'processed' | 'original';
  curveLuts: InstantPreviewCurveLuts;
};

type CurveChannelOverrides = {
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
};

type InstantPreviewCurveLuts = {
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
};

export type InstantCurvePreviewTables = {
  red: string;
  green: string;
  blue: string;
};

const IDENTITY_EPSILON = 0.0001;

function contrastFactor(contrast: number) {
  const safeContrast = clamp(contrast, -255, 258);
  return (259 * (safeContrast + 255)) / (255 * Math.max(1, 259 - safeContrast));
}

function buildOutputCurveLuts(
  settings: ConversionSettings,
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
): InstantPreviewCurveLuts {
  const buffer = buildCurveLutBuffer(settings, labStyleToneCurve, labStyleChannelCurves);
  const result: InstantPreviewCurveLuts = {
    red: new Uint8Array(256),
    green: new Uint8Array(256),
    blue: new Uint8Array(256),
  };

  for (let index = 0; index < 256; index += 1) {
    const masterIndex = clamp(Math.round(buffer[index] * 255), 0, 255);
    result.red[index] = clamp(Math.round(buffer[256 + masterIndex] * 255), 0, 255);
    result.green[index] = clamp(Math.round(buffer[512 + masterIndex] * 255), 0, 255);
    result.blue[index] = clamp(Math.round(buffer[768 + masterIndex] * 255), 0, 255);
  }

  return result;
}

function lutsMatch(left: Uint8Array, right: Uint8Array) {
  for (let index = 0; index < 256; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function buildRelativeTableValues(baseline: Uint8Array, current: Uint8Array) {
  const values = new Array<string>(256);
  for (let output = 0; output < 256; output += 1) {
    let closestInput = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let input = 0; input < 256; input += 1) {
      const distance = Math.abs(baseline[input] - output);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestInput = input;
        if (distance === 0) break;
      }
    }
    values[output] = (current[closestInput] / 255).toFixed(4);
  }
  return values.join(' ');
}

export function captureInstantPreviewBaseline(
  settings: ConversionSettings,
  comparisonMode: InstantPreviewBaseline['comparisonMode'],
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
): InstantPreviewBaseline {
  const effectiveSettings = resolveEffectiveSettings(settings);
  return {
    exposure: effectiveSettings.exposure,
    contrast: effectiveSettings.contrast,
    saturation: effectiveSettings.saturation,
    comparisonMode,
    curveLuts: buildOutputCurveLuts(settings, labStyleToneCurve, labStyleChannelCurves),
  };
}

export function createInstantCurvePreviewTables(
  baseline: InstantPreviewBaseline | null,
  current: ConversionSettings | null,
  comparisonMode: InstantPreviewBaseline['comparisonMode'],
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: CurveChannelOverrides,
): InstantCurvePreviewTables | null {
  if (
    !baseline
    || !current
    || baseline.comparisonMode !== 'processed'
    || comparisonMode !== 'processed'
  ) {
    return null;
  }

  const currentLuts = buildOutputCurveLuts(current, labStyleToneCurve, labStyleChannelCurves);
  if (
    lutsMatch(baseline.curveLuts.red, currentLuts.red)
    && lutsMatch(baseline.curveLuts.green, currentLuts.green)
    && lutsMatch(baseline.curveLuts.blue, currentLuts.blue)
  ) {
    return null;
  }

  return {
    red: buildRelativeTableValues(baseline.curveLuts.red, currentLuts.red),
    green: buildRelativeTableValues(baseline.curveLuts.green, currentLuts.green),
    blue: buildRelativeTableValues(baseline.curveLuts.blue, currentLuts.blue),
  };
}

/**
 * Builds a cheap display-only approximation while the accurate worker render
 * is in flight. Ratios make the filter relative to the pixels currently on
 * screen, so a completed draft never receives the same adjustment twice.
 */
export function createInstantPreviewFilter(
  baseline: InstantPreviewBaseline | null,
  current: ConversionSettings | null,
  comparisonMode: InstantPreviewBaseline['comparisonMode'],
) {
  if (
    !baseline
    || !current
    || baseline.comparisonMode !== 'processed'
    || comparisonMode !== 'processed'
  ) {
    return 'none';
  }

  const effectiveCurrent = resolveEffectiveSettings(current);
  const brightness = Math.pow(2, (effectiveCurrent.exposure - baseline.exposure) / 50);
  const contrast = contrastFactor(effectiveCurrent.contrast) / contrastFactor(baseline.contrast);
  // Chroma cannot be reconstructed once a rendered baseline reaches exactly
  // zero saturation. A small denominator keeps the preview stable until the
  // worker supplies fresh pixels.
  const saturation = clamp(effectiveCurrent.saturation / Math.max(1, baseline.saturation), 0, 8);

  if (
    Math.abs(brightness - 1) < IDENTITY_EPSILON
    && Math.abs(contrast - 1) < IDENTITY_EPSILON
    && Math.abs(saturation - 1) < IDENTITY_EPSILON
  ) {
    return 'none';
  }

  return `brightness(${brightness.toFixed(4)}) contrast(${contrast.toFixed(4)}) saturate(${saturation.toFixed(4)})`;
}
