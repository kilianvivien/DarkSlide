import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentTab } from '../types';
import { TabBar } from './TabBar';

vi.mock('./DocumentThumbnail', () => ({
  DocumentThumbnail: ({ className }: { className?: string }) => (
    <div data-testid="thumbnail" className={className} />
  ),
}));

function createTabs(): DocumentTab[] {
  return ['frame-01.tiff', 'frame-02.tiff', 'frame-03.tiff'].map((name, index) => ({
    id: `tab-${index + 1}`,
    rollId: null,
    document: {
      source: { name },
      profileId: 'generic-color',
      lightSourceId: 'auto',
      dirty: false,
    },
  })) as unknown as DocumentTab[];
}

const TABS = createTabs();

function ControlledFilmstrip() {
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set(['tab-1']));

  return (
    <>
      <span data-testid="selection-count">{selectedIds.size}</span>
      <TabBar
        tabs={TABS}
        activeTabId="tab-1"
        workerClient={null}
        profilesById={new Map()}
        lightSourceProfilesById={new Map()}
        getRollById={() => null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCreateTab={vi.fn()}
        onReorderTabs={vi.fn()}
        onSyncRollSettings={vi.fn()}
        onApplyRollFilmBase={vi.fn()}
        onRemoveFromRoll={vi.fn()}
        onOpenRollInfo={vi.fn()}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />
    </>
  );
}

describe('TabBar filmstrip', () => {
  it('renders frames without the old Open images action header', () => {
    render(<ControlledFilmstrip />);

    expect(screen.getAllByTestId('thumbnail')).toHaveLength(3);
    expect(screen.queryByText('Open images')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /batch export/i })).not.toBeInTheDocument();
  });

  it('selects every frame with the platform select-all shortcut', () => {
    render(<ControlledFilmstrip />);

    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(screen.getByTestId('selection-count')).toHaveTextContent('3');
  });

  it('supports command-click multi-selection', () => {
    render(<ControlledFilmstrip />);

    fireEvent.click(screen.getByTitle(/frame-02\.tiff/i), { metaKey: true });
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2');
  });

  it('offers visible per-frame selection controls without modifier keys', () => {
    render(<ControlledFilmstrip />);

    const secondFrameToggle = screen.getByRole('button', { name: 'Select frame-02.tiff' });
    fireEvent.click(secondFrameToggle);

    expect(screen.getByTestId('selection-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Deselect frame-02.tiff' })).toHaveAttribute('aria-pressed', 'true');
  });
});
