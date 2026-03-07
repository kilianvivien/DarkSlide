import React, { useState, useRef, useEffect } from 'react';
import { CurvePoint, Curves } from '../types';

interface CurvesControlProps {
  curves: Curves;
  onChange: (curves: Curves) => void;
  isColor: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

type Channel = keyof Curves;

export const CurvesControl: React.FC<CurvesControlProps> = ({ curves, onChange, isColor, onInteractionStart, onInteractionEnd }) => {
  const [activeChannel, setActiveChannel] = useState<Channel>('rgb');
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const points = curves[activeChannel];
  const size = 200;

  const handleMouseDown = (index: number) => {
    onInteractionStart?.();
    setDraggingPoint(index);
  };

  const handleMouseMove = (e: React.MouseEvent | MouseEvent) => {
    if (draggingPoint === null || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.min(255, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * 255)));
    const y = Math.min(255, Math.max(0, Math.round(255 - ((e.clientY - rect.top) / rect.height) * 255)));

    const newPoints = [...points];
    
    // Constraints: points must be ordered by x
    if (draggingPoint === 0) {
      newPoints[0] = { x: 0, y };
    } else if (draggingPoint === points.length - 1) {
      newPoints[points.length - 1] = { x: 255, y };
    } else {
      const prevX = points[draggingPoint - 1].x;
      const nextX = points[draggingPoint + 1].x;
      newPoints[draggingPoint] = { x: Math.min(nextX - 1, Math.max(prevX + 1, x)), y };
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

  const pathData = points.reduce((acc, p, i) => {
    const x = (p.x / 255) * size;
    const y = size - (p.y / 255) * size;
    return acc + (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
  }, '');

  const channelColors = {
    rgb: 'white',
    red: '#ef4444',
    green: '#22c55e',
    blue: '#3b82f6'
  };

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

      <div className="relative w-full aspect-square bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden group">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size} ${size}`}
          className="w-full h-full cursor-crosshair"
          onDoubleClick={handleDoubleClick}
        >
          {/* Grid */}
          <line x1="0" y1={size/4} x2={size} y2={size/4} stroke="#27272a" strokeWidth="1" />
          <line x1="0" y1={size/2} x2={size} y2={size/2} stroke="#27272a" strokeWidth="1" />
          <line x1="0" y1={size*0.75} x2={size} y2={size*0.75} stroke="#27272a" strokeWidth="1" />
          <line x1={size/4} y1="0" x2={size/4} y2={size} stroke="#27272a" strokeWidth="1" />
          <line x1={size/2} y1="0" x2={size/2} y2={size} stroke="#27272a" strokeWidth="1" />
          <line x1={size*0.75} y1="0" x2={size*0.75} y2={size} stroke="#27272a" strokeWidth="1" />

          {/* Curve Path */}
          <path
            d={pathData}
            fill="none"
            stroke={channelColors[activeChannel]}
            strokeWidth="2"
            className="transition-colors duration-300"
          />

          {/* Points */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={(p.x / 255) * size}
              cy={size - (p.y / 255) * size}
              r={draggingPoint === i ? 5 : 4}
              fill={channelColors[activeChannel]}
              stroke="#09090b"
              strokeWidth="2"
              className="cursor-pointer hover:r-6 transition-all"
              onMouseDown={(e) => {
                e.stopPropagation();
                handleMouseDown(i);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                removePoint(i);
              }}
            />
          ))}
        </svg>
        
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-[9px] text-zinc-600 bg-zinc-950/80 px-1.5 py-0.5 rounded border border-zinc-800">
            Double-click to add point • Right-click to remove
          </span>
        </div>
      </div>
    </div>
  );
};
