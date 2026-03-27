import { useCallback, useRef, useState } from 'react';
import type { ZoomLevel } from '../types';

function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.1, z));
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

  const zoomIn = useCallback(() => {
    const current = liveZoomRef.current === 'fit' ? 1 : liveZoomRef.current;
    setCommittedZoom(clampZoom(current * 1.25));
  }, [setCommittedZoom]);

  const zoomOut = useCallback(() => {
    const current = liveZoomRef.current === 'fit' ? 1 : liveZoomRef.current;
    setCommittedZoom(clampZoom(current * 0.8));
  }, [setCommittedZoom]);

  const setZoomLevel = useCallback((level: ZoomLevel) => {
    if (level === 'fit') {
      zoomToFit();
    } else {
      setCommittedZoom(clampZoom(level));
    }
  }, [setCommittedZoom, zoomToFit]);

  const handleWheel = useCallback((
    deltaY: number,
    cursorNormX: number,
    cursorNormY: number,
  ) => {
    const current = liveZoomRef.current === 'fit' ? 1 : liveZoomRef.current;
    const factor = deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = clampZoom(current * factor);
    const currentPan = livePanRef.current;
    const blend = 0.1;
    const nextPan = {
      x: currentPan.x + (cursorNormX - currentPan.x) * blend,
      y: currentPan.y + (cursorNormY - currentPan.y) * blend,
    };
    applyViewportTransform(nextPan, nextZoom);
  }, [applyViewportTransform]);

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

    // Store geometry for direct DOM updates
    panGeometryRef.current = { imageWidth, imageHeight, viewportWidth, viewportHeight, fitScale: effectiveZoom };

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
