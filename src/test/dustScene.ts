import type { DustMark } from '../types';

// Synthetic "scanned positive" with known dust and scratches, used to measure
// the auto-detector's precision and recall. The scene carries the things that
// fool a naive detector on real scans: film grain, busy foliage-like texture,
// hard edges, lit windows, blurred specular highlights and thin dark branches.

export type DustSceneSpot = { kind: 'spot'; x: number; y: number; radius: number };
export type DustSceneLine = { kind: 'line'; points: Array<{ x: number; y: number }>; width: number };
export type DustSceneDefect = DustSceneSpot | DustSceneLine;

export interface DustScene {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  defects: DustSceneDefect[];
}

export interface DustSceneOptions {
  width?: number;
  height?: number;
  seed?: number;
  spotCount?: number;
  grain?: number;
  // 'bright' puts dust on as a positive from a negative shows it (white);
  // 'dark' as a slide shows it.
  polarity?: 'bright' | 'dark';
}

function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number) {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function blurChannel(channel: Float32Array, width: number, height: number, passes: number) {
  const temp = new Float32Array(channel.length);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const left = channel[y * width + Math.max(0, x - 1)];
        const right = channel[y * width + Math.min(width - 1, x + 1)];
        temp[y * width + x] = (left + 2 * channel[y * width + x] + right) / 4;
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const top = temp[Math.max(0, y - 1) * width + x];
        const bottom = temp[Math.min(height - 1, y + 1) * width + x];
        channel[y * width + x] = (top + 2 * temp[y * width + x] + bottom) / 4;
      }
    }
  }
}

function createValueNoise(random: () => number, cells: number) {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let index = 0; index < grid.length; index += 1) {
    grid[index] = random();
  }
  return (u: number, v: number) => {
    const gx = u * cells;
    const gy = v * cells;
    const x0 = Math.min(cells - 1, Math.floor(gx));
    const y0 = Math.min(cells - 1, Math.floor(gy));
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const at = (x: number, y: number) => grid[y * (cells + 1) + x];
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}

function drawPolyline(
  target: Float32Array,
  width: number,
  height: number,
  points: Array<{ x: number; y: number }>,
  lineWidth: number,
  opacity: number,
) {
  const half = lineWidth / 2;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const minX = Math.max(0, Math.floor(Math.min(start.x, end.x) - half - 1));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(start.x, end.x) + half + 1));
    const minY = Math.max(0, Math.floor(Math.min(start.y, end.y) - half - 1));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(start.y, end.y) + half + 1));
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared));
        const distance = Math.hypot(x - (start.x + dx * t), y - (start.y + dy * t));
        const coverage = Math.max(0, Math.min(1, half + 0.5 - distance)) * opacity;
        const index2 = y * width + x;
        target[index2] = Math.max(target[index2], coverage);
      }
    }
  }
}

export function createDustScene(options: DustSceneOptions = {}): DustScene {
  const width = options.width ?? 960;
  const height = options.height ?? 640;
  const random = createRandom(options.seed ?? 1);
  const polarity = options.polarity ?? 'bright';
  const grain = options.grain ?? 0.022;
  const size = width * height;
  const red = new Float32Array(size);
  const green = new Float32Array(size);
  const blue = new Float32Array(size);
  const coarse = createValueNoise(random, 5);
  const foliage = createValueNoise(random, Math.round(width / 6));
  const foliageFine = createValueNoise(random, Math.round(width / 2.5));
  const horizon = height * 0.62;

  // Sky gradient, ground with foliage-like texture.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const u = x / width;
      const v = y / height;
      const tone = coarse(u, v) * 0.18;
      if (y < horizon) {
        const t = y / horizon;
        red[index] = 0.42 + t * 0.25 + tone;
        green[index] = 0.55 + t * 0.2 + tone;
        blue[index] = 0.78 + t * 0.08 + tone * 0.5;
      } else {
        const leaf = foliage(u, v) * 0.6 + foliageFine(u, v) * 0.4;
        const shade = 0.12 + leaf * 0.38 + tone;
        red[index] = shade * 0.7;
        green[index] = shade * 1.05;
        blue[index] = shade * 0.45;
      }
    }
  }

  // Buildings: hard edges and grids of small lit windows.
  for (let building = 0; building < 3; building += 1) {
    const left = Math.round(width * (0.08 + building * 0.3));
    const right = left + Math.round(width * 0.14);
    const top = Math.round(height * (0.3 + random() * 0.12));
    const bottom = Math.round(horizon + height * 0.06);
    const wall = 0.22 + random() * 0.3;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = y * width + x;
        red[index] = wall * 1.05;
        green[index] = wall;
        blue[index] = wall * 0.92;
      }
    }
    for (let y = top + 6; y < bottom - 8; y += 12) {
      for (let x = left + 5; x < right - 6; x += 9) {
        if (random() < 0.45) {
          continue;
        }
        for (let wy = 0; wy < 5; wy += 1) {
          for (let wx = 0; wx < 4; wx += 1) {
            const index = (y + wy) * width + x + wx;
            red[index] = 0.92;
            green[index] = 0.82;
            blue[index] = 0.55;
          }
        }
      }
    }
  }

  // Thin dark branches over the foliage and the sky edge: real image lines.
  const branches = new Float32Array(size);
  for (let branch = 0; branch < 6; branch += 1) {
    const points: Array<{ x: number; y: number }> = [];
    let x = width * random();
    let y = horizon - height * 0.05 + random() * height * 0.3;
    let angle = -Math.PI / 2 + (random() - 0.5) * 1.4;
    for (let step = 0; step < 14; step += 1) {
      points.push({ x, y });
      x += Math.cos(angle) * 9;
      y += Math.sin(angle) * 9;
      angle += (random() - 0.5) * 0.5;
    }
    drawPolyline(branches, width, height, points, 1.4 + random(), 0.85);
  }
  for (let index = 0; index < size; index += 1) {
    const amount = branches[index];
    red[index] = red[index] * (1 - amount) + 0.05 * amount;
    green[index] = green[index] * (1 - amount) + 0.06 * amount;
    blue[index] = blue[index] * (1 - amount) + 0.04 * amount;
  }

  // Specular highlights in the foliage: small, bright, but lens-soft.
  for (let highlight = 0; highlight < 10; highlight += 1) {
    const cx = width * (0.05 + random() * 0.9);
    const cy = horizon + random() * (height - horizon - 4);
    const sigma = 1.1 + random() * 1.2;
    for (let y = Math.floor(cy - 6); y <= cy + 6; y += 1) {
      for (let x = Math.floor(cx - 6); x <= cx + 6; x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const amount = 0.7 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
        const index = y * width + x;
        red[index] += amount;
        green[index] += amount;
        blue[index] += amount * 0.9;
      }
    }
  }

  // Lens softness, then grain.
  blurChannel(red, width, height, 1);
  blurChannel(green, width, height, 1);
  blurChannel(blue, width, height, 1);

  const grainLuma = new Float32Array(size);
  const grainChroma = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    grainLuma[index] = gaussian(random);
    grainChroma[index] = gaussian(random);
  }
  blurChannel(grainLuma, width, height, 1);
  blurChannel(grainChroma, width, height, 1);
  for (let index = 0; index < size; index += 1) {
    const luma = grainLuma[index] * grain * 2;
    const chroma = grainChroma[index] * grain;
    red[index] += luma + chroma;
    green[index] += luma;
    blue[index] += luma - chroma;
  }

  // Defects sit on the film plane: sharp, unaffected by the lens blur.
  const defects: DustSceneDefect[] = [];
  const defectLayer = new Float32Array(size);
  const spotCount = options.spotCount ?? 36;
  for (let spot = 0; spot < spotCount; spot += 1) {
    const cx = 8 + random() * (width - 16);
    const cy = 8 + random() * (height - 16);
    const radius = 0.7 + random() ** 1.6 * 3.2;
    const aspect = 1 + random() * 0.8;
    const angle = random() * Math.PI;
    const opacity = 0.45 + random() * 0.55;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = Math.ceil(radius * aspect + 2);
    for (let y = Math.floor(cy - reach); y <= cy + reach; y += 1) {
      for (let x = Math.floor(cx - reach); x <= cx + reach; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const along = (dx * cos + dy * sin) / aspect;
        const across = -dx * sin + dy * cos;
        const distance = Math.hypot(along, across);
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance)) * opacity;
        const index = y * width + x;
        defectLayer[index] = Math.max(defectLayer[index], coverage);
      }
    }
    defects.push({ kind: 'spot', x: cx, y: cy, radius: radius * aspect });
  }

  const addLine = (points: Array<{ x: number; y: number }>, lineWidth: number, opacity: number) => {
    drawPolyline(defectLayer, width, height, points, lineWidth, opacity);
    defects.push({ kind: 'line', points, width: lineWidth });
  };

  // Curved hairs.
  for (let hair = 0; hair < 3; hair += 1) {
    const points: Array<{ x: number; y: number }> = [];
    let x = width * (0.15 + random() * 0.7);
    let y = height * (0.15 + random() * 0.7);
    let angle = random() * Math.PI * 2;
    const steps = 10 + Math.round(random() * 14);
    for (let step = 0; step < steps; step += 1) {
      points.push({ x, y });
      x = Math.max(4, Math.min(width - 5, x + Math.cos(angle) * 7));
      y = Math.max(4, Math.min(height - 5, y + Math.sin(angle) * 7));
      angle += (random() - 0.5) * 0.7;
    }
    addLine(points, 1.2 + random() * 0.8, 0.75 + random() * 0.25);
  }

  // Straight scratches, including a diagonal one.
  for (const angle of [0.08, Math.PI / 4 + 0.1, Math.PI / 2 - 0.05]) {
    const length = Math.min(width, height) * (0.25 + random() * 0.3);
    const cx = width * (0.25 + random() * 0.5);
    const cy = height * (0.25 + random() * 0.5);
    const dx = Math.cos(angle) * length / 2;
    const dy = Math.sin(angle) * length / 2;
    addLine([{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }], 1, 0.55 + random() * 0.35);
  }

  const data = new Uint8ClampedArray(size * 4);
  const target = polarity === 'bright' ? 1 : 0.02;
  for (let index = 0; index < size; index += 1) {
    const amount = defectLayer[index];
    data[index * 4] = Math.round((red[index] * (1 - amount) + target * amount) * 255);
    data[index * 4 + 1] = Math.round((green[index] * (1 - amount) + target * amount) * 255);
    data[index * 4 + 2] = Math.round((blue[index] * (1 - amount) + target * amount) * 255);
    data[index * 4 + 3] = 255;
  }

  return { width, height, data, defects };
}

function distanceToPolyline(points: Array<{ x: number; y: number }>, x: number, y: number) {
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(x - (start.x + dx * t), y - (start.y + dy * t)));
  }
  return best;
}

function distanceToDefect(defect: DustSceneDefect, x: number, y: number) {
  if (defect.kind === 'spot') {
    return Math.max(0, Math.hypot(x - defect.x, y - defect.y) - defect.radius);
  }
  return Math.max(0, distanceToPolyline(defect.points, x, y) - defect.width / 2);
}

function markCovers(mark: DustMark, width: number, height: number, x: number, y: number) {
  const radius = mark.radius * Math.hypot(width, height) + 1;
  if (mark.kind === 'spot') {
    return Math.hypot(x - mark.cx * width, y - mark.cy * height) <= radius;
  }
  return distanceToPolyline(mark.points.map((point) => ({ x: point.x * width, y: point.y * height })), x, y) <= radius;
}

function samplePolyline(points: Array<{ x: number; y: number }>, spacing: number) {
  const samples: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / spacing));
    for (let step = 0; step < steps; step += 1) {
      samples.push({ x: start.x + (end.x - start.x) * (step / steps), y: start.y + (end.y - start.y) * (step / steps) });
    }
  }
  samples.push(points[points.length - 1]);
  return samples;
}

export interface DustSceneScore {
  marks: number;
  truePositives: number;
  precision: number;
  spotRecall: number;
  lineRecall: number;
}

// A mark is correct when it sits on a defect; a spot is found when a mark covers
// its centre; a line is found when marks cover 60% of its length.
export function scoreDustScene(scene: DustScene, marks: DustMark[]): DustSceneScore {
  const { width, height, defects } = scene;
  let truePositives = 0;
  for (const mark of marks) {
    const tolerance = 1.5;
    if (mark.kind === 'spot') {
      const x = mark.cx * width;
      const y = mark.cy * height;
      if (defects.some((defect) => distanceToDefect(defect, x, y) <= tolerance + mark.radius * Math.hypot(width, height) * 0.5)) {
        truePositives += 1;
      }
    } else {
      const points = mark.points.map((point) => ({ x: point.x * width, y: point.y * height }));
      const samples = samplePolyline(points, 2);
      const onDefect = samples.filter((sample) => defects.some((defect) => distanceToDefect(defect, sample.x, sample.y) <= tolerance + 1)).length;
      if (onDefect / samples.length >= 0.5) {
        truePositives += 1;
      }
    }
  }

  const spots = defects.filter((defect): defect is DustSceneSpot => defect.kind === 'spot');
  const lines = defects.filter((defect): defect is DustSceneLine => defect.kind === 'line');
  const foundSpots = spots.filter((spot) => marks.some((mark) => markCovers(mark, width, height, spot.x, spot.y))).length;
  const foundLines = lines.filter((line) => {
    const samples = samplePolyline(line.points, 2);
    const covered = samples.filter((sample) => marks.some((mark) => markCovers(mark, width, height, sample.x, sample.y))).length;
    return covered / samples.length >= 0.6;
  }).length;

  return {
    marks: marks.length,
    truePositives,
    precision: marks.length === 0 ? 1 : truePositives / marks.length,
    spotRecall: spots.length === 0 ? 1 : foundSpots / spots.length,
    lineRecall: lines.length === 0 ? 1 : foundLines / lines.length,
  };
}
