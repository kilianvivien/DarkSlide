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
              className="pointer-events-auto w-[520px] max-h-[80vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
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

                {tab === 'diagnostics' && (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <h3 className="text-sm font-semibold text-zinc-100">Render Backend</h3>
                      <div className="mt-4 space-y-2 text-[11px]">
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Path</span>
                          <span className="text-zinc-200">{renderBackendDiagnostics.backendMode === 'gpu-tiled-render' ? 'GPU tiled render' : 'CPU worker'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Adapter</span>
                          <span className="text-right text-zinc-200">{renderBackendDiagnostics.gpuAdapterName ?? 'Unavailable'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">GPU toggle</span>
                          <span className="text-zinc-200">{renderBackendDiagnostics.gpuEnabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Tile size</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.tileSize ? `${renderBackendDiagnostics.tileSize}px` : 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Halo</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.halo !== null ? `${renderBackendDiagnostics.halo}px` : 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Tile count</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.tileCount ?? 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Intermediate format</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.intermediateFormat ?? 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Source kind</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.sourceKind ?? 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Job duration</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.jobDurationMs !== null ? `${renderBackendDiagnostics.jobDurationMs} ms` : 'Unavailable'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Storage buffer limit</span>
                          <span className="text-right text-zinc-200">
                            {formatBytes(renderBackendDiagnostics.maxStorageBufferBindingSize)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">Max buffer size</span>
                          <span className="text-right text-zinc-200">
                            {formatBytes(renderBackendDiagnostics.maxBufferSize)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                          <span className="text-zinc-500">CPU fallback</span>
                          <span className="text-right text-zinc-200">
                            {renderBackendDiagnostics.usedCpuFallback ? (renderBackendDiagnostics.fallbackReason ?? 'Yes') : 'No'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-zinc-500">Reason</span>
                          <span className="text-right text-zinc-200">{renderBackendDiagnostics.gpuDisabledReason ?? 'Active'}</span>
                        </div>
                      </div>
                    </div>

                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      Copy a diagnostic report to your clipboard to share when reporting issues.
                    </p>
                    <button
                      onClick={handleCopy}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                        copied
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied!' : 'Copy Debug Info'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
