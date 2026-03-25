import React from 'react';
import { Download, RefreshCw, X } from 'lucide-react';

type UpdateBannerProps = {
  version: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;
  isBusy: boolean;
  onCheckNow: () => void;
  onDownload: () => void;
  onDismiss: () => void;
};

export function UpdateBanner({
  version,
  releaseNotes,
  downloadProgress,
  isBusy,
  onCheckNow,
  onDownload,
  onDismiss,
}: UpdateBannerProps) {
  return (
    <div className="z-20 flex shrink-0 items-center justify-between gap-4 border-b border-sky-500/25 bg-[linear-gradient(90deg,rgba(14,116,144,0.82),rgba(37,99,235,0.82))] px-4 py-2 text-sm text-white shadow-lg shadow-sky-950/30">
      <div className="min-w-0">
        <p className="truncate font-medium">DarkSlide {version} is available.</p>
        {releaseNotes && (
          <p className="truncate text-xs text-sky-100/80">{releaseNotes.split('\n')[0]}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {downloadProgress !== null && (
          <div className="w-28 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-1.5 rounded-full bg-white transition-[width]"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        )}
        <button
          type="button"
          onClick={onCheckNow}
          className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/10"
        >
          Check Now
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-sky-950 transition-colors hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
          {isBusy ? 'Downloading…' : 'Download & Restart'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Dismiss update"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
