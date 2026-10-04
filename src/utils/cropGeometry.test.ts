import { describe, expect, it } from 'vitest';
import type { CropSettings, DetectedFrame } from '../types';
import { getAutoFrameCrop } from './frameDetection';
import { rotateCropClockwise } from './imagePipeline';

// Inverts the worker's renderTransformedCanvas: the source is drawn centred
// into an expanded canvas after ctx.rotate(angle), and the normalized crop is
// read from that canvas. Returns the source pixel under a crop-space point.
function sourcePointFor(
  point: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
  angleDegrees: number,
) {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const canvasWidth = Math.abs(sourceWidth * cos) + Math.abs(sourceHeight * sin);
  const canvasHeight = Math.abs(sourceWidth * sin) + Math.abs(sourceHeight * cos);
  const px = point.x * canvasWidth - canvasWidth / 2;
  const py = point.y * canvasHeight - canvasHeight / 2;
  return {
    x: px * cos + py * sin + sourceWidth / 2,
    y: -px * sin + py * cos + sourceHeight / 2,
  };
}

function cropCorners(crop: CropSettings) {
  return [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x, y: crop.y + crop.height },
    { x: crop.x + crop.width, y: crop.y + crop.height },
  ];
}

function sourceCorners(crop: CropSettings, sourceWidth: number, sourceHeight: number, angle: number) {
  return cropCorners(crop)
    .map((corner) => sourcePointFor(corner, sourceWidth, sourceHeight, angle))
    .map(({ x, y }) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const SOURCES: Array<[number, number]> = [[3000, 2000], [2000, 3000], [2400, 2400]];
const ROTATIONS = [0, 90, 180, 270];

describe('rotateCropClockwise against the render transform', () => {
  const crop: CropSettings = { x: 0.12, y: 0.21, width: 0.33, height: 0.4, aspectRatio: null };

  for (const [sourceWidth, sourceHeight] of SOURCES) {
    for (const rotation of ROTATIONS) {
      for (const levelAngle of [0, 1.5, -2.25]) {
        it(`keeps the same source region for ${sourceWidth}x${sourceHeight} at ${rotation}° + ${levelAngle}°`, () => {
          const before = sourceCorners(crop, sourceWidth, sourceHeight, rotation + levelAngle);
          const after = sourceCorners(rotateCropClockwise(crop), sourceWidth, sourceHeight, rotation + 90 + levelAngle);
          expect(after).toEqual(before);
        });
      }
    }
  }

  it('returns to the original crop after four quarter turns', () => {
    let rotated = crop;
    for (let turn = 0; turn < 4; turn += 1) rotated = rotateCropClockwise(rotated);
    expect(rotated.x).toBeCloseTo(crop.x, 10);
    expect(rotated.y).toBeCloseTo(crop.y, 10);
    expect(rotated.width).toBeCloseTo(crop.width, 10);
    expect(rotated.height).toBeCloseTo(crop.height, 10);
  });
});

describe('getAutoFrameCrop against the render transform', () => {
  // Detected frames are measured on the unrotated source preview.
  const frame: DetectedFrame = { left: 0.08, top: 0.11, right: 0.9, bottom: 0.86, angle: -1.8, confidence: 8 };

  for (const [sourceWidth, sourceHeight] of SOURCES) {
    for (const rotation of ROTATIONS) {
      it(`covers exactly the detected gate for ${sourceWidth}x${sourceHeight} at ${rotation}°`, () => {
        const crop = getAutoFrameCrop(frame, rotation);
        const corners = sourceCorners(crop, sourceWidth, sourceHeight, rotation);
        const expected = [
          [frame.left * sourceWidth, frame.top * sourceHeight],
          [frame.left * sourceWidth, frame.bottom * sourceHeight],
          [frame.right * sourceWidth, frame.top * sourceHeight],
          [frame.right * sourceWidth, frame.bottom * sourceHeight],
        ].map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
        expect(corners).toEqual(expected);
      });

      it(`stays inside the gate with a manual level angle for ${sourceWidth}x${sourceHeight} at ${rotation}°`, () => {
        const levelAngle = 2;
        const crop = getAutoFrameCrop(frame, rotation, levelAngle, sourceWidth, sourceHeight);
        const tolerance = 0.5;
        for (const corner of cropCorners(crop)) {
          const point = sourcePointFor(corner, sourceWidth, sourceHeight, rotation + levelAngle);
          expect(point.x).toBeGreaterThanOrEqual(frame.left * sourceWidth - tolerance);
          expect(point.x).toBeLessThanOrEqual(frame.right * sourceWidth + tolerance);
          expect(point.y).toBeGreaterThanOrEqual(frame.top * sourceHeight - tolerance);
          expect(point.y).toBeLessThanOrEqual(frame.bottom * sourceHeight + tolerance);
        }
        // Inscribing loses only a sliver of the gate at small angles.
        expect(crop.width * crop.height).toBeGreaterThan(0.8 * (frame.right - frame.left) * (frame.bottom - frame.top));
      });
    }
  }
});
