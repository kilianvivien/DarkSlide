import { memo, useCallback } from 'react';
import { Minus, Plus } from 'lucide-react';

interface StepButtonsProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  valueLabel?: string;
  compact?: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

function decimalPlaces(value: number) {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) {
    return Number(text.split('e-')[1] ?? 0);
  }
  return text.split('.')[1]?.length ?? 0;
}

function stepValue(value: number, direction: -1 | 1, step: number, min: number, max: number) {
  const precision = Math.max(decimalPlaces(value), decimalPlaces(step));
  const next = Number((value + direction * step).toFixed(precision));
  return Math.min(max, Math.max(min, next));
}

export const StepButtons = memo(function StepButtons({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit = '',
  valueLabel,
  compact = false,
  onInteractionStart,
  onInteractionEnd,
}: StepButtonsProps) {
  const applyStep = useCallback((direction: -1 | 1) => {
    const next = stepValue(value, direction, step, min, max);
    if (next === value) return;

    onInteractionStart?.();
    onChange(next);
    window.setTimeout(() => onInteractionEnd?.(), 0);
  }, [max, min, onChange, onInteractionEnd, onInteractionStart, step, value]);

  return (
    <div
      role="group"
      aria-label={`${label} fine adjustment`}
      className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-zinc-700 bg-zinc-950/70 shadow-sm"
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        data-tip={`Decrease ${label} by ${step}${unit}`}
        disabled={value <= min}
        onClick={() => applyStep(-1)}
        className={`${compact ? 'w-6' : 'w-7'} flex items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30`}
      >
        <Minus size={compact ? 10 : 11} strokeWidth={2.25} />
      </button>
      <output
        aria-label={`${label} value`}
        className={`${compact ? 'min-w-8 px-1' : 'min-w-11 px-1.5'} flex items-center justify-center border-x border-zinc-800 font-mono text-[10px] tabular-nums text-zinc-300`}
      >
        {valueLabel ?? `${value}${unit}`}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        data-tip={`Increase ${label} by ${step}${unit}`}
        disabled={value >= max}
        onClick={() => applyStep(1)}
        className={`${compact ? 'w-6' : 'w-7'} flex items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30`}
      >
        <Plus size={compact ? 10 : 11} strokeWidth={2.25} />
      </button>
    </div>
  );
});
