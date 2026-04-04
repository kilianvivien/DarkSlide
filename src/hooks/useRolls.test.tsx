import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRolls } from './useRolls';
import { Roll } from '../types';

function createLegacyRoll(id: string): Roll {
  return {
    id,
    name: `Roll ${id}`,
    filmStock: null,
    profileId: null,
    camera: null,
    date: null,
    notes: '',
    filmBaseSample: null,
    createdAt: Date.now(),
    directory: null,
  };
}

describe('useRolls', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('migrates legacy v1 storage into v2 roll storage with empty calibration data', async () => {
    window.localStorage.setItem('darkslide_rolls_v1', JSON.stringify({
      version: 1,
      rolls: [createLegacyRoll('legacy-roll')],
    }));

    let hookValue: ReturnType<typeof useRolls> | undefined;
    function Harness() {
      hookValue = useRolls();
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      expect(hookValue?.rolls.get('legacy-roll')?.calibration).toBeNull();
    });

    act(() => {
      hookValue?.createRoll('Migrated Roll');
    });

    const migrated = JSON.parse(window.localStorage.getItem('darkslide_rolls_v2') ?? 'null');
    expect(migrated).toMatchObject({
      version: 2,
    });
    expect(migrated.rolls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-roll',
        calibration: null,
      }),
    ]));
    expect(window.localStorage.getItem('darkslide_rolls_v1')).toBeNull();
  });

  it('invalidates an active calibration when samples change', async () => {
    let hookValue: ReturnType<typeof useRolls> | undefined;
    function Harness() {
      hookValue = useRolls();
      return null;
    }

    render(<Harness />);

    let rollId = '';
    act(() => {
      rollId = hookValue?.createRoll('Test Roll').id ?? '';
    });

    act(() => {
      hookValue?.setRollCalibrationBaseSample(rollId, { r: 245, g: 244, b: 243 });
      hookValue?.addRollCalibrationNeutralSample(rollId, {
        id: 'n1',
        documentId: 'doc-1',
        sampleRgb: { r: 210, g: 205, b: 200 },
        sampledAt: 1,
      });
      hookValue?.addRollCalibrationNeutralSample(rollId, {
        id: 'n2',
        documentId: 'doc-2',
        sampleRgb: { r: 180, g: 176, b: 172 },
        sampledAt: 2,
      });
      hookValue?.addRollCalibrationNeutralSample(rollId, {
        id: 'n3',
        documentId: 'doc-3',
        sampleRgb: { r: 150, g: 147, b: 143 },
        sampledAt: 3,
      });
      hookValue?.fitRollCalibrationForRoll(rollId);
    });

    expect(hookValue?.rolls.get(rollId)?.calibration).toEqual(expect.objectContaining({
      enabled: true,
      slopes: expect.any(Array),
    }));

    act(() => {
      hookValue?.addRollCalibrationNeutralSample(rollId, {
        id: 'n4',
        documentId: 'doc-4',
        sampleRgb: { r: 120, g: 118, b: 116 },
        sampledAt: 4,
      });
    });

    expect(hookValue?.rolls.get(rollId)?.calibration).toEqual(expect.objectContaining({
      enabled: false,
      slopes: [1, 1, 1],
      offsets: [0, 0, 0],
    }));
  });
});
