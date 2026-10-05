import { memo, ReactNode } from 'react';
import { Activity, Crop, Download, Eraser, Film, LayoutGrid, Settings, SlidersHorizontal } from 'lucide-react';
import { EditorTool } from '../types';

export const EDITOR_TOOLS: Array<{
  id: EditorTool;
  label: string;
  description: string;
  shortcut: string;
  icon: ReactNode;
  separated?: boolean;
}> = [
  { id: 'adjust', label: 'Develop', description: 'Film base, tone, white balance and color', shortcut: '1', icon: <SlidersHorizontal size={18} strokeWidth={1.8} /> },
  { id: 'curves', label: 'Curves', description: 'Tone curves per channel', shortcut: '2', icon: <Activity size={18} strokeWidth={1.8} /> },
  { id: 'profiles', label: 'Film profiles', description: 'Film stocks, custom presets and rolls', shortcut: '3', icon: <Film size={18} strokeWidth={1.8} />, separated: true },
  { id: 'crop', label: 'Crop & straighten', description: 'Crop, rotate and level', shortcut: '4', icon: <Crop size={18} strokeWidth={1.8} /> },
  { id: 'dust', label: 'Dust & scratches', description: 'Repair dust, hairs and scratches', shortcut: '5', icon: <Eraser size={18} strokeWidth={1.8} /> },
  { id: 'export', label: 'Export', description: 'Format, size and quick exports', shortcut: '6', icon: <Download size={18} strokeWidth={1.8} />, separated: true },
  { id: 'contact', label: 'Contact sheet', description: 'Lay out frames on one proof sheet', shortcut: '7', icon: <LayoutGrid size={18} strokeWidth={1.8} /> },
];

export function isEditorTool(value: unknown): value is EditorTool {
  return EDITOR_TOOLS.some((tool) => tool.id === value);
}

interface ToolRailProps {
  activeTool: EditorTool;
  panelOpen: boolean;
  /** Tools that have nothing to work on yet, such as Develop before a frame is open. */
  disabledTools?: EditorTool[];
  onSelect: (tool: EditorTool) => void;
  onOpenSettings: () => void;
}

/**
 * Vertical tool switcher. Each tool opens its panel in the inspector;
 * choosing the open tool again collapses the inspector.
 */
export const ToolRail = memo(function ToolRail({ activeTool, panelOpen, disabledTools, onSelect, onOpenSettings }: ToolRailProps) {
  return (
    <nav aria-label="Editing tools" className="flex h-full w-14 shrink-0 flex-col items-center border-r border-zinc-800 bg-zinc-950 py-3">
      {EDITOR_TOOLS.map((tool) => {
        const active = activeTool === tool.id;
        const disabled = disabledTools?.includes(tool.id) ?? false;
        const highlighted = active && panelOpen && !disabled;
        return (
          <div key={tool.id} className={tool.separated ? 'mt-2 border-t border-zinc-800 pt-2' : 'mb-1'}>
            <button
              type="button"
              aria-label={tool.label}
              aria-pressed={highlighted}
              disabled={disabled}
              data-tip={disabled
                ? `${tool.label} — open a scan first`
                : `${highlighted ? `Collapse ${tool.label}` : `${tool.label} — ${tool.description}`} (${tool.shortcut})`}
              onClick={() => onSelect(tool.id)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-[color,background-color,transform] duration-150 active:scale-95 ${
                highlighted
                  ? 'bg-zinc-800 text-zinc-100 before:absolute before:-left-2 before:inset-y-2 before:w-[3px] before:rounded-full before:bg-accent-400'
                  : disabled
                    ? 'cursor-default text-zinc-700'
                    : active
                      ? 'text-zinc-300 hover:bg-zinc-900'
                      : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {tool.icon}
              <kbd className="pointer-events-none absolute bottom-0.5 right-1 font-mono text-[8px] leading-none text-zinc-700">
                {tool.shortcut}
              </kbd>
            </button>
          </div>
        );
      })}
      <div className="mt-auto border-t border-zinc-800 pt-2">
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          data-tip="Settings (⌘,)"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
      </div>
    </nav>
  );
});
