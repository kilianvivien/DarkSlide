import React from 'react';
import { FolderOpen, ScanLine, Square, X } from 'lucide-react';
import { DocumentTab, FilmProfile, LightSourceProfile } from '../types';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { DocumentThumbnail } from './DocumentThumbnail';

type ScanQueueEntry = {
  path: string;
  filename: string;
  status: 'queued' | 'importing' | 'processing' | 'ready' | 'exported' | 'error';
  documentId?: string;
  error?: string;
  timestamp: number;
};

type ScanningSessionPanelProps = {
  isDesktop: boolean;
  isOpen: boolean;
  watchPath: string | null;
  isWatching: boolean;
  autoExport: boolean;
  autoExportPath: string | null;
  queue: ScanQueueEntry[];
  workerClient: ImageWorkerClient | null;
  tabs: DocumentTab[];
  profilesById: Map<string, FilmProfile>;
  lightSourceProfilesById: Map<string, LightSourceProfile>;
  onClose: () => void;
  onPickWatchPath: () => void;
  onToggleWatching: () => void;
  onToggleAutoExport: (enabled: boolean) => void;
  onPickAutoExportPath: () => void;
  onSelectTab: (tabId: string) => void;
  onClearQueue: () => void;
};

const STATUS_TONE: Record<ScanQueueEntry['status'], string> = {
  queued: 'bg-sky-400',
  importing: 'bg-amber-400',
  processing: 'bg-yellow-400',
  ready: 'bg-emerald-300',
  exported: 'bg-emerald-400',
  error: 'bg-red-400',
};

export function ScanningSessionPanel({
  isDesktop,
  isOpen,
  watchPath,
  isWatching,
  autoExport,
  autoExportPath,
  queue,
  workerClient,
  tabs,
  profilesById,
  lightSourceProfilesById,
  onClose,
  onPickWatchPath,
  onToggleWatching,
  onToggleAutoExport,
  onPickAutoExportPath,
  onSelectTab,
  onClearQueue,
}: ScanningSessionPanelProps) {
  if (!isDesktop || !isOpen) {
    return null;
  }

  const processedCount = queue.filter((entry) => entry.status === 'ready' || entry.status === 'exported').length;
  const errorCount = queue.filter((entry) => entry.status === 'error').length;

  return (
    <div className="absolute inset-x-4 bottom-4 z-30 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Scanning Session</p>
          <p className="mt-1 truncate text-sm text-zinc-200">{watchPath ?? 'Choose a watch folder to begin'}</p>
        </div>
        <button
          type="button"
          onClick={onPickWatchPath}
          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          <FolderOpen size={14} />
          Folder
        </button>
        <button
          type="button"
          disabled={!watchPath}
          onClick={onToggleWatching}
          className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            isWatching
              ? 'bg-red-500/15 text-red-200 hover:bg-red-500/20'
              : 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20'
          }`}
        >
          {isWatching ? <Square size={13} /> : <ScanLine size={13} />}
          {isWatching ? 'Stop' : 'Start'}
        </button>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={autoExport}
            onChange={(event) => onToggleAutoExport(event.target.checked)}
            className="rounded border-zinc-700 bg-zinc-900"
          />
          Auto-export
        </label>
        {autoExport && (
          <button
            type="button"
            onClick={onPickAutoExportPath}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
          >
            {autoExportPath ?? 'Choose export folder'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Close scanning session"
        >
          <X size={15} />
        </button>
      </div>

      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex gap-3 overflow-x-auto pb-1">
          {queue.length === 0 && (
            <div className="flex h-[88px] w-full items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950 text-xs text-zinc-600">
              New scans will appear here as they arrive.
            </div>
          )}
          {queue.map((entry) => {
            const tab = entry.documentId ? tabs.find((candidate) => candidate.id === entry.documentId) ?? null : null;
            const profile = tab ? profilesById.get(tab.document.profileId) ?? null : null;
            const lightSource = tab ? lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto') ?? null : null;

            return (
              <button
                key={`${entry.path}-${entry.timestamp}`}
                type="button"
                disabled={!entry.documentId}
                onClick={() => entry.documentId && onSelectTab(entry.documentId)}
                className="flex shrink-0 flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-2 text-left transition-colors hover:bg-zinc-900 disabled:cursor-default"
                title={entry.error || entry.filename}
              >
                {tab ? (
                  <DocumentThumbnail
                    workerClient={workerClient}
                    document={tab.document}
                    profile={profile}
                    lightSource={lightSource}
                    size={64}
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-600">
                    Scan
                  </div>
                )}
                <div className="w-16">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${STATUS_TONE[entry.status]}`} />
                    <span className="truncate text-[10px] uppercase tracking-[0.18em] text-zinc-500">{entry.status}</span>
                  </div>
                  <p className="truncate text-[11px] text-zinc-200">{entry.filename}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-zinc-400">
        <p>
          {processedCount} scanned · {errorCount} error{errorCount === 1 ? '' : 's'} · {isWatching ? 'Watching…' : 'Idle'}
        </p>
        <button
          type="button"
          onClick={onClearQueue}
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          Clear Queue
        </button>
      </div>
    </div>
  );
}
