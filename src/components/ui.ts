// Shared class names for the inspector panels, so every tool reads the same:
// section headings, segmented controls, field labels and the "armed" state
// of a tool that waits for a click on the image.

export const SECTION_TITLE = 'mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500';

export const FIELD_LABEL = 'text-[11px] font-medium uppercase tracking-wider text-zinc-400';

export const SEGMENT_TRACK = 'grid gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-1';

export function segmentItem(active: boolean): string {
  return `rounded-md px-1.5 py-1.5 text-[11px] font-medium transition-colors ${
    active
      ? 'bg-zinc-100 text-zinc-950'
      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent'
  }`;
}

/** Small header action, such as Auto or Auto WB. */
export const HEADER_ACTION = 'ml-auto flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200';

/** Full-width secondary action in a panel. */
export const PANEL_BUTTON = 'flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[13px] font-medium text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60';

/** A tool that is armed and waiting for a click or a stroke on the image. */
export const ARMED = 'border-amber-400/70 bg-amber-400/10 text-amber-200';

export const SELECT_INPUT = 'min-w-0 w-full truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 outline-none transition-colors focus:border-zinc-500';
