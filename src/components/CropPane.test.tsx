import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';
import { CropPane } from './CropPane';

vi.mock('./Slider', () => ({
  Slider: () => <div data-testid="slider" />,
}));

function renderCropPane(overrides: Partial<React.ComponentProps<typeof CropPane>> = {}) {
  const settings = createDefaultSettings();

  return render(
    <CropPane
      crop={settings.crop}
      rotation={settings.rotation}
      levelAngle={settings.levelAngle}
      imageWidth={4032}
      imageHeight={6048}
      cropTab="Film"
      onCropTabChange={vi.fn()}
      onCropChange={vi.fn()}
      onRotate={vi.fn()}
      onLevelAngleChange={vi.fn()}
      onDone={vi.fn()}
      onResetCrop={vi.fn()}
      {...overrides}
    />,
  );
}

describe('CropPane', () => {
  it('renders the film tab by default with grouped format buttons', () => {
    renderCropPane();

    expect(screen.getByRole('button', { name: /free/i })).toBeInTheDocument();
    expect(screen.getAllByText('35mm')).toHaveLength(2);
    expect(screen.getByText('Medium Format')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^35mm/i })[0]).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^6×7/i })[0]).toBeInTheDocument();
  });

  it('switches print ratios through the crop callback and applies the current landscape orientation', () => {
    const onCropChange = vi.fn();

    renderCropPane({
      cropTab: 'Print',
      onCropChange,
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^2:3/i })[0]);

    expect(onCropChange).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: 3 / 2,
    }));
  });

  it('rotates crop settings through the dedicated callback', () => {
    const onRotate = vi.fn();

    renderCropPane({
      crop: {
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.5,
        aspectRatio: 3 / 2,
      },
      rotation: 90,
      onRotate,
    });

    fireEvent.click(screen.getByRole('button', { name: /rotate 90° clockwise/i }));

    expect(onRotate).toHaveBeenCalledWith(180, expect.objectContaining({
      aspectRatio: 2 / 3,
      width: 0.5,
      height: 0.7,
    }));
  });

  it('updates the level angle through the dedicated callback', () => {
    const onLevelAngleChange = vi.fn();

    renderCropPane({
      levelAngle: 1.5,
      onLevelAngleChange,
    });

    fireEvent.click(screen.getByRole('button', { name: /reset level/i }));

    expect(onLevelAngleChange).toHaveBeenCalledWith(0);
  });

  it('toggles a selected ratio between landscape and portrait', () => {
    const onCropChange = vi.fn();

    renderCropPane({
      crop: {
        x: 0.1,
        y: 0.1,
        width: 0.8,
        height: 0.8,
        aspectRatio: 3 / 2,
      },
      cropTab: 'Print',
      onCropChange,
    });

    fireEvent.click(screen.getByRole('button', { name: /2:3 switch to portrait/i }));

    expect(onCropChange).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: 2 / 3,
    }));
  });

  it('keeps custom ratio collapsed by default and expands on demand', () => {
    renderCropPane();

    expect(screen.queryByLabelText('Custom crop width')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /custom ratio/i }));

    expect(screen.getByLabelText('Custom crop width')).toBeInTheDocument();
  });

  it('applies a custom aspect ratio from numeric inputs', () => {
    const onCropChange = vi.fn();

    renderCropPane({
      onCropChange,
    });

    fireEvent.click(screen.getByRole('button', { name: /custom ratio/i }));
    fireEvent.change(screen.getByLabelText('Custom crop width'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Custom crop height'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /apply custom ratio/i }));

    expect(onCropChange).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: 20 / 30,
    }));
  });
});
