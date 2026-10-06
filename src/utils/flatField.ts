import { getImageKernels } from './imageKernels';

// Flat-field correction for camera scans. A frame of the bare light source,
// shot with the same camera, lens and light as the roll, records how much
// light reaches each part of the sensor (lens vignetting, an uneven panel).
// Dividing every scan by that map, in linear light and before any analysis,
// removes the falloff. Without it the density inversion reads the falloff as
// film density: a dim corner prints too bright, and a colour-uneven panel
// prints as a colour cast that changes across the frame. The map is
// normalized to its centre, so the frame centre keeps its exposure and colour.

const GRID_LONG_SIDE = 64;
const SAMPLES_PER_CELL = 400;
// Central share of each axis used as the reference brightness (~10% of the area).
const CENTRE_HALF_WIDTH = 0.16;
const MIN_CENTRE_LINEAR = 0.01;
const CLIPPED_LINEAR = 0.97;
const MIN_GAIN = 0.25;
const MAX_GAIN = 4;
const MAX_OUTLIER_SHARE = 0.05;
const ENCODE_LUT_BITS = 20;
const OUTLIER_CELL_DEVIATION = 0.04;

export interface FlatFieldProfile {
  version: 1;
  name: string;
  // Dimensions of the decoded reference. A scan is corrected only when its
  // decode has the same size, i.e. it comes from the same camera.
  width: number;
  height: number;
  gridWidth: number;
  gridHeight: number;
  // Linear gains, gridWidth * gridHeight * 3, row-major RGB.
  gains: number[];
  // Largest correction in stops, for the settings readout.
  maxCorrectionStops: number;
  createdAt: number;
}

export type FlatFieldBuildResult =
  | { ok: true; profile: FlatFieldProfile }
  | { ok: false; reason: 'too-dark' | 'clipped' | 'not-uniform' | 'too-small' };

let decodeLut: Float32Array | null = null;
let encodeLut: Uint16Array | null = null;

function srgbDecode(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbEncode(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function getDecodeLut() {
  if (!decodeLut) {
    decodeLut = new Float32Array(65536);
    for (let index = 0; index < 65536; index += 1) decodeLut[index] = srgbDecode(index / 65535);
  }
  return decodeLut;
}

// Linear -> 16-bit sRGB code. 2^20 linear steps keep every result within one
// code of the exact encode, including the steep toe where the thin end of a
// camera-scanned orange mask sits.
function getEncodeLut() {
  if (!encodeLut) {
    const size = 1 << ENCODE_LUT_BITS;
    encodeLut = new Uint16Array(size);
    for (let index = 0; index < size; index += 1) {
      encodeLut[index] = Math.round(srgbEncode(index / (size - 1)) * 65535);
    }
  }
  return encodeLut;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

// What a cell should read if the light varies smoothly through it: the
// average of the linear predictions from each pair of neighbours along a row
// or column (one-sided extrapolation at the edges). Exact on a gradient, and
// close on the gentle curvature of real falloff, unlike a median, which bends
// it wherever it is steep.
function predictFromNeighbours(grid: Float64Array, width: number, height: number) {
  const out = new Float64Array(grid.length);
  const at = (x: number, y: number, channel: number) => grid[(y * width + x) * 3 + channel];
  const along = (position: number, size: number, read: (index: number) => number) => {
    if (position > 0 && position < size - 1) return (read(position - 1) + read(position + 1)) / 2;
    if (position === 0) return 2 * read(1) - read(2);
    return 2 * read(size - 2) - read(size - 3);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const horizontal = along(x, width, (index) => at(index, y, channel));
        const vertical = along(y, height, (index) => at(x, index, channel));
        out[(y * width + x) * 3 + channel] = (horizontal + vertical) / 2;
      }
    }
  }
  return out;
}

// Least-squares plane through the clean cells around (cx, cy), evaluated at
// that cell, per channel. Null when too few clean cells surround it.
function fitLocalPlane(
  grid: Float64Array,
  excluded: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
): [number, number, number] | null {
  const radius = 3;
  // Normal equations for value = a + b*dx + c*dy.
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const sv = [0, 0, 0];
  const sxv = [0, 0, 0];
  const syv = [0, 0, 0];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= width || y < 0 || y >= height || excluded[y * width + x]) continue;
      n += 1;
      sx += dx;
      sy += dy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = grid[(y * width + x) * 3 + channel];
        sv[channel] += value;
        sxv[channel] += dx * value;
        syv[channel] += dy * value;
      }
    }
  }
  if (n < 6) return null;
  // Solve the 3x3 system by Cramer's rule; only a (the value at dx = dy = 0) is needed.
  const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (Math.abs(det) < 1e-9) return null;
  return [0, 1, 2].map((channel) => {
    const detA = sv[channel] * (sxx * syy - sxy * sxy)
      - sx * (sxv[channel] * syy - sxy * syv[channel])
      + sy * (sxv[channel] * sxy - sxx * syv[channel]);
    return Math.max(1e-6, detA / det);
  }) as [number, number, number];
}

/**
 * Builds a flat-field map from a decoded reference frame of the bare light
 * source (16-bit, sRGB-encoded RGB, as decode_raw_binary returns it).
 */
export function buildFlatFieldProfile(
  data: ArrayLike<number>,
  width: number,
  height: number,
  name: string,
): FlatFieldBuildResult {
  if (width < 16 || height < 16 || data.length < width * height * 3) {
    return { ok: false, reason: 'too-small' };
  }
  const lut = getDecodeLut();
  const gridWidth = width >= height ? GRID_LONG_SIDE : Math.max(2, Math.round(GRID_LONG_SIDE * width / height));
  const gridHeight = height >= width ? GRID_LONG_SIDE : Math.max(2, Math.round(GRID_LONG_SIDE * height / width));
  const grid = new Float64Array(gridWidth * gridHeight * 3);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y0 = Math.floor(gy * height / gridHeight);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * height / gridHeight));
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x0 = Math.floor(gx * width / gridWidth);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * width / gridWidth));
      const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / SAMPLES_PER_CELL)));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const index = (y * width + x) * 3;
          r += lut[data[index]];
          g += lut[data[index + 1]];
          b += lut[data[index + 2]];
          count += 1;
        }
      }
      const cell = (gy * gridWidth + gx) * 3;
      grid[cell] = r / count;
      grid[cell + 1] = g / count;
      grid[cell + 2] = b / count;
    }
  }

  for (let index = 0; index < grid.length; index += 1) {
    if (grid[index] >= CLIPPED_LINEAR) return { ok: false, reason: 'clipped' };
  }

  // A speck of dust on the panel darkens a cell or two well below what its
  // neighbours predict. Those cells, and the ring around them that the speck
  // may partly cover, are rebuilt from a plane fitted to the clean cells
  // nearby. Every other cell keeps its own average, so the falloff is not
  // smoothed where it is steepest.
  const predicted = predictFromNeighbours(grid, gridWidth, gridHeight);
  const flagged = new Uint8Array(gridWidth * gridHeight);
  let outliers = 0;
  for (let cell = 0; cell < flagged.length; cell += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const index = cell * 3 + channel;
      if (Math.abs(grid[index] - predicted[index]) / Math.max(predicted[index], 1e-6) > OUTLIER_CELL_DEVIATION) {
        flagged[cell] = 1;
      }
    }
    outliers += flagged[cell];
  }
  const excluded = new Uint8Array(flagged.length);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      if (!flagged[gy * gridWidth + gx]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) excluded[y * gridWidth + x] = 1;
        }
      }
    }
  }
  const smooth = Float64Array.from(grid);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      if (excluded[gy * gridWidth + gx]) {
        const fitted = fitLocalPlane(grid, excluded, gridWidth, gridHeight, gx, gy);
        if (fitted) smooth.set(fitted, (gy * gridWidth + gx) * 3);
      }
    }
  }

  const centre = [0, 1, 2].map((channel) => {
    const values: number[] = [];
    for (let gy = 0; gy < gridHeight; gy += 1) {
      for (let gx = 0; gx < gridWidth; gx += 1) {
        if (Math.abs((gx + 0.5) / gridWidth - 0.5) <= CENTRE_HALF_WIDTH
          && Math.abs((gy + 0.5) / gridHeight - 0.5) <= CENTRE_HALF_WIDTH) {
          values.push(smooth[(gy * gridWidth + gx) * 3 + channel]);
        }
      }
    }
    return median(values);
  });
  if (centre.some((value) => !(value >= MIN_CENTRE_LINEAR))) {
    return { ok: false, reason: 'too-dark' };
  }

  // A blank light source has only a few dusty cells. Many cells off their
  // neighbours' prediction means film, a holder or a picture in the frame.
  if (outliers / grid.length > MAX_OUTLIER_SHARE) {
    return { ok: false, reason: 'not-uniform' };
  }

  const gains = new Array<number>(grid.length);
  let maxCorrectionStops = 0;
  for (let index = 0; index < grid.length; index += 1) {
    const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, centre[index % 3] / Math.max(smooth[index], 1e-6)));
    gains[index] = Math.round(gain * 10000) / 10000;
    maxCorrectionStops = Math.max(maxCorrectionStops, Math.abs(Math.log2(gain)));
  }

  return {
    ok: true,
    profile: {
      version: 1,
      name,
      width,
      height,
      gridWidth,
      gridHeight,
      gains,
      maxCorrectionStops: Math.round(maxCorrectionStops * 100) / 100,
      createdAt: Date.now(),
    },
  };
}

export function flatFieldMatches(profile: FlatFieldProfile, width: number, height: number) {
  return profile.width === width && profile.height === height;
}

// Pads the grid with one ring of cells extrapolated quadratically from the
// three nearest, so the half cell between the outermost centres and the image
// edge follows the falloff's curve into the corners instead of flattening.
function padGains(gains: number[], width: number, height: number) {
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const padded = new Float32Array(paddedWidth * paddedHeight * 3);
  const extrapolate = (a: number, b: number, c: number) => Math.min(MAX_GAIN, Math.max(MIN_GAIN, 3 * a - 3 * b + c));
  const source = (x: number, y: number, channel: number) => gains[(y * width + x) * 3 + channel];
  const columnValue = (x: number, y: number, channel: number) => {
    if (x === -1) return extrapolate(source(0, y, channel), source(1, y, channel), source(2, y, channel));
    if (x === width) return extrapolate(source(width - 1, y, channel), source(width - 2, y, channel), source(width - 3, y, channel));
    return source(x, y, channel);
  };
  for (let y = -1; y <= height; y += 1) {
    for (let x = -1; x <= width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let value: number;
        if (y === -1) {
          value = extrapolate(columnValue(x, 0, channel), columnValue(x, 1, channel), columnValue(x, 2, channel));
        } else if (y === height) {
          value = extrapolate(columnValue(x, height - 1, channel), columnValue(x, height - 2, channel), columnValue(x, height - 3, channel));
        } else {
          value = columnValue(x, y, channel);
        }
        padded[((y + 1) * paddedWidth + (x + 1)) * 3 + channel] = value;
      }
    }
  }
  return { padded, paddedWidth };
}

// Bilinear interpolation between cell centres of the padded grid.
function buildAxisWeights(size: number, cells: number) {
  const lower = new Int32Array(size);
  const weight = new Float32Array(size);
  for (let position = 0; position < size; position += 1) {
    // +1 for the padding ring; always within [0.5, cells + 0.5].
    const coordinate = ((position + 0.5) / size) * cells + 0.5;
    const low = Math.min(cells, Math.floor(coordinate));
    lower[position] = low;
    weight[position] = coordinate - low;
  }
  return { lower, weight };
}

/**
 * Divides a decoded scan (16-bit, sRGB-encoded RGB) by the flat-field map in
 * linear light, in place. Returns false, leaving the data untouched, when the
 * scan does not come from the reference's camera.
 */
export function applyFlatField(data: Uint16Array, width: number, height: number, profile: FlatFieldProfile) {
  if (!flatFieldMatches(profile, width, height) || data.length < width * height * 3) {
    return false;
  }
  const decode = getDecodeLut();
  const encode = getEncodeLut();
  const encodeScale = encode.length - 1;
  const { gridWidth, gridHeight } = profile;
  const { padded, paddedWidth } = padGains(profile.gains, gridWidth, gridHeight);
  const kernels = getImageKernels();
  if (kernels) {
    kernels.flatField(data, width, height, gridWidth, gridHeight, padded, decode, encode);
    return true;
  }
  const columns = buildAxisWeights(width, gridWidth);
  const rows = buildAxisWeights(height, gridHeight);
  const rowGains = new Float32Array(paddedWidth * 3);

  for (let y = 0; y < height; y += 1) {
    const top = rows.lower[y] * paddedWidth * 3;
    const bottom = top + paddedWidth * 3;
    const wy = rows.weight[y];
    for (let index = 0; index < rowGains.length; index += 1) {
      rowGains[index] = padded[top + index] * (1 - wy) + padded[bottom + index] * wy;
    }
    let offset = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const left = columns.lower[x] * 3;
      const wx = columns.weight[x];
      for (let channel = 0; channel < 3; channel += 1) {
        const gain = rowGains[left + channel] + (rowGains[left + 3 + channel] - rowGains[left + channel]) * wx;
        const linear = decode[data[offset]] * gain;
        data[offset] = linear >= 1 ? 65535 : encode[(linear * encodeScale + 0.5) | 0];
        offset += 1;
      }
    }
  }
  return true;
}
