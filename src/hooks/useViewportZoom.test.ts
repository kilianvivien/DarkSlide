import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { computeWheelZoom, useViewportZoom } from './useViewportZoom';

describe('computeWheelZoom', () => {
  it('keeps high-resolution trackpad deltas small', () => {
    expect(computeWheelZoom(1, -1)).toBeCloseTo(1.0007, 5);
  });

  it('uses reciprocal scaling for equal wheel movement', () => {
    const zoomedIn = computeWheelZoom(1, -100);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedIn).toBeLessThan(1.1);
    expect(computeWheelZoom(zoomedIn, 100)).toBeCloseTo(1, 8);
  });

  it('does not jump when the fitted image is below the normal zoom floor', () => {
    expect(computeWheelZoom(0.05, -100, 0.05)).toBeCloseTo(0.0536, 4);
  });
});

describe('useViewportZoom', () => {
  it('starts wheel zoom from the fit scale instead of jumping to 100%', () => {
    const { result } = renderHook(() => useViewportZoom());
    result.current.panGeometryRef.current = {
      imageWidth: 4000,
      imageHeight: 3000,
      viewportWidth: 1000,
      viewportHeight: 750,
      fitScale: 0.25,
    };

    act(() => {
      result.current.handleWheel(-100, 0.5, 0.5);
      result.current.commitZoom();
    });

    expect(result.current.zoom).toBeTypeOf('number');
    expect(result.current.zoom).toBeCloseTo(0.2681, 3);
  });

  it('moves toward the cursor in proportion to the zoom change', () => {
    const { result } = renderHook(() => useViewportZoom());
    result.current.panGeometryRef.current = {
      imageWidth: 4000,
      imageHeight: 3000,
      viewportWidth: 1000,
      viewportHeight: 750,
      fitScale: 0.25,
    };

    act(() => {
      result.current.handleWheel(-1, 1, 1);
      result.current.commitZoom();
    });

    expect(result.current.pan.x).toBeGreaterThan(0.5);
    expect(result.current.pan.x).toBeLessThan(0.501);
    expect(result.current.pan.y).toBe(result.current.pan.x);
  });

  it('uses smaller button steps from the current fit scale', () => {
    const { result } = renderHook(() => useViewportZoom());
    result.current.panGeometryRef.current = {
      imageWidth: 4000,
      imageHeight: 3000,
      viewportWidth: 1000,
      viewportHeight: 750,
      fitScale: 0.25,
    };

    act(() => {
      result.current.zoomIn();
    });

    expect(result.current.zoom).toBeCloseTo(0.2875, 5);
  });
});
