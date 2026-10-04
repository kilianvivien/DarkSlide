import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES } from '../constants';

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
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
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
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
      />,
    );

    expect(screen.getByText('Sample Film Base')).toBeInTheDocument();
  });

  it('keeps low-confidence base provenance visible and re-analyzes from the crop', () => {
    const onReanalyzeFilmBase = vi.fn();

    render(
      <Sidebar
        settings={createDefaultSettings()}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onSettingsChange={vi.fn()}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={FILM_PROFILES[0] ?? null}
        histogramData={null}
        isPickingFilmBase={false}
        estimatedFilmBase={{
          sample: { r: 91, g: 140, b: 120 },
          source: 'in-frame',
          confidence: 0.25,
          rejectedCandidates: 238,
          clamped: false,
        }}
        onTogglePicker={vi.fn()}
        onReanalyzeFilmBase={onReanalyzeFilmBase}
        onExport={vi.fn()}
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
      />,
    );

    expect(screen.getByText('In-frame estimate · 25%')).toBeInTheDocument();
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze film base outside the current crop' }));
    expect(onReanalyzeFilmBase).toHaveBeenCalledOnce();
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
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
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
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
      />,
    );

    expect(screen.getByText('Black & White')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Green')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.getAllByTestId('slider').find((slider) => slider.textContent === 'Tone')).toBeInTheDocument();
  });

  it('shows and forwards bit-depth controls for TIFF exports', () => {
    const onExportOptionsChange = vi.fn();

    render(
      <Sidebar
        settings={createDefaultSettings()}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, format: 'image/tiff', bitDepth: 16, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onLevelInteractionChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onExportOptionsChange={onExportOptionsChange}
        onColorManagementChange={vi.fn()}
        activeProfile={FILM_PROFILES[0] ?? null}
        histogramData={null}
        isPickingFilmBase={false}
        onTogglePicker={vi.fn()}
        onExport={vi.fn()}
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="export"
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '8-bit' }));
    expect(onExportOptionsChange).toHaveBeenCalledWith({ bitDepth: 8 });
  });

});

describe('Sidebar adjustment groups', () => {
  function renderDevelop(settings = createDefaultSettings(), onSettingsChange = vi.fn()) {
    const colorProfile = FILM_PROFILES.find((profile) => profile.type === 'color') ?? null;
    render(
      <Sidebar
        settings={settings}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onLevelInteractionChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={colorProfile}
        histogramData={null}
        isPickingFilmBase={false}
        onTogglePicker={vi.fn()}
        onExport={vi.fn()}
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting={false}
        activeTab="adjust"
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
      />,
    );
    return onSettingsChange;
  }

  it('switches each group off and back on through the normal settings path', () => {
    const onSettingsChange = renderDevelop();

    for (const [label, key] of [
      ['Tone', 'toneEnabled'],
      ['Range', 'toneRangeEnabled'],
      ['White Balance', 'whiteBalanceEnabled'],
      ['Color', 'colorControlsEnabled'],
    ] as const) {
      const toggle = screen.getByRole('switch', { name: `${label} adjustments` });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(toggle);
      expect(onSettingsChange).toHaveBeenLastCalledWith({ [key]: false });
    }
  });

  it('shows a switched-off group as off while keeping its sliders available', () => {
    const onSettingsChange = renderDevelop(createDefaultSettings({ toneEnabled: false }));
    const toggle = screen.getByRole('switch', { name: 'Tone adjustments' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Exposure')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ toneEnabled: true });
  });

  it('puts black and white point in Range and the RGB balance in Color', () => {
    renderDevelop();
    const range = screen.getByRole('switch', { name: 'Range adjustments' }).closest('section')!;
    const color = screen.getByRole('switch', { name: 'Color adjustments' }).closest('section')!;
    expect(range).toHaveTextContent('Black Point');
    expect(range).toHaveTextContent('White Point');
    expect(color).toHaveTextContent('Saturation');
    expect(color).toHaveTextContent('Red Balance');
  });
});
