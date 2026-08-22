import { resolveDustRemovalSettings } from '../constants';
import { ConversionSettings, CropSettings, DustMark } from '../types';
import { getTransformedDimensions, normalizeCrop } from './imagePipeline';
import { clamp } from './math';

export interface NormalizedPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawSourceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawZoomRegionPlan {
  displayRect: NormalizedPreviewRect;
  sourceRegion: RawSourceRegion;
  localCrop: CropSettings;
  maxDimension: number;
}

function intersectRects(left: DOMRectReadOnly, right: DOMRectReadOnly) {
  const x = Math.max(left.left, right.left);
  const y = Math.max(left.top, right.top);
  const rightEdge = Math.min(left.right, right.right);
  const bottomEdge = Math.min(left.bottom, right.bottom);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

export function getVisiblePreviewRect(
  canvasRect: DOMRectReadOnly,
  viewportRect: DOMRectReadOnly,
  overscanFraction = 0.15,
): NormalizedPreviewRect | null {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return null;
  const intersection = intersectRects(canvasRect, viewportRect);
  if (!intersection) return null;

  const visible = {
    x: (intersection.x - canvasRect.left) / canvasRect.width,
    y: (intersection.y - canvasRect.top) / canvasRect.height,
    width: intersection.width / canvasRect.width,
    height: intersection.height / canvasRect.height,
  };
  const padX = visible.width * overscanFraction;
  const padY = visible.height * overscanFraction;
  const x = clamp(visible.x - padX, 0, 1);
  const y = clamp(visible.y - padY, 0, 1);
  const right = clamp(visible.x + visible.width + padX, 0, 1);
  const bottom = clamp(visible.y + visible.height + padY, 0, 1);
  return {
    x,
    y,
    width: Math.max(0.0001, right - x),
    height: Math.max(0.0001, bottom - y),
  };
}

function inverseRotatePoint(
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
  rotatedWidth: number,
  rotatedHeight: number,
  radians: number,
) {
  const centeredX = x - rotatedWidth / 2;
  const centeredY = y - rotatedHeight / 2;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: cosine * centeredX + sine * centeredY + sourceWidth / 2,
    y: -sine * centeredX + cosine * centeredY + sourceHeight / 2,
  };
}

function clampCrop(crop: CropSettings): CropSettings {
  const x = clamp(crop.x, 0, 0.9999);
  const y = clamp(crop.y, 0, 0.9999);
  return {
    ...crop,
    x,
    y,
    width: clamp(crop.width, 0.0001, 1 - x),
    height: clamp(crop.height, 0.0001, 1 - y),
  };
}

export function planRawZoomRegion(options: {
  sourceWidth: number;
  sourceHeight: number;
  settings: ConversionSettings;
  displayRect: NormalizedPreviewRect;
  maxOutputDimension?: number;
}): RawZoomRegionPlan {
  const { sourceWidth, sourceHeight, settings, displayRect } = options;
  const angle = settings.rotation + settings.levelAngle;
  const radians = (angle * Math.PI) / 180;
  const rotated = getTransformedDimensions(sourceWidth, sourceHeight, angle);
  const crop = normalizeCrop(settings);
  const rotatedRect = {
    x: (crop.x + displayRect.x * crop.width) * rotated.width,
    y: (crop.y + displayRect.y * crop.height) * rotated.height,
    width: displayRect.width * crop.width * rotated.width,
    height: displayRect.height * crop.height * rotated.height,
  };
  const corners = [
    [rotatedRect.x, rotatedRect.y],
    [rotatedRect.x + rotatedRect.width, rotatedRect.y],
    [rotatedRect.x, rotatedRect.y + rotatedRect.height],
    [rotatedRect.x + rotatedRect.width, rotatedRect.y + rotatedRect.height],
  ].map(([x, y]) => inverseRotatePoint(
    x,
    y,
    sourceWidth,
    sourceHeight,
    rotated.width,
    rotated.height,
    radians,
  ));
  const minX = Math.min(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxX = Math.max(...corners.map((point) => point.x));
  const maxY = Math.max(...corners.map((point) => point.y));
  const padding = Math.max(8, Math.min(96, Math.ceil(Math.max(maxX - minX, maxY - minY) * 0.035)));
  const left = clamp(Math.floor(minX) - padding, 0, sourceWidth - 1);
  const top = clamp(Math.floor(minY) - padding, 0, sourceHeight - 1);
  const right = clamp(Math.ceil(maxX) + padding, left + 1, sourceWidth);
  const bottom = clamp(Math.ceil(maxY) + padding, top + 1, sourceHeight);
  const sourceRegion = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };

  const localRotated = getTransformedDimensions(sourceRegion.width, sourceRegion.height, angle);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerDeltaX = sourceWidth / 2 - (sourceRegion.x + sourceRegion.width / 2);
  const centerDeltaY = sourceHeight / 2 - (sourceRegion.y + sourceRegion.height / 2);
  const offsetX = cosine * centerDeltaX - sine * centerDeltaY
    + localRotated.width / 2 - rotated.width / 2;
  const offsetY = sine * centerDeltaX + cosine * centerDeltaY
    + localRotated.height / 2 - rotated.height / 2;
  const localCrop = clampCrop({
    x: (rotatedRect.x + offsetX) / localRotated.width,
    y: (rotatedRect.y + offsetY) / localRotated.height,
    width: rotatedRect.width / localRotated.width,
    height: rotatedRect.height / localRotated.height,
    aspectRatio: null,
  });

  return {
    displayRect,
    sourceRegion,
    localCrop,
    maxDimension: Math.min(
      options.maxOutputDimension ?? 4096,
      Math.max(sourceRegion.width, sourceRegion.height),
    ),
  };
}

function rebasePoint(
  point: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
  region: RawSourceRegion,
) {
  return {
    x: (point.x * sourceWidth - region.x) / region.width,
    y: (point.y * sourceHeight - region.y) / region.height,
  };
}

export function createRegionSettings(
  settings: ConversionSettings,
  sourceWidth: number,
  sourceHeight: number,
  plan: RawZoomRegionPlan,
): ConversionSettings {
  const dustRemoval = resolveDustRemovalSettings(settings.dustRemoval);
  const fullDiagonal = Math.hypot(sourceWidth, sourceHeight);
  const regionDiagonal = Math.hypot(plan.sourceRegion.width, plan.sourceRegion.height);
  const radiusScale = fullDiagonal / Math.max(1, regionDiagonal);
  const marks = dustRemoval.marks.reduce<DustMark[]>((result, mark) => {
    if (mark.kind === 'path') {
      const points = mark.points.map((point) => rebasePoint(
        point,
        sourceWidth,
        sourceHeight,
        plan.sourceRegion,
      ));
      if (!points.some((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
        return result;
      }
      result.push({
        ...mark,
        points,
        radius: mark.radius * radiusScale,
        ...(mark.widthAlongPath
          ? { widthAlongPath: mark.widthAlongPath.map((width) => width * radiusScale) }
          : {}),
      });
      return result;
    }

    const center = rebasePoint(
      { x: mark.cx, y: mark.cy },
      sourceWidth,
      sourceHeight,
      plan.sourceRegion,
    );
    const radius = mark.radius * radiusScale;
    if (center.x + radius < 0 || center.x - radius > 1 || center.y + radius < 0 || center.y - radius > 1) {
      return result;
    }
    result.push({ ...mark, cx: center.x, cy: center.y, radius });
    return result;
  }, []);

  return {
    ...structuredClone(settings),
    crop: plan.localCrop,
    dustRemoval: { ...dustRemoval, marks },
  };
}
