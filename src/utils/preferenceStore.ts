import { DEFAULT_EXPORT_OPTIONS } from '../constants';
import { CropTab, ExportOptions } from '../types';

const STORAGE_KEY = 'darkslide_preferences_v1';

export interface UserPreferences {
  version: 1;
  lastProfileId: string;
  exportOptions: ExportOptions;
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'export';
  cropTab?: CropTab;
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
  gpuRendering: boolean;
  ultraSmoothDrag: boolean;
}

function isValidPreferences(value: unknown): value is UserPreferences {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<UserPreferences>;
  const exportOptions = prefs.exportOptions as Partial<ExportOptions> | undefined;
  return (
    prefs.version === 1 &&
    typeof prefs.lastProfileId === 'string' &&
    exportOptions !== undefined &&
    typeof exportOptions.format === 'string' &&
    typeof exportOptions.quality === 'number' &&
    typeof exportOptions.filenameBase === 'string' &&
    (exportOptions.embedMetadata === undefined || typeof exportOptions.embedMetadata === 'boolean') &&
    (exportOptions.iccEmbedMode === undefined || exportOptions.iccEmbedMode === 'srgb' || exportOptions.iccEmbedMode === 'none') &&
    typeof prefs.sidebarTab === 'string' &&
    (prefs.cropTab === undefined || ['Film', 'Print', 'Social', 'Digital'].includes(prefs.cropTab)) &&
    typeof prefs.isLeftPaneOpen === 'boolean' &&
    typeof prefs.isRightPaneOpen === 'boolean' &&
    (prefs.gpuRendering === undefined || typeof prefs.gpuRendering === 'boolean') &&
    (prefs.ultraSmoothDrag === undefined || typeof prefs.ultraSmoothDrag === 'boolean')
  );
}

export function loadPreferences(): UserPreferences | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isValidPreferences(parsed)) return null;
    return {
      ...parsed,
      exportOptions: {
        ...DEFAULT_EXPORT_OPTIONS,
        ...parsed.exportOptions,
      },
      cropTab: parsed.cropTab ?? 'Film',
      gpuRendering: parsed.gpuRendering ?? true,
      ultraSmoothDrag: parsed.ultraSmoothDrag ?? false,
    };
  } catch {
    return null;
  }
}

export function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
