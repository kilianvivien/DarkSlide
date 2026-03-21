import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CurvePoint, Curves } from '../types';
import { clamp } from '../utils/math';

interface CurvesControlProps {
  curves: Curves;
  onChange: (curves: Curves) => void;
  isColor: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type Channel = keyof Curves;
const CHANNEL_COLORS: Record<Channel, string> = {
  rgb: 'white',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
};

function buildPath(channelPoints: CurvePoint[], size: number) {
  return channelPoints.reduce((acc, point, index) => {
    const pointX = (point.x / 255) * size;
    const pointY = size - (point.y / 255) * size;
    return acc + (index === 0 ? `M ${pointX} ${pointY}` : ` L ${pointX} ${pointY}`);
  }, '');
}

export const CurvesControl = memo(function CurvesControl({
  curves,
  onChange,
  isColor,
  onInteractionStart,
  onInteractionEnd,
}: CurvesControlProps) {
  const [activeChannel, setActiveChannel] = useState<Channel>('rgb');
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const points = curves[activeChannel];
  const size = 200;
  const gridPositions = useMemo(() => [size / 4, size / 2, (size * 3) / 4], [size]);

  const handleMouseDown = (index: number) => {
    onInteractionStart?.();
    setDraggingPoint(index);
  };

  const handleMouseMove = (e: React.MouseEvent | MouseEvent) => {
    if (draggingPoint === null || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = clamp(Math.round(((e.clientX - rect.left) / rect.width) * 255), 0, 255);
    let y = clamp(Math.round(255 - ((e.clientY - rect.top) / rect.height) * 255), 0, 255);
    if (e.shiftKey) {
      y = clamp(Math.round(y / 16) * 16, 0, 255);
    }

    const newPoints = [...points];

    if (draggingPoint === 0) {
      newPoints[0] = {
        x: clamp(x, 0, newPoints[1].x - 1),
        y,
      };
    } else if (draggingPoint === points.length - 1) {
      newPoints[points.length - 1] = {
        x: clamp(x, newPoints[draggingPoint - 1].x + 1, 255),
        y,
      };
    } else {
      const prevX = points[draggingPoint - 1].x;
      const nextX = points[draggingPoint + 1].x;
      newPoints[draggingPoint] = { x: clamp(x, prevX + 1, nextX - 1), y };
    }

    onChange({ ...curves, [activeChannel]: newPoints });
  };

  const handleMouseUp = () => {
    setDraggingPoint(null);
    onInteractionEnd?.();
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 255);
    const y = Math.round(255 - ((e.clientY - rect.top) / rect.height) * 255);

    // Find where to insert
    let insertIndex = -1;
    for (let i = 0; i < points.length - 1; i++) {
      if (x > points[i].x && x < points[i + 1].x) {
        insertIndex = i + 1;
        break;
      }
    }

    if (insertIndex !== -1) {
      const newPoints = [...points];
      newPoints.splice(insertIndex, 0, { x, y });
      onChange({ ...curves, [activeChannel]: newPoints });
    }
  };

  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) return;
    const newPoints = [...points];
    newPoints.splice(index, 1);
    onChange({ ...curves, [activeChannel]: newPoints });
  };

  useEffect(() => {
    if (draggingPoint !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingPoint, points, activeChannel]);

  const pathData = useMemo(() => buildPath(points, size), [points, size]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
        {(['rgb', 'red', 'green', 'blue'] as Channel[]).map((ch) => {
          if (!isColor && ch !== 'rgb') return null;
          return (
            <button
              key={ch}
              onClick={() => setActiveChannel(ch)}
              className={`flex-1 py-1 text-[10px] uppercase tracking-widest rounded transition-all ${
                activeChannel === ch ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {ch}
            </button>
          );
        })}
      </div>

      <div className="relative w-full aspect-square bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden group select-none">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size} ${size}`}
          className="w-full h-full cursor-crosshair select-none"
          onDoubleClick={handleDoubleClick}
        >
          {/* Grid */}
          {gridPositions.map((position) => (
            <React.Fragment key={position}>
              <line x1="0" y1={position} x2={size} y2={position} stroke="#27272a" strokeWidth="1" />
              <line x1={position} y1="0" x2={position} y2={size} stroke="#27272a" strokeWidth="1" />
            </React.Fragment>
          ))}

          {/* Curve Path */}
          <path
            d={pathData}
            fill="none"
            stroke={CHANNEL_COLORS[activeChannel]}
            strokeWidth="2"
            className="transition-colors duration-300"
          />

          {activeChannel !== 'rgb' && (Object.entries(curves) as [Channel, CurvePoint[]][]).map(([channel, channelPoints]) => {
            if (channel === 'rgb' || channel === activeChannel) {
              return null;
            }

            return (
              <path
                key={channel}
                d={buildPath(channelPoints, size)}
                fill="none"
                stroke={CHANNEL_COLORS[channel]}
                strokeWidth="1"
                opacity="0.15"
              />
            );
          })}

          {/* Points */}
          {points.map((p, i) => (
            <g key={i}>
              <circle
                cx={(p.x / 255) * size}
                cy={size - (p.y / 255) * size}
                r={12}
                fill="transparent"
                className="cursor-pointer"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handleMouseDown(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  removePoint(i);
                }}
              />
              <circle
                cx={(p.x / 255) * size}
                cy={size - (p.y / 255) * size}
                r={draggingPoint === i ? 7 : 5}
                fill={CHANNEL_COLORS[activeChannel]}
                stroke="#09090b"
                strokeWidth="2"
                className="pointer-events-none transition-all"
              />
            </g>
          ))}

          {draggingPoint !== null && (
            <text
              x={Math.min(size - 4, ((points[draggingPoint].x / 255) * size) + 8)}
              y={Math.max(12, size - ((points[draggingPoint].y / 255) * size) - 8)}
              fill="white"
              fontSize="10"
              className="pointer-events-none select-none"
            >
              {points[draggingPoint].x}, {points[draggingPoint].y}
            </text>
          )}
        </svg>
        
        <div className="pointer-events-none absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 select-none">
          <span className="select-none text-[9px] text-zinc-600 bg-zinc-950/80 px-1.5 py-0.5 rounded border border-zinc-800">
            Double-click to add point • Right-click to remove
          </span>
        </div>
      </div>
    </div>
  );
});
