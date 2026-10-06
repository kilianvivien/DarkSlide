import { beforeEach, describe, expect, it } from 'vitest';
import type { FlatFieldProfile } from './flatField';
import {
  clearFlatField,
  getActiveFlatFieldProfile,
  getFlatFieldState,
  resetFlatFieldStoreForTests,
  setFlatFieldEnabled,
  setFlatFieldProfile,
  subscribeFlatField,
} from './flatFieldStore';

const profile: FlatFieldProfile = {
  version: 1,
  name: 'flat.nef',
  width: 6048,
  height: 4032,
  gridWidth: 2,
  gridHeight: 2,
  gains: new Array(12).fill(1.1),
  maxCorrectionStops: 0.14,
  createdAt: 1,
};

describe('flatFieldStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFlatFieldStoreForTests();
  });

  it('is off until a reference is chosen', () => {
    expect(getFlatFieldState()).toEqual({ enabled: false, profile: null });
    expect(getActiveFlatFieldProfile()).toBeNull();
  });

  it('enables a new reference and persists it across reloads', () => {
    setFlatFieldProfile(profile);
    expect(getActiveFlatFieldProfile()).toEqual(profile);

    resetFlatFieldStoreForTests();
    expect(getFlatFieldState()).toEqual({ enabled: true, profile });
  });

  it('keeps the reference when turned off, and drops it when removed', () => {
    let notified = 0;
    subscribeFlatField(() => { notified += 1; });
    setFlatFieldProfile(profile);
    setFlatFieldEnabled(false);
    expect(getActiveFlatFieldProfile()).toBeNull();
    expect(getFlatFieldState().profile).toEqual(profile);

    clearFlatField();
    resetFlatFieldStoreForTests();
    expect(getFlatFieldState()).toEqual({ enabled: false, profile: null });
    expect(notified).toBe(3);
  });

  it('ignores a corrupted stored reference', () => {
    window.localStorage.setItem('darkslide_flat_field_v1', JSON.stringify({ version: 1, enabled: true, profile: { ...profile, gains: [1, 2] } }));
    expect(getActiveFlatFieldProfile()).toBeNull();
  });
});
