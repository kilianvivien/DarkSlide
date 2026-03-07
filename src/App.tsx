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
  Pipette,
  Copy,
  SplitSquareVertical,
  Crop,
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PresetsPane } from './components/PresetsPane';
import { CropOverlay } from './components/CropOverlay';
import { DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, RAW_EXTENSIONS, SUPPORTED_EXTENSIONS } from './constants';
import { ConversionSettings, FilmProfile, WorkspaceDocument } from './types';
import { useHistory } from './hooks/useHistory';
import { useCustomPresets } from './hooks/useCustomPresets';
import { appendDiagnostic, getDiagnosticsReport } from './utils/diagnostics';
import { ImageWorkerClient } from './utils/imageWorkerClient';
import { clamp, getFileExtension, sanitizeFilenameBase } from './utils/imagePipeline';

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

export default function App() {
  const [documentState, setDocumentState] = useState<WorkspaceDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLeftPaneOpen, setIsLeftPaneOpen] = useState(true);
  const [isRightPaneOpen, setIsRightPaneOpen] = useState(true);
  const [isPickingFilmBase, setIsPickingFilmBase] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<'processed' | 'original'>('processed');
  const [isDragActive, setIsDragActive] = useState(false);
  const [isCropOverlayVisible, setIsCropOverlayVisible] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workerClientRef = useRef<ImageWorkerClient | null>(null);
  const renderRevisionRef = useRef(0);

  const { customPresets, savePreset, deletePreset } = useCustomPresets();
  const allProfiles = useMemo(() => [...FILM_PROFILES, ...customPresets], [customPresets]);
  const fallbackProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0];
  const activeProfile = documentState
    ? allProfiles.find((profile) => profile.id === documentState.profileId) ?? fallbackProfile
    : fallbackProfile;

  const { push, undo, redo, canUndo, canRedo, reset: resetHistory } = useHistory<ConversionSettings>(fallbackProfile.defaultSettings);

  useEffect(() => {
    workerClientRef.current = new ImageWorkerClient();
    return () => {
      workerClientRef.current?.terminate();
      workerClientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!documentState) return;
    const timer = window.setTimeout(() => {
      push(documentState.settings);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [documentState?.settings, push]);

  const drawPreview = useCallback((imageData: ImageData) => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return;

    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.putImageData(imageData, 0, 0);
    setCanvasSize({ width: imageData.width, height: imageData.height });
  }, []);

  const getTargetMaxDimension = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return 1024;
    return Math.max(512, Math.ceil(Math.max(viewport.clientWidth, viewport.clientHeight) * window.devicePixelRatio));
  }, []);

  const renderDocument = useCallback(async (nextDocument: WorkspaceDocument, nextComparisonMode: 'processed' | 'original') => {
    const worker = workerClientRef.current;
    if (!worker) return;

    const revision = renderRevisionRef.current + 1;
    renderRevisionRef.current = revision;

    setDocumentState((current) => current && current.id === nextDocument.id ? { ...current, status: 'processing', renderRevision: revision } : current);

    try {
      const result = await worker.render({
        documentId: nextDocument.id,
        settings: nextDocument.settings,
        isColor: activeProfile.type === 'color',
        revision,
        targetMaxDimension: getTargetMaxDimension(),
        comparisonMode: nextComparisonMode,
      });

      if (result.revision !== renderRevisionRef.current) return;

      drawPreview(result.imageData);
      setDocumentState((current) => {
        if (!current || current.id !== nextDocument.id) return current;
        return {
          ...current,
          histogram: result.histogram,
          renderRevision: result.revision,
          status: 'ready',
        };
      });
    } catch (renderError) {
      const message = formatError(renderError);
      appendDiagnostic({ level: 'error', code: 'RENDER_FAILED', message, context: { comparisonMode: nextComparisonMode } });
      setError(`Processing failed. ${message}`);
      setDocumentState((current) => current && current.id === nextDocument.id ? { ...current, status: 'error', errorCode: 'RENDER_FAILED' } : current);
    }
  }, [activeProfile.type, drawPreview, getTargetMaxDimension]);

  useEffect(() => {
    if (!documentState) return;
    const timer = window.setTimeout(() => {
      void renderDocument(documentState, comparisonMode);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [comparisonMode, documentState, renderDocument]);

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

  const disposeCurrentDocument = useCallback(async () => {
    if (!documentState || !workerClientRef.current) return;
    try {
      await workerClientRef.current.disposeDocument(documentState.id);
    } catch {
      // Ignore worker disposal failures while resetting the UI.
    }
  }, [documentState]);

  const clearCanvas = () => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 1;
    canvas.height = 1;
    ctx?.clearRect(0, 0, 1, 1);
    setCanvasSize({ width: 0, height: 0 });
  };

  const handleCloseImage = useCallback(async () => {
    await disposeCurrentDocument();
    renderRevisionRef.current = 0;
    setDocumentState(null);
    setError(null);
    setComparisonMode('processed');
    setIsPickingFilmBase(false);
    setIsCropOverlayVisible(false);
    clearCanvas();
    resetHistory(fallbackProfile.defaultSettings);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [disposeCurrentDocument, fallbackProfile.defaultSettings, resetHistory]);

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
    renderRevisionRef.current = 0;

    if (documentState) {
      await disposeCurrentDocument();
    }

    const documentId = crypto.randomUUID();
    const initialProfile = fallbackProfile;

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
      const decoded = await worker.decode({
        documentId,
        buffer,
        fileName: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      });

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
        context: { width: decoded.metadata.width, height: decoded.metadata.height, size: decoded.metadata.size },
      });
    } catch (importError) {
      const message = formatError(importError);
      appendDiagnostic({ level: 'error', code: 'IMPORT_FAILED', message, context: { fileName: file.name } });
      setError(`Import failed. ${message}`);
      setDocumentState(null);
      clearCanvas();
    }
  }, [disposeCurrentDocument, documentState, fallbackProfile, resetHistory]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await importFile(file);
  };

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
        fileInputRef.current?.click();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && documentState) {
        event.preventDefault();
        void handleCloseImage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [documentState, handleCloseImage, handleRedo, handleUndo]);

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
    updateDocument((current) => ({
      ...current,
      settings: structuredClone(activeProfile.defaultSettings),
      dirty: false,
    }));
    resetHistory(activeProfile.defaultSettings);
  }, [activeProfile.defaultSettings, documentState, resetHistory, updateDocument]);

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

      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.download = result.filename;
      link.href = url;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      appendDiagnostic({ level: 'info', code: 'EXPORT_SUCCESS', message: result.filename, context: { format: documentState.exportOptions.format } });
      setDocumentState((current) => current ? { ...current, status: 'ready' } : current);
    } catch (exportError) {
      const message = formatError(exportError);
      appendDiagnostic({ level: 'error', code: 'EXPORT_FAILED', message });
      setError(`Export failed. ${message}`);
      setDocumentState((current) => current ? { ...current, status: 'error', errorCode: 'EXPORT_FAILED' } : current);
    }
  }, [activeProfile.type, documentState]);

  const handleCanvasClick = useCallback(async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!documentState || !isPickingFilmBase || !displayCanvasRef.current || !workerClientRef.current) return;

    const canvas = displayCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    try {
      const sample = await workerClientRef.current.sampleFilmBase({
        documentId: documentState.id,
        settings: documentState.settings,
        targetMaxDimension: getTargetMaxDimension(),
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
  }, [documentState, getTargetMaxDimension, handleSettingsChange, isPickingFilmBase]);

  const handleCopyDebugInfo = useCallback(async () => {
    const report = {
      document: documentState,
      diagnostics: getDiagnosticsReport(),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setError('Debug info copied to clipboard.');
    } catch {
      setError('Could not copy debug info to the clipboard.');
    }
  }, [documentState]);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await importFile(file);
  }, [importFile]);

  const isBusy = documentState?.status === 'loading' || documentState?.status === 'processing';
  const isExporting = documentState?.status === 'exporting';

  return (
    <div className="flex h-screen w-screen bg-zinc-950 font-sans text-zinc-100 overflow-hidden">
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
              onSettingsChange={handleSettingsChange}
              onExportOptionsChange={handleExportOptionsChange}
              activeProfile={documentState ? activeProfile : null}
              histogramData={documentState?.histogram ?? null}
              isPickingFilmBase={isPickingFilmBase}
              onTogglePicker={() => setIsPickingFilmBase((current) => !current)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex-1 flex flex-col relative overflow-hidden bg-zinc-900/30 min-w-0">
        <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4 shrink-0 bg-zinc-950/50 backdrop-blur-xl z-20">
          <div className="flex items-center gap-4">
            <div className="flex gap-1.5 mr-2">
              <div className="w-3 h-3 rounded-full bg-zinc-800" />
              <div className="w-3 h-3 rounded-full bg-zinc-800" />
              <div className="w-3 h-3 rounded-full bg-zinc-800" />
            </div>
            <button
              onClick={() => setIsLeftPaneOpen((current) => !current)}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-all"
              title="Toggle Adjustments"
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
                    title="Undo (Cmd+Z)"
                  >
                    <Undo2 size={18} />
                  </button>
                  <button
                    onClick={handleRedo}
                    disabled={!canRedo}
                    className={`p-2 rounded-lg transition-all ${
                      canRedo ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-700 cursor-not-allowed'
                    }`}
                    title="Redo (Cmd+Shift+Z)"
                  >
                    <Redo2 size={18} />
                  </button>
                </div>
                <div className="w-px h-4 bg-zinc-800 mx-1" />
                <button
                  onClick={handleReset}
                  className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                  title="Reset Adjustments"
                >
                  <RotateCcw size={18} />
                </button>
                <button
                  onClick={() => setComparisonMode((current) => current === 'processed' ? 'original' : 'processed')}
                  className={`p-2 rounded-lg transition-all ${comparisonMode === 'original' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'}`}
                  title="Toggle Before/After"
                >
                  <SplitSquareVertical size={18} />
                </button>
                <button
                  onClick={() => setIsCropOverlayVisible((current) => !current)}
                  className={`p-2 rounded-lg transition-all ${isCropOverlayVisible ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'}`}
                  title="Toggle Crop Overlay"
                >
                  <Crop size={18} />
                </button>
                <button
                  onClick={handleCopyDebugInfo}
                  className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                  title="Copy Debug Info"
                >
                  <Copy size={18} />
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
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-1.5 bg-zinc-800 text-zinc-200 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-all border border-zinc-700/50"
            >
              <Upload size={16} /> Import
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
              className="hidden"
            />
            <div className="w-px h-4 bg-zinc-800 mx-1" />
            <button
              onClick={() => setIsRightPaneOpen((current) => !current)}
              className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-all"
              title="Toggle Profiles"
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
                <p className="text-zinc-500 text-sm leading-relaxed mb-8">
                  Import TIFF, JPEG, PNG, or WebP scans. DarkSlide keeps decode, preview render, and export work off the React thread.
                </p>
                <button
                  onClick={() => fileInputRef.current?.click()}
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
                className="relative w-full h-full flex items-center justify-center"
              >
                <div className={`relative max-w-full max-h-full shadow-2xl rounded-sm overflow-hidden border border-zinc-800 bg-black transition-all flex items-center justify-center ${isFullscreen ? 'fixed inset-0 z-50 p-4 bg-zinc-950' : ''}`}>
                  <div className="relative inline-block max-w-full max-h-full">
                    <canvas
                      ref={displayCanvasRef}
                      onClick={handleCanvasClick}
                      className={`block max-w-full max-h-[calc(100vh-12rem)] object-contain transition-opacity duration-300 ${isBusy ? 'opacity-30' : 'opacity-100'} ${isPickingFilmBase ? 'cursor-crosshair' : ''}`}
                      style={canvasSize.width > 0 ? { aspectRatio: `${canvasSize.width} / ${canvasSize.height}` } : undefined}
                    />
                    {isCropOverlayVisible && comparisonMode === 'processed' && (
                      <CropOverlay
                        crop={documentState.settings.crop}
                        onChange={(crop) => handleSettingsChange({ crop })}
                      />
                    )}
                  </div>

                  {isBusy && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/50 backdrop-blur-sm">
                      <Loader2 className="animate-spin text-zinc-400" size={48} />
                      <p className="text-zinc-400 text-sm font-medium animate-pulse">
                        {documentState.status === 'loading' ? 'Decoding high-resolution file…' : 'Rendering preview…'}
                      </p>
                    </div>
                  )}

                  <div className="absolute top-4 right-4 flex gap-2">
                    {activeProfile.type === 'color' && (
                      <button
                        onClick={() => setIsPickingFilmBase((current) => !current)}
                        className={`p-2 rounded-full border transition-all shadow-xl ${isPickingFilmBase ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/60' : 'bg-zinc-950/80 text-zinc-400 border-zinc-800 hover:text-zinc-100'}`}
                        title="Sample Film Base"
                      >
                        <Pipette size={18} />
                      </button>
                    )}
                    <button
                      onClick={() => void handleCloseImage()}
                      className="p-2 bg-zinc-950/80 hover:bg-red-500/20 text-zinc-400 hover:text-red-400 backdrop-blur-md rounded-full border border-zinc-800 transition-all shadow-xl"
                      title="Close Image"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 bg-zinc-950/80 backdrop-blur-md border border-zinc-800 rounded-2xl shadow-2xl">
                    <span className="text-[10px] font-mono text-zinc-500 px-2 uppercase tracking-widest">{activeProfile.name}</span>
                    <div className="w-px h-4 bg-zinc-800 mx-1" />
                    <span className="text-[10px] font-mono text-zinc-500 px-2 uppercase tracking-widest">
                      {comparisonMode === 'processed' ? 'Processed' : 'Original'}
                    </span>
                    <div className="w-px h-4 bg-zinc-800 mx-1" />
                    <span className="text-[10px] font-mono text-zinc-500 px-2 uppercase tracking-widest">
                      {documentState.source.width}×{documentState.source.height}
                    </span>
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
  );
}
