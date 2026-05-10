import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownUp, Check, ChevronDown, Copy, Download, Film, FolderOpen, FolderPlus, Info, Layers, Pencil, Plus, Search, SlidersHorizontal, Trash2, Unlink2, Upload, X } from 'lucide-react';
import { DARKSLIDE_PRESET_FILE_VERSION, FILM_PROFILES, LAB_STYLE_PROFILES_MAP, LIGHT_SOURCE_PROFILES } from '../constants';
import { confirmDeletePreset, isDesktopShell, savePresetFile, openPresetFile } from '../utils/fileBridge';
import { validateDarkslideFile } from '../utils/presetStore';
import { RAW_IMPORT_PROFILE_ID } from '../utils/rawImport';
import { getRollAccent } from '../utils/rolls';
import { DarkslidePresetFile, DocumentTab, FilmProfile, FilmProfileCategory, PresetFolder, Roll, ScannerType } from '../types';

const GENERIC_IDS = new Set(['generic-bw', 'generic-color']);

const CUSTOM_FILM_STOCKS_KEY = 'darkslide_custom_film_stocks_v1';
const CUSTOM_SORT_KEY = 'darkslide_custom_sort_v1';

type CustomPresetSort = 'last-added' | 'color-bw' | 'raw-nonraw' | 'film-stock';

const SORT_OPTIONS: { value: CustomPresetSort; label: string }[] = [
  { value: 'last-added', label: 'Last added' },
  { value: 'color-bw', label: 'Color / B&W' },
  { value: 'raw-nonraw', label: 'RAW / Non-RAW' },
  { value: 'film-stock', label: 'Film stock' },
];

function loadCustomFilmStocks(): string[] {
  try {
    const stored = localStorage.getItem(CUSTOM_FILM_STOCKS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

function saveCustomFilmStocks(stocks: string[]) {
  try {
    localStorage.setItem(CUSTOM_FILM_STOCKS_KEY, JSON.stringify(stocks));
  } catch { /* ignore */ }
}

function loadCustomSort(): CustomPresetSort {
  try {
    const stored = localStorage.getItem(CUSTOM_SORT_KEY);
    if (stored && SORT_OPTIONS.some((o) => o.value === stored)) return stored as CustomPresetSort;
  } catch { /* ignore */ }
  return 'last-added';
}

function sortCustomPresets(presets: FilmProfile[], sort: CustomPresetSort): FilmProfile[] {
  if (sort === 'last-added') return presets;
  const sorted = [...presets];
  switch (sort) {
    case 'color-bw':
      sorted.sort((a, b) => {
        const aType = a.type === 'color' ? 0 : 1;
        const bType = b.type === 'color' ? 0 : 1;
        return aType - bType || a.name.localeCompare(b.name);
      });
      break;
    case 'raw-nonraw': {
      const isRaw = (p: FilmProfile) => p.tags?.includes('raw') ? 0 : 1;
      sorted.sort((a, b) => isRaw(a) - isRaw(b) || a.name.localeCompare(b.name));
      break;
    }
    case 'film-stock':
      sorted.sort((a, b) => (a.filmStock ?? '').localeCompare(b.filmStock ?? '') || a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

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

function formatBuiltInProfileLabel(profile: FilmProfile) {
  const filmTypeLabel = profile.filmType === 'slide' ? 'Slide' : 'Negative';
  const processLabel = profile.type === 'color' ? 'Color' : 'B&W';
  return `${filmTypeLabel} · ${processLabel}`;
}

const CATEGORY_ORDER: FilmProfileCategory[] = ['Generic', 'Kodak', 'Fuji', 'Ilford', 'CineStill', 'Lomography', 'Harman', 'Kentmere', 'Foma', 'Rollei'];

interface PresetsPaneProps {
  activeStockId: string;
  onStockChange: (stock: FilmProfile) => void;
  builtinProfiles?: FilmProfile[];
  customPresets: FilmProfile[];
  presetFolders?: PresetFolder[];
  canSavePreset: boolean;
  saveTags?: string[];
  onSavePreset: (name: string, metadata?: {
    filmStock?: string;
    scannerType?: ScannerType | null;
    folderId?: string | null;
    saveFraming?: boolean;
  }) => void;
  onImportPreset: (profile: FilmProfile, options?: { overwriteId?: string; renameTo?: string }) => void;
  onDeletePreset: (id: string) => void;
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (id: string, name: string) => void;
  onDeleteFolder?: (id: string) => void;
  onMovePresetToFolder?: (presetId: string, folderId: string | null) => void;
  onError?: (message: string | null) => void;
  rolls?: Map<string, Roll>;
  activeRoll?: Roll | null;
  activeTabId?: string | null;
  filmstripTabs?: DocumentTab[];
  onSelectTab?: (tabId: string) => void;
  onOpenRollInfo?: (rollId: string) => void;
  onSyncRollSettings?: (tabId: string, rollId: string) => void;
  onRemoveFromRoll?: (tabId: string) => void;
  onDeleteRoll?: (rollId: string) => void;
  onCreateRollFromTabs?: () => void;
  onToggleScanningSession?: () => void;
  usesNativeFileDialogs?: boolean;
  tabs?: DocumentTab[];
}

export const PresetsPane: React.FC<PresetsPaneProps> = ({
  activeStockId,
  onStockChange,
  builtinProfiles = FILM_PROFILES,
  customPresets,
  presetFolders = [],
  canSavePreset,
  saveTags,
  onSavePreset,
  onImportPreset,
  onDeletePreset,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMovePresetToFolder,
  onError,
  rolls,
  activeRoll,
  activeTabId,
  filmstripTabs = [],
  onSelectTab,
  onOpenRollInfo,
  onSyncRollSettings,
  onRemoveFromRoll,
  onDeleteRoll,
  onCreateRollFromTabs,
  onToggleScanningSession,
  usesNativeFileDialogs,
  tabs = [],
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [saveFilmStock, setSaveFilmStock] = useState('');
  const [saveScannerType, setSaveScannerType] = useState<ScannerType | null>(null);
  const [saveFraming, setSaveFraming] = useState(false);
  const [presetTab, setPresetTab] = useState<'builtin' | 'custom' | 'rolls'>('builtin');
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [importConflict, setImportConflict] = useState<ImportConflictState | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilmStockSuggestions, setShowFilmStockSuggestions] = useState(false);
  const [filmStockHighlight, setFilmStockHighlight] = useState(-1);
  const [customFilmStocks, setCustomFilmStocks] = useState(loadCustomFilmStocks);
  const [customSort, setCustomSort] = useState<CustomPresetSort>(loadCustomSort);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const [collapsedCustomGroups, setCollapsedCustomGroups] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem('darkslide_collapsed_custom_groups_v1');
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return {};
  });
  const [moveMenuPresetId, setMoveMenuPresetId] = useState<string | null>(null);
  const filmStockInputRef = useRef<HTMLInputElement>(null);
  const filmStockDropdownRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<FilmProfileCategory, boolean>>(() => {
    const defaults: Record<FilmProfileCategory, boolean> = {
      Generic: true,
      Kodak: true,
      Fuji: true,
      Ilford: true,
      CineStill: true,
      Lomography: true,
      Harman: true,
      Kentmere: true,
      Foma: true,
      Rollei: true,
    };
    try {
      const stored = localStorage.getItem('darkslide_collapsed_groups_v1');
      if (stored) return { ...defaults, ...JSON.parse(stored) };
    } catch { /* ignore */ }
    return defaults;
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
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

  const searchNormalized = searchQuery.trim().toLowerCase();

  const matchesSearch = useCallback((profile: FilmProfile) => {
    if (!searchNormalized) return true;
    const haystack = [
      profile.name,
      profile.filmStock,
      profile.category,
      profile.filmType,
      profile.type,
      formatScannerType(profile.scannerType),
      ...(profile.tags?.map(formatTag) ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(searchNormalized);
  }, [searchNormalized]);

  const filteredGenericProfiles = useMemo(
    () => (isSearching ? genericProfiles.filter(matchesSearch) : genericProfiles),
    [genericProfiles, isSearching, matchesSearch],
  );
  const filteredStockProfiles = useMemo(
    () => (isSearching ? stockProfiles.filter(matchesSearch) : stockProfiles),
    [stockProfiles, isSearching, matchesSearch],
  );
  const groupedStockProfiles = useMemo(() => {
    const groups = new Map<FilmProfileCategory, FilmProfile[]>();
    filteredStockProfiles.forEach((profile) => {
      const category = profile.category ?? 'Generic';
      const existing = groups.get(category) ?? [];
      existing.push(profile);
      groups.set(category, existing);
    });

    return CATEGORY_ORDER
      .map((category) => ({
        category,
        profiles: groups.get(category) ?? [],
      }))
      .filter((group) => group.profiles.length > 0);
  }, [filteredStockProfiles]);
  const filteredCustomPresets = useMemo(
    () => {
      const base = isSearching ? customPresets.filter(matchesSearch) : customPresets;
      return sortCustomPresets(base, customSort);
    },
    [customPresets, isSearching, customSort, matchesSearch],
  );

  // Film stock suggestions: built-in profile names + custom preset filmStocks + user-entered stocks
  const filmStockSuggestions = useMemo(() => {
    const set = new Set<string>();
    stockProfiles.forEach((p) => set.add(p.name));
    customPresets.forEach((p) => { if (p.filmStock) set.add(p.filmStock); });
    customFilmStocks.forEach((s) => set.add(s));
    const all = Array.from(set).sort((a, b) => a.localeCompare(b));
    if (!saveFilmStock.trim()) return all;
    const q = saveFilmStock.trim().toLowerCase();
    return all.filter((s) => s.toLowerCase().includes(q));
  }, [stockProfiles, customPresets, customFilmStocks, saveFilmStock]);

  // Close sort menu when clicking outside
  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current?.contains(e.target as Node)) return;
      if (sortButtonRef.current?.contains(e.target as Node)) return;
      setShowSortMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSortMenu]);

  // Close move menu when clicking outside
  useEffect(() => {
    if (!moveMenuPresetId) return;
    const handler = (e: MouseEvent) => {
      if (moveMenuRef.current?.contains(e.target as Node)) return;
      setMoveMenuPresetId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moveMenuPresetId]);

  const toggleCustomGroup = useCallback((groupId: string) => {
    setCollapsedCustomGroups((current) => {
      const next = { ...current, [groupId]: !current[groupId] };
      try { localStorage.setItem('darkslide_collapsed_custom_groups_v1', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Close film stock dropdown when clicking outside
  useEffect(() => {
    if (!showFilmStockSuggestions) return;
    const handler = (e: MouseEvent) => {
      if (filmStockDropdownRef.current?.contains(e.target as Node)) return;
      if (filmStockInputRef.current?.contains(e.target as Node)) return;
      setShowFilmStockSuggestions(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilmStockSuggestions]);

  const persistFilmStock = useCallback((stock: string) => {
    const trimmed = stock.trim();
    if (!trimmed) return;
    // Don't persist if it's already a built-in profile name
    const isBuiltin = stockProfiles.some((p) => p.name === trimmed);
    if (isBuiltin) return;
    setCustomFilmStocks((prev) => {
      if (prev.includes(trimmed)) return prev;
      const next = [...prev, trimmed];
      saveCustomFilmStocks(next);
      return next;
    });
  }, [stockProfiles]);

  const resetSaveForm = () => {
    setNewPresetName('');
    setSaveFilmStock('');
    setSaveScannerType(null);
    setSaveFraming(false);
    setSaveFolderId(null);
    setIsSaving(false);
  };

  const handleSave = () => {
    const trimmedName = newPresetName.trim();
    if (!trimmedName || !canSavePreset) {
      return;
    }

    const filmStock = saveFilmStock.trim() || undefined;
    if (filmStock) persistFilmStock(filmStock);

    onSavePreset(trimmedName, {
      filmStock,
      scannerType: saveScannerType,
      folderId: saveFolderId,
      saveFraming,
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

    if (!isDesktopShell()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const opened = await openPresetFile();
      if (!opened) {
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

  const renderCustomPresetRow = (stock: FilmProfile) => {
    const tagLabels = (stock.tags?.length ? stock.tags : [stock.type])
      .map(formatTag)
      .filter((value): value is string => Boolean(value));
    const labStyleName = stock.labStyleId ? LAB_STYLE_PROFILES_MAP[stock.labStyleId]?.name : null;
    const lightSourceName = stock.lightSourceId
      ? LIGHT_SOURCE_PROFILES.find((ls) => ls.id === stock.lightSourceId)?.name ?? null
      : null;
    const compactMeta = [
      stock.filmStock,
      formatScannerType(stock.scannerType),
      ...tagLabels,
    ].filter(Boolean);
    const expandedDetails = [
      stock.filmStock ? ['Film stock', stock.filmStock] : null,
      formatScannerType(stock.scannerType) ? ['Scanner', formatScannerType(stock.scannerType)] : null,
      lightSourceName ? ['Light source', lightSourceName] : null,
      labStyleName ? ['Lab style', labStyleName] : null,
    ].filter((entry): entry is [string, string] => entry !== null);
    const isExpanded = activeStockId === stock.id;

    return (
      <div key={stock.id} className="relative">
        <button
          onClick={() => onStockChange(stock)}
          className={`group w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex flex-col gap-1 ${
            isExpanded
              ? 'bg-zinc-100 text-zinc-950 shadow-lg'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
          }`}
        >
          {/* Top row: icon + name + action buttons */}
          <div className="flex w-full items-center gap-3">
            <Film size={14} className="shrink-0 text-zinc-600" />
            <div className="min-w-0 flex-1">
              <span className="font-medium truncate block">{stock.name}</span>
              {!isExpanded && compactMeta.length > 0 && (
                <span className="text-[10px] opacity-60 truncate block text-zinc-500">
                  {compactMeta.join(' · ')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
              {presetFolders.length > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMoveMenuPresetId((current) => current === stock.id ? null : stock.id);
                  }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); setMoveMenuPresetId((current) => current === stock.id ? null : stock.id); } }}
                  aria-label={`Move ${stock.name} to folder`}
                  className={`p-1 rounded transition-colors ${
                    isExpanded
                      ? 'text-zinc-500 hover:text-zinc-950 hover:bg-zinc-300'
                      : 'text-zinc-600 hover:text-zinc-100 hover:bg-zinc-800'
                  }`}
                  data-tip="Move to folder"
                >
                  <FolderOpen size={12} />
                </span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleExportPreset(stock);
                }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); void handleExportPreset(stock); } }}
                aria-label={`Export ${stock.name}`}
                className={`p-1 rounded transition-colors ${
                  isExpanded
                    ? 'text-zinc-500 hover:text-zinc-950 hover:bg-zinc-300'
                    : 'text-zinc-600 hover:text-zinc-100 hover:bg-zinc-800'
                }`}
                data-tip="Export Preset"
              >
                <Download size={12} />
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeleteClick(stock);
                }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); void handleDeleteClick(stock); } }}
                aria-label={`Delete ${stock.name}`}
                className={`p-1 rounded transition-colors ${
                  isExpanded
                    ? 'text-zinc-500 hover:text-red-600 hover:bg-red-100'
                    : 'text-zinc-600 hover:text-red-400 hover:bg-red-400/10'
                }`}
                data-tip="Delete Preset"
              >
                <Trash2 size={12} />
              </span>
            </div>
          </div>
          {/* Expanded details row: full width below */}
          <AnimatePresence initial={false}>
            {isExpanded && expandedDetails.length > 0 && (
              <motion.div
                key="details"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeInOut' }}
                className="w-full overflow-hidden"
              >
                <div className="border-t border-zinc-200 pt-2 mt-1 space-y-1.5">
                  {expandedDetails.length > 0 && (
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      {expandedDetails.map(([label, value]) => (
                        <React.Fragment key={label}>
                          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide whitespace-nowrap">{label}</span>
                          <span className="text-[10px] text-zinc-600">{value}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  {tagLabels.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {tagLabels.map((tag) => (
                        <span key={tag} className="inline-flex items-center rounded-full bg-zinc-200 px-2 py-0.5 text-[9px] font-medium text-zinc-600">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </button>

        {/* Move-to-folder popup */}
        {moveMenuPresetId === stock.id && (
          <div
            ref={moveMenuRef}
            className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
          >
            <button
              type="button"
              onClick={() => { onMovePresetToFolder?.(stock.id, null); setMoveMenuPresetId(null); }}
              className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                !stock.folderId ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              Ungrouped
            </button>
            {presetFolders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => { onMovePresetToFolder?.(stock.id, folder.id); setMoveMenuPresetId(null); }}
                className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                  stock.folderId === folder.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
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

      <div className={`px-6 pt-6 ${isSearching ? 'pb-4' : 'pb-0'} border-b border-zinc-800 shrink-0`}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] flex items-center gap-2">
            <Layers size={12} /> Film Profiles
          </h2>
          <div className="flex items-center gap-1">
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
            <button
              onClick={() => {
                const next = !isSearching;
                setIsSearching(next);
                if (!next) setSearchQuery('');
                else setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              aria-label="Search presets"
              className={`p-1.5 rounded-lg transition-all ${
                isSearching
                  ? 'text-zinc-100 bg-zinc-800'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
              }`}
              data-tip="Search Presets"
            >
              <Search size={14} />
            </button>
          </div>
        </div>
        <div className="flex gap-4">
          {(['builtin', 'custom', 'rolls'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setPresetTab(tab)}
              className={`pb-2 text-[11px] uppercase tracking-widest font-semibold border-b-2 transition-all ${
                presetTab === tab ? 'border-zinc-200 text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {tab === 'builtin' ? 'Built-in' : tab === 'custom' ? 'Custom' : 'Rolls'}
            </button>
          ))}
        </div>

        {isSearching && (
          <div className="mt-3 mb-1 relative">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setIsSearching(false);
                  setSearchQuery('');
                }
              }}
              placeholder="Search presets..."
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-8 pr-8 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-zinc-500 placeholder:text-zinc-600"
              autoFocus
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
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

              <div className="relative">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Film stock</span>
                <input
                  ref={filmStockInputRef}
                  type="text"
                  value={saveFilmStock}
                  onChange={(event) => {
                    setSaveFilmStock(event.target.value);
                    setShowFilmStockSuggestions(true);
                    setFilmStockHighlight(-1);
                  }}
                  onFocus={() => setShowFilmStockSuggestions(true)}
                  onKeyDown={(event) => {
                    if (showFilmStockSuggestions && filmStockSuggestions.length > 0) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setFilmStockHighlight((i) => Math.min(i + 1, filmStockSuggestions.length - 1));
                        return;
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setFilmStockHighlight((i) => Math.max(i - 1, -1));
                        return;
                      }
                      if (event.key === 'Enter' && filmStockHighlight >= 0) {
                        event.preventDefault();
                        setSaveFilmStock(filmStockSuggestions[filmStockHighlight]);
                        setShowFilmStockSuggestions(false);
                        setFilmStockHighlight(-1);
                        return;
                      }
                      if (event.key === 'Escape') {
                        setShowFilmStockSuggestions(false);
                        return;
                      }
                    }
                    handleKeyDown(event);
                  }}
                  placeholder="Optional"
                  autoComplete="off"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-zinc-500 placeholder:text-zinc-600"
                />
                {showFilmStockSuggestions && filmStockSuggestions.length > 0 && (
                  <div
                    ref={filmStockDropdownRef}
                    className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl custom-scrollbar"
                  >
                    {filmStockSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSaveFilmStock(suggestion);
                          setShowFilmStockSuggestions(false);
                          setFilmStockHighlight(-1);
                          filmStockInputRef.current?.focus();
                        }}
                        onMouseEnter={() => setFilmStockHighlight(index)}
                        className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                          index === filmStockHighlight
                            ? 'bg-zinc-700 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>

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

              <label className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={saveFraming}
                  onChange={(event) => setSaveFraming(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-zinc-100 focus:ring-zinc-500"
                />
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Save crop &amp; rotation</span>
                  <span className="block text-xs text-zinc-400">Include the current crop and rotation in this preset.</span>
                </span>
              </label>

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

              {presetFolders.length > 0 && (
                <div>
                  <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Folder</span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSaveFolderId(null)}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition-all ${
                        saveFolderId === null
                          ? 'border-white bg-zinc-100 text-zinc-950 shadow-lg'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                      }`}
                    >
                      None
                    </button>
                    {presetFolders.map((folder) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => setSaveFolderId(folder.id)}
                        className={`rounded-lg border px-3 py-1.5 text-xs transition-all ${
                          saveFolderId === folder.id
                            ? 'border-white bg-zinc-100 text-zinc-950 shadow-lg'
                            : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                        }`}
                      >
                        {folder.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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

        {presetTab === 'rolls' ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <button
                type="button"
                onClick={onCreateRollFromTabs}
                disabled={tabs.length < 2 || tabs.every((t) => Boolean(t.rollId))}
                data-tip={
                  tabs.length < 2
                    ? 'Open at least 2 images to group them into a roll'
                    : tabs.every((t) => Boolean(t.rollId))
                      ? 'All open tabs are already assigned to a roll'
                      : 'Create a new roll from all unassigned tabs'
                }
                className="flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={14} className="shrink-0" />
                Group open tabs into a roll
              </button>
              <button
                type="button"
                onClick={onToggleScanningSession}
                disabled={!usesNativeFileDialogs}
                data-tip="Watch a folder for new scans and automatically import them into a roll as they appear"
                className="flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Film size={14} className="shrink-0" />
                Scanning Session
                {!usesNativeFileDialogs && <span className="ml-auto text-[10px] text-zinc-600">Desktop only</span>}
              </button>
            </div>

            {activeRoll ? (
              <>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${getRollAccent(activeRoll.id).dot}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">{activeRoll.name}</p>
                      <p className="truncate text-[11px] text-zinc-500">
                        {filmstripTabs.length} frame{filmstripTabs.length === 1 ? '' : 's'}
                        {activeRoll.filmStock ? ` · ${activeRoll.filmStock}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenRollInfo?.(activeRoll.id)}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                    >
                      <Info size={12} />
                      Edit Info
                    </button>
                    <button
                      type="button"
                      onClick={() => activeTabId && onSyncRollSettings?.(activeTabId, activeRoll.id)}
                      disabled={!activeTabId || filmstripTabs.length < 2}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Copy size={12} />
                      Sync Settings
                    </button>
                  </div>
                  {onDeleteRoll && (
                    <div className="mt-2 pt-2 border-t border-zinc-800">
                      <button
                        type="button"
                        onClick={() => onDeleteRoll(activeRoll.id)}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-900/40 bg-zinc-800 px-2.5 py-2 text-[11px] font-medium text-red-400/80 transition-colors hover:border-red-800/60 hover:bg-red-950/30 hover:text-red-300"
                      >
                        <Trash2 size={12} />
                        Delete Roll
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Frames
                  </h3>
                  <div className="space-y-1.5">
                    {filmstripTabs.map((tab, index) => {
                      const isActive = tab.id === activeTabId;
                      const accent = getRollAccent(activeRoll.id);
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => onSelectTab?.(tab.id)}
                          className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-all ${
                            isActive
                              ? `${accent.border} border bg-zinc-900 text-zinc-100`
                              : 'border border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                          }`}
                        >
                          <span className="w-5 shrink-0 text-center text-[10px] font-mono text-zinc-600">{index + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px]">{tab.document.source.name}</span>
                          {isActive && onRemoveFromRoll && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onRemoveFromRoll(tab.id); }}
                              className="shrink-0 rounded p-1 text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-300 group-hover:opacity-100"
                              aria-label="Remove from roll"
                              data-tip="Remove this frame from the roll (the image stays open)"
                            >
                              <Unlink2 size={12} />
                            </button>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : rolls && rolls.size > 0 ? (
              <div>
                <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  All Rolls
                </h3>
                <div className="space-y-2">
                  {Array.from(rolls!.values())
                    .sort((a: Roll, b: Roll) => b.createdAt - a.createdAt)
                    .map((roll: Roll) => {
                      const accent = getRollAccent(roll.id);
                      return (
                        <div
                          key={roll.id}
                          className="group flex w-full items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenRollInfo?.(roll.id)}
                            className="flex min-w-0 flex-1 items-center gap-3"
                          >
                            <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-zinc-200">{roll.name}</p>
                              <p className="truncate text-[10px] text-zinc-600">
                                {roll.filmStock || 'No film stock set'}
                              </p>
                            </div>
                          </button>
                          {onDeleteRoll && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onDeleteRoll(roll.id); }}
                              className="shrink-0 rounded p-1 text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                              aria-label={`Delete roll ${roll.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Film size={24} className="mb-2 text-zinc-700" />
                <p className="text-[11px] leading-relaxed text-zinc-600 max-w-[200px]">
                  Group frames from the same film roll to sync settings and film base across all frames.
                </p>
              </div>
            )}
          </div>
        ) : presetTab === 'custom' ? (
          <div
            className="space-y-6"
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
            {isDropTarget && (
              <div className="rounded-lg border border-dashed border-zinc-400 bg-zinc-900/50 py-4 text-center text-[11px] text-zinc-400">
                Drop .darkslide file here
              </div>
            )}

            {filteredCustomPresets.length === 0 && !isSearching && customPresets.length === 0 ? (
              <div className="space-y-3">
                <div className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <FolderOpen size={10} /> Actions
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleImportClick()}
                    aria-label="Import preset"
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400 transition-all hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    <Upload size={10} /> Import
                  </button>
                </div>
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <Layers size={24} className="text-zinc-700" />
                  <p className="text-[11px] text-zinc-600 leading-relaxed max-w-[180px]">
                    No custom presets yet. Save one from the current edit or import a `.darkslide` file.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* --- Toolbar row --- */}
                <div className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <Layers size={10} /> Presets
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => { setIsCreatingFolder(true); setNewFolderName(''); }}
                      aria-label="New folder"
                      className="rounded-md p-1 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-100"
                      data-tip="New Folder"
                    >
                      <FolderPlus size={10} />
                    </button>
                    <div className="relative">
                      <button
                        ref={sortButtonRef}
                        type="button"
                        onClick={() => setShowSortMenu((v) => !v)}
                        aria-label="Sort presets"
                        className={`rounded-md p-1 transition-all ${
                          showSortMenu || customSort !== 'last-added'
                            ? 'text-zinc-100 bg-zinc-800'
                            : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100'
                        }`}
                        data-tip="Sort Presets"
                      >
                        <ArrowDownUp size={10} />
                      </button>
                      {showSortMenu && (
                        <div
                          ref={sortMenuRef}
                          className="absolute right-0 z-50 mt-1 w-40 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
                        >
                          {SORT_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                setCustomSort(option.value);
                                setShowSortMenu(false);
                                try { localStorage.setItem(CUSTOM_SORT_KEY, option.value); } catch { /* ignore */ }
                              }}
                              className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                                customSort === option.value
                                  ? 'bg-zinc-700 text-zinc-100'
                                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                              }`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleImportClick()}
                      aria-label="Import preset"
                      className="rounded-md p-1 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-100"
                      data-tip="Import Preset"
                    >
                      <Upload size={10} />
                    </button>
                  </div>
                </div>

                {/* --- New folder inline form --- */}
                {isCreatingFolder && (
                  <div className="flex items-center gap-2">
                    <FolderOpen size={12} className="shrink-0 text-zinc-500" />
                    <input
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newFolderName.trim()) {
                          onCreateFolder?.(newFolderName.trim());
                          setIsCreatingFolder(false);
                          setNewFolderName('');
                        }
                        if (e.key === 'Escape') {
                          setIsCreatingFolder(false);
                          setNewFolderName('');
                        }
                      }}
                      placeholder="Folder name..."
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none transition-colors focus:border-zinc-500 placeholder:text-zinc-600"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newFolderName.trim()) {
                          onCreateFolder?.(newFolderName.trim());
                        }
                        setIsCreatingFolder(false);
                        setNewFolderName('');
                      }}
                      className="p-1 text-emerald-500 hover:bg-emerald-500/20 rounded transition-colors"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}
                      className="p-1 text-red-500 hover:bg-red-500/20 rounded transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {/* --- Folder groups --- */}
                {presetFolders.map((folder) => {
                  const folderPresets = filteredCustomPresets.filter((p) => p.folderId === folder.id);
                  if (isSearching && folderPresets.length === 0) return null;
                  const isCollapsed = !isSearching && collapsedCustomGroups[folder.id];

                  return (
                    <div key={folder.id} className="space-y-3">
                      <div className="flex w-full items-center justify-between">
                        <button
                          type="button"
                          onClick={() => toggleCustomGroup(folder.id)}
                          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500"
                        >
                          <FolderOpen size={10} />
                          {editingFolderId === folder.id ? (
                            <input
                              type="text"
                              value={editingFolderName}
                              onChange={(e) => setEditingFolderName(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter' && editingFolderName.trim()) {
                                  onRenameFolder?.(folder.id, editingFolderName.trim());
                                  setEditingFolderId(null);
                                }
                                if (e.key === 'Escape') setEditingFolderId(null);
                              }}
                              onBlur={() => {
                                if (editingFolderName.trim()) {
                                  onRenameFolder?.(folder.id, editingFolderName.trim());
                                }
                                setEditingFolderId(null);
                              }}
                              className="bg-transparent border-b border-zinc-500 outline-none text-zinc-300 w-20"
                              autoFocus
                            />
                          ) : (
                            <span>{folder.name}</span>
                          )}
                          <ChevronDown
                            size={12}
                            className={`transition-transform ${isSearching || !isCollapsed ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {!isCollapsed && (
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name); }}
                              aria-label={`Rename ${folder.name}`}
                              className="rounded p-1 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                            >
                              <Pencil size={10} />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteFolder?.(folder.id)}
                              aria-label={`Delete folder ${folder.name}`}
                              className="rounded p-1 text-zinc-600 transition-colors hover:bg-red-400/10 hover:text-red-400"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        )}
                      </div>
                      {!isCollapsed && (
                        folderPresets.length === 0 ? (
                          <p className="text-[11px] text-zinc-600 pl-6">Empty folder</p>
                        ) : (
                          <div className="space-y-2">
                            {folderPresets.map((stock) => renderCustomPresetRow(stock))}
                          </div>
                        )
                      )}
                    </div>
                  );
                })}

                {/* --- Ungrouped presets --- */}
                {(() => {
                  const ungrouped = filteredCustomPresets.filter((p) => !p.folderId || !presetFolders.some((f) => f.id === p.folderId));
                  if (ungrouped.length === 0 && presetFolders.length > 0) return null;
                  if (ungrouped.length === 0 && isSearching) return null;
                  return (
                    <div className="space-y-3">
                      {presetFolders.length > 0 && (
                        <div className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                          <span className="flex items-center gap-1.5">
                            <Film size={10} /> Ungrouped
                          </span>
                        </div>
                      )}
                      {ungrouped.length === 0 ? (
                        isSearching ? (
                          <p className="text-center text-[11px] text-zinc-600 py-6">No matching presets</p>
                        ) : null
                      ) : (
                        <div className="space-y-2">
                          {ungrouped.map((stock) => renderCustomPresetRow(stock))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {isSearching && filteredCustomPresets.length === 0 && (
                  <p className="text-center text-[11px] text-zinc-600 py-6">No matching presets</p>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {filteredGenericProfiles.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
                  <SlidersHorizontal size={10} /> Generic
                </h3>
                <div className="space-y-2">
                  {filteredGenericProfiles.map((stock) => (
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
            )}

            {filteredStockProfiles.length > 0 && (
              groupedStockProfiles.map((group) => (
                <div key={group.category} className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups((current) => {
                      const next = { ...current, [group.category]: isSearching ? false : !current[group.category] };
                      try { localStorage.setItem('darkslide_collapsed_groups_v1', JSON.stringify(next)); } catch { /* ignore */ }
                      return next;
                    })}
                    className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-widest text-zinc-500"
                  >
                    <span className="flex items-center gap-1.5">
                      <Film size={10} /> {group.category}
                    </span>
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${isSearching || !collapsedGroups[group.category] ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {(isSearching || !collapsedGroups[group.category]) && (
                    <div className="space-y-2">
                      {group.profiles.map((stock) => (
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
                              {formatBuiltInProfileLabel(stock)}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}

            {isSearching && filteredGenericProfiles.length === 0 && filteredStockProfiles.length === 0 && (
              <p className="text-center text-[11px] text-zinc-600 py-6">No matching presets</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
