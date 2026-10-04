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
  /** Shows −/+ buttons that move the value by this amount. */
  fineStep?: number;
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
  fineStep,
  onInteractionStart,
  onInteractionEnd,
}: SliderProps) {
  const inputId = useId();

  // The filled part of the track runs from zero for bipolar sliders
  // (exposure, tint…) and from the minimum otherwise.
  const span = max - min || 1;
  const toPercent = (input: number) => `${Math.min(100, Math.max(0, ((input - min) / span) * 100))}%`;
  const origin = min < 0 && max > 0 ? 0 : min;
  const fillStyle = {
    '--fill-from': toPercent(Math.min(origin, value)),
    '--fill-to': toPercent(Math.max(origin, value)),
  } as React.CSSProperties;

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(event.target.value));
  }, [onChange]);

  return (
    <div className="mb-2.5 flex flex-col gap-1">
      <div className="flex min-h-6 items-center justify-between px-0.5">
        <label htmlFor={inputId} className="text-[12px] text-zinc-300">{label}</label>
        {fineStep !== undefined ? (
          <StepButtons
            label={label}
            value={value}
            min={min}
            max={max}
            step={fineStep}
            onChange={onChange}
            unit={unit}
            valueLabel={valueLabel}
            onInteractionStart={onInteractionStart}
            onInteractionEnd={onInteractionEnd}
          />
        ) : (
          <span className="font-mono text-[11px] tabular-nums text-zinc-500">{valueLabel ?? `${value}${unit}`}</span>
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
        style={fillStyle}
        className="slider-track w-full cursor-pointer appearance-none bg-transparent"
      />
    </div>
  );
});
