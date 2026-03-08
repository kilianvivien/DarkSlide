import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Copy, Check } from 'lucide-react';
import { RenderBackendDiagnostics } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCopyDebugInfo: () => Promise<void>;
  gpuRenderingEnabled: boolean;
  renderBackendDiagnostics: RenderBackendDiagnostics;
  onToggleGPURendering: (enabled: boolean) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS = [
  { action: 'Open Image', key: `${mod}O` },
  { action: 'Close Image', key: `${mod}W` },
  { action: 'Undo', key: `${mod}Z` },
  { action: 'Redo', key: `${mod}⇧Z` },
  { action: 'Export', key: `${mod}E` },
  { action: 'Settings', key: `${mod},` },
  { action: 'Zoom to Fit', key: `${mod}0` },
  { action: 'Zoom 100%', key: `${mod}1` },
  { action: 'Zoom In', key: `${mod}=` },
  { action: 'Zoom Out', key: `${mod}−` },
  { action: 'Pan (hold)', key: 'Space' },
];

function getRenderBackendLabel(diagnostics: RenderBackendDiagnostics) {
  if (!diagnostics.gpuAvailable) {
    return 'Unavailable — your browser does not support WebGPU';
  }

  if (diagnostics.gpuActive) {
    if (diagnostics.backendMode === 'gpu-tiled-render') {
      return diagnostics.gpuAdapterName
        ? `Active — GPU tiled render on ${diagnostics.gpuAdapterName}`
        : 'Active — GPU tiled render';
    }
    return diagnostics.gpuAdapterName
      ? `Active — GPU (WebGPU) on ${diagnostics.gpuAdapterName}`
      : 'Active — GPU (WebGPU)';
  }

  if (!diagnostics.gpuEnabled) {
    return 'Active — CPU (GPU disabled in settings)';
  }

  return 'Active — CPU';
}

function getRenderBackendDetail(diagnostics: RenderBackendDiagnostics) {
  if (diagnostics.gpuDisabledReason === 'user') {
    return 'GPU acceleration is disabled by preference.';
  }
  if (diagnostics.gpuDisabledReason === 'unsupported') {
    return 'This browser or webview does not expose navigator.gpu.';
  }
  if (diagnostics.gpuDisabledReason === 'device-lost') {
    return diagnostics.lastError ?? 'The GPU device was lost. DarkSlide will retry on the next render.';
  }
  if (diagnostics.gpuDisabledReason === 'initialization-failed') {
    return diagnostics.lastError ?? 'WebGPU initialization failed, so rendering fell back to the CPU path.';
  }
  if (diagnostics.backendMode === 'gpu-tiled-render') {
    return 'WebGPU is processing texture-backed tiles on the main thread and assembling the final image tile by tile.';
  }

  if (diagnostics.usedCpuFallback) {
    return diagnostics.fallbackReason ?? 'The tiled GPU path failed and DarkSlide fell back to the CPU worker path.';
  }

  return diagnostics.gpuActive ? 'WebGPU is active on the main thread.' : 'The CPU worker path is currently active.';
}

function formatBytes(value: number | null) {
  if (value === null) {
    return 'Unavailable';
  }

  const gib = value / (1024 ** 3);
  if (gib >= 1) {
    return `${gib.toFixed(2)} GiB`;
  }

  const mib = value / (1024 ** 2);
  return `${mib.toFixed(0)} MiB`;
}

function getStatusBadge(diagnostics: RenderBackendDiagnostics): { label: string; color: 'green' | 'amber' | 'red' | 'zinc' } {
  if (!diagnostics.gpuAvailable) return { label: 'Unavailable', color: 'red' };
  if (diagnostics.usedCpuFallback) return { label: 'CPU Fallback', color: 'amber' };
  if (diagnostics.gpuDisabledReason === 'device-lost') return { label: 'Device Lost', color: 'red' };
  if (diagnostics.gpuDisabledReason === 'initialization-failed') return { label: 'Init Failed', color: 'red' };
  if (diagnostics.gpuDisabledReason === 'user') return { label: 'GPU Disabled', color: 'zinc' };
  if (diagnostics.gpuActive) return { label: 'Active', color: 'green' };
  return { label: 'CPU', color: 'zinc' };
}

function getJobDurationColor(ms: number | null): string {
  if (ms === null) return 'text-zinc-400';
  if (ms < 100) return 'text-emerald-400';
  if (ms < 300) return 'text-amber-400';
  return 'text-red-400';
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onCopyDebugInfo,
  gpuRenderingEnabled,
  renderBackendDiagnostics,
  onToggleGPURendering,
}) => {
  const [tab, setTab] = useState<'general' | 'shortcuts' | 'diagnostics'>('general');
  const [copied, setCopied] = useState(false);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [isOpen, onClose]);

  const handleCopy = async () => {
    await onCopyDebugInfo();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ type: 'spring', bounce: 0.1, duration: 0.25 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div
              className="pointer-events-auto w-[min(680px,calc(100vw-2rem))] max-h-[80vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
                <h2 className="text-sm font-semibold text-zinc-100 tracking-tight">Settings</h2>
                <button
                  onClick={onClose}
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex gap-4 px-6 pt-4 border-b border-zinc-800 shrink-0">
                {(['general', 'shortcuts', 'diagnostics'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`pb-3 text-[11px] uppercase tracking-widest font-semibold border-b-2 transition-all capitalize ${
                      tab === t ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                {tab === 'general' && (
                  <div className="space-y-6">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
                        <img src="/favicon.png" alt="DarkSlide" className="w-10 h-10 object-contain" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-100">DarkSlide</h3>
                        <p className="text-[11px] text-zinc-500 mt-0.5">Version 0.1.0 beta</p>
                        <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed max-w-xs">
                          Film negative converter. Import TIFF, JPEG, PNG, or WebP scans and convert them non-destructively.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100">Render Backend</h3>
                          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                            Disable GPU acceleration if you see rendering artifacts, instability, or device-loss errors.
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gpuRenderingEnabled}
                          onClick={() => onToggleGPURendering(!gpuRenderingEnabled)}
                          className={`relative shrink-0 overflow-hidden h-7 w-12 rounded-full border transition-all ${
                            gpuRenderingEnabled
                              ? 'border-emerald-400/70 bg-emerald-500/25'
                              : 'border-zinc-700 bg-zinc-950'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-zinc-100 transition-all ${
                              gpuRenderingEnabled ? 'left-[22px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      </div>

                      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2.5">
                        <p className="text-[11px] font-medium text-zinc-200">{getRenderBackendLabel(renderBackendDiagnostics)}</p>
                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{getRenderBackendDetail(renderBackendDiagnostics)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'shortcuts' && (
                  <div className="space-y-1">
                    {SHORTCUTS.map(({ action, key }) => (
                      <div key={action} className="flex items-center justify-between py-2 border-b border-zinc-900">
                        <span className="text-[12px] text-zinc-400">{action}</span>
                        <kbd className="px-2 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-[11px] font-mono text-zinc-300 shadow-sm">
                          {key}
                        </kbd>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'diagnostics' && (() => {
                  const d = renderBackendDiagnostics;
                  const { label: statusLabel, color: statusColor } = getStatusBadge(d);
                  const statusClasses = {
                    green: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
                    amber: 'bg-amber-500/15 border-amber-500/30 text-amber-400',
                    red: 'bg-red-500/15 border-red-500/30 text-red-400',
                    zinc: 'bg-zinc-800 border-zinc-700 text-zinc-400',
                  }[statusColor];
                  const dotClasses = {
                    green: 'bg-emerald-400',
                    amber: 'bg-amber-400',
                    red: 'bg-red-400',
                    zinc: 'bg-zinc-500',
                  }[statusColor];

                  const groups = [
                    {
                      title: 'Render Path',
                      items: [
                        { label: 'Path', value: d.backendMode === 'gpu-tiled-render' ? 'GPU tiled render' : 'CPU worker', mono: false },
                        { label: 'Adapter', value: d.gpuAdapterName ?? '—', mono: false },
                        { label: 'GPU toggle', value: d.gpuEnabled ? 'Enabled' : 'Disabled', mono: false },
                        { label: 'Source kind', value: d.sourceKind ?? '—', mono: false },
                      ],
                    },
                    {
                      title: 'Tile Config',
                      items: [
                        { label: 'Tile size', value: d.tileSize ? `${d.tileSize}px` : '—', mono: true },
                        { label: 'Tile count', value: d.tileCount ?? '—', mono: true },
                        { label: 'Halo', value: d.halo !== null ? `${d.halo}px` : '—', mono: true },
                        { label: 'Intermediate', value: d.intermediateFormat ?? '—', mono: true },
                      ],
                    },
                    {
                      title: 'Performance',
                      items: [
                        {
                          label: 'Job duration',
                          value: d.jobDurationMs !== null ? `${d.jobDurationMs} ms` : '—',
                          mono: true,
                          valueClass: getJobDurationColor(d.jobDurationMs),
                        },
                        {
                          label: 'CPU fallback',
                          value: d.usedCpuFallback ? 'Yes' : 'No',
                          mono: false,
                          valueClass: d.usedCpuFallback ? 'text-amber-400' : 'text-zinc-200',
                        },
                        { label: 'Storage limit', value: formatBytes(d.maxStorageBufferBindingSize), mono: true },
                        { label: 'Max buffer', value: formatBytes(d.maxBufferSize), mono: true },
                      ],
                    },
                  ];

                  return (
                    <div className="space-y-3">
                      {/* Header card */}
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <h3 className="text-sm font-semibold text-zinc-100">Render Backend</h3>
                            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 max-w-sm">
                              {getRenderBackendDetail(d)}
                            </p>
                          </div>
                          <span className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${statusClasses}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${dotClasses}`} />
                            {statusLabel}
                          </span>
                        </div>
                      </div>

                      {/* Grouped metric sections */}
                      {groups.map((group) => (
                        <div key={group.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                          <p className="mb-3 text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-600">{group.title}</p>
                          <div className="grid grid-cols-2 gap-2">
                            {group.items.map(({ label, value, mono, valueClass }) => (
                              <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2.5">
                                <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-600">{label}</p>
                                <p className={`mt-1 text-[11px] break-words ${valueClass ?? 'text-zinc-200'} ${mono ? 'font-mono' : ''}`}>
                                  {String(value)}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {tab === 'diagnostics' && (
                <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 px-6 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Copy a diagnostic report to your clipboard to share when reporting issues.
                    </p>
                    <button
                      onClick={handleCopy}
                      className={`flex shrink-0 items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                        copied
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied!' : 'Copy Debug Info'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
