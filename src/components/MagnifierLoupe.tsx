import React, { useEffect, useRef, useState } from 'react';

interface MagnifierLoupeProps {
  sourceCanvas: HTMLCanvasElement | null;
  containerRef: React.RefObject<HTMLElement | null>;
  magnification: number;
  size: number;
}

interface LoupeState {
  visible: boolean;
  left: number;
  top: number;
  rgb: [number, number, number];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function MagnifierLoupe({ sourceCanvas, containerRef, magnification, size }: MagnifierLoupeProps) {
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<LoupeState>({
    visible: false,
    left: 0,
    top: 0,
    rgb: [0, 0, 0],
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const drawLoupe = () => {
      frameRef.current = null;

      const pointer = pointerRef.current;
      const loupeCanvas = loupeCanvasRef.current;
      if (!pointer || !loupeCanvas || !sourceCanvas) {
        setState((current) => (current.visible ? { ...current, visible: false } : current));
        return;
      }

      const canvasRect = sourceCanvas.getBoundingClientRect();
      if (
        pointer.x < canvasRect.left
        || pointer.x > canvasRect.right
        || pointer.y < canvasRect.top
        || pointer.y > canvasRect.bottom
      ) {
        setState((current) => (current.visible ? { ...current, visible: false } : current));
        return;
      }

      const ctx = loupeCanvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const sourceX = clamp(((pointer.x - canvasRect.left) / Math.max(canvasRect.width, 1)) * sourceCanvas.width, 0, sourceCanvas.width - 1);
      const sourceY = clamp(((pointer.y - canvasRect.top) / Math.max(canvasRect.height, 1)) * sourceCanvas.height, 0, sourceCanvas.height - 1);
      const sampleSize = size / magnification;
      const sampleLeft = sourceX - sampleSize / 2;
      const sampleTop = sourceY - sampleSize / 2;
      const clippedLeft = clamp(sampleLeft, 0, sourceCanvas.width);
      const clippedTop = clamp(sampleTop, 0, sourceCanvas.height);
      const clippedRight = clamp(sampleLeft + sampleSize, 0, sourceCanvas.width);
      const clippedBottom = clamp(sampleTop + sampleSize, 0, sourceCanvas.height);
      const clippedWidth = Math.max(0, clippedRight - clippedLeft);
      const clippedHeight = Math.max(0, clippedBottom - clippedTop);
      const destX = (clippedLeft - sampleLeft) * magnification;
      const destY = (clippedTop - sampleTop) * magnification;
      const destWidth = clippedWidth * magnification;
      const destHeight = clippedHeight * magnification;

      ctx.save();
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      if (clippedWidth > 0 && clippedHeight > 0) {
        ctx.drawImage(
          sourceCanvas,
          clippedLeft,
          clippedTop,
          clippedWidth,
          clippedHeight,
          destX,
          destY,
          destWidth,
          destHeight,
        );
      }

      const center = size / 2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(center, 0);
      ctx.lineTo(center, size);
      ctx.moveTo(0, center);
      ctx.lineTo(size, center);
      ctx.stroke();

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(center, 0);
      ctx.lineTo(center, size);
      ctx.moveTo(0, center);
      ctx.lineTo(size, center);
      ctx.stroke();
      ctx.restore();

      const loupeCtx = loupeCanvas.getContext('2d', { willReadFrequently: true });
      const centerPixel = loupeCtx?.getImageData(center, center, 1, 1).data;
      const containerRect = container.getBoundingClientRect();
      const pointerLeft = pointer.x - containerRect.left;
      const pointerTop = pointer.y - containerRect.top;
      const horizontalOffset = 28;
      const verticalOffset = 28;
      const labelAllowance = 36;
      const preferredLeft = pointerLeft + horizontalOffset;
      const fallbackLeft = pointerLeft - size - horizontalOffset;
      const preferredTop = pointerTop + verticalOffset;
      const fallbackTop = pointerTop - size - labelAllowance - verticalOffset;
      const left = preferredLeft + size <= containerRect.width - 16 ? preferredLeft : fallbackLeft;
      const top = preferredTop + size + labelAllowance <= containerRect.height - 16 ? preferredTop : fallbackTop;

      setState({
        visible: true,
        left: clamp(left, 0, Math.max(0, containerRect.width - size)),
        top: clamp(top, 0, Math.max(0, containerRect.height - size - labelAllowance)),
        rgb: centerPixel ? [centerPixel[0], centerPixel[1], centerPixel[2]] : [0, 0, 0],
      });
    };

    const queueDraw = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(drawLoupe);
      }
    };

    const hideLoupe = () => {
      pointerRef.current = null;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      setState((current) => (current.visible ? { ...current, visible: false } : current));
    };

    window.addEventListener('pointermove', queueDraw, { passive: true });
    window.addEventListener('blur', hideLoupe);

    return () => {
      window.removeEventListener('pointermove', queueDraw);
      window.removeEventListener('blur', hideLoupe);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [containerRef, magnification, size, sourceCanvas]);

  return (
    <div
      className={`pointer-events-none absolute z-30 flex flex-col items-center gap-2 transition-opacity ${state.visible ? 'opacity-100' : 'opacity-0'}`}
      style={{
        left: state.left,
        top: state.top,
        visibility: state.visible ? 'visible' : 'hidden',
      }}
    >
      <div className="overflow-hidden rounded-full border-2 border-white shadow-lg shadow-black/60">
        <canvas
          ref={loupeCanvasRef}
          width={size}
          height={size}
          className="block"
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      </div>
      <div className="rounded-full bg-zinc-950/85 px-2 py-1 font-mono text-[10px] text-zinc-100 shadow-lg shadow-black/50">
        rgb({state.rgb[0]}, {state.rgb[1]}, {state.rgb[2]})
      </div>
    </div>
  );
}
