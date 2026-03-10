import React, { useMemo, useRef, useState } from 'react';
import { Check, Download, Film, Layers, Plus, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react';
import { DARKSLIDE_PRESET_FILE_VERSION, FILM_PROFILES } from '../constants';
import { confirmDeletePreset, savePresetFile, openPresetFile } from '../utils/fileBridge';
import { validateDarkslideFile } from '../utils/presetStore';
import { RAW_IMPORT_PROFILE_ID } from '../utils/rawImport';
import { DarkslidePresetFile, FilmProfile, ScannerType } from '../types';

const GENERIC_IDS = new Set(['generic-bw', 'generic-color']);

function isGenericProfile(profile: FilmProfile) {
  return GENERIC_IDS.has(profile.id) || profile.id === RAW_IMPORT_PROFILE_ID;
}

type ImportConflictState = {
  existingId: string;
  profile: FilmProfile;
  renameTo: string;
};

function slugifyPresetName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-') || 'darkslide-preset';
}

function normalizePresetName(name: string) {
  return name.trim().toLowerCase();
}

function formatScannerType(scannerType: ScannerType | null | undefined) {
  if (!scannerType) return null;

  switch (scannerType) {
    case 'flatbed':
      return 'Flatbed';
    case 'camera':
      return 'Camera';
    case 'dedicated':
      return 'Dedicated';
    case 'smartphone':
      return 'Smartphone';
    default:
      return null;
  }
}

function formatTag(tag: string | undefined) {
  if (!tag) return null;
  switch (tag) {
    case 'bw':
      return 'B&W';
    case 'color':
      return 'Color';
    case 'raw':
      return 'RAW';
    case 'non-raw':
      return 'Non-RAW';
    default:
      return tag;
  }
}

interface PresetsPaneProps {
  activeStockId: string;
  onStockChange: (stock: FilmProfile) => void;
  builtinProfiles?: FilmProfile[];
  customPresets: FilmProfile[];
  canSavePreset: boolean;
  saveTags?: string[];
  onSavePreset: (name: string, metadata?: { filmStock?: string; scannerType?: ScannerType | null }) => void;
  onImportPreset: (profile: FilmProfile, options?: { overwriteId?: string; renameTo?: string }) => void;
  onDeletePreset: (id: string) => void;
  onError?: (message: string | null) => void;
}

export const PresetsPane: React.FC<PresetsPaneProps> = ({
  activeStockId,
  onStockChange,
  builtinProfiles = FILM_PROFILES,
  customPresets,
  canSavePreset,
  saveTags,
  onSavePreset,
  onImportPreset,
  onDeletePreset,
  onError,
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [saveFilmStock, setSaveFilmStock] = useState('');
  const [saveScannerType, setSaveScannerType] = useState<ScannerType | null>(null);
  const [presetTab, setPresetTab] = useState<'builtin' | 'custom'>('builtin');
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [importConflict, setImportConflict] = useState<ImportConflictState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const genericProfiles = useMemo(
    () => builtinProfiles.filter(isGenericProfile),
    [builtinProfiles],
  );
  const stockProfiles = useMemo(
    () => builtinProfiles.filter((profile) => !isGenericProfile(profile)),
    [builtinProfiles],
  );

  const activeProfile = useMemo(
    () => [...builtinProfiles, ...customPresets].find((profile) => profile.id === activeStockId) ?? null,
    [activeStockId, builtinProfiles, customPresets],
  );
  const activeTags = (saveTags?.length ? saveTags : [activeProfile?.type ?? 'color'])
    .map(formatTag)
    .filter((value): value is string => Boolean(value));

  const resetSaveForm = () => {
    setNewPresetName('');
    setSaveFilmStock('');
    setSaveScannerType(null);
    setIsSaving(false);
  };

  const handleSave = () => {
    const trimmedName = newPresetName.trim();
    if (!trimmedName || !canSavePreset) {
      return;
    }

    onSavePreset(trimmedName, {
      filmStock: saveFilmStock.trim() || undefined,
      scannerType: saveScannerType,
    });
    resetSaveForm();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') handleSave();
    if (event.key === 'Escape') resetSaveForm();
  };

  const handleImportPayload = (payload: DarkslidePresetFile) => {
    setPresetTab('custom');
    const duplicate = customPresets.find((preset) => normalizePresetName(preset.name) === normalizePresetName(payload.profile.name));

    if (duplicate) {
      setImportConflict({
        existingId: duplicate.id,
        profile: payload.profile,
        renameTo: `${payload.profile.name} Copy`,
      });
      return;
    }

    onImportPreset(payload.profile);
    setImportConflict(null);
  };

  const processImportedText = (content: string, fileName: string) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      onError?.(`Preset import failed. ${fileName} is not valid JSON.`);
      return;
    }

    const validated = validateDarkslideFile(parsed);
    if (!validated) {
      onError?.(`Preset import failed. ${fileName} is not a valid .darkslide preset.`);
      return;
    }

    handleImportPayload(validated);
  };

  const handleImportFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.darkslide')) {
      onError?.('Preset import failed. Choose a .darkslide preset file.');
      return;
    }

    processImportedText(await file.text(), file.name);
  };

  const handleImportClick = async () => {
    setPresetTab('custom');
    setIsSaving(false);

    try {
      const opened = await openPresetFile();
      if (!opened) {
        fileInputRef.current?.click();
        return;
      }

      processImportedText(opened.content, opened.fileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError?.(`Preset import failed. ${message}`);
    }
  };

  const handleExportPreset = async (profile: FilmProfile) => {
    try {
      await savePresetFile(
        JSON.stringify({
          darkslideVersion: DARKSLIDE_PRESET_FILE_VERSION,
          profile,
        }, null, 2),
        `${slugifyPresetName(profile.name)}.darkslide`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError?.(`Preset export failed. ${message}`);
    }
  };

  const handleDeleteClick = async (profile: FilmProfile) => {
    const confirmed = await confirmDeletePreset(profile.name);
    if (!confirmed) {
      return;
    }

    onDeletePreset(profile.id);
  };

  const commitImportRename = () => {
    if (!importConflict) {
      return;
    }

    const renameTo = importConflict.renameTo.trim();
    if (!renameTo) {
      return;
    }

    const duplicate = customPresets.find((preset) => normalizePresetName(preset.name) === normalizePresetName(renameTo));
    if (duplicate) {
      onError?.(`Preset import failed. A preset named "${renameTo}" already exists.`);
      return;
    }

    onImportPreset(importConflict.profile, { renameTo });
    setImportConflict(null);
  };

  return (
    <div className="w-80 h-full bg-zinc-950 flex flex-col overflow-hidden select-none">
      <input
        ref={fileInputRef}
        type="file"
        accept=".darkslide"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            void handleImportFile(file);
          }
        }}
      />

      <div className="px-6 pt-6 pb-0 border-b border-zinc-800 shrink-0">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] flex items-center gap-2">
            <Layers size={12} /> Film Profiles
          </h2>
          <button
            onClick={() => {
              setImportConflict(null);
              setPresetTab('custom');
              setIsSaving(true);
            }}
            aria-label="Save current preset"
            disabled={!canSavePreset}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-all disabled:cursor-default disabled:text-zinc-700 disabled:hover:bg-transparent"
            data-tip="Save Current Settings as Preset"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex gap-4">
          {(['builtin', 'custom'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setPresetTab(tab)}
              className={`pb-2 text-[11px] uppercase tracking-widest font-semibold border-b-2 transition-all ${
                presetTab === tab ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {tab === 'builtin' ? 'Built-in' : 'Custom'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
        {isSaving && (
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-lg">
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Preset name</span>
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(event) => setNewPresetName(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Preset Name..."
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-zinc-500 placeholder:text-zinc-600"
                  autoFocus
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Film stock</span>
                <input
                  type="text"
                  value={saveFilmStock}
                  onChange={(event) => setSaveFilmStock(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-zinc-500 placeholder:text-zinc-600"
                />
              </label>

              <div>
                <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Scanner</span>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { label: 'Flatbed', value: 'flatbed' as const },
                    { label: 'Camera', value: 'camera' as const },
                    { label: 'Dedicated', value: 'dedicated' as const },
                    { label: 'Smartphone', value: 'smartphone' as const },
                  ]).map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={saveScannerType === option.value}
                      onClick={() => setSaveScannerType(saveScannerType === option.value ? null : option.value)}
                      className={`rounded-lg border px-3 py-2 text-xs transition-all ${
                        saveScannerType === option.value
                          ? 'border-white bg-zinc-100 text-zinc-950 shadow-lg'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Tags</span>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {activeTags.map((tag) => (
                    <span key={tag} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-300">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button aria-label="Save preset" onClick={handleSave} className="p-2 text-emerald-500 hover:bg-emerald-500/20 rounded-lg transition-colors">
                <Check size={14} />
              </button>
              <button aria-label="Cancel preset save" onClick={resetSaveForm} className="p-2 text-red-500 hover:bg-red-500/20 rounded-lg transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {importConflict && (
          <div className="rounded-xl border border-amber-700/50 bg-amber-950/20 p-4 shadow-lg">
            <p className="text-sm text-amber-100">
              A preset named &quot;{importConflict.profile.name}&quot; already exists. Overwrite it or rename the incoming preset.
            </p>
            <input
              type="text"
              value={importConflict.renameTo}
              onChange={(event) => setImportConflict((current) => current ? { ...current, renameTo: event.target.value } : current)}
              className="mt-3 w-full rounded-lg border border-amber-900/60 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-amber-500"
            />
            <div className="mt-3 flex justify-end gap-2 text-xs uppercase tracking-widest">
              <button
                type="button"
                onClick={() => {
                  onImportPreset(importConflict.profile, { overwriteId: importConflict.existingId });
                  setImportConflict(null);
                }}
                className="rounded-lg border border-amber-700/70 px-3 py-2 text-amber-200 transition-colors hover:bg-amber-900/30"
              >
                Overwrite
              </button>
              <button
                type="button"
                onClick={commitImportRename}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => setImportConflict(null)}
                className="rounded-lg border border-zinc-800 px-3 py-2 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {presetTab === 'custom' ? (
          <div
            className={`space-y-4 rounded-xl border border-dashed p-3 transition-colors ${
              isDropTarget ? 'border-zinc-300 bg-zinc-900/70' : 'border-zinc-800 bg-transparent'
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragLeave={() => setIsDropTarget(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDropTarget(false);
              const file = event.dataTransfer.files?.[0];
              if (file) {
                void handleImportFile(file);
              }
            }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
                Custom Presets
              </h3>
              <button
                type="button"
                onClick={() => void handleImportClick()}
                aria-label="Import preset"
                className="rounded-md p-1.5 text-zinc-400 transition-all hover:bg-zinc-800 hover:text-zinc-100"
                data-tip="Import Preset"
              >
                <Upload size={14} />
              </button>
            </div>

            {customPresets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                <Layers size={24} className="text-zinc-700" />
                <p className="text-[11px] text-zinc-600 leading-relaxed max-w-[180px]">
                  No custom presets yet. Save one from the current edit or import a `.darkslide` file.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {customPresets.map((stock) => {
                  const tagLabels = (stock.tags?.length ? stock.tags : [stock.type])
                    .map(formatTag)
                    .filter((value): value is string => Boolean(value));
                  const metadata = [
                    stock.filmStock,
                    formatScannerType(stock.scannerType),
                    ...tagLabels,
                  ].filter(Boolean);

                  return (
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
                        {metadata.length > 0 && (
                          <span className={`text-[11px] ${activeStockId === stock.id ? 'text-zinc-700' : 'text-zinc-500'}`}>
                            {metadata.join(' · ')}
                          </span>
                        )}
                      </button>
                      <div className="absolute right-2 flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100">
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleExportPreset(stock);
                          }}
                          aria-label={`Export ${stock.name}`}
                          className="p-1.5 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 rounded"
                          data-tip="Export Preset"
                        >
                          <Download size={12} />
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteClick(stock);
                          }}
                          aria-label={`Delete ${stock.name}`}
                          className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded"
                          data-tip="Delete Preset"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
                <SlidersHorizontal size={10} /> Generic
              </h3>
              <div className="space-y-2">
                {genericProfiles.map((stock) => (
                  <button
                    key={stock.id}
                    onClick={() => onStockChange(stock)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex items-center gap-3 ${
                      activeStockId === stock.id
                        ? 'bg-zinc-100 text-zinc-950 shadow-lg'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    <SlidersHorizontal size={14} className="shrink-0 text-zinc-600" />
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
                {stockProfiles.map((stock) => (
                  <button
                    key={stock.id}
                    onClick={() => onStockChange(stock)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex items-center gap-3 ${
                      activeStockId === stock.id
                        ? 'bg-zinc-100 text-zinc-950 shadow-lg'
                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                    }`}
                  >
                    <Film size={14} className="shrink-0 text-zinc-600" />
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
          </>
        )}
      </div>
    </div>
  );
};
