# Phase 15: Conversion Quality & Minilab Emulation — Implementation Plan

This phase focuses on output quality — making DarkSlide's conversions match or exceed competing tools. It builds on Phase 13's architectural refactors (decomposed hooks, typed worker protocol, error boundaries) and Phase 14's smart scanning features (auto-crop, flat-field, flare correction, light source profiles).

**Prerequisites from earlier phases:**
- Phase 13A: `useRenderQueue`, `useDocumentTabs`, `useWorkspaceCommands`, `useAppShortcuts` hooks extracted from App.tsx. Note: `useFileImport` exists as a hook but import logic currently lives in `useWorkspaceCommands`. `useKeyboardShortcuts` is a generic binding utility; app shortcuts are in `useAppShortcuts`.
- Phase 13B: Shared `workerProtocol.ts` with typed request/response unions (16 request types) and transfer lists
- Phase 14B–D: Flat-field, flare correction, and light source correction steps already in the pipeline (flare → light-source → inversion → film-base → color-matrix → …)
- Phase 14E: Expanded film profiles (~32 stocks), `filmType: 'negative' | 'slide'` field on `FilmProfile`

---

## 15A — Minilab Emulation Profiles (Frontier / Noritsu)

### Goal
Let users apply the tonal and color signature of classic minilab scanners (Fuji Frontier, Noritsu) as a post-inversion "Lab Style" layer, independent of the film stock profile.

### Type Changes (`src/types.ts`)

1. **Add `toneCurve` to `FilmProfile`** (after line ~164, inside the `FilmProfile` interface at line 153):
   ```typescript
   toneCurve?: CurvePoint[];  // optional post-inversion tone curve
   ```
   This field is reused by lab style profiles. When present, it's composited into the curve LUT.

2. **Add `LabStyleProfile` type**:
   ```typescript
   interface LabStyleProfile {
     id: string;
     name: string;
     description: string;
     toneCurve: CurvePoint[];           // master tone curve
     channelCurves?: {                  // optional per-channel curves
       r?: CurvePoint[];
       g?: CurvePoint[];
       b?: CurvePoint[];
     };
     tonalCharacterOverride?: Partial<TonalCharacter>;  // shadow lift, rolloff tweaks
     saturationBias: number;            // additive saturation shift (-30 to +30)
     temperatureBias: number;           // additive temperature shift (-15 to +15)
   }
   ```

3. **Add `labStyleId` to `WorkspaceDocument`** (alongside `profileId`):
   ```typescript
   labStyleId: string | null;  // active lab style, null = none
   ```
   This persists across undo/redo (included in the history entry alongside `settings` and `profileId`).

4. **Extend `comparisonMode`** from `'processed' | 'original'` to:
   ```typescript
   comparisonMode: 'processed' | 'original' | 'profile-ab';
   ```
   In `'profile-ab'` mode, the render queue fires two concurrent renders with different lab styles.

5. **Add `labStyleB` to `WorkspaceDocument`**:
   ```typescript
   labStyleB: string | null;  // alternate lab style for A/B comparison
   ```

### Constants (`src/constants.ts`)

Add 4 built-in lab style profiles after the existing film profiles:

| ID | Name | Character |
|----|------|-----------|
| `lab-frontier-classic` | Lab: Frontier Classic | Warm, saturated, lifted blacks, gentle highlight rolloff (SP-3000 look) |
| `lab-frontier-modern` | Lab: Frontier Modern | Less saturated, cleaner highlights (LP-5000/DX100 era) |
| `lab-noritsu` | Lab: Noritsu | Cooler, neutral, linear midtones, harder contrast (HS-1800 look) |
| `lab-neutral` | Lab: Neutral | Minimal tonal character, flat transfer — for manual grading |

Each profile defines:
- A `toneCurve: CurvePoint[]` (5–8 points) encoding the scanner's characteristic S-curve
- `channelCurves` for Frontier profiles (subtle red/green crossover)
- `saturationBias` (+10 for Frontier Classic, +3 for Modern, -2 for Noritsu, 0 for Neutral)
- `temperatureBias` (+8 for Frontier Classic, +3 for Modern, -5 for Noritsu, 0 for Neutral)

Export as `LAB_STYLE_PROFILES: LabStyleProfile[]` and `LAB_STYLE_PROFILES_MAP: Record<string, LabStyleProfile>`.

### Pipeline Integration (`src/utils/imagePipeline.ts`)

**LUT fusion in `buildCurveLutBuffer()`** (currently line 405):

The current function builds a 1024-element `Float32Array` (4 channels × 256 entries) from the user's curve points. Extend to composite three layers:

1. **Lab profile tone curve** (if `labStyleId` is set): convert `LabStyleProfile.toneCurve` to a 256-entry LUT via the existing `createCurveLut()` function
2. **User's RGB master curve**: the existing behavior
3. **User's per-channel curves**: the existing behavior

Composition: `fused[i] = userCurve[profileCurve[i]]` — simple array chaining. The profile curve is applied first, then the user's curve on top.

For per-channel lab curves (`channelCurves.r/g/b`): compose each channel independently: `fusedR[i] = userR[labR[masterUser[labMaster[i]]]]`.

**Updated signature:**
```typescript
function buildCurveLutBuffer(
  curves: ConversionSettings['curves'],
  labStyleToneCurve?: CurvePoint[],
  labStyleChannelCurves?: { r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] }
): Float32Array
```

This adds < 0.1 ms since the LUT is rebuilt only on settings change, not per-pixel.

**Tonal character override:**

In `processImageData()`, when a lab style is active and has `tonalCharacterOverride`, merge it with the film profile's tonal character:
```typescript
const effectiveTonal = {
  ...filmProfileTonalCharacter,
  ...labStyle.tonalCharacterOverride
};
```
Pass to `applyTonalCharacter()` at lines 656–658.

**Saturation and temperature biases:**

After the existing temperature/tint application (lines 622–625) and saturation (lines 661–664), add the lab style's additive biases:
- `effectiveTemperature = settings.temperature + labStyle.temperatureBias`
- `effectiveSaturation = settings.saturation + labStyle.saturationBias`

These biases are applied transparently — the user's sliders still show their own values, not the biased result.

### GPU Path (`src/utils/gpu/WebGPUPipeline.ts` + `src/utils/gpu/shaders/tiledRender.wgsl`)

**No shader changes needed.** The fused LUT is already uploaded as the `curveLutBuffer` (256 × 4 channels × 4 bytes = 4 KB `GPUBuffer`). The lab profile's tonal character is baked into the same buffer by `buildCurveLutBuffer()`. The saturation and temperature biases are folded into the `ProcessingUniforms` values before upload via `buildProcessingUniforms()`.

Add two new uniform fields to `buildProcessingUniforms()`:
- `labSaturationBias: f32` (added to `saturationFactor`)
- `labTempBias: f32` (added to `tempShift`)

These are folded into the existing uniform values before GPU upload, so no WGSL changes are required.

### Worker Protocol (`src/utils/workerProtocol.ts`)

Extend `RenderPayload` (post-Phase 13B) to include:
```typescript
labStyleToneCurve?: CurvePoint[];
labStyleChannelCurves?: { r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] };
labTonalCharacterOverride?: Partial<TonalCharacter>;
labSaturationBias?: number;
labTemperatureBias?: number;
```

The main thread resolves the `labStyleId` to these values before sending the render request. The worker remains stateless regarding lab styles — it just applies what it receives.

### UI (`src/components/Sidebar.tsx`)

In the Adjust tab, below the Film Profile selector (`<select>` for `activeProfile`), add a **"Lab Style" dropdown**:

```tsx
<div className="flex items-center gap-2">
  <label className="text-xs text-neutral-400">Lab Style</label>
  <select
    value={activeDoc.labStyleId ?? 'none'}
    onChange={(e) => onLabStyleChange(e.target.value === 'none' ? null : e.target.value)}
    className="..."
  >
    <option value="none">None</option>
    {LAB_STYLE_PROFILES.map(p => (
      <option key={p.id} value={p.id}>{p.name}</option>
    ))}
  </select>
</div>
```

When a lab style is active, show a `<Building2 size={14} />` icon in the status bar (same pattern as the GPU indicator).

### A/B Comparison (ties into 15C)

When `comparisonMode === 'profile-ab'`:
- The render queue fires two concurrent `workerClient.render()` calls: one with the current `labStyleId` (A), one with `labStyleB` (B)
- Both results are drawn to the split canvas (see 15C)
- A small dropdown in the comparison toolbar lets the user pick `labStyleB`

### Undo/Redo Integration

`labStyleId` is included in the undo history entry (same level as `profileId`). Changing lab style pushes to the undo stack via `handleSettingsChange`.

---

## 15B — Improved Auto-Exposure and Color Balance

### Goal
Reduce click count for the common case by auto-analyzing the converted preview's histogram and setting initial exposure/WB values.

### New Module: `src/utils/autoAnalysis.ts`

This module runs on the **main thread** using the histogram already returned by the first preview render — no extra worker round-trip.

```typescript
interface AutoAnalysisResult {
  exposure: number;       // in the ±2.0 slider range
  blackPoint: number;     // 0–100
  whitePoint: number;     // 0–100
  temperature: number;    // slider range
  tint: number;           // slider range
}

function analyzeExposure(histogram: HistogramData): Pick<AutoAnalysisResult, 'exposure' | 'blackPoint' | 'whitePoint'>;
function analyzeColorBalance(histogram: HistogramData): Pick<AutoAnalysisResult, 'temperature' | 'tint'>;
function autoAnalyze(histogram: HistogramData): AutoAnalysisResult;
```

### Auto-Exposure Algorithm

From the luminance histogram (`histogram.l`, 256 bins):
1. Compute cumulative distribution
2. Find P1 (1st percentile) and P99 (99th percentile)
3. Compute: `exposureShift = 0.5 - ((P1 + P99) / 2) / 255` (mapped to ±2.0 range)
4. Set: `blackPoint = P1 / 255 * 100` and `whitePoint = (255 - P99) / 255 * 100`

This maps the image's dynamic range to 2%–98% output.

### Auto Color Balance Algorithm

After auto-exposure, compute per-channel weighted means over the midtone range (bins 64–192):
1. For each channel: `meanC = Σ(i × histogram.c[i]) / Σ(histogram.c[i])` for i ∈ [64, 192]
2. Compute luminance mean `meanL` the same way from `histogram.l`
3. If `|meanR - meanL| > 5`: `tempShift = (meanR - meanB) / 255 * temperatureRange`
4. Derive `tint` from `meanG` deviation similarly

This corrects residual color bias that film-base compensation doesn't fully remove.

### UI: "Auto" Button

Add a `<Wand2 />` (lucide-react) button at the top of the Sidebar's Adjust tab.

**On click:**
1. Check if `exposure`, `temperature`, `tint`, `blackPoint`, or `whitePoint` differ from defaults
2. If so, show `window.confirm('Auto will overwrite your manual adjustments. Continue?')`
3. Run `autoAnalyze(activeDoc.histogram)`
4. Apply via `handleSettingsChange()` (pushes to undo stack — fully undoable)

**Keyboard shortcut:** `Cmd+Shift+A` (registered in `useAppShortcuts`).

### When Auto Runs

Auto-analysis does **not** run automatically on import (to preserve user control). It runs only when:
- The user clicks the Auto button
- Batch mode with auto enabled (see below)

### Batch Integration

Add `batchAutoMode: 'per-image' | 'first-frame'` option to `BatchModal.tsx`:
- `'per-image'` (default): run auto-analysis independently on each entry's render result
- `'first-frame'`: run auto-analysis on the first entry, apply the same `{ exposure, blackPoint, whitePoint, temperature, tint }` as fixed overrides to all subsequent entries

This is useful for roll consistency — same lighting conditions across a strip.

### Coexistence with Curves Auto-Balance

The existing "Curves auto-balance" (wand icon in Curves tab) stretches levels per-channel via curve endpoints. The new auto-exposure/balance operates on main exposure/WB sliders **earlier** in the pipeline (before curves). Both coexist:
- New auto: sets the overall level (exposure, WB)
- Existing curves auto: fine-tunes per-channel distribution

---

## 15C — Split-Screen Before/After Comparison

### Goal
Replace the current full-image toggle with a split-screen comparison (like Lightroom's split-view) for simultaneous evaluation.

### Extended Comparison Mode

Change `comparisonMode` type from `'processed' | 'original'` to:
```typescript
type ComparisonMode = 'off' | 'toggle' | 'split' | 'side-by-side';
```

- `'off'`: normal view (processed only) — replaces current `'processed'`
- `'toggle'`: full-image flip between processed/original — replaces current `'original'`
- `'split'`: vertical/horizontal split divider, draggable
- `'side-by-side'`: two viewports at half width

### New Component: `src/components/SplitComparison.tsx`

**Split divider mode:**

Uses a **single `<canvas>`** with clip regions (not two canvases):
```typescript
// In drawPreview():
ctx.save();
ctx.beginPath();
ctx.rect(0, 0, dividerX, height);
ctx.clip();
// Draw processed image
ctx.restore();

ctx.save();
ctx.beginPath();
ctx.rect(dividerX, 0, width - dividerX, height);
ctx.clip();
// Draw original image
ctx.restore();
```

Benefits:
- No doubled GPU memory
- Zoom/pan perfectly synchronized (same transform matrix)

**Divider interaction:**
- 2px line with a 12px-radius circular drag handle at center
- `isDraggingSplitDivider` state
- On `pointerdown`: capture pointer, update `splitPosition` (0–1) on `pointermove`
- `will-change: transform` on handle for smooth 60fps

**Side-by-side mode:**
- Two viewport regions at half width
- Each renders the full image via separate `drawImage()` calls from the same `ImageData`
- Zoom and pan synchronized: both share the same `useViewportZoom` state

### State Additions

In App.tsx (comparison state is already managed there at line 67):
```typescript
const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('off');
const [splitPosition, setSplitPosition] = useState(0.5);  // 0–1
const [splitOrientation, setSplitOrientation] = useState<'vertical' | 'horizontal'>('vertical');
```

### Render Queue Changes

For `'split'` and `'side-by-side'` modes, the render queue (in `useRenderQueue`) fires **two** `workerClient.render()` calls per frame:
- One with `comparisonMode: 'processed'`
- One with `comparisonMode: 'original'` (or Profile A/B from 15A)

**Performance optimization:** During interactive slider drags, the second (original/B) render uses `interactionQuality: 'draft'` (lower preview level). On interaction end, re-render at `'settled'` quality.

### Toolbar UI

The existing comparison button (`<SplitSquareVertical />` icon) becomes a dropdown flyout (using the existing `TooltipPortal` pattern) with 4 options:
1. Off (no comparison)
2. Toggle (full-image flip)
3. Split (draggable divider)
4. Side-by-side

**Keyboard shortcut:** `C` cycles through the modes. `Cmd+X` preserved for backward compat as alias for toggle mode.

### Canvas Drawing Integration

Modify the `drawPreview()` function in App.tsx to handle all comparison modes:

```typescript
function drawPreview(processedImageData: ImageData, originalImageData?: ImageData) {
  switch (comparisonMode) {
    case 'off':
      // Current behavior — draw processed only
      break;
    case 'toggle':
      // Draw whichever is currently shown (toggle state)
      break;
    case 'split':
      // Clip-region approach described above
      drawSplitComparison(ctx, processedImageData, originalImageData, splitPosition, splitOrientation);
      break;
    case 'side-by-side':
      drawSideBySide(ctx, processedImageData, originalImageData);
      break;
  }
}
```

---

## 15D — Highlight Recovery Improvements

### Goal
Reduce highlight clipping during inversion — the most consistent quality complaint across tools.

### Exposure-Aware Highlight Recovery

**Analysis step** (in the worker, during render):

After inversion and before tonal character, count the percentage of pixels with luminance > 240:
```typescript
let highCount = 0;
for (let i = 0; i < totalPixels; i++) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma > 240) highCount++;
}
const highlightDensity = highCount / totalPixels;  // 0–1
```

Store as `highlightDensity` in `RenderResult` (returned alongside `histogram`).

**Adaptive rolloff** (in `applyTonalCharacter()`, line 209):

Multiply user's `highlightProtection` by an adaptive factor:
```typescript
const effectiveRolloff = highlightRolloff * (1.0 + highlightDensity * 0.5);
```

Dense highlights get up to 50% stronger rolloff automatically.

**GPU path:** Add `highlightDensity: f32` to `ProcessingUniforms`. The WGSL shader applies:
```wgsl
let effectiveRolloff = uniforms.highlightRolloff * (1.0 + uniforms.highlightDensity * 0.5);
```

**Note on GPU `highlightDensity` computation:** Computing `highlightDensity` on the GPU requires a reduction pass (count pixels above threshold). Two approaches:
1. **CPU fallback:** Compute from the histogram (already generated). `highlightDensity = sum(histogram.l[240..255]) / totalPixels`. This avoids a GPU reduction pass and is accurate enough since the histogram is already quantized to 256 bins. **This is the recommended approach.**
2. **GPU compute:** Add a separate compute pass with atomics — more complex, marginal benefit.

Use approach (1): compute `highlightDensity` from the histogram on the main thread after the first render, then pass it back as a uniform for the settled render.

### Per-Channel Highlight Recovery

**Current behavior** (`applyTonalCharacter()`, line 209): operates on a per-value basis — applies shadow lift, midtone anchor, and highlight rolloff with a soft shoulder. Currently applied per-channel identically (lines 656–658).

**New behavior:** Apply rolloff per-channel independently:
```typescript
function applyHighlightRolloff(v: number, anchor: number, strength: number): number {
  if (v <= anchor) return v;
  const excess = (v - anchor) / (1.0 - anchor);
  const compressed = 1.0 - Math.pow(1.0 - excess, 1.0 + strength);
  return anchor + compressed * (1.0 - anchor);
}

pixel.r = applyHighlightRolloff(pixel.r, midtoneAnchor, effectiveRolloff);
pixel.g = applyHighlightRolloff(pixel.g, midtoneAnchor, effectiveRolloff);
pixel.b = applyHighlightRolloff(pixel.b, midtoneAnchor, effectiveRolloff);
```

This lets a blown red channel (common with tungsten-lit scenes) recover independently without affecting green/blue.

**WGSL change** in `tiledRender.wgsl`: Replace the current luminance-based rolloff block with:
```wgsl
fn applyHighlightRolloff(v: f32, anchor: f32, strength: f32) -> f32 {
  if (v <= anchor) { return v; }
  let excess = (v - anchor) / (1.0 - anchor);
  let compressed = 1.0 - pow(1.0 - excess, 1.0 + strength);
  return anchor + compressed * (1.0 - anchor);
}

// In main function:
pixel.r = applyHighlightRolloff(pixel.r, uniforms.midtoneAnchor, effectiveRolloff);
pixel.g = applyHighlightRolloff(pixel.g, uniforms.midtoneAnchor, effectiveRolloff);
pixel.b = applyHighlightRolloff(pixel.b, uniforms.midtoneAnchor, effectiveRolloff);
```

### "Recover Highlights" Button

Add a `<Sunrise />` icon button (lucide-react) next to the Highlight Protection slider in the Adjust tab.

**On click:**
1. Read `histogram.r/g/b` from `WorkspaceDocument.histogram`
2. For each channel, find the highest non-zero bin
3. If any channel has significant counts in bins 253–255 (> 0.1% of total pixels):
   - Increase `highlightProtection` by 10 (clamped to max)
   - Decrease `whitePoint` by 5 (clamped to valid range)
4. Apply via `handleSettingsChange()` (undoable)

### Visual Clipping Indicator: `src/components/ClippingOverlay.tsx`

Overlay colored highlights on clipped areas in the viewport:
- **Red** semi-transparent overlay (`rgba(255, 0, 0, 0.5)`) for clipped highlights (any channel > 253)
- **Blue** overlay (`rgba(0, 0, 255, 0.5)`) for clipped shadows (any channel < 2)

**Implementation:**
After `drawPreview()` draws the processed image, if clipping overlay is enabled:
1. Read back canvas pixels via `ctx.getImageData()`
2. Scan at **1/4 resolution** (every other pixel in X and Y) for performance
3. Draw 2×2 colored blocks at clipped positions

This is a visualization aid only — no precision needed.

**Toggle:** Toolbar button with `<Layers />` icon. Keyboard shortcut: `J` (Lightroom convention).

**State:** `showClippingOverlay: boolean` in App.tsx — session-only, not persisted.

---

## 15E — Shadow Recovery & Tonal Control

### Goal
Add shadow recovery and midtone contrast sliders for fine-grained tonal control.

### New Settings (`src/types.ts` → `ConversionSettings`)

```typescript
shadowRecovery: number;      // 0–100, default 0
midtoneContrast: number;     // -100 to 100, default 0
```

### Shadow Recovery Algorithm

Applied per-channel to the lower 25% of the tonal range:
```typescript
function applyShadowRecovery(v: number, strength: number): number {
  if (v >= 0.25 || strength === 0) return v;
  const t = 1.0 - v / 0.25;  // 1 at black, 0 at boundary
  return v + (0.25 - v) * (strength / 100) * t * t;  // quadratic ease-out
}
```

Lifts the darkest values most, smoothly blends to zero lift at the 25% boundary. Values above 0.25 are untouched.

### Midtone Contrast Algorithm

Parametric S-curve centered at 0.5 luminance:
```typescript
function applyMidtoneContrast(v: number, strength: number): number {
  if (strength === 0) return v;
  const weight = 1.0 - 4.0 * (v - 0.5) * (v - 0.5);  // parabola: peaks at 0.5, zero at 0 and 1
  return 0.5 + (v - 0.5) * (1.0 + (strength / 100) * weight);
}
```

- Positive values: boost contrast in midtones (S-curve)
- Negative values: flatten midtones (inverse S-curve)
- Shadows and highlights untouched (weight → 0 at extremes)

### Pipeline Placement

Both controls are applied in `processImageData()` **after** the contrast block (line 652–654) and **before** `applyTonalCharacter` (line 656). This places them between contrast and highlight protection in the pipeline.

```
... → flare → light-source → inversion → film-base → color-matrix →
  → color balance/temperature/tint → B&W mix → exposure → black/white point → contrast →
  → [NEW] shadow recovery → [NEW] midtone contrast →
  → tonal character (highlight protection) → saturation → curves → noise reduction → sharpen
```

### GPU Path

Add to `ProcessingUniforms`:
```wgsl
shadowRecovery: f32,
midtoneContrast: f32,
```

In `src/utils/gpu/shaders/tiledRender.wgsl`, insert between the white/black point block and curve LUT lookup:
```wgsl
// Shadow recovery
if (uniforms.shadowRecovery > 0.0) {
  if (pixel.r < 0.25) {
    let t = 1.0 - pixel.r / 0.25;
    pixel.r += (0.25 - pixel.r) * uniforms.shadowRecovery * t * t;
  }
  // Same for .g and .b
}

// Midtone contrast
if (uniforms.midtoneContrast != 0.0) {
  let wr = 1.0 - 4.0 * (pixel.r - 0.5) * (pixel.r - 0.5);
  pixel.r = 0.5 + (pixel.r - 0.5) * (1.0 + uniforms.midtoneContrast * wr);
  // Same for .g and .b
}
```

### UI

Two new `<Slider>` components in the Sidebar's Adjust tab:
- **Shadow Recovery** (0–100, default 0) — between Highlight Protection and Saturation
- **Midtone Contrast** (-100 to +100, default 0) — below Shadow Recovery

Use the existing `<Slider>` component pattern with the same styling.

### Defaults & Constants

In `src/constants.ts`, add to `DEFAULT_CONVERSION_SETTINGS`:
```typescript
shadowRecovery: 0,
midtoneContrast: 0,
```

---

## Implementation Order

The sub-features have some dependencies. Recommended implementation sequence:

### Step 1: Type & Pipeline Foundation
1. Add `shadowRecovery`, `midtoneContrast` to `ConversionSettings` in `types.ts`
2. Add `toneCurve` field to `FilmProfile` in `types.ts`
3. Add `LabStyleProfile` type and `labStyleId`/`labStyleB` to `WorkspaceDocument`
4. Extend `ComparisonMode` type
5. Update `DEFAULT_CONVERSION_SETTINGS` in `constants.ts`

### Step 2: 15E — Shadow Recovery & Midtone Contrast (simplest pipeline change)
1. Implement `applyShadowRecovery()` and `applyMidtoneContrast()` in `imagePipeline.ts`
2. Insert into `processImageData()` pipeline at correct position
3. Add uniforms to `buildProcessingUniforms()`
4. Add WGSL shader code
5. Add two `<Slider>` components to Sidebar Adjust tab
6. Test with existing images

### Step 3: 15D — Highlight Recovery Improvements
1. Implement per-channel `applyHighlightRolloff()` (replace luminance-based version)
2. Add `highlightDensity` computation from histogram
3. Implement adaptive rolloff scaling
4. Update WGSL shader with per-channel rolloff function
5. Add "Recover highlights" button to Sidebar
6. Implement `ClippingOverlay.tsx` component
7. Add toolbar toggle button and `J` keyboard shortcut

### Step 4: 15B — Auto-Exposure & Color Balance
1. Create `src/utils/autoAnalysis.ts` with `analyzeExposure()` and `analyzeColorBalance()`
2. Add `<Wand2 />` Auto button to Adjust tab
3. Register `Cmd+Shift+A` keyboard shortcut
4. Add `batchAutoMode` option to `BatchModal.tsx`
5. Test against diverse film stocks and scanning conditions

### Step 5: 15A — Minilab Emulation Profiles
1. Define 4 lab style profiles in `constants.ts` (curves + biases)
2. Extend `buildCurveLutBuffer()` for LUT fusion
3. Add lab style bias handling in `buildProcessingUniforms()`
4. Add "Lab Style" dropdown to Sidebar Adjust tab
5. Add `<Building2 />` status bar indicator
6. Wire `labStyleId` into undo/redo history
7. Implement Profile A/B render path in `useRenderQueue`

### Step 6: 15C — Split-Screen Comparison
1. Extend comparison mode state and cycling logic
2. Create `SplitComparison.tsx` with clip-region rendering
3. Implement divider interaction (drag handle)
4. Implement side-by-side mode with synchronized zoom/pan
5. Create comparison mode dropdown flyout on toolbar button
6. Add `C` keyboard shortcut for mode cycling
7. Optimize: draft quality for second render during interactions

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `src/types.ts` | Add `shadowRecovery`, `midtoneContrast` to `ConversionSettings`; `toneCurve` to `FilmProfile`; new `LabStyleProfile` type; extend `ComparisonMode`; `labStyleId`/`labStyleB` on `WorkspaceDocument`; `highlightDensity` on `RenderResult` |
| `src/constants.ts` | New defaults; 4 lab style profiles; `LAB_STYLE_PROFILES` export |
| `src/utils/imagePipeline.ts` | `applyShadowRecovery()`, `applyMidtoneContrast()`, per-channel `applyHighlightRolloff()`; extend `buildCurveLutBuffer()` (line 405) for LUT fusion; adaptive rolloff in `applyTonalCharacter()` (line 209); update `buildProcessingUniforms()` |
| `src/utils/gpu/shaders/tiledRender.wgsl` | New uniforms (`shadowRecovery`, `midtoneContrast`, `highlightDensity`); per-channel rolloff function; shadow recovery + midtone contrast blocks in the live GPU shader path |
| `src/utils/gpu/WebGPUPipeline.ts` | Update uniform buffer layout to include new fields |
| `src/utils/autoAnalysis.ts` | **New file** — `analyzeExposure()`, `analyzeColorBalance()`, `autoAnalyze()` |
| `src/components/SplitComparison.tsx` | **New file** — split divider + side-by-side rendering |
| `src/components/ClippingOverlay.tsx` | **New file** — highlight/shadow clipping visualization |
| `src/components/Sidebar.tsx` | Lab Style dropdown; Auto button; Shadow Recovery + Midtone Contrast sliders; Recover Highlights button |
| `src/App.tsx` | Extended comparison mode state (line 67); `splitPosition`/`splitOrientation` state; `showClippingOverlay` state; `drawPreview()` split/side-by-side handling; `C`/`J` keyboard shortcuts (via `useAppShortcuts`) |
| `src/utils/workerProtocol.ts` | Extended `RenderPayload` with lab style fields |
| `src/utils/imageWorkerClient.ts` | Pass lab style data in render requests |
| `src/utils/imageWorker.ts` | Forward lab style data to pipeline; return `highlightDensity` |
| `src/utils/batchProcessor.ts` | `batchAutoMode` support; auto-analysis integration |
| `src/components/BatchModal.tsx` | `batchAutoMode` UI option |

## Testing Strategy

- **Unit tests** (`autoAnalysis.test.ts`): synthetic histograms → verify exposure/WB calculations
- **Unit tests** (`imagePipeline.test.ts`): verify shadow recovery, midtone contrast, per-channel rolloff produce expected pixel values on small test buffers
- **Unit tests** (`buildCurveLutBuffer` with lab curves): verify LUT fusion composition order
- **Visual regression**: render the same scan with each lab style, compare against reference outputs
- **Performance**: benchmark `buildCurveLutBuffer` with and without lab curves (target < 0.5 ms); benchmark clipping overlay scan at 1/4 resolution (target < 5 ms for 2048px)
- **Undo/redo**: verify lab style changes are fully undoable; verify auto-exposure is undoable
