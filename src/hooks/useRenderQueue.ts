import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from './useEvent';

type RenderPriority = 'draft' | 'settled';

type UseRenderQueueOptions<T> = {
  render: (request: T) => Promise<void>;
  cancelActive?: (request: T) => void | Promise<void>;
  onCoalesced?: () => void;
};

export function useRenderQueue<T>({
  render,
  cancelActive,
  onCoalesced,
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

    while (queuedRef.current) {
      const next = queuedRef.current;
      queuedRef.current = null;
      inFlightRef.current = true;
      setIsRendering(true);

      try {
        await renderEvent(next);
      } finally {
        inFlightRef.current = false;
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
      cancelActiveEvent(request);
      return;
    }

    scheduleDrain(priority);
  }, [cancelActiveEvent, onCoalescedEvent, scheduleDrain]);

  const cancelPending = useCallback(() => {
    queuedRef.current = null;
    clearScheduled();
  }, [clearScheduled]);

  useEffect(() => cancelPending, [cancelPending]);

  return {
    enqueueRender,
    cancelPending,
    isRendering,
  };
}
