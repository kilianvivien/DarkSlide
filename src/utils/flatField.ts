import { clamp } from './math';

export function processFlatFieldReference(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  targetSize: number,
): Float32Array {
  const result = new Float32Array(targetSize * targetSize * 3);
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;

  for (let ty = 0; ty < targetSize; ty += 1) {
    const sourceTop = (ty * height) / targetSize;
    const sourceBottom = ((ty + 1) * height) / targetSize;

    for (let tx = 0; tx < targetSize; tx += 1) {
      const sourceLeft = (tx * width) / targetSize;
      const sourceRight = ((tx + 1) * width) / targetSize;
      const sample = areaAverageSample(pixels, width, height, sourceLeft, sourceTop, sourceRight, sourceBottom);
      const targetIndex = (ty * targetSize + tx) * 3;
      result[targetIndex] = sample[0];
      result[targetIndex + 1] = sample[1];
      result[targetIndex + 2] = sample[2];
      maxR = Math.max(maxR, sample[0]);
      maxG = Math.max(maxG, sample[1]);
      maxB = Math.max(maxB, sample[2]);
    }
  }

  const safeMaxR = Math.max(maxR, 1 / 255);
  const safeMaxG = Math.max(maxG, 1 / 255);
  const safeMaxB = Math.max(maxB, 1 / 255);

  for (let index = 0; index < result.length; index += 3) {
    result[index] /= safeMaxR;
    result[index + 1] /= safeMaxG;
    result[index + 2] /= safeMaxB;
  }

  return result;
}

export function applyFlatFieldCorrection(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  flatField: Float32Array,
  ffSize: number,
): void {
  if (ffSize <= 1) {
    return;
  }

  const xScale = ffSize / Math.max(width, 1);
  const yScale = ffSize / Math.max(height, 1);

  for (let y = 0; y < height; y += 1) {
    const v = y * yScale;
    const y0 = clamp(Math.floor(v), 0, ffSize - 1);
    const y1 = clamp(y0 + 1, 0, ffSize - 1);
    const fy = clamp(v - y0, 0, 1);

    for (let x = 0; x < width; x += 1) {
      const u = x * xScale;
      const x0 = clamp(Math.floor(u), 0, ffSize - 1);
      const x1 = clamp(x0 + 1, 0, ffSize - 1);
      const fx = clamp(u - x0, 0, 1);
      const pixelIndex = (y * width + x) * 4;

      const ffR = bilinearSample(flatField, ffSize, x0, y0, x1, y1, fx, fy, 0);
      const ffG = bilinearSample(flatField, ffSize, x0, y0, x1, y1, fx, fy, 1);
      const ffB = bilinearSample(flatField, ffSize, x0, y0, x1, y1, fx, fy, 2);

      pixels[pixelIndex] = clamp(Math.round(pixels[pixelIndex] / Math.max(ffR, 0.05)), 0, 255);
      pixels[pixelIndex + 1] = clamp(Math.round(pixels[pixelIndex + 1] / Math.max(ffG, 0.05)), 0, 255);
      pixels[pixelIndex + 2] = clamp(Math.round(pixels[pixelIndex + 2] / Math.max(ffB, 0.05)), 0, 255);
    }
  }
}

function areaAverageSample(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number, number] {
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let totalWeight = 0;

  const startX = clamp(Math.floor(left), 0, width - 1);
  const endX = clamp(Math.ceil(right), 1, width);
  const startY = clamp(Math.floor(top), 0, height - 1);
  const endY = clamp(Math.ceil(bottom), 1, height);

  for (let y = startY; y < endY; y += 1) {
    const overlapY = Math.max(0, Math.min(bottom, y + 1) - Math.max(top, y));
    if (overlapY <= 0) continue;

    for (let x = startX; x < endX; x += 1) {
      const overlapX = Math.max(0, Math.min(right, x + 1) - Math.max(left, x));
      const weight = overlapX * overlapY;
      if (weight <= 0) continue;

      const pixelIndex = (y * width + x) * 4;
      totalR += pixels[pixelIndex] * weight;
      totalG += pixels[pixelIndex + 1] * weight;
      totalB += pixels[pixelIndex + 2] * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight <= 0) {
    return [0, 0, 0];
  }

  return [totalR / totalWeight / 255, totalG / totalWeight / 255, totalB / totalWeight / 255];
}

function bilinearSample(
  flatField: Float32Array,
  ffSize: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fx: number,
  fy: number,
  channel: 0 | 1 | 2,
) {
  const topLeft = flatField[(y0 * ffSize + x0) * 3 + channel];
  const topRight = flatField[(y0 * ffSize + x1) * 3 + channel];
  const bottomLeft = flatField[(y1 * ffSize + x0) * 3 + channel];
  const bottomRight = flatField[(y1 * ffSize + x1) * 3 + channel];

  const top = topLeft + (topRight - topLeft) * fx;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
  return top + (bottom - top) * fy;
}
