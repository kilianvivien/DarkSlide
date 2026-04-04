# DarkSlide — Physically Accurate Film Negative Inversion via H&D Curves

## Feature Implementation Guide (v0.6.0 → v0.7.0+)

> **Purpose**: Guide for upgrading DarkSlide's inversion pipeline from its current per-profile approach to a density-domain (Hurter-Driffield curve) model, inspired by [nmtzwh/negative-film-converter](https://github.com/nmtzwh/negative-film-converter) and the broader negative conversion ecosystem.

### DarkSlide Current State (v0.6.0)

DarkSlide is a React 19 / Tauri / Vite app with WebGPU (+ CPU fallback) image processing via Web Workers. It already has:

- **40+ built-in film stock profiles** (color & B&W) including Portra, Ektar, Gold, Superia, Ektachrome, Double-X, HP5+, Delta, Fomapan, Rollei RPX, etc.
- **Full editing controls**: exposure, contrast, saturation, temperature, tint, curves, B&W points, highlight protection, sharpening, noise reduction
- **Roll management** with filmstrip sidebar, scanning sessions (folder watch), batch export, contact sheets
- **Preset system** with folders, autocomplete, `.darkslide` import/export, IndexedDB storage
- **Non-destructive crop**, before/after comparison, live histogram with per-channel display
- **RAW support** via rawler (DNG, CR3, NEF, ARW, RAF, RW2) in desktop mode, UTIF for TIFF in browser
- **WGSL shaders** already exist (1.4% of codebase is WGSL), with WebGPU compute pipeline + CPU fallback

### What This Guide Adds

The key upgrade is moving the core inversion math from a per-profile empirical approach to a **physically grounded density-domain pipeline**. This doesn't replace the existing film profiles — it makes them *better* by basing them on real photometric data rather than aesthetic curve-fitting. It also enables **roll calibration** (the killer feature from `negative-film-converter`) which ensures color consistency across an entire roll from a few neutral-point samples.

---

## 1. Why H&D Curves Matter (The Problem with Linear Inversion)

### The naive approach (what most tools do)

```
positive = 1.0 - negative  // simple inversion
positive *= white_balance   // per-channel multiply
positive = pow(positive, gamma) // contrast curve
```

This fails because film does **not** respond to light linearly. The relationship between exposure and optical density follows an S-shaped logarithmic curve — the **Hurter-Driffield characteristic curve**.

### What goes wrong with linear inversion

| Problem | Cause | Visible artifact |
|---------|-------|-----------------|
| **Muddy shadows** | Toe compression ignored — shadow detail encoded non-linearly | Dark areas look flat, lack separation |
| **Blown highlights** | Shoulder rolloff not modeled | Highlights clip abruptly instead of rolling off gracefully |
| **Color crossover** | R/G/B dye layers have different gammas | Magenta shadows, green highlights, inconsistent WB across tonal range |
| **Orange mask artifacts** | Subtracting flat color from non-linear data | Incorrect mask removal in shadows vs highlights |

### What density-domain inversion solves

By working in **density space** (log domain), you invert through the film's actual transfer function:

- Shadow detail is recovered from the compressed toe region
- Highlight rolloff is natural and film-like
- Per-channel gamma differences are handled correctly
- Orange mask subtraction becomes a simple offset in log space

---

## 2. The Math — Density-Domain Inversion Pipeline

### Core equations

```
Definitions:
  T  = transmittance (what the scanner/camera captures, normalized 0-1)
  D  = optical density = -log₁₀(T)  or equivalently  log₁₀(1/T)
  E  = exposure (scene luminance × time)
  γ  = gamma (slope of the straight-line portion of the H&D curve)
  D₀ = base + fog density (the orange mask, per-channel)
```

### Pipeline stages

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 1. RAW Decode │───▶│ 2. T → D     │───▶│ 3. Mask Sub  │───▶│ 4. Inv H&D   │───▶│ 5. Output    │
│ (rawler)      │    │ D=-log₁₀(T)  │    │ D'=D-D₀      │    │ per-channel  │    │ color space  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

**Stage 1 — RAW Decode** (already done by rawler)
- Decode to linear float32 RGB, no auto-WB, no tone curve
- This gives you transmittance values (T) normalized to 0-1

**Stage 2 — Transmittance to Density**
```
D_r = -log₁₀(T_r)
D_g = -log₁₀(T_g)
D_b = -log₁₀(T_b)
```
- Clamp T to a small epsilon before log to avoid -infinity
- Typical density range: 0.0 (clear) to ~3.0 (very dense)

**Stage 3 — Orange Mask Subtraction**
```
D'_r = D_r - D₀_r
D'_g = D_g - D₀_g
D'_b = D_b - D₀_b
```
- `D₀` is sampled from unexposed film border (base + fog)
- This is a simple subtraction in density space — much cleaner than doing it in linear space
- Result: density that represents only the dye image, without the mask

**Stage 4 — Inverse H&D Curve (density to scene luminance)**

For the **simplified model** (adequate for most film stocks):
```
// Per-channel power law inversion
L_r = pow(10.0, D'_r / γ_r) × scale
L_g = pow(10.0, D'_g / γ_g) × scale
L_b = pow(10.0, D'_b / γ_b) × scale
```

For the **full model** (with toe/shoulder modeling):
```
// Use a 1D LUT per channel, either:
// - Digitized from Kodak/Fuji data sheets
// - Fitted via roll calibration (see §5)
L_c = inverse_hd_lut[channel](D'_c)
```

**Stage 5 — Output Conversion**
- Apply any user adjustments (exposure, WB, contrast)
- Convert from scene-referred linear to output color space (sRGB, Display P3, etc.)

### Key insight: density balance (per-channel gamma correction)

Different film stocks have different per-channel gammas. This is why you need **density balance**, not just white balance. In density space, density balance is a simple per-channel multiply:

```
D_balanced_r = D'_r × (γ_ref / γ_r)
D_balanced_g = D'_g × (γ_ref / γ_g)
D_balanced_b = D'_b × (γ_ref / γ_b)
```

In linear space, this becomes a per-channel power function:
```
balanced_r = pow(linear_r, γ_ref / γ_r)
```

This is why tools like Negative Lab Pro and the `abpy/color-neg-resources` approach work in density space — it makes the color correction arithmetic much simpler.

---

## 3. WebGPU / WGSL Implementation

### Where this fits in DarkSlide's architecture

DarkSlide already uses a **WebGPU compute pipeline with CPU fallback via Web Workers**. The inversion logic currently lives in WGSL shaders (the repo is 1.4% WGSL). The change here is to replace the per-pixel inversion math inside the existing shader(s), not to create a new pipeline from scratch.

The current flow is:
```
RAW file → rawler (Rust/Tauri) → linear float32 RGB → Web Worker → WebGPU compute shader → display
                                                                 ↘ CPU fallback (same math in TS)
```

The H&D upgrade changes **only the math inside the compute shader** and the corresponding CPU fallback path. The rest of the pipeline (RAW decode, Web Worker dispatch, GPU buffer management, display) stays the same.

**Key constraint**: since DarkSlide also runs in-browser (no Tauri), the CPU fallback path in TypeScript must implement the same density-domain math. Keep both paths in sync.

### WGSL Compute Shader — Core Inversion

```wgsl
// ============================================================
// film_inversion.wgsl — H&D curve-based negative inversion
// ============================================================

struct FilmProfile {
    // Base + fog density (orange mask), per channel
    base_density_r: f32,
    base_density_g: f32,
    base_density_b: f32,
    _pad0: f32,

    // Per-channel gamma (slope of straight-line portion)
    gamma_r: f32,
    gamma_g: f32,
    gamma_b: f32,
    _pad1: f32,

    // Exposure compensation
    exposure: f32,
    // White balance multipliers (applied in linear space)
    wb_r: f32,
    wb_g: f32,
    wb_b: f32,

    // Black/white point (density domain)
    black_point: f32,
    white_point: f32,
    // Output gamma (for display transform)
    output_gamma: f32,
    _pad2: f32,
}

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> profile: FilmProfile;
@group(0) @binding(3) var<uniform> dimensions: vec2<u32>; // width, height

const EPSILON: f32 = 1e-10;
const LOG10_E: f32 = 0.4342944819; // 1/ln(10)

// log base 10 via natural log
fn log10(x: f32) -> f32 {
    return log(max(x, EPSILON)) * LOG10_E;
}

// 10^x
fn pow10(x: f32) -> f32 {
    return exp(x / LOG10_E);
}

@compute @workgroup_size(16, 16)
fn invert_negative(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let w = dimensions.x;
    let h = dimensions.y;

    if (x >= w || y >= h) {
        return;
    }

    let idx = (y * w + x) * 3u;

    // Stage 1: Read linear transmittance from RAW decode
    let t_r = max(input[idx + 0u], EPSILON);
    let t_g = max(input[idx + 1u], EPSILON);
    let t_b = max(input[idx + 2u], EPSILON);

    // Stage 2: Transmittance → Density
    let d_r = -log10(t_r);
    let d_g = -log10(t_g);
    let d_b = -log10(t_b);

    // Stage 3: Subtract base + fog (orange mask removal)
    let d_prime_r = d_r - profile.base_density_r;
    let d_prime_g = d_g - profile.base_density_g;
    let d_prime_b = d_b - profile.base_density_b;

    // Stage 4: Inverse H&D — density → scene-referred linear
    // Using simplified power-law model: L = 10^(D / γ)
    // Note: in negative film, higher density = more exposure = brighter scene
    // So we invert by mapping high density → high luminance
    let l_r = pow10(d_prime_r / profile.gamma_r);
    let l_g = pow10(d_prime_g / profile.gamma_g);
    let l_b = pow10(d_prime_b / profile.gamma_b);

    // Apply exposure compensation (linear multiply)
    let exp_mult = pow(2.0, profile.exposure);
    var out_r = l_r * exp_mult * profile.wb_r;
    var out_g = l_g * exp_mult * profile.wb_g;
    var out_b = l_b * exp_mult * profile.wb_b;

    // Normalize using black/white points
    let range = max(profile.white_point - profile.black_point, EPSILON);
    // (These points define the density range to map to [0,1])

    // Stage 5: Output gamma (linear → display)
    let inv_gamma = 1.0 / profile.output_gamma;
    out_r = pow(clamp(out_r, 0.0, 1.0), inv_gamma);
    out_g = pow(clamp(out_g, 0.0, 1.0), inv_gamma);
    out_b = pow(clamp(out_b, 0.0, 1.0), inv_gamma);

    // Write output
    output[idx + 0u] = out_r;
    output[idx + 1u] = out_g;
    output[idx + 2u] = out_b;
}
```

### Alternative: 1D LUT-based inversion (for full H&D curves)

For film stocks where you have the full characteristic curve (digitized from data sheets), use a 1D texture lookup instead of the analytical power law:

```wgsl
// LUT-based approach — one 1D texture per channel
@group(1) @binding(0) var lut_r: texture_1d<f32>;
@group(1) @binding(1) var lut_g: texture_1d<f32>;
@group(1) @binding(2) var lut_b: texture_1d<f32>;
@group(1) @binding(3) var lut_sampler: sampler;

fn inverse_hd_lut(density: f32, channel: u32) -> f32 {
    // Map density range [0, max_density] → UV [0, 1]
    let max_density = 3.0; // typical for color negative
    let uv = clamp(density / max_density, 0.0, 1.0);

    // Sample the appropriate channel LUT
    switch channel {
        case 0u: { return textureSampleLevel(lut_r, lut_sampler, uv, 0.0).r; }
        case 1u: { return textureSampleLevel(lut_g, lut_sampler, uv, 0.0).r; }
        case 2u: { return textureSampleLevel(lut_b, lut_sampler, uv, 0.0).r; }
        default: { return 0.0; }
    }
}
```

### TypeScript side: extending DarkSlide's existing profile system

DarkSlide already has 40+ film profiles. The density-domain upgrade adds **physical parameters** to the existing profile data. The current profiles store aesthetic curve parameters; the upgrade adds `baseDensity` and `gamma` fields derived from actual film data sheets.

```typescript
// Extend DarkSlide's existing film profile type with H&D parameters
// This goes alongside the existing profile data, not replacing it

interface FilmHDData {
  // Base + fog density (orange mask), per channel [R, G, B]
  baseDensity: [number, number, number];
  // Per-channel gamma (slope of straight-line portion of H&D curve)
  gamma: [number, number, number];
  // Optional: full H&D curve as LUT for toe/shoulder accuracy
  hdCurveLUT?: {
    r: Float32Array; // 256 or 1024 entries
    g: Float32Array;
    b: Float32Array;
  };
}

// H&D data for DarkSlide's existing built-in profiles
// These values would be digitized from manufacturer data sheets
// Start with the most popular stocks, add more progressively
const FILM_HD_DATA: Record<string, FilmHDData> = {
  // Color negative — Kodak
  'portra_400':    { baseDensity: [0.78, 0.62, 0.35], gamma: [0.60, 0.65, 0.55] },
  'portra_160':    { baseDensity: [0.75, 0.60, 0.33], gamma: [0.58, 0.63, 0.53] },
  'ektar_100':     { baseDensity: [0.85, 0.68, 0.38], gamma: [0.70, 0.75, 0.65] },
  'gold_200':      { baseDensity: [0.72, 0.58, 0.32], gamma: [0.62, 0.67, 0.58] },
  'colorplus_200': { baseDensity: [0.70, 0.56, 0.30], gamma: [0.60, 0.65, 0.56] },
  'ultramax_400':  { baseDensity: [0.74, 0.60, 0.34], gamma: [0.63, 0.68, 0.58] },
  // Color negative — Fujifilm
  'superia_400':   { baseDensity: [0.70, 0.55, 0.30], gamma: [0.65, 0.68, 0.60] },
  'fujifilm_200':  { baseDensity: [0.68, 0.54, 0.29], gamma: [0.63, 0.66, 0.58] },
  'c200':          { baseDensity: [0.66, 0.52, 0.28], gamma: [0.62, 0.65, 0.57] },
  // B&W — gamma is equal across channels, minimal base fog
  'hp5_plus':      { baseDensity: [0.20, 0.20, 0.20], gamma: [0.62, 0.62, 0.62] },
  'tri_x_400':     { baseDensity: [0.22, 0.22, 0.22], gamma: [0.65, 0.65, 0.65] },
  'tmax_400':      { baseDensity: [0.18, 0.18, 0.18], gamma: [0.70, 0.70, 0.70] },
  'delta_100':     { baseDensity: [0.15, 0.15, 0.15], gamma: [0.58, 0.58, 0.58] },
  'delta_400':     { baseDensity: [0.19, 0.19, 0.19], gamma: [0.63, 0.63, 0.63] },
  'fp4_plus':      { baseDensity: [0.16, 0.16, 0.16], gamma: [0.56, 0.56, 0.56] },
  'fomapan_100':   { baseDensity: [0.17, 0.17, 0.17], gamma: [0.55, 0.55, 0.55] },
  'fomapan_200':   { baseDensity: [0.19, 0.19, 0.19], gamma: [0.60, 0.60, 0.60] },
  'fomapan_400':   { baseDensity: [0.21, 0.21, 0.21], gamma: [0.64, 0.64, 0.64] },
  'rpx_25':        { baseDensity: [0.14, 0.14, 0.14], gamma: [0.52, 0.52, 0.52] },
  'rpx_100':       { baseDensity: [0.16, 0.16, 0.16], gamma: [0.57, 0.57, 0.57] },
  'rpx_400':       { baseDensity: [0.20, 0.20, 0.20], gamma: [0.63, 0.63, 0.63] },
  // Slide (E-6) — no orange mask, gamma ≈ 1.0+ (high contrast)
  'ektachrome_e100': { baseDensity: [0.05, 0.05, 0.05], gamma: [1.80, 1.80, 1.80] },
  'astia_100f':      { baseDensity: [0.05, 0.05, 0.05], gamma: [1.60, 1.60, 1.60] },
  // Cinema
  'double_x_5222':   { baseDensity: [0.20, 0.20, 0.20], gamma: [0.65, 0.65, 0.65] },
  // Auto-detect mode
  'auto':            { baseDensity: [0.0, 0.0, 0.0], gamma: [0.65, 0.65, 0.65] },
};
```

The GPU pipeline setup (bind group layouts, uniform buffers) should integrate with DarkSlide's existing WebGPU infrastructure rather than creating a parallel pipeline. The `FilmHDData` uniform is passed alongside the existing editing parameters.  return { pipeline, bindGroupLayout };
}
```

---

## 4. Film Stock Profiles — Data Sources

### Where to get H&D curve data

| Source | Format | Films covered |
|--------|--------|---------------|
| [Kodak Technical Data Sheets (PDF)](https://imaging.kodakalaris.com/photographers/technical-data) | Graphs in PDF, need digitizing | Portra, Ektar, Gold, ColorPlus, Tri-X, T-Max, etc. |
| [Fujifilm Data Sheets](https://asset.fujifilm.com/www/us/files/2024-01/) | Similar PDF format | Superia, C200, Pro 400H (discontinued), Acros, etc. |
| [Ilford Technical Data](https://www.ilfordphoto.com/technical-information) | PDF | HP5+, FP4+, Delta, Pan F+, etc. |
| [abpy/color-neg-resources](https://github.com/abpy/color-neg-resources) | LUT .cube files + Python scripts | Generic density balance values for Ektar, etc. |
| [arufahc/negicc](https://github.com/arufahc/negicc) | ICC profiles + Python | Portra 400 via IT8 calibration |

### Digitizing H&D curves from data sheets

1. Download the PDF data sheet for the film stock
2. Extract the "Characteristic Curves" graph (D vs. log E, per layer)
3. Use a plot digitizer tool (e.g., WebPlotDigitizer) to extract data points
4. Fit a parametric model or store as a 1D LUT

### Parametric model (for the simplified approach)

The H&D curve can be approximated with a **4-parameter sigmoid**:

```
D(logE) = D_max / (1 + exp(-k × (logE - logE_0))) + D_fog
```

Where:
- `D_max` = maximum density (shoulder saturation)
- `k` = steepness (relates to gamma)
- `logE_0` = inflection point (speed point)
- `D_fog` = base + fog density

This is invertible analytically:
```
logE(D) = logE_0 - (1/k) × ln(D_max / (D - D_fog) - 1)
```

---

## 5. Roll Calibration (from negative-film-converter)

One of the most valuable features in `negative-film-converter` is **roll-level curve calibration**. Instead of using generic film stock profiles, you calibrate a custom H&D curve from the actual roll being processed.

### How it works

1. **Sample multiple frames**: User picks 3-5 frames from the roll and samples neutral gray points (e.g., gray card, known neutral surfaces)
2. **Collect data points**: For each sample, record `(scanner_value_R, scanner_value_G, scanner_value_B)` — these are transmittance readings at points that should be neutral gray
3. **Fit curve**: Use the per-channel transmittance values to fit a logarithmic curve:
   ```
   D_out(channel) = a × log₁₀(T_channel) + b
   ```
   Where `a` and `b` are fitted per-channel to make all neutral samples actually neutral
4. **Apply to entire roll**: The fitted curve is used as the inversion profile for every frame

### Implementation in DarkSlide

```typescript
// roll-calibration.ts

interface CalibrationSample {
  frameIndex: number;
  // Average transmittance in the sampled region
  transmittance: [number, number, number]; // R, G, B
  // What the sample should be (e.g., neutral gray → equal RGB)
  isNeutral: boolean;
}

interface FittedCurve {
  // Per-channel: D_corrected = slope × D_raw + offset
  slopes: [number, number, number];
  offsets: [number, number, number];
  baseDensity: [number, number, number];
}

function fitRollCurve(samples: CalibrationSample[]): FittedCurve {
  // Convert transmittances to densities
  const densities = samples.map(s => ({
    r: -Math.log10(Math.max(s.transmittance[0], 1e-10)),
    g: -Math.log10(Math.max(s.transmittance[1], 1e-10)),
    b: -Math.log10(Math.max(s.transmittance[2], 1e-10)),
  }));

  // For neutral samples, the corrected density should be equal across channels
  // Use least-squares to find per-channel slope/offset that minimizes
  // the difference between channels at neutral points

  // Simplified: use the green channel as reference, fit R and B to match
  // Full implementation would use scipy-style least squares (or a Rust/TS equivalent)

  // ... fitting logic here (see §7 for library recommendations)

  return {
    slopes: [1.0, 1.0, 1.0],   // placeholder
    offsets: [0.0, 0.0, 0.0],   // placeholder
    baseDensity: [0.0, 0.0, 0.0],
  };
}
```

### UI workflow for roll calibration (integrates with existing roll management)

DarkSlide v0.6.0 already has roll management with a filmstrip sidebar. The calibration workflow slots into this:

1. User opens a roll (already grouped in DarkSlide's roll system)
2. User clicks **"Calibrate Roll"** button in the roll sidebar header
3. App enters calibration mode: the filmstrip highlights, and a toolbar shows "Pick Neutral" and "Pick Film Base"
4. **Pick Film Base**: user clicks on the unexposed film border on any frame → app samples a 5×5 region, averages to get `D₀` per channel
5. **Pick Neutral** (repeat 3-5 times across different frames): user clicks on a known neutral area (gray card, concrete, overcast sky, etc.) → app records the per-channel density at that point
6. App fits per-channel slope/offset to make all neutral samples neutral (equal density across R/G/B after correction)
7. Results are stored as roll-level metadata and auto-applied to all frames
8. A "Clear Calibration" button allows resetting to the generic film profile
9. Calibration data is preserved when exporting the roll (included in batch export sidecar)

---

## 6. Other Features to Borrow from negative-film-converter

### 6.1. Interactive Tone Curves (Pchip Spline)

The `negative-film-converter` uses **Pchip (Piecewise Cubic Hermite Interpolation)** for tone curves instead of standard cubic splines. The advantage: Pchip curves are **monotone** — they never overshoot, which prevents tone reversal artifacts.

**Why this matters for negative inversion**: Standard cubic splines can create small bumps and dips in the curve, which in the context of an already-inverted negative can cause weird tonal inversions in the shadows or highlights.

**Implementation path for DarkSlide**:
- Use a JS/TS implementation of Pchip (e.g., `@mathigon/core` has monotone cubic interpolation, or port the algorithm — it's ~50 lines of code)
- The curve editor UI is a standard React canvas component: draggable control points, real-time preview
- The resulting LUT (256 or 1024 entries per channel) is uploaded to the GPU as a 1D texture

```typescript
// pchip.ts — Monotone cubic Hermite interpolation
// Prevents overshoot in tone curves

interface CurvePoint {
  x: number; // input (0-1)
  y: number; // output (0-1)
}

function pchipInterpolate(points: CurvePoint[], resolution: number = 256): Float32Array {
  const lut = new Float32Array(resolution);
  const n = points.length;

  // Sort by x
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs = sorted.map(p => p.x);
  const ys = sorted.map(p => p.y);

  // Compute slopes using Fritsch-Carlson method
  const h = new Array(n - 1);
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = (ys[i + 1] - ys[i]) / h[i];
  }

  const d = new Array(n);
  d[0] = delta[0];
  d[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0; // flat at local extrema
    } else {
      // Harmonic mean
      d[i] = 2 / (1 / delta[i - 1] + 1 / delta[i]);
    }
  }

  // Evaluate at each LUT position
  for (let j = 0; j < resolution; j++) {
    const t = j / (resolution - 1);
    // Find interval
    let i = 0;
    while (i < n - 2 && t > xs[i + 1]) i++;

    const dx = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / dx;
    const s2 = s * s;
    const s3 = s2 * s;

    // Hermite basis functions
    lut[j] = (2 * s3 - 3 * s2 + 1) * ys[i]
           + (s3 - 2 * s2 + s) * dx * d[i]
           + (-2 * s3 + 3 * s2) * ys[i + 1]
           + (s3 - s2) * dx * d[i + 1];
    lut[j] = Math.max(0, Math.min(1, lut[j]));
  }

  return lut;
}
```

### 6.2. Hold-to-Compare (Negative ↔ Positive Toggle)

DarkSlide already has **before/after comparison** — but `negative-film-converter`'s hold-to-compare is a different UX: hold spacebar to instantly flash the raw negative, release to see the positive. This is a more visceral interaction than a split view. Since DarkSlide already renders via WebGPU, this is trivial: on keydown, bypass the inversion shader and display the raw input texture; on keyup, restore.

### 6.3. Sidecar JSON for Roll Calibration

DarkSlide already has **`.darkslide` preset files** and **IndexedDB preset storage**. The new data to persist is the **roll calibration result** — the fitted per-channel curve from neutral-point sampling. This should be stored at the roll level (since calibration applies to an entire roll), not per-frame.

Since v0.6.0 added roll management, the calibration data fits naturally as a property of a roll:

```json
{
  "rollId": "roll_2024-03-15",
  "filmStock": "portra_400",
  "calibration": {
    "baseDensity": [0.79, 0.63, 0.36],
    "slopes": [1.02, 1.00, 0.97],
    "offsets": [0.01, 0.00, -0.01],
    "sampleCount": 4,
    "calibratedAt": "2024-03-15T14:30:00Z"
  }
}
```

This calibration overrides the built-in `FilmHDData` values for that roll, giving per-roll accuracy rather than generic per-stock values.

### 6.4. GPU Histogram Optimization

DarkSlide already has a **live histogram with per-channel display**. If it's currently computed on the CPU fallback path, moving it to a WebGPU compute shader would make it truly real-time even at full resolution. Here's the shader pattern:

```wgsl
@group(0) @binding(0) var<storage, read> pixels: array<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>; // 256 × 3 bins

@compute @workgroup_size(256)
fn compute_histogram(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x * 3u;
    if (idx + 2u >= arrayLength(&pixels)) { return; }

    let r = u32(clamp(pixels[idx + 0u] * 255.0, 0.0, 255.0));
    let g = u32(clamp(pixels[idx + 1u] * 255.0, 0.0, 255.0));
    let b = u32(clamp(pixels[idx + 2u] * 255.0, 0.0, 255.0));

    atomicAdd(&histogram[r], 1u);
    atomicAdd(&histogram[256u + g], 1u);
    atomicAdd(&histogram[512u + b], 1u);
}
```

### 6.5. Features DarkSlide Already Has (No Action Needed)

These features from `negative-film-converter` are already present in DarkSlide v0.6.0:
- **Non-destructive cropping** with film format ratios ✅
- **Batch export** with preset application to entire rolls ✅  
- **Film strip / folder browsing** with sidebar ✅
- **Settings persistence** via presets + IndexedDB ✅
- **Zoom & pan** for detail inspection ✅
- **Real-time histogram** ✅

---

## 7. Implementation Roadmap for DarkSlide (v0.7.0+)

Since DarkSlide v0.6.0 already has film profiles, editing controls, roll management, histograms, crop, batch export, and presets, the roadmap focuses **only on the new density-domain work**.

### Phase 1: Density-Domain Inversion Core

**Goal**: Upgrade the existing inversion math from empirical to physically grounded.

- [ ] Add `FilmHDData` interface (baseDensity + gamma per channel) — see §3 for type definition
- [ ] Extend existing film profile objects with H&D parameters for the top 10 stocks
- [ ] Modify the existing WGSL inversion shader to work in density space (log₁₀ transform → mask subtract → power-law inverse) — see §3 for shader code
- [ ] Mirror the same math in the CPU fallback path (Web Worker TypeScript) for browser mode
- [ ] Add a "Film Base Picker" tool: user clicks on unexposed film border, app averages a region and writes `D₀` to the profile uniform
- [ ] Add "Auto" mode that estimates base density from the darkest corner/border of the image
- [ ] A/B toggle: let the user compare the old inversion vs. density-domain on the same image to validate the upgrade

### Phase 2: Roll Calibration

**Goal**: The killer differentiator — per-roll accuracy from neutral-point sampling.

- [ ] Add a "Calibrate Roll" button to the roll management sidebar
- [ ] Implement neutral-point sampling: user marks a rectangle on a neutral area (gray card, white wall, etc.) on 3-5 frames from the roll
- [ ] Implement least-squares curve fitting (per-channel slope/offset in density space) — see §5
- [ ] Store calibration result as part of the roll metadata (IndexedDB or sidecar JSON)
- [ ] Auto-apply calibration to all frames in the roll
- [ ] Allow calibration to work with the scanning session workflow (calibrate once during scan, apply to incoming frames)

### Phase 3: Pchip Tone Curves

**Goal**: Upgrade the existing curve editor to use overshoot-free interpolation.

- [ ] Replace the current tone curve interpolation with Pchip (Fritsch-Carlson monotone cubic Hermite) — see §6.1 for complete TS implementation
- [ ] Upload the resulting 256-entry LUT to the GPU as a 1D texture, sampled in the shader after inversion
- [ ] This is a drop-in improvement for the existing curves UI — no new UI needed, just better math behind it

### Phase 4: Full H&D Curve LUTs

**Goal**: Move from simplified power-law to full characteristic curves for the most popular stocks.

- [ ] Digitize H&D curves from Kodak/Fuji/Ilford data sheets using WebPlotDigitizer or similar
- [ ] Store as 1D textures (1024 entries per channel, 3 channels per stock)
- [ ] Add LUT-based inverse path in the shader alongside the analytical path — see §3 for LUT shader code
- [ ] Allow users to contribute/import custom H&D curves via `.darkslide` preset files

### Phase 5: Advanced (Optional)

- [ ] Dye crosstalk correction (inter-channel density dependencies — cf. `arufahc/negicc`)
- [ ] Paper simulation curve (emulate RA-4 print response — cf. `abpy/color-neg-resources` paper LUTs)
- [ ] 3D LUT export (`.cube` format) for use in Lightroom/Capture One/DaVinci
- [ ] Hold-to-compare: spacebar flash between raw negative and converted positive (different from existing before/after split)
- [ ] ICC profile generation from roll calibration data

---

## 8. DarkSlide vs. negative-film-converter — Architecture Comparison

| Aspect | negative-film-converter | DarkSlide v0.6.0 |
|--------|------------------------|-------------------|
| **Image processing** | Python/NumPy/OpenCV (CPU) | WebGPU compute shaders (GPU) + CPU fallback |
| **RAW decode** | rawpy (Python libraw bindings) | rawler (pure Rust, via Tauri) |
| **Curve interpolation** | SciPy Pchip (Python) | Custom TS (to be added) + WGSL LUT |
| **Architecture** | Sidecar Python process + FastAPI HTTP | All-in-one Tauri app, Web Workers |
| **Preview pipeline** | CPU render → Base64 JPEG → WebView | GPU texture → direct WebGPU canvas |
| **Film profiles** | Few, focused on density math | 40+ built-in, aesthetic + density (target) |
| **Roll management** | Folder-based film strip | Full roll management + scanning sessions |
| **Preset system** | Sidecar JSON per file | `.darkslide` files + IndexedDB + folders |
| **Browser support** | None (desktop only) | Full browser mode (no RAW, but TIFF/JPEG) |
| **Performance** | Async Python, seconds per update | Real-time GPU, 30-60fps parameter changes |

DarkSlide is already ahead on features and UX. The main thing to take from `negative-film-converter` is the **density-domain math** and **roll calibration** concept — both of which slot cleanly into DarkSlide's existing architecture.

---

## 9. References & Resources

- [Hurter & Driffield, "Photochemical Investigations" (1890)](https://en.wikipedia.org/wiki/Hurter_and_Driffield) — The original paper
- [nmtzwh/negative-film-converter](https://github.com/nmtzwh/negative-film-converter) — Tauri+React+Python reference implementation with H&D math
- [abpy/color-neg-resources](https://github.com/abpy/color-neg-resources) — LUTs, density balance scripts, excellent math documentation
- [abpy blog post: Scanning Color Negative Film](https://abpy.github.io/2023/08/20/color-neg.html) — Detailed process explanation with density balance workflow
- [arufahc/negicc](https://github.com/arufahc/negicc) — ICC profile generation from calibration targets, Pchip curve fitting for dye crosstalk
- [amoslu-photo/simple-inversion](https://github.com/amoslu-photo/simple-inversion) — Automated batch inversion with D-min/D-max estimation from leader frames
- [RawTherapee Film Negative tool](https://github.com/Beep6581/RawTherapee/issues/7063) — Discussion of correct orange mask handling in RAW processing
- [Kodak Technical Data Sheets](https://imaging.kodakalaris.com/photographers/technical-data) — Official H&D curves per film stock
- [Ilford Technical Data](https://www.ilfordphoto.com/technical-information) — H&D curves for HP5+, FP4+, Delta, Pan F+
- [brotzeit.engineering: Finding the Positive in Negatives](https://brotzeit.engineering/articles/finding-the-positives-in-negatives/) — Good theoretical overview with Python code
- [SmartConvert by Filmomat](https://www.filmomat.eu/smartconvert) — Commercial reference: density-based algorithm that adapts per-negative
- [Capture One Film Negative mode](https://support.captureone.com/hc/en-us/articles/33917623779229-Negative-Film-Conversion) — How a pro tool handles the same problem (added in v16.7.4)

---

## 10. Quick-Start Checklist

To get the minimum viable density-domain inversion into DarkSlide:

1. **Locate your existing inversion shader** in `src/` (the `.wgsl` files — 1.4% of the codebase)
2. **Add the `FilmProfile` uniform struct** from §3 to the shader, passing `baseDensity` and `gamma` alongside existing parameters
3. **Replace the core inversion math**: instead of `1.0 - pixel`, do `T → D → D-D₀ → pow(10, D'/γ)` as shown in the shader code in §3
4. **Add the same math to the CPU fallback** in the Web Worker TypeScript code
5. **Hardcode Portra 400 values** from the `FILM_HD_DATA` table in §3 as a first test
6. **Add a "Pick Film Base" eyedropper** that samples a 5×5 region and writes `D₀` to the uniform buffer
7. **Compare** the result against the current inversion on the same image — the difference in shadow detail and color consistency should be immediately visible

That's it for the MVP. Roll calibration (Phase 2) is the next high-impact addition, and it builds directly on this foundation.
