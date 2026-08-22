import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Plus,
  RefreshCw,
  Unlink2,
  X,
} from 'lucide-react';
import { DocumentTab, FilmProfile, LightSourceProfile, Roll } from '../types';
import { getRollAccent } from '../utils/rolls';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { DocumentThumbnail } from './DocumentThumbnail';

interface TabBarProps {
  tabs: DocumentTab[];
  activeTabId: string | null;
  workerClient: ImageWorkerClient | null;
  profilesById: Map<string, FilmProfile>;
  lightSourceProfilesById: Map<string, LightSourceProfile>;
  getRollById: (rollId: string | null) => Roll | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onSyncRollSettings: (tabId: string, rollId: string) => void;
  onApplyRollFilmBase: (rollId: string) => void;
  onRemoveFromRoll: (tabId: string) => void;
  onOpenRollInfo: (rollId: string) => void;
  selectedIds: Set<string>;
  onSelectionChange: React.Dispatch<React.SetStateAction<Set<string>>>;
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
  workerClient,
  profilesById,
  lightSourceProfilesById,
  getRollById,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onReorderTabs,
  onSyncRollSettings,
  onApplyRollFilmBase,
  onRemoveFromRoll,
  onOpenRollInfo,
  selectedIds,
  onSelectionChange: setSelectedIds,
}: TabBarProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(activeTabId);
  const previousActiveIdRef = useRef(activeTabId);
  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab] as const)), [tabs]);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

  useEffect(() => {
    const activeChanged = previousActiveIdRef.current !== activeTabId;
    previousActiveIdRef.current = activeTabId;
    setSelectedIds((current) => {
      const liveIds = new Set(tabs.map((tab) => tab.id));
      const next = new Set(Array.from(current).filter((id) => liveIds.has(id)));
      if (activeChanged && current.size <= 1 && activeTabId) {
        return new Set([activeTabId]);
      }
      if (next.size === 0 && activeTabId) next.add(activeTabId);
      if (next.size === current.size && Array.from(next).every((id) => current.has(id))) return current;
      return next;
    });
  }, [activeTabId, setSelectedIds, tabs]);

  useEffect(() => {
    if (!activeTabId) return;
    itemRefs.current.get(activeTabId)?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeTabId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (isEditable || document.querySelector('[role="dialog"]')) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelectedIds(new Set(tabs.map((tab) => tab.id)));
        setSelectionAnchorId(activeTabId ?? tabs[0]?.id ?? null);
      } else if (event.key === 'Escape' && selectedIds.size > 1) {
        event.preventDefault();
        const fallbackId = activeTabId ?? tabs[0]?.id;
        setSelectedIds(new Set(fallbackId ? [fallbackId] : []));
        setSelectionAnchorId(fallbackId ?? null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, selectedIds.size, setSelectedIds, tabs]);

  const move = (direction: -1 | 1) => {
    if (tabs.length < 2) return;
    const nextIndex = activeIndex < 0
      ? 0
      : (activeIndex + direction + tabs.length) % tabs.length;
    const nextId = tabs[nextIndex]?.id;
    if (!nextId) return;
    setSelectedIds(new Set([nextId]));
    setSelectionAnchorId(nextId);
    onSelectTab(nextId);
  };

  const handleFrameClick = (event: React.MouseEvent, tabId: string) => {
    if (event.shiftKey && selectionAnchorId) {
      const anchorIndex = tabs.findIndex((tab) => tab.id === selectionAnchorId);
      const nextIndex = tabs.findIndex((tab) => tab.id === tabId);
      if (anchorIndex >= 0 && nextIndex >= 0) {
        const [start, end] = anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
        setSelectedIds(new Set(tabs.slice(start, end + 1).map((tab) => tab.id)));
      }
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(tabId) && next.size > 1) next.delete(tabId);
        else next.add(tabId);
        return next;
      });
      setSelectionAnchorId(tabId);
    } else {
      setSelectedIds(new Set([tabId]));
      setSelectionAnchorId(tabId);
    }
    onSelectTab(tabId);
  };

  const toggleFrameSelection = (tabId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
    setSelectionAnchorId(tabId);
  };

  return (
    <>
      <section aria-label="Filmstrip" className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 shadow-[0_-12px_40px_rgba(0,0,0,0.24)]">
        <div className="grid h-[112px] grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-1 px-2">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={tabs.length < 2}
            aria-label="Previous image"
            className="flex h-16 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-25"
          >
            <ChevronLeft size={18} />
          </button>

          <div ref={filmstripRef} className="custom-scrollbar flex min-w-0 gap-2 overflow-x-auto py-2">
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeTabId;
              const isSelected = selectedIds.has(tab.id);
              const accent = getRollAccent(tab.rollId);
              const profile = profilesById.get(tab.document.profileId) ?? null;
              const lightSource = lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto') ?? null;

              return (
                <div
                  key={tab.id}
                  ref={(element) => {
                    if (element) itemRefs.current.set(tab.id, element);
                    else itemRefs.current.delete(tab.id);
                  }}
                  draggable
                  onDragStart={() => setDraggedTabId(tab.id)}
                  onDragEnd={() => setDraggedTabId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    if (!draggedTabId || draggedTabId === tab.id) return setDraggedTabId(null);
                    const draggedTab = tabsById.get(draggedTabId) ?? null;
                    if (!event.altKey && draggedTab?.rollId !== tab.rollId) return setDraggedTabId(null);
                    onReorderTabs(draggedTabId, tab.id);
                    setDraggedTabId(null);
                  }}
                  onContextMenu={(event) => {
                    if (!tab.rollId) return;
                    event.preventDefault();
                    setContextMenu({ tabId: tab.id, rollId: tab.rollId, x: event.clientX, y: event.clientY });
                  }}
                  className={`group relative shrink-0 rounded-xl border p-1 transition-all ${
                    isActive
                      ? 'border-amber-400 bg-amber-400/10 shadow-[0_0_0_1px_rgba(251,191,36,0.25)]'
                      : isSelected
                        ? 'border-amber-500/60 bg-amber-400/[0.06] shadow-[0_0_0_1px_rgba(251,191,36,0.1)]'
                        : 'border-transparent bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900'
                  }`}
                  style={isActive && tab.rollId ? { boxShadow: `0 0 0 1px ${accent.tint}` } : undefined}
                >
                  <button
                    type="button"
                    onClick={(event) => handleFrameClick(event, tab.id)}
                    aria-label={`Open ${tab.document.source.name}`}
                    aria-pressed={isSelected}
                    className="block text-left"
                    title={`${index + 1}. ${tab.document.source.name}${eventLabel(tab.rollId, getRollById)} · Shift-click a range · Cmd/Ctrl-click to add`}
                  >
                    <DocumentThumbnail
                      workerClient={workerClient}
                      document={tab.document}
                      profile={profile}
                      lightSource={lightSource}
                      width={112}
                      height={62}
                      className="rounded-lg"
                      isActive={isActive}
                    />
                    <span className={`mt-1 block w-28 truncate px-0.5 text-[10px] ${isActive ? 'text-zinc-100' : 'text-zinc-500'}`}>
                      <span className="mr-1 font-mono text-zinc-600">{String(index + 1).padStart(2, '0')}</span>
                      {tab.document.source.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    draggable={false}
                    aria-label={`${isSelected ? 'Deselect' : 'Select'} ${tab.document.source.name}`}
                    aria-pressed={isSelected}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFrameSelection(tab.id);
                    }}
                    className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border shadow-sm backdrop-blur transition-all ${
                      isSelected
                        ? 'border-amber-300 bg-amber-400 text-zinc-950 opacity-100'
                        : 'border-zinc-600 bg-black/65 text-transparent opacity-0 hover:border-zinc-400 group-hover:opacity-100'
                    }`}
                  >
                    <Check size={12} strokeWidth={2.5} />
                  </button>
                  {tab.document.dirty && <span className="absolute bottom-7 left-2 h-1.5 w-1.5 rounded-full bg-amber-400 shadow" aria-label="Edited" />}
                  <button
                    type="button"
                    onClick={() => onCloseTab(tab.id)}
                    aria-label={`Close ${tab.document.source.name}`}
                    className="absolute right-1.5 top-1.5 rounded-md bg-black/70 p-1 text-zinc-400 opacity-0 backdrop-blur transition-all hover:bg-red-500 hover:text-white group-hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={onCreateTab}
              className="flex h-[92px] w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-zinc-800 text-[10px] text-zinc-600 transition-colors hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
            >
              <Plus size={17} /> Add
            </button>
          </div>

          <button
            type="button"
            onClick={() => move(1)}
            disabled={tabs.length < 2}
            aria-label="Next image"
            className="flex h-16 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-25"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </section>

      {contextMenu && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setContextMenu(null)} aria-label="Close roll actions" />
          <div className="fixed z-50 min-w-[230px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-1 shadow-2xl" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <p className="border-b border-zinc-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              {getRollById(contextMenu.rollId)?.name ?? 'Untitled roll'}
            </p>
            <MenuButton icon={<RefreshCw size={14} />} label="Sync settings to roll" onClick={() => onSyncRollSettings(contextMenu.tabId, contextMenu.rollId)} close={() => setContextMenu(null)} />
            <MenuButton icon={<RefreshCw size={14} />} label="Apply film base to roll" onClick={() => onApplyRollFilmBase(contextMenu.rollId)} close={() => setContextMenu(null)} />
            <MenuButton icon={<Unlink2 size={14} />} label="Remove from roll" onClick={() => onRemoveFromRoll(contextMenu.tabId)} close={() => setContextMenu(null)} />
            <MenuButton icon={<Info size={14} />} label="Roll info" onClick={() => onOpenRollInfo(contextMenu.rollId)} close={() => setContextMenu(null)} />
          </div>
        </>
      )}
    </>
  );
}

function eventLabel(rollId: string | null, getRollById: (rollId: string | null) => Roll | null) {
  const roll = getRollById(rollId);
  return roll ? ` · ${roll.name}` : '';
}

function MenuButton({ icon, label, onClick, close }: { icon: React.ReactNode; label: string; onClick: () => void; close: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { onClick(); close(); }}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
    >
      {icon}{label}
    </button>
  );
}
