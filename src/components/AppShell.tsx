import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  Building2,
  CheckCheck,
  ChevronDown,
  Copy,
  Crop,
  Download,
  Eraser,
  ExternalLink,
  Film,
  FileWarning,
  Image as ImageIcon,
  Info,
  ImagePlus,
  Keyboard,
  Layers2,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Redo2,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Settings2,
  SlidersHorizontal,
  SplitSquareVertical,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { formatAspectRatio } from '../utils/aspectRatio';
import { Sidebar } from './Sidebar';
import { PresetsPane } from './PresetsPane';
import { CropOverlay } from './CropOverlay';
import { DustOverlay } from './DustOverlay';
import { SettingsModal } from './SettingsModal';
import { BatchModal } from './BatchModal';
import { ContactSheetModal } from './ContactSheetModal';
import { TabBar } from './TabBar';
import { ZoomBar } from './ZoomBar';
import { MagnifierLoupe } from './MagnifierLoupe';
import { WebGLZoomRegion, ZoomRegionPreview } from './WebGLZoomRegion';
import { RecentFilesList } from './RecentFilesList';
import { ErrorBoundary } from './ErrorBoundary';
import { ToastHost } from './ToastHost';
import { DEFAULT_COLOR_MANAGEMENT } from '../constants';
import {
  BatchJobEntry,
} from '../utils/batchProcessor';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import {
  BlockingOverlayState,
  SuggestionNoticeState,
  TransientNoticeState,
} from '../utils/appHelpers';
import {
  ColorManagementSettings,
  ConversionSettings,
  CropTab,
  DocumentTab,
  FilmProfile,
  LabStyleProfile,
  LightSourceProfile,
  NotificationSettings,
  PointPickerMode,
  PresetFolder,
  QuickExportPreset,
  RenderBackendDiagnostics,
  Roll,
  ScannerType,
  WorkspaceDocument,
} from '../types';
import { MaxResidentDocs } from '../utils/residentDocsStore';
import { computePanTranslate, PanGeometry } from '../hooks/useViewportZoom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useModalA11y } from '../hooks/useModalA11y';
import { SHORTCUT_MODIFIER, SHORTCUTS } from '../utils/shortcutHelp';

type SidebarTool = 'adjust' | 'profiles' | 'curves' | 'crop' | 'dust' | 'export';
type SidebarRailTool = SidebarTool | 'basic';

const SIDEBAR_TOOLS: Array<{
  id: SidebarRailTool;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  separated?: boolean;
}> = [
  { id: 'basic', label: 'Basic adjustments', icon: <SlidersHorizontal size={18} strokeWidth={1.8} />, shortcut: 'B' },
  { id: 'adjust', label: 'Advanced adjustments', icon: <Settings2 size={18} strokeWidth={1.8} />, shortcut: 'V' },
  { id: 'profiles', label: 'Film profiles', icon: <Film size={18} strokeWidth={1.8} />, shortcut: 'P', separated: true },
  { id: 'curves', label: 'Curves', icon: <Activity size={18} strokeWidth={1.8} /> },
  { id: 'crop', label: 'Crop and level', icon: <Crop size={18} strokeWidth={1.8} />, shortcut: 'C' },
  { id: 'dust', label: 'Dust removal', icon: <Eraser size={18} strokeWidth={1.8} />, shortcut: 'D' },
  { id: 'export', label: 'Export', icon: <Download size={18} strokeWidth={1.8} />, shortcut: `${SHORTCUT_MODIFIER}E`, separated: true },
];

function SidebarToolRail({
  activeTool,
  panelOpen,
  editingEnabled,
  onSelect,
  onOpenSettings,
}: {
  activeTool: SidebarRailTool;
  panelOpen: boolean;
  editingEnabled: boolean;
  onSelect: (tool: SidebarRailTool) => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav aria-label="Editing tools" className="order-1 flex h-full w-12 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 px-1.5 py-3">
      {SIDEBAR_TOOLS.map((tool) => {
        const active = activeTool === tool.id;
        const expanded = editingEnabled && active ? panelOpen : undefined;
        return (
          <div key={tool.id} className={tool.separated ? 'mt-3 border-t border-zinc-800 pt-3' : 'mb-1'}>
            <button
              type="button"
              aria-label={tool.label}
              aria-pressed={active}
              aria-expanded={expanded}
              disabled={!editingEnabled}
              data-tip={`${active && expanded ? `Collapse ${tool.label}` : tool.label}${tool.shortcut ? ` (${tool.shortcut})` : ''}`}
              onClick={() => onSelect(tool.id)}
              className={`relative flex h-10 w-full items-center justify-center rounded-md transition-colors after:absolute after:-right-1.5 after:inset-y-2 after:w-0.5 after:rounded-full disabled:cursor-not-allowed disabled:opacity-25 ${
                active && editingEnabled
                  ? 'bg-zinc-800 text-zinc-100 after:bg-amber-400'
                  : 'text-zinc-600 after:bg-transparent hover:bg-zinc-900 hover:text-zinc-300'
              }`}
            >
              {tool.icon}
              {tool.shortcut && (
                <kbd className="pointer-events-none absolute bottom-0.5 right-1 font-mono text-[7px] leading-none text-zinc-600">
                  {tool.shortcut}
                </kbd>
              )}
            </button>
          </div>
        );
      })}
      <div className="mt-auto border-t border-zinc-800 pt-3">
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          data-tip="Settings (⌘,)"
          className="flex h-10 w-full items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
      </div>
    </nav>
  );
}

type AppShellProps = {
  usesNativeFileDialogs: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  displayCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  previewContainerRef: React.RefObject<HTMLDivElement | null>;
  panTransformRef: React.RefObject<HTMLDivElement | null>;
  panGeometryRef: React.MutableRefObject<PanGeometry | null>;
  workerClient: ImageWorkerClient | null;
  documentState: WorkspaceDocument | null;
  activeTab: DocumentTab | null;
  tabs: DocumentTab[];
  activeTabId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  fallbackProfile: FilmProfile;
  activeProfile: FilmProfile;
  activeLabStyle: LabStyleProfile | null;
  builtinProfiles: FilmProfile[];
  labStyleProfiles: LabStyleProfile[];
  lightSourceProfiles: LightSourceProfile[];
  customPresets: FilmProfile[];
  presetFolders: PresetFolder[];
  savePresetTags: string[];
  sidebarTab: 'adjust' | 'profiles' | 'curves' | 'crop' | 'dust' | 'export';
  dustBrushActive: boolean;
  selectedDustMarkId: string | null;
  isDetectingDust: boolean;
  cropTab: CropTab;
  comparisonMode: 'processed' | 'original';
  isLeftPaneOpen: boolean;
  isPickingFilmBase: boolean;
  activePointPicker: PointPickerMode | null;
  isAdjustingLevel: boolean;
  isAdjustingCrop: boolean;
  isPanDragging: boolean;
  isSpaceHeld: boolean;
  isDragActive: boolean;
  showSettingsModal: boolean;
  showBatchModal: boolean;
  showContactSheetModal: boolean;
  showShortcutHelp: boolean;
  showTabSwitchOverlay: boolean;
  tabSwitchOverlayKey: number;
  showMagnifier: boolean;
  isCropOverlayVisible: boolean;
  showBlockingOverlay: boolean;
  isRenderIndicatorVisible: boolean;
  overlayContent: BlockingOverlayState | null;
  error: string | null;
  suggestionNotice: SuggestionNoticeState | null;
  transientNotice: TransientNoticeState | null;
  isExporting: boolean;
  gpuRenderingEnabled: boolean;
  ultraSmoothDragEnabled: boolean;
  notificationSettings: NotificationSettings;
  renderBackendDiagnostics: RenderBackendDiagnostics;
  defaultLightSourceId: string;
  defaultLabStyleId: string;
  defaultImportPresetId: string | null;
  onDefaultImportPresetChange: (presetId: string | null) => void;
  onDefaultLabStyleChange: (labStyleId: string) => void;
  maxResidentDocs: MaxResidentDocs;
  externalEditorPath: string | null;
  externalEditorName: string | null;
  openInEditorOutputPath: string | null;
  defaultExportPath: string | null;
  batchOutputPath: string | null;
  contactSheetOutputPath: string | null;
  customPresetCount: number;
  presetFolderCount: number;
  quickExportPresets: QuickExportPreset[];
  updaterEnabled: boolean;
  updaterDisabledReason: string | null;
  updateChannel: 'stable' | 'beta';
  updateLastCheckedAt: number | null;
  updateError: string | null;
  isCheckingForUpdates: boolean;
  activeRoll: Roll | null;
  rolls: Map<string, Roll>;
  filmstripTabs: DocumentTab[];
  getRollById: (rollId: string | null) => Roll | null;
  profilesById: Map<string, FilmProfile>;
  lightSourceProfilesById: Map<string, LightSourceProfile>;
  zoom: number | 'fit';
  fitScale: number;
  effectiveZoom: number;
  pan: { x: number; y: number };
  previewTransformAngle: number;
  logicalPreviewSize: { width: number; height: number };
  zoomRegionPreview: ZoomRegionPreview | null;
  cropImageSize: { width: number; height: number };
  contactSheetEntries: BatchJobEntry[];
  contactSheetSharedSettings: ConversionSettings | null;
  contactSheetSharedProfile: FilmProfile | null;
  contactSheetSharedLabStyle: LabStyleProfile | null;
  contactSheetSharedColorManagement: ColorManagementSettings | null;
  contactSheetSharedLightSourceBias: [number, number, number] | null;
  onSetIsPanDragging: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  onSetComparisonMode: React.Dispatch<React.SetStateAction<'processed' | 'original'>>;
  onSetIsCropOverlayVisible: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowSettingsModal: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowBatchModal: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowContactSheetModal: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowShortcutHelp: React.Dispatch<React.SetStateAction<boolean>>;
  onSetSuggestionNotice: React.Dispatch<React.SetStateAction<SuggestionNoticeState | null>>;
  onSetTransientNotice: React.Dispatch<React.SetStateAction<TransientNoticeState | null>>;
  onSetError: React.Dispatch<React.SetStateAction<string | null>>;
  onOpenImage: () => Promise<void>;
  onCloseImage: (requestedTabId?: string | null) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onToggleLeftPane: () => void;
  onReset: () => void;
  onOpenInEditor: () => void;
  onDownload: () => void;
  onCancelExport: () => void;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onRecentImport: (file: File, path?: string | null, size?: number) => Promise<string | null>;
  onSelectTab: (tabId: string) => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onSyncRollSettings: (tabId: string, rollId: string) => void;
  onApplyRollFilmBase: (rollId: string) => void;
  onRemoveFromRoll: (tabId: string) => void;
  onOpenRollInfo: (rollId: string) => void;
  onDeleteRoll: (rollId: string) => void;
  onCreateRollFromTabs: () => void;
  onCopySettings: () => void;
  onPasteSettings: (tabIds?: string[]) => void;
  canPasteSettings: boolean;
  onToggleScanningSession: () => void;
  onOpenContactSheet: (payload: {
    entries: BatchJobEntry[];
    sharedSettings: ConversionSettings;
    sharedProfile: FilmProfile;
    sharedLabStyle: LabStyleProfile | null;
    sharedColorManagement: ColorManagementSettings;
    sharedLightSourceBias: [number, number, number] | null;
  }) => void;
  defaultExportOptions: WorkspaceDocument['exportOptions'];
  onSettingsChange: (newSettings: Partial<ConversionSettings>) => void;
  onDustRemovalChange: (dustRemoval: ConversionSettings['dustRemoval']) => void;
  onExportOptionsChange: (options: Partial<WorkspaceDocument['exportOptions']>) => void;
  onColorManagementChange: (options: Partial<ColorManagementSettings>) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
  onLevelInteractionChange: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleFilmBasePicker: () => void;
  onReanalyzeFilmBase: () => void;
  isReanalyzingFilmBase: boolean;
  onExportClick: () => void;
  onQuickExport: (preset: QuickExportPreset) => void;
  onSaveQuickExportPreset: () => void;
  onDeleteQuickExportPreset: (presetId: string) => void;
  onOpenBatchExport: () => void;
  onSidebarScrollTopChange: (scrollTop: number) => void;
  onSidebarTabChange: (tab: 'adjust' | 'profiles' | 'curves' | 'crop' | 'dust' | 'export') => void;
  onCropTabChange: (tab: CropTab) => void;
  onRedetectFrame: () => void;
  onAutoLensDistortion: () => void;
  isEstimatingLensDistortion: boolean;
  onAutoCropSelected: (tabIds: string[]) => Promise<void>;
  onCropDone: () => void;
  onResetCrop: () => void;
  onDetectDust: () => void;
  onDustBrushActiveChange: (active: boolean) => void;
  onSelectedDustMarkIdChange: (markId: string | null) => void;
  onDustBrushInteractionStart: () => void;
  onDustBrushInteractionEnd: () => void;
  onSetActivePointPicker: (mode: PointPickerMode | null) => void;
  onOpenSettingsModal: () => void;
  onLightSourceChange: (lightSourceId: string | null) => void;
  onLabStyleChange: (labStyleId: string | null) => void;
  onAutoAdjust: () => void;
  onAutoWhiteBalance: () => void;
  onProfileChange: (profile: FilmProfile) => void;
  onProfilePreview: (profile: FilmProfile) => void;
  onProfilePreviewEnd: () => void;
  onSavePreset: (name: string, metadata?: {
    filmStock?: string;
    scannerType?: ScannerType | null;
    folderId?: string | null;
    saveFraming?: boolean;
  }) => void;
  onImportPreset: (profile: FilmProfile, options?: { overwriteId?: string; renameTo?: string }) => void;
  onDeletePreset: (id: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMovePresetToFolder: (presetId: string, folderId: string | null) => void;
  onSaveCustomLightSource: (profile: {
    id?: string | null;
    name: string;
    colorTemperature: number;
    spectralBias: [number, number, number];
    flareCharacteristic: LightSourceProfile['flareCharacteristic'];
  }) => Promise<LightSourceProfile>;
  onDeleteCustomLightSource: (id: string) => void;
  onCopyDebugInfo: () => Promise<void>;
  onToggleGPURendering: (enabled: boolean) => void;
  onToggleUltraSmoothDrag: (enabled: boolean) => void;
  onMaxResidentDocsChange: (value: MaxResidentDocs) => void;
  onNotificationSettingsChange: (options: Partial<NotificationSettings>) => void;
  onDefaultLightSourceChange: (lightSourceId: string) => void;
  onChooseExternalEditor: () => Promise<void>;
  onClearExternalEditor: () => void;
  onChooseOpenInEditorOutputPath: () => Promise<void>;
  onUseDownloadsForOpenInEditor: () => void;
  onChooseDefaultExportPath: () => Promise<void>;
  onUseDownloadsForExport: () => void;
  onChooseBatchOutputPath: () => Promise<void>;
  onUseDownloadsForBatch: () => void;
  onChooseContactSheetOutputPath: () => Promise<void>;
  onUseDownloadsForContactSheet: () => void;
  onExportPresetBackup: () => Promise<'saved' | 'cancelled'>;
  onImportPresetBackup: (file?: File) => Promise<'imported' | 'cancelled'>;
  onUpdateChannelChange: (channel: 'stable' | 'beta') => void;
  onCheckForUpdates: () => void;
  onCanvasClick: (event: React.MouseEvent<HTMLCanvasElement>) => Promise<void>;
  onHandleZoomWheel: (deltaY: number, normX: number, normY: number) => void;
  onStartPan: (clientX: number, clientY: number) => void;
  onUpdatePan: (clientX: number, clientY: number, imageWidth: number, imageHeight: number, viewportWidth: number, viewportHeight: number, effectiveZoom: number) => void;
  onEndPan: () => void;
  onCropInteractionStart: () => void;
  onCropInteractionEnd: () => void;
  onCropOverlayChange: (crop: ConversionSettings['crop']) => void;
  onDustOverlayChange: (marks: NonNullable<ConversionSettings['dustRemoval']>['marks']) => void;
  onDropFile: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
  onTitleBarMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  zoomToFit: () => void;
  zoomTo100: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setZoomLevel: (zoom: number | 'fit') => void;
};

export function AppShell({
  usesNativeFileDialogs,
  fileInputRef,
  displayCanvasRef,
  viewportRef,
  previewContainerRef,
  panTransformRef,
  panGeometryRef,
  workerClient,
  documentState,
  activeTab,
  tabs,
  activeTabId,
  canUndo,
  canRedo,
  fallbackProfile,
  activeProfile,
  activeLabStyle,
  builtinProfiles,
  labStyleProfiles,
  lightSourceProfiles,
  customPresets,
  presetFolders,
  savePresetTags,
  sidebarTab,
  dustBrushActive,
  selectedDustMarkId,
  isDetectingDust,
  cropTab,
  comparisonMode,
  isLeftPaneOpen,
  isPickingFilmBase,
  activePointPicker,
  isAdjustingLevel,
  isAdjustingCrop,
  isPanDragging,
  isSpaceHeld,
  isDragActive,
  showSettingsModal,
  showBatchModal,
  showContactSheetModal,
  showShortcutHelp,
  showTabSwitchOverlay,
  tabSwitchOverlayKey,
  showMagnifier,
  isCropOverlayVisible,
  showBlockingOverlay,
  isRenderIndicatorVisible,
  overlayContent,
  error,
  suggestionNotice,
  transientNotice,
  isExporting,
  gpuRenderingEnabled,
  ultraSmoothDragEnabled,
  notificationSettings,
  renderBackendDiagnostics,
  defaultLightSourceId,
  defaultLabStyleId,
  defaultImportPresetId,
  onDefaultImportPresetChange,
  onDefaultLabStyleChange,
  maxResidentDocs,
  externalEditorPath,
  externalEditorName,
  openInEditorOutputPath,
  defaultExportPath,
  batchOutputPath,
  contactSheetOutputPath,
  customPresetCount,
  presetFolderCount,
  quickExportPresets,
  updaterEnabled,
  updaterDisabledReason,
  updateChannel,
  updateLastCheckedAt,
  updateError,
  isCheckingForUpdates,
  activeRoll,
  rolls,
  filmstripTabs,
  getRollById,
  profilesById,
  lightSourceProfilesById,
  zoom,
  fitScale,
  effectiveZoom,
  pan,
  previewTransformAngle,
  logicalPreviewSize,
  zoomRegionPreview,
  cropImageSize,
  contactSheetEntries,
  contactSheetSharedSettings,
  contactSheetSharedProfile,
  contactSheetSharedLabStyle,
  contactSheetSharedColorManagement,
  contactSheetSharedLightSourceBias,
  onSetIsPanDragging,
  onSetIsDragActive,
  onSetComparisonMode,
  onSetIsCropOverlayVisible,
  onSetShowSettingsModal,
  onSetShowBatchModal,
  onSetShowContactSheetModal,
  onSetShowShortcutHelp,
  onSetSuggestionNotice,
  onSetTransientNotice,
  onSetError,
  onOpenImage,
  onCloseImage,
  onUndo,
  onRedo,
  onToggleLeftPane,
  onReset,
  onOpenInEditor,
  onDownload,
  onCancelExport,
  onFileChange,
  onRecentImport,
  onSelectTab,
  onReorderTabs,
  onSyncRollSettings,
  onApplyRollFilmBase,
  onRemoveFromRoll,
  onOpenRollInfo,
  onDeleteRoll,
  onCreateRollFromTabs,
  onCopySettings,
  onPasteSettings,
  canPasteSettings,
  onToggleScanningSession,
  onOpenContactSheet,
  defaultExportOptions,
  onSettingsChange,
  onDustRemovalChange,
  onExportOptionsChange,
  onColorManagementChange,
  onInteractionStart,
  onInteractionEnd,
  onLevelInteractionChange,
  onToggleFilmBasePicker,
  onReanalyzeFilmBase,
  isReanalyzingFilmBase,
  onExportClick,
  onQuickExport,
  onSaveQuickExportPreset,
  onDeleteQuickExportPreset,
  onOpenBatchExport,
  onSidebarScrollTopChange,
  onSidebarTabChange,
  onCropTabChange,
  onRedetectFrame,
  onAutoLensDistortion,
  isEstimatingLensDistortion,
  onAutoCropSelected,
  onCropDone,
  onResetCrop,
  onDetectDust,
  onDustBrushActiveChange,
  onSelectedDustMarkIdChange,
  onDustBrushInteractionStart,
  onDustBrushInteractionEnd,
  onSetActivePointPicker,
  onOpenSettingsModal,
  onLightSourceChange,
  onLabStyleChange,
  onAutoAdjust,
  onAutoWhiteBalance,
  onProfileChange,
  onProfilePreview,
  onProfilePreviewEnd,
  onSavePreset,
  onImportPreset,
  onDeletePreset,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMovePresetToFolder,
  onSaveCustomLightSource,
  onDeleteCustomLightSource,
  onCopyDebugInfo,
  onToggleGPURendering,
  onToggleUltraSmoothDrag,
  onMaxResidentDocsChange,
  onNotificationSettingsChange,
  onDefaultLightSourceChange,
  onChooseExternalEditor,
  onClearExternalEditor,
  onChooseOpenInEditorOutputPath,
  onUseDownloadsForOpenInEditor,
  onChooseDefaultExportPath,
  onUseDownloadsForExport,
  onChooseBatchOutputPath,
  onUseDownloadsForBatch,
  onChooseContactSheetOutputPath,
  onUseDownloadsForContactSheet,
  onExportPresetBackup,
  onImportPresetBackup,
  onUpdateChannelChange,
  onCheckForUpdates,
  onCanvasClick,
  onHandleZoomWheel,
  onStartPan,
  onUpdatePan,
  onEndPan,
  onCropInteractionStart,
  onCropInteractionEnd,
  onCropOverlayChange,
  onDustOverlayChange,
  onDropFile,
  onTitleBarMouseDown,
  zoomToFit,
  zoomTo100,
  zoomIn,
  zoomOut,
  setZoomLevel,
}: AppShellProps) {
  const shortcutHelpRef = useRef<HTMLDivElement>(null);
  const commandPaletteRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);
  const [utilityMenuOpen, setUtilityMenuOpen] = React.useState(false);
  const [straightenActive, setStraightenActive] = React.useState(false);
  const [batchSelectionIds, setBatchSelectionIds] = React.useState<string[] | null>(null);
  const [isAutoCroppingSelection, setIsAutoCroppingSelection] = React.useState(false);
  const [selectedFilmstripIds, setSelectedFilmstripIds] = React.useState<Set<string>>(
    () => new Set(activeTabId ? [activeTabId] : []),
  );
  const availableProfiles = useMemo(
    () => [...builtinProfiles, ...customPresets],
    [builtinProfiles, customPresets],
  );
  const selectedFilmstripTabIds = useMemo(
    () => tabs.filter((tab) => selectedFilmstripIds.has(tab.id)).map((tab) => tab.id),
    [selectedFilmstripIds, tabs],
  );

  useEffect(() => {
    setSelectedFilmstripIds((current) => {
      const liveIds = new Set(tabs.map((tab) => tab.id));
      const next = new Set(Array.from(current).filter((id) => liveIds.has(id)));
      if (next.size === 0 && activeTabId) next.add(activeTabId);
      if (next.size === current.size && Array.from(next).every((id) => current.has(id))) return current;
      return next;
    });
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (sidebarTab !== 'crop' || !isCropOverlayVisible || comparisonMode !== 'processed') {
      setStraightenActive(false);
    }
  }, [comparisonMode, isCropOverlayVisible, sidebarTab]);
  const [showCommandPalette, setShowCommandPalette] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const [adjustView, setAdjustView] = React.useState<'basic' | 'advanced'>('basic');
  const closeShortcutHelp = React.useCallback(() => onSetShowShortcutHelp(false), [onSetShowShortcutHelp]);
  const { titleId: shortcutHelpTitleId } = useModalA11y(showShortcutHelp, closeShortcutHelp);
  const closeCommandPalette = React.useCallback(() => setShowCommandPalette(false), []);
  const { titleId: commandPaletteTitleId } = useModalA11y(showCommandPalette, closeCommandPalette);

  useFocusTrap(shortcutHelpRef, showShortcutHelp);
  useFocusTrap(commandPaletteRef, showCommandPalette);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setShowCommandPalette((current) => !current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const openAdjustView = React.useCallback((view: 'basic' | 'advanced') => {
    setAdjustView(view);
    onSidebarTabChange('adjust');
    if (!isLeftPaneOpen) onToggleLeftPane();
  }, [isLeftPaneOpen, onSidebarTabChange, onToggleLeftPane]);

  const openProfiles = React.useCallback(() => {
    onSidebarTabChange('profiles');
    if (!isLeftPaneOpen) onToggleLeftPane();
  }, [isLeftPaneOpen, onSidebarTabChange, onToggleLeftPane]);

  const runAutoCropCommand = React.useCallback(async () => {
    if (isAutoCroppingSelection) return;
    if (selectedFilmstripTabIds.length <= 1) {
      onRedetectFrame();
      return;
    }

    setIsAutoCroppingSelection(true);
    try {
      await onAutoCropSelected(selectedFilmstripTabIds);
    } finally {
      setIsAutoCroppingSelection(false);
    }
  }, [isAutoCroppingSelection, onAutoCropSelected, onRedetectFrame, selectedFilmstripTabIds]);

  const selectRailTool = React.useCallback((tool: SidebarRailTool) => {
    if (tool === 'basic') {
      if (sidebarTab === 'adjust' && adjustView === 'basic' && isLeftPaneOpen) {
        onToggleLeftPane();
        return;
      }
      openAdjustView('basic');
      return;
    }
    if (tool === 'adjust') {
      if (sidebarTab === 'adjust' && adjustView === 'advanced' && isLeftPaneOpen) {
        onToggleLeftPane();
        return;
      }
      openAdjustView('advanced');
      return;
    }
    if (tool === 'profiles') {
      if (sidebarTab === 'profiles' && isLeftPaneOpen) {
        onToggleLeftPane();
        return;
      }
      openProfiles();
      return;
    }
    if (tool === sidebarTab) {
      onToggleLeftPane();
      return;
    }
    onSidebarTabChange(tool);
    if (!isLeftPaneOpen) onToggleLeftPane();
  }, [adjustView, isLeftPaneOpen, onSidebarTabChange, onToggleLeftPane, openAdjustView, openProfiles, sidebarTab]);

  useEffect(() => {
    const handleToolShortcut = (event: KeyboardEvent) => {
      if (
        !documentState
        || showShortcutHelp
        || showCommandPalette
        || showSettingsModal
        || showBatchModal
        || showContactSheetModal
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.repeat
      ) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;

      const key = event.key.toLowerCase();
      if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        void runAutoCropCommand();
      } else if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        openAdjustView('basic');
      } else if (key === 'v' && !event.shiftKey) {
        event.preventDefault();
        openAdjustView('advanced');
      } else if (key === 'p' && !event.shiftKey) {
        event.preventDefault();
        openProfiles();
      }
    };
    window.addEventListener('keydown', handleToolShortcut);
    return () => window.removeEventListener('keydown', handleToolShortcut);
  }, [
    documentState,
    openAdjustView,
    openProfiles,
    runAutoCropCommand,
    showBatchModal,
    showCommandPalette,
    showContactSheetModal,
    showSettingsModal,
    showShortcutHelp,
  ]);

  useEffect(() => {
    if (!showCommandPalette) {
      setCommandQuery('');
      return;
    }
    window.requestAnimationFrame(() => commandInputRef.current?.focus());
  }, [showCommandPalette]);

  useEffect(() => {
    if (!showBatchModal) setBatchSelectionIds(null);
  }, [showBatchModal]);

  const openBatchExport = React.useCallback((tabIds?: string[]) => {
    setBatchSelectionIds(tabIds && tabIds.length > 1 ? tabIds : null);
    onSetShowBatchModal(true);
  }, [onSetShowBatchModal]);
  const clearFilmstripSelection = React.useCallback(() => {
    const fallbackId = activeTabId ?? tabs[0]?.id;
    setSelectedFilmstripIds(new Set(fallbackId ? [fallbackId] : []));
  }, [activeTabId, tabs]);
  const toggleAllFilmstripFrames = React.useCallback(() => {
    if (selectedFilmstripIds.size === tabs.length) {
      clearFilmstripSelection();
      return;
    }
    setSelectedFilmstripIds(new Set(tabs.map((tab) => tab.id)));
  }, [clearFilmstripSelection, selectedFilmstripIds.size, tabs]);
  void isAdjustingCrop;
  void profilesById;
  void lightSourceProfilesById;

  useEffect(() => {
    const element = previewContainerRef.current;
    if (!element) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const normX = (event.clientX - rect.left) / rect.width;
      const normY = (event.clientY - rect.top) / rect.height;
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
      onHandleZoomWheel(event.deltaY * deltaScale, normX, normY);
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, [documentState, onHandleZoomWheel, previewContainerRef]);

  useLayoutEffect(() => {
    panGeometryRef.current = {
      imageWidth: logicalPreviewSize.width,
      imageHeight: logicalPreviewSize.height,
      viewportWidth: viewportRef.current?.clientWidth ?? 1,
      viewportHeight: viewportRef.current?.clientHeight ?? 1,
      fitScale,
    };
  }, [fitScale, logicalPreviewSize.height, logicalPreviewSize.width, panGeometryRef, viewportRef]);

  const panTransformStyle = useMemo(() => {
    const viewportWidth = viewportRef.current?.clientWidth ?? 1;
    const viewportHeight = viewportRef.current?.clientHeight ?? 1;
    const translate = computePanTranslate(
      pan,
      logicalPreviewSize.width,
      logicalPreviewSize.height,
      viewportWidth,
      viewportHeight,
      effectiveZoom,
    );

    return {
      transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${effectiveZoom})`,
      transformOrigin: 'center center',
    };
  }, [effectiveZoom, logicalPreviewSize.height, logicalPreviewSize.width, pan, viewportRef]);
  const activeFilmstripIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const workspaceCommands = [
    { label: 'Add images', keywords: 'open import files', shortcut: `${SHORTCUT_MODIFIER} O`, run: () => void onOpenImage() },
    ...(documentState ? [
      { label: 'Export current frame', keywords: 'save download', shortcut: `${SHORTCUT_MODIFIER} E`, run: onDownload },
      { label: 'Batch export', keywords: 'convert all folder', shortcut: `${SHORTCUT_MODIFIER} ⇧ E`, run: () => openBatchExport() },
      { label: 'Auto adjust', keywords: 'automatic exposure contrast', shortcut: 'A', run: onAutoAdjust },
      { label: selectedFilmstripTabIds.length > 1 ? 'Auto crop selected images' : 'Auto crop current image', keywords: 'automatic frame detection crop selected', shortcut: '⇧ C', run: () => { void runAutoCropCommand(); } },
      { label: 'Crop and level', keywords: 'rotate geometry straighten', shortcut: 'C', run: () => {
        onSidebarTabChange('crop');
        if (!isLeftPaneOpen) onToggleLeftPane();
      } },
      { label: 'Dust cleanup', keywords: 'scratch hair removal', run: () => {
        onSidebarTabChange('dust');
        if (!isLeftPaneOpen) onToggleLeftPane();
      } },
      { label: 'Reset adjustments', keywords: 'restore preset defaults', run: onReset },
      ...(usesNativeFileDialogs ? [{ label: 'Open in external editor', keywords: 'photoshop affinity', shortcut: `${SHORTCUT_MODIFIER} ⇧ O`, run: onOpenInEditor }] : []),
    ] : []),
    ...(documentState ? [
      { label: isLeftPaneOpen ? 'Hide adjustments' : 'Show adjustments', keywords: 'left panel controls', run: onToggleLeftPane },
      { label: 'Film profiles', keywords: 'film stock preset left panel', shortcut: 'P', run: openProfiles },
    ] : []),
    { label: 'Keyboard shortcuts', keywords: 'help keys commands', shortcut: '?', run: () => onSetShowShortcutHelp(true) },
    { label: 'Settings', keywords: 'preferences configuration', shortcut: `${SHORTCUT_MODIFIER} ,`, run: onOpenSettingsModal },
  ];
  const normalizedCommandQuery = commandQuery.trim().toLowerCase();
  const filteredWorkspaceCommands = workspaceCommands.filter((command) => (
    !normalizedCommandQuery
    || `${command.label} ${command.keywords}`.toLowerCase().includes(normalizedCommandQuery)
  ));
  const runWorkspaceCommand = (command: typeof workspaceCommands[number]) => {
    setShowCommandPalette(false);
    command.run();
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      {usesNativeFileDialogs && (
        <div
          data-tauri-drag-region=""
          onMouseDownCapture={onTitleBarMouseDown}
          className="absolute inset-x-0 top-0 z-30 h-8 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl"
        />
      )}

      <div className={`flex min-h-0 w-full flex-1 ${usesNativeFileDialogs ? 'pt-8' : ''}`}>
        <AnimatePresence initial={false}>
          {documentState && isLeftPaneOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="order-2 h-full shrink-0 overflow-hidden border-r border-zinc-800"
            >
              <ErrorBoundary>
                {sidebarTab === 'profiles' ? (
                  <PresetsPane
                    activeStockId={documentState.profileId ?? fallbackProfile.id}
                    onStockChange={onProfileChange}
                    onStockPreview={onProfilePreview}
                    onStockPreviewEnd={onProfilePreviewEnd}
                    builtinProfiles={builtinProfiles}
                    customPresets={customPresets}
                    presetFolders={presetFolders}
                    canSavePreset
                    saveTags={savePresetTags}
                    onSavePreset={onSavePreset}
                    onImportPreset={onImportPreset}
                    onDeletePreset={onDeletePreset}
                    onCreateFolder={onCreateFolder}
                    onRenameFolder={onRenameFolder}
                    onDeleteFolder={onDeleteFolder}
                    onMovePresetToFolder={onMovePresetToFolder}
                    onError={onSetError}
                    rolls={rolls}
                    activeRoll={activeRoll}
                    activeTabId={activeTabId}
                    filmstripTabs={filmstripTabs}
                    onSelectTab={onSelectTab}
                    onOpenRollInfo={onOpenRollInfo}
                    onSyncRollSettings={onSyncRollSettings}
                    onRemoveFromRoll={onRemoveFromRoll}
                    onDeleteRoll={onDeleteRoll}
                    onCreateRollFromTabs={onCreateRollFromTabs}
                    onToggleScanningSession={onToggleScanningSession}
                    usesNativeFileDialogs={usesNativeFileDialogs}
                    tabs={tabs}
                  />
                ) : (
                  <Sidebar
                  settings={documentState?.settings ?? fallbackProfile.defaultSettings}
                  exportOptions={documentState?.exportOptions ?? defaultExportOptions}
                  quickExportPresets={quickExportPresets}
                  colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
                  sourceMetadata={documentState?.source ?? null}
                  cropImageWidth={cropImageSize.width}
                  cropImageHeight={cropImageSize.height}
                  onLevelInteractionChange={onLevelInteractionChange}
                  straightenActive={straightenActive}
                  onStraightenActiveChange={(active) => {
                    setStraightenActive(active);
                    if (active) {
                      onSetIsCropOverlayVisible(true);
                      onSetComparisonMode('processed');
                    }
                  }}
                  onSettingsChange={onSettingsChange}
                  onExportOptionsChange={onExportOptionsChange}
                  onColorManagementChange={onColorManagementChange}
                  onInteractionStart={onInteractionStart}
                  onInteractionEnd={onInteractionEnd}
                  activeProfile={documentState ? activeProfile : null}
                  activeLabStyleId={documentState?.labStyleId ?? null}
                  labStyleProfiles={labStyleProfiles}
                  estimatedFlare={documentState?.estimatedFlare ?? null}
                  lightSourceId={documentState?.lightSourceId ?? null}
                  cropSource={documentState?.cropSource ?? null}
                  lightSourceProfiles={lightSourceProfiles}
                  histogramData={documentState?.histogram ?? null}
                  isPickingFilmBase={isPickingFilmBase}
                  isReanalyzingFilmBase={isReanalyzingFilmBase}
                  estimatedFilmBase={documentState?.estimatedFilmBase ?? null}
                  filmBaseSampleSource={documentState?.settings.filmBaseSampleSource ?? null}
                  onTogglePicker={onToggleFilmBasePicker}
                  onReanalyzeFilmBase={onReanalyzeFilmBase}
                  onExport={onExportClick}
                  onCancelExport={onCancelExport}
                  onQuickExport={onQuickExport}
                  onSaveQuickExportPreset={onSaveQuickExportPreset}
                  onDeleteQuickExportPreset={onDeleteQuickExportPreset}
                  onOpenBatchExport={onOpenBatchExport}
                  onPreviousImage={activeFilmstripIndex > 0
                    ? () => onSelectTab(tabs[activeFilmstripIndex - 1].id)
                    : undefined}
                  onNextImage={activeFilmstripIndex >= 0 && activeFilmstripIndex < tabs.length - 1
                    ? () => onSelectTab(tabs[activeFilmstripIndex + 1].id)
                    : undefined}
                  canPreviousImage={activeFilmstripIndex > 0}
                  canNextImage={activeFilmstripIndex >= 0 && activeFilmstripIndex < tabs.length - 1}
                  isExporting={isExporting}
                  contentScrollTop={activeTab?.sidebarScrollTop ?? 0}
                  onContentScrollTopChange={onSidebarScrollTopChange}
                  activeTab={sidebarTab}
                  onTabChange={onSidebarTabChange}
                  cropTab={cropTab}
                  onCropTabChange={onCropTabChange}
                  onRedetectFrame={onRedetectFrame}
                  onAutoLensDistortion={onAutoLensDistortion}
                  isEstimatingLensDistortion={isEstimatingLensDistortion}
                  onCropDone={onCropDone}
                  onResetCrop={onResetCrop}
                  onDustRemovalChange={onDustRemovalChange}
                  onDetectDust={onDetectDust}
                  isDetectingDust={isDetectingDust}
                  dustBrushActive={dustBrushActive}
                  onDustBrushActiveChange={onDustBrushActiveChange}
                  activePointPicker={activePointPicker}
                  onSetPointPicker={onSetActivePointPicker}
                  onOpenSettings={onOpenSettingsModal}
                  onLightSourceChange={onLightSourceChange}
                  onLabStyleChange={onLabStyleChange}
                  onAutoAdjust={onAutoAdjust}
                  onAutoWhiteBalance={onAutoWhiteBalance}
                  filmProfiles={availableProfiles}
                  onProfileChange={onProfileChange}
                  adjustView={adjustView}
                  onAdjustViewChange={setAdjustView}
                  showAdjustmentViewToggle={false}
                />
                )}
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>

        <SidebarToolRail
          activeTool={sidebarTab === 'adjust' ? (adjustView === 'basic' ? 'basic' : 'adjust') : sidebarTab}
          panelOpen={isLeftPaneOpen}
          editingEnabled={Boolean(documentState)}
          onOpenSettings={onOpenSettingsModal}
          onSelect={selectRailTool}
        />

        <main className="order-3 relative flex min-w-0 flex-1 flex-col overflow-hidden bg-zinc-900/30 pb-10">
          <header className="relative z-20 flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-3 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              {documentState && (
                <button
                  onClick={onToggleLeftPane}
                  aria-label={isLeftPaneOpen ? 'Hide editing panel' : 'Show editing panel'}
                  className="rounded-md p-1 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-200"
                  data-tip="Toggle Adjustments"
                >
                  {isLeftPaneOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
                </button>
              )}
              <h1 className="ml-1 text-[13px] font-bold tracking-tight text-zinc-100">
                Dark<span className="font-medium text-amber-400">Slide</span>
              </h1>
            </div>

            {documentState && (
              <div className="pointer-events-none absolute left-1/2 hidden max-w-[34%] -translate-x-1/2 text-center md:block">
                <p className="truncate text-xs font-medium text-zinc-300">{documentState.source.name}</p>
                <p className="mt-0.5 text-xs tabular-nums text-zinc-500">
                  Frame {activeFilmstripIndex + 1} of {tabs.length}
                  {' · '}{documentState.source.width.toLocaleString()} × {documentState.source.height.toLocaleString()} px
                  {' · '}{formatAspectRatio(documentState.source.width, documentState.source.height)}
                  {activeRoll ? ` · ${activeRoll.name}` : ''}
                </p>
              </div>
            )}

            <div className="relative flex items-center gap-2">
              {!documentState && (
                <button
                  onClick={() => void onOpenImage()}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 transition-all hover:bg-zinc-700"
                >
                  <Upload size={16} /> Import
                </button>
              )}
              {!usesNativeFileDialogs && (
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(event) => { void onFileChange(event); }}
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                  className="hidden"
                />
              )}
            </div>
          </header>

          <ErrorBoundary>
            <div
              data-testid="image-drop-zone"
              ref={viewportRef}
              className={`relative flex flex-1 items-center justify-center overflow-hidden ${isDragActive ? 'bg-zinc-900/60' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                onSetIsDragActive(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  onSetIsDragActive(false);
                }
              }}
              onDrop={(event) => {
                onSetIsDragActive(false);
                void onDropFile(event);
              }}
            >
              <AnimatePresence>
                {isDragActive && (
                  <motion.div
                    aria-hidden="true"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-zinc-500/70 bg-zinc-950/70 backdrop-blur-sm"
                  >
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Upload size={34} className="text-zinc-300" />
                      <p className="text-base font-semibold text-zinc-100">Drop files to import</p>
                      <p className="text-xs text-zinc-400">TIFF, JPEG, PNG, WebP, or desktop RAW files</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <AnimatePresence mode="wait">
                {!documentState ? (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="flex max-w-md flex-col items-center text-center"
                  >
                    <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl">
                      <ImageIcon size={32} className="text-zinc-600" />
                    </div>
                    <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-200">Drop your negatives here</h2>
                    <p className="mb-8 text-sm leading-relaxed text-zinc-500">Import TIFF, JPEG, or PNG scans, plus RAW files in the desktop app.</p>
                    <button
                      onClick={() => void onOpenImage()}
                      className="rounded-2xl bg-zinc-100 px-8 py-3 font-semibold text-zinc-950 shadow-xl shadow-black/40 transition-all hover:bg-white"
                    >
                      Select Files
                    </button>
                    <RecentFilesList
                      onImport={(file, path, size) => void onRecentImport(file, path, size)}
                      onOpenPicker={() => void onOpenImage()}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="editor"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="relative flex h-full w-full flex-col items-center justify-center"
                  >
                    <div
                      data-testid="image-preview-stage"
                      ref={previewContainerRef}
                      className="relative w-full flex-1 overflow-hidden bg-[#151616]"
                      onMouseDown={(event) => {
                        const canPan = (zoom !== 'fit' || isSpaceHeld)
                          && !isPickingFilmBase
                          && !activePointPicker
                          && !isCropOverlayVisible
                          && !dustBrushActive;
                        if (canPan && event.button === 0) {
                          event.preventDefault();
                          onSetIsPanDragging(true);
                          onStartPan(event.clientX, event.clientY);
                        }
                      }}
                      onMouseMove={(event) => {
                        if (!isPanDragging || !viewportRef.current) return;
                        onUpdatePan(
                          event.clientX,
                          event.clientY,
                          logicalPreviewSize.width,
                          logicalPreviewSize.height,
                          viewportRef.current.clientWidth,
                          viewportRef.current.clientHeight,
                          effectiveZoom,
                        );
                      }}
                      onMouseUp={() => {
                        if (isPanDragging) {
                          onSetIsPanDragging(false);
                          onEndPan();
                        }
                      }}
                      onMouseLeave={() => {
                        if (isPanDragging) {
                          onSetIsPanDragging(false);
                          onEndPan();
                        }
                      }}
                      style={{ cursor: isPanDragging ? 'grabbing' : (zoom !== 'fit' && !isPickingFilmBase && !activePointPicker && !dustBrushActive ? 'grab' : undefined) }}
                    >
                      <AnimatePresence initial={false}>
                        {showTabSwitchOverlay && (
                          <motion.div
                            key={tabSwitchOverlayKey}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: [0, 0.16, 0] }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.22, ease: 'easeOut' }}
                            className="pointer-events-none absolute inset-0 z-10"
                            style={{
                              background: 'radial-gradient(circle at center, rgba(24,24,27,0.28), rgba(24,24,27,0.14) 46%, rgba(24,24,27,0) 76%)',
                            }}
                          />
                        )}
                      </AnimatePresence>

                      <div
                        ref={panTransformRef}
                        className="absolute inset-0 flex items-center justify-center will-change-transform"
                        style={panTransformStyle}
                      >
                        <div
                          className="relative inline-block will-change-transform"
                          style={previewTransformAngle === 0 ? undefined : { transform: `rotate(${previewTransformAngle}deg)` }}
                        >
                          <canvas
                            ref={displayCanvasRef}
                            onClick={(event) => { void onCanvasClick(event); }}
                            className={`block transition-opacity duration-300 ${showBlockingOverlay ? 'opacity-30' : 'opacity-100'} ${showMagnifier ? 'cursor-none' : ''}`}
                            style={{
                              width: `${logicalPreviewSize.width}px`,
                              height: `${logicalPreviewSize.height}px`,
                            }}
                          />
                          {zoomRegionPreview && (
                            <WebGLZoomRegion preview={zoomRegionPreview} />
                          )}
                          {isAdjustingLevel && comparisonMode === 'processed' && (
                            <div
                              className="pointer-events-none absolute inset-0 opacity-80"
                              style={{
                                backgroundImage: [
                                  'linear-gradient(to right, transparent 24.35%, rgba(0,0,0,0.28) 24.7%, rgba(255,255,255,0.58) 25%, rgba(0,0,0,0.28) 25.3%, transparent 25.65%)',
                                  'linear-gradient(to right, transparent 49.2%, rgba(0,0,0,0.34) 49.65%, rgba(255,255,255,0.82) 50%, rgba(0,0,0,0.34) 50.35%, transparent 50.8%)',
                                  'linear-gradient(to right, transparent 74.35%, rgba(0,0,0,0.28) 74.7%, rgba(255,255,255,0.58) 75%, rgba(0,0,0,0.28) 75.3%, transparent 75.65%)',
                                  'linear-gradient(to bottom, transparent 24.35%, rgba(0,0,0,0.28) 24.7%, rgba(255,255,255,0.58) 25%, rgba(0,0,0,0.28) 25.3%, transparent 25.65%)',
                                  'linear-gradient(to bottom, transparent 49.2%, rgba(0,0,0,0.34) 49.65%, rgba(255,255,255,0.82) 50%, rgba(0,0,0,0.34) 50.35%, transparent 50.8%)',
                                  'linear-gradient(to bottom, transparent 74.35%, rgba(0,0,0,0.28) 74.7%, rgba(255,255,255,0.58) 75%, rgba(0,0,0,0.28) 75.3%, transparent 75.65%)',
                                ].join(','),
                                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.28)',
                              }}
                            />
                          )}
                          {isCropOverlayVisible && comparisonMode === 'processed' && (
                            <CropOverlay
                              crop={documentState.settings.crop}
                              imageWidth={cropImageSize.width}
                              imageHeight={cropImageSize.height}
                              levelAngle={documentState.settings.levelAngle}
                              straightenActive={straightenActive}
                              onLevelAngleChange={(levelAngle) => onSettingsChange({ levelAngle })}
                              onInteractionStart={() => {
                                onCropInteractionStart();
                                if (straightenActive) onLevelInteractionChange(true);
                              }}
                              onInteractionEnd={() => {
                                if (straightenActive) onLevelInteractionChange(false);
                                onCropInteractionEnd();
                              }}
                              onChange={onCropOverlayChange}
                            />
                          )}
                          {comparisonMode === 'processed' && sidebarTab === 'dust' && documentState.settings.dustRemoval && (
                            <DustOverlay
                              settings={documentState.settings}
                              sourceWidth={documentState.source.width}
                              sourceHeight={documentState.source.height}
                              brushActive={dustBrushActive}
                              marks={documentState.settings.dustRemoval.marks}
                              manualBrushRadiusPx={documentState.settings.dustRemoval.manualBrushRadius}
                              selectedMarkId={selectedDustMarkId}
                              onSelectedMarkIdChange={onSelectedDustMarkIdChange}
                              onChange={onDustOverlayChange}
                              onInteractionStart={onDustBrushInteractionStart}
                              onInteractionEnd={onDustBrushInteractionEnd}
                            />
                          )}
                        </div>
                      </div>
                    </div>

                  </motion.div>
                )}
              </AnimatePresence>

              {overlayContent && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/55 backdrop-blur-sm">
                  <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-950/95 px-6 py-5 shadow-2xl shadow-black/60">
                    <div className="flex items-center gap-4">
                      <Loader2 className="shrink-0 animate-spin text-zinc-200" size={30} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-zinc-100">{overlayContent.title}</p>
                        <p className="mt-1 text-xs text-zinc-400">{overlayContent.detail}</p>
                      </div>
                    </div>
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
                      <div className="h-full w-1/2 animate-pulse rounded-full bg-zinc-200" />
                    </div>
                  </div>
                </div>
              )}

              <div
                data-testid="notification-stack"
                className="pointer-events-none absolute bottom-8 right-8 z-50 flex w-[min(28rem,calc(100%-4rem))] flex-col items-stretch gap-3"
              >
                <AnimatePresence initial={false}>
                  {transientNotice && (
                    <motion.div
                      key="transient-notice"
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 12 }}
                      className={`pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-2xl backdrop-blur-xl ${
                        transientNotice.tone === 'success'
                          ? 'border border-emerald-800/60 bg-emerald-950/55 text-emerald-100'
                          : transientNotice.tone === 'info'
                            ? 'border border-zinc-700/70 bg-zinc-900/90 text-zinc-200'
                            : 'border border-amber-800/60 bg-amber-950/55 text-amber-100'
                      }`}
                    >
                      {transientNotice.tone === 'info'
                        ? <Info size={18} className="shrink-0 text-zinc-400" />
                        : <FileWarning size={18} className={`shrink-0 ${transientNotice.tone === 'success' ? 'text-emerald-300' : 'text-amber-300'}`} />}
                      <span className="min-w-0 flex-1">{transientNotice.message}</span>
                      <button type="button" onClick={() => onSetTransientNotice(null)} aria-label="Dismiss notification" className="shrink-0 opacity-50 hover:opacity-100">✕</button>
                    </motion.div>
                  )}

                  {error && (
                    <motion.div
                      key="error-notice"
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 12 }}
                      className="pointer-events-auto flex items-center gap-3 rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-200 shadow-2xl backdrop-blur-xl"
                    >
                      <FileWarning size={18} className="shrink-0 text-red-400" />
                      <span className="min-w-0 flex-1">{error}</span>
                      <button type="button" onClick={() => onSetError(null)} aria-label="Dismiss error" className="shrink-0 opacity-50 hover:opacity-100">✕</button>
                    </motion.div>
                  )}

                  {suggestionNotice && (
                    <motion.div
                      key="suggestion-notice"
                      layout
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
                      className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-zinc-700/70 bg-zinc-900/90 px-4 py-3 text-sm text-zinc-200 shadow-2xl shadow-black/50 backdrop-blur-xl"
                    >
                      <ImageIcon size={16} className="shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 leading-snug text-zinc-300">{suggestionNotice.message}</span>
                      <button
                        type="button"
                        onClick={() => {
                          suggestionNotice.onAction();
                          onSetSuggestionNotice(null);
                        }}
                        className="shrink-0 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 transition-colors hover:bg-white"
                      >
                        {suggestionNotice.actionLabel}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSetSuggestionNotice(null)}
                        className="shrink-0 text-zinc-600 transition-colors hover:text-zinc-300"
                        aria-label="Dismiss suggestion"
                      >
                        <X size={13} />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </ErrorBoundary>

          {tabs.length > 0 && (
            <ErrorBoundary>
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                workerClient={workerClient}
                profilesById={profilesById}
                lightSourceProfilesById={lightSourceProfilesById}
                getRollById={getRollById}
                onSelectTab={onSelectTab}
                onCloseTab={(tabId) => void onCloseImage(tabId)}
                onCreateTab={() => void onOpenImage()}
                onReorderTabs={onReorderTabs}
                onSyncRollSettings={onSyncRollSettings}
                onApplyRollFilmBase={onApplyRollFilmBase}
                onRemoveFromRoll={onRemoveFromRoll}
                onOpenRollInfo={onOpenRollInfo}
                selectedIds={selectedFilmstripIds}
                onSelectionChange={setSelectedFilmstripIds}
              />
            </ErrorBoundary>
          )}
        </main>

        {showMagnifier && (
          <MagnifierLoupe
            sourceCanvas={displayCanvasRef.current}
            containerRef={viewportRef}
            magnification={6}
            size={120}
          />
        )}
      </div>

      {documentState && tabs.length > 0 && (
        <footer
          data-testid="bottom-utility-bar"
          className="absolute bottom-0 z-30 grid h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-t border-zinc-800 bg-zinc-950 px-2 shadow-[0_-8px_24px_rgba(0,0,0,0.2)] transition-[left,right] duration-300"
          style={{
            left: 48 + (isLeftPaneOpen ? 320 : 0),
            right: 0,
          }}
        >
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {selectedFilmstripTabIds.length > 1 && (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-400/10 px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-300">
                <CheckCheck size={11} /> {selectedFilmstripTabIds.length} selected
              </span>
            )}
            {activeLabStyle && (
              <div className="hidden min-w-0 items-center gap-1 text-zinc-600 xl:flex">
                <Building2 size={11} className="shrink-0" />
                <span className="truncate text-[9px] font-mono uppercase tracking-[0.14em]">
                  {activeLabStyle.name}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo"
              data-tip="Undo (Cmd+Z)"
              className="filmstrip-action justify-center px-2"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label="Redo"
              data-tip="Redo (Cmd+Shift+Z)"
              className="filmstrip-action justify-center px-2"
            >
              <Redo2 size={14} />
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-800" />
            <button
              type="button"
              onClick={() => onSetComparisonMode((current) => current === 'processed' ? 'original' : 'processed')}
              aria-label={comparisonMode === 'original' ? 'Return to processed view' : 'Show original image'}
              aria-pressed={comparisonMode === 'original'}
              data-active={comparisonMode === 'original' || undefined}
              data-tip={comparisonMode === 'original' ? 'Showing Original — click to return' : 'Toggle Before/After'}
              className="filmstrip-action justify-center px-2"
            >
              <SplitSquareVertical size={14} />
            </button>
            <button
              type="button"
              onClick={onReset}
              aria-label="Reset current adjustments"
              data-tip="Reset Adjustments"
              className="filmstrip-action justify-center px-2"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1.5">
            <AnimatePresence initial={false}>
              {isRenderIndicatorVisible && (
                <motion.div
                  key="render-indicator"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                  className="hidden text-[9px] font-mono uppercase tracking-[0.16em] text-zinc-600 lg:block"
                >
                  Rendering...
                </motion.div>
              )}
            </AnimatePresence>
            <ZoomBar
              zoom={zoom}
              fitScale={fitScale}
              onZoomToFit={zoomToFit}
              onZoomTo100={zoomTo100}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onSetZoom={setZoomLevel}
            />
            <div className="mx-1 h-5 w-px bg-zinc-800" />

            {selectedFilmstripTabIds.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => { void runAutoCropCommand(); }}
                  disabled={isAutoCroppingSelection}
                  className="filmstrip-action"
                  data-tip="Detect and crop every selected frame (Shift+C)"
                >
                  {isAutoCroppingSelection ? <Loader2 size={12} className="animate-spin" /> : <Crop size={12} />}
                  {isAutoCroppingSelection ? 'Cropping...' : 'Auto crop'}
                </button>
                <button type="button" onClick={onCopySettings} className="filmstrip-action" data-tip={`Copy current settings (${SHORTCUT_MODIFIER}+C)`}>
                  <Copy size={12} /> Copy
                </button>
                <button
                  type="button"
                  onClick={() => onPasteSettings(selectedFilmstripTabIds)}
                  disabled={!canPasteSettings}
                  className="filmstrip-action"
                  data-tip="Paste settings to the selected frames"
                >
                  <Layers2 size={12} /> Paste
                </button>
                <button type="button" onClick={() => openBatchExport(selectedFilmstripTabIds)} className="filmstrip-action" data-tip="Export only the selected frames">
                  <Download size={12} /> Export selected
                </button>
                {activeRoll && activeTabId && (
                  <button type="button" onClick={() => onSyncRollSettings(activeTabId, activeRoll.id)} className="filmstrip-action" data-tip="Apply current settings to this roll">
                    <RefreshCw size={12} /> Sync roll
                  </button>
                )}
                <button type="button" onClick={clearFilmstripSelection} className="filmstrip-action" data-tip="Clear multi-selection (Escape)">
                  <X size={12} /> Done
                </button>
              </>
            ) : (
              <>
                <div className="relative">
                  <button
                    type="button"
                    onClick={isExporting ? onCancelExport : () => setExportMenuOpen((current) => !current)}
                    aria-busy={isExporting}
                    aria-expanded={isExporting ? undefined : exportMenuOpen}
                    aria-haspopup={isExporting ? undefined : 'menu'}
                    className="filmstrip-action"
                    data-tip={isExporting ? 'Cancel the current export' : 'Export options'}
                  >
                    {isExporting ? <X size={12} /> : <Download size={12} />}
                    {isExporting ? 'Cancel export' : 'Export'}
                    {!isExporting && <ChevronDown size={10} aria-hidden="true" />}
                  </button>
                  {exportMenuOpen && (
                    <>
                      <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setExportMenuOpen(false)} aria-label="Close export options" />
                      <div role="menu" className="absolute bottom-full right-0 z-50 mb-2 min-w-52 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-1 shadow-2xl">
                        <HeaderMenuButton icon={<Download size={14} />} label="Export current image" onClick={onDownload} close={() => setExportMenuOpen(false)} />
                        <HeaderMenuButton icon={<Layers2 size={14} />} label="Batch export" shortcut={`${SHORTCUT_MODIFIER} ⇧ E`} onClick={() => openBatchExport()} close={() => setExportMenuOpen(false)} />
                      </div>
                    </>
                  )}
                </div>
                <button type="button" onClick={() => void onOpenImage()} className="filmstrip-action" data-tip={`Add images (${SHORTCUT_MODIFIER}+O)`}>
                  <ImagePlus size={12} /> Add
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setUtilityMenuOpen((current) => !current)}
                    className="filmstrip-action px-2"
                    aria-label="More filmstrip actions"
                    aria-expanded={utilityMenuOpen}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {utilityMenuOpen && (
                    <>
                      <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setUtilityMenuOpen(false)} aria-label="Close filmstrip actions" />
                      <div className="absolute bottom-full right-0 z-50 mb-2 min-w-52 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-1 shadow-2xl">
                        <HeaderMenuButton icon={<CheckCheck size={14} />} label="Select all frames" onClick={toggleAllFilmstripFrames} close={() => setUtilityMenuOpen(false)} />
                        <HeaderMenuButton icon={<Copy size={14} />} label="Copy current settings" onClick={onCopySettings} close={() => setUtilityMenuOpen(false)} />
                        {canPasteSettings && activeTabId && (
                          <HeaderMenuButton icon={<Layers2 size={14} />} label="Paste to current frame" onClick={() => onPasteSettings([activeTabId])} close={() => setUtilityMenuOpen(false)} />
                        )}
                        <div className="my-1 h-px bg-zinc-800" />
                        <HeaderMenuButton icon={<Crop size={14} />} label={isCropOverlayVisible ? 'Hide crop overlay' : 'Show crop overlay'} onClick={() => onSetIsCropOverlayVisible((current) => !current)} close={() => setUtilityMenuOpen(false)} />
                        <HeaderMenuButton icon={<Film size={14} />} label="Film profiles" shortcut="P" onClick={openProfiles} close={() => setUtilityMenuOpen(false)} />
                        {usesNativeFileDialogs && (
                          <HeaderMenuButton icon={<ExternalLink size={14} />} label="Open in external editor" shortcut={`${SHORTCUT_MODIFIER} ⇧ O`} onClick={onOpenInEditor} close={() => setUtilityMenuOpen(false)} />
                        )}
                        <HeaderMenuButton icon={<X size={14} />} label="Close current image" onClick={() => void onCloseImage()} close={() => setUtilityMenuOpen(false)} tone="danger" />
                        <div className="my-1 h-px bg-zinc-800" />
                        <HeaderMenuButton icon={<Search size={14} />} label="Commands" shortcut={`${SHORTCUT_MODIFIER} K`} onClick={() => setShowCommandPalette(true)} close={() => setUtilityMenuOpen(false)} />
                        <HeaderMenuButton icon={<Keyboard size={14} />} label="Keyboard shortcuts" shortcut="?" onClick={() => onSetShowShortcutHelp(true)} close={() => setUtilityMenuOpen(false)} />
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </footer>
      )}

      {showShortcutHelp && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onSetShowShortcutHelp(false);
          }}
        >
          <section
            ref={shortcutHelpRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={shortcutHelpTitleId}
            className="flex max-h-[min(720px,calc(100vh-3rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <div>
                <h2 id={shortcutHelpTitleId} className="text-sm font-semibold text-zinc-100">Keyboard shortcuts</h2>
                <p className="mt-1 text-xs text-zinc-500">Move through a roll without leaving the keyboard.</p>
              </div>
              <button autoFocus type="button" onClick={() => onSetShowShortcutHelp(false)} aria-label="Close keyboard shortcuts" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-800 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="custom-scrollbar grid overflow-y-auto gap-x-8 gap-y-1 p-5 sm:grid-cols-2">
              {SHORTCUTS.map(({ action, keys }) => (
                <ShortcutRow key={action} label={action} keys={keys} />
              ))}
            </div>
            <p className="border-t border-zinc-800 px-5 py-3 text-[10px] text-zinc-600">
              Tip: use Shift-click for a range, or {SHORTCUT_MODIFIER}-click to select individual frames in the filmstrip. Press Escape to close.
            </p>
          </section>
        </div>
      )}

      {showCommandPalette && (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/65 px-4 pt-[14vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCommandPalette(false);
          }}
        >
          <section
            ref={commandPaletteRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={commandPaletteTitleId}
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/70"
          >
            <h2 id={commandPaletteTitleId} className="sr-only">Commands</h2>
            <div className="flex items-center gap-3 border-b border-zinc-800 px-4">
              <Search size={17} className="shrink-0 text-zinc-500" />
              <input
                ref={commandInputRef}
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && filteredWorkspaceCommands[0]) {
                    event.preventDefault();
                    runWorkspaceCommand(filteredWorkspaceCommands[0]);
                  }
                }}
                className="h-13 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                placeholder="Type a command"
                aria-label="Search commands"
              />
              <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-1 font-mono text-[9px] text-zinc-600">Esc</kbd>
            </div>
            <div className="custom-scrollbar max-h-80 overflow-y-auto p-2">
              {filteredWorkspaceCommands.map((command, index) => (
                <button
                  key={command.label}
                  type="button"
                  onClick={() => runWorkspaceCommand(command)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${index === 0 ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`}
                >
                  <span className="flex-1">{command.label}</span>
                  {command.shortcut && <kbd className="font-mono text-[10px] text-zinc-600">{command.shortcut}</kbd>}
                </button>
              ))}
              {filteredWorkspaceCommands.length === 0 && (
                <p className="px-3 py-8 text-center text-xs text-zinc-600">No matching command</p>
              )}
            </div>
          </section>
        </div>
      )}

      <ErrorBoundary>
        <SettingsModal
          isOpen={showSettingsModal}
          onClose={() => onSetShowSettingsModal(false)}
          onCopyDebugInfo={onCopyDebugInfo}
          gpuRenderingEnabled={gpuRenderingEnabled}
          ultraSmoothDragEnabled={ultraSmoothDragEnabled}
          renderBackendDiagnostics={renderBackendDiagnostics}
          onToggleGPURendering={onToggleGPURendering}
          onToggleUltraSmoothDrag={onToggleUltraSmoothDrag}
          maxResidentDocs={maxResidentDocs}
          onMaxResidentDocsChange={onMaxResidentDocsChange}
          notificationSettings={notificationSettings}
          onNotificationSettingsChange={onNotificationSettingsChange}
          colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
          sourceMetadata={documentState?.source ?? null}
          onColorManagementChange={onColorManagementChange}
          lightSourceProfiles={lightSourceProfiles}
          defaultLightSourceId={defaultLightSourceId}
          onDefaultLightSourceChange={onDefaultLightSourceChange}
          defaultLabStyleId={defaultLabStyleId}
          onDefaultLabStyleChange={onDefaultLabStyleChange}
          builtinProfiles={builtinProfiles}
          customPresets={customPresets}
          defaultImportPresetId={defaultImportPresetId}
          onDefaultImportPresetChange={onDefaultImportPresetChange}
          labStyleProfiles={labStyleProfiles}
          onSaveCustomLightSource={onSaveCustomLightSource}
          onDeleteCustomLightSource={onDeleteCustomLightSource}
          exportOptions={documentState?.exportOptions ?? defaultExportOptions}
          onExportOptionsChange={onExportOptionsChange}
          externalEditorPath={externalEditorPath}
          externalEditorName={externalEditorName}
          openInEditorOutputPath={openInEditorOutputPath}
          onChooseExternalEditor={() => { void onChooseExternalEditor(); }}
          onClearExternalEditor={onClearExternalEditor}
          onChooseOpenInEditorOutputPath={() => { void onChooseOpenInEditorOutputPath(); }}
          onUseDownloadsForOpenInEditor={onUseDownloadsForOpenInEditor}
          defaultExportPath={defaultExportPath}
          onChooseDefaultExportPath={() => { void onChooseDefaultExportPath(); }}
          onUseDownloadsForExport={onUseDownloadsForExport}
          batchOutputPath={batchOutputPath}
          onChooseBatchOutputPath={() => { void onChooseBatchOutputPath(); }}
          onUseDownloadsForBatch={onUseDownloadsForBatch}
          contactSheetOutputPath={contactSheetOutputPath}
          onChooseContactSheetOutputPath={() => { void onChooseContactSheetOutputPath(); }}
          onUseDownloadsForContactSheet={onUseDownloadsForContactSheet}
          customPresetCount={customPresetCount}
          presetFolderCount={presetFolderCount}
          onExportPresetBackup={() => onExportPresetBackup()}
          onImportPresetBackup={(file) => onImportPresetBackup(file)}
          updateChannel={updateChannel}
          lastUpdateCheckAt={updateLastCheckedAt}
          updateError={updateError}
          isCheckingForUpdates={isCheckingForUpdates}
          updaterEnabled={updaterEnabled}
          updaterDisabledReason={updaterDisabledReason}
          onUpdateChannelChange={onUpdateChannelChange}
          onCheckForUpdates={onCheckForUpdates}
        />
      </ErrorBoundary>
      <ErrorBoundary>
        <BatchModal
          isOpen={showBatchModal}
          onClose={() => {
            setBatchSelectionIds(null);
            onSetShowBatchModal(false);
          }}
          onOpenContactSheet={(payload) => {
            flushSync(() => onSetShowBatchModal(false));
            onOpenContactSheet(payload);
          }}
          workerClient={workerClient}
          currentSettings={documentState?.settings ?? null}
          currentProfile={documentState ? activeProfile : null}
          currentLabStyle={documentState ? activeLabStyle : null}
          currentColorManagement={documentState?.colorManagement ?? null}
          currentLightSourceBias={documentState ? (lightSourceProfilesById.get(documentState.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1]) : null}
          lightSourceProfiles={lightSourceProfiles}
          notificationSettings={notificationSettings}
          customProfiles={customPresets}
          openTabs={batchSelectionIds ? tabs.filter((tab) => batchSelectionIds.includes(tab.id)) : tabs}
          defaultOutputPath={batchOutputPath}
        />
      </ErrorBoundary>
      <ErrorBoundary>
        <ContactSheetModal
          isOpen={showContactSheetModal}
          onClose={() => onSetShowContactSheetModal(false)}
          entries={contactSheetEntries}
          sharedSettings={contactSheetSharedSettings}
          sharedProfile={contactSheetSharedProfile}
          sharedLabStyle={contactSheetSharedLabStyle}
          sharedColorManagement={contactSheetSharedColorManagement}
          sharedLightSourceBias={contactSheetSharedLightSourceBias}
          notificationSettings={notificationSettings}
          workerClient={workerClient}
          defaultOutputPath={contactSheetOutputPath}
        />
      </ErrorBoundary>
      <ToastHost />
    </div>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-zinc-900 py-2 text-xs text-zinc-400">
      <span>{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((key) => <kbd key={key} className="min-w-6 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-center font-mono text-[10px] text-zinc-300 shadow-sm">{key}</kbd>)}
      </span>
    </div>
  );
}

function HeaderMenuButton({
  icon,
  label,
  shortcut,
  onClick,
  close,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  close: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onClick();
        close();
      }}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
        tone === 'danger'
          ? 'text-zinc-400 hover:bg-red-950/50 hover:text-red-300'
          : 'text-zinc-300 hover:bg-zinc-900 hover:text-white'
      }`}
    >
      <span className={tone === 'danger' ? 'text-red-500/70' : 'text-zinc-500'}>{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <kbd className="font-mono text-[9px] text-zinc-600">{shortcut}</kbd>}
    </button>
  );
}
