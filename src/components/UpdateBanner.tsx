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
    <div className="z-20 flex shrink-0 items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-[13px] text-zinc-200">
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-100">DarkSlide {version} is available.</p>
          {releaseNotes && (
            <p className="truncate text-xs text-zinc-500">{releaseNotes.split('\n')[0]}</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {downloadProgress !== null && (
          <div className="w-28 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-1.5 rounded-full bg-accent-400 transition-[width]"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        )}
        <button
          type="button"
          onClick={onCheckNow}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
        >
          Check Now
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
          {isBusy ? 'Downloading…' : 'Download & Restart'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Dismiss update"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
