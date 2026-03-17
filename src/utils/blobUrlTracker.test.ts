import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBlobUrlDiagnostics,
  resetBlobUrlTrackerForTests,
  trackCreateObjectURL,
  trackRevokeObjectURL,
} from './blobUrlTracker';

describe('blobUrlTracker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetBlobUrlTrackerForTests();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:tracked'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    resetBlobUrlTrackerForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tracks active blob URLs and removes them on revoke in development', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);

    const url = trackCreateObjectURL(new Blob(['hello'], { type: 'text/plain' }));
    expect(url).toBe('blob:tracked');
    const diagnosticsAfterCreate = getBlobUrlDiagnostics();
    if (diagnosticsAfterCreate.activeBlobUrlCount === null) {
      expect(diagnosticsAfterCreate.oldestActiveBlobUrlAgeMs).toBeNull();
      return;
    }

    expect(diagnosticsAfterCreate).toMatchObject({
      activeBlobUrlCount: 1,
      oldestActiveBlobUrlAgeMs: 0,
    });

    trackRevokeObjectURL(url);
    expect(getBlobUrlDiagnostics()).toMatchObject({
      activeBlobUrlCount: 0,
      oldestActiveBlobUrlAgeMs: null,
    });
  });
});
