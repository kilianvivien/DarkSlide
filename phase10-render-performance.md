# Phase 10: Render Performance — Implementation Plan

## Overview

Phase 10 ships three independent workstreams that improve interactive editing responsiveness and export quality. All changes are low-risk refactors with measurable impact, particularly on large scans (24–120 MP).

| Workstream | Scope | Risk | Expected Impact |
|---|---|---|---|
| A. React rendering efficiency | 6 files | Low | Fewer unnecessary re-renders during slider drags |
| B. CPU pipeline optimisations | 2 files | Low | 5–15% faster per-frame CPU render time |
| C. EXIF metadata preservation | 8 files, 1 new dep | Medium | Exported images carry orientation, date, software tag |

---

## Workstream A: React Rendering Efficiency

### Current Problem

No component uses `React.memo`. Every slider drag replaces the entire `ConversionSettings` object in App state, which triggers a full re-render of:
- `Sidebar` (all 27 `Slider` children, even unchanged ones)
- `CropPane` (receives full `settings` object)
- `CropOverlay` (if visible)
- `CurvesControl` (curves sub-object)
- `Histogram` (histogram data updates independently)

Additional waste: 27 inline `onChange` closures in Sidebar, inline motion animation objects, inline style objects in Histogram, and inline arrow functions passed from App to Sidebar.

### A1. `React.memo` boundaries

Wrap the following components with `React.memo()`:

| Component | File | Why it helps |
|---|---|---|
| `Sidebar` | `src/components/Sidebar.tsx` | Helps on tab-only or parent-layout updates, but the bigger win comes from memoized children and narrower props |
| `Histogram` | `src/components/Histogram.tsx` | Only needs to re-render when `data` changes, not on every settings update |
| `CurvesControl` | `src/components/CurvesControl.tsx` | Only depends on `curves` sub-object and its callbacks |
| `CropOverlay` | `src/components/CropOverlay.tsx` | Only depends on `crop`, image dimensions, and callbacks |
| `CropPane` | `src/components/CropPane.tsx` | Only depends on crop-related settings, not tone/color |
| `Slider` | `src/components/Slider.tsx` | Each slider only depends on its own `value` and `onChange` |

**Implementation per component:**

```tsx
// Before
export default function Histogram({ data }: Props) { ... }

// After
import { memo } from 'react';
export default memo(function Histogram({ data }: Props) { ... });
```

For `Slider`, since it receives an `onChange` callback, memoization only helps if the callback is referentially stable (see A2).

### A2. Stabilize callbacks passed to memoized children

**In `Sidebar.tsx`** — stabilize the callbacks that feed memoized leaves:

Currently each slider gets a fresh inline callback such as `onChange={(value) => onSettingsChange({ exposure: value })}`, which defeats `React.memo` on `Slider`.

Do not model this as one generic `keyof ConversionSettings` handler map. The current sidebar has three distinct update shapes:

1. **Scalar settings** — `exposure`, `contrast`, `blackPoint`, `whitePoint`, `highlightProtection`, `saturation`, `temperature`, `tint`, `redBalance`, `greenBalance`, `blueBalance`
2. **Nested settings** — `blackAndWhite`, `sharpen`, `noiseReduction`
3. **Export options** — `quality` uses `onExportOptionsChange`, not `onSettingsChange`

Recommended pattern:

```tsx
const handleExposureChange = useCallback(
  (value: number) => onSettingsChange({ exposure: value }),
  [onSettingsChange],
);

const handleBlackAndWhiteEnabledChange = useCallback(
  (enabled: boolean) => onSettingsChange({
    blackAndWhite: { ...settings.blackAndWhite, enabled },
  }),
  [onSettingsChange, settings.blackAndWhite],
);

const handleExportQualityChange = useCallback(
  (value: number) => onExportOptionsChange({ quality: value / 100 }),
  [onExportOptionsChange],
);
```

For the scalar settings, a factory helper is fine:

```tsx
const createScalarSliderHandler = useCallback(
  (key: keyof ConversionSettings) => (value: number) => {
    onSettingsChange({ [key]: value } as Partial<ConversionSettings>);
  },
  [onSettingsChange],
);
```

But restrict it to the scalar numeric keys only. Do not use it for nested settings or export options.

Since the slider keys are static, a memoized handler map is still reasonable:

```tsx
const handlers = useMemo(() => {
  const keys = ['exposure', 'contrast', 'blackPoint', 'whitePoint', 'highlightProtection', 'saturation', 'temperature', 'tint', 'redBalance', 'greenBalance', 'blueBalance'] as const;
  const map: Record<string, (v: number) => void> = {};
  for (const key of keys) {
    map[key] = (value: number) => onSettingsChange({ [key]: value } as Partial<ConversionSettings>);
  }
  return map;
}, [onSettingsChange]);
// Usage: onChange={handlers.exposure}
```

**In `App.tsx`** — inline arrow functions passed to Sidebar:

```tsx
// Current (new reference every render):
onTogglePicker={() => setIsPickingFilmBase((current) => !current)}
onExport={() => void handleDownload()}
onOpenSettings={() => setShowSettingsModal(true)}

// Replace with useCallback:
const handleTogglePicker = useCallback(
  () => setIsPickingFilmBase((c) => !c), []
);
const handleExportClick = useCallback(
  () => void handleDownload(), [handleDownload]
);
const handleOpenSettings = useCallback(
  () => setShowSettingsModal(true), []
);
```

### A3. Eliminate inline objects

**`Sidebar.tsx`** — motion animation config objects:

Extract the 4 sets of motion `initial`/`animate`/`exit` objects to module-level constants:

```tsx
// Top of file, outside component
const PANE_INITIAL = { opacity: 0, x: -10 };
const PANE_ANIMATE = { opacity: 1, x: 0 };
const PANE_EXIT = { opacity: 0, x: 10 };
```

**`Sidebar.tsx`** — point picker array:

The `[{ mode: 'black', ... }, { mode: 'grey', ... }, { mode: 'white', ... }]` array (lines 309–327) is recreated every render. Hoist to module-level constant.

**`Histogram.tsx`** — inline `style={{ mixBlendMode: 'screen' }}`:

Extract to a module-level constant:

```tsx
const BLEND_SCREEN = { mixBlendMode: 'screen' as const };
```

**`CurvesControl.tsx`** — `channelColors` object:

Move from inside the component body to module-level constant.

**`CurvesControl.tsx`** — SVG grid calculations:

Wrap the grid line positions (`size/4`, `size/2`, `3*size/4`) in a `useMemo` keyed on `size`.

### A4. Settings segmentation (deferred or minimal)

The plan calls for splitting `ConversionSettings` into smaller slices (color, tone, spatial). This is a significant refactor that touches every component, the worker protocol, and the undo system. Given the risk/reward:

**Recommended approach:** Do NOT split the `ConversionSettings` type itself. Instead, rely on `React.memo` + stable callbacks (A1–A3) to achieve the same render-skipping benefit with far less churn. The memo boundaries already ensure that:
- `CropPane` only re-renders when crop-related props change (if we pass `settings.crop` instead of the full `settings`)
- `CurvesControl` only re-renders when `settings.curves` changes
- `Histogram` only re-renders when `histogramData` changes

**Minimal segmentation:** In Sidebar, instead of passing the full `settings` object down, destructure and pass only what each pane needs:

```tsx
// CropPane only needs crop settings
<CropPane crop={settings.crop} rotation={settings.rotation} ... />

// CurvesControl already receives only curves
<CurvesControl curves={settings.curves} ... />
```

This gives CropPane and CurvesControl stable props across unrelated changes when combined with `React.memo`.

### A — Files Changed

| File | Changes |
|---|---|
| `src/components/Sidebar.tsx` | Wrap with `memo`, memoize slider callbacks, hoist inline objects |
| `src/components/Histogram.tsx` | Wrap with `memo`, extract inline style |
| `src/components/CurvesControl.tsx` | Wrap with `memo`, hoist `channelColors`, memoize grid |
| `src/components/CropOverlay.tsx` | Wrap with `memo` |
| `src/components/CropPane.tsx` | Wrap with `memo`, receive narrower props |
| `src/components/Slider.tsx` | Wrap with `memo` |
| `src/App.tsx` | Replace inline arrow props with `useCallback` |

### A — Testing

- Run existing test suite (`npm run test`) — no behavioral change expected.
- Manual test: open a large scan, drag exposure slider, confirm sidebar doesn't flash-re-render the crop tab content or histogram during drag.
- Optional: add React DevTools profiler recording before/after to quantify render count reduction.

---

## Workstream B: CPU Pipeline Optimisations

### Current Problem

The `processImageData` hot loop in `imagePipeline.ts` processes every pixel through ~12 sequential operations. Three specific redundancies can be eliminated.

### B1. Grayscale deduplication

**Current state:** Luminance (`0.299 * r + 0.587 * g + 0.114 * b`) is computed in multiple places:

1. **`processImageData` line ~567**: saturation step (color mode) — computes `gray` to blend with saturated values
2. **`processImageData` line ~572**: B&W tone step — computes `gray` again in else branch
3. **`accumulateHistogram` line ~393**: luminance channel binning — recomputes on final pixel values
4. **`applyNoiseReduction` lines ~455–456**: computes luminance of both original and blurred pixels

**Fix for the main loop (lines 566–576):**

The saturation step and the B&W tone step are mutually exclusive branches of the same `if/else`. However, in both branches, `gray` is computed identically. Hoist the computation above the branch:

```typescript
// Before (two branches, two gray computations):
if (isColor && !effectiveSettings.blackAndWhite.enabled) {
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  r = gray + (r - gray) * saturationFactor;
  ...
} else {
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  [r, g, b] = shouldUseBlackAndWhite ? applyBlackAndWhiteTone(gray, ...) : [gray, gray, gray];
}

// After (one gray computation):
const gray = 0.299 * r + 0.587 * g + 0.114 * b;
if (isColor && !effectiveSettings.blackAndWhite.enabled) {
  r = gray + (r - gray) * saturationFactor;
  ...
} else {
  [r, g, b] = shouldUseBlackAndWhite ? applyBlackAndWhiteTone(gray, ...) : [gray, gray, gray];
}
```

This saves one multiply-add triplet per pixel (~5% of per-pixel cost for a 40 MP scan).

**Also:** Extract the luma coefficients to module-level constants:

```typescript
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
```

Replace all 5+ occurrences across `processImageData`, `accumulateHistogram`, and `applyNoiseReduction`.

### B2. LUT consolidation

**Current state (lines ~490–493, 582–584):**

```typescript
// Built once per render call:
const lutRGB = createCurveLut(effectiveSettings.curves.rgb);     // 256 entries
const lutR   = createCurveLut(effectiveSettings.curves.red);     // 256 entries
const lutG   = createCurveLut(effectiveSettings.curves.green);   // 256 entries
const lutB   = createCurveLut(effectiveSettings.curves.blue);    // 256 entries

// Applied per pixel (chained lookup):
r = lutR[lutRGB[mappedR]] / 255;
g = lutG[lutRGB[mappedG]] / 255;
b = lutB[lutRGB[mappedB]] / 255;
```

Each pixel performs 6 array lookups (3 into `lutRGB`, then 3 into `lutR`/`lutG`/`lutB`) plus 3 divisions. The chained indexing (`lutR[lutRGB[x]]`) creates a data dependency that prevents CPU pipelining of the lookup.

**Fix:** Pre-fuse the RGB master curve with each per-channel curve into 3 combined LUTs:

```typescript
const lutRGB = createCurveLut(effectiveSettings.curves.rgb);
const lutRBase = createCurveLut(effectiveSettings.curves.red);
const lutGBase = createCurveLut(effectiveSettings.curves.green);
const lutBBase = createCurveLut(effectiveSettings.curves.blue);

// Fused LUTs: combine RGB master → per-channel in one table
const fusedR = new Float32Array(256);
const fusedG = new Float32Array(256);
const fusedB = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  fusedR[i] = lutRBase[lutRGB[i]] / 255;
  fusedG[i] = lutGBase[lutRGB[i]] / 255;
  fusedB[i] = lutBBase[lutRGB[i]] / 255;
}

// Per pixel (3 independent lookups, no chain):
r = fusedR[mappedR];
g = fusedG[mappedG];
b = fusedB[mappedB];
```

Benefits:
- Reduces per-pixel lookups from 6 to 3 (one per channel)
- Eliminates the `/ 255` per pixel (baked into the LUT)
- Removes data dependency between RGB and per-channel lookups
- LUT construction cost is negligible (768 iterations once per render vs millions of pixels)

Use `Float32Array` for the fused LUTs since the rest of the pipeline operates in float space.

### B3. Geometry cache granularity

**Current state** (`imageWorker.ts`):

The geometry cache key includes `crop`, `rotation`, and `levelAngle` together. When any geometry parameter changes, `cache.clear()` wipes all entries — even if only crop changed and the rotation result could be reused.

```typescript
// Current: single cache key containing all geometry
function createGeometryCacheKey(...) {
  return JSON.stringify({
    sourceKind, previewLevelId,
    crop, rotation, levelAngle,
  });
}

// On miss: clear entire cache
cache.clear();
cache.set(geometryCacheKey, storedJob);
```

**Fix:** Split geometry processing into two stages with independent caches:

```typescript
interface StoredDocument {
  // ... existing fields
  rotationCache: Map<string, OffscreenCanvas>;  // rotation+level result
  cropCache: Map<string, StoredTileJob>;         // crop of rotated canvas
}
```

**Stage 1 — Rotation cache:**
- Key: `JSON.stringify({ sourceKind, previewLevelId, rotation, levelAngle })`
- Value: rotated `OffscreenCanvas` (no crop applied)
- Invalidation: only when `rotation` or `levelAngle` changes

**Stage 2 — Crop cache:**
- Key: `JSON.stringify({ sourceKind, previewLevelId, rotation, levelAngle, crop })`
- Value: final `StoredTileJob` (crop applied to the rotated canvas)
- Invalidation: when any geometry parameter changes (but rotation cache survives)

This means during a crop drag (the most common geometry interaction), the rotation cache is preserved. The crop stage reads from the cached rotated canvas instead of re-rotating the source.

**Cache eviction policy:** Keep at most 2 entries per cache level (current + previous) to bound memory. Since preview and source use separate caches, total entries are capped at 4 per document.

Be explicit that this optimization only affects the worker tile path (`prepare-tile-job` / `read-tile`). It does not change the simpler preview `render` path used during CPU fallback.

**Also:** Replace `JSON.stringify` for the cache key with a cheaper string concatenation:

```typescript
function rotationCacheKey(sourceKind: string, levelId: string | null, rotation: number, levelAngle: number) {
  return `${sourceKind}|${levelId ?? ''}|${rotation}|${levelAngle}`;
}
```

### B — Files Changed

| File | Changes |
|---|---|
| `src/utils/imagePipeline.ts` | Hoist gray computation, add luma constants, fuse curve LUTs |
| `src/utils/imageWorker.ts` | Split geometry cache into rotation + crop stages, cheaper keys |

### B — Testing

- Run `npm run test` — the existing `imagePipeline.test.ts` golden-pixel tests will catch any regression in output values.
- Verify that fused LUTs produce identical output by running the existing per-slider pipeline tests.
- Add worker/client tests for geometry cache behavior:
  - crop-only change reuses the rotation cache
  - rotation change invalidates rotation cache
  - cache eviction keeps current + previous only
  - cancelled tile jobs still clean up correctly
- The geometry cache split is transparent to the client message protocol — `imageWorkerClient.ts` request shapes stay unchanged.
- Manual test: open a 40 MP scan, drag the crop handles rapidly, confirm the preview updates without visible lag increase.

---

## Workstream C: EXIF Metadata Preservation

### Current Problem

Exported images carry zero metadata. The original scan's EXIF data (orientation, date, camera/scanner info) is silently dropped during the canvas round-trip, and the current export flow has two backend branches:

- CPU fallback exports entirely inside `imageWorker.ts`
- GPU tiled export assembles pixels and creates the blob in `imageWorkerClient.ts`

Also, the current raster decode path uses `createImageBitmap(blob)` in the worker. Browsers may already honor EXIF orientation during decode, so orientation handling must be made explicit to avoid double-rotation.

### C1. Choose an EXIF library

**Recommended:** [`piexifjs`](https://github.com/nickaknudson/piexifjs) (~25 KB minified)

Reasons:
- Pure JS, no native dependencies (works in both browser and Web Worker)
- Supports both EXIF read and write for JPEG
- Can insert an EXIF block into an existing JPEG blob
- Well-maintained, MIT licensed

Alternative: [`exif-reader`](https://github.com/nickaknudson/piexifjs) is read-only (lighter, ~5 KB) — suitable if we only need to read but not write. Since we need both read and write, `piexifjs` is the better fit.

**Note on PNG:** PNG metadata uses tEXt/iTXt chunks, not EXIF. For PNG export, we'll use a minimal custom writer (< 50 lines) to inject a `tEXt` chunk with the software tag. WebP EXIF injection is more complex and can be deferred.

**Install:**

```bash
npm install piexifjs
```

### C2. Extend `SourceMetadata` with EXIF fields

**`src/types.ts`:**

```typescript
export interface ExifMetadata {
  orientation?: number;          // EXIF tag 274 (1–8)
  dateTimeOriginal?: string;     // EXIF tag 36867 (e.g. "2024:03:15 14:30:00")
  make?: string;                 // EXIF tag 271 (camera/scanner manufacturer)
  model?: string;                // EXIF tag 272 (camera/scanner model)
  software?: string;             // EXIF tag 305 (scanning software)
  iccProfileName?: string;       // Extracted from ICC profile header if present
}

export interface SourceMetadata {
  id: string;
  name: string;
  mime: string;
  extension: string;
  size: number;
  width: number;
  height: number;
  exif?: ExifMetadata;           // NEW
}
```

Add `embedMetadata` to `ExportOptions`:

```typescript
export interface ExportOptions {
  format: ExportFormat;
  quality: number;
  filenameBase: string;
  embedMetadata: boolean;        // NEW — default true
}
```

Update `DEFAULT_EXPORT_OPTIONS` in `constants.ts` to include `embedMetadata: true`.

### C3. EXIF read at import time

**Where:** `src/utils/imageWorker.ts` — inside `handleDecode()`

**For JPEG files:**

After receiving the `ArrayBuffer` from the main thread, before calling `createImageBitmap()`:

```typescript
import piexif from 'piexifjs';

function extractExif(buffer: ArrayBuffer): ExifMetadata | undefined {
  try {
    // piexifjs works on binary strings or data URIs
    const binary = arrayBufferToBinaryString(buffer);
    const exifObj = piexif.load(binary);
    if (!exifObj) return undefined;

    const zeroth = exifObj['0th'] ?? {};
    const exifIfd = exifObj['Exif'] ?? {};

    return {
      orientation: zeroth[piexif.ImageIFD.Orientation],
      dateTimeOriginal: exifIfd[piexif.ExifIFD.DateTimeOriginal],
      make: zeroth[piexif.ImageIFD.Make],
      model: zeroth[piexif.ImageIFD.Model],
      software: zeroth[piexif.ImageIFD.Software],
    };
  } catch {
    return undefined;  // Silently ignore malformed EXIF
  }
}
```

Call `extractExif(buffer)` in the JPEG decode path and include the result in the `DecodedImage` response sent back to the main thread. To avoid applying orientation twice, make the decode policy explicit:

```typescript
const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
```

That keeps the decoded pixels in source-file orientation so DarkSlide can apply `rotationFromExifOrientation()` exactly once during document setup.

This means extending the `DecodedImage` type:

```typescript
export interface DecodedImage {
  // ... existing fields
  exif?: ExifMetadata;
}
```

**For TIFF files:** avoid a second full parse of the same large buffer. `decodeTiffRaster()` already calls `UTIF.decode(buffer)` internally, so extend it to surface first-frame metadata alongside pixel data:

```typescript
export interface DecodedTiffRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  frameIndex: number;
  frameCount: number;
  orientation?: number;
}
```

**For PNG/WebP:** These formats rarely carry useful EXIF. Skip extraction — return `undefined`.

**For RAW (desktop):** The Tauri `decode_raw` command already reads orientation via `analyze_metadata()`. Extend the `RawDecodeResult` to also return `dateTimeOriginal`, `make`, `model` from rawler metadata, and store in `ExifMetadata`. If phase 10 is meant to stay browser-focused, this can be a follow-up rather than part of the initial implementation.

### C4. Orientation auto-apply

**Where:** `src/utils/imageWorkerClient.ts` and `src/App.tsx`

When `exif.orientation` is present (values 1–8), apply the corresponding rotation automatically during the initial document setup — the same way `rawImport.ts` already does for RAW files.

This depends on C3's explicit decode policy (`imageOrientation: 'none'`). If raster decode is left as browser-default orientation handling, this auto-rotation step must not run for JPEG imports.

```tsx
// Reuse the existing helper
import { rotationFromExifOrientation } from './rawImport';
```

```typescript
// In the decode result handler (App.tsx or wherever WorkspaceDocument is created):
const rotation = rotationFromExifOrientation(decoded.exif?.orientation);
if (rotation !== 0) {
  initialSettings.rotation = rotation;
}
```

The existing `rotationFromExifOrientation` in `src/utils/rawImport.ts` already handles orientations 3 (180), 6 (90), 8 (270). Extend it to also handle mirrored orientations (2, 4, 5, 7) if desired, or ignore them for now (very rare in scanner output).

Store the parsed `ExifMetadata` in `SourceMetadata` so it's available at export time.

### C5. EXIF write on export

**Where:** centralize in a backend-agnostic export finalization step, not only in `src/utils/imageWorkerClient.ts`

Today export can finish in either place:

- CPU worker path returns a finished blob from `imageWorker.ts`
- GPU tiled path creates the blob in `imageWorkerClient.ts`

The metadata injection step should therefore run after either branch yields `{ blob, filename }`. Recommended shape:

```typescript
async function finalizeExportBlob(
  result: ExportResult,
  format: ExportFormat,
  embedMetadata: boolean,
  sourceExif: ExifMetadata | undefined,
): Promise<ExportResult> {
  if (!embedMetadata) {
    return result;
  }

  let blob = result.blob;
  if (format === 'image/jpeg') {
    blob = await injectExifIntoJpeg(blob, sourceExif);
  } else if (format === 'image/png') {
    blob = await injectPngTextChunk(blob, 'Software', 'DarkSlide');
  }

  return { ...result, blob };
}
```

**For JPEG exports:**

After `convertToBlob()` produces a bare JPEG blob, inject an EXIF block:

```typescript
import piexif from 'piexifjs';

async function injectExifIntoJpeg(
  blob: Blob,
  sourceExif: ExifMetadata | undefined,
): Promise<Blob> {
  const exifObj: Record<string, Record<number, unknown>> = {
    '0th': {
      [piexif.ImageIFD.Orientation]: 1,  // Always 1 (top-left) — rotation already applied
      [piexif.ImageIFD.Software]: 'DarkSlide',
    },
    'Exif': {},
  };

  // Preserve original date if available
  if (sourceExif?.dateTimeOriginal) {
    exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal] = sourceExif.dateTimeOriginal;
  }

  // Preserve camera/scanner info
  if (sourceExif?.make) exifObj['0th'][piexif.ImageIFD.Make] = sourceExif.make;
  if (sourceExif?.model) exifObj['0th'][piexif.ImageIFD.Model] = sourceExif.model;

  const exifBytes = piexif.dump(exifObj);
  const binaryStr = await blobToBinaryString(blob);
  const inserted = piexif.insert(exifBytes, binaryStr);
  return binaryStringToBlob(inserted, 'image/jpeg');
}
```

**For PNG exports:**

PNG doesn't use EXIF. Inject a minimal `tEXt` chunk with `Software: DarkSlide`. This is a simple binary operation (< 30 lines) — no library needed:

```typescript
function injectPngTextChunk(blob: Blob, key: string, value: string): Promise<Blob> {
  // Insert a tEXt chunk before the first IDAT chunk
  // Format: length(4) + "tEXt" + key + \0 + value + CRC(4)
  // ...
}
```

**For WebP exports:** Defer EXIF injection — WebP EXIF support requires RIFF container manipulation. Mark as a follow-up.

**Integration point:**

In `imageWorkerClient.ts`, finalize the export result after either the CPU or GPU branch returns:

```typescript
const rawResult = await this.exportInternal(payload, true);
return finalizeExportBlob(
  rawResult,
  payload.options.format,
  payload.options.embedMetadata,
  payload.sourceExif,
);
```

The source EXIF must be passed through the export flow. Currently `ExportRequest` doesn't include source metadata. Extend it:

```typescript
export interface ExportRequest {
  // ... existing fields
  sourceExif?: ExifMetadata;     // NEW
  embedMetadata: boolean;        // NEW
}
```

### C6. Export UI toggle

**Where:** `src/components/Sidebar.tsx` — Export tab (lines ~358–427)

Add an "Embed metadata" checkbox below the quality slider:

```tsx
<label className="flex items-center gap-2 text-xs text-zinc-400">
  <input
    type="checkbox"
    checked={exportOptions.embedMetadata}
    onChange={(e) => onExportOptionsChange({ embedMetadata: e.target.checked })}
    className="rounded border-zinc-600 bg-zinc-800"
  />
  Embed metadata
</label>
```

Add a tooltip: "Include camera info, date, and software tag in exported file. Disable for privacy."

### C — Files Changed

| File | Changes |
|---|---|
| `package.json` | Add `piexifjs` dependency |
| `src/types.ts` | Add `ExifMetadata` interface, extend `SourceMetadata`, `ExportOptions`, `ExportRequest`, `DecodedImage` |
| `src/constants.ts` | Update `DEFAULT_EXPORT_OPTIONS` with `embedMetadata: true` |
| `src/utils/imageWorker.ts` | EXIF extraction in decode path, explicit raster decode orientation policy |
| `src/utils/imageWorkerClient.ts` | Backend-agnostic export finalization, pass `sourceExif` through export flow |
| `src/utils/tiff.ts` | Surface TIFF orientation from the existing decode pass instead of re-parsing |
| `src/App.tsx` | Store `exif` in `SourceMetadata` on decode, auto-apply orientation exactly once, pass metadata to export |
| `src/components/Sidebar.tsx` | "Embed metadata" checkbox in Export tab |
| `src/utils/rawImport.ts` | Extend `rotationFromExifOrientation` for mirrored orientations (optional) |
| `src-tauri/src/lib.rs` | Extend `RawDecodeResult` to return additional EXIF fields (optional desktop follow-up) |

### C — Testing

- **Unit test:** round-trip a JPEG with known EXIF through decode → export, verify orientation tag is 1 and dateTimeOriginal is preserved.
- **Unit test:** export with `embedMetadata: false`, verify the blob contains no EXIF APP1 marker.
- **Unit test:** PNG export contains `tEXt` chunk with `Software: DarkSlide`.
- **Integration test:** import a JPEG with EXIF orientation 6, verify `settings.rotation` is auto-set to 90.
- **Manual test:** import a scanned JPEG, export, open in macOS Preview → Get Info, confirm metadata fields are present.

---

## Implementation Order

The three workstreams are independent and can be developed in parallel. Within each:

### Phase A (React rendering): ~1–2 sessions
1. Wrap all 6 components with `React.memo`
2. Hoist all inline objects to module-level constants
3. Memoize Sidebar callbacks by update shape (scalar settings, nested settings, export options)
4. Replace App.tsx inline arrow props with `useCallback`
5. Narrow CropPane props (pass `settings.crop` instead of full `settings`)
6. Run tests, verify no regressions

### Phase B (CPU pipeline): ~1 session
1. Add luma constants, hoist gray computation in `processImageData`
2. Build fused curve LUTs, replace per-pixel chained lookup
3. Split geometry cache in `imageWorker.ts` (rotation + crop stages)
4. Run `imagePipeline.test.ts` golden-pixel tests, verify exact output match
5. Add worker/client cache-behavior tests for crop-only reuse and eviction

### Phase C (EXIF preservation): ~2 sessions
1. Install `piexifjs`, add types (`ExifMetadata`, extended `SourceMetadata`, `ExportOptions`)
2. Implement EXIF extraction in worker decode path and set explicit raster orientation decode policy
3. Wire orientation auto-apply in App.tsx
4. Implement backend-agnostic export finalization (JPEG EXIF + PNG software tag)
5. Add "Embed metadata" checkbox in Sidebar export tab
6. Write round-trip tests
7. Optionally extend Tauri `decode_raw` to return additional metadata fields

---

## Out of Scope

- **Settings segmentation** (splitting `ConversionSettings` type): deferred as the memo boundaries achieve the same render-skip benefit at far lower risk.
- **WebP EXIF injection**: deferred — requires RIFF container manipulation.
- **ICC profile preservation**: belongs to Phase 12 (ICC color management).
- **EXIF for mirrored orientations** (2, 4, 5, 7): rare in scanner output; can be added later.
- **RAW metadata expansion**: optional desktop follow-up unless this phase explicitly includes Tauri-side work.
- **GPU pipeline optimizations**: belong to Phase 11 (GPU & Memory Hardening).
