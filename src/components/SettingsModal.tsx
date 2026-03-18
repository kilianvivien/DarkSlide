import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Copy, Check, ExternalLink } from 'lucide-react';
import { ColorManagementSettings, ColorProfileId, RenderBackendDiagnostics, SourceMetadata } from '../types';
import { APP_VERSION_LABEL } from '../appVersion';
import { getColorProfileDescription } from '../utils/colorProfiles';

const COLOR_PROFILE_IDS: ColorProfileId[] = ['srgb', 'display-p3', 'adobe-rgb'];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCopyDebugInfo: () => Promise<void>;
  gpuRenderingEnabled: boolean;
  ultraSmoothDragEnabled: boolean;
  renderBackendDiagnostics: RenderBackendDiagnostics;
  onToggleGPURendering: (enabled: boolean) => void;
  onToggleUltraSmoothDrag: (enabled: boolean) => void;
  colorManagement: ColorManagementSettings;
  sourceMetadata: SourceMetadata | null;
  onColorManagementChange: (options: Partial<ColorManagementSettings>) => void;
  externalEditorPath: string | null;
  externalEditorName: string | null;
  onChooseExternalEditor: () => void;
  onClearExternalEditor: () => void;
}

type DiagnosticCardItem = {
  label: string;
  value: string | number;
  mono: boolean;
  valueClass?: string;
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS = [
  { action: 'Open Image', key: `${mod}O` },
  { action: 'Close Image', key: `${mod}W` },
  { action: 'Undo', key: `${mod}Z` },
  { action: 'Redo', key: `${mod}⇧Z` },
  { action: 'Export', key: `${mod}E` },
  { action: 'Open in Editor', key: `${mod}⇧O` },
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
    if (diagnostics.backendMode === 'gpu-preview') {
      return diagnostics.gpuAdapterName
        ? `Active — GPU preview on ${diagnostics.gpuAdapterName}`
        : 'Active — GPU preview';
    }
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
    return 'GPU device was lost. DarkSlide will retry on the next render.';
  }
  if (diagnostics.gpuDisabledReason === 'initialization-failed') {
    return diagnostics.lastError ?? 'WebGPU initialization failed, so rendering fell back to the CPU path.';
  }
  if (diagnostics.backendMode === 'gpu-preview') {
    return 'WebGPU is processing the full preview frame in a single pass for faster interactive updates.';
  }
  if (diagnostics.backendMode === 'gpu-tiled-render') {
    return 'WebGPU is processing texture-backed tiles on the main thread and assembling the final image tile by tile.';
  }

  if (diagnostics.usedCpuFallback) {
    return diagnostics.fallbackReason ?? 'The tiled GPU path failed and DarkSlide fell back to the CPU worker path.';
  }

  return diagnostics.gpuActive ? 'WebGPU is active on the main thread.' : 'The CPU worker path is currently active.';
}

function getBackendModeLabel(value: RenderBackendDiagnostics['backendMode'] | RenderBackendDiagnostics['previewBackend']) {
  if (value === 'gpu-preview') return 'GPU preview';
  if (value === 'gpu-tiled-render') return 'GPU tiled render';
  return 'CPU worker';
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

function formatAgeMs(value: number | null) {
  if (value === null) {
    return 'Unavailable';
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
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
  ultraSmoothDragEnabled,
  renderBackendDiagnostics,
  onToggleGPURendering,
  onToggleUltraSmoothDrag,
  colorManagement,
  sourceMetadata,
  onColorManagementChange,
  externalEditorPath,
  externalEditorName,
  onChooseExternalEditor,
  onClearExternalEditor,
}) => {
  const [tab, setTab] = useState<'general' | 'color' | 'shortcuts' | 'diagnostics'>('general');
  const [copied, setCopied] = useState(false);

  const autoInputLabel = (() => {
    if (sourceMetadata?.decoderColorProfileId) return getColorProfileDescription(sourceMetadata.decoderColorProfileId);
    if (sourceMetadata?.embeddedColorProfileId) return getColorProfileDescription(sourceMetadata.embeddedColorProfileId);
    return 'sRGB';
  })();

  const colorManagementHelper = (() => {
    if (sourceMetadata?.unsupportedColorProfileName) {
      return `Unsupported source profile "${sourceMetadata.unsupportedColorProfileName}". Auto is using sRGB.`;
    }
    if (sourceMetadata?.decoderColorProfileName) return `Using decoder-reported color space: ${autoInputLabel}`;
    if (sourceMetadata?.embeddedColorProfileName && sourceMetadata.embeddedColorProfileId) {
      return `Using embedded profile: ${autoInputLabel}`;
    }
    return `No source profile detected. Auto is using ${autoInputLabel}.`;
  })();

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
                {(['general', 'color', 'shortcuts', 'diagnostics'] as const).map((t) => (
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
                        <p className="text-[11px] text-zinc-500 mt-0.5">Version {APP_VERSION_LABEL} beta</p>
                        <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed max-w-xs">
                          Film negative converter. Import TIFF, JPEG, or PNG scans, plus RAW files in the desktop app, and convert them non-destructively.
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
                          aria-label="GPU Rendering"
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

                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100">External Editor</h3>
                          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                            Choose which app opens when you use &ldquo;Open in Editor&hellip;&rdquo;
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={onChooseExternalEditor}
                          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900 transition-all"
                        >
                          <ExternalLink size={14} className="text-zinc-500" />
                          {externalEditorName || 'Choose Application\u2026'}
                        </button>
                        {externalEditorName && (
                          <button
                            onClick={onClearExternalEditor}
                            className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                        {externalEditorPath
                          ? externalEditorPath
                          : 'If none is set, the file opens with your system default.'}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100">Interactive Preview</h3>
                          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                            Ultra Smooth Drag uses a lower preview level and less frequent histogram updates while dragging sliders and curves.
                            It trades accuracy for snappiness.
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-label="Ultra Smooth Drag"
                          aria-checked={ultraSmoothDragEnabled}
                          onClick={() => onToggleUltraSmoothDrag(!ultraSmoothDragEnabled)}
                          className={`relative shrink-0 overflow-hidden h-7 w-12 rounded-full border transition-all ${
                            ultraSmoothDragEnabled
                              ? 'border-amber-400/70 bg-amber-500/20'
                              : 'border-zinc-700 bg-zinc-950'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-zinc-100 transition-all ${
                              ultraSmoothDragEnabled ? 'left-[22px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'color' && (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-100">Input Profile</h3>
                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                          Tells DarkSlide how to interpret the color values in your source file before any conversion is applied.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <select
                          value={colorManagement.inputMode}
                          onChange={(e) => onColorManagementChange({ inputMode: e.target.value as ColorManagementSettings['inputMode'] })}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600"
                        >
                          <option value="auto">Auto ({autoInputLabel})</option>
                          <option value="override">Manual Override</option>
                        </select>
                        <select
                          value={colorManagement.inputProfileId}
                          onChange={(e) => onColorManagementChange({ inputMode: 'override', inputProfileId: e.target.value as ColorProfileId })}
                          disabled={colorManagement.inputMode === 'auto'}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600 disabled:opacity-40"
                        >
                          {COLOR_PROFILE_IDS.map((id) => (
                            <option key={id} value={id}>{getColorProfileDescription(id)}</option>
                          ))}
                        </select>
                        <p className={`text-[11px] leading-relaxed ${sourceMetadata?.unsupportedColorProfileName ? 'text-amber-300' : 'text-zinc-500'}`}>
                          {colorManagementHelper}
                        </p>
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
                  const previewItems: DiagnosticCardItem[] = [
                    { label: 'Backend', value: d.lastPreviewJob ? getBackendModeLabel(d.lastPreviewJob.backendMode) : '—', mono: false },
                    { label: 'Mode', value: d.lastPreviewJob?.previewMode ?? '—', mono: false },
                    { label: 'Quality', value: d.lastPreviewJob?.interactionQuality ?? '—', mono: false },
                    { label: 'Histogram', value: d.lastPreviewJob?.histogramMode ?? '—', mono: false },
                    { label: 'Preview level', value: d.lastPreviewJob?.previewLevelId ?? '—', mono: true },
                    { label: 'Duration', value: d.lastPreviewJob?.jobDurationMs !== null && d.lastPreviewJob ? `${d.lastPreviewJob.jobDurationMs} ms` : '—', mono: true, valueClass: getJobDurationColor(d.lastPreviewJob?.jobDurationMs ?? null) },
                    { label: 'Cache hit', value: d.lastPreviewJob?.geometryCacheHit === null || d.lastPreviewJob?.geometryCacheHit === undefined ? '—' : (d.lastPreviewJob.geometryCacheHit ? 'Yes' : 'No'), mono: false },
                    { label: 'Fallback', value: d.lastPreviewJob?.usedCpuFallback ? (d.lastPreviewJob.fallbackReason ?? 'Yes') : 'No', mono: false, valueClass: d.lastPreviewJob?.usedCpuFallback ? 'text-amber-400' : 'text-zinc-200' },
                  ];
                  const exportItems: DiagnosticCardItem[] = [
                    { label: 'Backend', value: d.lastExportJob ? getBackendModeLabel(d.lastExportJob.backendMode) : '—', mono: false },
                    { label: 'Source kind', value: d.lastExportJob?.sourceKind ?? '—', mono: false },
                    { label: 'Tile count', value: d.lastExportJob?.tileCount ?? '—', mono: true },
                    { label: 'Duration', value: d.lastExportJob?.jobDurationMs !== null && d.lastExportJob ? `${d.lastExportJob.jobDurationMs} ms` : '—', mono: true, valueClass: getJobDurationColor(d.lastExportJob?.jobDurationMs ?? null) },
                    { label: 'Cache hit', value: d.lastExportJob?.geometryCacheHit === null || d.lastExportJob?.geometryCacheHit === undefined ? '—' : (d.lastExportJob.geometryCacheHit ? 'Yes' : 'No'), mono: false },
                    { label: 'Fallback', value: d.lastExportJob?.usedCpuFallback ? (d.lastExportJob.fallbackReason ?? 'Yes') : 'No', mono: false, valueClass: d.lastExportJob?.usedCpuFallback ? 'text-amber-400' : 'text-zinc-200' },
                  ];
                  const sharedItems: DiagnosticCardItem[] = [
                    { label: 'Adapter', value: d.gpuAdapterName ?? '—', mono: false },
                    { label: 'GPU toggle', value: d.gpuEnabled ? 'Enabled' : 'Disabled', mono: false },
                    { label: 'Preview backend', value: d.previewBackend ? getBackendModeLabel(d.previewBackend) : '—', mono: false },
                    { label: 'Coalesced previews', value: d.coalescedPreviewRequests, mono: true },
                    { label: 'Cancelled previews', value: d.cancelledPreviewJobs, mono: true },
                    { label: 'Storage limit', value: formatBytes(d.maxStorageBufferBindingSize), mono: true },
                    { label: 'Max buffer', value: formatBytes(d.maxBufferSize), mono: true },
                    { label: 'Current path', value: getBackendModeLabel(d.backendMode), mono: false },
                  ];
                  const runtimeItems: DiagnosticCardItem[] = [
                    { label: 'Worker docs', value: d.workerMemory?.documentCount ?? '—', mono: true },
                    { label: 'Preview canvases', value: d.workerMemory?.totalPreviewCanvases ?? '—', mono: true },
                    { label: 'Tile jobs', value: d.workerMemory?.tileJobCount ?? '—', mono: true },
                    { label: 'Cancelled jobs', value: d.workerMemory?.cancelledJobCount ?? '—', mono: true },
                    { label: 'Est. memory', value: formatBytes(d.workerMemory?.estimatedMemoryBytes ?? null), mono: true },
                    { label: 'Blob URLs', value: d.activeBlobUrlCount ?? '—', mono: true },
                    { label: 'Oldest blob age', value: formatAgeMs(d.oldestActiveBlobUrlAgeMs), mono: true },
                  ];
                  const groups = [
                    { title: 'Last Preview Render', items: previewItems },
                    { title: 'Last Export Render', items: exportItems },
                    { title: 'GPU State', items: sharedItems },
                    { title: 'Runtime Memory', items: runtimeItems },
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
                            {group.items.map((item) => (
                              <div key={item.label} className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2.5">
                                <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-600">{item.label}</p>
                                <p className={`mt-1 text-[11px] break-words ${item.valueClass ?? 'text-zinc-200'} ${item.mono ? 'font-mono' : ''}`}>
                                  {String(item.value)}
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
