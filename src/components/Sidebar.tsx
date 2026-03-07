import React, { useState } from 'react';
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
} from 'lucide-react';
import { ConversionSettings, ExportFormat, ExportOptions, FilmProfile, HistogramData } from '../types';
import { Slider } from './Slider';
import { Histogram } from './Histogram';
import { CurvesControl } from './CurvesControl';
import { CropPane } from './CropPane';

interface SidebarProps {
  settings: ConversionSettings;
  exportOptions: ExportOptions;
  cropImageWidth: number;
  cropImageHeight: number;
  usesNativeFileDialogs: boolean;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  onSettingsChange: (settings: Partial<ConversionSettings>) => void;
  onExportOptionsChange: (options: Partial<ExportOptions>) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  activeProfile: FilmProfile | null;
  histogramData: HistogramData | null;
  isPickingFilmBase: boolean;
  onTogglePicker: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  settings,
  exportOptions,
  cropImageWidth,
  cropImageHeight,
  usesNativeFileDialogs,
  onLevelInteractionChange,
  onSettingsChange,
  onExportOptionsChange,
  onInteractionStart,
  onInteractionEnd,
  activeProfile,
  histogramData,
  isPickingFilmBase,
  onTogglePicker,
}) => {
  const [activeTab, setActiveTab] = useState<'adjust' | 'curves' | 'crop' | 'export'>('adjust');
  const isColor = activeProfile?.type === 'color';
  const filmBaseInstruction = isPickingFilmBase
    ? 'Click an unexposed film-base area…'
    : 'Sample Film Base';

  return (
    <div className="w-80 h-full bg-zinc-950 flex flex-col overflow-hidden select-none">
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
            onClick={() => setActiveTab(tab)}
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
                  <p className="mt-3 text-[10px] text-zinc-500 leading-relaxed italic">
                    Sample an unexposed section of the negative. DarkSlide uses that film-base color before inversion for both color and B&W conversions.
                  </p>
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
                  onLevelInteractionChange={onLevelInteractionChange}
                  onSettingsChange={onSettingsChange}
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
                        className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 outline-none focus:border-zinc-600"
                        placeholder="darkslide-converted"
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

                <section className="p-4 rounded-xl bg-zinc-900/30 border border-zinc-800/50">
                  <div className="flex gap-3">
                    <Download size={14} className="text-zinc-600 shrink-0 mt-0.5" />
                    <p className="text-[10px] leading-relaxed text-zinc-500 italic">
                      Export uses the full-resolution source in the worker and {usesNativeFileDialogs ? 'saves through the desktop file dialog.' : 'downloads a blob with the correct file extension.'}
                    </p>
                  </div>
                </section>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
