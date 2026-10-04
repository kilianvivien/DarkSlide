import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExportFramesControl } from './ExportFramesControl';

function setup(props: Partial<React.ComponentProps<typeof ExportFramesControl>> = {}) {
  const handlers = { onExportCurrent: vi.fn(), onExportFrames: vi.fn(), onCancel: vi.fn() };
  const view = render(
    <ExportFramesControl selectedCount={1} totalCount={5} isExporting={false} progress={null} {...handlers} {...props} />,
  );
  return { ...handlers, ...view };
}

describe('ExportFramesControl', () => {
  it('exports the current frame by default and disables Selected without a selection', () => {
    const { onExportCurrent } = setup();
    expect(screen.getByRole('radio', { name: 'This frame' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Selected' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Export Image' }));
    expect(onExportCurrent).toHaveBeenCalledOnce();
  });

  it('follows a filmstrip multi-selection and exports that scope', () => {
    const { onExportFrames, rerender, onExportCurrent, onCancel } = setup();
    rerender(<ExportFramesControl selectedCount={3} totalCount={5} isExporting={false} progress={null} onExportCurrent={onExportCurrent} onExportFrames={onExportFrames} onCancel={onCancel} />);
    expect(screen.getByRole('radio', { name: 'Selected (3)' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Export 3 Frames' }));
    expect(onExportFrames).toHaveBeenCalledWith('selected');

    fireEvent.click(screen.getByRole('radio', { name: 'All (5)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export 5 Frames' }));
    expect(onExportFrames).toHaveBeenLastCalledWith('all');
    expect(screen.getByText(/keeps its own look/)).toBeInTheDocument();
  });

  it('shows progress with a cancel action instead of the export button', () => {
    const { onCancel } = setup({ progress: { done: 1, total: 4, currentName: 'frame-02.tiff' } });
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Exporting 2 of 4 · frame-02.tiff/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
