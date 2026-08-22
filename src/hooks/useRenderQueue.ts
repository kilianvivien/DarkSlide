import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from './useEvent';

type RenderPriority = 'draft' | 'settled';

type UseRenderQueueOptions<T> = {
  render: (request: T) => Promise<void>;
  cancelActive?: (request: T) => void | Promise<void>;
  onCoalesced?: () => void;
  /**
   * Hold the queue without dropping it. Requests keep coalescing while paused
   * and the newest one drains on resume. Used while an export owns the worker.
   */
  paused?: boolean;
};

export function useRenderQueue<T>({
  render,
  cancelActive,
  onCoalesced,
  paused = false,
}: UseRenderQueueOptions<T>) {
  const renderEvent = useEvent(render);
  const cancelActiveEvent = useEvent((request: T) => {
    cancelActive?.(request);
  });
  const onCoalescedEvent = useEvent(() => {
    onCoalesced?.();
  });

  const queuedRef = useRef<T | null>(null);
  const inFlightRef = useRef(false);
  const activeRef = useRef<T | null>(null);
  // Assigned during render, not in an effect: an enqueue between the pause
  // commit and an effect would otherwise slip through and drain.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const draftFrameRef = useRef<number | null>(null);
  const settledTimerRef = useRef<number | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const clearScheduled = useCallback(() => {
    if (draftFrameRef.current !== null) {
      window.clearTimeout(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    if (settledTimerRef.current !== null) {
      window.clearTimeout(settledTimerRef.current);
      settledTimerRef.current = null;
    }
  }, []);

  const drainQueue = useEvent(async () => {
    if (inFlightRef.current) {
      return;
    }

    while (queuedRef.current && !pausedRef.current) {
      const next = queuedRef.current;
      queuedRef.current = null;
      inFlightRef.current = true;
      activeRef.current = next;
      setIsRendering(true);

      try {
        await renderEvent(next);
      } finally {
        inFlightRef.current = false;
        activeRef.current = null;
        setIsRendering(false);
      }
    }
  });

  const scheduleDrain = useEvent((priority: RenderPriority) => {
    clearScheduled();
    if (priority === 'draft') {
      draftFrameRef.current = window.setTimeout(() => {
        draftFrameRef.current = null;
        void drainQueue();
      }, 0) as unknown as number;
      return;
    }

    settledTimerRef.current = window.setTimeout(() => {
      settledTimerRef.current = null;
      void drainQueue();
    }, 0);
  });

  const enqueueRender = useCallback((request: T, priority: RenderPriority) => {
    if (queuedRef.current !== null || inFlightRef.current) {
      onCoalescedEvent();
    }

    queuedRef.current = request;
    if (inFlightRef.current) {
      if (activeRef.current !== null) {
        cancelActiveEvent(activeRef.current);
      }
      return;
    }

    scheduleDrain(priority);
  }, [cancelActiveEvent, onCoalescedEvent, scheduleDrain]);

  const cancelPending = useCallback(() => {
    queuedRef.current = null;
    clearScheduled();
  }, [clearScheduled]);

  useEffect(() => {
    if (!paused && queuedRef.current) {
      void drainQueue();
    }
  }, [drainQueue, paused]);

  useEffect(() => cancelPending, [cancelPending]);

  return {
    enqueueRender,
    cancelPending,
    isRendering,
  };
}
