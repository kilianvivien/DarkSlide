import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Pipette, SlidersHorizontal, Target, Trash2, X } from 'lucide-react';
import { MIN_ROLL_CALIBRATION_SAMPLES } from '../utils/rollCalibration';
import { Roll, WorkspaceDocument } from '../types';

type RollCalibrationModalProps = {
  isOpen: boolean;
  roll: Roll | null;
  activeDocument: WorkspaceDocument | null;
  onClose: () => void;
  onPickFilmBase: (rollId: string) => void;
  onPickNeutral: (rollId: string) => void;
  onFitCalibration: (rollId: string) => void;
  onClearCalibration: (rollId: string) => void;
};

export function RollCalibrationModal({
  isOpen,
  roll,
  activeDocument,
  onClose,
  onPickFilmBase,
  onPickNeutral,
  onFitCalibration,
  onClearCalibration,
}: RollCalibrationModalProps) {
  const calibration = roll?.calibration ?? null;
  const neutralSampleCount = calibration?.neutralSamples.length ?? 0;
  const hasBaseSample = Boolean(calibration?.baseSample ?? roll?.filmBaseSample);
  const canSampleFromActiveFrame = Boolean(roll && activeDocument?.rollId === roll.id);
  const canFitCalibration = hasBaseSample && neutralSampleCount >= MIN_ROLL_CALIBRATION_SAMPLES;

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
              className="w-full max-w-lg rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Roll Calibration</h2>
                  <p className="mt-1 text-xs text-zinc-500">{roll.name}</p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Close roll calibration"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="space-y-3 px-5 py-5">
                {/* Status card */}
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Status</p>
                    {calibration?.enabled ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-900/60 bg-emerald-950/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-300">
                        <CheckCircle2 size={10} />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                        Not fitted
                      </span>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    {/* Film base cell */}
                    <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-3 py-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Film Base</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full shrink-0 ${hasBaseSample ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
                        <p className="text-sm text-zinc-200">{hasBaseSample ? 'Captured' : 'Not sampled'}</p>
                      </div>
                    </div>
                    {/* Neutral samples cell */}
                    <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-3 py-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Neutral Samples</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex gap-1">
                          {Array.from({ length: MIN_ROLL_CALIBRATION_SAMPLES }).map((_, i) => (
                            <span
                              key={i}
                              className={`h-2 w-2 rounded-full ${i < neutralSampleCount ? 'bg-emerald-400' : 'bg-zinc-700'}`}
                            />
                          ))}
                        </div>
                        <p className="text-sm text-zinc-400">{neutralSampleCount}/{MIN_ROLL_CALIBRATION_SAMPLES}</p>
                      </div>
                    </div>
                  </div>

                  {!canSampleFromActiveFrame ? (
                    <p className="mt-3 text-xs leading-relaxed text-amber-300/80">
                      Open a frame from this roll to pick samples.
                    </p>
                  ) : (
                    <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                      Clicking a picker closes this dialog — then click directly on the image.
                    </p>
                  )}
                </div>

                {/* Sampling actions */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => onPickFilmBase(roll.id)}
                    disabled={!canSampleFromActiveFrame}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Pipette size={14} />
                    Pick Film Base
                  </button>
                  <button
                    type="button"
                    onClick={() => onPickNeutral(roll.id)}
                    disabled={!canSampleFromActiveFrame}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Target size={14} />
                    Pick Neutral
                  </button>
                </div>

                {/* Fit / Clear */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => onFitCalibration(roll.id)}
                    disabled={!canFitCalibration}
                    className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      canFitCalibration
                        ? 'border border-zinc-500 bg-zinc-100 text-zinc-900 hover:bg-white'
                        : 'border border-zinc-700 bg-zinc-900 text-zinc-400'
                    }`}
                  >
                    <SlidersHorizontal size={14} />
                    Fit Calibration
                  </button>
                  <button
                    type="button"
                    onClick={() => onClearCalibration(roll.id)}
                    disabled={!calibration}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-400 transition-colors hover:border-red-900/50 hover:bg-red-950/20 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                    Clear Calibration
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
