import { DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS } from '../constants';
import { CropTab, ExportOptions, NotificationSettings } from '../types';

const STORAGE_KEY = 'darkslide_preferences_v1';

export interface UserPreferences {
  version: 4;
  lastProfileId: string;
  exportOptions: ExportOptions;
  notificationSettings: NotificationSettings;
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'export';
  cropTab?: CropTab;
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
  gpuRendering: boolean;
  ultraSmoothDrag: boolean;
  externalEditorPath: string | null;
  externalEditorName: string | null;
  openInEditorOutputPath: string | null;
}

function isValidPreferences(value: unknown): value is UserPreferences {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<UserPreferences>;
  const exportOptions = prefs.exportOptions as Partial<ExportOptions> | undefined;
  return (
    prefs.version === 4 &&
    typeof prefs.notificationSettings === 'object' &&
    prefs.notificationSettings !== null &&
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
    (prefs.ultraSmoothDrag === undefined || typeof prefs.ultraSmoothDrag === 'boolean') &&
    (prefs.externalEditorPath === undefined || prefs.externalEditorPath === null || typeof prefs.externalEditorPath === 'string') &&
    (prefs.externalEditorName === undefined || prefs.externalEditorName === null || typeof prefs.externalEditorName === 'string') &&
    (prefs.openInEditorOutputPath === undefined || prefs.openInEditorOutputPath === null || typeof prefs.openInEditorOutputPath === 'string') &&
    (prefs.notificationSettings.enabled === undefined || typeof prefs.notificationSettings.enabled === 'boolean') &&
    (prefs.notificationSettings.exportComplete === undefined || typeof prefs.notificationSettings.exportComplete === 'boolean') &&
    (prefs.notificationSettings.batchComplete === undefined || typeof prefs.notificationSettings.batchComplete === 'boolean') &&
    (prefs.notificationSettings.contactSheetComplete === undefined || typeof prefs.notificationSettings.contactSheetComplete === 'boolean')
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

function isVersion2Preferences(value: unknown): value is Omit<UserPreferences, 'version' | 'openInEditorOutputPath' | 'notificationSettings'> & { version: 2 } {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<{
    version: number;
    lastProfileId: string;
    exportOptions: ExportOptions;
    sidebarTab: UserPreferences['sidebarTab'];
    cropTab?: CropTab;
    isLeftPaneOpen: boolean;
    isRightPaneOpen: boolean;
    gpuRendering?: boolean;
    ultraSmoothDrag?: boolean;
    externalEditorPath?: string | null;
    externalEditorName?: string | null;
  }>;
  const exportOptions = prefs.exportOptions as Partial<ExportOptions> | undefined;
  return (
    prefs.version === 2 &&
    typeof prefs.lastProfileId === 'string' &&
    exportOptions !== undefined &&
    typeof exportOptions.format === 'string' &&
    typeof exportOptions.quality === 'number' &&
    typeof exportOptions.filenameBase === 'string' &&
    typeof prefs.sidebarTab === 'string' &&
    typeof prefs.isLeftPaneOpen === 'boolean' &&
    typeof prefs.isRightPaneOpen === 'boolean'
  );
}

function isVersion3Preferences(value: unknown): value is Omit<UserPreferences, 'version' | 'notificationSettings'> & { version: 3 } {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<Omit<UserPreferences, 'version' | 'notificationSettings'> & { version: 3 }>;
  return prefs.version === 3
    && typeof prefs.lastProfileId === 'string'
    && typeof prefs.sidebarTab === 'string'
    && typeof prefs.isLeftPaneOpen === 'boolean'
    && typeof prefs.isRightPaneOpen === 'boolean';
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
    version: 4,
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
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
    externalEditorPath: null,
    externalEditorName: null,
    openInEditorOutputPath: null,
  };
}

function migrateVersion2Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion2Preferences(legacy)) {
    return null;
  }

  return {
    version: 4,
    lastProfileId: legacy.lastProfileId,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      ...legacy.exportOptions,
    },
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
    externalEditorPath: legacy.externalEditorPath ?? null,
    externalEditorName: legacy.externalEditorName ?? null,
    openInEditorOutputPath: null,
  };
}

function migrateVersion3Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion3Preferences(legacy)) {
    return null;
  }

  return {
    version: 4,
    lastProfileId: legacy.lastProfileId,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      ...legacy.exportOptions,
    },
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
    externalEditorPath: legacy.externalEditorPath ?? null,
    externalEditorName: legacy.externalEditorName ?? null,
    openInEditorOutputPath: legacy.openInEditorOutputPath ?? null,
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
    if (isVersion2Preferences(parsed)) {
      return migrateVersion2Preferences(parsed);
    }
    if (isVersion3Preferences(parsed)) {
      return migrateVersion3Preferences(parsed);
    }
    if (!isValidPreferences(parsed)) return null;
    return {
      ...parsed,
      version: 4,
      exportOptions: {
        ...DEFAULT_EXPORT_OPTIONS,
        ...parsed.exportOptions,
      },
      notificationSettings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        ...parsed.notificationSettings,
      },
      cropTab: parsed.cropTab ?? 'Film',
      gpuRendering: parsed.gpuRendering ?? true,
      ultraSmoothDrag: parsed.ultraSmoothDrag ?? false,
      externalEditorPath: parsed.externalEditorPath ?? null,
      externalEditorName: parsed.externalEditorName ?? null,
      openInEditorOutputPath: parsed.openInEditorOutputPath ?? null,
    };
  } catch {
    return null;
  }
}

export function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
