// Shared class names for the inspector panels, so every tool reads the same:
// section headings, segmented controls, field labels and the "armed" state
// of a tool that waits for a click on the image.

export const SECTION_TITLE = 'mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500';

export const FIELD_LABEL = 'text-[12px] text-zinc-300';

export const SEGMENT_TRACK = 'grid gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-1';

export function segmentItem(active: boolean): string {
  return `rounded-md px-1.5 py-1.5 text-[11px] font-medium transition-colors ${
    active
      ? 'bg-zinc-100 text-zinc-950'
      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent'
  }`;
}

/** Small header action, such as Auto or Auto WB. */
export const HEADER_ACTION = 'ml-auto flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200';

/** A tool that is armed and waiting for a click or a stroke on the image. */
export const ARMED = 'border-accent-400/70 bg-accent-400/10 text-accent-200';

/** Full-width secondary action in a panel. */
const PANEL_BUTTON_BASE = 'flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-[13px] font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60';
const PANEL_BUTTON_IDLE = 'border-zinc-800 bg-zinc-900 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800';

export const PANEL_BUTTON = `${PANEL_BUTTON_BASE} ${PANEL_BUTTON_IDLE}`;

/** A panel button for a tool that can be armed (film base picker, dust brush). */
export function panelToggleButton(armed: boolean): string {
  return `${PANEL_BUTTON_BASE} ${armed ? ARMED : PANEL_BUTTON_IDLE}`;
}


export const SELECT_INPUT = 'min-w-0 w-full truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 outline-none transition-colors focus:border-zinc-500';
