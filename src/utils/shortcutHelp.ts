export type ShortcutDefinition = {
  action: string;
  keys: string[];
};

export const SHORTCUT_MODIFIER =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘'
    : 'Ctrl';

export const SHORTCUT_ALT_MODIFIER =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌥'
    : 'Alt';

export const SHORTCUTS: ShortcutDefinition[] = [
  { action: 'Previous / next frame', keys: ['←', '→'] },
  { action: 'Next frame', keys: ['Return'] },
  { action: 'Copy image settings', keys: [SHORTCUT_MODIFIER, 'C'] },
  { action: 'Paste image settings', keys: [SHORTCUT_MODIFIER, 'V'] },
  { action: 'Select all frames', keys: [SHORTCUT_MODIFIER, 'A'] },
  { action: 'Open basic adjustments', keys: ['B'] },
  { action: 'Open advanced adjustments', keys: ['V'] },
  { action: 'Toggle film profiles', keys: ['P'] },
  { action: 'Auto adjust', keys: ['A'] },
  { action: 'Exposure', keys: ['↑', '↓'] },
  { action: 'Contrast', keys: [SHORTCUT_ALT_MODIFIER, '↑', '↓'] },
  { action: 'Saturation', keys: [SHORTCUT_MODIFIER, '↑', '↓'] },
  { action: 'Crop', keys: ['C'] },
  { action: 'Auto crop current / selected frames', keys: ['⇧', 'C'] },
  { action: 'Before / after', keys: ['\\'] },
  { action: 'Rotate clockwise', keys: ['R'] },
  { action: 'Rotate counterclockwise', keys: ['⇧', 'R'] },
  { action: 'Pan image', keys: ['Hold Space'] },
  { action: 'Open images', keys: [SHORTCUT_MODIFIER, 'O'] },
  { action: 'Close image', keys: [SHORTCUT_MODIFIER, 'W'] },
  { action: 'Undo', keys: [SHORTCUT_MODIFIER, 'Z'] },
  { action: 'Redo', keys: [SHORTCUT_MODIFIER, '⇧', 'Z'] },
  { action: 'Fit to window', keys: [SHORTCUT_MODIFIER, '0'] },
  { action: 'Zoom to 100%', keys: [SHORTCUT_MODIFIER, '1'] },
  { action: 'Zoom in', keys: [SHORTCUT_MODIFIER, '='] },
  { action: 'Zoom out', keys: [SHORTCUT_MODIFIER, '−'] },
  { action: 'Export frame', keys: [SHORTCUT_MODIFIER, 'E'] },
  { action: 'Batch export', keys: [SHORTCUT_MODIFIER, '⇧', 'E'] },
  { action: 'Open in editor', keys: [SHORTCUT_MODIFIER, '⇧', 'O'] },
  { action: 'Scanning session', keys: [SHORTCUT_MODIFIER, '⇧', 'W'] },
  { action: 'Settings', keys: [SHORTCUT_MODIFIER, ','] },
  { action: 'Commands', keys: [SHORTCUT_MODIFIER, 'K'] },
  { action: 'Show shortcuts', keys: ['?'] },
];
