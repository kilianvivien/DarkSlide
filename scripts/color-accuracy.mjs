#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import UTIF from 'utif';

export const EVALUATOR_VERSION = 1;

const D50_WHITE = [0.96422, 1, 0.82521];
const D65_TO_D50 = [
  1.0478112, 0.0228866, -0.050127,
  0.0295424, 0.9904844, -0.0170491,
  -0.0092345, 0.0150436, 0.7521316,
];

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 3) => Number(value.toFixed(digits));

function assertTriplet(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    throw new Error(`${label} must contain exactly three finite numbers.`);
  }
}

export function srgbChannelToLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(value) {
  const channel = Math.min(1, Math.max(0, value));
  const encoded = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

export function linearSrgbToLabD50([r, g, b]) {
  const x65 = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y65 = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z65 = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

  const x = D65_TO_D50[0] * x65 + D65_TO_D50[1] * y65 + D65_TO_D50[2] * z65;
  const y = D65_TO_D50[3] * x65 + D65_TO_D50[4] * y65 + D65_TO_D50[5] * z65;
  const z = D65_TO_D50[6] * x65 + D65_TO_D50[7] * y65 + D65_TO_D50[8] * z65;
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const pivot = (value) => value > epsilon ? Math.cbrt(value) : (kappa * value + 16) / 116;
  const fx = pivot(x / D50_WHITE[0]);
  const fy = pivot(y / D50_WHITE[1]);
  const fz = pivot(z / D50_WHITE[2]);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function srgbToLabD50([r, g, b]) {
  assertTriplet([r, g, b], 'sRGB value');
  return linearSrgbToLabD50([
    srgbChannelToLinear(r),
    srgbChannelToLinear(g),
    srgbChannelToLinear(b),
  ]);
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function hueDegrees(a, b) {
  if (a === 0 && b === 0) return 0;
  const degrees = radiansToDegrees(Math.atan2(b, a));
  return degrees >= 0 ? degrees : degrees + 360;
}

// CIEDE2000, following Sharma, Wu, and Dalal (2005).
export function deltaE00(lab1, lab2) {
  assertTriplet(lab1, 'First Lab value');
  assertTriplet(lab2, 'Second Lab value');
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const cMean7 = cMean ** 7;
  const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1Prime = hueDegrees(a1Prime, b1);
  const h2Prime = hueDegrees(a2Prime, b2);
  const deltaLPrime = l2 - l1;
  const deltaCPrime = c2Prime - c1Prime;

  let deltaHDegrees = h2Prime - h1Prime;
  if (c1Prime * c2Prime === 0) deltaHDegrees = 0;
  else if (deltaHDegrees > 180) deltaHDegrees -= 360;
  else if (deltaHDegrees < -180) deltaHDegrees += 360;
  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime)
    * Math.sin(degreesToRadians(deltaHDegrees / 2));

  const lMeanPrime = (l1 + l2) / 2;
  const cMeanPrime = (c1Prime + c2Prime) / 2;
  let hMeanPrime;
  if (c1Prime * c2Prime === 0) hMeanPrime = h1Prime + h2Prime;
  else if (Math.abs(h1Prime - h2Prime) <= 180) hMeanPrime = (h1Prime + h2Prime) / 2;
  else if (h1Prime + h2Prime < 360) hMeanPrime = (h1Prime + h2Prime + 360) / 2;
  else hMeanPrime = (h1Prime + h2Prime - 360) / 2;

  const t = 1
    - 0.17 * Math.cos(degreesToRadians(hMeanPrime - 30))
    + 0.24 * Math.cos(degreesToRadians(2 * hMeanPrime))
    + 0.32 * Math.cos(degreesToRadians(3 * hMeanPrime + 6))
    - 0.2 * Math.cos(degreesToRadians(4 * hMeanPrime - 63));
  const deltaTheta = 30 * Math.exp(-(((hMeanPrime - 275) / 25) ** 2));
  const cMeanPrime7 = cMeanPrime ** 7;
  const rC = 2 * Math.sqrt(cMeanPrime7 / (cMeanPrime7 + 25 ** 7));
  const sL = 1 + (0.015 * (lMeanPrime - 50) ** 2)
    / Math.sqrt(20 + (lMeanPrime - 50) ** 2);
  const sC = 1 + 0.045 * cMeanPrime;
  const sH = 1 + 0.015 * cMeanPrime * t;
  const rT = -Math.sin(degreesToRadians(2 * deltaTheta)) * rC;
  const lTerm = deltaLPrime / sL;
  const cTerm = deltaCPrime / sC;
  const hTerm = deltaHPrime / sH;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rT * cTerm * hTerm);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hueDifference(lab1, lab2) {
  if (Math.hypot(lab1[1], lab1[2]) < 1 || Math.hypot(lab2[1], lab2[2]) < 1) return null;
  const first = hueDegrees(lab1[1], lab1[2]);
  const second = hueDegrees(lab2[1], lab2[2]);
  const difference = Math.abs(first - second);
  return Math.min(difference, 360 - difference);
}

// Provenance every measured run must carry, mirroring the schema. A score
// without these cannot be reproduced or compared against another release.
const REQUIRED_CAPTURE_STRINGS = [
  'target',
  'targetSerial',
  'referenceDataSource',
  'filmStock',
  'development',
  'camera',
  'lens',
  'backlight',
  'darkslideVersion',
  'profileId',
];
const NULLABLE_CAPTURE_STRINGS = ['lightSourceId', 'labStyleId'];
const EVIDENCE_KINDS = ['measured', 'synthetic'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCapture(capture, evidence) {
  if (evidence === 'synthetic' && capture === undefined) return;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new Error('Measured datasets require a capture block recording how the image was produced.');
  }
  const missing = REQUIRED_CAPTURE_STRINGS.filter((key) => !isNonEmptyString(capture[key]));
  if (missing.length) {
    throw new Error(`capture is missing required provenance: ${missing.join(', ')}.`);
  }
  for (const key of NULLABLE_CAPTURE_STRINGS) {
    if (!(key in capture) || (capture[key] !== null && !isNonEmptyString(capture[key]))) {
      throw new Error(`capture.${key} must be a string or null.`);
    }
  }
  if (!Number.isInteger(capture.profileVersion) || capture.profileVersion < 1) {
    throw new Error('capture.profileVersion must be a positive integer.');
  }
  if (!['technical', 'creative'].includes(capture.profileIntent)) {
    throw new Error('capture.profileIntent must be technical or creative.');
  }
  if (!['automatic', 'locked'].includes(capture.filmBaseMode)) {
    throw new Error('capture.filmBaseMode must be automatic or locked.');
  }
  if (!['profile-defaults', 'modified'].includes(capture.settingsSource)) {
    throw new Error('capture.settingsSource must be profile-defaults or modified.');
  }
  if (!capture.settingsSnapshot || typeof capture.settingsSnapshot !== 'object'
    || Array.isArray(capture.settingsSnapshot)) {
    throw new Error('capture.settingsSnapshot must be the complete settings object used for the export.');
  }
  if (!isFiniteNumber(capture.exposureBracketEv)) {
    throw new Error('capture.exposureBracketEv must be a finite number (0 for nominal exposure).');
  }
}

export function validateDataset(dataset, needsRects) {
  if (!dataset || dataset.schemaVersion !== 1 || !isNonEmptyString(dataset.id)) {
    throw new Error('Dataset requires schemaVersion 1 and a non-empty id.');
  }
  if (!EVIDENCE_KINDS.includes(dataset.evidence)) {
    throw new Error('evidence must be "measured" (a physical target capture) or "synthetic" (a test fixture).');
  }
  if (dataset.referenceWhite !== 'D50') {
    throw new Error('referenceWhite must be D50. Convert measured reference data before evaluation.');
  }
  if (dataset.referenceObserver !== '2-degree') {
    throw new Error('referenceObserver must be 2-degree.');
  }
  validateCapture(dataset.capture, dataset.evidence);
  if (!Array.isArray(dataset.patches) || dataset.patches.length === 0) {
    throw new Error('Dataset must contain at least one patch.');
  }
  const ids = new Set();
  for (const [index, patch] of dataset.patches.entries()) {
    if (!patch || !isNonEmptyString(patch.id) || ids.has(patch.id)) {
      throw new Error(`Patch ${index + 1} has a missing or duplicate id.`);
    }
    ids.add(patch.id);
    assertTriplet(patch.referenceLab, `Patch ${patch.id} referenceLab`);
    if (patch.referenceLab[0] < 0 || patch.referenceLab[0] > 100) {
      throw new Error(`Patch ${patch.id} referenceLab L* must be within 0–100.`);
    }
    if (patch.observedLab !== undefined) assertTriplet(patch.observedLab, `Patch ${patch.id} observedLab`);
    if (patch.observedSrgb !== undefined) {
      assertTriplet(patch.observedSrgb, `Patch ${patch.id} observedSrgb`);
      if (!patch.observedSrgb.every((value) => value >= 0 && value <= 255)) {
        throw new Error(`Patch ${patch.id} observedSrgb values must be within 0–255.`);
      }
    }
    if (needsRects) {
      if (!Array.isArray(patch.sampleRect) || patch.sampleRect.length !== 4
        || !patch.sampleRect.every(isFiniteNumber)) {
        throw new Error(`Patch ${patch.id} needs sampleRect [x, y, width, height].`);
      }
      const [x, y, width, height] = patch.sampleRect;
      if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
        throw new Error(`Patch ${patch.id} sampleRect must fit within normalized image coordinates.`);
      }
    } else if (!patch.observedLab && !patch.observedSrgb) {
      throw new Error(`Patch ${patch.id} needs observedLab or observedSrgb when no image is supplied.`);
    }
  }
}

function readUint32Be(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function asciiAt(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// Reads the human-readable descriptions of an ICC profile (v2 'desc' and v4
// 'mluc' tags). Enough to tell sRGB from Display P3 / Adobe RGB exports.
export function readIccDescriptions(icc) {
  if (!icc || icc.length < 144) return [];
  const tagCount = Math.min(readUint32Be(icc, 128) ?? 0, 64);
  const labels = [];
  for (let index = 0; index < tagCount; index += 1) {
    const entry = 132 + index * 12;
    const offset = readUint32Be(icc, entry + 4);
    const length = readUint32Be(icc, entry + 8);
    if (offset === null || length === null || length < 12 || offset + length > icc.length) continue;
    const tag = icc.subarray(offset, offset + length);
    const type = asciiAt(tag, 0, 4);
    if (type === 'desc') {
      const textLength = readUint32Be(tag, 8);
      if (textLength && textLength > 1 && 12 + textLength - 1 <= tag.length) {
        labels.push(asciiAt(tag, 12, textLength - 1).replace(/\0/g, '').trim());
      }
    } else if (type === 'mluc') {
      const records = Math.min(readUint32Be(tag, 8) ?? 0, 16);
      const recordSize = readUint32Be(tag, 12) ?? 0;
      for (let record = 0; record < records && recordSize >= 12; record += 1) {
        const recordOffset = 16 + record * recordSize;
        const textLength = readUint32Be(tag, recordOffset + 4);
        const textOffset = readUint32Be(tag, recordOffset + 8);
        if (!textLength || textOffset === null || textOffset + textLength > tag.length) continue;
        let text = '';
        for (let char = textOffset; char + 1 < textOffset + textLength; char += 2) {
          text += String.fromCharCode((tag[char] << 8) | tag[char + 1]);
        }
        labels.push(text.replace(/\0/g, '').trim());
      }
    }
  }
  return labels.filter(Boolean);
}

function tagValues(ifd, tag) {
  const value = ifd[`t${tag}`];
  if (value === undefined) return null;
  return Array.from(value);
}

// The evaluator converts samples with the sRGB transfer curve and primaries,
// so anything else would be measured under the wrong assumptions. Reject it.
export function describeTiffColorContract(ifd) {
  const photometric = tagValues(ifd, 262)?.[0];
  const bitsPerSample = tagValues(ifd, 258) ?? [1];
  const samplesPerPixel = tagValues(ifd, 277)?.[0] ?? 1;
  const sampleFormat = tagValues(ifd, 339) ?? [1];
  const icc = ifd.t34675 ? Uint8Array.from(ifd.t34675) : null;

  if (photometric !== 2) {
    throw new Error('Only RGB TIFFs are supported (PhotometricInterpretation 2). Export the chart as an RGB TIFF.');
  }
  if (samplesPerPixel !== 3 && samplesPerPixel !== 4) {
    throw new Error(`Expected 3 or 4 samples per pixel, found ${samplesPerPixel}.`);
  }
  if (!bitsPerSample.every((bits) => bits === 8)) {
    throw new Error(`Only 8-bit TIFFs are supported, found ${bitsPerSample.join('/')} bits per sample. Export an 8-bit sRGB TIFF.`);
  }
  if (!sampleFormat.every((format) => format === 1)) {
    throw new Error('Only unsigned integer TIFF samples are supported.');
  }

  if (!icc) {
    return { bitsPerSample: 8, samplesPerPixel, colorProfile: 'untagged (assumed sRGB)' };
  }
  const descriptions = readIccDescriptions(icc);
  const srgb = descriptions.find((label) => /\bsRGB\b/i.test(label));
  if (!srgb) {
    throw new Error(`The TIFF embeds a non-sRGB ICC profile (${descriptions[0] ?? 'unnamed'}). Export the chart in sRGB.`);
  }
  return { bitsPerSample: 8, samplesPerPixel, colorProfile: srgb };
}

async function readTiff(filename) {
  const bytes = await readFile(filename);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ifds = UTIF.decode(buffer);
  if (ifds.length === 0) throw new Error(`No TIFF image found in ${filename}.`);
  const contract = describeTiffColorContract(ifds[0]);
  UTIF.decodeImage(buffer, ifds[0], ifds);
  const rgba = UTIF.toRGBA8(ifds[0]);
  return { rgba, width: ifds[0].width, height: ifds[0].height, contract };
}

export function samplePatch({ rgba, width, height }, rect) {
  const [x, y, rectWidth, rectHeight] = rect;
  const left = Math.max(0, Math.floor(x * width));
  const top = Math.max(0, Math.floor(y * height));
  const right = Math.min(width, Math.ceil((x + rectWidth) * width));
  const bottom = Math.min(height, Math.ceil((y + rectHeight) * height));
  const linear = [0, 0, 0];
  let count = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * width + column) * 4;
      if (rgba[offset + 3] === 0) continue;
      linear[0] += srgbChannelToLinear(rgba[offset]);
      linear[1] += srgbChannelToLinear(rgba[offset + 1]);
      linear[2] += srgbChannelToLinear(rgba[offset + 2]);
      count += 1;
    }
  }
  if (count === 0) throw new Error('A sample rectangle contains no visible pixels.');
  const average = linear.map((value) => value / count);
  return {
    observedLab: linearSrgbToLabD50(average),
    observedSrgb: average.map(linearChannelToSrgb),
    sampledPixels: count,
  };
}

export async function evaluateDataset(dataset, options = {}) {
  validateDataset(dataset, Boolean(options.image));
  const image = options.image ? await readTiff(options.image) : null;
  const patches = dataset.patches.map((patch) => {
    const sample = image ? samplePatch(image, patch.sampleRect) : null;
    const observedLab = sample?.observedLab
      ?? (patch.observedLab ? patch.observedLab : srgbToLabD50(patch.observedSrgb));
    assertTriplet(observedLab, `Patch ${patch.id} observed Lab`);
    const referenceChroma = Math.hypot(patch.referenceLab[1], patch.referenceLab[2]);
    const observedChroma = Math.hypot(observedLab[1], observedLab[2]);
    const hueError = hueDifference(patch.referenceLab, observedLab);
    return {
      id: patch.id,
      name: patch.name ?? patch.id,
      category: patch.category ?? 'uncategorized',
      referenceLab: patch.referenceLab.map((value) => round(value)),
      observedLab: observedLab.map((value) => round(value)),
      observedSrgb: sample?.observedSrgb?.map((value) => round(value, 1)) ?? patch.observedSrgb,
      sampledPixels: sample?.sampledPixels,
      deltaE00: round(deltaE00(patch.referenceLab, observedLab)),
      lightnessError: round(Math.abs(observedLab[0] - patch.referenceLab[0])),
      chromaError: round(Math.abs(observedChroma - referenceChroma)),
      hueErrorDegrees: hueError === null ? null : round(hueError, 1),
    };
  });
  const errors = patches.map((patch) => patch.deltaE00);
  const neutralErrors = patches
    .filter((patch) => patch.category.toLowerCase() === 'neutral')
    .map((patch) => patch.deltaE00);
  const categories = Object.fromEntries([...new Set(patches.map((patch) => patch.category))]
    .map((category) => {
      const categoryErrors = patches.filter((patch) => patch.category === category)
        .map((patch) => patch.deltaE00);
      return [category, { count: categoryErrors.length, meanDeltaE00: round(mean(categoryErrors)) }];
    }));
  const summary = {
    patchCount: patches.length,
    meanDeltaE00: round(mean(errors)),
    medianDeltaE00: round(median(errors)),
    p95DeltaE00: round(percentile(errors, 0.95)),
    maxDeltaE00: round(Math.max(...errors)),
    neutralMeanDeltaE00: neutralErrors.length ? round(mean(neutralErrors)) : null,
    meanLightnessError: round(mean(patches.map((patch) => patch.lightnessError))),
    meanChromaError: round(mean(patches.map((patch) => patch.chromaError))),
    meanHueErrorDegrees: (() => {
      const values = patches.map((patch) => patch.hueErrorDegrees).filter(isFiniteNumber);
      return values.length ? round(mean(values), 1) : null;
    })(),
  };
  const thresholdResults = Object.entries(dataset.thresholds ?? {}).map(([metric, limit]) => {
    if (!isFiniteNumber(limit) || !isFiniteNumber(summary[metric])) {
      throw new Error(`Threshold ${metric} does not match a numeric summary metric.`);
    }
    return { metric, actual: summary[metric], limit, passed: summary[metric] <= limit };
  });
  return {
    schemaVersion: 1,
    evaluatorVersion: EVALUATOR_VERSION,
    evidence: dataset.evidence,
    dataset: { id: dataset.id, description: dataset.description, capture: dataset.capture ?? null },
    sourceImage: image
      ? { path: options.image, width: image.width, height: image.height, ...image.contract }
      : null,
    generatedAt: new Date().toISOString(),
    summary,
    categories,
    thresholds: thresholdResults,
    passed: thresholdResults.length ? thresholdResults.every((result) => result.passed) : null,
    patches,
  };
}

export function formatMarkdown(report) {
  const capture = report.dataset.capture ?? {};
  const recorded = (value) => (value === undefined || value === null || value === '' ? 'not recorded' : value);
  const lines = [
    `# Color accuracy: ${report.dataset.id}`,
    '',
  ];
  if (report.evidence === 'synthetic') {
    lines.push('> **Synthetic fixture.** These numbers test the evaluator, not DarkSlide\'s photographic accuracy.', '');
  }
  lines.push(
    report.dataset.description ?? '',
    '',
    '| Test condition | Value |',
    '| --- | --- |',
    `| Evidence | ${report.evidence} |`,
    `| DarkSlide | ${recorded(capture.darkslideVersion)}${capture.darkslideRevision ? ` (${capture.darkslideRevision})` : ''} |`,
    `| Target | ${recorded(capture.target)}${capture.targetSerial ? ` #${capture.targetSerial}` : ''} |`,
    `| Reference data | ${recorded(capture.referenceDataSource)} |`,
    `| Film stock | ${recorded(capture.filmStock)} |`,
    `| Development | ${recorded(capture.development)} |`,
    `| Exposure bracket | ${isFiniteNumber(capture.exposureBracketEv) ? `${capture.exposureBracketEv > 0 ? '+' : ''}${capture.exposureBracketEv} EV` : 'not recorded'} |`,
    `| Scanning setup | ${[capture.camera, capture.lens, capture.backlight].filter(Boolean).join('; ') || 'not recorded'} |`,
    `| Source image | ${report.sourceImage ? `${report.sourceImage.width}×${report.sourceImage.height}, ${report.sourceImage.bitsPerSample}-bit, ${report.sourceImage.colorProfile}` : 'pre-measured values'} |`,
    `| Negative profile | ${capture.profileId ? `${capture.profileId} v${capture.profileVersion ?? '?'}` : 'not recorded'} |`,
    `| Profile intent | ${capture.profileIntent ?? 'not recorded'} |`,
    `| Film base | ${capture.filmBaseMode ?? 'not recorded'} |`,
    `| Settings | ${capture.settingsSource ?? 'not recorded'} |`,
    `| Light source profile | ${capture.lightSourceId ?? 'none'} |`,
    `| Lab style | ${capture.labStyleId ?? 'none'} |`,
    '',
    '| Metric | Result |',
    '| --- | ---: |',
    `| Mean CIEDE2000 | ${report.summary.meanDeltaE00.toFixed(3)} |`,
    `| Median CIEDE2000 | ${report.summary.medianDeltaE00.toFixed(3)} |`,
    `| 95th percentile | ${report.summary.p95DeltaE00.toFixed(3)} |`,
    `| Maximum | ${report.summary.maxDeltaE00.toFixed(3)} |`,
    `| Neutral mean | ${report.summary.neutralMeanDeltaE00?.toFixed(3) ?? 'n/a'} |`,
    `| Mean lightness error | ${report.summary.meanLightnessError.toFixed(3)} |`,
    `| Mean chroma error | ${report.summary.meanChromaError.toFixed(3)} |`,
    `| Mean hue error | ${report.summary.meanHueErrorDegrees?.toFixed(1) ?? 'n/a'}${report.summary.meanHueErrorDegrees === null ? '' : '°'} |`,
    '',
  );
  if (report.thresholds.length) {
    lines.push('## Thresholds', '', '| Metric | Actual | Limit | Result |', '| --- | ---: | ---: | --- |');
    for (const result of report.thresholds) {
      lines.push(`| ${result.metric} | ${result.actual} | ${result.limit} | ${result.passed ? 'PASS' : 'FAIL'} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Patches',
    '',
    '| Patch | Category | ΔE00 | ΔL* | ΔC* | Δh |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  for (const patch of [...report.patches].sort((a, b) => b.deltaE00 - a.deltaE00)) {
    lines.push(`| ${patch.name} | ${patch.category} | ${patch.deltaE00.toFixed(3)} | ${patch.lightnessError.toFixed(3)} | ${patch.chromaError.toFixed(3)} | ${patch.hueErrorDegrees === null ? 'n/a' : `${patch.hueErrorDegrees.toFixed(1)}°`} |`);
  }
  return `${lines.join('\n')}\n`;
}

function printHelp() {
  process.stdout.write(`Usage: npm run evaluate:color -- <dataset.json> [options]\n\nOptions:\n  --image <file.tif>   Sample normalized patch rectangles from an 8-bit sRGB TIFF\n  --format <markdown|json>\n  --output <filename>  Write the report instead of printing it\n  --help               Show this help\n`);
}

function parseArguments(argv) {
  const result = { format: 'markdown' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') result.help = true;
    else if (argument === '--image') result.image = argv[++index];
    else if (argument === '--format') result.format = argv[++index];
    else if (argument === '--output') result.output = argv[++index];
    else if (!result.dataset) result.dataset = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!['markdown', 'json'].includes(result.format)) throw new Error('Format must be markdown or json.');
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.dataset) {
    printHelp();
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const dataset = JSON.parse(await readFile(options.dataset, 'utf8'));
  const report = await evaluateDataset(dataset, { image: options.image });
  const output = options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatMarkdown(report);
  if (options.output) await writeFile(options.output, output);
  else process.stdout.write(output);
  if (report.passed === false) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Color evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
