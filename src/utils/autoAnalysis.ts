import type { AutoAnalyzeResult, ConversionSettings, Curves, HistogramData } from '../types';
import { clamp } from './math';

const WB_MARGIN_RATIO = 0.04;
const WB_MARGIN_MIN = 8;
const WB_MARGIN_MAX = 48;
const WB_LUMA_MIN = 72;
const WB_LUMA_MAX = 225;
const WB_CHANNEL_MIN = 12;
const WB_CHANNEL_MAX = 248;
const WB_MAX_SATURATION = 0.35;
const WB_MIN_SAMPLE_COUNT = 256;
const WB_MIN_SAMPLE_RATIO = 0.0005;
const WB_SAMPLE_STRIDE = 2;
const FLOOR_THRESHOLD = 20;
const FLOOR_SPREAD_THRESHOLD = 15;
const FLOOR_PERCENTILE = 0.01;
const MIDTONE_COMPRESSION_THRESHOLD = 0.35;
const MIDTONE_MAX_BOOST = 25;
const AUTO_EXPOSURE_TARGET = 127.5;
const AUTO_EXPOSURE_LIMIT = 30;
const COLOR_NEGATIVE_POSITIVE_EXPOSURE_STRENGTH = 0.6;
const BW_NEGATIVE_POSITIVE_EXPOSURE_DEADBAND = 6;
const BW_NEGATIVE_POSITIVE_EXPOSURE_STRENGTH = 0.25;
const BW_NEGATIVE_POSITIVE_EXPOSURE_LIMIT = 6;
const AUTO_BLACK_POINT_STRENGTH = 0.25;
const AUTO_WHITE_POINT_STRENGTH = 0.5;
const WB_MAX_SATURATION_RELAXED = 0.55;
const WB_MINKOWSKI_POWER = 6;
const NEGATIVE_WB_DIRECT_GAIN_RATIO = 1.28;
const NEGATIVE_WB_REJECT_GAIN_RATIO = 3;
const NEGATIVE_WB_MIN_SAMPLE_RATIO = 0.002;
const NEGATIVE_WB_FULL_SAMPLE_RATIO = 0.08;
const NEGATIVE_WB_DAMPED_MAX_GAIN_RATIO = 1.18;
const MONO_MARGIN_RATIO = 0.05;
const MONO_MARGIN_MIN = 8;
const MONO_MARGIN_MAX = 64;
const MONO_LUMA_MIN = 16;
const MONO_LUMA_MAX = 239;
const MONO_MIN_SAMPLE_COUNT = 256;
const MONO_SAMPLE_STRIDE = 3;
const MONO_LOW_CHROMA_MAX = 12;
const MONO_HIGH_CHROMA_MIN = 28;
const MONO_MEAN_CHROMA_MAX = 16;
const MONO_LOW_CHROMA_RATIO_MIN = 0.6;
const MONO_HIGH_CHROMA_RATIO_MAX = 0.12;
const MONO_LOW_RESIDUAL_MAX = 0.24;
const MONO_HIGH_RESIDUAL_MIN = 0.5;
const MONO_MEAN_RESIDUAL_MAX = 0.2;
const MONO_LOW_RESIDUAL_RATIO_MIN = 0.82;
const MONO_HIGH_RESIDUAL_RATIO_MAX = 0.08;

function createIdentityCurves(): Curves {
  return {
    rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  };
}

/**
 * Build a stable analysis pass from the source conversion rather than from the
 * currently edited preview. Geometry and film-base calibration describe the
 * source, so they are retained. All controls that Auto can influence are
 * neutralized to prevent Auto-on-Auto feedback.
 */
export function createAutoAnalysisSettings(
  current: ConversionSettings,
  profileDefaults: ConversionSettings,
): ConversionSettings {
  return {
    ...structuredClone(profileDefaults),
    exposure: 0,
    contrast: 0,
    saturation: 100,
    shadowRecovery: 0,
    midtoneContrast: 0,
    temperature: 0,
    tint: 0,
    blackPoint: 0,
    whitePoint: 255,
    highlightProtection: 0,
    curves: createIdentityCurves(),
    rotation: current.rotation,
    levelAngle: current.levelAngle,
    crop: structuredClone(current.crop),
    filmBaseSample: current.filmBaseSample ? { ...current.filmBaseSample } : null,
    filmBaseSampleSource: current.filmBaseSampleSource,
    residualBaseCorrection: current.residualBaseCorrection,
    blackAndWhite: {
      ...structuredClone(profileDefaults.blackAndWhite),
      enabled: current.blackAndWhite.enabled,
    },
    sharpen: { ...profileDefaults.sharpen, enabled: false },
    noiseReduction: { ...profileDefaults.noiseReduction, enabled: false },
    dustRemoval: profileDefaults.dustRemoval
      ? { ...structuredClone(profileDefaults.dustRemoval), autoEnabled: false, marks: [] }
      : undefined,
  };
}

/**
 * Auto owns these fields. Always derive them from the profile baseline and the
 * latest analysis result instead of retaining values from a previous Auto run.
 */
export function createAutoAdjustmentPatch(
  profileDefaults: ConversionSettings,
  result: AutoAnalyzeResult,
): Pick<
  ConversionSettings,
  | 'toneEnabled'
  | 'toneRangeEnabled'
  | 'whiteBalanceEnabled'
  | 'colorControlsEnabled'
  | 'exposure'
  | 'contrast'
  | 'saturation'
  | 'shadowRecovery'
  | 'midtoneContrast'
  | 'flareCorrection'
  | 'temperature'
  | 'tint'
  | 'redBalance'
  | 'greenBalance'
  | 'blueBalance'
  | 'blackPoint'
  | 'whitePoint'
  | 'highlightProtection'
  | 'curves'
> {
  const curves = structuredClone(profileDefaults.curves);
  const whiteBalance = applyWhiteBalanceGains(profileDefaults, result.whiteBalanceGains);

  if (result.midtoneBoostPoint) {
    curves.rgb = [{ x: 0, y: 0 }, result.midtoneBoostPoint, { x: 255, y: 255 }];
  }
  if (result.suggestedCurves?.redFloor !== null && result.suggestedCurves?.redFloor !== undefined) {
    curves.red = [{ x: 0, y: 0 }, { x: result.suggestedCurves.redFloor, y: 0 }, { x: 255, y: 255 }];
  }
  if (result.suggestedCurves?.greenFloor !== null && result.suggestedCurves?.greenFloor !== undefined) {
    curves.green = [{ x: 0, y: 0 }, { x: result.suggestedCurves.greenFloor, y: 0 }, { x: 255, y: 255 }];
  }
  if (result.suggestedCurves?.blueFloor !== null && result.suggestedCurves?.blueFloor !== undefined) {
    curves.blue = [{ x: 0, y: 0 }, { x: result.suggestedCurves.blueFloor, y: 0 }, { x: 255, y: 255 }];
  }

  return {
    toneEnabled: profileDefaults.toneEnabled,
    toneRangeEnabled: profileDefaults.toneRangeEnabled,
    whiteBalanceEnabled: profileDefaults.whiteBalanceEnabled,
    colorControlsEnabled: profileDefaults.colorControlsEnabled,
    exposure: result.exposure,
    contrast: result.contrast ?? profileDefaults.contrast,
    saturation: profileDefaults.saturation,
    shadowRecovery: profileDefaults.shadowRecovery,
    midtoneContrast: profileDefaults.midtoneContrast,
    flareCorrection: profileDefaults.flareCorrection,
    // Auto WB uses diagonal gains. Keep the additive controls at their profile
    // values so repeated Auto runs cannot accumulate offsets or shift black.
    temperature: profileDefaults.temperature,
    tint: profileDefaults.tint,
    ...whiteBalance,
    blackPoint: result.blackPoint,
    whitePoint: result.whitePoint,
    highlightProtection: profileDefaults.highlightProtection,
    curves,
  };
}

export type MonochromeSuggestionAnalysis = {
  isLikelyMonochrome: boolean;
  sampleCount: number;
  meanChroma: number;
  lowChromaRatio: number;
  highChromaRatio: number;
  meanNormalizedResidual: number;
  lowResidualRatio: number;
  highResidualRatio: number;
};

function total(bins: number[]) {
  return bins.reduce((sum, value) => sum + value, 0);
}

function percentile(bins: number[], fraction: number) {
  const count = total(bins);
  if (count <= 0) {
    return fraction <= 0.5 ? 0 : 255;
  }

  const target = count * fraction;
  let seen = 0;
  for (let index = 0; index < bins.length; index += 1) {
    seen += bins[index];
    if (seen >= target) {
      return index;
    }
  }

  return bins.length - 1;
}

export type AutoExposureMode = 'standard' | 'color-negative' | 'black-and-white-negative';

export function analyzeExposure(
  histogram: HistogramData,
  mode: AutoExposureMode = 'standard',
): Pick<AutoAnalyzeResult, 'exposure' | 'blackPoint' | 'whitePoint'> {
  const p1 = percentile(histogram.l, 0.01);
  const p99 = percentile(histogram.l, 0.99);
  const midpoint = Math.max(1, (p1 + p99) / 2);

  // The render pipeline applies Density as 2^(value / 50), so solve in stops
  // instead of treating the control as a linear offset. Keep Auto within 0.6
  // stop in either direction. Negative conversion has already established the
  // broad density range, and a larger automatic move tends to erase high-key
  // or low-key intent.
  const solvedExposure = clamp(
    Math.round(50 * Math.log2(AUTO_EXPOSURE_TARGET / midpoint)),
    -AUTO_EXPOSURE_LIMIT,
    AUTO_EXPOSURE_LIMIT,
  );
  const exposure = mode === 'black-and-white-negative'
    ? solvedExposure <= BW_NEGATIVE_POSITIVE_EXPOSURE_DEADBAND
      ? Math.min(0, solvedExposure)
      : Math.min(
        BW_NEGATIVE_POSITIVE_EXPOSURE_LIMIT,
        Math.round(
          (solvedExposure - BW_NEGATIVE_POSITIVE_EXPOSURE_DEADBAND)
          * BW_NEGATIVE_POSITIVE_EXPOSURE_STRENGTH,
        ),
      )
    : mode === 'color-negative' && solvedExposure > 0
      ? Math.round(solvedExposure * COLOR_NEGATIVE_POSITIVE_EXPOSURE_STRENGTH)
      : solvedExposure;
  const exposureFactor = Math.pow(2, exposure / 50);
  const adjustedP1 = p1 * exposureFactor;
  const adjustedP99 = p99 * exposureFactor;

  // Set the range against the already exposure-adjusted percentiles. This
  // prevents Density and the range controls from correcting the same shift
  // twice. Only use part of the available tail stretch to preserve headroom.
  const blackPoint = clamp(
    Math.round(adjustedP1 * AUTO_BLACK_POINT_STRENGTH),
    0,
    80,
  );
  const whitePoint = clamp(
    Math.round(255 - (255 - adjustedP99) * AUTO_WHITE_POINT_STRENGTH),
    180,
    255,
  );

  return {
    exposure,
    blackPoint,
    whitePoint,
  };
}

export function analyzeChannelFloors(imageData: ImageData): {
  redFloor: number | null;
  greenFloor: number | null;
  blueFloor: number | null;
} {
  const { data } = imageData;
  const rHist = new Array<number>(256).fill(0);
  const gHist = new Array<number>(256).fill(0);
  const bHist = new Array<number>(256).fill(0);

  for (let i = 0; i < data.length; i += 4) {
    rHist[data[i]] += 1;
    gHist[data[i + 1]] += 1;
    bHist[data[i + 2]] += 1;
  }

  const rFloor = percentile(rHist, FLOOR_PERCENTILE);
  const gFloor = percentile(gHist, FLOOR_PERCENTILE);
  const bFloor = percentile(bHist, FLOOR_PERCENTILE);

  const maxFloor = Math.max(rFloor, gFloor, bFloor);
  const minFloor = Math.min(rFloor, gFloor, bFloor);

  if (maxFloor < FLOOR_THRESHOLD || (maxFloor - minFloor) < FLOOR_SPREAD_THRESHOLD) {
    return { redFloor: null, greenFloor: null, blueFloor: null };
  }

  return {
    redFloor: rFloor > FLOOR_THRESHOLD ? rFloor : null,
    greenFloor: gFloor > FLOOR_THRESHOLD ? gFloor : null,
    blueFloor: bFloor > FLOOR_THRESHOLD ? bFloor : null,
  };
}

export function analyzeMidtoneContrast(histogram: HistogramData): {
  contrast: number | null;
  midtoneBoostPoint: { x: number; y: number } | null;
} {
  const p25 = percentile(histogram.l, 0.25);
  const p75 = percentile(histogram.l, 0.75);
  const p1 = percentile(histogram.l, 0.01);
  const p99 = percentile(histogram.l, 0.99);
  const range = Math.max(1, p99 - p1);
  const iqr = p75 - p25;
  const compression = iqr / range;

  let contrast: number | null = null;
  if (compression < MIDTONE_COMPRESSION_THRESHOLD) {
    const boost = clamp(Math.round((MIDTONE_COMPRESSION_THRESHOLD - compression) * 60), 0, MIDTONE_MAX_BOOST);
    contrast = boost > 0 ? boost : null;
  }

  // Density now handles the global midpoint in the same exponential space as
  // rendering. Adding another RGB-curve lift here would brighten the same
  // midtones twice. Preserve the profile curve and limit this pass to a small
  // contrast correction for compressed histograms.
  return { contrast, midtoneBoostPoint: null };
}

function sampleColorBalance(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxSaturation: number,
): {
  temperature: number;
  tint: number;
  whiteBalanceGains: NonNullable<AutoAnalyzeResult['whiteBalanceGains']>;
  sampleCount: number;
  sampleRatio: number;
} | null {
  const margin = clamp(
    Math.round(Math.min(width, height) * WB_MARGIN_RATIO),
    WB_MARGIN_MIN,
    WB_MARGIN_MAX,
  );
  const left = Math.min(width, margin);
  const top = Math.min(height, margin);
  const right = Math.max(left, width - margin);
  const bottom = Math.max(top, height - margin);

  let poweredR = 0;
  let poweredG = 0;
  let poweredB = 0;
  let sampleCount = 0;

  for (let y = top; y < bottom; y += WB_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += WB_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];

      if (
        r <= WB_CHANNEL_MIN || g <= WB_CHANNEL_MIN || b <= WB_CHANNEL_MIN
        || r >= WB_CHANNEL_MAX || g >= WB_CHANNEL_MAX || b >= WB_CHANNEL_MAX
      ) {
        continue;
      }

      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const saturation = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
      if (saturation > maxSaturation) {
        continue;
      }

      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < WB_LUMA_MIN || luma > WB_LUMA_MAX) {
        continue;
      }

      poweredR += Math.pow(r / 255, WB_MINKOWSKI_POWER);
      poweredG += Math.pow(g / 255, WB_MINKOWSKI_POWER);
      poweredB += Math.pow(b / 255, WB_MINKOWSKI_POWER);
      sampleCount += 1;
    }
  }

  const minimumSamples = Math.max(
    WB_MIN_SAMPLE_COUNT,
    Math.round(((right - left) * (bottom - top) * WB_MIN_SAMPLE_RATIO) / (WB_SAMPLE_STRIDE * WB_SAMPLE_STRIDE)),
  );
  if (sampleCount < minimumSamples) {
    return null;
  }

  // Shades of Gray estimates the illuminant from a per-channel Minkowski
  // norm. L6 is the best-performing simple norm in Finlayson and Trezzi's
  // calibrated evaluation and is less scene-color-biased than an arithmetic
  // mean. Relative saturation filtering keeps strongly colored surfaces out
  // without rejecting a neutral surface merely because it has a color cast.
  const estimateR = Math.pow(poweredR / sampleCount, 1 / WB_MINKOWSKI_POWER) * 255;
  const estimateG = Math.pow(poweredG / sampleCount, 1 / WB_MINKOWSKI_POWER) * 255;
  const estimateB = Math.pow(poweredB / sampleCount, 1 / WB_MINKOWSKI_POWER) * 255;
  const offsets = calculateWhiteBalanceOffsets(estimateR, estimateG, estimateB);
  const whiteBalanceGains = calculateWhiteBalanceGains(estimateR, estimateG, estimateB);
  const sampleCapacity = Math.max(
    1,
    Math.ceil((right - left) / WB_SAMPLE_STRIDE) * Math.ceil((bottom - top) / WB_SAMPLE_STRIDE),
  );

  return {
    ...offsets,
    whiteBalanceGains,
    sampleCount,
    sampleRatio: sampleCount / sampleCapacity,
  };
}

/**
 * Solve DarkSlide's additive white-balance controls for a sampled neutral.
 * Temperature adds to red and subtracts from blue; tint adds to green.
 */
export function calculateWhiteBalanceOffsets(
  red: number,
  green: number,
  blue: number,
): Pick<ConversionSettings, 'temperature' | 'tint'> {
  const redBlueMidpoint = (red + blue) / 2;
  return {
    temperature: clamp(Math.round((blue - red) / 2), -100, 100),
    tint: clamp(Math.round(redBlueMidpoint - green), -100, 100),
  };
}

/**
 * Solve diagonal white-balance gains for a sampled neutral. The geometric
 * mean preserves the sample's overall energy while equalizing its channels.
 */
export function calculateWhiteBalanceGains(
  red: number,
  green: number,
  blue: number,
): NonNullable<AutoAnalyzeResult['whiteBalanceGains']> {
  const safeRed = Math.max(red, 1);
  const safeGreen = Math.max(green, 1);
  const safeBlue = Math.max(blue, 1);
  const target = Math.cbrt(safeRed * safeGreen * safeBlue);
  return {
    red: clamp(target / safeRed, 0.5, 2),
    green: clamp(target / safeGreen, 0.5, 2),
    blue: clamp(target / safeBlue, 0.5, 2),
  };
}

export function applyWhiteBalanceGains(
  baseline: Pick<ConversionSettings, 'redBalance' | 'greenBalance' | 'blueBalance'>,
  gains: AutoAnalyzeResult['whiteBalanceGains'],
): Pick<ConversionSettings, 'redBalance' | 'greenBalance' | 'blueBalance'> {
  return {
    redBalance: clamp(baseline.redBalance * (gains?.red ?? 1), 0.5, 1.5),
    greenBalance: clamp(baseline.greenBalance * (gains?.green ?? 1), 0.5, 1.5),
    blueBalance: clamp(baseline.blueBalance * (gains?.blue ?? 1), 0.5, 1.5),
  };
}

function dampWhiteBalanceGains(
  gains: NonNullable<AutoAnalyzeResult['whiteBalanceGains']>,
  strength: number,
  maximumRatio: number,
): NonNullable<AutoAnalyzeResult['whiteBalanceGains']> {
  const logs = [Math.log(gains.red), Math.log(gains.green), Math.log(gains.blue)];
  const centeredMean = (logs[0] + logs[1] + logs[2]) / 3;
  const centered = logs.map((value) => value - centeredMean);
  const range = Math.max(...centered) - Math.min(...centered);
  const ratioScale = range > 0 ? Math.log(maximumRatio) / range : 1;
  const scale = Math.min(strength, ratioScale);
  return {
    red: Math.exp(centered[0] * scale),
    green: Math.exp(centered[1] * scale),
    blue: Math.exp(centered[2] * scale),
  };
}

export function analyzeColorBalance(
  imageData: ImageData,
  isColorNegative = false,
): Pick<AutoAnalyzeResult, 'temperature' | 'tint' | 'whiteBalanceGains'> {
  const { data, width, height } = imageData;
  if (width <= 0 || height <= 0) {
    return { temperature: null, tint: null, whiteBalanceGains: null };
  }

  const firstPass = sampleColorBalance(data, width, height, WB_MAX_SATURATION);
  const secondPass = firstPass === null && !isColorNegative
    ? sampleColorBalance(data, width, height, WB_MAX_SATURATION_RELAXED)
    : null;

  const result = secondPass ?? firstPass;
  if (!result) {
    return { temperature: null, tint: null, whiteBalanceGains: null };
  }

  // A color negative is not expected to average neutral. Accept small moves
  // directly. Larger moves require broad neutral coverage and are damped so a
  // colored scene cannot replace the stock/profile calibration.
  const gains = Object.values(result.whiteBalanceGains);
  const gainRatio = Math.max(...gains) / Math.max(Math.min(...gains), 0.01);
  if (isColorNegative && gainRatio > NEGATIVE_WB_DIRECT_GAIN_RATIO) {
    if (gainRatio > NEGATIVE_WB_REJECT_GAIN_RATIO || result.sampleRatio < NEGATIVE_WB_MIN_SAMPLE_RATIO) {
      return { temperature: null, tint: null, whiteBalanceGains: null };
    }
    const confidence = clamp(
      (result.sampleRatio - NEGATIVE_WB_MIN_SAMPLE_RATIO)
      / (NEGATIVE_WB_FULL_SAMPLE_RATIO - NEGATIVE_WB_MIN_SAMPLE_RATIO),
      0,
      1,
    );
    return {
      temperature: result.temperature,
      tint: result.tint,
      whiteBalanceGains: dampWhiteBalanceGains(
        result.whiteBalanceGains,
        0.35 + confidence * 0.3,
        NEGATIVE_WB_DAMPED_MAX_GAIN_RATIO,
      ),
    };
  }

  return {
    temperature: result.temperature,
    tint: result.tint,
    whiteBalanceGains: result.whiteBalanceGains,
  };
}

export function analyzeMonochromeSuggestion(imageData: ImageData): MonochromeSuggestionAnalysis {
  const { data, width, height } = imageData;
  if (width <= 0 || height <= 0) {
    return {
      isLikelyMonochrome: false,
      sampleCount: 0,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const margin = clamp(
    Math.round(Math.min(width, height) * MONO_MARGIN_RATIO),
    MONO_MARGIN_MIN,
    MONO_MARGIN_MAX,
  );
  const left = Math.min(width, margin);
  const top = Math.min(height, margin);
  const right = Math.max(left, width - margin);
  const bottom = Math.max(top, height - margin);

  let weightedChroma = 0;
  let weightSum = 0;
  let lowChromaCount = 0;
  let highChromaCount = 0;
  let sampleCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSqR = 0;
  let sumSqG = 0;
  let sumSqB = 0;

  for (let y = top; y < bottom; y += MONO_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += MONO_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma < MONO_LUMA_MIN || luma > MONO_LUMA_MAX) {
        continue;
      }

      sampleCount += 1;
      sumR += r;
      sumG += g;
      sumB += b;
      sumSqR += r * r;
      sumSqG += g * g;
      sumSqB += b * b;
    }
  }

  if (sampleCount < MONO_MIN_SAMPLE_COUNT) {
    return {
      isLikelyMonochrome: false,
      sampleCount,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const meanR = sumR / sampleCount;
  const meanG = sumG / sampleCount;
  const meanB = sumB / sampleCount;
  const neutralMean = (meanR + meanG + meanB) / 3;
  const offsetR = neutralMean - meanR;
  const offsetG = neutralMean - meanG;
  const offsetB = neutralMean - meanB;
  const varianceR = Math.max(sumSqR / sampleCount - meanR * meanR, 1);
  const varianceG = Math.max(sumSqG / sampleCount - meanG * meanG, 1);
  const varianceB = Math.max(sumSqB / sampleCount - meanB * meanB, 1);
  const stdR = Math.sqrt(varianceR);
  const stdG = Math.sqrt(varianceG);
  const stdB = Math.sqrt(varianceB);
  let weightedResidual = 0;
  let lowResidualCount = 0;
  let highResidualCount = 0;

  for (let y = top; y < bottom; y += MONO_SAMPLE_STRIDE) {
    for (let x = left; x < right; x += MONO_SAMPLE_STRIDE) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma < MONO_LUMA_MIN || luma > MONO_LUMA_MAX) {
        continue;
      }

      const castCorrectedR = clamp(r + offsetR, 0, 255);
      const castCorrectedG = clamp(g + offsetG, 0, 255);
      const castCorrectedB = clamp(b + offsetB, 0, 255);
      const castCorrectedMax = Math.max(castCorrectedR, castCorrectedG, castCorrectedB);
      const castCorrectedMin = Math.min(castCorrectedR, castCorrectedG, castCorrectedB);
      const chroma = castCorrectedMax - castCorrectedMin;
      const normalizedR = (r - meanR) / stdR;
      const normalizedG = (g - meanG) / stdG;
      const normalizedB = (b - meanB) / stdB;
      const residual = (
        Math.abs(normalizedR - normalizedG)
        + Math.abs(normalizedG - normalizedB)
        + Math.abs(normalizedR - normalizedB)
      ) / 3;
      const midtoneWeight = 1 - Math.abs(luma - 127.5) / 127.5;
      const weight = Math.max(0.2, midtoneWeight);

      weightedChroma += chroma * weight;
      weightedResidual += residual * weight;
      weightSum += weight;

      if (chroma <= MONO_LOW_CHROMA_MAX) {
        lowChromaCount += 1;
      }
      if (chroma >= MONO_HIGH_CHROMA_MIN) {
        highChromaCount += 1;
      }
      if (residual <= MONO_LOW_RESIDUAL_MAX) {
        lowResidualCount += 1;
      }
      if (residual >= MONO_HIGH_RESIDUAL_MIN) {
        highResidualCount += 1;
      }
    }
  }

  if (weightSum <= 0) {
    return {
      isLikelyMonochrome: false,
      sampleCount,
      meanChroma: 0,
      lowChromaRatio: 0,
      highChromaRatio: 0,
      meanNormalizedResidual: 0,
      lowResidualRatio: 0,
      highResidualRatio: 0,
    };
  }

  const meanChroma = weightedChroma / weightSum;
  const lowChromaRatio = lowChromaCount / sampleCount;
  const highChromaRatio = highChromaCount / sampleCount;
  const meanNormalizedResidual = weightedResidual / weightSum;
  const lowResidualRatio = lowResidualCount / sampleCount;
  const highResidualRatio = highResidualCount / sampleCount;

  return {
    isLikelyMonochrome: (
      meanChroma <= MONO_MEAN_CHROMA_MAX
      && lowChromaRatio >= MONO_LOW_CHROMA_RATIO_MIN
      && highChromaRatio <= MONO_HIGH_CHROMA_RATIO_MAX
    ) || (
      meanNormalizedResidual <= MONO_MEAN_RESIDUAL_MAX
      && lowResidualRatio >= MONO_LOW_RESIDUAL_RATIO_MIN
      && highResidualRatio <= MONO_HIGH_RESIDUAL_RATIO_MAX
      && meanChroma <= 24
      && highChromaRatio <= 0.18
    ),
    sampleCount,
    meanChroma,
    lowChromaRatio,
    highChromaRatio,
    meanNormalizedResidual,
    lowResidualRatio,
    highResidualRatio,
  };
}

export function autoAnalyze(histogram: HistogramData, imageData: ImageData, isColorNegative = false): AutoAnalyzeResult {
  const midtone = analyzeMidtoneContrast(histogram);

  return {
    ...analyzeExposure(histogram, isColorNegative ? 'color-negative' : 'standard'),
    ...analyzeColorBalance(imageData, isColorNegative),
    contrast: midtone.contrast,
    midtoneBoostPoint: midtone.midtoneBoostPoint,
    // Per-channel black-floor curves destroy legitimate colored shadows. Auto
    // owns tonal range, not independent RGB clipping.
    suggestedCurves: null,
  };
}
