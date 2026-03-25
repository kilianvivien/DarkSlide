import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { Roll, WorkspaceDocument } from '../types';

type RollInfoModalProps = {
  isOpen: boolean;
  roll: Roll | null;
  activeDocument: WorkspaceDocument | null;
  frameCount: number;
  onClose: () => void;
  onSave: (rollId: string, updates: Partial<Roll>) => void;
  onSyncSettings: (rollId: string) => void;
  onApplyFilmBase: (rollId: string) => void;
};

export function RollInfoModal({
  isOpen,
  roll,
  activeDocument,
  frameCount,
  onClose,
  onSave,
  onSyncSettings,
  onApplyFilmBase,
}: RollInfoModalProps) {
  const [draft, setDraft] = useState<Partial<Roll>>({});

  useEffect(() => {
    if (!roll) {
      setDraft({});
      return;
    }

    setDraft({
      name: roll.name,
      filmStock: roll.filmStock,
      camera: roll.camera,
      date: roll.date,
      notes: roll.notes,
    });
  }, [roll]);

  return (
    <AnimatePresence>
      {isOpen && roll && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
          >
            <div
              className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Roll Info</h2>
                  <p className="mt-1 text-xs text-zinc-500">{frameCount} frame{frameCount === 1 ? '' : 's'} in this roll</p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Close roll info"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Name</span>
                  <input
                    value={draft.name ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Film Stock</span>
                  <input
                    value={draft.filmStock ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, filmStock: event.target.value || null }))}
                    placeholder="Portra 400"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Camera</span>
                  <input
                    value={draft.camera ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, camera: event.target.value || null }))}
                    placeholder="Nikon F3"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Date</span>
                  <input
                    type="date"
                    value={draft.date ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value || null }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Notes</span>
                  <textarea
                    value={draft.notes ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                    rows={5}
                    className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSyncSettings(roll.id)}
                    className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    Sync To Roll
                  </button>
                  <button
                    type="button"
                    disabled={!activeDocument?.settings.filmBaseSample}
                    onClick={() => onApplyFilmBase(roll.id)}
                    className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply Film Base To Roll
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onSave(roll.id, draft)}
                  className="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
                >
                  Save Roll Metadata
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
