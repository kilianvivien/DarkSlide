import { Dispatch, SetStateAction, useEffect } from 'react';
import { DocumentTab, EditorTool, QuickExportPreset } from '../types';
import { openImageFileByPath } from '../utils/fileBridge';
import { clearRecentFiles } from '../utils/recentFilesStore';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

type UseAppShortcutsOptions = {
  tabs: DocumentTab[];
  activeTabId: string | null;
  setActiveTabId: (value: string | null) => void;
  documentStatePresent: boolean;
  isCropOverlayVisible: boolean;
  dustBrushActive: boolean;
  usesNativeFileDialogs: boolean;
  setShowSettingsModal: Dispatch<SetStateAction<boolean>>;
  setIsSpaceHeld: Dispatch<SetStateAction<boolean>>;
  onUndo: () => void;
  onRedo: () => void;
  onOpenImage: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onOpenConvertFiles: () => void;
  onOpenRecentFile: (file: File, path: string, size?: number) => Promise<string | null>;
  onOpenFilesByPath: (paths: string[]) => Promise<void>;
  onOpenInEditor: () => Promise<void>;
  onCloseImage: () => Promise<void>;
  onDownload: () => Promise<void>;
  quickExportPresets: QuickExportPreset[];
  onQuickExport: (preset: QuickExportPreset) => Promise<void>;
  onReset: () => void;
  onCopyDebugInfo: () => Promise<void>;
  onToggleComparison: () => void;
  onAutoAdjust: () => void;
  onToggleCropOverlay: () => void;
  onToggleDustBrush: () => void;
  onDecreaseDustBrushRadius: () => void;
  onIncreaseDustBrushRadius: () => void;
  onRemoveLastDustMark: () => void;
  onDeactivateDustBrush: () => void;
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;
  onToggleFilmstrip: () => void;
  onSelectTool: (tool: EditorTool) => void;
  hasFrameSelection: boolean;
  onClearFrameSelection: () => void;
  onCheckForUpdates: () => void;
  zoomToFit: () => void;
  zoomTo100: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
};

export function useAppShortcuts({
  tabs,
  activeTabId,
  setActiveTabId,
  documentStatePresent,
  isCropOverlayVisible,
  dustBrushActive,
  usesNativeFileDialogs,
  setShowSettingsModal,
  setIsSpaceHeld,
  onUndo,
  onRedo,
  onOpenImage,
  onOpenFolder,
  onOpenConvertFiles,
  onOpenRecentFile,
  onOpenFilesByPath,
  onOpenInEditor,
  onCloseImage,
  onDownload,
  quickExportPresets,
  onQuickExport,
  onReset,
  onCopyDebugInfo,
  onToggleComparison,
  onAutoAdjust,
  onToggleCropOverlay,
  onToggleDustBrush,
  onDecreaseDustBrushRadius,
  onIncreaseDustBrushRadius,
  onRemoveLastDustMark,
  onDeactivateDustBrush,
  onToggleLeftPane,
  onToggleRightPane,
  onToggleFilmstrip,
  onSelectTool,
  hasFrameSelection,
  onClearFrameSelection,
  onCheckForUpdates,
  zoomToFit,
  zoomTo100,
  zoomIn,
  zoomOut,
}: UseAppShortcutsOptions) {
  useKeyboardShortcuts({
    shortcuts: {
      undo: { key: 'z', meta: true, handler: onUndo },
      redo: { key: 'z', meta: true, shift: true, handler: onRedo },
      open: { key: 'o', meta: true, handler: () => { void onOpenImage(); } },
      openInEditor: { key: 'o', meta: true, shift: true, when: () => documentStatePresent, handler: () => { void onOpenInEditor(); } },
      close: { key: 'w', meta: true, when: () => documentStatePresent, handler: () => { void onCloseImage(); } },
      zoomFit: { key: '0', meta: true, handler: zoomToFit },
      zoom100: { key: '1', meta: true, handler: zoomTo100 },
      zoomInEquals: { key: '=', meta: true, handler: zoomIn },
      zoomInPlus: { key: '+', meta: true, handler: zoomIn },
      zoomOut: { key: '-', meta: true, handler: zoomOut },
      export: { key: 'e', meta: true, when: () => documentStatePresent, handler: () => { void onDownload(); } },
      quickExport1: { key: '1', meta: true, shift: true, when: () => Boolean(documentStatePresent && quickExportPresets[0]), handler: () => { void onQuickExport(quickExportPresets[0]!); } },
      quickExport2: { key: '2', meta: true, shift: true, when: () => Boolean(documentStatePresent && quickExportPresets[1]), handler: () => { void onQuickExport(quickExportPresets[1]!); } },
      quickExport3: { key: '3', meta: true, shift: true, when: () => Boolean(documentStatePresent && quickExportPresets[2]), handler: () => { void onQuickExport(quickExportPresets[2]!); } },
      quickExport4: { key: '4', meta: true, shift: true, when: () => Boolean(documentStatePresent && quickExportPresets[3]), handler: () => { void onQuickExport(quickExportPresets[3]!); } },
      autoAdjust: { key: 'a', meta: true, shift: true, when: () => documentStatePresent, handler: onAutoAdjust },
      toggleDustBrush: { key: 'd', when: () => documentStatePresent && !isCropOverlayVisible, handler: onToggleDustBrush },
      decreaseDustBrush: { key: '[', when: () => dustBrushActive, handler: onDecreaseDustBrushRadius },
      increaseDustBrush: { key: ']', when: () => dustBrushActive, handler: onIncreaseDustBrushRadius },
      removeLastDustMark: { key: 'backspace', when: () => dustBrushActive, handler: onRemoveLastDustMark },
      deactivateDustBrush: { key: 'escape', when: () => dustBrushActive, handler: onDeactivateDustBrush },
      clearFrameSelection: { key: 'escape', when: () => !dustBrushActive && hasFrameSelection, handler: onClearFrameSelection },
      // Multi-frame export lives in the Export panel; Convert Files opens from there.
      exportFrames: { key: 'e', meta: true, shift: true, handler: () => onSelectTool('export') },
previousTab: {
        key: '[',
        meta: true,
        shift: true,
        when: () => tabs.length > 1,
        handler: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          const nextIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
          setActiveTabId(tabs[nextIndex]?.id ?? activeTabId);
        },
      },
      nextTab: {
        key: ']',
        meta: true,
        shift: true,
        when: () => tabs.length > 1,
        handler: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          const nextIndex = currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
          setActiveTabId(tabs[nextIndex]?.id ?? activeTabId);
        },
      },
      settings: { key: ',', meta: true, handler: () => setShowSettingsModal((current) => !current) },
      toolDevelop: { key: '1', handler: () => onSelectTool('adjust') },
      toolCurves: { key: '2', handler: () => onSelectTool('curves') },
      toolProfiles: { key: '3', handler: () => onSelectTool('profiles') },
      toggleProfiles: { key: 'p', handler: onToggleRightPane },
      toggleFilmstrip: { key: 'f', when: () => tabs.length > 0, handler: onToggleFilmstrip },
      toolCrop: { key: '4', when: () => documentStatePresent, handler: () => onSelectTool('crop') },
      toolDust: { key: '5', when: () => documentStatePresent, handler: () => onSelectTool('dust') },
      toolExport: { key: '6', handler: () => onSelectTool('export') },
      toolContactSheet: { key: '7', when: () => documentStatePresent, handler: () => onSelectTool('contact') },
      toggleCropOverlay: { key: 'c', when: () => documentStatePresent && !dustBrushActive, handler: onToggleCropOverlay },
      toggleComparison: { key: '\\', when: () => documentStatePresent, handler: onToggleComparison },
      previousFrame: {
        key: 'arrowleft',
        when: () => tabs.length > 1 && !isCropOverlayVisible,
        handler: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          if (currentIndex > 0) setActiveTabId(tabs[currentIndex - 1].id);
        },
      },
      nextFrame: {
        key: 'arrowright',
        when: () => tabs.length > 1 && !isCropOverlayVisible,
        handler: () => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          if (currentIndex >= 0 && currentIndex < tabs.length - 1) setActiveTabId(tabs[currentIndex + 1].id);
        },
      },
      holdPan: { key: ' ', handler: () => setIsSpaceHeld(true), when: () => !documentStatePresent || !isCropOverlayVisible },
    },
    onMenuAction: (action) => {
      switch (action) {
        case 'open':
          void onOpenImage();
          break;
        case 'open-folder':
          void onOpenFolder();
          break;
        case 'export':
          void onDownload();
          break;
        case 'open-in-editor':
          void onOpenInEditor();
          break;
        case 'batch-export':
          onSelectTool('export');
          break;
        case 'convert-files':
          onOpenConvertFiles();
          break;
        case 'close-image':
          void onCloseImage();
          break;
        case 'reset-adjustments':
          onReset();
          break;
        case 'copy-debug-info':
          void onCopyDebugInfo();
          break;
        case 'toggle-comparison':
          onToggleComparison();
          break;
        case 'toggle-crop-overlay':
          onToggleCropOverlay();
          break;
        case 'toggle-adjustments-pane':
          onToggleLeftPane();
          break;
        case 'toggle-profiles-pane':
          onToggleRightPane();
          break;
        case 'zoom-fit':
          zoomToFit();
          break;
        case 'zoom-100':
          zoomTo100();
          break;
        case 'zoom-in':
          zoomIn();
          break;
        case 'zoom-out':
          zoomOut();
          break;
        case 'show-settings':
          setShowSettingsModal(true);
          break;
case 'check-for-updates':
          onCheckForUpdates();
          break;
        case 'clear-recent-files':
          clearRecentFiles();
          break;
      }
    },
    onMenuOpenRecent: (path) => {
      void (async () => {
        try {
          const result = await openImageFileByPath(path);
          if (result) {
            await onOpenRecentFile(result.file, path, result.size);
          }
        } catch {
          void onOpenImage();
        }
      })();
    },
    onOpenFiles: (paths) => {
      void onOpenFilesByPath(paths);
    },
    enableMenuEvents: usesNativeFileDialogs,
  });

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        setIsSpaceHeld(false);
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [setIsSpaceHeld]);
}
