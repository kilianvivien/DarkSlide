import { memo, useEffect, useRef } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useEvent } from '../hooks/useEvent';

interface StepButtonsProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  valueLabel?: string;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

function decimalPlaces(value: number) {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) {
    const [mantissa, exponent] = text.split('e-');
    return (mantissa.split('.')[1]?.length ?? 0) + Number(exponent ?? 0);
  }
  return text.split('.')[1]?.length ?? 0;
}

export function stepValue(value: number, direction: -1 | 1, step: number, min: number, max: number) {
  const precision = Math.min(10, Math.max(decimalPlaces(value), decimalPlaces(step)));
  const next = Number((value + direction * step).toFixed(precision));
  return Math.min(max, Math.max(min, next));
}

function formatStep(step: number, unit: string) {
  return `${step}${unit}`;
}

/**
 * Precise −/+ controls for a slider. Each click is one bracketed interaction,
 * so it produces exactly one undo entry through the normal settings path.
 */
export const StepButtons = memo(function StepButtons({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit = '',
  valueLabel,
  onInteractionStart,
  onInteractionEnd,
}: StepButtonsProps) {
  // The end handler must see the state *after* the change, so it is called
  // once the new value has been rendered rather than from the click closure.
  const pendingEndRef = useRef(false);
  const fallbackTimerRef = useRef<number | null>(null);
  const finishInteraction = useEvent(() => {
    if (!pendingEndRef.current) return;
    pendingEndRef.current = false;
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    onInteractionEnd?.();
  });

  useEffect(() => {
    finishInteraction();
  }, [finishInteraction, value]);

  useEffect(() => () => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
    }
  }, []);

  const applyStep = (direction: -1 | 1) => {
    const next = stepValue(value, direction, step, min, max);
    if (next === value) return;

    // A previous click whose value never landed still needs closing first.
    finishInteraction();
    pendingEndRef.current = true;
    onInteractionStart?.();
    onChange(next);
    // If the parent ignores the change, the value effect never runs; close
    // the interaction anyway so it cannot stay open.
    fallbackTimerRef.current = window.setTimeout(() => {
      fallbackTimerRef.current = null;
      finishInteraction();
    }, 0);
  };

  const buttonClassName = 'flex w-6 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-30';

  return (
    <div
      role="group"
      aria-label={`${label} fine adjustment`}
      className="inline-flex h-6 items-stretch overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/70"
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        data-tip={`Decrease ${label} by ${formatStep(step, unit)}`}
        disabled={value <= min}
        onClick={() => applyStep(-1)}
        className={buttonClassName}
      >
        <Minus size={10} strokeWidth={2.25} />
      </button>
      <output
        aria-label={`${label} value`}
        aria-live="polite"
        className="flex min-w-10 items-center justify-center border-x border-zinc-800 px-1.5 font-mono text-[11px] tabular-nums text-zinc-400"
      >
        {valueLabel ?? `${value}${unit}`}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        data-tip={`Increase ${label} by ${formatStep(step, unit)}`}
        disabled={value >= max}
        onClick={() => applyStep(1)}
        className={buttonClassName}
      >
        <Plus size={10} strokeWidth={2.25} />
      </button>
    </div>
  );
});
