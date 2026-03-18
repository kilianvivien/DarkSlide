import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Download, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, MAX_FILE_SIZE_BYTES } from '../constants';
import { ConversionSettings, DocumentTab, ExportOptions, FilmProfile } from '../types';
import { openDirectory, openMultipleImageFiles } from '../utils/fileBridge';
import { BatchJobEntry, runBatch } from '../utils/batchProcessor';
import { ImageWorkerClient } from '../utils/imageWorkerClient';

type SettingsSourceMode = 'current' | 'builtin' | 'custom';

interface BatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenContactSheet: (payload: {
    entries: BatchJobEntry[];
    sharedSettings: ConversionSettings;
    sharedProfile: FilmProfile;
  }) => void;
  workerClient: ImageWorkerClient | null;
  currentSettings: ConversionSettings | null;
  currentProfile: FilmProfile | null;
  customProfiles: FilmProfile[];
  openTabs: DocumentTab[];
}

function formatFileSize(size: number) {
  if (size > 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function BatchModal({
  isOpen,
  onClose,
  onOpenContactSheet,
  workerClient,
  currentSettings,
  currentProfile,
  customProfiles,
  openTabs,
}: BatchModalProps) {
  const [entries, setEntries] = useState<BatchJobEntry[]>([]);
  const [settingsSource, setSettingsSource] = useState<SettingsSourceMode>(currentSettings && currentProfile ? 'current' : 'builtin');
  const [selectedProfileId, setSelectedProfileId] = useState(FILM_PROFILES[0]?.id ?? 'generic-color');
  const [selectedCustomProfileId, setSelectedCustomProfileId] = useState(customProfiles[0]?.id ?? '');
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    filenameBase: '{original}_darkslide',
  });
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelTokenRef = useRef({ cancelled: false });

  const selectedBuiltinProfile = useMemo(
    () => FILM_PROFILES.find((profile) => profile.id === selectedProfileId) ?? FILM_PROFILES[0],
    [selectedProfileId],
  );
  const selectedCustomProfile = useMemo(
    () => customProfiles.find((profile) => profile.id === selectedCustomProfileId) ?? customProfiles[0] ?? null,
    [customProfiles, selectedCustomProfileId],
  );
  const openTabsSignature = useMemo(
    () => openTabs.map((tab) => tab.id).join('|'),
    [openTabs],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSettingsSource(currentSettings && currentProfile ? 'current' : 'builtin');
  }, [currentProfile, currentSettings, isOpen]);

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
        filename: tab.document.source.name,
        size: tab.document.source.size,
        status: existingEntry?.status ?? 'pending',
        errorMessage: existingEntry?.errorMessage,
        progress: existingEntry?.progress,
        };
      });

      return [...nextOpenEntries, ...fileEntries];
    });
  }, [isOpen, openTabsSignature]);

  if (!isOpen) {
    return (
      <AnimatePresence>
        {false && null}
      </AnimatePresence>
    );
  }

  const addFiles = (files: File[]) => {
    const nextEntries = files.map((file) => ({
      id: crypto.randomUUID(),
      kind: 'file' as const,
      file,
      filename: file.name,
      size: file.size,
      status: 'pending' as const,
      errorMessage: file.size > MAX_FILE_SIZE_BYTES
        ? `File exceeds ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`
        : undefined,
    }));

    setEntries((current) => [...current, ...nextEntries]);
  };

  const handleAddFiles = async () => {
    try {
      const nativeFiles = await openMultipleImageFiles();
      if (nativeFiles.length > 0) {
        addFiles(nativeFiles.map((entry) => entry.file));
        return;
      }

      fileInputRef.current?.click();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await openDirectory();
      if (selected) {
        setOutputPath(selected);
      }
    } catch (folderError) {
      setError(folderError instanceof Error ? folderError.message : String(folderError));
    }
  };

  const sharedProfile = settingsSource === 'current'
    ? currentProfile
    : (settingsSource === 'builtin' ? selectedBuiltinProfile : selectedCustomProfile);
  const sharedSettings = settingsSource === 'current'
    ? currentSettings
    : sharedProfile?.defaultSettings ?? null;
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

    cancelTokenRef.current = { cancelled: false };
    setIsRunning(true);
    setError(null);
    setEntries((current) => current.map((entry) => ({
      ...entry,
      status: entry.errorMessage ? 'error' : 'pending',
      progress: entry.errorMessage ? undefined : 0,
    })));

    try {
      for await (const event of runBatch(
        workerClient,
        runnableEntries,
        structuredClone(sharedSettings),
        sharedProfile,
        exportOptions,
        outputPath,
        cancelTokenRef.current,
      )) {
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
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            key="batch-modal"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ type: 'spring', bounce: 0.1, duration: 0.25 }}
            className="fixed inset-0 z-50 flex items-stretch justify-center p-6 pointer-events-none"
          >
            <div
              className="pointer-events-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const files = Array.from(event.dataTransfer.files ?? []) as File[];
                if (files.length > 0) {
                  addFiles(files);
                }
              }}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">Batch Export</h2>
                  <p className="text-sm text-zinc-500">Process multiple scans sequentially with one shared export recipe.</p>
                </div>
                <div className="flex items-center gap-2">
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
                      });
                    }}
                    disabled={!canOpenContactSheet || isRunning}
                    title={canOpenContactSheet ? 'Create a contact sheet from the current batch list' : 'Add batch items and choose a settings source first'}
                    className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Contact Sheet…
                  </button>
                  <button type="button" onClick={onClose} className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[1.3fr_1fr]">
                <div className="flex min-h-0 flex-col border-r border-zinc-800">
                  <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
                    <h3 className="text-sm font-semibold text-zinc-200">Files</h3>
                    <button
                      type="button"
                      onClick={() => void handleAddFiles()}
                      disabled={isRunning}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <Plus size={15} />
                      Add Files
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []) as File[];
                        addFiles(files);
                        event.target.value = '';
                      }}
                    />

              <div className="space-y-3">
                {entries.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">
                    Add TIFF, JPEG, PNG, or WebP files, or drop them here.
                  </div>
                ) : entries.map((entry) => (
                  <div key={entry.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-100">{entry.filename}</p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                          <span>{formatFileSize(entry.size)}</span>
                          <span className="text-zinc-700">•</span>
                          <span>{entry.kind === 'open-tab' ? 'Open in app' : 'Added file'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                          entry.status === 'done'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : entry.status === 'error'
                              ? 'bg-red-500/15 text-red-300'
                              : entry.status === 'processing'
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-zinc-800 text-zinc-400'
                        }`}
                        >
                          {entry.status}
                        </span>
                        <button
                          type="button"
                          onClick={() => setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}
                          disabled={isRunning}
                          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {typeof entry.progress === 'number' && (
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-zinc-100" style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                      </div>
                    )}
                    {entry.errorMessage && (
                      <p className="mt-3 text-xs text-red-300">{entry.errorMessage}</p>
                    )}
                  </div>
                ))}
              </div>
                  </div>
                </div>

                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <div className="space-y-6">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Settings Source</h3>
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input
                    type="radio"
                    checked={settingsSource === 'current'}
                    disabled={!currentSettings || !currentProfile}
                    onChange={() => setSettingsSource('current')}
                  />
                  Use current document settings
                </label>
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input type="radio" checked={settingsSource === 'builtin'} onChange={() => setSettingsSource('builtin')} />
                  Use built-in profile
                </label>
                {settingsSource === 'builtin' && (
                  <select
                    value={selectedProfileId}
                    onChange={(event) => setSelectedProfileId(event.target.value)}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  >
                    {FILM_PROFILES.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                )}
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input
                    type="radio"
                    checked={settingsSource === 'custom'}
                    disabled={customProfiles.length === 0}
                    onChange={() => setSettingsSource('custom')}
                  />
                  Use custom profile
                </label>
                {settingsSource === 'custom' && (
                  <select
                    value={selectedCustomProfileId}
                    onChange={(event) => setSelectedCustomProfileId(event.target.value)}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  >
                    {customProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                )}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Export Options</h3>
                <div className="grid grid-cols-3 gap-2">
                  {(['image/jpeg', 'image/png', 'image/webp'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => setExportOptions((current) => ({ ...current, format }))}
                      className={`rounded-xl border px-3 py-2 text-xs font-semibold uppercase ${
                        exportOptions.format === format
                          ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                      }`}
                    >
                      {format.split('/')[1]}
                    </button>
                  ))}
                </div>
                {exportOptions.format !== 'image/png' && (
                  <label className="block text-sm text-zinc-300">
                    Quality
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={Math.round(exportOptions.quality * 100)}
                      onChange={(event) => setExportOptions((current) => ({ ...current, quality: Number(event.target.value) / 100 }))}
                      className="mt-2 w-full"
                    />
                  </label>
                )}
                <label className="block text-sm text-zinc-300">
                  Output naming
                  <input
                    type="text"
                    value={exportOptions.filenameBase}
                    onChange={(event) => setExportOptions((current) => ({ ...current, filenameBase: event.target.value }))}
                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  />
                </label>
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={exportOptions.embedMetadata}
                    onChange={(event) => setExportOptions((current) => ({ ...current, embedMetadata: event.target.checked }))}
                  />
                  Embed metadata
                </label>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Color Profile</p>
                  <label className="flex items-center gap-3 text-sm text-zinc-300">
                    <input
                      type="radio"
                      checked={exportOptions.iccEmbedMode === 'srgb'}
                      onChange={() => setExportOptions((current) => ({ ...current, iccEmbedMode: 'srgb' }))}
                    />
                    sRGB
                  </label>
                  <label className="flex items-center gap-3 text-sm text-zinc-300">
                    <input
                      type="radio"
                      checked={exportOptions.iccEmbedMode === 'none'}
                      onChange={() => setExportOptions((current) => ({ ...current, iccEmbedMode: 'none' }))}
                    />
                    None
                  </label>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-200">Output Folder</h3>
                  <button
                    type="button"
                    onClick={() => void handleChooseFolder()}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    <FolderOpen size={15} />
                    Choose Folder
                  </button>
                </div>
                <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-400">
                  {outputPath ?? 'Browser download flow will be used if no folder is chosen.'}
                </p>
              </section>
                  </div>
                </div>
              </div>

              {error && (
                <div className="border-t border-zinc-800 px-6 py-3 text-sm text-red-300">{error}</div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
                <button
                  type="button"
                  onClick={() => {
                    if (isRunning) {
                      cancelTokenRef.current.cancelled = true;
                    } else {
                      onClose();
                    }
                  }}
                  className="rounded-xl border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
                >
                  {isRunning ? 'Cancel After Current File' : 'Close'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={isRunning}
                  className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
                >
                  <Download size={15} />
                  {isRunning ? 'Processing…' : 'Start Batch'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
