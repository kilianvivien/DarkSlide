import { clamp } from './math';

const MAX_RADIAL_COEFFICIENT = 0.14;
const AUTO_ANALYSIS_MAX_DIMENSION = 320;
const AUTO_MAX_EDGE_POINTS = 4200;
const AUTO_COARSE_STEP = 8;
const AUTO_MAX_AMOUNT = 80;

export interface LensDistortionEstimate {
  amount: number;
  confidence: number;
  lineCount: number;
  scoreImprovement: number;
}

interface EdgePoint {
  x: number;
  y: number;
  weight: number;
}

export function normalizeLensDistortion(value: number | null | undefined) {
  return clamp(Number.isFinite(value) ? value! : 0, -100, 100);
}

function radialCoefficient(amount: number) {
  return normalizeLensDistortion(amount) / 100 * MAX_RADIAL_COEFFICIENT;
}

function sourcePointToCorrectedPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  amount: number,
) {
  const coefficient = radialCoefficient(amount);
  if (Math.abs(coefficient) < 1e-8) return { x, y };
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const halfWidth = Math.max(1, centerX);
  const halfHeight = Math.max(1, centerY);
  const sourceX = (x - centerX) / halfWidth;
  const sourceY = (y - centerY) / halfHeight;
  const sourceRadius = Math.hypot(sourceX, sourceY);
  if (sourceRadius < 1e-8) return { x, y };

  let correctedRadius = sourceRadius;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const radiusSquared = correctedRadius * correctedRadius;
    const value = correctedRadius * (1 + coefficient * radiusSquared) - sourceRadius;
    const derivative = 1 + 3 * coefficient * radiusSquared;
    if (Math.abs(derivative) < 1e-6) break;
    correctedRadius = Math.max(0, correctedRadius - value / derivative);
  }

  const radiusScale = correctedRadius / sourceRadius / safeCoordinateScale(coefficient);
  return {
    x: centerX + sourceX * radiusScale * halfWidth,
    y: centerY + sourceY * radiusScale * halfHeight,
  };
}

function buildAnalysisLuma(imageData: Pick<ImageData, 'data' | 'width' | 'height'>) {
  const sourceWidth = Math.max(1, imageData.width);
  const sourceHeight = Math.max(1, imageData.height);
  const scale = Math.min(1, AUTO_ANALYSIS_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(24, Math.round(sourceWidth * scale));
  const height = Math.max(24, Math.round(sourceHeight * scale));
  const luma = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      luma[y * width + x] = imageData.data[sourceIndex] * 0.299
        + imageData.data[sourceIndex + 1] * 0.587
        + imageData.data[sourceIndex + 2] * 0.114;
    }
  }

  return { luma, width, height };
}

function extractEdgePoints(imageData: Pick<ImageData, 'data' | 'width' | 'height'>) {
  const { luma, width, height } = buildAnalysisLuma(imageData);
  const candidates: EdgePoint[] = [];
  const magnitudes: number[] = [];
  const insetX = Math.max(2, Math.round(width * 0.035));
  const insetY = Math.max(2, Math.round(height * 0.035));

  for (let y = insetY; y < height - insetY; y += 1) {
    for (let x = insetX; x < width - insetX; x += 1) {
      const topLeft = luma[(y - 1) * width + x - 1];
      const top = luma[(y - 1) * width + x];
      const topRight = luma[(y - 1) * width + x + 1];
      const left = luma[y * width + x - 1];
      const right = luma[y * width + x + 1];
      const bottomLeft = luma[(y + 1) * width + x - 1];
      const bottom = luma[(y + 1) * width + x];
      const bottomRight = luma[(y + 1) * width + x + 1];
      const gradientX = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gradientY = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const magnitude = Math.hypot(gradientX, gradientY);
      if (magnitude < 18) continue;
      candidates.push({ x, y, weight: magnitude });
      magnitudes.push(magnitude);
    }
  }

  if (candidates.length < 180) return { points: [] as EdgePoint[], width, height };
  magnitudes.sort((left, right) => left - right);
  const threshold = magnitudes[Math.floor(magnitudes.length * 0.86)] ?? 0;
  const strong = candidates.filter((point) => point.weight >= threshold);
  const stride = Math.max(1, Math.ceil(strong.length / AUTO_MAX_EDGE_POINTS));
  const points: EdgePoint[] = [];
  for (let index = 0; index < strong.length; index += stride) {
    points.push({ ...strong[index], weight: Math.min(3, strong[index].weight / Math.max(1, threshold)) });
  }
  return { points, width, height };
}

function scoreStraightLines(points: EdgePoint[], width: number, height: number, amount: number) {
  const angleCount = 60;
  const rhoStep = 2;
  const diagonal = Math.hypot(width, height);
  const rhoCount = Math.ceil((diagonal * 2) / rhoStep) + 3;
  const accumulator = new Float32Array(angleCount * rhoCount);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;

  for (const point of points) {
    const corrected = sourcePointToCorrectedPoint(point.x, point.y, width, height, amount);
    const localX = corrected.x - centerX;
    const localY = corrected.y - centerY;
    for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
      const angle = angleIndex * Math.PI / angleCount;
      const rho = localX * Math.cos(angle) + localY * Math.sin(angle);
      const rhoIndex = Math.round((rho + diagonal) / rhoStep);
      if (rhoIndex >= 0 && rhoIndex < rhoCount) {
        accumulator[angleIndex * rhoCount + rhoIndex] += point.weight;
      }
    }
  }

  const peaks: number[] = [];
  for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
    const offset = angleIndex * rhoCount;
    let strongest = 0;
    let second = 0;
    for (let rhoIndex = 1; rhoIndex < rhoCount - 1; rhoIndex += 1) {
      const value = accumulator[offset + rhoIndex];
      if (value <= accumulator[offset + rhoIndex - 1] || value < accumulator[offset + rhoIndex + 1]) continue;
      if (value > strongest) {
        second = strongest;
        strongest = value;
      } else if (value > second) {
        second = value;
      }
    }
    peaks.push(strongest, second);
  }
  peaks.sort((left, right) => right - left);
  const selected = peaks.slice(0, 18);
  const score = selected.reduce((total, peak, index) => total + peak * peak / (1 + index * 0.12), 0);
  const lineCount = selected.filter((peak) => peak >= Math.max(10, points.length * 0.018)).length;
  return { score, lineCount };
}

export function estimateLensDistortion(
  imageData: Pick<ImageData, 'data' | 'width' | 'height'>,
): LensDistortionEstimate | null {
  const { points, width, height } = extractEdgePoints(imageData);
  if (points.length < 180) return null;

  const coarse: Array<{ amount: number; score: number; lineCount: number }> = [];
  for (let amount = -AUTO_MAX_AMOUNT; amount <= AUTO_MAX_AMOUNT; amount += AUTO_COARSE_STEP) {
    coarse.push({ amount, ...scoreStraightLines(points, width, height, amount) });
  }
  coarse.sort((left, right) => right.score - left.score);
  const coarseBest = coarse[0];
  if (!coarseBest || Math.abs(coarseBest.amount) === AUTO_MAX_AMOUNT) return null;

  const refined: Array<{ amount: number; score: number; lineCount: number }> = [];
  for (let amount = coarseBest.amount - AUTO_COARSE_STEP; amount <= coarseBest.amount + AUTO_COARSE_STEP; amount += 1) {
    refined.push({ amount, ...scoreStraightLines(points, width, height, amount) });
  }
  refined.sort((left, right) => right.score - left.score);
  const best = refined[0];
  const zero = coarse.find((candidate) => candidate.amount === 0) ?? { score: best.score, lineCount: best.lineCount };
  const separatedRunner = [...coarse, ...refined]
    .filter((candidate) => Math.abs(candidate.amount - best.amount) >= 10)
    .sort((left, right) => right.score - left.score)[0];
  const scoreImprovement = (best.score - zero.score) / Math.max(1, zero.score);
  const separation = separatedRunner ? (best.score - separatedRunner.score) / Math.max(1, best.score) : 0;
  const evidence = clamp((best.lineCount - 3) / 10, 0, 1);
  const confidence = clamp(evidence * 0.45 + Math.max(0, scoreImprovement) * 7 + Math.max(0, separation) * 4, 0, 1);
  // The coarse Hough bins have a small center bias. Treat sub-9 values as
  // optically negligible instead of inventing a correction for straight scans.
  const amount = Math.abs(best.amount) < 9 ? 0 : best.amount;

  if (best.lineCount < 5 || confidence < 0.28) return null;
  return {
    amount,
    confidence,
    lineCount: best.lineCount,
    scoreImprovement,
  };
}

function safeCoordinateScale(coefficient: number) {
  if (coefficient <= 0) return 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) / 2;
    const mappedCorner = middle * (1 + coefficient * 2 * middle * middle);
    if (mappedCorner <= 1) low = middle;
    else high = middle;
  }
  return low;
}

export function mapLensCorrectedPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  amount: number,
) {
  const coefficient = radialCoefficient(amount);
  if (Math.abs(coefficient) < 1e-8) return { x, y };
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const halfWidth = Math.max(1, centerX);
  const halfHeight = Math.max(1, centerY);
  const scale = safeCoordinateScale(coefficient);
  const normalizedX = (x - centerX) / halfWidth * scale;
  const normalizedY = (y - centerY) / halfHeight * scale;
  const radiusSquared = normalizedX * normalizedX + normalizedY * normalizedY;
  const radialScale = 1 + coefficient * radiusSquared;
  return {
    x: centerX + normalizedX * radialScale * halfWidth,
    y: centerY + normalizedY * radialScale * halfHeight,
  };
}

export function correctLensDistortionImageData(imageData: ImageData, amount: number) {
  const normalizedAmount = normalizeLensDistortion(amount);
  if (Math.abs(normalizedAmount) < 1e-6) return imageData;
  const { width, height, data } = imageData;
  const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = mapLensCorrectedPoint(x, y, width, height, normalizedAmount);
      const x0 = clamp(Math.floor(source.x), 0, width - 1);
      const y0 = clamp(Math.floor(source.y), 0, height - 1);
      const x1 = clamp(x0 + 1, 0, width - 1);
      const y1 = clamp(y0 + 1, 0, height - 1);
      const fx = clamp(source.x - x0, 0, 1);
      const fy = clamp(source.y - y0, 0, 1);
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = data[(y0 * width + x0) * 4 + channel] * (1 - fx)
          + data[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = data[(y1 * width + x0) * 4 + channel] * (1 - fx)
          + data[(y1 * width + x1) * 4 + channel] * fx;
        output.data[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return output;
}
