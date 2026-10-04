import { useCallback, useRef, useState } from 'react';
import type { ZoomLevel } from '../types';

export const MAX_ZOOM = 8;
const DEFAULT_MIN_ZOOM = 0.1;
// Mouse wheels report ~100px per notch, so 0.001 keeps the familiar ~10% step.
const WHEEL_ZOOM_RATE = 0.001;
// Trackpad pinches arrive as ctrl+wheel with small deltas.
const PINCH_ZOOM_RATE = 0.01;
const MAX_WHEEL_DELTA = 240;

function clampZoom(z: number, minimum = DEFAULT_MIN_ZOOM): number {
  return Math.min(MAX_ZOOM, Math.max(minimum, z));
}

/** Zoom-out limit: never above the fit scale, so very large scans can still fit. */
export function resolveMinimumZoom(fitScale: number | null | undefined) {
  return fitScale && fitScale > 0 ? Math.min(DEFAULT_MIN_ZOOM, fitScale) : DEFAULT_MIN_ZOOM;
}

/**
 * Continuous wheel zoom. Tiny trackpad deltas give tiny changes, and one
 * oversized event (a fast flick or a page-mode delta) is bounded.
 */
export function computeWheelZoom(
  currentZoom: number,
  deltaY: number,
  minimumZoom = DEFAULT_MIN_ZOOM,
  pinch = false,
) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(currentZoom, minimumZoom);
  const boundedDelta = Math.min(MAX_WHEEL_DELTA, Math.max(-MAX_WHEEL_DELTA, deltaY));
  const rate = pinch ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
  return clampZoom(currentZoom * Math.exp(-boundedDelta * rate), minimumZoom);
}

function resolvePanAxis(
  pan: number,
  cursorOffset: number,
  imageSize: number,
  viewportSize: number,
  currentZoom: number,
  nextZoom: number,
) {
  const currentPannable = Math.max(0, imageSize * currentZoom - viewportSize);
  const nextPannable = Math.max(0, imageSize * nextZoom - viewportSize);
  if (nextPannable <= 0 || imageSize <= 0) {
    // The image fits along this axis and is centred; there is nothing to pan.
    return 0.5;
  }
  const currentTranslate = (0.5 - pan) * currentPannable;
  // Image-space offset from the image centre (in unscaled pixels) under the cursor.
  const anchor = (cursorOffset - currentTranslate) / currentZoom;
  const nextTranslate = cursorOffset - anchor * nextZoom;
  return Math.min(1, Math.max(0, 0.5 - nextTranslate / nextPannable));
}

/**
 * Pan that keeps the image point under the cursor fixed while zooming.
 * `cursorOffset` is measured in screen pixels from the centre of the element
 * the transform scales around. Pan stays within its 0–1 bounds, so anchoring
 * yields to the bounds near the image edges.
 */
export function computeAnchoredPan(
  pan: { x: number; y: number },
  cursorOffset: { x: number; y: number },
  geometry: Pick<PanGeometry, 'imageWidth' | 'imageHeight' | 'viewportWidth' | 'viewportHeight'>,
  currentZoom: number,
  nextZoom: number,
) {
  return {
    x: resolvePanAxis(pan.x, cursorOffset.x, geometry.imageWidth, geometry.viewportWidth, currentZoom, nextZoom),
    y: resolvePanAxis(pan.y, cursorOffset.y, geometry.imageHeight, geometry.viewportHeight, currentZoom, nextZoom),
  };
}

export interface WheelZoomOptions {
  /** Size of the element the wheel position was normalised against. */
  containerWidth?: number;
  containerHeight?: number;
  /** ctrl+wheel, as sent by trackpad pinch gestures. */
  pinch?: boolean;
}

export interface PanGeometry {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  fitScale: number;
}

export interface ViewportZoomState {
  zoom: ZoomLevel;
  pan: { x: number; y: number };
}

export function resolveEffectiveZoom(zoom: ZoomLevel, fitScale: number) {
  return zoom === 'fit' ? fitScale : zoom;
}

/**
 * Compute the pixel translate needed for a given pan value.
 * pan 0.5 = centered, 0 = left/top edge, 1 = right/bottom edge.
 * The translate is in screen-space pixels, applied AFTER scale in CSS:
 *   transform: translate3d(px, py, 0) scale(Z)
 */
export function computePanTranslate(
  pan: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  effectiveZoom: number,
): { x: number; y: number } {
  const pannableX = Math.max(0, imageWidth * effectiveZoom - viewportWidth);
  const pannableY = Math.max(0, imageHeight * effectiveZoom - viewportHeight);
  return {
    x: (0.5 - pan.x) * pannableX,
    y: (0.5 - pan.y) * pannableY,
  };
}

export function useViewportZoom() {
  const [zoom, setZoom] = useState<ZoomLevel>('fit');
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 });
  const panStartRef = useRef<{ clientX: number; clientY: number; startPan: { x: number; y: number } } | null>(null);

  const liveZoomRef = useRef<ZoomLevel>('fit');
  // Ref-based live pan for direct DOM updates during drag (bypasses React re-renders)
  const livePanRef = useRef({ x: 0.5, y: 0.5 });
  const panTransformRef = useRef<HTMLDivElement | null>(null);
  const panGeometryRef = useRef<PanGeometry | null>(null);

  const applyViewportTransform = useCallback((nextPan: { x: number; y: number }, nextZoom: ZoomLevel = liveZoomRef.current) => {
    livePanRef.current = nextPan;
    liveZoomRef.current = nextZoom;

    const el = panTransformRef.current;
    const geo = panGeometryRef.current;
    if (!el || !geo) return;

    const effectiveZoom = resolveEffectiveZoom(nextZoom, geo.fitScale);
    const t = computePanTranslate(nextPan, geo.imageWidth, geo.imageHeight, geo.viewportWidth, geo.viewportHeight, effectiveZoom);
    el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${effectiveZoom})`;
  }, []);

  const setCommittedZoom = useCallback((nextZoom: ZoomLevel) => {
    liveZoomRef.current = nextZoom;
    setZoom(nextZoom);
    applyViewportTransform(livePanRef.current, nextZoom);
  }, [applyViewportTransform]);

  const zoomToFit = useCallback(() => {
    liveZoomRef.current = 'fit';
    livePanRef.current = { x: 0.5, y: 0.5 };
    setZoom('fit');
    setPan({ x: 0.5, y: 0.5 });
    applyViewportTransform({ x: 0.5, y: 0.5 }, 'fit');
  }, [applyViewportTransform]);

  const zoomTo100 = useCallback(() => {
    setCommittedZoom(1);
  }, [setCommittedZoom]);

  // Relative zoom starts from what is on screen: 'fit' is the fit scale, not 100%.
  const resolveLiveZoom = useCallback(() => (
    liveZoomRef.current === 'fit' ? (panGeometryRef.current?.fitScale ?? 1) : liveZoomRef.current
  ), []);

  const zoomIn = useCallback(() => {
    const minimum = resolveMinimumZoom(panGeometryRef.current?.fitScale);
    setCommittedZoom(clampZoom(resolveLiveZoom() * 1.25, minimum));
  }, [resolveLiveZoom, setCommittedZoom]);

  const zoomOut = useCallback(() => {
    const minimum = resolveMinimumZoom(panGeometryRef.current?.fitScale);
    setCommittedZoom(clampZoom(resolveLiveZoom() * 0.8, minimum));
  }, [resolveLiveZoom, setCommittedZoom]);

  const setZoomLevel = useCallback((level: ZoomLevel) => {
    if (level === 'fit') {
      zoomToFit();
    } else {
      setCommittedZoom(clampZoom(level, resolveMinimumZoom(panGeometryRef.current?.fitScale)));
    }
  }, [setCommittedZoom, zoomToFit]);

  const handleWheel = useCallback((
    deltaY: number,
    cursorNormX: number,
    cursorNormY: number,
    options: WheelZoomOptions = {},
  ) => {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const geometry = panGeometryRef.current;
    const current = resolveLiveZoom();
    const nextZoom = computeWheelZoom(current, deltaY, resolveMinimumZoom(geometry?.fitScale), options.pinch);
    if (nextZoom === current && liveZoomRef.current !== 'fit') return;

    const currentPan = livePanRef.current;
    if (!geometry) {
      applyViewportTransform(currentPan, nextZoom);
      return;
    }

    const containerWidth = options.containerWidth ?? geometry.viewportWidth;
    const containerHeight = options.containerHeight ?? geometry.viewportHeight;
    const cursorOffset = {
      x: (Math.min(1, Math.max(0, cursorNormX)) - 0.5) * containerWidth,
      y: (Math.min(1, Math.max(0, cursorNormY)) - 0.5) * containerHeight,
    };
    applyViewportTransform(computeAnchoredPan(currentPan, cursorOffset, geometry, current, nextZoom), nextZoom);
  }, [applyViewportTransform, resolveLiveZoom]);

  const startPan = useCallback((clientX: number, clientY: number) => {
    const currentPan = livePanRef.current;
    panStartRef.current = { clientX, clientY, startPan: { ...currentPan } };
  }, []);

  // Direct DOM update during drag — no React re-render
  const applyPanTransform = useCallback((nextPan: { x: number; y: number }) => {
    applyViewportTransform(nextPan);
  }, [applyViewportTransform]);

  const updatePan = useCallback((
    clientX: number,
    clientY: number,
    imageWidth: number,
    imageHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    effectiveZoom: number,
  ) => {
    const start = panStartRef.current;
    if (!start) return;

    // Store geometry for direct DOM updates. Keep the real fit scale: relative
    // zoom and 'fit' transforms depend on it.
    panGeometryRef.current = {
      imageWidth,
      imageHeight,
      viewportWidth,
      viewportHeight,
      fitScale: panGeometryRef.current?.fitScale ?? effectiveZoom,
    };

    const pannableX = Math.max(1, imageWidth * effectiveZoom - viewportWidth);
    const pannableY = Math.max(1, imageHeight * effectiveZoom - viewportHeight);
    const dx = (clientX - start.clientX) / pannableX;
    const dy = (clientY - start.clientY) / pannableY;
    const nextPan = {
      x: Math.min(1, Math.max(0, start.startPan.x - dx)),
      y: Math.min(1, Math.max(0, start.startPan.y - dy)),
    };
    applyPanTransform(nextPan);
  }, [applyPanTransform]);

  const endPan = useCallback(() => {
    panStartRef.current = null;
    // Sync ref-based pan back to React state for a single re-render
    const finalPan = livePanRef.current;
    setPan(finalPan);
  }, []);

  const commitZoom = useCallback(() => {
    setZoom(liveZoomRef.current);
    setPan(livePanRef.current);
  }, []);

  const isPanning = panStartRef.current !== null;

  return {
    zoom,
    pan,
    setPan,
    liveZoomRef,
    livePanRef,
    panTransformRef,
    panGeometryRef,
    isPanning,
    zoomToFit,
    zoomTo100,
    zoomIn,
    zoomOut,
    setZoomLevel,
    handleWheel,
    startPan,
    updatePan,
    endPan,
    commitZoom,
  };
}
