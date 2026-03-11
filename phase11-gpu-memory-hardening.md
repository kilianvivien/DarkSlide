# Phase 11: GPU & Memory Hardening — Implementation Plan

## Overview

Phase 11 hardens the GPU pipeline and worker memory management for stability under heavy workloads — large scans (24–120 MP), long editing sessions, and GPU edge cases. All changes are defensive in nature: no new features, no UI additions beyond diagnostics reporting.

| Workstream | Scope | Risk | Expected Impact |
|---|---|---|---|
| A. GPU uniform upload elision | `WebGPUPipeline.ts` | Low | Eliminates redundant uniform/LUT uploads during rapid slider drags |
| B. Memory hardening | `imageWorker.ts`, `imageWorkerClient.ts`, `App.tsx`, `imagePipeline.ts`, `fileBridge.ts`, `constants.ts`, `types.ts`, `SettingsModal.tsx` | Medium | Prevents OOM on large files, plugs blob/canvas leaks, adds graceful error messaging |

---

## Workstream A: GPU Uniform Upload Elision

### Current Problem

The `WebGPUPipeline` in `src/utils/gpu/WebGPUPipeline.ts` rewrites all uniform buffers and curve LUTs on every render dispatch, even when the effective processing state has not changed between frames. During rapid slider drags this means redundant GPU uploads every interaction frame.

**Current per-render GPU write cost:**
- `processingUniformBuffer`: 192 bytes (`48 * 4`) via `writeBuffer` — line 474
- `curveLutBuffer`: 4,096 bytes (`1024 * 4`) via `writeBuffer` — line 479
- `blurUniformBuffer`: 32 bytes, written 0–4 times per render — lines 383–392
- `effectUniformBuffer`: 16 bytes, written 0–2 times per render — lines 396–400
- `sourceTexture` via `writeTexture`: full image data (e.g. 37.7 MB for 4K) — line 459

None of these are guarded by a dirty check.

### A1. Hash-based uniform upload elision

Do not thread a new `settingsRevision` token through the app and worker for Phase 11. The lowest-risk change is local to `WebGPUPipeline`: hash the generated uniform payloads and skip `writeBuffer` when the byte content is unchanged.

**Changes to `WebGPUPipeline.ts`:**

Add private fields to track the last-uploaded state:

```ts
private lastProcessingUniformsHash: number | null = null;
private lastCurveLutHash: number | null = null;
```

Before each `writeBuffer` call in `processImageData()`, compute a lightweight hash of the uniform data and compare against the cached value. Skip the write if unchanged:

```ts
// In processImageData(), replace the unconditional writeBuffer calls:

const processingUniforms = buildProcessingUniforms(settings, isColor, comparisonMode, maskTuning, colorMatrix, tonalCharacter);
const processingHash = hashFloat32Array(processingUniforms);
if (processingHash !== this.lastProcessingUniformsHash) {
  this.device.queue.writeBuffer(this.processingUniformBuffer, 0, processingUniforms);
  this.lastProcessingUniformsHash = processingHash;
}

const curveLut = buildCurveLutBuffer(settings);
const curveHash = hashFloat32Array(curveLut);
if (curveHash !== this.lastCurveLutHash) {
  this.device.queue.writeBuffer(this.curveLutBuffer, 0, curveLut);
  this.lastCurveLutHash = curveHash;
}
```

**Hash function** — use a fast FNV-1a over the Float32Array's backing `ArrayBuffer`:

```ts
private static hashFloat32Array(data: Float32Array): number {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}
```

Use a `number` hash instead of a string to avoid allocation. Reset both hashes on `destroy()` and on device loss to ensure stale state is never reused.

This is upload elision, not true revision tracking: `buildProcessingUniforms()` / `buildCurveLutBuffer()` still run every render. That is acceptable for Phase 11 because it keeps the change local to the GPU pipeline. If profiling later shows hash cost is material, a follow-up can propagate a caller-owned revision token and skip both buffer construction and upload.

### A2. Curve LUT diff

The curve LUT buffer (4 × 256 entries = 4,096 bytes) is the most expensive per-render upload outside of the source texture. During non-curve edits (exposure, contrast, saturation, etc.) the curves do not change.

This is already handled by A1's `curveHash` check — the hash over the 1024-element `Float32Array` will match on non-curve edits, skipping the `writeBuffer`.

No additional work needed beyond A1.

### A3. Texture reuse on resize

**Current behavior** (`ensureTextures()`, lines 256–309): if either width or height changes, all five textures (source, workA, workB, workC, output) are destroyed and recreated.

**Conclusion**: no Phase 11 change is required here. All five textures share the same dimensions, so partial texture reuse is not possible at the GPU level. The current `ensureTextures()` exact-dimension reuse and `ensureReadbackBuffer()` size-capacity reuse are already the correct baseline.

Do not add a 1px tolerance check here: it would silently reuse textures of the wrong size and produce incorrect output. Any real readback/submit overlap would require a larger redesign such as double-buffered readback or pipelining the next tile while the previous readback maps. That work is deferred out of Phase 11.

---

## Workstream B: Memory Hardening

### Current Problem

The app relies on browser dimension caps (`MAX_IMAGE_PIXELS = 120_000_000`, `MAX_IMAGE_DIMENSION = 18_000`) and a 50-entry undo limit to bound memory. Several edge cases can still cause problems:

1. **No file size pre-check**: `file.size` is stored in metadata but never validated before `arrayBuffer()` is called. A 500 MB TIFF can exhaust memory mid-decode.
2. **No GPU device-lost recovery**: the `device.lost` promise is listened to (line 196–198) and `isLost()` is checked in `ensureGPU()`, but there is no proactive handler that tears down resources, logs to diagnostics, and surfaces a user-visible notification.
3. **Blob URL lifecycle**: `fileBridge.ts` correctly revokes blob URLs via `setTimeout(..., 1000)` (lines 131, 161), but there is no audit mechanism to detect leaks from other code paths (e.g. if an export is interrupted before the revoke timer fires).
4. **Worker memory after document close**: `handleDispose()` (line 617–623) deletes the document from the `documents` map but does not explicitly release `sourceCanvas` or preview canvases. Garbage collection handles this eventually, but OffscreenCanvas memory can linger in long sessions.
5. **No OOM catch**: the main decode and render paths do not catch `RangeError` (typed-array allocation failure), so a too-large image produces a generic worker error instead of an actionable message.

### B1. File size pre-check

**File**: `src/utils/imageWorker.ts` (and `src/constants.ts`)

Add a `MAX_FILE_SIZE_BYTES` constant:

```ts
// constants.ts
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
```

In `handleDecode()`, before any processing, check the incoming buffer size:

```ts
// At the top of handleDecode(), after the raw-rgba check:
if (payload.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
  throw createError(
    'FILE_TOO_LARGE',
    `File size (${Math.round(payload.buffer.byteLength / 1024 / 1024)} MB) exceeds the ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB limit. Try a smaller scan or reduce the scan resolution.`,
  );
}
```

Import `MAX_FILE_SIZE_BYTES` from `constants.ts` in the worker.

**Add the main-thread pre-check at the actual allocation boundary** in `App.tsx`: reject the file before `file.arrayBuffer()` is called. This avoids allocating the large browser-side `ArrayBuffer` at all for oversized imports.

```ts
// In importFile(), before file.arrayBuffer():
if (!rawImport && sourceFileSize > MAX_FILE_SIZE_BYTES) {
  setError(`File is too large (${Math.round(sourceFileSize / 1024 / 1024)} MB). Maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`);
  return;
}
```

Keep the worker-side `payload.buffer.byteLength` guard as defense in depth for any future entry point that bypasses the UI pre-check.

### B2. GPU device-lost recovery

**Files**: `WebGPUPipeline.ts`, `imageWorkerClient.ts`, `App.tsx`, `SettingsModal.tsx`

**Step 1 — Robust `device.lost` handler in `WebGPUPipeline`:**

Replace the current fire-and-forget listener (lines 196–198):

```ts
// Current:
void this.device.lost.then(() => {
  this.lost = true;
});

// Proposed:
void this.device.lost.then((info) => {
  this.lost = true;
  this.lostReason = info.reason ?? 'unknown';
  this.lostMessage = info.message ?? 'GPU device was lost.';
});
```

Add fields:

```ts
private lostReason: string = '';
private lostMessage: string = '';
```

Add a public getter:

```ts
getLostInfo(): { reason: string; message: string } | null {
  if (!this.lost) return null;
  return { reason: this.lostReason, message: this.lostMessage };
}
```

**Step 2 — Worker client device-loss handling in `imageWorkerClient.ts`:**

In `handleGPUFailure()` (line 445), add diagnostics logging when device-lost is detected and keep the current retry-on-next-render policy:

```ts
private handleGPUFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /device was lost/i.test(message) ? 'device-lost' : 'initialization-failed';

  // Log to diagnostics with context
  appendDiagnostic({
    level: 'error',
    code: 'GPU_DEVICE_LOST',
    message: 'GPU device was lost. Falling back to CPU rendering until the next render retry.',
    context: {
      reason,
      originalError: message,
      adapterName: this.gpuPipeline?.adapterName ?? 'unknown',
    },
  });

  this.resetGPU(reason, message, true); // retry on next render
}
```

Do **not** permanently disable GPU for the rest of the session after device loss. Phase 11 keeps the current behavior: mark the GPU unavailable, surface the event in diagnostics/UI, and allow re-initialization on the next render attempt. Update the implementation text accordingly:

```ts
private handleGPUFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const isDeviceLost = /device was lost/i.test(message);
  const reason = isDeviceLost ? 'device-lost' : 'initialization-failed';

  appendDiagnostic({
    level: 'error',
    code: isDeviceLost ? 'GPU_DEVICE_LOST' : 'GPU_FAILURE',
    message: isDeviceLost
      ? 'GPU device was lost. Falling back to CPU rendering.'
      : `GPU pipeline error: ${message}`,
    context: {
      reason,
      originalError: message,
    },
  });

  // Retry on the next render after device loss; some losses are transient.
  this.resetGPU(reason, message, true);
}
```

**Step 3 — Add an explicit notification path to the UI:**

Do not add a passive `gpuLostNotified` field and hope the app notices it later. The current app only refreshes diagnostics on startup and when the settings modal opens, so a device-loss event needs an explicit push path.

```ts
// imageWorkerClient.ts
type ImageWorkerClientOptions = {
  gpuEnabled?: boolean;
  onBackendDiagnosticsChange?: (diagnostics: RenderBackendDiagnostics) => void;
  onGPUDeviceLost?: (message: string) => void;
};
```

Add a synchronous `getCachedGPUDiagnostics()` helper that snapshots current client state without calling `ensureGPU()`. Call `onBackendDiagnosticsChange?.(getCachedGPUDiagnostics())` whenever `resetGPU()` or `updateBackendState()` changes the backend state.

```ts
private getCachedGPUDiagnostics(): RenderBackendDiagnostics {
  return {
    gpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
    gpuEnabled: this.gpuEnabled,
    gpuActive: this.gpuPipeline !== null,
    gpuAdapterName: this.gpuPipeline?.adapterName ?? null,
    ...
  };
}
```

When `handleGPUFailure()` detects `'device-lost'`, invoke `onGPUDeviceLost?.(message)` once per transition into the lost state. Clear that one-shot guard after a successful GPU re-initialization so a later loss can notify again.

In `App.tsx`, pass both callbacks into the `ImageWorkerClient` constructor. On backend diagnostics change, immediately call `setRenderBackendDiagnostics(...)`. On GPU device loss, surface a non-blocking transient notice.

```ts
workerClientRef.current = new ImageWorkerClient({
  gpuEnabled: initialPreferences?.gpuRendering ?? true,
  onBackendDiagnosticsChange: setRenderBackendDiagnostics,
  onGPUDeviceLost: (message) => {
    // Reuse an existing non-blocking transient notice surface if one exists.
    // If none exists yet, add a small local toast/banner rather than using setError().
    showTransientNotice(message || 'GPU unavailable — retrying on the next render');
  },
});
```

**Step 4 — Diagnostics panel reporting:**

Do not add a separate `gpuLostNotified` row. The existing diagnostics/status UI already has a backend label, detail copy, and a status badge. Update that copy so `gpuDisabledReason === 'device-lost'` reads as "GPU device was lost. DarkSlide will retry on the next render." and ensure the client callback above refreshes diagnostics immediately when loss happens.

### B3. Blob URL audit

**File**: `src/utils/fileBridge.ts`

The current blob URL handling in `fileBridge.ts` is actually correct — both `downloadBlob()` (line 126–131) and `downloadPresetFile()` (line 156–161) create a blob URL, trigger the download, and revoke after 1 second via `setTimeout`. No other files in the codebase create blob URLs outside of test mocks.

**Add a debug-mode lifecycle audit** — but do not warn solely on active-count threshold, because the current code intentionally keeps each blob URL alive for 1 second after download and burst exports can legitimately create many concurrent URLs.

```ts
// src/utils/blobUrlTracker.ts (new file, ~30 lines)

const activeBlobUrls = new Map<string, number>();
const WARN_AFTER_MS = 10_000;

export function trackCreateObjectURL(blob: Blob | MediaSource): string {
  const url = URL.createObjectURL(blob);
  activeBlobUrls.set(url, performance.now());
  warnForStaleBlobUrls();
  return url;
}

export function trackRevokeObjectURL(url: string): void {
  URL.revokeObjectURL(url);
  activeBlobUrls.delete(url);
}

export function getActiveBlobUrlCount(): number {
  return activeBlobUrls.size;
}

export function getOldestActiveBlobUrlAgeMs(): number | null {
  const now = performance.now();
  let oldest = -1;
  for (const createdAt of activeBlobUrls.values()) {
    oldest = Math.max(oldest, now - createdAt);
  }
  return oldest >= 0 ? oldest : null;
}

function warnForStaleBlobUrls() {
  const now = performance.now();
  for (const [url, createdAt] of activeBlobUrls.entries()) {
    if (now - createdAt > WARN_AFTER_MS) {
      console.warn('[DarkSlide] Blob URL remained active far longer than expected.', {
        url,
        ageMs: Math.round(now - createdAt),
      });
    }
  }
}
```

Replace the direct `URL.createObjectURL` / `URL.revokeObjectURL` calls in `fileBridge.ts` with the tracked versions. Import only in development builds via a conditional to avoid overhead in production:

```ts
// fileBridge.ts
import { trackCreateObjectURL, trackRevokeObjectURL } from './blobUrlTracker';

// Replace URL.createObjectURL(blob) → trackCreateObjectURL(blob)
// Replace URL.revokeObjectURL(url) → trackRevokeObjectURL(url)
```

Expose `getActiveBlobUrlCount()` and optionally the oldest active age in the Diagnostics tab of `SettingsModal.tsx` as debug-only rows.

### B4. Worker memory cleanup on document close

**File**: `src/utils/imageWorker.ts`

The `handleDispose()` path (line 617–623) deletes the document from the `documents` map and clears related tile jobs, but does not explicitly release `OffscreenCanvas` resources. While the garbage collector will eventually reclaim them, in long sessions with many open/close cycles, deferred GC can cause memory pressure.

Disposal is not the only leak point. The current worker also drops transformed canvases on geometry-cache replacement and job cancellation without explicit cleanup. Phase 11 should harden all three paths: cache eviction, tile-job cleanup, and document disposal.

**Add reference-safe canvas cleanup helpers:**

Geometry caches own transformed canvases; `tileJobs` borrow them. Do not blindly `releaseCanvas()` from `clearTileJob()`, because the same `transformedCanvas` may still be referenced by the active geometry cache. Instead, add a helper that releases a canvas only when no cache entry and no tile job still reference it.

```ts
function releaseCanvasIfUnreferenced(canvas: OffscreenCanvas) {
  const stillReferencedByCache = Array.from(documents.values()).some((doc) =>
    Array.from(doc.previewGeometryCache.values()).some((job) => job.transformedCanvas === canvas)
    || Array.from(doc.sourceGeometryCache.values()).some((job) => job.transformedCanvas === canvas)
  );
  const stillReferencedByTileJob = Array.from(tileJobs.values()).some((job) => job.transformedCanvas === canvas);
  if (!stillReferencedByCache && !stillReferencedByTileJob) {
    releaseCanvas(canvas);
  }
}
```

Add a `releaseCanvas` helper:

```ts
function releaseCanvas(canvas: OffscreenCanvas) {
  // Shrink the canvas to 1x1 to release the backing bitmap memory.
  // OffscreenCanvas does not have a .close() method in all browsers,
  // but resizing to 1x1 releases the bitmap allocation immediately.
  try {
    canvas.width = 1;
    canvas.height = 1;
  } catch {
    // Ignore if canvas is already detached (e.g. transferred)
  }
}
```

Use `releaseCanvasIfUnreferenced()` in these places:

- when replacing a geometry-cache entry (`cache.clear()` / new `cache.set(...)` path)
- when deleting a cache entry during document disposal
- when cancelling or clearing tile jobs after the job entry is removed

In the cache-replacement path, capture the old cached job before `cache.clear()` and call `releaseCanvasIfUnreferenced(oldJob.transformedCanvas)` after the cache mutation, so long editing sessions do not retain abandoned transformed canvases.

**Also release the static `rotateCanvas` and `outputCanvas`** after dispose if no documents remain:

```ts
if (documents.size === 0) {
  if (rotateCanvas) {
    releaseCanvas(rotateCanvas);
    rotateCanvas = null;
  }
  if (outputCanvas) {
    releaseCanvas(outputCanvas);
    outputCanvas = null;
  }
}
```

**Expose approximate retained memory** in diagnostics. Add a worker message type `'diagnostics'` that reports:

```ts
// New response payload:
interface WorkerMemoryDiagnostics {
  documentCount: number;
  totalPreviewCanvases: number;
  tileJobCount: number;
  cancelledJobCount: number;
  estimatedMemoryBytes: number;
}
```

The `estimatedMemoryBytes` is computed as:

```ts
function estimateMemoryBytes(): number {
  let total = 0;
  for (const [, doc] of documents) {
    // Source canvas: width * height * 4 bytes (RGBA)
    total += doc.sourceCanvas.width * doc.sourceCanvas.height * 4;
    // Preview canvases
    for (const preview of doc.previews) {
      if (preview.canvas !== doc.sourceCanvas) {
        total += preview.canvas.width * preview.canvas.height * 4;
      }
    }
    // Geometry caches
    for (const [, job] of doc.previewGeometryCache) {
      total += job.width * job.height * 4;
    }
    for (const [, job] of doc.sourceGeometryCache) {
      total += job.width * job.height * 4;
    }
  }
  // Tile jobs
  for (const [, job] of tileJobs) {
    total += job.width * job.height * 4;
  }
  // Static canvases
  if (rotateCanvas) total += rotateCanvas.width * rotateCanvas.height * 4;
  if (outputCanvas) total += outputCanvas.width * outputCanvas.height * 4;
  return total;
}
```

This is an estimate (actual browser allocations may differ) but gives the diagnostics panel a useful order-of-magnitude reading.

### B5. Graceful OOM messaging

**Files**: `src/utils/imageWorker.ts`, `src/App.tsx`

The worker's top-level `try/catch` (line 659–668) catches all errors generically. Add a specific check for `RangeError`, which is the standard error thrown when a typed-array allocation fails:

```ts
// In the catch block of self.onmessage (line 659):
} catch (error) {
  const failure = error as Partial<WorkerError> & { message?: string };

  // Detect OOM from typed-array allocation failure
  const isOOM = error instanceof RangeError
    || (failure.message && /invalid array length|out of memory|allocation failed/i.test(failure.message));

  reply({
    id: request.id,
    ok: false,
    error: createError(
      isOOM ? 'OUT_OF_MEMORY' : (failure.code ?? 'WORKER_ERROR'),
      isOOM
        ? 'Image too large for available memory. Try closing other tabs or using a smaller scan resolution.'
        : (failure.message ?? String(error)),
    ),
  });
}
```

No `imageWorkerClient.ts` recovery change is needed here. The current recovery path already only retries missing-document failures, so OOM errors will naturally propagate without a special guard.

In `App.tsx`, when the error code is `OUT_OF_MEMORY`, display a specific error message to the user instead of the generic import failure text.

---

## Implementation Order

### Phase 1: Memory safety (B1, B5) — lowest risk, highest immediate value

1. **B1** — Add `MAX_FILE_SIZE_BYTES` constant and pre-check in both the worker and `App.tsx`.
2. **B5** — Add `RangeError` / OOM detection in the worker catch block and specific OOM messaging in `App.tsx`.

These two changes are completely self-contained and can ship independently.

### Phase 2: GPU resilience (A1, B2) — moderate risk, significant value

3. **A1** — Add FNV-1a hashing to `WebGPUPipeline` and skip redundant uniform/LUT `writeBuffer` calls.
4. **B2** — Improve `device.lost` handling, keep retry-on-next-render behavior, add diagnostics logging, and push backend state changes to the UI via explicit callbacks.

A1 requires testing with all pipeline paths (preview, tiled, export) to ensure hash collisions don't cause stale renders. B2 requires testing on a system where device loss can be simulated (e.g. by disabling the GPU mid-session via browser flags).

### Phase 3: Leak prevention (B3, B4) — low risk, long-session value

5. **B3** — Add `blobUrlTracker.ts`, wire into `fileBridge.ts`, expose count in diagnostics.
6. **B4** — Add reference-safe canvas cleanup helpers for cache eviction/job cleanup/dispose, add memory estimation, expose in diagnostics.

---

## Files Modified

| File | Workstream | Changes |
|---|---|---|
| `src/constants.ts` | B1 | Add `MAX_FILE_SIZE_BYTES` |
| `src/types.ts` | B4 | Add `WorkerMemoryDiagnostics` interface |
| `src/utils/gpu/WebGPUPipeline.ts` | A1, B2 | Hash-based buffer skip, device-lost info getters |
| `src/utils/imageWorker.ts` | B1, B4, B5 | File size check, canvas release on dispose, OOM detection |
| `src/utils/imageWorkerClient.ts` | B2 | Device-lost diagnostics, retry-on-next-render, backend diagnostics change callbacks |
| `src/utils/fileBridge.ts` | B3 | Use tracked blob URL functions |
| `src/utils/blobUrlTracker.ts` | B3 | **New file** — blob URL lifecycle audit with stale-age warnings |
| `src/App.tsx` | B1, B2, B5 | Pre-import size check, GPU-loss notice hookup, specific OOM messaging |
| `src/components/SettingsModal.tsx` | B2, B3, B4 | Updated GPU-loss detail copy, blob URL debug rows, worker memory estimate |

## New Files

| File | Purpose | Size |
|---|---|---|
| `src/utils/blobUrlTracker.ts` | Track `createObjectURL` / `revokeObjectURL` calls and warn on stale unreleased URLs | ~40 lines |

## Testing Plan

### Unit tests (vitest)

| Test | File | Validates |
|---|---|---|
| File size rejection | `imageWorker.test.ts` | Worker throws `FILE_TOO_LARGE` for buffers > `MAX_FILE_SIZE_BYTES` |
| Main-thread size rejection | `App.test.tsx` | Oversized browser import is rejected before `file.arrayBuffer()` |
| OOM error code | `imageWorker.test.ts` | `RangeError` in decode/render maps to `OUT_OF_MEMORY` code |
| Blob URL tracker | `blobUrlTracker.test.ts` | `trackCreateObjectURL` increments count, `trackRevokeObjectURL` decrements, stale-age warning fires only for long-lived URLs |
| Hash stability | `WebGPUPipeline.test.ts` | Same uniform payload produces same hash; different payload produces different hash |
| Geometry cleanup on cache replacement | `imageWorker.test.ts` | Replaced transformed canvases are eventually released when no longer referenced |
| GPU diagnostics callback | `imageWorkerClient.test.ts` | Device loss pushes updated diagnostics and emits a one-shot user notification |

### Manual tests

| Scenario | Steps | Expected |
|---|---|---|
| Large file rejection | Import a 600 MB TIFF | Error message: "File is too large (600 MB)" before any decode attempt |
| GPU device loss | Open Chrome DevTools → `chrome://gpu` → kill GPU process | Non-blocking notice appears; Diagnostics updates immediately to "device-lost"; the next render attempts GPU re-init |
| Long editing session | Import 10 images sequentially, editing each for 2 minutes | Worker memory estimate in diagnostics stays bounded; no browser tab crash |
| Blob URL leak detection | Export 25 images rapidly | No warning from normal 1-second revoke delay; warning only if a blob URL remains unreleased well beyond the expected window |
| OOM on huge image | Construct a 120 MP × 16-bit TIFF and import | Error: "Image too large for available memory" instead of generic crash |

---

## Non-Goals

These are explicitly out of scope for Phase 11:

- **Decode cache eviction** (`imageWorkerClient.ts` `decodeCache`): the current single-document model means the cache holds at most one entry. This becomes relevant in Phase 12 (multi-document tabs) and will be addressed there.
- **Geometry cache bounding**: the current `cache.clear()` on each new geometry key (line 426) means each cache holds at most one entry. This is correct for the single-document model.
- **True GPU/CPU overlap or double-buffered readback**: Phase 11 does not redesign the readback flow. A real overlap implementation would need separate readback buffers and/or pipelining across tiles/jobs.
- **GPU texture format changes**: no changes to `INTERMEDIATE_FORMAT` or texture pipeline topology.
- **CPU pipeline optimisations**: covered in Phase 10.
- **Worker thread pooling**: beyond current scope; single-worker model remains.
