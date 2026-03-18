import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Download, X } from 'lucide-react';
import { DEFAULT_EXPORT_OPTIONS, MAX_FILE_SIZE_BYTES } from '../constants';
import { ConversionSettings, FilmProfile } from '../types';
import { saveExportBlob } from '../utils/fileBridge';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { BatchJobEntry } from '../utils/batchProcessor';

interface ContactSheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  entries: BatchJobEntry[];
  sharedSettings: ConversionSettings | null;
  sharedProfile: FilmProfile | null;
  workerClient: ImageWorkerClient | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '').trim();
  const safeHex = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized.padEnd(6, '0').slice(0, 6);

  return [
    parseInt(safeHex.slice(0, 2), 16),
    parseInt(safeHex.slice(2, 4), 16),
    parseInt(safeHex.slice(4, 6), 16),
  ];
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

export function ContactSheetModal({
  isOpen,
  onClose,
  entries,
  sharedSettings,
  sharedProfile,
  workerClient,
}: ContactSheetModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(entries.map((entry) => entry.id));
  const [columns, setColumns] = useState(Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(entries.length, 1))))));
  const [cellMaxDimension, setCellMaxDimension] = useState(512);
  const [margin, setMargin] = useState(16);
  const [background, setBackground] = useState('#111111');
  const [showCaptions, setShowCaptions] = useState(true);
  const [captionFontSize, setCaptionFontSize] = useState(14);
  const [format, setFormat] = useState<'image/jpeg' | 'image/png'>('image/jpeg');
  const [quality, setQuality] = useState(0.92);
  const [filenameBase, setFilenameBase] = useState('contact_sheet');
  const [iccEmbedMode, setIccEmbedMode] = useState<'srgb' | 'none'>(DEFAULT_EXPORT_OPTIONS.iccEmbedMode);
  const [embedMetadata, setEmbedMetadata] = useState(DEFAULT_EXPORT_OPTIONS.embedMetadata);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedIds.includes(entry.id)),
    [entries, selectedIds],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSelectedIds(entries.map((entry) => entry.id));
    setColumns(Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(entries.length, 1))))));
  }, [entries, isOpen]);

  const handleGenerate = async () => {
    if (!workerClient || selectedEntries.length === 0) {
      setError('Select at least one batch item before generating the sheet.');
      return;
    }

    if (!sharedSettings || !sharedProfile) {
      setError('Choose a batch settings source before generating the sheet.');
      return;
    }

    const tempDocumentIds: string[] = [];

    setIsGenerating(true);
    setError(null);

    try {
      const cells: Array<{ documentId: string; label: string }> = [];

      for (const entry of selectedEntries) {
        if (entry.kind === 'open-tab') {
          cells.push({
            documentId: entry.documentId ?? entry.id,
            label: entry.filename,
          });
          continue;
        }

        if (!entry.file) {
          throw new Error(`Missing file for "${entry.filename}".`);
        }

        if (entry.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`"${entry.filename}" exceeds the supported file size limit.`);
        }

        const tempDocumentId = `contact-sheet-${entry.id}`;
        const buffer = await entry.file.arrayBuffer();
        await workerClient.decode({
          documentId: tempDocumentId,
          buffer,
          fileName: entry.filename,
          mime: entry.file.type || 'application/octet-stream',
          size: entry.file.size,
        });

        tempDocumentIds.push(tempDocumentId);
        cells.push({
          documentId: tempDocumentId,
          label: entry.filename,
        });
      }

      const result = await workerClient.contactSheet({
        cells,
        columns,
        cellMaxDimension,
        margin,
        backgroundColor: hexToRgb(background),
        showCaptions,
        captionFontSize,
        exportOptions: {
          format,
          quality,
          filenameBase,
          embedMetadata,
          iccEmbedMode,
        },
        settingsPerCell: cells.map(() => structuredClone(sharedSettings)),
        profilePerCell: cells.map(() => structuredClone(sharedProfile)),
      });

      await saveExportBlob(result.blob, result.filename, format);
      onClose();
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      await Promise.all(tempDocumentIds.map(async (documentId) => {
        try {
          await workerClient.disposeDocument(documentId);
        } catch {
          // Ignore cleanup races.
        }
      }));
      setIsGenerating(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="contact-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            key="contact-sheet-modal"
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: 'spring', bounce: 0.08, duration: 0.22 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none"
          >
            <div
              className="pointer-events-auto flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-4">
                <div>
                  <h2 className="text-base font-semibold text-zinc-100">Contact Sheet</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">Build a proof sheet from the items currently queued in batch export.</p>
                </div>
                <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-300">
                  <X size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_1fr]">
                {/* Left: item list */}
                <div className="min-h-0 overflow-y-auto border-r border-zinc-800/80 px-5 py-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Batch Items</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedIds((current) => current.length === entries.length ? [] : entries.map((entry) => entry.id))}
                      className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 transition-colors hover:text-zinc-300"
                    >
                      {selectedIds.length === entries.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {entries.map((entry) => {
                      const isChecked = selectedIds.includes(entry.id);
                      return (
                        <label
                          key={entry.id}
                          className="flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-3.5 py-3 transition-colors hover:border-zinc-700/80 hover:bg-zinc-900/60"
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={isChecked}
                            onChange={(event) => {
                              setSelectedIds((current) => (
                                event.target.checked
                                  ? [...current, entry.id]
                                  : current.filter((id) => id !== entry.id)
                              ));
                            }}
                          />
                          <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                            isChecked ? 'border-zinc-100 bg-zinc-100' : 'border-zinc-600'
                          }`}>
                            {isChecked && <Check size={10} className="text-zinc-950" strokeWidth={3} />}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-zinc-200">{entry.filename}</p>
                            <p className="text-xs text-zinc-600">
                              {entry.kind === 'open-tab' ? 'Open in app' : 'Added file'}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Right: layout & export settings */}
                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <div className="space-y-5">

                    {/* Layout */}
                    <section className="space-y-4">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Layout</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="mb-1.5 text-xs text-zinc-400">Columns</p>
                          <input
                            type="number"
                            min={1}
                            max={8}
                            value={columns}
                            onChange={(event) => setColumns(Number(event.target.value))}
                            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-xs text-zinc-400">Margin</p>
                            <span className="text-xs tabular-nums text-zinc-600">{margin}px</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={64}
                            value={margin}
                            onChange={(event) => setMargin(Number(event.target.value))}
                            className="mt-2 w-full"
                          />
                        </div>
                      </div>
                    </section>

                    <div className="border-t border-zinc-800/80" />

                    {/* Cell Size */}
                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Cell Size</h3>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { label: 'Small', value: 256 },
                          { label: 'Medium', value: 512 },
                          { label: 'Large', value: 1024 },
                        ].map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setCellMaxDimension(option.value)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                              cellMaxDimension === option.value
                                ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                                : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </section>

                    <div className="border-t border-zinc-800/80" />

                    {/* Appearance */}
                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Appearance</h3>
                      <div className="flex items-center gap-4">
                        <div className="flex-1">
                          <p className="mb-1.5 text-xs text-zinc-400">Background</p>
                          <div className="relative">
                            <div className="h-9 w-full overflow-hidden rounded-lg border border-zinc-800">
                              <input
                                type="color"
                                value={background}
                                onChange={(event) => setBackground(event.target.value)}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                              <div className="h-full w-full" style={{ backgroundColor: background }} />
                            </div>
                          </div>
                        </div>
                        <div className="flex-1 pt-6">
                          <CheckOption
                            checked={showCaptions}
                            onChange={setShowCaptions}
                          >
                            Show captions
                          </CheckOption>
                        </div>
                      </div>
                      {showCaptions && (
                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-xs text-zinc-400">Caption font size</p>
                            <span className="text-xs tabular-nums text-zinc-600">{captionFontSize}px</span>
                          </div>
                          <input
                            type="range"
                            min={12}
                            max={24}
                            value={captionFontSize}
                            onChange={(event) => setCaptionFontSize(Number(event.target.value))}
                            className="w-full"
                          />
                        </div>
                      )}
                    </section>

                    <div className="border-t border-zinc-800/80" />

                    {/* Export */}
                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Export</h3>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(['image/jpeg', 'image/png'] as const).map((candidate) => (
                          <button
                            key={candidate}
                            type="button"
                            onClick={() => setFormat(candidate)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                              format === candidate
                                ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                                : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                            }`}
                          >
                            {candidate.split('/')[1]}
                          </button>
                        ))}
                      </div>
                      {format === 'image/jpeg' && (
                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-xs text-zinc-400">Quality</p>
                            <span className="text-xs tabular-nums text-zinc-600">{Math.round(quality * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min={10}
                            max={100}
                            value={Math.round(quality * 100)}
                            onChange={(event) => setQuality(Number(event.target.value) / 100)}
                            className="w-full"
                          />
                        </div>
                      )}
                      <div>
                        <p className="mb-1.5 text-xs text-zinc-400">Output filename</p>
                        <input
                          type="text"
                          value={filenameBase}
                          onChange={(event) => setFilenameBase(event.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                        />
                      </div>
                      <CheckOption
                        checked={embedMetadata}
                        onChange={setEmbedMetadata}
                      >
                        Embed metadata
                      </CheckOption>
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Color Profile</p>
                        <div className="flex gap-4">
                          {(['srgb', 'none'] as const).map((mode) => (
                            <label key={mode} className="flex cursor-pointer items-center gap-2.5 text-sm">
                              <input
                                type="radio"
                                className="sr-only"
                                checked={iccEmbedMode === mode}
                                onChange={() => setIccEmbedMode(mode)}
                              />
                              <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors ${
                                iccEmbedMode === mode ? 'border-zinc-100' : 'border-zinc-600'
                              }`}>
                                {iccEmbedMode === mode && <span className="h-[5px] w-[5px] rounded-full bg-zinc-100" />}
                              </span>
                              <span className="text-zinc-300">{mode === 'srgb' ? 'sRGB' : 'None'}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </section>

                  </div>
                </div>
              </div>

              {error && (
                <div className="border-t border-zinc-800/80 px-6 py-3 text-xs text-red-400">{error}</div>
              )}

              <div className="flex items-center justify-end gap-2.5 border-t border-zinc-800/80 px-6 py-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={isGenerating || selectedEntries.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-50"
                >
                  <Download size={14} />
                  {isGenerating ? 'Generating…' : 'Generate Sheet'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
