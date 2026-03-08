import { ExportOptions } from '../types';

const STORAGE_KEY = 'darkslide_preferences_v1';

export interface UserPreferences {
  version: 1;
  lastProfileId: string;
  exportOptions: ExportOptions;
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'export';
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
}

function isValidPreferences(value: unknown): value is UserPreferences {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<UserPreferences>;
  return (
    prefs.version === 1 &&
    typeof prefs.lastProfileId === 'string' &&
    prefs.exportOptions !== undefined &&
    typeof prefs.sidebarTab === 'string' &&
    typeof prefs.isLeftPaneOpen === 'boolean' &&
    typeof prefs.isRightPaneOpen === 'boolean'
  );
}

export function loadPreferences(): UserPreferences | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isValidPreferences(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
