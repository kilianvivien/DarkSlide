import { DEFAULT_EXPORT_OPTIONS } from '../constants';
import { CropTab, ExportOptions } from '../types';

const STORAGE_KEY = 'darkslide_preferences_v1';

export interface UserPreferences {
  version: 2;
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
    prefs.version === 2 &&
    typeof prefs.lastProfileId === 'string' &&
    exportOptions !== undefined &&
    typeof exportOptions.format === 'string' &&
    typeof exportOptions.quality === 'number' &&
    typeof exportOptions.filenameBase === 'string' &&
    (exportOptions.embedMetadata === undefined || typeof exportOptions.embedMetadata === 'boolean') &&
    (exportOptions.outputProfileId === undefined || ['srgb', 'display-p3', 'adobe-rgb'].includes(exportOptions.outputProfileId)) &&
    (exportOptions.embedOutputProfile === undefined || typeof exportOptions.embedOutputProfile === 'boolean') &&
    typeof prefs.sidebarTab === 'string' &&
    (prefs.cropTab === undefined || ['Film', 'Print', 'Social', 'Digital'].includes(prefs.cropTab)) &&
    typeof prefs.isLeftPaneOpen === 'boolean' &&
    typeof prefs.isRightPaneOpen === 'boolean' &&
    (prefs.gpuRendering === undefined || typeof prefs.gpuRendering === 'boolean') &&
    (prefs.ultraSmoothDrag === undefined || typeof prefs.ultraSmoothDrag === 'boolean')
  );
}

function isLegacyPreferences(value: unknown): value is {
  version: 1;
  lastProfileId: string;
  exportOptions: {
    format: ExportOptions['format'];
    quality: number;
    filenameBase: string;
    embedMetadata?: boolean;
    iccEmbedMode?: 'srgb' | 'none';
  };
  sidebarTab: UserPreferences['sidebarTab'];
  cropTab?: CropTab;
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
  gpuRendering?: boolean;
  ultraSmoothDrag?: boolean;
} {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<{ version: number; exportOptions: Record<string, unknown> }>;
  return prefs.version === 1 && typeof prefs.exportOptions === 'object' && prefs.exportOptions !== null;
}

function migrateLegacyPreferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isLegacyPreferences(legacy)) {
    return null;
  }

  if (
    typeof legacy.lastProfileId !== 'string'
    || typeof legacy.exportOptions.format !== 'string'
    || typeof legacy.exportOptions.quality !== 'number'
    || typeof legacy.exportOptions.filenameBase !== 'string'
    || typeof legacy.sidebarTab !== 'string'
    || typeof legacy.isLeftPaneOpen !== 'boolean'
    || typeof legacy.isRightPaneOpen !== 'boolean'
    || (legacy.cropTab !== undefined && !['Film', 'Print', 'Social', 'Digital'].includes(legacy.cropTab))
    || (legacy.exportOptions.embedMetadata !== undefined && typeof legacy.exportOptions.embedMetadata !== 'boolean')
    || (legacy.gpuRendering !== undefined && typeof legacy.gpuRendering !== 'boolean')
    || (legacy.ultraSmoothDrag !== undefined && typeof legacy.ultraSmoothDrag !== 'boolean')
  ) {
    return null;
  }

  return {
    version: 2,
    lastProfileId: legacy.lastProfileId,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      format: legacy.exportOptions.format,
      quality: legacy.exportOptions.quality,
      filenameBase: legacy.exportOptions.filenameBase,
      embedMetadata: legacy.exportOptions.embedMetadata ?? DEFAULT_EXPORT_OPTIONS.embedMetadata,
      outputProfileId: 'srgb',
      embedOutputProfile: legacy.exportOptions.iccEmbedMode !== 'none',
    },
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
  };
}

export function loadPreferences(): UserPreferences | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (isLegacyPreferences(parsed)) {
      return migrateLegacyPreferences(parsed);
    }
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
