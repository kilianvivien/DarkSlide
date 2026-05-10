import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _clearToastsForTesting,
  dismissToast,
  getToasts,
  pushToast,
  subscribeToasts,
} from './toastStore';

afterEach(() => {
  _clearToastsForTesting();
});

describe('toastStore', () => {
  it('appends a toast and notifies subscribers', () => {
    const observed: number[] = [];
    const unsubscribe = subscribeToasts((toasts) => observed.push(toasts.length));

    pushToast({ level: 'info', title: 'hi' });

    expect(getToasts()).toHaveLength(1);
    expect(observed.at(-1)).toBe(1);

    unsubscribe();
  });

  it('caps the toast list at MAX_TOASTS (6)', () => {
    for (let index = 0; index < 12; index += 1) {
      pushToast({ level: 'info', title: `toast-${index}` });
    }
    expect(getToasts()).toHaveLength(6);
    // Newest entries survive — keeping the most recent context for the user.
    expect(getToasts().at(-1)?.title).toBe('toast-11');
  });

  it('keeps error toasts indefinitely (no auto-dismiss)', () => {
    vi.useFakeTimers();
    pushToast({ level: 'error', title: 'boom', diagnosticId: 'abc' });
    vi.advanceTimersByTime(60_000);
    expect(getToasts()).toHaveLength(1);
    vi.useRealTimers();
  });

  it('auto-dismisses non-error toasts after the level-specific delay', () => {
    vi.useFakeTimers();
    pushToast({ level: 'success', title: 'saved' });
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(getToasts()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('dismissToast removes only the matching id', () => {
    const a = pushToast({ level: 'info', title: 'a' });
    const b = pushToast({ level: 'info', title: 'b' });
    dismissToast(a.id);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].id).toBe(b.id);
  });
});
