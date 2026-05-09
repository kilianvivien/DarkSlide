import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Download, FolderOpen, LayoutGrid, Plus, Trash2, X } from 'lucide-react';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, LAB_STYLE_PROFILES_MAP, MAX_FILE_SIZE_BYTES, RAW_EXTENSIONS } from '../constants';
import { ColorManagementSettings, ColorProfileId, ConversionSettings, DocumentTab, ExportOptions, FilmProfile, LabStyleProfile, LightSourceProfile, NotificationSettings } from '../types';
import { getDesktopDownloadsDirectory, isDesktopShell, openDirectory, openImageFolder, openMultipleImageFiles } from '../utils/fileBridge';
import { BatchJobEntry, runBatch } from '../utils/batchProcessor';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { customProfileHasEmbeddedCropOrRotation, getBatchEffectiveSettings } from '../utils/batchSettings';
import { notifyExportFinished, primeExportNotificationsPermission } from '../utils/exportNotifications';
import { useFocusTrap } from '../hooks/useFocusTrap';

type SettingsSourceMode = 'current' | 'builtin' | 'custom';

interface BatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenContactSheet: (payload: {
    entries: BatchJobEntry[];
    sharedSettings: ConversionSettings;
    sharedProfile: FilmProfile;
    sharedLabStyle: LabStyleProfile | null;
    sharedColorManagement: ColorManagementSettings;
    sharedLightSourceBias: [number, number, number] | null;
  }) => void;
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
    <label className={`flex items-center gap-3 text-sm ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
      <input type="radio" className="sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors ${
        checked ? 'border-zinc-100' : 'border-zinc-600'
      }`}>
        {checked && <span className="h-[5px] w-[5px] rounded-full bg-zinc-100" />}
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
    <label className={`flex items-center gap-3 text-sm ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked ? 'border-zinc-100 bg-zinc-100' : 'border-zinc-600'
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
  onOpenContactSheet,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const cancelTokenRef = useRef({ cancelled: false });
  const desktopShell = isDesktopShell();

  useFocusTrap(modalRef, isOpen);

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

    setExportOptions((current) => ({ ...current, outputProfileId: 'srgb' }));
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
  const canOpenContactSheet = entries.length > 0 && Boolean(sharedSettings && sharedProfile);

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
            className="fixed inset-0 z-50 flex items-stretch justify-center p-6 pointer-events-none"
          >
            <div
              ref={modalRef}
              className="pointer-events-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const files = Array.from(event.dataTransfer.files ?? []) as File[];
                if (files.length > 0) {
                  addFiles(files.map((file) => ({ file })));
                }
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">Batch Export</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">Process multiple scans sequentially with one shared export recipe. RAW files supported on desktop.</p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close batch export" className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-300">
                  <X size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[1.3fr_1fr]">
                {/* Left: file list */}
                <div className="flex min-h-0 flex-col border-r border-zinc-800/80">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Files</h3>
                    <div className="flex items-center gap-2">
                      {desktopShell && (
                        <button
                          type="button"
                          onClick={() => void handleAddFolder()}
                          disabled={isRunning}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-100 disabled:opacity-50"
                        >
                          <FolderOpen size={12} />
                          Add Folder
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleAddFiles()}
                        disabled={isRunning}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-100 disabled:opacity-50"
                      >
                        <Plus size={12} />
                        Add Files
                      </button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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

                    <div className="space-y-2">
                      {entries.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-700/50 bg-zinc-900/20 p-10 text-center">
                          <div className="rounded-full border border-zinc-800 bg-zinc-900/60 p-3">
                            <FolderOpen size={20} className="text-zinc-600" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-zinc-500">Drop scans here</p>
                            <p className="mt-1 text-xs text-zinc-700">TIFF, JPEG, PNG, WebP · RAW on desktop</p>
                          </div>
                        </div>
                      ) : entries.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-zinc-100">{entry.filename}</p>
                              <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-600">
                                <span>{formatFileSize(entry.size)}</span>
                                <span className="text-zinc-800">·</span>
                                <span>{entry.kind === 'open-tab' ? 'Open in app' : 'Added file'}</span>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                                entry.status === 'done'
                                  ? 'bg-emerald-500/12 text-emerald-400'
                                  : entry.status === 'error'
                                    ? 'bg-red-500/12 text-red-400'
                                    : entry.status === 'processing'
                                      ? 'bg-amber-500/12 text-amber-400'
                                      : 'bg-zinc-800/80 text-zinc-500'
                              }`}
                              >
                                {entry.status}
                              </span>
                              <button
                                type="button"
                                onClick={() => setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}
                                disabled={isRunning}
                                className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                          {typeof entry.progress === 'number' && (
                            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-zinc-800">
                              <div className="h-full rounded-full bg-zinc-300 transition-all duration-300" style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                            </div>
                          )}
                          {entry.errorMessage && (
                            <p className="mt-2 text-xs text-red-400">{entry.errorMessage}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Right: settings */}
                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <div className="space-y-6">

                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Settings Source</h3>
                      <div className="grid grid-cols-3 gap-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
                        {([
                          { value: 'current', label: 'Current Doc', disabled: !currentSettings || !currentProfile },
                          { value: 'builtin', label: 'Built-in', disabled: false },
                          { value: 'custom', label: 'Custom', disabled: customProfiles.length === 0 },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            disabled={opt.disabled}
                            onClick={() => setSettingsSource(opt.value)}
                            className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                              settingsSource === opt.value
                                ? 'bg-zinc-100 text-zinc-950'
                                : opt.disabled
                                  ? 'cursor-not-allowed text-zinc-700'
                                  : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {settingsSource === 'builtin' && (
                        <select
                          value={selectedProfileId}
                          onChange={(event) => setSelectedProfileId(event.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                        >
                          {FILM_PROFILES.map((profile) => (
                            <option key={profile.id} value={profile.id}>{profile.name}</option>
                          ))}
                        </select>
                      )}
                      {settingsSource === 'custom' && (
                        <div className="space-y-3">
                          <select
                            value={selectedCustomProfileId}
                            onChange={(event) => setSelectedCustomProfileId(event.target.value)}
                            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                          >
                            {customProfiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>{profile.name}</option>
                            ))}
                          </select>
                          {selectedCustomProfileHasEmbeddedTransforms && (
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
                              <p className="text-xs font-medium text-amber-200">This preset has a saved crop or rotation.</p>
                              <p className="mt-1 text-[11px] leading-5 text-amber-100/80">
                                Every image will be cropped and rotated the same way. Tick the box below to skip this and keep each image as-is.
                              </p>
                              <div className="mt-3">
                                <CheckOption
                                  checked={ignorePresetCropAndRotation}
                                  onChange={setIgnorePresetCropAndRotation}
                                >
                                  Ignore preset crop and rotation
                                </CheckOption>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </section>

                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Scanning Corrections</h3>
                      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                        <CheckOption checked={batchAutoCrop} disabled={isRunning} onChange={setBatchAutoCrop}>
                          Auto-crop each scan after decode
                        </CheckOption>
                        <CheckOption checked={batchAutoDustRemoval} disabled={isRunning} onChange={setBatchAutoDustRemoval}>
                          Auto dust / scratch / hair removal
                        </CheckOption>
                      </div>
                    </section>

                    <div className="border-t border-zinc-800/80" />

                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Export Options</h3>
                      <div className="grid grid-cols-3 gap-1.5">
                      {(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'] as const).map((format) => (
                          <button
                            key={format}
                            type="button"
                            onClick={() => setExportOptions((current) => ({
                              ...current,
                              format,
                              ...(format === 'image/webp' ? { outputProfileId: 'srgb' as const } : {}),
                            }))}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                              exportOptions.format === format
                                ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                                : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                            }`}
                          >
                            {format.split('/')[1]}
                          </button>
                        ))}
                      </div>
                      {exportOptions.format !== 'image/png' && exportOptions.format !== 'image/tiff' && (
                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-zinc-400">Quality</span>
                            <span className="text-xs tabular-nums text-zinc-500">{Math.round(exportOptions.quality * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min={10}
                            max={100}
                            value={Math.round(exportOptions.quality * 100)}
                            onChange={(event) => setExportOptions((current) => ({ ...current, quality: Number(event.target.value) / 100 }))}
                            className="w-full"
                          />
                        </div>
                      )}
                      <div>
                        <p className="mb-1.5 text-xs text-zinc-400">Output naming</p>
                        <input
                          type="text"
                          value={exportOptions.filenameBase}
                          onChange={(event) => setExportOptions((current) => ({ ...current, filenameBase: event.target.value }))}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {['{original}', '{date}', '{index}'].map((token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() => setExportOptions((current) => ({ ...current, filenameBase: current.filenameBase + token }))}
                              className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[10px] text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
                            >
                              {token}
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
                      <div className="rounded-xl border border-zinc-800/60">
                        <button
                          type="button"
                          onClick={() => setColorMgmtExpanded((v) => !v)}
                          className="flex w-full items-center justify-between px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600 transition-colors hover:text-zinc-400"
                        >
                          <span>Color Management</span>
                          <ChevronDown size={12} className={`transition-transform duration-150 ${colorMgmtExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        {colorMgmtExpanded && (
                          <div className="space-y-4 border-t border-zinc-800/60 px-3.5 pb-3.5 pt-3">
                            <div className="space-y-2">
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Input Profile</p>
                              <select
                                value={colorManagement.inputMode}
                                onChange={(event) => setColorManagement((current) => ({ ...current, inputMode: event.target.value as ColorManagementSettings['inputMode'] }))}
                                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
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
                                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
                              >
                                {(['srgb', 'display-p3', 'adobe-rgb'] as ColorProfileId[]).map((profileId) => (
                                  <option key={profileId} value={profileId}>{getColorProfileDescription(profileId)}</option>
                                ))}
                              </select>
                              <p className="text-[11px] text-zinc-500">Auto uses each file&apos;s embedded or decoder-reported profile.</p>
                            </div>
                            <div className="space-y-2">
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Output Profile</p>
                              <div className="space-y-2">
                                {(['srgb', 'display-p3', 'adobe-rgb'] as ColorProfileId[]).map((profileId) => (
                                  <React.Fragment key={profileId}>
                                    <RadioOption
                                      disabled={exportOptions.format === 'image/webp' && profileId !== 'srgb'}
                                      checked={exportOptions.outputProfileId === profileId}
                                      onChange={() => setExportOptions((current) => ({ ...current, outputProfileId: profileId }))}
                                    >
                                      {getColorProfileDescription(profileId)}
                                    </RadioOption>
                                  </React.Fragment>
                                ))}
                              </div>
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
                    </section>

                    <div className="border-t border-zinc-800/80" />

                    <section className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Output Folder</h3>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void handleChooseFolder()}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
                          >
                            <FolderOpen size={12} />
                            Choose Folder
                          </button>
                          {desktopShell && (
                            <button
                              type="button"
                              onClick={() => void handleUseDownloads()}
                              className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
                            >
                              Use Downloads
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-500">
                        {desktopShell
                          ? 'Desktop batch export needs a destination before processing starts. Choose a folder or use Downloads.'
                          : 'Choose a folder to save directly there, or leave it empty to use your browser download flow.'}
                      </p>
                      <p className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
                        {outputPath ?? (desktopShell ? 'No destination selected.' : 'Browser download flow will be used if no folder is chosen.')}
                      </p>
                    </section>

                  </div>
                </div>
              </div>

              {error && (
                <div className="border-t border-zinc-800/80 px-6 py-3 text-xs text-red-400">{error}</div>
              )}

              <div className="flex items-center justify-between gap-2.5 border-t border-zinc-800/80 px-6 py-4">
                <button
                  type="button"
                  onClick={() => {
                    if (!sharedSettings || !sharedProfile) {
                      setError('Choose a settings source before opening the contact sheet.');
                      return;
                    }

                    onOpenContactSheet({
                      entries,
                      sharedSettings: structuredClone(sharedSettings),
                      sharedProfile,
                      sharedLabStyle,
                      sharedColorManagement: {
                        ...colorManagement,
                        outputProfileId: exportOptions.outputProfileId,
                        embedOutputProfile: exportOptions.embedOutputProfile,
                      },
                      sharedLightSourceBias,
                    });
                  }}
                  disabled={!canOpenContactSheet || isRunning}
                  title={canOpenContactSheet ? 'Create a contact sheet from the current batch list' : 'Add batch items and choose a settings source first'}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <LayoutGrid size={13} />
                  Contact Sheet…
                </button>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (isRunning) {
                        cancelTokenRef.current.cancelled = true;
                      } else {
                        onClose();
                      }
                    }}
                    className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    {isRunning ? 'Cancel After Current File' : 'Close'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleStart()}
                    disabled={isRunning}
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-50"
                  >
                    <Download size={14} />
                    {isRunning ? 'Processing…' : 'Start Batch'}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
