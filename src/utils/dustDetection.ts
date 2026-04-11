import { DustAutoDetectMode, DustMark } from '../types';
import { clamp } from './math';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const MAX_AUTO_MARKS = 64;
const MAX_MARKS_PER_COMPONENT = 24;

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function evenlySubsample<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) {
    return items;
  }
  const step = (items.length - 1) / (maxCount - 1);
  const result: T[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    result.push(items[Math.round(index * step)]);
  }
  return result;
}

function computeLuminance(data: Uint8ClampedArray, width: number, height: number) {
  const luminance = new Float32Array(width * height);
  for (let index = 0, pixelIndex = 0; index < luminance.length; index += 1, pixelIndex += 4) {
    luminance[index] = (
      data[pixelIndex] * LUMA_R
      + data[pixelIndex + 1] * LUMA_G
      + data[pixelIndex + 2] * LUMA_B
    ) / 255;
  }
  return luminance;
}

function boxBlurHorizontal(source: Float32Array, width: number, height: number, radius: number) {
  const result = new Float32Array(source.length);
  const windowSize = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let running = 0;

    for (let x = -radius; x <= radius; x += 1) {
      const sampleX = clamp(x, 0, width - 1);
      running += source[rowOffset + sampleX];
    }

    for (let x = 0; x < width; x += 1) {
      result[rowOffset + x] = running / windowSize;
      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      running += source[rowOffset + addX] - source[rowOffset + removeX];
    }
  }

  return result;
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number) {
  if (radius <= 0) {
    return new Float32Array(source);
  }

  const horizontal = boxBlurHorizontal(source, width, height, radius);
  const result = new Float32Array(source.length);
  const windowSize = radius * 2 + 1;

  for (let x = 0; x < width; x += 1) {
    let running = 0;
    for (let y = -radius; y <= radius; y += 1) {
      const sampleY = clamp(y, 0, height - 1);
      running += horizontal[sampleY * width + x];
    }

    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = running / windowSize;
      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      running += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }

  return result;
}

function downsampleImageData(imageData: ImageData) {
  const width = Math.max(1, Math.floor(imageData.width / 2));
  const height = Math.max(1, Math.floor(imageData.height / 2));
  const result = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const samples = [0, 0, 0, 0];
      let count = 0;

      for (let offsetY = 0; offsetY < 2; offsetY += 1) {
        for (let offsetX = 0; offsetX < 2; offsetX += 1) {
          const sourceX = Math.min(imageData.width - 1, x * 2 + offsetX);
          const sourceY = Math.min(imageData.height - 1, y * 2 + offsetY);
          const sourceIndex = (sourceY * imageData.width + sourceX) * 4;
          samples[0] += imageData.data[sourceIndex];
          samples[1] += imageData.data[sourceIndex + 1];
          samples[2] += imageData.data[sourceIndex + 2];
          samples[3] += imageData.data[sourceIndex + 3];
          count += 1;
        }
      }

      const targetIndex = (y * width + x) * 4;
      result[targetIndex] = Math.round(samples[0] / count);
      result[targetIndex + 1] = Math.round(samples[1] / count);
      result[targetIndex + 2] = Math.round(samples[2] / count);
      result[targetIndex + 3] = Math.round(samples[3] / count);
    }
  }

  return new ImageData(result, width, height);
}

type ComponentStats = {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  totalX: number;
  totalY: number;
  totalDeviation: number;
  maxDeviation: number;
  boundaryEdges: number;
  touchesBorder: boolean;
  points: Array<{ x: number; y: number }>;
};

function createComponentStats(width: number, height: number): ComponentStats {
  return {
    area: 0,
    minX: width,
    maxX: 0,
    minY: height,
    maxY: 0,
    totalX: 0,
    totalY: 0,
    totalDeviation: 0,
    maxDeviation: 0,
    boundaryEdges: 0,
    touchesBorder: false,
    points: [],
  };
}

function dedupeMarks(marks: Array<DustMark & { score: number }>, diagonal: number) {
  const deduped: Array<DustMark & { score: number }> = [];
  const minDistance = Math.max(1.5 / Math.max(diagonal, 1), 0.0015);

  for (const mark of marks.sort((left, right) => right.score - left.score)) {
    const isDuplicate = deduped.some((existing) => (
      Math.hypot(existing.cx - mark.cx, existing.cy - mark.cy) < Math.max(minDistance, Math.min(existing.radius, mark.radius) * 0.65)
    ));
    if (!isDuplicate) {
      deduped.push(mark);
    }
    if (deduped.length >= MAX_AUTO_MARKS) {
      break;
    }
  }

  return deduped.map((mark) => ({
    id: mark.id,
    cx: mark.cx,
    cy: mark.cy,
    radius: mark.radius,
    source: mark.source,
  }));
}

/**
 * Orders component points by walking a nearest-neighbor chain from one extremity.
 * This follows curved shapes naturally, unlike axis-aligned sorting.
 */
function orderPointsAlongCurve(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length <= 2) {
    return points;
  }

  // Start from the point with the smallest coordinate sum (one extremity)
  let startIndex = 0;
  let minSum = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const sum = points[index].x + points[index].y;
    if (sum < minSum) {
      minSum = sum;
      startIndex = index;
    }
  }

  const ordered: Array<{ x: number; y: number }> = [];
  const used = new Uint8Array(points.length);
  let current = startIndex;

  for (let step = 0; step < points.length; step += 1) {
    ordered.push(points[current]);
    used[current] = 1;

    let bestDistance = Infinity;
    let bestIndex = -1;
    for (let index = 0; index < points.length; index += 1) {
      if (used[index]) {
        continue;
      }
      const dx = points[index].x - points[current].x;
      const dy = points[index].y - points[current].y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      break;
    }
    current = bestIndex;
  }

  return ordered;
}

function classifyAndBuildMarks(
  stats: ComponentStats,
  width: number,
  height: number,
  maxRadius: number,
  scale: number,
  normalizedSensitivity: number,
  adaptiveThreshold: number,
  mode: DustAutoDetectMode,
) {
  const blobWidth = stats.maxX - stats.minX + 1;
  const blobHeight = stats.maxY - stats.minY + 1;
  const aspectRatio = Math.max(blobWidth, blobHeight) / Math.max(1, Math.min(blobWidth, blobHeight));
  const meanDeviation = stats.totalDeviation / Math.max(stats.area, 1);
  const fillRatio = stats.area / Math.max(blobWidth * blobHeight, 1);
  const circularity = (4 * Math.PI * stats.area) / Math.max(stats.boundaryEdges * stats.boundaryEdges, 1);
  const diagonal = Math.hypot(width * scale, height * scale);
  const marks: Array<DustMark & { score: number }> = [];

  const canEmitSpots = mode === 'spots' || mode === 'both';
  const canEmitScratches = mode === 'scratches' || mode === 'both';

  const spotMinArea = Math.round(lerp(8, 2, normalizedSensitivity));
  const spotMeanMultiplier = lerp(2.5, 1.2, normalizedSensitivity);
  const spotMaxMultiplier = lerp(3.0, 1.4, normalizedSensitivity);
  const isSpotCandidate = (
    stats.area >= spotMinArea
    && stats.area <= Math.PI * maxRadius * maxRadius
    && aspectRatio <= 2.8
    && fillRatio >= 0.22
    && circularity >= 0.05
    && meanDeviation > adaptiveThreshold * spotMeanMultiplier
    && stats.maxDeviation > adaptiveThreshold * spotMaxMultiplier
  );

  if (canEmitSpots && isSpotCandidate) {
    const cx = (stats.totalX / stats.area + 0.5) * scale;
    const cy = (stats.totalY / stats.area + 0.5) * scale;
    const radiusPx = Math.max(blobWidth, blobHeight) * scale * 0.6;
    marks.push({
      id: `dust-auto-${crypto.randomUUID()}`,
      cx: clamp(cx / (width * scale), 0, 1),
      cy: clamp(cy / (height * scale), 0, 1),
      radius: clamp(radiusPx / diagonal, 0, 1),
      source: 'auto',
      score: meanDeviation * stats.area,
    });
  }

  const longSide = Math.max(blobWidth, blobHeight);
  const shortSide = Math.min(blobWidth, blobHeight);

  // Reject components running entirely within a narrow margin of a single image
  // border — these are scanner edge artifacts, not real defects.
  const borderMargin = Math.max(maxRadius * 2, 6);
  const hugsBorder = (
    stats.maxX < borderMargin
    || stats.minX >= width - borderMargin
    || stats.maxY < borderMargin
    || stats.minY >= height - borderMargin
  );

  const linearMeanMultiplier = lerp(1.4, 0.6, normalizedSensitivity);
  const linearMaxMultiplier = lerp(1.8, 0.85, normalizedSensitivity);
  const isScratchCandidate = (
    canEmitScratches
    && !stats.touchesBorder
    && !hugsBorder
    && stats.area >= Math.max(4, Math.round(maxRadius))
    && aspectRatio >= 2
    && longSide >= Math.max(8, Math.round(maxRadius * 1.4))
    && shortSide <= Math.max(maxRadius * 1.2, 10)
    && fillRatio >= 0.04
    && fillRatio <= 0.55
    && meanDeviation > adaptiveThreshold * linearMeanMultiplier
    && stats.maxDeviation > adaptiveThreshold * linearMaxMultiplier
  );

  // Hair/fiber candidate: thin curving structures whose bounding box is too square
  // for scratch classification. Detected by low average width (area / longest side).
  // Hairs may touch image edges, but border-hugging artifacts are rejected above.
  const averageWidth = stats.area / Math.max(longSide, 1);
  const isHairCandidate = (
    canEmitScratches
    && !isSpotCandidate
    && !hugsBorder
    && stats.area >= Math.max(6, Math.round(maxRadius * 1.5))
    && averageWidth <= Math.max(maxRadius * 0.8, 4)
    && longSide >= Math.max(12, Math.round(maxRadius * 2))
    && meanDeviation > adaptiveThreshold * linearMeanMultiplier
    && stats.maxDeviation > adaptiveThreshold * linearMaxMultiplier
  );

  if (!isScratchCandidate && !isHairCandidate) {
    return marks;
  }

  if (isScratchCandidate) {
    // Straight scratch: bucket along dominant axis
    const horizontal = blobWidth >= blobHeight;
    const sortedPoints = [...stats.points].sort((left, right) => (
      horizontal ? left.x - right.x : left.y - right.y
    ));
    const sampleStep = Math.max(2, Math.round(Math.max(shortSide, maxRadius * 0.6)));
    let bucketAnchor = horizontal ? sortedPoints[0]?.x ?? 0 : sortedPoints[0]?.y ?? 0;
    let bucket: Array<{ x: number; y: number }> = [];
    const bucketCenters: Array<{ x: number; y: number }> = [];

    const flushBucket = () => {
      if (bucket.length === 0) {
        return;
      }
      const total = bucket.reduce((accumulator, point) => ({
        x: accumulator.x + point.x,
        y: accumulator.y + point.y,
      }), { x: 0, y: 0 });
      bucketCenters.push({
        x: total.x / bucket.length,
        y: total.y / bucket.length,
      });
      bucket = [];
    };

    for (const point of sortedPoints) {
      const axisValue = horizontal ? point.x : point.y;
      if (axisValue - bucketAnchor > sampleStep) {
        flushBucket();
        bucketAnchor = axisValue;
      }
      bucket.push(point);
    }
    flushBucket();

    const scratchRadiusPx = clamp(Math.max(shortSide * 0.95, maxRadius * 0.55), 1.5, maxRadius * 1.15) * scale;
    const score = meanDeviation * stats.area * 0.9;

    // Evenly subsample if too many centers to prevent one component monopolizing the budget
    const scratchCenters = evenlySubsample(bucketCenters, MAX_MARKS_PER_COMPONENT);
    for (const center of scratchCenters) {
      marks.push({
        id: `dust-auto-${crypto.randomUUID()}`,
        cx: clamp(((center.x + 0.5) * scale) / (width * scale), 0, 1),
        cy: clamp(((center.y + 0.5) * scale) / (height * scale), 0, 1),
        radius: clamp(scratchRadiusPx / diagonal, 0, 1),
        source: 'auto',
        score,
      });
    }
  } else {
    // Curved hair/fiber: walk along the shape using nearest-neighbor chain,
    // then emit marks at regular intervals along the path.
    const orderedPoints = orderPointsAlongCurve(stats.points);
    const stepPx = Math.max(3, Math.round(Math.max(averageWidth * 3, maxRadius * 0.8)));
    let accumulated = 0;
    let bucket: Array<{ x: number; y: number }> = [];
    const bucketCenters: Array<{ x: number; y: number }> = [];

    const flushBucket = () => {
      if (bucket.length === 0) {
        return;
      }
      const total = bucket.reduce((accumulator, point) => ({
        x: accumulator.x + point.x,
        y: accumulator.y + point.y,
      }), { x: 0, y: 0 });
      bucketCenters.push({
        x: total.x / bucket.length,
        y: total.y / bucket.length,
      });
      bucket = [];
    };

    bucket.push(orderedPoints[0]);
    for (let index = 1; index < orderedPoints.length; index += 1) {
      const dx = orderedPoints[index].x - orderedPoints[index - 1].x;
      const dy = orderedPoints[index].y - orderedPoints[index - 1].y;
      accumulated += Math.sqrt(dx * dx + dy * dy);
      bucket.push(orderedPoints[index]);
      if (accumulated >= stepPx) {
        flushBucket();
        accumulated = 0;
      }
    }
    flushBucket();

    const hairRadiusPx = clamp(Math.max(averageWidth * 2.5, maxRadius * 0.6), 2.5, maxRadius * 1.5) * scale;
    const score = meanDeviation * stats.area * 0.85;

    const hairCenters = evenlySubsample(bucketCenters, MAX_MARKS_PER_COMPONENT);
    for (const center of hairCenters) {
      marks.push({
        id: `dust-auto-${crypto.randomUUID()}`,
        cx: clamp(((center.x + 0.5) * scale) / (width * scale), 0, 1),
        cy: clamp(((center.y + 0.5) * scale) / (height * scale), 0, 1),
        radius: clamp(hairRadiusPx / diagonal, 0, 1),
        source: 'auto',
        score,
      });
    }
  }

  return marks;
}

/**
 * Computes adaptive threshold and binary mask for a single-polarity deviation map.
 */
function computeDeviationPass(
  luminance: Float32Array,
  blurred: Float32Array,
  normalizedSensitivity: number,
  mode: DustAutoDetectMode,
  polarity: 'bright' | 'dark',
) {
  const length = luminance.length;
  const deviations = new Float32Array(length);
  const mask = new Uint8Array(length);

  let deviationSum = 0;
  for (let index = 0; index < length; index += 1) {
    const raw = polarity === 'bright'
      ? luminance[index] - blurred[index]
      : blurred[index] - luminance[index];
    const deviation = Math.max(0, raw);
    deviations[index] = deviation;
    deviationSum += deviation;
  }

  const deviationMean = length > 0 ? deviationSum / length : 0;
  let deviationVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = deviations[index] - deviationMean;
    deviationVariance += delta * delta;
  }
  const deviationStd = length > 0 ? Math.sqrt(deviationVariance / length) : 0;

  const fixedFloor = lerp(0.06, 0.012, normalizedSensitivity);
  const adaptiveThreshold = Math.max(
    fixedFloor,
    deviationMean + deviationStd * lerp(3.5, 0.8, normalizedSensitivity),
  );

  const binaryMultiplier = mode === 'spots'
    ? 1.0
    : lerp(0.9, 0.5, normalizedSensitivity);
  const binaryThreshold = adaptiveThreshold * binaryMultiplier;

  for (let index = 0; index < length; index += 1) {
    mask[index] = deviations[index] > binaryThreshold ? 1 : 0;
  }

  return { deviations, mask, adaptiveThreshold };
}

function detectDustMarksAtScale(
  imageData: ImageData,
  sensitivity: number,
  maxRadius: number,
  scale: number,
  mode: DustAutoDetectMode,
) {
  const { width, height, data } = imageData;
  const normalizedSensitivity = clamp(sensitivity, 0, 100) / 100;
  const blurRadius = Math.max(2, Math.round(maxRadius * 3.5));
  const luminance = computeLuminance(data, width, height);
  const blurred = boxBlur(luminance, width, height, blurRadius);

  // Two independent passes: bright anomalies (dust holes) and dark anomalies (hairs/fibers).
  // Each pass computes its own statistics and threshold so one polarity's noise
  // doesn't inflate the other's baseline.
  const bright = computeDeviationPass(luminance, blurred, normalizedSensitivity, mode, 'bright');
  const dark = computeDeviationPass(luminance, blurred, normalizedSensitivity, mode, 'dark');

  // Merge: use the higher deviation from either pass, and union the masks.
  const deviations = new Float32Array(luminance.length);
  const mask = new Uint8Array(luminance.length);
  const adaptiveThreshold = Math.min(bright.adaptiveThreshold, dark.adaptiveThreshold);
  for (let index = 0; index < luminance.length; index += 1) {
    deviations[index] = Math.max(bright.deviations[index], dark.deviations[index]);
    mask[index] = (bright.mask[index] || dark.mask[index]) ? 1 : 0;
  }

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const marks: Array<DustMark & { score: number }> = [];
  const sourceDiagonal = Math.hypot(width * scale, height * scale);

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail++] = index;
    visited[index] = 1;
    const stats = createComponentStats(width, height);

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      stats.area += 1;
      stats.minX = Math.min(stats.minX, x);
      stats.maxX = Math.max(stats.maxX, x);
      stats.minY = Math.min(stats.minY, y);
      stats.maxY = Math.max(stats.maxY, y);
      stats.totalX += x;
      stats.totalY += y;
      stats.totalDeviation += deviations[current];
      stats.maxDeviation = Math.max(stats.maxDeviation, deviations[current]);
      stats.points.push({ x, y });
      if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) {
        stats.touchesBorder = true;
      }

      const orthogonalNeighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ];
      const connectedNeighbors = [
        ...orthogonalNeighbors,
        current - width - 1,
        current - width + 1,
        current + width - 1,
        current + width + 1,
      ];

      for (const neighbor of orthogonalNeighbors) {
        if (neighbor < 0 || neighbor >= mask.length) {
          stats.boundaryEdges += 1;
          continue;
        }

        if (visited[neighbor] || !mask[neighbor]) {
          stats.boundaryEdges += 1;
        }
      }

      for (const neighbor of connectedNeighbors) {
        if (neighbor < 0 || neighbor >= mask.length || visited[neighbor] || !mask[neighbor]) {
          continue;
        }

        const neighborX = neighbor % width;
        const neighborY = Math.floor(neighbor / width);
        if (Math.abs(neighborX - x) > 1 || Math.abs(neighborY - y) > 1) {
          continue;
        }

        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }

    marks.push(...classifyAndBuildMarks(
      stats,
      width,
      height,
      maxRadius,
      scale,
      normalizedSensitivity,
      adaptiveThreshold,
      mode,
    ));
  }

  return dedupeMarks(marks, sourceDiagonal);
}

export function detectDustMarks(
  imageData: ImageData,
  sensitivity: number,
  maxRadius: number,
  mode: DustAutoDetectMode = 'both',
): DustMark[] {
  const megapixels = (imageData.width * imageData.height) / 1_000_000;
  if (megapixels > 12 && imageData.width >= 2 && imageData.height >= 2) {
    const downsampled = downsampleImageData(imageData);
    return detectDustMarksAtScale(downsampled, sensitivity, Math.max(1, maxRadius / 2), 2, mode);
  }

  return detectDustMarksAtScale(imageData, sensitivity, maxRadius, 1, mode);
}
