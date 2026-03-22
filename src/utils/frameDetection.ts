import { clamp } from './math';
import { DetectedFrame } from '../types';

const MAX_DETECTION_ANGLE = 5;
const MIN_FRAME_AREA = 0.2;
const MAX_FRAME_AREA = 0.98;
const MIN_CONFIDENCE = 3;
const SAMPLE_COUNT = 8;
const MIN_ABSOLUTE_PEAK_FACTOR = 10;
const EDGE_SEARCH_BAND_FRACTION = 0.18;
const CANDIDATE_THRESHOLD_SIGMA = 1.25;
const SMOOTHING_RADIUS_FRACTION = 0.006;
const MAX_SMOOTHING_RADIUS = 8;
const EDGE_CONTRAST_SCALE = 20;

type Peak = {
  index: number;
  value: number;
  score: number;
  contrast: number;
};

export function detectFrame(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): DetectedFrame | null {
  if (width < 8 || height < 8) {
    return null;
  }

  const grayscale = buildGrayscale(pixels, width, height);
  const rawProjectionX = new Float32Array(width);
  const rawProjectionY = new Float32Array(height);
  const gradientY = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = rowOffset + x;
      const gx = grayscale[index + 1] - grayscale[index - 1];
      const gy = grayscale[index + width] - grayscale[index - width];
      const absGx = Math.abs(gx);
      const absGy = Math.abs(gy);
      rawProjectionX[x] += absGx;
      rawProjectionY[y] += absGy;
      gradientY[index] = absGy;
    }
  }

  const projectionX = smoothProfile(rawProjectionX);
  const projectionY = smoothProfile(rawProjectionY);
  const xStats = getStats(projectionX);
  const yStats = getStats(projectionY);

  if (xStats.sigma <= 0 || yStats.sigma <= 0) {
    return null;
  }

  const xBandEnd = Math.max(2, Math.floor((width - 1) * EDGE_SEARCH_BAND_FRACTION));
  const xBandStart = Math.min(width - 3, Math.ceil((width - 1) * (1 - EDGE_SEARCH_BAND_FRACTION)));
  const yBandEnd = Math.max(2, Math.floor((height - 1) * EDGE_SEARCH_BAND_FRACTION));
  const yBandStart = Math.min(height - 3, Math.ceil((height - 1) * (1 - EDGE_SEARCH_BAND_FRACTION)));

  const leftPeak = findBestPeakInBand(
    projectionX,
    xStats.mean + xStats.sigma * CANDIDATE_THRESHOLD_SIGMA,
    xStats.sigma,
    1,
    xBandEnd,
    (index) => measureVerticalEdgeContrast(grayscale, width, height, index, 'left'),
  );
  const rightPeak = findBestPeakInBand(
    projectionX,
    xStats.mean + xStats.sigma * CANDIDATE_THRESHOLD_SIGMA,
    xStats.sigma,
    xBandStart,
    width - 2,
    (index) => measureVerticalEdgeContrast(grayscale, width, height, index, 'right'),
  );
  const topPeak = findBestPeakInBand(
    projectionY,
    yStats.mean + yStats.sigma * CANDIDATE_THRESHOLD_SIGMA,
    yStats.sigma,
    1,
    yBandEnd,
    (index) => measureHorizontalEdgeContrast(grayscale, width, height, index, 'top'),
  );
  const bottomPeak = findBestPeakInBand(
    projectionY,
    yStats.mean + yStats.sigma * CANDIDATE_THRESHOLD_SIGMA,
    yStats.sigma,
    yBandStart,
    height - 2,
    (index) => measureHorizontalEdgeContrast(grayscale, width, height, index, 'bottom'),
  );

  if (!leftPeak || !rightPeak || !topPeak || !bottomPeak) {
    return null;
  }

  const left = refinePeak(projectionX, leftPeak.index) / Math.max(1, width - 1);
  const right = refinePeak(projectionX, rightPeak.index) / Math.max(1, width - 1);
  const top = refinePeak(projectionY, topPeak.index) / Math.max(1, height - 1);
  const bottom = refinePeak(projectionY, bottomPeak.index) / Math.max(1, height - 1);

  if (!(right > left && bottom > top)) {
    return null;
  }

  const frameArea = (right - left) * (bottom - top);
  const minPeakStrength = Math.min(topPeak.value, bottomPeak.value, leftPeak.value, rightPeak.value);
  const confidence = Math.min(
    topPeak.value / yStats.sigma,
    bottomPeak.value / yStats.sigma,
    leftPeak.value / xStats.sigma,
    rightPeak.value / xStats.sigma,
  );

  if (
    confidence < MIN_CONFIDENCE
    || frameArea < MIN_FRAME_AREA
    || frameArea > MAX_FRAME_AREA
    || minPeakStrength < Math.min(width, height) * MIN_ABSOLUTE_PEAK_FACTOR
  ) {
    return null;
  }

  let nextTop = top;
  let nextBottom = bottom;
  let nextLeft = left;
  let nextRight = right;

  const topSlope = fitHorizontalEdgeSlope(gradientY, width, height, topPeak.index);
  const bottomSlope = fitHorizontalEdgeSlope(gradientY, width, height, bottomPeak.index);
  const averageSlope = averageFinite(topSlope, bottomSlope);
  const angle = clamp((Math.atan(averageSlope) * 180) / Math.PI, -MAX_DETECTION_ANGLE, MAX_DETECTION_ANGLE);

  const detectedAspect = (right - left) * width / Math.max((bottom - top) * height, 1e-6);
  if (detectedAspect >= 1.3 && detectedAspect <= 1.7) {
    const sprocketSide = detectSprocketSide(grayscale, width, height, top, bottom, left, right);
    const inset = Math.max((bottom - top) * 0.03, 0.05);
    if (sprocketSide === 'top') {
      nextTop = clamp(nextTop + inset, 0, nextBottom - 0.01);
    } else if (sprocketSide === 'bottom') {
      nextBottom = clamp(nextBottom - inset, nextTop + 0.01, 1);
    } else if (sprocketSide === 'left') {
      nextLeft = clamp(nextLeft + inset, 0, nextRight - 0.01);
    } else if (sprocketSide === 'right') {
      nextRight = clamp(nextRight - inset, nextLeft + 0.01, 1);
    }
  }

  return {
    top: nextTop,
    left: nextLeft,
    bottom: nextBottom,
    right: nextRight,
    angle,
    confidence,
  };
}

function buildGrayscale(pixels: Uint8ClampedArray, width: number, height: number) {
  const grayscale = new Float32Array(width * height);

  for (let index = 0, pixel = 0; index < grayscale.length; index += 1, pixel += 4) {
    grayscale[index] = pixels[pixel] * 0.299 + pixels[pixel + 1] * 0.587 + pixels[pixel + 2] * 0.114;
  }

  return grayscale;
}

function getStats(values: Float32Array) {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
  }
  const mean = sum / Math.max(values.length, 1);

  let variance = 0;
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - mean;
    variance += delta * delta;
  }

  return {
    mean,
    sigma: Math.sqrt(variance / Math.max(values.length, 1)),
  };
}

function isLocalMaximum(values: Float32Array, index: number) {
  return values[index] >= values[index - 1] && values[index] >= values[index + 1];
}

function smoothProfile(values: Float32Array) {
  const radius = Math.max(2, Math.min(MAX_SMOOTHING_RADIUS, Math.round(values.length * SMOOTHING_RADIUS_FRACTION)));
  const smoothed = new Float32Array(values.length);
  const prefix = new Float32Array(values.length + 1);

  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }

  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    smoothed[index] = (prefix[end + 1] - prefix[start]) / Math.max(1, end - start + 1);
  }

  return smoothed;
}

function findBestPeakInBand(
  values: Float32Array,
  threshold: number,
  sigma: number,
  start: number,
  end: number,
  getContrast: (index: number) => number,
): Peak | null {
  if (start > end) {
    return null;
  }

  const candidates: Peak[] = [];
  let fallbackIndex = start;
  let fallbackValue = Number.NEGATIVE_INFINITY;
  let strongestLocalMaxIndex = -1;
  let strongestLocalMaxValue = Number.NEGATIVE_INFINITY;

  for (let index = start; index <= end; index += 1) {
    const value = values[index];
    if (value > fallbackValue) {
      fallbackValue = value;
      fallbackIndex = index;
    }

    if (index <= 0 || index >= values.length - 1 || !isLocalMaximum(values, index)) {
      continue;
    }

    if (value > strongestLocalMaxValue) {
      strongestLocalMaxValue = value;
      strongestLocalMaxIndex = index;
    }

    if (value >= threshold) {
      const contrast = getContrast(index);
      candidates.push({
        index,
        value,
        contrast,
        score: value / Math.max(sigma, 1e-6) + contrast / EDGE_CONTRAST_SCALE,
      });
    }
  }

  if (candidates.length === 0) {
    const chosenIndex = strongestLocalMaxIndex >= 0 ? strongestLocalMaxIndex : fallbackIndex;
    const chosenValue = values[chosenIndex];
    const contrast = getContrast(chosenIndex);
    candidates.push({
      index: chosenIndex,
      value: chosenValue,
      contrast,
      score: chosenValue / Math.max(sigma, 1e-6) + contrast / EDGE_CONTRAST_SCALE,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.value - a.value);
  return candidates[0] ?? null;
}

function refinePeak(values: Float32Array, centerIndex: number) {
  if (centerIndex <= 0 || centerIndex >= values.length - 1) {
    return centerIndex;
  }

  const left = values[centerIndex - 1];
  const center = values[centerIndex];
  const right = values[centerIndex + 1];
  const denominator = 2 * (left - 2 * center + right);
  if (Math.abs(denominator) < 1e-6) {
    return centerIndex;
  }

  return centerIndex + (left - right) / denominator;
}

function measureVerticalEdgeContrast(
  grayscale: Float32Array,
  width: number,
  height: number,
  edgeX: number,
  side: 'left' | 'right',
) {
  const yStart = Math.max(0, Math.floor(height * 0.1));
  const yEnd = Math.min(height - 1, Math.ceil(height * 0.9));
  const bandWidth = Math.max(1, Math.round(width * 0.012));

  if (side === 'left') {
    const outer = averageRegion(grayscale, width, 0, edgeX - bandWidth, edgeX - 1, yStart, yEnd);
    const inner = averageRegion(grayscale, width, 0, edgeX, edgeX + bandWidth - 1, yStart, yEnd);
    return Math.abs(inner - outer);
  }

  const inner = averageRegion(grayscale, width, 0, edgeX - bandWidth + 1, edgeX, yStart, yEnd);
  const outer = averageRegion(grayscale, width, 0, edgeX + 1, edgeX + bandWidth, yStart, yEnd);
  return Math.abs(inner - outer);
}

function measureHorizontalEdgeContrast(
  grayscale: Float32Array,
  width: number,
  height: number,
  edgeY: number,
  side: 'top' | 'bottom',
) {
  const xStart = Math.max(0, Math.floor(width * 0.1));
  const xEnd = Math.min(width - 1, Math.ceil(width * 0.9));
  const bandHeight = Math.max(1, Math.round(height * 0.012));

  if (side === 'top') {
    const outer = averageRegion(grayscale, width, height, xStart, xEnd, edgeY - bandHeight, edgeY - 1);
    const inner = averageRegion(grayscale, width, height, xStart, xEnd, edgeY, edgeY + bandHeight - 1);
    return Math.abs(inner - outer);
  }

  const inner = averageRegion(grayscale, width, height, xStart, xEnd, edgeY - bandHeight + 1, edgeY);
  const outer = averageRegion(grayscale, width, height, xStart, xEnd, edgeY + 1, edgeY + bandHeight);
  return Math.abs(inner - outer);
}

function averageRegion(
  grayscale: Float32Array,
  width: number,
  heightOrZero: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
) {
  const inferredHeight = heightOrZero || Math.floor(grayscale.length / Math.max(width, 1));
  const clampedXStart = clamp(Math.min(xStart, xEnd), 0, width - 1);
  const clampedXEnd = clamp(Math.max(xStart, xEnd), 0, width - 1);
  const clampedYStart = clamp(Math.min(yStart, yEnd), 0, inferredHeight - 1);
  const clampedYEnd = clamp(Math.max(yStart, yEnd), 0, inferredHeight - 1);

  let total = 0;
  let count = 0;

  for (let y = clampedYStart; y <= clampedYEnd; y += 1) {
    const rowOffset = y * width;
    for (let x = clampedXStart; x <= clampedXEnd; x += 1) {
      total += grayscale[rowOffset + x];
      count += 1;
    }
  }

  return total / Math.max(count, 1);
}

function fitHorizontalEdgeSlope(
  gradientY: Float32Array,
  width: number,
  height: number,
  approxY: number,
) {
  const xStart = Math.max(1, Math.floor(width * 0.1));
  const xEnd = Math.min(width - 2, Math.ceil(width * 0.9));
  const searchRadius = Math.max(2, Math.round(height * 0.03));
  const points: Array<{ x: number; y: number }> = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const t = sample / (SAMPLE_COUNT - 1);
    const x = Math.round(xStart + (xEnd - xStart) * t);
    let bestY = approxY;
    let bestValue = -1;

    for (let y = Math.max(1, approxY - searchRadius); y <= Math.min(height - 2, approxY + searchRadius); y += 1) {
      const value = gradientY[y * width + x];
      if (value > bestValue) {
        bestValue = value;
        bestY = y;
      }
    }

    points.push({ x, y: bestY });
  }

  return fitSlope(points);
}

function fitSlope(points: Array<{ x: number; y: number }>) {
  const count = points.length;
  if (count < 2) {
    return 0;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  }

  const denominator = count * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-6) {
    return 0;
  }

  return (count * sumXY - sumX * sumY) / denominator;
}

function averageFinite(...values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function detectSprocketSide(
  grayscale: Float32Array,
  width: number,
  height: number,
  top: number,
  bottom: number,
  left: number,
  right: number,
) {
  if (width >= height) {
    const topProfile = extractHorizontalBandProfile(grayscale, width, height, top, 0.035);
    const bottomProfile = extractHorizontalBandProfile(grayscale, width, height, bottom, 0.035);
    const expectedSpacing = width / 24;
    const topScore = Math.max(periodicPeakScore(topProfile, expectedSpacing), brightRunScore(topProfile, expectedSpacing));
    const bottomScore = Math.max(periodicPeakScore(bottomProfile, expectedSpacing), brightRunScore(bottomProfile, expectedSpacing));

    if (topScore >= 3 && topScore > bottomScore) {
      return 'top' as const;
    }
    if (bottomScore >= 3 && bottomScore > topScore) {
      return 'bottom' as const;
    }
    return null;
  }

  const leftProfile = extractVerticalBandProfile(grayscale, width, height, left, 0.035);
  const rightProfile = extractVerticalBandProfile(grayscale, width, height, right, 0.035);
  const expectedSpacing = height / 24;
  const leftScore = Math.max(periodicPeakScore(leftProfile, expectedSpacing), brightRunScore(leftProfile, expectedSpacing));
  const rightScore = Math.max(periodicPeakScore(rightProfile, expectedSpacing), brightRunScore(rightProfile, expectedSpacing));

  if (leftScore >= 3 && leftScore > rightScore) {
    return 'left' as const;
  }
  if (rightScore >= 3 && rightScore > leftScore) {
    return 'right' as const;
  }

  return null;
}

function extractHorizontalBandProfile(
  grayscale: Float32Array,
  width: number,
  height: number,
  edge: number,
  bandHeight: number,
) {
  const yCenter = clamp(Math.round(edge * (height - 1)), 0, height - 1);
  const radius = Math.max(1, Math.round(height * bandHeight));
  const profile = new Float32Array(width);

  for (let x = 0; x < width; x += 1) {
    let total = 0;
    let count = 0;
    for (let y = Math.max(0, yCenter - radius); y <= Math.min(height - 1, yCenter + radius); y += 1) {
      total += grayscale[y * width + x];
      count += 1;
    }
    profile[x] = total / Math.max(count, 1);
  }

  return profile;
}

function extractVerticalBandProfile(
  grayscale: Float32Array,
  width: number,
  height: number,
  edge: number,
  bandWidth: number,
) {
  const xCenter = clamp(Math.round(edge * (width - 1)), 0, width - 1);
  const radius = Math.max(1, Math.round(width * bandWidth));
  const profile = new Float32Array(height);

  for (let y = 0; y < height; y += 1) {
    let total = 0;
    let count = 0;
    for (let x = Math.max(0, xCenter - radius); x <= Math.min(width - 1, xCenter + radius); x += 1) {
      total += grayscale[y * width + x];
      count += 1;
    }
    profile[y] = total / Math.max(count, 1);
  }

  return profile;
}

function periodicPeakScore(profile: Float32Array, expectedSpacing: number) {
  const peaks: number[] = [];
  const stats = getStats(profile);
  const threshold = stats.mean + stats.sigma * 1.25;

  for (let index = 1; index < profile.length - 1; index += 1) {
    if (profile[index] > threshold && isLocalMaximum(profile, index)) {
      peaks.push(index);
    }
  }

  let matches = 0;
  for (let index = 1; index < peaks.length; index += 1) {
    const spacing = peaks[index] - peaks[index - 1];
    if (Math.abs(spacing - expectedSpacing) <= Math.max(2, expectedSpacing * 0.35)) {
      matches += 1;
    }
  }

  return matches;
}

function brightRunScore(profile: Float32Array, expectedSpacing: number) {
  const stats = getStats(profile);
  const threshold = stats.mean + stats.sigma * 0.75;
  const centers: number[] = [];
  let runStart = -1;

  for (let index = 0; index < profile.length; index += 1) {
    if (profile[index] >= threshold) {
      if (runStart < 0) {
        runStart = index;
      }
      continue;
    }

    if (runStart >= 0) {
      centers.push((runStart + index - 1) / 2);
      runStart = -1;
    }
  }

  if (runStart >= 0) {
    centers.push((runStart + profile.length - 1) / 2);
  }

  let matches = 0;
  for (let index = 1; index < centers.length; index += 1) {
    const spacing = centers[index] - centers[index - 1];
    if (Math.abs(spacing - expectedSpacing) <= Math.max(2, expectedSpacing * 0.4)) {
      matches += 1;
    }
  }

  return matches;
}
