import React, { useState } from 'react';
import { Clock } from 'lucide-react';
import { isDesktopShell, openImageFileByPath } from '../utils/fileBridge';
import { clearRecentFiles, loadRecentFiles, RecentFileEntry } from '../utils/recentFilesStore';

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

interface RecentFilesListProps {
  onImport: (file: File, path: string | null, size?: number) => void;
  onOpenPicker: () => void;
}

export function RecentFilesList({ onImport, onOpenPicker }: RecentFilesListProps) {
  const [entries, setEntries] = useState<RecentFileEntry[]>(() => loadRecentFiles());
  const isDesktop = isDesktopShell();

  const handleClear = () => {
    clearRecentFiles();
    setEntries([]);
  };

  const handleRowClick = async (entry: RecentFileEntry) => {
    if (!isDesktop || !entry.path) {
      onOpenPicker();
      return;
    }
    try {
      const result = await openImageFileByPath(entry.path);
      if (result) {
        onImport(result.file, entry.path, result.size);
      }
    } catch {
      onOpenPicker();
    }
  };

  if (entries.length === 0) return null;

  return (
    <div className="mt-8 w-full max-w-sm">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Recent</p>
      <div className="flex flex-col gap-1">
        {entries.map((entry, i) => {
          const canOpen = isDesktop && entry.path;
          return (
            <button
              key={i}
              onClick={() => void handleRowClick(entry)}
              className={`flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors w-full ${
                canOpen ? 'hover:bg-zinc-800/60' : 'opacity-50 cursor-default'
              }`}
            >
              <Clock size={14} className="text-zinc-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-300 truncate">{entry.name}</p>
                <p className="text-xs text-zinc-600">
                  {formatSize(entry.size)} · {formatRelativeTime(entry.timestamp)}
                  {!canOpen ? ' · re-import to open' : ''}
                </p>
              </div>
            </button>
          );
        })}
      </div>
      <button
        onClick={handleClear}
        className="mt-3 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        Clear
      </button>
    </div>
  );
}
