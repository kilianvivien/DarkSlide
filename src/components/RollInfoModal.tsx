import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Trash2, X } from 'lucide-react';
import { FILM_PROFILES } from '../constants';
import { Roll } from '../types';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useModalA11y } from '../hooks/useModalA11y';

type RollInfoModalProps = {
  isOpen: boolean;
  roll: Roll | null;
  frameCount: number;
  onClose: () => void;
  onSave: (rollId: string, updates: Partial<Roll>) => void;
  onSyncSettings: (rollId: string) => void;
  onDeleteRoll: (rollId: string) => void;
};

export function RollInfoModal({
  isOpen,
  roll,
  frameCount,
  onClose,
  onSave,
  onSyncSettings,
  onDeleteRoll,
}: RollInfoModalProps) {
  const [draft, setDraft] = useState<Partial<Roll>>({});
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, isOpen && roll !== null);
  const { titleId } = useModalA11y(isOpen && roll !== null, onClose);

  const filmStockSuggestions = useMemo(
    () => [...new Set(FILM_PROFILES.map((p) => p.name))].sort((a, b) => a.localeCompare(b)),
    [],
  );

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
            {/* stopPropagation prevents backdrop-click-to-close from firing
               when the user clicks inside the modal. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <div
              ref={modalRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
                <div>
                  <h2 id={titleId} className="text-sm font-semibold text-zinc-100">Roll Info</h2>
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
                    list="roll-film-stock-suggestions"
                    value={draft.filmStock ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, filmStock: event.target.value || null }))}
                    placeholder="Portra 400"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
                  />
                  <datalist id="roll-film-stock-suggestions">
                    {filmStockSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
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
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSyncSettings(roll.id)}
                    className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    Sync To Roll
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteRoll(roll.id)}
                    className="rounded-xl border border-red-900/50 bg-zinc-900 px-3 py-2 text-sm text-red-400 transition-colors hover:border-red-800 hover:bg-red-950/30"
                    aria-label="Delete roll"
                  >
                    <Trash2 size={14} />
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
