import React, { useCallback, useEffect, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  FolderOpen,
  Loader2,
  ScanLine,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import './index.css';

type ScanEntryState = {
  path: string;
  filename: string;
  status: 'queued' | 'importing' | 'processing' | 'ready' | 'exported' | 'error';
  documentId?: string;
  error?: string;
  timestamp: number;
};

type ScanningState = {
  watchPath: string | null;
  isWatching: boolean;
  autoExport: boolean;
  autoExportPath: string | null;
  queue: ScanEntryState[];
};

const STATUS_CONFIG: Record<ScanEntryState['status'], { icon: typeof Clock; label: string; color: string; bg: string }> = {
  queued: { icon: Clock, label: 'Queued', color: 'text-sky-400', bg: 'bg-sky-400/10' },
  importing: { icon: Loader2, label: 'Importing', color: 'text-amber-400', bg: 'bg-amber-400/10' },
  processing: { icon: Loader2, label: 'Processing', color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  ready: { icon: CheckCircle2, label: 'Ready', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  exported: { icon: Upload, label: 'Exported', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  error: { icon: CircleAlert, label: 'Error', color: 'text-red-400', bg: 'bg-red-400/10' },
};

const ScanEntryRow: React.FC<{ entry: ScanEntryState; onSelect: (id: string) => void }> = ({ entry, onSelect }) => {
  const config = STATUS_CONFIG[entry.status];
  const StatusIcon = config.icon;
  const isSpinning = entry.status === 'importing' || entry.status === 'processing';

  return (
    <button
      type="button"
      disabled={!entry.documentId}
      onClick={() => entry.documentId && onSelect(entry.documentId)}
      className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/60 disabled:cursor-default"
      title={entry.error || entry.filename}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${config.bg}`}>
        <StatusIcon size={15} className={`${config.color} ${isSpinning ? 'animate-spin' : ''}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-zinc-200">{entry.filename}</p>
        {entry.error ? (
          <p className="truncate text-[11px] text-red-400/80">{entry.error}</p>
        ) : (
          <p className={`text-[11px] ${config.color} opacity-70`}>{config.label}</p>
        )}
      </div>
      <span className="text-[10px] tabular-nums text-zinc-600">
        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </button>
  );
};

export default function ScanningSessionWindow() {
  const [state, setState] = useState<ScanningState>({
    watchPath: null,
    isWatching: false,
    autoExport: false,
    autoExportPath: null,
    queue: [],
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<ScanningState>('scanning://state-update', (event) => {
        if (!cancelled) {
          setState(event.payload);
        }
      });

      // Request initial state from the main window.
      await emit('scanning://request-state');
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const sendCommand = useCallback((command: string, payload?: unknown) => {
    void emit(`scanning://command`, { command, payload });
  }, []);

  const processedCount = state.queue.filter((e) => e.status === 'ready' || e.status === 'exported').length;
  const errorCount = state.queue.filter((e) => e.status === 'error').length;
  const activeCount = state.queue.filter((e) => e.status === 'importing' || e.status === 'processing').length;
  const queuedCount = state.queue.filter((e) => e.status === 'queued').length;

  const folderName = state.watchPath?.split('/').pop() || state.watchPath;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-200 select-none">
      {/* Draggable title bar — two-part layout keeps macOS traffic lights clickable */}
      <div className="flex h-12 shrink-0 items-center">
        {/* Non-draggable zone over traffic lights */}
        <div className="w-20 shrink-0" />
        {/* Draggable center area */}
        <div className="flex flex-1 items-center justify-center" data-tauri-drag-region="true">
          <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-zinc-500" data-tauri-drag-region="true">
            Scanning Session
          </span>
        </div>
        {/* Balance spacer for centering */}
        <div className="w-20 shrink-0" data-tauri-drag-region="true" />
      </div>

      {/* Watch folder bar */}
      <div className="mx-3 flex items-center gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          {state.watchPath ? (
            <>
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Watch folder</p>
              <p className="mt-0.5 truncate text-[13px] font-medium text-zinc-200" title={state.watchPath}>
                {folderName}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-zinc-500">Choose a watch folder to begin</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => sendCommand('pick-watch-path')}
          className="flex items-center gap-1.5 rounded-xl border border-zinc-700/50 bg-zinc-800/50 px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700/50"
        >
          <FolderOpen size={13} />
          Folder
        </button>
        <button
          type="button"
          disabled={!state.watchPath}
          onClick={() => sendCommand('toggle-watching')}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            state.isWatching
              ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
              : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
          }`}
        >
          {state.isWatching ? <Square size={12} /> : <ScanLine size={12} />}
          {state.isWatching ? 'Stop' : 'Start'}
        </button>
      </div>

      {/* Auto-export bar */}
      <div className="mx-3 mt-2 flex items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-2.5">
        <label className="flex items-center gap-2 text-[12px] text-zinc-400">
          <input
            type="checkbox"
            checked={state.autoExport}
            onChange={(event) => sendCommand('toggle-auto-export', event.target.checked)}
            className="rounded border-zinc-700 bg-zinc-800"
          />
          Auto-export
        </label>
        {state.autoExport && (
          <button
            type="button"
            onClick={() => sendCommand('pick-export-path')}
            className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-[12px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title={state.autoExportPath || undefined}
          >
            {state.autoExportPath?.split('/').pop() || 'Choose export folder…'}
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="mx-3 mt-3 flex items-center gap-4 px-1">
        <div className="flex items-center gap-4 text-[11px] text-zinc-500">
          {state.isWatching && (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Watching
            </span>
          )}
          {activeCount > 0 && (
            <span className="text-yellow-400/80">{activeCount} processing</span>
          )}
          {queuedCount > 0 && (
            <span className="text-sky-400/80">{queuedCount} queued</span>
          )}
          <span>{processedCount} done</span>
          {errorCount > 0 && (
            <span className="text-red-400/80">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex-1" />
        {state.queue.length > 0 && (
          <button
            type="button"
            onClick={() => sendCommand('clear-queue')}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          >
            <Trash2 size={12} />
            Clear
          </button>
        )}
      </div>

      {/* Queue list */}
      <div className="mx-3 mt-2 mb-3 flex-1 overflow-y-auto rounded-2xl border border-zinc-800/80 bg-zinc-900/30">
        {state.queue.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-zinc-700/50 bg-zinc-900/50">
              <ScanLine size={20} className="text-zinc-600" />
            </div>
            <div>
              <p className="text-[13px] font-medium text-zinc-400">No scans yet</p>
              <p className="mt-1 text-[12px] text-zinc-600">
                {state.isWatching
                  ? 'New scans will appear here as they arrive.'
                  : 'Start watching a folder to begin.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-px p-1.5">
            {[...state.queue].reverse().map((entry: ScanEntryState) => (
              <ScanEntryRow
                key={`${entry.path}-${entry.timestamp}`}
                entry={entry}
                onSelect={(id) => sendCommand('select-tab', id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
