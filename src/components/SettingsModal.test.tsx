import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_NOTIFICATION_SETTINGS } from '../constants';
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

describe('SettingsModal', () => {
  it('lets the user change the resident worker document limit', () => {
    const onMaxResidentDocsChange = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onCopyDebugInfo={vi.fn(async () => undefined)}
        gpuRenderingEnabled
        ultraSmoothDragEnabled={false}
        notificationSettings={DEFAULT_NOTIFICATION_SETTINGS}
        onNotificationSettingsChange={vi.fn()}
        renderBackendDiagnostics={{
          gpuAvailable: false,
          gpuEnabled: true,
          gpuActive: false,
          gpuAdapterName: null,
          backendMode: 'cpu-worker',
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
          coalescedPreviewRequests: 0,
          cancelledPreviewJobs: 0,
          previewBackend: null,
          lastPreviewJob: null,
          lastExportJob: null,
          maxStorageBufferBindingSize: null,
          maxBufferSize: null,
          gpuDisabledReason: 'unsupported',
          lastError: null,
          workerMemory: null,
          activeBlobUrlCount: null,
          oldestActiveBlobUrlAgeMs: null,
        }}
        onToggleGPURendering={vi.fn()}
        onToggleUltraSmoothDrag={vi.fn()}
        maxResidentDocs={3}
        onMaxResidentDocsChange={onMaxResidentDocsChange}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        onColorManagementChange={vi.fn()}
        externalEditorPath={null}
        externalEditorName={null}
        openInEditorOutputPath={null}
        onChooseExternalEditor={vi.fn()}
        onClearExternalEditor={vi.fn()}
        onChooseOpenInEditorOutputPath={vi.fn()}
        onUseDownloadsForOpenInEditor={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(onMaxResidentDocsChange).toHaveBeenCalledWith(5);
  });

  it('renders a notifications tab and updates notification settings', () => {
    const onNotificationSettingsChange = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onCopyDebugInfo={vi.fn(async () => undefined)}
        gpuRenderingEnabled
        ultraSmoothDragEnabled={false}
        notificationSettings={DEFAULT_NOTIFICATION_SETTINGS}
        onNotificationSettingsChange={onNotificationSettingsChange}
        renderBackendDiagnostics={{
          gpuAvailable: false,
          gpuEnabled: true,
          gpuActive: false,
          gpuAdapterName: null,
          backendMode: 'cpu-worker',
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
          coalescedPreviewRequests: 0,
          cancelledPreviewJobs: 0,
          previewBackend: null,
          lastPreviewJob: null,
          lastExportJob: null,
          maxStorageBufferBindingSize: null,
          maxBufferSize: null,
          gpuDisabledReason: 'unsupported',
          lastError: null,
          workerMemory: null,
          activeBlobUrlCount: null,
          oldestActiveBlobUrlAgeMs: null,
        }}
        onToggleGPURendering={vi.fn()}
        onToggleUltraSmoothDrag={vi.fn()}
        maxResidentDocs={3}
        onMaxResidentDocsChange={vi.fn()}
        colorManagement={DEFAULT_COLOR_MANAGEMENT}
        sourceMetadata={null}
        onColorManagementChange={vi.fn()}
        externalEditorPath={null}
        externalEditorName={null}
        openInEditorOutputPath={null}
        onChooseExternalEditor={vi.fn()}
        onClearExternalEditor={vi.fn()}
        onChooseOpenInEditorOutputPath={vi.fn()}
        onUseDownloadsForOpenInEditor={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'notifications' }));
    expect(screen.getByText('Export Notifications')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Batch Exports' }));
    expect(onNotificationSettingsChange).toHaveBeenCalledWith({ batchComplete: false });
  });
});
