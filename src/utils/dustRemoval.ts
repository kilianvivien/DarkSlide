import { DEFAULT_DUST_REMOVAL, resolveDustRemovalSettings } from '../constants';
import { DustMark, DustRemovalSettings, PathDustMark, SpotDustMark } from '../types';
import { clamp } from './math';

const TAU = Math.PI * 2;

type BoundarySample = {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  luma: number;
  gradient: number;
  weight: number;
};

type MeanColor = {
  r: number;
  g: number;
  b: number;
};

type PatchStats = MeanColor & {
  gradient: number;
};

function getEffectiveDustRemoval(settings?: DustRemovalSettings | null) {
  return resolveDustRemovalSettings(settings ?? DEFAULT_DUST_REMOVAL);
}

function getMarkRadius(mark: DustMark) {
  return mark.radius;
}

function sortMarksLargestFirst(marks: DustMark[]) {
  return [...marks].sort((left, right) => getMarkRadius(right) - getMarkRadius(left));
}

function computeGradientAt(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const left = clamp(x - 1, 0, width - 1);
  const right = clamp(x + 1, 0, width - 1);
  const top = clamp(y - 1, 0, height - 1);
  const bottom = clamp(y + 1, 0, height - 1);

  const leftIndex = (y * width + left) * 4;
  const rightIndex = (y * width + right) * 4;
  const topIndex = (top * width + x) * 4;
  const bottomIndex = (bottom * width + x) * 4;

  const leftLuma = (
    data[leftIndex] * 0.299
    + data[leftIndex + 1] * 0.587
    + data[leftIndex + 2] * 0.114
  ) / 255;
  const rightLuma = (
    data[rightIndex] * 0.299
    + data[rightIndex + 1] * 0.587
    + data[rightIndex + 2] * 0.114
  ) / 255;
  const topLuma = (
    data[topIndex] * 0.299
    + data[topIndex + 1] * 0.587
    + data[topIndex + 2] * 0.114
  ) / 255;
  const bottomLuma = (
    data[bottomIndex] * 0.299
    + data[bottomIndex + 1] * 0.587
    + data[bottomIndex + 2] * 0.114
  ) / 255;

  return Math.hypot(rightLuma - leftLuma, bottomLuma - topLuma);
}

function buildBoundarySamples(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): BoundarySample[] {
  const samples: BoundarySample[] = [];
  const innerRadius = Math.max(1, radius * 0.82);
  const outerRadius = Math.max(innerRadius + 1, radius * 1.26);
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
        gradient: computeGradientAt(data, width, height, x, y),
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

function getBoundaryStats(samples: BoundarySample[]): PatchStats | null {
  let totalWeight = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let totalGradient = 0;

  for (const sample of samples) {
    totalWeight += sample.weight;
    totalR += sample.r * sample.weight;
    totalG += sample.g * sample.weight;
    totalB += sample.b * sample.weight;
    totalGradient += sample.gradient * sample.weight;
  }

  if (totalWeight <= 0) {
    return null;
  }

  return {
    r: totalR / totalWeight,
    g: totalG / totalWeight,
    b: totalB / totalWeight,
    gradient: totalGradient / totalWeight,
  };
}

function computePatchStats(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radiusPx: number,
): PatchStats | null {
  const radius = Math.ceil(radiusPx);
  const radiusSquared = radiusPx * radiusPx;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let totalGradient = 0;
  let count = 0;

  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      if (dx * dx + dy * dy > radiusSquared) {
        continue;
      }
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) {
        continue;
      }

      const pixelIndex = (y * width + x) * 4;
      totalR += data[pixelIndex];
      totalG += data[pixelIndex + 1];
      totalB += data[pixelIndex + 2];
      totalGradient += computeGradientAt(data, width, height, x, y);
      count += 1;
    }
  }

  if (count === 0) {
    return null;
  }

  return {
    r: totalR / count,
    g: totalG / count,
    b: totalB / count,
    gradient: totalGradient / count,
  };
}

function findBestPatch(
  originalData: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radiusPx: number,
  boundaryStats: PatchStats,
) {
  const candidateAngles = 16;
  const searchRadii = [radiusPx * 2.1, radiusPx * 2.9, radiusPx * 3.9];
  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const searchRadius of searchRadii) {
    for (let index = 0; index < candidateAngles; index += 1) {
      const angle = (index / candidateAngles) * TAU;
      const dx = Math.round(Math.cos(angle) * searchRadius);
      const dy = Math.round(Math.sin(angle) * searchRadius);
      const patchCenterX = cx + dx;
      const patchCenterY = cy + dy;
      if (patchCenterX < 0 || patchCenterY < 0 || patchCenterX >= width || patchCenterY >= height) {
        continue;
      }

      const patchStats = computePatchStats(originalData, width, height, patchCenterX, patchCenterY, radiusPx);
      if (!patchStats) {
        continue;
      }

      const score = (
        Math.abs(patchStats.r - boundaryStats.r)
        + Math.abs(patchStats.g - boundaryStats.g)
        + Math.abs(patchStats.b - boundaryStats.b)
        + Math.abs(patchStats.gradient - boundaryStats.gradient) * 120
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

function repairSpotMark(
  data: Uint8ClampedArray,
  originalData: Uint8ClampedArray,
  width: number,
  height: number,
  mark: SpotDustMark,
  diagonal: number,
) {
  const radiusPx = Math.max(1, mark.radius * diagonal);
  const cx = clamp(mark.cx * width, 0, Math.max(width - 1, 0));
  const cy = clamp(mark.cy * height, 0, Math.max(height - 1, 0));

  const boundarySamples = filterBoundarySamples(buildBoundarySamples(originalData, width, height, cx, cy, radiusPx));
  if (boundarySamples.length === 0) {
    return;
  }
  const boundaryStats = getBoundaryStats(boundarySamples);
  if (!boundaryStats) {
    return;
  }

  const patch = findBestPatch(originalData, width, height, cx, cy, radiusPx, boundaryStats);
  const patchStats = computePatchStats(
    originalData,
    width,
    height,
    cx + patch.dx,
    cy + patch.dy,
    radiusPx,
  );

  const markFeather = mark.source === 'manual' ? 0.4 : 0.48;
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
      const interpolated = interpolateBoundary(boundarySamples, x, y);
      if (!interpolated) {
        continue;
      }

      const srcX = Math.round(x + patch.dx);
      const srcY = Math.round(y + patch.dy);
      let reconstructed: MeanColor = interpolated;

      if (srcX >= 0 && srcY >= 0 && srcX < width && srcY < height && patchStats) {
        const srcIndex = (srcY * width + srcX) * 4;
        reconstructed = {
          r: interpolated.r + (originalData[srcIndex] - patchStats.r),
          g: interpolated.g + (originalData[srcIndex + 1] - patchStats.g),
          b: interpolated.b + (originalData[srcIndex + 2] - patchStats.b),
        };
      }

      data[pixelIndex] = clamp(Math.round(data[pixelIndex] * (1 - mask) + reconstructed.r * mask), 0, 255);
      data[pixelIndex + 1] = clamp(Math.round(data[pixelIndex + 1] * (1 - mask) + reconstructed.g * mask), 0, 255);
      data[pixelIndex + 2] = clamp(Math.round(data[pixelIndex + 2] * (1 - mask) + reconstructed.b * mask), 0, 255);
    }
  }
}

function sampleColor(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): MeanColor | null {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return null;
  }

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const index00 = (y0 * width + x0) * 4;
  const index10 = (y0 * width + x1) * 4;
  const index01 = (y1 * width + x0) * 4;
  const index11 = (y1 * width + x1) * 4;

  const sampleChannel = (channelOffset: number) => {
    const top = data[index00 + channelOffset] * (1 - tx) + data[index10 + channelOffset] * tx;
    const bottom = data[index01 + channelOffset] * (1 - tx) + data[index11 + channelOffset] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  return {
    r: sampleChannel(0),
    g: sampleChannel(1),
    b: sampleChannel(2),
  };
}

function averageColors(colors: MeanColor[]) {
  if (colors.length === 0) {
    return null;
  }

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (const color of colors) {
    totalR += color.r;
    totalG += color.g;
    totalB += color.b;
  }

  return {
    r: totalR / colors.length,
    g: totalG / colors.length,
    b: totalB / colors.length,
  };
}

function getNearestSegmentInfo(path: Array<{ x: number; y: number }>, x: number, y: number) {
  let bestDistance = Infinity;
  let best:
    | {
      distance: number;
      projX: number;
      projY: number;
      tangentX: number;
      tangentY: number;
    }
    | null = null;

  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const lengthSquared = segmentX * segmentX + segmentY * segmentY;
    if (lengthSquared <= 0) {
      continue;
    }

    const t = clamp(
      ((x - start.x) * segmentX + (y - start.y) * segmentY) / lengthSquared,
      0,
      1,
    );
    const projX = start.x + segmentX * t;
    const projY = start.y + segmentY * t;
    const distance = Math.hypot(x - projX, y - projY);
    if (distance >= bestDistance) {
      continue;
    }

    const length = Math.sqrt(lengthSquared);
    bestDistance = distance;
    best = {
      distance,
      projX,
      projY,
      tangentX: segmentX / length,
      tangentY: segmentY / length,
    };
  }

  return best;
}

function repairPathMark(
  data: Uint8ClampedArray,
  originalData: Uint8ClampedArray,
  width: number,
  height: number,
  mark: PathDustMark,
  diagonal: number,
) {
  const radiusPx = Math.max(1, mark.radius * diagonal);
  const pixelPath = mark.points.map((point) => ({
    x: clamp(point.x * width, 0, Math.max(width - 1, 0)),
    y: clamp(point.y * height, 0, Math.max(height - 1, 0)),
  }));
  if (pixelPath.length < 2) {
    return;
  }

  const xs = pixelPath.map((point) => point.x);
  const ys = pixelPath.map((point) => point.y);
  const padding = Math.ceil(radiusPx * 3);
  const left = clamp(Math.floor(Math.min(...xs) - padding), 0, Math.max(width - 1, 0));
  const top = clamp(Math.floor(Math.min(...ys) - padding), 0, Math.max(height - 1, 0));
  const right = clamp(Math.ceil(Math.max(...xs) + padding), left, Math.max(width - 1, 0));
  const bottom = clamp(Math.ceil(Math.max(...ys) + padding), top, Math.max(height - 1, 0));
  const sigma = Math.max(radiusPx * 0.7, 0.75);
  const sigmaSquared = sigma * sigma;
  const sideOffsets = [radiusPx * 1.4, radiusPx * 1.9, radiusPx * 2.35];

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const segment = getNearestSegmentInfo(pixelPath, x, y);
      if (!segment || segment.distance > radiusPx * 1.25) {
        continue;
      }

      const normalX = -segment.tangentY;
      const normalY = segment.tangentX;
      const leftSamples: MeanColor[] = [];
      const rightSamples: MeanColor[] = [];

      for (const offset of sideOffsets) {
        const sampleLeft = sampleColor(
          originalData,
          width,
          height,
          segment.projX - normalX * offset,
          segment.projY - normalY * offset,
        );
        const sampleRight = sampleColor(
          originalData,
          width,
          height,
          segment.projX + normalX * offset,
          segment.projY + normalY * offset,
        );
        if (sampleLeft) {
          leftSamples.push(sampleLeft);
        }
        if (sampleRight) {
          rightSamples.push(sampleRight);
        }
      }

      const leftMean = averageColors(leftSamples);
      const rightMean = averageColors(rightSamples);
      const reconstructed = averageColors(
        [leftMean, rightMean].filter((color): color is MeanColor => color !== null),
      );
      if (!reconstructed) {
        continue;
      }

      const mask = Math.exp(-(segment.distance * segment.distance) / (2 * sigmaSquared));
      const pixelIndex = (y * width + x) * 4;
      data[pixelIndex] = clamp(Math.round(data[pixelIndex] * (1 - mask) + reconstructed.r * mask), 0, 255);
      data[pixelIndex + 1] = clamp(Math.round(data[pixelIndex + 1] * (1 - mask) + reconstructed.g * mask), 0, 255);
      data[pixelIndex + 2] = clamp(Math.round(data[pixelIndex + 2] * (1 - mask) + reconstructed.b * mask), 0, 255);
    }
  }
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
  const originalData = new Uint8ClampedArray(data);

  for (const mark of marks) {
    if (mark.kind === 'path') {
      repairPathMark(data, originalData, width, height, mark, diagonal);
      continue;
    }

    repairSpotMark(data, originalData, width, height, mark, diagonal);
  }

  return imageData;
}
