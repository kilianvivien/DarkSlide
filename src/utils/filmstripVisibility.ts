const STORAGE_KEY = 'darkslide.filmstripCollapsed';

/** Whether the filmstrip's thumbnails are hidden, remembered between sessions. */
export function loadFilmstripCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveFilmstripCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    // Storage can be unavailable (private mode); the choice just isn't remembered.
  }
}
