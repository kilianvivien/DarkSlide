import { ConversionSettings, DustMark } from '../types';
import { getCropPixelBounds, getTransformedDimensions, normalizeCrop } from './imagePipeline';
import { clamp } from './math';

function rotatePoint(x: number, y: number, radians: number) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: x * cosine - y * sine,
    y: x * sine + y * cosine,
  };
}

export function getDustGeometry(settings: ConversionSettings, imageWidth: number, imageHeight: number) {
  const rotation = settings.rotation + settings.levelAngle;
  const radians = (rotation * Math.PI) / 180;
  const rotated = getTransformedDimensions(imageWidth, imageHeight, rotation);
  const cropBounds = getCropPixelBounds(normalizeCrop(settings), rotated.width, rotated.height);
  return {
    radians,
    rotatedWidth: rotated.width,
    rotatedHeight: rotated.height,
    cropBounds,
    sourceDiagonal: Math.hypot(imageWidth, imageHeight),
    transformedDiagonal: Math.hypot(cropBounds.width, cropBounds.height),
  };
}

function sourcePointToRotatedPoint(
  nx: number,
  ny: number,
  imageWidth: number,
  imageHeight: number,
  rotatedWidth: number,
  rotatedHeight: number,
  radians: number,
) {
  const sourceX = nx * imageWidth - imageWidth / 2;
  const sourceY = ny * imageHeight - imageHeight / 2;
  const rotated = rotatePoint(sourceX, sourceY, radians);
  return {
    x: rotated.x + rotatedWidth / 2,
    y: rotated.y + rotatedHeight / 2,
  };
}

function rotatedPointToSourcePoint(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  rotatedWidth: number,
  rotatedHeight: number,
  radians: number,
) {
  const centeredX = x - rotatedWidth / 2;
  const centeredY = y - rotatedHeight / 2;
  const source = rotatePoint(centeredX, centeredY, -radians);
  return {
    x: (source.x + imageWidth / 2) / imageWidth,
    y: (source.y + imageHeight / 2) / imageHeight,
  };
}

export function projectDustMarksToTransformedSpace(
  marks: DustMark[],
  settings: ConversionSettings,
  imageWidth: number,
  imageHeight: number,
): DustMark[] {
  if (marks.length === 0) {
    return [];
  }

  const geometry = getDustGeometry(settings, imageWidth, imageHeight);
  return marks.reduce<DustMark[]>((result, mark) => {
    const pixelRadius = mark.radius * geometry.sourceDiagonal;
    const transformedPoints = mark.kind === 'path'
      ? mark.points.map((point) => sourcePointToRotatedPoint(
        point.x,
        point.y,
        imageWidth,
        imageHeight,
        geometry.rotatedWidth,
        geometry.rotatedHeight,
        geometry.radians,
      ))
      : [sourcePointToRotatedPoint(
        mark.cx,
        mark.cy,
        imageWidth,
        imageHeight,
        geometry.rotatedWidth,
        geometry.rotatedHeight,
        geometry.radians,
      )];

    const xs = transformedPoints.map((point) => point.x - geometry.cropBounds.x);
    const ys = transformedPoints.map((point) => point.y - geometry.cropBounds.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const withinHorizontal = maxX + pixelRadius >= 0 && minX - pixelRadius <= geometry.cropBounds.width;
    const withinVertical = maxY + pixelRadius >= 0 && minY - pixelRadius <= geometry.cropBounds.height;
    if (!withinHorizontal || !withinVertical) {
      return result;
    }

    if (mark.kind === 'path') {
      result.push({
        ...mark,
        points: transformedPoints.map((point) => ({
          x: (point.x - geometry.cropBounds.x) / geometry.cropBounds.width,
          y: (point.y - geometry.cropBounds.y) / geometry.cropBounds.height,
        })),
        radius: pixelRadius / geometry.transformedDiagonal,
      });
      return result;
    }

    result.push({
      ...mark,
      cx: xs[0] / geometry.cropBounds.width,
      cy: ys[0] / geometry.cropBounds.height,
      radius: pixelRadius / geometry.transformedDiagonal,
    });
    return result;
  }, []);
}

export function projectDustMarkFromTransformedSpace(
  mark: DustMark,
  settings: ConversionSettings,
  imageWidth: number,
  imageHeight: number,
): DustMark {
  const geometry = getDustGeometry(settings, imageWidth, imageHeight);
  const sourceRadius = clamp((mark.radius * geometry.transformedDiagonal) / geometry.sourceDiagonal, 0, 1);

  if (mark.kind === 'path') {
    return {
      ...mark,
      points: mark.points.map((point) => {
        const rotatedX = geometry.cropBounds.x + point.x * geometry.cropBounds.width;
        const rotatedY = geometry.cropBounds.y + point.y * geometry.cropBounds.height;
        return rotatedPointToSourcePoint(
          rotatedX,
          rotatedY,
          imageWidth,
          imageHeight,
          geometry.rotatedWidth,
          geometry.rotatedHeight,
          geometry.radians,
        );
      }).map((point) => ({
        x: clamp(point.x, 0, 1),
        y: clamp(point.y, 0, 1),
      })),
      radius: sourceRadius,
    };
  }

  const rotatedX = geometry.cropBounds.x + mark.cx * geometry.cropBounds.width;
  const rotatedY = geometry.cropBounds.y + mark.cy * geometry.cropBounds.height;
  const sourcePoint = rotatedPointToSourcePoint(
    rotatedX,
    rotatedY,
    imageWidth,
    imageHeight,
    geometry.rotatedWidth,
    geometry.rotatedHeight,
    geometry.radians,
  );

  return {
    ...mark,
    cx: clamp(sourcePoint.x, 0, 1),
    cy: clamp(sourcePoint.y, 0, 1),
    radius: sourceRadius,
  };
}
