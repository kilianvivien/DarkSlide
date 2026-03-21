import { useCallback, useRef, useState } from 'react';

function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.1, z));
}

export type ZoomLevel = number | 'fit';

export interface ViewportZoomState {
  zoom: ZoomLevel;
  pan: { x: number; y: number };
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

  // Ref-based live pan for direct DOM updates during drag (bypasses React re-renders)
  const livePanRef = useRef({ x: 0.5, y: 0.5 });
  const panTransformRef = useRef<HTMLDivElement | null>(null);
  const panGeometryRef = useRef<{
    imageWidth: number;
    imageHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    effectiveZoom: number;
  } | null>(null);

  const zoomToFit = useCallback(() => {
    setZoom('fit');
    setPan({ x: 0.5, y: 0.5 });
    livePanRef.current = { x: 0.5, y: 0.5 };
  }, []);

  const zoomTo100 = useCallback(() => {
    setZoom(1);
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      return clampZoom(current * 1.25);
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      const next = clampZoom(current * 0.8);
      return next;
    });
  }, []);

  const setZoomLevel = useCallback((level: ZoomLevel) => {
    if (level === 'fit') {
      zoomToFit();
    } else {
      setZoom(clampZoom(level));
    }
  }, [zoomToFit]);

  const handleWheel = useCallback((
    deltaY: number,
    cursorNormX: number,
    cursorNormY: number,
  ) => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      const factor = deltaY < 0 ? 1.1 : 0.9;
      const next = clampZoom(current * factor);
      return next;
    });
    setPan((prev) => {
      const blend = 0.1;
      const next = {
        x: prev.x + (cursorNormX - prev.x) * blend,
        y: prev.y + (cursorNormY - prev.y) * blend,
      };
      livePanRef.current = next;
      return next;
    });
  }, []);

  const startPan = useCallback((clientX: number, clientY: number) => {
    const currentPan = livePanRef.current;
    panStartRef.current = { clientX, clientY, startPan: { ...currentPan } };
  }, []);

  // Direct DOM update during drag — no React re-render
  const applyPanTransform = useCallback((nextPan: { x: number; y: number }) => {
    livePanRef.current = nextPan;
    const el = panTransformRef.current;
    const geo = panGeometryRef.current;
    if (!el || !geo) return;
    const t = computePanTranslate(nextPan, geo.imageWidth, geo.imageHeight, geo.viewportWidth, geo.viewportHeight, geo.effectiveZoom);
    el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${geo.effectiveZoom})`;
  }, []);

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
    panGeometryRef.current = { imageWidth, imageHeight, viewportWidth, viewportHeight, effectiveZoom };

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

  const isPanning = panStartRef.current !== null;

  return {
    zoom,
    pan,
    setPan,
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
  };
}
