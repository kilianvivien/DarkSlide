import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasToolbar } from './CanvasToolbar';

function setup(props: Partial<React.ComponentProps<typeof CanvasToolbar>> = {}) {
  const handlers = {
    onSetComparisonMode: vi.fn(),
    onRotateClockwise: vi.fn(),
    onToggleCrop: vi.fn(),
    onZoomToFit: vi.fn(),
    onZoomTo100: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onSetZoom: vi.fn(),
  };
  render(
    <CanvasToolbar
      profileName="Kodak Portra 400"
      labStyleName={null}
      comparisonMode="processed"
      isCropOverlayVisible={false}
      zoom="fit"
      fitScale={0.42}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('CanvasToolbar', () => {
  it('marks a hovered profile as a preview', () => {
    setup({ profileName: 'Generic B&W', isProfilePreview: true });
    expect(screen.getByTitle('Previewing Generic B&W')).toHaveTextContent('PreviewGeneric B&W');
  });

  it('switches between the converted image and the negative', () => {
    const handlers = setup();
    expect(screen.getByRole('button', { name: 'Converted' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle before and after' }));
    expect(handlers.onSetComparisonMode).toHaveBeenCalledWith('original');
  });

  it('returns to the converted view from the negative', () => {
    const handlers = setup({ comparisonMode: 'original' });
    fireEvent.click(screen.getByRole('button', { name: 'Return to processed view' }));
    expect(handlers.onSetComparisonMode).toHaveBeenCalledWith('processed');
  });

  it('rotates, toggles crop and zooms', () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90° clockwise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show crop overlay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to 200%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to 100%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(handlers.onRotateClockwise).toHaveBeenCalledOnce();
    expect(handlers.onToggleCrop).toHaveBeenCalledOnce();
    expect(handlers.onSetZoom).toHaveBeenCalledWith(2);
    expect(handlers.onZoomTo100).toHaveBeenCalledOnce();
    expect(handlers.onZoomIn).toHaveBeenCalledOnce();
  });

  it('shows the effective zoom, using the fit scale in fit mode', () => {
    setup();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit to view' })).toHaveAttribute('aria-pressed', 'true');
  });
});
