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

function CancellationHarness({
  request,
  onRender,
  onCancel,
}: {
  request: string;
  onRender: (request: string) => Promise<void>;
  onCancel: (request: string) => void;
}) {
  const { enqueueRender } = useRenderQueue<string>({
    render: onRender,
    cancelActive: onCancel,
  });

  useEffect(() => {
    enqueueRender(request, 'draft');
  }, [enqueueRender, request]);

  return null;
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

  it('cancels the request already in flight when a newer request arrives', async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | null = null;
    const onRender = vi.fn((request: string) => (
      request === 'first'
        ? new Promise<void>((resolve) => { releaseFirst = resolve; })
        : Promise.resolve()
    ));
    const onCancel = vi.fn();

    const { rerender } = render(
      <CancellationHarness request="first" onRender={onRender} onCancel={onCancel} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    rerender(<CancellationHarness request="second" onRender={onRender} onCancel={onCancel} />);
    expect(onCancel).toHaveBeenCalledWith('first');

    await act(async () => {
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onRender).toHaveBeenLastCalledWith('second');
    vi.useRealTimers();
  });
});
