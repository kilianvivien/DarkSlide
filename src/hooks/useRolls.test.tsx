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

  it('migrates legacy v1 storage into v2 roll storage', async () => {
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
      expect(hookValue?.rolls.get('legacy-roll')).toBeTruthy();
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
      }),
    ]));
    expect(window.localStorage.getItem('darkslide_rolls_v1')).toBeNull();
  });

  it('stores a sampled film base on the roll', async () => {
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
      hookValue?.applyFilmBaseToRoll({ r: 245, g: 244, b: 243 }, rollId);
    });

    expect(hookValue?.rolls.get(rollId)?.filmBaseSample).toEqual({ r: 245, g: 244, b: 243 });
  });
});
