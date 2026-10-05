import { DustAutoDetectMode, DustMark, DustPathPoint, PathDustMark, SpotDustMark } from '../types';
import { clamp } from './math';

// Automatic dust and scratch detection on the converted positive.
//
// 1. Morphological top-hat on luminance. An opening (or closing) with a square
//    a little wider than the largest defect removes every bright (or dark)
//    structure that fits inside it and leaves edges, gradients and broad
//    shapes alone. What remains is small-scale contrast: dust, hairs,
//    scratches, grain and fine texture.
// 2. A local noise floor, measured per block as a robust percentile of that
//    residual, so grain and busy texture raise the bar where they live.
// 3. Hysteresis: strong pixels seed a component, weaker neighbours extend it,
//    so a defect is captured whole and faint stretches of a scratch stay
//    connected.
// 4. Each component is measured along its own geodesic axis (length, width,
//    centreline) and then judged on shape, isolation from similar texture,
//    and colour. Dust and hairs are opaque, so they push the colour towards
//    neutral; a lit window or a coloured detail does not.
//
// Dust on a negative blocks light, so it comes out bright in the positive;
// on a slide it stays dark. Spots are looked for with that polarity only.
// Scratches can go either way (base scratches scatter, emulsion scratches
// remove dye), so paths are looked for in both.

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const MAX_AUTO_SPOTS = 320;
const MAX_AUTO_PATHS = 40;
const MAX_PATH_POINTS = 64;
const MAX_COMPONENT_AREA = 40000;
const NOISE_HISTOGRAM_BINS = 96;
const NOISE_HISTOGRAM_RANGE = 0.5;

export type DustPolarity = 'bright' | 'dark';

export interface DustDetectOptions {
  // Polarity of dust specks in the analysed positive: 'bright' for negatives,
  // 'dark' for slides.
  polarity?: DustPolarity;
}

type Point = { x: number; y: number };

type ScoredMark = DustMark & { score: number };

type NoiseField = {
  blockSize: number;
  columns: number;
  rows: number;
  values: Float32Array;
};

type Component = {
  pixels: Int32Array;
  peak: number;
  totalSignal: number;
};

type ComponentShape = {
  centerline: Point[];
  widths: number[];
  length: number;
  width: number;
};

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

function downsampleImageData(imageData: ImageData) {
  const width = Math.max(1, Math.floor(imageData.width / 2));
  const height = Math.max(1, Math.floor(imageData.height / 2));
  const result = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let total = 0;
        for (let offsetY = 0; offsetY < 2; offsetY += 1) {
          for (let offsetX = 0; offsetX < 2; offsetX += 1) {
            const sourceX = Math.min(imageData.width - 1, x * 2 + offsetX);
            const sourceY = Math.min(imageData.height - 1, y * 2 + offsetY);
            total += imageData.data[(sourceY * imageData.width + sourceX) * 4 + channel];
          }
        }
        result[targetIndex + channel] = Math.round(total / 4);
      }
    }
  }

  return new ImageData(result, width, height);
}

// Running minimum over a square window of 2·radius+1, truncated at the image
// border. Each axis uses the van Herk/Gil-Werman scheme: per block of window
// length, a forward and a backward running minimum, so the cost does not
// depend on the radius. The vertical pass works on whole rows at a time to
// stay cache-friendly.
function squareMinimum(source: Float32Array, width: number, height: number, radius: number) {
  const windowSize = radius * 2 + 1;
  const forward = new Float32Array(source.length);
  const backward = new Float32Array(source.length);
  const horizontal = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let blockStart = 0; blockStart < width; blockStart += windowSize) {
      const blockEnd = Math.min(width, blockStart + windowSize) - 1;
      let running = source[row + blockStart];
      forward[row + blockStart] = running;
      for (let x = blockStart + 1; x <= blockEnd; x += 1) {
        const value = source[row + x];
        running = value < running ? value : running;
        forward[row + x] = running;
      }
      running = source[row + blockEnd];
      backward[row + blockEnd] = running;
      for (let x = blockEnd - 1; x >= blockStart; x -= 1) {
        const value = source[row + x];
        running = value < running ? value : running;
        backward[row + x] = running;
      }
    }
    for (let x = 0; x < width; x += 1) {
      const low = x - radius;
      const high = x + radius < width ? x + radius : width - 1;
      if (low <= 0) {
        horizontal[row + x] = forward[row + high];
      } else if (high - (high % windowSize) <= low) {
        horizontal[row + x] = backward[row + low];
      } else {
        const left = backward[row + low];
        const right = forward[row + high];
        horizontal[row + x] = left < right ? left : right;
      }
    }
  }

  for (let blockStart = 0; blockStart < height; blockStart += windowSize) {
    const blockEnd = Math.min(height, blockStart + windowSize) - 1;
    forward.set(horizontal.subarray(blockStart * width, blockStart * width + width), blockStart * width);
    for (let y = blockStart + 1; y <= blockEnd; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const value = horizontal[row + x];
        const previous = forward[row - width + x];
        forward[row + x] = value < previous ? value : previous;
      }
    }
    backward.set(horizontal.subarray(blockEnd * width, blockEnd * width + width), blockEnd * width);
    for (let y = blockEnd - 1; y >= blockStart; y -= 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const value = horizontal[row + x];
        const next = backward[row + width + x];
        backward[row + x] = value < next ? value : next;
      }
    }
  }

  const result = horizontal;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const low = y - radius;
    const high = y + radius < height ? y + radius : height - 1;
    if (low <= 0) {
      result.set(forward.subarray(high * width, high * width + width), row);
    } else if (high - (high % windowSize) <= low) {
      result.set(backward.subarray(low * width, low * width + width), row);
    } else {
      const lowRow = low * width;
      const highRow = high * width;
      for (let x = 0; x < width; x += 1) {
        const top = backward[lowRow + x];
        const bottom = forward[highRow + x];
        result[row + x] = top < bottom ? top : bottom;
      }
    }
  }

  return result;
}

function negate(values: Float32Array) {
  for (let index = 0; index < values.length; index += 1) {
    values[index] = -values[index];
  }
  return values;
}

// Erosion (min) or dilation (max, as the negated minimum of the negation).
function squareFilter(source: Float32Array, width: number, height: number, radius: number, useMax: boolean) {
  if (!useMax) {
    return squareMinimum(source, width, height, radius);
  }
  const negated = negate(Float32Array.from(source));
  return negate(squareMinimum(negated, width, height, radius));
}

// White top-hat (luminance minus its opening) for bright defects, black
// top-hat (closing minus luminance) for dark ones.
function computeTopHat(luminance: Float32Array, width: number, height: number, radius: number, polarity: DustPolarity) {
  const bright = polarity === 'bright';
  const first = squareFilter(luminance, width, height, radius, !bright);
  const reference = squareFilter(first, width, height, radius, bright);
  for (let index = 0; index < reference.length; index += 1) {
    reference[index] = bright
      ? Math.max(0, luminance[index] - reference[index])
      : Math.max(0, reference[index] - luminance[index]);
  }
  return reference;
}

// The 80th percentile of the top-hat residual in each block approximates the
// local grain/texture level while staying blind to the few defect pixels a
// block may hold. Blocks are smoothed with their neighbours so the floor does
// not jump at block seams.
function measureNoiseField(signal: Float32Array, width: number, height: number, blockSize: number): NoiseField {
  const columns = Math.max(1, Math.ceil(width / blockSize));
  const rows = Math.max(1, Math.ceil(height / blockSize));
  const raw = new Float32Array(columns * rows);
  const histogram = new Uint32Array(NOISE_HISTOGRAM_BINS);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      histogram.fill(0);
      const startX = column * blockSize;
      const startY = row * blockSize;
      const endX = Math.min(width, startX + blockSize);
      const endY = Math.min(height, startY + blockSize);
      let count = 0;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          // Square-root binning keeps resolution where grain lives (small values).
          const normalized = Math.min(1, signal[y * width + x] / NOISE_HISTOGRAM_RANGE);
          histogram[Math.min(NOISE_HISTOGRAM_BINS - 1, Math.floor(Math.sqrt(normalized) * NOISE_HISTOGRAM_BINS))] += 1;
          count += 1;
        }
      }
      const target = count * 0.8;
      let cumulative = 0;
      let bin = 0;
      for (; bin < NOISE_HISTOGRAM_BINS; bin += 1) {
        cumulative += histogram[bin];
        if (cumulative >= target) {
          break;
        }
      }
      const upper = (bin + 1) / NOISE_HISTOGRAM_BINS;
      raw[row * columns + column] = upper * upper * NOISE_HISTOGRAM_RANGE;
    }
  }

  const values = new Float32Array(raw.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let total = 0;
      let weight = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighbourRow = row + offsetY;
          const neighbourColumn = column + offsetX;
          if (neighbourRow < 0 || neighbourColumn < 0 || neighbourRow >= rows || neighbourColumn >= columns) {
            continue;
          }
          const sampleWeight = offsetX === 0 && offsetY === 0 ? 2 : 1;
          total += raw[neighbourRow * columns + neighbourColumn] * sampleWeight;
          weight += sampleWeight;
        }
      }
      // Never let smoothing pull a busy block below its own level by much.
      values[row * columns + column] = Math.max(total / weight, raw[row * columns + column] * 0.8);
    }
  }

  return { blockSize, columns, rows, values };
}

function sampleNoise(field: NoiseField, x: number, y: number) {
  const gx = clamp(x / field.blockSize - 0.5, 0, field.columns - 1);
  const gy = clamp(y / field.blockSize - 0.5, 0, field.rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(field.columns - 1, x0 + 1);
  const y1 = Math.min(field.rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const top = field.values[y0 * field.columns + x0] * (1 - fx) + field.values[y0 * field.columns + x1] * fx;
  const bottom = field.values[y1 * field.columns + x0] * (1 - fx) + field.values[y1 * field.columns + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

// 2 = above the strong threshold, 1 = above the weak one.
function buildHysteresisMask(
  signal: Float32Array,
  noise: NoiseField,
  width: number,
  height: number,
  highFactor: number,
  lowFactor: number,
  highFloor: number,
  lowFloor: number,
) {
  const mask = new Uint8Array(signal.length);
  const rowLevels = new Float32Array(noise.columns);
  for (let y = 0; y < height; y += 1) {
    // Interpolate the block grid down to this row once, then along it.
    const gy = clamp(y / noise.blockSize - 0.5, 0, noise.rows - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(noise.rows - 1, y0 + 1);
    const fy = gy - y0;
    for (let column = 0; column < noise.columns; column += 1) {
      rowLevels[column] = noise.values[y0 * noise.columns + column] * (1 - fy)
        + noise.values[y1 * noise.columns + column] * fy;
    }
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = signal[index];
      if (value <= lowFloor) {
        continue;
      }
      const gx = clamp(x / noise.blockSize - 0.5, 0, noise.columns - 1);
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const level = rowLevels[x0] * (1 - fx) + rowLevels[Math.min(noise.columns - 1, x0 + 1)] * fx;
      if (value > Math.max(highFloor, level * highFactor)) {
        mask[index] = 2;
      } else if (value > Math.max(lowFloor, level * lowFactor)) {
        mask[index] = 1;
      }
    }
  }
  return mask;
}

function collectComponents(mask: Uint8Array, signal: Float32Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 2 || visited[start]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let peak = 0;
    let totalSignal = 0;

    while (head < tail) {
      const current = queue[head++];
      const value = signal[current];
      peak = Math.max(peak, value);
      totalSignal += value;
      const x = current % width;
      const y = (current - x) / width;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= height) {
          continue;
        }
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX;
          if (nextX < 0 || nextX >= width) {
            continue;
          }
          const next = nextY * width + nextX;
          if (visited[next] || mask[next] === 0) {
            continue;
          }
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }

    // Components that sprawl past any plausible defect are texture or image
    // structure; they are dropped before the costlier measurements.
    if (tail > MAX_COMPONENT_AREA) {
      continue;
    }
    components.push({ pixels: queue.slice(0, tail), peak, totalSignal });
  }

  return components;
}

// Breadth-first distances inside one component, from `origin`.
function geodesicDistances(
  pixels: Int32Array,
  lookup: Map<number, number>,
  width: number,
  origin: number,
) {
  const distances = new Int32Array(pixels.length).fill(-1);
  const parents = new Int32Array(pixels.length).fill(-1);
  const queue = new Int32Array(pixels.length);
  let head = 0;
  let tail = 0;
  distances[origin] = 0;
  queue[tail++] = origin;
  let farthest = origin;

  while (head < tail) {
    const current = queue[head++];
    if (distances[current] > distances[farthest]) {
      farthest = current;
    }
    const pixel = pixels[current];
    const x = pixel % width;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }
        const nextX = x + offsetX;
        if (nextX < 0 || nextX >= width) {
          continue;
        }
        const neighbour = lookup.get(pixel + offsetY * width + offsetX);
        if (neighbour === undefined || distances[neighbour] !== -1) {
          continue;
        }
        distances[neighbour] = distances[current] + 1;
        parents[neighbour] = current;
        queue[tail++] = neighbour;
      }
    }
  }

  return { distances, parents, farthest };
}

// Length, width and centreline of a component, measured along its longest
// internal path, so curved hairs and diagonal scratches measure as well as
// straight horizontal ones.
function measureShape(pixels: Int32Array, width: number): ComponentShape {
  if (pixels.length === 1) {
    const x = pixels[0] % width;
    const y = (pixels[0] - x) / width;
    return { centerline: [{ x, y }], widths: [1], length: 1, width: 1 };
  }

  const lookup = new Map<number, number>();
  for (let index = 0; index < pixels.length; index += 1) {
    lookup.set(pixels[index], index);
  }

  const firstPass = geodesicDistances(pixels, lookup, width, 0);
  const { distances, parents, farthest } = geodesicDistances(pixels, lookup, width, firstPass.farthest);
  const maxDistance = distances[farthest];

  // Euclidean length of the longest internal path.
  let pathLength = 0;
  for (let current = farthest; parents[current] !== -1; current = parents[current]) {
    const pixel = pixels[current];
    const parent = pixels[parents[current]];
    const dx = (pixel % width) - (parent % width);
    const dy = Math.floor(pixel / width) - Math.floor(parent / width);
    pathLength += Math.hypot(dx, dy);
  }
  const length = Math.max(1, pathLength + 1);
  const componentWidth = pixels.length / length;
  const stepLength = maxDistance > 0 ? pathLength / maxDistance : 1;

  const binSize = Math.max(2, Math.round(componentWidth * 1.5));
  const binCount = Math.floor(maxDistance / binSize) + 1;
  const sumX = new Float64Array(binCount);
  const sumY = new Float64Array(binCount);
  const counts = new Uint32Array(binCount);
  for (let index = 0; index < pixels.length; index += 1) {
    const distance = distances[index];
    if (distance < 0) {
      continue;
    }
    const bin = Math.min(binCount - 1, Math.floor(distance / binSize));
    const x = pixels[index] % width;
    sumX[bin] += x;
    sumY[bin] += (pixels[index] - x) / width;
    counts[bin] += 1;
  }

  const centerline: Point[] = [];
  const widths: number[] = [];
  for (let bin = 0; bin < binCount; bin += 1) {
    if (counts[bin] === 0) {
      continue;
    }
    centerline.push({ x: sumX[bin] / counts[bin], y: sumY[bin] / counts[bin] });
    const binSpan = Math.max(1, Math.min(binSize, maxDistance + 1 - bin * binSize)) * stepLength;
    widths.push(counts[bin] / binSpan);
  }

  // Run top-left to bottom-right, whichever end the search started from.
  const first = centerline[0];
  const last = centerline[centerline.length - 1];
  if (first.x + first.y > last.x + last.y) {
    centerline.reverse();
    widths.reverse();
  }

  return { centerline, widths, length, width: componentWidth };
}

// Largest distance of the centreline from the chord joining its ends.
function measureBend(centerline: Point[]) {
  const start = centerline[0];
  const end = centerline[centerline.length - 1];
  let bend = 0;
  for (const point of centerline) {
    bend = Math.max(bend, distancePointToSegment(point.x, point.y, start.x, start.y, end.x, end.y));
  }
  return bend;
}

function readColor(data: Uint8ClampedArray, pixel: number): [number, number, number] {
  const offset = pixel * 4;
  return [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
}

function chroma(color: [number, number, number]) {
  return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
}

function quantile(values: number[], amount: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))];
}

function median(values: number[]) {
  return quantile(values, 0.5);
}

type Surroundings = {
  background: [number, number, number];
  busyRatio: number;
  // Interquartile range of the ring's luminance.
  spread: number;
};

// Samples a ring (or, for paths, both sides of the centreline) just outside
// the component: its median colour is the background the defect sits on, and
// the share of ring pixels that are themselves above the weak threshold says
// whether the component is one grain of a busy texture.
function sampleSurroundings(
  data: Uint8ClampedArray,
  activity: Uint8Array,
  width: number,
  height: number,
  samplePoints: Point[],
): Surroundings {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const lumas: number[] = [];
  let busy = 0;
  for (const point of samplePoints) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }
    const pixel = y * width + x;
    const [red, green, blue] = readColor(data, pixel);
    reds.push(red);
    greens.push(green);
    blues.push(blue);
    lumas.push(red * LUMA_R + green * LUMA_G + blue * LUMA_B);
    if (activity[pixel] !== 0) {
      busy += 1;
    }
  }
  return {
    background: [median(reds), median(greens), median(blues)],
    busyRatio: reds.length > 0 ? busy / reds.length : 1,
    spread: quantile(lumas, 0.75) - quantile(lumas, 0.25),
  };
}

function ringPoints(cx: number, cy: number, radii: number[]) {
  const points: Point[] = [];
  for (const radius of radii) {
    const count = Math.max(12, Math.round(radius * 4));
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
  }
  return points;
}

function sidePoints(centerline: Point[], offsets: number[]) {
  const points: Point[] = [];
  for (let index = 0; index < centerline.length; index += 1) {
    const previous = centerline[Math.max(0, index - 1)];
    const next = centerline[Math.min(centerline.length - 1, index + 1)];
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    for (const offset of offsets) {
      points.push({ x: centerline[index].x + normalX * offset, y: centerline[index].y + normalY * offset });
      points.push({ x: centerline[index].x - normalX * offset, y: centerline[index].y - normalY * offset });
    }
  }
  return points;
}

function meanColor(data: Uint8ClampedArray, pixels: Int32Array, signal: Float32Array, peak: number) {
  // Only the core of the component: its faint rim is mostly background.
  const total: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (signal[pixels[index]] < peak * 0.5) {
      continue;
    }
    const color = readColor(data, pixels[index]);
    total[0] += color[0];
    total[1] += color[1];
    total[2] += color[2];
    count += 1;
  }
  return total.map((value) => value / Math.max(1, count)) as [number, number, number];
}

// Opaque dust and hair pull the colour towards white (or black); a coloured
// feature such as a lit window adds chroma of its own.
function addsChroma(
  core: [number, number, number],
  background: [number, number, number],
  tolerance: number,
) {
  return chroma(core) > chroma(background) + tolerance;
}

function toNormalizedPoint(point: Point, width: number, height: number): DustPathPoint {
  return {
    x: clamp((point.x + 0.5) / width, 0, 1),
    y: clamp((point.y + 0.5) / height, 0, 1),
  };
}

function limitPathPoints(points: DustPathPoint[], widths: number[]) {
  if (points.length <= MAX_PATH_POINTS) {
    return { points, widths };
  }
  const step = (points.length - 1) / (MAX_PATH_POINTS - 1);
  const keptPoints: DustPathPoint[] = [];
  const keptWidths: number[] = [];
  for (let index = 0; index < MAX_PATH_POINTS; index += 1) {
    const source = Math.round(index * step);
    keptPoints.push(points[source]);
    keptWidths.push(widths[source]);
  }
  return { points: keptPoints, widths: keptWidths };
}

type DetectionContext = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  scale: number;
  maxRadius: number;
  sensitivity: number;
  canEmitSpots: boolean;
  canEmitPaths: boolean;
};

function classifyComponent(
  context: DetectionContext,
  component: Component,
  signal: Float32Array,
  activity: Uint8Array,
  noise: NoiseField,
  allowSpots: boolean,
): ScoredMark | null {
  const { data, width, height, scale, maxRadius, sensitivity } = context;
  const { pixels, peak } = component;
  const area = pixels.length;
  const shape = measureShape(pixels, width);
  const elongation = shape.length / Math.max(shape.width, 1);
  const diagonal = Math.hypot(width * scale, height * scale);

  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < area; index += 1) {
    const pixel = pixels[index];
    const x = pixel % width;
    const value = signal[pixel];
    weightedX += x * value;
    weightedY += ((pixel - x) / width) * value;
  }
  const cx = weightedX / component.totalSignal;
  const cy = weightedY / component.totalSignal;
  const level = Math.max(1e-4, sampleNoise(noise, cx, cy));
  const contrast = component.totalSignal / area;
  const snr = peak / level;
  const core = meanColor(data, pixels, signal, peak);

  const maxSpotLength = maxRadius * 2.5 + 2;
  const isSpotShaped = shape.length <= maxSpotLength && (elongation < 4.5 || shape.length < maxRadius * 1.5);
  if (isSpotShaped) {
    if (!allowSpots || !context.canEmitSpots) {
      return null;
    }
    // Dust is opaque or close to it, so its profile has a flat top. A
    // lens-soft highlight peaks and falls away like a bell.
    let coreCount = 0;
    let topCount = 0;
    let extentCount = 0;
    for (let index = 0; index < area; index += 1) {
      const value = signal[pixels[index]];
      extentCount += value >= peak * 0.25 ? 1 : 0;
      coreCount += value >= peak * 0.5 ? 1 : 0;
      topCount += value >= peak * 0.8 ? 1 : 0;
    }
    // A lone pixel needs to stand far above the grain; a broad plateau of
    // many pixels is convincing at a lower contrast.
    const sizeFactor = clamp((4 / coreCount) ** 0.25, 0.65, 1.6);
    const minSnr = lerp(4, 2.6, sensitivity) * sizeFactor;
    if (snr < minSnr) {
      return null;
    }
    if (coreCount >= 7 && topCount / coreCount < lerp(0.45, 0.3, sensitivity)) {
      return null;
    }
    const defectRadius = Math.max(0.5, Math.sqrt(extentCount / Math.PI), shape.length * 0.375);
    const surroundings = sampleSurroundings(
      data,
      activity,
      width,
      height,
      ringPoints(cx, cy, [defectRadius + 2, defectRadius + 3.5, defectRadius * 2 + 5]),
    );
    if (surroundings.busyRatio > lerp(0.12, 0.3, sensitivity)) {
      return null;
    }
    if (surroundings.spread > peak * lerp(0.3, 0.45, sensitivity)) {
      return null;
    }
    if (addsChroma(core, surroundings.background, lerp(0.05, 0.12, sensitivity))) {
      return null;
    }

    const radiusPx = clamp(defectRadius * 1.6 + 1, 1.5, maxRadius * 1.6) * scale;
    return {
      id: `dust-auto-${crypto.randomUUID()}`,
      kind: 'spot',
      cx: clamp((cx + 0.5) / width, 0, 1),
      cy: clamp((cy + 0.5) / height, 0, 1),
      radius: clamp(radiusPx / diagonal, 0, 1),
      source: 'auto',
      score: (contrast / level) * Math.sqrt(area),
    } satisfies SpotDustMark & { score: number };
  }

  if (!context.canEmitPaths) {
    return null;
  }
  const maxPathWidth = Math.max(2.6, maxRadius * 0.9);
  if (
    elongation < 4.5
    || shape.length < Math.max(12, maxRadius * 2.5)
    || shape.width > maxPathWidth
    || shape.centerline.length < 2
  ) {
    return null;
  }
  // Scratches are judged on their mean, not their peak: a run of grain
  // touching end to end has the odd strong pixel but a weak average.
  const lengthRelief = clamp(Math.sqrt(24 / shape.length), 0.6, 1);
  if (contrast / level < lerp(3.6, 2.2, sensitivity) * lengthRelief) {
    return null;
  }

  const sideOffset = shape.width / 2 + 3;
  const surroundings = sampleSurroundings(
    data,
    activity,
    width,
    height,
    sidePoints(shape.centerline, [sideOffset, sideOffset + 2]),
  );
  if (surroundings.busyRatio > lerp(0.3, 0.45, sensitivity)) {
    return null;
  }
  // Emulsion scratches can take on colour, so paths get more slack.
  if (addsChroma(core, surroundings.background, lerp(0.12, 0.22, sensitivity))) {
    return null;
  }

  // Hairs come out with the dust's polarity. A line of the other polarity
  // is only taken when it is straight, as transport scratches are; that keeps
  // branches and wires in the picture.
  if (!allowSpots && measureBend(shape.centerline) > Math.max(1.5, shape.length * 0.02)) {
    return null;
  }

  // Lines hugging the frame edge are usually the film holder or rebate.
  const borderMargin = Math.max(3, Math.min(width, height) * 0.012);
  const nearBorder = shape.centerline.filter((point) => (
    point.x < borderMargin
    || point.y < borderMargin
    || point.x > width - 1 - borderMargin
    || point.y > height - 1 - borderMargin
  )).length;
  if (nearBorder / shape.centerline.length > 0.5) {
    return null;
  }

  const { points, widths } = limitPathPoints(
    shape.centerline.map((point) => toNormalizedPoint(point, width, height)),
    shape.widths,
  );
  const radiusPx = clamp(shape.width * 0.75 + 0.75, 1.2, maxRadius) * scale;
  return {
    id: `dust-auto-${crypto.randomUUID()}`,
    kind: 'path',
    points,
    radius: clamp(radiusPx / diagonal, 0, 1),
    widthAlongPath: widths.map((value) => (value * scale) / diagonal),
    source: 'auto',
    score: (contrast / level) * Math.sqrt(area) * 1.5,
  } satisfies PathDustMark & { score: number };
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
  return Math.hypot(pointX - (startX + dx * t), pointY - (startY + dy * t));
}

function distancePointToPath(pointX: number, pointY: number, mark: PathDustMark) {
  let bestDistance = Infinity;
  for (let index = 1; index < mark.points.length; index += 1) {
    bestDistance = Math.min(bestDistance, distancePointToSegment(
      pointX,
      pointY,
      mark.points[index - 1].x,
      mark.points[index - 1].y,
      mark.points[index].x,
      mark.points[index].y,
    ));
  }
  return bestDistance;
}

// Marks are compared in a square space so radii (normalised by the diagonal)
// and positions (normalised per axis) can be compared directly.
function dedupeMarks(marks: ScoredMark[], aspect: { x: number; y: number }) {
  const deduped: ScoredMark[] = [];
  const sorted = [...marks].sort((left, right) => right.score - left.score);
  let spotCount = 0;
  let pathCount = 0;
  const toSquare = (x: number, y: number) => ({ x: x * aspect.x, y: y * aspect.y });

  for (const mark of sorted) {
    if (mark.kind === 'path' ? pathCount >= MAX_AUTO_PATHS : spotCount >= MAX_AUTO_SPOTS) {
      continue;
    }

    const isDuplicate = deduped.some((existing) => {
      if (mark.kind === 'spot' && existing.kind === 'spot') {
        const a = toSquare(mark.cx, mark.cy);
        const b = toSquare(existing.cx, existing.cy);
        return Math.hypot(a.x - b.x, a.y - b.y) < Math.max(existing.radius, mark.radius) * 0.8;
      }
      const spot = mark.kind === 'spot' ? mark : existing.kind === 'spot' ? existing : null;
      const path = mark.kind === 'path' ? mark : existing.kind === 'path' ? existing : null;
      if (spot && path) {
        const squarePath = { ...path, points: path.points.map((point) => toSquare(point.x, point.y)) };
        const center = toSquare(spot.cx, spot.cy);
        return distancePointToPath(center.x, center.y, squarePath) < Math.max(path.radius, spot.radius) * 0.9;
      }
      return false;
    });

    if (isDuplicate) {
      continue;
    }

    deduped.push(mark);
    if (mark.kind === 'path') {
      pathCount += 1;
    } else {
      spotCount += 1;
    }
  }

  return deduped.map(({ score: _score, ...mark }) => mark);
}

type PolarityStage = {
  polarity: DustPolarity;
  signal: Float32Array;
  noise: NoiseField;
  mask: Uint8Array;
};

function buildPolarityStage(context: DetectionContext, luminance: Float32Array, polarity: DustPolarity): PolarityStage {
  const { width, height, maxRadius, sensitivity } = context;
  const radius = Math.ceil(maxRadius) + 1;
  const signal = computeTopHat(luminance, width, height, radius, polarity);
  const noise = measureNoiseField(signal, width, height, Math.max(16, radius * 4));
  const highFactor = lerp(3.2, 2.6, sensitivity);
  const mask = buildHysteresisMask(
    signal,
    noise,
    width,
    height,
    highFactor,
    highFactor * 0.5,
    lerp(0.05, 0.025, sensitivity),
    lerp(0.025, 0.012, sensitivity),
  );
  return { polarity, signal, noise, mask };
}

function detectDustMarksAtScale(
  imageData: ImageData,
  sensitivity: number,
  maxRadius: number,
  scale: number,
  mode: DustAutoDetectMode,
  polarity: DustPolarity,
) {
  const { width, height, data } = imageData;
  const context: DetectionContext = {
    data,
    width,
    height,
    scale,
    maxRadius,
    sensitivity: clamp(sensitivity, 0, 100) / 100,
    canEmitSpots: mode === 'spots' || mode === 'both',
    canEmitPaths: mode === 'scratches' || mode === 'both',
  };
  const luminance = computeLuminance(data, width, height);
  const stages = [
    buildPolarityStage(context, luminance, polarity),
    buildPolarityStage(context, luminance, polarity === 'bright' ? 'dark' : 'bright'),
  ];
  // Small structure of either polarity counts as surrounding texture: the
  // dark gaps between lit windows sit in a field of bright ones.
  const activity = new Uint8Array(luminance.length);
  for (let index = 0; index < activity.length; index += 1) {
    activity[index] = stages[0].mask[index] | stages[1].mask[index];
  }

  const marks: ScoredMark[] = [];
  for (const stage of stages) {
    const isDefectPolarity = stage.polarity === polarity;
    if (!isDefectPolarity && !context.canEmitPaths) {
      continue;
    }
    for (const component of collectComponents(stage.mask, stage.signal, width, height)) {
      const mark = classifyComponent(context, component, stage.signal, activity, stage.noise, isDefectPolarity);
      if (mark) {
        marks.push(mark);
      }
    }
  }

  const diagonal = Math.hypot(width, height);
  return dedupeMarks(marks, { x: width / diagonal, y: height / diagonal });
}

export function detectDustMarks(
  imageData: ImageData,
  sensitivity: number,
  maxRadius: number,
  mode: DustAutoDetectMode = 'both',
  options: DustDetectOptions = {},
): DustMark[] {
  const polarity = options.polarity ?? 'bright';
  const megapixels = (imageData.width * imageData.height) / 1_000_000;
  if (megapixels > 10 && imageData.width >= 2 && imageData.height >= 2) {
    const downsampled = downsampleImageData(imageData);
    return detectDustMarksAtScale(downsampled, sensitivity, Math.max(1, maxRadius / 2), 2, mode, polarity);
  }

  return detectDustMarksAtScale(imageData, sensitivity, maxRadius, 1, mode, polarity);
}
