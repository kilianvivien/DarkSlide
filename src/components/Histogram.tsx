import { memo, useMemo } from 'react';
import { HistogramData } from '../types';

const BLEND_SCREEN = { mixBlendMode: 'screen' as const };

interface HistogramProps {
  data: HistogramData | null;
}

export const Histogram = memo(function Histogram({ data }: HistogramProps) {
  const paths = useMemo(() => {
    if (!data) return null;

    const height = 80;
    
    // Find max value across all channels for normalization
    const max = Math.max(
      ...data.r,
      ...data.g,
      ...data.b,
      ...data.l
    );

    const getPath = (channel: number[]) => {
      if (max === 0) return '';
      let path = `M 0 ${height} `;
      for (let i = 0; i < 256; i++) {
        const val = (channel[i] / max) * height;
        path += `L ${i} ${height - val} `;
      }
      path += `L 256 ${height} Z`;
      return path;
    };

    return {
      r: getPath(data.r),
      g: getPath(data.g),
      b: getPath(data.b),
      l: getPath(data.l),
    };
  }, [data]);

  if (!data || !paths) {
    return (
      <div className="w-full h-20 bg-zinc-900/50 rounded-lg border border-zinc-800 flex items-center justify-center">
        <span className="text-[10px] text-zinc-600 uppercase tracking-widest">No Data</span>
      </div>
    );
  }

  return (
    <div>
      <div className="w-full h-20 bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden relative">
        <svg
          viewBox="0 0 256 80"
          preserveAspectRatio="none"
          className="w-full h-full opacity-80"
        >
          <path d={paths.l} fill="rgba(255,255,255,0.1)" />
          <path d={paths.r} fill="rgba(239,68,68,0.3)" style={BLEND_SCREEN} />
          <path d={paths.g} fill="rgba(34,197,94,0.3)" style={BLEND_SCREEN} />
          <path d={paths.b} fill="rgba(59,130,246,0.3)" style={BLEND_SCREEN} />
        </svg>

        {/* Grid lines */}
        <div className="absolute inset-0 pointer-events-none flex justify-between px-[25%] opacity-10">
          <div className="w-px h-full bg-white" />
          <div className="w-px h-full bg-white" />
          <div className="w-px h-full bg-white" />
        </div>
      </div>

      {/* Axis + legend row */}
      <div className="flex items-center justify-between mt-1 px-0.5">
        <span className="text-[9px] font-mono text-zinc-700">0</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-white/30" />L
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500/60" />R
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500/60" />G
          </span>
          <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500/60" />B
          </span>
        </div>
        <span className="text-[9px] font-mono text-zinc-700">255</span>
      </div>
    </div>
  );
});
