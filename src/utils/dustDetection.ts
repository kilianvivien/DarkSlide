import { DustAutoDetectMode, DustMark, DustPathPoint, PathDustMark, SpotDustMark } from '../types';
import { clamp } from './math';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const MAX_AUTO_MARKS = 64;
const MAX_AUTO_PATHS = 16;
const MAX_PATH_POINTS = 48;

type ComponentStats = {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  totalX: number;
  totalY: number;
  totalSignal: number;
  totalEdge: number;
  nearBorderCount: number;
  points: Array<{ x: number; y: number }>;
};

type ScoredMark = DustMark & { score: number };

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function createComponentStats(width: number, height: number): ComponentStats {
  return {
    area: 0,
    minX: width,
    maxX: 0,
    minY: height,
    maxY: 0,
    totalX: 0,
    totalY: 0,
    totalSignal: 0,
    totalEdge: 0,
    nearBorderCount: 0,
    points: [],
  };
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

function computeGradientMagnitude(luminance: Float32Array, width: number, height: number) {
  const result = new Float32Array(luminance.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const topLeft = luminance[index - width - 1];
      const top = luminance[index - width];
      const topRight = luminance[index - width + 1];
      const left = luminance[index - 1];
      const right = luminance[index + 1];
      const bottomLeft = luminance[index + width - 1];
      const bottom = luminance[index + width];
      const bottomRight = luminance[index + width + 1];

      const gx = -topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      result[index] = Math.sqrt(gx * gx + gy * gy) * 0.25;
    }
  }

  return result;
}

function computeLineStrength(signal: Float32Array, width: number, height: number) {
  const result = new Float32Array(signal.length);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const center = signal[index];

      const horizontal = (
        signal[index - 1]
        + center
        + signal[index + 1]
      ) - 0.5 * (
        signal[index - width]
        + signal[index + width]
        + signal[index - width - 1]
        + signal[index - width + 1]
        + signal[index + width - 1]
        + signal[index + width + 1]
      ) / 3;
      const vertical = (
        signal[index - width]
        + center
        + signal[index + width]
      ) - 0.5 * (
        signal[index - 1]
        + signal[index + 1]
        + signal[index - width - 1]
        + signal[index - width + 1]
        + signal[index + width - 1]
        + signal[index + width + 1]
      ) / 3;
      const diagonalDown = (
        signal[index - width - 1]
        + center
        + signal[index + width + 1]
      ) - 0.5 * (
        signal[index - width]
        + signal[index + width]
        + signal[index - 1]
        + signal[index + 1]
        + signal[index - width + 1]
        + signal[index + width - 1]
      ) / 3;
      const diagonalUp = (
        signal[index - width + 1]
        + center
        + signal[index + width - 1]
      ) - 0.5 * (
        signal[index - width]
        + signal[index + width]
        + signal[index - 1]
        + signal[index + 1]
        + signal[index - width - 1]
        + signal[index + width + 1]
      ) / 3;

      result[index] = Math.max(horizontal, vertical, diagonalDown, diagonalUp, 0);
    }
  }

  return result;
}

function orderPointsAlongCurve(points: Array<{ x: number; y: number }>) {
  if (points.length <= 2) {
    return points;
  }

  let startIndex = 0;
  let minScore = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const score = points[index].x + points[index].y;
    if (score < minScore) {
      minScore = score;
      startIndex = index;
    }
  }

  const ordered: Array<{ x: number; y: number }> = [];
  const used = new Uint8Array(points.length);
  let current = startIndex;

  for (let step = 0; step < points.length; step += 1) {
    ordered.push(points[current]);
    used[current] = 1;

    let bestIndex = -1;
    let bestDistance = Infinity;
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

function subsamplePathPoints(
  orderedPoints: Array<{ x: number; y: number }>,
  spacing: number,
  width: number,
  height: number,
  scale: number,
): DustPathPoint[] {
  if (orderedPoints.length === 0) {
    return [];
  }

  const normalized: DustPathPoint[] = [];
  let previous = orderedPoints[0];
  normalized.push({
    x: clamp(((previous.x + 0.5) * scale) / (width * scale), 0, 1),
    y: clamp(((previous.y + 0.5) * scale) / (height * scale), 0, 1),
  });

  let accumulated = 0;
  for (let index = 1; index < orderedPoints.length; index += 1) {
    const current = orderedPoints[index];
    accumulated += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
    if (accumulated < spacing) {
      continue;
    }

    normalized.push({
      x: clamp(((current.x + 0.5) * scale) / (width * scale), 0, 1),
      y: clamp(((current.y + 0.5) * scale) / (height * scale), 0, 1),
    });
    accumulated = 0;
  }

  const last = orderedPoints[orderedPoints.length - 1];
  const lastPoint = {
    x: clamp(((last.x + 0.5) * scale) / (width * scale), 0, 1),
    y: clamp(((last.y + 0.5) * scale) / (height * scale), 0, 1),
  };
  const prevPoint = normalized[normalized.length - 1];
  if (!prevPoint || prevPoint.x !== lastPoint.x || prevPoint.y !== lastPoint.y) {
    normalized.push(lastPoint);
  }

  if (normalized.length <= MAX_PATH_POINTS) {
    return normalized;
  }

  const step = (normalized.length - 1) / (MAX_PATH_POINTS - 1);
  const result: DustPathPoint[] = [];
  for (let index = 0; index < MAX_PATH_POINTS; index += 1) {
    result.push(normalized[Math.round(index * step)]);
  }
  return result;
}

function buildComponentStats(
  mask: Uint8Array,
  signal: Float32Array,
  edge: Float32Array,
  width: number,
  height: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: ComponentStats[] = [];
  const borderMargin = Math.max(2, Math.round(Math.min(width, height) * 0.015));

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
      stats.totalSignal += signal[current];
      stats.totalEdge += edge[current];
      if (
        x <= borderMargin
        || y <= borderMargin
        || x >= width - borderMargin - 1
        || y >= height - borderMargin - 1
      ) {
        stats.nearBorderCount += 1;
      }
      stats.points.push({ x, y });

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }
          const nextIndex = nextY * width + nextX;
          if (visited[nextIndex] || !mask[nextIndex]) {
            continue;
          }
          visited[nextIndex] = 1;
          queue[tail++] = nextIndex;
        }
      }
    }

    components.push(stats);
  }

  return components;
}

function distancePointToSegment(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  const dx = endX - startX;
  const dy = endY - startY;
  if (dx === 0 && dy === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const t = clamp(
    ((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy),
    0,
    1,
  );
  const projX = startX + dx * t;
  const projY = startY + dy * t;
  return Math.hypot(pointX - projX, pointY - projY);
}

function distancePointToPath(pointX: number, pointY: number, mark: PathDustMark) {
  let bestDistance = Infinity;
  for (let index = 1; index < mark.points.length; index += 1) {
    const distance = distancePointToSegment(
      pointX,
      pointY,
      mark.points[index - 1].x,
      mark.points[index - 1].y,
      mark.points[index].x,
      mark.points[index].y,
    );
    bestDistance = Math.min(bestDistance, distance);
  }
  return bestDistance;
}

function dedupeMarks(marks: ScoredMark[]) {
  const deduped: ScoredMark[] = [];
  const sorted = [...marks].sort((left, right) => right.score - left.score);
  let autoPathCount = 0;

  for (const mark of sorted) {
    if (mark.kind === 'path' && autoPathCount >= MAX_AUTO_PATHS) {
      continue;
    }

    const isDuplicate = deduped.some((existing) => {
      if (mark.kind === 'spot' && existing.kind === 'spot') {
        return Math.hypot(existing.cx - mark.cx, existing.cy - mark.cy) < Math.max(existing.radius, mark.radius) * 0.8;
      }

      if (mark.kind === 'spot' && existing.kind === 'path') {
        return distancePointToPath(mark.cx, mark.cy, existing) < Math.max(existing.radius, mark.radius) * 0.9;
      }

      if (mark.kind === 'path' && existing.kind === 'spot') {
        return distancePointToPath(existing.cx, existing.cy, mark) < Math.max(existing.radius, mark.radius) * 0.9;
      }

      if (mark.kind !== 'path' || existing.kind !== 'path') {
        return false;
      }

      const markStart = mark.points[0];
      const markEnd = mark.points[mark.points.length - 1];
      const existingStart = existing.points[0];
      const existingEnd = existing.points[existing.points.length - 1];
      return (
        Math.hypot(markStart.x - existingStart.x, markStart.y - existingStart.y) < Math.max(existing.radius, mark.radius)
        && Math.hypot(markEnd.x - existingEnd.x, markEnd.y - existingEnd.y) < Math.max(existing.radius, mark.radius)
      );
    });

    if (isDuplicate) {
      continue;
    }

    deduped.push(mark);
    if (mark.kind === 'path') {
      autoPathCount += 1;
    }
    if (deduped.length >= MAX_AUTO_MARKS) {
      break;
    }
  }

  return deduped.map(({ score: _score, ...mark }) => mark);
}

function classifySpotComponent(
  stats: ComponentStats,
  width: number,
  height: number,
  maxRadius: number,
  scale: number,
  normalizedSensitivity: number,
): ScoredMark | null {
  const blobWidth = stats.maxX - stats.minX + 1;
  const blobHeight = stats.maxY - stats.minY + 1;
  const longSide = Math.max(blobWidth, blobHeight);
  const shortSide = Math.min(blobWidth, blobHeight);
  const aspectRatio = longSide / Math.max(shortSide, 1);
  const fillRatio = stats.area / Math.max(blobWidth * blobHeight, 1);
  const meanSignal = stats.totalSignal / Math.max(stats.area, 1);
  const meanEdge = stats.totalEdge / Math.max(stats.area, 1);
  const borderRatio = stats.nearBorderCount / Math.max(stats.area, 1);
  const edgePenalty = meanEdge * lerp(2.4, 1.2, normalizedSensitivity);
  const score = meanSignal - edgePenalty - borderRatio * 0.08;

  if (
    stats.area < 2
    || stats.area > Math.max(24, Math.round(Math.PI * maxRadius * maxRadius * 1.35))
    || aspectRatio > lerp(2.3, 3.4, normalizedSensitivity)
    || fillRatio < 0.2
    || meanSignal < lerp(0.022, 0.01, normalizedSensitivity)
    || score < lerp(0.012, 0.006, normalizedSensitivity)
  ) {
    return null;
  }

  const diagonal = Math.hypot(width * scale, height * scale);
  const radiusPx = clamp(Math.max(longSide * 0.72, shortSide * 0.95), 1.5, maxRadius * 1.15) * scale;
  const cx = ((stats.totalX / stats.area) + 0.5) * scale;
  const cy = ((stats.totalY / stats.area) + 0.5) * scale;

  return {
    id: `dust-auto-${crypto.randomUUID()}`,
    kind: 'spot',
    cx: clamp(cx / (width * scale), 0, 1),
    cy: clamp(cy / (height * scale), 0, 1),
    radius: clamp(radiusPx / diagonal, 0, 1),
    source: 'auto',
    score: score * stats.area,
  } satisfies SpotDustMark & { score: number };
}

function classifyPathComponent(
  stats: ComponentStats,
  width: number,
  height: number,
  maxRadius: number,
  scale: number,
  normalizedSensitivity: number,
): ScoredMark | null {
  const blobWidth = stats.maxX - stats.minX + 1;
  const blobHeight = stats.maxY - stats.minY + 1;
  const longSide = Math.max(blobWidth, blobHeight);
  const shortSide = Math.min(blobWidth, blobHeight);
  const aspectRatio = longSide / Math.max(shortSide, 1);
  const averageWidth = stats.area / Math.max(longSide, 1);
  const meanSignal = stats.totalSignal / Math.max(stats.area, 1);
  const meanEdge = stats.totalEdge / Math.max(stats.area, 1);
  const borderRatio = stats.nearBorderCount / Math.max(stats.area, 1);
  const score = meanSignal - meanEdge * lerp(1.9, 1.0, normalizedSensitivity) - borderRatio * 0.04;

  if (
    stats.area < Math.max(10, Math.round(maxRadius * 1.5))
    || longSide < Math.max(14, Math.round(maxRadius * 2))
    || averageWidth > Math.max(4.8, maxRadius * 0.95)
    || aspectRatio < lerp(2.4, 1.85, normalizedSensitivity)
    || score < lerp(0.022, 0.012, normalizedSensitivity)
  ) {
    return null;
  }

  const ordered = orderPointsAlongCurve(stats.points);
  const pathPoints = subsamplePathPoints(
    ordered,
    Math.max(2, Math.round(Math.max(averageWidth * 1.5, maxRadius * 0.45))),
    width,
    height,
    scale,
  );
  if (pathPoints.length < 2) {
    return null;
  }

  const diagonal = Math.hypot(width * scale, height * scale);
  const radiusPx = clamp(Math.max(averageWidth * 1.25, maxRadius * 0.42), 1.5, maxRadius * 0.95) * scale;

  return {
    id: `dust-auto-${crypto.randomUUID()}`,
    kind: 'path',
    points: pathPoints,
    radius: clamp(radiusPx / diagonal, 0, 1),
    source: 'auto',
    score: score * ordered.length,
  } satisfies PathDustMark & { score: number };
}

function collectFallbackSpotCandidates(
  signal: Float32Array,
  localMad: Float32Array,
  edge: Float32Array,
  lineStrength: Float32Array,
  width: number,
  height: number,
  maxRadius: number,
  scale: number,
  normalizedSensitivity: number,
) {
  const marks: ScoredMark[] = [];
  const diagonal = Math.hypot(width * scale, height * scale);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const anomaly = signal[index];
      const threshold = Math.max(
        lerp(0.014, 0.006, normalizedSensitivity),
        localMad[index] * lerp(2.3, 1.4, normalizedSensitivity) + 0.0015,
      );
      if (anomaly <= threshold) {
        continue;
      }

      const gradient = edge[index];
      const localLine = lineStrength[index];
      if (
        gradient > anomaly * 1.45 + 0.03
        || localLine > anomaly * 1.9
      ) {
        continue;
      }

      let isPeak = true;
      for (let offsetY = -1; offsetY <= 1 && isPeak; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }
          if (signal[(y + offsetY) * width + (x + offsetX)] > anomaly) {
            isPeak = false;
            break;
          }
        }
      }
      if (!isPeak) {
        continue;
      }

      const radiusPx = clamp(maxRadius * 0.52, 1.2, maxRadius * 0.9) * scale;
      marks.push({
        id: `dust-auto-${crypto.randomUUID()}`,
        kind: 'spot',
        cx: clamp(((x + 0.5) * scale) / (width * scale), 0, 1),
        cy: clamp(((y + 0.5) * scale) / (height * scale), 0, 1),
        radius: clamp(radiusPx / diagonal, 0, 1),
        source: 'auto',
        score: anomaly - gradient * 0.7,
      });
    }
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
  const backgroundRadius = Math.max(3, Math.round(maxRadius * 2.4));
  const madRadius = Math.max(1, Math.round(maxRadius * 0.85));
  const luminance = computeLuminance(data, width, height);
  const baseline = boxBlur(luminance, width, height, backgroundRadius);
  const edge = computeGradientMagnitude(luminance, width, height);
  const signal = new Float32Array(luminance.length);

  for (let index = 0; index < luminance.length; index += 1) {
    signal[index] = Math.abs(luminance[index] - baseline[index]);
  }

  const localMad = boxBlur(signal, width, height, madRadius);
  const lineStrength = computeLineStrength(signal, width, height);
  const spotMask = new Uint8Array(signal.length);
  const lineMask = new Uint8Array(signal.length);

  const canEmitSpots = mode === 'spots' || mode === 'both';
  const canEmitPaths = mode === 'scratches' || mode === 'both';

  for (let index = 0; index < signal.length; index += 1) {
    const anomaly = signal[index];
    const localNoise = localMad[index];
    const gradient = edge[index];
    const localLine = lineStrength[index];
    const spotThreshold = Math.max(
      lerp(0.02, 0.008, normalizedSensitivity),
      localNoise * lerp(3.1, 1.7, normalizedSensitivity) + 0.0025,
    );
    const lineThreshold = Math.max(
      lerp(0.022, 0.01, normalizedSensitivity),
      localNoise * lerp(3.1, 1.8, normalizedSensitivity) + 0.003,
    );
    const edgePenaltyFactor = lerp(1.05, 1.55, normalizedSensitivity);

    if (
      canEmitSpots
      && anomaly > spotThreshold
      && gradient < anomaly * edgePenaltyFactor + 0.025
    ) {
      spotMask[index] = 1;
    }

    if (
      canEmitPaths
      && anomaly > lineThreshold
      && localLine > anomaly * lerp(0.95, 0.65, normalizedSensitivity)
      && gradient < localLine * lerp(1.4, 1.9, normalizedSensitivity) + 0.03
    ) {
      lineMask[index] = 1;
    }
  }

  const marks: ScoredMark[] = [];

  if (canEmitSpots) {
    const components = buildComponentStats(spotMask, signal, edge, width, height);
    for (const component of components) {
      const mark = classifySpotComponent(component, width, height, maxRadius, scale, normalizedSensitivity);
      if (mark) {
        marks.push(mark);
      }
    }

    marks.push(...collectFallbackSpotCandidates(
      signal,
      localMad,
      edge,
      lineStrength,
      width,
      height,
      maxRadius,
      scale,
      normalizedSensitivity,
    ));
  }

  if (canEmitPaths) {
    const components = buildComponentStats(lineMask, lineStrength, edge, width, height);
    for (const component of components) {
      const mark = classifyPathComponent(component, width, height, maxRadius, scale, normalizedSensitivity);
      if (mark) {
        marks.push(mark);
      }
    }
  }

  return dedupeMarks(marks);
}

export function detectDustMarks(
  imageData: ImageData,
  sensitivity: number,
  maxRadius: number,
  mode: DustAutoDetectMode = 'both',
): DustMark[] {
  const megapixels = (imageData.width * imageData.height) / 1_000_000;
  if (megapixels > 10 && imageData.width >= 2 && imageData.height >= 2) {
    const downsampled = downsampleImageData(imageData);
    return detectDustMarksAtScale(downsampled, sensitivity, Math.max(1, maxRadius / 2), 2, mode);
  }

  return detectDustMarksAtScale(imageData, sensitivity, maxRadius, 1, mode);
}
