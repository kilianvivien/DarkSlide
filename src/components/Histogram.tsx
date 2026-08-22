import { memo, useMemo, useState } from 'react';
import { HistogramData } from '../types';

const BLEND_SCREEN = { mixBlendMode: 'screen' as const };

interface HistogramProps {
  data: HistogramData | null;
  variant?: 'color' | 'neutral';
  blackPoint?: number;
  whitePoint?: number;
}

type HistogramChannel = 'l' | 'r' | 'g' | 'b';

function percentile(bins: number[], fraction: number) {
  const total = bins.reduce((sum, value) => sum + value, 0);
  const target = total * fraction;
  let seen = 0;
  for (let index = 0; index < bins.length; index += 1) {
    seen += bins[index];
    if (seen >= target) return index;
  }
  return 255;
}

function percentage(value: number, total: number) {
  if (total <= 0 || value <= 0) return '0%';
  const result = (value / total) * 100;
  return result < 0.1 ? '<0.1%' : `${result.toFixed(result < 10 ? 1 : 0)}%`;
}

export const Histogram = memo(function Histogram({ data, variant = 'color', blackPoint, whitePoint }: HistogramProps) {
  const [visibleChannels, setVisibleChannels] = useState<Set<HistogramChannel>>(
    () => new Set(variant === 'neutral' ? ['l'] : ['l', 'r', 'g', 'b']),
  );
  const analysis = useMemo(() => {
    if (!data) return null;

    const height = 84;
    const available: HistogramChannel[] = variant === 'neutral' ? ['l'] : ['l', 'r', 'g', 'b'];
    const visible = available.filter((channel) => visibleChannels.has(channel));
    const max = Math.max(1, ...visible.flatMap((channel) => data[channel]));
    const logMax = Math.log1p(max);

    const getPath = (channel: number[]) => {
      let path = `M 0 ${height}`;
      for (let index = 0; index < 256; index += 1) {
        const normalized = Math.log1p(channel[index]) / logMax;
        path += ` L ${index} ${height - normalized * height}`;
      }
      return `${path} L 255 ${height} Z`;
    };

    const total = data.l.reduce((sum, value) => sum + value, 0);
    const shadowClipped = data.l[0] + data.l[1];
    const highlightClipped = data.l[254] + data.l[255];

    return {
      paths: { r: getPath(data.r), g: getPath(data.g), b: getPath(data.b), l: getPath(data.l) },
      p1: percentile(data.l, 0.01),
      median: percentile(data.l, 0.5),
      p99: percentile(data.l, 0.99),
      shadowClipLabel: percentage(shadowClipped, total),
      highlightClipLabel: percentage(highlightClipped, total),
      shadowsClipped: shadowClipped > total * 0.001,
      highlightsClipped: highlightClipped > total * 0.001,
    };
  }, [data, variant, visibleChannels]);

  const toggleChannel = (channel: HistogramChannel) => {
    setVisibleChannels((current) => {
      const next = new Set(current);
      if (next.has(channel) && next.size > 1) next.delete(channel);
      else next.add(channel);
      return next;
    });
  };

  if (!data || !analysis) {
    return (
      <div className="w-full h-20 bg-zinc-900/50 rounded-lg border border-zinc-800 flex items-center justify-center">
        <span className="text-[10px] text-zinc-600 uppercase tracking-widest">No Data</span>
      </div>
    );
  }

  const channelButtons: Array<{ id: HistogramChannel; label: string; activeClass: string }> = [
    { id: 'l', label: 'L', activeClass: 'text-zinc-200' },
    { id: 'r', label: 'R', activeClass: 'text-red-400' },
    { id: 'g', label: 'G', activeClass: 'text-green-400' },
    { id: 'b', label: 'B', activeClass: 'text-blue-400' },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1" aria-label="Histogram channels">
          {channelButtons.filter(({ id }) => variant === 'color' || id === 'l').map((channel) => {
            const active = visibleChannels.has(channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                aria-label={`Toggle ${channel.label} histogram channel`}
                aria-pressed={active}
                onClick={() => toggleChannel(channel.id)}
                className={`flex h-5 min-w-5 items-center justify-center rounded border px-1 font-mono text-[8px] ${active ? `border-zinc-700 bg-zinc-800 ${channel.activeClass}` : 'border-zinc-900 text-zinc-700'}`}
              >
                {channel.label}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 font-mono text-[8px] text-zinc-600">
          <span className={analysis.shadowsClipped ? 'text-red-400' : ''}>◀ {analysis.shadowClipLabel}</span>
          <span className={analysis.highlightsClipped ? 'text-red-400' : ''}>{analysis.highlightClipLabel} ▶</span>
        </div>
      </div>

      <div className="relative h-24 w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#09090b]">
        <div className="pointer-events-none absolute inset-0 grid grid-cols-4">
          <span className="border-r border-zinc-800/60" />
          <span className="border-r border-zinc-800/60" />
          <span className="border-r border-zinc-800/60" />
        </div>
        <svg viewBox="0 0 256 84" preserveAspectRatio="none" className="h-full w-full">
          {visibleChannels.has('l') && <path d={analysis.paths.l} fill="rgba(212,212,216,0.22)" stroke="rgba(228,228,231,0.45)" strokeWidth="0.7" />}
          {variant === 'color' && visibleChannels.has('r') && <path d={analysis.paths.r} fill="rgba(239,68,68,0.2)" stroke="rgba(248,113,113,0.45)" strokeWidth="0.5" style={BLEND_SCREEN} />}
          {variant === 'color' && visibleChannels.has('g') && <path d={analysis.paths.g} fill="rgba(34,197,94,0.2)" stroke="rgba(74,222,128,0.45)" strokeWidth="0.5" style={BLEND_SCREEN} />}
          {variant === 'color' && visibleChannels.has('b') && <path d={analysis.paths.b} fill="rgba(59,130,246,0.2)" stroke="rgba(96,165,250,0.5)" strokeWidth="0.5" style={BLEND_SCREEN} />}
        </svg>
        {blackPoint !== undefined && <div className="pointer-events-none absolute inset-y-0 border-l border-amber-300/70" style={{ left: `${(blackPoint / 255) * 100}%` }}><span className="absolute left-1 top-1 font-mono text-[7px] text-amber-300/80">B</span></div>}
        {whitePoint !== undefined && <div className="pointer-events-none absolute inset-y-0 border-l border-amber-300/70" style={{ left: `${(whitePoint / 255) * 100}%` }}><span className="absolute right-1 top-1 font-mono text-[7px] text-amber-300/80">W</span></div>}
      </div>

      <div className="grid grid-cols-3 font-mono text-[8px] tabular-nums text-zinc-600">
        <span>P1 {analysis.p1}</span>
        <span className="text-center">Median {analysis.median}</span>
        <span className="text-right">P99 {analysis.p99}</span>
      </div>
    </div>
  );
});
