import React, { useMemo, useState } from 'react';
import { Info, Plus, RefreshCw, Unlink2, X } from 'lucide-react';
import { DocumentTab, Roll } from '../types';
import { getRollAccent } from '../utils/rolls';

interface TabBarProps {
  tabs: DocumentTab[];
  activeTabId: string | null;
  getRollById: (rollId: string | null) => Roll | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onSyncRollSettings: (tabId: string, rollId: string) => void;
  onApplyRollFilmBase: (rollId: string) => void;
  onRemoveFromRoll: (tabId: string) => void;
  onOpenRollInfo: (rollId: string) => void;
}

function truncateLabel(value: string, maxLength = 20) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

type ContextMenuState = {
  tabId: string;
  rollId: string;
  x: number;
  y: number;
} | null;

export function TabBar({
  tabs,
  activeTabId,
  getRollById,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onReorderTabs,
  onSyncRollSettings,
  onApplyRollFilmBase,
  onRemoveFromRoll,
  onOpenRollInfo,
}: TabBarProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab] as const)), [tabs]);

  return (
    <>
      <div className="flex h-10 items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-950 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const previousRollId = tabs[index - 1]?.rollId ?? null;
            const showSeparator = index > 0 && previousRollId !== tab.rollId;
            const accent = getRollAccent(tab.rollId);
            const roll = getRollById(tab.rollId);

            return (
              <React.Fragment key={tab.id}>
                {showSeparator && (
                  <div
                    className={`mx-1 h-5 w-1 shrink-0 rounded-full ${accent.dot}`}
                    style={{ boxShadow: `0 0 0 1px ${accent.tint}` }}
                    aria-hidden="true"
                  />
                )}
                <div className="relative shrink-0">
                  <div
                    draggable
                    onDragStart={() => setDraggedTabId(tab.id)}
                    onDragEnd={() => setDraggedTabId(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      if (!draggedTabId || draggedTabId === tab.id) {
                        setDraggedTabId(null);
                        return;
                      }

                      const draggedTab = tabsById.get(draggedTabId) ?? null;
                      const allowCrossRoll = event.altKey;
                      if (!allowCrossRoll && draggedTab?.rollId !== tab.rollId) {
                        setDraggedTabId(null);
                        return;
                      }

                      onReorderTabs(draggedTabId, tab.id);
                      setDraggedTabId(null);
                    }}
                    onContextMenu={(event) => {
                      if (!tab.rollId) {
                        return;
                      }
                      event.preventDefault();
                      setContextMenu({
                        tabId: tab.id,
                        rollId: tab.rollId,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    className={`group relative z-10 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-[background-color,color,border-color,box-shadow] duration-100 ${
                      isActive
                        ? `${accent.border} bg-zinc-800/90 text-zinc-100`
                        : 'border-transparent text-zinc-500 hover:bg-zinc-900/70 hover:text-zinc-300'
                    }`}
                    style={isActive ? { boxShadow: `inset 0 0 0 1px ${accent.tint}` } : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTab(tab.id)}
                      className="flex min-w-0 items-center gap-2"
                      title={roll ? `${tab.document.source.name} · ${roll.name}` : tab.document.source.name}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${tab.rollId ? accent.dot : tab.document.dirty ? 'bg-amber-400' : isActive ? 'bg-zinc-500' : 'bg-zinc-700'}`} />
                      <span className="max-w-[160px] truncate font-medium">{truncateLabel(tab.document.source.name)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className={`rounded p-0.5 transition-colors hover:text-zinc-100 ${isActive ? 'text-zinc-400' : 'text-zinc-600 opacity-0 group-hover:opacity-100'}`}
                      aria-label={`Close ${tab.document.source.name}`}
                    >
                      <X size={11} />
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onCreateTab}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
          aria-label="Open another image"
        >
          <Plus size={14} />
        </button>
      </div>

      {contextMenu && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setContextMenu(null)}
            aria-label="Close roll actions"
          />
          <div
            className="fixed z-50 min-w-[220px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="border-b border-zinc-800 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Roll: {getRollById(contextMenu.rollId)?.name ?? 'Untitled Roll'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                onSyncRollSettings(contextMenu.tabId, contextMenu.rollId);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
            >
              <RefreshCw size={14} />
              Sync Settings To Roll
            </button>
            <button
              type="button"
              onClick={() => {
                onApplyRollFilmBase(contextMenu.rollId);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
            >
              <RefreshCw size={14} />
              Apply Film Base To Roll
            </button>
            <button
              type="button"
              onClick={() => {
                onRemoveFromRoll(contextMenu.tabId);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
            >
              <Unlink2 size={14} />
              Remove From Roll
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenRollInfo(contextMenu.rollId);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
            >
              <Info size={14} />
              Roll Info…
            </button>
          </div>
        </>
      )}
    </>
  );
}
