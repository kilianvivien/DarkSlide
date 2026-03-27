import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS } from '../constants';
import { SettingsModal } from './SettingsModal';

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

vi.mock('../utils/fileBridge', () => ({
  isDesktopShell: () => true,
}));

describe('SettingsModal', () => {
  const createProps = () => ({
    isOpen: true,
    onClose: vi.fn(),
    onCopyDebugInfo: vi.fn(async () => undefined),
    gpuRenderingEnabled: true,
    ultraSmoothDragEnabled: false,
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    onNotificationSettingsChange: vi.fn(),
    renderBackendDiagnostics: {
      gpuAvailable: false,
      gpuEnabled: true,
      gpuActive: false,
      gpuAdapterName: null,
      backendMode: 'cpu-worker' as const,
      sourceKind: null,
      previewMode: null,
      previewLevelId: null,
      interactionQuality: null,
      histogramMode: null,
      tileSize: null,
      halo: null,
      tileCount: null,
      intermediateFormat: null,
      usedCpuFallback: false,
      fallbackReason: null,
      jobDurationMs: null,
      geometryCacheHit: null,
      phaseTimings: null,
      coalescedPreviewRequests: 0,
      cancelledPreviewJobs: 0,
      previewBackend: null,
      lastPreviewJob: null,
      lastExportJob: null,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
      gpuDisabledReason: 'unsupported' as const,
      lastError: null,
      workerMemory: null,
      activeBlobUrlCount: null,
      oldestActiveBlobUrlAgeMs: null,
    },
    onToggleGPURendering: vi.fn(),
    onToggleUltraSmoothDrag: vi.fn(),
    maxResidentDocs: 3 as const,
    onMaxResidentDocsChange: vi.fn(),
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    sourceMetadata: null,
    onColorManagementChange: vi.fn(),
    lightSourceProfiles: [
      {
        id: 'auto',
        name: 'Auto (no correction)',
        colorTemperature: 0,
        spectralBias: [1, 1, 1] as [number, number, number],
        flareCharacteristic: 'medium' as const,
      },
      {
        id: 'daylight',
        name: 'Generic daylight LED panel',
        colorTemperature: 5500,
        spectralBias: [1, 0.98, 0.95] as [number, number, number],
        flareCharacteristic: 'low' as const,
      },
    ],
    defaultLightSourceId: 'auto',
    onDefaultLightSourceChange: vi.fn(),
    onSaveCustomLightSource: vi.fn(async () => ({
      id: 'custom-light',
      name: 'Custom Light Source',
      colorTemperature: 5500,
      spectralBias: [1, 1, 1] as [number, number, number],
      flareCharacteristic: 'medium' as const,
    })),
    onDeleteCustomLightSource: vi.fn(),
    flatFieldProfileNames: ['Studio Panel'],
    activeFlatFieldProfileName: 'Studio Panel',
    activeFlatFieldLoaded: true,
    activeFlatFieldPreview: {
      data: new Float32Array([1, 1, 1, 0.8, 0.8, 0.8, 0.6, 0.6, 0.6, 0.4, 0.4, 0.4]),
      size: 2,
    },
    onSelectFlatFieldProfile: vi.fn(async () => undefined),
    onImportFlatFieldReference: vi.fn(async () => 'Studio Panel'),
    onDeleteFlatFieldProfile: vi.fn(async () => undefined),
    onRenameFlatFieldProfile: vi.fn(async () => 'Studio Panel Renamed'),
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    onExportOptionsChange: vi.fn(),
    externalEditorPath: null,
    externalEditorName: null,
    openInEditorOutputPath: null,
    defaultExportPath: null,
    onChooseExternalEditor: vi.fn(),
    onClearExternalEditor: vi.fn(),
    onChooseOpenInEditorOutputPath: vi.fn(),
    onUseDownloadsForOpenInEditor: vi.fn(),
    onChooseDefaultExportPath: vi.fn(),
    onUseDownloadsForExport: vi.fn(),
    batchOutputPath: null,
    onChooseBatchOutputPath: vi.fn(),
    onUseDownloadsForBatch: vi.fn(),
    contactSheetOutputPath: null,
    onChooseContactSheetOutputPath: vi.fn(),
    onUseDownloadsForContactSheet: vi.fn(),
    customPresetCount: 12,
    presetFolderCount: 3,
    onExportPresetBackup: vi.fn(async () => 'saved' as const),
    onImportPresetBackup: vi.fn(async () => 'imported' as const),
    updateChannel: 'stable' as const,
    lastUpdateCheckAt: null,
    updateError: null,
    isCheckingForUpdates: false,
    updaterEnabled: false,
    updaterDisabledReason: 'Updater is not configured.',
    onUpdateChannelChange: vi.fn(),
    onCheckForUpdates: vi.fn(),
  });

  it('lets the user change the resident worker document limit', () => {
    const props = createProps();
    const onMaxResidentDocsChange = vi.fn();
    props.onMaxResidentDocsChange = onMaxResidentDocsChange;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(onMaxResidentDocsChange).toHaveBeenCalledWith(5);
  });

  it('renders a notifications tab and updates notification settings', () => {
    const props = createProps();
    const onNotificationSettingsChange = vi.fn();
    props.onNotificationSettingsChange = onNotificationSettingsChange;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('switch', { name: 'Notifications Enabled' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Batch exports' }));
    expect(onNotificationSettingsChange).toHaveBeenCalledWith({ batchComplete: false });
  });

  it('renders the calibration tab and lets the user switch the active flat-field profile', () => {
    const props = createProps();
    const onSelectFlatFieldProfile = vi.fn(async () => undefined);
    const onDefaultLightSourceChange = vi.fn();
    props.onSelectFlatFieldProfile = onSelectFlatFieldProfile;
    props.onDefaultLightSourceChange = onDefaultLightSourceChange;
    props.flatFieldProfileNames = ['Studio Panel', 'Tablet Light'];

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));
    expect(screen.getByText('Flat-Field Profiles')).toBeInTheDocument();
    expect(screen.getByLabelText('Flat-field preview')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Studio Panel'), { target: { value: 'Tablet Light' } });
    expect(onSelectFlatFieldProfile).toHaveBeenCalledWith('Tablet Light');

    fireEvent.change(screen.getByDisplayValue('Auto (no correction)'), { target: { value: 'daylight' } });
    expect(onDefaultLightSourceChange).toHaveBeenCalledWith('daylight');
  });

  it('renders the backup tab and triggers preset backup actions', () => {
    const props = createProps();
    const onExportPresetBackup = vi.fn(async () => 'saved' as const);
    const onImportPresetBackup = vi.fn(async () => 'imported' as const);
    props.onExportPresetBackup = onExportPresetBackup;
    props.onImportPresetBackup = onImportPresetBackup;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Backup' }));
    expect(screen.getByText('12 presets across 3 folders')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    expect(onExportPresetBackup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Import backup' }));
    expect(onImportPresetBackup).toHaveBeenCalledTimes(1);
  });
});
