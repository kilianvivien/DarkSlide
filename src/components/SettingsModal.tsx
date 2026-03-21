import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Copy, Check, ExternalLink, FolderOpen, Settings2, Bell, Palette, Keyboard, Activity, Download, RefreshCw } from 'lucide-react';
import { ColorManagementSettings, ColorProfileId, ExportOptions, NotificationSettings, RenderBackendDiagnostics, SourceMetadata } from '../types';
import { APP_VERSION_LABEL } from '../appVersion';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { MAX_RESIDENT_DOC_OPTIONS, MaxResidentDocs } from '../utils/residentDocsStore';

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
  maxResidentDocs: MaxResidentDocs;
  onMaxResidentDocsChange: (value: MaxResidentDocs) => void;
  notificationSettings: NotificationSettings;
  onNotificationSettingsChange: (options: Partial<NotificationSettings>) => void;
  colorManagement: ColorManagementSettings;
  sourceMetadata: SourceMetadata | null;
  onColorManagementChange: (options: Partial<ColorManagementSettings>) => void;
  exportOptions: ExportOptions;
  onExportOptionsChange: (options: Partial<ExportOptions>) => void;
  externalEditorPath: string | null;
  externalEditorName: string | null;
  openInEditorOutputPath: string | null;
  onChooseExternalEditor: () => void;
  onClearExternalEditor: () => void;
  onChooseOpenInEditorOutputPath: () => void;
  onUseDownloadsForOpenInEditor: () => void;
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

const TABS = [
  { id: 'performance' as const, label: 'Performance', icon: Settings2, disabled: false },
  { id: 'export' as const, label: 'Export', icon: Download, disabled: false },
  { id: 'notifications' as const, label: 'Notifications', icon: Bell, disabled: false },
  { id: 'color' as const, label: 'Color', icon: Palette, disabled: false },
  { id: 'shortcuts' as const, label: 'Shortcuts', icon: Keyboard, disabled: false },
  { id: 'diagnostics' as const, label: 'Diagnostics', icon: Activity, disabled: false },
  { id: 'update' as const, label: 'Update', icon: RefreshCw, disabled: true },
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

function getGPUSimpleStatus(diagnostics: RenderBackendDiagnostics): string {
  if (!diagnostics.gpuAvailable) return 'Not supported in this browser.';
  if (diagnostics.gpuDisabledReason === 'user') return 'Turned off — using your processor instead.';
  if (diagnostics.gpuDisabledReason === 'device-lost') return 'Graphics card disconnected. Will retry on the next render.';
  if (diagnostics.gpuDisabledReason === 'initialization-failed') return 'Could not start — falling back to your processor.';
  if (diagnostics.usedCpuFallback) return 'Fell back to your processor for this render.';
  if (diagnostics.gpuActive) return 'Running — your graphics card is handling rendering.';
  return 'Using your processor for rendering.';
}

function getBackendModeLabel(value: RenderBackendDiagnostics['backendMode'] | RenderBackendDiagnostics['previewBackend']) {
  if (value === 'gpu-preview') return 'GPU preview';
  if (value === 'gpu-tiled-render') return 'GPU tiled render';
  return 'CPU worker';
}

function formatBytes(value: number | null) {
  if (value === null) return 'Unavailable';
  const gib = value / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = value / (1024 ** 2);
  return `${mib.toFixed(0)} MiB`;
}

function formatAgeMs(value: number | null) {
  if (value === null) return 'Unavailable';
  if (value < 1000) return `${value} ms`;
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

function Toggle({
  checked,
  onChange,
  label,
  color = 'green',
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  color?: 'green' | 'amber';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 overflow-hidden h-7 w-12 rounded-full border transition-all disabled:opacity-40 ${
        checked
          ? color === 'amber'
            ? 'border-amber-400/70 bg-amber-500/20'
            : 'border-emerald-400/70 bg-emerald-500/25'
          : 'border-zinc-700 bg-zinc-950'
      }`}
    >
      <span
        className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-zinc-100 transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
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
  maxResidentDocs,
  onMaxResidentDocsChange,
  notificationSettings,
  onNotificationSettingsChange,
  colorManagement,
  sourceMetadata,
  onColorManagementChange,
  exportOptions,
  onExportOptionsChange,
  externalEditorPath,
  externalEditorName,
  openInEditorOutputPath,
  onChooseExternalEditor,
  onClearExternalEditor,
  onChooseOpenInEditorOutputPath,
  onUseDownloadsForOpenInEditor,
}) => {
  const [tab, setTab] = useState<'performance' | 'export' | 'notifications' | 'color' | 'shortcuts' | 'diagnostics'>('performance');
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useFocusTrap(modalRef, isOpen);

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

  const qualityPct = Math.round(exportOptions.quality * 100);
  const showQuality = exportOptions.format !== 'image/png';

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
              ref={modalRef}
              className="pointer-events-auto w-[min(720px,calc(100vw-2rem))] h-[min(580px,82vh)] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
                <h2 className="text-[13px] font-semibold text-zinc-400 tracking-tight">Settings</h2>
                <button
                  onClick={onClose}
                  aria-label="Close settings"
                  className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                >
                  <X size={15} />
                </button>
              </div>

              {/* Body: sidebar + content */}
              <div className="flex flex-1 overflow-hidden">

                {/* Sidebar nav */}
                <div className="w-44 shrink-0 border-r border-zinc-800 flex flex-col py-2">
                  <nav className="flex-1 px-2 space-y-0.5">
                    {TABS.map(({ id, label, icon: Icon, disabled }) => (
                      disabled ? (
                        <div
                          key={id}
                          title="Coming soon"
                          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-zinc-700 cursor-not-allowed select-none"
                        >
                          <Icon size={14} className="shrink-0" />
                          {label}
                        </div>
                      ) : (
                        <button
                          key={id}
                          onClick={() => setTab(id as typeof tab)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all text-left ${
                            tab === id
                              ? 'bg-zinc-800 text-zinc-100'
                              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                          }`}
                        >
                          <Icon size={14} className="shrink-0" />
                          {label}
                        </button>
                      )
                    ))}
                  </nav>

                  {/* App info */}
                  <div className="px-3 py-3 border-t border-zinc-800/70 mt-2">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 overflow-hidden">
                        <img src="/favicon.png" alt="DarkSlide" className="w-6 h-6 object-contain" />
                      </div>
                      <div>
                        <p className="text-[12px] font-semibold text-zinc-300 leading-tight">DarkSlide</p>
                        <p className="text-[10px] text-zinc-600 leading-tight mt-0.5">{APP_VERSION_LABEL} beta</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Content area */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto custom-scrollbar p-5">

                    {/* ── Performance ── */}
                    {tab === 'performance' && (
                      <div className="space-y-3">

                        {/* GPU Acceleration */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold text-zinc-100">GPU Acceleration</p>
                              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                                Uses your graphics card for faster rendering. Turn off if you see visual glitches or crashes.
                              </p>
                            </div>
                            <Toggle
                              checked={gpuRenderingEnabled}
                              onChange={onToggleGPURendering}
                              label="GPU Acceleration"
                            />
                          </div>
                          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
                            <p className="text-[11px] text-zinc-400">{getGPUSimpleStatus(renderBackendDiagnostics)}</p>
                            {renderBackendDiagnostics.gpuAdapterName && (
                              <p className="mt-0.5 text-[11px] text-zinc-600 font-mono">{renderBackendDiagnostics.gpuAdapterName}</p>
                            )}
                          </div>
                        </div>

                        {/* Smoother Dragging */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold text-zinc-100">Smoother Dragging</p>
                              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                                Makes sliders feel more responsive. Uses a slightly lower-quality preview while dragging, then sharpens when you stop.
                              </p>
                            </div>
                            <Toggle
                              checked={ultraSmoothDragEnabled}
                              onChange={onToggleUltraSmoothDrag}
                              label="Smoother Dragging"
                              color="amber"
                            />
                          </div>
                        </div>

                        {/* Memory Usage */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                          <div>
                            <p className="text-[13px] font-semibold text-zinc-100">Memory Usage</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                              How many open images stay loaded in memory. Lower values free up RAM sooner when switching between files.
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {[...MAX_RESIDENT_DOC_OPTIONS, null].map((value) => {
                              const isActive = value === maxResidentDocs;
                              const label = value === null ? 'Unlimited' : String(value);
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  aria-pressed={isActive}
                                  onClick={() => onMaxResidentDocsChange(value)}
                                  className={`rounded-lg border px-3 py-2 text-[13px] transition-all ${
                                    isActive
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                      : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900'
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-[11px] text-zinc-600">
                            Current: {maxResidentDocs === null ? 'Unlimited' : `${maxResidentDocs} images`}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* ── Export ── */}
                    {tab === 'export' && (
                      <div className="space-y-3">

                        {/* Default Format */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                          <div>
                            <p className="text-[13px] font-semibold text-zinc-100">Default Format</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                              The file format used when you export. You can always change it per export.
                            </p>
                          </div>
                          <div className="flex gap-1.5">
                            {([
                              { value: 'image/jpeg', label: 'JPEG' },
                              { value: 'image/png', label: 'PNG' },
                              { value: 'image/webp', label: 'WebP' },
                            ] as const).map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => onExportOptionsChange({ format: value })}
                                className={`flex-1 rounded-lg border py-2 text-[13px] font-medium transition-all ${
                                  exportOptions.format === value
                                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Quality */}
                        {showQuality && (
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-semibold text-zinc-100">Quality</p>
                                <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                                  Higher quality means a sharper image but a larger file size.
                                </p>
                              </div>
                              <span className="shrink-0 text-[13px] font-mono font-semibold text-zinc-200 tabular-nums">
                                {qualityPct}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={100}
                              step={1}
                              value={qualityPct}
                              onChange={(e) => onExportOptionsChange({ quality: Number(e.target.value) / 100 })}
                              className="w-full accent-emerald-400"
                              aria-label="Export quality"
                            />
                            <div className="flex justify-between text-[10px] text-zinc-700">
                              <span>Smaller file</span>
                              <span>Best quality</span>
                            </div>
                          </div>
                        )}

                        {/* External Editor */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                          <div>
                            <p className="text-[13px] font-semibold text-zinc-100">External Editor</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                              Open your converted photo in another app for further editing.
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={onChooseExternalEditor}
                              className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 hover:bg-zinc-900 transition-all"
                            >
                              <ExternalLink size={13} className="text-zinc-500" />
                              {externalEditorName || 'Choose App\u2026'}
                            </button>
                            {externalEditorName && (
                              <button
                                onClick={onClearExternalEditor}
                                className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-all"
                                aria-label="Clear external editor"
                              >
                                <X size={13} />
                              </button>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-600 font-mono break-all">
                            {externalEditorPath ?? 'If none is set, your system default app will be used.'}
                          </p>
                        </div>

                        {/* Editor Export Folder */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                          <div>
                            <p className="text-[13px] font-semibold text-zinc-100">Editor Export Folder</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                              Where your photo is saved before opening in the external app.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={onChooseOpenInEditorOutputPath}
                              className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 hover:bg-zinc-900 transition-all"
                            >
                              <FolderOpen size={13} className="text-zinc-500" />
                              Choose Folder…
                            </button>
                            <button
                              onClick={onUseDownloadsForOpenInEditor}
                              className={`rounded-lg border px-3 py-2 text-[13px] transition-all ${
                                openInEditorOutputPath
                                  ? 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900'
                                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                              }`}
                            >
                              Use Downloads
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-600 font-mono break-all">
                            {openInEditorOutputPath ?? 'Downloads'}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* ── Notifications ── */}
                    {tab === 'notifications' && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold text-zinc-100">Notifications</p>
                              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                                Get a system notification when an export finishes.
                              </p>
                            </div>
                            <Toggle
                              checked={notificationSettings.enabled}
                              onChange={(v) => onNotificationSettingsChange({ enabled: v })}
                              label="Notifications Enabled"
                            />
                          </div>
                        </div>

                        <div className={`space-y-2 transition-opacity duration-150 ${notificationSettings.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                          {[
                            { key: 'exportComplete' as const, label: 'Single exports', description: 'Notify when a single image is saved.' },
                            { key: 'batchComplete' as const, label: 'Batch exports', description: 'Notify when a batch run completes.' },
                            { key: 'contactSheetComplete' as const, label: 'Contact sheets', description: 'Notify when a contact sheet is saved.' },
                          ].map((item) => (
                            <div key={item.key} className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                              <div className="flex items-center justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] font-medium text-zinc-200">{item.label}</p>
                                  <p className="text-[11px] text-zinc-500 mt-0.5">{item.description}</p>
                                </div>
                                <Toggle
                                  checked={notificationSettings[item.key]}
                                  onChange={(v) => onNotificationSettingsChange({ [item.key]: v } as Partial<NotificationSettings>)}
                                  label={item.label}
                                  disabled={!notificationSettings.enabled}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Color ── */}
                    {tab === 'color' && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                          <div>
                            <p className="text-[13px] font-semibold text-zinc-100">Source Color Profile</p>
                            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
                              How DarkSlide reads the colors in your scan. Auto works well for most images — only change this if colors look off.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <select
                              value={colorManagement.inputMode}
                              onChange={(e) => onColorManagementChange({ inputMode: e.target.value as ColorManagementSettings['inputMode'] })}
                              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-zinc-600"
                            >
                              <option value="auto">Auto ({autoInputLabel})</option>
                              <option value="override">Manual Override</option>
                            </select>
                            <select
                              value={colorManagement.inputProfileId}
                              onChange={(e) => onColorManagementChange({ inputMode: 'override', inputProfileId: e.target.value as ColorProfileId })}
                              disabled={colorManagement.inputMode === 'auto'}
                              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-zinc-600 disabled:opacity-40"
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

                    {/* ── Shortcuts ── */}
                    {tab === 'shortcuts' && (
                      <div className="divide-y divide-zinc-900">
                        {SHORTCUTS.map(({ action, key }) => (
                          <div key={action} className="flex items-center justify-between py-2.5">
                            <span className="text-[13px] text-zinc-400">{action}</span>
                            <kbd className="px-2 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-[11px] font-mono text-zinc-300 shadow-sm">
                              {key}
                            </kbd>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── Diagnostics ── */}
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
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-[13px] font-semibold text-zinc-100">Render Backend</p>
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

                          {groups.map((group) => (
                            <div key={group.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                              <p className="mb-3 text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-600">{group.title}</p>
                              <div className="grid grid-cols-2 gap-2">
                                {group.items.map((item) => (
                                  <div key={item.label} className="rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-2.5">
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

                  {/* Diagnostics footer */}
                  {tab === 'diagnostics' && (
                    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 px-5 py-3.5">
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-[11px] leading-relaxed text-zinc-500">
                          Copy a diagnostic report to share when reporting issues.
                        </p>
                        <button
                          onClick={handleCopy}
                          className={`flex shrink-0 items-center gap-2 px-4 py-2 rounded-xl border text-[13px] font-medium transition-all ${
                            copied
                              ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {copied ? <Check size={13} /> : <Copy size={13} />}
                          {copied ? 'Copied!' : 'Copy Debug Info'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
