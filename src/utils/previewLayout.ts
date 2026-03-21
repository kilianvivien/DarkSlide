import { CropSettings } from '../types';

const CROP_TOLERANCE = 0.0001;

export const CROP_OVERLAY_HANDLE_SAFE_PADDING = 56;

interface ComputeViewportFitScaleOptions {
  viewportWidth: number;
  viewportHeight: number;
  previewWidth: number;
  previewHeight: number;
  overlayPadding?: number;
}

export function computeViewportFitScale({
  viewportWidth,
  viewportHeight,
  previewWidth,
  previewHeight,
  overlayPadding = 0,
}: ComputeViewportFitScaleOptions) {
  const safeViewportWidth = Math.max(1, viewportWidth - overlayPadding * 2);
  const safeViewportHeight = Math.max(1, viewportHeight - overlayPadding * 2);
  const safePreviewWidth = Math.max(1, previewWidth);
  const safePreviewHeight = Math.max(1, previewHeight);

  return Math.min(
    safeViewportWidth / safePreviewWidth,
    safeViewportHeight / safePreviewHeight,
    1,
  );
}

export function isFullFrameFreeCrop(crop: CropSettings) {
  return crop.aspectRatio === null
    && Math.abs(crop.x) <= CROP_TOLERANCE
    && Math.abs(crop.y) <= CROP_TOLERANCE
    && Math.abs(1 - crop.width) <= CROP_TOLERANCE
    && Math.abs(1 - crop.height) <= CROP_TOLERANCE;
}
