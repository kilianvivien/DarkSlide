import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload,
  Download,
  RotateCcw,
  Image as ImageIcon,
  Loader2,
  FileWarning,
  Undo2,
  Redo2,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  X,
  SplitSquareVertical,
  Crop,
  ExternalLink,
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PresetsPane } from './components/PresetsPane';
import { CropOverlay } from './components/CropOverlay';
import { SettingsModal } from './components/SettingsModal';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES, MAX_FILE_SIZE_BYTES, MAX_OPEN_TABS, SUPPORTED_EXTENSIONS } from './constants';
import { BatchModal } from './components/BatchModal';
import { ContactSheetModal } from './components/ContactSheetModal';
import { TabBar } from './components/TabBar';
import { ColorManagementSettings, ColorMatrix, ColorProfileId, ConversionSettings, CropTab, DecodedImage, DocumentTab, FilmProfile, HistogramMode, InteractionQuality, MaskTuning, NotificationSettings, RenderBackendDiagnostics, ScannerType, SourceMetadata, TonalCharacter, WorkspaceDocument } from './types';
import { useCustomPresets } from './hooks/useCustomPresets';
import { useViewportZoom } from './hooks/useViewportZoom';
import { ZoomBar } from './components/ZoomBar';
import { MagnifierLoupe } from './components/MagnifierLoupe';
import { appendDiagnostic, getDiagnosticsReport } from './utils/diagnostics';
import { isDesktopShell, openImageFile, openDirectory, saveExportBlob, openInExternalEditor, chooseApplicationPath, confirmDiscard } from './utils/fileBridge';
import { loadPreferences, savePreferences, UserPreferences } from './utils/preferenceStore';
import { addRecentFile } from './utils/recentFilesStore';
import { RecentFilesList } from './components/RecentFilesList';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { clamp, getFileExtension, getTransformedDimensions, sanitizeFilenameBase } from './utils/imagePipeline';
import { getColorProfileDescription, supportsDisplayP3Canvas } from './utils/colorProfiles';
import { buildRawInitialSettings, createRawImportProfile, decodeDesktopRawForWorker, estimateFilmBaseSample, getFilmBaseCorrectionSettings, isRawExtension, rotationFromExifOrientation } from './utils/rawImport';
import { BatchJobEntry } from './utils/batchProcessor';
import { notifyExportFinished, primeExportNotificationsPermission } from './utils/exportNotifications';

function resolveAutoInputProfileId(source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>): ColorProfileId {
  return source.decoderColorProfileId ?? source.embeddedColorProfileId ?? 'srgb';
}

function getResolvedInputProfileId(
  source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>,
  colorManagement: Pick<ColorManagementSettings, 'inputMode' | 'inputProfileId'>,
) {
  return colorManagement.inputMode === 'override'
    ? colorManagement.inputProfileId
    : resolveAutoInputProfileId(source);
}

function createDocumentColorManagement(
  source: Pick<SourceMetadata, 'decoderColorProfileId' | 'embeddedColorProfileId'>,
  exportOptions = DEFAULT_EXPORT_OPTIONS,
): ColorManagementSettings {
  return {
    ...DEFAULT_COLOR_MANAGEMENT,
    inputProfileId: resolveAutoInputProfileId(source),
    outputProfileId: exportOptions.outputProfileId,
    embedOutputProfile: exportOptions.embedOutputProfile,
  };
}

function formatError(error: unknown, options?: { preservePrefix?: boolean }) {
  const message = error instanceof Error ? error.message : String(error);
  if (options?.preservePrefix) {
    return message || 'Unknown error.';
  }
  const readable = message.includes(': ') ? message.split(': ').slice(1).join(': ') : message;
  return readable || 'Unknown error.';
}

function getOpenInEditorErrorContext(error: unknown): Record<string, string | null> | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const details = error as {
    savedPath?: unknown;
    destinationDirectory?: unknown;
    editorPath?: unknown;
  };

  const savedPath = typeof details.savedPath === 'string' ? details.savedPath : null;
  const destinationDirectory = typeof details.destinationDirectory === 'string' ? details.destinationDirectory : null;
  const editorPath = typeof details.editorPath === 'string' ? details.editorPath : null;

  if (!savedPath && !destinationDirectory && !editorPath) {
    return null;
  }

  return {
    savedPath,
    destinationDirectory,
    editorPath,
  };
}

function getErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(':')[0]?.trim();
  return code || null;
}

function isIgnorableRenderError(error: unknown) {
  if (error instanceof Error) {
    return error.message.startsWith('JOB_CANCELLED')
      || error.message.startsWith('JOB_MISSING')
      || error.message.includes('The tile job was cancelled.')
      || error.message.includes('The requested tile job is no longer available.')
      || error.message.includes('The image document is no longer available.');
  }

  if (typeof error === 'string') {
    return error.startsWith('JOB_CANCELLED')
      || error.startsWith('JOB_MISSING')
      || error.includes('The tile job was cancelled.')
      || error.includes('The requested tile job is no longer available.')
      || error.includes('The image document is no longer available.');
  }

  return false;
}

function isSupportedFile(file: File) {
  const extension = getFileExtension(file.name);
  return SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number]);
}

function isRawFile(file: File) {
  return isRawExtension(getFileExtension(file.name));
}

function getPresetTags(
  settings: ConversionSettings,
  profileType: FilmProfile['type'],
  extension: string,
) {
  return [
    settings.blackAndWhite.enabled || profileType === 'bw' ? 'bw' : 'color',
    isRawExtension(extension) ? 'raw' : 'non-raw',
  ];
}

function normalizePreviewImageData(imageData: ImageData, width: number, height: number) {
  if (imageData.width === width && imageData.height === height) {
    return imageData;
  }

  return new ImageData(new Uint8ClampedArray(imageData.data), width, height);
}

function getCanvas2dContext(canvas: HTMLCanvasElement) {
  if (supportsDisplayP3Canvas()) {
    return canvas.getContext('2d', {
      willReadFrequently: true,
      colorSpace: 'display-p3',
    } as CanvasRenderingContext2DSettings) ?? canvas.getContext('2d');
  }

  return canvas.getContext('2d', { willReadFrequently: true }) ?? canvas.getContext('2d');
}

function getNativePathFromFile(file: File): string | null {
  const candidate = (file as File & { path?: string }).path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function waitForNextPaint() {
  if (typeof window === 'undefined' || (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

type QueuedPreviewRender = {
  documentId: string;
  settings: ConversionSettings;
  isColor: boolean;
  comparisonMode: 'processed' | 'original';
  targetMaxDimension: number;
  previewMode: 'draft' | 'settled';
  interactionQuality: InteractionQuality | null;
  histogramMode: HistogramMode;
  maskTuning?: MaskTuning;
  colorMatrix?: ColorMatrix;
  tonalCharacter?: TonalCharacter;
};

type BlockingOverlayState = {
  title: string;
  detail: string;
};

type TransientNoticeState = {
  message: string;
};

const HISTORY_LIMIT = 50;

function createDocumentTab(document: WorkspaceDocument): DocumentTab {
  return {
    id: document.id,
    document,
    historyStack: [structuredClone(document.settings)],
    historyIndex: 0,
    zoom: 'fit',
    pan: { x: 0.5, y: 0.5 },
    sidebarScrollTop: 0,
  };
}

export default function App() {
  const initialPreferences = useMemo(() => loadPreferences(), []);
  const usesNativeFileDialogs = isDesktopShell();
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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

  const [displayScaleFactor, setDisplayScaleFactor] = useState(() => (
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  ));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const tabsRef = useRef<DocumentTab[]>([]);
  const importSessionRef = useRef(0);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeRenderRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const hasVisiblePreviewRef = useRef(false);
  const pendingPreviewRef = useRef<{ documentId: string; angle: number; imageData: ImageData } | null>(null);
  const previewRetryFrameRef = useRef<number | null>(null);
  const interactivePreviewFrameRef = useRef<number | null>(null);
  const previewRenderInFlightRef = useRef(false);
  const queuedPreviewRenderRef = useRef<QueuedPreviewRender | null>(null);
  const pendingInteractivePreviewRef = useRef<QueuedPreviewRender | null>(null);
  const interactionJustEndedRef = useRef(false);
  const handleDownloadRef = useRef<(() => void) | null>(null);
  const handleOpenInEditorRef = useRef<(() => void) | null>(null);
  const handleResetRef = useRef<(() => void) | null>(null);
  const handleCopyDebugInfoRef = useRef<(() => Promise<void>) | null>(null);
  const transientNoticeTimeoutRef = useRef<number | null>(null);
  const tabSwitchOverlayTimeoutRef = useRef<number | null>(null);
  const previousActiveTabIdRef = useRef<string | null>(null);
  const interactionSnapshotRef = useRef<ConversionSettings | null>(null);
  const tauriWindowRef = useRef<{
    startDragging: () => Promise<void>;
    scaleFactor: () => Promise<number>;
    onScaleChanged: (handler: ({ payload }: { payload: { scaleFactor: number } }) => void) => Promise<() => void>;
  } | null>(null);

  const showTransientNotice = useCallback((message: string) => {
    if (transientNoticeTimeoutRef.current !== null) {
      window.clearTimeout(transientNoticeTimeoutRef.current);
    }

    setTransientNotice({ message });
    transientNoticeTimeoutRef.current = window.setTimeout(() => {
      setTransientNotice(null);
      transientNoticeTimeoutRef.current = null;
    }, 4000);
  }, []);

  const { customPresets, savePreset, importPreset, deletePreset } = useCustomPresets();
  const fallbackProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0];
  const documentState = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId)?.document ?? null,
    [activeTabId, tabs],
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  tabsRef.current = tabs;
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
    const z = zoom === 'fit' ? 1 : zoom;
    if (z <= 1) return targetMaxDimension;
    const sourceMax = documentState ? Math.max(documentState.source.width, documentState.source.height) : targetMaxDimension;
    return Math.min(sourceMax, Math.ceil(targetMaxDimension * z));
  }, [targetMaxDimension, zoom, documentState]);
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

  const canUndo = (activeTab?.historyIndex ?? 0) > 0;
  const canRedo = activeTab ? activeTab.historyIndex < activeTab.historyStack.length - 1 : false;

  const updateActiveDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === activeTabId
        ? { ...tab, document: updater(tab.document) }
        : tab
    )));
  }, [activeTabId]);

  const setDocumentState = useCallback((nextState: WorkspaceDocument | null | ((current: WorkspaceDocument | null) => WorkspaceDocument | null)) => {
    if (!activeTabId) {
      return;
    }

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId) {
        return tab;
      }

      const resolved = typeof nextState === 'function'
        ? nextState(tab.document)
        : nextState;

      return resolved ? { ...tab, document: resolved } : tab;
    }));
  }, [activeTabId]);

  const updateTabById = useCallback((tabId: string, updater: (tab: DocumentTab) => DocumentTab) => {
    setTabs((previous) => previous.map((tab) => tab.id === tabId ? updater(tab) : tab));
  }, []);

  const pushHistoryEntry = useCallback((nextState: ConversionSettings) => {
    if (!activeTabId) {
      return;
    }

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId) {
        return tab;
      }

      const baseHistory = tab.historyStack.slice(0, tab.historyIndex + 1);
      const lastEntry = baseHistory[baseHistory.length - 1];
      if (JSON.stringify(lastEntry) === JSON.stringify(nextState)) {
        return tab;
      }

      const nextHistory = [...baseHistory, structuredClone(nextState)].slice(-HISTORY_LIMIT);
      return {
        ...tab,
        historyStack: nextHistory,
        historyIndex: nextHistory.length - 1,
      };
    }));
  }, [activeTabId]);

  const resetHistory = useCallback((nextState: ConversionSettings) => {
    if (!activeTabId) {
      return;
    }

    interactionSnapshotRef.current = null;
    updateTabById(activeTabId, (tab) => ({
      ...tab,
      historyStack: [structuredClone(nextState)],
      historyIndex: 0,
    }));
  }, [activeTabId, updateTabById]);

  const beginInteraction = useCallback(() => {
    if (documentState) {
      interactionSnapshotRef.current = structuredClone(documentState.settings);
    }
  }, [documentState]);

  const commitInteraction = useCallback((currentState: ConversionSettings) => {
    const snapshot = interactionSnapshotRef.current;
    interactionSnapshotRef.current = null;
    if (!snapshot) {
      return;
    }
    if (JSON.stringify(snapshot) === JSON.stringify(currentState)) {
      return;
    }
    pushHistoryEntry(currentState);
  }, [pushHistoryEntry]);

  const isInteractingRef = useRef(false);

  const cancelScheduledInteractivePreview = useCallback(() => {
    if (interactivePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(interactivePreviewFrameRef.current);
      interactivePreviewFrameRef.current = null;
    }
    pendingInteractivePreviewRef.current = null;
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

    updateTabById(activeTabId, (tab) => (
      tab.zoom === zoom && tab.pan.x === pan.x && tab.pan.y === pan.y
        ? tab
        : { ...tab, zoom, pan }
    ));
  }, [activeTabId, pan, updateTabById, zoom]);

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

  const drainPreviewRenderQueue = useCallback(async () => {
    if (previewRenderInFlightRef.current) {
      return;
    }

    while (queuedPreviewRenderRef.current) {
      const next = queuedPreviewRenderRef.current;
      queuedPreviewRenderRef.current = null;
      previewRenderInFlightRef.current = true;
      try {
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
      } finally {
        previewRenderInFlightRef.current = false;
      }
    }
  }, [executePreviewRender]);

  const schedulePreviewRender = useCallback((next: QueuedPreviewRender) => {
    const hadQueuedPreview = queuedPreviewRenderRef.current !== null;
    queuedPreviewRenderRef.current = next;

    if (previewRenderInFlightRef.current) {
      if (hadQueuedPreview || activeRenderRequestRef.current?.documentId === next.documentId) {
        workerClientRef.current?.noteCoalescedPreviewRequest();
      }
      void workerClientRef.current?.cancelActivePreviewRender(next.documentId);
      return;
    }

    void drainPreviewRenderQueue();
  }, [drainPreviewRenderQueue]);

  const scheduleInteractivePreviewRender = useCallback((next: QueuedPreviewRender) => {
    if (pendingInteractivePreviewRef.current) {
      workerClientRef.current?.noteCoalescedPreviewRequest();
    }

    pendingInteractivePreviewRef.current = next;
    if (interactivePreviewFrameRef.current !== null) {
      return;
    }

    interactivePreviewFrameRef.current = window.requestAnimationFrame(() => {
      interactivePreviewFrameRef.current = null;
      const queuedPreview = pendingInteractivePreviewRef.current;
      pendingInteractivePreviewRef.current = null;
      if (queuedPreview) {
        schedulePreviewRender(queuedPreview);
      }
    });
  }, [schedulePreviewRender]);

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

    if (isInteractingWithPreviewControls || isAdjustingCrop) {
      scheduleInteractivePreviewRender(queuedPreview);
      return;
    }

    cancelScheduledInteractivePreview();
    const debounceMs = isDraftPreview ? 40 : (interactionJustEndedRef.current ? 0 : (hasVisiblePreviewRef.current ? 120 : 0));
    interactionJustEndedRef.current = false;
    const timer = window.setTimeout(() => {
      schedulePreviewRender(queuedPreview);
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
    isDraftPreview,
    isAdjustingCrop,
    isInteractingWithPreviewControls,
    renderTargetDimension,
    scheduleInteractivePreviewRender,
    schedulePreviewRender,
    ultraSmoothDragEnabled,
  ]);

  const updateDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument) => {
    setDocumentState((current) => (current ? updater(current) : current));
  }, [setDocumentState]);

  const handleSettingsChange = useCallback((newSettings: Partial<ConversionSettings>) => {
    updateDocument((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...newSettings,
      },
      dirty: true,
    }));
  }, [updateDocument]);

  const handleSidebarTabChange = useCallback((tab: 'adjust' | 'curves' | 'crop' | 'export') => {
    setSidebarTab(tab);
    if (tab !== 'crop') {
      setIsCropOverlayVisible(false);
      setIsAdjustingCrop(false);
    }
    savePreferences({ ...prefsSnapshotRef.current, sidebarTab: tab });
  }, []);

  const handleCropDone = useCallback(() => {
    setSidebarTab('adjust');
    setIsCropOverlayVisible(false);
    setIsAdjustingCrop(false);
  }, []);

  const handleToggleFilmBasePicker = useCallback(() => {
    setIsPickingFilmBase((current) => !current);
  }, []);

  const handleOpenSettingsModal = useCallback(() => {
    setShowSettingsModal(true);
  }, []);

  const handleCropTabChange = useCallback((tab: CropTab) => {
    setCropTab(tab);
    savePreferences({ ...prefsSnapshotRef.current, cropTab: tab });
  }, []);

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
      ? {
        ...options,
        outputProfileId: 'srgb' as const,
      }
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
  }, [documentState, updateDocument]);

  const handleColorManagementChange = useCallback((options: Partial<ColorManagementSettings>) => {
    if (!documentState) {
      return;
    }

    updateDocument((current) => {
      const nextColorManagement = {
        ...current.colorManagement,
        ...options,
      };
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
  }, [documentState, updateDocument]);

  const handleNotificationSettingsChange = useCallback((options: Partial<NotificationSettings>) => {
    setNotificationSettings((current) => {
      const next = { ...current, ...options };
      savePreferences({ ...prefsSnapshotRef.current, notificationSettings: next });
      return next;
    });
  }, []);

  const disposeDocument = useCallback(async (documentId: string | null | undefined) => {
    if (!documentId || !workerClientRef.current) return;
    try {
      await workerClientRef.current.disposeDocument(documentId);
    } catch {
      // Ignore worker disposal failures while resetting the UI.
    }
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return;
    const ctx = getCanvas2dContext(canvas);
    canvas.width = 1;
    canvas.height = 1;
    ctx?.clearRect(0, 0, 1, 1);
    setCanvasSize({ width: 0, height: 0 });
  }, []);

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
    pendingPreviewRef.current = null;
    queuedPreviewRenderRef.current = null;
    pendingInteractivePreviewRef.current = null;
    previewRenderInFlightRef.current = false;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setPreviewVisibility(false);
    setRenderedPreviewAngle(0);
    setIsAdjustingCrop(false);
    setIsCropOverlayVisible(false);
    setIsPickingFilmBase(false);
    setActivePointPicker(null);
    clearCanvas();

    const incomingTab = tabsRef.current.find((tab) => tab.id === activeTabId);
    if (!incomingTab) {
      zoomToFit();
      return;
    }

    setZoomLevel(incomingTab.zoom);
    setPan(incomingTab.pan);
  }, [
    activeTabId,
    cancelPendingPreviewRetry,
    cancelScheduledInteractivePreview,
    clearCanvas,
    setPan,
    setPreviewVisibility,
    setZoomLevel,
    zoomToFit,
  ]);

  const handleCloseImage = useCallback(async (requestedTabId?: string | null) => {
    const documentId = requestedTabId ?? activeTabId;
    if (!documentId) {
      return;
    }

    const currentTabs = tabsRef.current;
    const tabIndex = currentTabs.findIndex((tab) => tab.id === documentId);
    const tabToClose = tabIndex >= 0 ? currentTabs[tabIndex] : null;
    if (!tabToClose) {
      return;
    }

    if (tabToClose.document.dirty && !(await confirmDiscard())) {
      return;
    }

    importSessionRef.current += 1;
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current = null;
    queuedPreviewRenderRef.current = null;
    pendingInteractivePreviewRef.current = null;
    previewRenderInFlightRef.current = false;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(false);
    setPreviewVisibility(false);
    setIsAdjustingLevel(false);
    setIsInteractingWithPreviewControls(false);
    setRenderedPreviewAngle(0);
    void workerClientRef.current?.cancelActivePreviewRender(documentId);

    const remainingTabs = currentTabs.filter((tab) => tab.id !== documentId);
    const nextActiveTab = activeTabId === documentId
      ? (remainingTabs[tabIndex] ?? remainingTabs[tabIndex - 1] ?? null)
      : remainingTabs.find((tab) => tab.id === activeTabId) ?? null;

    setTabs(remainingTabs);
    setActiveTabId(nextActiveTab?.id ?? null);
    await disposeDocument(documentId);
    setError(null);
    setBlockingOverlay(null);
    setComparisonMode('processed');
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    appendDiagnostic({
      level: 'info',
      code: 'IMAGE_CLOSED',
      message: documentId ?? 'none',
      context: {
        documentId,
      },
    });
    if (remainingTabs.length === 0) {
      activeDocumentIdRef.current = null;
      zoomToFit();
      clearCanvas();
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [activeTabId, cancelPendingPreviewRetry, cancelScheduledInteractivePreview, clearCanvas, disposeDocument, setPreviewVisibility, zoomToFit]);

  const importFile = useCallback(async (file: File, nativePath?: string | null, nativeFileSize?: number) => {
    const worker = workerClientRef.current;
    if (!worker) return;
    const sourceFileSize = nativeFileSize ?? file.size;
    const rawImport = isRawFile(file);

    if (rawImport) {
      if (!isDesktopShell()) {
        setError('RAW files (.dng, .cr3, .nef, .arw, .raf, .rw2) require the DarkSlide desktop app. Convert to TIFF for browser use, or download DarkSlide for desktop.');
        appendDiagnostic({ level: 'error', code: 'RAW_UNSUPPORTED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return;
      }

      if (!nativePath) {
        setError('RAW import requires a file path. Please use File > Open.');
        appendDiagnostic({ level: 'error', code: 'RAW_PATH_REQUIRED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return;
      }
    }

    if (!isSupportedFile(file) && !rawImport) {
      setError('Unsupported file type. Import TIFF, JPEG, PNG, or WebP for now.');
      appendDiagnostic({ level: 'error', code: 'UNSUPPORTED_FILE', message: file.name });
      return;
    }

    if (!rawImport && sourceFileSize > MAX_FILE_SIZE_BYTES) {
      setError(`File is too large (${Math.round(sourceFileSize / 1024 / 1024)} MB). Maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`);
      appendDiagnostic({
        level: 'error',
        code: 'FILE_TOO_LARGE',
        message: file.name,
        context: {
          limitBytes: MAX_FILE_SIZE_BYTES,
          size: sourceFileSize,
        },
      });
      return;
    }

    setError(null);
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    setIsAdjustingLevel(false);
    setIsInteractingWithPreviewControls(false);
    setRenderedPreviewAngle(0);
    setPreviewVisibility(false);
    clearCanvas();
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current = null;
    queuedPreviewRenderRef.current = null;
    pendingInteractivePreviewRef.current = null;
    previewRenderInFlightRef.current = false;
    cancelPendingPreviewRetry();
    cancelScheduledInteractivePreview();
    interactionJustEndedRef.current = false;
    setIsAdjustingCrop(false);

    const currentTabs = tabsRef.current;
    if (currentTabs.length >= MAX_OPEN_TABS) {
      const evictedTab = currentTabs.find((tab) => !tab.document.dirty) ?? null;
      if (!evictedTab) {
        setError(`You already have ${MAX_OPEN_TABS} tabs open. Close a dirty tab before importing another image.`);
        return;
      }

      setTabs((previous) => previous.filter((tab) => tab.id !== evictedTab.id));
      void disposeDocument(evictedTab.id);
    }

    const importSession = importSessionRef.current + 1;
    importSessionRef.current = importSession;

    const documentId = crypto.randomUUID();
    const savedPrefs = loadPreferences();
    const rawDefaultProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? fallbackProfile;
    const initialProfile = rawImport
      ? rawDefaultProfile
      : (
        savedPrefs
          ? (persistedProfilesRef.current.find((p) => p.id === savedPrefs.lastProfileId) ?? fallbackProfile)
          : fallbackProfile
      );
    activeDocumentIdRef.current = documentId;

    appendDiagnostic({
      level: 'info',
      code: 'IMPORT_STARTED',
      message: file.name,
      context: {
        documentId,
        extension: getFileExtension(file.name),
        importSession,
        size: sourceFileSize,
      },
    });

    const loadingDocument: WorkspaceDocument = {
      id: documentId,
      source: {
        id: documentId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        extension: getFileExtension(file.name),
        size: sourceFileSize,
        width: 0,
        height: 0,
      },
      previewLevels: [],
      settings: structuredClone(initialProfile.defaultSettings),
      colorManagement: DEFAULT_COLOR_MANAGEMENT,
      profileId: initialProfile.id,
      exportOptions: {
        ...DEFAULT_EXPORT_OPTIONS,
        filenameBase: sanitizeFilenameBase(file.name),
      },
      histogram: null,
      renderRevision: 0,
      status: 'loading',
      dirty: false,
    };
    flushSync(() => {
      setBlockingOverlay(rawImport ? {
        title: 'RAW import underway',
        detail: 'Decoding the RAW file and preparing the first preview.',
      } : {
        title: 'Import underway',
        detail: 'Loading the image and preparing preview levels.',
      });
      setTabs((previous) => [...previous, createDocumentTab(loadingDocument)]);
      setActiveTabId(documentId);
    });
    if (rawImport) {
      await waitForNextPaint();
    }

    try {
      let decoded: DecodedImage;
      let initialSettings = structuredClone(initialProfile.defaultSettings);
      let rawImportProfile: FilmProfile | null = null;

      if (rawImport) {
        try {
          const { rawResult, decodeRequest } = await decodeDesktopRawForWorker({
            documentId,
            fileName: file.name,
            path: nativePath,
            size: sourceFileSize,
          });
          const estimatedFilmBase = estimateFilmBaseSample(rawResult.data, rawResult.width, rawResult.height);
          initialSettings = buildRawInitialSettings(
            initialProfile.defaultSettings,
            rawResult.data,
            rawResult.width,
            rawResult.height,
            rawResult.orientation,
          );
          rawImportProfile = createRawImportProfile(initialProfile, initialSettings);

          if (estimatedFilmBase) {
            appendDiagnostic({
              level: 'info',
              code: 'RAW_FILM_BASE_ESTIMATED',
              message: `${estimatedFilmBase.r}/${estimatedFilmBase.g}/${estimatedFilmBase.b}`,
              context: {
                documentId,
                fileName: file.name,
              },
            });
          }

          appendDiagnostic({
            level: 'info',
            code: 'RAW_DECODED',
            message: `RAW decoded via Tauri: ${file.name} (${rawResult.width}×${rawResult.height}, ${rawResult.color_space})`,
            context: {
              colorSpace: rawResult.color_space,
              documentId,
              fileName: file.name,
              height: rawResult.height,
              orientation: rawResult.orientation ?? null,
              width: rawResult.width,
            },
          });

          decoded = await worker.decode(decodeRequest);
        } catch (rawError) {
          const message = formatError(rawError);
          appendDiagnostic({
            level: 'error',
            code: 'RAW_DECODE_FAILED',
            message,
            context: {
              documentId,
              fileName: file.name,
              nativePath: nativePath ?? null,
            },
          });
          throw rawError;
        }
      } else {
        const buffer = await file.arrayBuffer();
        if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) {
          appendDiagnostic({
            level: 'info',
            code: 'IMPORT_STALE_IGNORED',
            message: file.name,
            context: {
              documentId,
              importSession,
              stage: 'array-buffer',
            },
          });
          return;
        }

        decoded = await worker.decode({
          documentId,
          buffer,
          fileName: file.name,
          mime: file.type || 'application/octet-stream',
          size: sourceFileSize,
        });

        const rotationFromMetadata = rotationFromExifOrientation(decoded.metadata.exif?.orientation);
        if (rotationFromMetadata !== 0) {
          initialSettings = {
            ...initialSettings,
            rotation: rotationFromMetadata,
          };
        }
      }

      if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) {
        await disposeDocument(documentId);
        appendDiagnostic({
          level: 'info',
          code: 'IMPORT_STALE_IGNORED',
          message: file.name,
          context: {
            documentId,
            importSession,
            stage: 'decode',
          },
        });
        return;
      }

      const nextDocument: WorkspaceDocument = {
        id: documentId,
        source: {
          ...decoded.metadata,
          size: sourceFileSize,
        },
        previewLevels: decoded.previewLevels,
        settings: initialSettings,
        colorManagement: createDocumentColorManagement(decoded.metadata, {
          ...DEFAULT_EXPORT_OPTIONS,
          ...(savedPrefs?.exportOptions ? {
            format: savedPrefs.exportOptions.format,
            quality: savedPrefs.exportOptions.quality,
            embedMetadata: savedPrefs.exportOptions.embedMetadata,
            outputProfileId: savedPrefs.exportOptions.outputProfileId,
            embedOutputProfile: savedPrefs.exportOptions.embedOutputProfile,
          } : {}),
        }),
        rawImportProfile,
        profileId: rawImportProfile?.id ?? initialProfile.id,
        exportOptions: {
          ...DEFAULT_EXPORT_OPTIONS,
          ...(savedPrefs?.exportOptions ? {
            format: savedPrefs.exportOptions.format,
            quality: savedPrefs.exportOptions.quality,
            embedMetadata: savedPrefs.exportOptions.embedMetadata,
            outputProfileId: savedPrefs.exportOptions.outputProfileId,
            embedOutputProfile: savedPrefs.exportOptions.embedOutputProfile,
          } : {}),
          filenameBase: sanitizeFilenameBase(file.name),
        },
        histogram: null,
        renderRevision: 0,
        status: 'ready',
        dirty: false,
      };

      updateTabById(documentId, (tab) => ({
        ...tab,
        document: nextDocument,
        historyStack: [structuredClone(nextDocument.settings)],
        historyIndex: 0,
      }));

      if (decoded.metadata.unsupportedColorProfileName) {
        setTransientNotice({
          message: `Unsupported source profile "${decoded.metadata.unsupportedColorProfileName}". DarkSlide is using sRGB until you override it.`,
        });
      } else {
        setTransientNotice(null);
      }
      addRecentFile({
        name: file.name,
        path: isDesktopShell() ? (nativePath ?? null) : null,
        size: sourceFileSize,
      });
      appendDiagnostic({
        level: 'info',
        code: 'FILE_IMPORTED',
        message: file.name,
        context: {
          documentId,
          height: decoded.metadata.height,
          importSession,
          previewLevels: decoded.previewLevels.length,
          size: decoded.metadata.size,
          width: decoded.metadata.width,
        },
      });
    } catch (importError) {
      if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) return;

      const message = formatError(importError);
      const errorCode = getErrorCode(importError);
      activeDocumentIdRef.current = null;
      appendDiagnostic({
        level: 'error',
        code: 'IMPORT_FAILED',
        message,
        context: {
          documentId,
          fileName: file.name,
          importSession,
        },
      });
      setError(errorCode === 'OUT_OF_MEMORY' ? message : `Import failed. ${message}`);
      setTabs((previous) => previous.filter((tab) => tab.id !== documentId));
      if (activeTabId === documentId) {
        setActiveTabId(tabsRef.current.find((tab) => tab.id !== documentId)?.id ?? null);
      }
      setPreviewVisibility(false);
      clearCanvas();
      setBlockingOverlay(null);
    }
  }, [activeTabId, cancelPendingPreviewRetry, cancelScheduledInteractivePreview, clearCanvas, disposeDocument, fallbackProfile, setPreviewVisibility, updateTabById]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importFile(file, getNativePathFromFile(file));
  };

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
  }, [importFile, usesNativeFileDialogs]);

  const handleUndo = useCallback(() => {
    if (!activeTabId) return;

    let previousState: ConversionSettings | null = null;
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId || tab.historyIndex <= 0) {
        return tab;
      }

      const nextIndex = tab.historyIndex - 1;
      previousState = structuredClone(tab.historyStack[nextIndex] ?? null);
      return {
        ...tab,
        historyIndex: nextIndex,
        document: previousState ? { ...tab.document, settings: previousState, dirty: true } : tab.document,
      };
    }));
  }, [activeTabId]);

  const handleRedo = useCallback(() => {
    if (!activeTabId) return;

    let nextState: ConversionSettings | null = null;
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId || tab.historyIndex >= tab.historyStack.length - 1) {
        return tab;
      }

      const nextIndex = tab.historyIndex + 1;
      nextState = structuredClone(tab.historyStack[nextIndex] ?? null);
      return {
        ...tab,
        historyIndex: nextIndex,
        document: nextState ? { ...tab.document, settings: nextState, dirty: true } : tab.document,
      };
    }));
  }, [activeTabId]);

  const handleOpenBatchExport = useCallback(() => {
    setShowBatchModal(true);
  }, []);

  const handleOpenContactSheet = useCallback((payload: {
    entries: BatchJobEntry[];
    sharedSettings: ConversionSettings;
    sharedProfile: FilmProfile;
    sharedColorManagement: ColorManagementSettings;
  }) => {
    setContactSheetEntries(payload.entries);
    setContactSheetSharedSettings(payload.sharedSettings);
    setContactSheetSharedProfile(payload.sharedProfile);
    setContactSheetSharedColorManagement(payload.sharedColorManagement);
    setShowContactSheetModal(true);
  }, []);

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

  const handleGPURenderingChange = useCallback((enabled: boolean) => {
    setGPURenderingEnabled(enabled);
    workerClientRef.current?.setGPUEnabled(enabled);
    savePreferences({ ...prefsSnapshotRef.current, gpuRendering: enabled });
    void refreshRenderBackendDiagnostics();
  }, [refreshRenderBackendDiagnostics]);

  const handleUltraSmoothDragChange = useCallback((enabled: boolean) => {
    setUltraSmoothDragEnabled(enabled);
    savePreferences({ ...prefsSnapshotRef.current, ultraSmoothDrag: enabled });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (event.shiftKey && documentState) {
          void handleOpenInEditorRef.current?.();
        } else if (!event.shiftKey) {
          void handleOpenImage();
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && documentState) {
        event.preventDefault();
        void handleCloseImage();
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '0') {
        event.preventDefault();
        zoomToFit();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '1') {
        event.preventDefault();
        zoomTo100();
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        zoomIn();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '-') {
        event.preventDefault();
        zoomOut();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        if (event.shiftKey) {
          setShowBatchModal(true);
        } else if (documentState) {
          void handleDownloadRef.current?.();
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === '[' || event.key === '{') && tabs.length > 1) {
        event.preventDefault();
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
        const nextIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
        setActiveTabId(tabs[nextIndex]?.id ?? activeTabId);
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === ']' || event.key === '}') && tabs.length > 1) {
        event.preventDefault();
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
        const nextIndex = currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
        setActiveTabId(tabs[nextIndex]?.id ?? activeTabId);
      }

      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setShowSettingsModal((current) => !current);
      }

      if (event.key === ' ' && !event.repeat) {
        event.preventDefault();
        setIsSpaceHeld(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        setIsSpaceHeld(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activeTabId, documentState, handleCloseImage, handleOpenImage, handleRedo, handleUndo, tabs, zoomToFit, zoomTo100, zoomIn, zoomOut]);

  useEffect(() => {
    if (!usesNativeFileDialogs) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistenFn = await listen<string>('menu-action', (event) => {
          switch (event.payload) {
            case 'open': void handleOpenImage(); break;
            case 'export': void handleDownloadRef.current?.(); break;
            case 'open-in-editor': void handleOpenInEditorRef.current?.(); break;
            case 'batch-export': setShowBatchModal(true); break;
            case 'close-image': void handleCloseImage(); break;
            case 'reset-adjustments': handleResetRef.current?.(); break;
            case 'copy-debug-info': void handleCopyDebugInfoRef.current?.(); break;
            case 'toggle-comparison': handleToggleComparison(); break;
            case 'toggle-crop-overlay': handleToggleCropOverlay(); break;
            case 'toggle-adjustments-pane': handleToggleLeftPane(); break;
            case 'toggle-profiles-pane': handleToggleRightPane(); break;
            case 'zoom-fit': zoomToFit(); break;
            case 'zoom-100': zoomTo100(); break;
            case 'zoom-in': zoomIn(); break;
            case 'zoom-out': zoomOut(); break;
            case 'show-settings': setShowSettingsModal(true); break;
          }
        });
        unlisten = unlistenFn;
      } catch {
        // Not in Tauri environment
      }
    })();

    return () => { unlisten?.(); };
  }, [
    usesNativeFileDialogs,
    handleOpenImage,
    handleCloseImage,
    handleToggleComparison,
    handleToggleCropOverlay,
    handleToggleLeftPane,
    handleToggleRightPane,
    zoomToFit,
    zoomTo100,
    zoomIn,
    zoomOut,
  ]);

  const handleProfileChange = useCallback((profile: FilmProfile) => {
    updateDocument((current) => ({
      ...current,
      profileId: profile.id,
      settings: structuredClone(profile.defaultSettings),
      dirty: true,
    }));
    resetHistory(profile.defaultSettings);
    savePreferences({ ...prefsSnapshotRef.current, lastProfileId: profile.id });
  }, [resetHistory, updateDocument]);

  const handleSavePreset = useCallback((
    name: string,
    metadata?: { filmStock?: string; scannerType?: ScannerType | null },
  ) => {
    if (!documentState) return;
    const newPreset = savePreset({
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `custom-${crypto.randomUUID()}`
        : `custom-${Date.now()}`,
      version: 1,
      name,
      type: activeProfile.type,
      description: 'Custom DarkSlide preset',
      defaultSettings: structuredClone(documentState.settings),
      isCustom: true,
      tags: savePresetTags,
      filmStock: metadata?.filmStock?.trim() ? metadata.filmStock.trim() : null,
      scannerType: metadata?.scannerType ?? null,
    });
    updateDocument((current) => ({
      ...current,
      profileId: newPreset.id,
      dirty: false,
    }));
  }, [activeProfile.type, documentState, savePreset, savePresetTags, updateDocument]);

  const handleImportPreset = useCallback((
    profile: FilmProfile,
    options?: { overwriteId?: string; renameTo?: string },
  ) => {
    importPreset({
      ...profile,
      version: profile.version ?? 1,
      description: profile.description || 'Imported DarkSlide preset',
      tags: profile.tags?.length ? profile.tags : [profile.type],
      filmStock: profile.filmStock ?? null,
      scannerType: profile.scannerType ?? null,
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
    // Push current state before resetting so Cmd+Z can restore it.
    pushHistoryEntry(documentState.settings);
    updateDocument((current) => ({
      ...current,
      settings: structuredClone(activeProfile.defaultSettings),
      dirty: false,
    }));
  }, [activeProfile.defaultSettings, documentState, pushHistoryEntry, updateDocument]);
  handleResetRef.current = handleReset;

  const handleDownload = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) return;

    setDocumentState((current) => current ? { ...current, status: 'exporting' } : current);
    try {
      if (notificationSettings.enabled && notificationSettings.exportComplete) {
        await primeExportNotificationsPermission();
      }
      const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
      const result = await worker.export({
        documentId: documentState.id,
        settings: documentState.settings,
        isColor: activeProfile.type === 'color' && !documentState.settings.blackAndWhite.enabled,
        inputProfileId,
        outputProfileId: documentState.exportOptions.outputProfileId,
        options: documentState.exportOptions,
        sourceExif: documentState.source.exif,
        maskTuning: activeProfile.maskTuning,
        colorMatrix: activeProfile.colorMatrix,
        tonalCharacter: activeProfile.tonalCharacter,
      });

      const saveResult = await saveExportBlob(result.blob, result.filename, documentState.exportOptions.format);
      if (saveResult === 'saved') {
        appendDiagnostic({ level: 'info', code: 'EXPORT_SUCCESS', message: result.filename, context: { format: documentState.exportOptions.format } });
        if (notificationSettings.enabled && notificationSettings.exportComplete) {
          await notifyExportFinished({
            kind: 'export',
            filename: result.filename,
          });
        }
      } else {
        appendDiagnostic({ level: 'info', code: 'EXPORT_CANCELLED', message: result.filename, context: { format: documentState.exportOptions.format } });
      }
      setDocumentState((current) => current ? { ...current, status: 'ready' } : current);
      void refreshRenderBackendDiagnostics();
    } catch (exportError) {
      const message = formatError(exportError);
      appendDiagnostic({ level: 'error', code: 'EXPORT_FAILED', message });
      setError(`Export failed. ${message}`);
      setDocumentState((current) => current ? { ...current, status: 'error', errorCode: 'EXPORT_FAILED' } : current);
      void refreshRenderBackendDiagnostics();
    }
  }, [activeProfile.colorMatrix, activeProfile.maskTuning, activeProfile.tonalCharacter, activeProfile.type, documentState, notificationSettings.enabled, notificationSettings.exportComplete, refreshRenderBackendDiagnostics]);

  handleDownloadRef.current = handleDownload;

  const handleExportClick = useCallback(() => {
    void handleDownload();
  }, [handleDownload]);

  const handleOpenInEditor = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) return;

    setDocumentState((current) => current ? { ...current, status: 'exporting' } : current);
    try {
      const inputProfileId = getResolvedInputProfileId(documentState.source, documentState.colorManagement);
      const result = await worker.export({
        documentId: documentState.id,
        settings: documentState.settings,
        isColor: activeProfile.type === 'color' && !documentState.settings.blackAndWhite.enabled,
        inputProfileId,
        outputProfileId: documentState.exportOptions.outputProfileId,
        options: documentState.exportOptions,
        sourceExif: documentState.source.exif,
        maskTuning: activeProfile.maskTuning,
        colorMatrix: activeProfile.colorMatrix,
        tonalCharacter: activeProfile.tonalCharacter,
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
      showTransientNotice(`Saved to ${openResult.savedPath} and opened in ${editorName || 'default app'}`);
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
  }, [activeProfile.colorMatrix, activeProfile.maskTuning, activeProfile.tonalCharacter, activeProfile.type, documentState, showTransientNotice]);
  handleOpenInEditorRef.current = handleOpenInEditor;

  const handleOpenInEditorClick = useCallback(() => {
    void handleOpenInEditor();
  }, [handleOpenInEditor]);

  const handleChooseExternalEditor = useCallback(async () => {
    const result = await chooseApplicationPath();
    if (result) {
      setExternalEditorPath(result.path);
      setExternalEditorName(result.name);
      savePreferences({ ...prefsSnapshotRef.current, externalEditorPath: result.path, externalEditorName: result.name });
    }
  }, []);

  const handleClearExternalEditor = useCallback(() => {
    setExternalEditorPath(null);
    setExternalEditorName(null);
    savePreferences({ ...prefsSnapshotRef.current, externalEditorPath: null, externalEditorName: null });
  }, []);

  const handleChooseOpenInEditorOutputPath = useCallback(async () => {
    try {
      const selected = await openDirectory();
      if (!selected) {
        return;
      }

      setOpenInEditorOutputPath(selected);
      savePreferences({ ...prefsSnapshotRef.current, openInEditorOutputPath: selected });
    } catch (pathError) {
      const message = formatError(pathError, { preservePrefix: true });
      setError(`Could not choose an Open in Editor folder. ${message}`);
    }
  }, []);

  const handleUseDownloadsForOpenInEditor = useCallback(() => {
    setOpenInEditorOutputPath(null);
    savePreferences({ ...prefsSnapshotRef.current, openInEditorOutputPath: null });
  }, []);

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
          // Compute temperature/tint correction to neutralize the sampled pixel
          const safeR = Math.max(sample.r, 1);
          const safeG = Math.max(sample.g, 1);
          const safeB = Math.max(sample.b, 1);
          // Temperature: R vs B cast. Tint: G vs RB average cast.
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
  }, [activePointPicker, displaySettings, documentState, handleSettingsChange, isPickingFilmBase, targetMaxDimension]);

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
        targetMaxDimension,
        renderBackend: renderBackendDiagnostics,
      },
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setError('Debug info copied to clipboard.');
    } catch {
      setError('Could not copy debug info to the clipboard.');
    }
  }, [canvasSize, documentState, hasVisiblePreview, renderBackendDiagnostics, targetMaxDimension]);
  handleCopyDebugInfoRef.current = handleCopyDebugInfo;

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await importFile(file, getNativePathFromFile(file));
  }, [importFile]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleReorderTabs = useCallback((sourceId: string, targetId: string) => {
    setTabs((previous) => {
      const sourceIndex = previous.findIndex((tab) => tab.id === sourceId);
      const targetIndex = previous.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return previous;
      }

      const next = [...previous];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const handleSidebarScrollTopChange = useCallback((scrollTop: number) => {
    if (!activeTabId) {
      return;
    }

    updateTabById(activeTabId, (tab) => (
      Math.abs(tab.sidebarScrollTop - scrollTop) < 1
        ? tab
        : { ...tab, sidebarScrollTop: scrollTop }
    ));
  }, [activeTabId, updateTabById]);

  const handleTitleBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!usesNativeFileDialogs || event.button !== 0) return;

    const appWindow = tauriWindowRef.current;
    if (!appWindow) return;

    event.preventDefault();
    void appWindow.startDragging().catch(() => {
      // Fall back to the native drag region attribute if startDragging fails.
    });
  }, [usesNativeFileDialogs]);

  const showBlockingOverlay = Boolean(blockingOverlay);
  const overlayContent = blockingOverlay;
  const isExporting = documentState?.status === 'exporting';

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      {usesNativeFileDialogs && (
        <div
          data-tauri-drag-region=""
          onMouseDownCapture={handleTitleBarMouseDown}
          className="absolute inset-x-0 top-0 z-30 h-8 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl"
        />
      )}

      <div className={`flex min-h-0 w-full flex-1 ${usesNativeFileDialogs ? 'pt-8' : ''}`}>
        <AnimatePresence initial={false}>
          {isLeftPaneOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="h-full shrink-0 border-r border-zinc-800 overflow-hidden"
            >
              <Sidebar
                settings={documentState?.settings ?? fallbackProfile.defaultSettings}
                exportOptions={documentState?.exportOptions ?? DEFAULT_EXPORT_OPTIONS}
                colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
                sourceMetadata={documentState?.source ?? null}
                cropImageWidth={cropImageSize.width}
                cropImageHeight={cropImageSize.height}
                onLevelInteractionChange={setIsAdjustingLevel}
                onSettingsChange={handleSettingsChange}
                onExportOptionsChange={handleExportOptionsChange}
                onColorManagementChange={handleColorManagementChange}
                onInteractionStart={handleInteractionStart}
                onInteractionEnd={handleInteractionEnd}
                activeProfile={documentState ? activeProfile : null}
                histogramData={documentState?.histogram ?? null}
                isPickingFilmBase={isPickingFilmBase}
                onTogglePicker={handleToggleFilmBasePicker}
                onExport={handleExportClick}
                onOpenBatchExport={handleOpenBatchExport}
                isExporting={isExporting}
                contentScrollTop={activeTab?.sidebarScrollTop ?? 0}
                onContentScrollTopChange={handleSidebarScrollTopChange}
                activeTab={sidebarTab}
                onTabChange={handleSidebarTabChange}
                cropTab={cropTab}
                onCropTabChange={handleCropTabChange}
                onCropDone={handleCropDone}
                onResetCrop={handleResetCrop}
                activePointPicker={activePointPicker}
                onSetPointPicker={setActivePointPicker}
                onOpenSettings={handleOpenSettingsModal}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="flex-1 flex flex-col relative overflow-hidden bg-zinc-900/30 min-w-0">
          <header
            className="h-14 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-zinc-950/50 backdrop-blur-xl z-20 px-4"
          >
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsLeftPaneOpen((current) => !current)}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-all"
              data-tip="Toggle Adjustments"
            >
              {isLeftPaneOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </button>
            <h1 className="text-sm font-bold tracking-tight text-zinc-100 ml-2">
              Dark<span className="text-zinc-500 font-medium">Slide</span>{' '}
              <span className="text-zinc-700 font-normal ml-1 text-[10px] uppercase tracking-widest">beta</span>
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {documentState && (
              <>
                <div className="flex items-center gap-1 mr-2">
                  <button
                    onClick={handleUndo}
                    disabled={!canUndo}
                    className={`p-2 rounded-lg transition-all ${
                      canUndo ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-700 cursor-not-allowed'
                    }`}
                    data-tip="Undo (Cmd+Z)"
                  >
                    <Undo2 size={18} />
                  </button>
                  <button
                    onClick={handleRedo}
                    disabled={!canRedo}
                    className={`p-2 rounded-lg transition-all ${
                      canRedo ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-700 cursor-not-allowed'
                    }`}
                    data-tip="Redo (Cmd+Shift+Z)"
                  >
                    <Redo2 size={18} />
                  </button>
                </div>
                <div className="w-px h-4 bg-zinc-800 mx-1" />
                <button
                  onClick={handleReset}
                  className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                  data-tip="Reset Adjustments to Current Preset"
                >
                  <RotateCcw size={18} />
                </button>
                <button
                  onClick={() => setComparisonMode((current) => current === 'processed' ? 'original' : 'processed')}
                  className={`p-2 rounded-lg transition-all ${comparisonMode === 'original' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'}`}
                  data-tip={comparisonMode === 'original' ? 'Showing Original — click to return' : 'Toggle Before/After'}
                >
                  <SplitSquareVertical size={18} />
                </button>
                <button
                  onClick={() => setIsCropOverlayVisible((current) => !current)}
                  className={`p-2 rounded-lg transition-all ${isCropOverlayVisible ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'}`}
                  data-tip="Toggle Crop Overlay"
                >
                  <Crop size={18} />
                </button>
                {isDesktopShell() && (
                  <button
                    onClick={handleOpenInEditorClick}
                    disabled={Boolean(isExporting)}
                    className="p-2 rounded-lg transition-all text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    data-tip="Open in External Editor"
                  >
                    <ExternalLink size={18} />
                  </button>
                )}
                <div className="w-px h-4 bg-zinc-800 mx-1" />
                <button
                  onClick={handleDownload}
                  disabled={Boolean(isExporting)}
                  className="flex items-center gap-2 px-4 py-1.5 bg-zinc-100 text-zinc-950 rounded-lg text-sm font-medium hover:bg-white transition-all shadow-lg shadow-black/20 disabled:opacity-50"
                >
                  {isExporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {isExporting ? 'Exporting...' : 'Export'}
                </button>
              </>
            )}
            <button
              onClick={() => void handleOpenImage()}
              className="flex items-center gap-2 px-4 py-1.5 bg-zinc-800 text-zinc-200 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-all border border-zinc-700/50"
            >
              <Upload size={16} /> Import
            </button>
            {!usesNativeFileDialogs && (
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                className="hidden"
              />
            )}
            <div className="w-px h-4 bg-zinc-800 mx-1" />
            <button
              onClick={() => setIsRightPaneOpen((current) => !current)}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-all"
              data-tip="Toggle Profiles"
            >
              {isRightPaneOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
            </button>
          </div>
        </header>

        {tabs.length > 0 && (
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={(tabId) => void handleCloseImage(tabId)}
            onCreateTab={() => void handleOpenImage()}
            onReorderTabs={handleReorderTabs}
          />
        )}

        <div
          ref={viewportRef}
          className={`flex-1 relative overflow-hidden flex items-center justify-center p-8 ${isDragActive ? 'bg-zinc-900/60' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragActive(true);
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
        >
          <AnimatePresence mode="wait">
            {!documentState ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col items-center text-center max-w-md"
              >
                <div className="w-20 h-20 rounded-3xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-6 shadow-2xl">
                  <ImageIcon size={32} className="text-zinc-600" />
                </div>
                <h2 className="text-2xl font-semibold text-zinc-200 mb-3 tracking-tight">Drop your negatives here</h2>
                <p className="text-zinc-500 text-sm leading-relaxed mb-8">Import TIFF, JPEG, or PNG scans, plus RAW files in the desktop app.</p>
                <button
                  onClick={() => void handleOpenImage()}
                  className="px-8 py-3 bg-zinc-100 text-zinc-950 rounded-2xl font-semibold hover:bg-white transition-all shadow-xl shadow-black/40"
                >
                  Select Files
                </button>
                <RecentFilesList
                  onImport={(file, path, size) => void importFile(file, path, size)}
                  onOpenPicker={() => void handleOpenImage()}
                />
              </motion.div>
            ) : (
              <motion.div
                key="editor"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="relative w-full h-full flex flex-col items-center justify-center gap-2"
              >
                <div
                  className={`relative flex-1 w-full overflow-hidden border border-zinc-800 bg-black ${isFullscreen ? 'fixed inset-0 z-50 bg-zinc-950' : ''}`}
                  onWheel={(e) => {
                    if (!documentState) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const normX = (e.clientX - rect.left) / rect.width;
                    const normY = (e.clientY - rect.top) / rect.height;
                    handleZoomWheel(e.deltaY, normX, normY);
                  }}
                  onMouseDown={(e) => {
                    if (!documentState) return;
                    const canPan = (zoom !== 'fit' || isSpaceHeld) && !isPickingFilmBase && !activePointPicker && !isCropOverlayVisible;
                    if (canPan && e.button === 0) {
                      e.preventDefault();
                      setIsPanDragging(true);
                      startPan(e.clientX, e.clientY);
                    }
                  }}
                  onMouseMove={(e) => {
                    if (!isPanDragging) return;
                    const viewport = viewportRef.current;
                    if (!viewport) return;
                    updatePan(e.clientX, e.clientY, viewport.clientWidth, viewport.clientHeight, effectiveZoom);
                  }}
                  onMouseUp={() => {
                    if (isPanDragging) {
                      setIsPanDragging(false);
                      endPan();
                    }
                  }}
                  onMouseLeave={() => {
                    if (isPanDragging) {
                      setIsPanDragging(false);
                      endPan();
                    }
                  }}
                  style={{ cursor: isPanDragging ? 'grabbing' : (zoom !== 'fit' && !isPickingFilmBase && !activePointPicker ? 'grab' : undefined) }}
                >
                  <div className="absolute right-4 top-4 z-20">
                    <ZoomBar
                      zoom={zoom}
                      fitScale={fitScale}
                      onZoomToFit={zoomToFit}
                      onZoomTo100={zoomTo100}
                      onZoomIn={zoomIn}
                      onZoomOut={zoomOut}
                      onSetZoom={setZoomLevel}
                    />
                  </div>

                  <AnimatePresence initial={false}>
                    {showTabSwitchOverlay && (
                      <motion.div
                        key={tabSwitchOverlayKey}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 0.16, 0] }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        className="pointer-events-none absolute inset-0 z-10"
                        style={{
                          background: 'radial-gradient(circle at center, rgba(24,24,27,0.28), rgba(24,24,27,0.14) 46%, rgba(24,24,27,0) 76%)',
                        }}
                      />
                    )}
                  </AnimatePresence>

                  <div
                    className="absolute inset-0 flex items-center justify-center will-change-transform"
                    style={{
                      transform: `scale(${effectiveZoom}) translate(${(0.5 - pan.x) * 100}%, ${(0.5 - pan.y) * 100}%)`,
                      transformOrigin: 'center center',
                    }}
                  >
                    <div
                      className="relative inline-block will-change-transform"
                      style={previewTransformAngle === 0 ? undefined : { transform: `rotate(${previewTransformAngle}deg)` }}
                    >
                      <canvas
                        ref={displayCanvasRef}
                        onClick={handleCanvasClick}
                        className={`block transition-opacity duration-300 ${showBlockingOverlay ? 'opacity-30' : 'opacity-100'} ${showMagnifier ? 'cursor-none' : ''}`}
                        style={{
                          width: `${logicalPreviewSize.width}px`,
                          height: `${logicalPreviewSize.height}px`,
                        }}
                      />
                    {isAdjustingLevel && comparisonMode === 'processed' && (
                      <div
                        className="absolute inset-0 pointer-events-none opacity-80"
                        style={{
                          backgroundImage: [
                            'linear-gradient(to right, transparent 24.35%, rgba(0,0,0,0.28) 24.7%, rgba(255,255,255,0.58) 25%, rgba(0,0,0,0.28) 25.3%, transparent 25.65%)',
                            'linear-gradient(to right, transparent 49.2%, rgba(0,0,0,0.34) 49.65%, rgba(255,255,255,0.82) 50%, rgba(0,0,0,0.34) 50.35%, transparent 50.8%)',
                            'linear-gradient(to right, transparent 74.35%, rgba(0,0,0,0.28) 74.7%, rgba(255,255,255,0.58) 75%, rgba(0,0,0,0.28) 75.3%, transparent 75.65%)',
                            'linear-gradient(to bottom, transparent 24.35%, rgba(0,0,0,0.28) 24.7%, rgba(255,255,255,0.58) 25%, rgba(0,0,0,0.28) 25.3%, transparent 25.65%)',
                            'linear-gradient(to bottom, transparent 49.2%, rgba(0,0,0,0.34) 49.65%, rgba(255,255,255,0.82) 50%, rgba(0,0,0,0.34) 50.35%, transparent 50.8%)',
                            'linear-gradient(to bottom, transparent 74.35%, rgba(0,0,0,0.28) 74.7%, rgba(255,255,255,0.58) 75%, rgba(0,0,0,0.28) 75.3%, transparent 75.65%)',
                          ].join(','),
                          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.28)',
                        }}
                      />
                    )}
                    {isCropOverlayVisible && comparisonMode === 'processed' && (
                      <CropOverlay
                        crop={documentState.settings.crop}
                        imageWidth={cropImageSize.width}
                        imageHeight={cropImageSize.height}
                        onInteractionStart={handleCropInteractionStart}
                        onInteractionEnd={handleCropInteractionEnd}
                        onChange={handleCropOverlayChange}
                      />
                    )}
                    </div>
                  </div>

                </div>

                <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 rounded-2xl shadow-2xl">
                      <span className="text-[10px] font-mono text-zinc-500 px-2 uppercase tracking-widest">{activeProfile.name}</span>
                      <div className="w-px h-4 bg-zinc-800 mx-1" />
                      <span className="text-[10px] font-mono text-zinc-500 px-2 uppercase tracking-widest">
                        {documentState.source.width.toLocaleString()} × {documentState.source.height.toLocaleString()} px
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap justify-end">
                    <button
                      onClick={() => void handleCloseImage()}
                      className="flex items-center gap-2 px-3 py-2 bg-zinc-950/80 hover:bg-red-500/20 text-zinc-400 hover:text-red-400 backdrop-blur-md rounded-xl border border-zinc-800 transition-all shadow-xl"
                      data-tip="Close Image"
                    >
                      <X size={16} />
                      <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Close</span>
                    </button>
                  </div>
                </div>
              </motion.div>
          )}
          </AnimatePresence>

          {overlayContent && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/55 backdrop-blur-sm">
              <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-950/95 px-6 py-5 shadow-2xl shadow-black/60">
                <div className="flex items-center gap-4">
                  <Loader2 className="shrink-0 animate-spin text-zinc-200" size={30} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-100">{overlayContent.title}</p>
                    <p className="mt-1 text-xs text-zinc-400">{overlayContent.detail}</p>
                  </div>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-zinc-200" />
                </div>
              </div>
            </div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute bottom-8 right-8 flex items-center gap-3 px-4 py-3 bg-red-950/50 border border-red-900/50 rounded-xl text-red-200 text-sm backdrop-blur-xl shadow-2xl z-50 max-w-md"
            >
              <FileWarning size={18} className="text-red-400 shrink-0" />
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 opacity-50 hover:opacity-100">✕</button>
            </motion.div>
          )}

          {transientNotice && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-28 right-8 flex items-center gap-3 px-4 py-3 bg-amber-950/55 border border-amber-800/60 rounded-xl text-amber-100 text-sm backdrop-blur-xl shadow-2xl z-50 max-w-md"
            >
              <FileWarning size={18} className="text-amber-300 shrink-0" />
              <span>{transientNotice.message}</span>
              <button onClick={() => setTransientNotice(null)} className="ml-2 opacity-50 hover:opacity-100">✕</button>
            </motion.div>
          )}
          </div>
        </main>

        <AnimatePresence initial={false}>
          {isRightPaneOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="h-full shrink-0 border-l border-zinc-800 overflow-hidden"
            >
              <PresetsPane
                activeStockId={documentState?.profileId ?? fallbackProfile.id}
                onStockChange={handleProfileChange}
                builtinProfiles={builtinProfiles}
                customPresets={customPresets}
                canSavePreset={Boolean(documentState)}
                saveTags={savePresetTags}
                onSavePreset={handleSavePreset}
                onImportPreset={handleImportPreset}
                onDeletePreset={handleDeletePreset}
                onError={setError}
              />
              </motion.div>
            )}
          </AnimatePresence>

          {showMagnifier && (
            <MagnifierLoupe
              sourceCanvas={displayCanvasRef.current}
              containerRef={viewportRef}
              magnification={6}
              size={120}
            />
          )}
        </div>

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        onCopyDebugInfo={handleCopyDebugInfo}
        gpuRenderingEnabled={gpuRenderingEnabled}
        ultraSmoothDragEnabled={ultraSmoothDragEnabled}
        renderBackendDiagnostics={renderBackendDiagnostics}
        onToggleGPURendering={handleGPURenderingChange}
        onToggleUltraSmoothDrag={handleUltraSmoothDragChange}
        notificationSettings={notificationSettings}
        onNotificationSettingsChange={handleNotificationSettingsChange}
        colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={documentState?.source ?? null}
        onColorManagementChange={handleColorManagementChange}
        externalEditorPath={externalEditorPath}
        externalEditorName={externalEditorName}
        openInEditorOutputPath={openInEditorOutputPath}
        onChooseExternalEditor={handleChooseExternalEditor}
        onClearExternalEditor={handleClearExternalEditor}
        onChooseOpenInEditorOutputPath={() => void handleChooseOpenInEditorOutputPath()}
        onUseDownloadsForOpenInEditor={handleUseDownloadsForOpenInEditor}
      />
      <BatchModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        onOpenContactSheet={(payload) => {
          setShowBatchModal(false);
          handleOpenContactSheet(payload);
        }}
        workerClient={workerClientRef.current}
        currentSettings={documentState?.settings ?? null}
        currentProfile={documentState ? activeProfile : null}
        currentColorManagement={documentState?.colorManagement ?? null}
        notificationSettings={notificationSettings}
        customProfiles={customPresets}
        openTabs={tabs}
      />
      <ContactSheetModal
        isOpen={showContactSheetModal}
        onClose={() => setShowContactSheetModal(false)}
        entries={contactSheetEntries}
        sharedSettings={contactSheetSharedSettings}
        sharedProfile={contactSheetSharedProfile}
        sharedColorManagement={contactSheetSharedColorManagement}
        notificationSettings={notificationSettings}
        workerClient={workerClientRef.current}
      />
    </div>
  );
}
