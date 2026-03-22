import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, FILM_PROFILES } from '../constants';

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy({}, {
      get: (_, tag: string) => ReactModule.forwardRef((
        props: { children?: React.ReactNode } & Record<string, unknown>,
        ref,
      ) => {
        const { children, ...rest } = props;
        return ReactModule.createElement(tag, { ...rest, ref }, children);
      }),
    }),
  };
});

vi.mock('./Histogram', () => ({
  Histogram: () => <div data-testid="histogram" />,
}));

vi.mock('./Slider', () => ({
  Slider: ({ label }: { label: string }) => <div data-testid="slider">{label}</div>,
}));

vi.mock('./CurvesControl', () => ({
  CurvesControl: () => <div data-testid="curves" />,
}));

vi.mock('./CropPane', () => ({
  CropPane: () => <div data-testid="crop-pane" />,
}));

import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('shows film-base sampling controls for B&W profiles', () => {
    const bwProfile = FILM_PROFILES.find((profile) => profile.type === 'bw');
    expect(bwProfile).toBeTruthy();

    render(
      <Sidebar
        settings={createDefaultSettings()}
        exportOptions={{
          format: 'image/jpeg',
          quality: 0.92,
          filenameBase: 'test',
          embedMetadata: true,
          outputProfileId: 'srgb',
          embedOutputProfile: true,
        }}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onLevelInteractionChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={bwProfile ?? null}
        histogramData={null}
        isPickingFilmBase={false}
        onTogglePicker={vi.fn()}
        onExport={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        onTabChange={vi.fn()}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Sample Film Base')).toBeInTheDocument();
  });

  it('shows black-and-white conversion sliders for color profiles when enabled', () => {
    const colorProfile = FILM_PROFILES.find((profile) => profile.type === 'color');
    expect(colorProfile).toBeTruthy();

    render(
      <Sidebar
        settings={createDefaultSettings({
          blackAndWhite: {
            enabled: true,
            redMix: 0,
            greenMix: 0,
            blueMix: 0,
            tone: 0,
          },
        })}
        exportOptions={{
          format: 'image/jpeg',
          quality: 0.92,
          filenameBase: 'test',
          embedMetadata: true,
          outputProfileId: 'srgb',
          embedOutputProfile: true,
        }}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onLevelInteractionChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={colorProfile ?? null}
        histogramData={null}
        isPickingFilmBase={false}
        onTogglePicker={vi.fn()}
        onExport={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        onTabChange={vi.fn()}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Convert to Black and White')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Green')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.getByText('Tone')).toBeInTheDocument();
  });

  it('opens the custom light source form and saves a custom profile', async () => {
    const colorProfile = FILM_PROFILES.find((profile) => profile.type === 'color');
    const onLightSourceChange = vi.fn();
    const onSaveCustomLightSource = vi.fn(async () => ({
      id: 'custom-test',
      name: 'My Light',
      colorTemperature: 5400,
      spectralBias: [1, 1, 1] as [number, number, number],
      flareCharacteristic: 'medium' as const,
    }));

    render(
      <Sidebar
        settings={createDefaultSettings()}
        exportOptions={{
          format: 'image/jpeg',
          quality: 0.92,
          filenameBase: 'test',
          embedMetadata: true,
          outputProfileId: 'srgb',
          embedOutputProfile: true,
        }}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onLevelInteractionChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={colorProfile ?? null}
        lightSourceProfiles={[{
          id: 'auto',
          name: 'Auto (no correction)',
          colorTemperature: 0,
          spectralBias: [1, 1, 1],
          flareCharacteristic: 'medium',
        }]}
        histogramData={null}
        isPickingFilmBase={false}
        onTogglePicker={vi.fn()}
        onExport={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        onTabChange={vi.fn()}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
        onOpenSettings={vi.fn()}
        onLightSourceChange={onLightSourceChange}
        onSaveCustomLightSource={onSaveCustomLightSource}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Auto (no correction)'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByDisplayValue('Custom Light Source'), { target: { value: 'My Light' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSaveCustomLightSource).toHaveBeenCalledWith(expect.objectContaining({
        name: 'My Light',
      }));
      expect(onLightSourceChange).toHaveBeenCalledWith('custom-test');
    });
  });
});
