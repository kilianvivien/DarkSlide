import { DEFAULT_DUST_REMOVAL, resolveDustRemovalSettings } from '../constants';
import { DustMark, DustRemovalSettings } from '../types';
import { clamp } from './math';

const TAU = Math.PI * 2;

function getEffectiveDustRemoval(settings?: DustRemovalSettings | null) {
  return resolveDustRemovalSettings(settings ?? DEFAULT_DUST_REMOVAL);
}

function sortMarksLargestFirst(marks: DustMark[]) {
  return [...marks].sort((left, right) => right.radius - left.radius);
}

type BoundarySample = {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  luma: number;
  weight: number;
};

function buildBoundarySamples(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): BoundarySample[] {
  const samples: BoundarySample[] = [];
  const innerRadius = Math.max(1, radius * 0.8);
  const outerRadius = Math.max(innerRadius + 1, radius * 1.2);
  const perimeterEstimate = Math.max(16, Math.round(TAU * outerRadius));

  for (let index = 0; index < perimeterEstimate; index += 1) {
    const angle = (index / perimeterEstimate) * TAU;
    for (const sampleRadius of [innerRadius, (innerRadius + outerRadius) * 0.5, outerRadius]) {
      const x = Math.round(cx + Math.cos(angle) * sampleRadius);
      const y = Math.round(cy + Math.sin(angle) * sampleRadius);
      if (x < 0 || y < 0 || x >= width || y >= height) {
        continue;
      }

      const pixelIndex = (y * width + x) * 4;
      const normalizedDistance = (sampleRadius - innerRadius) / Math.max(outerRadius - innerRadius, 1);
      samples.push({
        x,
        y,
        r: data[pixelIndex],
        g: data[pixelIndex + 1],
        b: data[pixelIndex + 2],
        luma: (
          data[pixelIndex] * 0.299
          + data[pixelIndex + 1] * 0.587
          + data[pixelIndex + 2] * 0.114
        ) / 255,
        weight: 1 - Math.abs(normalizedDistance - 0.5),
      });
    }
  }

  return samples;
}

function filterBoundarySamples(samples: BoundarySample[]) {
  if (samples.length < 8) {
    return samples;
  }

  const luminanceValues = samples
    .map((sample) => sample.luma)
    .sort((left, right) => left - right);
  const lowIndex = Math.floor((luminanceValues.length - 1) * 0.15);
  const highIndex = Math.ceil((luminanceValues.length - 1) * 0.85);
  const low = luminanceValues[lowIndex];
  const high = luminanceValues[highIndex];
  const filtered = samples.filter((sample) => sample.luma >= low && sample.luma <= high);
  return filtered.length >= Math.max(6, Math.floor(samples.length * 0.4))
    ? filtered
    : samples;
}

function interpolateBoundary(samples: BoundarySample[], x: number, y: number) {
  let totalWeight = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (const sample of samples) {
    const dx = sample.x - x;
    const dy = sample.y - y;
    const distanceSquared = Math.max(dx * dx + dy * dy, 1);
    const weight = sample.weight / distanceSquared;
    totalWeight += weight;
    totalR += sample.r * weight;
    totalG += sample.g * weight;
    totalB += sample.b * weight;
  }

  if (totalWeight <= 0) {
    return null;
  }

  return {
    r: totalR / totalWeight,
    g: totalG / totalWeight,
    b: totalB / totalWeight,
  };
}

function getBoundaryMean(samples: BoundarySample[]) {
  let totalWeight = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (const sample of samples) {
    totalWeight += sample.weight;
    totalR += sample.r * sample.weight;
    totalG += sample.g * sample.weight;
    totalB += sample.b * sample.weight;
  }

  if (totalWeight <= 0) {
    return null;
  }

  return {
    r: totalR / totalWeight,
    g: totalG / totalWeight,
    b: totalB / totalWeight,
  };
}

function getNearestBoundarySample(
  samples: BoundarySample[],
  x: number,
  y: number,
) {
  let closestSample: BoundarySample | null = null;
  let closestDistanceSquared = Number.POSITIVE_INFINITY;

  for (const sample of samples) {
    const dx = sample.x - x;
    const dy = sample.y - y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < closestDistanceSquared) {
      closestDistanceSquared = distanceSquared;
      closestSample = sample;
    }
  }

  if (!closestSample) {
    return null;
  }

  return closestSample;
}

function selectTextureSample(
  samples: BoundarySample[],
  cx: number,
  cy: number,
  x: number,
  y: number,
  salt: number,
) {
  if (samples.length === 0) {
    return null;
  }

  const baseAngle = Math.atan2(y - cy, x - cx);
  const jitter = Math.sin((x * 12.9898 + y * 78.233 + salt * 37.719) * 0.0174533) * 0.45;
  const targetAngle = baseAngle + jitter;
  let bestSample: BoundarySample | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const sample of samples) {
    const sampleAngle = Math.atan2(sample.y - cy, sample.x - cx);
    const angleDelta = Math.atan2(Math.sin(sampleAngle - targetAngle), Math.cos(sampleAngle - targetAngle));
    const score = Math.abs(angleDelta) + (1 - sample.weight) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      bestSample = sample;
    }
  }

  return bestSample;
}

function blendTextureSamples(samples: Array<BoundarySample | null>) {
  const valid = samples.filter((sample): sample is BoundarySample => sample !== null);
  if (valid.length === 0) {
    return null;
  }

  const totals = valid.reduce((accumulator, sample) => ({
    r: accumulator.r + sample.r,
    g: accumulator.g + sample.g,
    b: accumulator.b + sample.b,
  }), { r: 0, g: 0, b: 0 });

  return {
    r: totals.r / valid.length,
    g: totals.g / valid.length,
    b: totals.b / valid.length,
  };
}

export function applyDustRemoval(
  imageData: ImageData,
  dustRemoval?: DustRemovalSettings | null,
) {
  const resolved = getEffectiveDustRemoval(dustRemoval);
  if (resolved.marks.length === 0) {
    return imageData;
  }

  const { data, width, height } = imageData;
  const diagonal = Math.hypot(width, height);
  const marks = sortMarksLargestFirst(resolved.marks);

  for (const mark of marks) {
    const markSource = new Uint8ClampedArray(data);
    const radiusPx = Math.max(1, mark.radius * diagonal);
    const cx = clamp(mark.cx * width, 0, Math.max(width - 1, 0));
    const cy = clamp(mark.cy * height, 0, Math.max(height - 1, 0));
    const boundarySamples = filterBoundarySamples(
      buildBoundarySamples(data, width, height, cx, cy, radiusPx),
    );
    if (boundarySamples.length === 0) {
      continue;
    }
    const boundaryMean = getBoundaryMean(boundarySamples);
    if (!boundaryMean) {
      continue;
    }
    const markFeather = mark.source === 'manual' ? 0.42 : 0.5;
    const markReach = mark.source === 'manual' ? 1.02 : 1.12;
    const padding = Math.ceil(radiusPx * (mark.source === 'manual' ? 1.12 : 1.35));
    const left = clamp(Math.floor(cx - padding), 0, Math.max(width - 1, 0));
    const top = clamp(Math.floor(cy - padding), 0, Math.max(height - 1, 0));
    const right = clamp(Math.ceil(cx + padding), left, Math.max(width - 1, 0));
    const bottom = clamp(Math.ceil(cy + padding), top, Math.max(height - 1, 0));
    const sigma = Math.max(radiusPx * markFeather, 0.5);
    const sigmaSquared = sigma * sigma;

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const distance = Math.hypot(dx, dy);
        if (distance > radiusPx * markReach) {
          continue;
        }

        const interpolated = interpolateBoundary(boundarySamples, x, y);
        if (!interpolated) {
          continue;
        }

        const mask = Math.exp(-(distance * distance) / (2 * sigmaSquared));
        const pixelIndex = (y * width + x) * 4;
        const nearestSample = getNearestBoundarySample(boundarySamples, x, y);
        const textureSampleA = selectTextureSample(boundarySamples, cx, cy, x, y, 1);
        const textureSampleB = selectTextureSample(boundarySamples, cx, cy, x, y, 2);
        const textureSampleC = selectTextureSample(boundarySamples, cx, cy, x, y, 3);
        const textureSample = blendTextureSamples([nearestSample, textureSampleA, textureSampleB, textureSampleC]);
        const textureResidual = textureSample && boundaryMean
          ? {
            r: textureSample.r - boundaryMean.r,
            g: textureSample.g - boundaryMean.g,
            b: textureSample.b - boundaryMean.b,
          }
          : { r: 0, g: 0, b: 0 };
        const nearestResidual = nearestSample && boundaryMean
          ? {
            r: nearestSample.r - boundaryMean.r,
            g: nearestSample.g - boundaryMean.g,
            b: nearestSample.b - boundaryMean.b,
          }
          : { r: 0, g: 0, b: 0 };
        const centerWeight = Math.max(0, 1 - distance / Math.max(radiusPx, 1));
        const grainWeight = (mark.source === 'manual' ? 1.55 : 0.95) * mask * (0.65 + centerWeight * 0.7);
        const localWeight = (mark.source === 'manual' ? 0.65 : 0.35) * mask;
        const textureBias = textureSample
          ? {
            r: boundaryMean.r + textureResidual.r * grainWeight + nearestResidual.r * localWeight,
            g: boundaryMean.g + textureResidual.g * grainWeight + nearestResidual.g * localWeight,
            b: boundaryMean.b + textureResidual.b * grainWeight + nearestResidual.b * localWeight,
          }
          : interpolated;
        const lowFrequencyMix = mark.source === 'manual' ? 0.35 : 0.7;
        const reconstructed = {
          r: interpolated.r * lowFrequencyMix + textureBias.r * (1 - lowFrequencyMix),
          g: interpolated.g * lowFrequencyMix + textureBias.g * (1 - lowFrequencyMix),
          b: interpolated.b * lowFrequencyMix + textureBias.b * (1 - lowFrequencyMix),
        };
        data[pixelIndex] = clamp(Math.round(
          markSource[pixelIndex] * (1 - mask)
          + reconstructed.r * mask,
        ), 0, 255);
        data[pixelIndex + 1] = clamp(Math.round(
          markSource[pixelIndex + 1] * (1 - mask)
          + reconstructed.g * mask,
        ), 0, 255);
        data[pixelIndex + 2] = clamp(Math.round(
          markSource[pixelIndex + 2] * (1 - mask)
          + reconstructed.b * mask,
        ), 0, 255);
      }
    }
  }

  return imageData;
}
