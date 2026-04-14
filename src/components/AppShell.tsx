import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Building2,
  Crop,
  Download,
  ExternalLink,
  FileWarning,
  Grid3x3,
  Image as ImageIcon,
  Loader2,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Redo2,
  RotateCcw,
  SplitSquareVertical,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
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
import { RecentFilesList } from './RecentFilesList';
import { ErrorBoundary } from './ErrorBoundary';
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

type AppShellProps = {
  usesNativeFileDialogs: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  displayCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
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
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'dust' | 'export';
  dustBrushActive: boolean;
  selectedDustMarkId: string | null;
  isDetectingDust: boolean;
  cropTab: CropTab;
  comparisonMode: 'processed' | 'original';
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
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
  defaultColorNegativeInversion: 'standard' | 'advanced-hd';
  renderBackendDiagnostics: RenderBackendDiagnostics;
  defaultLightSourceId: string;
  defaultLabStyleId: string;
  onDefaultLabStyleChange: (labStyleId: string) => void;
  flatFieldProfileNames: string[];
  activeFlatFieldProfileName: string | null;
  activeFlatFieldLoaded: boolean;
  activeFlatFieldPreview: { data: Float32Array; size: number } | null;
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
  onSetSuggestionNotice: React.Dispatch<React.SetStateAction<SuggestionNoticeState | null>>;
  onSetTransientNotice: React.Dispatch<React.SetStateAction<TransientNoticeState | null>>;
  onSetError: React.Dispatch<React.SetStateAction<string | null>>;
  onOpenImage: () => Promise<void>;
  onCloseImage: (requestedTabId?: string | null) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;
  onReset: () => void;
  onOpenInEditor: () => void;
  onDownload: () => void;
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
  onExportClick: () => void;
  onQuickExport: (preset: QuickExportPreset) => void;
  onSaveQuickExportPreset: () => void;
  onDeleteQuickExportPreset: (presetId: string) => void;
  onOpenBatchExport: () => void;
  onSidebarScrollTopChange: (scrollTop: number) => void;
  onSidebarTabChange: (tab: 'adjust' | 'curves' | 'crop' | 'dust' | 'export') => void;
  onCropTabChange: (tab: CropTab) => void;
  onRedetectFrame: () => void;
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
  onProfileChange: (profile: FilmProfile) => void;
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
  onDefaultColorNegativeInversionChange: (value: 'standard' | 'advanced-hd') => void;
  onDefaultLightSourceChange: (lightSourceId: string) => void;
  onSelectFlatFieldProfile: (name: string | null) => Promise<void>;
  onImportFlatFieldReference: (file: File) => Promise<string>;
  onDeleteFlatFieldProfile: (name: string) => Promise<void>;
  onRenameFlatFieldProfile: (currentName: string, nextName: string) => Promise<string>;
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
  isRightPaneOpen,
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
  defaultColorNegativeInversion,
  renderBackendDiagnostics,
  defaultLightSourceId,
  defaultLabStyleId,
  onDefaultLabStyleChange,
  flatFieldProfileNames,
  activeFlatFieldProfileName,
  activeFlatFieldLoaded,
  activeFlatFieldPreview,
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
  onSetSuggestionNotice,
  onSetTransientNotice,
  onSetError,
  onOpenImage,
  onCloseImage,
  onUndo,
  onRedo,
  onToggleLeftPane,
  onToggleRightPane,
  onReset,
  onOpenInEditor,
  onDownload,
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
  onExportClick,
  onQuickExport,
  onSaveQuickExportPreset,
  onDeleteQuickExportPreset,
  onOpenBatchExport,
  onSidebarScrollTopChange,
  onSidebarTabChange,
  onCropTabChange,
  onRedetectFrame,
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
  onProfileChange,
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
  onDefaultColorNegativeInversionChange,
  onDefaultLightSourceChange,
  onSelectFlatFieldProfile,
  onImportFlatFieldReference,
  onDeleteFlatFieldProfile,
  onRenameFlatFieldProfile,
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
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
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
      onHandleZoomWheel(event.deltaY, normX, normY);
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, [documentState, onHandleZoomWheel]);

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

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      {usesNativeFileDialogs && (
        <div
          data-tauri-drag-region=""
          onMouseDownCapture={onTitleBarMouseDown}
          className="absolute inset-x-0 top-0 z-30 h-8 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl"
        />
      )}

      <div className={`flex min-h-0 w-full flex-1 ${usesNativeFileDialogs ? 'pt-8' : ''}`}>
        <AnimatePresence initial={false}>
          {isLeftPaneOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="h-full shrink-0 overflow-hidden border-r border-zinc-800"
            >
              <ErrorBoundary>
                <Sidebar
                  settings={documentState?.settings ?? fallbackProfile.defaultSettings}
                  exportOptions={documentState?.exportOptions ?? defaultExportOptions}
                  quickExportPresets={quickExportPresets}
                  colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
                  sourceMetadata={documentState?.source ?? null}
                  cropImageWidth={cropImageSize.width}
                  cropImageHeight={cropImageSize.height}
                  onLevelInteractionChange={onLevelInteractionChange}
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
                  hasActiveFlatFieldProfile={activeFlatFieldLoaded}
                  histogramData={documentState?.histogram ?? null}
                  isPickingFilmBase={isPickingFilmBase}
                  onTogglePicker={onToggleFilmBasePicker}
                  onExport={onExportClick}
                  onQuickExport={onQuickExport}
                  onSaveQuickExportPreset={onSaveQuickExportPreset}
                  onDeleteQuickExportPreset={onDeleteQuickExportPreset}
                  onOpenBatchExport={onOpenBatchExport}
                  isExporting={isExporting}
                  contentScrollTop={activeTab?.sidebarScrollTop ?? 0}
                  onContentScrollTopChange={onSidebarScrollTopChange}
                  activeTab={sidebarTab}
                  onTabChange={onSidebarTabChange}
                  cropTab={cropTab}
                  onCropTabChange={onCropTabChange}
                  onRedetectFrame={onRedetectFrame}
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
                />
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-zinc-900/30">
          <header className="z-20 flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-4 backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <button
                onClick={onToggleLeftPane}
                aria-label={isLeftPaneOpen ? 'Hide adjustments panel' : 'Show adjustments panel'}
                className="rounded-md p-1.5 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-200"
                data-tip="Toggle Adjustments"
              >
                {isLeftPaneOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
              </button>
              <h1 className="ml-2 text-sm font-bold tracking-tight text-zinc-100">
                Dark<span className="font-medium text-zinc-500">Slide</span>{' '}
                <span className="ml-1 text-[10px] font-normal uppercase tracking-widest text-zinc-700">beta</span>
              </h1>
            </div>

            <div className="flex items-center gap-3">
              {documentState && (
                <>
                  <div className="mr-2 flex items-center gap-1">
                    <button
                      onClick={onUndo}
                      disabled={!canUndo}
                      aria-label="Undo"
                      className={`rounded-lg p-2 transition-all ${
                        canUndo ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'cursor-not-allowed text-zinc-700'
                      }`}
                      data-tip="Undo (Cmd+Z)"
                    >
                      <Undo2 size={18} />
                    </button>
                    <button
                      onClick={onRedo}
                      disabled={!canRedo}
                      aria-label="Redo"
                      className={`rounded-lg p-2 transition-all ${
                        canRedo ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'cursor-not-allowed text-zinc-700'
                      }`}
                      data-tip="Redo (Cmd+Shift+Z)"
                    >
                      <Redo2 size={18} />
                    </button>
                  </div>
                  <div className="mx-1 h-4 w-px bg-zinc-800" />
                  <button
                    onClick={onReset}
                    aria-label="Reset adjustments to current preset"
                    className="rounded-lg p-2 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-200"
                    data-tip="Reset Adjustments to Current Preset"
                  >
                    <RotateCcw size={18} />
                  </button>
                  <button
                    onClick={() => onSetComparisonMode((current) => current === 'processed' ? 'original' : 'processed')}
                    aria-label={comparisonMode === 'original' ? 'Return to processed view' : 'Toggle before and after'}
                    className={`rounded-lg p-2 transition-all ${comparisonMode === 'original' ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}`}
                    data-tip={comparisonMode === 'original' ? 'Showing Original — click to return' : 'Toggle Before/After'}
                  >
                    <SplitSquareVertical size={18} />
                  </button>
                  <button
                    onClick={() => onSetIsCropOverlayVisible((current) => !current)}
                    aria-label={isCropOverlayVisible ? 'Hide crop overlay' : 'Show crop overlay'}
                    className={`rounded-lg p-2 transition-all ${isCropOverlayVisible ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}`}
                    data-tip="Toggle Crop Overlay"
                  >
                    <Crop size={18} />
                  </button>
                  {usesNativeFileDialogs && (
                    <button
                      onClick={onOpenInEditor}
                      disabled={Boolean(isExporting)}
                      aria-label="Open in external editor"
                      className="rounded-lg p-2 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                      data-tip="Open in External Editor"
                    >
                      <ExternalLink size={18} />
                    </button>
                  )}
                  <div className="mx-1 h-4 w-px bg-zinc-800" />
                  <button
                    onClick={onDownload}
                    disabled={Boolean(isExporting)}
                    className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 shadow-lg shadow-black/20 transition-all hover:bg-white disabled:opacity-50"
                  >
                    {isExporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    {isExporting ? 'Exporting...' : 'Export'}
                  </button>
                </>
              )}
              <button
                onClick={() => void onOpenImage()}
                className="flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 transition-all hover:bg-zinc-700"
              >
                <Upload size={16} /> Import
              </button>
              {!usesNativeFileDialogs && (
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(event) => { void onFileChange(event); }}
                  accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                  className="hidden"
                />
              )}
              <div className="mx-1 h-4 w-px bg-zinc-800" />
              <button
                onClick={onToggleRightPane}
                aria-label={isRightPaneOpen ? 'Hide presets panel' : 'Show presets panel'}
                className="rounded-md p-1.5 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-200"
                data-tip="Toggle Profiles"
              >
                {isRightPaneOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
              </button>
            </div>
          </header>

          {tabs.length > 0 && (
            <ErrorBoundary>
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                getRollById={getRollById}
                onSelectTab={onSelectTab}
                onCloseTab={(tabId) => void onCloseImage(tabId)}
                onCreateTab={() => void onOpenImage()}
                onReorderTabs={onReorderTabs}
                onSyncRollSettings={onSyncRollSettings}
                onApplyRollFilmBase={onApplyRollFilmBase}
                onRemoveFromRoll={onRemoveFromRoll}
                onOpenRollInfo={onOpenRollInfo}
              />
            </ErrorBoundary>
          )}

          <ErrorBoundary>
            <div
              ref={viewportRef}
              className={`relative flex flex-1 items-center justify-center overflow-hidden p-8 ${isDragActive ? 'bg-zinc-900/60' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                onSetIsDragActive(true);
              }}
              onDragLeave={() => onSetIsDragActive(false)}
              onDrop={(event) => { void onDropFile(event); }}
            >
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
                    className="relative flex h-full w-full flex-col items-center justify-center gap-2"
                  >
                    <div
                      ref={previewContainerRef}
                      className="relative w-full flex-1 overflow-hidden border border-zinc-800 bg-black"
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
                      <div className="absolute right-4 top-4 z-20">
                        <ZoomBar
                          zoom={zoom}
                          fitScale={fitScale}
                          onZoomToFit={zoomToFit}
                          onZoomTo100={zoomTo100}
                          onZoomIn={zoomIn}
                          onZoomOut={zoomOut}
                          onSetZoom={setZoomLevel}
                        />
                      </div>

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
                              onInteractionStart={onCropInteractionStart}
                              onInteractionEnd={onCropInteractionEnd}
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

<div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 shadow-2xl backdrop-blur-md">
                        <span className="px-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500">{activeProfile.name}</span>
                        <div className="mx-1 h-4 w-px bg-zinc-800" />
                        <span className="px-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                          {documentState.source.width.toLocaleString()} × {documentState.source.height.toLocaleString()} px
                        </span>
                      </div>
                      {documentState.settings.flatFieldEnabled && activeFlatFieldLoaded && (
                        <div className="flex items-center gap-2 rounded-2xl border border-emerald-900/60 bg-emerald-950/35 px-3 py-2 shadow-2xl backdrop-blur-md">
                          <Grid3x3 size={14} className="text-emerald-300" />
                          <span className="text-[10px] font-mono uppercase tracking-widest text-emerald-200">
                            {activeFlatFieldProfileName ? `Flat-field · ${activeFlatFieldProfileName}` : 'Flat-field active'}
                          </span>
                        </div>
                      )}
                      {activeLabStyle && (
                        <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 shadow-2xl backdrop-blur-md">
                          <Building2 size={14} className="text-zinc-500" />
                          <span className="px-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                            {activeLabStyle.name}
                          </span>
                        </div>
                      )}
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-3">
                        <AnimatePresence initial={false}>
                          {isRenderIndicatorVisible && (
                            <motion.div
                              key="render-indicator"
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: 4 }}
                              transition={{ duration: 0.14, ease: 'easeOut' }}
                              className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 shadow-xl backdrop-blur-md"
                            >
                              Rendering...
                            </motion.div>
                          )}
                        </AnimatePresence>
                        <button
                          onClick={() => void onCloseImage()}
                          aria-label="Close image"
                          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-zinc-400 shadow-xl transition-all hover:bg-red-500/20 hover:text-red-400 backdrop-blur-md"
                          data-tip="Close Image"
                        >
                          <X size={16} />
                          <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Close</span>
                        </button>
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

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute bottom-8 right-8 z-50 flex max-w-md items-center gap-3 rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-200 shadow-2xl backdrop-blur-xl"
                >
                  <FileWarning size={18} className="shrink-0 text-red-400" />
                  <span>{error}</span>
                  <button onClick={() => onSetError(null)} className="ml-2 opacity-50 hover:opacity-100">✕</button>
                </motion.div>
              )}

              {suggestionNotice && (
                <motion.div
                  initial={{ opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
                  className="absolute bottom-20 right-8 z-50 flex max-w-md items-center gap-3 rounded-2xl border border-zinc-700/70 bg-zinc-900/90 px-4 py-3 text-sm text-zinc-200 shadow-2xl shadow-black/50 backdrop-blur-xl"
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

              {transientNotice && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className={`absolute bottom-28 right-8 z-50 flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-2xl backdrop-blur-xl ${
                    transientNotice.tone === 'success'
                      ? 'border border-emerald-800/60 bg-emerald-950/55 text-emerald-100'
                      : 'border border-amber-800/60 bg-amber-950/55 text-amber-100'
                  }`}
                >
                  <FileWarning size={18} className={`shrink-0 ${transientNotice.tone === 'success' ? 'text-emerald-300' : 'text-amber-300'}`} />
                  <span>{transientNotice.message}</span>
                  <button onClick={() => onSetTransientNotice(null)} className="ml-2 opacity-50 hover:opacity-100">✕</button>
                </motion.div>
              )}
            </div>
          </ErrorBoundary>
        </main>

        <AnimatePresence initial={false}>
          {isRightPaneOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="h-full shrink-0 overflow-hidden border-l border-zinc-800"
            >
              <ErrorBoundary>
                <PresetsPane
                  activeStockId={documentState?.profileId ?? fallbackProfile.id}
                  onStockChange={onProfileChange}
                  builtinProfiles={builtinProfiles}
                  customPresets={customPresets}
                  presetFolders={presetFolders}
                  canSavePreset={Boolean(documentState)}
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
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>

        {showMagnifier && (
          <MagnifierLoupe
            sourceCanvas={displayCanvasRef.current}
            containerRef={viewportRef}
            magnification={6}
            size={120}
          />
        )}
      </div>

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
          defaultColorNegativeInversion={defaultColorNegativeInversion}
          onDefaultColorNegativeInversionChange={onDefaultColorNegativeInversionChange}
          colorManagement={documentState?.colorManagement ?? DEFAULT_COLOR_MANAGEMENT}
          sourceMetadata={documentState?.source ?? null}
          onColorManagementChange={onColorManagementChange}
          lightSourceProfiles={lightSourceProfiles}
          defaultLightSourceId={defaultLightSourceId}
          onDefaultLightSourceChange={onDefaultLightSourceChange}
          defaultLabStyleId={defaultLabStyleId}
          onDefaultLabStyleChange={onDefaultLabStyleChange}
          labStyleProfiles={labStyleProfiles}
          onSaveCustomLightSource={onSaveCustomLightSource}
          onDeleteCustomLightSource={onDeleteCustomLightSource}
          flatFieldProfileNames={flatFieldProfileNames}
          activeFlatFieldProfileName={activeFlatFieldProfileName}
          activeFlatFieldLoaded={activeFlatFieldLoaded}
          activeFlatFieldPreview={activeFlatFieldPreview}
          onSelectFlatFieldProfile={onSelectFlatFieldProfile}
          onImportFlatFieldReference={onImportFlatFieldReference}
          onDeleteFlatFieldProfile={onDeleteFlatFieldProfile}
          onRenameFlatFieldProfile={onRenameFlatFieldProfile}
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
          onClose={() => onSetShowBatchModal(false)}
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
          openTabs={tabs}
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
    </div>
  );
}
