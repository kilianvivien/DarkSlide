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
  it('resets each adjustment section to the active profile defaults without crossing section boundaries', () => {
    const sourceProfile = FILM_PROFILES.find((profile) => profile.id === 'portra-400');
    const activeProfile = sourceProfile ? {
      ...sourceProfile,
      defaultSettings: createDefaultSettings({
        ...sourceProfile.defaultSettings,
        rotation: 90,
        levelAngle: 1.5,
        lensDistortion: 7,
        crop: { x: 0.1, y: 0.12, width: 0.8, height: 0.74, aspectRatio: null },
      }),
    } : null;
    const onSettingsChange = vi.fn();
    expect(activeProfile).toBeTruthy();

    render(
      <Sidebar
        settings={createDefaultSettings({
          exposure: -20,
          contrast: 50,
          saturation: 70,
          highlightProtection: 80,
          shadowRecovery: 65,
          blackPoint: 34,
          whitePoint: 220,
          midtoneContrast: 42,
          temperature: -30,
          tint: 18,
          redBalance: 0.8,
          greenBalance: 1.2,
          blueBalance: 1.3,
        })}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onSettingsChange={onSettingsChange}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={activeProfile ?? null}
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

    fireEvent.click(screen.getByRole('button', { name: 'Reset develop adjustments' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      exposure: activeProfile?.defaultSettings.exposure,
      contrast: activeProfile?.defaultSettings.contrast,
      saturation: activeProfile?.defaultSettings.saturation,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset balance' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      redBalance: activeProfile?.defaultSettings.redBalance,
      greenBalance: activeProfile?.defaultSettings.greenBalance,
      blueBalance: activeProfile?.defaultSettings.blueBalance,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset geometry' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      rotation: 90,
      levelAngle: 1.5,
      lensDistortion: 7,
      crop: { x: 0.1, y: 0.12, width: 0.8, height: 0.74, aspectRatio: null },
    });

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Reset tone adjustments' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      exposure: activeProfile?.defaultSettings.exposure,
      contrast: activeProfile?.defaultSettings.contrast,
      highlightProtection: activeProfile?.defaultSettings.highlightProtection,
      shadowRecovery: activeProfile?.defaultSettings.shadowRecovery,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset tone range adjustments' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      blackPoint: activeProfile?.defaultSettings.blackPoint,
      whitePoint: activeProfile?.defaultSettings.whitePoint,
      midtoneContrast: activeProfile?.defaultSettings.midtoneContrast,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset white balance' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      temperature: activeProfile?.defaultSettings.temperature,
      tint: activeProfile?.defaultSettings.tint,
      redBalance: activeProfile?.defaultSettings.redBalance,
      greenBalance: activeProfile?.defaultSettings.greenBalance,
      blueBalance: activeProfile?.defaultSettings.blueBalance,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Color controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset color balance' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      saturation: activeProfile?.defaultSettings.saturation,
      redBalance: activeProfile?.defaultSettings.redBalance,
      greenBalance: activeProfile?.defaultSettings.greenBalance,
      blueBalance: activeProfile?.defaultSettings.blueBalance,
    });
  });

  it('starts in a compact basic view and forwards its primary actions', () => {
    const colorProfile = FILM_PROFILES.find((profile) => profile.type === 'color');
    const onSettingsChange = vi.fn();
    const onProfileChange = vi.fn();
    const onTabChange = vi.fn();
    const onRedetectFrame = vi.fn();
    const onAutoLensDistortion = vi.fn();

    const renderSidebar = (sourceId: string) => (
      <Sidebar
        settings={createDefaultSettings()}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={{ id: sourceId, name: `${sourceId}.tiff`, mime: 'image/tiff', extension: 'tiff', size: 1, width: 300, height: 200 }}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onSettingsChange={onSettingsChange}
        onExportOptionsChange={vi.fn()}
        onColorManagementChange={vi.fn()}
        activeProfile={colorProfile ?? null}
        filmProfiles={FILM_PROFILES}
        onProfileChange={onProfileChange}
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
        onTabChange={onTabChange}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onRedetectFrame={onRedetectFrame}
        onAutoLensDistortion={onAutoLensDistortion}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    const { rerender } = render(renderSidebar('source-1'));

    expect(screen.getByRole('button', { name: /basic/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Density')).toBeInTheDocument();
    expect(screen.getByText('Histogram')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.queryByText('Curve')).not.toBeInTheDocument();
    expect(screen.getByText('Geometry')).toBeInTheDocument();
    expect(screen.queryByText('Shadow Recovery')).not.toBeInTheDocument();

    const alternateProfile = FILM_PROFILES.find((profile) => profile.id !== colorProfile?.id);
    expect(alternateProfile).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Film profile' }), { target: { value: alternateProfile?.id } });
    expect(onProfileChange).toHaveBeenCalledWith(alternateProfile);

    fireEvent.change(screen.getByRole('slider', { name: 'Density' }), { target: { value: '20' } });
    expect(onSettingsChange).toHaveBeenCalledWith({ exposure: 20 });
    expect(screen.queryByRole('slider', { name: 'Lens distortion' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Detect lens distortion automatically' }));
    expect(onAutoLensDistortion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /fine tune/i }));
    fireEvent.change(screen.getByRole('slider', { name: 'Lens distortion' }), { target: { value: '24' } });
    expect(onSettingsChange).toHaveBeenCalledWith({ lensDistortion: 24 });
    fireEvent.change(screen.getByRole('slider', { name: 'Cyan' }), { target: { value: '0.1' } });
    expect(onSettingsChange).toHaveBeenCalledWith({ redBalance: 0.9 });
    const cyanValue = screen.getByRole('spinbutton', { name: 'Cyan value' });
    fireEvent.focus(cyanValue);
    fireEvent.change(cyanValue, { target: { value: '0.25' } });
    fireEvent.blur(cyanValue);
    expect(onSettingsChange).toHaveBeenCalledWith({ redBalance: 0.75 });
    const densityValue = screen.getByRole('spinbutton', { name: 'Density value' });
    fireEvent.focus(densityValue);
    fireEvent.change(densityValue, { target: { value: '1.25' } });
    fireEvent.blur(densityValue);
    expect(onSettingsChange).toHaveBeenCalledWith({ exposure: 25 });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto crop' }));
    expect(onRedetectFrame).toHaveBeenCalledTimes(1);
    rerender(renderSidebar('source-2'));
    expect(screen.getByRole('switch', { name: 'Auto crop' })).toHaveAttribute('aria-checked', 'true');
    expect(onRedetectFrame).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('switch', { name: 'Auto crop' }));
    expect(screen.getByRole('switch', { name: 'Auto crop' })).toHaveAttribute('aria-checked', 'false');
    expect(onRedetectFrame).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Reset develop adjustments' }));
    expect(onSettingsChange).toHaveBeenCalledWith({
      exposure: colorProfile?.defaultSettings.exposure,
      contrast: colorProfile?.defaultSettings.contrast,
      saturation: colorProfile?.defaultSettings.saturation,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Crop' }));
    expect(onTabChange).toHaveBeenCalledWith('crop');
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export current' })).not.toBeInTheDocument();
  });

  it('opens common advanced controls and keeps effect toggles independent from collapse', () => {
    const colorProfile = FILM_PROFILES.find((profile) => profile.type === 'color');
    const onSettingsChange = vi.fn();
    const settings = createDefaultSettings();
    expect(colorProfile).toBeTruthy();

    const sidebar = (
      <Sidebar
        settings={settings}
        exportOptions={{ ...DEFAULT_EXPORT_OPTIONS, filenameBase: 'test' }}
        quickExportPresets={[]}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        cropImageWidth={4032}
        cropImageHeight={6048}
        onSettingsChange={onSettingsChange}
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
        onTabChange={vi.fn()}
        cropTab="Film"
        onCropTabChange={vi.fn()}
        onCropDone={vi.fn()}
        onResetCrop={vi.fn()}
        activePointPicker={null}
        onSetPointPicker={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    const { rerender } = render(sidebar);

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(screen.getByText('Exposure')).toBeInTheDocument();
    expect(screen.getByText('Shadow Recovery')).toBeInTheDocument();
    expect(screen.getByText('Black Point')).toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.queryByText('Saturation')).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Collapse Tone' })).toHaveAttribute('aria-expanded', 'true');
    const toneSwitch = screen.getByRole('switch', { name: 'Disable Tone' });
    fireEvent.click(toneSwitch);
    expect(onSettingsChange).toHaveBeenCalledWith({ toneEnabled: false });
    expect(screen.getByRole('button', { name: 'Collapse Tone' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Exposure')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Collapse Tone range' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Tone range' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ toneRangeEnabled: false });
    expect(screen.getByText('Black Point')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Tone range' }));
    expect(screen.queryByText('Black Point')).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Collapse White balance' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Disable White balance' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ whiteBalanceEnabled: false });
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse White balance' }));
    expect(screen.queryByText('Temperature')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Disable Color controls' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ colorControlsEnabled: false });
    expect(screen.getByRole('button', { name: 'Expand Color controls' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Color controls' }));
    expect(screen.getByText('Saturation')).toBeInTheDocument();
    expect(screen.queryByText('Red Balance')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'Cyan' }), { target: { value: '0.1' } });
    expect(onSettingsChange).toHaveBeenCalledWith({ redBalance: 0.9 });

    const sourceDisclosure = screen.getByRole('button', { name: 'Expand Source and scanning' });
    expect(sourceDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(sourceDisclosure).not.toHaveClass('rounded-lg');
    expect(sourceDisclosure.closest('h2')).toHaveClass('font-mono', 'uppercase');
    expect(sourceDisclosure.closest('h2')?.parentElement).toHaveClass('mb-3', 'flex');

    expect(screen.getByRole('button', { name: 'Collapse Detail controls' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Collapse Sharpen' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Amount')).toBeInTheDocument();
    const sharpenSwitch = screen.getByRole('switch', { name: 'Enable Sharpen' });
    expect(sharpenSwitch).toHaveAttribute('aria-checked', 'false');
    expect(sharpenSwitch).toHaveAttribute('data-tip', 'Enable the sharpen effect on the image.');
    fireEvent.click(sharpenSwitch);
    expect(onSettingsChange).toHaveBeenCalledWith({
      sharpen: expect.objectContaining({ enabled: true }),
    });
    rerender(React.cloneElement(sidebar, {
      settings: {
        ...settings,
        sharpen: { ...settings.sharpen, enabled: true },
      },
    }));
    expect(screen.getByRole('button', { name: 'Collapse Sharpen' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('switch', { name: 'Disable Sharpen' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Amount')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Sharpen'));
    expect(screen.queryByText('Amount')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Sharpen' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('switch', { name: 'Disable Sharpen' })).toBeInTheDocument();
  });

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

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Source and scanning' }));
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

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Source and scanning' }));
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

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Color controls' }));
    expect(screen.getByText('Convert to Black and White')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Green')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.getAllByText('Tone')).toHaveLength(2);
  });

  it('shows and forwards bit-depth controls for TIFF exports', () => {
    const onExportOptionsChange = vi.fn();
    const onCancelExport = vi.fn();

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
        onCancelExport={onCancelExport}
        onQuickExport={vi.fn()}
        onSaveQuickExportPreset={vi.fn()}
        onDeleteQuickExportPreset={vi.fn()}
        onOpenBatchExport={vi.fn()}
        isExporting
        activeTab="export"
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

    fireEvent.click(screen.getByRole('button', { name: '8-bit' }));
    expect(onExportOptionsChange).toHaveBeenCalledWith({ bitDepth: 8 });
    expect(screen.getByRole('region', { name: 'Export summary' })).toHaveTextContent('TIFF');
    expect(screen.getByRole('region', { name: 'Export summary' })).toHaveTextContent('16-bit');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
    expect(onCancelExport).toHaveBeenCalledTimes(1);
  });

});
