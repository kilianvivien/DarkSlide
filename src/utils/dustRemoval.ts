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

/**
 * Compute the mean color of a circular region in the image.
 */
function computePatchMean(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radiusPx: number,
): { r: number; g: number; b: number } | null {
  const r = Math.ceil(radiusPx);
  let totalR = 0, totalG = 0, totalB = 0, count = 0;
  const rSq = radiusPx * radiusPx;

  for (let dy = -r; dy <= r; dy += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      if (dx * dx + dy * dy > rSq) continue;
      const px = Math.round(cx + dx);
      const py = Math.round(cy + dy);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const idx = (py * width + px) * 4;
      totalR += data[idx];
      totalG += data[idx + 1];
      totalB += data[idx + 2];
      count++;
    }
  }

  if (count === 0) return null;
  return { r: totalR / count, g: totalG / count, b: totalB / count };
}

/**
 * Find the best-matching patch offset from the original image.
 * Searches candidate positions around the mark, scores by color similarity to the boundary mean,
 * and returns the (dx, dy) offset to copy pixels from.
 */
function findBestPatch(
  originalData: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radiusPx: number,
  boundaryMean: { r: number; g: number; b: number },
): { dx: number; dy: number } {
  const candidateAngles = 16;
  const searchRadii = [radiusPx * 2.2, radiusPx * 3.0, radiusPx * 4.0];
  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const searchRadius of searchRadii) {
    for (let i = 0; i < candidateAngles; i++) {
      const angle = (i / candidateAngles) * TAU;
      const dx = Math.round(Math.cos(angle) * searchRadius);
      const dy = Math.round(Math.sin(angle) * searchRadius);
      const pcx = cx + dx;
      const pcy = cy + dy;

      // Skip if patch center is outside image
      if (pcx < 0 || pcy < 0 || pcx >= width || pcy >= height) continue;

      const patchMean = computePatchMean(originalData, width, height, pcx, pcy, radiusPx);
      if (!patchMean) continue;

      const score = (
        Math.abs(patchMean.r - boundaryMean.r)
        + Math.abs(patchMean.g - boundaryMean.g)
        + Math.abs(patchMean.b - boundaryMean.b)
      );

      if (score < bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return { dx: bestDx, dy: bestDy };
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

  // Snapshot of original pixels — used for boundary sampling and patch copying.
  // This ensures overlapping marks don't contaminate each other's reference data,
  // and that painting over a repaired area always compounds toward full repair.
  const originalData = new Uint8ClampedArray(data);

  for (const mark of marks) {
    const radiusPx = Math.max(1, mark.radius * diagonal);
    const cx = clamp(mark.cx * width, 0, Math.max(width - 1, 0));
    const cy = clamp(mark.cy * height, 0, Math.max(height - 1, 0));

    // Build boundary from original data so prior repairs don't contaminate the reference.
    const boundarySamples = filterBoundarySamples(
      buildBoundarySamples(originalData, width, height, cx, cy, radiusPx),
    );
    if (boundarySamples.length === 0) {
      continue;
    }
    const boundaryMean = getBoundaryMean(boundarySamples);
    if (!boundaryMean) {
      continue;
    }

    // Find the best nearby patch in original data and compute its mean.
    const patch = findBestPatch(originalData, width, height, cx, cy, radiusPx, boundaryMean);
    const patchMean = computePatchMean(
      originalData, width, height, cx + patch.dx, cy + patch.dy, radiusPx,
    );

    const markFeather = mark.source === 'manual' ? 0.4 : 0.5;
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

        const mask = Math.exp(-(distance * distance) / (2 * sigmaSquared));
        const pixelIndex = (y * width + x) * 4;

        // Low-frequency color target from boundary interpolation.
        const interpolated = interpolateBoundary(boundarySamples, x, y);
        if (!interpolated) {
          continue;
        }

        // Patch-copy synthesis: lift grain from the best nearby patch in the original image,
        // then shift it to match the interpolated local color.
        // reconstructed = interpolated_color + (patch_pixel - patch_mean)
        const srcX = Math.round(x + patch.dx);
        const srcY = Math.round(y + patch.dy);

        let reconstructed: { r: number; g: number; b: number };

        if (srcX >= 0 && srcY >= 0 && srcX < width && srcY < height && patchMean) {
          const srcIdx = (srcY * width + srcX) * 4;
          reconstructed = {
            r: interpolated.r + (originalData[srcIdx]     - patchMean.r),
            g: interpolated.g + (originalData[srcIdx + 1] - patchMean.g),
            b: interpolated.b + (originalData[srcIdx + 2] - patchMean.b),
          };
        } else {
          reconstructed = interpolated;
        }

        // Write to data (not originalData) so successive overlapping marks compound:
        // each pass blends the current (progressively repaired) value further toward reconstructed.
        data[pixelIndex]     = clamp(Math.round(data[pixelIndex]     * (1 - mask) + reconstructed.r * mask), 0, 255);
        data[pixelIndex + 1] = clamp(Math.round(data[pixelIndex + 1] * (1 - mask) + reconstructed.g * mask), 0, 255);
        data[pixelIndex + 2] = clamp(Math.round(data[pixelIndex + 2] * (1 - mask) + reconstructed.b * mask), 0, 255);
      }
    }
  }

  return imageData;
}
