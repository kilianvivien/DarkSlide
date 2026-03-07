import React from 'react';
import { RotateCw, Crop as CropIcon, Square, Smartphone, Image as ImageIcon, Monitor } from 'lucide-react';
import { ConversionSettings, CropSettings } from '../types';
import { ASPECT_RATIOS } from '../constants';
import { createCenteredAspectCrop, rotateCropClockwise } from '../utils/imagePipeline';
import { Slider } from './Slider';

interface CropPaneProps {
  settings: ConversionSettings;
  imageWidth: number;
  imageHeight: number;
  onSettingsChange: (settings: Partial<ConversionSettings>) => void;
  onLevelInteractionChange?: (isInteracting: boolean) => void;
  onDone: () => void;
  onResetCrop: () => void;
}

export const CropPane: React.FC<CropPaneProps> = ({
  settings,
  imageWidth,
  imageHeight,
  onSettingsChange,
  onLevelInteractionChange,
  onDone,
  onResetCrop,
}) => {
  const handleRotate = () => {
    const nextRotation = (settings.rotation + 90) % 360;
    onSettingsChange({
      rotation: nextRotation,
      crop: rotateCropClockwise(settings.crop),
    });
  };

  const handleAspectChange = (aspect: number | null) => {
    const newCrop: CropSettings = { ...settings.crop, aspectRatio: aspect };

    if (aspect) {
      Object.assign(newCrop, createCenteredAspectCrop(aspect, imageWidth, imageHeight));
    } else {
      newCrop.x = 0;
      newCrop.y = 0;
      newCrop.width = 1;
      newCrop.height = 1;
    }
    
    onSettingsChange({ crop: newCrop });
  };

  const getIcon = (name: string) => {
    switch (name) {
      case '1:1': return <Square size={14} />;
      case '9:16': return <Smartphone size={14} />;
      case '16:9': return <Monitor size={14} />;
      default: return <ImageIcon size={14} />;
    }
  };

  const isAspectSelected = (preset: number | null) => {
    if (preset === null) return settings.crop.aspectRatio === null;
    const currentAspect = settings.crop.aspectRatio;
    if (!currentAspect) return false;
    return Math.abs(currentAspect - preset) < 0.0001 || Math.abs(currentAspect - 1 / preset) < 0.0001;
  };

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
          <RotateCw size={12} /> Orientation
        </h2>
        <button
          onClick={handleRotate}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 rounded-xl border border-zinc-800 transition-all"
        >
          <RotateCw size={18} className="text-zinc-400" />
          <span className="text-sm font-medium">Rotate 90° Clockwise</span>
          <span className="text-[10px] text-zinc-500 ml-auto bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">
            {settings.rotation}°
          </span>
        </button>
        <div className="mt-4 rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-4">
          <Slider
            label="Level"
            value={settings.levelAngle}
            min={-10}
            max={10}
            step={0.1}
            valueLabel={`${settings.levelAngle.toFixed(1)}°`}
            onChange={(value) => onSettingsChange({ levelAngle: value })}
            onInteractionStart={() => onLevelInteractionChange?.(true)}
            onInteractionEnd={() => onLevelInteractionChange?.(false)}
          />
          <button
            type="button"
            onClick={() => onSettingsChange({ levelAngle: 0 })}
            disabled={Math.abs(settings.levelAngle) < 0.05}
            className="mt-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:text-zinc-300 disabled:cursor-default disabled:text-zinc-700"
          >
            Reset Level
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
          <CropIcon size={12} /> Aspect Ratio Presets
        </h2>
        
        <div className="grid grid-cols-2 gap-2">
          {ASPECT_RATIOS.map((ratio) => (
            <button
              key={ratio.name}
              onClick={() => handleAspectChange(ratio.value)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all border ${
                isAspectSelected(ratio.value)
                  ? 'bg-zinc-100 text-zinc-950 border-white shadow-lg'
                  : 'bg-zinc-900/50 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              <span className="opacity-60">{getIcon(ratio.name)}</span>
              <div className="flex flex-col items-start leading-tight">
                <span className="font-medium">{ratio.name}</span>
                {ratio.category && (
                  <span className={`text-[9px] uppercase tracking-tighter opacity-50 ${isAspectSelected(ratio.value) ? 'text-zinc-900' : 'text-zinc-500'}`}>
                    {ratio.category}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </section>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onResetCrop}
          className="flex-1 px-4 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 text-sm font-medium transition-all"
        >
          Reset Crop
        </button>
        <button
          onClick={onDone}
          className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-100 text-zinc-950 hover:bg-white text-sm font-semibold transition-all shadow-lg shadow-black/20"
        >
          Done
        </button>
      </div>
    </div>
  );
};
