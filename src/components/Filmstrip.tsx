import React, { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Crop, Download, Info, Pipette, Plus, RefreshCw, ScanLine, Unlink2, X } from 'lucide-react';
import { DocumentTab, Roll } from '../types';
import { FilmstripThumbnail, getThumbnailKey } from '../utils/filmstripThumbnails';
import { getRollAccent } from '../utils/rolls';

interface FilmstripProps {
  tabs: DocumentTab[];
  activeTabId: string | null;
  selectedIds: string[];
  thumbnails: Record<string, FilmstripThumbnail>;
  getRollById: (rollId: string | null) => Roll | null;
  isBusy?: boolean;
  onFrameClick: (tabId: string, modifiers: { toggle: boolean; range: boolean }) => void;
  onCloseTab: (tabId: string) => void;
  onAddImages: () => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onSyncSettings: (sourceId: string, targetIds: string[]) => void;
  onStabilizeCrops: (tabIds: string[]) => void;
  onExportFrames: (tabIds: string[]) => void;
  onClearSelection: () => void;
  onSyncRollSettings: (tabId: string, rollId: string) => void;
  onApplyRollFilmBase: (rollId: string) => void;
  onRemoveFromRoll: (tabId: string) => void;
  onOpenRollInfo: (rollId: string) => void;
  /** Hides the thumbnails and keeps the header row, to give the image more height. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

type ContextMenuState = { tabId: string; rollId: string; x: number; y: number } | null;

const ACTION_CLASS = 'flex items-center gap-1.5 rounded-md border border-zinc-700/70 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40';

function FrameStatus({ tab }: { tab: DocumentTab }) {
  const { settings, cropSource, dirty } = tab.document;
  const hasBase = Boolean(settings.filmBaseSample);
  const hasCrop = Boolean(cropSource);
  return (
    <span className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1">
      {hasBase && (
        <span title="Film base set" className="flex h-4 w-4 items-center justify-center rounded bg-zinc-950/80 text-emerald-400">
          <Pipette size={9} />
        </span>
      )}
      {hasCrop && (
        <span title={cropSource === 'auto' ? 'Auto crop' : 'Cropped'} className="flex h-4 w-4 items-center justify-center rounded bg-zinc-950/80 text-sky-400">
          <Crop size={9} />
        </span>
      )}
      {dirty && <span title="Unsaved edits" className="h-1.5 w-1.5 rounded-full bg-accent-400 shadow-[0_0_0_2px_rgba(9,9,11,0.8)]" />}
    </span>
  );
}

/**
 * Open frames as a strip of thumbnails. Click selects and opens a frame,
 * Cmd/Ctrl-click and Shift-click build a selection, and the selection bar
 * applies roll-style actions to exactly the selected frames.
 */
export const Filmstrip = memo(function Filmstrip({
  tabs,
  activeTabId,
  selectedIds,
  thumbnails,
  getRollById,
  isBusy = false,
  onFrameClick,
  onCloseTab,
  onAddImages,
  onReorderTabs,
  onSyncSettings,
  onStabilizeCrops,
  onExportFrames,
  onClearSelection,
  onSyncRollSettings,
  onApplyRollFilmBase,
  onRemoveFromRoll,
  onOpenRollInfo,
  collapsed = false,
  onToggleCollapsed,
}: FilmstripProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab] as const)), [tabs]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const multiSelect = selectedIds.length > 1;
  const activeTab = activeTabId ? tabsById.get(activeTabId) ?? null : null;
  const activeRoll = getRollById(activeTab?.rollId ?? null);
  const otherSelectedIds = selectedIds.filter((id) => id !== activeTabId);

  return (
    <section aria-label="Filmstrip" className="shrink-0 border-t border-zinc-800 bg-zinc-950">
      <div className={`flex h-8 items-center gap-3 px-4 ${collapsed ? '' : 'border-b border-zinc-900'}`}>
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
          {activeRoll ? activeRoll.name : 'Open frames'}
        </span>
        <span className="font-mono text-[10px] text-zinc-600">
          {activeTab ? `${tabs.indexOf(activeTab) + 1} / ${tabs.length}` : tabs.length}
        </span>

        {multiSelect && (
          <div role="toolbar" aria-label="Selected frames" className="flex items-center gap-1.5 rounded-lg border border-accent-400/30 bg-accent-400/10 py-0.5 pl-2.5 pr-1">
            <span className="mr-1 text-[11px] font-medium text-accent-200">{selectedIds.length} selected</span>
            <button
              type="button"
              className={ACTION_CLASS}
              disabled={isBusy || !activeTabId || otherSelectedIds.length === 0}
              onClick={() => activeTabId && onSyncSettings(activeTabId, otherSelectedIds)}
              data-tip="Copy the current frame's look to the other selected frames. Each frame keeps its own crop, rotation and dust repairs."
            >
              <RefreshCw size={11} /> Sync look
            </button>
            <button
              type="button"
              className={ACTION_CLASS}
              disabled={isBusy}
              onClick={() => onStabilizeCrops(selectedIds)}
              data-tip="Auto crop the selected frames and share a robust crop size between frames scanned at the same size"
            >
              <ScanLine size={11} /> Stabilize crops
            </button>
            <button
              type="button"
              className={ACTION_CLASS}
              disabled={isBusy}
              onClick={() => onExportFrames(selectedIds)}
              data-tip="Export each selected frame with its own edits"
            >
              <Download size={11} /> Export {selectedIds.length}
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              aria-label="Clear selection"
              data-tip="Clear selection (Esc)"
              className="flex h-6 w-6 items-center justify-center rounded-md text-accent-200/70 transition-colors hover:bg-accent-400/10 hover:text-accent-100"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <span className="ml-auto hidden text-[10px] text-zinc-600 lg:inline">
          ⌘/Ctrl-click or Shift-click to select several frames
        </span>
        <button
          type="button"
          onClick={onAddImages}
          aria-label="Add images"
          data-tip="Add images (⌘O)"
          className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
        >
          <Plus size={12} /> Add
        </button>
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Show filmstrip' : 'Hide filmstrip'}
            aria-expanded={!collapsed}
            data-tip={`${collapsed ? 'Show' : 'Hide'} filmstrip (F)`}
            className="-mr-2 flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>

      {!collapsed && (
        <ol className="custom-scrollbar flex gap-2.5 overflow-x-auto px-4 py-2" aria-label="Frames">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const isSelected = selected.has(tab.id);
            const accent = getRollAccent(tab.rollId);
            const thumbnail = thumbnails[tab.id];
            const isStale = Boolean(thumbnail) && thumbnail.key !== getThumbnailKey(tab.document);
            const name = tab.document.source.name;

            return (
              <li
                key={tab.id}
                className="group relative w-[124px] shrink-0"
                draggable
                onDragStart={() => setDraggedTabId(tab.id)}
                onDragEnd={() => setDraggedTabId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const draggedTab = draggedTabId ? tabsById.get(draggedTabId) ?? null : null;
                  setDraggedTabId(null);
                  if (!draggedTab || draggedTab.id === tab.id) return;
                  // Frames stay within their roll unless Alt is held.
                  if (!event.altKey && draggedTab.rollId !== tab.rollId) return;
                  onReorderTabs(draggedTab.id, tab.id);
                }}
                onContextMenu={(event) => {
                  if (!tab.rollId) return;
                  event.preventDefault();
                  setContextMenu({ tabId: tab.id, rollId: tab.rollId, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  aria-label={`Frame ${index + 1}: ${name}`}
                  aria-current={isActive ? 'true' : undefined}
                  aria-pressed={multiSelect ? isSelected : undefined}
                  onClick={(event) => onFrameClick(tab.id, {
                    toggle: event.metaKey || event.ctrlKey,
                    range: event.shiftKey,
                  })}
                  className={`relative block h-[78px] w-full overflow-hidden rounded-lg bg-zinc-900 transition-shadow ${
                    isActive
                      ? 'ring-2 ring-zinc-100'
                      : isSelected
                        ? 'ring-2 ring-accent-400'
                        : 'ring-1 ring-zinc-800 hover:ring-zinc-600'
                  }`}
                >
                  {thumbnail ? (
                    <img src={thumbnail.url} alt="" draggable={false} className={`h-full w-full object-contain ${isStale ? 'opacity-60' : ''}`} />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-600">
                      {tab.document.status === 'loading' ? 'Loading' : 'Open to preview'}
                    </span>
                  )}
                  {tab.rollId && <span className={`absolute inset-x-0 top-0 h-[3px] ${accent.dot}`} aria-hidden="true" />}
                  {multiSelect && isSelected && (
                    <span className="absolute left-1 top-1.5 flex h-4 w-4 items-center justify-center rounded bg-accent-400 text-[10px] font-bold text-zinc-950" aria-hidden="true">✓</span>
                  )}
                  {isStale && (
                    <span title="Edited in the background; open the frame to refresh" className="absolute left-1 bottom-1 rounded bg-zinc-950/80 px-1 font-mono text-[8px] text-zinc-400">
                      ↻
                    </span>
                  )}
                  <FrameStatus tab={tab} />
                </button>
                <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-zinc-500">
                  <span className={isActive ? 'text-zinc-200' : ''}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onCloseTab(tab.id)}
                  aria-label={`Close ${name}`}
                  className="absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded bg-zinc-950/80 text-zinc-400 opacity-0 transition-opacity hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {contextMenu && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setContextMenu(null)} aria-label="Close roll actions" />
          <div
            role="menu"
            className="fixed z-50 min-w-[220px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50"
            style={{ left: contextMenu.x, top: Math.max(8, contextMenu.y - 190) }}
          >
            <div className="border-b border-zinc-800 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Roll: {getRollById(contextMenu.rollId)?.name ?? 'Untitled Roll'}
              </p>
            </div>
            {([
              ['Sync Settings To Roll', <RefreshCw key="sync" size={14} />, () => onSyncRollSettings(contextMenu.tabId, contextMenu.rollId)],
              ['Apply Film Base To Roll', <Pipette key="base" size={14} />, () => onApplyRollFilmBase(contextMenu.rollId)],
              ['Remove From Roll', <Unlink2 key="remove" size={14} />, () => onRemoveFromRoll(contextMenu.tabId)],
              ['Roll Info…', <Info key="info" size={14} />, () => onOpenRollInfo(contextMenu.rollId)],
            ] as Array<[string, React.ReactNode, () => void]>).map(([label, icon, run]) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                onClick={() => {
                  run();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
});
