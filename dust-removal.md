# Dust Removal — Design Spec

Film scans pick up dust, hair, and scratches from the film surface and scanner glass. This document describes a combined **auto + manual** dust removal system for DarkSlide.

---

## Overview

| Mode | What it does | When to use |
|------|-------------|-------------|
| **Auto** | Detects and inpaints bright specks/dark scratches via image analysis | First pass on every scan — catches 80–90% of common dust |
| **Manual** | User paints retouching marks over remaining spots; worker inpaints | Clean-up for marks the auto pass missed or misjudged |

Both modes run entirely in the Web Worker and are non-destructive — the original source canvas in `StoredDocument` is never mutated.

---

## 1. Data Model

### 1.1 New types (`types.ts`)

```ts
export type DustMarkSource = 'auto' | 'manual';

export interface DustMark {
  id: string;                // nanoid
  cx: number;                // center x, normalized 0–1
  cy: number;                // center y, normalized 0–1
  radius: number;            // normalized 0–1 (relative to image diagonal)
  source: DustMarkSource;    // provenance — drives separate clear actions
}

export interface DustRemovalSettings {
  autoEnabled: boolean;
  autoSensitivity: number;     // 0–100 → maps to detection threshold
  autoMaxRadius: number;       // px at source resolution, 1–30, default 8
  manualBrushRadius: number;   // px at source resolution, 2–50, default 10
  marks: DustMark[];           // auto + manual marks combined
}
```

Add to `ConversionSettings`:

```ts
dustRemoval?: DustRemovalSettings;
```

Optional field — existing sidecars/presets without it default at read time.

### 1.2 Default (`constants.ts`)

```ts
export const DEFAULT_DUST_REMOVAL: DustRemovalSettings = {
  autoEnabled: false,
  autoSensitivity: 50,
  autoMaxRadius: 8,
  manualBrushRadius: 10,
  marks: [],
};
```

### 1.3 Sidecar persistence

`DustRemovalSettings` serialises directly into `settings.dustRemoval` in the sidecar JSON. Marks use normalized 0–1 coordinates so they survive crop changes. On sidecar load, a missing `dustRemoval` field falls back to `DEFAULT_DUST_REMOVAL`.

---

## 2. Auto Detection Algorithm

### 2.1 When it runs

Detection runs **in the worker**, on the source-resolution buffer already resident in `StoredDocument.sourceCanvas`. It is triggered:

- Once on "Detect Now" button press
- Again if `autoSensitivity` or `autoMaxRadius` changes while `autoEnabled` is true

Detection does **not** re-run on every render — only inpainting does.

### 2.2 Detection pass

Operate on the **raw scan luminance** (pre-inversion). On a typical color negative scan, dust appears as bright specks against the orange film base:

1. **Extract luminance channel** — `luma[i] = 0.299 * R + 0.587 * G + 0.114 * B` (matches existing `LUMA_R/G/B` constants in `imagePipeline.ts`).

2. **Local contrast map** — compute per-pixel deviation from a box-blurred version (blur radius = `autoMaxRadius * 2`).
   `deviation[i] = abs(luma[i] - blur[i])`
   Use a two-pass separable box blur for O(n) performance regardless of radius.

3. **Threshold** — mark pixels where `deviation > threshold`.
   `threshold = lerp(0.25, 0.04, autoSensitivity / 100)`
   (higher sensitivity → lower threshold → more detections).

4. **Connected-component labeling** (4-connectivity flood fill) — group marked pixels into blobs.

5. **Filter blobs**:
   - Area ≤ `π * autoMaxRadius²` (reject large regions)
   - Aspect ratio ≤ 3.0 (keep round/oval spots, reject edges and text)
   - Mean deviation > `threshold * 1.5` (reject borderline noise)

6. **Output** — list of `DustMark` with `source: 'auto'`, bounding-circle fit for `(cx, cy, radius)`.

### 2.3 Downsampled detection for speed

For source images > 12 MP, run detection on a 2× downsampled copy (half width, half height). Scale the output mark coordinates back up. This keeps detection under 500 ms on a 50 MP scan.

### 2.4 Scratch detection (sensitivity ≥ 70, optional future extension)

At high sensitivity, additionally run a thin-line detector on the deviation map to catch linear scratches. Each detected segment is emitted as a chain of overlapping circular marks. This is **deferred to v2** — circular marks handle >90% of real-world dust.

---

## 3. Inpainting Algorithm

### 3.1 Pipeline placement

Inpainting is a **spatial pre-pass** applied to the raw RGBA `ImageData` buffer **before** `processImageData()` is called. This means:

- It operates on the raw negative scan data (pre-inversion, pre-color).
- The repaired pixels flow through the full pipeline naturally — inversion, color, curves all see clean data.
- It runs alongside the existing spatial operation pattern (similar to how `applyNoiseReduction` and `applySharpen` work, but as a pre-step rather than post-step).

In the worker's `handleRender()` / `handleExport()` paths, the call order becomes:

```
source canvas → getImageData() → applyDustRemoval() → processImageData() → ...
```

### 3.2 Inpainting method: boundary-weighted radial interpolation

For each `DustMark`:

1. Convert normalized `(cx, cy, radius)` to pixel-space bounding box.
2. Build a **soft mask** (Gaussian falloff, σ = pixelRadius / 2) defining repair strength per pixel.
3. **Sample boundary ring** — collect pixels in the annulus from `0.8 * radius` to `1.2 * radius` (outside the mark), weighted by proximity.
4. **Interpolate interior** — for each masked pixel, compute a distance-weighted average of boundary samples. Closer boundary pixels contribute more (1/d² weighting). This is simple, fast, and produces smooth results for small circular marks.
5. **Blend** — `output = lerp(original, interpolated, mask)` per pixel, per channel (R, G, B independently, preserve A).

This is simpler and faster than full Telea fast-marching and sufficient for dust spots up to ~30 px radius. If a future v2 needs large-area inpainting (e.g. scratches), Telea can replace this step.

Process marks **largest-first** so large repairs don't overwrite boundary data of smaller nearby marks.

### 3.3 Performance budget

| Image size | Marks | Target time |
|------------|-------|-------------|
| 24 MP      | 20    | < 150 ms    |
| 24 MP      | 100   | < 600 ms    |
| 50 MP      | 50    | < 500 ms    |

For preview pyramid levels (512/1024/2048), scale mark pixel coordinates proportionally — no re-detection needed.

---

## 4. Worker Protocol Integration

### 4.1 `workerProtocol.ts` — new message type

Add to the `WorkerRequest` union:

```ts
| { type: 'dust-detect'; payload: DustDetectRequest }
```

```ts
export interface DustDetectRequest {
  documentId: string;
  sensitivity: number;
  maxRadius: number;
}
```

Add to `WorkerSuccessPayload`:

```ts
| { type: 'dust-detect'; detectedMarks: DustMark[] }
```

### 4.2 `imageWorker.ts` — handler

```ts
function handleDustDetect(request: WorkerMessage<'dust-detect'>) {
  const { documentId, sensitivity, maxRadius } = request.payload;
  const doc = documents.get(documentId);
  if (!doc) { replyError(request, 'Document not loaded'); return; }

  const ctx = doc.sourceCanvas.getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, doc.sourceCanvas.width, doc.sourceCanvas.height);
  const detectedMarks = detectDustMarks(imageData, sensitivity, maxRadius);

  reply(request, { type: 'dust-detect', detectedMarks });
}
```

Add case in `self.onmessage` switch:

```ts
case 'dust-detect': handleDustDetect(msg); break;
```

### 4.3 `imageWorkerClient.ts` — public method

```ts
async detectDust(documentId: string, sensitivity: number, maxRadius: number): Promise<DustMark[]> {
  await this.ensureDocumentLoaded(documentId);
  const result = await this.requestWithDocumentRecovery(
    documentId,
    () => this.request<{ type: 'dust-detect'; detectedMarks: DustMark[] }>(
      'dust-detect',
      { documentId, sensitivity, maxRadius },
    ),
    true,
  );
  return result.detectedMarks;
}
```

Add timeout entry:

```ts
'dust-detect': 10_000,
```

### 4.4 Inpainting in the render path

No new message type needed — inpainting is applied inline during `handleRender()` and `handleExport()`. The `ConversionSettings` already carries `dustRemoval.marks`, so the worker applies `applyDustRemoval()` on the buffer before calling `processImageData()`.

---

## 5. UI

### 5.1 Sidebar tab — `DustPane.tsx`

Add `'dust'` to the sidebar tab union type in `Sidebar.tsx`. Location: between the Sharpen/NR group and Export.

```
┌─ Dust Removal ──────────────────────────┐
│                                         │
│  ── Auto Detection ──────────────────── │
│  [Toggle: Auto enabled]                 │
│  Sensitivity    ●───────────────        │
│  Max spot size  ●──────                 │
│  [Detect Now]        "Found 12 spots"   │
│  [Clear auto marks]                     │
│                                         │
│  ── Manual ──────────────────────────── │
│  [Toggle: Brush active]                 │
│  Brush radius   ●──────                │
│  Tip: click/drag to add, Alt+click to  │
│  remove. Right-click to undo last.     │
│  [Clear manual marks]                   │
│                                         │
│  ── Summary ──────────────────────────  │
│  12 auto + 3 manual marks              │
│  [Clear all]                            │
└─────────────────────────────────────────┘
```

**Component structure** (follows existing pane pattern):

```tsx
interface DustPaneProps {
  dustRemoval: DustRemovalSettings;
  onSettingsChange: (settings: DustRemovalSettings) => void;
  onDetectNow: () => void;
  isDetecting: boolean;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  brushActive: boolean;
  onBrushActiveChange: (active: boolean) => void;
}

export const DustPane = memo(function DustPane({ ... }: DustPaneProps) {
  // ...
});
```

- Reuse `Slider` for sensitivity, max radius, brush radius.
- Icons: `Sparkles` (auto), `Paintbrush` (manual), `Eraser` (clear) from `lucide-react`.
- Wrap with `motion.div` using existing `ADJUST_PANE_INITIAL/ANIMATE/EXIT` variants.

### 5.2 Brush overlay — `DustOverlay.tsx`

New overlay component, layered on the preview image (same layer strategy as `CropOverlay`).

**Coordinate system**: all `DustMark` coordinates are normalized 0–1. Conversion to/from DOM pixels follows the existing CropOverlay pattern:

```ts
// DOM → normalized
const rect = container.getBoundingClientRect();
const nx = (event.clientX - rect.left) / rect.width;
const ny = (event.clientY - rect.top) / rect.height;

// normalized → visual position
style.left = `${mark.cx * 100}%`;
style.top = `${mark.cy * 100}%`;
```

**Interactions:**
- **Hover**: circular cursor sized to `manualBrushRadius` (converted to display px via current zoom).
- **Click / drag**: create `DustMark` with `source: 'manual'`, append to `marks[]`.
- **Alt+click on mark**: remove it.
- **Drag on existing mark**: reposition it.

**Visual rendering:**
- Auto marks: semi-transparent blue circles with dashed border.
- Manual marks: semi-transparent red circles with solid border.
- Active brush cursor: dotted circle following the mouse.

Use `requestAnimationFrame` batching for drag updates (matches `CropOverlay.scheduleCropChange` pattern).

**Integration with zoom**: read current zoom/pan state from `useViewportZoom` to correctly scale the overlay and cursor size.

### 5.3 Keyboard shortcuts

Add to `useKeyboardShortcuts.ts` / `useAppShortcuts.ts`:

| Key | Action | Condition |
|-----|--------|-----------|
| `D` | Toggle dust brush mode | Image loaded, not in crop mode |
| `[` | Decrease brush radius by 2 | Brush active |
| `]` | Increase brush radius by 2 | Brush active |
| `Backspace` | Remove last manual mark | Brush active, marks exist |
| `Escape` | Deactivate brush | Brush active |

### 5.4 State lifting in `App.tsx`

Two pieces of state lifted to App level (matching the `sidebarTab` / `activePointPicker` pattern):

```ts
const [dustBrushActive, setDustBrushActive] = useState(false);
const [isDetecting, setIsDetecting] = useState(false);
```

`dustBrushActive` is mutually exclusive with crop mode and point picker — activating one deactivates the others.

---

## 6. History (Undo/Redo) Integration

Dust removal settings live inside `ConversionSettings`, so they're automatically tracked by the existing `useHistory` hook. Specific behaviors:

- **Auto-detect**: when "Detect Now" completes and merges marks into settings, this is a single `push()` to history. User can undo the entire auto-detect result in one step.
- **Manual brush click**: each click that adds a mark → `push()` (one undo step per mark).
- **Manual brush drag**: `beginInteraction()` on mousedown, accumulate marks during drag, `commitInteraction()` on mouseup. The entire stroke is one undo step.
- **Slider changes** (sensitivity, radius): follow the existing slider pattern — `beginInteraction()` on pointerdown, `commitInteraction()` on pointerup.

---

## 7. Batch Mode

In batch processing (`batchProcessor.ts`), dust removal participates as follows:

- **Auto detection**: runs per-image if `autoEnabled` is true, using the shared `autoSensitivity` / `autoMaxRadius` from the batch settings template.
- **Manual marks**: per-image only. Manual marks from the template image are **not** copied to other images (dust positions are image-specific).
- **Settings merge** in `batchSettings.ts`: `dustRemoval` settings propagate like other `ConversionSettings` fields, but `marks[]` is reset to `[]` for each batch image before auto-detect runs.

---

## 8. New Files

| File | Purpose |
|------|---------|
| `src/utils/dustDetection.ts` | `detectDustMarks()` — auto detection algorithm |
| `src/utils/dustRemoval.ts` | `applyDustRemoval()` — inpainting spatial pass |
| `src/utils/dustDetection.test.ts` | Unit tests for detection |
| `src/utils/dustRemoval.test.ts` | Unit tests for inpainting |
| `src/components/DustPane.tsx` | Sidebar panel |
| `src/components/DustOverlay.tsx` | Preview brush/mark overlay |

---

## 9. Implementation Order

| Phase | What | Depends on |
|-------|------|-----------|
| 1 | Types + constants: `DustMark`, `DustRemovalSettings`, `DEFAULT_DUST_REMOVAL` in `types.ts` / `constants.ts` | — |
| 2 | `dustRemoval.ts`: `applyDustRemoval()` inpainting function (boundary-weighted radial interpolation) | Phase 1 |
| 3 | `dustRemoval.test.ts`: test inpainting — white pixel in grey field should blend to grey | Phase 2 |
| 4 | Wire inpainting into worker render path: call `applyDustRemoval()` on buffer before `processImageData()` in `handleRender` / `handleExport` | Phase 2 |
| 5 | `dustDetection.ts`: `detectDustMarks()` algorithm | Phase 1 |
| 6 | `dustDetection.test.ts`: test detection on synthetic image with known bright spots | Phase 5 |
| 7 | Worker protocol: `dust-detect` message type in `workerProtocol.ts`, handler in `imageWorker.ts`, client method in `imageWorkerClient.ts` | Phase 5 |
| 8 | `DustPane.tsx`: sidebar panel with auto controls + detect button + manual brush toggle | Phase 7 |
| 9 | `DustOverlay.tsx`: brush cursor, mark rendering, click/drag/alt-click interactions | Phase 8 |
| 10 | State lifting in `App.tsx`: `dustBrushActive`, `isDetecting`, mutual exclusion with crop/point-picker | Phase 8–9 |
| 11 | Keyboard shortcuts: `D`, `[`, `]`, `Backspace`, `Escape` | Phase 10 |
| 12 | Sidecar: serialize/deserialize `dustRemoval` in `SidecarFile` type + read migration | Phase 1 |
| 13 | Batch integration: auto-detect per-image, reset manual marks | Phase 7 |

Phases 2–3 and 5–6 can run in parallel (inpainting and detection are independent).

---

## 10. Open Questions

- **Large marks (> 30 px)**: boundary-weighted interpolation produces visible blurriness at large radii. If users need to repair large scratches or hairs, a Telea fast-marching or PatchMatch approach would produce better results. Defer to v2 — the 30 px cap covers typical dust.
- **Film type awareness**: slide film scans have different dust appearance (dark specks on light background) vs. negatives (bright specks on dark base). Detection threshold may need per-film-type tuning. Start with a single threshold and evaluate.
- **GPU acceleration**: the inpainting loop is embarrassingly parallel per-mark. If `WebGPUPipeline` is active, the spatial pass could run as a compute shader. Defer unless CPU performance is insufficient.
- **Mark density cap**: auto-detection on a very dirty scan could produce 500+ marks, making inpainting slow. Cap at 200 auto marks and surface a "too many spots — clean your scanner" warning.
