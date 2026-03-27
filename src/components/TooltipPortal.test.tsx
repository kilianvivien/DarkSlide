import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipPortal } from './TooltipPortal';

describe('TooltipPortal', () => {
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 240,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return this.textContent?.includes('Viewport edge tooltip') ? 220 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.textContent?.includes('Viewport edge tooltip') ? 40 : 0;
      },
    });
  });

  afterEach(() => {
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
    }
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it('clamps tooltip position to stay inside the viewport', async () => {
    render(
      <TooltipPortal>
        <button data-tip="Viewport edge tooltip">Trigger</button>
      </TooltipPortal>,
    );

    const trigger = screen.getByText('Trigger');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 90,
      width: 20,
      height: 20,
      top: 90,
      right: 20,
      bottom: 110,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseOver(trigger);

    const tooltip = await screen.findByText('Viewport edge tooltip');
    await waitFor(() => {
      expect(tooltip).toHaveStyle({
        left: '12px',
        top: '42px',
        visibility: 'visible',
      });
    });
  });
});
