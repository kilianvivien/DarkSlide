import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurvesControl } from './CurvesControl';

describe('CurvesControl', () => {
  it('prevents selecting the helper tooltip while dragging the curve UI', () => {
    const { container } = render(
      <CurvesControl
        curves={{
          rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        }}
        onChange={vi.fn()}
        isColor
      />,
    );

    const surface = container.querySelector('.group');
    const tooltip = screen.getByText('Double-click to add point • Right-click to remove');

    expect(surface).toHaveClass('select-none');
    expect(tooltip.parentElement).toHaveClass('pointer-events-none');
    expect(tooltip).toHaveClass('select-none');
  });

  it('updates the dragged point locally and coalesces parent changes per frame', () => {
    let frameCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frameCallback = null;
    });
    const onChange = vi.fn();
    const onInteractionEnd = vi.fn();
    const { container } = render(
      <CurvesControl
        curves={{
          rgb: [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }],
          red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        }}
        onChange={onChange}
        onInteractionEnd={onInteractionEnd}
        isColor
      />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    vi.spyOn(svg as SVGSVGElement, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
    } as DOMRect);

    const hitTargets = container.querySelectorAll('circle[fill="transparent"]');
    fireEvent.mouseDown(hitTargets[1]);
    fireEvent.mouseMove(window, { clientX: 90, clientY: 80 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50 });

    const visiblePoints = container.querySelectorAll('circle[fill="white"]');
    expect(Number(visiblePoints[1].getAttribute('cy'))).toBeCloseTo(50.2, 1);
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      frameCallback?.(16);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].rgb[1]).toEqual({ x: 128, y: 191 });

    fireEvent.mouseUp(window);
    expect(onInteractionEnd).toHaveBeenCalledTimes(1);
  });
});
