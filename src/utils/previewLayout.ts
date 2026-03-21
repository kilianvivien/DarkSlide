import { CropSettings, PreviewLevel } from '../types';
import { selectPreviewLevel } from './imagePipeline';

const CROP_TOLERANCE = 0.0001;
const PREVIEW_LEVEL_HYSTERESIS = 0.1;
const SOURCE_LEVEL_PROMOTION_RATIO = 0.92;
const SOURCE_LEVEL_DEMOTION_RATIO = 0.84;

export const CROP_OVERLAY_HANDLE_SAFE_PADDING = 56;

export interface RenderTargetSelectionState {
  previewLevelId: string;
  targetDimension: number;
}

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

export function resolveRenderTargetSelection(
  levels: PreviewLevel[],
  targetDimension: number,
  previous: RenderTargetSelectionState | null,
  interactionJustEnded: boolean,
) {
  const ordered = [...levels].sort((left, right) => left.maxDimension - right.maxDimension);
  const sourceLevel = ordered.at(-1) ?? null;
  const penultimateLevel = ordered.length > 1 ? ordered[ordered.length - 2] : null;
  let resolvedTargetDimension = targetDimension;
  let selected = selectPreviewLevel(ordered, targetDimension);

  if (sourceLevel && penultimateLevel && selected.id === sourceLevel.id) {
    const sourcePromotionThreshold = sourceLevel.maxDimension * SOURCE_LEVEL_PROMOTION_RATIO;
    const sourceDemotionThreshold = sourceLevel.maxDimension * SOURCE_LEVEL_DEMOTION_RATIO;
    const previousIsSource = previous?.previewLevelId === sourceLevel.id;
    const shouldHoldPenultimate = previousIsSource
      ? targetDimension < sourceDemotionThreshold
      : targetDimension < sourcePromotionThreshold;

    if (shouldHoldPenultimate) {
      selected = penultimateLevel;
      resolvedTargetDimension = Math.min(targetDimension, penultimateLevel.maxDimension);
    }
  }

  if (interactionJustEnded || !previous) {
    return {
      previewLevelId: selected.id,
      targetDimension: resolvedTargetDimension,
    } satisfies RenderTargetSelectionState;
  }

  const previousIndex = ordered.findIndex((level) => level.id === previous.previewLevelId);
  const selectedIndex = ordered.findIndex((level) => level.id === selected.id);

  if (previousIndex < 0 || selectedIndex < 0) {
    return {
      previewLevelId: selected.id,
      targetDimension: resolvedTargetDimension,
    } satisfies RenderTargetSelectionState;
  }

  if (previousIndex === selectedIndex) {
    return previous;
  }

  if (selectedIndex > previousIndex) {
    const thresholdLevel = ordered[selectedIndex - 1];
    if (targetDimension < thresholdLevel.maxDimension * (1 + PREVIEW_LEVEL_HYSTERESIS)) {
      return previous;
    }
  } else {
    const thresholdLevel = ordered[selectedIndex];
    if (targetDimension > thresholdLevel.maxDimension * (1 - PREVIEW_LEVEL_HYSTERESIS)) {
      return previous;
    }
  }

  return {
    previewLevelId: selected.id,
    targetDimension: resolvedTargetDimension,
  } satisfies RenderTargetSelectionState;
}
