import type { ColorProfileId, InputProfileSpec } from '../types';
import { getExtendedTransferFunctions } from './colorProfiles';
import { clamp } from './math';

// Temperature, tint and exposure act as multiplicative gains on linear light,
// the way a change of illuminant or exposure time does. Gains keep black at
// black (an additive offset tints the shadows) and stay proportional across
// the tonal range instead of being strongest in the shadows.

// Slider units per stop. Temperature/tint at 40 units/stop keeps the midtone
// strength of the previous additive model, so preset values keep their look.
export const WHITE_BALANCE_UNITS_PER_STOP = 40;
// Exposure at 25 units/stop: ±100 spans ±4 stops, and small preset values land
// close to their previous gamma-space strength.
export const EXPOSURE_UNITS_PER_STOP = 25;

const SLIDER_LIMIT = 100;
// Linear-light luminance weights; WB gains are normalized so a neutral keeps
// its brightness while the cast changes.
const LINEAR_LUMA_R = 0.2126;
const LINEAR_LUMA_G = 0.7152;
const LINEAR_LUMA_B = 0.0722;
const LOG_FLOOR = 1e-6;

export type RgbGains = [number, number, number];

export function resolveExposureGain(exposure: number) {
  return 2 ** (exposure / EXPOSURE_UNITS_PER_STOP);
}

// temperature includes any lab-style bias. Positive warms (red up, blue down),
// positive tint adds green.
export function resolveWhiteBalanceGains(temperature: number, tint: number): RgbGains {
  const temperatureStops = clamp(temperature, -2 * SLIDER_LIMIT, 2 * SLIDER_LIMIT) / WHITE_BALANCE_UNITS_PER_STOP;
  const tintStops = clamp(tint, -SLIDER_LIMIT, SLIDER_LIMIT) / WHITE_BALANCE_UNITS_PER_STOP;
  const red = 2 ** temperatureStops;
  const green = 2 ** tintStops;
  const blue = 2 ** -temperatureStops;
  const luminance = LINEAR_LUMA_R * red + LINEAR_LUMA_G * green + LINEAR_LUMA_B * blue;
  return [red / luminance, green / luminance, blue / luminance];
}

export function isIdentityGains(gains: RgbGains) {
  return gains[0] === 1 && gains[1] === 1 && gains[2] === 1;
}

// Applies per-channel linear-light gains to encoded values in place, keeping
// over-white and negative values intact for the later tone stages.
export function createLinearGainApplier(profile: InputProfileSpec) {
  const { decode, encode } = getExtendedTransferFunctions(profile);
  return (r: number, g: number, b: number, gains: RgbGains): [number, number, number] => [
    gains[0] === 1 ? r : encode(decode(r) * gains[0]),
    gains[1] === 1 ? g : encode(decode(g) * gains[1]),
    gains[2] === 1 ? b : encode(decode(b) * gains[2]),
  ];
}

// Solves the temperature/tint that makes an encoded sample (0-255 units of the
// output profile, measured before white balance) neutral under the gains above.
export function neutralWhiteBalance(
  sample: { r: number; g: number; b: number },
  labTemperatureBias = 0,
  profile: ColorProfileId = 'srgb',
) {
  const { decode } = getExtendedTransferFunctions(profile);
  const logLinear = (value: number) => Math.log2(Math.max(decode(value / 255), LOG_FLOOR));
  const red = logLinear(sample.r);
  const green = logLinear(sample.g);
  const blue = logLinear(sample.b);
  // Weighted sums can put an exact half-step infinitesimally below its value.
  // Keep rounding deterministic between a uniform frame and a picked patch.
  const rounded = (value: number) => clamp(Math.round(value + 1e-9), -SLIDER_LIMIT, SLIDER_LIMIT) || 0;
  return {
    temperature: rounded(((blue - red) / 2) * WHITE_BALANCE_UNITS_PER_STOP - labTemperatureBias),
    tint: rounded(((red + blue) / 2 - green) * WHITE_BALANCE_UNITS_PER_STOP),
  };
}
