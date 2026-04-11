# Inversion Improvement Plan — DarkSlide

> **Goal:** Make color negative inversion consistently reliable across film stocks, exposure conditions, and capture setups without requiring per-image manual correction.  
> **Scope:** Changes to `rawImport.ts`, `imagePipeline.ts`, `imageWorker.ts`, `constants.ts`, and `types.ts`. No new UI panels in Phase 1.  
> **Date:** April 2026

---

## Diagnosis: What's Currently Broken and Why

### What already works

- **Border-based Dmin detection** exists in `rawImport.ts:87` → `estimateFilmBaseSampleWithStride`: samples the outer 3% border strip, takes the top 12% by luminance, and averages them. Structurally sound.
- **Per-channel advanced H-D inversion** exists: `applyAdvancedHdInversion` (`imagePipeline.ts:332`) applies per-channel gamma/density curves, and `resolveAdvancedHdParameters` (`imagePipeline.ts:345`) builds the parameters.
- **Per-channel base density** is already tracked as a 3-tuple.
- **Per-stock color matrices** already exist in `constants.ts:226` (22 stocks), and **advanced inversion profiles** (gamma + baseDensityFallback) in `constants.ts:244` (22 stocks).
- **Film base sample** flows from decode → `StoredDocument.estimatedFilmBaseSample` → `DecodedImage` → `WorkspaceDocument` → `RenderRequest` → `processImageData` / `buildProcessingUniforms`.

### What's missing or weak

| Gap | Symptom | Root cause |
|---|---|---|
| Dmin detection is a luminance average, not a modal cluster | Bright light leaks or highlights in the border skew the base estimate upward → color cast post-inversion | `estimateFilmBaseSampleWithStride` sorts by luminance then averages the top 12% — outlier-dominated |
| Density balance (per-channel scale) is not auto-computed | Colors correct in midtones, wrong in shadows and highlights | Per-channel gamma equalization requires `scale_R`, `scale_G`, `scale_B` from the midtone histogram in density space; this step is absent |
| Residual base color is not removed after inversion | Shadows are brownish or greenish instead of neutral black | The film base, even after Dmin subtraction, leaves a residual color in dense areas that must be subtracted post-inversion |
| No per-stock density balance presets | Ektar fails worse than Portra; Fuji 400H fails most | Density balance values are relatively stable per film stock × backlight; a small lookup table would cover 90% of use cases |
| Working color space for inversion unclear | Saturated stocks (Ektar, cross-process) show color posterization | Inversion must happen in wide-gamut linear space; sRGB clips in dense negative areas |

---

## Phase 1 — High Impact, Minimal Scope (implement first)

These address the two root causes responsible for most catastrophic failures.

### 1.1 — Robustify Dmin detection with modal cluster sampling

**File:** `src/utils/rawImport.ts` → `estimateFilmBaseSampleWithStride` (line 87)

**Problem:** The current approach sorts all border samples by luminance and averages the top 12%. A single bright light leak corner can pull the estimate significantly high, causing the entire inversion to be mis-anchored.

**Current algorithm** (lines 100–165):
1. Walk the outer 3% border strip, push `{ lum, r, g, b }` into `samples[]`.
2. Sort by `lum` descending.
3. Take the top 12% (`takeCount`).
4. Average R, G, B across those samples.
5. Reject if average per-channel deviation > 24.

**New algorithm — per-channel modal clustering:**

Replace the sort-then-average with:

```typescript
function estimateFilmBaseSampleWithStride(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  stride: 3 | 4,
): FilmBaseSample | null {
  // ... existing border sampling loop stays identical (lines 93–127) ...

  if (samples.length < 24) return null;

  // Per-channel modal cluster instead of luminance-average
  const result = { r: 0, g: 0, b: 0 };

  for (const channel of ['r', 'g', 'b'] as const) {
    // 1. Build a coarse histogram (64 bins over [0, 255])
    const BIN_COUNT = 64;
    const BIN_WIDTH = 256 / BIN_COUNT; // 4
    const bins = new Uint32Array(BIN_COUNT);
    for (const s of samples) {
      const bin = Math.min(BIN_COUNT - 1, Math.floor(s[channel] / BIN_WIDTH));
      bins[bin]++;
    }

    // 2. Find the mode bin
    let modeBin = 0;
    for (let i = 1; i < BIN_COUNT; i++) {
      if (bins[i] > bins[modeBin]) modeBin = i;
    }

    // 3. Average samples within ±10 units of the mode bin center
    const modeCenter = (modeBin + 0.5) * BIN_WIDTH;
    const RADIUS = 10;
    let sum = 0;
    let count = 0;
    for (const s of samples) {
      if (Math.abs(s[channel] - modeCenter) <= RADIUS) {
        sum += s[channel];
        count++;
      }
    }

    if (count < 12) return null; // Not enough agreement — bail
    result[channel] = clamp(Math.round(sum / count), 1, 255);
  }

  // Sanity check: reject if channels are implausibly close (not a negative)
  // or if any channel is near zero (black border, not film base)
  if (Math.min(result.r, result.g, result.b) < 5) return null;

  return result;
}
```

**Why per-channel matters:** The film base is orange — `R_base > G_base >> B_base`. A luminance average conflates the channels. The modal cluster must be found independently per channel.

**Files touched:**
- `src/utils/rawImport.ts:87–165` — replace the body of `estimateFilmBaseSampleWithStride`
- `src/utils/rawImport.test.ts` — add test with outlier border samples

**Acceptance test:** An image with a bright specular highlight touching the border should produce the same base estimate (±2 per channel) as the same image without the highlight.

---

### 1.2 — Auto-compute per-channel density balance from midtone histogram

**Problem:** Per-channel gamma equalization requires `scale_R` and `scale_B` relative to a green anchor. Without them, a scene-neutral gray shifts color progressively from shadows to highlights.

**The math:**

1. After Dmin subtraction but before inversion, convert to density space:
   ```
   density_ch = -log10(linear_ch / base_ch)
   ```
   Where `base_ch` is the film base sample value (normalized 0–1). Use `sampleChannelToDensity()` (`imagePipeline.ts:304`) which already does `-log10(clamp(value/255, ε, 1))`.

2. For each channel, compute the mean density over the 20th–80th percentile of the midtone range.

3. Set `scale_ch = mean_density_G / mean_density_ch` (green is the anchor; it has the least orange-mask contamination).

4. Clamp results to [0.4, 2.0] to prevent runaway from a bad base estimate.

**New type in `types.ts`:**

```typescript
export interface DensityBalance {
  scaleR: number;  // typically ~1.0 for most C-41 stocks
  scaleG: number;  // always 1.0 (anchor)
  scaleB: number;  // typically 0.5–0.7 for most C-41 stocks
  source: 'auto-histogram' | 'film-stock-preset' | 'manual';
}
```

Add `estimatedDensityBalance?: DensityBalance | null;` to:
- `DecodedImage` (`types.ts:306`) — returned from decode
- `WorkspaceDocument` (`types.ts:322`) — stored on the document
- `RenderRequest` (`types.ts:372`) — passed to render
- `ExportRequest` (`types.ts:424`) — passed to export
- `StoredDocument` (`imageWorker.ts:76`) — worker-side storage

**New function in `imagePipeline.ts`:**

```typescript
export function computeDensityBalance(
  imageData: ImageData,
  filmBaseSample: FilmBaseSample,
): DensityBalance {
  const { data, width, height } = imageData;
  const baseR = filmBaseSample.r / 255;
  const baseG = filmBaseSample.g / 255;
  const baseB = filmBaseSample.b / 255;

  // Collect per-channel densities for all pixels
  const densitiesR: number[] = [];
  const densitiesG: number[] = [];
  const densitiesB: number[] = [];

  // Sample with stride for performance (target ~50k pixels)
  const totalPixels = width * height;
  const stride = Math.max(1, Math.floor(totalPixels / 50000));

  for (let i = 0; i < data.length; i += 4 * stride) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    // Skip near-black pixels (film rebate / unexposed) and near-white (specular)
    if (r < 0.02 || g < 0.02 || b < 0.02) continue;
    if (r > 0.98 && g > 0.98 && b > 0.98) continue;

    // Compute density relative to film base
    const dR = -Math.log10(Math.max(r / baseR, 1e-6));
    const dG = -Math.log10(Math.max(g / baseG, 1e-6));
    const dB = -Math.log10(Math.max(b / baseB, 1e-6));

    // Only keep positive densities (denser than base)
    if (dR > 0 && dG > 0 && dB > 0) {
      densitiesR.push(dR);
      densitiesG.push(dG);
      densitiesB.push(dB);
    }
  }

  if (densitiesR.length < 100) {
    return { scaleR: 1.0, scaleG: 1.0, scaleB: 0.6, source: 'auto-histogram' };
  }

  // Sort each channel to find percentiles
  densitiesR.sort((a, b) => a - b);
  densitiesG.sort((a, b) => a - b);
  densitiesB.sort((a, b) => a - b);

  // Mean of 20th–80th percentile
  const lo = Math.floor(densitiesR.length * 0.2);
  const hi = Math.floor(densitiesR.length * 0.8);
  const meanR = mean(densitiesR, lo, hi);
  const meanG = mean(densitiesG, lo, hi);
  const meanB = mean(densitiesB, lo, hi);

  return {
    scaleR: clamp(meanG / Math.max(meanR, 1e-6), 0.4, 2.0),
    scaleG: 1.0,
    scaleB: clamp(meanG / Math.max(meanB, 1e-6), 0.4, 2.0),
    source: 'auto-histogram',
  };
}

function mean(sorted: number[], lo: number, hi: number): number {
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += sorted[i];
  return sum / Math.max(1, hi - lo);
}
```

**Integration in `imageWorker.ts` — compute at decode time:**

In the decode handler (around lines 730–760 and 808–840), after `estimateCanvasFilmBase`:

```typescript
const estimatedFilmBaseSample = estimateCanvasFilmBase(canvas);

// NEW: Compute density balance from full-resolution image data
let estimatedDensityBalance: DensityBalance | null = null;
if (estimatedFilmBaseSample) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    const fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    estimatedDensityBalance = computeDensityBalance(fullImageData, estimatedFilmBaseSample);
  }
}

documents.set(payload.documentId, {
  // ... existing fields ...
  estimatedFilmBaseSample,
  estimatedDensityBalance,  // NEW
  lastAccessedAt: Date.now(),
});
```

Return `estimatedDensityBalance` in the `DecodedImage` result.

**Integration in `resolveAdvancedHdParameters` (`imagePipeline.ts:345`):**

Add a `densityBalance?: DensityBalance | null` parameter. When present, scale the per-channel gamma:

```typescript
export function resolveAdvancedHdParameters(
  settings: Pick<ConversionSettings, 'inversionMethod' | 'filmBaseSample'>,
  isColor: boolean,
  filmType: FilmProfileType,
  advancedInversion?: AdvancedInversionProfile | null,
  estimatedFilmBaseSample?: FilmBaseSample | null,
  inputProfileId: ColorProfileId = 'srgb',
  outputProfileId: ColorProfileId = 'srgb',
  lightSourceBias: [number, number, number] = [1, 1, 1],
  densityBalance?: DensityBalance | null,  // NEW
) {
  // ... existing resolution logic (lines 355–393) ...

  // NEW: Apply density balance to gamma values
  if (densityBalance) {
    gamma[0] *= densityBalance.scaleR;
    // gamma[1] unchanged — green is anchor (scaleG is always 1.0)
    gamma[2] *= densityBalance.scaleB;
  }

  // ... rest unchanged ...
}
```

**Threading the new parameter through callers:**

All callers of `resolveAdvancedHdParameters` need the new `densityBalance` argument:

| Caller | File:Line | How it gets `densityBalance` |
|---|---|---|
| `processImageData` | `imagePipeline.ts:843` | New parameter on `processImageData` (add after `lightSourceBias`) |
| `buildProcessingUniforms` | `imagePipeline.ts:538` | New parameter on `buildProcessingUniforms` (add after `lightSourceBias`) |
| `applyAutoWhiteBalanceAnalysisStage` | `imageWorker.ts:1003` | Read from `StoredDocument` |
| Worker render handler | `imageWorker.ts` (various) | Read from `StoredDocument`, pass via `RenderRequest` |

**GPU pipeline (`WebGPUPipeline.ts`):**

`buildProcessingUniforms` is called at `WebGPUPipeline.ts:569`. The GPU path feeds `resolveAdvancedHdParameters` indirectly through `buildProcessingUniforms`, so adding the parameter there automatically covers the GPU path. No WGSL shader changes needed — density balance modifies gamma values on the CPU side before they're packed into the uniform buffer.

**Acceptance test:** A neutral gray card photographed anywhere in tonal range (shadow / midtone / highlight) should invert to neutral gray ±5 units per channel after this step.

---

## Phase 2 — Medium Impact, Targeted Fixes

### 2.1 — Post-inversion residual base correction

**File:** `src/utils/imagePipeline.ts` → in `processImageData`, after the inversion block (line 907) and before color matrix (line 909)

**Problem:** Even with correct Dmin subtraction and density balance, the inverted image often has a slight color in the deepest shadows (should be 0, 0, 0 but is brownish or greenish). This is a small residual from imperfect base estimation.

**Fix — two-pass approach:**

This requires a pre-analysis pass, because we need to know the 1st-percentile pixel values before we can subtract them during the main render pass.

**Step 1 — Analysis pass in `imageWorker.ts`:**

Add a new function `computeResidualBaseOffset` that runs the inversion stage on a downsampled preview, then finds the 1st-percentile RGB of the result:

```typescript
function computeResidualBaseOffset(
  document: StoredDocument,
  settings: ConversionSettings,
  isColor: boolean,
  filmType: FilmProfileType,
  advancedInversion: AdvancedInversionProfile | null,
  inputProfileId: ColorProfileId,
  outputProfileId: ColorProfileId,
  lightSourceBias: [number, number, number],
  densityBalance: DensityBalance | null,
): [number, number, number] | null {
  // Use the smallest preview level for speed
  const preview = document.previews[0]; // 512px level
  const ctx = preview.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const imageData = ctx.getImageData(0, 0, preview.canvas.width, preview.canvas.height);
  const { data } = imageData;

  // Run inversion-only on each pixel, collect per-channel values
  const values: { r: number; g: number; b: number }[] = [];
  // ... (apply same flare/light-source/inversion logic as processImageData lines 881-907)
  // ... (collect inverted r, g, b into values[])

  // Sort each channel, find 1st percentile
  const n = values.length;
  const p1Index = Math.floor(n * 0.01);
  const rs = values.map(v => v.r).sort((a, b) => a - b);
  const gs = values.map(v => v.g).sort((a, b) => a - b);
  const bs = values.map(v => v.b).sort((a, b) => a - b);

  return [rs[p1Index], gs[p1Index], bs[p1Index]];
}
```

**Step 2 — Apply in `processImageData`:**

After the inversion block and before color matrix, subtract the residual offset:

```typescript
// After line 907 (end of inversion), before line 909 (color matrix):
if (residualBaseOffset) {
  r = Math.max(0, r - residualBaseOffset[0]);
  g = Math.max(0, g - residualBaseOffset[1]);
  b = Math.max(0, b - residualBaseOffset[2]);
}
```

**New setting — toggle in `ConversionSettings`:**

```typescript
// types.ts — add to ConversionSettings
residualBaseCorrection?: boolean;  // default true
```

Keep it behind this toggle so it can be disabled for images without true black (e.g., low-key night shots, foggy scenes).

**GPU path:** Add the residual offset as 3 new floats in the uniform buffer (`buildProcessingUniforms`), apply in the WGSL shader after inversion. Alternatively, fold into the existing `flareFloor` uniform since the math is similar (subtract + clamp).

---

### 2.2 — Per-film-stock density balance presets

**File:** `src/constants.ts` → new `FILM_STOCK_DENSITY_PRESETS` record  
**File:** `src/types.ts` → new `filmStockDensityPreset` field on `ConversionSettings`

**Problem:** The auto-histogram approach (1.2) works well when the image has a good tonal spread. For thin negatives (underexposed, pushed film) or images with very little midtone content, the histogram-based estimate is unreliable. A lookup table of known-good values gives a reliable fallback.

**Known good starting points (white LED backlight, camera at daylight WB):**

| Film Stock | Profile ID (existing) | scaleR | scaleG | scaleB |
|---|---|---|---|---|
| Kodak Portra 160 | `portra-160` | 1.0 | 1.0 | 0.63 |
| Kodak Portra 400 | `portra-400` | 1.0 | 1.0 | 0.62 |
| Kodak Portra 800 | `portra-800` | 1.0 | 1.0 | 0.61 |
| Kodak Ektar 100 | `ektar-100` | 1.0 | 1.0 | 0.58 |
| Kodak Gold 200 | `gold-200` | 1.0 | 1.0 | 0.60 |
| Kodak Gold 100 | `gold-100` | 1.0 | 1.0 | 0.60 |
| Kodak UltraMax 400 | `ultramax-400` | 1.0 | 1.0 | 0.59 |
| Kodak ColorPlus 200 | `colorplus-200` | 1.0 | 1.0 | 0.60 |
| Fujifilm 200 | `fujifilm-200` | 1.0 | 1.0 | 0.57 |
| Fujifilm Superia 400 | `superia-400` | 1.0 | 1.0 | 0.55 |
| Fujifilm Pro 400H | `fuji-400h` | 1.0 | 1.0 | 0.53 |
| CineStill 800T | `cinestill-800t` | 1.0 | 1.0 | 0.68 |
| CineStill 50D | `cinestill-50d` | 1.0 | 1.0 | 0.60 |
| Lomo 400 | `lomo-400` | 1.0 | 1.0 | 0.58 |
| Generic C-41 | `generic-color` | 1.0 | 1.0 | 0.60 |

*(Approximate empirical starting points. Validate against known-good scans before shipping.)*

**Implementation in `constants.ts`:**

```typescript
export const FILM_STOCK_DENSITY_PRESETS: Record<string, Omit<DensityBalance, 'source'>> = {
  'portra-160': { scaleR: 1.0, scaleG: 1.0, scaleB: 0.63 },
  'portra-400': { scaleR: 1.0, scaleG: 1.0, scaleB: 0.62 },
  // ... etc, keyed by existing profile IDs from FILM_PROFILES
};
```

**Resolution logic — add to `resolveAdvancedHdParameters`:**

Priority order for density balance:
1. **Manual** (future Phase 3 neutral picker) — highest priority
2. **Film stock preset** — if the user has selected a specific stock and it has a preset
3. **Auto-histogram** — the computed `estimatedDensityBalance`
4. **Fallback** — `{ scaleR: 1.0, scaleG: 1.0, scaleB: 0.6 }`

The `profileId` from `WorkspaceDocument` already identifies the film stock. Thread it into `resolveAdvancedHdParameters` to look up `FILM_STOCK_DENSITY_PRESETS[profileId]`.

**No new UI needed for this step.** The existing film profile selector already sets `profileId`. The density preset lookup is automatic based on the selected profile.

**Note on CineStill/tungsten stocks:** After density balance, apply a secondary daylight→tungsten WB shift (+~500K) to correct for the tungsten color balance of the film. This is the root cause of the "green cast on CineStill" failure mode. This can be baked into the `ADVANCED_INVERSION_PROFILES` entry for `cinestill-800t` as an adjusted blue gamma rather than requiring a separate WB step.

---

### 2.3 — Audit and enforce linear working space for inversion

**File:** `src/utils/imagePipeline.ts` → inversion section (lines 878–907)

**Problem:** sRGB clips in dense negative areas and applies a gamma curve that makes the density-space math wrong. Inverting in sRGB produces muddy desaturated results on saturated stocks (Ektar, cross-process E6).

**Current state (audit results):**

The pipeline does `convertRgbBetweenProfiles` at line 878 before inversion. This function (in `colorProfiles.ts`) applies:
1. Inverse transfer function of the input profile (decode gamma → linear)
2. 3×3 matrix transform between profiles
3. Forward transfer function of the output profile (linear → encode gamma)

**The issue:** When `inputProfileId === outputProfileId` (common case: both `srgb`), the conversion is a no-op — the values stay gamma-encoded and inversion happens in gamma space. The advanced-HD path's `log10(transmittance)` assumes linear input.

**Required fix:**

For the advanced-HD inversion path, ensure the pixel values are linearized before density math. Two approaches:

**Option A — Explicit linearize/delinearize around inversion (recommended):**

```typescript
// Before inversion (after line 887):
if (advancedHd.enabled) {
  // Linearize: remove sRGB gamma for density-space math
  r = srgbToLinear(r);
  g = srgbToLinear(g);
  b = srgbToLinear(b);

  r = applyAdvancedHdInversion(r, advancedHd.baseDensity[0], advancedHd.gamma[0]);
  g = applyAdvancedHdInversion(g, advancedHd.baseDensity[1], advancedHd.gamma[1]);
  b = applyAdvancedHdInversion(b, advancedHd.baseDensity[2], advancedHd.gamma[2]);
  // Output of HD inversion is already in perceptual space — no re-encode needed
}
```

The `srgbToLinear` function already exists in `colorProfiles.ts` as `srgbInverseTransfer`. Import and use it.

**Option B — Force conversion through a linear intermediate:**

When `inputProfileId === outputProfileId`, still run the conversion through linear space by splitting into decode → (inversion in linear) → encode. This is more invasive and changes behavior for the standard path too.

**Recommendation:** Go with Option A. It's surgical, only affects the advanced-HD path, and the `applyAdvancedHdInversion` output is already designed to produce perceptual-space values (the `1 - 10^(-density/gamma)` mapping acts as its own tone curve).

**GPU path:** The WGSL shader for `buildProcessingUniforms` would need the same linearize step before HD inversion. Add a utility function in the WGSL shader. The intermediate texture format is `rgba16float`, so no precision issues.

**Document the contract:** Add a comment at the top of `processImageData`:

```typescript
/**
 * Input encoding contract:
 * - Pixels arrive as 8-bit sRGB (or the profile specified by inputProfileId).
 * - convertRgbBetweenProfiles handles cross-profile conversion.
 * - Advanced-HD inversion explicitly linearizes before density math.
 * - All post-inversion operations expect perceptual-space (gamma-encoded) values.
 */
```

---

## Phase 3 — Lower Priority / Future Work

### 3.1 — Two-point neutral picker for manual density balance correction

Expose a UI control allowing the user to click two tonally-separated neutral areas in the image (e.g., shadow gray card, highlight gray card). The tool solves for `scale_R` and `scale_B` from those two constraints — the same approach as RawTherapee's film negative tool. This gives users a path to correct stocks not in the preset table or images with unusual lighting.

**Implementation:** Extend the existing `sampleFilmBase` worker function (`imageWorkerClient.ts`) to support a "neutral point" mode. Two neutral points + the film base sample (three constraints × three channels) is enough to solve the per-channel exponents analytically.

The result would produce a `DensityBalance` with `source: 'manual'`, which takes highest priority in the resolution chain.

### 3.2 — Per-roll color checker calibration

One frame of a photographed X-Rite ColorChecker on the same roll → derive the exact `DensityBalance` for the roll mathematically. All subsequent frames inherit those values via the `Roll.filmBaseSample` mechanism already in `types.ts:196`. This is lab-grade accuracy for power users. Implement as a separate "Calibrate roll" flow, not part of the default path.

### 3.3 — Density mixing matrix (dye cross-talk correction)

The Filmeon / Darktable Negadoctor approach: apply a 3×3 matrix in density space to correct for inter-layer dye contamination (cyan dye absorbs some green, etc.). This is the physically rigorous fix for heavy-mask edge cases (dense Fuji 400H, expired film). Requires per-stock calibration data. Implement after 2.2 (presets) since the matrix needs the same per-stock infrastructure.

This would live alongside the existing `COLOR_MATRICES` (`constants.ts:226`) but applied in density space (before inversion) rather than in RGB space (after inversion).

---

## Implementation Order & Checklist

### Phase 0 — Regression baseline (implement BEFORE any algorithm changes)

- [ ] **`imagePipeline.test.ts`**: Add `describe('inversion regression snapshots')` with snapshot tests R1 #1–8
- [ ] **`rawImport.test.ts`**: Add snapshot tests R1 #9–11 (including mixed-border outlier case)
- [ ] **`imagePipeline.test.ts`**: Convert key `resolveAdvancedHdParameters` assertions to inline snapshots (R1 #12–13)
- [ ] **`src/utils/testHelpers.ts`**: Add `pixelRmse` utility (R6)
- [ ] **`imagePipeline.test.ts`**: Add CPU ↔ GPU parity test for current uniform layout (R4)
- [ ] **Visual**: Export reference images (R5 #1–7) at current default settings → `reference_v0_*.png`
- [ ] **`Docs/Improve inversion/regression-test-manifest.md`**: Document reference image set + RMSE thresholds
- [ ] Verify: `npm run test` passes, all snapshots captured

### Phase 1a — Type threading (zero behavioral change)

- [ ] **`types.ts`**: Add `DensityBalance` interface
- [ ] **`types.ts:306`** (`DecodedImage`): Add `estimatedDensityBalance?: DensityBalance | null`
- [ ] **`types.ts:322`** (`WorkspaceDocument`): Add `estimatedDensityBalance?: DensityBalance | null`
- [ ] **`types.ts:372`** (`RenderRequest`): Add `estimatedDensityBalance?: DensityBalance | null`
- [ ] **`types.ts:424`** (`ExportRequest`): Add `estimatedDensityBalance?: DensityBalance | null`
- [ ] **`imageWorker.ts:76`** (`StoredDocument`): Add `estimatedDensityBalance: DensityBalance | null`
- [ ] **`imagePipeline.ts:345`** (`resolveAdvancedHdParameters`): Add `densityBalance?: DensityBalance | null` parameter (no-op when null)
- [ ] **`imagePipeline.ts:801`** (`processImageData`): Add `densityBalance` parameter, pass through
- [ ] **`imagePipeline.ts:510`** (`buildProcessingUniforms`): Add `densityBalance` parameter, pass through
- [ ] **`imagePipeline.test.ts`**: Add null-path parity test (R2) — confirm all R1 snapshots unchanged
- [ ] Verify: `npm run test` passes with **zero** snapshot changes

### Phase 1b — Modal cluster Dmin detection

- [ ] **`rawImport.ts:87–165`**: Replace luminance-average base estimation with per-channel modal cluster
- [ ] **`rawImport.test.ts`**: Update snapshot #9 (expected to change); add outlier rejection test, confirm #10 improves
- [ ] **Visual**: Re-export reference images → `reference_v1b_*.png`, compute RMSE vs v0. Expect RMSE = 0 for images without border outliers, RMSE < 8 for images with border issues (improvement)
- [ ] Verify: `npm run test` passes — only rawImport snapshots should update

### Phase 1c — Density balance computation and application

- [ ] **`imagePipeline.ts`**: Add `computeDensityBalance()` function
- [ ] **`imagePipeline.test.ts`**: Unit tests for `computeDensityBalance` — synthetic uniform image returns `{ 1.0, 1.0, ~0.6 }`, pure gray returns `{ 1.0, 1.0, 1.0 }`
- [ ] **`imageWorker.ts:730,808`**: Call `computeDensityBalance` at decode time, store on `StoredDocument`, return in `DecodedImage`
- [ ] **`imageWorker.ts`** (render handlers): Thread `estimatedDensityBalance` from `StoredDocument` through render calls
- [ ] **`imageWorkerClient.ts`**: Thread `estimatedDensityBalance` through the client ↔ main-thread bridge
- [ ] **`App.tsx`**: Store `estimatedDensityBalance` on `WorkspaceDocument` when decode completes, pass to render requests
- [ ] **`imagePipeline.ts:345`** (`resolveAdvancedHdParameters`): Apply `densityBalance` to gamma when non-null
- [ ] **`imagePipeline.test.ts`**: Extend `resolveAdvancedHdParameters` tests with density balance cases
- [ ] **`imagePipeline.test.ts`**: Update R1 snapshots #2, #3, #4, #8 (advanced-HD path changed). Standard-path snapshots #1, #5, #6, #7 must remain **unchanged**
- [ ] **`imagePipeline.test.ts`**: Add bounded-delta test (R6) — RMSE between null and computed density balance is > 0 and < 10
- [ ] **Visual**: Re-export reference images → `reference_v1c_*.png`. Standard-path images: RMSE = 0. Advanced-HD images: RMSE < 10, visually improved shadow/highlight color balance

### Phase 2 (can be done incrementally)

- [ ] **`imagePipeline.ts:907`**: Add residual base subtraction pass (post-inversion, before color matrix)
- [ ] **`imageWorker.ts`**: Add `computeResidualBaseOffset` analysis pass at decode or first render
- [ ] **`types.ts`** (`ConversionSettings`): Add `residualBaseCorrection?: boolean` (default `true`)
- [ ] **`constants.ts`**: Add `FILM_STOCK_DENSITY_PRESETS` record keyed by existing profile IDs
- [ ] **`imagePipeline.ts:345`**: Add preset lookup in `resolveAdvancedHdParameters` with priority chain (manual > preset > auto > fallback)
- [ ] **`imagePipeline.ts:878–892`**: Linearize before advanced-HD inversion (`srgbInverseTransfer`)
- [ ] **GPU shader** (`WebGPUPipeline.ts`): Add linearize step in WGSL before HD inversion
- [ ] **`imagePipeline.ts:801`**: Add encoding contract comment

### Phase 3 (post-1.0)

- [ ] Two-point neutral picker UI + worker math → produces `DensityBalance` with `source: 'manual'`
- [ ] Color checker calibration workflow → per-roll `DensityBalance` stored on `Roll`
- [ ] Density mixing 3×3 matrix in density space (pre-inversion)

---

## Regression Prevention Strategy

Every change in this plan modifies the core inversion path — the most visible part of the app. A regression here means every image looks worse. The following safeguards must be in place **before** any Phase 1 code is merged.

### R1 — Golden reference snapshot tests (implement first, before any algorithm changes)

Capture the **current** pixel output for a fixed set of synthetic and semi-realistic inputs as `.toMatchInlineSnapshot()` or `.toMatchSnapshot()` assertions. These freeze the exact behavior of the current pipeline so any change is immediately visible in the test diff.

**What to snapshot — `imagePipeline.test.ts`:**

Add a `describe('inversion regression snapshots')` block with these cases, each producing a snapshot of the output RGBA values:

| # | Input pixel(s) | Settings | What it locks down |
|---|---|---|---|
| 1 | `(220, 140, 60)` — typical C-41 orange-mask pixel | Standard inversion, `filmBaseSample: { r: 230, g: 150, b: 70 }` | Standard inversion + film base compensation |
| 2 | Same pixel | Advanced-HD, Portra-400 profile, same film base sample | Advanced-HD inversion path |
| 3 | Same pixel | Advanced-HD, Portra-400 profile, **no** film base sample (fallback) | Fallback density path |
| 4 | `(200, 180, 150)` — lighter negative | Advanced-HD, Ektar-100 profile, auto base `{ r: 230, g: 160, b: 80 }` | Different stock, different tonal range |
| 5 | `(50, 50, 50)` — very dense negative area | Standard inversion, same film base | Shadow handling / floor correction |
| 6 | `(128, 128, 128)` — neutral mid-gray | Standard + no film base, B&W | B&W path unchanged |
| 7 | `(220, 140, 60)` with `colorMatrix` from Portra-400 | Standard inversion, Portra-400 matrix | Color matrix interaction |
| 8 | `(220, 140, 60)` with `tonalCharacter` from Portra-400 | Advanced-HD + tonal character | Full profile path |

**Implementation pattern:**

```typescript
it('regression: standard inversion with film base sample', () => {
  const pixel = createPixel(220, 140, 60);
  processImageData(pixel, {
    ...neutralSettings,
    filmBaseSample: { r: 230, g: 150, b: 70 },
  }, true, 'processed');
  expect(Array.from(pixel.data.slice(0, 4))).toMatchInlineSnapshot();
});
```

Run once to capture the current values. From then on, any algorithm change that shifts output will fail this test, forcing a deliberate `--update` to acknowledge the delta.

**What to snapshot — `rawImport.test.ts`:**

| # | Input | What it locks down |
|---|---|---|
| 9 | Uniform border `(168, 151, 134)`, center `(40, 60, 120)` — existing test | Current base estimate exact values |
| 10 | Mixed border: 90% `(168, 151, 134)` + 10% `(255, 255, 240)` outliers | Current outlier behavior (documents the weakness, then later shows improvement) |
| 11 | Low-contrast border `(140, 130, 120)` | Near-threshold behavior |

**What to snapshot — `resolveAdvancedHdParameters`:**

| # | Input | What it locks down |
|---|---|---|
| 12 | Portra-400 profile, estimated base `{ r: 200, g: 180, b: 150 }`, **no density balance** | Gamma and baseDensity values before density balance feature exists |
| 13 | Same, with `lightSourceBias: [1, 1, 1.2]` (blue-heavy LED) | Blue gamma / density adaptation |

These already partially exist (tests at `imagePipeline.test.ts:164–271`) but use `toBeCloseTo` / `toBeGreaterThan`. Convert the key assertions to **exact inline snapshots** so any shift is caught.

### R2 — Null-path backward compatibility (mandatory for every new parameter)

Every new parameter added to `resolveAdvancedHdParameters`, `processImageData`, and `buildProcessingUniforms` **must** default to `null` or `undefined`, and the `null` path **must** produce bit-identical output to the current code.

**Design rule:** `densityBalance: null | undefined` → no gamma scaling applied, behavior identical to pre-change. This means the new code can be merged and deployed without changing any output until density balance is actually computed and passed in.

**Enforce with a test:**

```typescript
it('null density balance produces identical output to no density balance', () => {
  const pixelA = createPixel(220, 140, 60);
  const pixelB = createPixel(220, 140, 60);

  processImageData(pixelA, settings, true, 'processed',
    /* ... existing params ... */
    /* densityBalance: */ undefined,
  );
  processImageData(pixelB, settings, true, 'processed',
    /* ... existing params ... */
    /* densityBalance: */ null,
  );

  expect(Array.from(pixelA.data)).toEqual(Array.from(pixelB.data));
});
```

And compare against a snapshot from R1 to confirm it also matches pre-change output.

### R3 — Merge order (incremental, not big-bang)

Do **not** merge all Phase 1 changes in a single PR. Split into incremental merges, each independently regression-safe:

| PR | Contents | Regression risk | Gate |
|---|---|---|---|
| **PR 0** | Golden reference snapshots (R1) only — no algorithm changes | Zero | All snapshots pass |
| **PR 1a** | `DensityBalance` type + threading through all signatures with `null` default | Zero — null path is no-op | All R1 snapshots still pass unchanged |
| **PR 1b** | `estimateFilmBaseSampleWithStride` modal cluster rewrite | Changes base estimates | R1 snapshot #9 updates; snapshots #1–8 may shift. Manually verify Portra 400 test image |
| **PR 1c** | `computeDensityBalance` + integration in worker + `resolveAdvancedHdParameters` | Changes advanced-HD output | R1 snapshots #2, #3, #4, #8 update. Manually verify all test images |

Each PR must:
1. Pass `npm run typecheck` and `npm run lint`.
2. Pass `npm run test` — updating snapshots only for the expected changes.
3. Be visually verified against the reference image set (R5) before merge.

### R4 — `buildProcessingUniforms` parity test (CPU ↔ GPU consistency)

The CPU path (`processImageData`) and GPU path (`buildProcessingUniforms` → WGSL shader) must produce the same results. After any pipeline change:

```typescript
it('CPU and GPU uniform paths resolve identical advanced-HD parameters', () => {
  const settings = createDefaultSettings({ inversionMethod: 'advanced-hd' });
  const profile = FILM_PROFILES.find(p => p.id === 'portra-400')!;
  const base = { r: 200, g: 180, b: 150 };
  const densityBalance = { scaleR: 1.0, scaleG: 1.0, scaleB: 0.62, source: 'auto-histogram' as const };

  // GPU path: uniforms encode the resolved gamma/baseDensity at known offsets
  const uniforms = buildProcessingUniforms(
    settings, true, 'processed',
    undefined, undefined, undefined, undefined, 0, 0, 0,
    'srgb', 'srgb', 'negative',
    profile.advancedInversion, base, null, [1, 1, 1],
    densityBalance,
  );

  // CPU path: resolve directly
  const resolved = resolveAdvancedHdParameters(
    settings, true, 'negative',
    profile.advancedInversion, base,
    'srgb', 'srgb', [1, 1, 1],
    densityBalance,
  );

  // Uniform offsets for advanced-HD gamma (slots 66-68) and baseDensity (slots 69-71)
  // must match the CPU-resolved values
  expect(uniforms[66]).toBeCloseTo(resolved.gamma[0], 5);
  expect(uniforms[67]).toBeCloseTo(resolved.gamma[1], 5);
  expect(uniforms[68]).toBeCloseTo(resolved.gamma[2], 5);
  expect(uniforms[69]).toBeCloseTo(resolved.baseDensity[0], 5);
  expect(uniforms[70]).toBeCloseTo(resolved.baseDensity[1], 5);
  expect(uniforms[71]).toBeCloseTo(resolved.baseDensity[2], 5);
});
```

**Note:** Verify the exact uniform slot indices by checking `buildProcessingUniforms` output array — the indices above are approximate and must be confirmed against the current layout (84 floats total, `imagePipeline.test.ts:116`).

### R5 — Visual reference image set

Maintain a set of reference images (not checked into git — too large) with known-good exports:

| # | Image | Film stock | Inversion method | What to check |
|---|---|---|---|---|
| 1 | Portra 400, well-exposed daylight portrait | portra-400 | Standard | Skin tones, neutral shadows |
| 2 | Same image | portra-400 | Advanced-HD | Same, compare against #1 |
| 3 | Ektar 100, saturated landscape | ektar-100 | Advanced-HD | No shadow color shift, saturated colors intact |
| 4 | Fuji Pro 400H, overcast portrait | fuji-400h | Advanced-HD | No residual blue-green cast |
| 5 | CineStill 800T, night street | cinestill-800t | Advanced-HD | No green shadow cast |
| 6 | Underexposed thin negative (any stock) | generic-color | Both | No blowout, reasonable tones |
| 7 | Frame with light leak at border | Any | Both | Base estimate not corrupted |

**Process:**
1. Before starting Phase 1, export each image at default settings → save as `reference_v0_*.png`.
2. After each PR, re-export → save as `reference_v{PR}_*.png`.
3. Diff visually (side-by-side) and with a per-pixel RMSE check. Acceptable delta:
   - PR 1a (type threading): RMSE = 0 (bit-identical).
   - PR 1b (modal cluster): RMSE < 2 for images without border outliers, RMSE < 8 for images with border outliers (improvement expected).
   - PR 1c (density balance): RMSE < 10 for Advanced-HD images (improvement expected in shadow/highlight color balance). Standard-path images must be RMSE = 0 (untouched).

Store the reference set path and RMSE thresholds in a `Docs/Improve inversion/regression-test-manifest.md` file so they're documented alongside this plan.

### R6 — Automated per-pixel RMSE comparison utility

Add a small test utility for comparing `ImageData` outputs:

```typescript
// src/utils/testHelpers.ts
export function pixelRmse(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Dimension mismatch');
  let sumSq = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = a.data[i + c] - b.data[i + c];
      sumSq += diff * diff;
    }
  }
  return Math.sqrt(sumSq / (a.width * a.height * 3));
}
```

Use this in tests to assert bounded deltas when an algorithm change is expected to shift output:

```typescript
it('density balance shifts advanced-HD output by bounded amount', () => {
  const before = createTestImage(/* ... */);
  const after = createTestImage(/* ... */);

  processImageData(before, settings, true, 'processed', /* ..., densityBalance: null */);
  processImageData(after, settings, true, 'processed', /* ..., densityBalance: computed */);

  expect(pixelRmse(before, after)).toBeLessThan(10);
  expect(pixelRmse(before, after)).toBeGreaterThan(0); // Confirm it actually changed
});
```

### Summary: regression prevention checklist

- [ ] **R1**: Golden reference snapshots committed (PR 0) — before any algorithm changes
- [ ] **R2**: Every new parameter defaults to `null` with bit-identical null-path behavior, tested
- [ ] **R3**: Changes split into incremental PRs with per-PR snapshot updates
- [ ] **R4**: CPU ↔ GPU parity test for `resolveAdvancedHdParameters` through both paths
- [ ] **R5**: Visual reference image set established with before/after exports and RMSE thresholds
- [ ] **R6**: `pixelRmse` utility added to `testHelpers.ts` for bounded-delta assertions

---

## Testing Protocol

For each phase, validate against these known failure cases before merging:

| Test case | Expected outcome after fix |
|---|---|
| Frame with bright specular highlight at the edge | Base estimate unchanged vs. same frame without highlight |
| Underexposed negative (thin negative) | No worse than before; ideally uses preset fallback |
| Kodak Ektar 100 scan | Colors in shadows match midtones; no progressive color shift |
| Fujifilm Pro 400H scan | Heavy orange mask removed without residual blue-green cast |
| CineStill 800T scan | No green cast in shadows |
| Same frame before/after Phase 1 changes, Portra 400 | Visually equivalent or better; no regression |
| Image with no true black (overcast sky, fog) | Residual base correction disabled/no-op; no clipping |
| Image where `inputProfileId === outputProfileId` (sRGB→sRGB) | Advanced-HD inversion still produces correct colors (linearize path active) |

---

## Key References

- `src/utils/rawImport.ts:87` — `estimateFilmBaseSampleWithStride` (base detection to modify in 1.1)
- `src/utils/imagePipeline.ts:304` — `sampleChannelToDensity` (existing density helper)
- `src/utils/imagePipeline.ts:332` — `applyAdvancedHdInversion` (per-channel HD inversion)
- `src/utils/imagePipeline.ts:345` — `resolveAdvancedHdParameters` (density balance to extend in 1.2)
- `src/utils/imagePipeline.ts:510` — `buildProcessingUniforms` (GPU uniform builder — needs density balance param)
- `src/utils/imagePipeline.ts:801` — `processImageData` (main CPU render loop — needs density balance param)
- `src/utils/imageWorker.ts:76` — `StoredDocument` interface (add `estimatedDensityBalance`)
- `src/utils/imageWorker.ts:192` — `estimateCanvasFilmBase` (add density balance call after this)
- `src/utils/imageWorker.ts:730,808` — decode handlers where `estimateCanvasFilmBase` is called
- `src/utils/gpu/WebGPUPipeline.ts:569` — GPU render path calling `buildProcessingUniforms`
- `src/utils/colorProfiles.ts` — `srgbInverseTransfer` (linearization for 2.3)
- `src/constants.ts:244` — `ADVANCED_INVERSION_PROFILES` (existing per-stock gamma/density data)
- `src/types.ts:306` — `DecodedImage`, `src/types.ts:322` — `WorkspaceDocument`, `src/types.ts:372` — `RenderRequest`
- Darktable Negadoctor source — Cineon-derived pipeline, best open reference for density-space math
- RawTherapee Film Negative — per-channel exponent model, two-point neutral solving
- Aaron Buchler: *Scanning Color Negative Film* — most thorough write-up of the transmittance→density pipeline
