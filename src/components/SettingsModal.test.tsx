import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS } from '../constants';
import { SettingsModal } from './SettingsModal';
import { getActiveFlatFieldProfile, resetFlatFieldStoreForTests } from '../utils/flatFieldStore';

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

const pickRawFilePath = vi.fn(async (): Promise<string | null> => '/scans/flat.nef');
const buildFlatFieldFromRawPath = vi.fn();

vi.mock('../utils/fileBridge', () => ({
  isDesktopShell: () => true,
  pickRawFilePath: () => pickRawFilePath(),
}));

vi.mock('../utils/rawImport', () => ({
  buildFlatFieldFromRawPath: (path: string, name: string) => buildFlatFieldFromRawPath(path, name),
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
    defaultColorNegativeInversion: 'standard' as const,
    onDefaultColorNegativeInversionChange: vi.fn(),
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
    defaultLabStyleId: '',
    onDefaultLabStyleChange: vi.fn(),
    builtinProfiles: [
      {
        id: 'generic-color',
        version: 1,
        name: 'Generic Color',
        type: 'color' as const,
        filmType: 'negative' as const,
        category: 'Generic' as const,
        description: 'Built-in preset',
        defaultSettings: DEFAULT_COLOR_MANAGEMENT as never,
      },
    ],
    customPresets: [
      {
        id: 'custom-portra',
        version: 1,
        name: 'Custom Portra',
        type: 'color' as const,
        filmType: 'negative' as const,
        category: 'Generic' as const,
        description: 'Custom preset',
        defaultSettings: DEFAULT_COLOR_MANAGEMENT as never,
        isCustom: true,
      },
    ],
    defaultImportPresetId: null,
    onDefaultImportPresetChange: vi.fn(),
    labStyleProfiles: [],
    onSaveCustomLightSource: vi.fn(async () => ({
      id: 'custom-light',
      name: 'Custom Light Source',
      colorTemperature: 5500,
      spectralBias: [1, 1, 1] as [number, number, number],
      flareCharacteristic: 'medium' as const,
    })),
    onDeleteCustomLightSource: vi.fn(),
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

    fireEvent.click(screen.getByRole('switch', { name: 'Batch Exports' }));
    expect(onNotificationSettingsChange).toHaveBeenCalledWith({ batchComplete: false });
  });

  it('renders the calibration tab and lets the user change the default light source', () => {
    const props = createProps();
    const onDefaultLightSourceChange = vi.fn();
    props.onDefaultLightSourceChange = onDefaultLightSourceChange;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));
    fireEvent.change(screen.getByDisplayValue('Auto (no correction)'), { target: { value: 'daylight' } });
    expect(onDefaultLightSourceChange).toHaveBeenCalledWith('daylight');
  });

  it('measures a flat-field reference and lets the user turn it off', async () => {
    window.localStorage.clear();
    resetFlatFieldStoreForTests();
    buildFlatFieldFromRawPath.mockResolvedValueOnce({
      ok: true,
      profile: {
        version: 1, name: 'flat.nef', width: 6048, height: 4032, gridWidth: 2, gridHeight: 2,
        gains: new Array(12).fill(1.2), maxCorrectionStops: 0.26, createdAt: 1,
      },
    });
    render(<SettingsModal {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));

    fireEvent.click(screen.getByRole('button', { name: 'Choose Reference RAW…' }));

    await waitFor(() => expect(screen.getByText(/flat\.nef · 6048×4032/)).toBeInTheDocument());
    expect(buildFlatFieldFromRawPath).toHaveBeenCalledWith('/scans/flat.nef', 'flat.nef');
    expect(getActiveFlatFieldProfile()?.name).toBe('flat.nef');

    fireEvent.click(screen.getByRole('switch', { name: 'Apply flat-field correction' }));
    expect(getActiveFlatFieldProfile()).toBeNull();
  });

  it('explains why a flat-field reference was refused', async () => {
    window.localStorage.clear();
    resetFlatFieldStoreForTests();
    buildFlatFieldFromRawPath.mockResolvedValueOnce({ ok: false, reason: 'not-uniform' });
    render(<SettingsModal {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));

    fireEvent.click(screen.getByRole('button', { name: 'Choose Reference RAW…' }));

    await waitFor(() => expect(screen.getByText(/Shoot the bare light source/)).toBeInTheDocument());
    expect(getActiveFlatFieldProfile()).toBeNull();
  });

  it('lets the user choose an auto-apply import preset', () => {
    const props = createProps();
    const onDefaultImportPresetChange = vi.fn();
    props.onDefaultImportPresetChange = onDefaultImportPresetChange;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));
    fireEvent.change(screen.getByDisplayValue('Last used preset'), { target: { value: 'custom-portra' } });
    expect(onDefaultImportPresetChange).toHaveBeenCalledWith('custom-portra');
  });

  it('lets the user search presets and choose no preset', () => {
    const props = createProps();
    const onDefaultImportPresetChange = vi.fn();
    props.onDefaultImportPresetChange = onDefaultImportPresetChange;

    render(
      <SettingsModal {...props} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));
    fireEvent.change(screen.getByPlaceholderText('Search presets...'), { target: { value: 'portra' } });

    expect(screen.queryByRole('option', { name: 'Generic Color' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Custom Portra' })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Last used preset'), { target: { value: '__none__' } });
    expect(onDefaultImportPresetChange).toHaveBeenCalledWith('__none__');
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
