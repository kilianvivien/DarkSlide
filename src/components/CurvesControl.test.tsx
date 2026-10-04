import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
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

  it('ends the interaction only after the final coalesced change has rendered', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const initial = {
      rgb: [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }],
      red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    };
    const committed: number[] = [];

    function Harness() {
      const [curves, setCurves] = React.useState(initial);
      // Mirrors App: the end handler commits the curves of its own render.
      const handleEnd = React.useCallback(() => {
        committed.push(curves.rgb[1].y);
      }, [curves]);
      return <CurvesControl curves={curves} onChange={setCurves} onInteractionEnd={handleEnd} isColor />;
    }

    const { container } = render(<Harness />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200 } as DOMRect);

    fireEvent.mouseDown(container.querySelectorAll('circle[fill="transparent"]')[1]);
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50 });
    fireEvent.mouseUp(window);

    expect(committed).toEqual([191]);
  });
});
