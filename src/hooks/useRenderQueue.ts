import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from './useEvent';

type RenderPriority = 'draft' | 'settled';

type UseRenderQueueOptions<T> = {
  render: (request: T) => Promise<void>;
  /**
   * Called with the request that is currently rendering when a newer request
   * supersedes it. Never called with the incoming request: the two can belong
   * to different documents.
   */
  cancelActive?: (request: T) => void | Promise<void>;
  onCoalesced?: () => void;
  /**
   * A render that throws does not stall the queue: newer requests still drain.
   * Defaults to logging the error.
   */
  onError?: (error: unknown, request: T) => void;
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
  onError,
  paused = false,
}: UseRenderQueueOptions<T>) {
  const renderEvent = useEvent(render);
  const cancelActiveEvent = useEvent((request: T) => {
    cancelActive?.(request);
  });
  const onCoalescedEvent = useEvent(() => {
    onCoalesced?.();
  });
  const onErrorEvent = useEvent((error: unknown, request: T) => {
    if (onError) {
      onError(error, request);
      return;
    }
    console.error('Render queue request failed', error);
  });

  const queuedRef = useRef<T | null>(null);
  const inFlightRef = useRef(false);
  // The request currently rendering, tracked separately from the pending one
  // so a supersede cancels the work that is actually running.
  const activeRef = useRef<{ request: T; cancelled: boolean } | null>(null);
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
      activeRef.current = { request: next, cancelled: false };
      setIsRendering(true);

      try {
        await renderEvent(next);
      } catch (error) {
        onErrorEvent(error, next);
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
      // Cancel the running render once; later supersedes only replace the
      // pending request. While paused nothing new starts, so the cancelled
      // render's successor waits for resume.
      const active = activeRef.current;
      if (active && !active.cancelled) {
        active.cancelled = true;
        cancelActiveEvent(active.request);
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
