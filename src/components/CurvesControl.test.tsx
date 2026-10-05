import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Curves } from '../types';
import { CurvesControl } from './CurvesControl';

const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

function makeCurves(rgb = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }]): Curves {
  return { rgb, red: identity, green: identity, blue: identity };
}

function mockSurface(container: HTMLElement) {
  const svg = container.querySelector('svg') as SVGSVGElement;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200 } as DOMRect);
  return svg;
}

function captureFrames() {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return () => {
    const pending = callbacks.splice(0);
    act(() => pending.forEach((callback) => callback(performance.now() + 1000)));
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CurvesControl', () => {
  it('keeps the helper hint out of the way of dragging', () => {
    const { container } = render(<CurvesControl curves={makeCurves(identity)} onChange={vi.fn()} isColor />);
    const surface = container.querySelector('.group');
    const hint = screen.getByText(/Drag the curve to add a point/);
    expect(surface).toHaveClass('select-none');
    expect(hint.parentElement).toHaveClass('pointer-events-none');
  });

  it('updates the dragged point locally and coalesces parent changes per frame', () => {
    const runFrames = captureFrames();
    const onChange = vi.fn();
    const onInteractionEnd = vi.fn();
    const { container } = render(
      <CurvesControl curves={makeCurves()} onChange={onChange} onInteractionEnd={onInteractionEnd} isColor />,
    );
    mockSurface(container);

    const handle = screen.getByRole('slider', { name: 'RGB curve point 2' });
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 80 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50 });

    expect(handle).toHaveAttribute('aria-valuetext', 'Input 128, output 192');
    expect(onChange).not.toHaveBeenCalled();

    runFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].rgb[1]).toEqual({ x: 128, y: 192 });

    fireEvent.mouseUp(window);
    expect(onInteractionEnd).toHaveBeenCalledTimes(1);
  });

  it('moves a point at a fifth of the pointer speed while Alt is held', () => {
    captureFrames();
    const { container } = render(<CurvesControl curves={makeCurves()} onChange={vi.fn()} isColor />);
    mockSurface(container);

    const handle = screen.getByRole('slider', { name: 'RGB curve point 2' });
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100, altKey: true });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50, altKey: true });

    // 50 px is 64 levels at full speed, about 13 with Alt.
    expect(handle).toHaveAttribute('aria-valuetext', 'Input 128, output 141');
  });

  it('nudges the focused point with the arrow keys and removes it with Delete', () => {
    captureFrames();
    const onChange = vi.fn();
    render(<CurvesControl curves={makeCurves()} onChange={onChange} isColor />);

    const handle = screen.getByRole('slider', { name: 'RGB curve point 2' });
    fireEvent.focus(handle);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onChange.mock.calls.at(-1)?.[0].rgb[1]).toEqual({ x: 128, y: 129 });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(onChange.mock.calls.at(-1)?.[0].rgb[1]).toEqual({ x: 138, y: 129 });

    fireEvent.keyDown(handle, { key: 'Delete' });
    expect(onChange.mock.calls.at(-1)?.[0].rgb).toHaveLength(2);
  });

  it('adds a point where the curve is pressed and lets it follow the pointer', () => {
    captureFrames();
    const onChange = vi.fn();
    const { container } = render(<CurvesControl curves={makeCurves(identity)} onChange={onChange} isColor />);
    const svg = mockSurface(container);

    // x = 50 px is level 64 on the identity curve, which sits at y = 150 px.
    fireEvent.pointerDown(svg, { button: 0, clientX: 50, clientY: 152 });
    const added = screen.getByRole('slider', { name: 'RGB curve point 2' });
    expect(added).toHaveAttribute('aria-valuetext', 'Input 64, output 64');

    fireEvent.mouseMove(window, { clientX: 50, clientY: 130 });
    expect(added).toHaveAttribute('aria-valuetext', 'Input 64, output 92');
  });

  it('edits the selected point from the input and output fields', () => {
    captureFrames();
    const onChange = vi.fn();
    render(<CurvesControl curves={makeCurves()} onChange={onChange} isColor />);

    fireEvent.focus(screen.getByRole('slider', { name: 'RGB curve point 2' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Point output' }), { target: { value: '150' } });
    expect(onChange.mock.calls.at(-1)?.[0].rgb[1]).toEqual({ x: 128, y: 150 });
  });

  it('ends the interaction only after the final coalesced change has rendered', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const committed: number[] = [];

    function Harness() {
      const [curves, setCurves] = React.useState(makeCurves());
      // Mirrors App: the end handler commits the curves of its own render.
      const handleEnd = React.useCallback(() => {
        committed.push(curves.rgb[1].y);
      }, [curves]);
      return <CurvesControl curves={curves} onChange={setCurves} onInteractionEnd={handleEnd} isColor />;
    }

    const { container } = render(<Harness />);
    mockSurface(container);

    fireEvent.mouseDown(screen.getByRole('slider', { name: 'RGB curve point 2' }), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 50 });
    fireEvent.mouseUp(window);

    expect(committed).toEqual([192]);
  });
});
