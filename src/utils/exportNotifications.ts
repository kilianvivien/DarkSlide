import { isDesktopShell } from './fileBridge';

type ExportNotificationKind = 'export' | 'contact-sheet' | 'batch';

interface ExportNotificationPayload {
  kind: ExportNotificationKind;
  filename?: string;
  successCount?: number;
  failureCount?: number;
  cancelled?: boolean;
}

function hasBrowserNotifications() {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

async function isNotificationPermissionGranted() {
  if (isDesktopShell()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      return isPermissionGranted();
    } catch {
      return false;
    }
  }

  return hasBrowserNotifications() && Notification.permission === 'granted';
}

export async function primeExportNotificationsPermission() {
  if (isDesktopShell()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      const granted = await isPermissionGranted();
      if (!granted) {
        await requestPermission();
      }
    } catch {
      // Ignore missing plugin support.
    }
    return;
  }

  if (!hasBrowserNotifications() || Notification.permission !== 'default') {
    return;
  }

  try {
    await Notification.requestPermission();
  } catch {
    // Ignore browser permission failures.
  }
}

function getNotificationMessage({
  kind,
  filename,
  successCount = 0,
  failureCount = 0,
  cancelled = false,
}: ExportNotificationPayload) {
  if (kind === 'export') {
    return {
      title: 'Export Finished',
      body: filename ?? 'Your export was saved.',
    };
  }

  if (kind === 'contact-sheet') {
    return {
      title: 'Contact Sheet Finished',
      body: filename ?? 'Your contact sheet was saved.',
    };
  }

  if (cancelled && successCount === 0 && failureCount === 0) {
    return {
      title: 'Batch Cancelled',
      body: 'The batch was stopped before any files were exported.',
    };
  }

  if (failureCount > 0) {
    return {
      title: 'Batch Finished',
      body: `${successCount} exported, ${failureCount} failed.`,
    };
  }

  if (cancelled) {
    return {
      title: 'Batch Finished',
      body: `${successCount} exported before cancellation.`,
    };
  }

  return {
    title: 'Batch Finished',
    body: `${successCount} file${successCount === 1 ? '' : 's'} exported successfully.`,
  };
}

export async function notifyExportFinished(payload: ExportNotificationPayload) {
  const permissionGranted = await isNotificationPermissionGranted();

  if (!permissionGranted) {
    return;
  }

  const message = getNotificationMessage(payload);

  if (isDesktopShell()) {
    try {
      const { sendNotification } = await import('@tauri-apps/plugin-notification');
      sendNotification(message);
    } catch {
      // Ignore notification delivery failures.
    }
    return;
  }

  if (!hasBrowserNotifications()) {
    return;
  }

  try {
    new Notification(message.title, { body: message.body });
  } catch {
    // Ignore notification delivery failures.
  }
}
