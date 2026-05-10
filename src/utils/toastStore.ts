// Module-level toast store. Components subscribe via useToasts(); any code
// path (worker client, hooks, utility code) can pushToast() without dragging
// a React context across the codebase. Errors and notices both use this
// channel — toasts auto-dismiss for non-error levels, errors stick until
// dismissed and carry an optional diagnostic id for support.

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  level: ToastLevel;
  title: string;
  message?: string;
  diagnosticId?: string;
  // Wall-clock timestamp the toast was pushed (used for sort + auto-dismiss).
  createdAt: number;
}

type Listener = (toasts: readonly Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const MAX_TOASTS = 6;
const AUTO_DISMISS_MS: Partial<Record<ToastLevel, number>> = {
  info: 4500,
  success: 4500,
  warning: 7000,
};

function notify() {
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pushToast(input: {
  level: ToastLevel;
  title: string;
  message?: string;
  diagnosticId?: string;
}): Toast {
  const toast: Toast = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...input,
  };
  toasts = [...toasts, toast].slice(-MAX_TOASTS);
  notify();

  const dismissAfter = AUTO_DISMISS_MS[toast.level];
  if (dismissAfter !== undefined) {
    setTimeout(() => dismissToast(toast.id), dismissAfter);
  }

  return toast;
}

export function dismissToast(id: string) {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) {
    return;
  }
  toasts = next;
  notify();
}

// Test-only: clear the store between tests.
export function _clearToastsForTesting() {
  toasts = [];
  notify();
}
