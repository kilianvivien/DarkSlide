import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
}));

vi.mock('./fileBridge', () => ({
  isDesktopShell: fileBridgeState.isDesktopShell,
}));

import { notifyExportFinished } from './exportNotifications';

describe('exportNotifications', () => {
  beforeEach(() => {
    fileBridgeState.isDesktopShell.mockReset();
    fileBridgeState.isDesktopShell.mockReturnValue(false);
  });

  it('sends a success message for completed batches', async () => {
    const notificationSpy = vi.fn();
    class MockNotification {
      static permission = 'granted';

      constructor(title: string, options?: NotificationOptions) {
        notificationSpy(title, options);
      }
    }

    vi.stubGlobal('Notification', MockNotification);

    await notifyExportFinished({
      kind: 'batch',
      successCount: 3,
      failureCount: 0,
      cancelled: false,
    });

    expect(notificationSpy).toHaveBeenCalledWith('Batch Finished', {
      body: '3 files exported successfully.',
    });
  });

  it('sends a partial-failure message when some batch items fail', async () => {
    const notificationSpy = vi.fn();
    class MockNotification {
      static permission = 'granted';

      constructor(title: string, options?: NotificationOptions) {
        notificationSpy(title, options);
      }
    }

    vi.stubGlobal('Notification', MockNotification);

    await notifyExportFinished({
      kind: 'batch',
      successCount: 2,
      failureCount: 1,
      cancelled: false,
    });

    expect(notificationSpy).toHaveBeenCalledWith('Batch Finished', {
      body: '2 exported, 1 failed.',
    });
  });
});
