import { FILM_BASE_CONFIDENCE, MAX_HIGH_DEPTH_RAW_PIXELS, RAW_EXTENSIONS } from '../constants';
import { ConversionSettings, DecodeRequest, FilmBaseEstimate, FilmBaseSample, FilmProfile, RawDecodeResult } from '../types';
import { getColorProfileIdFromName } from './colorProfiles';
import { clamp } from './math';

export const RAW_IMPORT_PROFILE_ID = 'raw-import-result';

export interface DesktopRawDecodeForWorkerOptions {
  documentId: string;
  fileName: string;
  path: string;
  size: number;
}

export function isRawExtension(extension: string) {
  return RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number]);
}

// Rotation that uprights the image once any horizontal mirror has been baked
// into the stored pixels (see mirrorFromExifOrientation). EXIF 5/7 are
// transpose/transverse: mirror first, then rotate 270/90 clockwise.
export function rotationFromExifOrientation(orientation: number | null | undefined) {
  switch (orientation) {
    case 3:
    case 4:
      return 180;
    case 6:
    case 7:
      return 90;
    case 5:
    case 8:
      return 270;
    default:
      return 0;
  }
}

// EXIF orientations 2, 4, 5 and 7 are mirrored variants; film holders flip
// strips constantly, so they show up regularly in scans.
export function mirrorFromExifOrientation(orientation: number | null | undefined) {
  return orientation === 2 || orientation === 4 || orientation === 5 || orientation === 7;
}

export function rgbToRgba(rgb: ArrayLike<number>, width: number, height: number) {
  const expectedLength = width * height * 3;
  if (rgb.length !== expectedLength) {
    throw new Error(`RAW decode returned ${rgb.length} RGB bytes for a ${width}x${height} image.`);
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < rgb.length; sourceIndex += 3, targetIndex += 4) {
    rgba[targetIndex] = rgb[sourceIndex] ?? 0;
    rgba[targetIndex + 1] = rgb[sourceIndex + 1] ?? 0;
    rgba[targetIndex + 2] = rgb[sourceIndex + 2] ?? 0;
    rgba[targetIndex + 3] = 255;
  }
  return rgba;
}

export function rgb16ToRgba8(rgb: ArrayLike<number>, width: number, height: number) {
  const expectedLength = width * height * 3;
  if (rgb.length !== expectedLength) {
    throw new Error(`RAW decode returned ${rgb.length} RGB samples for a ${width}x${height} image.`);
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < rgb.length; sourceIndex += 3, targetIndex += 4) {
    rgba[targetIndex] = Math.round((rgb[sourceIndex] ?? 0) / 257);
    rgba[targetIndex + 1] = Math.round((rgb[sourceIndex + 1] ?? 0) / 257);
    rgba[targetIndex + 2] = Math.round((rgb[sourceIndex + 2] ?? 0) / 257);
    rgba[targetIndex + 3] = 255;
  }
  return rgba;
}

function normalizeRawHighDepthBuffer(rawResult: RawDecodeResult) {
  if (rawResult.width * rawResult.height > MAX_HIGH_DEPTH_RAW_PIXELS) {
    return undefined;
  }

  const bitDepth = rawResult.bitDepth ?? 8;
  if (bitDepth !== 16) {
    return undefined;
  }
  return Uint16Array.from(rawResult.data).buffer;
}

export function createWorkerDecodeRequestFromRaw(
  documentId: string,
  fileName: string,
  size: number,
  rawResult: RawDecodeResult,
): DecodeRequest {
  const previewRgba = (rawResult.bitDepth ?? 8) === 16
    ? rgb16ToRgba8(rawResult.data, rawResult.width, rawResult.height).buffer
    : rgbToRgba(rawResult.data, rawResult.width, rawResult.height).buffer;
  const highDepthRawBuffer = normalizeRawHighDepthBuffer(rawResult);
  // Estimate the clear base from the highest-fidelity data available: the
  // full-resolution 16-bit RGB buffer when present (independent of whether it
  // survived the high-depth size cap), otherwise the 8-bit RGB. The 8-bit
  // preview is a display artifact and never the source of truth here.
  const precomputedFilmBase = (rawResult.bitDepth ?? 8) === 16
    ? estimateFilmBase16(rawResult.data, rawResult.width, rawResult.height)
    : estimateFilmBase(rawResult.data, rawResult.width, rawResult.height, 3);

  return {
    documentId,
    buffer: previewRgba,
    fileName,
    mime: 'image/x-raw-rgba',
    size,
    rawDimensions: {
      width: rawResult.width,
      height: rawResult.height,
    },
    highDepthRawBuffer,
    highDepthRawBitDepth: highDepthRawBuffer ? 16 : undefined,
    highDepthRawTransfer: highDepthRawBuffer ? (rawResult.transfer ?? 'srgb') : undefined,
    precomputedFilmBase,
    precomputedFilmBaseSample: precomputedFilmBase?.sample ?? null,
    declaredColorProfileName: rawResult.color_space,
    declaredColorProfileId: getColorProfileIdFromName(rawResult.color_space),
    mirrorHorizontal: mirrorFromExifOrientation(rawResult.orientation),
  };
}

export async function decodeDesktopRawForWorker(options: DesktopRawDecodeForWorkerOptions) {
  const { invoke } = await import('@tauri-apps/api/core');
  const rawResult = await invoke<RawDecodeResult>('decode_raw', { path: options.path });

  return {
    rawResult,
    decodeRequest: createWorkerDecodeRequestFromRaw(
      options.documentId,
      options.fileName,
      options.size,
      rawResult,
    ),
  };
}

const ANALYSIS_GRID_TARGET = 200;      // max cells per axis
const ANALYSIS_MAX_SAMPLES = 260_000;  // bound per-import pixel reads
const LUMINANCE_R = 0.299;
const LUMINANCE_G = 0.587;
const LUMINANCE_B = 0.114;

interface AnalysisCell {
  r: number;      // mean channel value, 0..255 float
  g: number;
  b: number;
  lum: number;
  stdDev: number; // max per-channel std-dev inside the cell
  count: number;
  touchesInner: boolean; // cell lies (partly) in the 3–12% rebate band
  scanned: boolean;      // cell had at least one sampled border/rebate pixel
}

// Per-channel mode-cluster mean over a set of cell means: reuse the historical
// 64-bin mode + ±10 averaging so a clean uniform border reproduces the exact
// legacy sample value.
function modeClusterMean(values: number[]): number {
  const BIN_COUNT = 64;
  const BIN_WIDTH = 256 / BIN_COUNT;
  const CLUSTER_RADIUS = 10;
  const bins = new Uint32Array(BIN_COUNT);
  for (const value of values) {
    bins[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(value / BIN_WIDTH)))] += 1;
  }
  let modeBin = 0;
  for (let index = 1; index < BIN_COUNT; index += 1) {
    if (bins[index] > bins[modeBin]) modeBin = index;
  }
  const modeCenter = (modeBin + 0.5) * BIN_WIDTH;
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (Math.abs(value - modeCenter) <= CLUSTER_RADIUS) {
      sum += value;
      count += 1;
    }
  }
  if (count === 0) {
    return values.reduce((acc, value) => acc + value, 0) / Math.max(1, values.length);
  }
  return sum / count;
}

function percentileSample(cells: AnalysisCell[], percentile: number): FilmBaseSample {
  const collect = (channel: 'r' | 'g' | 'b') => {
    const values = cells.map((cell) => cell[channel]).sort((left, right) => left - right);
    const index = clamp(Math.floor(values.length * percentile), 0, values.length - 1);
    return clamp(Math.round(values[index] ?? 0), 1, 255);
  };
  return { r: collect('r'), g: collect('g'), b: collect('b') };
}

// 4-connected clustering over candidate cells, shared by the border-band
// estimator and the borderless in-frame fallback.
function clusterCandidateCells(
  cells: AnalysisCell[],
  gridW: number,
  gridH: number,
  isCandidate: (cell: AnalysisCell) => boolean,
): number[][] {
  const cellCount = gridW * gridH;
  const clusterId = new Int32Array(cellCount).fill(-1);
  const clusters: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < cellCount; start += 1) {
    if (clusterId[start] !== -1 || !isCandidate(cells[start])) continue;
    const id = clusters.length;
    const members: number[] = [];
    clusterId[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      members.push(current);
      const cx = current % gridW;
      const cy = Math.floor(current / gridW);
      const neighbors = [
        cx > 0 ? current - 1 : -1,
        cx < gridW - 1 ? current + 1 : -1,
        cy > 0 ? current - gridW : -1,
        cy < gridH - 1 ? current + gridW : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && clusterId[neighbor] === -1 && isCandidate(cells[neighbor])) {
          clusterId[neighbor] = id;
          stack.push(neighbor);
        }
      }
    }
    clusters.push(members);
  }
  return clusters;
}

// Borderless-scan fallback: pick the brightest low-texture interior cluster as
// the Dmin proxy. Scoring is brightness-first (unlike the border estimator's
// uniformity-first weights) because in-frame the discriminating evidence for
// clear base is brightness, not coverage.
function estimateInFrameBase(
  interiorCells: AnalysisCell[],
  gridW: number,
  gridH: number,
  scannedInteriorCells: AnalysisCell[],
  isCandidate: (cell: AnalysisCell) => boolean,
): FilmBaseEstimate | null {
  if (scannedInteriorCells.length < 8) {
    return null;
  }
  const clusters = clusterCandidateCells(interiorCells, gridW, gridH, isCandidate);
  const minClusterCells = Math.max(1, Math.round(scannedInteriorCells.length * FILM_BASE_CONFIDENCE.minRegionFraction));
  const survivors = clusters.filter((members) => members.length >= minClusterCells);
  if (survivors.length === 0) {
    return null;
  }

  let best: number[] | null = null;
  let bestScore = -1;
  for (const members of survivors) {
    let lumSum = 0;
    let stdSum = 0;
    for (const index of members) {
      lumSum += interiorCells[index].lum;
      stdSum += interiorCells[index].stdDev;
    }
    const meanLum = lumSum / members.length;
    const meanStd = stdSum / members.length;
    const clusterFraction = members.length / scannedInteriorCells.length;
    const sizeScore = Math.min(1, clusterFraction / (4 * FILM_BASE_CONFIDENCE.minRegionFraction));
    const uniformityScore = clamp(1 - meanStd / FILM_BASE_CONFIDENCE.maxRegionStdDev, 0, 1);
    const brightnessScore = clamp(
      (meanLum - FILM_BASE_CONFIDENCE.minPlausibleLuminance) / (255 - FILM_BASE_CONFIDENCE.minPlausibleLuminance),
      0,
      1,
    );
    const score = 0.5 * brightnessScore + 0.3 * uniformityScore + 0.2 * sizeScore;
    if (score > bestScore) {
      bestScore = score;
      best = members;
    }
  }
  if (!best) {
    return null;
  }

  const sample: FilmBaseSample = {
    r: clamp(Math.round(modeClusterMean(best.map((index) => interiorCells[index].r))), 1, 255),
    g: clamp(Math.round(modeClusterMean(best.map((index) => interiorCells[index].g))), 1, 255),
    b: clamp(Math.round(modeClusterMean(best.map((index) => interiorCells[index].b))), 1, 255),
  };

  return {
    sample,
    source: 'in-frame',
    confidence: Math.min(clamp(bestScore, 0, 1) * 0.85, FILM_BASE_CONFIDENCE.inFrameConfidenceCap),
    rejectedCandidates: clusters.length - survivors.length,
    clamped: false,
  };
}

// Region-based, confidence-scored clear-film-base estimator. Parameterized by a
// channel scale so the 8-bit (scale 1) and 16-bit (scale 255/65535) paths share
// one implementation. Reads at most ANALYSIS_MAX_SAMPLES pixels regardless of
// source resolution.
function estimateFilmBaseCore(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  stride: number,
  channelScale: number,
): FilmBaseEstimate | null {
  if (width < 8 || height < 8 || pixels.length < width * height * stride) {
    return null;
  }

  const minDimension = Math.min(width, height);
  const outerInsetPx = Math.max(2, minDimension * 0.03);
  const innerInsetPx = Math.max(outerInsetPx + 1, minDimension * 0.12);

  const cellSize = Math.max(1, Math.ceil(Math.max(width, height) / ANALYSIS_GRID_TARGET));
  const gridW = Math.ceil(width / cellSize);
  const gridH = Math.ceil(height / cellSize);
  const cellCount = gridW * gridH;

  const sumR = new Float64Array(cellCount);
  const sumG = new Float64Array(cellCount);
  const sumB = new Float64Array(cellCount);
  const sumSqR = new Float64Array(cellCount);
  const sumSqG = new Float64Array(cellCount);
  const sumSqB = new Float64Array(cellCount);
  const counts = new Uint32Array(cellCount);
  const touchesInner = new Uint8Array(cellCount);

  // Interior (beyond the 12% band) accumulates into its own set of cells so
  // the border-band statistics stay byte-identical to the border-only
  // estimator; the interior grid only feeds the borderless-scan fallback.
  const interiorSumR = new Float64Array(cellCount);
  const interiorSumG = new Float64Array(cellCount);
  const interiorSumB = new Float64Array(cellCount);
  const interiorSumSqR = new Float64Array(cellCount);
  const interiorSumSqG = new Float64Array(cellCount);
  const interiorSumSqB = new Float64Array(cellCount);
  const interiorCounts = new Uint32Array(cellCount);

  const pixelStep = Math.max(1, Math.round(Math.sqrt((width * height) / ANALYSIS_MAX_SAMPLES)));

  for (let y = 0; y < height; y += pixelStep) {
    const edgeY = Math.min(y, height - 1 - y);
    for (let x = 0; x < width; x += pixelStep) {
      const edgeDist = Math.min(x, width - 1 - x, edgeY);
      const cellIndex = Math.floor(y / cellSize) * gridW + Math.floor(x / cellSize);
      const sourceIndex = (y * width + x) * stride;
      const r = (pixels[sourceIndex] ?? 0) * channelScale;
      const g = (pixels[sourceIndex + 1] ?? 0) * channelScale;
      const b = (pixels[sourceIndex + 2] ?? 0) * channelScale;
      if (edgeDist > innerInsetPx) {
        // Interior image content — only a candidate for the borderless fallback.
        interiorSumR[cellIndex] += r;
        interiorSumG[cellIndex] += g;
        interiorSumB[cellIndex] += b;
        interiorSumSqR[cellIndex] += r * r;
        interiorSumSqG[cellIndex] += g * g;
        interiorSumSqB[cellIndex] += b * b;
        interiorCounts[cellIndex] += 1;
        continue;
      }
      sumR[cellIndex] += r;
      sumG[cellIndex] += g;
      sumB[cellIndex] += b;
      sumSqR[cellIndex] += r * r;
      sumSqG[cellIndex] += g * g;
      sumSqB[cellIndex] += b * b;
      counts[cellIndex] += 1;
      if (edgeDist > outerInsetPx) {
        touchesInner[cellIndex] = 1;
      }
    }
  }

  const cells: AnalysisCell[] = new Array(cellCount);
  const scannedCells: AnalysisCell[] = [];
  const stdDevOf = (sum: number, sumSq: number, n: number) => {
    const meanValue = sum / n;
    return Math.sqrt(Math.max(0, sumSq / n - meanValue * meanValue));
  };

  for (let index = 0; index < cellCount; index += 1) {
    const n = counts[index];
    if (n === 0) {
      cells[index] = { r: 0, g: 0, b: 0, lum: 0, stdDev: Infinity, count: 0, touchesInner: false, scanned: false };
      continue;
    }
    const r = sumR[index] / n;
    const g = sumG[index] / n;
    const b = sumB[index] / n;
    const stdDev = Math.max(
      stdDevOf(sumR[index], sumSqR[index], n),
      stdDevOf(sumG[index], sumSqG[index], n),
      stdDevOf(sumB[index], sumSqB[index], n),
    );
    const cell: AnalysisCell = {
      r,
      g,
      b,
      lum: LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b,
      stdDev,
      count: n,
      touchesInner: touchesInner[index] === 1,
      scanned: true,
    };
    cells[index] = cell;
    scannedCells.push(cell);
  }

  const interiorCells: AnalysisCell[] = new Array(cellCount);
  const scannedInteriorCells: AnalysisCell[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const n = interiorCounts[index];
    if (n === 0) {
      interiorCells[index] = { r: 0, g: 0, b: 0, lum: 0, stdDev: Infinity, count: 0, touchesInner: false, scanned: false };
      continue;
    }
    const r = interiorSumR[index] / n;
    const g = interiorSumG[index] / n;
    const b = interiorSumB[index] / n;
    const stdDev = Math.max(
      stdDevOf(interiorSumR[index], interiorSumSqR[index], n),
      stdDevOf(interiorSumG[index], interiorSumSqG[index], n),
      stdDevOf(interiorSumB[index], interiorSumSqB[index], n),
    );
    const cell: AnalysisCell = {
      r,
      g,
      b,
      lum: LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b,
      stdDev,
      count: n,
      touchesInner: false,
      scanned: true,
    };
    interiorCells[index] = cell;
    scannedInteriorCells.push(cell);
  }

  if (scannedCells.length < 8) {
    return null;
  }

  // Candidate filter: bright enough, low texture, not blown out.
  const isCandidate = (cell: AnalysisCell) => (
    cell.scanned
    && cell.lum >= FILM_BASE_CONFIDENCE.minPlausibleLuminance
    && cell.stdDev <= FILM_BASE_CONFIDENCE.maxRegionStdDev
    && Math.min(cell.r, cell.g, cell.b) < 250
  );

  // 4-connected clustering over candidate cells.
  const clusters = clusterCandidateCells(cells, gridW, gridH, isCandidate);

  const minClusterCells = Math.max(1, Math.round(scannedCells.length * FILM_BASE_CONFIDENCE.minRegionFraction));
  const survivors = clusters.filter((members) => members.length >= minClusterCells);
  const rejectedCandidates = clusters.length - survivors.length;

  if (survivors.length === 0) {
    // No clear base in the border band. Borderless-scan fallback: on a
    // negative, unexposed film base is the brightest thing in frame, so the
    // brightest low-texture interior patch is a usable Dmin proxy. Its
    // confidence is capped below `accept` so it is always used-but-flagged,
    // and the decode-time crush guard demotes a sample that would crush the
    // frame (the known bias: an in-frame patch can be slightly denser than
    // true base).
    const inFrame = estimateInFrameBase(interiorCells, gridW, gridH, scannedInteriorCells, isCandidate);
    if (inFrame) {
      return { ...inFrame, rejectedCandidates: inFrame.rejectedCandidates + clusters.length };
    }
    // No trustworthy clear base anywhere — conservative bright-percentile
    // fallback so the render can never collapse to black. Fed by border and
    // interior cells so borderless scans use the whole frame's statistics.
    return {
      sample: percentileSample([...scannedCells, ...scannedInteriorCells], 0.995),
      source: 'low-confidence',
      confidence: 0,
      rejectedCandidates: clusters.length,
      clamped: false,
    };
  }

  let best: number[] = survivors[0];
  let bestConfidence = -1;
  let bestTouchesInner = false;
  for (const members of survivors) {
    let lumSum = 0;
    let stdSum = 0;
    let touchesInnerRing = false;
    for (const index of members) {
      lumSum += cells[index].lum;
      stdSum += cells[index].stdDev;
      if (cells[index].touchesInner) touchesInnerRing = true;
    }
    const meanLum = lumSum / members.length;
    const meanStd = stdSum / members.length;
    const clusterFraction = members.length / scannedCells.length;
    const sizeScore = Math.min(1, clusterFraction / (4 * FILM_BASE_CONFIDENCE.minRegionFraction));
    const uniformityScore = clamp(1 - meanStd / FILM_BASE_CONFIDENCE.maxRegionStdDev, 0, 1);
    const brightnessScore = clamp(
      (meanLum - FILM_BASE_CONFIDENCE.minPlausibleLuminance) / (255 - FILM_BASE_CONFIDENCE.minPlausibleLuminance),
      0,
      1,
    );
    const confidence = 0.3 * sizeScore + 0.4 * uniformityScore + 0.3 * brightnessScore;
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      best = members;
      bestTouchesInner = touchesInnerRing;
    }
  }

  const winningR = best.map((index) => cells[index].r);
  const winningG = best.map((index) => cells[index].g);
  const winningB = best.map((index) => cells[index].b);
  const sample: FilmBaseSample = {
    r: clamp(Math.round(modeClusterMean(winningR)), 1, 255),
    g: clamp(Math.round(modeClusterMean(winningG)), 1, 255),
    b: clamp(Math.round(modeClusterMean(winningB)), 1, 255),
  };

  return {
    sample,
    source: bestTouchesInner ? 'frame-rebate' : 'outer-border',
    confidence: clamp(bestConfidence, 0, 1),
    rejectedCandidates,
    clamped: false,
  };
}

export function estimateFilmBase(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  stride: 3 | 4,
): FilmBaseEstimate | null {
  return estimateFilmBaseCore(pixels, width, height, stride, 1);
}

// Conservative bright-percentile base over the whole frame (not just the
// border): guarantees a high transmittance reference so the density inversion
// cannot collapse the image to black. Used when the crush guard demotes an
// estimate. Bounded to ANALYSIS_MAX_SAMPLES reads regardless of resolution.
export function computeBrightPercentileSample(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  stride: 3 | 4,
  percentile = 0.995,
): FilmBaseSample {
  const valuesR: number[] = [];
  const valuesG: number[] = [];
  const valuesB: number[] = [];
  const pixelStep = Math.max(1, Math.round(Math.sqrt((width * height) / ANALYSIS_MAX_SAMPLES)));
  for (let y = 0; y < height; y += pixelStep) {
    for (let x = 0; x < width; x += pixelStep) {
      const index = (y * width + x) * stride;
      valuesR.push(pixels[index] ?? 0);
      valuesG.push(pixels[index + 1] ?? 0);
      valuesB.push(pixels[index + 2] ?? 0);
    }
  }
  const pick = (values: number[]) => {
    if (values.length === 0) return 1;
    values.sort((left, right) => left - right);
    const idx = clamp(Math.floor(values.length * percentile), 0, values.length - 1);
    return clamp(Math.round(values[idx]), 1, 255);
  };
  return { r: pick(valuesR), g: pick(valuesG), b: pick(valuesB) };
}

// 16-bit RGB analysis path (stride 3). Channels are normalized to 0..255 float
// without rounding before scoring; the returned sample is rounded to 8-bit.
export function estimateFilmBase16(
  rgb: Uint16Array | ArrayLike<number>,
  width: number,
  height: number,
): FilmBaseEstimate | null {
  return estimateFilmBaseCore(rgb, width, height, 3, 255 / 65535);
}

export function estimateFilmBaseSample(rgb: ArrayLike<number>, width: number, height: number): FilmBaseSample | null {
  return estimateFilmBase(rgb, width, height, 3)?.sample ?? null;
}

export function estimateFilmBaseSampleFromRgba(rgba: ArrayLike<number>, width: number, height: number): FilmBaseSample | null {
  return estimateFilmBase(rgba, width, height, 4)?.sample ?? null;
}

export function getFilmBaseChannelBalance(sample: FilmBaseSample | null) {
  if (!sample) {
    return {
      redBalance: 1,
      greenBalance: 1,
      blueBalance: 1,
    };
  }

  const safeR = Math.max(255 - sample.r, 1);
  const safeG = Math.max(255 - sample.g, 1);
  const safeB = Math.max(255 - sample.b, 1);

  return {
    redBalance: safeG / safeR,
    greenBalance: 1,
    blueBalance: safeG / safeB,
  };
}

export function getFilmBaseCorrectionSettings(sample: FilmBaseSample | null) {
  return {
    filmBaseSample: null,
    temperature: 0,
    tint: 0,
    ...getFilmBaseChannelBalance(sample),
  } satisfies Pick<ConversionSettings, 'filmBaseSample' | 'temperature' | 'tint' | 'redBalance' | 'greenBalance' | 'blueBalance'>;
}

export function getFilmBaseExposure(sample: FilmBaseSample | null, targetWhitePoint = 245 / 255) {
  if (!sample) {
    return 0;
  }

  const positiveGreen = clamp((255 - sample.g) / 255, 1 / 255, 1);
  const target = clamp(targetWhitePoint, 1 / 255, 1);
  return clamp(Math.round(50 * Math.log2(target / positiveGreen)), -100, 100);
}

export function buildRawInitialSettings(
  baseSettings: ConversionSettings,
  rgb: ArrayLike<number>,
  width: number,
  height: number,
  orientation: number | null | undefined,
  estimatedFilmBase: FilmBaseSample | FilmBaseEstimate | null = estimateFilmBase(rgb, width, height, 3),
) {
  const nextSettings = structuredClone(baseSettings);

  // A distrusted estimate must not seed the white balance — a wrong base start
  // compounds the wrong reference (diagnosis §"fallback behavior is too eager").
  // Bare samples carry no confidence signal and are treated as trusted.
  const estimate = estimatedFilmBase && typeof estimatedFilmBase === 'object' && 'sample' in estimatedFilmBase
    ? estimatedFilmBase
    : null;
  const bareSample = estimate ? estimate.sample : (estimatedFilmBase as FilmBaseSample | null);
  const lowConfidence = estimate != null
    && (estimate.confidence < FILM_BASE_CONFIDENCE.reject || estimate.source === 'low-confidence');
  const channelBalance = lowConfidence
    ? { redBalance: 1, greenBalance: 1, blueBalance: 1 }
    : getFilmBaseChannelBalance(bareSample);

  return {
    ...nextSettings,
    filmBaseSample: null,
    redBalance: clamp(nextSettings.redBalance * channelBalance.redBalance, 0.01, 8),
    greenBalance: clamp(nextSettings.greenBalance * channelBalance.greenBalance, 0.01, 8),
    blueBalance: clamp(nextSettings.blueBalance * channelBalance.blueBalance, 0.01, 8),
    rotation: rotationFromExifOrientation(orientation),
  } satisfies ConversionSettings;
}

export function createRawImportProfile(baseProfile: FilmProfile, settings: ConversionSettings): FilmProfile {
  return {
    ...baseProfile,
    id: RAW_IMPORT_PROFILE_ID,
    name: 'Raw Import Result',
    description: 'Exact starting point produced during RAW import.',
    defaultSettings: structuredClone(settings),
  } satisfies FilmProfile;
}
