import { FilmBaseSample, RollCalibration, RollCalibrationNeutralSample } from '../types';
import { clamp } from './math';

const DENSITY_EPSILON = 1e-6;
const MIN_VARIANCE = 1e-6;

export const MIN_ROLL_CALIBRATION_SAMPLES = 3;
export const IDENTITY_ROLL_CALIBRATION_SLOPES: [number, number, number] = [1, 1, 1];
export const IDENTITY_ROLL_CALIBRATION_OFFSETS: [number, number, number] = [0, 0, 0];

function sampleChannelToDensity(sampleValue: number) {
  return -Math.log10(clamp(sampleValue / 255, DENSITY_EPSILON, 1));
}

function toImageDensity(sample: FilmBaseSample, baseSample: FilmBaseSample | null): [number, number, number] {
  const baseDensity = baseSample
    ? [
      sampleChannelToDensity(baseSample.r),
      sampleChannelToDensity(baseSample.g),
      sampleChannelToDensity(baseSample.b),
    ] as const
    : [0, 0, 0] as const;

  return [
    Math.max(0, sampleChannelToDensity(sample.r) - baseDensity[0]),
    Math.max(0, sampleChannelToDensity(sample.g) - baseDensity[1]),
    Math.max(0, sampleChannelToDensity(sample.b) - baseDensity[2]),
  ];
}

function fitChannelToReference(
  channelSamples: number[],
  referenceSamples: number[],
) {
  if (channelSamples.length === 0 || channelSamples.length !== referenceSamples.length) {
    return { slope: 1, offset: 0 };
  }

  const meanX = channelSamples.reduce((sum, value) => sum + value, 0) / channelSamples.length;
  const meanY = referenceSamples.reduce((sum, value) => sum + value, 0) / referenceSamples.length;
  let variance = 0;
  let covariance = 0;

  for (let index = 0; index < channelSamples.length; index += 1) {
    const dx = channelSamples[index] - meanX;
    variance += dx * dx;
    covariance += dx * (referenceSamples[index] - meanY);
  }

  if (variance < MIN_VARIANCE) {
    const fallbackOffset = referenceSamples.reduce((sum, value, index) => sum + (value - channelSamples[index]), 0) / channelSamples.length;
    return {
      slope: 1,
      offset: clamp(fallbackOffset, -1, 1),
    };
  }

  const slope = clamp(covariance / variance, 0.5, 1.5);
  const offset = clamp(meanY - slope * meanX, -1, 1);
  return { slope, offset };
}

export function createEmptyRollCalibration(baseSample: FilmBaseSample | null = null): RollCalibration {
  return {
    enabled: false,
    baseSample,
    neutralSamples: [],
    slopes: [...IDENTITY_ROLL_CALIBRATION_SLOPES],
    offsets: [...IDENTITY_ROLL_CALIBRATION_OFFSETS],
    updatedAt: Date.now(),
  };
}

export function isRollCalibrationReady(calibration: RollCalibration | null | undefined) {
  return Boolean(calibration?.baseSample && (calibration?.neutralSamples.length ?? 0) >= MIN_ROLL_CALIBRATION_SAMPLES);
}

export function fitRollCalibration(
  neutralSamples: RollCalibrationNeutralSample[],
  baseSample: FilmBaseSample | null,
) {
  const densities = neutralSamples.map((sample) => toImageDensity(sample.sampleRgb, baseSample));
  const referenceSamples = densities.map((sample) => sample[1]);
  const redFit = fitChannelToReference(densities.map((sample) => sample[0]), referenceSamples);
  const blueFit = fitChannelToReference(densities.map((sample) => sample[2]), referenceSamples);

  return {
    enabled: neutralSamples.length >= MIN_ROLL_CALIBRATION_SAMPLES,
    slopes: [redFit.slope, 1, blueFit.slope] as [number, number, number],
    offsets: [redFit.offset, 0, blueFit.offset] as [number, number, number],
    updatedAt: Date.now(),
  };
}
