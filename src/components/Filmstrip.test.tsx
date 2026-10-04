import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS } from '../constants';
import type { DocumentTab, WorkspaceDocument } from '../types';
import { getThumbnailKey } from '../utils/filmstripThumbnails';
import { Filmstrip } from './Filmstrip';

function makeTab(id: string, overrides: Partial<WorkspaceDocument> = {}): DocumentTab {
  const document: WorkspaceDocument = {
    id,
    source: { id, name: `${id}.tiff`, extension: '.tiff', mime: 'image/tiff', size: 1, width: 300, height: 200 },
    previewLevels: [],
    settings: createDefaultSettings(),
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    profileId: 'generic-color',
    labStyleId: null,
    rollId: null,
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    histogram: null,
    renderRevision: 1,
    status: 'ready',
    dirty: false,
    ...overrides,
  };
  return {
    id,
    document,
    rollId: document.rollId,
    historyStack: [],
    historyIndex: 0,
    zoom: 'fit',
    pan: { x: 0.5, y: 0.5 },
    sidebarScrollTop: 0,
  };
}

function renderStrip(props: Partial<React.ComponentProps<typeof Filmstrip>> = {}) {
  const handlers = {
    onFrameClick: vi.fn(),
    onCloseTab: vi.fn(),
    onAddImages: vi.fn(),
    onReorderTabs: vi.fn(),
    onSyncSettings: vi.fn(),
    onStabilizeCrops: vi.fn(),
    onExportFrames: vi.fn(),
    onClearSelection: vi.fn(),
    onSyncRollSettings: vi.fn(),
    onApplyRollFilmBase: vi.fn(),
    onRemoveFromRoll: vi.fn(),
    onOpenRollInfo: vi.fn(),
  };
  const tabs = props.tabs ?? [makeTab('a'), makeTab('b'), makeTab('c')];
  render(
    <Filmstrip
      tabs={tabs}
      activeTabId="a"
      selectedIds={['a']}
      thumbnails={{}}
      getRollById={() => null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('Filmstrip', () => {
  it('numbers frames, marks the open one, and reports click modifiers', () => {
    const { onFrameClick } = renderStrip();
    const second = screen.getByRole('button', { name: 'Frame 2: b.tiff' });
    expect(screen.getByRole('button', { name: 'Frame 1: a.tiff' })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(second);
    fireEvent.click(second, { metaKey: true });
    fireEvent.click(second, { ctrlKey: true, shiftKey: true });
    expect(onFrameClick.mock.calls).toEqual([
      ['b', { toggle: false, range: false }],
      ['b', { toggle: true, range: false }],
      ['b', { toggle: true, range: true }],
    ]);
  });

  it('shows selection actions only for a multi-selection and scopes them to it', () => {
    const handlers = renderStrip({ selectedIds: ['a', 'c'] });
    const bar = screen.getByRole('toolbar', { name: 'Selected frames' });
    expect(bar).toHaveTextContent('2 selected');

    fireEvent.click(within(bar).getByRole('button', { name: /Sync look/ }));
    expect(handlers.onSyncSettings).toHaveBeenCalledWith('a', ['c']);
    fireEvent.click(within(bar).getByRole('button', { name: /Stabilize crops/ }));
    expect(handlers.onStabilizeCrops).toHaveBeenCalledWith(['a', 'c']);
    fireEvent.click(within(bar).getByRole('button', { name: /Export 2/ }));
    expect(handlers.onExportFrames).toHaveBeenCalledWith(['a', 'c']);
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(handlers.onClearSelection).toHaveBeenCalledOnce();
  });

  it('hides the selection bar for a single frame and disables actions while busy', () => {
    renderStrip();
    expect(screen.queryByRole('toolbar', { name: 'Selected frames' })).not.toBeInTheDocument();
  });

  it('disables selection actions while a selection action runs', () => {
    renderStrip({ selectedIds: ['a', 'b'], isBusy: true });
    const bar = screen.getByRole('toolbar', { name: 'Selected frames' });
    expect(within(bar).getByRole('button', { name: /Export 2/ })).toBeDisabled();
  });

  it('flags thumbnails whose frame changed since they were captured', () => {
    const fresh = makeTab('a');
    const edited = makeTab('b', { settings: createDefaultSettings({ exposure: 30 }) });
    renderStrip({
      tabs: [fresh, edited],
      thumbnails: {
        a: { url: 'data:a', key: getThumbnailKey(fresh.document) },
        b: { url: 'data:b', key: getThumbnailKey(makeTab('b').document) },
      },
    });

    expect(screen.getByRole('button', { name: 'Frame 1: a.tiff' })).not.toHaveTextContent('↻');
    expect(screen.getByRole('button', { name: 'Frame 2: b.tiff' })).toHaveTextContent('↻');
  });

  it('shows film base, crop and unsaved status per frame', () => {
    renderStrip({
      tabs: [makeTab('a', { settings: createDefaultSettings({ filmBaseSample: { r: 200, g: 150, b: 100 } }), cropSource: 'auto', dirty: true })],
    });
    const frame = screen.getByRole('button', { name: 'Frame 1: a.tiff' });
    expect(within(frame).getByTitle('Film base set')).toBeInTheDocument();
    expect(within(frame).getByTitle('Auto crop')).toBeInTheDocument();
    expect(within(frame).getByTitle('Unsaved edits')).toBeInTheDocument();
  });

  it('closes a frame and adds images', () => {
    const handlers = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close b.tiff' }));
    expect(handlers.onCloseTab).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: 'Add images' }));
    expect(handlers.onAddImages).toHaveBeenCalledOnce();
  });
});
