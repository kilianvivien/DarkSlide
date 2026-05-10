import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Copy, Info, X } from 'lucide-react';
import { dismissToast, getToasts, subscribeToasts, Toast, ToastLevel } from '../utils/toastStore';

const LEVEL_STYLES: Record<ToastLevel, { container: string; iconColor: string; Icon: typeof Info }> = {
  info: {
    container: 'border-zinc-700 bg-zinc-900/95 text-zinc-100',
    iconColor: 'text-sky-400',
    Icon: Info,
  },
  success: {
    container: 'border-emerald-800/70 bg-zinc-900/95 text-zinc-100',
    iconColor: 'text-emerald-400',
    Icon: CheckCircle2,
  },
  warning: {
    container: 'border-amber-800/70 bg-zinc-900/95 text-zinc-100',
    iconColor: 'text-amber-400',
    Icon: AlertTriangle,
  },
  error: {
    container: 'border-red-800/70 bg-zinc-900/95 text-zinc-100',
    iconColor: 'text-red-400',
    Icon: AlertTriangle,
  },
};

function ToastCard({ toast }: { toast: Toast }) {
  const [copied, setCopied] = useState(false);
  const styles = LEVEL_STYLES[toast.level];
  const { Icon } = styles;

  const handleCopy = async () => {
    if (!toast.diagnosticId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(toast.diagnosticId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in some contexts (Tauri webview without
      // permission). Silently ignore — the id is already visible in the toast.
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 12, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      role={toast.level === 'error' || toast.level === 'warning' ? 'alert' : 'status'}
      aria-live={toast.level === 'error' ? 'assertive' : 'polite'}
      className={`pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] gap-3 rounded-xl border px-3.5 py-3 shadow-xl shadow-black/40 backdrop-blur ${styles.container}`}
    >
      <Icon size={16} className={`mt-0.5 shrink-0 ${styles.iconColor}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">{toast.title}</p>
        {toast.message && (
          <p className="mt-1 text-[12px] leading-snug text-zinc-400">{toast.message}</p>
        )}
        {toast.diagnosticId && (
          <button
            type="button"
            onClick={handleCopy}
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <Copy size={11} />
            <span className="font-mono">{toast.diagnosticId.slice(0, 8)}</span>
            <span>{copied ? 'Copied' : 'Copy ID'}</span>
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
        className="mt-0.5 shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<readonly Toast[]>(() => getToasts());

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}
