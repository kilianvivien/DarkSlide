# Phase 11: GPU & Memory Hardening — Implementation Plan

## Overview

Phase 11 hardens the GPU pipeline and worker memory management for stability under heavy workloads — large scans (24–120 MP), long editing sessions, and GPU edge cases. All changes are defensive in nature: no new features, no UI additions beyond diagnostics reporting.

| Workstream | Scope | Risk | Expected Impact |
|---|---|---|---|
| A. GPU buffer caching | `WebGPUPipeline.ts`, `imageWorkerClient.ts`, `types.ts` | Low | Eliminates redundant GPU uploads during rapid slider drags |
| B. Memory hardening | `imageWorker.ts`, `imageWorkerClient.ts`, `App.tsx`, `imagePipeline.ts`, `fileBridge.ts`, `constants.ts`, `types.ts`, `SettingsModal.tsx` | Medium | Prevents OOM on large files, plugs blob/canvas leaks, adds graceful error messaging |

---

## Workstream A: GPU Buffer Caching

### Current Problem

The `WebGPUPipeline` in `src/utils/gpu/WebGPUPipeline.ts` rewrites all uniform buffers and curve LUTs on every render dispatch, even when the `ConversionSettings` have not changed between frames. During rapid slider drags this means redundant GPU uploads every interaction frame. Additionally, `ensureTextures()` destroys and recreates all five work textures when any dimension changes, even if only one dimension changed.

**Current per-render GPU write cost:**
- `processingUniformBuffer`: 192 bytes (`48 * 4`) via `writeBuffer` — line 474
- `curveLutBuffer`: 4,096 bytes (`1024 * 4`) via `writeBuffer` — line 479
- `blurUniformBuffer`: 32 bytes, written 0–4 times per render — lines 383–392
- `effectUniformBuffer`: 16 bytes, written 0–2 times per render — lines 396–400
- `sourceTexture` via `writeTexture`: full image data (e.g. 37.7 MB for 4K) — line 459

None of these are guarded by a dirty check.

### A1. Settings revision tracking

Add a `settingsRevision` counter to skip redundant uniform buffer uploads when settings have not changed between consecutive renders.

**Changes to `WebGPUPipeline.ts`:**

Add private fields to track the last-uploaded state:

```ts
private lastProcessingUniformsHash: string | null = null;
private lastCurveLutHash: string | null = null;
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

**Hash function** — use a fast FNV-1a over the Float32Array's backing ArrayBuffer. This is cheaper than the writeBuffer call it guards:

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

Use a `number` hash instead of a string to avoid allocation. Store as `lastProcessingUniformsHash: number | null` and `lastCurveLutHash: number | null`.

**Reset hashes on `destroy()`** and on device loss to ensure stale state is never reused.

### A2. Curve LUT diff

The curve LUT buffer (4 × 256 entries = 4,096 bytes) is the most expensive per-render upload outside of the source texture. During non-curve edits (exposure, contrast, saturation, etc.) the curves do not change.

This is already handled by A1's `curveHash` check — the hash over the 1024-element `Float32Array` will match on non-curve edits, skipping the `writeBuffer`.

No additional work needed beyond A1.

### A3. Texture reuse on partial resize

**Current behavior** (`ensureTextures()`, lines 256–309): if either width or height changes, all five textures (source, workA, workB, workC, output) are destroyed and recreated.

**Problem**: a crop-height change also forces reallocation of textures whose width hasn't changed. Since all five textures share the same dimensions, this is unavoidable at the GPU level — textures cannot be partially resized. However, the readback buffer can be reused more aggressively.

**Change to `ensureReadbackBuffer()`** (lines 311–325): the current check `this.currentReadbackSize >= size` already handles the case where the buffer is large enough. No change needed — this is already correct.

**Change to `ensureTextures()`**: add a tolerance check to avoid thrashing on sub-pixel dimension changes from crop drag rounding. If the new dimensions are within 1px of the current dimensions and the current textures exist, skip reallocation:

```ts
private ensureTextures(width: number, height: number) {
  if (
    this.sourceTexture
    && this.currentTextureWidth === width
    && this.currentTextureHeight === height
  ) {
    return;
  }

  // Existing destroy + recreate logic unchanged
  ...
}
```

The existing check is already dimension-exact. No change needed here — the texture reuse is already optimal. The only real win is in A4 below.

### A4. Readback overlap

**Current behavior** (line 577): after `device.queue.submit()`, the code immediately calls `await this.readbackBuffer.mapAsync(GPUMapMode.READ)`, which blocks the worker until the GPU finishes the entire pipeline.

**Change**: split the readback into a non-blocking submit + deferred await pattern. Between `submit()` and the `mapAsync` await, perform any CPU-side bookkeeping:

```ts
// Current (blocking):
this.device.queue.submit([encoder.finish()]);
await this.readbackBuffer.mapAsync(GPUMapMode.READ);
const pixels = this.extractPixels(expandedWidth, expandedHeight);
return copyWholeImage(pixels, expandedWidth, expandedHeight);

// Proposed (overlapped):
this.device.queue.submit([encoder.finish()]);
const mapPromise = this.readbackBuffer.mapAsync(GPUMapMode.READ);
// No CPU-side work to overlap with currently — but the promise-based
// pattern ensures future CPU work (e.g. histogram prep) can slot in here.
await mapPromise;
const pixels = this.extractPixels(expandedWidth, expandedHeight);
return copyWholeImage(pixels, expandedWidth, expandedHeight);
```

This is a structural change that enables future overlap. The immediate benefit is small (just separating submit from await), but it unblocks future histogram-prep-during-readback optimizations without changing the return type or API.

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

**Also add a pre-check on the main thread** in `App.tsx` before sending the file to the worker. This avoids the cost of transferring a huge `ArrayBuffer` to the worker just to have it rejected:

```ts
// In the importFile handler, before calling workerClient.decode():
if (file.size > MAX_FILE_SIZE_BYTES) {
  setError(`File is too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`);
  return;
}
```

### B2. GPU device-lost recovery

**Files**: `WebGPUPipeline.ts`, `imageWorkerClient.ts`, `types.ts`, `SettingsModal.tsx`

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

In `handleGPUFailure()` (line 445), add diagnostics logging when device-lost is detected:

```ts
private handleGPUFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /device was lost/i.test(message) ? 'device-lost' : 'initialization-failed';

  // Log to diagnostics with context
  appendDiagnostic({
    level: 'error',
    code: 'GPU_DEVICE_LOST',
    message: 'GPU device was lost. Falling back to CPU rendering for the remainder of this session.',
    context: {
      reason,
      originalError: message,
      adapterName: this.gpuPipeline?.adapterName ?? 'unknown',
    },
  });

  this.resetGPU(reason, message, false); // allowRetry=false for device-lost
}
```

Change the `allowRetry` parameter: when the reason is `'device-lost'`, set `allowRetry = false` to prevent re-initialization attempts that will likely fail again. Currently `handleGPUFailure` always passes `true` (line 448) — change this:

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

  // Don't retry after device loss — the GPU is gone for this session.
  // Do allow retry after transient init failures.
  this.resetGPU(reason, message, !isDeviceLost);
}
```

**Step 3 — Surface a non-blocking toast in the UI:**

Add a `gpuLostNotified` field to `RenderBackendDiagnostics`:

```ts
// types.ts — add to RenderBackendDiagnostics:
gpuLostNotified: boolean;
```

In `imageWorkerClient.ts`, track whether the loss has been reported:

```ts
private gpuLostNotified = false;
```

Set it to `true` when device-lost is detected in `handleGPUFailure()`. Expose it in `getBackendDiagnostics()`.

In `App.tsx`, when `backendDiagnostics.gpuLostNotified` transitions from `false` to `true`, show a toast notification (use the existing status/error display mechanism):

```ts
// In the render effect or a useEffect watching diagnostics:
useEffect(() => {
  const diagnostics = workerClientRef.current?.getBackendDiagnostics();
  if (diagnostics?.gpuDisabledReason === 'device-lost' && !gpuLostToastShown) {
    setGpuLostToastShown(true);
    // Show a non-blocking toast (can reuse existing error toast pattern)
    setStatusMessage('GPU unavailable — using CPU rendering');
  }
}, [backendDiagnostics]);
```

**Step 4 — Diagnostics panel reporting:**

In `SettingsModal.tsx`, add a "GPU Status" row in the Diagnostics tab that shows:
- "Active (GPU)" in green when GPU is working
- "CPU fallback (device lost)" in yellow when `gpuDisabledReason === 'device-lost'`
- "CPU fallback (unsupported)" in grey when `gpuDisabledReason === 'unsupported'`

### B3. Blob URL audit

**File**: `src/utils/fileBridge.ts`

The current blob URL handling in `fileBridge.ts` is actually correct — both `downloadBlob()` (line 126–131) and `downloadPresetFile()` (line 156–161) create a blob URL, trigger the download, and revoke after 1 second via `setTimeout`. No other files in the codebase create blob URLs outside of test mocks.

**Add a debug-mode leak detector** — a lightweight wrapper around `URL.createObjectURL` / `URL.revokeObjectURL` that tracks outstanding blob URLs and warns if the count exceeds a threshold:

```ts
// src/utils/blobUrlTracker.ts (new file, ~30 lines)

const activeBlobUrls = new Set<string>();
const WARN_THRESHOLD = 20;

export function trackCreateObjectURL(blob: Blob | MediaSource): string {
  const url = URL.createObjectURL(blob);
  activeBlobUrls.add(url);
  if (activeBlobUrls.size > WARN_THRESHOLD) {
    console.warn(
      `[DarkSlide] ${activeBlobUrls.size} unreleased blob URLs detected (threshold: ${WARN_THRESHOLD}). Possible leak.`,
    );
  }
  return url;
}

export function trackRevokeObjectURL(url: string): void {
  URL.revokeObjectURL(url);
  activeBlobUrls.delete(url);
}

export function getActiveBlobUrlCount(): number {
  return activeBlobUrls.size;
}
```

Replace the direct `URL.createObjectURL` / `URL.revokeObjectURL` calls in `fileBridge.ts` with the tracked versions. Import only in development builds via a conditional to avoid overhead in production:

```ts
// fileBridge.ts
import { trackCreateObjectURL, trackRevokeObjectURL } from './blobUrlTracker';

// Replace URL.createObjectURL(blob) → trackCreateObjectURL(blob)
// Replace URL.revokeObjectURL(url) → trackRevokeObjectURL(url)
```

Expose `getActiveBlobUrlCount()` in the Diagnostics tab of `SettingsModal.tsx` as a "Blob URLs" row.

### B4. Worker memory cleanup on document close

**File**: `src/utils/imageWorker.ts`

The `handleDispose()` path (line 617–623) deletes the document from the `documents` map and clears related tile jobs, but does not explicitly release OffscreenCanvas resources. While the garbage collector will eventually reclaim them, in long sessions with many open/close cycles, deferred GC can cause memory pressure.

**Add explicit canvas cleanup:**

```ts
// In the dispose handler (line 617-623):
if (request.type === 'dispose') {
  const doc = documents.get(request.payload.documentId);
  if (doc) {
    // Explicitly release canvas memory
    releaseCanvas(doc.sourceCanvas);
    doc.previews.forEach((preview) => {
      // Don't release if preview.canvas === doc.sourceCanvas (shared reference)
      if (preview.canvas !== doc.sourceCanvas) {
        releaseCanvas(preview.canvas);
      }
    });
    // Clear geometry caches (each holds a StoredTileJob with a transformedCanvas)
    doc.previewGeometryCache.forEach((job) => releaseCanvas(job.transformedCanvas));
    doc.previewGeometryCache.clear();
    doc.sourceGeometryCache.forEach((job) => releaseCanvas(job.transformedCanvas));
    doc.sourceGeometryCache.clear();
  }

  documents.delete(request.payload.documentId);

  // Clean up tile jobs for this document
  Array.from(tileJobs.entries())
    .filter(([, job]) => job.documentId === request.payload.documentId)
    .forEach(([jobId, job]) => {
      releaseCanvas(job.transformedCanvas);
      clearTileJob(jobId);
    });

  // Clean up cancelled job IDs for this document
  // (cancelledJobs is a Set<string> of job IDs, not document-scoped,
  // but any cancelled jobs for this document's tile jobs are now irrelevant)

  reply({ id: request.id, ok: true, payload: { disposed: true } });
  return;
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

**Files**: `src/utils/imageWorker.ts`, `src/utils/imageWorkerClient.ts`

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

On the client side (`imageWorkerClient.ts`), the `isMissingDocumentError()` check should NOT trigger recovery for OOM errors. Add a guard:

```ts
private isOOMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OUT_OF_MEMORY') || message.includes('Image too large');
}
```

In `requestWithDocumentRecovery()`, skip recovery on OOM:

```ts
private async requestWithDocumentRecovery<T>(
  documentId: string,
  operation: () => Promise<T>,
  allowRecovery: boolean,
) {
  try {
    return await operation();
  } catch (error) {
    if (!allowRecovery || !this.isMissingDocumentError(error) || this.isOOMError(error)) {
      throw error;
    }
    await this.recoverDocument(documentId);
    return operation();
  }
}
```

In `App.tsx`, when the error code is `OUT_OF_MEMORY`, display a specific error message to the user instead of the generic import failure text.

---

## Implementation Order

### Phase 1: Memory safety (B1, B5) — lowest risk, highest immediate value

1. **B1** — Add `MAX_FILE_SIZE_BYTES` constant and pre-check in both the worker and `App.tsx`.
2. **B5** — Add `RangeError` / OOM detection in the worker catch block and client-side guard.

These two changes are completely self-contained and can ship independently.

### Phase 2: GPU resilience (A1, B2) — moderate risk, significant value

3. **A1** — Add FNV-1a hash to `WebGPUPipeline` and skip redundant `writeBuffer` calls.
4. **B2** — Improve `device.lost` handler, disable retry on device-lost, add diagnostics logging, surface toast in UI.

A1 requires testing with all pipeline paths (preview, tiled, export) to ensure hash collisions don't cause stale renders. B2 requires testing on a system where device loss can be simulated (e.g. by disabling the GPU mid-session via browser flags).

### Phase 3: Leak prevention (B3, B4) — low risk, long-session value

5. **B3** — Add `blobUrlTracker.ts`, wire into `fileBridge.ts`, expose count in diagnostics.
6. **B4** — Add `releaseCanvas()` helper, expand dispose handler, add memory estimation, expose in diagnostics.

### Phase 4: Performance (A4) — low risk, marginal immediate value

7. **A4** — Restructure readback to promise-based pattern. Minimal immediate benefit but sets up future histogram-during-readback optimization.

---

## Files Modified

| File | Workstream | Changes |
|---|---|---|
| `src/constants.ts` | B1 | Add `MAX_FILE_SIZE_BYTES` |
| `src/types.ts` | B2, B4 | Add `gpuLostNotified` to `RenderBackendDiagnostics`; add `WorkerMemoryDiagnostics` interface |
| `src/utils/gpu/WebGPUPipeline.ts` | A1, A4, B2 | Hash-based buffer skip, readback overlap, device-lost info getters |
| `src/utils/imageWorker.ts` | B1, B4, B5 | File size check, canvas release on dispose, OOM detection |
| `src/utils/imageWorkerClient.ts` | B2, B5 | Device-lost diagnostics + no-retry, OOM guard in recovery |
| `src/utils/fileBridge.ts` | B3 | Use tracked blob URL functions |
| `src/utils/blobUrlTracker.ts` | B3 | **New file** — blob URL lifecycle tracker |
| `src/App.tsx` | B1, B2 | Pre-import size check, GPU-lost toast |
| `src/components/SettingsModal.tsx` | B2, B3, B4 | GPU status row, blob URL count, worker memory estimate |

## New Files

| File | Purpose | Size |
|---|---|---|
| `src/utils/blobUrlTracker.ts` | Track `createObjectURL` / `revokeObjectURL` calls, warn on leak threshold | ~30 lines |

## Testing Plan

### Unit tests (vitest)

| Test | File | Validates |
|---|---|---|
| File size rejection | `imageWorker.test.ts` | Worker throws `FILE_TOO_LARGE` for buffers > `MAX_FILE_SIZE_BYTES` |
| OOM error code | `imageWorker.test.ts` | `RangeError` in decode/render maps to `OUT_OF_MEMORY` code |
| OOM skips recovery | `imageWorkerClient.test.ts` | `requestWithDocumentRecovery` does not retry on OOM |
| Blob URL tracker | `blobUrlTracker.test.ts` | `trackCreateObjectURL` increments count, `trackRevokeObjectURL` decrements, warn fires at threshold |
| Hash stability | `WebGPUPipeline.test.ts` | Same settings produce same hash; different settings produce different hash |

### Manual tests

| Scenario | Steps | Expected |
|---|---|---|
| Large file rejection | Import a 600 MB TIFF | Error message: "File is too large (600 MB)" before any decode attempt |
| GPU device loss | Open Chrome DevTools → `chrome://gpu` → kill GPU process | Toast: "GPU unavailable — using CPU rendering"; Diagnostics shows "device-lost" |
| Long editing session | Import 10 images sequentially, editing each for 2 minutes | Worker memory estimate in diagnostics stays bounded; no browser tab crash |
| Blob URL leak detection | Export 25 images rapidly | Console warning if blob URLs exceed 20 (debug build only) |
| OOM on huge image | Construct a 120 MP × 16-bit TIFF and import | Error: "Image too large for available memory" instead of generic crash |

---

## Non-Goals

These are explicitly out of scope for Phase 11:

- **Decode cache eviction** (`imageWorkerClient.ts` `decodeCache`): the current single-document model means the cache holds at most one entry. This becomes relevant in Phase 12 (multi-document tabs) and will be addressed there.
- **Geometry cache bounding**: the current `cache.clear()` on each new geometry key (line 426) means each cache holds at most one entry. This is correct for the single-document model.
- **GPU texture format changes**: no changes to `INTERMEDIATE_FORMAT` or texture pipeline topology.
- **CPU pipeline optimisations**: covered in Phase 10.
- **Worker thread pooling**: beyond current scope; single-worker model remains.
