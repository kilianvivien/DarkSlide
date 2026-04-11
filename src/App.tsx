import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { DEFAULT_COLOR_NEGATIVE_INVERSION, DEFAULT_DUST_REMOVAL, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES, LAB_STYLE_PROFILES, LAB_STYLE_PROFILES_MAP, LIGHT_SOURCE_PROFILES, resolveDustRemovalSettings } from './constants';
import { AppShell } from './components/AppShell';
import { RollInfoModal } from './components/RollInfoModal';
import { useScanningSessionWindow } from './hooks/useScanningSessionWindow';
import { UpdateBanner } from './components/UpdateBanner';
import { ColorManagementSettings, ColorMatrix, ConversionSettings, CropTab, DocumentHistoryEntry, ExportOptions, FilmProfile, HistogramMode, InteractionQuality, LabStyleProfile, MaskTuning, NotificationSettings, PointPickerMode, RenderBackendDiagnostics, Roll, TonalCharacter, UpdateChannel, WorkspaceDocument } from './types';
import { useCustomPresets } from './hooks/useCustomPresets';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useDocumentTabs } from './hooks/useDocumentTabs';
import { useRenderQueue } from './hooks/useRenderQueue';
import { useWorkspaceCommands } from './hooks/useWorkspaceCommands';
import { useCalibration } from './hooks/useCalibration';
import { useCustomLightSources } from './hooks/useCustomLightSources';
import { useViewportZoom } from './hooks/useViewportZoom';
import { useRolls } from './hooks/useRolls';
import { useScanningSession } from './hooks/useScanningSession';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { appendDiagnostic } from './utils/diagnostics';
import { confirmDeleteRoll, confirmOverwriteAutoAdjust, confirmReplacePresetLibrary, confirmSyncFilmBase, confirmSyncSettings, isDesktopShell, openDirectory, openImageFileByPath, openPresetBackupFile, promptText, registerBeforeUnloadGuard, savePresetBackupFile, saveToDirectory } from './utils/fileBridge';
import { loadPreferences, savePreferences, UserPreferences } from './utils/preferenceStore';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { computeHighlightDensity, getTransformedDimensions } from './utils/imagePipeline';
import { analyzeMonochromeSuggestion } from './utils/autoAnalysis';
import { createPresetBackupFile, validatePresetBackupFile } from './utils/presetStore';
import { computeViewportFitScale, CROP_OVERLAY_HANDLE_SAFE_PADDING, isFullFrameFreeCrop, resolveRenderTargetSelection } from './utils/previewLayout';
import { BatchJobEntry } from './utils/batchProcessor';
import { syncRecentFilesToMenu } from './utils/recentFilesStore';
import { BlockingOverlayState, createDocumentColorManagement, formatError, getCanvas2dContext, getErrorCode, getPresetTags, getResolvedInputProfileId, isIgnorableRenderError, isRawFile, isSupportedFile, normalizePreviewImageData, QueuedPreviewRender, SuggestionNoticeState, TransientNoticeState } from './utils/appHelpers';
import { loadMaxResidentDocs, MaxResidentDocs } from './utils/residentDocsStore';
import { createFromCurrentSettings, loadQuickExportPresets, saveQuickExportPresets } from './utils/quickExportStore';

function createDocumentHistoryEntry(document: Pick<WorkspaceDocument, 'settings' | 'labStyleId'>): DocumentHistoryEntry {
  return {
    settings: structuredClone(document.settings),
    labStyleId: document.labStyleId,
  };
}

export default function App() {
  const RENDER_INDICATOR_DELAY_MS = 450;
  const HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD = 0.01;
  const LARGE_SETTLED_PREVIEW_BITMAP_PIXELS = 8_000_000;
  const WORKER_MEMORY_EVICT_HIGH_WATERMARK_BYTES = 768 * 1024 * 1024;
  const WORKER_MEMORY_EVICT_LOW_WATERMARK_BYTES = 640 * 1024 * 1024;
  const SETTLED_RENDER_DEBOUNCE_MS = {
    zoom: 320,
    pan: 240,
    control: 140,
    crop: 180,
    other: 0,
  } as const;
  const initialPreferences = useMemo(() => loadPreferences(), []);
  const usesNativeFileDialogs = isDesktopShell();
  const {
    tabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTab,
    activeDocument: documentState,
    canUndo,
    canRedo,
    openDocument,
    replaceDocument,
    removeDocument,
    reorderTabs,
    updateTabById,
    setDocumentState,
    updateActiveDocument: updateDocument,
    pushHistoryEntry,
    resetHistory,
    beginInteraction,
    commitInteraction,
    evictOldestCleanTab,
    setActiveViewport,
    setActiveSidebarScrollTop,
    undo: handleUndo,
    redo: handleRedo,
  } = useDocumentTabs();
  const [error, setError] = useState<string | null>(null);
  const [isLeftPaneOpen, setIsLeftPaneOpen] = useState(true);
  const [isRightPaneOpen, setIsRightPaneOpen] = useState(true);
  const [isPickingFilmBase, setIsPickingFilmBase] = useState(false);
  const [activePointPicker, setActivePointPicker] = useState<PointPickerMode | null>(null);
  const [comparisonMode, setComparisonMode] = useState<'processed' | 'original'>('processed');
  const [isDragActive, setIsDragActive] = useState(false);
  const [isCropOverlayVisible, setIsCropOverlayVisible] = useState(false);
  const [isAdjustingLevel, setIsAdjustingLevel] = useState(false);
  const [isInteractingWithPreviewControls, setIsInteractingWithPreviewControls] = useState(false);
  const [isZooming, setIsZooming] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [targetMaxDimension, setTargetMaxDimension] = useState(1024);
  const [hasVisiblePreview, setHasVisiblePreview] = useState(false);
  const [renderedPreviewAngle, setRenderedPreviewAngle] = useState(0);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'adjust' | 'curves' | 'crop' | 'dust' | 'export'>('adjust');
  const [dustBrushActive, setDustBrushActive] = useState(false);
  const [isDetectingDust, setIsDetectingDust] = useState(false);
  const [cropTab, setCropTab] = useState<CropTab>(() => initialPreferences?.cropTab ?? 'Film');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showContactSheetModal, setShowContactSheetModal] = useState(false);
  const [activeRollInfoId, setActiveRollInfoId] = useState<string | null>(null);
  const [contactSheetEntries, setContactSheetEntries] = useState<BatchJobEntry[]>([]);
  const [contactSheetSharedSettings, setContactSheetSharedSettings] = useState<ConversionSettings | null>(null);
  const [contactSheetSharedProfile, setContactSheetSharedProfile] = useState<FilmProfile | null>(null);
  const [contactSheetSharedLabStyle, setContactSheetSharedLabStyle] = useState<LabStyleProfile | null>(null);
  const [contactSheetSharedColorManagement, setContactSheetSharedColorManagement] = useState<ColorManagementSettings | null>(null);
  const [contactSheetSharedLightSourceBias, setContactSheetSharedLightSourceBias] = useState<[number, number, number] | null>(null);
  const [gpuRenderingEnabled, setGPURenderingEnabled] = useState(() => initialPreferences?.gpuRendering ?? true);
  const [ultraSmoothDragEnabled, setUltraSmoothDragEnabled] = useState(() => initialPreferences?.ultraSmoothDrag ?? false);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(() => initialPreferences?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS);
  const [maxResidentDocs, setMaxResidentDocs] = useState<MaxResidentDocs>(() => loadMaxResidentDocs());
  const [externalEditorPath, setExternalEditorPath] = useState<string | null>(() => initialPreferences?.externalEditorPath ?? null);
  const [externalEditorName, setExternalEditorName] = useState<string | null>(() => initialPreferences?.externalEditorName ?? null);
  const [openInEditorOutputPath, setOpenInEditorOutputPath] = useState<string | null>(() => initialPreferences?.openInEditorOutputPath ?? null);
  const [defaultExportPath, setDefaultExportPath] = useState<string | null>(() => initialPreferences?.defaultExportPath ?? null);
  const [batchOutputPath, setBatchOutputPath] = useState<string | null>(() => initialPreferences?.batchOutputPath ?? null);
  const [contactSheetOutputPath, setContactSheetOutputPath] = useState<string | null>(() => initialPreferences?.contactSheetOutputPath ?? null);
  const [scanningWatchPath, setScanningWatchPath] = useState<string | null>(() => initialPreferences?.scanningWatchPath ?? null);
  const [scanningAutoExport, setScanningAutoExport] = useState(() => initialPreferences?.scanningAutoExport ?? false);
  const [scanningAutoExportPath, setScanningAutoExportPath] = useState<string | null>(() => initialPreferences?.scanningAutoExportPath ?? null);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => initialPreferences?.updateChannel ?? 'stable');
  const [defaultColorNegativeInversion, setDefaultColorNegativeInversion] = useState(() => initialPreferences?.defaultColorNegativeInversion ?? DEFAULT_COLOR_NEGATIVE_INVERSION);
  const [defaultExportOptions, setDefaultExportOptions] = useState<ExportOptions>(() => initialPreferences?.exportOptions ?? DEFAULT_EXPORT_OPTIONS);
  const [quickExportPresets, setQuickExportPresets] = useState(() => loadQuickExportPresets());
  const [isAdjustingCrop, setIsAdjustingCrop] = useState(false);
  const [isRenderIndicatorVisible, setIsRenderIndicatorVisible] = useState(false);
  const [blockingOverlay, setBlockingOverlay] = useState<BlockingOverlayState | null>(null);
  const [suggestionNotice, setSuggestionNotice] = useState<SuggestionNoticeState | null>(null);
  const [transientNotice, setTransientNotice] = useState<TransientNoticeState | null>(null);
  const [showTabSwitchOverlay, setShowTabSwitchOverlay] = useState(false);
  const [tabSwitchOverlayKey, setTabSwitchOverlayKey] = useState(0);
  const [renderBackendDiagnostics, setRenderBackendDiagnostics] = useState<RenderBackendDiagnostics>({
    gpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
    gpuEnabled: initialPreferences?.gpuRendering ?? true,
    gpuActive: false,
    gpuAdapterName: null,
    backendMode: 'cpu-worker',
    sourceKind: null,
    previewMode: null,
    previewLevelId: null,
    interactionQuality: null,
    histogramMode: null,
    tileSize: null,
    halo: null,
    tileCount: null,
    intermediateFormat: null,
    usedCpuFallback: false,
    fallbackReason: null,
    jobDurationMs: null,
    geometryCacheHit: null,
    phaseTimings: null,
    coalescedPreviewRequests: 0,
    cancelledPreviewJobs: 0,
    previewBackend: null,
    lastPreviewJob: null,
    lastExportJob: null,
    maxStorageBufferBindingSize: null,
    maxBufferSize: null,
    gpuDisabledReason: (typeof navigator === 'undefined' || !('gpu' in navigator)) ? 'unsupported' : ((initialPreferences?.gpuRendering ?? true) ? null : 'user'),
    lastError: null,
    workerMemory: null,
    activeBlobUrlCount: null,
    oldestActiveBlobUrlAgeMs: null,
  });

  const [displayScaleFactor, setDisplayScaleFactor] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  const [workerReadyVersion, setWorkerReadyVersion] = useState(0);
  const [defaultLightSourceId, setDefaultLightSourceId] = useState<string>(() => (
    typeof window !== 'undefined'
      ? window.localStorage.getItem('darkslide_default_light_source') ?? 'auto'
      : 'auto'
  ));
  const [defaultLabStyleId, setDefaultLabStyleId] = useState<string>(() => (
    typeof window !== 'undefined'
      ? window.localStorage.getItem('darkslide_default_lab_style') ?? ''
      : ''
  ));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeRenderRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const hasVisiblePreviewRef = useRef(false);
  const pendingPreviewRef = useRef<{
    documentId: string;
    revision: number;
    angle: number;
    imageData: ImageData;
    imageBitmap: ImageBitmap | null;
  } | null>(null);
  const currentPreviewImageDataRef = useRef<ImageData | null>(null);
  const previewRetryFrameRef = useRef<number | null>(null);
  const interactivePreviewFrameRef = useRef<number | null>(null);
  const pendingInteractivePreviewRef = useRef<QueuedPreviewRender | null>(null);
  const interactionJustEndedRef = useRef(false);
  const lastInteractionTypeRef = useRef<'zoom' | 'pan' | 'control' | 'crop' | null>(null);
  const zoomIdleTimeoutRef = useRef<number | null>(null);
  const renderIndicatorTimeoutRef = useRef<number | null>(null);
  const renderIndicatorRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const lastCompletedSettledRenderKeyRef = useRef<string | null>(null);
  const settledAdaptiveStateRef = useRef(new Map<string, {
    committedHighlightDensity: number;
    lastSettledKey: string | null;
    followUpCompletedForKey: string | null;
  }>());
  const enqueuePreviewRenderRef = useRef<((request: QueuedPreviewRender, priority: 'draft' | 'settled') => void) | null>(null);
  const workerMemoryPressureActiveRef = useRef(false);
  const fullRenderTargetSelectionRef = useRef<{ previewLevelId: string; targetDimension: number } | null>(null);
  const tabSwitchDraftRef = useRef<string | null>(null);
  const transientNoticeTimeoutRef = useRef<number | null>(null);
  const tabSwitchOverlayTimeoutRef = useRef<number | null>(null);
  const previousActiveTabIdRef = useRef<string | null>(null);
  const lastAutoFitCropKeyRef = useRef<string | null>(null);
  const monochromeSuggestionOfferedRef = useRef(new Set<string>());
  const convertToBlackAndWhiteActionRef = useRef<(documentId: string) => void>(() => undefined);
  const tauriWindowRef = useRef<{
    startDragging: () => Promise<void>;
    scaleFactor: () => Promise<number>;
    onScaleChanged: (handler: ({ payload }: { payload: { scaleFactor: number } }) => void) => Promise<() => void>;
  } | null>(null);

  const showTransientNotice = useCallback((message: string, tone: TransientNoticeState['tone'] = 'warning') => {
    if (transientNoticeTimeoutRef.current !== null) {
      window.clearTimeout(transientNoticeTimeoutRef.current);
    }

    setTransientNotice({ message, tone });
    transientNoticeTimeoutRef.current = window.setTimeout(() => {
      setTransientNotice(null);
      transientNoticeTimeoutRef.current = null;
    }, 4000);
  }, []);

  const maybeSuggestBlackAndWhiteConversion = useCallback((
    documentId: string,
    imageData: ImageData,
    options: {
      comparisonMode: 'processed' | 'original';
      previewMode: 'draft' | 'settled';
      interactionQuality: InteractionQuality | null;
      isColor: boolean;
      blackAndWhiteEnabled: boolean;
    },
  ) => {
    if (
      options.comparisonMode !== 'processed'
      || options.previewMode !== 'settled'
      || options.interactionQuality !== null
      || !options.isColor
      || options.blackAndWhiteEnabled
      || monochromeSuggestionOfferedRef.current.has(documentId)
    ) {
      return;
    }

    const analysis = analyzeMonochromeSuggestion(imageData);
    if (!analysis.isLikelyMonochrome || activeDocumentIdRef.current !== documentId) {
      return;
    }

    monochromeSuggestionOfferedRef.current.add(documentId);
    setSuggestionNotice({
      documentId,
      message: 'This scan looks monochrome. Convert it to black and white?',
      actionLabel: 'Convert to B&W',
      onAction: () => convertToBlackAndWhiteActionRef.current(documentId),
    });
  }, []);

  useEffect(() => {
    if (!documentState) {
      setSuggestionNotice(null);
      return;
    }

    if (documentState.settings.blackAndWhite.enabled) {
      setSuggestionNotice((current) => current?.documentId === documentState.id ? null : current);
      return;
    }

    if (
      suggestionNotice
      && suggestionNotice.documentId !== documentState.id
    ) {
      setSuggestionNotice(null);
    }
  }, [documentState, suggestionNotice]);

  const createPreviewRenderKey = useCallback((payload: {
    documentId: string;
    settings: ConversionSettings;
    isColor: boolean;
    filmType?: 'negative' | 'slide';
    advancedInversion?: FilmProfile['advancedInversion'] | null;
    comparisonMode: 'processed' | 'original';
    targetMaxDimension: number;
    inputProfileId: string;
    outputProfileId: string;
    maskTuning?: MaskTuning;
    colorMatrix?: ColorMatrix;
    tonalCharacter?: TonalCharacter;
    labStyleToneCurve?: FilmProfile['toneCurve'];
    labStyleChannelCurves?: { r?: FilmProfile['toneCurve']; g?: FilmProfile['toneCurve']; b?: FilmProfile['toneCurve'] };
    labTonalCharacterOverride?: Partial<TonalCharacter>;
    labSaturationBias?: number;
    labTemperatureBias?: number;
    flareFloor?: [number, number, number] | null;
    lightSourceBias?: [number, number, number];
  }) => JSON.stringify(payload), []);

  const getSettledAdaptiveState = useCallback((documentId: string) => {
    const existing = settledAdaptiveStateRef.current.get(documentId);
    if (existing) {
      return existing;
    }

    const initial = {
      committedHighlightDensity: 0,
      lastSettledKey: null,
      followUpCompletedForKey: null,
    };
    settledAdaptiveStateRef.current.set(documentId, initial);
    return initial;
  }, []);

  const clearRenderIndicator = useCallback(() => {
    if (renderIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(renderIndicatorTimeoutRef.current);
      renderIndicatorTimeoutRef.current = null;
    }
    renderIndicatorRequestRef.current = null;
    setIsRenderIndicatorVisible(false);
  }, []);

  const scheduleRenderIndicator = useCallback((documentId: string, revision: number) => {
    clearRenderIndicator();
    renderIndicatorRequestRef.current = { documentId, revision };
    renderIndicatorTimeoutRef.current = window.setTimeout(() => {
      const activeRequest = activeRenderRequestRef.current;
      const trackedRequest = renderIndicatorRequestRef.current;
      if (
        trackedRequest?.documentId === documentId
        && trackedRequest.revision === revision
        && activeRequest?.documentId === documentId
        && activeRequest.revision === revision
        && !isZoomingRef.current
        && !isInteractingRef.current
        && !isPanDragging
        && !isAdjustingCrop
      ) {
        setIsRenderIndicatorVisible(true);
      }
      renderIndicatorTimeoutRef.current = null;
    }, RENDER_INDICATOR_DELAY_MS);
  }, [clearRenderIndicator, isAdjustingCrop, isPanDragging]);

  const { customPresets, folders: presetFolders, savePreset, importPreset, deletePreset, createFolder, renameFolder, deleteFolder, movePresetToFolder, replaceLibrary } = useCustomPresets();
  const { customLightSources, saveCustomLightSource, deleteCustomLightSource } = useCustomLightSources();
  const fallbackProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0];

  useEffect(() => registerBeforeUnloadGuard(() => tabs.some((tab) => tab.document.dirty)), [tabs]);
  useEffect(() => { void syncRecentFilesToMenu(); }, []);
  const persistedProfiles = useMemo(() => [...FILM_PROFILES, ...customPresets], [customPresets]);
  const profilesById = useMemo(() => {
    const map = new Map<string, FilmProfile>();
    [...FILM_PROFILES, ...customPresets].forEach((profile) => {
      map.set(profile.id, profile);
    });
    tabs.forEach((tab) => {
      if (tab.document.rawImportProfile) {
        map.set(tab.document.rawImportProfile.id, tab.document.rawImportProfile);
      }
    });
    return map;
  }, [customPresets, tabs]);
  const builtinProfiles = useMemo(() => (
    documentState?.rawImportProfile
      ? [documentState.rawImportProfile, ...FILM_PROFILES]
      : FILM_PROFILES
  ), [documentState?.rawImportProfile]);
  const allLightSourceProfiles = useMemo(() => [...LIGHT_SOURCE_PROFILES, ...customLightSources], [customLightSources]);
  const lightSourceProfilesById = useMemo(() => {
    const map = new Map(allLightSourceProfiles.map((profile) => [profile.id, profile] as const));
    return map;
  }, [allLightSourceProfiles]);
  const calibration = useCalibration(workerClientRef, workerReadyVersion);
  const {
    rolls,
    createRoll,
    updateRoll,
    deleteRoll,
    assignToRoll,
    getDocumentsInRoll,
    syncSettingsToRoll,
    applyFilmBaseToRoll,
    ensureRollForDirectory,
  } = useRolls({
    tabs,
    updateTabById,
  });

  // Always-current ref for non-transient profiles — avoids adding them to importFile's deps
  const persistedProfilesRef = useRef(persistedProfiles);
  persistedProfilesRef.current = persistedProfiles;

  // Snapshot of the latest preference-relevant state, updated on every render so handlers can always read fresh values
  const prefsSnapshotRef = useRef<UserPreferences>({
    version: 7,
    lastProfileId: fallbackProfile.id,
    defaultColorNegativeInversion: initialPreferences?.defaultColorNegativeInversion ?? DEFAULT_COLOR_NEGATIVE_INVERSION,
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    notificationSettings: initialPreferences?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS,
    sidebarTab: 'adjust',
    cropTab: initialPreferences?.cropTab ?? 'Film',
    isLeftPaneOpen: true,
    isRightPaneOpen: true,
    gpuRendering: initialPreferences?.gpuRendering ?? true,
    ultraSmoothDrag: initialPreferences?.ultraSmoothDrag ?? false,
    externalEditorPath: initialPreferences?.externalEditorPath ?? null,
    externalEditorName: initialPreferences?.externalEditorName ?? null,
    openInEditorOutputPath: initialPreferences?.openInEditorOutputPath ?? null,
    defaultExportPath: initialPreferences?.defaultExportPath ?? null,
    batchOutputPath: initialPreferences?.batchOutputPath ?? null,
    contactSheetOutputPath: initialPreferences?.contactSheetOutputPath ?? null,
    scanningWatchPath: initialPreferences?.scanningWatchPath ?? null,
    scanningAutoExport: initialPreferences?.scanningAutoExport ?? false,
    scanningAutoExportPath: initialPreferences?.scanningAutoExportPath ?? null,
    updateChannel: initialPreferences?.updateChannel ?? 'stable',
  });
  prefsSnapshotRef.current = {
    version: 7,
    lastProfileId: documentState?.profileId ?? prefsSnapshotRef.current.lastProfileId,
    defaultColorNegativeInversion,
    exportOptions: documentState?.exportOptions ?? prefsSnapshotRef.current.exportOptions,
    notificationSettings,
    sidebarTab,
    cropTab,
    isLeftPaneOpen,
    isRightPaneOpen,
    gpuRendering: gpuRenderingEnabled,
    ultraSmoothDrag: ultraSmoothDragEnabled,
    externalEditorPath,
    externalEditorName,
    openInEditorOutputPath,
    defaultExportPath,
    batchOutputPath,
    contactSheetOutputPath,
    scanningWatchPath,
    scanningAutoExport,
    scanningAutoExportPath,
    updateChannel,
  };

  const getRollById = useCallback((rollId: string | null) => (
    rollId ? rolls.get(rollId) ?? null : null
  ), [rolls]);
  const activeRoll = useMemo(() => getRollById(documentState?.rollId ?? null), [documentState?.rollId, getRollById]);
  const filmstripTabs = useMemo(() => (
    activeRoll
      ? tabs.filter((tab) => tab.rollId === activeRoll.id)
      : tabs
  ), [activeRoll, tabs]);

  const resolveRollId = useCallback((nativePath: string | null | undefined) => {
    if (!nativePath) {
      return null;
    }
    const normalized = nativePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash < 0) {
      return null;
    }
    return ensureRollForDirectory(normalized.slice(0, lastSlash)).id;
  }, [ensureRollForDirectory]);
  const activeProfile = documentState
    ? profilesById.get(documentState.profileId) ?? fallbackProfile
    : fallbackProfile;
  const activeLabStyle = useMemo(
    () => (documentState?.labStyleId ? LAB_STYLE_PROFILES_MAP[documentState.labStyleId] ?? null : null),
    [documentState?.labStyleId],
  );
  const savePresetTags = useMemo(() => (
    documentState
      ? getPresetTags(documentState.settings, activeProfile.type, documentState.source.extension)
      : [activeProfile.type]
  ), [activeProfile.type, documentState]);
  const cropImageSize = useMemo(() => {
    if (!documentState) {
      return { width: 1, height: 1 };
    }

    return getTransformedDimensions(
      documentState.source.width,
      documentState.source.height,
      documentState.settings.rotation + documentState.settings.levelAngle,
    );
  }, [documentState?.settings.levelAngle, documentState?.settings.rotation, documentState?.source.height, documentState?.source.width]);
  const displaySettings = useMemo(() => {
    if (!documentState) return null;
    if (!isCropOverlayVisible) return documentState.settings;

    return {
      ...documentState.settings,
      crop: {
        ...documentState.settings.crop,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    };
  }, [documentState?.settings, isCropOverlayVisible]);
  const displayAngle = displaySettings ? displaySettings.rotation + displaySettings.levelAngle : 0;
  const {
    zoom, pan,
    zoomToFit, zoomTo100, zoomIn, zoomOut, setZoomLevel,
    setPan: setRawPan,
    livePanRef, panTransformRef, panGeometryRef,
    handleWheel: handleZoomWheelRaw,
    startPan, updatePan, endPan,
    commitZoom,
  } = useViewportZoom();

  // Wrap setPan to always sync the live ref (used by tab switching, etc.)
  const setPan = useCallback((value: React.SetStateAction<{ x: number; y: number }>) => {
    setRawPan((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      livePanRef.current = next;
      return next;
    });
  }, [livePanRef, setRawPan]);

  const isZoomingRef = useRef(false);
  const beginZoomInteraction = useCallback(() => {
    clearRenderIndicator();
    if (!isZoomingRef.current) {
      isZoomingRef.current = true;
      interactionJustEndedRef.current = false;
      setIsZooming(true);
    }
  }, [clearRenderIndicator]);

  const finishZoomInteraction = useCallback(() => {
    isZoomingRef.current = false;
    commitZoom();
    lastInteractionTypeRef.current = 'zoom';
    interactionJustEndedRef.current = true;
    setIsZooming(false);
    zoomIdleTimeoutRef.current = null;
  }, [commitZoom]);

  const scheduleZoomInteractionFinish = useCallback((delayMs: number) => {
    if (zoomIdleTimeoutRef.current !== null) {
      window.clearTimeout(zoomIdleTimeoutRef.current);
    }
    zoomIdleTimeoutRef.current = window.setTimeout(() => {
      finishZoomInteraction();
    }, delayMs);
  }, [finishZoomInteraction]);

  const handleZoomWheel = useCallback((deltaY: number, normX: number, normY: number) => {
    beginZoomInteraction();
    handleZoomWheelRaw(deltaY, normX, normY);
    scheduleZoomInteractionFinish(200);
  }, [beginZoomInteraction, handleZoomWheelRaw, scheduleZoomInteractionFinish]);

  const runZoomControlWithDraft = useCallback((action: () => void) => {
    beginZoomInteraction();
    action();
    scheduleZoomInteractionFinish(300);
  }, [beginZoomInteraction, scheduleZoomInteractionFinish]);

  const zoomToFitWithDraft = useCallback(() => {
    runZoomControlWithDraft(zoomToFit);
  }, [runZoomControlWithDraft, zoomToFit]);

  const zoomTo100WithDraft = useCallback(() => {
    runZoomControlWithDraft(zoomTo100);
  }, [runZoomControlWithDraft, zoomTo100]);

  const zoomInWithDraft = useCallback(() => {
    runZoomControlWithDraft(zoomIn);
  }, [runZoomControlWithDraft, zoomIn]);

  const zoomOutWithDraft = useCallback(() => {
    runZoomControlWithDraft(zoomOut);
  }, [runZoomControlWithDraft, zoomOut]);

  const setZoomLevelWithDraft = useCallback((level: number | 'fit') => {
    runZoomControlWithDraft(() => {
      setZoomLevel(level);
    });
  }, [runZoomControlWithDraft, setZoomLevel]);

  const fitScale = useMemo(() => {
    if (!documentState || !displaySettings) return 1;
    const viewport = viewportRef.current;
    if (!viewport) return 1;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight - 48;
    const rotatedSize = getTransformedDimensions(
      documentState.source.width,
      documentState.source.height,
      displaySettings.rotation + displaySettings.levelAngle,
    );
    const displayWidth = Math.max(1, Math.round((rotatedSize.width * displaySettings.crop.width) / displayScaleFactor));
    const displayHeight = Math.max(1, Math.round((rotatedSize.height * displaySettings.crop.height) / displayScaleFactor));
    return computeViewportFitScale({
      viewportWidth: vw,
      viewportHeight: vh,
      previewWidth: displayWidth,
      previewHeight: displayHeight,
      overlayPadding: isCropOverlayVisible ? CROP_OVERLAY_HANDLE_SAFE_PADDING : 0,
    });
  }, [
    displayScaleFactor,
    displaySettings,
    documentState,
    documentState?.source.height,
    documentState?.source.width,
    isCropOverlayVisible,
  ]);

  const effectiveZoom = zoom === 'fit' ? fitScale : zoom;
  const logicalPreviewSize = useMemo(() => {
    if (!documentState || !displaySettings) {
      return { width: 1, height: 1 };
    }

    const rotatedSize = getTransformedDimensions(
      documentState.source.width,
      documentState.source.height,
      displaySettings.rotation + displaySettings.levelAngle,
    );

    return {
      width: Math.max(1, Math.round((rotatedSize.width * displaySettings.crop.width) / displayScaleFactor)),
      height: Math.max(1, Math.round((rotatedSize.height * displaySettings.crop.height) / displayScaleFactor)),
    };
  }, [
    displayScaleFactor,
    displaySettings,
    documentState,
    documentState?.source.height,
    documentState?.source.width,
  ]);

  const fullRenderTargetDimension = useMemo(() => {
    const sourceMax = documentState ? Math.max(documentState.source.width, documentState.source.height) : targetMaxDimension;
    if (sourceMax <= targetMaxDimension) {
      fullRenderTargetSelectionRef.current = null;
      return targetMaxDimension;
    }
    if (!documentState || documentState.previewLevels.length === 0) {
      fullRenderTargetSelectionRef.current = null;
      return Math.min(sourceMax, targetMaxDimension);
    }
    const z = zoom === 'fit' ? fitScale : zoom;
    const effectiveTarget = Math.ceil((targetMaxDimension * z) / Math.max(fitScale, 0.0001));
    const clampedTarget = Math.min(sourceMax, Math.max(targetMaxDimension, effectiveTarget));
    const selection = resolveRenderTargetSelection(
      documentState.previewLevels,
      clampedTarget,
      fullRenderTargetSelectionRef.current,
      interactionJustEndedRef.current,
    );
    fullRenderTargetSelectionRef.current = selection;
    return selection.targetDimension;
  }, [documentState, fitScale, targetMaxDimension, zoom]);
  const isDraftPreview = comparisonMode === 'processed' && (isAdjustingLevel || isInteractingWithPreviewControls || isAdjustingCrop || isZooming);
  const renderTargetDimension = useMemo(() => {
    if (!isDraftPreview) {
      return fullRenderTargetDimension;
    }

    if (isAdjustingCrop && comparisonMode === 'processed') {
      return Math.min(fullRenderTargetDimension, 1024);
    }

    if ((isInteractingWithPreviewControls || isZooming) && comparisonMode === 'processed') {
      return Math.min(fullRenderTargetDimension, ultraSmoothDragEnabled ? 512 : 1024);
    }

    return Math.min(fullRenderTargetDimension, 1024);
  }, [comparisonMode, fullRenderTargetDimension, isAdjustingCrop, isDraftPreview, isInteractingWithPreviewControls, isZooming, ultraSmoothDragEnabled]);
  const previewTransformAngle = isAdjustingLevel ? displayAngle - renderedPreviewAngle : 0;
  const showMagnifier = Boolean((isPickingFilmBase || activePointPicker) && documentState?.status === 'ready');

  const autoFitCropKey = useMemo(() => {
    if (!isCropOverlayVisible || !documentState || !isFullFrameFreeCrop(documentState.settings.crop)) {
      return null;
    }

    return [
      documentState.id,
      documentState.settings.rotation,
      documentState.settings.levelAngle,
      documentState.settings.crop.x,
      documentState.settings.crop.y,
      documentState.settings.crop.width,
      documentState.settings.crop.height,
      documentState.settings.crop.aspectRatio ?? 'free',
    ].join(':');
  }, [documentState, isCropOverlayVisible]);

  useEffect(() => {
    if (!autoFitCropKey) {
      lastAutoFitCropKeyRef.current = null;
      return;
    }

    if (autoFitCropKey === lastAutoFitCropKeyRef.current) {
      return;
    }

    lastAutoFitCropKeyRef.current = autoFitCropKey;
    zoomToFit();
  }, [autoFitCropKey, zoomToFit]);

  const isInteractingRef = useRef(false);

  const cancelScheduledInteractivePreview = useCallback(() => {
    if (interactivePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(interactivePreviewFrameRef.current);
      interactivePreviewFrameRef.current = null;
    }
    pendingInteractivePreviewRef.current = null;
    cancelPendingPreviewRender();
  }, []);

  const handleInteractionStart = useCallback(() => {
    clearRenderIndicator();
    isInteractingRef.current = true;
    interactionJustEndedRef.current = false;
    setIsInteractingWithPreviewControls(true);
    beginInteraction();
  }, [beginInteraction, clearRenderIndicator]);

  const handleInteractionEnd = useCallback(() => {
    isInteractingRef.current = false;
    lastInteractionTypeRef.current = 'control';
    interactionJustEndedRef.current = true;
    cancelScheduledInteractivePreview();
    setIsInteractingWithPreviewControls(false);
    if (documentState) {
      commitInteraction(createDocumentHistoryEntry(documentState));
    }
  }, [cancelScheduledInteractivePreview, commitInteraction, documentState]);

  const handleCropInteractionStart = useCallback(() => {
    if (isInteractingRef.current) {
      return;
    }

    clearRenderIndicator();
    isInteractingRef.current = true;
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(true);
    beginInteraction();
  }, [beginInteraction, clearRenderIndicator]);

  const handleCropInteractionEnd = useCallback(() => {
    if (!isInteractingRef.current) {
      return;
    }

    isInteractingRef.current = false;
    lastInteractionTypeRef.current = 'crop';
    interactionJustEndedRef.current = true;
    cancelScheduledInteractivePreview();
    setIsAdjustingCrop(false);
    if (documentState) {
      commitInteraction(createDocumentHistoryEntry(documentState));
    }
  }, [cancelScheduledInteractivePreview, commitInteraction, documentState]);

  const handleDustBrushInteractionStart = useCallback(() => {
    clearRenderIndicator();
    interactionJustEndedRef.current = false;
    beginInteraction();
  }, [beginInteraction, clearRenderIndicator]);

  const handleDustBrushInteractionEnd = useCallback(() => {
    lastInteractionTypeRef.current = null;
    interactionJustEndedRef.current = false;
    cancelScheduledInteractivePreview();
    if (documentState) {
      commitInteraction(createDocumentHistoryEntry(documentState));
    }
  }, [cancelScheduledInteractivePreview, commitInteraction, documentState]);

  useEffect(() => {
    if (!activeTabId) {
      return;
    }

    setActiveViewport(zoom, pan);
  }, [activeTabId, pan, setActiveViewport, zoom]);

  useEffect(() => {
    setDustBrushActive(false);
  }, [activeTabId]);

  useEffect(() => {
    workerClientRef.current = new ImageWorkerClient({
      gpuEnabled: initialPreferences?.gpuRendering ?? true,
      onBackendDiagnosticsChange: setRenderBackendDiagnostics,
      onGPUDeviceLost: (message) => {
        showTransientNotice(message || 'GPU unavailable — retrying on the next render');
      },
    });
    setWorkerReadyVersion((current) => current + 1);
    void workerClientRef.current.getGPUDiagnostics().then(setRenderBackendDiagnostics).catch(() => {
      // Ignore diagnostics refresh failures during startup.
    });
    return () => {
      if (transientNoticeTimeoutRef.current !== null) {
        window.clearTimeout(transientNoticeTimeoutRef.current);
      }
      if (tabSwitchOverlayTimeoutRef.current !== null) {
        window.clearTimeout(tabSwitchOverlayTimeoutRef.current);
      }
      if (previewRetryFrameRef.current !== null) {
        window.cancelAnimationFrame(previewRetryFrameRef.current);
      }
      if (interactivePreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(interactivePreviewFrameRef.current);
      }
      if (zoomIdleTimeoutRef.current !== null) {
        window.clearTimeout(zoomIdleTimeoutRef.current);
      }
      if (renderIndicatorTimeoutRef.current !== null) {
        window.clearTimeout(renderIndicatorTimeoutRef.current);
      }
      pendingPreviewRef.current?.imageBitmap?.close();
      pendingPreviewRef.current = null;
      workerClientRef.current?.terminate();
      workerClientRef.current = null;
    };
  }, [initialPreferences, showTransientNotice]);

  // Restore UI layout from stored preferences on first mount
  useEffect(() => {
    const prefs = initialPreferences;
    if (!prefs) return;
    if (['adjust', 'curves', 'crop', 'dust', 'export'].includes(prefs.sidebarTab)) {
      setSidebarTab(prefs.sidebarTab);
    }
    setCropTab(prefs.cropTab ?? 'Film');
    setIsLeftPaneOpen(prefs.isLeftPaneOpen);
    setIsRightPaneOpen(prefs.isRightPaneOpen);
    setGPURenderingEnabled(prefs.gpuRendering);
    setUltraSmoothDragEnabled(prefs.ultraSmoothDrag);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPreferences]);

  const refreshRenderBackendDiagnostics = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker) return;
    const diagnostics = await worker.getGPUDiagnostics();
    setRenderBackendDiagnostics(diagnostics);
  }, []);

  useEffect(() => {
    const worker = workerClientRef.current;
    if (!worker || tabs.length === 0) {
      return;
    }

    void worker
      .trimResidentDocuments(maxResidentDocs, activeTabId)
      .then(() => refreshRenderBackendDiagnostics())
      .catch(() => {
        // Ignore resident-doc trimming failures and keep the editor responsive.
      });
  }, [activeTabId, maxResidentDocs, refreshRenderBackendDiagnostics, tabs.length]);

  useEffect(() => {
    const activeIds = new Set(tabs.map((tab) => tab.id));
    for (const documentId of settledAdaptiveStateRef.current.keys()) {
      if (!activeIds.has(documentId)) {
        settledAdaptiveStateRef.current.delete(documentId);
      }
    }
  }, [tabs]);

  useEffect(() => {
    const worker = workerClientRef.current;
    const estimatedMemoryBytes = renderBackendDiagnostics.workerMemory?.estimatedMemoryBytes ?? null;
    if (!worker || estimatedMemoryBytes === null) {
      return;
    }

    if (estimatedMemoryBytes < WORKER_MEMORY_EVICT_LOW_WATERMARK_BYTES) {
      workerMemoryPressureActiveRef.current = false;
      return;
    }

    if (
      workerMemoryPressureActiveRef.current
      || estimatedMemoryBytes < WORKER_MEMORY_EVICT_HIGH_WATERMARK_BYTES
    ) {
      return;
    }

    const inactiveDocumentIds = tabs
      .map((tab) => tab.id)
      .filter((documentId) => documentId !== activeTabId);
    if (inactiveDocumentIds.length === 0) {
      workerMemoryPressureActiveRef.current = true;
      return;
    }

    workerMemoryPressureActiveRef.current = true;
    void Promise.allSettled(inactiveDocumentIds.map((documentId) => worker.evictPreviews(documentId)))
      .then(() => refreshRenderBackendDiagnostics())
      .catch(() => {
        // Ignore memory-pressure eviction failures and keep the editor responsive.
      });
  }, [
    activeTabId,
    refreshRenderBackendDiagnostics,
    renderBackendDiagnostics.workerMemory?.estimatedMemoryBytes,
    tabs,
    WORKER_MEMORY_EVICT_HIGH_WATERMARK_BYTES,
    WORKER_MEMORY_EVICT_LOW_WATERMARK_BYTES,
  ]);

  useEffect(() => {
    if (!showSettingsModal) return;
    void refreshRenderBackendDiagnostics();
  }, [refreshRenderBackendDiagnostics, showSettingsModal]);

  useEffect(() => {
    const syncBrowserScale = () => {
      const next = window.devicePixelRatio || 1;
      setDisplayScaleFactor((current) => (Math.abs(current - next) < 0.001 ? current : next));
    };

    syncBrowserScale();

    if (!usesNativeFileDialogs) {
      window.addEventListener('resize', syncBrowserScale);
      return () => window.removeEventListener('resize', syncBrowserScale);
    }

    let cancelled = false;
    let unlistenScale: (() => void) | null = null;

    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();
        tauriWindowRef.current = appWindow;
        const scaleFactor = await appWindow.scaleFactor();
        if (!cancelled) {
          setDisplayScaleFactor(scaleFactor);
        }
        unlistenScale = await appWindow.onScaleChanged(({ payload }) => {
          setDisplayScaleFactor(payload.scaleFactor);
        });
      } catch {
        if (!cancelled) {
          syncBrowserScale();
        }
      }
    })();

    return () => {
      cancelled = true;
      tauriWindowRef.current = null;
      unlistenScale?.();
    };
  }, [usesNativeFileDialogs]);

  useEffect(() => {
    if (!documentState) return;
    if (isInteractingRef.current) return;
    const timer = window.setTimeout(() => {
      pushHistoryEntry(createDocumentHistoryEntry(documentState));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [documentState, pushHistoryEntry]);

  const setPreviewVisibility = useCallback((next: boolean) => {
    hasVisiblePreviewRef.current = next;
    setHasVisiblePreview(next);
  }, []);

  useEffect(() => {
    if (!hasVisiblePreview) {
      return;
    }

    setBlockingOverlay((current) => (current ? null : current));
  }, [hasVisiblePreview]);

  const drawPreview = useCallback((imageData: ImageData, imageBitmap: ImageBitmap | null) => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return null;

    const startedAt = performance.now();
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = getCanvas2dContext(canvas);
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    if (imageBitmap) {
      ctx.clearRect(0, 0, imageData.width, imageData.height);
      ctx.drawImage(imageBitmap, 0, 0, imageData.width, imageData.height);
      imageBitmap.close();
    } else {
      ctx.putImageData(imageData, 0, 0);
    }
    currentPreviewImageDataRef.current = imageData;
    setCanvasSize({ width: imageData.width, height: imageData.height });
    return Math.max(0, Math.round(performance.now() - startedAt));
  }, []);

  const cancelPendingPreviewRetry = useCallback(() => {
    if (previewRetryFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRetryFrameRef.current);
      previewRetryFrameRef.current = null;
    }
  }, []);

  const flushPendingPreview = useCallback(function attemptPreviewDraw(attempt = 0) {
    const pendingPreview = pendingPreviewRef.current;
    if (!pendingPreview) {
      previewRetryFrameRef.current = null;
      return;
    }

    if (pendingPreview.documentId !== activeDocumentIdRef.current) {
      pendingPreview.imageBitmap?.close();
      pendingPreviewRef.current = null;
      previewRetryFrameRef.current = null;
      return;
    }

    const canvasDrawMs = drawPreview(pendingPreview.imageData, pendingPreview.imageBitmap);
    if (canvasDrawMs !== null) {
      pendingPreviewRef.current = null;
      setRenderedPreviewAngle(pendingPreview.angle);
      setPreviewVisibility(true);
      workerClientRef.current?.recordPreviewPresentationTimings(
        pendingPreview.documentId,
        pendingPreview.revision,
        { canvasDrawMs },
      );
      previewRetryFrameRef.current = null;
      return;
    }

    if (attempt >= 30) {
      previewRetryFrameRef.current = null;
      setPreviewVisibility(false);
      appendDiagnostic({
        level: 'error',
        code: 'PREVIEW_DRAW_FAILED',
        message: pendingPreview.documentId,
        context: {
          attempt,
          documentId: pendingPreview.documentId,
        },
      });
      return;
    }

    previewRetryFrameRef.current = window.requestAnimationFrame(() => {
      attemptPreviewDraw(attempt + 1);
    });
  }, [drawPreview, setPreviewVisibility]);

  useEffect(() => {
    if (!displayCanvasRef.current) {
      return;
    }

    if (pendingPreviewRef.current?.documentId !== activeDocumentIdRef.current) {
      return;
    }

    flushPendingPreview();
  }, [documentState?.id, documentState?.status, flushPendingPreview]);

  useEffect(() => {
    const currentPreview = currentPreviewImageDataRef.current;
    if (!currentPreview || !displayCanvasRef.current) {
      return;
    }

    drawPreview(currentPreview, null);
  }, [comparisonMode, drawPreview]);

  const calculateTargetMaxDimension = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return 1024;
    return Math.max(512, Math.ceil(Math.max(viewport.clientWidth, viewport.clientHeight) * displayScaleFactor));
  }, [displayScaleFactor]);

  useEffect(() => {
    const updateTargetMaxDimension = () => {
      const nextValue = calculateTargetMaxDimension();
      setTargetMaxDimension((current) => (current === nextValue ? current : nextValue));
    };

    updateTargetMaxDimension();
    window.addEventListener('resize', updateTargetMaxDimension);

    const viewport = viewportRef.current;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateTargetMaxDimension);
    if (viewport && resizeObserver) {
      resizeObserver.observe(viewport);
    }

    return () => {
      window.removeEventListener('resize', updateTargetMaxDimension);
      resizeObserver?.disconnect();
    };
  }, [calculateTargetMaxDimension]);

  const executePreviewRender = useCallback(async (
    documentId: string,
    settings: ConversionSettings,
    isColor: boolean,
    filmType: 'negative' | 'slide',
    advancedInversion: FilmProfile['advancedInversion'] | null,
    nextComparisonMode: 'processed' | 'original',
    nextTargetMaxDimension: number,
    previewMode: 'draft' | 'settled',
    interactionQuality: InteractionQuality | null,
    histogramMode: HistogramMode,
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
    labStyleToneCurve?: FilmProfile['toneCurve'],
    labStyleChannelCurves?: { r?: FilmProfile['toneCurve']; g?: FilmProfile['toneCurve']; b?: FilmProfile['toneCurve'] },
    labTonalCharacterOverride?: Partial<TonalCharacter>,
    labSaturationBias?: number,
    labTemperatureBias?: number,
    highlightDensityEstimate?: number,
    flareFloor?: [number, number, number] | null,
    lightSourceBias?: [number, number, number],
  ) => {
    const worker = workerClientRef.current;
    if (!worker) return;

    const activeTabDocument = tabsRef.current.find((tab) => tab.id === documentId)?.document ?? null;
    const revision = (activeTabDocument?.renderRevision ?? 0) + 1;
    const inputProfileId = activeTabDocument
      ? getResolvedInputProfileId(activeTabDocument.source, activeTabDocument.colorManagement)
      : 'srgb';
    const outputProfileId = activeTabDocument?.colorManagement.outputProfileId ?? DEFAULT_EXPORT_OPTIONS.outputProfileId;
    const shouldTrackHeavyRenderIndicator = previewMode === 'settled' && interactionQuality === null;
    const adaptiveState = getSettledAdaptiveState(documentId);
    const resolvedHighlightDensityEstimate = shouldTrackHeavyRenderIndicator && nextComparisonMode === 'processed'
      ? (highlightDensityEstimate ?? adaptiveState.committedHighlightDensity)
      : highlightDensityEstimate;
    activeRenderRequestRef.current = { documentId, revision };
    const renderKey = createPreviewRenderKey({
      documentId,
      settings,
      isColor,
      filmType,
      advancedInversion,
      comparisonMode: nextComparisonMode,
      targetMaxDimension: nextTargetMaxDimension,
      inputProfileId,
      outputProfileId,
      maskTuning,
      colorMatrix,
      tonalCharacter,
      labStyleToneCurve,
      labStyleChannelCurves,
      labTonalCharacterOverride,
      labSaturationBias,
      labTemperatureBias,
      flareFloor,
      lightSourceBias,
    });
    if (shouldTrackHeavyRenderIndicator && adaptiveState.lastSettledKey !== renderKey) {
      adaptiveState.lastSettledKey = renderKey;
      adaptiveState.followUpCompletedForKey = null;
    }

    const shouldLogInteractiveDraftDiagnostics = !(previewMode === 'draft' && interactionQuality !== null);
    if (shouldLogInteractiveDraftDiagnostics) {
      appendDiagnostic({
        level: 'info',
        code: 'RENDER_REQUESTED',
        message: documentId,
        context: {
          comparisonMode: nextComparisonMode,
          documentId,
          previewMode,
          revision,
          targetMaxDimension: nextTargetMaxDimension,
        },
      });
    }

    setDocumentState((current) => current && current.id === documentId ? { ...current, status: 'processing', renderRevision: revision } : current);
    if (shouldTrackHeavyRenderIndicator) {
      scheduleRenderIndicator(documentId, revision);
    } else {
      clearRenderIndicator();
    }

    try {
      const result = await worker.render({
        documentId,
        settings,
        isColor,
        profileId: activeTabDocument?.profileId ?? null,
        filmType,
        advancedInversion,
        estimatedDensityBalance: activeTabDocument?.estimatedDensityBalance ?? null,
        inputProfileId,
        outputProfileId,
        revision,
        targetMaxDimension: nextTargetMaxDimension,
        comparisonMode: nextComparisonMode,
        previewMode,
        interactionQuality,
        histogramMode,
        maskTuning,
        colorMatrix,
        tonalCharacter,
        labStyleToneCurve,
        labStyleChannelCurves,
        labTonalCharacterOverride,
        labSaturationBias,
        labTemperatureBias,
        highlightDensityEstimate: resolvedHighlightDensityEstimate,
        flareFloor,
        lightSourceBias,
      });

      const isLatestResult = activeDocumentIdRef.current === result.documentId
        && activeRenderRequestRef.current?.documentId === result.documentId
        && activeRenderRequestRef.current?.revision === result.revision;

      if (!isLatestResult) {
        if (shouldLogInteractiveDraftDiagnostics) {
          appendDiagnostic({
            level: 'info',
            code: 'RENDER_STALE_IGNORED',
            message: result.documentId,
            context: {
              documentId: result.documentId,
              revision: result.revision,
              activeDocumentId: activeDocumentIdRef.current,
              activeRevision: activeRenderRequestRef.current?.revision ?? null,
            },
          });
        }
        return;
      }

      const normalizedImageData = normalizePreviewImageData(result.imageData, result.width, result.height);
      const shouldUseWorkerPreparedBitmap = previewMode === 'settled'
        && interactionQuality === null
        && normalizedImageData.width * normalizedImageData.height >= LARGE_SETTLED_PREVIEW_BITMAP_PIXELS;
      let imageBitmap: ImageBitmap | null = null;

      if (shouldUseWorkerPreparedBitmap) {
        const workerBitmapPrepStartedAt = performance.now();
        imageBitmap = await worker.preparePreviewBitmap(result.documentId, result.revision, normalizedImageData)
          .catch(() => null);
        if (imageBitmap) {
          worker.recordPreviewPresentationTimings(result.documentId, result.revision, {
            workerBitmapPrepMs: Math.max(0, Math.round(performance.now() - workerBitmapPrepStartedAt)),
          });
        }
      }

      if (!imageBitmap) {
        const createImageBitmapStartedAt = performance.now();
        imageBitmap = typeof createImageBitmap === 'function'
          ? await createImageBitmap(normalizedImageData).catch(() => null)
          : null;
        const createImageBitmapMs = typeof createImageBitmap === 'function'
          ? Math.max(0, Math.round(performance.now() - createImageBitmapStartedAt))
          : null;
        if (createImageBitmapMs !== null) {
          worker.recordPreviewPresentationTimings(result.documentId, result.revision, { createImageBitmapMs });
        }
      }

      const isStillLatestResult = activeDocumentIdRef.current === result.documentId
        && activeRenderRequestRef.current?.documentId === result.documentId
        && activeRenderRequestRef.current?.revision === result.revision;
      if (!isStillLatestResult) {
        imageBitmap?.close();
        return;
      }

      pendingPreviewRef.current?.imageBitmap?.close();
      pendingPreviewRef.current = {
        documentId: result.documentId,
        revision: result.revision,
        angle: settings.rotation + settings.levelAngle,
        imageData: normalizedImageData,
        imageBitmap,
      };
      clearRenderIndicator();
      cancelPendingPreviewRetry();
      flushPendingPreview();
      if (shouldLogInteractiveDraftDiagnostics) {
        appendDiagnostic({
          level: 'info',
          code: 'RENDER_COMPLETED',
          message: result.documentId,
          context: {
            documentId: result.documentId,
            height: result.height,
            previewLevelId: result.previewLevelId,
            revision: result.revision,
            width: result.width,
          },
        });
      }
      setDocumentState((current) => {
        if (!current || current.id !== documentId) return current;
        return {
          ...current,
          histogram: result.histogram,
          renderRevision: result.revision,
          status: 'ready',
        };
      });
      maybeSuggestBlackAndWhiteConversion(result.documentId, normalizedImageData, {
        comparisonMode: nextComparisonMode,
        previewMode,
        interactionQuality,
        isColor,
        blackAndWhiteEnabled: settings.blackAndWhite.enabled,
      });
      if (shouldTrackHeavyRenderIndicator) {
        lastCompletedSettledRenderKeyRef.current = renderKey;
        adaptiveState.committedHighlightDensity = result.highlightDensity;
        if (
          nextComparisonMode === 'processed'
          && adaptiveState.lastSettledKey === renderKey
          && adaptiveState.followUpCompletedForKey !== renderKey
          && Math.abs(result.highlightDensity - (resolvedHighlightDensityEstimate ?? 0)) > HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD
        ) {
          adaptiveState.followUpCompletedForKey = renderKey;
          enqueuePreviewRenderRef.current?.({
            documentId,
            settings,
            isColor,
            filmType,
            advancedInversion,
            comparisonMode: nextComparisonMode,
            targetMaxDimension: nextTargetMaxDimension,
            previewMode: 'settled',
            interactionQuality: null,
            histogramMode,
            maskTuning,
            colorMatrix,
            tonalCharacter,
            labStyleToneCurve,
            labStyleChannelCurves,
            labTonalCharacterOverride,
            labSaturationBias,
            labTemperatureBias,
            highlightDensityEstimate: result.highlightDensity,
            flareFloor,
            lightSourceBias,
          }, 'settled');
        }
      }
      if (shouldLogInteractiveDraftDiagnostics) {
        void refreshRenderBackendDiagnostics();
      }
    } catch (renderError) {
      const isLatestRequest = activeDocumentIdRef.current === documentId
        && activeRenderRequestRef.current?.documentId === documentId
        && activeRenderRequestRef.current?.revision === revision;
      if (!isLatestRequest) return;

      if (isIgnorableRenderError(renderError)) {
        return;
      }

      const message = formatError(renderError);
      clearRenderIndicator();
      appendDiagnostic({
        level: 'error',
        code: 'RENDER_FAILED',
        message,
        context: {
          comparisonMode: nextComparisonMode,
          documentId,
          previewMode,
          revision,
          targetMaxDimension: nextTargetMaxDimension,
        },
      });
      setError(`Processing failed. ${message}`);
      setDocumentState((current) => current && current.id === documentId ? { ...current, status: 'error', errorCode: 'RENDER_FAILED' } : current);
      if (shouldLogInteractiveDraftDiagnostics) {
        void refreshRenderBackendDiagnostics();
      }
    }
  }, [HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD, LARGE_SETTLED_PREVIEW_BITMAP_PIXELS, cancelPendingPreviewRetry, clearRenderIndicator, createPreviewRenderKey, documentState?.estimatedDensityBalance, drawPreview, flushPendingPreview, getSettledAdaptiveState, maybeSuggestBlackAndWhiteConversion, refreshRenderBackendDiagnostics, scheduleRenderIndicator, setDocumentState, setPreviewVisibility, tabsRef]);

  const {
    enqueueRender: enqueuePreviewRender,
    cancelPending: cancelPendingPreviewRender,
  } = useRenderQueue<QueuedPreviewRender>({
    render: async (next) => {
      await executePreviewRender(
        next.documentId,
        next.settings,
        next.isColor,
        next.filmType ?? 'negative',
        next.advancedInversion ?? null,
        next.comparisonMode,
        next.targetMaxDimension,
        next.previewMode,
        next.interactionQuality,
        next.histogramMode,
        next.maskTuning,
        next.colorMatrix,
        next.tonalCharacter,
        next.labStyleToneCurve,
        next.labStyleChannelCurves,
        next.labTonalCharacterOverride,
        next.labSaturationBias,
        next.labTemperatureBias,
        next.highlightDensityEstimate,
        next.flareFloor,
        next.lightSourceBias,
      );
    },
    cancelActive: (next) => {
      void workerClientRef.current?.cancelActivePreviewRender(next.documentId);
    },
    onCoalesced: () => {
      workerClientRef.current?.noteCoalescedPreviewRequest();
    },
  });

  useEffect(() => {
    enqueuePreviewRenderRef.current = enqueuePreviewRender;
    return () => {
      if (enqueuePreviewRenderRef.current === enqueuePreviewRender) {
        enqueuePreviewRenderRef.current = null;
      }
    };
  }, [enqueuePreviewRender]);

  const handlePanStart = useCallback((clientX: number, clientY: number) => {
    clearRenderIndicator();
    interactionJustEndedRef.current = false;
    cancelScheduledInteractivePreview();
    cancelPendingPreviewRender();
    if (activeDocumentIdRef.current) {
      void workerClientRef.current?.cancelActivePreviewRender(activeDocumentIdRef.current);
    }
    startPan(clientX, clientY);
  }, [cancelPendingPreviewRender, cancelScheduledInteractivePreview, clearRenderIndicator, startPan]);

  const handlePanEnd = useCallback(() => {
    endPan();
    lastInteractionTypeRef.current = 'pan';
    interactionJustEndedRef.current = true;
  }, [endPan]);

  useEffect(() => {
    if (!documentState || !displaySettings || documentState.previewLevels.length === 0) return;

    const documentId = documentState.id;
    const settings = displaySettings;
    const isColor = activeProfile.type === 'color';
    const profileMaskTuning = activeProfile.maskTuning;
    const profileColorMatrix = activeProfile.colorMatrix;
    const profileTonalCharacter = activeProfile.tonalCharacter;
    const profileFilmType = activeProfile.filmType ?? 'negative';
    const profileAdvancedInversion = activeProfile.advancedInversion ?? null;
    const highlightDensityEstimate = getSettledAdaptiveState(documentId).committedHighlightDensity;
    const lightSourceBias = lightSourceProfilesById.get(documentState.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1];
    const flareFloor = documentState.estimatedFlare;
    const previewMode = isDraftPreview ? 'draft' : 'settled';
    const interactionQuality: InteractionQuality | null = comparisonMode === 'processed'
      ? (
        isAdjustingCrop
          ? 'balanced'
          : (
            (isInteractingWithPreviewControls || isZooming)
              ? (ultraSmoothDragEnabled ? 'ultra-smooth' : 'balanced')
              : null
          )
      )
      : null;
    const histogramMode: HistogramMode = interactionQuality === 'ultra-smooth' && previewMode === 'draft'
      ? 'throttled'
      : 'full';
    const queuedPreview = {
      documentId,
      settings,
      isColor,
      filmType: profileFilmType,
      advancedInversion: profileAdvancedInversion,
      comparisonMode,
      targetMaxDimension: renderTargetDimension,
      previewMode,
      interactionQuality,
      histogramMode,
      maskTuning: profileMaskTuning,
      colorMatrix: profileColorMatrix,
      tonalCharacter: profileTonalCharacter,
      labStyleToneCurve: activeLabStyle?.toneCurve,
      labStyleChannelCurves: activeLabStyle?.channelCurves,
      labTonalCharacterOverride: activeLabStyle?.tonalCharacterOverride,
      labSaturationBias: activeLabStyle?.saturationBias ?? 0,
      labTemperatureBias: activeLabStyle?.temperatureBias ?? 0,
      highlightDensityEstimate,
      flareFloor,
      lightSourceBias,
    } satisfies QueuedPreviewRender;
    const queuedSettledRenderKey = previewMode === 'settled' && interactionQuality === null
      ? createPreviewRenderKey({
        documentId,
        settings,
        isColor,
        filmType: profileFilmType,
        advancedInversion: profileAdvancedInversion,
        comparisonMode,
        targetMaxDimension: renderTargetDimension,
        inputProfileId: getResolvedInputProfileId(documentState.source, documentState.colorManagement),
        outputProfileId: documentState.colorManagement.outputProfileId ?? DEFAULT_EXPORT_OPTIONS.outputProfileId,
        maskTuning: profileMaskTuning,
        colorMatrix: profileColorMatrix,
        tonalCharacter: profileTonalCharacter,
        labStyleToneCurve: activeLabStyle?.toneCurve,
        labStyleChannelCurves: activeLabStyle?.channelCurves,
        labTonalCharacterOverride: activeLabStyle?.tonalCharacterOverride,
        labSaturationBias: activeLabStyle?.saturationBias ?? 0,
        labTemperatureBias: activeLabStyle?.temperatureBias ?? 0,
        flareFloor,
        lightSourceBias,
      })
      : null;

    if (tabSwitchDraftRef.current === documentId && !isDraftPreview && previewMode === 'settled') {
      tabSwitchDraftRef.current = null;
      cancelScheduledInteractivePreview();

      const switchDraftTargetDimension = Math.min(fullRenderTargetDimension, ultraSmoothDragEnabled ? 768 : 1280);

      void executePreviewRender(
        documentId,
        settings,
        isColor,
        profileFilmType,
        profileAdvancedInversion,
        comparisonMode,
        switchDraftTargetDimension,
        'draft',
        'balanced',
        'throttled',
        profileMaskTuning,
        profileColorMatrix,
        profileTonalCharacter,
        activeLabStyle?.toneCurve,
        activeLabStyle?.channelCurves,
        activeLabStyle?.tonalCharacterOverride,
        activeLabStyle?.saturationBias ?? 0,
        activeLabStyle?.temperatureBias ?? 0,
        highlightDensityEstimate,
        flareFloor,
        lightSourceBias,
      ).finally(() => {
        if (activeDocumentIdRef.current !== documentId) {
          return;
        }

        enqueuePreviewRender(queuedPreview, 'settled');
      });
      return;
    }

    if (isPanDragging) {
      cancelScheduledInteractivePreview();
      return;
    }

    if (isInteractingWithPreviewControls || isAdjustingCrop || isZooming) {
      if (isZooming && !isInteractingWithPreviewControls && !isAdjustingCrop) {
        return;
      }
      if (pendingInteractivePreviewRef.current) {
        workerClientRef.current?.noteCoalescedPreviewRequest();
      }
      pendingInteractivePreviewRef.current = queuedPreview;
      if (interactivePreviewFrameRef.current === null) {
        interactivePreviewFrameRef.current = window.requestAnimationFrame(() => {
          interactivePreviewFrameRef.current = null;
          const nextInteractivePreview = pendingInteractivePreviewRef.current;
          pendingInteractivePreviewRef.current = null;
          if (nextInteractivePreview) {
            enqueuePreviewRender(nextInteractivePreview, 'draft');
          }
        });
      }
      return;
    }

    cancelScheduledInteractivePreview();
    if (
      queuedSettledRenderKey
      && hasVisiblePreviewRef.current
      && lastCompletedSettledRenderKeyRef.current === queuedSettledRenderKey
    ) {
      interactionJustEndedRef.current = false;
      lastInteractionTypeRef.current = null;
      clearRenderIndicator();
      return;
    }

    const justEndedInteraction = interactionJustEndedRef.current ? lastInteractionTypeRef.current : null;
    const debounceMs = isDraftPreview
      ? 40
      : (
        justEndedInteraction === 'zoom'
          ? SETTLED_RENDER_DEBOUNCE_MS.zoom
          : justEndedInteraction === 'pan'
            ? SETTLED_RENDER_DEBOUNCE_MS.pan
            : justEndedInteraction === 'control'
              ? SETTLED_RENDER_DEBOUNCE_MS.control
              : justEndedInteraction === 'crop'
                ? SETTLED_RENDER_DEBOUNCE_MS.crop
                : (hasVisiblePreviewRef.current ? 120 : SETTLED_RENDER_DEBOUNCE_MS.other)
      );
    interactionJustEndedRef.current = false;
    lastInteractionTypeRef.current = null;
    const timer = window.setTimeout(() => {
      enqueuePreviewRender(queuedPreview, previewMode === 'draft' ? 'draft' : 'settled');
    }, debounceMs);

    return () => window.clearTimeout(timer);
  }, [
    activeProfile.advancedInversion,
    activeProfile.colorMatrix,
    activeProfile.filmType,
    activeProfile.maskTuning,
    activeProfile.tonalCharacter,
    activeProfile.type,
    activeLabStyle,
    cancelScheduledInteractivePreview,
    comparisonMode,
    displaySettings,
    documentState?.id,
    documentState?.colorManagement,
    documentState?.estimatedFlare,
    documentState?.lightSourceId,
    documentState?.previewLevels.length,
    documentState?.source,
    enqueuePreviewRender,
    executePreviewRender,
    fullRenderTargetDimension,
    getSettledAdaptiveState,
    createPreviewRenderKey,
    clearRenderIndicator,
    isDraftPreview,
    isAdjustingCrop,
    isInteractingWithPreviewControls,
    isPanDragging,
    isZooming,
    lightSourceProfilesById,
    renderTargetDimension,
    ultraSmoothDragEnabled,
  ]);

  const {
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
  } = useWorkspaceCommands({
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
    setSidebarTab,
    setCropTab,
    isPickingFilmBase,
    activePointPicker,
    usesNativeFileDialogs,
    lightSourceProfiles: allLightSourceProfiles,
    defaultFlatFieldEnabled: calibration.activeProfileLoaded,
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
    cancelPendingPreviewRetry,
    cancelScheduledInteractivePreview,
    isSupportedFile,
    isRawFile,
    createDocumentColorManagement,
    formatError,
    getErrorCode,
    resolveRollId,
    getRollById,
  });

  useEffect(() => {
    convertToBlackAndWhiteActionRef.current = (documentId: string) => {
      if (!documentState || documentState.id !== documentId) {
        return;
      }

      handleSettingsChange({
        blackAndWhite: {
          ...documentState.settings.blackAndWhite,
          enabled: true,
        },
      });
      setSuggestionNotice(null);
      showTransientNotice('Converted to black and white.', 'success');
    };
  }, [documentState, handleSettingsChange, showTransientNotice]);

  const handleSelectFlatFieldProfile = useCallback(async (name: string | null) => {
    await calibration.selectActiveProfile(name);
    if (!documentState) {
      return;
    }

    updateDocument((current) => ({
      ...current,
      settings: {
        ...current.settings,
        flatFieldEnabled: Boolean(name),
      },
      dirty: true,
    }));
  }, [calibration, documentState, updateDocument]);

  const handleImportFlatFieldReference = useCallback(async (file: File) => {
    const importedName = await calibration.importFlatFieldFile(file);
    if (documentState) {
      updateDocument((current) => ({
        ...current,
        settings: {
          ...current.settings,
          flatFieldEnabled: true,
        },
        dirty: true,
      }));
    }
    return importedName;
  }, [calibration, documentState, updateDocument]);

  const handleDeleteFlatFieldProfile = useCallback(async (name: string) => {
    await calibration.removeProfile(name);
  }, [calibration]);

  const handleRenameFlatFieldProfile = useCallback(async (currentName: string, nextName: string) => {
    return calibration.renameProfile(currentName, nextName);
  }, [calibration]);

  const handleSaveCustomLightSource = useCallback(async (draft: Parameters<typeof saveCustomLightSource>[0]) => {
    return saveCustomLightSource(draft);
  }, [saveCustomLightSource]);

  const handleDeleteCustomLightSource = useCallback((id: string) => {
    deleteCustomLightSource(id);
  }, [deleteCustomLightSource]);

  const handleExportPresetBackup = useCallback(async () => {
    const payload = createPresetBackupFile(customPresets, presetFolders);
    const dateLabel = payload.exportedAt.slice(0, 10);
    return savePresetBackupFile(
      JSON.stringify(payload, null, 2),
      `darkslide-presets-${dateLabel}.darkslide-library`,
    );
  }, [customPresets, presetFolders]);

  const handleImportPresetBackup = useCallback(async (file?: File) => {
    const opened = file
      ? { content: await file.text(), fileName: file.name }
      : await openPresetBackupFile();

    if (!opened) {
      return 'cancelled' as const;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(opened.content);
    } catch {
      throw new Error(`Preset backup import failed. ${opened.fileName} is not valid JSON.`);
    }

    const backup = validatePresetBackupFile(parsed);
    if (!backup) {
      throw new Error(`Preset backup import failed. ${opened.fileName} is not a valid preset backup.`);
    }

    const confirmed = await confirmReplacePresetLibrary();
    if (!confirmed) {
      return 'cancelled' as const;
    }

    replaceLibrary(backup.presets, backup.folders);
    return 'imported' as const;
  }, [replaceLibrary]);

  const handleSaveQuickExportPreset = useCallback(() => {
    const baseOptions = documentState?.exportOptions ?? defaultExportOptions;
    const name = promptText('Save current export settings as a quick preset', 'Custom Export');
    if (!name) {
      return;
    }

    setQuickExportPresets((current) => {
      const next = [...current, createFromCurrentSettings(name, baseOptions)];
      saveQuickExportPresets(next);
      return loadQuickExportPresets();
    });
  }, [defaultExportOptions, documentState?.exportOptions]);

  const handleDeleteQuickExportPreset = useCallback((presetId: string) => {
    setQuickExportPresets((current) => {
      const next = current.filter((preset) => preset.id !== presetId);
      saveQuickExportPresets(next);
      return loadQuickExportPresets();
    });
  }, []);

  const wrappedHandleExportOptionsChange = useCallback((options: Partial<ExportOptions>) => {
    handleExportOptionsChange(options);
    if (!documentState) {
      setDefaultExportOptions((current) => ({ ...current, ...options }));
    }
  }, [handleExportOptionsChange, documentState]);

  const handleDefaultLightSourceChange = useCallback((lightSourceId: string) => {
    const nextId = lightSourceId || 'auto';
    setDefaultLightSourceId(nextId);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('darkslide_default_light_source', nextId);
    }
  }, []);

  const handleDefaultLabStyleChange = useCallback((labStyleId: string) => {
    setDefaultLabStyleId(labStyleId);
    if (typeof window !== 'undefined') {
      if (labStyleId) {
        window.localStorage.setItem('darkslide_default_lab_style', labStyleId);
      } else {
        window.localStorage.removeItem('darkslide_default_lab_style');
      }
    }
  }, []);

  useEffect(() => {
    if (!documentState || calibration.activeProfileLoaded || !documentState.settings.flatFieldEnabled) {
      return;
    }

    updateDocument((current) => ({
      ...current,
      settings: {
        ...current.settings,
        flatFieldEnabled: false,
      },
      dirty: current.dirty,
    }));
  }, [calibration.activeProfileLoaded, documentState, updateDocument]);

  const handleToggleComparison = useCallback(() => {
    setComparisonMode((current) => current === 'processed' ? 'original' : 'processed');
  }, []);

  const handleToggleCropOverlay = useCallback(() => {
    setDustBrushActive(false);
    setIsCropOverlayVisible((current) => !current);
  }, []);

  const handleDustRemovalChange = useCallback((dustRemoval: ConversionSettings['dustRemoval']) => {
    handleSettingsChange({
      dustRemoval: resolveDustRemovalSettings(dustRemoval ?? DEFAULT_DUST_REMOVAL),
    });
  }, [handleSettingsChange]);

  const handleDustOverlayChange = useCallback((marks: NonNullable<ConversionSettings['dustRemoval']>['marks']) => {
    const resolvedDustRemoval = resolveDustRemovalSettings(documentState?.settings.dustRemoval ?? DEFAULT_DUST_REMOVAL);
    handleSettingsChange({
      dustRemoval: {
        ...resolvedDustRemoval,
        marks,
      },
    });
  }, [documentState?.settings.dustRemoval, handleSettingsChange]);

  const handleDustBrushActiveChange = useCallback((active: boolean) => {
    setDustBrushActive(active);
    if (!active) {
      return;
    }

    setIsCropOverlayVisible(false);
    setIsPickingFilmBase(false);
    setActivePointPicker(null);
    setSidebarTab('dust');
  }, []);

  const handleSetActivePointPicker = useCallback((mode: PointPickerMode | null) => {
    if (mode) {
      setDustBrushActive(false);
      setIsPickingFilmBase(false);
      setIsCropOverlayVisible(false);
    }
    setActivePointPicker(mode);
  }, []);

  const handleFilmBasePickerToggle = useCallback(() => {
    setDustBrushActive(false);
    handleToggleFilmBasePicker();
  }, [handleToggleFilmBasePicker]);

  const handleToggleDustBrush = useCallback(() => {
    handleDustBrushActiveChange(!dustBrushActive);
  }, [dustBrushActive, handleDustBrushActiveChange]);

  const handleAdjustDustBrushRadius = useCallback((delta: number) => {
    const dustRemoval = resolveDustRemovalSettings(documentState?.settings.dustRemoval ?? DEFAULT_DUST_REMOVAL);
    handleSettingsChange({
      dustRemoval: {
        ...dustRemoval,
        manualBrushRadius: Math.min(50, Math.max(2, dustRemoval.manualBrushRadius + delta)),
      },
    });
  }, [documentState?.settings.dustRemoval, handleSettingsChange]);

  const handleRemoveLastDustMark = useCallback(() => {
    if (!documentState) {
      return;
    }
    const dustRemoval = resolveDustRemovalSettings(documentState?.settings.dustRemoval ?? DEFAULT_DUST_REMOVAL);
    const manualMarks = dustRemoval.marks.filter((mark) => mark.source === 'manual');
    const lastManual = manualMarks[manualMarks.length - 1];
    if (!lastManual) {
      return;
    }

    pushHistoryEntry(createDocumentHistoryEntry(documentState));
    handleSettingsChange({
      dustRemoval: {
        ...dustRemoval,
        marks: dustRemoval.marks.filter((mark) => mark.id !== lastManual.id),
      },
    });
  }, [documentState, handleSettingsChange, pushHistoryEntry]);

  const handleDetectDust = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState || isDetectingDust) {
      return;
    }

    const dustRemoval = resolveDustRemovalSettings(documentState.settings.dustRemoval ?? DEFAULT_DUST_REMOVAL);
    setIsDetectingDust(true);
    try {
      const detectedMarks = await worker.detectDust(
        documentState.id,
        dustRemoval.autoSensitivity,
        dustRemoval.autoMaxRadius,
        dustRemoval.autoDetectMode,
      );
      const latestDocument = tabsRef.current.find((tab) => tab.id === documentState.id)?.document ?? null;
      if (!latestDocument) {
        return;
      }

      const latestDustRemoval = resolveDustRemovalSettings(latestDocument.settings.dustRemoval ?? DEFAULT_DUST_REMOVAL);
      const manualMarks = latestDustRemoval.marks.filter((mark) => mark.source === 'manual');
      pushHistoryEntry(createDocumentHistoryEntry(latestDocument));
      handleSettingsChange({
        dustRemoval: {
          ...latestDustRemoval,
          marks: [...manualMarks, ...detectedMarks],
        },
      });
    } catch (error) {
      showTransientNotice(formatError(error));
    } finally {
      setIsDetectingDust(false);
    }
  }, [documentState, formatError, handleSettingsChange, isDetectingDust, pushHistoryEntry, showTransientNotice, tabsRef]);

  const lastAutoDustDetectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const dustRemoval = documentState?.settings.dustRemoval;
    if (!documentState || !dustRemoval?.autoEnabled) {
      lastAutoDustDetectionKeyRef.current = null;
      return;
    }

    const key = [
      documentState.id,
      dustRemoval.autoDetectMode,
      dustRemoval.autoSensitivity,
      dustRemoval.autoMaxRadius,
    ].join(':');

    if (lastAutoDustDetectionKeyRef.current === null) {
      lastAutoDustDetectionKeyRef.current = key;
      return;
    }

    if (lastAutoDustDetectionKeyRef.current === key) {
      return;
    }

    lastAutoDustDetectionKeyRef.current = key;
    void handleDetectDust();
  }, [documentState?.id, documentState?.settings.dustRemoval, handleDetectDust]);

  const handleToggleLeftPane = useCallback(() => {
    setIsLeftPaneOpen((current) => {
      const next = !current;
      savePreferences({ ...prefsSnapshotRef.current, isLeftPaneOpen: next });
      return next;
    });
  }, []);

  const handleToggleRightPane = useCallback(() => {
    setIsRightPaneOpen((current) => {
      const next = !current;
      savePreferences({ ...prefsSnapshotRef.current, isRightPaneOpen: next });
      return next;
    });
  }, []);

  const handleAutoAdjust = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState || !displaySettings) {
      return;
    }

    const defaults = activeProfile.defaultSettings;
    const hasManualAdjustments = documentState.settings.exposure !== defaults.exposure
      || documentState.settings.temperature !== defaults.temperature
      || documentState.settings.tint !== defaults.tint
      || documentState.settings.blackPoint !== defaults.blackPoint
      || documentState.settings.whitePoint !== defaults.whitePoint;

    if (hasManualAdjustments && !await confirmOverwriteAutoAdjust()) {
      return;
    }

    const requestDocumentId = documentState.id;
    const requestRevision = documentState.renderRevision;
    const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
    const outputProfileId = documentState.colorManagement.outputProfileId ?? DEFAULT_EXPORT_OPTIONS.outputProfileId;
    const lightSourceBias = lightSourceProfilesById.get(documentState.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1];
    const result = await worker.autoAnalyze({
      documentId: requestDocumentId,
      settings: displaySettings,
      isColor: activeProfile.type === 'color',
      profileId: activeProfile.id,
      filmType: activeProfile.filmType,
      advancedInversion: activeProfile.advancedInversion ?? null,
      inputProfileId,
      outputProfileId,
      targetMaxDimension: Math.min(targetMaxDimension, 1024),
      maskTuning: activeProfile.maskTuning,
      colorMatrix: activeProfile.colorMatrix,
      tonalCharacter: activeProfile.tonalCharacter,
      labStyleToneCurve: activeLabStyle?.toneCurve,
      labStyleChannelCurves: activeLabStyle?.channelCurves,
      labTonalCharacterOverride: activeLabStyle?.tonalCharacterOverride,
      labSaturationBias: activeLabStyle?.saturationBias ?? 0,
      labTemperatureBias: activeLabStyle?.temperatureBias ?? 0,
      highlightDensityEstimate: documentState.histogram ? computeHighlightDensity(documentState.histogram) : 0,
      flareFloor: documentState.estimatedFlare,
      lightSourceBias,
    }).catch((error) => {
      const message = formatError(error);
      showTransientNotice(`Auto analysis failed. ${message}`);
      return null;
    });

    if (!result) {
      return;
    }

    const latestDocument = tabsRef.current.find((tab) => tab.id === requestDocumentId)?.document ?? null;
    if (
      activeDocumentIdRef.current !== requestDocumentId
      || !latestDocument
      || latestDocument.renderRevision !== requestRevision
    ) {
      return;
    }

    const nextSettings: Partial<ConversionSettings> = {
      exposure: result.exposure,
      blackPoint: result.blackPoint,
      whitePoint: result.whitePoint,
    };

    if (result.temperature !== null && result.tint !== null) {
      nextSettings.temperature = result.temperature;
      nextSettings.tint = result.tint;
    }

    if (result.contrast !== null) {
      nextSettings.contrast = result.contrast;
    }

    if (result.suggestedCurves || result.midtoneBoostPoint) {
      const currentCurves = latestDocument.settings.curves;
      nextSettings.curves = {
        ...currentCurves,
        rgb: result.midtoneBoostPoint
          ? [{ x: 0, y: 0 }, result.midtoneBoostPoint, { x: 255, y: 255 }]
          : currentCurves.rgb,
        red: result.suggestedCurves?.redFloor !== null && result.suggestedCurves?.redFloor !== undefined
          ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.redFloor, y: 0 }, { x: 255, y: 255 }]
          : currentCurves.red,
        green: result.suggestedCurves?.greenFloor !== null && result.suggestedCurves?.greenFloor !== undefined
          ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.greenFloor, y: 0 }, { x: 255, y: 255 }]
          : currentCurves.green,
        blue: result.suggestedCurves?.blueFloor !== null && result.suggestedCurves?.blueFloor !== undefined
          ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.blueFloor, y: 0 }, { x: 255, y: 255 }]
          : currentCurves.blue,
      };
    }

    handleSettingsChange(nextSettings);
    if (result.temperature === null || result.tint === null) {
      showTransientNotice('Auto adjusted tone, but left white balance unchanged.');
    }
  }, [
    activeProfile.advancedInversion,
    activeLabStyle?.channelCurves,
    activeLabStyle?.saturationBias,
    activeLabStyle?.temperatureBias,
    activeLabStyle?.toneCurve,
    activeLabStyle?.tonalCharacterOverride,
    activeProfile,
    displaySettings,
    documentState,
    handleSettingsChange,
    lightSourceProfilesById,
    showTransientNotice,
    tabsRef,
    targetMaxDimension,
  ]);

  const handleOpenRollInfo = useCallback((rollId: string) => {
    setActiveRollInfoId(rollId);
  }, []);

  const handleSaveRollMetadata = useCallback((rollId: string, updates: Partial<Roll>) => {
    updateRoll(rollId, {
      name: updates.name?.trim() || 'Untitled Roll',
      filmStock: updates.filmStock?.trim() || null,
      camera: updates.camera?.trim() || null,
      date: updates.date?.trim() || null,
      notes: updates.notes ?? '',
    });
    setActiveRollInfoId(null);
  }, [updateRoll]);

  const handleSyncRollSettings = useCallback(async (tabId: string, rollId: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId) ?? null;
    const roll = getRollById(rollId);
    const rollTabs = tabsRef.current.filter((candidate) => candidate.rollId === rollId);
    if (!tab || !roll || rollTabs.length < 2) {
      return;
    }

    const confirmed = await confirmSyncSettings(tab.document.source.name, rollTabs.length - 1, roll.name);
    if (!confirmed) return;

    syncSettingsToRoll(tabId, rollId);
    showTransientNotice(`Synced ${roll.name} from ${tab.document.source.name}.`, 'success');
  }, [getRollById, showTransientNotice, syncSettingsToRoll, tabsRef]);

  const handleApplyRollFilmBase = useCallback(async (rollId: string) => {
    const sourceDocument = tabsRef.current.find((tab) => tab.rollId === rollId && tab.document.settings.filmBaseSample)?.document ?? null;
    const roll = getRollById(rollId);
    if (!sourceDocument?.settings.filmBaseSample || !roll) {
      showTransientNotice('Sample a film base on one frame before syncing it to the roll.');
      return;
    }

    const confirmed = await confirmSyncFilmBase(roll.name);
    if (!confirmed) return;

    applyFilmBaseToRoll(sourceDocument.settings.filmBaseSample, rollId);
    showTransientNotice(`Applied ${roll.name} film base to the full roll.`, 'success');
  }, [applyFilmBaseToRoll, getRollById, showTransientNotice, tabsRef]);

  const handleRemoveFromRoll = useCallback((tabId: string) => {
    assignToRoll([tabId], null);
    showTransientNotice('Removed frame from its roll.', 'success');
  }, [assignToRoll, showTransientNotice]);

  const handleCreateRollFromTabs = useCallback(() => {
    const unrolledTabs = tabsRef.current.filter((tab) => !tab.rollId);
    if (unrolledTabs.length === 0) {
      showTransientNotice('All open tabs are already in a roll.');
      return;
    }
    const roll = createRoll('Untitled Roll');
    assignToRoll(unrolledTabs.map((tab) => tab.id), roll.id);
    showTransientNotice(`Created roll with ${unrolledTabs.length} frame${unrolledTabs.length === 1 ? '' : 's'}.`, 'success');
  }, [assignToRoll, createRoll, showTransientNotice, tabsRef]);

  const handleDeleteRoll = useCallback(async (rollId: string) => {
    const roll = rolls.get(rollId);
    if (!roll) return;

    const docIds = getDocumentsInRoll(rollId);
    const frameInfo = docIds.length > 0
      ? `\n\n${docIds.length} frame${docIds.length === 1 ? '' : 's'} will be unlinked from this roll (images won't be deleted).`
      : '';

    const confirmed = await confirmDeleteRoll(roll.name, frameInfo);
    if (!confirmed) return;

    if (docIds.length > 0) {
      assignToRoll(docIds, null);
    }

    deleteRoll(rollId);
    setActiveRollInfoId(null);
  }, [assignToRoll, deleteRoll, getDocumentsInRoll, rolls]);

const runAutoAdjustForDocument = useCallback(async (documentId: string) => {
    const worker = workerClientRef.current;
    const tab = tabsRef.current.find((candidate) => candidate.id === documentId) ?? null;
    if (!worker || !tab) {
      return;
    }

    const profile = profilesById.get(tab.document.profileId) ?? fallbackProfile;
    const labStyle = tab.document.labStyleId ? LAB_STYLE_PROFILES_MAP[tab.document.labStyleId] ?? null : null;
    const outputProfileId = tab.document.colorManagement.outputProfileId ?? DEFAULT_EXPORT_OPTIONS.outputProfileId;
    const lightSourceBias = lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1];
    const result = await worker.autoAnalyze({
      documentId,
      settings: tab.document.settings,
      isColor: profile.type === 'color',
      profileId: profile.id,
      filmType: profile.filmType,
      advancedInversion: profile.advancedInversion ?? null,
      inputProfileId: getResolvedInputProfileId(tab.document.source, tab.document.colorManagement),
      outputProfileId,
      targetMaxDimension: Math.min(targetMaxDimension, 1024),
      maskTuning: profile.maskTuning,
      colorMatrix: profile.colorMatrix,
      tonalCharacter: profile.tonalCharacter,
      labStyleToneCurve: labStyle?.toneCurve,
      labStyleChannelCurves: labStyle?.channelCurves,
      labTonalCharacterOverride: labStyle?.tonalCharacterOverride,
      labSaturationBias: labStyle?.saturationBias ?? 0,
      labTemperatureBias: labStyle?.temperatureBias ?? 0,
      highlightDensityEstimate: tab.document.histogram ? computeHighlightDensity(tab.document.histogram) : 0,
      flareFloor: tab.document.estimatedFlare,
      lightSourceBias,
    });

    updateTabById(documentId, (currentTab) => {
      const curveOverrides: Partial<ConversionSettings> = {};
      if (result.suggestedCurves || result.midtoneBoostPoint) {
        const currentCurves = currentTab.document.settings.curves;
        curveOverrides.curves = {
          ...currentCurves,
          rgb: result.midtoneBoostPoint
            ? [{ x: 0, y: 0 }, result.midtoneBoostPoint, { x: 255, y: 255 }]
            : currentCurves.rgb,
          red: result.suggestedCurves?.redFloor !== null && result.suggestedCurves?.redFloor !== undefined
            ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.redFloor, y: 0 }, { x: 255, y: 255 }]
            : currentCurves.red,
          green: result.suggestedCurves?.greenFloor !== null && result.suggestedCurves?.greenFloor !== undefined
            ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.greenFloor, y: 0 }, { x: 255, y: 255 }]
            : currentCurves.green,
          blue: result.suggestedCurves?.blueFloor !== null && result.suggestedCurves?.blueFloor !== undefined
            ? [{ x: 0, y: 0 }, { x: result.suggestedCurves.blueFloor, y: 0 }, { x: 255, y: 255 }]
            : currentCurves.blue,
        };
      }
      return {
        ...currentTab,
        document: {
          ...currentTab.document,
          settings: {
            ...currentTab.document.settings,
            exposure: result.exposure,
            blackPoint: result.blackPoint,
            whitePoint: result.whitePoint,
            temperature: result.temperature ?? currentTab.document.settings.temperature,
            tint: result.tint ?? currentTab.document.settings.tint,
            ...(result.contrast !== null ? { contrast: result.contrast } : {}),
            ...curveOverrides,
          },
          dirty: true,
        },
      };
    });
  }, [fallbackProfile, lightSourceProfilesById, profilesById, tabsRef, targetMaxDimension, updateTabById]);

  const runAutoCropForDocument = useCallback(async (documentId: string) => {
    const worker = workerClientRef.current;
    if (!worker) {
      return;
    }

    const detected = await worker.detectFrame(documentId);
    if (!detected) {
      return;
    }

    updateTabById(documentId, (currentTab) => ({
      ...currentTab,
      document: {
        ...currentTab.document,
        settings: {
          ...currentTab.document.settings,
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
      },
    }));
  }, [updateTabById]);

  const exportDocumentToDirectory = useCallback(async (documentId: string, outputPath: string) => {
    const worker = workerClientRef.current;
    const tab = tabsRef.current.find((candidate) => candidate.id === documentId) ?? null;
    if (!worker || !tab) {
      return;
    }

    const profile = profilesById.get(tab.document.profileId) ?? fallbackProfile;
    const labStyle = tab.document.labStyleId ? LAB_STYLE_PROFILES_MAP[tab.document.labStyleId] ?? null : null;
    const lightSourceBias = lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1];
    const result = await worker.export({
      documentId,
      settings: tab.document.settings,
      isColor: profile.type === 'color' && !tab.document.settings.blackAndWhite.enabled,
      profileId: profile.id,
      filmType: profile.filmType,
      advancedInversion: profile.advancedInversion ?? null,
      inputProfileId: getResolvedInputProfileId(tab.document.source, tab.document.colorManagement),
      outputProfileId: tab.document.exportOptions.outputProfileId,
      options: tab.document.exportOptions,
      sourceExif: tab.document.source.exif,
      flareFloor: tab.document.estimatedFlare,
      lightSourceBias,
      maskTuning: profile.maskTuning,
      colorMatrix: profile.colorMatrix,
      tonalCharacter: profile.tonalCharacter,
      labStyleToneCurve: labStyle?.toneCurve,
      labStyleChannelCurves: labStyle?.channelCurves,
      labTonalCharacterOverride: labStyle?.tonalCharacterOverride,
      labSaturationBias: labStyle?.saturationBias ?? 0,
      labTemperatureBias: labStyle?.temperatureBias ?? 0,
      highlightDensityEstimate: tab.document.histogram ? computeHighlightDensity(tab.document.histogram) : 0,
    });

    await saveToDirectory(result.blob, result.filename, outputPath);
    await worker.evictPreviews(documentId).catch(() => undefined);
  }, [fallbackProfile, lightSourceProfilesById, profilesById, tabsRef]);

  const processScannedFile = useCallback(async (path: string, options: { autoExport: boolean; autoExportPath: string | null }) => {
    const result = await openImageFileByPath(path);
    if (!result) {
      throw new Error('Could not open scanned file.');
    }

    const documentId = await importFile(result.file, result.path, result.size);
    if (!documentId) {
      throw new Error('Could not import scanned file.');
    }

    await runAutoCropForDocument(documentId).catch(() => undefined);
    await runAutoAdjustForDocument(documentId).catch(() => undefined);

    if (options.autoExport && options.autoExportPath) {
      await exportDocumentToDirectory(documentId, options.autoExportPath);
      return { documentId, exported: true };
    }

    return { documentId, exported: false };
  }, [exportDocumentToDirectory, importFile, runAutoAdjustForDocument, runAutoCropForDocument]);

  const { session: scanningSession, startWatching, stopWatching, setAutoExport: configureScanningAutoExport, setWatchPath: setScanningSessionWatchPath, setAutoExportPath: setScanningSessionAutoExportPath, clearQueue: clearScanningQueue } = useScanningSession({
    initialWatchPath: scanningWatchPath,
    initialAutoExport: scanningAutoExport,
    initialAutoExportPath: scanningAutoExportPath,
    processScan: processScannedFile,
  });

  const { state: updateState, checkNow: checkForUpdatesNow, startDownload: downloadUpdateNow, dismiss: dismissUpdate } = useAutoUpdate(updateChannel);

  const handleChooseScanningWatchPath = useCallback(async () => {
    const selected = await openDirectory();
    if (!selected) {
      return;
    }
    setScanningWatchPath(selected);
    setScanningSessionWatchPath(selected);
    savePreferences({ ...prefsSnapshotRef.current, scanningWatchPath: selected });
  }, [setScanningSessionWatchPath]);

  const handleChooseScanningAutoExportPath = useCallback(async () => {
    const selected = await openDirectory();
    if (!selected) {
      return;
    }
    setScanningAutoExportPath(selected);
    setScanningSessionAutoExportPath(selected);
    savePreferences({ ...prefsSnapshotRef.current, scanningAutoExportPath: selected });
  }, [setScanningSessionAutoExportPath]);

  const handleToggleScanningWatcher = useCallback(async () => {
    if (scanningSession.isWatching) {
      await stopWatching();
      return;
    }

    if (!scanningSession.watchPath) {
      await handleChooseScanningWatchPath();
      return;
    }

    await startWatching(scanningSession.watchPath);
  }, [handleChooseScanningWatchPath, scanningSession.isWatching, scanningSession.watchPath, startWatching, stopWatching]);

  const handleScanningAutoExportChange = useCallback((enabled: boolean) => {
    setScanningAutoExport(enabled);
    configureScanningAutoExport(enabled, scanningAutoExportPath);
    savePreferences({ ...prefsSnapshotRef.current, scanningAutoExport: enabled });
  }, [configureScanningAutoExport, scanningAutoExportPath]);

  const { toggleScanningWindow } = useScanningSessionWindow({
    session: scanningSession,
    onPickWatchPath: () => { void handleChooseScanningWatchPath(); },
    onToggleWatching: () => { void handleToggleScanningWatcher(); },
    onToggleAutoExport: handleScanningAutoExportChange,
    onPickAutoExportPath: () => { void handleChooseScanningAutoExportPath(); },
    onSelectTab: handleSelectTab,
    onClearQueue: clearScanningQueue,
  });

  const handleUpdateChannelChange = useCallback((channel: UpdateChannel) => {
    setUpdateChannel(channel);
    savePreferences({ ...prefsSnapshotRef.current, updateChannel: channel });
  }, []);

  useAppShortcuts({
    tabs,
    activeTabId,
    setActiveTabId,
    documentStatePresent: Boolean(documentState),
    isCropOverlayVisible,
    dustBrushActive,
    usesNativeFileDialogs,
    setShowBatchModal,
    setShowSettingsModal,
    setIsSpaceHeld,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onOpenImage: handleOpenImage,
    onOpenRecentFile: importFile,
    onOpenInEditor: async () => { await handleOpenInEditor(); },
    onCloseImage: async () => { await handleCloseImage(); },
    onDownload: async () => { await handleDownload(); },
    quickExportPresets,
    onQuickExport: async (preset) => { await handleQuickExport(preset); },
    onReset: handleReset,
    onCopyDebugInfo: handleCopyDebugInfo,
    onToggleComparison: handleToggleComparison,
    onAutoAdjust: () => { void handleAutoAdjust(); },
    onToggleCropOverlay: handleToggleCropOverlay,
    onToggleDustBrush: handleToggleDustBrush,
    onDecreaseDustBrushRadius: () => handleAdjustDustBrushRadius(-2),
    onIncreaseDustBrushRadius: () => handleAdjustDustBrushRadius(2),
    onRemoveLastDustMark: handleRemoveLastDustMark,
    onDeactivateDustBrush: () => handleDustBrushActiveChange(false),
    onToggleLeftPane: handleToggleLeftPane,
    onToggleRightPane: handleToggleRightPane,
onToggleScanningSession: toggleScanningWindow,
    onCheckForUpdates: () => { void checkForUpdatesNow(); },
    zoomToFit: zoomToFitWithDraft,
    zoomTo100: zoomTo100WithDraft,
    zoomIn: zoomInWithDraft,
    zoomOut: zoomOutWithDraft,
  });

  const showBlockingOverlay = Boolean(blockingOverlay);
  const overlayContent = blockingOverlay;
  const isExporting = documentState?.status === 'exporting';

  return (
    <>
      <AppShell
      usesNativeFileDialogs={usesNativeFileDialogs}
      fileInputRef={fileInputRef}
      displayCanvasRef={displayCanvasRef}
      viewportRef={viewportRef}
      panTransformRef={panTransformRef}
      panGeometryRef={panGeometryRef}
      workerClient={workerClientRef.current}
      documentState={documentState}
      activeTab={activeTab}
      tabs={tabs}
      activeTabId={activeTabId}
      canUndo={canUndo}
      canRedo={canRedo}
      fallbackProfile={fallbackProfile}
      activeProfile={activeProfile}
      activeLabStyle={activeLabStyle}
      builtinProfiles={builtinProfiles}
      labStyleProfiles={LAB_STYLE_PROFILES}
      lightSourceProfiles={allLightSourceProfiles}
      customPresets={customPresets}
      presetFolders={presetFolders}
      savePresetTags={savePresetTags}
      sidebarTab={sidebarTab}
      dustBrushActive={dustBrushActive}
      isDetectingDust={isDetectingDust}
      cropTab={cropTab}
      comparisonMode={comparisonMode}
      isLeftPaneOpen={isLeftPaneOpen}
      isRightPaneOpen={isRightPaneOpen}
      isPickingFilmBase={isPickingFilmBase}
      activePointPicker={activePointPicker}
      isAdjustingLevel={isAdjustingLevel}
      isAdjustingCrop={isAdjustingCrop}
      isPanDragging={isPanDragging}
      isSpaceHeld={isSpaceHeld}
      isDragActive={isDragActive}
      showSettingsModal={showSettingsModal}
      showBatchModal={showBatchModal}
      showContactSheetModal={showContactSheetModal}
      showTabSwitchOverlay={showTabSwitchOverlay}
      tabSwitchOverlayKey={tabSwitchOverlayKey}
      showMagnifier={showMagnifier}
      isCropOverlayVisible={isCropOverlayVisible}
      showBlockingOverlay={showBlockingOverlay}
      isRenderIndicatorVisible={isRenderIndicatorVisible}
      overlayContent={overlayContent}
      error={error}
      suggestionNotice={suggestionNotice}
      transientNotice={transientNotice}
      isExporting={Boolean(isExporting)}
      gpuRenderingEnabled={gpuRenderingEnabled}
      ultraSmoothDragEnabled={ultraSmoothDragEnabled}
      notificationSettings={notificationSettings}
      defaultColorNegativeInversion={defaultColorNegativeInversion}
      renderBackendDiagnostics={renderBackendDiagnostics}
      defaultLightSourceId={defaultLightSourceId}
      defaultLabStyleId={defaultLabStyleId}
      onDefaultLabStyleChange={handleDefaultLabStyleChange}
      flatFieldProfileNames={calibration.profileNames}
      activeFlatFieldProfileName={calibration.activeProfileName}
      activeFlatFieldLoaded={calibration.activeProfileLoaded}
      activeFlatFieldPreview={calibration.activeProfilePreview}
      maxResidentDocs={maxResidentDocs}
      externalEditorPath={externalEditorPath}
      externalEditorName={externalEditorName}
      openInEditorOutputPath={openInEditorOutputPath}
      defaultExportPath={defaultExportPath}
      batchOutputPath={batchOutputPath}
      contactSheetOutputPath={contactSheetOutputPath}
      customPresetCount={customPresets.length}
      presetFolderCount={presetFolders.length}
      quickExportPresets={quickExportPresets}
      updaterEnabled={updateState.enabled}
      updaterDisabledReason={updateState.disabledReason}
      updateChannel={updateChannel}
      updateLastCheckedAt={updateState.lastCheckedAt}
      updateError={updateState.error}
      isCheckingForUpdates={updateState.isChecking}
      activeRoll={activeRoll}
      rolls={rolls}
      filmstripTabs={filmstripTabs}
      getRollById={getRollById}
      profilesById={profilesById}
      lightSourceProfilesById={lightSourceProfilesById}
      zoom={zoom}
      fitScale={fitScale}
      effectiveZoom={effectiveZoom}
      pan={pan}
      previewTransformAngle={previewTransformAngle}
      logicalPreviewSize={logicalPreviewSize}
      cropImageSize={cropImageSize}
      contactSheetEntries={contactSheetEntries}
      contactSheetSharedSettings={contactSheetSharedSettings}
      contactSheetSharedProfile={contactSheetSharedProfile}
      contactSheetSharedLabStyle={contactSheetSharedLabStyle}
      contactSheetSharedColorManagement={contactSheetSharedColorManagement}
      contactSheetSharedLightSourceBias={contactSheetSharedLightSourceBias}
      onSetIsPanDragging={setIsPanDragging}
      onSetIsDragActive={setIsDragActive}
      onSetComparisonMode={setComparisonMode}
      onSetIsCropOverlayVisible={setIsCropOverlayVisible}
      onSetShowSettingsModal={setShowSettingsModal}
      onSetShowBatchModal={setShowBatchModal}
      onSetShowContactSheetModal={setShowContactSheetModal}
      onSetSuggestionNotice={setSuggestionNotice}
      onSetTransientNotice={setTransientNotice}
      onSetError={setError}
      onOpenImage={handleOpenImage}
      onCloseImage={handleCloseImage}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onToggleLeftPane={handleToggleLeftPane}
      onToggleRightPane={handleToggleRightPane}
      onReset={handleReset}
      onOpenInEditor={() => { void handleOpenInEditor(); }}
      onDownload={() => { void handleDownload(); }}
      onFileChange={handleFileChange}
      onRecentImport={importFile}
      onSelectTab={handleSelectTab}
      onReorderTabs={handleReorderTabs}
      onSyncRollSettings={handleSyncRollSettings}
      onApplyRollFilmBase={handleApplyRollFilmBase}
      onRemoveFromRoll={handleRemoveFromRoll}
      onOpenRollInfo={handleOpenRollInfo}
      onDeleteRoll={handleDeleteRoll}
      onCreateRollFromTabs={handleCreateRollFromTabs}
      onToggleScanningSession={toggleScanningWindow}
      onOpenContactSheet={handleOpenContactSheet}
      onSettingsChange={handleSettingsChange}
      onDustRemovalChange={handleDustRemovalChange}
      defaultExportOptions={defaultExportOptions}
      onExportOptionsChange={wrappedHandleExportOptionsChange}
      onColorManagementChange={handleColorManagementChange}
      onInteractionStart={handleInteractionStart}
      onInteractionEnd={handleInteractionEnd}
      onLevelInteractionChange={setIsAdjustingLevel}
      onToggleFilmBasePicker={handleFilmBasePickerToggle}
      onExportClick={handleExportClick}
      onQuickExport={(preset) => { void handleQuickExport(preset); }}
      onSaveQuickExportPreset={handleSaveQuickExportPreset}
      onDeleteQuickExportPreset={handleDeleteQuickExportPreset}
      onOpenBatchExport={handleOpenBatchExport}
      onSidebarScrollTopChange={handleSidebarScrollTopChange}
      onSidebarTabChange={handleSidebarTabChange}
      onCropTabChange={handleCropTabChange}
      onRedetectFrame={handleRedetectFrame}
      onCropDone={handleCropDone}
      onResetCrop={handleResetCrop}
      onDetectDust={() => { void handleDetectDust(); }}
      onDustBrushActiveChange={handleDustBrushActiveChange}
      onDustBrushInteractionStart={handleDustBrushInteractionStart}
      onDustBrushInteractionEnd={handleDustBrushInteractionEnd}
      onSetActivePointPicker={handleSetActivePointPicker}
      onOpenSettingsModal={handleOpenSettingsModal}
      onLightSourceChange={handleLightSourceChange}
      onLabStyleChange={handleLabStyleChange}
      onAutoAdjust={() => { void handleAutoAdjust(); }}
      onProfileChange={handleProfileChange}
      onSavePreset={handleSavePreset}
      onImportPreset={handleImportPreset}
      onDeletePreset={handleDeletePreset}
      onCreateFolder={createFolder}
      onRenameFolder={renameFolder}
      onDeleteFolder={deleteFolder}
      onMovePresetToFolder={movePresetToFolder}
      onSaveCustomLightSource={handleSaveCustomLightSource}
      onDeleteCustomLightSource={handleDeleteCustomLightSource}
      onCopyDebugInfo={handleCopyDebugInfo}
      onToggleGPURendering={handleGPURenderingChange}
      onToggleUltraSmoothDrag={handleUltraSmoothDragChange}
      onMaxResidentDocsChange={handleMaxResidentDocsChange}
      onNotificationSettingsChange={handleNotificationSettingsChange}
      onDefaultColorNegativeInversionChange={handleDefaultColorNegativeInversionChange}
      onDefaultLightSourceChange={handleDefaultLightSourceChange}
      onSelectFlatFieldProfile={handleSelectFlatFieldProfile}
      onImportFlatFieldReference={handleImportFlatFieldReference}
      onDeleteFlatFieldProfile={handleDeleteFlatFieldProfile}
      onRenameFlatFieldProfile={handleRenameFlatFieldProfile}
      onChooseExternalEditor={handleChooseExternalEditor}
      onClearExternalEditor={handleClearExternalEditor}
      onChooseOpenInEditorOutputPath={handleChooseOpenInEditorOutputPath}
      onUseDownloadsForOpenInEditor={handleUseDownloadsForOpenInEditor}
      onChooseDefaultExportPath={handleChooseDefaultExportPath}
      onUseDownloadsForExport={handleUseDownloadsForExport}
      onChooseBatchOutputPath={handleChooseBatchOutputPath}
      onUseDownloadsForBatch={handleUseDownloadsForBatch}
      onChooseContactSheetOutputPath={handleChooseContactSheetOutputPath}
      onUseDownloadsForContactSheet={handleUseDownloadsForContactSheet}
      onExportPresetBackup={handleExportPresetBackup}
      onImportPresetBackup={handleImportPresetBackup}
      onUpdateChannelChange={handleUpdateChannelChange}
      onCheckForUpdates={() => { void checkForUpdatesNow(); }}
      onCanvasClick={handleCanvasClick}
      onHandleZoomWheel={handleZoomWheel}
      onStartPan={handlePanStart}
      onUpdatePan={updatePan}
      onEndPan={handlePanEnd}
      onCropInteractionStart={handleCropInteractionStart}
      onCropInteractionEnd={handleCropInteractionEnd}
      onCropOverlayChange={handleCropOverlayChange}
      onDustOverlayChange={handleDustOverlayChange}
      onDropFile={handleDrop}
      onTitleBarMouseDown={handleTitleBarMouseDown}
      zoomToFit={zoomToFitWithDraft}
      zoomTo100={zoomTo100WithDraft}
      zoomIn={zoomInWithDraft}
      zoomOut={zoomOutWithDraft}
      setZoomLevel={setZoomLevelWithDraft}
      />

      {updateState.available && !updateState.dismissed && (
        <div className={`fixed left-0 right-0 z-40 ${usesNativeFileDialogs ? 'top-8' : 'top-0'}`}>
          <UpdateBanner
            version={updateState.version}
            releaseNotes={updateState.releaseNotes}
            downloadProgress={updateState.downloadProgress}
            isBusy={updateState.isDownloading || updateState.isChecking}
            onCheckNow={() => { void checkForUpdatesNow(); }}
            onDownload={() => { void downloadUpdateNow(); }}
            onDismiss={dismissUpdate}
          />
        </div>
      )}


      <RollInfoModal
        isOpen={Boolean(activeRollInfoId)}
        roll={getRollById(activeRollInfoId)}
        frameCount={activeRollInfoId ? getDocumentsInRoll(activeRollInfoId).length : 0}
        onClose={() => setActiveRollInfoId(null)}
        onSave={handleSaveRollMetadata}
        onSyncSettings={(rollId) => {
          if (activeTabId) {
            handleSyncRollSettings(activeTabId, rollId);
          }
        }}
        onDeleteRoll={handleDeleteRoll}
      />
      <Analytics />
    </>
  );
}
