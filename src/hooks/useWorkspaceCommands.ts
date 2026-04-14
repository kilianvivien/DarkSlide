import React, { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createDefaultSettings, MAX_OPEN_TABS, resolveLightSourceIdForProfile } from '../constants';
import { useFileImport } from './useFileImport';
import { appendDiagnostic, getDiagnosticsReport } from '../utils/diagnostics';
import {
  chooseApplicationPath,
  confirmDiscard,
  isDesktopShell,
  openDirectory,
  openImageFile,
  openInExternalEditor,
  saveExportBlob,
  saveExportBlobDetailed,
  saveToDirectory,
  writeTextFileByPath,
} from '../utils/fileBridge';
import { getCanvas2dContext, getNativePathFromFile, getOpenInEditorErrorContext, getResolvedInversionPipelineSummary, getResolvedInputProfileId, TransientNoticeState, waitForNextPaint } from '../utils/appHelpers';
import { resolveDefaultInversionMethodForProfile } from '../utils/appHelpers';
import { savePreferences, UserPreferences } from '../utils/preferenceStore';
import { saveMaxResidentDocs, MaxResidentDocs } from '../utils/residentDocsStore';
import { notifyExportFinished, primeExportNotificationsPermission } from '../utils/exportNotifications';
import { clamp } from '../utils/math';
import { computeHighlightDensity } from '../utils/imagePipeline';
import { getFilmBaseCorrectionSettings } from '../utils/rawImport';
import {
  BatchJobEntry,
} from '../utils/batchProcessor';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import {
  ColorManagementSettings,
  ConversionSettings,
  CropTab,
  DocumentHistoryEntry,
  DocumentTab,
  FilmProfile,
  LabStyleProfile,
  LightSourceProfile,
  NotificationSettings,
  PointPickerMode,
  RenderBackendDiagnostics,
  ScannerType,
  TonalCharacter,
  WorkspaceDocument,
  QuickExportPreset,
  Roll,
} from '../types';
import { buildSidecarFile, getSidecarPathForExport, serializeSidecar } from '../utils/sidecarSettings';
import { sanitizeFilenameBase } from '../utils/imagePipeline';

function createHistoryEntry(
  settings: ConversionSettings,
  labStyleId: string | null,
): DocumentHistoryEntry {
  return {
    settings: structuredClone(settings),
    labStyleId,
  };
}

function buildQuickExportCrop(crop: ConversionSettings['crop']) {
  const squareSize = Math.min(crop.width, crop.height);
  return {
    ...crop,
    x: crop.x + ((crop.width - squareSize) / 2),
    y: crop.y + ((crop.height - squareSize) / 2),
    width: squareSize,
    height: squareSize,
    aspectRatio: 1,
  };
}

const DEFAULT_PRESET_CROP: ConversionSettings['crop'] = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspectRatio: null,
};

function preserveCurrentFraming(
  nextSettings: ConversionSettings,
  currentSettings: ConversionSettings | null | undefined,
) {
  if (!currentSettings) {
    return nextSettings;
  }

  nextSettings.crop = structuredClone(currentSettings.crop);
  nextSettings.rotation = currentSettings.rotation;
  nextSettings.levelAngle = currentSettings.levelAngle;
  return nextSettings;
}

function buildProfileSettingsForDocument(
  profile: FilmProfile,
  currentDocument: WorkspaceDocument | null,
) {
  const profileDefaults = currentDocument?.rawImportProfile && profile.id === currentDocument.rawImportProfile.id
    ? currentDocument.rawImportProfile.defaultSettings
    : profile.defaultSettings;
  const nextSettings = createDefaultSettings(structuredClone(profileDefaults));
  const isSwitchingAwayFromRawImportProfile = Boolean(
    currentDocument?.rawImportProfile
    && currentDocument.profileId === currentDocument.rawImportProfile.id
    && profile.id !== currentDocument.rawImportProfile.id,
  );

  const scanFilmBaseSample = isSwitchingAwayFromRawImportProfile
    ? null
    : currentDocument?.settings.filmBaseSample
    ?? currentDocument?.estimatedFilmBaseSample
    ?? null;

  if (nextSettings.inversionMethod !== 'advanced-hd' && !nextSettings.filmBaseSample && scanFilmBaseSample) {
    nextSettings.filmBaseSample = structuredClone(scanFilmBaseSample);
  }

  return nextSettings;
}

function resolveProfileSwitchInversionMethod(
  profile: FilmProfile,
  currentDocument: WorkspaceDocument | null,
  preferred: 'standard' | 'advanced-hd',
) {
  const rawImportProfileId = currentDocument?.rawImportProfile?.id ?? null;
  const isRawDocument = currentDocument?.source.mime === 'image/x-raw-rgba';

  if (rawImportProfileId && profile.id === rawImportProfileId) {
    return currentDocument?.rawImportProfile?.defaultSettings.inversionMethod
      ?? profile.defaultSettings.inversionMethod;
  }

  if (isRawDocument && currentDocument) {
    return currentDocument.settings.inversionMethod;
  }

  return resolveDefaultInversionMethodForProfile(profile, preferred);
}

type SetState<T> = Dispatch<SetStateAction<T>>;

type TauriWindowHandle = {
  startDragging: () => Promise<void>;
};

type UseWorkspaceCommandsOptions = {
  tabs: DocumentTab[];
  tabsRef: MutableRefObject<DocumentTab[]>;
  activeTabId: string | null;
  setActiveTabId: (value: string | null) => void;
  documentState: WorkspaceDocument | null;
  displaySettings: ConversionSettings | null;
  targetMaxDimension: number;
  fitScale: number;
  fullRenderTargetDimension: number;
  hasVisiblePreview: boolean;
  canvasSize: { width: number; height: number };
  activeProfile: FilmProfile;
  activeLabStyle: {
    toneCurve: FilmProfile['toneCurve'];
    channelCurves?: { r?: FilmProfile['toneCurve']; g?: FilmProfile['toneCurve']; b?: FilmProfile['toneCurve'] };
    tonalCharacterOverride?: Partial<TonalCharacter>;
    saturationBias: number;
    temperatureBias: number;
  } | null;
  fallbackProfile: FilmProfile;
  savePresetTags: string[];
  notificationSettings: NotificationSettings;
  renderBackendDiagnostics: RenderBackendDiagnostics;
  setSidebarTab: SetState<'adjust' | 'curves' | 'crop' | 'dust' | 'export'>;
  setCropTab: SetState<CropTab>;
  isPickingFilmBase: boolean;
  activePointPicker: PointPickerMode | null;
  usesNativeFileDialogs: boolean;
  lightSourceProfiles: LightSourceProfile[];
  defaultFlatFieldEnabled?: boolean;
  displayScaleFactor: number;
  persistedProfilesRef: MutableRefObject<FilmProfile[]>;
  prefsSnapshotRef: MutableRefObject<UserPreferences>;
  workerClientRef: MutableRefObject<ImageWorkerClient | null>;
  activeDocumentIdRef: MutableRefObject<string | null>;
  activeRenderRequestRef: MutableRefObject<{ documentId: string; revision: number } | null>;
  pendingPreviewRef: MutableRefObject<{
    documentId: string;
    angle: number;
    imageData: ImageData;
    imageBitmap: ImageBitmap | null;
  } | null>;
  interactionJustEndedRef: MutableRefObject<boolean>;
  tabSwitchDraftRef: MutableRefObject<string | null>;
  previousActiveTabIdRef: MutableRefObject<string | null>;
  tauriWindowRef: MutableRefObject<TauriWindowHandle | null>;
  displayCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  transientNoticeTimeoutRef: MutableRefObject<number | null>;
  tabSwitchOverlayTimeoutRef: MutableRefObject<number | null>;
  openDocument: (document: WorkspaceDocument, options?: { activate?: boolean }) => void;
  replaceDocument: (documentId: string, document: WorkspaceDocument) => void;
  removeDocument: (documentId: string) => {
    removedTab: DocumentTab | null;
    remainingTabs: DocumentTab[];
    nextActiveTabId: string | null;
  };
  reorderTabs: (sourceId: string, targetId: string) => void;
  evictOldestCleanTab: (maxTabs: number) => DocumentTab | null | 'all-dirty';
  setActiveSidebarScrollTop: (scrollTop: number) => void;
  setDocumentState: (nextState: WorkspaceDocument | null | ((current: WorkspaceDocument | null) => WorkspaceDocument | null)) => void;
  updateDocument: (updater: (current: WorkspaceDocument) => WorkspaceDocument) => void;
  pushHistoryEntry: (nextState: DocumentHistoryEntry) => void;
  resetHistory: (nextState: DocumentHistoryEntry) => void;
  zoomToFit: () => void;
  setZoomLevel: (zoom: number | 'fit') => void;
  setPan: Dispatch<SetStateAction<{ x: number; y: number }>>;
  refreshRenderBackendDiagnostics: () => Promise<void>;
  showTransientNotice: (message: string, tone?: TransientNoticeState['tone']) => void;
  savePreset: (profile: FilmProfile) => FilmProfile;
  importPreset: (profile: FilmProfile, options?: { overwriteId?: string; renameTo?: string }) => void;
  deletePreset: (id: string) => void;
  setError: SetState<string | null>;
  setBlockingOverlay: SetState<{ title: string; detail: string } | null>;
  setTransientNotice: SetState<TransientNoticeState | null>;
  setIsPickingFilmBase: SetState<boolean>;
  setActivePointPicker: SetState<PointPickerMode | null>;
  setComparisonMode: SetState<'processed' | 'original'>;
  setIsCropOverlayVisible: SetState<boolean>;
  setIsAdjustingLevel: SetState<boolean>;
  setIsInteractingWithPreviewControls: SetState<boolean>;
  setRenderedPreviewAngle: SetState<number>;
  setIsAdjustingCrop: SetState<boolean>;
  setShowSettingsModal: SetState<boolean>;
  setShowBatchModal: SetState<boolean>;
  setShowContactSheetModal: SetState<boolean>;
  setContactSheetEntries: SetState<BatchJobEntry[]>;
  setContactSheetSharedSettings: SetState<ConversionSettings | null>;
  setContactSheetSharedProfile: SetState<FilmProfile | null>;
  setContactSheetSharedLabStyle: SetState<LabStyleProfile | null>;
  setContactSheetSharedColorManagement: SetState<ColorManagementSettings | null>;
  setContactSheetSharedLightSourceBias: SetState<[number, number, number] | null>;
  setGPURenderingEnabled: SetState<boolean>;
  setUltraSmoothDragEnabled: SetState<boolean>;
  setNotificationSettings: SetState<NotificationSettings>;
  setMaxResidentDocs: SetState<MaxResidentDocs>;
  setDefaultColorNegativeInversion: SetState<'standard' | 'advanced-hd'>;
  setExternalEditorPath: SetState<string | null>;
  setExternalEditorName: SetState<string | null>;
  setOpenInEditorOutputPath: SetState<string | null>;
  setDefaultExportPath: SetState<string | null>;
  setBatchOutputPath: SetState<string | null>;
  setContactSheetOutputPath: SetState<string | null>;
  setShowTabSwitchOverlay: SetState<boolean>;
  setTabSwitchOverlayKey: SetState<number>;
  setPreviewVisibility: (next: boolean) => void;
  setCanvasSize: SetState<{ width: number; height: number }>;
  cancelPendingPreviewRetry: () => void;
  cancelScheduledInteractivePreview: () => void;
  isSupportedFile: (file: File) => boolean;
  isRawFile: (file: File) => boolean;
  createDocumentColorManagement: (
    source: Pick<WorkspaceDocument['source'], 'decoderColorProfileId' | 'embeddedColorProfileId'>,
    exportOptions?: WorkspaceDocument['exportOptions'],
  ) => ColorManagementSettings;
  formatError: (error: unknown, options?: { preservePrefix?: boolean }) => string;
  getErrorCode: (error: unknown) => string | null;
  resolveRollId: (nativePath: string | null | undefined, fileName: string) => string | null;
  getRollById: (rollId: string | null) => Roll | null;
};

export function useWorkspaceCommands({
  tabs,
  tabsRef,
  activeTabId,
  setActiveTabId,
  documentState,
  displaySettings,
  targetMaxDimension,
  fitScale,
  fullRenderTargetDimension,
  hasVisiblePreview,
  canvasSize,
  activeProfile,
  activeLabStyle,
  fallbackProfile,
  savePresetTags,
  notificationSettings,
  renderBackendDiagnostics,
  usesNativeFileDialogs,
  lightSourceProfiles,
  defaultFlatFieldEnabled = false,
  displayScaleFactor,
  persistedProfilesRef,
  prefsSnapshotRef,
  workerClientRef,
  activeDocumentIdRef,
  activeRenderRequestRef,
  pendingPreviewRef,
  interactionJustEndedRef,
  tabSwitchDraftRef,
  previousActiveTabIdRef,
  tauriWindowRef,
  displayCanvasRef,
  fileInputRef,
  transientNoticeTimeoutRef,
  tabSwitchOverlayTimeoutRef,
  openDocument,
  replaceDocument,
  removeDocument,
  reorderTabs,
  evictOldestCleanTab,
  setActiveSidebarScrollTop,
  setDocumentState,
  updateDocument,
  pushHistoryEntry,
  resetHistory,
  zoomToFit,
  setZoomLevel,
  setPan,
  refreshRenderBackendDiagnostics,
  showTransientNotice,
  savePreset,
  importPreset,
  deletePreset,
  setError,
  setBlockingOverlay,
  setTransientNotice,
  setIsPickingFilmBase,
  setActivePointPicker,
  setComparisonMode,
  setIsCropOverlayVisible,
  setIsAdjustingLevel,
  setIsInteractingWithPreviewControls,
  setRenderedPreviewAngle,
  setIsAdjustingCrop,
  setShowSettingsModal,
  setShowBatchModal,
  setShowContactSheetModal,
  setContactSheetEntries,
  setContactSheetSharedSettings,
  setContactSheetSharedProfile,
  setContactSheetSharedLabStyle,
  setContactSheetSharedColorManagement,
  setContactSheetSharedLightSourceBias,
  setGPURenderingEnabled,
  setUltraSmoothDragEnabled,
  setNotificationSettings,
  setMaxResidentDocs,
  setDefaultColorNegativeInversion,
  setExternalEditorPath,
  setExternalEditorName,
  setOpenInEditorOutputPath,
  setDefaultExportPath,
  setBatchOutputPath,
  setContactSheetOutputPath,
  setShowTabSwitchOverlay,
  setTabSwitchOverlayKey,
  setPreviewVisibility,
  setCanvasSize,
  setSidebarTab,
  setCropTab,
  cancelPendingPreviewRetry,
  cancelScheduledInteractivePreview,
  isSupportedFile,
  isRawFile,
  createDocumentColorManagement,
  formatError,
  getErrorCode,
  resolveRollId,
  getRollById,
  isPickingFilmBase,
  activePointPicker,
}: UseWorkspaceCommandsOptions) {
  void tabs;
  void transientNoticeTimeoutRef;
  const getLightSourceProfile = useCallback((lightSourceId: string | null) => (
    lightSourceProfiles.find((profile) => profile.id === (lightSourceId ?? 'auto'))
      ?? lightSourceProfiles[0]
  ), [lightSourceProfiles]);

  const getDefaultFlareStrength = useCallback((lightSourceId: string | null) => {
    const profile = getLightSourceProfile(lightSourceId);
    switch (profile.flareCharacteristic) {
      case 'low':
        return 30;
      case 'high':
        return 70;
      default:
        return 50;
    }
  }, [getLightSourceProfile]);

  const clearCanvas = useCallback(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return;
    const ctx = getCanvas2dContext(canvas);
    canvas.width = 1;
    canvas.height = 1;
    ctx?.clearRect(0, 0, 1, 1);
    setCanvasSize({ width: 0, height: 0 });
  }, [displayCanvasRef, setCanvasSize]);

  const disposeDocument = useCallback(async (documentId: string | null | undefined) => {
    if (!documentId || !workerClientRef.current) return;
    try {
      await workerClientRef.current.disposeDocument(documentId);
    } catch {
      // Ignore worker disposal failures while resetting the UI.
    }
  }, [workerClientRef]);

  const resetUiForImport = useCallback(() => {
    setError(null);
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    setIsAdjustingLevel(false);
    setIsInteractingWithPreviewControls(false);
    setRenderedPreviewAngle(0);
    setPreviewVisibility(false);
    clearCanvas();
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current?.imageBitmap?.close();
    pendingPreviewRef.current = null;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(false);
  }, [
    activeRenderRequestRef,
    cancelPendingPreviewRetry,
    cancelScheduledInteractivePreview,
    clearCanvas,
    interactionJustEndedRef,
    pendingPreviewRef,
    setError,
    setIsAdjustingCrop,
    setIsAdjustingLevel,
    setIsCropOverlayVisible,
    setIsInteractingWithPreviewControls,
    setIsPickingFilmBase,
    setPreviewVisibility,
    setRenderedPreviewAngle,
  ]);

  const { importFile, importSessionRef } = useFileImport({
    workerClientRef,
    activeDocumentIdRef,
    persistedProfilesRef,
    fallbackProfile,
    defaultFlatFieldEnabled,
    displayScaleFactor,
    tabsApi: {
      openDocument,
      replaceDocument,
      removeDocument,
      evictOldestCleanTab,
    },
    maxTabs: MAX_OPEN_TABS,
    createDocumentColorManagement,
    formatError,
    getErrorCode,
    isSupportedFile,
    isRawFile,
    disposeDocument,
    resetUiForImport,
    setBlockingOverlay,
    setError,
    setTransientNotice,
    resolveRollId,
    getRollById,
  });

  const handleSettingsChange = useCallback((newSettings: Partial<ConversionSettings>) => {
    updateDocument((current) => {
      const blackAndWhiteEnabled = newSettings.blackAndWhite?.enabled;
      const nextSettings = {
        ...current.settings,
        ...newSettings,
      };
      if (blackAndWhiteEnabled) {
        nextSettings.inversionMethod = 'standard';
      }
      const nextLightSourceId = blackAndWhiteEnabled === undefined
        ? current.lightSourceId
        : resolveLightSourceIdForProfile(activeProfile, current.lightSourceId, { blackAndWhiteEnabled });

      return {
        ...current,
        lightSourceId: nextLightSourceId,
        settings: nextSettings,
        cropSource: (newSettings.crop || newSettings.levelAngle !== undefined) ? 'manual' : current.cropSource,
        dirty: true,
      };
    });
  }, [activeProfile, updateDocument]);

  const handleLabStyleChange = useCallback((labStyleId: string | null) => {
    updateDocument((current) => ({
      ...current,
      labStyleId,
      dirty: true,
    }));
  }, [updateDocument]);

  const handleSidebarTabChange = useCallback((tab: 'adjust' | 'curves' | 'crop' | 'dust' | 'export') => {
    setSidebarTab(tab);
    setIsCropOverlayVisible((current) => {
      if (tab !== 'crop' && current) {
        setIsAdjustingCrop(false);
        return false;
      }
      return current;
    });
    savePreferences({ ...prefsSnapshotRef.current, sidebarTab: tab });
  }, [prefsSnapshotRef, setIsAdjustingCrop, setIsCropOverlayVisible, setSidebarTab]);

  const handleCropDone = useCallback(() => {
    setSidebarTab('adjust');
    setIsCropOverlayVisible(false);
    setIsAdjustingCrop(false);
  }, [setIsAdjustingCrop, setIsCropOverlayVisible, setSidebarTab]);

  const handleToggleFilmBasePicker = useCallback(() => {
    setIsPickingFilmBase((current) => !current);
  }, [setIsPickingFilmBase]);

  const handleOpenSettingsModal = useCallback(() => {
    setShowSettingsModal(true);
  }, [setShowSettingsModal]);

  const handleCropTabChange = useCallback((tab: CropTab) => {
    setCropTab(tab);
    savePreferences({ ...prefsSnapshotRef.current, cropTab: tab });
  }, [prefsSnapshotRef, setCropTab]);

  const handleResetCrop = useCallback(() => {
    handleSettingsChange({
      crop: { x: 0, y: 0, width: 1, height: 1, aspectRatio: null },
      levelAngle: 0,
    });
  }, [handleSettingsChange]);

  const handleCropOverlayChange = useCallback((crop: ConversionSettings['crop']) => {
    handleSettingsChange({ crop });
  }, [handleSettingsChange]);

  const handleExportOptionsChange = useCallback((options: Partial<WorkspaceDocument['exportOptions']>) => {
    const normalizedOptions = options.format === 'image/webp'
      ? { ...options, outputProfileId: 'srgb' as const }
      : options;

    if (documentState) {
      updateDocument((current) => ({
        ...current,
        exportOptions: {
          ...current.exportOptions,
          ...normalizedOptions,
        },
        colorManagement: {
          ...current.colorManagement,
          ...(normalizedOptions.outputProfileId !== undefined ? { outputProfileId: normalizedOptions.outputProfileId } : {}),
          ...(normalizedOptions.embedOutputProfile !== undefined ? { embedOutputProfile: normalizedOptions.embedOutputProfile } : {}),
        },
        dirty: true,
      }));
    }

    if (
      normalizedOptions.format !== undefined
      || normalizedOptions.quality !== undefined
      || normalizedOptions.embedMetadata !== undefined
      || normalizedOptions.outputProfileId !== undefined
      || normalizedOptions.embedOutputProfile !== undefined
    ) {
      savePreferences({
        ...prefsSnapshotRef.current,
        exportOptions: {
          ...prefsSnapshotRef.current.exportOptions,
          ...(normalizedOptions.format !== undefined ? { format: normalizedOptions.format } : {}),
          ...(normalizedOptions.quality !== undefined ? { quality: normalizedOptions.quality } : {}),
          ...(normalizedOptions.embedMetadata !== undefined ? { embedMetadata: normalizedOptions.embedMetadata } : {}),
          ...(normalizedOptions.outputProfileId !== undefined ? { outputProfileId: normalizedOptions.outputProfileId } : {}),
          ...(normalizedOptions.embedOutputProfile !== undefined ? { embedOutputProfile: normalizedOptions.embedOutputProfile } : {}),
        },
      });
    }
  }, [documentState, prefsSnapshotRef, updateDocument]);

  const handleColorManagementChange = useCallback((options: Partial<ColorManagementSettings>) => {
    if (!documentState) {
      return;
    }

    updateDocument((current) => {
      const nextColorManagement = { ...current.colorManagement, ...options };
      const nextOutputProfileId = current.exportOptions.format === 'image/webp'
        ? 'srgb'
        : nextColorManagement.outputProfileId;
      return {
        ...current,
        colorManagement: {
          ...nextColorManagement,
          outputProfileId: nextOutputProfileId,
        },
        exportOptions: {
          ...current.exportOptions,
          outputProfileId: nextOutputProfileId,
          embedOutputProfile: nextColorManagement.embedOutputProfile,
        },
        dirty: true,
      };
    });

    if (options.outputProfileId !== undefined || options.embedOutputProfile !== undefined) {
      savePreferences({
        ...prefsSnapshotRef.current,
        exportOptions: {
          ...prefsSnapshotRef.current.exportOptions,
          ...(options.outputProfileId !== undefined ? { outputProfileId: options.outputProfileId } : {}),
          ...(options.embedOutputProfile !== undefined ? { embedOutputProfile: options.embedOutputProfile } : {}),
        },
      });
    }
  }, [documentState, prefsSnapshotRef, updateDocument]);

  const handleNotificationSettingsChange = useCallback((options: Partial<NotificationSettings>) => {
    setNotificationSettings((current) => {
      const next = { ...current, ...options };
      savePreferences({ ...prefsSnapshotRef.current, notificationSettings: next });
      return next;
    });
  }, [prefsSnapshotRef, setNotificationSettings]);

  useEffect(() => {
    const previousTabId = previousActiveTabIdRef.current;
    previousActiveTabIdRef.current = activeTabId;
    activeDocumentIdRef.current = activeTabId;

    if (previousTabId === activeTabId) {
      return;
    }

    if (tabSwitchOverlayTimeoutRef.current !== null) {
      window.clearTimeout(tabSwitchOverlayTimeoutRef.current);
      tabSwitchOverlayTimeoutRef.current = null;
    }

    if (previousTabId && activeTabId) {
      setTabSwitchOverlayKey((current) => current + 1);
      setShowTabSwitchOverlay(true);
      tabSwitchOverlayTimeoutRef.current = window.setTimeout(() => {
        setShowTabSwitchOverlay(false);
        tabSwitchOverlayTimeoutRef.current = null;
      }, 220);
    } else {
      setShowTabSwitchOverlay(false);
    }

    if (previousTabId) {
      void workerClientRef.current?.cancelActivePreviewRender(previousTabId);
    }

    activeRenderRequestRef.current = null;
    pendingPreviewRef.current?.imageBitmap?.close();
    pendingPreviewRef.current = null;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(false);
    setIsCropOverlayVisible(false);
    setIsPickingFilmBase(false);
    setActivePointPicker(null);

    const incomingTab = tabsRef.current.find((tab) => tab.id === activeTabId);
    if (!incomingTab) {
      tabSwitchDraftRef.current = null;
      setPreviewVisibility(false);
      setRenderedPreviewAngle(0);
      clearCanvas();
      zoomToFit();
      return;
    }

    tabSwitchDraftRef.current = previousTabId && activeTabId && incomingTab.document.status === 'ready'
      ? incomingTab.id
      : null;
    setZoomLevel(incomingTab.zoom);
    setPan(incomingTab.pan);
  }, [
    activeDocumentIdRef,
    activeRenderRequestRef,
    activeTabId,
    cancelPendingPreviewRetry,
    cancelScheduledInteractivePreview,
    clearCanvas,
    interactionJustEndedRef,
    pendingPreviewRef,
    previousActiveTabIdRef,
    tabSwitchDraftRef,
    setActivePointPicker,
    setIsAdjustingCrop,
    setIsCropOverlayVisible,
    setIsPickingFilmBase,
    setPan,
    setPreviewVisibility,
    setRenderedPreviewAngle,
    setShowTabSwitchOverlay,
    setTabSwitchOverlayKey,
    setZoomLevel,
    tabSwitchOverlayTimeoutRef,
    tabsRef,
    workerClientRef,
    zoomToFit,
  ]);

  const handleCloseImage = useCallback(async (requestedTabId?: string | null) => {
    const documentId = requestedTabId ?? activeTabId;
    if (!documentId) {
      return;
    }

    const currentTabs = tabsRef.current;
    const tabToClose = currentTabs.find((tab) => tab.id === documentId) ?? null;
    if (!tabToClose) {
      return;
    }

    if (tabToClose.document.dirty && !(await confirmDiscard())) {
      return;
    }

    importSessionRef.current += 1;
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current?.imageBitmap?.close();
    pendingPreviewRef.current = null;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(false);
    setPreviewVisibility(false);
    setIsAdjustingLevel(false);
    setIsInteractingWithPreviewControls(false);
    setRenderedPreviewAngle(0);
    void workerClientRef.current?.cancelActivePreviewRender(documentId);

    const { remainingTabs } = removeDocument(documentId);
    await disposeDocument(documentId);
    setError(null);
    setBlockingOverlay(null);
    setComparisonMode('processed');
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    appendDiagnostic({
      level: 'info',
      code: 'IMAGE_CLOSED',
      message: documentId,
      context: { documentId },
    });
    if (remainingTabs.length === 0) {
      activeDocumentIdRef.current = null;
      zoomToFit();
      clearCanvas();
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [
    activeDocumentIdRef,
    activeRenderRequestRef,
    activeTabId,
    cancelPendingPreviewRetry,
    cancelScheduledInteractivePreview,
    clearCanvas,
    disposeDocument,
    fileInputRef,
    interactionJustEndedRef,
    pendingPreviewRef,
    removeDocument,
    setBlockingOverlay,
    setComparisonMode,
    setError,
    setIsAdjustingCrop,
    setIsAdjustingLevel,
    setIsCropOverlayVisible,
    setIsInteractingWithPreviewControls,
    setIsPickingFilmBase,
    setPreviewVisibility,
    setRenderedPreviewAngle,
    tabsRef,
    workerClientRef,
    zoomToFit,
  ]);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importFile(file, getNativePathFromFile(file));
  }, [importFile]);

  const handleOpenImage = useCallback(async () => {
    if (!usesNativeFileDialogs) {
      fileInputRef.current?.click();
      return;
    }

    try {
      flushSync(() => {
        setBlockingOverlay({
          title: 'Preparing import',
          detail: 'Waiting for the selected file to open.',
        });
      });
      await waitForNextPaint();

      const result = await openImageFile();
      if (!result) {
        setBlockingOverlay(null);
        return;
      }

      await importFile(result.file, result.path, result.size);
    } catch (openError) {
      setBlockingOverlay(null);
      const message = formatError(openError);
      appendDiagnostic({ level: 'error', code: 'OPEN_DIALOG_FAILED', message });
      setError(`Could not open file. ${message}`);
    }
  }, [fileInputRef, formatError, importFile, setBlockingOverlay, setError, usesNativeFileDialogs]);

  const handleOpenBatchExport = useCallback(() => {
    setShowBatchModal(true);
  }, [setShowBatchModal]);

  const handleOpenContactSheet = useCallback((payload: {
    entries: BatchJobEntry[];
    sharedSettings: ConversionSettings;
    sharedProfile: FilmProfile;
    sharedLabStyle: LabStyleProfile | null;
    sharedColorManagement: ColorManagementSettings;
    sharedLightSourceBias: [number, number, number] | null;
  }) => {
    setContactSheetEntries(payload.entries);
    setContactSheetSharedSettings(payload.sharedSettings);
    setContactSheetSharedProfile(payload.sharedProfile);
    setContactSheetSharedLabStyle(payload.sharedLabStyle);
    setContactSheetSharedColorManagement(payload.sharedColorManagement);
    setContactSheetSharedLightSourceBias(payload.sharedLightSourceBias);
    setShowContactSheetModal(true);
  }, [
    setContactSheetEntries,
    setContactSheetSharedColorManagement,
    setContactSheetSharedLabStyle,
    setContactSheetSharedLightSourceBias,
    setContactSheetSharedProfile,
    setContactSheetSharedSettings,
    setShowContactSheetModal,
  ]);

  const handleGPURenderingChange = useCallback((enabled: boolean) => {
    setGPURenderingEnabled(enabled);
    workerClientRef.current?.setGPUEnabled(enabled);
    savePreferences({ ...prefsSnapshotRef.current, gpuRendering: enabled });
    void refreshRenderBackendDiagnostics();
  }, [prefsSnapshotRef, refreshRenderBackendDiagnostics, setGPURenderingEnabled, workerClientRef]);

  const handleUltraSmoothDragChange = useCallback((enabled: boolean) => {
    setUltraSmoothDragEnabled(enabled);
    savePreferences({ ...prefsSnapshotRef.current, ultraSmoothDrag: enabled });
  }, [prefsSnapshotRef, setUltraSmoothDragEnabled]);

  const handleMaxResidentDocsChange = useCallback((value: MaxResidentDocs) => {
    setMaxResidentDocs(value);
    saveMaxResidentDocs(value);
    void workerClientRef.current?.trimResidentDocuments(value, activeTabId).then(() => {
      void refreshRenderBackendDiagnostics();
    }).catch(() => {
      // Ignore trimming failures triggered from settings changes.
    });
  }, [activeTabId, refreshRenderBackendDiagnostics, setMaxResidentDocs, workerClientRef]);

  const handleDefaultColorNegativeInversionChange = useCallback((value: 'standard' | 'advanced-hd') => {
    setDefaultColorNegativeInversion(value);
    savePreferences({ ...prefsSnapshotRef.current, defaultColorNegativeInversion: value });
  }, [prefsSnapshotRef, setDefaultColorNegativeInversion]);

  const handleProfileChange = useCallback((profile: FilmProfile) => {
    const nextLightSourceId = Object.prototype.hasOwnProperty.call(profile, 'lightSourceId')
      ? (profile.lightSourceId ?? null)
      : undefined;

    const nextLabStyleId = Object.prototype.hasOwnProperty.call(profile, 'labStyleId')
      ? (profile.labStyleId ?? null)
      : undefined;

    const nextSettings = buildProfileSettingsForDocument(profile, documentState);
    const nextInversionMethod = resolveProfileSwitchInversionMethod(
      profile,
      documentState,
      prefsSnapshotRef.current.defaultColorNegativeInversion,
    );
    if (profile.includesFraming === false) {
      preserveCurrentFraming(nextSettings, documentState?.settings);
    }

    updateDocument((current) => ({
      ...current,
      profileId: profile.id,
      lightSourceId: nextLightSourceId !== undefined
        ? nextLightSourceId
        : resolveLightSourceIdForProfile(profile, current.lightSourceId),
      settings: {
        ...nextSettings,
        inversionMethod: nextInversionMethod,
      },
      ...(nextLabStyleId !== undefined ? { labStyleId: nextLabStyleId } : {}),
      dirty: true,
    }));
    const resolvedLabStyleId = nextLabStyleId !== undefined ? nextLabStyleId : (documentState?.labStyleId ?? null);
    resetHistory(createHistoryEntry({
      ...nextSettings,
      inversionMethod: nextInversionMethod,
    }, resolvedLabStyleId));
    savePreferences({ ...prefsSnapshotRef.current, lastProfileId: profile.id });
  }, [documentState, prefsSnapshotRef, resetHistory, updateDocument]);

  const handleSavePreset = useCallback((name: string, metadata?: {
    filmStock?: string;
    scannerType?: ScannerType | null;
    folderId?: string | null;
    saveFraming?: boolean;
  }) => {
    if (!documentState) return;
    const presetSettings = structuredClone(documentState.settings);
    if (!metadata?.saveFraming) {
      presetSettings.crop = structuredClone(DEFAULT_PRESET_CROP);
      presetSettings.rotation = 0;
      presetSettings.levelAngle = 0;
    }

    const newPreset = savePreset({
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `custom-${crypto.randomUUID()}`
        : `custom-${Date.now()}`,
      version: 1,
      name,
      type: activeProfile.type,
      filmType: activeProfile.filmType,
      category: activeProfile.category,
      description: 'Custom DarkSlide preset',
      defaultSettings: presetSettings,
      isCustom: true,
      tags: savePresetTags,
      filmStock: metadata?.filmStock?.trim() ? metadata.filmStock.trim() : null,
      scannerType: metadata?.scannerType ?? null,
      includesFraming: Boolean(metadata?.saveFraming),
      lightSourceId: documentState.lightSourceId ?? null,
      folderId: metadata?.folderId ?? null,
      labStyleId: documentState.labStyleId ?? null,
    });
    updateDocument((current) => ({
      ...current,
      profileId: newPreset.id,
      dirty: false,
    }));
  }, [activeProfile.type, documentState, savePreset, savePresetTags, updateDocument]);

  const handleImportPreset = useCallback((profile: FilmProfile, options?: { overwriteId?: string; renameTo?: string }) => {
    importPreset({
      ...profile,
      version: profile.version ?? 1,
      filmType: profile.filmType ?? 'negative',
      category: profile.category ?? 'Generic',
      description: profile.description || 'Imported DarkSlide preset',
      tags: profile.tags?.length ? profile.tags : [profile.type],
      filmStock: profile.filmStock ?? null,
      scannerType: profile.scannerType ?? null,
      ...(Object.prototype.hasOwnProperty.call(profile, 'lightSourceId')
        ? { lightSourceId: profile.lightSourceId ?? null }
        : {}),
    }, options);
  }, [importPreset]);

  const handleDeletePreset = useCallback((id: string) => {
    deletePreset(id);
    if (documentState?.profileId === id) {
      handleProfileChange(fallbackProfile);
    }
  }, [deletePreset, documentState?.profileId, fallbackProfile, handleProfileChange]);

  const handleReset = useCallback(() => {
    if (!documentState) return;
    const nextSettings = buildProfileSettingsForDocument(activeProfile, documentState);
    if (activeProfile.includesFraming === false) {
      preserveCurrentFraming(nextSettings, documentState.settings);
    }
    pushHistoryEntry(createHistoryEntry(documentState.settings, documentState.labStyleId));
    updateDocument((current) => ({
      ...current,
      settings: {
        ...nextSettings,
        inversionMethod: resolveDefaultInversionMethodForProfile(activeProfile, prefsSnapshotRef.current.defaultColorNegativeInversion),
      },
      dirty: false,
    }));
  }, [activeProfile, documentState, prefsSnapshotRef, pushHistoryEntry, updateDocument]);

  const runExport = useCallback(async (params?: {
    settings?: ConversionSettings;
    exportOptions?: WorkspaceDocument['exportOptions'];
    outputPath?: string | null;
    showNotice?: boolean;
  }) => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) return;

    const exportSettings = params?.settings ?? documentState.settings;
    const exportOptions = params?.exportOptions ?? documentState.exportOptions;

    setDocumentState((current) => current ? { ...current, status: 'exporting' } : current);
    try {
      if (notificationSettings.enabled && notificationSettings.exportComplete) {
        await primeExportNotificationsPermission();
      }
      const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
      const lightSourceBias = getLightSourceProfile(documentState.lightSourceId ?? null).spectralBias;
      const highlightDensityEstimate = documentState.histogram ? computeHighlightDensity(documentState.histogram) : 0;
      const result = await worker.export({
        documentId: documentState.id,
        settings: exportSettings,
        isColor: activeProfile.type === 'color' && !exportSettings.blackAndWhite.enabled,
        profileId: activeProfile.id,
        filmType: activeProfile.filmType,
        advancedInversion: activeProfile.advancedInversion ?? null,
        estimatedDensityBalance: documentState.estimatedDensityBalance ?? null,
        inputProfileId,
        outputProfileId: exportOptions.outputProfileId,
        options: exportOptions,
        sourceExif: documentState.source.exif,
        flareFloor: documentState.estimatedFlare,
        lightSourceBias,
        maskTuning: activeProfile.maskTuning,
        colorMatrix: activeProfile.colorMatrix,
        tonalCharacter: activeProfile.tonalCharacter,
        labStyleToneCurve: activeLabStyle?.toneCurve,
        labStyleChannelCurves: activeLabStyle?.channelCurves,
        labTonalCharacterOverride: activeLabStyle?.tonalCharacterOverride,
        labSaturationBias: activeLabStyle?.saturationBias ?? 0,
        labTemperatureBias: activeLabStyle?.temperatureBias ?? 0,
        highlightDensityEstimate,
      });

      const saved = params?.outputPath
        ? { status: 'saved' as const, path: await saveToDirectory(result.blob, result.filename, params.outputPath) }
        : exportOptions.saveSidecar
          ? await saveExportBlobDetailed(result.blob, result.filename, exportOptions.format)
          : { status: await saveExportBlob(result.blob, result.filename, exportOptions.format), path: null };

      if (saved.status === 'saved') {
        if (exportOptions.saveSidecar && saved.path && isDesktopShell()) {
          const roll = getRollById(documentState.rollId);
          const sidecar = buildSidecarFile({
            sourceFile: {
              name: documentState.source.name,
              size: documentState.source.size,
              dimensions: {
                width: documentState.source.width,
                height: documentState.source.height,
              },
            },
            settings: structuredClone(exportSettings),
            profileId: activeProfile.id,
            profileName: activeProfile.name,
            isColor: activeProfile.type === 'color' && !exportSettings.blackAndWhite.enabled,
            colorManagement: structuredClone(documentState.colorManagement),
            exportOptions: {
              ...exportOptions,
              filenameBase: sanitizeFilenameBase(result.filename),
            },
            roll: roll ? {
              name: roll.name,
              filmStock: roll.filmStock,
              camera: roll.camera,
              date: roll.date,
              notes: roll.notes,
            } : undefined,
            lightSourceProfileId: documentState.lightSourceId ?? undefined,
            labStyleId: documentState.labStyleId ?? undefined,
          });
          await writeTextFileByPath(getSidecarPathForExport(saved.path), serializeSidecar(sidecar));
        }

        appendDiagnostic({ level: 'info', code: 'EXPORT_SUCCESS', message: result.filename, context: { format: exportOptions.format } });
        if (notificationSettings.enabled && notificationSettings.exportComplete) {
          await notifyExportFinished({ kind: 'export', filename: result.filename });
        }
        if (params?.showNotice) {
          showTransientNotice(`Exported ${result.filename}`, 'success');
        }
      } else {
        appendDiagnostic({ level: 'info', code: 'EXPORT_CANCELLED', message: result.filename, context: { format: exportOptions.format } });
      }
      setDocumentState((current) => current ? { ...current, status: 'ready' } : current);
      void refreshRenderBackendDiagnostics();
      return saved;
    } catch (exportError) {
      const message = formatError(exportError);
      appendDiagnostic({ level: 'error', code: 'EXPORT_FAILED', message });
      setError(`Export failed. ${message}`);
      setDocumentState((current) => current ? { ...current, status: 'error', errorCode: 'EXPORT_FAILED' } : current);
      window.setTimeout(() => {
        setDocumentState((current) => current?.status === 'error'
          ? { ...current, status: 'ready', errorCode: undefined }
          : current);
      }, 3000);
      void refreshRenderBackendDiagnostics();
    }
    return null;
  }, [activeLabStyle, activeProfile.advancedInversion, activeProfile.colorMatrix, activeProfile.filmType, activeProfile.id, activeProfile.maskTuning, activeProfile.name, activeProfile.tonalCharacter, activeProfile.type, documentState, formatError, getLightSourceProfile, getRollById, notificationSettings.enabled, notificationSettings.exportComplete, refreshRenderBackendDiagnostics, setDocumentState, setError, showTransientNotice, workerClientRef]);

  const handleDownload = useCallback(async () => {
    await runExport();
  }, [runExport]);

  const handleExportClick = useCallback(() => {
    void handleDownload();
  }, [handleDownload]);

  const handleQuickExport = useCallback(async (preset: QuickExportPreset) => {
    if (!documentState) {
      return;
    }

    const nextSettings = preset.cropToSquare
      ? {
        ...structuredClone(documentState.settings),
        crop: buildQuickExportCrop(documentState.settings.crop),
      }
      : structuredClone(documentState.settings);

    const nextExportOptions = {
      ...documentState.exportOptions,
      format: preset.format,
      quality: preset.quality,
      outputProfileId: preset.outputProfileId,
      embedMetadata: preset.embedMetadata,
      embedOutputProfile: preset.embedOutputProfile,
      saveSidecar: preset.saveSidecar,
      targetMaxDimension: preset.maxDimension,
      filenameBase: `${sanitizeFilenameBase(documentState.source.name)}${preset.suffix}`,
    } satisfies WorkspaceDocument['exportOptions'];

    await runExport({
      settings: nextSettings,
      exportOptions: nextExportOptions,
      outputPath: prefsSnapshotRef.current.defaultExportPath,
      showNotice: true,
    });
  }, [documentState, prefsSnapshotRef, runExport]);

  const handleOpenInEditor = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) return;

    setDocumentState((current) => current ? { ...current, status: 'exporting' } : current);
    try {
      const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
      const lightSourceBias = getLightSourceProfile(documentState.lightSourceId ?? null).spectralBias;
      const highlightDensityEstimate = documentState.histogram ? computeHighlightDensity(documentState.histogram) : 0;
      const result = await worker.export({
        documentId: documentState.id,
        settings: documentState.settings,
        isColor: activeProfile.type === 'color' && !documentState.settings.blackAndWhite.enabled,
        profileId: activeProfile.id,
        filmType: activeProfile.filmType,
        advancedInversion: activeProfile.advancedInversion ?? null,
        estimatedDensityBalance: documentState.estimatedDensityBalance ?? null,
        inputProfileId,
        outputProfileId: documentState.exportOptions.outputProfileId,
        options: documentState.exportOptions,
        sourceExif: documentState.source.exif,
        flareFloor: documentState.estimatedFlare,
        lightSourceBias,
        maskTuning: activeProfile.maskTuning,
        colorMatrix: activeProfile.colorMatrix,
        tonalCharacter: activeProfile.tonalCharacter,
        labStyleToneCurve: activeLabStyle?.toneCurve,
        labStyleChannelCurves: activeLabStyle?.channelCurves,
        labTonalCharacterOverride: activeLabStyle?.tonalCharacterOverride,
        labSaturationBias: activeLabStyle?.saturationBias ?? 0,
        labTemperatureBias: activeLabStyle?.temperatureBias ?? 0,
        highlightDensityEstimate,
      });

      const editorPath = prefsSnapshotRef.current.externalEditorPath;
      const editorName = prefsSnapshotRef.current.externalEditorName;
      const outputDirectoryPath = prefsSnapshotRef.current.openInEditorOutputPath;
      const openResult = await openInExternalEditor(result.blob, result.filename, editorPath, outputDirectoryPath);
      appendDiagnostic({
        level: 'info',
        code: 'OPEN_IN_EDITOR_SUCCESS',
        message: openResult.savedPath,
        context: {
          destinationDirectory: openResult.destinationDirectory,
          documentId: documentState.id,
          editorPath,
        },
      });
      showTransientNotice(`Saved to ${openResult.savedPath} and opened in ${editorName || 'default app'}`, 'success');
      setDocumentState((current) => current ? { ...current, status: 'ready' } : current);
    } catch (err) {
      const message = formatError(err, { preservePrefix: true });
      const openInEditorContext = getOpenInEditorErrorContext(err);
      appendDiagnostic({
        level: 'error',
        code: 'OPEN_IN_EDITOR_FAILED',
        message,
        context: {
          documentId: documentState.id,
          destinationDirectory: openInEditorContext?.destinationDirectory ?? prefsSnapshotRef.current.openInEditorOutputPath,
          editorPath: openInEditorContext?.editorPath ?? prefsSnapshotRef.current.externalEditorPath,
          savedPath: openInEditorContext?.savedPath ?? null,
        },
      });
      setError(`Open in editor failed. ${message}`);
      setDocumentState((current) => current ? { ...current, status: 'error', errorCode: 'OPEN_IN_EDITOR_FAILED' } : current);
    }
  }, [activeLabStyle, activeProfile.advancedInversion, activeProfile.colorMatrix, activeProfile.filmType, activeProfile.id, activeProfile.maskTuning, activeProfile.tonalCharacter, activeProfile.type, documentState, formatError, getLightSourceProfile, prefsSnapshotRef, setDocumentState, setError, showTransientNotice, workerClientRef]);

  const handleLightSourceChange = useCallback((lightSourceId: string | null) => {
    updateDocument((current) => {
      const previousDefault = getDefaultFlareStrength(current.lightSourceId ?? null);
      const nextDefault = getDefaultFlareStrength(lightSourceId);
      const shouldUpdateFlare = current.settings.flareCorrection === previousDefault;

      return {
        ...current,
        lightSourceId,
        settings: shouldUpdateFlare
          ? { ...current.settings, flareCorrection: nextDefault }
          : current.settings,
        dirty: true,
      };
    });
  }, [getDefaultFlareStrength, updateDocument]);

  const handleRedetectFrame = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) {
      return;
    }

    try {
      if (typeof worker.detectFrame !== 'function') {
        showTransientNotice('Frame detection is unavailable in this build.');
        return;
      }

      const detected = await worker.detectFrame(documentState.id);
      if (!detected) {
        showTransientNotice('No frame detected. Adjust crop manually.');
        return;
      }

      updateDocument((current) => ({
        ...current,
        settings: {
          ...current.settings,
          crop: {
            x: detected.left,
            y: detected.top,
            width: detected.right - detected.left,
            height: detected.bottom - detected.top,
            aspectRatio: null,
          },
          levelAngle: detected.angle,
        },
        cropSource: 'auto',
        dirty: true,
      }));
      showTransientNotice('Frame detected and crop applied.', 'success');
    } catch (error) {
      setError(formatError(error));
    }
  }, [documentState, formatError, setError, showTransientNotice, updateDocument, workerClientRef]);

  const handleChooseExternalEditor = useCallback(async () => {
    const result = await chooseApplicationPath();
    if (result) {
      setExternalEditorPath(result.path);
      setExternalEditorName(result.name);
      savePreferences({ ...prefsSnapshotRef.current, externalEditorPath: result.path, externalEditorName: result.name });
    }
  }, [prefsSnapshotRef, setExternalEditorName, setExternalEditorPath]);

  const handleClearExternalEditor = useCallback(() => {
    setExternalEditorPath(null);
    setExternalEditorName(null);
    savePreferences({ ...prefsSnapshotRef.current, externalEditorPath: null, externalEditorName: null });
  }, [prefsSnapshotRef, setExternalEditorName, setExternalEditorPath]);

  const handleChooseOpenInEditorOutputPath = useCallback(async () => {
    try {
      const selected = await openDirectory();
      if (!selected) return;
      setOpenInEditorOutputPath(selected);
      savePreferences({ ...prefsSnapshotRef.current, openInEditorOutputPath: selected });
    } catch (pathError) {
      const message = formatError(pathError, { preservePrefix: true });
      setError(`Could not choose an Open in Editor folder. ${message}`);
    }
  }, [formatError, prefsSnapshotRef, setError, setOpenInEditorOutputPath]);

  const handleUseDownloadsForOpenInEditor = useCallback(() => {
    setOpenInEditorOutputPath(null);
    savePreferences({ ...prefsSnapshotRef.current, openInEditorOutputPath: null });
  }, [prefsSnapshotRef, setOpenInEditorOutputPath]);

  const handleChooseDefaultExportPath = useCallback(async () => {
    try {
      const selected = await openDirectory();
      if (!selected) return;
      setDefaultExportPath(selected);
      savePreferences({ ...prefsSnapshotRef.current, defaultExportPath: selected });
    } catch (pathError) {
      const message = formatError(pathError, { preservePrefix: true });
      setError(`Could not choose a default export folder. ${message}`);
    }
  }, [formatError, prefsSnapshotRef, setDefaultExportPath, setError]);

  const handleUseDownloadsForExport = useCallback(() => {
    setDefaultExportPath(null);
    savePreferences({ ...prefsSnapshotRef.current, defaultExportPath: null });
  }, [prefsSnapshotRef, setDefaultExportPath]);

  const handleChooseBatchOutputPath = useCallback(async () => {
    try {
      const selected = await openDirectory();
      if (!selected) return;
      setBatchOutputPath(selected);
      savePreferences({ ...prefsSnapshotRef.current, batchOutputPath: selected });
    } catch (pathError) {
      const message = formatError(pathError, { preservePrefix: true });
      setError(`Could not choose a batch export folder. ${message}`);
    }
  }, [formatError, prefsSnapshotRef, setError, setBatchOutputPath]);

  const handleUseDownloadsForBatch = useCallback(() => {
    setBatchOutputPath(null);
    savePreferences({ ...prefsSnapshotRef.current, batchOutputPath: null });
  }, [prefsSnapshotRef, setBatchOutputPath]);

  const handleChooseContactSheetOutputPath = useCallback(async () => {
    try {
      const selected = await openDirectory();
      if (!selected) return;
      setContactSheetOutputPath(selected);
      savePreferences({ ...prefsSnapshotRef.current, contactSheetOutputPath: selected });
    } catch (pathError) {
      const message = formatError(pathError, { preservePrefix: true });
      setError(`Could not choose a contact sheet export folder. ${message}`);
    }
  }, [formatError, prefsSnapshotRef, setError, setContactSheetOutputPath]);

  const handleUseDownloadsForContactSheet = useCallback(() => {
    setContactSheetOutputPath(null);
    savePreferences({ ...prefsSnapshotRef.current, contactSheetOutputPath: null });
  }, [prefsSnapshotRef, setContactSheetOutputPath]);

  const handleCanvasClick = useCallback(async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!documentState || !displaySettings || !displayCanvasRef.current || !workerClientRef.current) return;
    if (!isPickingFilmBase && !activePointPicker) return;

    const canvas = displayCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    if (isPickingFilmBase) {
      try {
        const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
        const sample = await workerClientRef.current.sampleFilmBase({
          documentId: documentState.id,
          settings: displaySettings,
          inputProfileId,
          outputProfileId: documentState.colorManagement.outputProfileId,
          targetMaxDimension,
          x,
          y,
        });

        handleSettingsChange(getFilmBaseCorrectionSettings(sample));
        setIsPickingFilmBase(false);
        appendDiagnostic({
          level: 'info',
          code: 'FILM_BASE_SAMPLED',
          message: `Sampled ${sample.r}/${sample.g}/${sample.b}`,
        });
      } catch (sampleError) {
        const message = formatError(sampleError);
        appendDiagnostic({ level: 'error', code: 'FILM_BASE_FAILED', message });
        setError(`Film-base sampling failed. ${message}`);
        setIsPickingFilmBase(false);
      }
      return;
    }

    if (activePointPicker) {
      try {
        const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
        const sample = await workerClientRef.current.sampleFilmBase({
          documentId: documentState.id,
          settings: displaySettings,
          inputProfileId,
          outputProfileId: documentState.colorManagement.outputProfileId,
          targetMaxDimension,
          x,
          y,
        });

        if (activePointPicker === 'black') {
          const luminance = Math.round(0.299 * sample.r + 0.587 * sample.g + 0.114 * sample.b);
          handleSettingsChange({ blackPoint: clamp(luminance, 0, 80) });
        } else if (activePointPicker === 'white') {
          const luminance = Math.round(0.299 * sample.r + 0.587 * sample.g + 0.114 * sample.b);
          handleSettingsChange({ whitePoint: clamp(luminance, 180, 255) });
        } else if (activePointPicker === 'grey') {
          const safeR = Math.max(sample.r, 1);
          const safeG = Math.max(sample.g, 1);
          const safeB = Math.max(sample.b, 1);
          const rbAvg = (safeR + safeB) / 2;
          const temperatureOffset = clamp(Math.round((safeB - safeR) * 0.4), -100, 100);
          const tintOffset = clamp(Math.round((rbAvg - safeG) * 0.4), -100, 100);
          handleSettingsChange({
            temperature: clamp(documentState.settings.temperature + temperatureOffset, -100, 100),
            tint: clamp(documentState.settings.tint + tintOffset, -100, 100),
          });
        }

        setActivePointPicker(null);
        appendDiagnostic({
          level: 'info',
          code: 'POINT_SAMPLED',
          message: `${activePointPicker} point sampled at ${sample.r}/${sample.g}/${sample.b}`,
        });
      } catch (sampleError) {
        const message = formatError(sampleError);
        appendDiagnostic({ level: 'error', code: 'POINT_SAMPLE_FAILED', message });
        setError(`Point sampling failed. ${message}`);
        setActivePointPicker(null);
      }
    }
  }, [
    activePointPicker,
    displayCanvasRef,
    displaySettings,
    documentState,
    formatError,
    handleSettingsChange,
    isPickingFilmBase,
    setActivePointPicker,
    setError,
    setIsPickingFilmBase,
    targetMaxDimension,
    workerClientRef,
  ]);

  const handleCopyDebugInfo = useCallback(async () => {
    const report = {
      canvas: {
        hasVisiblePreview,
        ...canvasSize,
      },
      document: documentState,
      diagnostics: getDiagnosticsReport(),
      pipeline: {
        activeDocumentId: activeDocumentIdRef.current,
        activeImportSession: importSessionRef.current,
        activeRenderRequest: activeRenderRequestRef.current,
        colorInversion: documentState ? getResolvedInversionPipelineSummary(documentState.settings, {
          profileType: activeProfile.type,
          filmType: activeProfile.filmType,
          advancedInversion: activeProfile.advancedInversion ?? null,
          estimatedFilmBaseSample: documentState.estimatedFilmBaseSample ?? null,
        }) : null,
        fitScale,
        targetMaxDimension,
        effectiveRenderTarget: fullRenderTargetDimension,
        renderBackend: renderBackendDiagnostics,
      },
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      showTransientNotice('Debug info copied to clipboard.', 'success');
    } catch {
      setError('Could not copy debug info to the clipboard.');
    }
  }, [activeDocumentIdRef, activeRenderRequestRef, canvasSize, documentState, fitScale, fullRenderTargetDimension, hasVisiblePreview, importSessionRef, renderBackendDiagnostics, setError, showTransientNotice, targetMaxDimension]);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await importFile(file, getNativePathFromFile(file));
  }, [importFile]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  const handleReorderTabs = useCallback((sourceId: string, targetId: string) => {
    reorderTabs(sourceId, targetId);
  }, [reorderTabs]);

  const handleSidebarScrollTopChange = useCallback((scrollTop: number) => {
    setActiveSidebarScrollTop(scrollTop);
  }, [setActiveSidebarScrollTop]);

  const handleTitleBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!usesNativeFileDialogs || event.button !== 0) return;
    const appWindow = tauriWindowRef.current;
    if (!appWindow) return;
    event.preventDefault();
    void appWindow.startDragging().catch(() => {});
  }, [tauriWindowRef, usesNativeFileDialogs]);

  return {
    importFile,
    handleSettingsChange,
    handleLabStyleChange,
    handleSidebarTabChange,
    handleCropDone,
    handleToggleFilmBasePicker,
    handleOpenSettingsModal,
    handleCropTabChange,
    handleResetCrop,
    handleCropOverlayChange,
    handleExportOptionsChange,
    handleColorManagementChange,
    handleNotificationSettingsChange,
    handleCloseImage,
    handleFileChange,
    handleOpenImage,
    handleOpenBatchExport,
    handleOpenContactSheet,
    handleGPURenderingChange,
    handleUltraSmoothDragChange,
    handleMaxResidentDocsChange,
    handleDefaultColorNegativeInversionChange,
    handleProfileChange,
    handleLightSourceChange,
    handleRedetectFrame,
    handleSavePreset,
    handleImportPreset,
    handleDeletePreset,
    handleReset,
    handleDownload,
    handleExportClick,
    handleOpenInEditor,
    handleQuickExport,
    handleChooseExternalEditor,
    handleClearExternalEditor,
    handleChooseOpenInEditorOutputPath,
    handleUseDownloadsForOpenInEditor,
    handleChooseDefaultExportPath,
    handleUseDownloadsForExport,
    handleChooseBatchOutputPath,
    handleUseDownloadsForBatch,
    handleChooseContactSheetOutputPath,
    handleUseDownloadsForContactSheet,
    handleCanvasClick,
    handleCopyDebugInfo,
    handleDrop,
    handleSelectTab,
    handleReorderTabs,
    handleSidebarScrollTopChange,
    handleTitleBarMouseDown,
  };
}
