import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, DEFAULT_NOTIFICATION_SETTINGS, FILM_PROFILES, LIGHT_SOURCE_PROFILES, createDefaultSettings } from '../constants';
import type { DocumentTab, FilmProfile } from '../types';
import type { ImageWorkerClient } from '../utils/imageWorkerClient';
import { useContactSheet } from './useContactSheet';

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  saveExportBlob: vi.fn(async () => 'saved' as const),
  saveToDirectory: vi.fn(),
  openMultipleImageFiles: vi.fn(),
  openImageFolder: vi.fn(),
}));

vi.mock('../utils/fileBridge', () => fileBridgeState);
vi.mock('../utils/exportNotifications', () => ({
  notifyExportFinished: vi.fn(),
  primeExportNotificationsPermission: vi.fn(),
}));

const profile = FILM_PROFILES.find((item) => item.id === 'generic-color') ?? FILM_PROFILES[0];

function createTab(id: string, settings = createDefaultSettings()): DocumentTab {
  return {
    id,
    document: {
      id,
      source: { id: `source-${id}`, name: `${id}.tiff`, mime: 'image/tiff', extension: '.tiff', size: 1024, width: 400, height: 300 },
      previewLevels: [],
      settings,
      colorManagement: DEFAULT_COLOR_MANAGEMENT,
      profileId: profile.id,
      labStyleId: null,
      rollId: null,
      exportOptions: DEFAULT_EXPORT_OPTIONS,
      histogram: null,
      renderRevision: 1,
      status: 'ready',
      dirty: false,
    },
    rollId: null,
    historyStack: [],
    historyIndex: 0,
    zoom: 'fit',
    pan: { x: 0.5, y: 0.5 },
    sidebarScrollTop: 0,
  };
}

function setup(tabs: DocumentTab[], selectedIds: string[] = []) {
  const worker = {
    decode: vi.fn(async () => ({})),
    render: vi.fn(async () => { throw new Error('no thumbnails in tests'); }),
    disposeDocument: vi.fn(async () => undefined),
    contactSheet: vi.fn(async (_request: unknown) => ({ blob: new Blob(['x']), width: 10, height: 10, filename: 'contact_sheet.jpg' })),
  };
  const onSaved = vi.fn();
  const hook = renderHook(() => useContactSheet({
    workerClientRef: { current: worker as unknown as ImageWorkerClient },
    tabs,
    tabsRef: { current: tabs },
    activeTabId: tabs[0]?.id ?? null,
    selectedIds,
    profilesById: new Map<string, FilmProfile>([[profile.id, profile]]),
    fallbackProfile: profile,
    lightSourceProfilesById: new Map(LIGHT_SOURCE_PROFILES.map((item) => [item.id, item] as const)),
    notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    outputPath: null,
    onSaved,
  }));
  return { ...hook, worker, onSaved };
}

describe('useContactSheet', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('lays out the selected frames, each with its own settings', async () => {
    const a = createTab('a', createDefaultSettings({ exposure: 20 }));
    const b = createTab('b', createDefaultSettings({ exposure: -10 }));
    const c = createTab('c');
    const { result, worker, onSaved } = setup([a, b, c], ['c', 'a']);

    expect(result.current.scope).toBe('selected');
    expect(result.current.cells.map((cell) => cell.id)).toEqual(['a', 'c']);

    await act(async () => {
      await result.current.generate();
    });

    const request = worker.contactSheet.mock.calls[0]?.[0] as unknown as { cells: Array<{ documentId: string }>; settingsPerCell: Array<{ exposure: number }> };
    expect(request.cells.map((cell) => cell.documentId)).toEqual(['a', 'c']);
    expect(request.settingsPerCell.map((settings) => settings.exposure)).toEqual([20, 0]);
    expect(onSaved).toHaveBeenCalledWith('Saved contact_sheet.jpg.');
  });

  it('gives files that are not open the edited frame look without its crop', async () => {
    const edited = createTab('a', createDefaultSettings({
      exposure: 15,
      rotation: 90,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, aspectRatio: null },
    }));
    const { result, worker } = setup([edited]);

    act(() => {
      result.current.addBrowserFiles([new File([new Uint8Array([1])], 'roll-01.jpg', { type: 'image/jpeg' })]);
    });
    expect(result.current.source).toBe('files');

    await act(async () => {
      await result.current.generate();
    });

    const request = worker.contactSheet.mock.calls[0]?.[0] as unknown as { cells: Array<{ documentId: string; label: string }>; settingsPerCell: Array<{ exposure: number; rotation: number; crop: { width: number } }> };
    expect(request.cells[0]?.label).toBe('roll-01.jpg');
    expect(request.settingsPerCell[0]).toMatchObject({ exposure: 15, rotation: 0, crop: { width: 1 } });
    // The temporary decode is released after the sheet is written.
    expect(worker.disposeDocument).toHaveBeenCalledWith(request.cells[0]?.documentId);
  });
});
