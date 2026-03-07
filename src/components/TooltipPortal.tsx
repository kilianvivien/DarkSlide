import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  content: string;
  x: number;
  y: number;
  below: boolean;
}

/**
 * Renders a styled fixed-position tooltip for any element with a [data-tip] attribute.
 * Uses event delegation on document so no per-button wrapper is needed.
 */
export const TooltipPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;

    const show = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (target === current) return;
      current = target;
      if (!target) { setTooltip(null); return; }
      const content = target.getAttribute('data-tip');
      if (!content) return;
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const above = rect.top - 8;
      const below = rect.bottom + 8;
      setTooltip({ content, x: cx, y: above < 28 ? below : above, below: above < 28 });
    };

    const hide = (e: MouseEvent) => {
      const leaving = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (leaving && !leaving.contains(e.relatedTarget as Node | null)) {
        current = null;
        setTooltip(null);
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
          className="fixed z-[9999] pointer-events-none px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-[10px] font-mono text-zinc-300 shadow-xl max-w-[220px] leading-relaxed"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: tooltip.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
          }}
        >
          {tooltip.content}
        </div>,
        document.body
      )}
    </>
  );
};
