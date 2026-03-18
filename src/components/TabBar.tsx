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
    <div className="flex h-11 items-center gap-2 border-b border-zinc-800 bg-zinc-950/85 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1 pt-1">
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
                  className="absolute inset-0 rounded-xl border border-zinc-600 bg-zinc-900 shadow-lg shadow-black/20"
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
                className={`group relative z-10 flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition-[border-color,color,transform] duration-200 ${
                  isActive
                    ? 'border-transparent bg-transparent text-zinc-100'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="flex min-w-0 items-center gap-2"
                  title={tab.document.source.name}
                >
                  <span className={`h-2 w-2 rounded-full transition-colors ${tab.document.dirty ? 'bg-amber-400' : 'bg-zinc-700'}`} />
                  <span className="max-w-[180px] truncate">{truncateLabel(tab.document.source.name)}</span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  aria-label={`Close ${tab.document.source.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onCreateTab}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-400 transition-all hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
        aria-label="Open another image"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
