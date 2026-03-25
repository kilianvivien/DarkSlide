import { Dispatch, SetStateAction, useEffect } from 'react';
import { DocumentTab, QuickExportPreset } from '../types';
import { openImageFileByPath } from '../utils/fileBridge';
import { clearRecentFiles } from '../utils/recentFilesStore';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

type UseAppShortcutsOptions = {
  tabs: DocumentTab[];
  activeTabId: string | null;
  setActiveTabId: (value: string | null) => void;
  documentStatePresent: boolean;
  isCropOverlayVisible: boolean;
  usesNativeFileDialogs: boolean;
  setShowBatchModal: Dispatch<SetStateAction<boolean>>;
  setShowSettingsModal: Dispatch<SetStateAction<boolean>>;
  setShowScanningSessionPanel: Dispatch<SetStateAction<boolean>>;
  setIsSpaceHeld: Dispatch<SetStateAction<boolean>>;
  onUndo: () => void;
  onRedo: () => void;
  onOpenImage: () => Promise<void>;
  onOpenRecentFile: (file: File, path: string, size?: number) => Promise<string | null>;
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
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;
onToggleScanningSession: () => void;
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
  usesNativeFileDialogs,
  setShowBatchModal,
  setShowSettingsModal,
  setShowScanningSessionPanel,
  setIsSpaceHeld,
  onUndo,
  onRedo,
  onOpenImage,
  onOpenRecentFile,
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
  onToggleLeftPane,
  onToggleRightPane,
onToggleScanningSession,
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
      batchExport: { key: 'e', meta: true, shift: true, handler: () => setShowBatchModal(true) },
      toggleScanningSession: { key: 'w', meta: true, shift: true, when: () => usesNativeFileDialogs, handler: onToggleScanningSession },
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
      holdPan: { key: ' ', handler: () => setIsSpaceHeld(true), when: () => !documentStatePresent || !isCropOverlayVisible },
    },
    onMenuAction: (action) => {
      switch (action) {
        case 'open':
          void onOpenImage();
          break;
        case 'export':
          void onDownload();
          break;
        case 'open-in-editor':
          void onOpenInEditor();
          break;
        case 'batch-export':
          setShowBatchModal(true);
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
        case 'scan-session-toggle':
          setShowScanningSessionPanel((current) => !current);
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
