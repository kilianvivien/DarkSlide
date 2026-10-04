import { memo } from 'react';
import { LayoutGrid } from 'lucide-react';
import { ContactSheetLayout, getContactSheetCaptionColor, getContactSheetGeometry } from '../utils/contactSheetLayout';

export interface ContactSheetPreviewCell {
  id: string;
  label: string;
  thumbnailUrl: string | null;
}

interface ContactSheetPreviewProps {
  cells: ContactSheetPreviewCell[];
  layout: ContactSheetLayout;
}

/**
 * Live preview of the contact sheet in the canvas, drawn at the sheet's own
 * pixel geometry (the same as the worker's compositor) and scaled to fit.
 */
export const ContactSheetPreview = memo(function ContactSheetPreview({ cells, layout }: ContactSheetPreviewProps) {
  if (cells.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <LayoutGrid size={28} className="text-zinc-700" />
        <p className="text-sm text-zinc-400">Nothing to lay out yet.</p>
        <p className="max-w-xs text-xs leading-relaxed text-zinc-600">Open frames, or add files in the panel, to build a contact sheet.</p>
      </div>
    );
  }

  const geometry = getContactSheetGeometry(layout, cells.length);
  const cell = layout.cellMaxDimension;
  const captionColor = getContactSheetCaptionColor(layout.background);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <svg
        role="img"
        aria-label={`Contact sheet preview, ${cells.length} frames in ${geometry.columns} columns`}
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        preserveAspectRatio="xMidYMid meet"
        className="min-h-0 w-full flex-1 drop-shadow-[0_20px_40px_rgba(0,0,0,0.55)]"
      >
        <rect width={geometry.width} height={geometry.height} fill={layout.background} />
        {cells.map((entry, index) => {
          const origin = geometry.cellOrigin(index);
          return (
            <g key={entry.id}>
              {entry.thumbnailUrl ? (
                <image
                  href={entry.thumbnailUrl}
                  x={origin.x}
                  y={origin.y}
                  width={cell}
                  height={cell}
                  preserveAspectRatio="xMidYMid meet"
                />
              ) : (
                <rect x={origin.x + cell * 0.08} y={origin.y + cell * 0.2} width={cell * 0.84} height={cell * 0.6} fill="#3f3f46" opacity={0.5} />
              )}
              {layout.showCaptions && (
                <text
                  x={origin.x + cell / 2}
                  y={origin.y + cell + 8}
                  fill={captionColor}
                  fontFamily="monospace"
                  fontSize={layout.captionFontSize}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                >
                  {entry.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
        {geometry.width} × {geometry.height} px · {cells.length} {cells.length === 1 ? 'frame' : 'frames'}
      </p>
    </div>
  );
});
