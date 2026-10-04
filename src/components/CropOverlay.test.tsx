import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CropOverlay } from './CropOverlay';

const crop = {
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.8,
  aspectRatio: null,
};

describe('CropOverlay', () => {
  it('provides precise corner and edge grips with a rule-of-thirds guide', () => {
    render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button', { name: /^Resize crop/ })).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Resize crop from left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize crop from bottom' })).toBeInTheDocument();
    expect(screen.getByTestId('crop-rule-of-thirds')).toBeInTheDocument();
  });

  it('resizes a free crop from an edge', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        onChange={onChange}
      />,
    );
    const overlay = container.firstElementChild as HTMLDivElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize crop from left' }), {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 250,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 250 });

    const lastCrop = onChange.mock.calls.at(-1)?.[0];
    expect(lastCrop?.x).toBeCloseTo(0.2);
    expect(lastCrop?.width).toBeCloseTo(0.7);
  });

  it('preserves the current ratio when Shift is held during a free crop resize', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        onChange={onChange}
      />,
    );
    const overlay = container.firstElementChild as HTMLDivElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize crop from bottom right' }), {
      pointerId: 5,
      button: 0,
      clientX: 900,
      clientY: 450,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, {
      pointerId: 5,
      clientX: 800,
      clientY: 350,
      shiftKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 800, clientY: 350 });

    const lastCrop = onChange.mock.calls.at(-1)?.[0];
    expect(lastCrop?.width).toBeCloseTo(0.7);
    expect(lastCrop?.height).toBeCloseTo(0.7);
    expect((lastCrop?.width ?? 0) / (lastCrop?.height ?? 1)).toBeCloseTo(crop.width / crop.height);
  });

  it('shows the crop ratio next to the dimensions while dragging', () => {
    render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        onChange={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize crop from right' }), {
      pointerId: 6,
      button: 0,
      clientX: 900,
      clientY: 250,
    });

    expect(screen.getByText('800 × 400 px')).toBeInTheDocument();
    expect(screen.getByText('2:1')).toBeInTheDocument();
  });

  it('greys the four areas outside the crop and lets the user reposition from them', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        onChange={onChange}
      />,
    );
    const overlay = container.firstElementChild as HTMLDivElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });

    expect(container.querySelectorAll('[data-crop-shade]')).toHaveLength(4);
    fireEvent.pointerDown(container.querySelector('[data-crop-shade="top"]')!, {
      pointerId: 2,
      button: 0,
      clientX: 500,
      clientY: 25,
    });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 500, clientY: 25 });

    const repositionedCrop = onChange.mock.calls.at(-1)?.[0];
    expect(repositionedCrop?.x).toBeCloseTo(0.1);
    expect(repositionedCrop?.y).toBe(0);
  });

  it('straightens from either a horizontal or vertical reference line', () => {
    const onLevelAngleChange = vi.fn();
    const { container } = render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        levelAngle={1}
        straightenActive
        onChange={vi.fn()}
        onLevelAngleChange={onLevelAngleChange}
      />,
    );
    const overlay = container.firstElementChild as HTMLDivElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(overlay, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(overlay, { pointerId: 3, clientX: 500, clientY: 135 });
    fireEvent.pointerUp(overlay, { pointerId: 3, clientX: 500, clientY: 135 });

    expect(onLevelAngleChange).toHaveBeenCalledWith(expect.closeTo(-4, 0));
  });

  it('keeps the straighten line aligned with the pointer when the preview is scaled', () => {
    const onLevelAngleChange = vi.fn();
    const { container } = render(
      <CropOverlay
        crop={crop}
        imageWidth={1000}
        imageHeight={500}
        straightenActive
        onChange={vi.fn()}
        onLevelAngleChange={onLevelAngleChange}
      />,
    );
    const overlay = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(overlay, {
      clientWidth: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 500 },
    });
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
      x: 50,
      y: 25,
      top: 25,
      left: 50,
      right: 2050,
      bottom: 1025,
      width: 2000,
      height: 1000,
      toJSON: () => ({}),
    });
    Object.defineProperty(overlay, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(() => {
        throw new DOMException('Pointer capture is unavailable');
      }),
    });

    fireEvent.pointerDown(overlay, { pointerId: 4, button: 0, clientX: 250, clientY: 225 });
    fireEvent.pointerMove(overlay, { pointerId: 4, clientX: 1050, clientY: 295 });

    const line = screen.getByTestId('straighten-line');
    expect(line.style.left).toBe('250px');
    expect(line.style.top).toBe('225px');
    expect(Number.parseFloat(line.style.width)).toBeCloseTo(Math.hypot(800, 70));

    fireEvent.pointerUp(overlay, { pointerId: 4, clientX: 1050, clientY: 295 });
    expect(onLevelAngleChange).toHaveBeenCalledWith(expect.closeTo(-5, 0));
  });
});
