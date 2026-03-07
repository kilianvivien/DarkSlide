import { useCallback, useRef, useState } from 'react';

function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.1, z));
}

export type ZoomLevel = number | 'fit';

export interface ViewportZoomState {
  zoom: ZoomLevel;
  pan: { x: number; y: number };
}

export function useViewportZoom() {
  const [zoom, setZoom] = useState<ZoomLevel>('fit');
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 });
  const panStartRef = useRef<{ clientX: number; clientY: number; startPan: { x: number; y: number } } | null>(null);

  const zoomToFit = useCallback(() => {
    setZoom('fit');
    setPan({ x: 0.5, y: 0.5 });
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
      return {
        x: prev.x + (cursorNormX - prev.x) * blend,
        y: prev.y + (cursorNormY - prev.y) * blend,
      };
    });
  }, []);

  const startPan = useCallback((clientX: number, clientY: number) => {
    panStartRef.current = { clientX, clientY, startPan: { ...pan } };
  }, [pan]);

  const updatePan = useCallback((clientX: number, clientY: number, viewportWidth: number, viewportHeight: number, effectiveZoom: number) => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = (clientX - start.clientX) / (viewportWidth * effectiveZoom);
    const dy = (clientY - start.clientY) / (viewportHeight * effectiveZoom);
    setPan({
      x: Math.min(1, Math.max(0, start.startPan.x - dx)),
      y: Math.min(1, Math.max(0, start.startPan.y - dy)),
    });
  }, []);

  const endPan = useCallback(() => {
    panStartRef.current = null;
  }, []);

  const isPanning = panStartRef.current !== null;

  return {
    zoom,
    pan,
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
