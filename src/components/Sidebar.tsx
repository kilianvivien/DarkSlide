import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Settings2,
  SlidersHorizontal,
  BarChart3,
  Activity,
  Pipette,
  Download,
  Focus,
  Eraser,
  Info,
  Settings,
  Wand2,
} from 'lucide-react';
import { ConversionSettings, CropTab, Curves, ExportFormat, ExportOptions, FilmProfile, HistogramData } from '../types';

function histPercentile(bins: number[], p: number): number {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return p < 0.5 ? 0 : 255;
  const target = total * p;
  let cumsum = 0;
  for (let i = 0; i < bins.length; i++) {
    cumsum += bins[i];
    if (cumsum >= target) return i;
  }
  return bins.length - 1;
}

function computeAutoBalance(data: HistogramData, isColor: boolean): Curves {
  const lo_l = histPercentile(data.l, 0.001);
  const hi_l = histPercentile(data.l, 0.999);
  // Guard: if range is degenerate, fall back to identity
  const safeRgb = hi_l > lo_l
    ? [{ x: lo_l, y: 0 }, { x: hi_l, y: 255 }]
    : [{ x: 0, y: 0 }, { x: 255, y: 255 }];

  if (!isColor) {
    return { rgb: safeRgb, red: [{ x: 0, y: 0 }, { x: 255, y: 255 }], green: [{ x: 0, y: 0 }, { x: 255, y: 255 }], blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
  }

  const lo_r = histPercentile(data.r, 0.001); const hi_r = histPercentile(data.r, 0.999);
  const lo_g = histPercentile(data.g, 0.001); const hi_g = histPercentile(data.g, 0.999);
  const lo_b = histPercentile(data.b, 0.001); const hi_b = histPercentile(data.b, 0.999);

  return {
    rgb: safeRgb,
    red:   hi_r > lo_r ? [{ x: lo_r, y: 0 }, { x: hi_r, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    green: hi_g > lo_g ? [{ x: lo_g, y: 0 }, { x: hi_g, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
    blue:  hi_b > lo_b ? [{ x: lo_b, y: 0 }, { x: hi_b, y: 255 }] : [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  };
}
import { Slider } from './Slider';
import { Histogram } from './Histogram';
import { CurvesControl } from './CurvesControl';
import { CropPane } from './CropPane';

interface SidebarProps {
  settings: ConversionSettings;
  exportOptions: ExportOptions;
  cropImageWidth: number;
  cropImageHeight: number;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  onSettingsChange: (settings: Partial<ConversionSettings>) => void;
  onExportOptionsChange: (options: Partial<ExportOptions>) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  activeProfile: FilmProfile | null;
  histogramData: HistogramData | null;
  isPickingFilmBase: boolean;
  onTogglePicker: () => void;
  onExport: () => void;
  isExporting: boolean;
  activeTab: 'adjust' | 'curves' | 'crop' | 'export';
  onTabChange: (tab: 'adjust' | 'curves' | 'crop' | 'export') => void;
  cropTab: CropTab;
  onCropTabChange: (tab: CropTab) => void;
  onCropDone: () => void;
  onResetCrop: () => void;
  activePointPicker: 'black' | 'white' | 'grey' | null;
  onSetPointPicker: (mode: 'black' | 'white' | 'grey' | null) => void;
  onOpenSettings: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  settings,
  exportOptions,
  cropImageWidth,
  cropImageHeight,
  onLevelInteractionChange,
  onSettingsChange,
  onExportOptionsChange,
  onInteractionStart,
  onInteractionEnd,
  activeProfile,
  histogramData,
  isPickingFilmBase,
  onTogglePicker,
  onExport,
  isExporting,
  activeTab,
  onTabChange,
  cropTab,
  onCropTabChange,
  onCropDone,
  onResetCrop,
  activePointPicker,
  onSetPointPicker,
  onOpenSettings,
}) => {
  const isColor = activeProfile?.type === 'color';
  const filmBaseInstruction = isPickingFilmBase
    ? 'Click an unexposed film-base area…'
    : 'Sample Film Base';

  return (
    <div className="w-80 h-full bg-zinc-950 flex flex-col overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-800 bg-zinc-900/20 shrink-0">
        <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-3 flex items-center gap-2">
          <BarChart3 size={12} /> Histogram
        </h2>
        <Histogram data={histogramData} />
      </div>

      <div className="flex px-6 pt-4 gap-4 shrink-0">
        {(['adjust', 'curves', 'crop', 'export'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`pb-2 text-[11px] uppercase tracking-widest font-semibold border-b-2 transition-all ${
              activeTab === tab ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="p-6 space-y-8">
          <AnimatePresence mode="wait">
            {activeTab === 'adjust' ? (
              <motion.div
                key="adjust"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-8"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Pipette size={12} /> Film Base
                    <button
                      data-tip="Sample an unexposed area of the negative to set the film base color used during inversion."
                      className="ml-1 text-zinc-700 hover:text-zinc-500 transition-colors"
                      tabIndex={-1}
                    >
                      <Info size={10} />
                    </button>
                  </h2>
                  <button
                    onClick={onTogglePicker}
                    className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                      isPickingFilmBase
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-800'
                    }`}
                  >
                    <Pipette size={16} className={isPickingFilmBase ? 'animate-pulse' : ''} />
                    <span className="text-sm font-medium">{filmBaseInstruction}</span>
                  </button>
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <SlidersHorizontal size={12} /> Basic Adjustments
                  </h2>

                  <Slider label="Exposure" value={settings.exposure} min={-100} max={100} onChange={(value) => onSettingsChange({ exposure: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="Contrast" value={settings.contrast} min={-100} max={100} onChange={(value) => onSettingsChange({ contrast: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="Black Point" value={settings.blackPoint} min={0} max={80} onChange={(value) => onSettingsChange({ blackPoint: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider label="White Point" value={settings.whitePoint} min={180} max={255} onChange={(value) => onSettingsChange({ whitePoint: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  <Slider
                    label="Highlight Protection"
                    value={settings.highlightProtection}
                    min={0}
                    max={100}
                    onChange={(value) => onSettingsChange({ highlightProtection: value })}
                    unit="%"
                    onInteractionStart={onInteractionStart}
                    onInteractionEnd={onInteractionEnd}
                  />

                  {isColor && (
                    <>
                      <Slider label="Saturation" value={settings.saturation} min={0} max={200} onChange={(value) => onSettingsChange({ saturation: value })} unit="%" onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Temperature" value={settings.temperature} min={-100} max={100} onChange={(value) => onSettingsChange({ temperature: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Tint" value={settings.tint} min={-100} max={100} onChange={(value) => onSettingsChange({ tint: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </>
                  )}
                </section>

                {isColor && (
                  <section>
                    <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                      <Settings2 size={12} /> Color Balance
                    </h2>
                    <Slider label="Red Balance" value={settings.redBalance} min={0.5} max={1.5} step={0.01} onChange={(value) => onSettingsChange({ redBalance: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Green Balance" value={settings.greenBalance} min={0.5} max={1.5} step={0.01} onChange={(value) => onSettingsChange({ greenBalance: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    <Slider label="Blue Balance" value={settings.blueBalance} min={0.5} max={1.5} step={0.01} onChange={(value) => onSettingsChange({ blueBalance: value })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  </section>
                )}

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Focus size={12} /> Sharpen
                  </h2>
                  <label className="flex items-center gap-2 mb-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.sharpen.enabled}
                      onChange={(e) => onSettingsChange({ sharpen: { ...settings.sharpen, enabled: e.target.checked } })}
                      className="accent-zinc-200"
                    />
                    <span className="text-[11px] text-zinc-400">Enable</span>
                  </label>
                  {settings.sharpen.enabled && (
                    <>
                      <Slider label="Amount" value={settings.sharpen.amount} min={0} max={200} onChange={(value) => onSettingsChange({ sharpen: { ...settings.sharpen, amount: value } })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                      <Slider label="Radius" value={settings.sharpen.radius} min={0.5} max={3} step={0.1} onChange={(value) => onSettingsChange({ sharpen: { ...settings.sharpen, radius: value } })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                    </>
                  )}
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                    <Eraser size={12} /> Noise Reduction
                  </h2>
                  <label className="flex items-center gap-2 mb-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.noiseReduction.enabled}
                      onChange={(e) => onSettingsChange({ noiseReduction: { ...settings.noiseReduction, enabled: e.target.checked } })}
                      className="accent-zinc-200"
                    />
                    <span className="text-[11px] text-zinc-400">Enable</span>
                  </label>
                  {settings.noiseReduction.enabled && (
                    <Slider label="Luminance" value={settings.noiseReduction.luminanceStrength} min={0} max={100} onChange={(value) => onSettingsChange({ noiseReduction: { ...settings.noiseReduction, luminanceStrength: value } })} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                  )}
                </section>
              </motion.div>
            ) : activeTab === 'curves' ? (
              <motion.div
                key="curves"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className="space-y-6"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <Activity size={12} /> RGB Curves
                  </h2>
                  <CurvesControl curves={settings.curves} onChange={(curves) => onSettingsChange({ curves })} isColor={isColor} onInteractionStart={onInteractionStart} onInteractionEnd={onInteractionEnd} />
                </section>

                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-4 flex items-center justify-between">
                    <span className="flex items-center gap-2"><Pipette size={12} /> Point Pickers</span>
                    {histogramData && (
                      <button
                        data-tip="Auto-balance: stretch levels to histogram data range, correct color balance"
                        onClick={() => onSettingsChange({ curves: computeAutoBalance(histogramData, isColor) })}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 text-[10px] font-semibold uppercase tracking-widest transition-all"
                      >
                        <Wand2 size={10} />
                        Auto
                      </button>
                    )}
                  </h2>
                  <div className="flex gap-2">
                    {([
                      { mode: 'black' as const, label: 'Black', swatchClass: 'bg-zinc-950 border-zinc-700' },
                      { mode: 'grey' as const, label: 'Grey', swatchClass: 'bg-zinc-500 border-zinc-400' },
                      { mode: 'white' as const, label: 'White', swatchClass: 'bg-white border-zinc-300' },
                    ]).map(({ mode, label, swatchClass }) => (
                      <button
                        key={mode}
                        data-tip={`Set ${label} Point — click a pixel on the image`}
                        onClick={() => onSetPointPicker(activePointPicker === mode ? null : mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border text-[11px] font-medium transition-all ${
                          activePointPicker === mode
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        <span className={`inline-block w-2.5 h-2.5 rounded-full border shrink-0 ${swatchClass}`} />
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
              </motion.div>
            ) : activeTab === 'crop' ? (
              <motion.div
                key="crop"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <CropPane
                  settings={settings}
                  imageWidth={cropImageWidth}
                  imageHeight={cropImageHeight}
                  cropTab={cropTab}
                  onCropTabChange={onCropTabChange}
                  onLevelInteractionChange={onLevelInteractionChange}
                  onSettingsChange={onSettingsChange}
                  onDone={onCropDone}
                  onResetCrop={onResetCrop}
                />
              </motion.div>
            ) : (
              <motion.div
                key="export"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                <section>
                  <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                    <Download size={12} /> Export Settings
                  </h2>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Format</label>
                      <div className="grid grid-cols-3 gap-2">
                        {(['image/jpeg', 'image/png', 'image/webp'] as ExportFormat[]).map((format) => (
                          <button
                            key={format}
                            onClick={() => onExportOptionsChange({ format })}
                            className={`px-2 py-2 rounded-lg text-[10px] font-bold uppercase tracking-tighter transition-all border ${
                              exportOptions.format === format
                                ? 'bg-zinc-100 text-zinc-950 border-white shadow-lg'
                                : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-300'
                            }`}
                          >
                            {format.split('/')[1]}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Filename</label>
                      <input
                        type="text"
                        value={exportOptions.filenameBase}
                        onChange={(event) => onExportOptionsChange({ filenameBase: event.target.value })}
                        className="w-full select-text px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 outline-none focus:border-zinc-600"
                        placeholder="darkslide-converted"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                    </div>

                    {exportOptions.format !== 'image/png' && (
                      <Slider
                        label="Quality"
                        value={Math.round(exportOptions.quality * 100)}
                        min={10}
                        max={100}
                        onChange={(value) => onExportOptionsChange({ quality: value / 100 })}
                        unit="%"
                      />
                    )}
                  </div>
                </section>

                <button
                  onClick={onExport}
                  disabled={isExporting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zinc-100 text-zinc-950 rounded-xl text-sm font-semibold hover:bg-white transition-all shadow-lg shadow-black/20 disabled:opacity-50"
                >
                  {isExporting ? (
                    <>
                      <Download size={16} className="animate-bounce" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Download size={16} />
                      Export Image
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Settings button pinned to sidebar bottom */}
      <div className="shrink-0 px-6 py-3 border-t border-zinc-800/50 flex items-center justify-end">
        <button
          onClick={onOpenSettings}
          data-tip="Settings (⌘,)"
          className="p-1.5 text-zinc-700 hover:text-zinc-400 hover:bg-zinc-800 rounded-lg transition-all"
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
};
