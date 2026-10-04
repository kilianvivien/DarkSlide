// Deterministic stand-in for a third-party negative→positive .cube LUT.
//
// The real-world LUTs DarkSlide was developed against are not redistributable,
// so tests generate an equivalent table instead: a 35-point inverting LUT with
// per-channel tone shaping and a little cross-channel mixing, serialized to
// .cube text so the parser path is still exercised end to end.
import type { CubeLut } from '../../../types';
import { serializeCubeLut } from '../../../utils/cubeLut';

export const SYNTHETIC_NEGATIVE_LUT_TITLE = 'SyntheticNegative';
export const SYNTHETIC_NEGATIVE_LUT_SIZE = 35;

const CHANNEL_GAMMA: [number, number, number] = [0.9, 1.0, 1.15];
const CROSS_MIX = 0.06;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function buildSyntheticNegativeLut(size = SYNTHETIC_NEGATIVE_LUT_SIZE): CubeLut {
  const data = new Float32Array(size ** 3 * 3);
  const last = size - 1;
  let offset = 0;

  // .cube order: red varies fastest, then green, then blue.
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const input = [r / last, g / last, b / last];
        const inverted = input.map((value, channel) => (1 - value) ** CHANNEL_GAMMA[channel]);
        const mean = (inverted[0] + inverted[1] + inverted[2]) / 3;

        for (let channel = 0; channel < 3; channel += 1) {
          // Mixing toward the mean keeps both lattice endpoints exact.
          data[offset] = clamp01(inverted[channel] * (1 - CROSS_MIX) + mean * CROSS_MIX);
          offset += 1;
        }
      }
    }
  }

  return {
    title: SYNTHETIC_NEGATIVE_LUT_TITLE,
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
  };
}

export function buildSyntheticNegativeLutText(size = SYNTHETIC_NEGATIVE_LUT_SIZE) {
  return serializeCubeLut(buildSyntheticNegativeLut(size), 'DarkSlide synthetic test fixture');
}
