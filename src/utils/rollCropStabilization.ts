import { appendDocumentHistory } from '../hooks/useDocumentTabs';
import type { DetectedFrame, DocumentTab } from '../types';
import { getAutoFrameCrop, stabilizeRollFrames } from './frameDetection';

export interface RollFrameMeasurement {
  id: string;
  /** Frame measured on the unrotated source, or null when none was found. */
  frame: DetectedFrame | null;
  sourceWidth: number;
  sourceHeight: number;
}

export interface RollFramePlan {
  /** Stabilized frames, still in unrotated source coordinates. */
  frames: Map<string, DetectedFrame>;
  undetectedIds: string[];
}

/**
 * Frames can only share a crop model when they come from scans of the same
 * pixel size: normalized gate sizes are meaningless across different scales
 * or orientations. Grouping never assumes the whole roll shares a format.
 */
function groupKey(measurement: RollFrameMeasurement) {
  return `${Math.round(measurement.sourceWidth)}x${Math.round(measurement.sourceHeight)}`;
}

export function planRollFrames(measurements: RollFrameMeasurement[]): RollFramePlan {
  const detected = measurements.filter((measurement): measurement is RollFrameMeasurement & { frame: DetectedFrame } => (
    measurement.frame !== null
  ));
  const stabilized = stabilizeRollFrames(
    detected.map((measurement) => measurement.frame),
    detected.map(groupKey),
  );

  return {
    frames: new Map(detected.map((measurement, index) => [measurement.id, stabilized[index]])),
    undetectedIds: measurements.filter((measurement) => measurement.frame === null).map((measurement) => measurement.id),
  };
}

/**
 * Applies a stabilized frame to one tab as a single undo step. Manual crops
 * are left alone unless the user explicitly chose to include them.
 */
export function applyStabilizedFrameToTab(
  tab: DocumentTab,
  frame: DetectedFrame,
  includeManual: boolean,
): DocumentTab {
  if (!includeManual && tab.document.cropSource === 'manual') {
    return tab;
  }

  // Record the pre-change state first, so one undo restores it even if the
  // tab's last edit had not been committed to history yet.
  const before = appendDocumentHistory(tab);
  const { settings, source } = before.document;
  return appendDocumentHistory({
    ...before,
    document: {
      ...before.document,
      settings: {
        ...settings,
        crop: getAutoFrameCrop(frame, settings.rotation, settings.levelAngle, source.width, source.height),
      },
      cropSource: 'auto',
      dirty: true,
    },
  });
}
