import { useEffect, useRef, useState } from 'react';
import { LAB_STYLE_PROFILES_MAP } from '../constants';
import { FilmProfile, LightSourceProfile, WorkspaceDocument } from '../types';
import { getResolvedInputProfileId } from '../utils/appHelpers';
import { computeHighlightDensity } from '../utils/imagePipeline';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { usesColorChannelPipeline } from '../utils/pipelineIntent';

type DocumentThumbnailProps = {
  workerClient: ImageWorkerClient | null;
  document: WorkspaceDocument;
  profile: FilmProfile | null;
  lightSource: LightSourceProfile | null;
  size?: number;
  width?: number;
  height?: number;
  className?: string;
  isActive?: boolean;
};

export function DocumentThumbnail({
  workerClient,
  document,
  profile,
  lightSource,
  size = 64,
  width = size,
  height = size,
  className = '',
  isActive = false,
}: DocumentThumbnailProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasRenderedRef = useRef(false);
  const renderedRevisionRef = useRef<number | null>(null);
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [status, setStatus] = useState<'idle' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { rootMargin: '160px' });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!isVisible) {
      return;
    }
    if (!canvas || !workerClient || !profile) {
      if (!hasRenderedRef.current) setStatus('error');
      return;
    }
    if (document.status !== 'ready') {
      if (!hasRenderedRef.current) {
        setStatus(document.status === 'error' ? 'error' : 'idle');
      }
      return;
    }

    let cancelled = false;
    let renderTimer: number | null = null;

    const renderThumbnail = async () => {
      try {
        const labStyle = document.labStyleId ? LAB_STYLE_PROFILES_MAP[document.labStyleId] ?? null : null;
        const result = await workerClient.renderThumbnail({
          documentId: document.id,
          settings: document.settings,
          isColor: usesColorChannelPipeline(profile),
          filmType: profile.filmType,
          inputProfileId: getResolvedInputProfileId(document.source, document.colorManagement),
          outputProfileId: document.colorManagement.outputProfileId,
          revision: document.renderRevision,
          targetMaxDimension: Math.max(96, Math.max(width, height) * 2),
          comparisonMode: 'processed',
          // Match the large preview's settled pipeline. Draft renders omit the
          // pinned residual film-base correction, which can leave thumbnails
          // with a different cast from the image currently being edited.
          previewMode: 'settled',
          maskTuning: profile.maskTuning,
          colorMatrix: profile.colorMatrix,
          tonalCharacter: profile.tonalCharacter,
          labStyleToneCurve: labStyle?.toneCurve,
          labStyleChannelCurves: labStyle?.channelCurves,
          labTonalCharacterOverride: labStyle?.tonalCharacterOverride,
          labSaturationBias: labStyle?.saturationBias ?? 0,
          labTemperatureBias: labStyle?.temperatureBias ?? 0,
          highlightDensityEstimate: document.histogram ? computeHighlightDensity(document.histogram) : 0,
          flareFloor: document.estimatedFlare,
          lightSourceBias: lightSource?.spectralBias ?? [1, 1, 1],
        });

        if (cancelled) {
          return;
        }

        const context = canvas.getContext('2d');
        if (!context) {
          if (!hasRenderedRef.current) setStatus('error');
          return;
        }

        canvas.width = result.width;
        canvas.height = result.height;
        context.putImageData(result.imageData, 0, 0);
        hasRenderedRef.current = true;
        renderedRevisionRef.current = document.renderRevision;
        setStatus('ready');
      } catch {
        if (!cancelled && !hasRenderedRef.current) {
          setStatus('error');
        }
      }
    };

    const mainPreviewRevisionChanged = renderedRevisionRef.current !== null
      && renderedRevisionRef.current !== document.renderRevision;
    if (!hasRenderedRef.current) setStatus('idle');
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      void renderThumbnail();
    }, mainPreviewRevisionChanged ? 0 : (isActive ? 500 : (hasRenderedRef.current ? 220 : 0)));

    return () => {
      cancelled = true;
      if (renderTimer !== null) window.clearTimeout(renderTimer);
    };
  }, [
    document.status,
    document.id,
    document.labStyleId,
    document.settings,
    document.source,
    document.colorManagement,
    document.renderRevision,
    document.histogram,
    document.estimatedFlare,
    lightSource,
    profile,
    height,
    isActive,
    isVisible,
    width,
    workerClient,
  ]);

  return (
    <div ref={containerRef} className={`relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${className}`}>
      <canvas
        ref={canvasRef}
        className="h-full w-full object-cover"
        style={{ width: `${width}px`, height: `${height}px` }}
      />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/90 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-600">
          {status === 'error' ? 'Preview' : 'Loading'}
        </div>
      )}
    </div>
  );
}
