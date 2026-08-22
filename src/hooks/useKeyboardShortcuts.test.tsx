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
