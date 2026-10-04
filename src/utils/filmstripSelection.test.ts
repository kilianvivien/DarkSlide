import { describe, expect, it } from 'vitest';
import { applySelectionClick, FilmstripSelection, reconcileSelection } from './filmstripSelection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const none = { toggle: false, range: false };

describe('applySelectionClick', () => {
  it('selects a single frame on a plain click', () => {
    expect(applySelectionClick({ ids: ['a', 'b'], anchorId: 'a' }, ORDER, 'd', none)).toEqual({ ids: ['d'], anchorId: 'd' });
  });

  it('toggles frames with Cmd/Ctrl and keeps filmstrip order', () => {
    let selection: FilmstripSelection = { ids: ['c'], anchorId: 'c' };
    selection = applySelectionClick(selection, ORDER, 'a', { toggle: true, range: false });
    expect(selection.ids).toEqual(['a', 'c']);
    selection = applySelectionClick(selection, ORDER, 'c', { toggle: true, range: false });
    expect(selection.ids).toEqual(['a']);
  });

  it('never deselects the last selected frame', () => {
    const selection = { ids: ['b'], anchorId: 'b' };
    expect(applySelectionClick(selection, ORDER, 'b', { toggle: true, range: false })).toBe(selection);
  });

  it('selects a range from the anchor in either direction', () => {
    expect(applySelectionClick({ ids: ['b'], anchorId: 'b' }, ORDER, 'd', { toggle: false, range: true }).ids).toEqual(['b', 'c', 'd']);
    expect(applySelectionClick({ ids: ['d'], anchorId: 'd' }, ORDER, 'a', { toggle: false, range: true }).ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('adds a range to the selection with Cmd+Shift', () => {
    const result = applySelectionClick({ ids: ['a', 'e'], anchorId: 'b' }, ORDER, 'c', { toggle: true, range: true });
    expect(result.ids).toEqual(['a', 'b', 'c', 'e']);
  });
});

describe('reconcileSelection', () => {
  it('drops closed frames and keeps the active frame selected', () => {
    expect(reconcileSelection({ ids: ['a', 'x'], anchorId: 'x' }, ORDER, 'a')).toEqual({ ids: ['a'], anchorId: 'a' });
    expect(reconcileSelection({ ids: ['b'], anchorId: 'b' }, ORDER, 'c')).toEqual({ ids: ['c'], anchorId: 'c' });
  });

  it('returns the same object when nothing changed', () => {
    const selection = { ids: ['a', 'b'], anchorId: 'a' };
    expect(reconcileSelection(selection, ORDER, 'a')).toBe(selection);
  });
});
