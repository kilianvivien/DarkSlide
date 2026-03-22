import { useEffect } from 'react';
import { useEvent } from './useEvent';

export type ShortcutDefinition = {
  key: string;
  meta?: boolean;
  shift?: boolean;
  handler: () => void;
  when?: () => boolean;
};

export type ShortcutMap = Record<string, ShortcutDefinition>;

type UseKeyboardShortcutsOptions = {
  shortcuts: ShortcutMap;
  onMenuAction?: (action: string) => void;
  onMenuOpenRecent?: (path: string) => void;
  enableMenuEvents?: boolean;
};

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }

  return Boolean(
    element.closest('input, textarea, select, [contenteditable="true"]'),
  );
}

export function useKeyboardShortcuts({
  shortcuts,
  onMenuAction,
  onMenuOpenRecent,
  enableMenuEvents = false,
}: UseKeyboardShortcutsOptions) {
  const getShortcuts = useEvent(() => shortcuts);
  const handleMenuAction = useEvent((action: string) => {
    onMenuAction?.(action);
  });
  const handleMenuOpenRecent = useEvent((path: string) => {
    onMenuOpenRecent?.(path);
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const entries = Object.values(getShortcuts());
      const key = event.key.toLowerCase();

      for (const shortcut of entries) {
        if (shortcut.key.toLowerCase() !== key) {
          continue;
        }

        if (Boolean(shortcut.meta) !== Boolean(event.metaKey || event.ctrlKey)) {
          continue;
        }

        if (Boolean(shortcut.shift) !== Boolean(event.shiftKey)) {
          continue;
        }

        if (shortcut.when && !shortcut.when()) {
          continue;
        }

        if (!shortcut.meta && isEditableTarget(event.target)) {
          continue;
        }

        event.preventDefault();
        shortcut.handler();
        break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [getShortcuts]);

  useEffect(() => {
    if (!enableMenuEvents) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) {
          return;
        }

        const unlistenAction = await listen<string>('menu-action', (event) => {
          handleMenuAction(event.payload);
        });
        if (cancelled) { unlistenAction(); return; }

        const unlistenRecent = await listen<string>('menu-open-recent', (event) => {
          handleMenuOpenRecent(event.payload);
        });
        if (cancelled) { unlistenAction(); unlistenRecent(); return; }

        unlisten = () => { unlistenAction(); unlistenRecent(); };
      } catch {
        // Ignore non-Tauri environments.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enableMenuEvents, handleMenuAction, handleMenuOpenRecent]);
}
