import { memo, useMemo, useState } from 'react';
import { HistogramData } from '../types';
import {
  analyzeHistogram,
  buildHistogramPath,
  CLIPPING_WARNING_FRACTION,
  ClippingStats,
  formatClippingFraction,
  HistogramChannel,
} from '../utils/histogramAnalysis';

const BLEND_SCREEN = { mixBlendMode: 'screen' as const };
const CHART_HEIGHT = 80;

interface HistogramProps {
  data: HistogramData | null;
  /** 'neutral' shows luminance only, for black-and-white output. */
  variant?: 'color' | 'neutral';
}

const CHANNELS: Array<{ id: HistogramChannel; label: string; name: string; activeClass: string }> = [
  { id: 'l', label: 'L', name: 'luminance', activeClass: 'text-zinc-200' },
  { id: 'r', label: 'R', name: 'red', activeClass: 'text-red-400' },
  { id: 'g', label: 'G', name: 'green', activeClass: 'text-green-400' },
  { id: 'b', label: 'B', name: 'blue', activeClass: 'text-blue-400' },
];

function describeClipping(stats: ClippingStats, endpoint: 0 | 255, neutral: boolean) {
  const where = endpoint === 0 ? 'at 0 (shadows)' : 'at 255 (highlights)';
  if (neutral) {
    return `Pixels ${where}: ${formatClippingFraction(stats.l)}`;
  }
  return `Pixels ${where} per channel: R ${formatClippingFraction(stats.r)}, G ${formatClippingFraction(stats.g)}, B ${formatClippingFraction(stats.b)}. Luminance ${formatClippingFraction(stats.l)}.`;
}

export const Histogram = memo(function Histogram({ data, variant = 'color' }: HistogramProps) {
  const [hiddenChannels, setHiddenChannels] = useState<ReadonlySet<HistogramChannel>>(() => new Set());
  const [scale, setScale] = useState<'linear' | 'log'>('linear');

  const neutral = variant === 'neutral';
  const availableChannels = useMemo(
    () => CHANNELS.filter(({ id }) => !neutral || id === 'l'),
    [neutral],
  );
  const visibleChannels = useMemo(() => {
    const visible = availableChannels.filter(({ id }) => !hiddenChannels.has(id)).map(({ id }) => id);
    // Switching between colour and B&W must never leave an empty chart.
    return new Set<HistogramChannel>(visible.length ? visible : availableChannels.map(({ id }) => id));
  }, [availableChannels, hiddenChannels]);

  const analysis = useMemo(() => (data ? analyzeHistogram(data) : null), [data]);

  const paths = useMemo(() => {
    if (!data) return null;
    let max = 0;
    for (const channel of visibleChannels) {
      for (const value of data[channel]) {
        if (value > max) max = value;
      }
    }
    return {
      l: buildHistogramPath(data.l, max, CHART_HEIGHT, scale),
      r: buildHistogramPath(data.r, max, CHART_HEIGHT, scale),
      g: buildHistogramPath(data.g, max, CHART_HEIGHT, scale),
      b: buildHistogramPath(data.b, max, CHART_HEIGHT, scale),
    };
  }, [data, scale, visibleChannels]);

  const toggleChannel = (channel: HistogramChannel) => {
    setHiddenChannels((current) => {
      const next = new Set(current);
      if (next.has(channel)) {
        next.delete(channel);
      } else if (visibleChannels.size > 1) {
        next.add(channel);
      }
      return next;
    });
  };

  if (!data || !paths || !analysis) {
    return (
      <div className="w-full h-20 bg-zinc-900/50 rounded-lg border border-zinc-800 flex items-center justify-center">
        <span className="text-[10px] text-zinc-600 uppercase tracking-widest">No Data</span>
      </div>
    );
  }

  const shadowFraction = neutral ? analysis.shadows.l : analysis.shadows.worstChannel;
  const highlightFraction = neutral ? analysis.highlights.l : analysis.highlights.worstChannel;
  const shadowsClipped = shadowFraction > CLIPPING_WARNING_FRACTION;
  const highlightsClipped = highlightFraction > CLIPPING_WARNING_FRACTION;
  const formatLevel = (value: number | null) => (value === null ? '—' : value);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Histogram channels">
          {availableChannels.map((channel) => {
            const active = visibleChannels.has(channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                aria-label={`Show ${channel.name} histogram`}
                aria-pressed={active}
                onClick={() => toggleChannel(channel.id)}
                className={`flex h-4 min-w-4 items-center justify-center rounded border px-1 font-mono text-[9px] transition-colors ${active ? `border-zinc-700 bg-zinc-800 ${channel.activeClass}` : 'border-zinc-900 text-zinc-700 hover:text-zinc-500'}`}
              >
                {channel.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-label="Logarithmic histogram scale"
            aria-pressed={scale === 'log'}
            data-tip={scale === 'log' ? 'Logarithmic height scale: small counts are exaggerated. Click for linear.' : 'Linear height scale. Click for logarithmic, which reveals small counts.'}
            onClick={() => setScale((current) => (current === 'log' ? 'linear' : 'log'))}
            className={`ml-1 flex h-4 items-center justify-center rounded border px-1 font-mono text-[9px] transition-colors ${scale === 'log' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-zinc-900 text-zinc-600 hover:text-zinc-400'}`}
          >
            LOG
          </button>
        </div>
        <div className="flex gap-2 font-mono text-[9px] tabular-nums text-zinc-600">
          <span
            data-testid="histogram-shadow-clipping"
            data-tip={describeClipping(analysis.shadows, 0, neutral)}
            aria-label={describeClipping(analysis.shadows, 0, neutral)}
            className={shadowsClipped ? 'text-red-400' : ''}
          >
            ◀ {formatClippingFraction(shadowFraction)}
          </span>
          <span
            data-testid="histogram-highlight-clipping"
            data-tip={describeClipping(analysis.highlights, 255, neutral)}
            aria-label={describeClipping(analysis.highlights, 255, neutral)}
            className={highlightsClipped ? 'text-red-400' : ''}
          >
            {formatClippingFraction(highlightFraction)} ▶
          </span>
        </div>
      </div>

      <div className="w-full h-20 bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden relative">
        <svg
          viewBox={`0 0 256 ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="w-full h-full opacity-80"
          aria-hidden="true"
        >
          {visibleChannels.has('l') && <path d={paths.l} fill="rgba(255,255,255,0.1)" />}
          {visibleChannels.has('r') && <path d={paths.r} fill="rgba(239,68,68,0.3)" style={BLEND_SCREEN} />}
          {visibleChannels.has('g') && <path d={paths.g} fill="rgba(34,197,94,0.3)" style={BLEND_SCREEN} />}
          {visibleChannels.has('b') && <path d={paths.b} fill="rgba(59,130,246,0.3)" style={BLEND_SCREEN} />}
        </svg>

        {shadowsClipped && <div className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-red-500/70" />}
        {highlightsClipped && <div className="pointer-events-none absolute inset-y-0 right-0 w-0.5 bg-red-500/70" />}

        {/* Grid lines */}
        <div className="absolute inset-0 pointer-events-none flex justify-between px-[25%] opacity-10">
          <div className="w-px h-full bg-white" />
          <div className="w-px h-full bg-white" />
          <div className="w-px h-full bg-white" />
        </div>
      </div>

      <div
        className="mt-1 grid grid-cols-3 px-0.5 font-mono text-[9px] tabular-nums text-zinc-600"
        data-tip="Luminance percentiles of the rendered preview (0–255)"
      >
        <span>P1 {formatLevel(analysis.p1)}</span>
        <span className="text-center">Median {formatLevel(analysis.median)}</span>
        <span className="text-right">P99 {formatLevel(analysis.p99)}</span>
      </div>
    </div>
  );
});
