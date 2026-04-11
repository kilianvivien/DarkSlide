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
  return marks.flatMap((mark) => {
    const rotated = sourcePointToRotatedPoint(
      mark.cx,
      mark.cy,
      imageWidth,
      imageHeight,
      geometry.rotatedWidth,
      geometry.rotatedHeight,
      geometry.radians,
    );
    const pixelRadius = mark.radius * geometry.sourceDiagonal;
    const croppedX = rotated.x - geometry.cropBounds.x;
    const croppedY = rotated.y - geometry.cropBounds.y;
    const withinHorizontal = croppedX + pixelRadius >= 0 && croppedX - pixelRadius <= geometry.cropBounds.width;
    const withinVertical = croppedY + pixelRadius >= 0 && croppedY - pixelRadius <= geometry.cropBounds.height;
    if (!withinHorizontal || !withinVertical) {
      return [];
    }

    return [{
      ...mark,
      cx: croppedX / geometry.cropBounds.width,
      cy: croppedY / geometry.cropBounds.height,
      radius: pixelRadius / geometry.transformedDiagonal,
    }];
  });
}

export function projectDustMarkFromTransformedSpace(
  mark: Omit<DustMark, 'cx' | 'cy' | 'radius'> & { cx: number; cy: number; radius: number },
  settings: ConversionSettings,
  imageWidth: number,
  imageHeight: number,
): DustMark {
  const geometry = getDustGeometry(settings, imageWidth, imageHeight);
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
    radius: clamp((mark.radius * geometry.transformedDiagonal) / geometry.sourceDiagonal, 0, 1),
  };
}
