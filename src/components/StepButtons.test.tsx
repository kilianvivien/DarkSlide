import { act, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Slider } from './Slider';
import { StepButtons, stepValue } from './StepButtons';

// Mirrors App's interaction bracket: start snapshots the committed value,
// end commits whatever value the *current* render holds.
function HistoryHarness({
  initial,
  min,
  max,
  step,
  onCommit,
}: {
  initial: number;
  min: number;
  max: number;
  step: number;
  onCommit: (entry: { from: number; to: number }) => void;
}) {
  const [value, setValue] = useState(initial);
  const snapshotRef = useRef<number | null>(null);
  const committedRef = useRef(initial);

  const handleStart = useCallback(() => {
    snapshotRef.current = committedRef.current;
  }, []);
  const handleEnd = useCallback(() => {
    const from = snapshotRef.current;
    snapshotRef.current = null;
    if (from === null || from === value) return;
    committedRef.current = value;
    onCommit({ from, to: value });
  }, [onCommit, value]);

  return (
    <Slider
      label="Exposure"
      value={value}
      min={min}
      max={max}
      fineStep={step}
      onChange={setValue}
      onInteractionStart={handleStart}
      onInteractionEnd={handleEnd}
    />
  );
}

describe('stepValue', () => {
  it('avoids floating-point drift on fractional steps', () => {
    expect(stepValue(1, 1, 0.01, 0.5, 1.5)).toBe(1.01);
    expect(stepValue(0.07, 1, 0.01, 0, 1)).toBe(0.08);
    expect(stepValue(0.3, -1, 0.1, -10, 10)).toBe(0.2);
    expect(stepValue(-0.1, 1, 0.1, -10, 10)).toBe(0);
  });

  it('clamps to the control bounds', () => {
    expect(stepValue(1.495, 1, 0.01, 0.5, 1.5)).toBe(1.5);
    expect(stepValue(-99.5, -1, 1, -100, 100)).toBe(-100);
  });
});

describe('StepButtons', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies precise decimal steps and brackets the update as one interaction', () => {
    const onChange = vi.fn();
    const onInteractionStart = vi.fn();
    const onInteractionEnd = vi.fn();

    const { rerender } = render(
      <StepButtons
        label="Red balance"
        value={1}
        min={0.5}
        max={1.5}
        step={0.01}
        onChange={onChange}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Increase Red balance' }));
    expect(onInteractionStart).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(1.01);

    rerender(
      <StepButtons
        label="Red balance"
        value={1.01}
        min={0.5}
        max={1.5}
        step={0.01}
        onChange={onChange}
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
      />,
    );
    expect(onInteractionEnd).toHaveBeenCalledOnce();
  });

  it('commits the post-click value, creating one undo entry per click', () => {
    const onCommit = vi.fn();
    render(<HistoryHarness initial={0} min={-100} max={100} step={1} onCommit={onCommit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Increase Exposure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Exposure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Exposure' }));

    expect(onCommit.mock.calls.map(([entry]) => entry)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ]);
    expect(screen.getByRole('slider', { name: 'Exposure' })).toHaveValue('1');
  });

  it('still closes the interaction when the parent ignores the change', () => {
    vi.useFakeTimers();
    const onInteractionEnd = vi.fn();
    render(
      <StepButtons
        label="Tint"
        value={0}
        min={-100}
        max={100}
        onChange={vi.fn()}
        onInteractionStart={vi.fn()}
        onInteractionEnd={onInteractionEnd}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Increase Tint' }));
    expect(onInteractionEnd).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(onInteractionEnd).toHaveBeenCalledOnce();
  });

  it('disables the button that would exceed a limit and does nothing at the boundary', () => {
    const onChange = vi.fn();
    const onInteractionStart = vi.fn();
    render(
      <StepButtons
        label="Exposure"
        value={-100}
        min={-100}
        max={100}
        onChange={onChange}
        onInteractionStart={onInteractionStart}
      />,
    );

    const decrease = screen.getByRole('button', { name: 'Decrease Exposure' });
    expect(decrease).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase Exposure' })).toBeEnabled();
    fireEvent.click(decrease);
    expect(onChange).not.toHaveBeenCalled();
    expect(onInteractionStart).not.toHaveBeenCalled();
  });

  it('shows the formatted value and is reachable by keyboard', () => {
    render(
      <StepButtons
        label="Level"
        value={1.5}
        min={-10}
        max={10}
        step={0.1}
        unit="°"
        valueLabel="1.5°"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('group', { name: 'Level fine adjustment' })).toBeInTheDocument();
    expect(screen.getByLabelText('Level value')).toHaveTextContent('1.5°');
    const increase = screen.getByRole('button', { name: 'Increase Level' });
    increase.focus();
    expect(increase).toHaveFocus();
    expect(increase).toHaveAttribute('data-tip', 'Increase Level by 0.1°');
  });
});

describe('Slider fine steps', () => {
  it('only renders step buttons when a fine step is configured', () => {
    const { rerender } = render(<Slider label="Contrast" value={0} min={-100} max={100} onChange={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Contrast fine adjustment' })).not.toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();

    rerender(<Slider label="Contrast" value={0} min={-100} max={100} fineStep={1} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Contrast fine adjustment' })).toBeInTheDocument();
  });
});
