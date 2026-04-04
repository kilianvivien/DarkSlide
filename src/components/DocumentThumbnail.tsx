import { useEffect, useRef, useState } from 'react';
import { LAB_STYLE_PROFILES_MAP } from '../constants';
import { FilmProfile, LightSourceProfile, WorkspaceDocument } from '../types';
import { getResolvedInputProfileId } from '../utils/appHelpers';
import { computeHighlightDensity } from '../utils/imagePipeline';
import { ImageWorkerClient } from '../utils/imageWorkerClient';

type DocumentThumbnailProps = {
  workerClient: ImageWorkerClient | null;
  document: WorkspaceDocument;
  profile: FilmProfile | null;
  lightSource: LightSourceProfile | null;
  size?: number;
  className?: string;
};

export function DocumentThumbnail({
  workerClient,
  document,
  profile,
  lightSource,
  size = 64,
  className = '',
}: DocumentThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !workerClient || !profile || document.status === 'loading') {
      setStatus('error');
      return;
    }

    let cancelled = false;

    const renderThumbnail = async () => {
      try {
        const labStyle = document.labStyleId ? LAB_STYLE_PROFILES_MAP[document.labStyleId] ?? null : null;
        const result = await workerClient.render({
          documentId: document.id,
          settings: document.settings,
          isColor: profile.type === 'color' && !document.settings.blackAndWhite.enabled,
          filmType: profile.filmType,
          advancedInversion: profile.advancedInversion ?? null,
          inputProfileId: getResolvedInputProfileId(document.source, document.colorManagement),
          outputProfileId: document.colorManagement.outputProfileId,
          revision: document.renderRevision,
          targetMaxDimension: Math.max(96, size * 2),
          comparisonMode: 'processed',
          previewMode: 'draft',
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
          setStatus('error');
          return;
        }

        canvas.width = result.width;
        canvas.height = result.height;
        context.putImageData(result.imageData, 0, 0);
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    };

    setStatus('idle');
    void renderThumbnail();

    return () => {
      cancelled = true;
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
    size,
    workerClient,
  ]);

  return (
    <div className={`relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${className}`}>
      <canvas
        ref={canvasRef}
        className="h-full w-full object-cover"
        style={{ width: `${size}px`, height: `${size}px` }}
      />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/90 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-600">
          {status === 'error' ? 'Scan' : 'Loading'}
        </div>
      )}
    </div>
  );
}
