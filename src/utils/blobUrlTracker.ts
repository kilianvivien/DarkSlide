const activeBlobUrls = new Map<string, number>();
const WARN_AFTER_MS = 10_000;

function isTrackingEnabled() {
  return import.meta.env.DEV;
}

function warnForStaleBlobUrls() {
  if (!isTrackingEnabled()) {
    return;
  }

  const now = performance.now();
  for (const [url, createdAt] of activeBlobUrls.entries()) {
    const ageMs = now - createdAt;
    if (ageMs > WARN_AFTER_MS) {
      console.warn('[DarkSlide] Blob URL remained active far longer than expected.', {
        url,
        ageMs: Math.round(ageMs),
      });
    }
  }
}

export function trackCreateObjectURL(blob: Blob | MediaSource) {
  const url = URL.createObjectURL(blob);
  if (isTrackingEnabled()) {
    activeBlobUrls.set(url, performance.now());
    warnForStaleBlobUrls();
  }
  return url;
}

export function trackRevokeObjectURL(url: string) {
  URL.revokeObjectURL(url);
  if (isTrackingEnabled()) {
    activeBlobUrls.delete(url);
  }
}

export function getBlobUrlDiagnostics() {
  if (!isTrackingEnabled()) {
    return {
      activeBlobUrlCount: null,
      oldestActiveBlobUrlAgeMs: null,
    };
  }

  const now = performance.now();
  let oldestActiveBlobUrlAgeMs: number | null = null;
  for (const createdAt of activeBlobUrls.values()) {
    const ageMs = now - createdAt;
    oldestActiveBlobUrlAgeMs = oldestActiveBlobUrlAgeMs === null
      ? ageMs
      : Math.max(oldestActiveBlobUrlAgeMs, ageMs);
  }

  return {
    activeBlobUrlCount: activeBlobUrls.size,
    oldestActiveBlobUrlAgeMs: oldestActiveBlobUrlAgeMs === null
      ? null
      : Math.round(oldestActiveBlobUrlAgeMs),
  };
}

export function resetBlobUrlTrackerForTests() {
  activeBlobUrls.clear();
}
