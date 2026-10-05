import type { ConversionSettings } from '../types';

/**
 * Copies a frame's look onto another frame while keeping what belongs to
 * each individual frame: its crop, rotation, level angle, and dust repairs.
 */
export function mergeSyncedSettings(source: ConversionSettings, target: ConversionSettings): ConversionSettings {
  const next = structuredClone(source);
  next.crop = structuredClone(target.crop);
  next.rotation = target.rotation;
  next.levelAngle = target.levelAngle;
  if (source.dustRemoval || target.dustRemoval) {
    next.dustRemoval = source.dustRemoval
      ? { ...structuredClone(source.dustRemoval), marks: structuredClone(target.dustRemoval?.marks ?? []) }
      : structuredClone(target.dustRemoval);
  }
  return next;
}
