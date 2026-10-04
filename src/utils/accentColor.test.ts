import { afterEach, describe, expect, it } from 'vitest';
import { applyAccentColor, DEFAULT_ACCENT_COLOR, loadAccentColor, saveAccentColor } from './accentColor';

describe('accent color', () => {
  afterEach(() => {
    localStorage.clear();
    applyAccentColor(DEFAULT_ACCENT_COLOR);
  });

  it('defaults to amber and ignores unknown stored values', () => {
    expect(loadAccentColor()).toBe('amber');
    localStorage.setItem('darkslide.accentColor', 'chartreuse');
    expect(loadAccentColor()).toBe('amber');
  });

  it('saves the choice and sets it on the document root', () => {
    saveAccentColor('blue');
    expect(loadAccentColor()).toBe('blue');
    expect(document.documentElement.dataset.accent).toBe('blue');

    saveAccentColor('amber');
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });
});
