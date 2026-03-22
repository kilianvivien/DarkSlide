# Phase 14: Smart Scanning Features — Implementation Plan

## Overview

This phase targets the camera scanning workflow — the setup where a photographer uses a digital camera + macro lens + light source to photograph film negatives. It adds five major features: auto-crop/frame detection, flat-field correction, scanning flare correction, light source profiles, and expanded film stock profiles.

**Goal**: bring DarkSlide to competitive parity with FilmLab 3.5 and SmartConvert on scanning-specific features, while keeping the architecture clean and the pipeline extensible.

**Prerequisites**: Phase 13 (Architecture Health) must be complete. This plan assumes the post-Phase 13 codebase structure throughout:
- **`App.tsx`** is decomposed (< 1,200 lines). Import, render, keyboard, and tab logic live in extracted hooks.
- **`src/hooks/useFileImport.ts`** owns the import flow (decode, preview pyramids, tab creation). All decode-time integrations (auto-crop, flare estimation) hook in here.
- **`src/hooks/useRenderQueue.ts`** owns render scheduling. Re-renders are triggered via `enqueueRender(settings, priority)`, not direct worker calls.
- **`src/hooks/useDocumentTabs.ts`** owns document state. Document updates go through `updateDoc(id, patch)`.
- **`src/hooks/useKeyboardShortcuts.ts`** owns shortcut registration via a handler map. New shortcuts are added to the map, not as standalone `useEffect` listeners.
- **`src/hooks/useEvent.ts`** provides stable callback references. New callbacks passed to child components or the worker should use `useEvent`.
- **`src/utils/workerProtocol.ts`** is the single source of truth for all worker request/response types. New message types (`detect-frame`, `load-flat-field`, `compute-flare`, etc.) are added here — not in `imageWorker.ts` or `imageWorkerClient.ts` individually.
- **Transfer lists** (13B): when sending `ArrayBuffer` payloads to the worker (e.g., flat-field data), use the transfer list pattern established in Phase 13 to avoid structured-clone copies.
- **`src/utils/math.ts`** exports `clamp()`. Any clamping in new pipeline functions imports from here.
- **`src/components/ErrorBoundary.tsx`** wraps sidebar, viewport, and modals. New UI zones (calibration tab, scanning corrections section) are automatically protected.
- **Buffered diagnostics** (13D): `appendDiagnostic()` is batched via `requestIdleCallback`. Performance timing logged from the worker uses this path.
- **`useFocusTrap`** (13E): already applied to `SettingsModal`. The new Calibration tab is automatically focus-trapped.
- **Idle-tab eviction** (13A): eviction drops preview pyramids but retains source canvas. Frame detection and flare estimation that run on the 1024-level must happen at decode time (inside `useFileImport`), before eviction can occur. Re-detection ("Re-detect frame" button) must first ensure the 1024 level is resident — if evicted, re-decode the preview pyramid.
- **4096 preview level** (13A): preview pyramids may now include a 4096 level on HiDPI. Frame detection and flare estimation always target the 1024 level specifically (by index, not "largest available") for consistent performance.

---

## 14A — Auto-Crop & Frame Detection

### Current State (Post-Phase 13)
- `CropPane.tsx` supports manual crop with aspect ratio presets (Film / Print / Social / Digital tabs), rotation spinner, and level angle slider.
- Crop stored as normalized 0–1 coordinates in `ConversionSettings.crop: { x, y, width, height, aspectRatio }`.
- Import flow lives in `useFileImport` hook — decode, preview pyramid generation, and tab creation happen there.
- Worker protocol types are centralized in `src/utils/workerProtocol.ts`.
- No frame detection logic exists anywhere in the codebase.

### Step 1: Frame Detection Algorithm — `src/utils/frameDetection.ts`

Create a new pure-function module (no DOM/worker dependencies) that operates on raw pixel data.

1. **Types** (add to `src/types.ts`):
   ```ts
   interface DetectedFrame {
     top: number;      // normalized 0–1
     left: number;
     bottom: number;
     right: number;
     angle: number;    // degrees, clamped ±5°
     confidence: number; // peak strength / σ
   }
   ```

2. **Core function**:
   ```ts
   export function detectFrame(
     pixels: Uint8ClampedArray,
     width: number,
     height: number
   ): DetectedFrame | null
   ```

3. **Algorithm steps** (all in the same function, no external deps):
   - **Grayscale conversion**: `Y = 0.299R + 0.587G + 0.114B` (BT.601 luma, matching `imagePipeline.ts`).
   - **Gradient computation**: horizontal and vertical luminance gradients using a 3×1 Sobel kernel `[-1, 0, 1]`. Operate on the grayscale buffer in-place — no need for a separate gradient image.
   - **Projection**: sum gradient magnitudes along columns (→ 1D array of length `width`) and along rows (→ 1D array of length `height`).
   - **Peak detection**: for each projection array, compute `mean` and `σ`. Scan for local maxima above `mean + 2σ`. Pick the outermost qualifying peak from each side (left/right for X projection, top/bottom for Y projection).
   - **Sub-pixel refinement**: 3-point parabolic fit on each detected peak: `x_peak = x₀ + (g[x₀-1] - g[x₀+1]) / (2 * (g[x₀-1] - 2*g[x₀] + g[x₀+1]))`.
   - **Rotation detection**: for horizontal edges, sample gradient peaks at 8 evenly-spaced columns, fit a line via least-squares. Slope → frame angle. Clamp to ±5°.
   - **Confidence**: `min(topPeakStrength, bottomPeakStrength, leftPeakStrength, rightPeakStrength) / σ`.
   - **Return `null`** if confidence < 3.0, or detected frame covers < 20% or > 98% of image area.

4. **Sprocket hole exclusion** (35mm heuristic):
   - If detected aspect ratio is within 10% of 3:2 (ratio 1.4–1.6) and one long edge's gradient projection shows periodic peaks at ~`imageWidth / 24` spacing → classify as 35mm with sprocket holes.
   - Tighten crop inward by 3% of frame height on the sprocket side.

5. **Testing** (`src/utils/frameDetection.test.ts`):
   - Create synthetic test images (e.g., white rectangle on black background with known coordinates) using `Uint8ClampedArray`.
   - Test: clean frame → exact detection within 1% tolerance.
   - Test: rotated frame (2°) → angle detected correctly.
   - Test: low-contrast frame → returns `null` (confidence below threshold).
   - Test: frame filling > 98% of image → returns `null`.
   - Test: 35mm aspect ratio with periodic edge peaks → sprocket exclusion applied.

**Performance target**: < 50 ms on 1024 px level (~1M pixels). The algorithm is O(width × height) for gradients + O(width + height) for projection/peaks.

---

### Step 2: Worker Integration

1. **Add `detect-frame` to worker protocol** (`src/utils/workerProtocol.ts`):
   - New request/response types in the shared protocol file:
     ```ts
     interface DetectFramePayload { documentId: string }
     // Add to WorkerRequest discriminated union:
     | { type: 'detect-frame'; payload: DetectFramePayload }
     // Response payload: DetectedFrame | null
     ```
   - New handler `handleDetectFrame(documentId)` in `imageWorker.ts`:
     - Read the 1024-level preview canvas (by index, not "largest") from the document cache via `getImageData()`.
     - Call `detectFrame(pixels, width, height)` from the imported module.
     - Return `DetectedFrame | null` in the response payload.
     - Log detection time via `performance.now()` → `appendDiagnostic()` (buffered, 13D).

2. **Worker client method** (`src/utils/imageWorkerClient.ts`):
   ```ts
   async detectFrame(documentId: string): Promise<DetectedFrame | null>
   ```
   Sends `{ type: 'detect-frame', payload: { documentId } }` and unwraps the response.

3. **Auto-detect on import** — in `useFileImport` hook (`src/hooks/useFileImport.ts`), after `workerClient.decode()` resolves and preview pyramids are ready, call `workerClient.detectFrame(docId)`. If a frame is detected:
   - Apply crop and angle via `updateDoc(docId, { settings: { ...settings, crop, levelAngle } })` (using the `useDocumentTabs` API).
   - Show `showTransientNotice('Frame detected — crop applied')`.
   - If detection returns `null`, show `showTransientNotice('Auto-crop skipped — manual crop available')` (subtle, dismisses quickly).

---

### Step 3: CropPane UI Updates

1. **"Re-detect frame" button** in `CropPane.tsx`:
   - Add a button with `<ScanLine size={14} />` icon (from lucide-react) + label "Re-detect frame".
   - On click: call `workerClient.detectFrame(docId)` → apply result via `updateDoc()` → `enqueueRender(settings, 'settled')`.
   - If the 1024-level preview was evicted (idle-tab eviction from 13A), the worker must re-decode the preview pyramid first. The `detectFrame` handler should check for the 1024 level and return an error code if missing, prompting the client to call `workerClient.ensurePreviewLevel(docId, 1024)` before retrying.
   - Disabled when no preview level is loaded (`!activeDoc || activeDoc.status !== 'ready'`).
   - Place it above the Done/Reset row at the bottom of the pane.
   - Wrap the click handler with `useEvent` for a stable callback reference.

2. **Auto-crop indicator**: when crop was set by auto-detection (track via a `cropSource: 'auto' | 'manual'` field on `WorkspaceDocument` or a local ref), show a small "(auto)" badge next to the crop dimensions display.

---

### Step 4: Batch Integration

1. In `runBatch()` (inside `BatchModal.tsx` or the batch processing logic):
   - After `workerClient.decode(entry)` resolves, immediately call `workerClient.detectFrame(entry.docId)`.
   - Store `DetectedFrame` on the `BatchJobEntry`.
   - Apply as initial `CropSettings` for that entry before rendering.
   - If detection fails, leave crop at full-frame (existing behavior).

2. Add a `batchAutoCrop: boolean` toggle to batch options (default `true`). When disabled, skip frame detection entirely for batch jobs.

---

## 14B — Flat-Field Correction

### Current State (Post-Phase 13)
- No flat-field logic exists in the codebase.
- `SettingsModal.tsx` has 5 tabs: general, notifications, color, shortcuts, diagnostics. Focus trapping is already applied via `useFocusTrap` (13E).
- Worker protocol is centralized in `workerProtocol.ts` with typed payloads and `default: never` exhaustiveness (13B).
- Worker stores documents in a `Map<string, DocumentCache>` at module scope, with idle-tab eviction (13A).
- Pipeline order: decode → inversion → film base → color/bw → temperature/tint → exposure → black/white point → contrast → highlight → saturation → curves.
- WebGPU pipeline has a `ProcessingUniforms` buffer (60 × 4 bytes) and source/work/output textures.

### Step 1: Flat-Field Processing — `src/utils/flatField.ts`

1. **`processFlatFieldReference`**:
   ```ts
   export function processFlatFieldReference(
     pixels: Uint8ClampedArray,
     width: number,
     height: number,
     targetSize: number // 1024
   ): Float32Array // targetSize × targetSize × 3
   ```
   - Downsample to `targetSize × targetSize` using area-averaging (not bilinear — area averaging handles high-frequency detail better for calibration).
   - Convert to per-channel float normalized to `[0, 1]`: `R_norm = R / max(R_across_all_pixels)`, same for G, B.
   - Return a `Float32Array` of length `targetSize * targetSize * 3` (RGB interleaved).

2. **`applyFlatFieldCorrection`** (CPU path):
   ```ts
   export function applyFlatFieldCorrection(
     pixels: Uint8ClampedArray,
     width: number,
     height: number,
     flatField: Float32Array,
     ffSize: number // 1024
   ): void // modifies pixels in-place
   ```
   - For each pixel `(x, y)`, compute flat-field UV: `u = x / width * ffSize`, `v = y / height * ffSize`.
   - Bilinear-sample the 3-channel flat-field at `(u, v)`.
   - Divide: `R_out = R_in / max(ff_r, 0.05)` (clamp denominator to avoid division-by-zero on dark edges).
   - Use integer-scaled fixed-point for UV interpolation to minimize float ops in the inner loop.

3. **Testing** (`src/utils/flatField.test.ts`):
   - Test uniform reference → no change to pixels.
   - Test reference with vignette pattern → pixels brightened at edges.
   - Test near-zero reference values → clamped, no NaN/Infinity.

---

### Step 2: Calibration Storage — `src/utils/calibrationStore.ts`

1. **IndexedDB wrapper** (no external dependency, raw `indexedDB` API):
   ```ts
   const DB_NAME = 'darkslide_calibration';
   const STORE_NAME = 'flatfield_profiles';

   export async function saveFlatFieldProfile(
     name: string,
     data: Float32Array,
     size: number
   ): Promise<void>

   export async function loadFlatFieldProfile(
     name: string
   ): Promise<{ data: Float32Array; size: number } | null>

   export async function deleteFlatFieldProfile(name: string): Promise<void>

   export async function listFlatFieldProfiles(): Promise<string[]>
   ```

2. **Tauri desktop path**: when `__TAURI__` is defined, use `@tauri-apps/plugin-fs` to read/write binary files in `appDataDir/calibration/` instead of IndexedDB. Abstract behind the same interface.

3. **Active profile tracking**: store the active profile name in `localStorage` under key `darkslide_active_flatfield_profile`.

---

### Step 3: Worker Integration

1. **New worker messages** — add to `src/utils/workerProtocol.ts`:
   ```ts
   interface LoadFlatFieldPayload { data: ArrayBuffer; size: number }
   // Add to WorkerRequest union:
   | { type: 'load-flat-field'; payload: LoadFlatFieldPayload }
   | { type: 'clear-flat-field'; payload: Record<string, never> }
   ```
   - `load-flat-field` handler in `imageWorker.ts`: store the `Float32Array` at module scope (`let flatFieldBuffer: Float32Array | null`).
   - `clear-flat-field` handler: set `flatFieldBuffer = null`.
   - **Transfer list** (13B pattern): when sending the flat-field `ArrayBuffer` to the worker, include it in the transfer list to avoid a 12 MB structured clone:
     ```ts
     worker.postMessage(msg, [msg.payload.data])
     ```

2. **Pipeline integration** (`imagePipeline.ts`):
   - In `processImageData()`, add flat-field correction as the **first step** — before inversion, before film base compensation, before everything.
   - Check `flatFieldBuffer !== null && settings.flatFieldEnabled` before applying.
   - Call `applyFlatFieldCorrection(pixels, width, height, flatFieldBuffer, 1024)`.
   - Use `clamp` from `src/utils/math.ts` for output clamping (not a local reimplementation).

3. **Worker client methods** (`imageWorkerClient.ts`):
   ```ts
   async loadFlatField(data: ArrayBuffer, size: number): Promise<void>
   async clearFlatField(): Promise<void>
   ```

---

### Step 4: GPU Path

1. **Flat-field texture**: in `WebGPUPipeline.ts`, add:
   - `flatFieldTexture: GPUTexture | null` — format `rgba32float`, size 1024×1024 (pad RGB→RGBA with A=1.0).
   - `flatFieldSampler: GPUSampler` — bilinear filtering.
   - Method `loadFlatFieldTexture(data: Float32Array, size: number)` to upload.
   - Method `clearFlatFieldTexture()` to destroy and null.

2. **Shader changes** (`conversion.wgsl` and `tiledRender.wgsl`):
   - Add bind group entries for `flatFieldTex: texture_2d<f32>` and `ffSampler: sampler`.
   - Add `hasFlatField: u32` to uniforms (1 when active, 0 when not).
   - Before the inversion block:
     ```wgsl
     if (uniforms.hasFlatField == 1u) {
       let uv = vec2f(f32(gid.x) / f32(dims.x), f32(gid.y) / f32(dims.y));
       let ff = textureSampleLevel(flatFieldTex, ffSampler, uv, 0.0);
       pixel.r /= max(ff.r, 0.05);
       pixel.g /= max(ff.g, 0.05);
       pixel.b /= max(ff.b, 0.05);
     }
     ```

3. **Uniform buffer expansion**: add 1 u32 (`hasFlatField`) to `ProcessingUniforms`. Current size is 60 × 4 = 240 bytes; new size 61 × 4 = 244 bytes (pad to 256 for alignment).

---

### Step 5: Settings UI — Calibration Section

1. **New tab in `SettingsModal.tsx`**: add a `'calibration'` tab (between `color` and `shortcuts`).
   - **Section: Flat-Field Profiles**:
     - Dropdown listing saved profiles from `listFlatFieldProfiles()`.
     - "Import reference image..." button — opens file picker (reuse existing file import path), decodes via worker, processes with `processFlatFieldReference()`, saves to IndexedDB, loads into worker.
     - "Rename" / "Delete" actions per profile (inline icon buttons).
     - Active profile indicator.
   - **Section: Active Profile Preview**: show a small 128×128 thumbnail of the flat-field reference (grayscale heatmap visualization) so the user can visually confirm it looks correct.

2. **Types** (add to `src/types.ts`):
   ```ts
   // Add to ConversionSettings:
   flatFieldEnabled: boolean; // default true when profile loaded, false otherwise
   ```

3. **Sidebar toggle**: in the Adjust tab (`Sidebar.tsx`), add a "Flat-field correction" toggle (visible only when a flat-field profile is active). Place it after the Film Base section, before Basic Adjustments.

4. **Status bar indicator**: when flat-field correction is active, show a `<Grid3x3 size={14} />` icon in the status bar.

5. **Defaults** (`src/constants.ts`): add `flatFieldEnabled: false` to `DEFAULT_CONVERSION_SETTINGS`.

---

### Step 6: App Startup Flow — `src/hooks/useCalibration.ts`

Extract as a dedicated hook (following the Phase 13 pattern of keeping App.tsx lean):

```ts
useCalibration(workerClient: ImageWorkerClient) => {
  activeProfile: string | null,
  isLoaded: boolean,
  loadProfile(name: string): Promise<void>,
  clearProfile(): Promise<void>,
  importReference(file: File): Promise<void>
}
```

1. On mount:
   - Read `darkslide_active_flatfield_profile` from `localStorage`.
   - If a profile name exists, load it from IndexedDB via `loadFlatFieldProfile(name)`.
   - If data exists, send to worker via `workerClient.loadFlatField(data, size)` (using transfer list).
   - Set `flatFieldEnabled: true` in default settings for new documents.

2. The hook is called in App.tsx alongside the other extracted hooks (`useRenderQueue`, `useFileImport`, `useDocumentTabs`, etc.).

---

## 14C — Scanning Flare Correction

### Current State (Post-Phase 13)
- No flare estimation logic exists.
- Pipeline currently goes: decode → inversion → film base → rest. After 14B, flat-field is inserted before inversion.
- `ConversionSettings` has no flare-related fields.
- Worker protocol in `workerProtocol.ts` with typed messages and transfer lists (13B).

### Step 1: Flare Estimation — `src/utils/flareEstimation.ts`

1. **Core function**:
   ```ts
   export function estimateFlare(
     pixels: Uint8ClampedArray,
     width: number,
     height: number
   ): [number, number, number] // [floorR, floorG, floorB] as 0–255
   ```
   - Build per-channel histograms (3 × 256 bins) in a single pass over the pixel buffer.
   - Find the 0.5th percentile for each channel: walk cumulative histogram until `cumSum >= totalPixels * 0.005`.
   - Return `[floorR, floorG, floorB]`.

2. **Performance**: O(n) time, O(1) extra memory (3 × 256 ints = 3 KB). No sorting, no allocations.

3. **Testing** (`src/utils/flareEstimation.test.ts`):
   - Uniform image (all pixels = [100, 80, 60]) → floors = [100, 80, 60].
   - Image with 1% dark pixels at [10, 5, 3] and 99% at [200, 180, 160] → floors near [10, 5, 3].
   - All-black image → floors = [0, 0, 0].

---

### Step 2: Pipeline Integration

1. **`applyFlareCorrection`** (add to `imagePipeline.ts`):
   ```ts
   function applyFlareCorrection(
     pixels: Uint8ClampedArray,
     width: number,
     height: number,
     flareFloor: [number, number, number],
     strength: number // 0–1 (slider value / 100)
   ): void // in-place
   ```
   - Per pixel: `R_out = max(0, R_in - floorR * strength)`, same for G, B.
   - Applied in `processImageData` **after flat-field correction, before inversion**. Pipeline order becomes: decode → flat-field → **flare subtraction** → inversion → film base → rest.

2. **Worker integration**:
   - Add to `src/utils/workerProtocol.ts`:
     ```ts
     interface ComputeFlarePayload { documentId: string }
     // Add to WorkerRequest union:
     | { type: 'compute-flare'; payload: ComputeFlarePayload }
     // Response payload: { floorR: number, floorG: number, floorB: number }
     ```
     Add `default: never` exhaustiveness check (13B pattern) to the worker's `onmessage` switch to catch any missing handlers at compile time.
   - Handler in `imageWorker.ts`: read 1024-level preview pixels (by index), call `estimateFlare()`, return floors.
   - **Auto-run on decode**: after the worker decodes a new document and generates preview pyramids, automatically run `estimateFlare` on the 1024-level. Include the result in the `DecodeResponse` payload as `estimatedFlare: [number, number, number] | null`. This means the `DecodeResponse` type in `workerProtocol.ts` must be extended.
   - Worker client: `async computeFlare(documentId: string): Promise<[number, number, number]>`.

3. **State storage**: add to `WorkspaceDocument`:
   ```ts
   estimatedFlare: [number, number, number] | null;
   ```
   Populated from `DecodeResponse.estimatedFlare` inside `useFileImport` after decode resolves. Stored via `updateDoc(docId, { estimatedFlare })` from the `useDocumentTabs` API.

---

### Step 3: Types & Defaults

1. **Add to `ConversionSettings`** (`src/types.ts`):
   ```ts
   flareCorrection: number; // 0–100, default 50
   ```

2. **Defaults** (`src/constants.ts`):
   - Add `flareCorrection: 50` to `DEFAULT_CONVERSION_SETTINGS`.

---

### Step 4: GPU Path

1. **Uniform additions** (`ProcessingUniforms` in `tiledRender.wgsl` and `conversion.wgsl`):
   ```wgsl
   flareFloorR: f32,
   flareFloorG: f32,
   flareFloorB: f32,
   flareStrength: f32,
   ```
   - `flareFloorR/G/B` = `estimatedFlare[0..2] / 255.0` (normalize to 0–1 for shader math).
   - `flareStrength` = `settings.flareCorrection / 100.0`.

2. **Shader code** (before the inversion block):
   ```wgsl
   pixel.r = max(pixel.r - uniforms.flareFloorR * uniforms.flareStrength, 0.0);
   pixel.g = max(pixel.g - uniforms.flareFloorG * uniforms.flareStrength, 0.0);
   pixel.b = max(pixel.b - uniforms.flareFloorB * uniforms.flareStrength, 0.0);
   ```

3. **Uniform buffer expansion**: add 4 f32 fields (16 bytes). Combined with 14B's addition, total new uniform fields so far: 5 (1 u32 for hasFlatField + 4 f32 for flare).

---

### Step 5: UI — Flare Slider

1. **Sidebar Adjust tab** (`Sidebar.tsx`):
   - Add a "Scanning Corrections" section header after Film Base and before Basic Adjustments.
   - Add a `<Slider>` for "Flare correction" (0–100, default 50, step 1).
   - The slider is always visible — flare estimation is automatic. At 0 the correction is a no-op.
   - Show the estimated flare values as a subtle label: `"Floor: R{floorR} G{floorG} B{floorB}"` below the slider (collapsed by default, expandable via an `<Info>` icon tooltip).

2. **Batch mode option**: in `BatchModal.tsx`, add:
   ```ts
   batchFlareMode: 'per-image' | 'first-frame'; // default 'per-image'
   ```
   - `'per-image'`: each batch entry uses its own `estimatedFlare` (default).
   - `'first-frame'`: the first entry's `estimatedFlare` is applied to all subsequent entries.
   - Radio buttons in the batch options section, labeled "Flare estimation: Per image / First frame (roll)".

---

## 14D — Light Source Profiles

### Current State (Post-Phase 13, Post-14B/C)
- No light source concept in the codebase.
- Film profiles are selected via a dropdown in the Sidebar.
- Pipeline has no spectral compensation step. After 14B/C, pre-inversion chain is: flat-field → flare → inversion.

### Step 1: Types & Data

1. **Add to `src/types.ts`**:
   ```ts
   interface LightSourceProfile {
     id: string;
     name: string;
     colorTemperature: number; // approximate CCT in Kelvin
     spectralBias: [number, number, number]; // relative R/G/B weights, max = 1.0
     flareCharacteristic: 'low' | 'medium' | 'high';
   }
   ```

2. **Built-in profiles** (`src/constants.ts`):
   ```ts
   export const LIGHT_SOURCE_PROFILES: LightSourceProfile[] = [
     { id: 'auto',     name: 'Auto (no correction)',        colorTemperature: 0,    spectralBias: [1, 1, 1],       flareCharacteristic: 'medium' },
     { id: 'daylight', name: 'Generic daylight LED panel',  colorTemperature: 5500, spectralBias: [1.0, 0.98, 0.95], flareCharacteristic: 'low' },
     { id: 'cs-lite',  name: 'CineStill CS-LITE',           colorTemperature: 5000, spectralBias: [1.0, 0.95, 0.88], flareCharacteristic: 'low' },
     { id: 'skier',    name: 'Skier Sunray Copy Box 3',     colorTemperature: 5600, spectralBias: [1.0, 0.97, 0.93], flareCharacteristic: 'low' },
     { id: 'valoi',    name: 'VALOI easy35 / Pluto LED',    colorTemperature: 5000, spectralBias: [1.0, 0.94, 0.87], flareCharacteristic: 'medium' },
     { id: 'kaiser',   name: 'Kaiser Slimlite Plano',       colorTemperature: 5300, spectralBias: [1.0, 0.96, 0.91], flareCharacteristic: 'low' },
     { id: 'lomo',     name: 'Lomography DigitaLIZA+ LED',  colorTemperature: 6000, spectralBias: [0.92, 0.96, 1.0], flareCharacteristic: 'medium' },
     { id: 'tablet',   name: 'iPad / tablet backlight',     colorTemperature: 6500, spectralBias: [0.88, 0.94, 1.0], flareCharacteristic: 'high' },
   ];
   ```
   - Spectral bias values are initial estimates — will need tuning against real scans from each source.

3. **Add to `WorkspaceDocument`**:
   ```ts
   lightSourceId: string | null; // null = 'auto'
   ```

4. **Persist default**: store last-used light source ID in `localStorage` under `darkslide_default_light_source`. New documents inherit this default.

---

### Step 2: Pipeline Integration

1. **CPU path** — add `applyLightSourceCorrection` to `imagePipeline.ts`:
   ```ts
   function applyLightSourceCorrection(
     pixels: Uint8ClampedArray,
     width: number,
     height: number,
     spectralBias: [number, number, number]
   ): void // in-place
   ```
   - Per pixel: `R_out = R_in / spectralBias[0]`, `G_out = G_in / spectralBias[1]`, `B_out = B_in / spectralBias[2]`.
   - The bias values are already normalized so `max(spectralBias) = 1.0`, meaning the brightest channel is untouched and others are boosted.
   - Clamp output to 0–255 using `clamp` from `src/utils/math.ts`.
   - Applied in `processImageData` **after flare subtraction, before inversion**. Full pre-inversion order: decode → flat-field → flare → **light-source** → inversion → film base → rest.

2. **GPU path** — add to uniforms:
   ```wgsl
   lightSourceBiasR: f32,
   lightSourceBiasG: f32,
   lightSourceBiasB: f32,
   ```
   - When no light source selected (or 'auto'): `[1.0, 1.0, 1.0]` (no-op).
   - Shader code (before inversion block, after flare):
     ```wgsl
     pixel.r /= uniforms.lightSourceBiasR;
     pixel.g /= uniforms.lightSourceBiasG;
     pixel.b /= uniforms.lightSourceBiasB;
     ```

3. **Flare interaction**: when a light source is first selected, set the flare slider default based on `flareCharacteristic`: `'low' → 30`, `'medium' → 50`, `'high' → 70`. Only change the slider if it's still at the previous default (don't override manual adjustments).

---

### Step 3: UI — Light Source Dropdown

1. **Sidebar Adjust tab** (`Sidebar.tsx`):
   - Add a "Light source" `<select>` dropdown in the new "Scanning Corrections" section (alongside flare slider from 14C).
   - Place it **above** the flare slider (light source affects flare default).
   - Options: all entries from `LIGHT_SOURCE_PROFILES` by name.
   - On change: call `updateDoc(docId, { lightSourceId })` (via `useDocumentTabs` API), adjust flare default if applicable, then `enqueueRender(settings, 'settled')` (via `useRenderQueue`). Wrap the handler with `useEvent` for stable reference.

2. **Custom light source**: the last option in the dropdown is "Custom...". Selecting it opens a small inline form:
   - Color temperature input (number, K).
   - R / G / B bias sliders (0.5–1.5, default 1.0).
   - Flare characteristic radio (low / medium / high).
   - "Save" button stores as a custom entry in `localStorage` under `darkslide_custom_light_sources`.

---

## 14E — Expanded Film Stock Profiles

### Current State
- 11 built-in profiles in `constants.ts`: 4 B&W (generic-bw, hp5, tri-x, delta-3200) + 7 color (generic-color, portra-400, portra-160, ektar-100, gold-200, fuji-400h, superia-400, cinestill-800t).
- Each profile has `defaultSettings`, optional `maskTuning`, `colorMatrix`, `tonalCharacter`.
- No `filmType` field — all profiles assume negative film.
- Presets pane shows a flat list with Built-in / Custom tab switcher.

### Step 1: Add `filmType` to Profile Structure

1. **Update `FilmProfile` type** (`src/types.ts`):
   ```ts
   filmType: 'negative' | 'slide'; // default 'negative'
   ```

2. **Pipeline change** (`imagePipeline.ts`):
   - When `filmType === 'slide'`, **skip the inversion step entirely**.
   - Still apply: color correction, film base compensation (skip if no sample), temperature/tint, exposure, contrast, curves, sharpen, noise reduction.
   - This is a single `if` guard around the inversion block — minimal code change.

3. **GPU path**: add `isSlide: u32` to `ProcessingUniforms`. When `isSlide == 1u`, skip the `pixel.rgb = 1.0 - pixel.rgb` line in the shader.

---

### Step 2: New Profiles

Add 22 new profiles to `FILM_PROFILES` in `constants.ts`. Each profile needs: `id`, `name`, `category` (new field), `filmType`, `defaultSettings` overrides, `maskTuning`, `colorMatrix`, `tonalCharacter`.

**New color negative profiles (14):**

| ID | Name | Category | Notes |
|---|---|---|---|
| `ultramax-400` | Kodak UltraMax 400 | Kodak | Saturated consumer stock |
| `colorplus-200` | Kodak ColorPlus 200 | Kodak | Warm budget stock |
| `gold-100` | Kodak Gold 100 | Kodak | Fine grain, warm |
| `portra-800` | Kodak Portra 800 | Kodak | High-speed portrait |
| `pro-image-100` | Kodak Pro Image 100 | Kodak | Tropical-market pro stock |
| `vision3-250d` | Kodak Vision3 250D | Kodak | Cinema daylight stock |
| `vision3-500t` | Kodak Vision3 500T | Kodak | Cinema tungsten stock |
| `fuji-c200` | Fujifilm C200 | Fuji | Budget consumer |
| `superia-xtra-400` | Fuji Superia X-TRA 400 | Fuji | Updated formulation |
| `pro-160ns` | Fuji Pro 160NS | Fuji | Natural skin tones |
| `cinestill-50d` | CineStill 50D | CineStill | Vision3 50D sans remjet |
| `cinestill-400d` | CineStill 400D | CineStill | Vision3 250D pushed |
| `lomo-400` | Lomography CN 400 | Lomography | Saturated, contrasty |
| `lomo-800` | Lomography CN 800 | Lomography | Grainy, punchy |

**New slide (positive) profiles (2):**

| ID | Name | Category | Notes |
|---|---|---|---|
| `velvia-50` | Fuji Velvia 50 | Fuji | Ultra-saturated slide |
| `provia-100f` | Fuji Provia 100F | Fuji | Neutral slide |

**New B&W profiles (4):**

| ID | Name | Category | Notes |
|---|---|---|---|
| `tmax-100` | Kodak T-Max 100 | Kodak | Tabular grain, fine |
| `tmax-400` | Kodak T-Max 400 | Kodak | Tabular grain, versatile |
| `fp4` | Ilford FP4 Plus | Ilford | Classic medium-speed |
| `panf-50` | Ilford Pan F Plus 50 | Ilford | Ultra-fine grain |

**Omitted from plan-next.md list**: Agfa Vista 200 (discontinued, minimal demand), Ektar 25 (extremely rare). Can add later if requested.

**Profile values**: initial `colorMatrix`, `tonalCharacter`, and `maskTuning` values should be derived from published characteristic curves (Kodak/Fuji datasheets) and iteratively tuned against sample scans. Start with reasonable estimates based on the stock's known character (warm/cool, saturated/neutral, contrasty/flat) and refine.

---

### Step 3: Profile Categories in UI

1. **Add `category` field to `FilmProfile`** (`src/types.ts`):
   ```ts
   category: 'Kodak' | 'Fuji' | 'Ilford' | 'CineStill' | 'Lomography' | 'Generic';
   ```

2. **Update existing profiles**: assign categories to all 11 existing profiles.

3. **PresetsPane.tsx changes**:
   - In the Built-in tab, group profiles by `category`.
   - Each group is a collapsible section with the manufacturer name as header.
   - Within each group, negative and slide profiles are visually distinguished (slide profiles get a `<Film size={12} />` icon or "(slide)" suffix).
   - Group order: Generic → Kodak → Fuji → Ilford → CineStill → Lomography.
   - Maintain the existing search/filter functionality — search matches against profile name, category, and film type.

---

## Implementation Order & Dependencies

The five sub-phases have the following dependency graph:

```
14A (Auto-crop) ──────────────────────────────────────── independent
14B (Flat-field) ─────────────────────────────────────── independent
14C (Flare) ──────────────── depends on 14B pipeline slot (flat-field runs first)
14D (Light source) ────────── depends on 14C pipeline slot (flare runs first)
14E (Expanded profiles) ──── depends on 14D for slide film support
```

**Recommended build sequence:**

| Order | Sub-phase | Rationale |
|-------|-----------|-----------|
| 1 | **14A** — Auto-crop | Self-contained, no pipeline changes, highest user-impact |
| 2 | **14E** — Expanded profiles | Mostly data entry + minor type/UI changes, parallelizable with 14A |
| 3 | **14B** — Flat-field | Establishes the pre-inversion pipeline slot pattern |
| 4 | **14C** — Flare | Slots in after flat-field, builds on the same pattern |
| 5 | **14D** — Light source | Slots in after flare, completes the pre-inversion chain |

14A and 14E can be built in parallel since they touch different files. 14B/C/D must be sequential because each extends the pipeline in order.

---

## Updated Pipeline Order (After Phase 14)

```
decode
  → flat-field correction (14B)      [new, pre-inversion]
  → flare subtraction (14C)          [new, pre-inversion]
  → light-source correction (14D)    [new, pre-inversion]
  → inversion (skip if slide film)   [modified for 14E]
  → film-base compensation
  → color matrix / film profile
  → color balance
  → temperature / tint
  → B&W conversion
  → exposure
  → black / white point
  → contrast
  → tonal character
  → saturation
  → B&W tone
  → curves
  → sharpen
  → noise reduction
```

---

## New Files Created

| File | Sub-phase | Purpose |
|------|-----------|---------|
| `src/utils/frameDetection.ts` | 14A | Frame detection algorithm |
| `src/utils/frameDetection.test.ts` | 14A | Tests |
| `src/utils/flatField.ts` | 14B | Flat-field processing & correction |
| `src/utils/flatField.test.ts` | 14B | Tests |
| `src/utils/calibrationStore.ts` | 14B | IndexedDB wrapper for calibration data |
| `src/hooks/useCalibration.ts` | 14B | Flat-field profile loading/management hook |
| `src/utils/flareEstimation.ts` | 14C | Histogram-based flare estimation |
| `src/utils/flareEstimation.test.ts` | 14C | Tests |

## Modified Files

| File | Sub-phases | Changes |
|------|------------|---------|
| `src/types.ts` | All | `DetectedFrame`, `LightSourceProfile`, `filmType`, `category`, `flatFieldEnabled`, `flareCorrection`, `estimatedFlare`, `lightSourceId` |
| `src/constants.ts` | 14C, 14D, 14E | New defaults, light source profiles, 22 new film profiles |
| `src/utils/workerProtocol.ts` | 14A, 14B, 14C | New message types: `detect-frame`, `load-flat-field`, `clear-flat-field`, `compute-flare`; extended `DecodeResponse` |
| `src/utils/imagePipeline.ts` | 14B, 14C, 14D, 14E | 3 new pre-inversion steps, slide film skip |
| `src/utils/imageWorker.ts` | 14A, 14B, 14C | Handler implementations for new protocol messages |
| `src/utils/imageWorkerClient.ts` | 14A, 14B, 14C | Client methods for new protocol messages |
| `src/hooks/useFileImport.ts` | 14A, 14C | Auto-detect frame + auto-estimate flare after decode |
| `src/utils/gpu/WebGPUPipeline.ts` | 14B, 14C, 14D, 14E | Flat-field texture, new uniforms, shader bind groups |
| `src/utils/gpu/shaders/conversion.wgsl` | 14B, 14C, 14D, 14E | Flat-field sample, flare subtraction, light source division, slide skip |
| `src/utils/gpu/shaders/tiledRender.wgsl` | 14B, 14C, 14D, 14E | Same as above (tiled path) |
| `src/components/Sidebar.tsx` | 14C, 14D | "Scanning Corrections" section with flare slider + light source dropdown |
| `src/components/CropPane.tsx` | 14A | "Re-detect frame" button |
| `src/components/PresetsPane.tsx` | 14E | Category grouping, slide film indicator |
| `src/components/SettingsModal.tsx` | 14B | New "Calibration" tab for flat-field profiles |
| `src/components/BatchModal.tsx` | 14A, 14C | Auto-crop toggle, flare mode radio |

---

## Uniform Buffer Layout (After Phase 14)

New fields appended to `ProcessingUniforms` (all sub-phases combined):

| Field | Type | Sub-phase | Notes |
|-------|------|-----------|-------|
| `hasFlatField` | `u32` | 14B | 0 or 1 |
| `flareFloorR` | `f32` | 14C | Normalized 0–1 |
| `flareFloorG` | `f32` | 14C | Normalized 0–1 |
| `flareFloorB` | `f32` | 14C | Normalized 0–1 |
| `flareStrength` | `f32` | 14C | 0–1 |
| `lightSourceBiasR` | `f32` | 14D | 1.0 = no correction |
| `lightSourceBiasG` | `f32` | 14D | 1.0 = no correction |
| `lightSourceBiasB` | `f32` | 14D | 1.0 = no correction |
| `isSlide` | `u32` | 14E | 0 or 1 |

Total new: 9 fields × 4 bytes = 36 bytes. Current buffer: 240 bytes → new: 276 bytes (pad to 288 for 16-byte alignment).

---

## Testing Strategy

- **Unit tests**: all three new utility modules (`frameDetection`, `flatField`, `flareEstimation`) are pure functions operating on `Uint8ClampedArray` / `Float32Array` — fully testable with synthetic data via Vitest.
- **Integration tests**: worker message round-trips can be tested by spawning the worker in a test harness and verifying response payloads.
- **Visual verification**: after each sub-phase, manually test with real camera scans (35mm and medium format) to validate detection accuracy, correction quality, and profile rendering.
- **Performance benchmarks**: add `performance.now()` timing in the worker for `detectFrame`, `estimateFlare`, and `applyFlatFieldCorrection`. Log to diagnostics panel. Target: < 50 ms each on 1024 px level.
