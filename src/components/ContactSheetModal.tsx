import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Download, X } from 'lucide-react';
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
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            key="contact-sheet-modal"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ type: 'spring', bounce: 0.1, duration: 0.25 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none"
          >
            <div
              className="pointer-events-auto flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">Contact Sheet</h2>
                  <p className="text-sm text-zinc-500">Build a proof sheet from the items currently queued in batch export.</p>
                </div>
                <button type="button" onClick={onClose} className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
                  <X size={18} />
                </button>
              </div>

              <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_1fr]">
                <div className="min-h-0 overflow-y-auto border-r border-zinc-800 px-6 py-5">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-zinc-200">Batch Items</h3>
                    <button
                      type="button"
                      onClick={() => setSelectedIds((current) => current.length === entries.length ? [] : entries.map((entry) => entry.id))}
                      className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
                    >
                      {selectedIds.length === entries.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="space-y-3">
                    {entries.map((entry) => (
                      <label key={entry.id} className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-200">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(entry.id)}
                          onChange={(event) => {
                            setSelectedIds((current) => (
                              event.target.checked
                                ? [...current, entry.id]
                                : current.filter((id) => id !== entry.id)
                            ));
                          }}
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{entry.filename}</p>
                          <p className="text-xs text-zinc-500">
                            {entry.kind === 'open-tab' ? 'Open in app' : 'Added file'}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <div className="space-y-6">
              <section className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm text-zinc-300">
                  Columns
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={columns}
                    onChange={(event) => setColumns(Number(event.target.value))}
                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  />
                </label>
                <label className="block text-sm text-zinc-300">
                  Margin
                  <input
                    type="range"
                    min={0}
                    max={64}
                    value={margin}
                    onChange={(event) => setMargin(Number(event.target.value))}
                    className="mt-3 w-full"
                  />
                  <span className="mt-1 block text-xs text-zinc-500">{margin}px</span>
                </label>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Cell Size</h3>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: 'Small', value: 256 },
                    { label: 'Medium', value: 512 },
                    { label: 'Large', value: 1024 },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setCellMaxDimension(option.value)}
                      className={`rounded-xl border px-3 py-2 text-sm ${
                        cellMaxDimension === option.value
                          ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm text-zinc-300">
                  Background
                  <input
                    type="color"
                    value={background}
                    onChange={(event) => setBackground(event.target.value)}
                    className="mt-2 h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900"
                  />
                </label>
                <label className="flex items-center gap-3 pt-8 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={showCaptions}
                    onChange={(event) => setShowCaptions(event.target.checked)}
                  />
                  Show captions
                </label>
              </section>

              {showCaptions && (
                <label className="block text-sm text-zinc-300">
                  Caption font size
                  <input
                    type="range"
                    min={12}
                    max={24}
                    value={captionFontSize}
                    onChange={(event) => setCaptionFontSize(Number(event.target.value))}
                    className="mt-3 w-full"
                  />
                  <span className="mt-1 block text-xs text-zinc-500">{captionFontSize}px</span>
                </label>
              )}

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-200">Export</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(['image/jpeg', 'image/png'] as const).map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setFormat(candidate)}
                      className={`rounded-xl border px-3 py-2 text-sm ${
                        format === candidate
                          ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                      }`}
                    >
                      {candidate.split('/')[1]}
                    </button>
                  ))}
                </div>
                {format === 'image/jpeg' && (
                  <label className="block text-sm text-zinc-300">
                    Quality
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={Math.round(quality * 100)}
                      onChange={(event) => setQuality(Number(event.target.value) / 100)}
                      className="mt-3 w-full"
                    />
                  </label>
                )}
                <label className="block text-sm text-zinc-300">
                  Output filename
                  <input
                    type="text"
                    value={filenameBase}
                    onChange={(event) => setFilenameBase(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  />
                </label>
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input type="checkbox" checked={embedMetadata} onChange={(event) => setEmbedMetadata(event.target.checked)} />
                  Embed metadata
                </label>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Color Profile</p>
                  <label className="flex items-center gap-3 text-sm text-zinc-300">
                    <input type="radio" checked={iccEmbedMode === 'srgb'} onChange={() => setIccEmbedMode('srgb')} />
                    sRGB
                  </label>
                  <label className="flex items-center gap-3 text-sm text-zinc-300">
                    <input type="radio" checked={iccEmbedMode === 'none'} onChange={() => setIccEmbedMode('none')} />
                    None
                  </label>
                </div>
              </section>
                  </div>
                </div>
              </div>

              {error && (
                <div className="border-t border-zinc-800 px-6 py-3 text-sm text-red-300">{error}</div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
                <button type="button" onClick={onClose} className="rounded-xl border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900">
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={isGenerating || selectedEntries.length === 0}
                  className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
                >
                  <Download size={15} />
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
