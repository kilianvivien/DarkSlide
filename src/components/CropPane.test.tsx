import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';
import { CropPane } from './CropPane';

vi.mock('./Slider', () => ({
  Slider: () => <div data-testid="slider" />,
}));

describe('CropPane', () => {
  it('renders portrait print presets', () => {
    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
        onSettingsChange={vi.fn()}
        onDone={vi.fn()}
        onResetCrop={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /2:3/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3:4/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /4:3/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /original/i })).toBeInTheDocument();
  });

  it('keeps custom ratio collapsed by default and expands on demand', () => {
    render(
      <CropPane
        settings={createDefaultSettings()}
        imageWidth={4032}
        imageHeight={6048}
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
