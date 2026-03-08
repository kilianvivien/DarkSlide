# Phase 6 & 7 — Detailed Implementation Plan

## Phase 6: Beta Product Finish [complete]

### 6.1 Persistent User Preferences

**Goal**: Remember the user's last-used profile, export settings, and layout across sessions.

**Current state**: localStorage is used in two places — `presetStore.ts` (custom presets, key `darkslide_custom_presets_v1`) and `diagnostics.ts` (diagnostic entries, key `darkslide_diagnostics_v1`). All layout and editing state in `App.tsx` starts from hardcoded defaults on every launch (lines 65–83).

#### New file: `src/utils/preferenceStore.ts`

Follow the same versioned-store pattern as `presetStore.ts`.

```ts
interface UserPreferences {
  version: 1;
  lastProfileId: string;                // e.g. 'portra-400'
  exportOptions: ExportOptions;          // format, quality, filenameBase
  sidebarTab: 'adjust' | 'curves' | 'crop' | 'export';
  isLeftPaneOpen: boolean;
  isRightPaneOpen: boolean;
}
```

Storage key: `darkslide_preferences_v1`.

Functions:
- `loadPreferences(): UserPreferences | null` — parse from localStorage, validate shape, return `null` on invalid/missing data.
- `savePreferences(prefs: UserPreferences): void` — serialize to localStorage.

#### Integration in `App.tsx`

- On mount (`useEffect([], ...)`): call `loadPreferences()`. If non-null, seed:
  - `sidebarTab` (line 82)
  - `isLeftPaneOpen` / `isRightPaneOpen` (lines 68–69)
  - Profile lookup from `lastProfileId` when creating the document's initial state
  - `exportOptions` on the `WorkspaceDocument`
- On change: call `savePreferences()` in the following handlers (debounce not needed — these fire infrequently):
  - Profile switch (`handleProfileChange` / profile selector)
  - Export options change
  - Sidebar tab change (`setSidebarTab`)
  - Pane toggle (`setIsLeftPaneOpen`, `setIsRightPaneOpen`)

No new hooks needed — a few inline calls to `savePreferences()` at the relevant set-state sites are sufficient.

#### Edge cases

- First launch (no stored prefs): fall through to existing hardcoded defaults — zero behavior change.
- Corrupt stored JSON: `loadPreferences()` returns `null`, same as first launch.
- Profile ID references a deleted custom preset: fall back to `generic-color`.

---

### 6.2 Recent Files List

**Goal**: Quick re-open of previously imported files. Full functionality on Tauri desktop; limited to session-level on browser.

#### New file: `src/utils/recentFilesStore.ts`

```ts
interface RecentFileEntry {
  name: string;       // original filename
  path: string | null; // filesystem path (Tauri only; null in browser)
  size: number;        // bytes
  timestamp: number;   // Date.now() at import time
}

interface RecentFilesStore {
  version: 1;
  entries: RecentFileEntry[];  // max 10, newest first
}
```

Storage key: `darkslide_recent_files_v1`.

Functions:
- `loadRecentFiles(): RecentFileEntry[]`
- `addRecentFile(entry: Omit<RecentFileEntry, 'timestamp'>): void` — prepend, deduplicate by `path ?? name`, cap at 10, persist.
- `clearRecentFiles(): void`

#### Recording entries

After a successful decode in `App.tsx` (inside the `handleDecode` callback where `setDocumentState` is called with `status: 'ready'`):

```ts
addRecentFile({
  name: metadata.name,
  path: isDesktopShell() ? (nativeFilePath ?? null) : null,
  size: metadata.size,
});
```

The native file path is available from the Tauri `open` dialog result (`fileBridge.openImageFile`). Add a return value or out-parameter to `openImageFile()` that surfaces the path string alongside the `File` object. In the browser path, `path` stays `null`.

#### UI: `src/components/RecentFilesList.tsx`

A compact list rendered in the **empty state** of the viewport (where the upload prompt currently lives, around `App.tsx` line ~200). Show when `documentState === null`.

Each row: filename, formatted size, relative timestamp ("2 min ago"). Clicking a row:
- **Tauri**: call `fileBridge.openImageFile(path)` with the stored path (add a `openImageFileByPath(path: string)` variant that reads from disk without the dialog).
- **Browser**: show the filename grayed out with "(re-import to open)" since the browser can't re-access files by path. Clicking opens the native file picker pre-focused.

A "Clear" link at the bottom calls `clearRecentFiles()`.

#### Keyboard shortcut

None needed — the empty-state list is always visible when no document is open, which is the moment recent files are useful.

---

### 6.3 Automated Regression Tests

**Goal**: Cover the core import → render → export flow and per-profile correctness so future pipeline changes (Phase 7) don't silently regress.

**Current state**: 6 test files exist (`App.test.tsx`, `Sidebar.test.tsx`, `imagePipeline.test.ts`, `imageWorkerClient.test.ts`, `fileBridge.test.ts`, `tiff.test.ts`, `constants.test.ts`). The pipeline test (`imagePipeline.test.ts`) covers film-base compensation, crop math, and rotation but not the full per-pixel conversion loop across slider ranges.

#### New tests in `src/utils/imagePipeline.test.ts`

Extend the existing file. Helper already exists: `createPixel(r, g, b)` returns a 1×1 `ImageData`.

**Per-slider range tests** (one `describe` block per slider):

| Slider | Test approach |
|---|---|
| `exposure` | Process same pixel at exposure = -50, 0, +50. Assert monotonically increasing luminance. |
| `contrast` | Process mid-gray (128,128,128) at contrast = 0, 40, 80. Assert 0 leaves it unchanged; higher values push values away from 128. |
| `blackPoint` / `whitePoint` | Process dark pixel (20,20,20) with blackPoint=0 vs 20. Assert blackPoint=20 maps it to ~0. Same logic for whitePoint on a bright pixel. |
| `highlightProtection` | Process a bright pixel (240,240,240) at protection=0 vs 80. Assert protection pulls it down. |
| `saturation` | Process a colored pixel at saturation=0 vs 100 vs 200. Assert 0 ≈ grayscale, 200 is more vivid than 100. |
| `temperature` / `tint` | Process neutral gray. Assert positive temperature shifts red up & blue down. Assert positive tint shifts green up. |
| `curves` | Build a LUT from a custom curve with midpoint pulled down. Assert output is darker than identity curve. |

**Profile round-trip test** (one `it` per profile):

For each of the 12 built-in profiles in `FILM_PROFILES`:
1. Create a 2×2 pixel test image with varied colors.
2. Call `processImageData` with the profile's `defaultSettings` and its `maskTuning`.
3. Snapshot the output RGBA. This captures a "golden" pixel baseline.
4. Use `toMatchInlineSnapshot()` so any future pipeline change that alters output will surface as a diff in the test.

**Noise reduction / sharpen tests**:

- Process a 4×4 checkerboard pattern through `processImageData` with noise reduction enabled. Assert output is smoother (lower variance across neighbors).
- Same with sharpen enabled. Assert edges are amplified (higher local contrast at boundaries).

#### New test: `src/utils/presetStore.test.ts`

- `loadPresetStore` returns `[]` on empty localStorage.
- `savePresetStore` + `loadPresetStore` round-trips correctly.
- Corrupt JSON returns `[]`.
- Presets missing required fields are filtered out.

#### New test: `src/utils/preferenceStore.test.ts`

Same pattern — round-trip, corruption, missing fields.

#### New test: `src/utils/recentFilesStore.test.ts`

- Deduplification by name/path.
- Cap at 10 entries.
- Clear removes all.

---

## Phase 7: Color Negative Science Refinement (implemented, with calibration follow-up)

### Overview

The current pipeline (`processImageData` in `imagePipeline.ts`, lines 306–378) works entirely in 8-bit integer space. Inversion is a simple `255 - x` per channel. Film-base compensation is a flat per-channel multiplier. These are serviceable but produce visible artifacts on dense orange-mask stocks (Portra, Ektar, Gold): muddy shadows, orange-tinted highlights, and dull midtones that require heavy manual correction.

Phase 7 upgrades the pipeline in five incremental steps, each independently testable and backward-compatible.

---

### 7.1 Float32 Pipeline Conversion

**What**: Convert the per-pixel loop from implicit integer arithmetic to explicit float [0, 1] space.

**Why**: Every intermediate `clamp(Math.round(...), 0, 255)` currently destroys fractional precision. Shadows (values 0–20) have only ~8% of the 0–255 range to work with; quantization crushes detail. Float space preserves full precision until the final write-back.

**Where**: `processImageData()` in `imagePipeline.ts`, lines 306–378.

#### Changes

1. At the top of the per-pixel loop, normalize to [0, 1]:
   ```ts
   let r = data[index] / 255;
   let g = data[index + 1] / 255;
   let b = data[index + 2] / 255;
   ```

2. All intermediate operations work in [0, 1] float space:
   - Inversion: `r = 1 - r` (instead of `255 - r`)
   - Film-base balance multipliers: unchanged (they're already ratios)
   - Color balance: unchanged (multiplicative)
   - Temperature/tint: convert the additive offsets to [0, 1] scale: `r += temperature / 255` (currently `r += effectiveSettings.temperature`)
   - Exposure: `r *= exposureFactor` — unchanged
   - Black/white point: remap to `(value - bp) / (wp - bp)` where `bp`/`wp` are normalized to [0, 1]
   - Contrast: `(value - 0.5) * contrastFactor + 0.5`
   - Highlight protection: rewrite `applyHighlightProtection` to work in [0, 1] (threshold at ~0.784 instead of 200)
   - Saturation: `gray + (value - gray) * saturationFactor` — unchanged in structure

3. Curves LUT remains 256-entry `Uint8Array` for now. At the curves step, scale back to 0–255 integer to index the LUT, then normalize the result back:
   ```ts
   const mappedR = clamp(Math.round(r * 255), 0, 255);
   r = lutR[lutRGB[mappedR]] / 255;
   ```

4. Final write-back:
   ```ts
   data[index] = clamp(Math.round(r * 255), 0, 255);
   ```

5. Update `applyWhiteBlackPoint` and `applyHighlightProtection` to accept and return float [0, 1] values with rescaled thresholds.

#### Compatibility

- No type changes to `ConversionSettings`, `RenderRequest`, or `RenderResult`.
- No worker protocol changes.
- Existing profiles work identically (slider values remain in their current ranges; only internal math changes).
- Existing tests will need updated inline snapshots since float precision may shift output by ±1 in edge cases.

#### Performance

Float math on modern JS engines is not meaningfully slower than integer math for this loop. The hot path is already ~400 lines of arithmetic per pixel; float vs int is within noise. No measurable impact expected.

---

### 7.2 Log-Space Inversion

**What**: After arithmetic inversion (`1 - x`), apply a logarithmic transfer to better model how film density maps to scene luminance.

**Why**: Film negative density is approximately logarithmic in exposure (the Hurter–Driffield relationship). A simple linear inversion compresses shadows and stretches highlights relative to how the scene actually looked. Log-space inversion expands shadow detail and compresses blown highlights, yielding a more "scan-like" tonal distribution before any user adjustments.

**Where**: Insert immediately after the inversion step (after line 314, post-float conversion).

#### Implementation

New function in `imagePipeline.ts`:

```ts
function logInvert(value: number): number {
  // value is in [0, 1] after linear inversion (1 - x).
  // Map through log to expand shadows and compress highlights.
  // epsilon prevents log(0).
  const epsilon = 1 / 255;
  const logMin = Math.log(epsilon);       // ≈ -5.55
  const logMax = 0;                        // log(1)
  const logVal = Math.log(Math.max(value, epsilon));
  return (logVal - logMin) / (logMax - logMin);
}
```

Applied per-channel:
```ts
r = 1 - r;
g = 1 - g;
b = 1 - b;

r = logInvert(r);
g = logInvert(g);
b = logInvert(b);
```

#### Profile retuning

Log inversion shifts the tonal distribution. The existing per-profile defaults (exposure, contrast, black/white point) were tuned against linear inversion and will look different. After implementing log inversion:

1. Process reference scans through each profile.
2. Adjust `defaultSettings` values in `constants.ts` to restore comparable output.
3. This is a tuning pass, not a code change — expect adjustments to `exposure` (±5), `contrast` (±10), `blackPoint` (±5), `whitePoint` (±5) per profile.

#### Toggle

No user-facing toggle. Log inversion replaces linear inversion globally — it's strictly better for negative conversion. The old behavior can be recovered by setting `exposure`/`contrast`/`blackPoint` to compensate, and the per-profile defaults will be retuned to account for the change.

---

### 7.3 Orange-Mask Color Matrix

**What**: Apply a 3×3 color matrix per film stock immediately after inversion to neutralize the orange dye mask before any user adjustments.

**Why**: The current approach (`getFilmBaseBalance` in `imagePipeline.ts` lines 172–185) applies a single per-channel multiplier derived from a user-sampled neutral area. This corrects the *average* cast but doesn't model the dye's wavelength-dependent cross-channel coupling. A 3×3 matrix can rotate the color space to undo the mask more precisely, reducing residual casts in shadows and highlights.

#### Type changes

Extend `FilmProfile` in `types.ts`:

```ts
export interface FilmProfile {
  // ... existing fields ...
  colorMatrix?: [
    number, number, number,
    number, number, number,
    number, number, number,
  ];
}
```

Row-major 3×3: `[R_out] = [m00 m01 m02] × [R_in]` etc.

Extend `RenderRequest` in `types.ts` to forward the matrix:

```ts
export interface RenderRequest {
  // ... existing fields ...
  colorMatrix?: [number, number, number, number, number, number, number, number, number];
}
```

#### Pipeline function

New function in `imagePipeline.ts`:

```ts
function applyColorMatrix(
  r: number, g: number, b: number,
  matrix: [number, number, number, number, number, number, number, number, number],
): [number, number, number] {
  return [
    matrix[0] * r + matrix[1] * g + matrix[2] * b,
    matrix[3] * r + matrix[4] * g + matrix[5] * b,
    matrix[6] * r + matrix[7] * g + matrix[8] * b,
  ];
}
```

#### Integration in `processImageData`

After log inversion and before film-base balance:

```ts
r = logInvert(r);
g = logInvert(g);
b = logInvert(b);

// Orange mask removal (if profile provides a matrix)
if (colorMatrix) {
  [r, g, b] = applyColorMatrix(r, g, b, colorMatrix);
}

r *= filmBaseBalance.red;
// ...
```

The matrix is passed via `processImageData`'s arguments. Add `colorMatrix` as an optional parameter alongside `maskTuning`.

#### Deriving matrices per stock

For each color profile in `FILM_PROFILES`:

1. Acquire a scan of a neutral gray card (or use the film rebate as an approximation).
2. Measure the inverted RGB values for the neutral patches.
3. Solve for the 3×3 matrix that maps those values to equal RGB (neutral).
4. Cross-validate against a ColorChecker if available.

Initial estimates (these will be refined during the tuning pass):

| Profile | Matrix (row-major, approximate) |
|---|---|
| Generic Color | `[1, 0, 0, 0, 1, 0, 0, 0, 1]` (identity — no correction) |
| Portra 400 | `[1.15, -0.10, -0.05, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08]` |
| Portra 160 | `[1.12, -0.08, -0.04, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07]` |
| Ektar 100 | `[1.20, -0.12, -0.08, -0.05, 1.10, -0.05, -0.03, -0.08, 1.11]` |
| Gold 200 | `[1.18, -0.11, -0.07, -0.05, 1.09, -0.04, -0.03, -0.07, 1.10]` |
| Fuji 400H | `[1.10, -0.06, -0.04, -0.02, 1.05, -0.03, -0.01, -0.04, 1.05]` |
| Superia 400 | `[1.12, -0.07, -0.05, -0.03, 1.06, -0.03, -0.02, -0.05, 1.07]` |
| CineStill 800T | `[1.08, -0.05, -0.03, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04]` |
| B&W profiles | No matrix (B&W negatives have no orange mask) |

These are starting points. The reference validation workflow (§7.5) will calibrate them.

---

### 7.4 Per-Stock Tone Latitude (Shadow Lift + Highlight Roll-off)

**What**: Encode per-film shadow and highlight behavior so built-in profiles render well out of the box without manual slider work.

**Why**: Portra's latitude lets you recover 3+ stops of shadow detail with gentle roll-off. Ektar clips harder. Delta 3200 blocks up in deep shadows. The current pipeline applies the same `applyHighlightProtection` function to all stocks with only a scalar bias. Per-stock coefficients model the real toe and shoulder behavior of each emulsion.

#### Type changes

Extend `FilmProfile` in `types.ts`:

```ts
export interface FilmProfile {
  // ... existing fields ...
  tonalCharacter?: {
    shadowLift: number;         // 0 to 0.5 — how much to open shadows (toe lift)
    highlightRolloff: number;   // 0 to 1.0 — how soft the shoulder is (0 = hard clip, 1 = very soft)
    midtoneAnchor: number;      // -0.1 to +0.1 — shift midpoint brightness
  };
}
```

Extend `RenderRequest` to forward `tonalCharacter` alongside `maskTuning`.

#### Pipeline functions

Replace the current `applyHighlightProtection` (lines 165–170) with a more general tone-shaping stage:

```ts
function applyTonalCharacter(
  value: number,
  highlightProtection: number,
  character?: { shadowLift: number; highlightRolloff: number; midtoneAnchor: number },
): number {
  let v = value; // [0, 1] float

  // Shadow lift (toe): raise deep shadows with a power curve
  if (character && character.shadowLift > 0 && v < 0.5) {
    const t = v / 0.5; // normalize shadow range to [0, 1]
    const gamma = 1 - character.shadowLift * 0.6; // lower gamma = more lift
    v = 0.5 * Math.pow(t, gamma);
  }

  // Midtone anchor: slight brightness shift
  if (character && character.midtoneAnchor !== 0) {
    v += character.midtoneAnchor;
  }

  // Highlight protection with stock-specific rolloff
  const rolloff = character?.highlightRolloff ?? 0.5;
  const threshold = 0.78; // ~200/255
  if (highlightProtection > 0 && v > threshold) {
    const protection = clamp(highlightProtection / 100, 0, 0.95);
    const shoulder = (v - threshold) / (1 - threshold);
    const softness = 1 - protection * Math.pow(shoulder, rolloff);
    v = threshold + shoulder * (1 - threshold) * softness;
  }

  return v;
}
```

This replaces the current `applyHighlightProtection` call in the per-pixel loop. Applied after contrast, before saturation (same position as current highlight protection).

#### Per-profile values in `constants.ts`

| Profile | shadowLift | highlightRolloff | midtoneAnchor |
|---|---|---|---|
| Generic Color | 0.05 | 0.5 | 0 |
| Portra 400 | 0.15 | 0.7 | 0.01 |
| Portra 160 | 0.12 | 0.65 | 0 |
| Ektar 100 | 0.03 | 0.3 | 0 |
| Gold 200 | 0.08 | 0.4 | 0.02 |
| Fuji 400H | 0.10 | 0.55 | -0.01 |
| Superia 400 | 0.06 | 0.4 | 0 |
| CineStill 800T | 0.12 | 0.6 | 0 |
| Generic B&W | 0.04 | 0.5 | 0 |
| HP5 Plus | 0.08 | 0.5 | 0 |
| Tri-X 400 | 0.05 | 0.35 | 0 |
| Delta 3200 | 0.02 | 0.25 | -0.02 |

These are initial estimates, refined during the validation pass.

---

### 7.5 Reference Validation Workflow

**What**: A repeatable, objective way to measure whether pipeline changes improve or regress color accuracy.

**Why**: Without measured ΔE values against known targets, every change is a subjective judgment call. A validation corpus lets us detect regressions automatically and track improvement over time.

#### Test fixtures

Create `src/test/fixtures/reference/` containing:

- One reference scan per color profile (a negative frame that includes a ColorChecker or neutral gray patches).
- A JSON sidecar per scan with measured ground-truth sRGB values for each patch.

Format:
```ts
// reference/portra-400.json
{
  "profile": "portra-400",
  "patches": [
    { "name": "neutral-5", "x": 120, "y": 80, "expected": [127, 127, 127] },
    { "name": "red",       "x": 200, "y": 80, "expected": [175, 54, 60] },
    // ...
  ]
}
```

If real reference scans aren't available initially, synthesize them: create small JPEG test images with known pixel values that simulate the appearance of an inverted negative (dark orange-masked pixels). This still validates the math even without a real scanner.

#### Color difference utility

New file: `src/utils/colorScience.ts`

```ts
// sRGB [0,255] → CIELAB
export function srgbToLab(r: number, g: number, b: number): [number, number, number] { ... }

// ΔE*ab (CIE76) — simple Euclidean distance in Lab
export function deltaE(lab1: [number, number, number], lab2: [number, number, number]): number {
  return Math.sqrt(
    (lab1[0] - lab2[0]) ** 2 +
    (lab1[1] - lab2[1]) ** 2 +
    (lab1[2] - lab2[2]) ** 2,
  );
}
```

CIE76 is sufficient for this use case — we're looking for gross improvements (ΔE drops of 5–15), not perceptual uniformity at ΔE < 1.

#### Validation test suite

New file: `src/utils/colorScience.test.ts`

```ts
describe('sRGB ↔ Lab conversion', () => {
  it('converts known sRGB values to Lab', () => { ... });
  it('round-trips without drift', () => { ... });
});

describe('deltaE', () => {
  it('returns 0 for identical colors', () => { ... });
  it('returns expected distance for known pairs', () => { ... });
});
```

New file: `src/utils/pipelineValidation.test.ts`

For each reference scan + sidecar:
1. Load the test image.
2. Process through `processImageData` with the profile's defaults + `maskTuning` + `colorMatrix` + `tonalCharacter`.
3. Sample the output pixels at each patch coordinate.
4. Compute ΔE against the expected values.
5. Assert mean ΔE < threshold (start with 10; tighten as matrices are calibrated).
6. Log per-patch ΔE for diagnostics.

This test suite runs with `npm run test` alongside all other tests. It serves as the objective gate: any pipeline change that increases mean ΔE for any profile by more than 2 points fails CI.

---

### 7.6 Curves Editor Precision Overhaul

**Goal**: Make per-channel curve editing more precise and flexible — unlock full movement on endpoint dots and improve overall interaction fidelity.

**Current state** (`CurvesControl.tsx`): The curve editor is a 200×200 SVG with points in 0–255 coordinate space. The first point (x=0) and last point (x=255) are **locked on the X axis** — only their Y value can change (lines 37–40). This means the user can lift/lower the shadow floor or highlight ceiling but cannot compress the tonal range from either end (e.g. "clip blacks below value 20" or "cap output at 240"). Middle points are constrained to stay between their neighbors on X (`prevX + 1 ≤ x ≤ nextX - 1`). Point circles are small (radius 4, growing to 5 on drag). There's no numeric readout of the current point position.

#### Changes

**1. Unlock endpoint X movement**

Modify `handleMouseMove` (lines 34–47) to allow endpoints to move on X within a safe range:

```ts
if (draggingPoint === 0) {
  // First point: X can move from 0 up to nextX - 1
  newPoints[0] = {
    x: clamp(x, 0, newPoints[1].x - 1),
    y: clamp(y, 0, 255),
  };
} else if (draggingPoint === points.length - 1) {
  // Last point: X can move from prevX + 1 down to 255
  newPoints[draggingPoint] = {
    x: clamp(x, newPoints[draggingPoint - 1].x + 1, 255),
    y: clamp(y, 0, 255),
  };
} else {
  // Middle points: unchanged (sandwiched between neighbors)
}
```

This lets users drag the bottom-left point rightward (crushing shadows) or the top-right point leftward (clipping highlights), mirroring the Levels behavior in Photoshop/Lightroom.

**2. Larger hit targets and visual feedback**

Increase point circle sizes for easier grabbing, especially on touch/trackpad:

- Default radius: `4` → `5`
- Dragging radius: `5` → `7`
- Add a transparent hit-area circle behind each visible dot with radius `12` (invisible, `fill="transparent"`) to enlarge the clickable zone without visually cluttering the curve.

**3. Coordinate readout on drag**

Show the current point's `(x, y)` values as a small floating label near the dragged point:

```tsx
{draggingPoint !== null && (
  <text
    x={(points[draggingPoint].x / 255) * 200 + 8}
    y={200 - (points[draggingPoint].y / 255) * 200 - 8}
    fill="white"
    fontSize="10"
    className="pointer-events-none select-none"
  >
    {points[draggingPoint].x}, {points[draggingPoint].y}
  </text>
)}
```

This gives precise numeric feedback during adjustment — critical for matching values across channels.

**4. Per-channel overlay (multi-channel visibility)**

When editing a single channel (R, G, or B), render the other channel curves as faint background paths (opacity ~0.15) so the user can see relative positions. Currently only the active channel is drawn.

Add after the main curve path (line ~149):

```tsx
{activeChannel !== 'rgb' && Object.entries(curves).map(([ch, pts]) => {
  if (ch === 'rgb' || ch === activeChannel) return null;
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x/255)*200} ${200-(p.y/255)*200}`).join(' ');
  return <path key={ch} d={d} fill="none" stroke={channelColors[ch]} strokeWidth="1" opacity="0.15" />;
})}
```

**5. Snap-to-grid (optional modifier)**

When holding Shift during drag, snap Y values to multiples of 16 (roughly 6% steps). This makes it easy to set precise quarter-tone adjustments. Implement in `handleMouseMove`:

```ts
let snappedY = y;
if (event.shiftKey) {
  snappedY = Math.round(y / 16) * 16;
}
```

Requires changing the `handleMouseMove` signature to receive the raw `MouseEvent` (currently it does via the window listener).

---

### 7.7 Magnification Loupe for Pixel Pickers

**Goal**: When the film-base picker or black/white/grey point picker is active, show a magnifying glass around the cursor on the image canvas so users can pick pixels precisely — especially useful on dense, dark negatives where individual details are hard to see at normal zoom.

**Current state**: When a picker is active, `App.tsx` sets `cursor-crosshair` on the canvas (line ~1389). There is no magnification — the user clicks blind on small details.

#### New component: `src/components/MagnifierLoupe.tsx`

A fixed-size circular loupe that follows the mouse cursor over the image canvas.

**Visual spec**:
- **Size**: 120×120px circle (`rounded-full`, `overflow-hidden`)
- **Magnification**: 6× zoom of the canvas content around the cursor
- **Border**: 2px solid white with a subtle drop shadow (`shadow-lg`)
- **Crosshair**: A centered crosshair drawn inside the loupe (two 1px white lines, horizontal + vertical, with a 1px dark outline for contrast)
- **Position**: Offset 20px up and 20px right from the cursor to avoid obscuring the pick point. If near the right or top edge of the viewport, flip the offset to keep the loupe visible.
- **Color readout**: Below the loupe circle, a small pill showing the RGB value of the pixel under the crosshair center: `rgb(182, 94, 52)` in a monospace font, 10px, with a dark semi-transparent background.

**Rendering approach**:

The loupe does **not** read from the display canvas via `getImageData` on every mouse move (too slow for large canvases). Instead:

1. Use a second hidden `<canvas>` element (the "loupe canvas"), sized to 120×120.
2. On mouse move over the main canvas, calculate the source coordinates in the display canvas's pixel space (accounting for `devicePixelRatio` and the viewport zoom/pan transform).
3. Call `loupeCtx.drawImage(displayCanvas, srcX - radius, srcY - radius, sampleSize, sampleSize, 0, 0, 120, 120)` — this uses the browser's native canvas scaling which is very fast.
4. Draw the crosshair overlay on top.
5. Position the loupe container via `transform: translate(...)` for GPU-accelerated movement.

**Debouncing**: Use `requestAnimationFrame` to coalesce rapid `mousemove` events — draw at most once per frame.

#### Integration in `App.tsx`

Render the loupe conditionally when a picker is active:

```tsx
{(isPickingFilmBase || activePointPicker) && documentState?.status === 'ready' && (
  <MagnifierLoupe
    sourceCanvas={displayCanvasRef.current}
    containerRef={viewportRef}
    magnification={6}
    size={120}
  />
)}
```

The component manages its own mouse tracking internally via `useEffect` on `pointermove` over the viewport container. It cleans up listeners on unmount (when the picker is deactivated).

#### Cursor styling update

Replace `cursor-crosshair` with `cursor-none` when the loupe is active — the loupe's built-in crosshair replaces the OS cursor, giving a cleaner look:

```tsx
className={`... ${(isPickingFilmBase || activePointPicker) ? 'cursor-none' : ''}`}
```

#### Edge cases

- **Cursor near canvas edge**: Clamp the source sample region to the canvas bounds. Fill any out-of-bounds area in the loupe with black (matching the dark app background).
- **Viewport zoom/pan**: The source coordinate calculation must account for the current zoom level and pan offset from `useViewportZoom`. At high zoom the loupe shows a smaller physical area (already magnified by viewport zoom × loupe magnification). At fit-to-view zoom the loupe is most useful.
- **Performance**: `drawImage` from one canvas to another is a GPU-backed operation in all modern browsers. No performance concern at 120×120 target size, even at 60fps mouse tracking.

---

### 7.8 Crop Overlay Handle Improvements

**Goal**: Make crop corner handles larger and easier to grab, especially on high-DPI displays and when zoomed out.

**Current state** (`CropOverlay.tsx`, lines 142–158): Corner handles are 16×16px circles (`h-4 w-4 rounded-full`), positioned 8px outside the crop frame (`-left-2 -top-2`). On a Retina display at fit-to-view zoom, these are physically ~8×8 points — small enough that precise grabbing requires effort. There are no edge handles (only the four corners + full-frame move).

#### Changes

**1. Larger corner handles**

Increase from `h-4 w-4` (16px) to `h-6 w-6` (24px). Adjust the positioning offset from `-2` (8px) to `-3` (12px) to keep handles centered on the corner:

```tsx
className={`absolute h-6 w-6 rounded-full border-2 border-zinc-950 bg-zinc-100 ${positionClasses}`}
```

Position classes update:
```ts
const positionClasses = {
  nw: '-left-3 -top-3 cursor-nwse-resize',
  ne: '-right-3 -top-3 cursor-nesw-resize',
  sw: '-left-3 -bottom-3 cursor-nesw-resize',
  se: '-right-3 -bottom-3 cursor-nwse-resize',
}[handle];
```

Also thicken the border from `border` (1px) to `border-2` (2px) for better visibility against both light and dark images.

**2. Invisible expanded hit area**

Add a transparent `::before` pseudo-element on each handle button that extends the clickable area to 40×40px without changing the visual size. This is the same pattern used by iOS/Android for minimum touch targets:

```tsx
<button
  className={`absolute h-6 w-6 rounded-full border-2 border-zinc-950 bg-zinc-100
    before:absolute before:-inset-2 before:content-['']
    ${positionClasses}`}
  onMouseDown={beginDrag(handle)}
/>
```

The `before:-inset-2` creates a 40×40px invisible hit zone (24px + 8px padding on each side).

**3. Corner bracket styling alternative**

Replace the filled circles with L-shaped corner brackets for a more professional, Lightroom-like appearance. Each corner renders two short white lines:

```tsx
{(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
  const bracketLength = 16; // px
  const bracketWidth = 2;   // px
  // Position at each corner of the crop frame
  return (
    <button
      key={handle}
      className={`absolute ${positionClasses} before:absolute before:content-['']`}
      style={{
        width: bracketLength + 8,  // hit area
        height: bracketLength + 8,
      }}
      onMouseDown={beginDrag(handle)}
    >
      {/* Horizontal arm */}
      <span className="absolute bg-white" style={{
        width: bracketLength, height: bracketWidth,
        [handle.includes('n') ? 'top' : 'bottom']: 0,
        [handle.includes('w') ? 'left' : 'right']: 0,
      }} />
      {/* Vertical arm */}
      <span className="absolute bg-white" style={{
        width: bracketWidth, height: bracketLength,
        [handle.includes('n') ? 'top' : 'bottom']: 0,
        [handle.includes('w') ? 'left' : 'right']: 0,
      }} />
    </button>
  );
})}
```

This provides a ~24×24px visual indicator with a generous invisible hit area, matches the aesthetic of professional crop tools, and reads well on both light and dark images (white arms with a subtle dark shadow via `drop-shadow`).

Choose between the larger circle (simpler) and the bracket (more polished) — both achieve the grabbing goal.

**4. Rule-of-thirds grid lines**

Add optional rule-of-thirds overlay inside the crop frame — two horizontal and two vertical lines at 1/3 and 2/3 positions:

```tsx
<div className="absolute inset-0 pointer-events-none">
  {/* Vertical thirds */}
  <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/25" />
  <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/25" />
  {/* Horizontal thirds */}
  <div className="absolute left-0 right-0 top-1/3 h-px bg-white/25" />
  <div className="absolute left-0 right-0 top-2/3 h-px bg-white/25" />
</div>
```

Rendered inside the crop frame div, after the handles. Low opacity (25% white) so it assists composition without dominating the view.

---

### Implementation Order

Phase 7 features build on each other:

1. **Float32 conversion** (§7.1) — prerequisite for everything; no visible output change.
2. **Log-space inversion** (§7.2) — changes tonal distribution; requires profile retuning.
3. **Orange-mask matrix** (§7.3) — requires float pipeline; changes color balance.
4. **Tonal latitude** (§7.4) — requires float pipeline; refines shadow/highlight behavior.
5. **Reference validation** (§7.5) — can start in parallel with §7.1; used to calibrate §7.2–7.4.
6. **Curves editor overhaul** (§7.6) — independent of pipeline work; can be built in parallel.
7. **Magnifier loupe** (§7.7) — independent; can be built in parallel with pipeline work.
8. **Crop handle improvements** (§7.8) — independent; can be built in parallel with everything else.

After all pipeline features (§7.1–7.4) are in place, do a final tuning pass across all 12 profiles using the reference validation suite to lock in the default values. The UI improvements (§7.6–7.8) have no pipeline dependencies and can ship as soon as they're ready.

---

### Reference: Real Scan Baseline

`Resources/Realscans/RealScanDebug.txt` contains a full debug dump of a successful conversion of `Img1875.tiff` (4032×6048, 32 MB TIFF color negative) with the current pipeline. Key data points for calibrating Phase 7 changes:

- **Film stock**: CineStill 400D — a daylight-balanced cinema stock (Kodak Vision3 250D base with remjet removed). Has a moderate orange mask, less dense than Portra/Ektar but still enough to produce noticeable color casts with linear inversion.
- **Film base sample**: `r: 220, g: 197, b: 186` — the orange mask is visible in the higher red value relative to green and blue.
- **Computed balance**: `redBalance: 0.895, blueBalance: 1.059` — the current flat-multiplier compensation.
- **User curve adjustments**: RGB curve with two extra control points pulling shadows down and highlights up (S-curve). Red channel clipped at x=164→y=255. Per-channel tweaks to green and blue needed to neutralize remaining cast — evidence of what the orange-mask matrix (§7.3) should handle automatically.
- **Settings used**: exposure=-1, contrast=15, saturation=103, highlightProtection=26, blackPoint=8, whitePoint=245, sharpen enabled (radius=0.5, amount=30).
- **Profile used**: custom preset (`custom-1772969472676`), not a built-in — the user had to create their own profile to get acceptable results from CineStill 400D, which is not yet in the built-in profile list.
- **Histogram**: shows significant energy bunched in the 40–100 range for all channels (midtone compression characteristic of linear inversion on dense negatives). Log-space inversion (§7.2) should spread this distribution more evenly.

This file serves as a real-world baseline: after Phase 7 pipeline changes, the same source image processed with a built-in profile should produce comparable or better results *without* the manual per-channel curve work the user had to apply. Consider adding CineStill 400D as a built-in profile in `constants.ts` — it's a popular stock and the debug dump provides a good starting point for its default settings and orange-mask matrix.
