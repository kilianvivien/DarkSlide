import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useEvent } from './useEvent';

function TestHarness({
  value,
  onHandler,
  onInvoke,
}: {
  value: string;
  onHandler: (handler: () => void) => void;
  onInvoke: (value: string) => void;
}) {
  const handler = useEvent(() => {
    onInvoke(value);
  });

  useEffect(() => {
    onHandler(handler);
  }, [handler, onHandler]);

  return <button onClick={handler}>Invoke</button>;
}

describe('useEvent', () => {
  it('keeps a stable function identity across rerenders', () => {
    const handlers: Array<() => void> = [];
    const onInvoke = vi.fn();

    const { rerender } = render(
      <TestHarness value="first" onHandler={(handler) => handlers.push(handler)} onInvoke={onInvoke} />,
    );

    rerender(
      <TestHarness value="second" onHandler={(handler) => handlers.push(handler)} onInvoke={onInvoke} />,
    );

    expect(handlers).toHaveLength(2);
    expect(handlers[0]).toBe(handlers[1]);
  });

  it('always calls the latest closure', () => {
    const onInvoke = vi.fn();

    const { rerender } = render(
      <TestHarness value="first" onHandler={() => {}} onInvoke={onInvoke} />,
    );

    rerender(
      <TestHarness value="latest" onHandler={() => {}} onInvoke={onInvoke} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));

    expect(onInvoke).toHaveBeenCalledWith('latest');
  });
});
