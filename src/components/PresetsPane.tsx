import React, { useState } from 'react';
import { Layers, Plus, Trash2, Check, X, SlidersHorizontal, Film } from 'lucide-react';
import { FILM_PROFILES } from '../constants';
import { FilmProfile } from '../types';

const GENERIC_IDS = new Set(['generic-bw', 'generic-color']);
const GENERIC_PROFILES = FILM_PROFILES.filter((p) => GENERIC_IDS.has(p.id));
const STOCK_PROFILES = FILM_PROFILES.filter((p) => !GENERIC_IDS.has(p.id));

interface PresetsPaneProps {
  activeStockId: string;
  onStockChange: (stock: FilmProfile) => void;
  customPresets: FilmProfile[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
}

export const PresetsPane: React.FC<PresetsPaneProps> = ({
  activeStockId,
  onStockChange,
  customPresets,
  onSavePreset,
  onDeletePreset,
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const handleSave = () => {
    if (newPresetName.trim()) {
      onSavePreset(newPresetName.trim());
      setNewPresetName('');
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setIsSaving(false);
  };

  return (
    <div className="w-80 h-full bg-zinc-950 flex flex-col overflow-hidden select-none">
      <div className="p-6 border-b border-zinc-800 shrink-0 flex justify-between items-center">
        <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] flex items-center gap-2">
          <Layers size={12} /> Film Profiles
        </h2>
        <button
          onClick={() => setIsSaving(true)}
          className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-md transition-all"
          title="Save Current Settings as Preset"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
        {isSaving && (
          <div className="p-3 bg-zinc-900 border border-zinc-700 rounded-lg flex items-center gap-2 shadow-lg mb-4">
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Preset Name..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-zinc-200 placeholder:text-zinc-600"
              autoFocus
            />
            <button onClick={handleSave} className="p-1 text-emerald-500 hover:bg-emerald-500/20 rounded">
              <Check size={14} />
            </button>
            <button onClick={() => setIsSaving(false)} className="p-1 text-red-500 hover:bg-red-500/20 rounded">
              <X size={14} />
            </button>
          </div>
        )}

        {customPresets.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Custom Presets</h3>
            <div className="space-y-2">
              {customPresets.map((stock) => (
                <div key={stock.id} className="relative group flex items-center">
                  <button
                    onClick={() => onStockChange(stock)}
                    className={`flex-1 text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex flex-col gap-0.5 ${
                      activeStockId === stock.id
                        ? 'bg-zinc-100 text-zinc-950 shadow-lg'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    <span className="font-medium">{stock.name}</span>
                    <span className={`text-[10px] opacity-60 ${activeStockId === stock.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                      {stock.type === 'color' ? 'Color Negative' : 'Black & White'}
                    </span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeletePreset(stock.id);
                    }}
                    className="absolute right-2 p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete Preset"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
            <SlidersHorizontal size={10} /> Generic
          </h3>
          <div className="space-y-2">
            {GENERIC_PROFILES.map((stock) => (
              <button
                key={stock.id}
                onClick={() => onStockChange(stock)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex items-center gap-3 ${
                  activeStockId === stock.id
                    ? 'bg-zinc-100 text-zinc-950 shadow-lg'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <SlidersHorizontal size={14} className={`shrink-0 ${activeStockId === stock.id ? 'text-zinc-600' : 'text-zinc-600'}`} />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{stock.name}</span>
                  <span className={`text-[10px] opacity-60 ${activeStockId === stock.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                    {stock.type === 'color' ? 'Color Negative' : 'Black & White'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
            <Film size={10} /> Film Stocks
          </h3>
          <div className="space-y-2">
            {STOCK_PROFILES.map((stock) => (
              <button
                key={stock.id}
                onClick={() => onStockChange(stock)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex items-center gap-3 ${
                  activeStockId === stock.id
                    ? 'bg-zinc-100 text-zinc-950 shadow-lg'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                <Film size={14} className={`shrink-0 ${activeStockId === stock.id ? 'text-zinc-600' : 'text-zinc-600'}`} />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{stock.name}</span>
                  <span className={`text-[10px] opacity-60 ${activeStockId === stock.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                    {stock.type === 'color' ? 'Color Negative' : 'Black & White'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
