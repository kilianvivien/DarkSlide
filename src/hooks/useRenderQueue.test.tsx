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
});
