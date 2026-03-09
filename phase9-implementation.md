# Phase 9: Editing Workflow Enhancements — Implementation Plan

## Status

- Feature A is implemented.
- Feature B is implemented.
- Feature C remains to be done.

Three independent feature sets, ordered by dependency depth. Film-format crop ratios and preset export/import are platform-agnostic and can be built in parallel. RAW import is Tauri-only and touches the deepest layer (Rust → worker → App).

---

## Feature A: Film-Format Crop Ratios

### A1. Extend the aspect ratio data model

**File: `src/constants.ts`**

Add an `AspectRatioEntry` type and restructure `ASPECT_RATIOS`:

```ts
export interface AspectRatioEntry {
  name: string;           // e.g. "2:3", "6:7"
  value: number | null;   // null = Free
  category: 'Film' | 'Print' | 'Social' | 'Digital';
  format?: string;        // e.g. "35mm", "6×7", "Half-frame"
  gauge?: '35mm' | 'Medium Format'; // grouping within Film tab
}
```

New Film entries to add:

| Format | Name | Value | Gauge |
|--------|------|-------|-------|
| 35mm | 2:3 | 2/3 | 35mm |
| 35mm | 3:2 | 3/2 | 35mm |
| Half-frame | 3:4 | 3/4 | 35mm |
| Half-frame | 4:3 | 4/3 | 35mm |
| 6×4.5 | 4:5 | 4/5 | Medium Format |
| 6×4.5 | 5:4 | 5/4 | Medium Format |
| 6×6 | 1:1 | 1 | Medium Format |
| 6×7 | 6:7 | 6/7 | Medium Format |
| 6×7 | 7:6 | 7/6 | Medium Format |
| 6×9 | 2:3 | 2/3 | Medium Format |
| 6×9 | 3:2 | 3/2 | Medium Format |

Notes:
- Some Film ratios share numeric values with Print/Social entries (e.g. 2:3, 1:1, 4:5). That's fine — they are separate entries with different `category` and `format` labels.
- The `Free` entry (value `null`) is category-independent and stays outside the tabs, rendered as a standalone button above the tab bar.

Redistribute existing entries:
- `1:1`, `4:5`, `9:16` → Social
- `2:3`, `3:2`, `3:4`, `4:3`, `5:7` → Print
- `16:9` → Digital

### A2. Tabbed crop pane with landscape/portrait toggle

**File: `src/components/CropPane.tsx`**

Replace the flat `grid grid-cols-2` ratio grid with a tabbed layout.

**Layout:**
```
[ Free       ]  ← standalone button, always visible

[ Film | Print | Social | Digital ]  ← tab bar

  ── Film tab ──
  35mm
    [ 35mm ◻↔◻ ]           ← button with L/P toggle
  Medium Format
    [ 6×4.5 ◻↔◻ ]
    [ 6×6        ]          ← square, no toggle
    [ 6×7  ◻↔◻ ]
    [ 6×9  ◻↔◻ ]

  ── Print tab ──
    [ 2:3  ◻↔◻ ]
    [ 3:4  ◻↔◻ ]
    [ 5:7  ◻↔◻ ]

  ── Social tab ──
    [ 1:1        ]
    [ 4:5  ◻↔◻ ]
    [ 9:16 ◻↔◻ ]

  ── Digital tab ──
    [ 16:9 ◻↔◻ ]
```

**State:**
```ts
const [cropTab, setCropTab] = useState<'Film' | 'Print' | 'Social' | 'Digital'>('Film');
```

**Landscape/portrait toggle behavior:**
- Each non-square format shows a single button with the format label (e.g. "35mm", "6×7", "2:3").
- A small landscape/portrait icon toggle sits inside the button (or as a suffix icon).
- Default orientation is landscape (wider dimension first).
- Clicking the toggle swaps the ratio value (e.g. 3/2 → 2/3) without deselecting.
- Track per-format orientation state locally: `orientationMap: Record<string, 'landscape' | 'portrait'>`.

**Film tab sub-groups:**
- Render "35mm" and "Medium Format" as small `text-zinc-500 text-[10px] uppercase tracking-wider` section labels within the Film tab.
- Within each gauge group, list formats vertically — each is a full-width button.

**Icon mapping:**
- Extend `getIcon()` to handle film formats. Use `<Film>` icon (lucide-react) for all Film-category entries, keeping existing icons for other categories.

**Tab bar styling:**
- Reuse the same pattern as `PresetsPane`'s `builtin`/`custom` tab bar (`flex border-b border-zinc-700/50`, active tab has `border-b-2 border-zinc-200`).

### A3. Custom ratio input

No changes — the custom ratio collapsible section stays below the tab bar, exactly as it is now.

### A4. Crop tab default

When a user first opens the Crop tab, default to the Film tab. Persist the last-used crop tab in `localStorage` alongside other preferences (via `preferenceStore`), or keep it session-local — session-local is fine for now.

---

## Feature B: Preset Export & Import

### B1. Extend `FilmProfile` with optional metadata

**File: `src/types.ts`**

Add three optional fields to `FilmProfile`:

```ts
export interface FilmProfile {
  // ... existing fields ...
  tags?: string[];                                          // ['color'] or ['bw']
  filmStock?: string | null;                                // e.g. "Portra 400", "HP5+"
  scannerType?: 'flatbed' | 'camera' | 'dedicated' | null; // scanner used
}
```

These fields are purely metadata — they do not affect the conversion pipeline.

### B2. Define the `.darkslide` export file format

**File: `src/types.ts`**

```ts
export interface DarkslidePresetFile {
  darkslideVersion: string;  // e.g. "1.0.0" — for forward-compat
  profile: FilmProfile;      // the full profile object (id, name, type, defaultSettings, etc.)
}
```

Design notes:
- The file is a JSON document with a `.darkslide` extension.
- `profile` contains the complete `FilmProfile` including `defaultSettings`, `maskTuning`, `colorMatrix`, `tonalCharacter`, and the new metadata fields.
- `darkslideVersion` enables future format migrations.
- No separate top-level `tags`/`filmStock`/`scannerType` — they live inside `profile` to keep the shape flat and aligned with the in-memory model.

### B3. File I/O helpers in fileBridge

**File: `src/utils/fileBridge.ts`**

Add two new functions:

```ts
export async function savePresetFile(
  json: string,
  filename: string
): Promise<'saved' | 'cancelled'>
```
- **Tauri:** native save dialog with filter `{ name: 'DarkSlide Preset', extensions: ['darkslide'] }`, then `writeTextFile()`.
- **Browser:** create a Blob with `type: 'application/json'`, construct a temporary `<a>` with `URL.createObjectURL`, click it, revoke.

```ts
export async function openPresetFile(): Promise<{ content: string; fileName: string } | null>
```
- **Tauri:** native open dialog filtered to `['darkslide']`, then `readTextFile()`.
- **Browser:** return `null` — the component will fall back to a hidden `<input type="file" accept=".darkslide">`.

### B4. Validation utility

**File: `src/utils/presetStore.ts`** (add to existing file)

```ts
export function validateDarkslideFile(raw: unknown): DarkslidePresetFile | null
```

Checks:
- Top-level object with `darkslideVersion` (string) and `profile` (object).
- `profile` has required `FilmProfile` fields: `id`, `name`, `type` ∈ `['color', 'bw']`, `defaultSettings` (object with at least `exposure`, `contrast`).
- Returns `null` on any validation failure (caller shows error toast).
- Does NOT reject unknown extra keys (forward-compat with newer versions).

### B5. Preset save form (inline metadata)

**File: `src/components/PresetsPane.tsx`**

Extend the existing save-preset inline UI. Currently, clicking "Save as preset" shows a name input + confirm/cancel. Expand this to include:

```
┌─────────────────────────────────┐
│ Preset name: [_______________]  │
│ Film stock:  [_______________]  │  ← text input, optional
│ Scanner:  ○ Flatbed  ○ Camera   │  ← radio group, optional
│            ○ Dedicated  ○ None  │
│ Tags:     auto-set from type    │  ← read-only chip (color/bw)
│                                 │
│         [✓ Save]  [✕ Cancel]    │
└─────────────────────────────────┘
```

State additions:
```ts
const [saveFilmStock, setSaveFilmStock] = useState('');
const [saveScannerType, setSaveScannerType] = useState<'flatbed' | 'camera' | 'dedicated' | null>(null);
```

On confirm, pass these through to the `onSavePreset` callback. Update `onSavePreset` signature:

```ts
onSavePreset: (name: string, metadata?: { filmStock?: string; scannerType?: 'flatbed' | 'camera' | 'dedicated' | null }) => void;
```

In `App.tsx`, the `handleSavePreset` handler sets `tags` automatically from `activeStock.type` (`['color']` or `['bw']`) and merges the metadata into the new `FilmProfile`.

### B6. Export button on each custom preset

**File: `src/components/PresetsPane.tsx`**

In the custom preset list, add a download icon button (`<Download size={12}>`) next to the existing delete button. Both appear on hover (`opacity-0 group-hover:opacity-100`).

On click:
1. Build a `DarkslidePresetFile` from the preset's `FilmProfile`.
2. `JSON.stringify` with 2-space indent.
3. Call `savePresetFile(json, slugify(preset.name) + '.darkslide')`.

Slugify: lowercase, replace non-alphanumeric with `-`, collapse runs.

### B7. Import button + drag-and-drop

**File: `src/components/PresetsPane.tsx`**

Add an upload icon button (`<Upload size={14}>`) in the Custom tab header row (next to the tab title or as a small action button).

**Click import flow:**
1. Call `openPresetFile()`.
2. If `null` (browser), click a hidden `<input type="file" accept=".darkslide">`.
3. Read the file content as text.
4. `JSON.parse` → `validateDarkslideFile()`.
5. On validation failure → show error toast.
6. On success → check for duplicate name in `customPresets`.
   - If duplicate → show inline prompt: "A preset named '{name}' already exists. Overwrite or rename?"
   - If unique → add to `customPresets` via `onSavePreset` (or a new `onImportPreset` callback).

**Drag-and-drop:**
- Add `onDragOver` / `onDrop` handlers to the Custom presets panel area.
- Accept only `.darkslide` files.
- Same validation + duplicate detection flow as click import.

### B8. Preset metadata display

**File: `src/components/PresetsPane.tsx`**

Below each custom preset name, render metadata when present:

```
  Portra 400 Push
  Kodak Portra 400 · Flatbed · Color
```

- Film stock in `text-zinc-500 text-[11px]`.
- Scanner type as a small badge/chip.
- Tags as a colored dot or small label (unnecessary if the profile type already implies it, but useful for quick scanning).
- If no metadata fields are set, show nothing extra (backward-compatible with existing presets).

---

## Feature C: RAW Import Pipeline (Tauri Desktop Only)

### C1. Add `rawler` crate to Tauri

**File: `src-tauri/Cargo.toml`**

```toml
[dependencies]
rawler = "0.7"  # pure Rust, supports DNG/CR3/NEF/ARW/RAF/RW2
```

Build-test the crate first (`cargo build` in `src-tauri/`) to verify it compiles on the developer's macOS toolchain. If `rawler` does not support a required camera model, fall back to `libraw-sys` — but start with `rawler` as it avoids C++ dependencies.

### C2. Implement `decode_raw` Tauri command

**File: `src-tauri/src/lib.rs`**

```rust
use rawler::decoders::RawDecodeParams;
use rawler::RawFile;
use serde::Serialize;

#[derive(Serialize)]
struct RawDecodeResult {
    width: u32,
    height: u32,
    data: Vec<u8>,          // 8-bit RGB, row-major
    color_space: String,    // "sRGB" after matrix application
    white_balance: Option<[f64; 3]>, // R/G/B multipliers from RAW metadata
}

#[tauri::command]
fn decode_raw(path: String) -> Result<RawDecodeResult, String> {
    // 1. Open and decode the RAW file
    // 2. Demosaic to a 16-bit linear-light RGB raster
    // 3. Apply the camera's daylight color matrix (from RAW metadata)
    //    to neutralize camera-specific color primaries → sRGB-ish linear
    // 4. Apply a linear-to-sRGB gamma curve (for consistency with JPEG/TIFF input)
    // 5. Normalize 16-bit → 8-bit
    // 6. Return the flat RGB buffer + dimensions + white balance metadata
}
```

Register in the builder:
```rust
.invoke_handler(tauri::generate_handler![decode_raw])
```

**Color integrity notes:**
- RAW sensor data is linear-light in camera-specific primaries.
- The `decode_raw` command must apply the camera's daylight matrix (available in RAW metadata via rawler) before returning data to JS.
- After matrix application, apply sRGB gamma transfer so the JS pipeline receives data in the same perceptual space as JPEG/TIFF inputs.
- Forward `white_balance` multipliers from RAW metadata so the UI can optionally pre-seed temperature/tint sliders (nice-to-have, not required for MVP).

### C3. Extend the open dialog to include RAW extensions on desktop

**File: `src/utils/fileBridge.ts`**

Combine RAW and standard extensions into a single dialog filter when running in Tauri:

```ts
const ALL_DIALOG_EXTENSIONS = isDesktopShell()
  ? [...SUPPORTED_DIALOG_EXTENSIONS, ...RAW_EXTENSIONS.map(e => e.slice(1))]
  : SUPPORTED_DIALOG_EXTENSIONS;
```

Use `ALL_DIALOG_EXTENSIONS` in the `openImageFile()` dialog filter. Single filter group labeled "All Supported Images".

### C4. Main-thread RAW interception

**File: `src/App.tsx`** — `importFile` function

Replace the current RAW error gate with a Tauri decode path:

```ts
if (isRawFile(file)) {
  if (!isDesktopShell()) {
    setError('RAW files require the DarkSlide desktop app. Use TIFF, JPEG, PNG, or WebP in the browser.');
    return;
  }
  if (!nativePath) {
    setError('RAW import requires a file path. Please use File > Open.');
    return;
  }

  // Invoke the Rust decode command
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<RawDecodeResult>('decode_raw', { path: nativePath });

  // Convert RGB → RGBA (the worker/pipeline expects RGBA)
  const rgba = rgbToRgba(result.data, result.width, result.height);

  // Build a synthetic DecodeRequest with the pre-decoded RGBA buffer
  const buffer = rgba.buffer;
  const decodeRequest: DecodeRequest = {
    documentId: newDocId,
    buffer,
    fileName: file.name,
    mime: 'image/x-raw-rgba',
    size: buffer.byteLength,
    rawDimensions: { width: result.width, height: result.height },
  };

  // Send to worker for pyramid building (same as TIFF/JPEG path from here)
  const decoded = await workerClientRef.current.decode(decodeRequest);
  // ... continue with standard post-decode flow (set document, build preview, etc.)
}
```

Add an `rgbToRgba` helper (or inline it):
```ts
function rgbToRgba(rgb: number[], width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j]     = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  return rgba;
}
```

### C5. Worker decode branch for pre-decoded RGBA

**File: `src/utils/imageWorker.ts`** — `handleDecode`

Add a branch before the RAW_UNSUPPORTED throw:

```ts
if (payload.mime === 'image/x-raw-rgba' && payload.rawDimensions) {
  const { width, height } = payload.rawDimensions;
  const rgba = new Uint8ClampedArray(payload.buffer);
  const imageData = new ImageData(rgba, width, height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  // Continue with standard pyramid building from canvas...
}
```

This reuses the same `OffscreenCanvas` → pyramid path that TIFF decoding already uses.

**File: `src/types.ts`** — `DecodeRequest`

Add optional field:
```ts
export interface DecodeRequest {
  // ... existing fields ...
  rawDimensions?: { width: number; height: number };
}
```

### C6. Browser graceful degradation

**File: `src/App.tsx`**

The error message for RAW files in the browser build should be improved:

```
"RAW files (.dng, .cr3, .nef, .arw, .raf, .rw2) require the DarkSlide desktop app.
Convert to TIFF for browser use, or download DarkSlide for desktop."
```

This replaces the current generic "RAW import is reserved for the future desktop path" message.

### C7. Diagnostics reporting

**File: `src/App.tsx`** — diagnostics panel

When a RAW file is successfully decoded via Tauri, append a diagnostic entry:

```ts
appendDiagnostic({
  type: 'info',
  message: `RAW decoded via Tauri: ${file.name} (${result.width}×${result.height}, ${result.color_space})`,
});
```

On decode failure, append the Rust error message as a diagnostic error.

---

## Implementation Order

The three features are independent and can be developed on separate branches. Recommended sequence for a single developer:

1. **A: Film-format crop ratios** (smallest scope, pure frontend)
   - A1: constants + type → A2: tabbed CropPane → A3/A4: cleanup
   - Estimated files changed: 2 (`constants.ts`, `CropPane.tsx`)

2. **B: Preset export/import** (medium scope, frontend + fileBridge)
   - B1: FilmProfile types → B2: DarkslidePresetFile type → B3: fileBridge helpers → B4: validation → B5: save form → B6: export button → B7: import + drag-drop → B8: metadata display
   - Estimated files changed: 4 (`types.ts`, `PresetsPane.tsx`, `fileBridge.ts`, `presetStore.ts`) + `App.tsx` (onSavePreset signature)

3. **C: RAW import** (largest scope, Rust + JS)
   - C1: Cargo.toml → C2: Rust command → C3: fileBridge dialog → C4: App.tsx intercept → C5: worker branch → C6: error messages → C7: diagnostics
   - Estimated files changed: 6 (`Cargo.toml`, `lib.rs`, `fileBridge.ts`, `App.tsx`, `imageWorker.ts`, `types.ts`)

---

## Testing Plan

### Film-format crop ratios
- Unit: verify all new `ASPECT_RATIOS` entries have valid `value`, `category`, `format`, and `gauge` fields.
- Manual: open Crop tab → switch between Film / Print / Social / Digital tabs → verify correct ratios appear in each. Toggle landscape/portrait on 35mm → verify ratio value flips. Select a Film ratio → verify crop overlay updates. Select Free → verify crop is unconstrained.

### Preset export/import
- Unit: `validateDarkslideFile` — valid file returns parsed object; missing fields returns null; extra fields are preserved; corrupt JSON returns null.
- Integration: save a custom preset with metadata → export it → delete the preset → import the `.darkslide` file → verify it appears with correct metadata. Import a duplicate name → verify overwrite/rename prompt.
- Manual: test export on both Tauri (save dialog) and browser (download). Test import on both. Test drag-and-drop import. Test importing a file from a newer `darkslideVersion`.

### RAW import
- Manual (Tauri only): open a DNG file → verify it decodes and appears in the viewport with correct colors. Open a CR3/NEF/ARW file → verify same. Try opening a RAW file in the browser build → verify the improved error message. Check Diagnostics panel for RAW decode info.
- Edge cases: corrupted RAW file → verify graceful error. Unsupported camera model → verify error message from rawler. Very large RAW file (100+ MP) → verify memory handling.

---

## Open Questions / Future Considerations

1. **White balance pre-seeding**: the `decode_raw` command forwards WB multipliers. Should these auto-populate the temperature/tint sliders, or just be available in diagnostics? Recommendation: diagnostics-only for MVP, auto-populate as a follow-up.

2. **RAW metadata display**: should the status bar or a new panel show RAW-specific info (camera model, ISO, shutter speed)? Recommendation: defer to a future phase — the current status bar shows dimensions and format, which is sufficient.

3. **Half-frame in Film tab**: half-frame 35mm shares the 3:4 / 4:3 ratio with the Print tab. The format label "Half-frame" distinguishes it contextually. No deduplication needed — different categories serve different mental models.

4. **Preset versioning**: if `FilmProfile` gains new fields in future phases, existing `.darkslide` files will lack them. The `darkslideVersion` field and the lenient validator (B4) handle this — unknown fields are preserved on round-trip, missing optional fields default to `undefined`.
