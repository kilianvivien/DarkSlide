import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useRenderQueue } from './useRenderQueue';

function TestHarness({
  paused,
  request,
  onRender,
  onQueueReady,
}: {
  paused: boolean;
  request: string | null;
  onRender: (request: string) => void;
  onQueueReady?: (enqueue: (request: string, priority: 'draft' | 'settled') => void) => void;
}) {
  const { enqueueRender } = useRenderQueue<string>({
    render: async (next) => {
      onRender(next);
    },
    paused,
  });

  useEffect(() => {
    onQueueReady?.(enqueueRender);
    if (request !== null) {
      enqueueRender(request, 'settled');
    }
  }, [enqueueRender, onQueueReady, request]);

  return null;
}

type DocRequest = { documentId: string; revision: number };
type Enqueue = (request: DocRequest, priority: 'draft' | 'settled') => void;

function ControlledHarness({
  paused = false,
  onRender,
  onCancel,
  onError,
  onReady,
}: {
  paused?: boolean;
  onRender: (request: DocRequest) => Promise<void>;
  onCancel: (request: DocRequest) => void;
  onError?: (error: unknown, request: DocRequest) => void;
  onReady: (enqueue: Enqueue) => void;
}) {
  const { enqueueRender } = useRenderQueue<DocRequest>({
    render: onRender,
    cancelActive: onCancel,
    onError,
    paused,
  });

  useEffect(() => {
    onReady(enqueueRender);
  }, [enqueueRender, onReady]);

  return null;
}

function deferredRender() {
  const pending = new Map<string, () => void>();
  const failures = new Map<string, (error: Error) => void>();
  const onRender = vi.fn((request: DocRequest) => new Promise<void>((resolve, reject) => {
    const key = `${request.documentId}:${request.revision}`;
    pending.set(key, resolve);
    failures.set(key, reject);
  }));
  return {
    onRender,
    resolve: (key: string) => pending.get(key)?.(),
    reject: (key: string, error: Error) => failures.get(key)?.(error),
  };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe('useRenderQueue', () => {
  it('holds requests while paused and drains the newest one on resume', async () => {
    vi.useFakeTimers();
    const onRender = vi.fn();

    const { rerender } = render(
      <TestHarness paused request="first" onRender={onRender} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onRender).not.toHaveBeenCalled();

    // Requests keep coalescing while paused: only the newest survives.
    rerender(<TestHarness paused request="second" onRender={onRender} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onRender).not.toHaveBeenCalled();

    rerender(<TestHarness paused={false} request="second" onRender={onRender} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledWith('second');
    vi.useRealTimers();
  });

  it('renders immediately when not paused', async () => {
    vi.useFakeTimers();
    const onRender = vi.fn();

    render(<TestHarness paused={false} request="only" onRender={onRender} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(onRender).toHaveBeenCalledWith('only');
    vi.useRealTimers();
  });

  it('cancels the render in flight, not the incoming request, when another document supersedes it', async () => {
    vi.useFakeTimers();
    const renders = deferredRender();
    const onCancel = vi.fn();
    let enqueue: Enqueue = () => undefined;

    render(<ControlledHarness onRender={renders.onRender} onCancel={onCancel} onReady={(next) => { enqueue = next; }} />);

    act(() => enqueue({ documentId: 'A', revision: 1 }, 'draft'));
    await flush();
    expect(renders.onRender).toHaveBeenCalledWith({ documentId: 'A', revision: 1 });

    act(() => enqueue({ documentId: 'B', revision: 1 }, 'draft'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ documentId: 'A', revision: 1 });

    await act(async () => {
      renders.resolve('A:1');
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(renders.onRender).toHaveBeenLastCalledWith({ documentId: 'B', revision: 1 });
    expect(renders.onRender).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('cancels the active render once and only renders the newest of several pending edits', async () => {
    vi.useFakeTimers();
    const renders = deferredRender();
    const onCancel = vi.fn();
    let enqueue: Enqueue = () => undefined;

    render(<ControlledHarness onRender={renders.onRender} onCancel={onCancel} onReady={(next) => { enqueue = next; }} />);

    act(() => enqueue({ documentId: 'A', revision: 1 }, 'draft'));
    await flush();
    act(() => {
      enqueue({ documentId: 'A', revision: 2 }, 'draft');
      enqueue({ documentId: 'A', revision: 3 }, 'draft');
      enqueue({ documentId: 'A', revision: 4 }, 'settled');
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ documentId: 'A', revision: 1 });

    await act(async () => {
      renders.resolve('A:1');
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(renders.onRender.mock.calls.map(([request]) => request.revision)).toEqual([1, 4]);
    vi.useRealTimers();
  });

  it('keeps the pending request through a pause that starts mid-render and drains it on resume', async () => {
    vi.useFakeTimers();
    const renders = deferredRender();
    const onCancel = vi.fn();
    let enqueue: Enqueue = () => undefined;
    const onReady = (next: Enqueue) => { enqueue = next; };

    const { rerender } = render(
      <ControlledHarness onRender={renders.onRender} onCancel={onCancel} onReady={onReady} />,
    );
    act(() => enqueue({ documentId: 'A', revision: 1 }, 'draft'));
    await flush();

    rerender(<ControlledHarness paused onRender={renders.onRender} onCancel={onCancel} onReady={onReady} />);
    act(() => enqueue({ documentId: 'A', revision: 2 }, 'draft'));
    await act(async () => {
      renders.resolve('A:1');
      await vi.advanceTimersByTimeAsync(10);
    });
    // Paused: no new preview work starts, but the request is not lost.
    expect(renders.onRender).toHaveBeenCalledTimes(1);

    rerender(<ControlledHarness onRender={renders.onRender} onCancel={onCancel} onReady={onReady} />);
    await flush();
    expect(renders.onRender).toHaveBeenCalledTimes(2);
    expect(renders.onRender).toHaveBeenLastCalledWith({ documentId: 'A', revision: 2 });
    vi.useRealTimers();
  });

  it('clears the active request after a failed render and keeps draining newer work', async () => {
    vi.useFakeTimers();
    const renders = deferredRender();
    const onCancel = vi.fn();
    const onError = vi.fn();
    let enqueue: Enqueue = () => undefined;

    render(
      <ControlledHarness
        onRender={renders.onRender}
        onCancel={onCancel}
        onError={onError}
        onReady={(next) => { enqueue = next; }}
      />,
    );

    act(() => enqueue({ documentId: 'A', revision: 1 }, 'draft'));
    await flush();
    act(() => enqueue({ documentId: 'A', revision: 2 }, 'draft'));
    const failure = new Error('gpu lost');
    await act(async () => {
      renders.reject('A:1', failure);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(onError).toHaveBeenCalledWith(failure, { documentId: 'A', revision: 1 });
    expect(renders.onRender).toHaveBeenLastCalledWith({ documentId: 'A', revision: 2 });

    // Revision 2 is now the active render; superseding it cancels revision 2,
    // never the failed revision 1.
    act(() => enqueue({ documentId: 'A', revision: 3 }, 'draft'));
    expect(onCancel).toHaveBeenLastCalledWith({ documentId: 'A', revision: 2 });
    vi.useRealTimers();
  });

  it('does not cancel anything when the queue is idle', async () => {
    vi.useFakeTimers();
    const renders = deferredRender();
    const onCancel = vi.fn();
    let enqueue: Enqueue = () => undefined;

    render(<ControlledHarness onRender={renders.onRender} onCancel={onCancel} onReady={(next) => { enqueue = next; }} />);
    act(() => enqueue({ documentId: 'A', revision: 1 }, 'draft'));
    await flush();
    await act(async () => {
      renders.resolve('A:1');
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => enqueue({ documentId: 'B', revision: 1 }, 'draft'));
    await flush();

    expect(onCancel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
