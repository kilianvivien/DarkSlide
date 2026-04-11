import { DEFAULT_COLOR_NEGATIVE_INVERSION, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS } from '../constants';
import { InversionMethod } from '../types';
import { CropTab, ExportOptions, NotificationSettings, UpdateChannel } from '../types';

const STORAGE_KEY = 'darkslide_preferences_v1';

export interface UserPreferences {
  version: 7;
  lastProfileId: string;
  defaultColorNegativeInversion: InversionMethod;
  exportOptions: ExportOptions;
  notificationSettings: NotificationSettings;
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'dust' | 'export';
  cropTab?: CropTab;
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
  gpuRendering: boolean;
  ultraSmoothDrag: boolean;
  externalEditorPath: string | null;
  externalEditorName: string | null;
  openInEditorOutputPath: string | null;
  defaultExportPath: string | null;
  batchOutputPath: string | null;
  contactSheetOutputPath: string | null;
  scanningWatchPath: string | null;
  scanningAutoExport: boolean;
  scanningAutoExportPath: string | null;
  updateChannel: UpdateChannel;
}

type PreferencesV5 = Omit<UserPreferences, 'version' | 'defaultColorNegativeInversion' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 5 };
type PreferencesV6 = Omit<UserPreferences, 'version' | 'defaultColorNegativeInversion'> & { version: 6 };
type PreferencesV6Base = Omit<UserPreferences, 'version' | 'defaultColorNegativeInversion' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'>
  & Partial<Pick<UserPreferences, 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'>>;

function isValidPreferences(value: unknown): value is UserPreferences {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<UserPreferences>;
  const exportOptions = prefs.exportOptions as Partial<ExportOptions> | undefined;
  return (
    prefs.version === 7 &&
    typeof prefs.notificationSettings === 'object' &&
    prefs.notificationSettings !== null &&
    typeof prefs.lastProfileId === 'string' &&
    (prefs.defaultColorNegativeInversion === 'standard' || prefs.defaultColorNegativeInversion === 'advanced-hd') &&
    exportOptions !== undefined &&
    typeof exportOptions.format === 'string' &&
    typeof exportOptions.quality === 'number' &&
    typeof exportOptions.filenameBase === 'string' &&
    (exportOptions.embedMetadata === undefined || typeof exportOptions.embedMetadata === 'boolean') &&
    (exportOptions.outputProfileId === undefined || ['srgb', 'display-p3', 'adobe-rgb'].includes(exportOptions.outputProfileId)) &&
    (exportOptions.embedOutputProfile === undefined || typeof exportOptions.embedOutputProfile === 'boolean') &&
    (exportOptions.saveSidecar === undefined || typeof exportOptions.saveSidecar === 'boolean') &&
    (exportOptions.targetMaxDimension === undefined || exportOptions.targetMaxDimension === null || typeof exportOptions.targetMaxDimension === 'number') &&
    typeof prefs.sidebarTab === 'string' &&
    (prefs.cropTab === undefined || ['Film', 'Print', 'Social', 'Digital'].includes(prefs.cropTab)) &&
    typeof prefs.isLeftPaneOpen === 'boolean' &&
    typeof prefs.isRightPaneOpen === 'boolean' &&
    typeof prefs.gpuRendering === 'boolean' &&
    typeof prefs.ultraSmoothDrag === 'boolean' &&
    (prefs.externalEditorPath === null || typeof prefs.externalEditorPath === 'string') &&
    (prefs.externalEditorName === null || typeof prefs.externalEditorName === 'string') &&
    (prefs.openInEditorOutputPath === null || typeof prefs.openInEditorOutputPath === 'string') &&
    (prefs.defaultExportPath === null || typeof prefs.defaultExportPath === 'string') &&
    (prefs.batchOutputPath === null || typeof prefs.batchOutputPath === 'string') &&
    (prefs.contactSheetOutputPath === null || typeof prefs.contactSheetOutputPath === 'string') &&
    (prefs.scanningWatchPath === null || typeof prefs.scanningWatchPath === 'string') &&
    typeof prefs.scanningAutoExport === 'boolean' &&
    (prefs.scanningAutoExportPath === null || typeof prefs.scanningAutoExportPath === 'string') &&
    (prefs.updateChannel === 'stable' || prefs.updateChannel === 'beta') &&
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

function isVersion2Preferences(value: unknown): value is Omit<UserPreferences, 'version' | 'openInEditorOutputPath' | 'notificationSettings' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 2 } {
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

function isVersion3Preferences(value: unknown): value is Omit<UserPreferences, 'version' | 'notificationSettings' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 3 } {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<Omit<UserPreferences, 'version' | 'notificationSettings' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 3 }>;
  return prefs.version === 3
    && typeof prefs.lastProfileId === 'string'
    && typeof prefs.sidebarTab === 'string'
    && typeof prefs.isLeftPaneOpen === 'boolean'
    && typeof prefs.isRightPaneOpen === 'boolean';
}

function isVersion4Preferences(value: unknown): value is Omit<UserPreferences, 'version' | 'defaultExportPath' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 4 } {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<Omit<UserPreferences, 'version' | 'defaultExportPath' | 'scanningWatchPath' | 'scanningAutoExport' | 'scanningAutoExportPath' | 'updateChannel'> & { version: 4 }>;
  return prefs.version === 4
    && typeof prefs.lastProfileId === 'string'
    && typeof prefs.sidebarTab === 'string'
    && typeof prefs.isLeftPaneOpen === 'boolean'
    && typeof prefs.isRightPaneOpen === 'boolean';
}

function isVersion5Preferences(value: unknown): value is PreferencesV5 {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<PreferencesV5>;
  return prefs.version === 5
    && typeof prefs.lastProfileId === 'string'
    && typeof prefs.sidebarTab === 'string'
    && typeof prefs.isLeftPaneOpen === 'boolean'
    && typeof prefs.isRightPaneOpen === 'boolean';
}

function withV6Defaults(base: PreferencesV6Base): UserPreferences {
  const {
    scanningWatchPath,
    scanningAutoExport,
    scanningAutoExportPath,
    updateChannel,
    ...rest
  } = base;

  return {
    ...rest,
    version: 7,
    defaultColorNegativeInversion: DEFAULT_COLOR_NEGATIVE_INVERSION,
    scanningWatchPath: scanningWatchPath ?? null,
    scanningAutoExport: scanningAutoExport ?? false,
    scanningAutoExportPath: scanningAutoExportPath ?? null,
    updateChannel: updateChannel ?? 'stable',
  };
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

  return withV6Defaults({
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
    defaultExportPath: null,
    batchOutputPath: null,
    contactSheetOutputPath: null,
  });
}

function migrateVersion2Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion2Preferences(legacy)) {
    return null;
  }

  return withV6Defaults({
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
    defaultExportPath: null,
    batchOutputPath: null,
    contactSheetOutputPath: null,
  });
}

function migrateVersion3Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion3Preferences(legacy)) {
    return null;
  }

  return withV6Defaults({
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
    defaultExportPath: null,
    batchOutputPath: null,
    contactSheetOutputPath: null,
  });
}

function migrateVersion4Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion4Preferences(legacy)) {
    return null;
  }

  return withV6Defaults({
    lastProfileId: legacy.lastProfileId,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      ...legacy.exportOptions,
    },
    notificationSettings: {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...legacy.notificationSettings,
    },
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
    externalEditorPath: legacy.externalEditorPath ?? null,
    externalEditorName: legacy.externalEditorName ?? null,
    openInEditorOutputPath: legacy.openInEditorOutputPath ?? null,
    defaultExportPath: null,
    batchOutputPath: legacy.batchOutputPath ?? null,
    contactSheetOutputPath: legacy.contactSheetOutputPath ?? null,
  });
}

function migrateVersion5Preferences(legacy: ReturnType<typeof JSON.parse>): UserPreferences | null {
  if (!isVersion5Preferences(legacy)) {
    return null;
  }

  return withV6Defaults({
    lastProfileId: legacy.lastProfileId,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      ...legacy.exportOptions,
    },
    notificationSettings: {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...legacy.notificationSettings,
    },
    sidebarTab: legacy.sidebarTab,
    cropTab: legacy.cropTab ?? 'Film',
    isLeftPaneOpen: legacy.isLeftPaneOpen,
    isRightPaneOpen: legacy.isRightPaneOpen,
    gpuRendering: legacy.gpuRendering ?? true,
    ultraSmoothDrag: legacy.ultraSmoothDrag ?? false,
    externalEditorPath: legacy.externalEditorPath ?? null,
    externalEditorName: legacy.externalEditorName ?? null,
    openInEditorOutputPath: legacy.openInEditorOutputPath ?? null,
    defaultExportPath: legacy.defaultExportPath ?? null,
    batchOutputPath: legacy.batchOutputPath ?? null,
    contactSheetOutputPath: legacy.contactSheetOutputPath ?? null,
  });
}

function isVersion6Preferences(value: unknown): value is PreferencesV6 {
  if (!value || typeof value !== 'object') return false;
  const prefs = value as Partial<PreferencesV6>;
  return prefs.version === 6
    && typeof prefs.lastProfileId === 'string'
    && typeof prefs.sidebarTab === 'string'
    && typeof prefs.isLeftPaneOpen === 'boolean'
    && typeof prefs.isRightPaneOpen === 'boolean';
}

export function loadPreferences(): UserPreferences | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (isLegacyPreferences(parsed)) return migrateLegacyPreferences(parsed);
    if (isVersion2Preferences(parsed)) return migrateVersion2Preferences(parsed);
    if (isVersion3Preferences(parsed)) return migrateVersion3Preferences(parsed);
    if (isVersion4Preferences(parsed)) return migrateVersion4Preferences(parsed);
    if (isVersion5Preferences(parsed)) return migrateVersion5Preferences(parsed);
    if (isVersion6Preferences(parsed)) {
      return withV6Defaults(parsed);
    }
    if (!isValidPreferences(parsed)) return null;

    return {
      ...parsed,
      version: 7,
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
      defaultExportPath: parsed.defaultExportPath ?? null,
      batchOutputPath: parsed.batchOutputPath ?? null,
      contactSheetOutputPath: parsed.contactSheetOutputPath ?? null,
      scanningWatchPath: parsed.scanningWatchPath ?? null,
      scanningAutoExport: parsed.scanningAutoExport ?? false,
      scanningAutoExportPath: parsed.scanningAutoExportPath ?? null,
      updateChannel: parsed.updateChannel ?? 'stable',
      defaultColorNegativeInversion: parsed.defaultColorNegativeInversion ?? DEFAULT_COLOR_NEGATIVE_INVERSION,
    };
  } catch {
    return null;
  }
}

export function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...prefs,
    version: 7,
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      ...prefs.exportOptions,
    },
  }));
}
