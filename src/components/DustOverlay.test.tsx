import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DustOverlay } from './DustOverlay';
import type { ConversionSettings, DustMark } from '../types';

function createSettings(): ConversionSettings {
  return {
    inversionMethod: 'standard',
    exposure: 0,
    contrast: 0,
    saturation: 100,
    temperature: 0,
    tint: 0,
    redBalance: 1,
    greenBalance: 1,
    blueBalance: 1,
    blackPoint: 0,
    whitePoint: 255,
    highlightProtection: 0,
    curves: {
      rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    },
    rotation: 0,
    levelAngle: 0,
    crop: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: null,
    },
    filmBaseSample: null,
    blackAndWhite: {
      enabled: false,
      redMix: 0,
      greenMix: 0,
      blueMix: 0,
      tone: 0,
    },
    sharpen: { enabled: false, radius: 1, amount: 0 },
    noiseReduction: { enabled: false, luminanceStrength: 0 },
    dustRemoval: undefined,
  };
}

function setupOverlay(marks: DustMark[], onChange = vi.fn(), onSelectedMarkIdChange = vi.fn()) {
  render(
    <DustOverlay
      settings={createSettings()}
      sourceWidth={200}
      sourceHeight={100}
      brushActive
      marks={marks}
      manualBrushRadiusPx={10}
      selectedMarkId={null}
      onSelectedMarkIdChange={onSelectedMarkIdChange}
      onChange={onChange}
    />,
  );

  const overlay = screen.getByTestId('dust-overlay');
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  return { overlay, onChange, onSelectedMarkIdChange };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DustOverlay', () => {
  it('accumulates manual brush marks across rapid pointer moves before the next frame flush', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });

    const { overlay, onChange } = setupOverlay([]);

    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 30 });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 30 });
    fireEvent.mouseMove(window, { clientX: 120, clientY: 32 });

    expect(onChange).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);

    rafCallbacks[0](16);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('removes the hovered manual mark on right click instead of always removing the last mark', () => {
    const { overlay, onChange } = setupOverlay([
      { id: 'm1', kind: 'spot', cx: 0.2, cy: 0.5, radius: 8 / Math.hypot(200, 100), source: 'manual' },
      { id: 'm2', kind: 'spot', cx: 0.75, cy: 0.5, radius: 8 / Math.hypot(200, 100), source: 'manual' },
    ]);

    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });
    fireEvent.contextMenu(overlay, { clientX: 150, clientY: 50 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: 'm1' }),
    ]);
  });
});
