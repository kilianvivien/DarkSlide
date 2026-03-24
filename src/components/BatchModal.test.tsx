import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES, createDefaultSettings } from '../constants';
import { BatchModal } from './BatchModal';
import type { DocumentTab, FilmProfile, WorkspaceDocument } from '../types';
import type { ImageWorkerClient } from '../utils/imageWorkerClient';

const fileBridgeState = vi.hoisted(() => ({
  getDesktopDownloadsDirectory: vi.fn(),
  isDesktopShell: vi.fn(() => false),
  openDirectory: vi.fn(),
  openMultipleImageFiles: vi.fn(),
}));

const runBatchState = vi.hoisted(() => ({
  runBatch: vi.fn(),
}));

const exportNotificationState = vi.hoisted(() => ({
  notifyExportFinished: vi.fn(),
  primeExportNotificationsPermission: vi.fn(),
}));

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
  getDesktopDownloadsDirectory: fileBridgeState.getDesktopDownloadsDirectory,
  isDesktopShell: fileBridgeState.isDesktopShell,
  openDirectory: fileBridgeState.openDirectory,
  openMultipleImageFiles: fileBridgeState.openMultipleImageFiles,
}));

vi.mock('../utils/batchProcessor', () => ({
  runBatch: runBatchState.runBatch,
}));

vi.mock('../utils/exportNotifications', () => ({
  notifyExportFinished: exportNotificationState.notifyExportFinished,
  primeExportNotificationsPermission: exportNotificationState.primeExportNotificationsPermission,
}));

function createOpenTab(profile: FilmProfile): DocumentTab {
  const document: WorkspaceDocument = {
    id: 'tab-1',
    source: {
      id: 'source-1',
      name: 'open-scan.tiff',
      mime: 'image/tiff',
      extension: '.tiff',
      size: 1024,
      width: 4000,
      height: 3000,
    },
    previewLevels: [],
    settings: createDefaultSettings(),
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    profileId: profile.id,
    labStyleId: null,
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    histogram: null,
    renderRevision: 1,
    status: 'ready',
    dirty: false,
  };

  return {
    id: 'tab-1',
    document,
    historyStack: [{ settings: document.settings, labStyleId: document.labStyleId }],
    historyIndex: 0,
    zoom: 'fit',
    pan: { x: 0.5, y: 0.5 },
    sidebarScrollTop: 0,
  };
}

function renderModal({
  customProfiles,
  currentSettings = null,
  currentProfile = null,
  notificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
  onOpenContactSheet = vi.fn(),
}: {
  customProfiles: FilmProfile[];
  currentSettings?: WorkspaceDocument['settings'] | null;
  currentProfile?: FilmProfile | null;
  notificationSettings?: typeof DEFAULT_NOTIFICATION_SETTINGS;
  onOpenContactSheet?: (payload: {
    entries: Array<{ id: string }>;
    sharedSettings: WorkspaceDocument['settings'];
    sharedProfile: FilmProfile;
    sharedColorManagement: typeof DEFAULT_COLOR_MANAGEMENT;
  }) => void;
}) {
  const profile = FILM_PROFILES.find((item) => item.id === 'generic-color') ?? FILM_PROFILES[0];

  render(
    <BatchModal
      isOpen
      onClose={vi.fn()}
      onOpenContactSheet={onOpenContactSheet}
      workerClient={{} as ImageWorkerClient}
      currentSettings={currentSettings}
      currentProfile={currentProfile}
      currentLabStyle={null}
      currentColorManagement={DEFAULT_COLOR_MANAGEMENT}
      notificationSettings={notificationSettings}
      customProfiles={customProfiles}
      openTabs={[createOpenTab(profile)]}
    />,
  );

  return { onOpenContactSheet };
}

describe('BatchModal', () => {
  beforeEach(() => {
    fileBridgeState.getDesktopDownloadsDirectory.mockReset();
    fileBridgeState.isDesktopShell.mockReset();
    fileBridgeState.openDirectory.mockReset();
    fileBridgeState.openMultipleImageFiles.mockReset();
    runBatchState.runBatch.mockReset();
    exportNotificationState.notifyExportFinished.mockReset();
    exportNotificationState.primeExportNotificationsPermission.mockReset();
    fileBridgeState.isDesktopShell.mockReturnValue(false);
    exportNotificationState.notifyExportFinished.mockResolvedValue(undefined);
    exportNotificationState.primeExportNotificationsPermission.mockResolvedValue(undefined);
    runBatchState.runBatch.mockImplementation(async function* () {
      yield { type: 'complete' as const };
    });
  });

  it('shows a warning for custom presets with embedded crop', async () => {
    renderModal({
      customProfiles: [{
        id: 'custom-crop',
        version: 1,
        name: 'Cropped',
        type: 'color',
        description: 'Custom',
        defaultSettings: createDefaultSettings({
          crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, aspectRatio: null },
        }),
      }],
    });

    await screen.findByText('open-scan.tiff');
    fireEvent.click(screen.getByText('Custom'));

    expect(screen.getByText('This preset has a saved crop or rotation.')).toBeInTheDocument();
  });

  it('shows a warning for custom presets with embedded rotation', async () => {
    renderModal({
      customProfiles: [{
        id: 'custom-rotated',
        version: 1,
        name: 'Rotated',
        type: 'color',
        description: 'Custom',
        defaultSettings: createDefaultSettings({
          rotation: 90,
        }),
      }],
    });

    await screen.findByText('open-scan.tiff');
    fireEvent.click(screen.getByText('Custom'));

    expect(screen.getByText('This preset has a saved crop or rotation.')).toBeInTheDocument();
  });

  it('does not show the warning for built-in profiles or neutral custom presets', async () => {
    renderModal({
      customProfiles: [{
        id: 'custom-neutral',
        version: 1,
        name: 'Neutral',
        type: 'color',
        description: 'Custom',
        defaultSettings: createDefaultSettings(),
      }],
    });

    await screen.findByText('open-scan.tiff');
    expect(screen.queryByText('This preset has a saved crop or rotation.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Custom'));
    expect(screen.queryByText('This preset has a saved crop or rotation.')).not.toBeInTheDocument();
  });

  it('passes neutralized settings into batch export when ignore is enabled', async () => {
    runBatchState.runBatch.mockImplementation(async function* () {
      yield { type: 'start' as const, entryId: 'tab-1' };
      yield { type: 'done' as const, entryId: 'tab-1' };
      yield { type: 'complete' as const };
    });

    renderModal({
      customProfiles: [{
        id: 'custom-transforms',
        version: 1,
        name: 'Transforms',
        type: 'color',
        description: 'Custom',
        defaultSettings: createDefaultSettings({
          rotation: 90,
          levelAngle: 1.25,
          crop: { x: 0.2, y: 0.15, width: 0.7, height: 0.65, aspectRatio: 4 / 5 },
        }),
      }],
    });

    await screen.findByText('open-scan.tiff');
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.click(screen.getByText('Ignore preset crop and rotation'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(runBatchState.runBatch).toHaveBeenCalledTimes(1);
    });

    const sharedSettings = runBatchState.runBatch.mock.calls[0]?.[2] as WorkspaceDocument['settings'];
    expect(sharedSettings.rotation).toBe(0);
    expect(sharedSettings.levelAngle).toBe(0);
    expect(sharedSettings.crop).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: null,
    });
  });

  it('passes the same neutralized settings into contact sheet generation', async () => {
    const onOpenContactSheet = vi.fn();

    renderModal({
      customProfiles: [{
        id: 'custom-transforms',
        version: 1,
        name: 'Transforms',
        type: 'color',
        description: 'Custom',
        defaultSettings: createDefaultSettings({
          rotation: 180,
          crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9, aspectRatio: null },
        }),
      }],
      onOpenContactSheet,
    });

    await screen.findByText('open-scan.tiff');
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.click(screen.getByText('Ignore preset crop and rotation'));
    fireEvent.click(screen.getByRole('button', { name: /contact sheet/i }));

    expect(onOpenContactSheet).toHaveBeenCalledWith(expect.objectContaining({
      sharedSettings: expect.objectContaining({
        rotation: 0,
        levelAngle: 0,
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
      }),
    }));
  });

  it('prompts for a desktop destination when starting without one selected', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openDirectory.mockResolvedValue('/Users/tester/Pictures/DarkSlide');

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(runBatchState.runBatch).toHaveBeenCalledTimes(1);
    });

    expect(fileBridgeState.openDirectory).toHaveBeenCalledTimes(1);
    expect(runBatchState.runBatch.mock.calls[0]?.[7]).toBe('/Users/tester/Pictures/DarkSlide');
  });

  it('keeps the batch stopped when the desktop destination prompt is cancelled', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openDirectory.mockResolvedValue(null);

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(fileBridgeState.openDirectory).toHaveBeenCalledTimes(1);
    });

    expect(runBatchState.runBatch).not.toHaveBeenCalled();
    expect(screen.getByText('Choose an output folder or use Downloads before starting the batch.')).toBeInTheDocument();
  });

  it('uses the desktop Downloads destination when selected explicitly', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.getDesktopDownloadsDirectory.mockResolvedValue('/Users/tester/Downloads');

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Use Downloads' }));

    await waitFor(() => {
      expect(screen.getByText('/Users/tester/Downloads')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(runBatchState.runBatch).toHaveBeenCalledTimes(1);
    });

    expect(fileBridgeState.getDesktopDownloadsDirectory).toHaveBeenCalledTimes(1);
    expect(fileBridgeState.openDirectory).not.toHaveBeenCalled();
    expect(runBatchState.runBatch.mock.calls[0]?.[7]).toBe('/Users/tester/Downloads');
  });

  it('does not re-prompt when a desktop destination is already selected', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    fileBridgeState.openDirectory.mockResolvedValue('/Users/tester/Exports');

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }));

    await waitFor(() => {
      expect(screen.getByText('/Users/tester/Exports')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(runBatchState.runBatch).toHaveBeenCalledTimes(1);
    });

    expect(fileBridgeState.openDirectory).toHaveBeenCalledTimes(1);
    expect(runBatchState.runBatch.mock.calls[0]?.[7]).toBe('/Users/tester/Exports');
  });

  it('sends one completion notification when the batch succeeds', async () => {
    runBatchState.runBatch.mockImplementation(async function* () {
      yield { type: 'start' as const, entryId: 'tab-1' };
      yield { type: 'done' as const, entryId: 'tab-1' };
      yield { type: 'complete' as const };
    });

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(exportNotificationState.notifyExportFinished).toHaveBeenCalledWith({
        kind: 'batch',
        successCount: 1,
        failureCount: 0,
        cancelled: false,
      });
    });
  });

  it('sends one completion notification when some batch items fail', async () => {
    runBatchState.runBatch.mockImplementation(async function* () {
      yield { type: 'start' as const, entryId: 'tab-1' };
      yield { type: 'error' as const, entryId: 'tab-1', message: 'Decode failed' };
      yield { type: 'complete' as const };
    });

    renderModal({ customProfiles: [] });
    await screen.findByText('open-scan.tiff');

    fireEvent.click(screen.getByRole('button', { name: 'Start Batch' }));

    await waitFor(() => {
      expect(exportNotificationState.notifyExportFinished).toHaveBeenCalledWith({
        kind: 'batch',
        successCount: 0,
        failureCount: 1,
        cancelled: false,
      });
    });
  });
});
