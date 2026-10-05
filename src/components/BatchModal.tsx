import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Check, CheckCircle2, ChevronDown, Download, FileImage, Files, FolderOpen, Layers, Loader2, Plus, Trash2, Upload, X } from 'lucide-react';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, LAB_STYLE_PROFILES_MAP, MAX_FILE_SIZE_BYTES, RAW_EXTENSIONS } from '../constants';
import { ColorManagementSettings, ColorProfileId, ConversionSettings, DocumentTab, ExportOptions, FilmProfile, LabStyleProfile, LightSourceProfile, NotificationSettings } from '../types';
import { getDesktopDownloadsDirectory, isDesktopShell, openDirectory, openImageFolder, openMultipleImageFiles } from '../utils/fileBridge';
import { BatchJobEntry, runBatch } from '../utils/batchProcessor';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { customProfileHasEmbeddedCropOrRotation, getBatchEffectiveSettings } from '../utils/batchSettings';
import { notifyExportFinished, primeExportNotificationsPermission } from '../utils/exportNotifications';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useModalA11y } from '../hooks/useModalA11y';
import { normalizeExportOptions } from '../utils/exportOptions';
import { Slider } from './Slider';
import { FIELD_LABEL, SECTION_TITLE, SEGMENT_TRACK, segmentItem } from './ui';

type SettingsSourceMode = 'current' | 'builtin' | 'custom';

interface BatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  workerClient: ImageWorkerClient | null;
  currentSettings: ConversionSettings | null;
  currentProfile: FilmProfile | null;
  currentLabStyle: LabStyleProfile | null;
  currentColorManagement: ColorManagementSettings | null;
  currentLightSourceBias?: [number, number, number] | null;
  lightSourceProfiles: LightSourceProfile[];
  notificationSettings: NotificationSettings;
  customProfiles: FilmProfile[];
  openTabs: DocumentTab[];
  defaultOutputPath?: string | null;
}

function formatFileSize(size: number) {
  if (size > 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

const SMALL_BUTTON = 'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50';
const FIELD_SELECT = 'w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition-colors focus:border-zinc-500';

const STATUS_STYLE: Record<BatchJobEntry['status'], { label: string; text: string }> = {
  pending: { label: 'Ready', text: 'text-zinc-500' },
  processing: { label: 'Converting', text: 'text-accent-300' },
  done: { label: 'Done', text: 'text-emerald-400' },
  error: { label: 'Error', text: 'text-red-400' },
};

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-800 font-mono text-[9px] text-zinc-300">{children}</span>
  );
}

function RadioOption({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex items-center gap-2.5 text-[12px] ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
      <input type="radio" className="peer sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent-400 ${
        checked ? 'border-accent-400' : 'border-zinc-600'
      }`}>
        {checked && <span className="h-[7px] w-[7px] rounded-full bg-accent-400" />}
      </span>
      <span className="text-zinc-300">{children}</span>
    </label>
  );
}

function CheckOption({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex items-center gap-2.5 text-[12px] ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent-400 ${
        checked ? 'border-accent-400 bg-accent-400' : 'border-zinc-600'
      }`}>
        {checked && <Check size={10} className="text-zinc-950" strokeWidth={3} />}
      </span>
      <span className="text-zinc-300">{children}</span>
    </label>
  );
}

export function BatchModal({
  isOpen,
  onClose,
  workerClient,
  currentSettings,
  currentProfile,
  currentLabStyle,
  currentColorManagement,
  currentLightSourceBias = null,
  lightSourceProfiles,
  notificationSettings,
  customProfiles,
  openTabs,
  defaultOutputPath,
}: BatchModalProps) {
  const [entries, setEntries] = useState<BatchJobEntry[]>([]);
  const [settingsSource, setSettingsSource] = useState<SettingsSourceMode>(currentSettings && currentProfile ? 'current' : 'builtin');
  const [selectedProfileId, setSelectedProfileId] = useState(FILM_PROFILES[0]?.id ?? 'generic-color');
  const [selectedCustomProfileId, setSelectedCustomProfileId] = useState(customProfiles[0]?.id ?? '');
  const [ignorePresetCropAndRotation, setIgnorePresetCropAndRotation] = useState(false);
  const [batchAutoCrop, setBatchAutoCrop] = useState(true);
  const [batchAutoDustRemoval, setBatchAutoDustRemoval] = useState(currentSettings?.dustRemoval?.autoEnabled ?? false);
  const [batchFlareMode, setBatchFlareMode] = useState<'per-image' | 'first-frame'>('per-image');
  const [batchAutoMode, setBatchAutoMode] = useState<'off' | 'per-image' | 'first-frame'>('off');
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    filenameBase: '{original}_darkslide',
  });
  const [colorManagement, setColorManagement] = useState<ColorManagementSettings>(currentColorManagement ?? DEFAULT_COLOR_MANAGEMENT);
  const [outputPath, setOutputPath] = useState<string | null>(defaultOutputPath ?? null);
  const [isRunning, setIsRunning] = useState(false);
  const [colorMgmtExpanded, setColorMgmtExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const cancelTokenRef = useRef({ cancelled: false });
  const desktopShell = isDesktopShell();

  useFocusTrap(modalRef, isOpen);
  const { titleId } = useModalA11y(isOpen, onClose);

  const selectedBuiltinProfile = useMemo(
    () => FILM_PROFILES.find((profile) => profile.id === selectedProfileId) ?? FILM_PROFILES[0],
    [selectedProfileId],
  );
  const selectedCustomProfile = useMemo(
    () => customProfiles.find((profile) => profile.id === selectedCustomProfileId) ?? customProfiles[0] ?? null,
    [customProfiles, selectedCustomProfileId],
  );
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSettingsSource(currentSettings && currentProfile ? 'current' : 'builtin');
    setColorManagement(currentColorManagement ?? DEFAULT_COLOR_MANAGEMENT);
    setIgnorePresetCropAndRotation(false);
    setBatchAutoCrop(true);
    setBatchAutoDustRemoval(currentSettings?.dustRemoval?.autoEnabled ?? false);
    setBatchFlareMode('per-image');
    setBatchAutoMode('off');
  }, [currentColorManagement, currentProfile, currentSettings, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setEntries((current) => {
      const existingOpenTabs = new Map<string, BatchJobEntry>(
        current
          .filter((entry) => entry.kind === 'open-tab')
          .map((entry) => [entry.documentId ?? entry.id, entry] as const),
      );
      const fileEntries = current.filter((entry) => entry.kind === 'file');

      const nextOpenEntries = openTabs.map((tab) => {
        const existingEntry = existingOpenTabs.get(tab.id);

        return {
        id: tab.id,
        kind: 'open-tab' as const,
        documentId: tab.id,
        sourceMetadata: tab.document.source,
        filename: tab.document.source.name,
        size: tab.document.source.size,
        status: existingEntry?.status ?? 'pending',
        errorMessage: existingEntry?.errorMessage,
        progress: existingEntry?.progress,
        histogram: tab.document.histogram,
        estimatedFlare: tab.document.estimatedFlare,
        };
      });

      return [...nextOpenEntries, ...fileEntries];
    });
  }, [isOpen, openTabs]);

  useEffect(() => {
    if (exportOptions.format !== 'image/webp' || exportOptions.outputProfileId === 'srgb') {
      return;
    }

    setExportOptions((current) => normalizeExportOptions({ ...current, outputProfileId: 'srgb' }));
  }, [exportOptions.format, exportOptions.outputProfileId]);

  if (!isOpen) {
    return <AnimatePresence />;
  }

  const addFiles = (files: Array<{ file: File; nativePath?: string; nativeSize?: number }>) => {
    const nextEntries = files.map(({ file, nativePath, nativeSize }) => {
      const size = nativeSize ?? file.size;
      return {
        id: crypto.randomUUID(),
        kind: 'file' as const,
        file,
        nativePath,
        filename: file.name,
        size,
        status: 'pending' as const,
        errorMessage: !nativePath && size > MAX_FILE_SIZE_BYTES
          ? `File exceeds ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`
          : undefined,
      };
    });

    setEntries((current) => [...current, ...nextEntries]);
  };

  const handleAddFiles = async () => {
    if (!isDesktopShell()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const nativeFiles = await openMultipleImageFiles();
      if (nativeFiles.length > 0) {
        addFiles(nativeFiles.map((entry) => ({ file: entry.file, nativePath: entry.path, nativeSize: entry.size })));
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  const handleAddFolder = async () => {
    try {
      const nativeFiles = await openImageFolder();
      if (nativeFiles.length > 0) {
        addFiles(nativeFiles.map((entry) => ({ file: entry.file, nativePath: entry.path, nativeSize: entry.size })));
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await openDirectory();
      if (selected) {
        setOutputPath(selected);
        setError(null);
      }
    } catch (folderError) {
      setError(folderError instanceof Error ? folderError.message : String(folderError));
    }
  };

  const handleUseDownloads = async () => {
    try {
      const selected = await getDesktopDownloadsDirectory();
      if (!selected) {
        setError('Could not determine the desktop Downloads folder.');
        return;
      }

      setOutputPath(selected);
      setError(null);
    } catch (downloadsError) {
      setError(downloadsError instanceof Error ? downloadsError.message : String(downloadsError));
    }
  };

  const sharedProfile = settingsSource === 'current'
    ? currentProfile
    : (settingsSource === 'builtin' ? selectedBuiltinProfile : selectedCustomProfile);
  const sharedLabStyle = settingsSource === 'current'
    ? currentLabStyle
    : (sharedProfile?.labStyleId ? LAB_STYLE_PROFILES_MAP[sharedProfile.labStyleId] ?? null : null);
  const sharedLightSourceBias = settingsSource === 'current'
    ? currentLightSourceBias
    : (sharedProfile?.lightSourceId
      ? (lightSourceProfiles.find((profile) => profile.id === sharedProfile.lightSourceId)?.spectralBias ?? null)
      : null);
  const sharedSettings = settingsSource === 'current'
    ? currentSettings
    : (sharedProfile
      ? getBatchEffectiveSettings(
        sharedProfile.defaultSettings,
        settingsSource === 'custom' && ignorePresetCropAndRotation,
      )
      : null);
  const selectedCustomProfileHasEmbeddedTransforms = settingsSource === 'custom'
    && customProfileHasEmbeddedCropOrRotation(selectedCustomProfile);

  const handleStart = async () => {
    if (!workerClient || !sharedSettings || !sharedProfile) {
      setError('Choose a settings source before starting the batch.');
      return;
    }

    const runnableEntries = entries.filter((entry) => !entry.errorMessage);
    if (runnableEntries.length === 0) {
      setError('Add at least one supported file before starting the batch.');
      return;
    }

    let resolvedOutputPath = outputPath;
    if (desktopShell && !resolvedOutputPath) {
      try {
        const selected = await openDirectory();
        if (!selected) {
          setError('Choose an output folder or use Downloads before starting the batch.');
          return;
        }

        resolvedOutputPath = selected;
        setOutputPath(selected);
      } catch (folderError) {
        setError(folderError instanceof Error ? folderError.message : String(folderError));
        return;
      }
    }

    cancelTokenRef.current = { cancelled: false };
    setIsRunning(true);
    setError(null);
    if (notificationSettings.enabled && notificationSettings.batchComplete) {
      await primeExportNotificationsPermission();
    }
    setEntries((current) => current.map((entry) => ({
      ...entry,
      status: entry.errorMessage ? 'error' : 'pending',
      progress: entry.errorMessage ? undefined : 0,
    })));

    try {
      let successCount = 0;
      let failureCount = 0;
      const shouldClearEntriesAfterSuccess = runnableEntries.length === entries.length;

      for await (const event of runBatch(
        workerClient,
        runnableEntries,
        structuredClone(sharedSettings),
        sharedProfile,
        sharedLabStyle,
        {
          ...colorManagement,
          outputProfileId: exportOptions.outputProfileId,
          embedOutputProfile: exportOptions.embedOutputProfile,
        },
        sharedLightSourceBias,
        exportOptions,
        resolvedOutputPath,
        cancelTokenRef.current,
        {
          autoCrop: batchAutoCrop,
          autoDustRemoval: batchAutoDustRemoval,
          flareMode: batchFlareMode,
          autoMode: batchAutoMode,
        },
      )) {
        if (event.type === 'done') {
          successCount += 1;
        } else if (event.type === 'error') {
          failureCount += 1;
        } else if (event.type === 'complete') {
          if (notificationSettings.enabled && notificationSettings.batchComplete) {
            await notifyExportFinished({
              kind: 'batch',
              successCount,
              failureCount,
              cancelled: cancelTokenRef.current.cancelled,
            });
          }
        }

        setEntries((current) => current.map((entry) => {
          if ('entryId' in event && entry.id !== event.entryId) {
            return entry;
          }

          switch (event.type) {
            case 'start':
              return { ...entry, status: 'processing', progress: 0.05, errorMessage: undefined };
            case 'progress':
              return { ...entry, progress: event.progress };
            case 'done':
              return { ...entry, status: 'done', progress: 1 };
            case 'error':
              return { ...entry, status: 'error', errorMessage: event.message };
            default:
              return entry;
          }
        }));
      }

      if (
        shouldClearEntriesAfterSuccess
        && !cancelTokenRef.current.cancelled
        && failureCount === 0
        && successCount === runnableEntries.length
      ) {
        setEntries([]);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setIsRunning(false);
    }
  };

  const runnableCount = entries.filter((entry) => !entry.errorMessage).length;
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const finishedCount = entries.filter((entry) => entry.status === 'done' || entry.status === 'error').length;
  const overallProgress = runnableCount > 0
    ? entries.reduce((sum, entry) => sum + (entry.errorMessage && entry.status !== 'error' ? 0 : (entry.status === 'done' ? 1 : entry.progress ?? 0)), 0) / runnableCount
    : 0;
  const startLabel = `Convert ${runnableCount} file${runnableCount === 1 ? '' : 's'}`;
  const isPngOrTiff = exportOptions.format === 'image/png' || exportOptions.format === 'image/tiff';

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="batch-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            key="batch-modal"
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: 'spring', bounce: 0.08, duration: 0.22 }}
            className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6"
          >
            {/* stopPropagation prevents backdrop-click-to-close from firing
               when the user clicks inside the modal. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <div
              ref={modalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="pointer-events-auto flex h-full max-h-[760px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
              onDragOver={(event) => {
                event.preventDefault();
                if (!isRunning) setIsDropTarget(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDropTarget(false);
                if (isRunning) return;
                const files = Array.from(event.dataTransfer.files ?? []) as File[];
                if (files.length > 0) {
                  addFiles(files.map((file) => ({ file })));
                }
              }}
            >
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-zinc-800/80 px-5 py-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent-400/25 bg-accent-400/10 text-accent-300">
                  <Layers size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id={titleId} className="text-[15px] font-semibold text-zinc-100">Convert Files</h2>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    One recipe for many scans, without opening them. Open frames keep their own look in the Export panel.
                  </p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close convert files" className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200">
                  <X size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_340px]">
                {/* Left: files */}
                <div className="flex min-h-0 flex-col">
                  <div className="flex items-center gap-2 px-5 pb-2 pt-4">
                    <h3 className={`${SECTION_TITLE} mb-0`}>
                      <Files size={12} /> Files
                    </h3>
                    {entries.length > 0 && (
                      <span className="rounded-full bg-zinc-900 px-2 py-0.5 font-mono text-[10px] tabular-nums text-zinc-400">
                        {entries.length} · {formatFileSize(totalSize)}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      {entries.length > 0 && !isRunning && (
                        <button type="button" onClick={() => setEntries([])} className={SMALL_BUTTON}>
                          Clear
                        </button>
                      )}
                      {desktopShell && (
                        <button type="button" onClick={() => void handleAddFolder()} disabled={isRunning} className={SMALL_BUTTON}>
                          <FolderOpen size={12} />
                          Add Folder
                        </button>
                      )}
                      <button type="button" onClick={() => void handleAddFiles()} disabled={isRunning} className={SMALL_BUTTON}>
                        <Plus size={12} />
                        Add Files
                      </button>
                    </div>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={`image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff,${RAW_EXTENSIONS.join(',')}`}
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []) as File[];
                      addFiles(files.map((file) => ({ file })));
                      event.target.value = '';
                    }}
                  />

                  <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-4 custom-scrollbar">
                    {entries.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => void handleAddFiles()}
                        className={`flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center transition-colors ${
                          isDropTarget
                            ? 'border-accent-400/70 bg-accent-400/5'
                            : 'border-zinc-800 bg-zinc-900/20 hover:border-zinc-700 hover:bg-zinc-900/40'
                        }`}
                      >
                        <span className={`flex h-12 w-12 items-center justify-center rounded-full border transition-colors ${isDropTarget ? 'border-accent-400/50 text-accent-300' : 'border-zinc-800 bg-zinc-900/60 text-zinc-500'}`}>
                          <Upload size={20} />
                        </span>
                        <span>
                          <span className="block text-sm font-medium text-zinc-300">Drop scans or a folder here</span>
                          <span className="mt-1 block text-xs text-zinc-600">or click to choose files · TIFF, JPEG, PNG, WebP · RAW on desktop</span>
                        </span>
                      </button>
                    ) : (
                      <ul className={`divide-y divide-zinc-900 overflow-hidden rounded-xl border transition-colors ${isDropTarget ? 'border-accent-400/60' : 'border-zinc-800/80'}`}>
                        {entries.map((entry) => {
                          const status = entry.errorMessage && entry.status !== 'processing' ? 'error' : entry.status;
                          return (
                            <li key={entry.id} className="group relative flex items-center gap-3 bg-zinc-900/30 px-3 py-2.5">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-zinc-500">
                                <FileImage size={15} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] font-medium text-zinc-200">{entry.filename}</p>
                                <p className="mt-0.5 truncate text-[11px] text-zinc-600">
                                  {formatFileSize(entry.size)}
                                  <span className="text-zinc-800"> · </span>
                                  {entry.kind === 'open-tab' ? 'Open in app' : 'Added file'}
                                  {entry.errorMessage && <span className="text-red-400"> · {entry.errorMessage}</span>}
                                </p>
                              </div>
                              <span className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${STATUS_STYLE[status].text}`}>
                                {status === 'processing'
                                  ? <Loader2 size={12} className="animate-spin" />
                                  : status === 'done'
                                    ? <CheckCircle2 size={12} />
                                    : status === 'error'
                                      ? <AlertCircle size={12} />
                                      : <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />}
                                {STATUS_STYLE[status].label}
                              </span>
                              <button
                                type="button"
                                aria-label={`Remove ${entry.filename}`}
                                onClick={() => setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}
                                disabled={isRunning}
                                className="shrink-0 rounded-md p-1.5 text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-300 focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
                              >
                                <Trash2 size={12} />
                              </button>
                              {typeof entry.progress === 'number' && entry.status === 'processing' && (
                                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-800">
                                  <span className="block h-full bg-accent-400 transition-[width] duration-300" style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Right: recipe and output */}
                <div className="min-h-0 overflow-y-auto border-t border-zinc-800/80 bg-zinc-900/20 px-5 py-4 custom-scrollbar md:border-l md:border-t-0">
                  <div className="space-y-6">
                    <section>
                      <h3 className={SECTION_TITLE}><StepNumber>1</StepNumber> Recipe</h3>
                      <div role="radiogroup" aria-label="Settings source" className={`${SEGMENT_TRACK} grid-cols-3`}>
                        {([
                          { value: 'current', label: 'This frame', disabled: !currentSettings || !currentProfile },
                          { value: 'builtin', label: 'Built-in', disabled: false },
                          { value: 'custom', label: 'Custom', disabled: customProfiles.length === 0 },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={settingsSource === opt.value}
                            disabled={opt.disabled || isRunning}
                            onClick={() => setSettingsSource(opt.value)}
                            className={segmentItem(settingsSource === opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2.5">
                        {settingsSource === 'current' && currentProfile && (
                          <p className="truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-400">
                            Look of the frame you are editing · <span className="text-zinc-200">{currentProfile.name}</span>
                          </p>
                        )}
                        {settingsSource === 'builtin' && (
                          <select
                            aria-label="Built-in profile"
                            value={selectedProfileId}
                            onChange={(event) => setSelectedProfileId(event.target.value)}
                            className={FIELD_SELECT}
                          >
                            {FILM_PROFILES.map((profile) => (
                              <option key={profile.id} value={profile.id}>{profile.name}</option>
                            ))}
                          </select>
                        )}
                        {settingsSource === 'custom' && (
                          <div className="space-y-2.5">
                            <select
                              aria-label="Custom preset"
                              value={selectedCustomProfileId}
                              onChange={(event) => setSelectedCustomProfileId(event.target.value)}
                              className={FIELD_SELECT}
                            >
                              {customProfiles.map((profile) => (
                                <option key={profile.id} value={profile.id}>{profile.name}</option>
                              ))}
                            </select>
                            {selectedCustomProfileHasEmbeddedTransforms && (
                              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5">
                                <p className="text-xs font-medium text-amber-200">This preset has a saved crop or rotation.</p>
                                <p className="mt-1 text-[11px] leading-5 text-amber-100/80">
                                  Every image will be cropped and rotated the same way.
                                </p>
                                <div className="mt-2">
                                  <CheckOption checked={ignorePresetCropAndRotation} onChange={setIgnorePresetCropAndRotation}>
                                    Ignore preset crop and rotation
                                  </CheckOption>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </section>

                    <section>
                      <h3 className={SECTION_TITLE}><StepNumber>2</StepNumber> Corrections</h3>
                      <div className="space-y-2.5">
                        <CheckOption checked={batchAutoCrop} disabled={isRunning} onChange={setBatchAutoCrop}>
                          Auto-crop each scan after decode
                        </CheckOption>
                        <CheckOption checked={batchAutoDustRemoval} disabled={isRunning} onChange={setBatchAutoDustRemoval}>
                          Auto dust / scratch / hair removal
                        </CheckOption>
                      </div>
                    </section>

                    <section>
                      <h3 className={SECTION_TITLE}><StepNumber>3</StepNumber> Output</h3>
                      <div className="space-y-3.5">
                        <div role="radiogroup" aria-label="Output format" className={`${SEGMENT_TRACK} grid-cols-4`}>
                          {(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'] as const).map((format) => (
                            <button
                              key={format}
                              type="button"
                              role="radio"
                              aria-checked={exportOptions.format === format}
                              disabled={isRunning}
                              onClick={() => setExportOptions((current) => normalizeExportOptions({
                                ...current,
                                format,
                                ...(format === 'image/webp' ? { outputProfileId: 'srgb' as const } : {}),
                              }))}
                              className={`${segmentItem(exportOptions.format === format)} uppercase`}
                            >
                              {format === 'image/jpeg' ? 'jpeg' : format.split('/')[1]}
                            </button>
                          ))}
                        </div>

                        {isPngOrTiff ? (
                          <div className="flex items-center justify-between gap-3">
                            <span className={FIELD_LABEL}>Bit Depth</span>
                            <div role="radiogroup" aria-label="Bit depth" className={`${SEGMENT_TRACK} w-36 grid-cols-2`}>
                              {([8, 16] as const).map((bitDepth) => (
                                <button
                                  key={bitDepth}
                                  type="button"
                                  role="radio"
                                  aria-checked={exportOptions.bitDepth === bitDepth}
                                  onClick={() => setExportOptions((current) => normalizeExportOptions({ ...current, bitDepth }))}
                                  className={segmentItem(exportOptions.bitDepth === bitDepth)}
                                >
                                  {bitDepth}-bit
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <Slider
                            label="Quality"
                            value={Math.round(exportOptions.quality * 100)}
                            min={10}
                            max={100}
                            unit="%"
                            onChange={(value) => setExportOptions((current) => ({ ...current, quality: value / 100 }))}
                          />
                        )}

                        <div>
                          <label className={`${FIELD_LABEL} mb-1.5 block`} htmlFor={`${titleId}-naming`}>Filename</label>
                          <input
                            id={`${titleId}-naming`}
                            type="text"
                            value={exportOptions.filenameBase}
                            onChange={(event) => setExportOptions((current) => ({ ...current, filenameBase: event.target.value }))}
                            className={`${FIELD_SELECT} font-mono`}
                          />
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {['{original}', '{date}', '{index}'].map((token) => (
                              <button
                                key={token}
                                type="button"
                                onClick={() => setExportOptions((current) => ({ ...current, filenameBase: current.filenameBase + token }))}
                                className="rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
                              >
                                + {token}
                              </button>
                            ))}
                          </div>
                        </div>

                        <CheckOption
                          checked={exportOptions.embedMetadata}
                          onChange={(checked) => setExportOptions((current) => ({ ...current, embedMetadata: checked }))}
                        >
                          Embed metadata
                        </CheckOption>

                        <div>
                          <span className={`${FIELD_LABEL} mb-1.5 block`}>Folder</span>
                          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 py-1 pl-2.5 pr-1">
                            <FolderOpen size={13} className="shrink-0 text-zinc-500" />
                            <span className={`min-w-0 flex-1 truncate text-xs ${outputPath ? 'text-zinc-200' : 'text-zinc-500'}`} data-tip={outputPath ?? undefined}>
                              {outputPath ?? (desktopShell ? 'No destination selected.' : 'Browser downloads')}
                            </span>
                            <button type="button" onClick={() => void handleChooseFolder()} className={SMALL_BUTTON}>
                              Choose Folder
                            </button>
                          </div>
                          {desktopShell && (
                            <button
                              type="button"
                              onClick={() => void handleUseDownloads()}
                              className="mt-1.5 text-[11px] text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-300 hover:underline"
                            >
                              Use Downloads
                            </button>
                          )}
                        </div>

                        <div className="rounded-lg border border-zinc-800/80">
                          <button
                            type="button"
                            aria-expanded={colorMgmtExpanded}
                            onClick={() => setColorMgmtExpanded((v) => !v)}
                            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                          >
                            <span>Color management · <span className="text-zinc-500">{getColorProfileDescription(exportOptions.outputProfileId)}</span></span>
                            <ChevronDown size={12} className={`transition-transform duration-150 ${colorMgmtExpanded ? 'rotate-180' : ''}`} />
                          </button>
                          {colorMgmtExpanded && (
                            <div className="space-y-4 border-t border-zinc-800/80 px-3 pb-3 pt-3">
                              <div className="space-y-2">
                                <p className={FIELD_LABEL}>Input Profile</p>
                                <select
                                  value={colorManagement.inputMode}
                                  onChange={(event) => setColorManagement((current) => ({ ...current, inputMode: event.target.value as ColorManagementSettings['inputMode'] }))}
                                  className={FIELD_SELECT}
                                >
                                  <option value="auto">Auto</option>
                                  <option value="override">Manual Override</option>
                                </select>
                                <select
                                  value={colorManagement.inputProfileId}
                                  onChange={(event) => setColorManagement((current) => ({
                                    ...current,
                                    inputMode: 'override',
                                    inputProfileId: event.target.value as ColorProfileId,
                                  }))}
                                  disabled={colorManagement.inputMode === 'auto'}
                                  className={`${FIELD_SELECT} disabled:opacity-50`}
                                >
                                  {(['srgb', 'display-p3', 'adobe-rgb', 'linear'] as ColorProfileId[]).map((profileId) => (
                                    <option key={profileId} value={profileId}>{getColorProfileDescription(profileId)}</option>
                                  ))}
                                </select>
                                <p className="text-[11px] text-zinc-500">Auto uses each file&apos;s embedded or decoder-reported profile.</p>
                              </div>
                              <div className="space-y-2">
                                <p className={FIELD_LABEL}>Output Profile</p>
                                {(['srgb', 'display-p3', 'adobe-rgb', 'linear'] as ColorProfileId[]).map((profileId) => (
                                  <RadioOption
                                    key={profileId}
                                    disabled={exportOptions.format === 'image/webp' && profileId !== 'srgb'}
                                    checked={exportOptions.outputProfileId === profileId}
                                    onChange={() => setExportOptions((current) => ({ ...current, outputProfileId: profileId }))}
                                  >
                                    {getColorProfileDescription(profileId)}
                                  </RadioOption>
                                ))}
                                <CheckOption
                                  checked={exportOptions.embedOutputProfile}
                                  onChange={(checked) => setExportOptions((current) => ({ ...current, embedOutputProfile: checked }))}
                                >
                                  Embed ICC profile
                                </CheckOption>
                                {exportOptions.format === 'image/webp' && (
                                  <p className="text-[11px] text-zinc-500">WebP export is limited to sRGB for now.</p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 border-t border-red-900/40 bg-red-950/20 px-5 py-2.5 text-xs text-red-300">
                  <AlertCircle size={13} className="shrink-0" />
                  {error}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center gap-4 border-t border-zinc-800/80 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  {isRunning ? (
                    <div className="max-w-sm">
                      <div className="mb-1.5 flex justify-between text-[11px] tabular-nums text-zinc-400">
                        <span>Converting {Math.min(finishedCount + 1, runnableCount)} of {runnableCount}</span>
                        <span>{Math.round(overallProgress * 100)}%</span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-accent-400 transition-[width] duration-300" style={{ width: `${Math.round(overallProgress * 100)}%` }} />
                      </div>
                    </div>
                  ) : (
                    <p className="truncate text-[11px] text-zinc-600">
                      {entries.length === 0 ? 'Add scans to start.' : `${runnableCount} ready${entries.length > runnableCount ? `, ${entries.length - runnableCount} skipped` : ''}.`}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (isRunning) {
                      cancelTokenRef.current.cancelled = true;
                    } else {
                      onClose();
                    }
                  }}
                  className="rounded-lg border border-zinc-800 px-4 py-2 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                >
                  {isRunning ? 'Cancel After Current File' : 'Close'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={isRunning || runnableCount === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-[13px] font-semibold text-zinc-950 shadow-lg shadow-black/20 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {isRunning ? 'Converting…' : startLabel}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
