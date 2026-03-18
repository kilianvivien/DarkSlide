import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, X } from 'lucide-react';
import { DocumentTab } from '../types';

interface TabBarProps {
  tabs: DocumentTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
}

function truncateLabel(value: string, maxLength = 20) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onReorderTabs,
}: TabBarProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);

  return (
    <div className="flex h-10 items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-950 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          return (
            <motion.div
              key={tab.id}
              layout
              transition={{ type: 'spring', stiffness: 360, damping: 30, mass: 0.8 }}
              className="relative shrink-0"
            >
              {isActive && (
                <motion.div
                  layoutId="active-tab-pill"
                  className="absolute inset-0 rounded-lg bg-zinc-800/80 ring-1 ring-inset ring-zinc-700/60"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}

              <div
                draggable
                onDragStart={() => setDraggedTabId(tab.id)}
                onDragEnd={() => setDraggedTabId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (draggedTabId && draggedTabId !== tab.id) {
                    onReorderTabs(draggedTabId, tab.id);
                  }
                  setDraggedTabId(null);
                }}
                className={`group relative z-10 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ${
                  isActive
                    ? 'text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-900/70 hover:text-zinc-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="flex min-w-0 items-center gap-2"
                  title={tab.document.source.name}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${tab.document.dirty ? 'bg-amber-400' : isActive ? 'bg-zinc-500' : 'bg-zinc-700'}`} />
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
            </motion.div>
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
  );
}
