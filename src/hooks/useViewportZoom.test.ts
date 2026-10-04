import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  computeAnchoredPan,
  computePanTranslate,
  computeWheelZoom,
  MAX_ZOOM,
  PanGeometry,
  resolveMinimumZoom,
  useViewportZoom,
} from './useViewportZoom';

const GEOMETRY: PanGeometry = {
  imageWidth: 4000,
  imageHeight: 3000,
  viewportWidth: 1000,
  viewportHeight: 800,
  fitScale: 0.25,
};

// Screen offset (from the scale origin) of an image-space offset from the
// image centre, under `translate3d(t) scale(zoom)` with a centred origin.
function screenOffset(imageOffset: { x: number; y: number }, pan: { x: number; y: number }, zoom: number) {
  const translate = computePanTranslate(pan, GEOMETRY.imageWidth, GEOMETRY.imageHeight, GEOMETRY.viewportWidth, GEOMETRY.viewportHeight, zoom);
  return { x: translate.x + imageOffset.x * zoom, y: translate.y + imageOffset.y * zoom };
}

function imagePointUnder(cursor: { x: number; y: number }, pan: { x: number; y: number }, zoom: number) {
  const translate = computePanTranslate(pan, GEOMETRY.imageWidth, GEOMETRY.imageHeight, GEOMETRY.viewportWidth, GEOMETRY.viewportHeight, zoom);
  return { x: (cursor.x - translate.x) / zoom, y: (cursor.y - translate.y) / zoom };
}

describe('computeWheelZoom', () => {
  it('makes tiny trackpad deltas produce tiny, continuous changes', () => {
    const next = computeWheelZoom(1, 1);
    expect(next).toBeLessThan(1);
    expect(next).toBeGreaterThan(0.995);
    expect(computeWheelZoom(1, -1)).toBeGreaterThan(1);
  });

  it('keeps a mouse notch close to the familiar 10% step', () => {
    expect(computeWheelZoom(1, -100)).toBeCloseTo(1.105, 3);
    expect(computeWheelZoom(1, 100)).toBeCloseTo(0.905, 3);
  });

  it('bounds very large deltas', () => {
    expect(computeWheelZoom(1, -10_000)).toBeCloseTo(computeWheelZoom(1, -240), 10);
    expect(computeWheelZoom(1, -10_000)).toBeLessThan(1.3);
  });

  it('zooms faster for pinch gestures', () => {
    expect(computeWheelZoom(1, -10, 0.1, true)).toBeGreaterThan(computeWheelZoom(1, -10, 0.1, false));
  });

  it('respects zoom limits, including fit scales below 10%', () => {
    expect(computeWheelZoom(MAX_ZOOM, -240)).toBe(MAX_ZOOM);
    expect(computeWheelZoom(0.1, 240)).toBe(0.1);
    expect(resolveMinimumZoom(0.04)).toBe(0.04);
    expect(computeWheelZoom(0.04, 240, resolveMinimumZoom(0.04))).toBe(0.04);
    expect(resolveMinimumZoom(0.5)).toBe(0.1);
    expect(resolveMinimumZoom(undefined)).toBe(0.1);
  });

  it('ignores non-finite deltas', () => {
    expect(computeWheelZoom(2, Number.NaN)).toBe(2);
  });
});

describe('computeAnchoredPan', () => {
  it('keeps the image point under the cursor fixed on screen', () => {
    const pan = { x: 0.5, y: 0.5 };
    const cursor = { x: 180, y: -120 };
    const from = 0.5;
    const to = 0.75;
    const anchor = imagePointUnder(cursor, pan, from);

    const nextPan = computeAnchoredPan(pan, cursor, GEOMETRY, from, to);
    const after = screenOffset(anchor, nextPan, to);
    expect(after.x).toBeCloseTo(cursor.x, 6);
    expect(after.y).toBeCloseTo(cursor.y, 6);
  });

  it('anchors when zooming in from the fit scale', () => {
    const pan = { x: 0.5, y: 0.5 };
    const cursor = { x: -60, y: 40 };
    const anchor = imagePointUnder(cursor, pan, GEOMETRY.fitScale);

    const nextPan = computeAnchoredPan(pan, cursor, GEOMETRY, GEOMETRY.fitScale, 0.3);
    const after = screenOffset(anchor, nextPan, 0.3);
    expect(after.x).toBeCloseTo(cursor.x, 6);
    expect(after.y).toBeCloseTo(cursor.y, 6);
  });

  it('keeps the anchor across repeated zoom-in and zoom-out steps', () => {
    let pan = { x: 0.3, y: 0.6 };
    let zoom = 1;
    const cursor = { x: 100, y: 50 };
    const anchor = imagePointUnder(cursor, pan, zoom);
    for (const nextZoom of [1.2, 1.6, 1.3, 0.9, 1.1]) {
      pan = computeAnchoredPan(pan, cursor, GEOMETRY, zoom, nextZoom);
      zoom = nextZoom;
      const after = screenOffset(anchor, pan, zoom);
      expect(after.x).toBeCloseTo(cursor.x, 6);
      expect(after.y).toBeCloseTo(cursor.y, 6);
    }
  });

  it('stays within pan bounds near image edges', () => {
    const nextPan = computeAnchoredPan({ x: 1, y: 0 }, { x: -500, y: 400 }, GEOMETRY, 1, 2);
    expect(nextPan.x).toBeGreaterThanOrEqual(0);
    expect(nextPan.x).toBeLessThanOrEqual(1);
    expect(nextPan.y).toBeGreaterThanOrEqual(0);
    expect(nextPan.y).toBeLessThanOrEqual(1);
  });

  it('centres an axis that fits inside the viewport', () => {
    const nextPan = computeAnchoredPan({ x: 0.2, y: 0.2 }, { x: 100, y: 100 }, GEOMETRY, 0.25, 0.2);
    expect(nextPan).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('useViewportZoom', () => {
  function setup(fitScale: number) {
    const hook = renderHook(() => useViewportZoom());
    hook.result.current.panGeometryRef.current = { ...GEOMETRY, fitScale };
    return hook;
  }

  it('starts wheel zoom from the fit scale instead of jumping to 100%', () => {
    const { result } = setup(0.25);
    act(() => {
      result.current.handleWheel(-100, 0.5, 0.5, { containerWidth: 1000, containerHeight: 800 });
      result.current.commitZoom();
    });
    expect(result.current.zoom).toBeCloseTo(0.25 * Math.exp(0.1), 6);
  });

  it('steps zoom buttons from the fit scale', () => {
    const { result } = setup(0.25);
    act(() => {
      result.current.zoomIn();
    });
    expect(result.current.zoom).toBeCloseTo(0.3125, 6);
  });

  it('lets very large scans zoom out to a fit scale below 10%', () => {
    const { result } = setup(0.05);
    act(() => {
      result.current.zoomOut();
    });
    expect(result.current.zoom).toBe(0.05);
  });

  it('keeps the real fit scale while panning', () => {
    const { result } = setup(0.25);
    act(() => {
      result.current.setZoomLevel(2);
      result.current.startPan(100, 100);
      result.current.updatePan(80, 90, 4000, 3000, 1000, 800, 2);
      result.current.endPan();
    });
    expect(result.current.panGeometryRef.current?.fitScale).toBe(0.25);
  });
});
