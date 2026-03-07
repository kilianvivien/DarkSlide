import { useCallback, useRef, useState } from 'react';

const HISTORY_LIMIT = 50;

export function useHistory<T>(initialState: T) {
  const [history, setHistory] = useState<T[]>([initialState]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const isInternalUpdate = useRef(false);
  const interactionSnapshotRef = useRef<T | null>(null);

  const push = useCallback((newState: T) => {
    if (isInternalUpdate.current) return;

    setHistory((prev) => {
      const base = prev.slice(0, currentIndex + 1);
      const last = base[base.length - 1];

      if (JSON.stringify(last) === JSON.stringify(newState)) {
        return prev;
      }

      const next = [...base, structuredClone(newState)].slice(-HISTORY_LIMIT);
      const nextIndex = next.length - 1;
      setCurrentIndex(nextIndex);
      return next;
    });
  }, [currentIndex]);

  const beginInteraction = useCallback(() => {
    const tip = history[currentIndex];
    if (tip !== undefined) {
      interactionSnapshotRef.current = structuredClone(tip);
    }
  }, [history, currentIndex]);

  const commitInteraction = useCallback((currentState: T) => {
    const snapshot = interactionSnapshotRef.current;
    interactionSnapshotRef.current = null;
    if (snapshot === null) return;
    if (JSON.stringify(snapshot) === JSON.stringify(currentState)) return;
    push(currentState);
  }, [push]);

  const undo = useCallback((): T | null => {
    if (currentIndex <= 0) return null;

    isInternalUpdate.current = true;
    const nextIndex = currentIndex - 1;
    setCurrentIndex(nextIndex);
    queueMicrotask(() => {
      isInternalUpdate.current = false;
    });
    return history[nextIndex] ?? null;
  }, [currentIndex, history]);

  const redo = useCallback((): T | null => {
    if (currentIndex >= history.length - 1) return null;

    isInternalUpdate.current = true;
    const nextIndex = currentIndex + 1;
    setCurrentIndex(nextIndex);
    queueMicrotask(() => {
      isInternalUpdate.current = false;
    });
    return history[nextIndex] ?? null;
  }, [currentIndex, history]);

  const reset = useCallback((state: T) => {
    isInternalUpdate.current = false;
    interactionSnapshotRef.current = null;
    setHistory([structuredClone(state)]);
    setCurrentIndex(0);
  }, []);

  return {
    push,
    undo,
    redo,
    reset,
    beginInteraction,
    commitInteraction,
    canUndo: currentIndex > 0,
    canRedo: currentIndex < history.length - 1,
  };
}
