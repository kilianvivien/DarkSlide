import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES } from './constants';
import { AppShell } from './components/AppShell';
import { ColorManagementSettings, ColorMatrix, ConversionSettings, CropTab, FilmProfile, HistogramMode, InteractionQuality, MaskTuning, NotificationSettings, RenderBackendDiagnostics, TonalCharacter, WorkspaceDocument } from './types';
import { useCustomPresets } from './hooks/useCustomPresets';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useDocumentTabs } from './hooks/useDocumentTabs';
import { useRenderQueue } from './hooks/useRenderQueue';
import { useWorkspaceCommands } from './hooks/useWorkspaceCommands';
import { useViewportZoom } from './hooks/useViewportZoom';
import { appendDiagnostic, getDiagnosticsReport } from './utils/diagnostics';
import { isDesktopShell, registerBeforeUnloadGuard } from './utils/fileBridge';
import { loadPreferences, savePreferences, UserPreferences } from './utils/preferenceStore';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { getTransformedDimensions } from './utils/imagePipeline';
import { clamp } from './utils/math';
import { BatchJobEntry } from './utils/batchProcessor';
import { BlockingOverlayState, createDocumentColorManagement, formatError, getCanvas2dContext, getErrorCode, getPresetTags, getResolvedInputProfileId, isIgnorableRenderError, isRawFile, isSupportedFile, normalizePreviewImageData, QueuedPreviewRender, TransientNoticeState } from './utils/appHelpers';
import { loadMaxResidentDocs, MaxResidentDocs, saveMaxResidentDocs } from './utils/residentDocsStore';

export default function App() {
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
  const [isAdjustingCrop, setIsAdjustingCrop] = useState(false);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeRenderRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const hasVisiblePreviewRef = useRef(false);
  const pendingPreviewRef = useRef<{ documentId: string; angle: number; imageData: ImageData } | null>(null);
  const previewRetryFrameRef = useRef<number | null>(null);
  const interactivePreviewFrameRef = useRef<number | null>(null);
  const pendingInteractivePreviewRef = useRef<QueuedPreviewRender | null>(null);
  const interactionJustEndedRef = useRef(false);
  const tabSwitchDraftRef = useRef<string | null>(null);
  const transientNoticeTimeoutRef = useRef<number | null>(null);
  const tabSwitchOverlayTimeoutRef = useRef<number | null>(null);
  const previousActiveTabIdRef = useRef<string | null>(null);
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

  const { customPresets, savePreset, importPreset, deletePreset } = useCustomPresets();
  const fallbackProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0];

  useEffect(() => registerBeforeUnloadGuard(() => tabs.some((tab) => tab.document.dirty)), [tabs]);
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
    zoomToFit, zoomTo100, zoomIn, zoomOut, setZoomLevel, setPan,
    handleWheel: handleZoomWheel,
    startPan, updatePan, endPan,
  } = useViewportZoom();

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
    return Math.min(vw / displayWidth, vh / displayHeight, 1);
  }, [
    displayScaleFactor,
    displaySettings,
    documentState,
    documentState?.source.height,
    documentState?.source.width,
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
      return targetMaxDimension;
    }
    const z = zoom === 'fit' ? fitScale : zoom;
    const effectiveTarget = Math.ceil((targetMaxDimension * z) / Math.max(fitScale, 0.0001));
    return Math.min(sourceMax, Math.max(targetMaxDimension, effectiveTarget));
  }, [documentState, fitScale, targetMaxDimension, zoom]);
  const isDraftPreview = comparisonMode === 'processed' && (isAdjustingLevel || isInteractingWithPreviewControls || isAdjustingCrop);
  const renderTargetDimension = useMemo(() => {
    if (!isDraftPreview) {
      return fullRenderTargetDimension;
    }

    if (isAdjustingCrop && comparisonMode === 'processed') {
      return Math.min(fullRenderTargetDimension, 1024);
    }

    if (isInteractingWithPreviewControls && comparisonMode === 'processed') {
      return Math.min(fullRenderTargetDimension, ultraSmoothDragEnabled ? 512 : 1024);
    }

    return Math.min(fullRenderTargetDimension, 1024);
  }, [comparisonMode, fullRenderTargetDimension, isAdjustingCrop, isDraftPreview, isInteractingWithPreviewControls, ultraSmoothDragEnabled]);
  const previewTransformAngle = isAdjustingLevel ? displayAngle - renderedPreviewAngle : 0;
  const showMagnifier = Boolean((isPickingFilmBase || activePointPicker) && documentState?.status === 'ready');

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
    isInteractingRef.current = true;
    interactionJustEndedRef.current = false;
    setIsInteractingWithPreviewControls(true);
    beginInteraction();
  }, [beginInteraction]);

  const handleInteractionEnd = useCallback(() => {
    isInteractingRef.current = false;
    interactionJustEndedRef.current = true;
    cancelScheduledInteractivePreview();
    setIsInteractingWithPreviewControls(false);
    if (documentState) {
      commitInteraction(documentState.settings);
    }
  }, [cancelScheduledInteractivePreview, commitInteraction, documentState]);

  const handleCropInteractionStart = useCallback(() => {
    if (isInteractingRef.current) {
      return;
    }

    isInteractingRef.current = true;
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(true);
    beginInteraction();
  }, [beginInteraction]);

  const handleCropInteractionEnd = useCallback(() => {
    if (!isInteractingRef.current) {
      return;
    }

    isInteractingRef.current = false;
    interactionJustEndedRef.current = true;
    cancelScheduledInteractivePreview();
    setIsAdjustingCrop(false);
    if (documentState) {
      commitInteraction(documentState.settings);
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
      pushHistoryEntry(documentState.settings);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [documentState?.settings, pushHistoryEntry]);

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

  const drawPreview = useCallback((imageData: ImageData) => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return false;

    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = getCanvas2dContext(canvas);
    if (!ctx) return false;
    ctx.imageSmoothingQuality = 'high';
    ctx.putImageData(imageData, 0, 0);
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
    if (!pendingPreview || pendingPreview.documentId !== activeDocumentIdRef.current) {
      previewRetryFrameRef.current = null;
      return;
    }

    if (drawPreview(pendingPreview.imageData)) {
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
    nextComparisonMode: 'processed' | 'original',
    nextTargetMaxDimension: number,
    previewMode: 'draft' | 'settled',
    interactionQuality: InteractionQuality | null,
    histogramMode: HistogramMode,
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
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

    try {
      const result = await worker.render({
        documentId,
        settings,
        isColor,
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

      pendingPreviewRef.current = {
        documentId: result.documentId,
        angle: settings.rotation + settings.levelAngle,
        imageData: normalizePreviewImageData(result.imageData, result.width, result.height),
      };
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
  }, [cancelPendingPreviewRetry, drawPreview, flushPendingPreview, refreshRenderBackendDiagnostics, setDocumentState, setPreviewVisibility]);

  const { enqueueRender: enqueuePreviewRender, cancelPending: cancelPendingPreviewRender } = useRenderQueue<QueuedPreviewRender>({
    render: async (next) => {
      await executePreviewRender(
        next.documentId,
        next.settings,
        next.isColor,
        next.comparisonMode,
        next.targetMaxDimension,
        next.previewMode,
        next.interactionQuality,
        next.histogramMode,
        next.maskTuning,
        next.colorMatrix,
        next.tonalCharacter,
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
    if (!documentState || !displaySettings || documentState.previewLevels.length === 0) return;

    const documentId = documentState.id;
    const settings = displaySettings;
    const isColor = activeProfile.type === 'color';
    const profileMaskTuning = activeProfile.maskTuning;
    const profileColorMatrix = activeProfile.colorMatrix;
    const profileTonalCharacter = activeProfile.tonalCharacter;
    const previewMode = isDraftPreview ? 'draft' : 'settled';
    const interactionQuality: InteractionQuality | null = comparisonMode === 'processed'
      ? (
        isAdjustingCrop
          ? 'balanced'
          : (
            isInteractingWithPreviewControls
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
      comparisonMode,
      targetMaxDimension: renderTargetDimension,
      previewMode,
      interactionQuality,
      histogramMode,
      maskTuning: profileMaskTuning,
      colorMatrix: profileColorMatrix,
      tonalCharacter: profileTonalCharacter,
    } satisfies QueuedPreviewRender;

    if (tabSwitchDraftRef.current === documentId && !isDraftPreview && previewMode === 'settled') {
      tabSwitchDraftRef.current = null;
      cancelScheduledInteractivePreview();

      const switchDraftTargetDimension = Math.min(fullRenderTargetDimension, ultraSmoothDragEnabled ? 768 : 1280);

      void executePreviewRender(
        documentId,
        settings,
        isColor,
        comparisonMode,
        switchDraftTargetDimension,
        'draft',
        'balanced',
        'throttled',
        profileMaskTuning,
        profileColorMatrix,
        profileTonalCharacter,
      ).finally(() => {
        if (activeDocumentIdRef.current !== documentId) {
          return;
        }

        enqueuePreviewRender(queuedPreview, 'settled');
      });
      return;
    }

    if (isInteractingWithPreviewControls || isAdjustingCrop) {
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
    const debounceMs = isDraftPreview ? 40 : (interactionJustEndedRef.current ? 0 : (hasVisiblePreviewRef.current ? 120 : 0));
    interactionJustEndedRef.current = false;
    const timer = window.setTimeout(() => {
      enqueuePreviewRender(queuedPreview, previewMode === 'draft' ? 'draft' : 'settled');
    }, debounceMs);

    return () => window.clearTimeout(timer);
  }, [
    activeProfile.colorMatrix,
    activeProfile.maskTuning,
    activeProfile.tonalCharacter,
    activeProfile.type,
    cancelScheduledInteractivePreview,
    comparisonMode,
    displaySettings,
    documentState?.id,
    documentState?.previewLevels.length,
    enqueuePreviewRender,
    executePreviewRender,
    fullRenderTargetDimension,
    isDraftPreview,
    isAdjustingCrop,
    isInteractingWithPreviewControls,
    renderTargetDimension,
    ultraSmoothDragEnabled,
  ]);

  const {
    importFile,
    handleSettingsChange,
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
    fallbackProfile,
    savePresetTags,
    notificationSettings,
    renderBackendDiagnostics,
    setSidebarTab,
    setCropTab,
    isPickingFilmBase,
    activePointPicker,
    usesNativeFileDialogs,
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
    onOpenInEditor: async () => { await handleOpenInEditor(); },
    onCloseImage: async () => { await handleCloseImage(); },
    onDownload: async () => { await handleDownload(); },
    onReset: handleReset,
    onCopyDebugInfo: handleCopyDebugInfo,
    onToggleComparison: handleToggleComparison,
    onToggleCropOverlay: handleToggleCropOverlay,
    onToggleLeftPane: handleToggleLeftPane,
    onToggleRightPane: handleToggleRightPane,
    zoomToFit,
    zoomTo100,
    zoomIn,
    zoomOut,
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
      workerClient={workerClientRef.current}
      documentState={documentState}
      activeTab={activeTab}
      tabs={tabs}
      activeTabId={activeTabId}
      canUndo={canUndo}
      canRedo={canRedo}
      fallbackProfile={fallbackProfile}
      activeProfile={activeProfile}
      builtinProfiles={builtinProfiles}
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
      overlayContent={overlayContent}
      error={error}
      transientNotice={transientNotice}
      isExporting={Boolean(isExporting)}
      gpuRenderingEnabled={gpuRenderingEnabled}
      ultraSmoothDragEnabled={ultraSmoothDragEnabled}
      notificationSettings={notificationSettings}
      renderBackendDiagnostics={renderBackendDiagnostics}
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
      onExportOptionsChange={handleExportOptionsChange}
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
      onCropDone={handleCropDone}
      onResetCrop={handleResetCrop}
      onSetActivePointPicker={setActivePointPicker}
      onOpenSettingsModal={handleOpenSettingsModal}
      onProfileChange={handleProfileChange}
      onSavePreset={handleSavePreset}
      onImportPreset={handleImportPreset}
      onDeletePreset={handleDeletePreset}
      onCopyDebugInfo={handleCopyDebugInfo}
      onToggleGPURendering={handleGPURenderingChange}
      onToggleUltraSmoothDrag={handleUltraSmoothDragChange}
      onMaxResidentDocsChange={handleMaxResidentDocsChange}
      onNotificationSettingsChange={handleNotificationSettingsChange}
      onChooseExternalEditor={handleChooseExternalEditor}
      onClearExternalEditor={handleClearExternalEditor}
      onChooseOpenInEditorOutputPath={handleChooseOpenInEditorOutputPath}
      onUseDownloadsForOpenInEditor={handleUseDownloadsForOpenInEditor}
      onCanvasClick={handleCanvasClick}
      onHandleZoomWheel={handleZoomWheel}
      onStartPan={startPan}
      onUpdatePan={updatePan}
      onEndPan={endPan}
      onCropInteractionStart={handleCropInteractionStart}
      onCropInteractionEnd={handleCropInteractionEnd}
      onCropOverlayChange={handleCropOverlayChange}
      onDropFile={handleDrop}
      onTitleBarMouseDown={handleTitleBarMouseDown}
      zoomToFit={zoomToFit}
      zoomTo100={zoomTo100}
      zoomIn={zoomIn}
      zoomOut={zoomOut}
      setZoomLevel={setZoomLevel}
    />
  );
}
