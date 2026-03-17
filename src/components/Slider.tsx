import React, { memo, useCallback } from 'react';

interface SliderProps {
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

export const Slider = memo(function Slider({
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
}: SliderProps) {
  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(event.target.value));
  }, [onChange]);

  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <div className="flex justify-between items-center px-1">
        <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">{label}</label>
        <span className="text-[11px] font-mono text-zinc-500">{valueLabel ?? `${value}${unit}`}</span>
      </div>
      <input
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
