import { memo } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { EditorTool } from '../types';
import { EDITOR_TOOLS } from './ToolRail';

interface InspectorHeaderProps {
  tool: EditorTool;
  onCollapse: () => void;
}

/**
 * Title row shared by every inspector panel. It sits at the same height as
 * the window's title bar so the two read as one line across the app.
 */
export const InspectorHeader = memo(function InspectorHeader({ tool, onCollapse }: InspectorHeaderProps) {
  const meta = EDITOR_TOOLS.find((entry) => entry.id === tool);
  const label = meta?.label ?? '';

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 pl-5 pr-2">
      <h2 className="min-w-0 truncate text-[13px] font-semibold text-zinc-100">{label}</h2>
      {meta && (
        <kbd className="rounded border border-zinc-800 px-1 font-mono text-[9px] leading-4 text-zinc-600">{meta.shortcut}</kbd>
      )}
      <button
        type="button"
        onClick={onCollapse}
        aria-label={`Collapse ${label}`}
        data-tip="Hide panel"
        className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
      >
        <PanelLeftClose size={15} />
      </button>
    </div>
  );
});
