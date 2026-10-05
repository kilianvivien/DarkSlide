import React, { memo, useId, useMemo, useState } from 'react';
import { HistogramData } from '../types';
import {
  analyzeHistogram,
  buildHistogramShape,
  CLIPPING_WARNING_FRACTION,
  ClippingStats,
  formatClippingFraction,
  histogramDisplayPeak,
  HistogramChannel,
} from '../utils/histogramAnalysis';

const CHART_HEIGHT = 96;

/** Fill and outline colour per channel; drawn in this order, luminance first. */
const CHANNEL_STYLE: Record<HistogramChannel, { color: string; fill: number; stroke: number }> = {
  l: { color: '#e4e4e7', fill: 0.16, stroke: 0.55 },
  r: { color: '#f87171', fill: 0.42, stroke: 0.9 },
  g: { color: '#4ade80', fill: 0.42, stroke: 0.9 },
  b: { color: '#60a5fa', fill: 0.42, stroke: 0.9 },
};
const DRAW_ORDER: HistogramChannel[] = ['l', 'r', 'g', 'b'];

interface HistogramProps {
  data: HistogramData | null;
  /** 'neutral' shows luminance only, for black-and-white output. */
  variant?: 'color' | 'neutral';
}

const CHANNELS: Array<{ id: HistogramChannel; label: string; name: string; activeClass: string }> = [
  { id: 'l', label: 'L', name: 'luminance', activeClass: 'text-zinc-100' },
  { id: 'r', label: 'R', name: 'red', activeClass: 'text-red-300' },
  { id: 'g', label: 'G', name: 'green', activeClass: 'text-green-300' },
  { id: 'b', label: 'B', name: 'blue', activeClass: 'text-blue-300' },
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
  const [scale, setScale] = useState<'linear' | 'log'>('log');

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

  const shapes = useMemo(() => {
    if (!data) return null;
    const peak = histogramDisplayPeak(data, visibleChannels);
    return {
      l: buildHistogramShape(data.l, peak, CHART_HEIGHT, scale),
      r: buildHistogramShape(data.r, peak, CHART_HEIGHT, scale),
      g: buildHistogramShape(data.g, peak, CHART_HEIGHT, scale),
      b: buildHistogramShape(data.b, peak, CHART_HEIGHT, scale),
    };
  }, [data, scale, visibleChannels]);

  const gradientId = useId();
  const [hoverLevel, setHoverLevel] = useState<number | null>(null);

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

  if (!data || !shapes || !analysis) {
    return (
      <div className="flex h-[118px] w-full items-center justify-center rounded-lg border border-zinc-800/80 bg-zinc-950/60">
        <span className="text-[10px] text-zinc-600 uppercase tracking-widest">No Data</span>
      </div>
    );
  }

  const shadowFraction = neutral ? analysis.shadows.l : analysis.shadows.worstChannel;
  const highlightFraction = neutral ? analysis.highlights.l : analysis.highlights.worstChannel;
  const shadowsClipped = shadowFraction > CLIPPING_WARNING_FRACTION;
  const highlightsClipped = highlightFraction > CLIPPING_WARNING_FRACTION;
  const formatLevel = (value: number | null) => (value === null ? '—' : value);

  const hoverReadout = hoverLevel === null || analysis.total <= 0
    ? null
    : availableChannels
      .filter(({ id }) => visibleChannels.has(id))
      .map(({ id, label, activeClass }) => ({
        id,
        label,
        activeClass,
        share: formatClippingFraction((data[id][hoverLevel] ?? 0) / analysis.total),
      }));

  const trackHover = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const level = Math.round(((event.clientX - rect.left) / rect.width) * 255);
    setHoverLevel(Math.max(0, Math.min(255, level)));
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-md border border-zinc-800 bg-zinc-950/70 p-0.5" role="group" aria-label="Histogram channels">
            {availableChannels.map((channel) => {
              const active = visibleChannels.has(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  aria-label={`Show ${channel.name} histogram`}
                  aria-pressed={active}
                  onClick={() => toggleChannel(channel.id)}
                  className={`flex h-5 min-w-5 items-center justify-center gap-1 rounded px-1.5 font-mono text-[10px] font-medium transition-colors ${active ? `bg-zinc-800 ${channel.activeClass}` : 'text-zinc-600 hover:text-zinc-400'}`}
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full transition-opacity"
                    style={{ backgroundColor: CHANNEL_STYLE[channel.id].color, opacity: active ? 1 : 0.3 }}
                  />
                  {channel.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Logarithmic histogram scale"
            aria-pressed={scale === 'log'}
            data-tip={scale === 'log' ? 'Logarithmic height scale: small counts are exaggerated. Click for linear.' : 'Linear height scale. Click for logarithmic, which reveals small counts.'}
            onClick={() => setScale((current) => (current === 'log' ? 'linear' : 'log'))}
            className={`flex h-6 items-center justify-center rounded-md border px-1.5 font-mono text-[10px] font-medium transition-colors ${scale === 'log' ? 'border-accent-500/40 bg-accent-500/10 text-accent-300' : 'border-zinc-800 text-zinc-600 hover:text-zinc-400'}`}
          >
            LOG
          </button>
        </div>
        <div className="flex gap-2.5 font-mono text-[10px] tabular-nums text-zinc-500">
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

      <div
        className="relative h-24 w-full cursor-crosshair overflow-hidden rounded-t-lg border border-b-0 border-zinc-800/80 bg-[radial-gradient(120%_100%_at_50%_100%,rgba(39,39,42,0.55),rgba(9,9,11,0.95))]"
        onPointerMove={trackHover}
        onPointerLeave={() => setHoverLevel(null)}
      >
        {/* Zone guides at quarter tones */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          {[25, 50, 75].map((position) => (
            <span key={position} className="absolute inset-y-0 w-px bg-white/[0.05]" style={{ left: `${position}%` }} />
          ))}
          <span className="absolute inset-x-0 top-1/2 h-px bg-white/[0.03]" />
        </div>

        <svg
          viewBox={`0 0 256 ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          <defs>
            {DRAW_ORDER.map((channel) => (
              <linearGradient key={channel} id={`${gradientId}-${channel}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHANNEL_STYLE[channel].color} stopOpacity={CHANNEL_STYLE[channel].fill} />
                <stop offset="100%" stopColor={CHANNEL_STYLE[channel].color} stopOpacity={CHANNEL_STYLE[channel].fill * 0.25} />
              </linearGradient>
            ))}
          </defs>
          <g style={{ mixBlendMode: 'screen' }}>
            {DRAW_ORDER.filter((channel) => visibleChannels.has(channel)).map((channel) => (
              <g key={channel}>
                <path d={shapes[channel].area} fill={`url(#${gradientId}-${channel})`} />
                <path
                  d={shapes[channel].line}
                  fill="none"
                  stroke={CHANNEL_STYLE[channel].color}
                  strokeOpacity={CHANNEL_STYLE[channel].stroke}
                  strokeWidth={1.25}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </g>
        </svg>

        {shadowsClipped && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-red-500/45 to-transparent" aria-hidden="true">
            <span className="absolute left-0 top-0 h-full w-0.5 bg-red-400" />
          </div>
        )}
        {highlightsClipped && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-red-500/45 to-transparent" aria-hidden="true">
            <span className="absolute right-0 top-0 h-full w-0.5 bg-red-400" />
          </div>
        )}

        {hoverLevel !== null && (
          <span
            className="pointer-events-none absolute inset-y-0 w-px bg-accent-300/70"
            style={{ left: `${(hoverLevel / 255) * 100}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {/* Tonal scale: where each part of the chart sits from black to white */}
      <div className="h-1.5 w-full rounded-b-lg border border-t-0 border-zinc-800/80 bg-gradient-to-r from-black via-zinc-500 to-white" aria-hidden="true" />

      <div
        className="mt-1.5 grid h-4 grid-cols-3 items-center px-0.5 font-mono text-[10px] tabular-nums text-zinc-500"
        data-tip={hoverReadout ? undefined : 'Luminance percentiles of the rendered preview (0–255)'}
      >
        {hoverReadout ? (
          <>
            <span className="text-zinc-300">Level {hoverLevel}</span>
            <span className="col-span-2 flex justify-end gap-2">
              {hoverReadout.map(({ id, label, activeClass, share }) => (
                <span key={id} className={activeClass}>{label} {share}</span>
              ))}
            </span>
          </>
        ) : (
          <>
            <span>P1 {formatLevel(analysis.p1)}</span>
            <span className="text-center">Median {formatLevel(analysis.median)}</span>
            <span className="text-right">P99 {formatLevel(analysis.p99)}</span>
          </>
        )}
      </div>
    </div>
  );
});
