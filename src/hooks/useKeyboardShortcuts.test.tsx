import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutMap, useKeyboardShortcuts } from './useKeyboardShortcuts';

function ShortcutHarness({ shortcuts }: { shortcuts: ShortcutMap }) {
  useKeyboardShortcuts({ shortcuts });
  return null;
}

describe('useKeyboardShortcuts', () => {
  it('keeps plain, Alt, and command arrow adjustments separate', () => {
    const adjustExposure = vi.fn();
    const adjustContrast = vi.fn();
    const adjustSaturation = vi.fn();

    render(
      <ShortcutHarness
        shortcuts={{
          exposure: { key: 'arrowup', handler: adjustExposure },
          contrast: { key: 'arrowup', alt: true, handler: adjustContrast },
          saturation: { key: 'arrowup', meta: true, handler: adjustSaturation },
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true });

    expect(adjustExposure).toHaveBeenCalledOnce();
    expect(adjustContrast).toHaveBeenCalledOnce();
    expect(adjustSaturation).toHaveBeenCalledOnce();
  });
});

describe('useKeyboardShortcuts pausing and editable targets', () => {
  function PausableHarness({ paused, handler }: { paused: boolean; handler: () => void }) {
    useKeyboardShortcuts({ shortcuts: { tool: { key: 'p', handler } }, paused });
    return <input aria-label="Name" />;
  }

  it('ignores shortcuts while paused and resumes afterwards', () => {
    const handler = vi.fn();
    const { rerender } = render(<PausableHarness paused handler={handler} />);
    fireEvent.keyDown(window, { key: 'p' });
    expect(handler).not.toHaveBeenCalled();

    rerender(<PausableHarness paused={false} handler={handler} />);
    fireEvent.keyDown(window, { key: 'p' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never fires single-key shortcuts while typing in a field', () => {
    const handler = vi.fn();
    const { getByLabelText } = render(<PausableHarness paused={false} handler={handler} />);
    fireEvent.keyDown(getByLabelText('Name'), { key: 'p' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts and focused controls', () => {
  function NudgeHarness({ handler }: { handler: () => void }) {
    useKeyboardShortcuts({ shortcuts: { next: { key: 'arrowright', handler } } });
    return <button type="button" onKeyDown={(event) => event.preventDefault()}>Crop area</button>;
  }

  it('skips keys a focused control already handled', () => {
    const handler = vi.fn();
    const { getByRole } = render(<NudgeHarness handler={handler} />);
    fireEvent.keyDown(getByRole('button', { name: 'Crop area' }), { key: 'ArrowRight' });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
