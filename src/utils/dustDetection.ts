import { DustAutoDetectMode, DustMark } from '../types';
import { clamp } from './math';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const MAX_AUTO_MARKS = 36;

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
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

  const isSpotCandidate = (
    stats.area >= (normalizedSensitivity >= 0.8 ? 1 : (normalizedSensitivity >= 0.55 ? 2 : 3))
    && stats.area <= Math.PI * maxRadius * maxRadius
    && aspectRatio <= 2.8
    && fillRatio >= 0.22
    && circularity >= 0.05
    && meanDeviation > adaptiveThreshold * 1.08
    && stats.maxDeviation > adaptiveThreshold * 1.25
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
  const isScratchCandidate = (
    canEmitScratches
    && !stats.touchesBorder
    && stats.area >= Math.max(4, Math.round(maxRadius))
    && aspectRatio >= 2
    && longSide >= Math.max(8, Math.round(maxRadius * 1.4))
    && shortSide <= Math.max(maxRadius * 1.2, 10)
    && fillRatio >= 0.04
    && fillRatio <= 0.55
    && meanDeviation > adaptiveThreshold * 0.72
    && stats.maxDeviation > adaptiveThreshold * 0.95
  );

  if (!isScratchCandidate) {
    return marks;
  }

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

  for (const center of bucketCenters) {
    marks.push({
      id: `dust-auto-${crypto.randomUUID()}`,
      cx: clamp(((center.x + 0.5) * scale) / (width * scale), 0, 1),
      cy: clamp(((center.y + 0.5) * scale) / (height * scale), 0, 1),
      radius: clamp(scratchRadiusPx / diagonal, 0, 1),
      source: 'auto',
      score,
    });
  }

  return marks;
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
  const threshold = lerp(0.22, 0.06, normalizedSensitivity);
  const blurRadius = Math.max(1, Math.round(maxRadius * 2));
  const luminance = computeLuminance(data, width, height);
  const blurred = boxBlur(luminance, width, height, blurRadius);
  const deviations = new Float32Array(luminance.length);
  const mask = new Uint8Array(luminance.length);

  let deviationSum = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    const deviation = Math.max(0, luminance[index] - blurred[index]);
    deviations[index] = deviation;
    deviationSum += deviation;
  }

  const deviationMean = deviations.length > 0 ? deviationSum / deviations.length : 0;
  let deviationVariance = 0;
  for (let index = 0; index < deviations.length; index += 1) {
    const delta = deviations[index] - deviationMean;
    deviationVariance += delta * delta;
  }
  const deviationStd = deviations.length > 0 ? Math.sqrt(deviationVariance / deviations.length) : 0;
  const adaptiveThreshold = Math.max(
    threshold,
    deviationMean + deviationStd * lerp(2.1, 0.95, normalizedSensitivity),
  );

  const binaryThreshold = mode === 'spots'
    ? adaptiveThreshold
    : adaptiveThreshold * 0.55;

  for (let index = 0; index < deviations.length; index += 1) {
    mask[index] = deviations[index] > binaryThreshold ? 1 : 0;
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
