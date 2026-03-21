import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clamp } from '../utils/math';

interface TooltipState {
  content: string;
  rect: DOMRect;
}

interface TooltipPosition {
  left: number;
  top: number;
  below: boolean;
}

/**
 * Renders a styled fixed-position tooltip for any element with a [data-tip] attribute.
 * Uses event delegation on document so no per-button wrapper is needed.
 */
export const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) {
      setPosition(null);
      return;
    }

    const padding = 12;
    const gap = 8;
    const tooltipWidth = tooltipRef.current.offsetWidth;
    const tooltipHeight = tooltipRef.current.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const centeredLeft = tooltip.rect.left + (tooltip.rect.width / 2) - (tooltipWidth / 2);
    const left = clamp(centeredLeft, padding, Math.max(padding, viewportWidth - tooltipWidth - padding));
    const topAbove = tooltip.rect.top - gap - tooltipHeight;
    const topBelow = tooltip.rect.bottom + gap;
    const fitsAbove = topAbove >= padding;
    const fitsBelow = topBelow + tooltipHeight <= viewportHeight - padding;
    const below = !fitsAbove && fitsBelow;
    const preferredTop = below ? topBelow : topAbove;
    const top = clamp(preferredTop, padding, Math.max(padding, viewportHeight - tooltipHeight - padding));

    setPosition({
      left,
      top,
      below,
    });
  }, [tooltip]);

  useEffect(() => {
    let current: HTMLElement | null = null;

    const show = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (target === current) return;
      current = target;
      if (!target) { setTooltip(null); return; }
      const content = target.getAttribute('data-tip');
      if (!content) return;
      setTooltip({ content, rect: target.getBoundingClientRect() });
    };

    const hide = (e: MouseEvent) => {
      const leaving = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (leaving && !leaving.contains(e.relatedTarget as Node | null)) {
        current = null;
        setTooltip(null);
        setPosition(null);
      }
    };

    document.addEventListener('mouseover', show);
    document.addEventListener('mouseout', hide);
    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('mouseout', hide);
    };
  }, []);

  return (
    <>
      {children}
      {tooltip && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-[9999] pointer-events-none px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-[10px] font-mono text-zinc-300 shadow-xl max-w-[220px] leading-relaxed"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            visibility: position ? 'visible' : 'hidden',
            maxWidth: 'min(220px, calc(100vw - 24px))',
          }}
        >
          {tooltip.content}
        </div>,
        document.body
      )}
    </>
  );
};
