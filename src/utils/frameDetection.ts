import { clamp } from './math';
import { CropSettings, DetectedFrame } from '../types';
import { rotateCropClockwise } from './imagePipeline';

const MAX_DETECTION_ANGLE = 5;
const MIN_FRAME_AREA = 0.2;
const MAX_FRAME_AREA = 0.98;
const MIN_CONFIDENCE = 3;
const ANGLE_SAMPLE_COUNT = 48;
const MIN_ABSOLUTE_PEAK_FACTOR = 10;
const EDGE_SEARCH_BAND_FRACTION = 0.18;
const CANDIDATE_THRESHOLD_SIGMA = 1.25;
const SMOOTHING_RADIUS_FRACTION = 0.006;
const MAX_SMOOTHING_RADIUS = 8;
const EDGE_CONTRAST_SCALE = 20;
const FULL_FRAME_35MM_ASPECT = 3 / 2;
const SCANNED_35MM_SHORT_EDGE_REBATE = 0.022;
// Sprocket holes confirm the format, but they do not justify discarding the
// full rebate width. The exposed gate in these camera scans starts about 4%
// inside the detected film outline. A larger fixed inset cut real image
// area on both long edges and made the loss swap sides after a 180deg turn.
const SCANNED_35MM_LONG_EDGE_REBATE = 0.04;
const COMMON_FILM_ASPECTS = [1, 7 / 6, 5 / 4, 4 / 3, 3 / 2];

type Peak = {
  index: number;
  value: number;
  score: number;
  contrast: number;
};

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Stabilize crops captured with one scanner setup without assuming a film
 * format. Frames are clustered by detected gate dimensions, so 6x6, 6x7,
 * 35mm, and other formats can coexist without sharing a crop model. Within a
 * cluster, robust median dimensions replace scene-dependent size outliers;
 * each frame retains its measured center to allow film-position movement.
 * `groupKeys` keeps frames apart that cannot share a model even when their
 * normalized sizes agree, such as scans with different pixel dimensions.
 */
export function stabilizeRollFrames(frames: DetectedFrame[], groupKeys?: readonly string[]) {
  if (frames.length < 3) return frames.map((frame) => ({ ...frame }));
  const parents = frames.map((_, index) => index);
  const find = (index: number): number => parents[index] === index
    ? index
    : (parents[index] = find(parents[index]));
  const join = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let left = 0; left < frames.length; left += 1) {
    const leftWidth = frames[left].right - frames[left].left;
    const leftHeight = frames[left].bottom - frames[left].top;
    for (let right = left + 1; right < frames.length; right += 1) {
      if (groupKeys && groupKeys[left] !== groupKeys[right]) continue;
      const rightWidth = frames[right].right - frames[right].left;
      const rightHeight = frames[right].bottom - frames[right].top;
      if (
        Math.abs(leftWidth - rightWidth) / Math.max(leftWidth, rightWidth, 1e-6) <= 0.1
        && Math.abs(leftHeight - rightHeight) / Math.max(leftHeight, rightHeight, 1e-6) <= 0.1
      ) join(left, right);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let index = 0; index < frames.length; index += 1) {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), index]);
  }

  return frames.map((frame, index) => {
    const cluster = clusters.get(find(index)) ?? [index];
    if (cluster.length < 3) return { ...frame };
    const width = median(cluster.map((member) => frames[member].right - frames[member].left));
    const height = median(cluster.map((member) => frames[member].bottom - frames[member].top));
    const centerX = (frame.left + frame.right) / 2;
    const centerY = (frame.top + frame.bottom) / 2;
    const left = clamp(centerX - width / 2, 0, 1 - width);
    const top = clamp(centerY - height / 2, 0, 1 - height);
    return { ...frame, left, top, right: left + width, bottom: top + height };
  });
}

export function detectFrame(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): DetectedFrame | null {
  if (height > width) {
    const canonical = detectFrameInternal(rotatePixelsClockwise(pixels, width, height), height, width, false);
    if (!canonical) return null;
    return {
      top: 1 - canonical.right,
      left: canonical.top,
      bottom: 1 - canonical.left,
      right: canonical.bottom,
      angle: canonical.angle,
      confidence: canonical.confidence,
    };
  }

  return detectFrameInternal(pixels, width, height, true);
}

function detectFrameInternal(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  useStableLandscape35mmRebate: boolean,
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
  const minimumPeakStrength = Math.min(width, height) * MIN_ABSOLUTE_PEAK_FACTOR;
  const hasStrongVerticalEdge = Math.max(leftPeak.value, rightPeak.value) >= minimumPeakStrength
    && Math.max(leftPeak.value, rightPeak.value) / xStats.sigma >= MIN_CONFIDENCE;
  const hasStrongHorizontalEdge = Math.max(topPeak.value, bottomPeak.value) >= minimumPeakStrength
    && Math.max(topPeak.value, bottomPeak.value) / yStats.sigma >= MIN_CONFIDENCE;
  const hasReliableCorner = hasStrongVerticalEdge && hasStrongHorizontalEdge;

  if (
    (!hasReliableCorner && confidence < MIN_CONFIDENCE)
    || frameArea < MIN_FRAME_AREA
    || frameArea > MAX_FRAME_AREA
    || (!hasReliableCorner && minPeakStrength < minimumPeakStrength)
  ) {
    return null;
  }

  let nextTop = top;
  let nextBottom = bottom;
  let nextLeft = left;
  let nextRight = right;

  const topSlope = findContinuousHorizontalEdgeSlope(gradientY, width, height, topPeak.index);
  const bottomSlope = findContinuousHorizontalEdgeSlope(gradientY, width, height, bottomPeak.index);
  const averageSlope = averageFinite(topSlope, bottomSlope);
  // Canvas rotation uses the same sign as the measured edge tilt, so leveling
  // must apply the inverse angle rather than rotating farther off-axis.
  let angle = clamp((-Math.atan(averageSlope) * 180) / Math.PI, -MAX_DETECTION_ANGLE, MAX_DETECTION_ANGLE);

  const detectedAspect = (right - left) * width / Math.max((bottom - top) * height, 1e-6);
  const isPlausibleFilmFrame = detectedAspect >= 0.7 && detectedAspect <= 2.1;
  if (isPlausibleFilmFrame) {
    let hasFilmEvidence = false;
    const sprocketSide = detectSprocketSide(grayscale, width, height, top, bottom, left, right);
    let innerLeft = findInnerFilmEdge(projectionX, leftPeak.index, 1, width, leftPeak.value);
    let innerRight = findInnerFilmEdge(projectionX, rightPeak.index, -1, width, rightPeak.value);
    // The rebate along a film strip's long edges can be considerably wider
    // than the end rebate, especially when sprocket holes are included.
    const innerTop = findInnerFilmEdge(projectionY, topPeak.index, 1, height, topPeak.value, 0.09);
    const innerBottom = findInnerFilmEdge(projectionY, bottomPeak.index, -1, height, bottomPeak.value, 0.09);
    const innerEdgeCount = [innerLeft, innerRight, innerTop, innerBottom]
      .filter((edge) => edge !== null).length;
    if (innerEdgeCount >= (sprocketSide !== null ? 2 : 3)) {
      hasFilmEvidence = true;
      // Once multiple rebate edges or sprockets confirm that this is film,
      // allow the end-edge search to span a wider unexposed leader/rebate.
      innerLeft = findInnerFilmEdge(projectionX, leftPeak.index, 1, width, leftPeak.value, 0.12);
      innerRight = findInnerFilmEdge(projectionX, rightPeak.index, -1, width, rightPeak.value, 0.12);
      if (innerLeft !== null) nextLeft = refinePeak(projectionX, innerLeft) / Math.max(1, width - 1);
      if (innerRight !== null) nextRight = refinePeak(projectionX, innerRight) / Math.max(1, width - 1);
      if (innerTop !== null) nextTop = refinePeak(projectionY, innerTop) / Math.max(1, height - 1);
      if (innerBottom !== null) nextBottom = refinePeak(projectionY, innerBottom) / Math.max(1, height - 1);

      if (innerTop !== null && innerBottom !== null) {
        const innerTopSlope = findContinuousHorizontalEdgeSlope(gradientY, width, height, innerTop);
        const innerBottomSlope = findContinuousHorizontalEdgeSlope(gradientY, width, height, innerBottom);
        const innerSlope = averageFinite(innerTopSlope, innerBottomSlope);
        const innerAngle = clamp((-Math.atan(innerSlope) * 180) / Math.PI, -MAX_DETECTION_ANGLE, MAX_DETECTION_ANGLE);
        if (Math.abs(innerAngle - angle) <= 2) angle = innerAngle;
      }

      if (sprocketSide !== null) {
      // Camera-scanned 35mm strips commonly show a pale rebate and sprocket
      // holes on both long edges. Even when one inner boundary has weak scene
      // contrast, never leave that known rebate in the automatic crop.
      const longEdgeInset = 0.045;
      const shortEdgeInset = 0.012;
      const xInset = shortEdgeInset;
      const yInset = longEdgeInset;
      const leftDominates = leftPeak.value > rightPeak.value * 2;
      const rightDominates = rightPeak.value > leftPeak.value * 2;
      if (rightDominates) {
        nextLeft = left;
        nextRight = Math.min(nextRight, right - xInset);
      } else if (leftDominates) {
        nextLeft = Math.max(nextLeft, left + xInset);
        nextRight = right;
      } else {
        nextLeft = Math.max(nextLeft, left + xInset);
        nextRight = Math.min(nextRight, right - xInset);
      }
      const topDominates = topPeak.value > bottomPeak.value * 2;
      const bottomDominates = bottomPeak.value > topPeak.value * 2;
      if (bottomDominates) {
        // A bright rebate exists only on the bottom side. Preserve the weak
        // opposite boundary instead of mistaking dark scene detail for rebate.
        nextTop = top;
        nextBottom = Math.min(nextBottom, bottom - yInset);
      } else if (topDominates) {
        nextTop = Math.max(nextTop, top + yInset);
        nextBottom = bottom;
      } else {
        nextTop = Math.max(nextTop, top + yInset);
        nextBottom = Math.min(nextBottom, bottom - yInset);
      }

      // The first long-edge transition is often the rebate/sprocket boundary,
      // not yet the exposed image. Step just inside it so a thin film edge is
      // not retained (this is the right edge after mapping portrait scans back).
      const innerLongEdgeInset = 0.003;
      if (innerTop !== null && !bottomDominates) {
        nextTop = Math.max(nextTop, innerTop / Math.max(1, height - 1) + innerLongEdgeInset);
      }
      if (innerBottom !== null && !topDominates) {
        nextBottom = Math.min(nextBottom, innerBottom / Math.max(1, height - 1) - innerLongEdgeInset);
      }
      }
    }

    const inset = 0.012;
    if (sprocketSide === 'top') {
      nextTop = clamp(nextTop + inset, 0, nextBottom - 0.01);
    } else if (sprocketSide === 'bottom') {
      nextBottom = clamp(nextBottom - inset, nextTop + 0.01, 1);
    } else if (sprocketSide === 'left') {
      nextLeft = clamp(nextLeft + inset, 0, nextRight - 0.01);
    } else if (sprocketSide === 'right') {
      nextRight = clamp(nextRight - inset, nextLeft + 0.01, 1);
    }

    if (sprocketSide !== null && useStableLandscape35mmRebate) {
      // Once the repeated sprocket pattern confirms full-frame 35mm, the film
      // outline is more reliable than scene-dependent transitions inside the
      // exposure. Camera scanning keeps these rebate distances stable across
      // a roll, so derive the gate from the outer film rectangle. This prevents
      // a bright wall, tree, or bookshelf from moving one crop edge inward.
      nextLeft = left + SCANNED_35MM_SHORT_EDGE_REBATE;
      nextRight = right - SCANNED_35MM_SHORT_EDGE_REBATE;
      nextTop = top + SCANNED_35MM_LONG_EDGE_REBATE;
      nextBottom = bottom - SCANNED_35MM_LONG_EDGE_REBATE;
    }

    if (hasFilmEvidence && sprocketSide !== null) {
      // A format check is useful for rejecting one bad edge, but forcing the
      // nominal ratio can expand equally reliable edges back into sprockets.
      // The opposite edge supplies the conservative expansion limit: an edge
      // may move outward only until both rebate insets agree.
      const xRebate = Math.min(nextLeft - left, right - nextRight);
      const yRebate = Math.max(
        Math.min(nextTop - top, bottom - nextBottom),
        sprocketSide !== null ? SCANNED_35MM_LONG_EDGE_REBATE : 0,
      );
      const guarded = expandFrameToAspect({
        top: nextTop,
        left: nextLeft,
        bottom: nextBottom,
        right: nextRight,
      }, {
        top: top + Math.max(0, yRebate),
        left: left + Math.max(0, xRebate),
        bottom: bottom - Math.max(0, yRebate),
        right: right - Math.max(0, xRebate),
      }, width, height, FULL_FRAME_35MM_ASPECT);
      nextTop = guarded.top;
      nextLeft = guarded.left;
      nextBottom = guarded.bottom;
      nextRight = guarded.right;
    } else if (hasFilmEvidence) {
      const innerAspect = (nextRight - nextLeft) * width
        / Math.max((nextBottom - nextTop) * height, 1e-6);
      const candidates = COMMON_FILM_ASPECTS.flatMap((aspect) => [aspect, 1 / aspect]);
      const targetAspect = candidates.reduce((best, candidate) => (
        Math.abs(Math.log(candidate / detectedAspect)) < Math.abs(Math.log(best / detectedAspect))
          ? candidate
          : best
      ));
      if (Math.abs(Math.log(targetAspect / innerAspect)) <= Math.log(1.12)) {
        const guarded = expandFrameToAspect({
          top: nextTop,
          left: nextLeft,
          bottom: nextBottom,
          right: nextRight,
        }, { top, left, bottom, right }, width, height, targetAspect);
        nextTop = guarded.top;
        nextLeft = guarded.left;
        nextBottom = guarded.bottom;
        nextRight = guarded.right;
      }
    }
  }

  // A format prior may recover image area but must never remove it. This final
  // guard is intentionally expansion-only and does not require sprockets, so
  // it also supports 126 and medium-format gates. Near-square detections are
  // treated as square before considering the denser 6x7/6x6 family.
  const finalAspect = (nextRight - nextLeft) * width
    / Math.max((nextBottom - nextTop) * height, 1e-6);
  const canonicalAspect = Math.max(finalAspect, 1 / finalAspect);
  if (canonicalAspect <= 1.12) {
    const targetAspect = 1;
    const guarded = expandFrameToAspect({
      top: nextTop,
      left: nextLeft,
      bottom: nextBottom,
      right: nextRight,
    }, { top: 0, left: 0, bottom: 1, right: 1 }, width, height, targetAspect);
    nextTop = guarded.top;
    nextLeft = guarded.left;
    nextBottom = guarded.bottom;
    nextRight = guarded.right;
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

export function expandFrameToAspect(
  frame: Pick<DetectedFrame, 'top' | 'left' | 'bottom' | 'right'>,
  limits: Pick<DetectedFrame, 'top' | 'left' | 'bottom' | 'right'>,
  imageWidth: number,
  imageHeight: number,
  targetAspect: number,
) {
  let { top, left, bottom, right } = frame;
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const cropWidth = Math.max(0.01, right - left);
  const cropHeight = Math.max(0.01, bottom - top);
  const currentAspect = cropWidth * width / (cropHeight * height);

  if (currentAspect < targetAspect) {
    const wantedWidth = targetAspect * cropHeight * height / width;
    const expansion = Math.max(0, wantedWidth - cropWidth);
    const leftRoom = Math.max(0, left - limits.left);
    const rightRoom = Math.max(0, limits.right - right);
    const addLeft = Math.min(leftRoom, expansion / 2);
    const addRight = Math.min(rightRoom, expansion - addLeft);
    left -= addLeft;
    right += addRight;
    const remainder = expansion - addLeft - addRight;
    if (remainder > 0) left -= Math.min(left - limits.left, remainder);
  } else if (currentAspect > targetAspect) {
    const wantedHeight = cropWidth * width / (targetAspect * height);
    const expansion = Math.max(0, wantedHeight - cropHeight);
    const topRoom = Math.max(0, top - limits.top);
    const bottomRoom = Math.max(0, limits.bottom - bottom);
    const addTop = Math.min(topRoom, expansion / 2);
    const addBottom = Math.min(bottomRoom, expansion - addTop);
    top -= addTop;
    bottom += addBottom;
    const remainder = expansion - addTop - addBottom;
    if (remainder > 0) top -= Math.min(top - limits.top, remainder);
  }

  return { top, left, bottom, right };
}

export function getLeveledFrameCrop(
  frame: DetectedFrame,
  imageWidth: number,
  imageHeight: number,
): CropSettings {
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const radians = (frame.angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotatedWidth = Math.abs(width * cosine) + Math.abs(height * sine);
  const rotatedHeight = Math.abs(width * sine) + Math.abs(height * cosine);
  const centerX = width / 2;
  const centerY = height / 2;

  const rotate = (x: number, y: number) => {
    const dx = x - centerX;
    const dy = y - centerY;
    return {
      x: dx * cosine - dy * sine + rotatedWidth / 2,
      y: dx * sine + dy * cosine + rotatedHeight / 2,
    };
  };

  const topLeft = rotate(frame.left * width, frame.top * height);
  const topRight = rotate(frame.right * width, frame.top * height);
  const bottomLeft = rotate(frame.left * width, frame.bottom * height);
  const bottomRight = rotate(frame.right * width, frame.bottom * height);
  const left = Math.max(topLeft.x, bottomLeft.x) / rotatedWidth;
  const right = Math.min(topRight.x, bottomRight.x) / rotatedWidth;
  const top = Math.max(topLeft.y, topRight.y) / rotatedHeight;
  const bottom = Math.min(bottomLeft.y, bottomRight.y) / rotatedHeight;

  return {
    x: clamp(left, 0, 0.99),
    y: clamp(top, 0, 0.99),
    width: clamp(right - left, 0.01, 1),
    height: clamp(bottom - top, 0.01, 1),
    aspectRatio: null,
  };
}

export function getOrientedFrameCrop(
  frame: DetectedFrame,
  imageWidth: number,
  imageHeight: number,
  rotation: number,
) {
  let crop = getLeveledFrameCrop(frame, imageWidth, imageHeight);
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const quarterTurns = Math.abs(normalizedRotation / 90 - Math.round(normalizedRotation / 90)) < 1e-6
    ? Math.round(normalizedRotation / 90) % 4
    : 0;

  for (let turn = 0; turn < quarterTurns; turn += 1) {
    crop = rotateCropClockwise(crop);
  }

  return crop;
}

/**
 * Map the detected image gate into the displayed orientation without applying
 * the detector's fine-angle estimate. Automatic leveling proved too fragile
 * on low-contrast negatives and caused the inscribed crop to discard valid
 * image area. Fine rotation remains an explicit manual adjustment: when the
 * document already has a level angle, the gate is mapped through it so the
 * crop still covers the same source region.
 */
export function getAutoFrameCrop(
  frame: DetectedFrame,
  rotation: number,
  levelAngle = 0,
  sourceWidth = 1,
  sourceHeight = 1,
) {
  if (Math.abs(levelAngle) >= 0.01) {
    return getOrientedFrameCrop({ ...frame, angle: levelAngle }, sourceWidth, sourceHeight, rotation);
  }

  let crop: CropSettings = {
    x: clamp(frame.left, 0, 0.99),
    y: clamp(frame.top, 0, 0.99),
    width: clamp(frame.right - frame.left, 0.01, 1),
    height: clamp(frame.bottom - frame.top, 0.01, 1),
    aspectRatio: null,
  };
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const quarterTurns = Math.abs(normalizedRotation / 90 - Math.round(normalizedRotation / 90)) < 1e-6
    ? Math.round(normalizedRotation / 90) % 4
    : 0;

  for (let turn = 0; turn < quarterTurns; turn += 1) crop = rotateCropClockwise(crop);
  return crop;
}

function findInnerFilmEdge(
  profile: Float32Array,
  outerIndex: number,
  direction: 1 | -1,
  axisLength: number,
  outerStrength: number,
  maxInsetFraction = 0.065,
) {
  const minInset = Math.max(2, Math.round(axisLength * 0.008));
  const maxInset = Math.max(minInset + 1, Math.round(axisLength * maxInsetFraction));
  const candidates: Array<{ index: number; value: number }> = [];

  for (let inset = minInset; inset <= maxInset; inset += 1) {
    const index = outerIndex + direction * inset;
    if (index <= 0 || index >= profile.length - 1 || !isLocalMaximum(profile, index)) continue;
    if (profile[index] >= outerStrength * 0.12) candidates.push({ index, value: profile[index] });
  }

  if (candidates.length === 0) return null;

  // The image-gate boundary is the first continuous transition after the
  // outer film edge. Interior scene detail can be much stronger, so choosing
  // the absolute maximum across the whole band can discard part of the photo.
  // Ignore tiny early ripples, then take the nearest credible peak.
  const strongest = Math.max(...candidates.map((candidate) => candidate.value));
  const credibleStrength = Math.max(outerStrength * 0.12, strongest * 0.25);
  return candidates.find((candidate) => candidate.value >= credibleStrength)?.index
    ?? candidates.reduce((best, candidate) => candidate.value > best.value ? candidate : best).index;
}

function rotatePixelsClockwise(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const rotatedWidth = height;
  const rotated = new Uint8ClampedArray(pixels.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const rotatedX = height - 1 - y;
      const rotatedY = x;
      const targetOffset = (rotatedY * rotatedWidth + rotatedX) * 4;
      rotated[targetOffset] = pixels[sourceOffset];
      rotated[targetOffset + 1] = pixels[sourceOffset + 1];
      rotated[targetOffset + 2] = pixels[sourceOffset + 2];
      rotated[targetOffset + 3] = pixels[sourceOffset + 3];
    }
  }

  return rotated;
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

function findContinuousHorizontalEdgeSlope(
  gradientY: Float32Array,
  width: number,
  height: number,
  approxY: number,
) {
  const xStart = Math.max(1, Math.floor(width * 0.1));
  const xEnd = Math.min(width - 2, Math.ceil(width * 0.9));
  const searchRadius = Math.max(2, Math.round(height * 0.03));
  const centerX = (xStart + xEnd) / 2;
  let bestSlope = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  // A film boundary runs across nearly the full scan. Sprocket holes and scene
  // detail can have much stronger gradients, but only over short sections. A
  // lower-quartile line score rewards continuity instead of a few bright peaks.
  for (let angle = -MAX_DETECTION_ANGLE; angle <= MAX_DETECTION_ANGLE + 1e-6; angle += 0.1) {
    const slope = Math.tan((angle * Math.PI) / 180);
    for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
      const strengths: number[] = [];
      for (let sample = 0; sample < ANGLE_SAMPLE_COUNT; sample += 1) {
        const t = sample / (ANGLE_SAMPLE_COUNT - 1);
        const x = Math.round(xStart + (xEnd - xStart) * t);
        const lineY = Math.round(approxY + offset + slope * (x - centerX));
        const y = clamp(lineY, 1, height - 2);
        strengths.push(gradientY[y * width + x]);
      }
      strengths.sort((left, right) => left - right);
      const continuity = strengths[Math.floor(strengths.length * 0.25)] ?? 0;
      const score = continuity - Math.abs(offset) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        bestSlope = slope;
      }
    }
  }

  return bestSlope;
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
    const expectedSpacings = [width / 24, width / 12, width / 10, width / 9, width / 8];
    const topScore = sprocketPatternScore(topProfile, expectedSpacings);
    const bottomScore = sprocketPatternScore(bottomProfile, expectedSpacings);

    if (topScore >= 3 && topScore > bottomScore) {
      return 'top' as const;
    }
    if (bottomScore >= 3 && bottomScore > topScore) {
      return 'bottom' as const;
    }
    if (topScore >= 3 && bottomScore >= 3) {
      return 'both' as const;
    }
    return null;
  }

  const leftProfile = extractVerticalBandProfile(grayscale, width, height, left, 0.035);
  const rightProfile = extractVerticalBandProfile(grayscale, width, height, right, 0.035);
  const expectedSpacings = [height / 24, height / 12, height / 10, height / 9, height / 8];
  const leftScore = sprocketPatternScore(leftProfile, expectedSpacings);
  const rightScore = sprocketPatternScore(rightProfile, expectedSpacings);

  if (leftScore >= 3 && leftScore > rightScore) {
    return 'left' as const;
  }
  if (rightScore >= 3 && rightScore > leftScore) {
    return 'right' as const;
  }
  if (leftScore >= 3 && rightScore >= 3) {
    return 'both' as const;
  }

  return null;
}

function sprocketPatternScore(profile: Float32Array, expectedSpacings: number[]) {
  let score = 0;
  for (const spacing of expectedSpacings) {
    score = Math.max(score, periodicPeakScore(profile, spacing), brightRunScore(profile, spacing));
  }
  return score;
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
