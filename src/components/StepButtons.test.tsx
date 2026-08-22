import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepButtons } from './StepButtons';

describe('StepButtons', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies precise decimal steps and brackets the update as one interaction', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onInteractionStart = vi.fn();
    const onInteractionEnd = vi.fn();

    render(
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
    expect(onInteractionEnd).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(onInteractionEnd).toHaveBeenCalledOnce();
  });

  it('disables the button that would exceed a limit', () => {
    render(
      <StepButtons
        label="Exposure"
        value={-100}
        min={-100}
        max={100}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Decrease Exposure' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase Exposure' })).toBeEnabled();
  });
});
