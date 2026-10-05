// Single source for the shortcut reference shown in Settings and in tooltips.
// Keep in sync with useAppShortcuts.

export type ShortcutReference = {
  action: string;
  keys: string[];
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const SHORTCUT_MODIFIER = IS_MAC ? '⌘' : 'Ctrl';
export const SHORTCUT_ALT_MODIFIER = IS_MAC ? '⌥' : 'Alt';

export const SHORTCUTS: ShortcutReference[] = [
  { action: 'Develop panel', keys: ['1'] },
  { action: 'Curves panel', keys: ['2'] },
  { action: 'Film profiles panel', keys: ['3'] },
  { action: 'Toggle film profiles', keys: ['P'] },
  { action: 'Crop panel and overlay', keys: ['4'] },
  { action: 'Toggle crop overlay', keys: ['C'] },
  { action: 'Dust panel', keys: ['5'] },
  { action: 'Dust brush', keys: ['D'] },
  { action: 'Export panel', keys: ['6'] },
  { action: 'Contact sheet', keys: ['7'] },
  { action: 'Previous / next frame', keys: ['←', '→'] },
  { action: 'Show / hide filmstrip', keys: ['F'] },
  { action: 'Clear frame selection', keys: ['Esc'] },
  { action: 'Collapse the panel', keys: ['Click the active tool'] },
  { action: 'Before / after', keys: ['\\'] },
  { action: 'Auto adjust', keys: [SHORTCUT_MODIFIER, '⇧', 'A'] },
  { action: 'Open images', keys: [SHORTCUT_MODIFIER, 'O'] },
  { action: 'Close image', keys: [SHORTCUT_MODIFIER, 'W'] },
  { action: 'Undo', keys: [SHORTCUT_MODIFIER, 'Z'] },
  { action: 'Redo', keys: [SHORTCUT_MODIFIER, '⇧', 'Z'] },
  { action: 'Export', keys: [SHORTCUT_MODIFIER, 'E'] },
  { action: 'Export several frames', keys: [SHORTCUT_MODIFIER, '⇧', 'E'] },
  { action: 'Quick export presets', keys: [SHORTCUT_MODIFIER, '⇧', '1–4'] },
  { action: 'Open in editor', keys: [SHORTCUT_MODIFIER, '⇧', 'O'] },
  { action: 'Fit to window', keys: [SHORTCUT_MODIFIER, '0'] },
  { action: 'Zoom to 100%', keys: [SHORTCUT_MODIFIER, '1'] },
  { action: 'Zoom in / out', keys: [SHORTCUT_MODIFIER, '=', '−'] },
  { action: 'Pan image', keys: ['Hold Space'] },
  { action: 'Settings', keys: [SHORTCUT_MODIFIER, ','] },
];

export function formatShortcut(keys: string[]) {
  return keys.join(IS_MAC ? '' : '+');
}
