import { useCallback, useMemo, useRef, useState } from 'react';
import { ConversionSettings, DocumentHistoryEntry, DocumentTab, WorkspaceDocument } from '../types';
import { ZoomLevel } from './useViewportZoom';

const HISTORY_LIMIT = 50;

function historyEntryEqual(a: DocumentHistoryEntry | undefined, b: DocumentHistoryEntry) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function createHistoryEntry(document: Pick<WorkspaceDocument, 'settings' | 'labStyleId'>): DocumentHistoryEntry {
  return {
    settings: structuredClone(document.settings),
    labStyleId: document.labStyleId,
  };
}

function createDocumentTab(document: WorkspaceDocument): DocumentTab {
  return {
    id: document.id,
    document,
    historyStack: [createHistoryEntry(document)],
    historyIndex: 0,
    zoom: 'fit',
    pan: { x: 0.5, y: 0.5 },
    sidebarScrollTop: 0,
  };
}

export function useDocumentTabs() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<DocumentTab[]>([]);
  tabsRef.current = tabs;

  const interactionSnapshotRef = useRef<DocumentHistoryEntry | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );

  const activeDocument = activeTab?.document ?? null;
  const canUndo = (activeTab?.historyIndex ?? 0) > 0;
  const canRedo = activeTab ? activeTab.historyIndex < activeTab.historyStack.length - 1 : false;

  const updateTabById = useCallback((tabId: string, updater: (tab: DocumentTab) => DocumentTab) => {
    setTabs((previous) => previous.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
  }, []);

  const setDocumentState = useCallback((
    nextState: WorkspaceDocument | null | ((current: WorkspaceDocument | null) => WorkspaceDocument | null),
  ) => {
    if (!activeTabId) {
      return;
    }

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId) {
        return tab;
      }

      const resolved = typeof nextState === 'function'
        ? nextState(tab.document)
        : nextState;

      return resolved ? { ...tab, document: resolved } : tab;
    }));
  }, [activeTabId]);

  const updateActiveDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument) => {
    if (!activeTabId) {
      return;
    }

    setTabs((previous) => previous.map((tab) => (
      tab.id === activeTabId
        ? { ...tab, document: updater(tab.document) }
        : tab
    )));
  }, [activeTabId]);

  const pushHistoryEntry = useCallback((nextState: DocumentHistoryEntry) => {
    if (!activeTabId) {
      return;
    }

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId) {
        return tab;
      }

      const baseHistory = tab.historyStack.slice(0, tab.historyIndex + 1);
      const lastEntry = baseHistory[baseHistory.length - 1];
      if (historyEntryEqual(lastEntry, nextState)) {
        return tab;
      }

      const nextHistory = [...baseHistory, structuredClone(nextState)].slice(-HISTORY_LIMIT);
      return {
        ...tab,
        historyStack: nextHistory,
        historyIndex: nextHistory.length - 1,
      };
    }));
  }, [activeTabId]);

  const resetHistory = useCallback((nextState: DocumentHistoryEntry) => {
    if (!activeTabId) {
      return;
    }

    interactionSnapshotRef.current = null;
    updateTabById(activeTabId, (tab) => ({
      ...tab,
      historyStack: [structuredClone(nextState)],
      historyIndex: 0,
    }));
  }, [activeTabId, updateTabById]);

  const beginInteraction = useCallback(() => {
    if (activeDocument) {
      interactionSnapshotRef.current = createHistoryEntry(activeDocument);
    }
  }, [activeDocument]);

  const commitInteraction = useCallback((currentState: DocumentHistoryEntry) => {
    const snapshot = interactionSnapshotRef.current;
    interactionSnapshotRef.current = null;
    if (!snapshot) {
      return;
    }
    if (historyEntryEqual(snapshot, currentState)) {
      return;
    }
    pushHistoryEntry(currentState);
  }, [pushHistoryEntry]);

  const openDocument = useCallback((document: WorkspaceDocument, options?: { activate?: boolean }) => {
    setTabs((previous) => [...previous, createDocumentTab(document)]);
    if (options?.activate ?? true) {
      setActiveTabId(document.id);
    }
  }, []);

  const replaceDocument = useCallback((documentId: string, nextDocument: WorkspaceDocument) => {
    updateTabById(documentId, (tab) => ({
      ...tab,
      document: nextDocument,
      historyStack: [createHistoryEntry(nextDocument)],
      historyIndex: 0,
    }));
  }, [updateTabById]);

  const reorderTabs = useCallback((sourceId: string, targetId: string) => {
    setTabs((previous) => {
      const sourceIndex = previous.findIndex((tab) => tab.id === sourceId);
      const targetIndex = previous.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return previous;
      }

      const next = [...previous];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const removeDocument = useCallback((documentId: string) => {
    const currentTabs = tabsRef.current;
    const tabIndex = currentTabs.findIndex((tab) => tab.id === documentId);
    if (tabIndex < 0) {
      return {
        removedTab: null,
        remainingTabs: currentTabs,
        nextActiveTabId: activeTabId,
      };
    }

    const removedTab = currentTabs[tabIndex];
    const remainingTabs = currentTabs.filter((tab) => tab.id !== documentId);
    const nextActiveTab = activeTabId === documentId
      ? (remainingTabs[tabIndex] ?? remainingTabs[tabIndex - 1] ?? null)
      : remainingTabs.find((tab) => tab.id === activeTabId) ?? null;

    setTabs(remainingTabs);
    setActiveTabId(nextActiveTab?.id ?? null);

    return {
      removedTab,
      remainingTabs,
      nextActiveTabId: nextActiveTab?.id ?? null,
    };
  }, [activeTabId]);

  const evictOldestCleanTab = useCallback((maxTabs: number) => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length < maxTabs) {
      return null;
    }

    const evictedTab = currentTabs.find((tab) => !tab.document.dirty) ?? null;
    if (!evictedTab) {
      return 'all-dirty' as const;
    }

    removeDocument(evictedTab.id);
    return evictedTab;
  }, [removeDocument]);

  const setActiveViewport = useCallback((zoom: ZoomLevel, pan: { x: number; y: number }) => {
    if (!activeTabId) {
      return;
    }

    updateTabById(activeTabId, (tab) => (
      tab.zoom === zoom && tab.pan.x === pan.x && tab.pan.y === pan.y
        ? tab
        : { ...tab, zoom, pan }
    ));
  }, [activeTabId, updateTabById]);

  const setActiveSidebarScrollTop = useCallback((scrollTop: number) => {
    if (!activeTabId) {
      return;
    }

    updateTabById(activeTabId, (tab) => (
      Math.abs(tab.sidebarScrollTop - scrollTop) < 1
        ? tab
        : { ...tab, sidebarScrollTop: scrollTop }
    ));
  }, [activeTabId, updateTabById]);

  const undo = useCallback(() => {
    if (!activeTabId) return;

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId || tab.historyIndex <= 0) {
        return tab;
      }

      const nextIndex = tab.historyIndex - 1;
      const previousState = structuredClone(tab.historyStack[nextIndex] ?? null);
      return {
        ...tab,
        historyIndex: nextIndex,
        document: previousState ? {
          ...tab.document,
          settings: previousState.settings,
          labStyleId: previousState.labStyleId,
          dirty: true,
        } : tab.document,
      };
    }));
  }, [activeTabId]);

  const redo = useCallback(() => {
    if (!activeTabId) return;

    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== activeTabId || tab.historyIndex >= tab.historyStack.length - 1) {
        return tab;
      }

      const nextIndex = tab.historyIndex + 1;
      const nextState = structuredClone(tab.historyStack[nextIndex] ?? null);
      return {
        ...tab,
        historyIndex: nextIndex,
        document: nextState ? {
          ...tab.document,
          settings: nextState.settings,
          labStyleId: nextState.labStyleId,
          dirty: true,
        } : tab.document,
      };
    }));
  }, [activeTabId]);

  return {
    tabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTab,
    activeDocument,
    canUndo,
    canRedo,
    openDocument,
    replaceDocument,
    removeDocument,
    reorderTabs,
    updateTabById,
    setDocumentState,
    updateActiveDocument,
    pushHistoryEntry,
    resetHistory,
    beginInteraction,
    commitInteraction,
    evictOldestCleanTab,
    setActiveViewport,
    setActiveSidebarScrollTop,
    undo,
    redo,
  };
}
