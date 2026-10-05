export interface FilmstripSelection {
  /** Selected frame ids, in filmstrip order. */
  ids: string[];
  /** Frame that Shift-click ranges extend from. */
  anchorId: string | null;
}

export type SelectionModifiers = { toggle: boolean; range: boolean };

/**
 * Click-to-select rules, as in file browsers:
 * - plain click selects only that frame;
 * - Cmd/Ctrl-click adds or removes it (the last frame cannot be removed);
 * - Shift-click selects the range from the anchor to it.
 */
export function applySelectionClick(
  current: FilmstripSelection,
  orderedIds: string[],
  clickedId: string,
  { toggle, range }: SelectionModifiers,
): FilmstripSelection {
  const order = (ids: Iterable<string>) => {
    const set = new Set(ids);
    return orderedIds.filter((id) => set.has(id));
  };

  if (range && current.anchorId && orderedIds.includes(current.anchorId)) {
    const from = orderedIds.indexOf(current.anchorId);
    const to = orderedIds.indexOf(clickedId);
    const [start, end] = from <= to ? [from, to] : [to, from];
    const rangeIds = orderedIds.slice(start, end + 1);
    return { ids: order(toggle ? [...current.ids, ...rangeIds] : rangeIds), anchorId: current.anchorId };
  }

  if (toggle) {
    const isSelected = current.ids.includes(clickedId);
    if (isSelected && current.ids.length === 1) {
      return current;
    }
    const ids = isSelected
      ? current.ids.filter((id) => id !== clickedId)
      : [...current.ids, clickedId];
    return { ids: order(ids), anchorId: clickedId };
  }

  return { ids: [clickedId], anchorId: clickedId };
}

/** Drops frames that no longer exist and keeps the active frame selected. */
export function reconcileSelection(
  current: FilmstripSelection,
  orderedIds: string[],
  activeId: string | null,
): FilmstripSelection {
  const existing = current.ids.filter((id) => orderedIds.includes(id));
  if (activeId && !existing.includes(activeId)) {
    return { ids: [activeId], anchorId: activeId };
  }
  if (existing.length === current.ids.length && (current.anchorId === null || orderedIds.includes(current.anchorId))) {
    return current;
  }
  return {
    ids: existing,
    anchorId: current.anchorId && orderedIds.includes(current.anchorId) ? current.anchorId : activeId,
  };
}
