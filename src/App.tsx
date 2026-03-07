import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PresetsPane } from './components/PresetsPane';
import { CropOverlay } from './components/CropOverlay';
import { SettingsModal } from './components/SettingsModal';
import { DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, RAW_EXTENSIONS, SUPPORTED_EXTENSIONS } from './constants';
import { ConversionSettings, FilmProfile, WorkspaceDocument } from './types';
import { useHistory } from './hooks/useHistory';
import { useCustomPresets } from './hooks/useCustomPresets';
import { useViewportZoom } from './hooks/useViewportZoom';
import { ZoomBar } from './components/ZoomBar';
import { appendDiagnostic, getDiagnosticsReport } from './utils/diagnostics';
import { isDesktopShell, openImageFile, saveExportBlob } from './utils/fileBridge';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { clamp, getFileExtension, getTransformedDimensions, sanitizeFilenameBase } from './utils/imagePipeline';

function formatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const readable = message.includes(': ') ? message.split(': ').slice(1).join(': ') : message;
  return readable || 'Unknown error.';
}

function isSupportedFile(file: File) {
  const extension = getFileExtension(file.name);
  return SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number]);
}

function isRawFile(file: File) {
  const extension = getFileExtension(file.name);
  return RAW_EXTENSIONS.includes(extension as typeof RAW_EXTENSIONS[number]);
}

function normalizePreviewImageData(imageData: ImageData, width: number, height: number) {
  if (imageData.width === width && imageData.height === height) {
    return imageData;
  }

  return new ImageData(new Uint8ClampedArray(imageData.data), width, height);
}

function getCanvas2dContext(canvas: HTMLCanvasElement) {
  return canvas.getContext('2d', { willReadFrequently: true }) ?? canvas.getContext('2d');
}

export default function App() {
  const usesNativeFileDialogs = isDesktopShell();
  const [documentState, setDocumentState] = useState<WorkspaceDocument | null>(null);
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
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [targetMaxDimension, setTargetMaxDimension] = useState(1024);
  const [hasVisiblePreview, setHasVisiblePreview] = useState(false);
  const [renderedPreviewAngle, setRenderedPreviewAngle] = useState(0);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'adjust' | 'curves' | 'crop' | 'export'>('adjust');
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const [displayScaleFactor, setDisplayScaleFactor] = useState(() => (
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  ));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const renderRevisionRef = useRef(0);
  const importSessionRef = useRef(0);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeRenderRequestRef = useRef<{ documentId: string; revision: number } | null>(null);
  const hasVisiblePreviewRef = useRef(false);
  const pendingPreviewRef = useRef<{ documentId: string; angle: number; imageData: ImageData } | null>(null);
  const previewRetryFrameRef = useRef<number | null>(null);
  const handleDownloadRef = useRef<(() => void) | null>(null);
  const handleResetRef = useRef<(() => void) | null>(null);
  const handleCopyDebugInfoRef = useRef<(() => Promise<void>) | null>(null);
  const tauriWindowRef = useRef<{
    startDragging: () => Promise<void>;
    scaleFactor: () => Promise<number>;
    onScaleChanged: (handler: ({ payload }: { payload: { scaleFactor: number } }) => void) => Promise<() => void>;
  } | null>(null);

  const { customPresets, savePreset, deletePreset } = useCustomPresets();
  const allProfiles = useMemo(() => [...FILM_PROFILES, ...customPresets], [customPresets]);
  const fallbackProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0];
  const activeProfile = documentState
    ? allProfiles.find((profile) => profile.id === documentState.profileId) ?? fallbackProfile
    : fallbackProfile;
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

  const renderTargetDimension = useMemo(() => {
    const baseDim = isAdjustingLevel ? Math.min(targetMaxDimension, 1024) : targetMaxDimension;
    const z = zoom === 'fit' ? 1 : zoom;
    if (z <= 1) return baseDim;
    const sourceMax = documentState ? Math.max(documentState.source.width, documentState.source.height) : baseDim;
    return Math.min(sourceMax, Math.ceil(baseDim * z));
  }, [isAdjustingLevel, targetMaxDimension, zoom, documentState]);
  const previewTransformAngle = isAdjustingLevel ? displayAngle - renderedPreviewAngle : 0;

  const { push, undo, redo, canUndo, canRedo, reset: resetHistory, beginInteraction, commitInteraction } = useHistory<ConversionSettings>(fallbackProfile.defaultSettings);

  const isInteractingRef = useRef(false);

  const handleInteractionStart = useCallback(() => {
    isInteractingRef.current = true;
    beginInteraction();
  }, [beginInteraction]);

  const handleInteractionEnd = useCallback(() => {
    isInteractingRef.current = false;
    if (documentState) {
      commitInteraction(documentState.settings);
    }
  }, [commitInteraction, documentState]);

  useEffect(() => {
    workerClientRef.current = new ImageWorkerClient();
    return () => {
      if (previewRetryFrameRef.current !== null) {
        window.cancelAnimationFrame(previewRetryFrameRef.current);
      }
      workerClientRef.current?.terminate();
      workerClientRef.current = null;
    };
  }, []);

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
      push(documentState.settings);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [documentState?.settings, push]);

  const setPreviewVisibility = useCallback((next: boolean) => {
    hasVisiblePreviewRef.current = next;
    setHasVisiblePreview(next);
  }, []);

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
      setRenderedPreviewAngle(pendingPreview.angle);
      setPreviewVisibility(true);
      previewRetryFrameRef.current = null;
      return;
    }

    if (attempt >= 10) {
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

  const renderDocument = useCallback(async (
    documentId: string,
    settings: ConversionSettings,
    isColor: boolean,
    nextComparisonMode: 'processed' | 'original',
    nextTargetMaxDimension: number,
    maskTuning?: { highlightProtectionBias: number; blackPointBias: number },
  ) => {
    const worker = workerClientRef.current;
    if (!worker) return;

    const revision = renderRevisionRef.current + 1;
    renderRevisionRef.current = revision;
    activeRenderRequestRef.current = { documentId, revision };

    appendDiagnostic({
      level: 'info',
      code: 'RENDER_REQUESTED',
      message: documentId,
      context: {
        comparisonMode: nextComparisonMode,
        documentId,
        revision,
        targetMaxDimension: nextTargetMaxDimension,
      },
    });

    setDocumentState((current) => current && current.id === documentId ? { ...current, status: 'processing', renderRevision: revision } : current);

    try {
      const result = await worker.render({
        documentId,
        settings,
        isColor,
        revision,
        targetMaxDimension: nextTargetMaxDimension,
        comparisonMode: nextComparisonMode,
        maskTuning,
      });

      const isLatestResult = activeDocumentIdRef.current === result.documentId
        && activeRenderRequestRef.current?.documentId === result.documentId
        && activeRenderRequestRef.current?.revision === result.revision
        && result.revision === renderRevisionRef.current;

      if (!isLatestResult) {
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
        return;
      }

      pendingPreviewRef.current = {
        documentId: result.documentId,
        angle: settings.rotation + settings.levelAngle,
        imageData: normalizePreviewImageData(result.imageData, result.width, result.height),
      };
      cancelPendingPreviewRetry();
      flushPendingPreview();
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
      setDocumentState((current) => {
        if (!current || current.id !== documentId) return current;
        return {
          ...current,
          histogram: result.histogram,
          renderRevision: result.revision,
          status: 'ready',
        };
      });
    } catch (renderError) {
      const isLatestRequest = activeDocumentIdRef.current === documentId
        && activeRenderRequestRef.current?.documentId === documentId
        && activeRenderRequestRef.current?.revision === revision;
      if (!isLatestRequest) return;

      const message = formatError(renderError);
      appendDiagnostic({
        level: 'error',
        code: 'RENDER_FAILED',
        message,
        context: {
          comparisonMode: nextComparisonMode,
          documentId,
          revision,
          targetMaxDimension: nextTargetMaxDimension,
        },
      });
      setError(`Processing failed. ${message}`);
      setDocumentState((current) => current && current.id === documentId ? { ...current, status: 'error', errorCode: 'RENDER_FAILED' } : current);
    }
  }, [cancelPendingPreviewRetry, drawPreview, flushPendingPreview, setPreviewVisibility]);

  useEffect(() => {
    if (!documentState || !displaySettings || documentState.previewLevels.length === 0) return;

    const documentId = documentState.id;
    const settings = displaySettings;
    const isColor = activeProfile.type === 'color';
    const profileMaskTuning = activeProfile.maskTuning;
    const debounceMs = isAdjustingLevel ? 40 : (hasVisiblePreviewRef.current ? 120 : 0);
    const timer = window.setTimeout(() => {
      void renderDocument(documentId, settings, isColor, comparisonMode, renderTargetDimension, profileMaskTuning);
    }, debounceMs);

    return () => window.clearTimeout(timer);
  }, [activeProfile.type, activeProfile.maskTuning, comparisonMode, displaySettings, documentState?.id, documentState?.previewLevels.length, isAdjustingLevel, renderDocument, renderTargetDimension]);

  const updateDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument) => {
    setDocumentState((current) => (current ? updater(current) : current));
  }, []);

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
    if (tab === 'crop') {
      setIsCropOverlayVisible(true);
    }
  }, []);

  const handleCropDone = useCallback(() => {
    setSidebarTab('adjust');
    setIsCropOverlayVisible(false);
  }, []);

  const handleResetCrop = useCallback(() => {
    handleSettingsChange({
      crop: { x: 0, y: 0, width: 1, height: 1, aspectRatio: null },
      levelAngle: 0,
    });
  }, [handleSettingsChange]);

  const handleExportOptionsChange = useCallback((options: Partial<WorkspaceDocument['exportOptions']>) => {
    updateDocument((current) => ({
      ...current,
      exportOptions: {
        ...current.exportOptions,
        ...options,
      },
      dirty: true,
    }));
  }, [updateDocument]);

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

  const handleCloseImage = useCallback(async () => {
    const documentId = activeDocumentIdRef.current;
    importSessionRef.current += 1;
    activeDocumentIdRef.current = null;
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current = null;
    cancelPendingPreviewRetry();
    renderRevisionRef.current = 0;
    setPreviewVisibility(false);
    setIsAdjustingLevel(false);
    setRenderedPreviewAngle(0);
    await disposeDocument(documentId);
    setDocumentState(null);
    setError(null);
    setComparisonMode('processed');
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    zoomToFit();
    clearCanvas();
    appendDiagnostic({
      level: 'info',
      code: 'IMAGE_CLOSED',
      message: documentId ?? 'none',
      context: {
        documentId,
      },
    });
    resetHistory(fallbackProfile.defaultSettings);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [cancelPendingPreviewRetry, clearCanvas, disposeDocument, fallbackProfile.defaultSettings, resetHistory, setPreviewVisibility, zoomToFit]);

  const importFile = useCallback(async (file: File) => {
    const worker = workerClientRef.current;
    if (!worker) return;

    if (isRawFile(file)) {
      setError('RAW import is reserved for the future desktop path. Use TIFF, JPEG, PNG, or WebP in the browser build.');
      appendDiagnostic({ level: 'error', code: 'RAW_UNSUPPORTED', message: file.name, context: { extension: getFileExtension(file.name) } });
      return;
    }

    if (!isSupportedFile(file)) {
      setError('Unsupported file type. Import TIFF, JPEG, PNG, or WebP for now.');
      appendDiagnostic({ level: 'error', code: 'UNSUPPORTED_FILE', message: file.name });
      return;
    }

    setError(null);
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    setIsAdjustingLevel(false);
    setRenderedPreviewAngle(0);
    setPreviewVisibility(false);
    clearCanvas();
    renderRevisionRef.current = 0;
    activeRenderRequestRef.current = null;
    pendingPreviewRef.current = null;
    cancelPendingPreviewRetry();

    const importSession = importSessionRef.current + 1;
    importSessionRef.current = importSession;
    const previousDocumentId = activeDocumentIdRef.current;
    await disposeDocument(previousDocumentId);

    const documentId = crypto.randomUUID();
    const initialProfile = fallbackProfile;
    activeDocumentIdRef.current = documentId;

    appendDiagnostic({
      level: 'info',
      code: 'IMPORT_STARTED',
      message: file.name,
      context: {
        documentId,
        extension: getFileExtension(file.name),
        importSession,
        size: file.size,
      },
    });

    setDocumentState({
      id: documentId,
      source: {
        id: documentId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        extension: getFileExtension(file.name),
        size: file.size,
        width: 0,
        height: 0,
      },
      previewLevels: [],
      settings: structuredClone(initialProfile.defaultSettings),
      profileId: initialProfile.id,
      exportOptions: {
        ...DEFAULT_EXPORT_OPTIONS,
        filenameBase: sanitizeFilenameBase(file.name),
      },
      histogram: null,
      renderRevision: 0,
      status: 'loading',
      dirty: false,
    });

    try {
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

      const decoded = await worker.decode({
        documentId,
        buffer,
        fileName: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      });

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
        source: decoded.metadata,
        previewLevels: decoded.previewLevels,
        settings: structuredClone(initialProfile.defaultSettings),
        profileId: initialProfile.id,
        exportOptions: {
          ...DEFAULT_EXPORT_OPTIONS,
          filenameBase: sanitizeFilenameBase(file.name),
        },
        histogram: null,
        renderRevision: 0,
        status: 'ready',
        dirty: false,
      };

      setDocumentState(nextDocument);
      resetHistory(nextDocument.settings);
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
      setError(`Import failed. ${message}`);
      setDocumentState(null);
      setPreviewVisibility(false);
      clearCanvas();
    }
  }, [cancelPendingPreviewRetry, clearCanvas, disposeDocument, fallbackProfile, resetHistory, setPreviewVisibility]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importFile(file);
  };

  const handleOpenImage = useCallback(async () => {
    if (!usesNativeFileDialogs) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const file = await openImageFile();
      if (!file) {
        return;
      }

      await importFile(file);
    } catch (openError) {
      const message = formatError(openError);
      appendDiagnostic({ level: 'error', code: 'OPEN_DIALOG_FAILED', message });
      setError(`Could not open file. ${message}`);
    }
  }, [importFile, usesNativeFileDialogs]);

  const handleUndo = useCallback(() => {
    const previousState = undo();
    if (!previousState) return;
    updateDocument((current) => ({ ...current, settings: structuredClone(previousState), dirty: true }));
  }, [undo, updateDocument]);

  const handleRedo = useCallback(() => {
    const nextState = redo();
    if (!nextState) return;
    updateDocument((current) => ({ ...current, settings: structuredClone(nextState), dirty: true }));
  }, [redo, updateDocument]);

  const handleToggleComparison = useCallback(() => {
    setComparisonMode((current) => current === 'processed' ? 'original' : 'processed');
  }, []);

  const handleToggleCropOverlay = useCallback(() => {
    setIsCropOverlayVisible((current) => !current);
  }, []);

  const handleToggleLeftPane = useCallback(() => {
    setIsLeftPaneOpen((current) => !current);
  }, []);

  const handleToggleRightPane = useCallback(() => {
    setIsRightPaneOpen((current) => !current);
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
        void handleOpenImage();
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

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e' && documentState) {
        event.preventDefault();
        void handleDownloadRef.current?.();
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
  }, [documentState, handleCloseImage, handleOpenImage, handleRedo, handleUndo, zoomToFit, zoomTo100, zoomIn, zoomOut]);

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
  }, [resetHistory, updateDocument]);

  const handleSavePreset = useCallback((name: string) => {
    if (!documentState) return;
    const newPreset = savePreset(name, activeProfile.type, documentState.settings);
    updateDocument((current) => ({
      ...current,
      profileId: newPreset.id,
      dirty: false,
    }));
  }, [activeProfile.type, documentState, savePreset, updateDocument]);

  const handleDeletePreset = useCallback((id: string) => {
    deletePreset(id);
    if (documentState?.profileId === id) {
      handleProfileChange(fallbackProfile);
    }
  }, [deletePreset, documentState?.profileId, fallbackProfile, handleProfileChange]);

  const handleReset = useCallback(() => {
    if (!documentState) return;
    // Push current state before resetting so Cmd+Z can restore it.
    push(documentState.settings);
    updateDocument((current) => ({
      ...current,
      settings: structuredClone(activeProfile.defaultSettings),
      dirty: false,
    }));
  }, [activeProfile.defaultSettings, documentState, push, updateDocument]);
  handleResetRef.current = handleReset;

  const handleDownload = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || !documentState) return;

    setDocumentState((current) => current ? { ...current, status: 'exporting' } : current);
    try {
      const result = await worker.export({
        documentId: documentState.id,
        settings: documentState.settings,
        isColor: activeProfile.type === 'color',
        options: documentState.exportOptions,
      });

      const saveResult = await saveExportBlob(result.blob, result.filename, documentState.exportOptions.format);
      if (saveResult === 'saved') {
        appendDiagnostic({ level: 'info', code: 'EXPORT_SUCCESS', message: result.filename, context: { format: documentState.exportOptions.format } });
      } else {
        appendDiagnostic({ level: 'info', code: 'EXPORT_CANCELLED', message: result.filename, context: { format: documentState.exportOptions.format } });
      }
      setDocumentState((current) => current ? { ...current, status: 'ready' } : current);
    } catch (exportError) {
      const message = formatError(exportError);
      appendDiagnostic({ level: 'error', code: 'EXPORT_FAILED', message });
      setError(`Export failed. ${message}`);
      setDocumentState((current) => current ? { ...current, status: 'error', errorCode: 'EXPORT_FAILED' } : current);
    }
  }, [activeProfile.type, documentState]);

  handleDownloadRef.current = handleDownload;

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
        const sample = await workerClientRef.current.sampleFilmBase({
          documentId: documentState.id,
          settings: displaySettings,
          targetMaxDimension,
          x,
          y,
        });

        const safeRed = Math.max(sample.r, 1);
        const safeBlue = Math.max(sample.b, 1);
        const safeGreen = Math.max(sample.g, 1);

        handleSettingsChange({
          filmBaseSample: sample,
          redBalance: clamp(safeGreen / safeRed, 0.5, 1.5),
          greenBalance: 1,
          blueBalance: clamp(safeGreen / safeBlue, 0.5, 1.5),
        });

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
        const sample = await workerClientRef.current.sampleFilmBase({
          documentId: documentState.id,
          settings: displaySettings,
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
      },
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setError('Debug info copied to clipboard.');
    } catch {
      setError('Could not copy debug info to the clipboard.');
    }
  }, [canvasSize, documentState, hasVisiblePreview, targetMaxDimension]);
  handleCopyDebugInfoRef.current = handleCopyDebugInfo;

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await importFile(file);
  }, [importFile]);

  const handleTitleBarMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!usesNativeFileDialogs || event.button !== 0) return;

    const appWindow = tauriWindowRef.current;
    if (!appWindow) return;

    event.preventDefault();
    void appWindow.startDragging().catch(() => {
      // Fall back to the native drag region attribute if startDragging fails.
    });
  }, [usesNativeFileDialogs]);

  const showBlockingOverlay = documentState?.status === 'loading' || (documentState?.status === 'processing' && !hasVisiblePreview);
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
                cropImageWidth={cropImageSize.width}
                cropImageHeight={cropImageSize.height}
                onLevelInteractionChange={setIsAdjustingLevel}
                onSettingsChange={handleSettingsChange}
                onExportOptionsChange={handleExportOptionsChange}
                onInteractionStart={handleInteractionStart}
                onInteractionEnd={handleInteractionEnd}
                activeProfile={documentState ? activeProfile : null}
                histogramData={documentState?.histogram ?? null}
                isPickingFilmBase={isPickingFilmBase}
                onTogglePicker={() => setIsPickingFilmBase((current) => !current)}
                onExport={() => void handleDownload()}
                isExporting={isExporting}
                activeTab={sidebarTab}
                onTabChange={handleSidebarTabChange}
                onCropDone={handleCropDone}
                onResetCrop={handleResetCrop}
                activePointPicker={activePointPicker}
                onSetPointPicker={setActivePointPicker}
                onOpenSettings={() => setShowSettingsModal(true)}
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
                  data-tip="Reset Adjustments (undoable)"
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
                <p className="text-zinc-500 text-sm leading-relaxed mb-8">Import TIFF, JPEG, PNG, or WebP scans.</p>
                <button
                  onClick={() => void handleOpenImage()}
                  className="px-8 py-3 bg-zinc-100 text-zinc-950 rounded-2xl font-semibold hover:bg-white transition-all shadow-xl shadow-black/40"
                >
                  Select Files
                </button>
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
                  style={{ cursor: isPanDragging ? 'grabbing' : (zoom !== 'fit' && !isPickingFilmBase ? 'grab' : undefined) }}
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
                        className={`block transition-opacity duration-300 ${showBlockingOverlay ? 'opacity-30' : 'opacity-100'} ${(isPickingFilmBase || activePointPicker) ? 'cursor-crosshair' : ''}`}
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
                        onChange={(crop) => handleSettingsChange({ crop })}
                      />
                    )}
                    </div>
                  </div>

                  {showBlockingOverlay && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/50 backdrop-blur-sm z-10">
                      <Loader2 className="animate-spin text-zinc-400" size={48} />
                      <p className="text-zinc-400 text-sm font-medium animate-pulse">
                        {documentState.status === 'loading' ? 'Decoding high-resolution file…' : 'Rendering preview…'}
                      </p>
                    </div>
                  )}

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
                customPresets={customPresets}
                onSavePreset={handleSavePreset}
                onDeletePreset={handleDeletePreset}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        onCopyDebugInfo={handleCopyDebugInfo}
      />
    </div>
  );
}
