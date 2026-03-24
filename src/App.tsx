import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES, LAB_STYLE_PROFILES, LAB_STYLE_PROFILES_MAP, LIGHT_SOURCE_PROFILES } from './constants';
import { AppShell } from './components/AppShell';
import { ColorManagementSettings, ColorMatrix, ConversionSettings, CropTab, DocumentHistoryEntry, ExportOptions, FilmProfile, HistogramMode, InteractionQuality, MaskTuning, NotificationSettings, RenderBackendDiagnostics, TonalCharacter, WorkspaceDocument } from './types';
import { useCustomPresets } from './hooks/useCustomPresets';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useDocumentTabs } from './hooks/useDocumentTabs';
import { useRenderQueue } from './hooks/useRenderQueue';
import { useWorkspaceCommands } from './hooks/useWorkspaceCommands';
import { useCalibration } from './hooks/useCalibration';
import { useCustomLightSources } from './hooks/useCustomLightSources';
import { useViewportZoom } from './hooks/useViewportZoom';
import { appendDiagnostic, getDiagnosticsReport } from './utils/diagnostics';
import { isDesktopShell, registerBeforeUnloadGuard } from './utils/fileBridge';
import { loadPreferences, savePreferences, UserPreferences } from './utils/preferenceStore';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { computeHighlightDensity, getTransformedDimensions } from './utils/imagePipeline';
import { clamp } from './utils/math';
import { computeViewportFitScale, CROP_OVERLAY_HANDLE_SAFE_PADDING, isFullFrameFreeCrop, resolveRenderTargetSelection } from './utils/previewLayout';
import { BatchJobEntry } from './utils/batchProcessor';
import { syncRecentFilesToMenu } from './utils/recentFilesStore';
import { BlockingOverlayState, createDocumentColorManagement, formatError, getCanvas2dContext, getErrorCode, getPresetTags, getResolvedInputProfileId, isIgnorableRenderError, isRawFile, isSupportedFile, normalizePreviewImageData, QueuedPreviewRender, TransientNoticeState } from './utils/appHelpers';
import { loadMaxResidentDocs, MaxResidentDocs, saveMaxResidentDocs } from './utils/residentDocsStore';

function createDocumentHistoryEntry(document: Pick<WorkspaceDocument, 'settings' | 'labStyleId'>): DocumentHistoryEntry {
  return {
    settings: structuredClone(document.settings),
    labStyleId: document.labStyleId,
  };
}

export default function App() {
  const RENDER_INDICATOR_DELAY_MS = 450;
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
  const [activePointPicker, setActivePointPicker] = useState<'black' | 'white' | 'grey' | null>(null);
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
  const [sidebarTab, setSidebarTab] = useState<'adjust' | 'curves' | 'crop' | 'export'>('adjust');
  const [cropTab, setCropTab] = useState<CropTab>(() => initialPreferences?.cropTab ?? 'Film');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showContactSheetModal, setShowContactSheetModal] = useState(false);
  const [contactSheetEntries, setContactSheetEntries] = useState<BatchJobEntry[]>([]);
  const [contactSheetSharedSettings, setContactSheetSharedSettings] = useState<ConversionSettings | null>(null);
  const [contactSheetSharedProfile, setContactSheetSharedProfile] = useState<FilmProfile | null>(null);
  const [contactSheetSharedColorManagement, setContactSheetSharedColorManagement] = useState<ColorManagementSettings | null>(null);
  const [gpuRenderingEnabled, setGPURenderingEnabled] = useState(() => initialPreferences?.gpuRendering ?? true);
  const [ultraSmoothDragEnabled, setUltraSmoothDragEnabled] = useState(() => initialPreferences?.ultraSmoothDrag ?? false);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(() => initialPreferences?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS);
  const [maxResidentDocs, setMaxResidentDocs] = useState<MaxResidentDocs>(() => loadMaxResidentDocs());
  const [externalEditorPath, setExternalEditorPath] = useState<string | null>(() => initialPreferences?.externalEditorPath ?? null);
  const [externalEditorName, setExternalEditorName] = useState<string | null>(() => initialPreferences?.externalEditorName ?? null);
  const [openInEditorOutputPath, setOpenInEditorOutputPath] = useState<string | null>(() => initialPreferences?.openInEditorOutputPath ?? null);
  const [defaultExportOptions, setDefaultExportOptions] = useState<ExportOptions>(() => initialPreferences?.exportOptions ?? DEFAULT_EXPORT_OPTIONS);
  const [isAdjustingCrop, setIsAdjustingCrop] = useState(false);
  const [isRenderIndicatorVisible, setIsRenderIndicatorVisible] = useState(false);
  const [blockingOverlay, setBlockingOverlay] = useState<BlockingOverlayState | null>(null);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeRenderRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const hasVisiblePreviewRef = useRef(false);
  const pendingPreviewRef = useRef<{
    documentId: string;
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
  const fullRenderTargetSelectionRef = useRef<{ previewLevelId: string; targetDimension: number } | null>(null);
  const tabSwitchDraftRef = useRef<string | null>(null);
  const transientNoticeTimeoutRef = useRef<number | null>(null);
  const tabSwitchOverlayTimeoutRef = useRef<number | null>(null);
  const previousActiveTabIdRef = useRef<string | null>(null);
  const lastAutoFitCropKeyRef = useRef<string | null>(null);
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

  const createPreviewRenderKey = useCallback((payload: {
    documentId: string;
    settings: ConversionSettings;
    isColor: boolean;
    filmType?: 'negative' | 'slide';
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
    highlightDensityEstimate?: number;
    flareFloor?: [number, number, number] | null;
    lightSourceBias?: [number, number, number];
  }) => JSON.stringify(payload), []);

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

  const { customPresets, savePreset, importPreset, deletePreset } = useCustomPresets();
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
  const allProfiles = useMemo(() => [...builtinProfiles, ...customPresets], [builtinProfiles, customPresets]);
  const allLightSourceProfiles = useMemo(() => [...LIGHT_SOURCE_PROFILES, ...customLightSources], [customLightSources]);
  const lightSourceProfilesById = useMemo(() => {
    const map = new Map(allLightSourceProfiles.map((profile) => [profile.id, profile] as const));
    return map;
  }, [allLightSourceProfiles]);
  const calibration = useCalibration(workerClientRef, workerReadyVersion);

  // Always-current ref for non-transient profiles — avoids adding them to importFile's deps
  const persistedProfilesRef = useRef(persistedProfiles);
  persistedProfilesRef.current = persistedProfiles;

  // Snapshot of the latest preference-relevant state, updated on every render so handlers can always read fresh values
  const prefsSnapshotRef = useRef<UserPreferences>({
    version: 4,
    lastProfileId: fallbackProfile.id,
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
  });
  prefsSnapshotRef.current = {
    version: 4,
    lastProfileId: documentState?.profileId ?? prefsSnapshotRef.current.lastProfileId,
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
  };
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

  useEffect(() => {
    if (!activeTabId) {
      return;
    }

    setActiveViewport(zoom, pan);
  }, [activeTabId, pan, setActiveViewport, zoom]);

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
    if (['adjust', 'curves', 'crop', 'export'].includes(prefs.sidebarTab)) {
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
    if (!canvas) return false;

    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = getCanvas2dContext(canvas);
    if (!ctx) return false;
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
    return true;
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

    if (drawPreview(pendingPreview.imageData, pendingPreview.imageBitmap)) {
      pendingPreviewRef.current = null;
      setRenderedPreviewAngle(pendingPreview.angle);
      setPreviewVisibility(true);
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
    activeRenderRequestRef.current = { documentId, revision };
    const shouldTrackHeavyRenderIndicator = previewMode === 'settled' && interactionQuality === null;
    const renderKey = createPreviewRenderKey({
      documentId,
      settings,
      isColor,
      filmType,
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
      highlightDensityEstimate,
      flareFloor,
      lightSourceBias,
    });

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
        filmType,
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
        highlightDensityEstimate,
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
      const imageBitmap = typeof createImageBitmap === 'function'
        ? await createImageBitmap(normalizedImageData).catch(() => null)
        : null;

      pendingPreviewRef.current?.imageBitmap?.close();
      pendingPreviewRef.current = {
        documentId: result.documentId,
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
      if (shouldTrackHeavyRenderIndicator) {
        lastCompletedSettledRenderKeyRef.current = renderKey;
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
  }, [cancelPendingPreviewRetry, clearRenderIndicator, createPreviewRenderKey, drawPreview, flushPendingPreview, refreshRenderBackendDiagnostics, scheduleRenderIndicator, setDocumentState, setPreviewVisibility]);

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
    const profileFilmType = activeProfile.filmType;
    const highlightDensityEstimate = documentState.histogram ? computeHighlightDensity(documentState.histogram) : 0;
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
        highlightDensityEstimate,
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
    documentState?.histogram,
    documentState?.lightSourceId,
    documentState?.previewLevels.length,
    documentState?.source,
    enqueuePreviewRender,
    executePreviewRender,
    fullRenderTargetDimension,
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
    handleChooseExternalEditor,
    handleClearExternalEditor,
    handleChooseOpenInEditorOutputPath,
    handleUseDownloadsForOpenInEditor,
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
    setContactSheetSharedColorManagement,
    setGPURenderingEnabled,
    setUltraSmoothDragEnabled,
    setNotificationSettings,
    setMaxResidentDocs,
    setExternalEditorPath,
    setExternalEditorName,
    setOpenInEditorOutputPath,
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
  });

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
    setIsCropOverlayVisible((current) => !current);
  }, []);

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

    if (hasManualAdjustments && typeof window !== 'undefined' && !window.confirm('Auto will overwrite your manual adjustments. Continue?')) {
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
      filmType: activeProfile.filmType,
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

    handleSettingsChange(nextSettings);
    if (result.temperature === null || result.tint === null) {
      showTransientNotice('Auto adjusted tone, but left white balance unchanged.');
    }
  }, [
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

  useAppShortcuts({
    tabs,
    activeTabId,
    setActiveTabId,
    documentStatePresent: Boolean(documentState),
    isCropOverlayVisible,
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
    onReset: handleReset,
    onCopyDebugInfo: handleCopyDebugInfo,
    onToggleComparison: handleToggleComparison,
    onAutoAdjust: () => { void handleAutoAdjust(); },
    onToggleCropOverlay: handleToggleCropOverlay,
    onToggleLeftPane: handleToggleLeftPane,
    onToggleRightPane: handleToggleRightPane,
    zoomToFit: zoomToFitWithDraft,
    zoomTo100: zoomTo100WithDraft,
    zoomIn: zoomInWithDraft,
    zoomOut: zoomOutWithDraft,
  });

  const showBlockingOverlay = Boolean(blockingOverlay);
  const overlayContent = blockingOverlay;
  const isExporting = documentState?.status === 'exporting';

  return (
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
      savePresetTags={savePresetTags}
      sidebarTab={sidebarTab}
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
      transientNotice={transientNotice}
      isExporting={Boolean(isExporting)}
      gpuRenderingEnabled={gpuRenderingEnabled}
      ultraSmoothDragEnabled={ultraSmoothDragEnabled}
      notificationSettings={notificationSettings}
      renderBackendDiagnostics={renderBackendDiagnostics}
      defaultLightSourceId={defaultLightSourceId}
      flatFieldProfileNames={calibration.profileNames}
      activeFlatFieldProfileName={calibration.activeProfileName}
      activeFlatFieldLoaded={calibration.activeProfileLoaded}
      activeFlatFieldPreview={calibration.activeProfilePreview}
      maxResidentDocs={maxResidentDocs}
      externalEditorPath={externalEditorPath}
      externalEditorName={externalEditorName}
      openInEditorOutputPath={openInEditorOutputPath}
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
      contactSheetSharedColorManagement={contactSheetSharedColorManagement}
      onSetIsPanDragging={setIsPanDragging}
      onSetIsDragActive={setIsDragActive}
      onSetComparisonMode={setComparisonMode}
      onSetIsCropOverlayVisible={setIsCropOverlayVisible}
      onSetShowSettingsModal={setShowSettingsModal}
      onSetShowBatchModal={setShowBatchModal}
      onSetShowContactSheetModal={setShowContactSheetModal}
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
      onOpenContactSheet={handleOpenContactSheet}
      onSettingsChange={handleSettingsChange}
      defaultExportOptions={defaultExportOptions}
      onExportOptionsChange={wrappedHandleExportOptionsChange}
      onColorManagementChange={handleColorManagementChange}
      onInteractionStart={handleInteractionStart}
      onInteractionEnd={handleInteractionEnd}
      onLevelInteractionChange={setIsAdjustingLevel}
      onToggleFilmBasePicker={handleToggleFilmBasePicker}
      onExportClick={handleExportClick}
      onOpenBatchExport={handleOpenBatchExport}
      onSidebarScrollTopChange={handleSidebarScrollTopChange}
      onSidebarTabChange={handleSidebarTabChange}
      onCropTabChange={handleCropTabChange}
      onRedetectFrame={handleRedetectFrame}
      onCropDone={handleCropDone}
      onResetCrop={handleResetCrop}
      onSetActivePointPicker={setActivePointPicker}
      onOpenSettingsModal={handleOpenSettingsModal}
      onLightSourceChange={handleLightSourceChange}
      onLabStyleChange={handleLabStyleChange}
      onAutoAdjust={() => { void handleAutoAdjust(); }}
      onProfileChange={handleProfileChange}
      onSavePreset={handleSavePreset}
      onImportPreset={handleImportPreset}
      onDeletePreset={handleDeletePreset}
      onSaveCustomLightSource={handleSaveCustomLightSource}
      onDeleteCustomLightSource={handleDeleteCustomLightSource}
      onCopyDebugInfo={handleCopyDebugInfo}
      onToggleGPURendering={handleGPURenderingChange}
      onToggleUltraSmoothDrag={handleUltraSmoothDragChange}
      onMaxResidentDocsChange={handleMaxResidentDocsChange}
      onNotificationSettingsChange={handleNotificationSettingsChange}
      onDefaultLightSourceChange={handleDefaultLightSourceChange}
      onSelectFlatFieldProfile={handleSelectFlatFieldProfile}
      onImportFlatFieldReference={handleImportFlatFieldReference}
      onDeleteFlatFieldProfile={handleDeleteFlatFieldProfile}
      onRenameFlatFieldProfile={handleRenameFlatFieldProfile}
      onChooseExternalEditor={handleChooseExternalEditor}
      onClearExternalEditor={handleClearExternalEditor}
      onChooseOpenInEditorOutputPath={handleChooseOpenInEditorOutputPath}
      onUseDownloadsForOpenInEditor={handleUseDownloadsForOpenInEditor}
      onCanvasClick={handleCanvasClick}
      onHandleZoomWheel={handleZoomWheel}
      onStartPan={handlePanStart}
      onUpdatePan={updatePan}
      onEndPan={handlePanEnd}
      onCropInteractionStart={handleCropInteractionStart}
      onCropInteractionEnd={handleCropInteractionEnd}
      onCropOverlayChange={handleCropOverlayChange}
      onDropFile={handleDrop}
      onTitleBarMouseDown={handleTitleBarMouseDown}
      zoomToFit={zoomToFitWithDraft}
      zoomTo100={zoomTo100WithDraft}
      zoomIn={zoomInWithDraft}
      zoomOut={zoomOutWithDraft}
      setZoomLevel={setZoomLevelWithDraft}
    />
  );
}
