import { useEffect, useRef } from 'react';
import { NormalizedPreviewRect } from '../utils/zoomRegionPreview';
import { createRegionRenderer, RegionRenderer } from '../utils/webglRegionRenderer';

export interface ZoomRegionPreview {
  requestKey: string;
  imageData: ImageData;
  rect: NormalizedPreviewRect;
}

export function WebGLZoomRegion({ preview }: { preview: ZoomRegionPreview }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RegionRenderer | null>(null);

  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.hidden = false;
    try {
      const renderer = rendererRef.current ?? createRegionRenderer(canvas);
      rendererRef.current = renderer;
      renderer.draw(preview.imageData);
    } catch {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      canvas.hidden = true;
    }
  }, [preview.imageData]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="webgl-zoom-region"
      className="pointer-events-none absolute"
      style={{
        left: `${preview.rect.x * 100}%`,
        top: `${preview.rect.y * 100}%`,
        width: `${preview.rect.width * 100}%`,
        height: `${preview.rect.height * 100}%`,
      }}
    />
  );
}
