# Zoom & Pan Smoothness Improvements

Analysis based on live debug telemetry and code review of the current implementation.

---

## Issues Identified from Debug Telemetry

### 1. Zoom-Out Cascade: Redundant Full-Resolution Settled Renders

**Observed**: Zooming out from 100% triggers a staircase of settled renders at decreasing `targetMaxDimension` values (6048 → 4351 → 3172 → 2569 → 2081 → 1686), each hitting `preview-source` (6048×4032) or `preview-4096`. Each render takes 1–3s total.

**Root cause**: `fullRenderTargetDimension` recalculates on every `zoom` state change (`App.tsx:335-343`). Each discrete zoom step produces a new target dimension, which triggers a new settled render — even though the user is still mid-gesture.

**Fix**: Add hysteresis to `fullRenderTargetDimension`. Only recalculate the effective render target when the zoom level crosses a pyramid level boundary by a meaningful margin (e.g., 10%). This prevents re-rendering when the target dimension changes but still maps to the same preview level.

```typescript
// Instead of recalculating on every zoom tick:
const effectiveTarget = Math.ceil((targetMaxDimension * z) / Math.max(fitScale, 0.0001));

// Add hysteresis: only change when we actually cross a pyramid level
const prevLevelRef = useRef<string | null>(null);
const selectedLevel = selectPreviewLevel(previewLevels, effectiveTarget);
if (prevLevelRef.current === selectedLevel.id && !interactionJustEnded) {
  return previousRenderTarget; // skip re-render
}
prevLevelRef.current = selectedLevel.id;
```

---

### 2. Canvas `drawImage` Bottleneck at Source Resolution

**Observed**: GPU tile job at source resolution completes in 362–549ms, but `RENDER_COMPLETED` arrives 2–3s later. The gap is the canvas `drawImage` / `putImageData` call for a 4032×6048 image.

**Example from telemetry**:
- `GPU_TILE_JOB_COMPLETED` at `16:09:45.428` (484ms job)
- `RENDER_COMPLETED` at `16:09:47.788` — **2.36s** just to draw to canvas

**Fix**: Use `OffscreenCanvas` with `createImageBitmap` for the final draw. `createImageBitmap` decodes asynchronously and `drawImage(imageBitmap)` is GPU-accelerated, eliminating the main-thread stall from `putImageData`.

```typescript
// Current (slow): putImageData of full RGBA buffer
ctx.putImageData(imageData, 0, 0);

// Proposed (fast): create bitmap in worker, transfer, draw
const bitmap = await createImageBitmap(imageData);
ctx.drawImage(bitmap, 0, 0);
bitmap.close();
```

For even better results, do the `createImageBitmap` call inside the Web Worker and transfer the `ImageBitmap` (it's transferable) — this moves the decode cost entirely off the main thread.

---

### 3. ZoomBar Button Clicks Bypass Draft Mode

**Observed**: `isZooming` is only set to `true` by the wheel handler (`App.tsx:271-287`). When using ZoomBar buttons (`zoomIn`/`zoomOut`/`zoomTo100`), `isZooming` remains `false`, so every click triggers an immediate **settled** render at full resolution.

**Fix**: Wrap ZoomBar discrete zoom actions in the same `isZooming` flag with a short idle timeout:

```typescript
const zoomInWithDraft = useCallback(() => {
  zoomIn();
  if (!isZoomingRef.current) {
    isZoomingRef.current = true;
    setIsZooming(true);
  }
  clearTimeout(zoomIdleTimeoutRef.current);
  zoomIdleTimeoutRef.current = setTimeout(() => {
    isZoomingRef.current = false;
    interactionJustEndedRef.current = true;
    setIsZooming(false);
  }, 300); // slightly longer than wheel (200ms) for click sequences
}, [zoomIn]);
```

---

### 4. Wheel Handler Triggers Two React State Updates Per Tick

**Observed**: `handleWheel` in `useViewportZoom.ts:85-105` calls both `setZoom()` and `setPan()` sequentially. While React 18+ batches these within the same event handler, the zoom state change propagates through `fullRenderTargetDimension` → `renderTargetDimension` → render effect, causing unnecessary dependency chain re-evaluations.

**Fix**: Store zoom in a ref during the gesture and only commit to React state when the gesture ends (same pattern as pan). This eliminates per-tick React re-renders during wheel zoom:

```typescript
const liveZoomRef = useRef<number>(1);

const handleWheel = useCallback((deltaY, normX, normY) => {
  const current = liveZoomRef.current;
  const factor = deltaY < 0 ? 1.1 : 0.9;
  liveZoomRef.current = clampZoom(current * factor);

  // Apply CSS transform directly via ref (like pan does)
  applyZoomTransform(liveZoomRef.current, livePanRef.current);
}, []);

const endZoom = useCallback(() => {
  setZoom(liveZoomRef.current); // single React commit
  setPan(livePanRef.current);
}, []);
```

This is the **highest-impact change** — it turns N React renders per zoom gesture into exactly 1.

---

### 5. Excessive Job Cancellations During Zoom

**Observed**: Revisions jump from 9 → 44 (35 cancelled) and 44 → 60 (16 cancelled) during zoom gestures. Each cancelled job still has overhead: message serialization to worker, GPU pipeline setup, abort signal processing.

**Fix**: When `ultraSmoothDragEnabled` is true and zooming, the code already skips worker renders (`App.tsx:894-896`). But when it's false ("balanced" mode), every RAF frame enqueues a draft render that immediately gets cancelled by the next. Add a **minimum interval** between draft render submissions during zoom:

```typescript
const lastDraftSubmitRef = useRef(0);
const DRAFT_MIN_INTERVAL_MS = 80; // ~12fps for draft renders

if (interactivePreviewFrameRef.current === null) {
  const now = performance.now();
  if (now - lastDraftSubmitRef.current < DRAFT_MIN_INTERVAL_MS) return;
  lastDraftSubmitRef.current = now;
  interactivePreviewFrameRef.current = requestAnimationFrame(() => { ... });
}
```

---

### 6. Pan Geometry Recalculated in Render Function

**Observed**: `AppShell.tsx:634-650` computes pan geometry inside the `style` prop callback, which runs on every React render. The `panGeometryRef.current` assignment inside a render function is a side effect during render.

**Fix**: Move geometry sync to a `useEffect` or `useLayoutEffect`, and memoize the transform style:

```typescript
useLayoutEffect(() => {
  panGeometryRef.current = {
    imageWidth: logicalPreviewSize.width,
    imageHeight: logicalPreviewSize.height,
    viewportWidth: viewportRef.current?.clientWidth ?? 1,
    viewportHeight: viewportRef.current?.clientHeight ?? 1,
    effectiveZoom,
  };
}, [logicalPreviewSize, effectiveZoom]);
```

---

### 7. Missing `passive: false` on Wheel Listener

**Observed**: The wheel handler in `AppShell.tsx:562-568` uses React's `onWheel` which is passive by default in React 18+. Calling `event.preventDefault()` in a passive listener is a no-op and generates console warnings. The browser may still scroll the page.

**Fix**: Use a native event listener with `{ passive: false }`:

```typescript
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const handler = (e: WheelEvent) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;
    onHandleZoomWheel(e.deltaY, normX, normY);
  };
  el.addEventListener('wheel', handler, { passive: false });
  return () => el.removeEventListener('wheel', handler);
}, [onHandleZoomWheel]);
```

---

## Priority Ranking

| # | Fix | Impact | Effort |
|---|-----|--------|--------|
| 4 | Ref-based zoom during gesture (skip React re-renders) | Very High | Medium |
| 2 | `createImageBitmap` for canvas draw | High | Low |
| 1 | Pyramid level hysteresis | High | Low |
| 3 | ZoomBar buttons use draft mode | Medium | Low |
| 7 | Native wheel listener with `passive: false` | Medium | Low |
| 5 | Draft render minimum interval | Medium | Low |
| 6 | Move geometry sync out of render | Low | Low |

---

## Summary

The two biggest wins are:

1. **Ref-based zoom** (#4): Eliminates per-tick React re-renders during wheel zoom. The CSS transform updates via direct DOM manipulation (like pan already does), and React state only commits once when the gesture ends. This alone should make wheel zoom feel native.

2. **`createImageBitmap` transfer** (#2): The 2.3s gap between GPU job completion and render completion is the canvas draw stalling the main thread. Moving to `ImageBitmap` transfer from the worker eliminates this entirely.

Together these should reduce perceived zoom latency from ~3s to near-instant during the gesture, with a single high-quality settled render when the user stops.
