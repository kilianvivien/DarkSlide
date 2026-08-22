import React, { memo, useCallback, useId } from 'react';
import { StepButtons } from './StepButtons';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  valueLabel?: string;
  showStepButtons?: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

export const Slider = memo(function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit = '',
  valueLabel,
  showStepButtons = false,
  onInteractionStart,
  onInteractionEnd,
}: SliderProps) {
  const inputId = useId();

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(event.target.value));
  }, [onChange]);

  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <div className="flex justify-between items-center px-1">
        <label htmlFor={inputId} className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">{label}</label>
        {showStepButtons ? (
          <StepButtons
            label={label}
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={onChange}
            unit={unit}
            valueLabel={valueLabel}
            onInteractionStart={onInteractionStart}
            onInteractionEnd={onInteractionEnd}
          />
        ) : (
          <span className="text-[11px] font-mono text-zinc-500">{valueLabel ?? `${value}${unit}`}</span>
        )}
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        onPointerDown={onInteractionStart}
        onPointerUp={onInteractionEnd}
        onPointerCancel={onInteractionEnd}
        onKeyDown={onInteractionStart}
        onKeyUp={onInteractionEnd}
        onBlur={onInteractionEnd}
        className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-zinc-200 hover:accent-white transition-all"
      />
    </div>
  );
});
