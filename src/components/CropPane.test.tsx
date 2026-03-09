import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';
import { CropPane } from './CropPane';

vi.mock('./Slider', () => ({
  Slider: () => <div data-testid="slider" />,
}));

describe('CropPane', () => {
  it('renders the film tab by default with grouped format buttons', () => {
    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /free/i })).toBeInTheDocument();
    expect(screen.getAllByText('35mm')).toHaveLength(2);
    expect(screen.getByText('Medium Format')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^35mm/i })[0]).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^6×7/i })[0]).toBeInTheDocument();
  });

  it('switches print ratios through the tab callback and applies the current landscape orientation', () => {
    const onSettingsChange = vi.fn();

    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
        cropTab="Print"
        onCropTabChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /^2:3/i })[0]);

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      crop: expect.objectContaining({
        aspectRatio: 3 / 2,
      }),
    }));
  });

  it('toggles a selected ratio between landscape and portrait', () => {
    const onSettingsChange = vi.fn();

    render(
      <CropPane
        settings={createDefaultSettings({
          crop: {
            x: 0.1,
            y: 0.1,
            width: 0.8,
            height: 0.8,
            aspectRatio: 3 / 2,
          },
        })}
        imageWidth={4032}
        imageHeight={6048}
        cropTab="Print"
        onCropTabChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /2:3 switch to portrait/i }));

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      crop: expect.objectContaining({
        aspectRatio: 2 / 3,
      }),
    }));
  });

  it('keeps custom ratio collapsed by default and expands on demand', () => {
    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Custom crop width')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /custom ratio/i }));

    expect(screen.getByLabelText('Custom crop width')).toBeInTheDocument();
  });

  it('applies a custom aspect ratio from numeric inputs', () => {
    const onSettingsChange = vi.fn();

    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom ratio/i }));
    fireEvent.change(screen.getByLabelText('Custom crop width'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Custom crop height'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /apply custom ratio/i }));

    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      crop: expect.objectContaining({
        aspectRatio: 20 / 30,
      }),
    }));
  });
});
