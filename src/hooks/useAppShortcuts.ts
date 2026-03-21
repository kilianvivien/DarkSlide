import { Dispatch, SetStateAction, useEffect } from 'react';
import { DocumentTab } from '../types';
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
  setIsSpaceHeld: Dispatch<SetStateAction<boolean>>;
  onUndo: () => void;
  onRedo: () => void;
  onOpenImage: () => Promise<void>;
  onOpenInEditor: () => Promise<void>;
  onCloseImage: () => Promise<void>;
  onDownload: () => Promise<void>;
  onReset: () => void;
  onCopyDebugInfo: () => Promise<void>;
  onToggleComparison: () => void;
  onToggleCropOverlay: () => void;
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;
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
  setIsSpaceHeld,
  onUndo,
  onRedo,
  onOpenImage,
  onOpenInEditor,
  onCloseImage,
  onDownload,
  onReset,
  onCopyDebugInfo,
  onToggleComparison,
  onToggleCropOverlay,
  onToggleLeftPane,
  onToggleRightPane,
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
      batchExport: { key: 'e', meta: true, shift: true, handler: () => setShowBatchModal(true) },
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
      }
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
