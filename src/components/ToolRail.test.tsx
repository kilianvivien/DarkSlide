import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EDITOR_TOOLS, isEditorTool, ToolRail } from './ToolRail';

describe('ToolRail', () => {
  it('lists every editor tool with its shortcut and marks the open one', () => {
    render(<ToolRail activeTool="curves" panelOpen onSelect={vi.fn()} onOpenSettings={vi.fn()} />);

    for (const tool of EDITOR_TOOLS) {
      const button = screen.getByRole('button', { name: tool.label });
      expect(button).toHaveTextContent(tool.shortcut);
      expect(button).toHaveAttribute('aria-pressed', tool.id === 'curves' ? 'true' : 'false');
    }
  });

  it('does not mark the active tool as open while the inspector is collapsed', () => {
    render(<ToolRail activeTool="curves" panelOpen={false} onSelect={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Curves' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the chosen tool and opens settings', () => {
    const onSelect = vi.fn();
    const onOpenSettings = vi.fn();
    render(<ToolRail activeTool="adjust" panelOpen onSelect={onSelect} onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Film profiles' }));
    expect(onSelect).toHaveBeenCalledWith('profiles');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('recognises stored tool ids', () => {
    expect(isEditorTool('profiles')).toBe(true);
    expect(isEditorTool('basic')).toBe(false);
    expect(isEditorTool(undefined)).toBe(false);
  });
});
