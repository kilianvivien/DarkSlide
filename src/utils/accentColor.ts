import { useCallback, useEffect, useState } from 'react';

// The interface accent (active tool, switches, selections, armed tools) is a
// set of CSS variables. Tailwind's `accent-*` colors read them, so changing
// the accent is a single attribute on <html>. Warnings keep their own amber.

export type AccentColorId = 'amber' | 'orange' | 'red' | 'pink' | 'violet' | 'blue' | 'teal' | 'green' | 'neutral';

export const ACCENT_COLORS: Array<{ id: AccentColorId; label: string; swatch: string }> = [
  { id: 'amber', label: 'Amber', swatch: '#fbbf24' },
  { id: 'orange', label: 'Orange', swatch: '#fb923c' },
  { id: 'red', label: 'Safelight', swatch: '#f87171' },
  { id: 'pink', label: 'Pink', swatch: '#f472b6' },
  { id: 'violet', label: 'Violet', swatch: '#a78bfa' },
  { id: 'blue', label: 'Blue', swatch: '#60a5fa' },
  { id: 'teal', label: 'Teal', swatch: '#2dd4bf' },
  { id: 'green', label: 'Green', swatch: '#4ade80' },
  { id: 'neutral', label: 'Graphite', swatch: '#d4d4d8' },
];

export const DEFAULT_ACCENT_COLOR: AccentColorId = 'amber';

const STORAGE_KEY = 'darkslide.accentColor';
const CHANGE_EVENT = 'darkslide:accent-change';

export function isAccentColorId(value: unknown): value is AccentColorId {
  return ACCENT_COLORS.some((entry) => entry.id === value);
}

export function loadAccentColor(): AccentColorId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isAccentColorId(stored) ? stored : DEFAULT_ACCENT_COLOR;
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}

export function applyAccentColor(accent: AccentColorId) {
  if (typeof document === 'undefined') return;
  if (accent === DEFAULT_ACCENT_COLOR) {
    delete document.documentElement.dataset.accent;
  } else {
    document.documentElement.dataset.accent = accent;
  }
}

export function saveAccentColor(accent: AccentColorId) {
  try {
    localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    // Storage can be unavailable; the accent still applies for this session.
  }
  applyAccentColor(accent);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: accent }));
}

/** Applies the saved accent and follows changes from Settings and other windows. */
export function initAccentColor() {
  applyAccentColor(loadAccentColor());
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyAccentColor(loadAccentColor());
  });
}

export function useAccentColor(): [AccentColorId, (accent: AccentColorId) => void] {
  const [accent, setAccent] = useState<AccentColorId>(loadAccentColor);

  useEffect(() => {
    const handleChange = () => setAccent(loadAccentColor());
    window.addEventListener(CHANGE_EVENT, handleChange);
    window.addEventListener('storage', handleChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  const update = useCallback((next: AccentColorId) => {
    setAccent(next);
    saveAccentColor(next);
  }, []);

  return [accent, update];
}
