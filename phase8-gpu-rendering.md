# Phase 8: GPU-Accelerated Rendering — Detailed Implementation Plan

## Goal

Move the three CPU bottlenecks in the imaging pipeline — the per-pixel conversion loop, the separable Gaussian blur (used by both sharpen and noise reduction), and the histogram reduction — onto the GPU via WebGPU compute shaders. The React layer, worker message protocol, and fallback CPU path remain unchanged.

---

## Architecture Overview

```
                         EXISTING (unchanged)
 ┌─────────────┐    ┌──────────────────────┐    ┌───────────────────┐
 │  App.tsx     │───▶│ imageWorkerClient.ts │───▶│   Web Worker      │
 │  (React)     │◀───│                      │◀───│                   │
 └─────────────┘    │  ┌──────────────────┐│    │ decode, rotate,   │
                    │  │ GPU Intercept    ││    │ crop, getImageData│
                    │  │ (main thread)    ││    │                   │
                    │  │                  ││    │ CPU fallback:     │
                    │  │ WebGPUPipeline   ││    │ processImageData  │
                    │  └──────────────────┘│    └───────────────────┘
                    └──────────────────────┘
                               │
                          RenderResult
                      (same shape either way)
```

### Key Constraint: WebKit is the Primary Target

The primary targets are **Safari on macOS 26 Tahoe** and **Tauri's WKWebView** (which uses the system WebKit). Chrome is a bonus. This dictates the architecture because:

- **Safari/WebKit does not expose WebGPU inside Web Workers.** `navigator.gpu` is only available on the main `Window` context. This applies to both Safari and Tauri's WKWebView.
- **Chrome 128+** does support WebGPU in dedicated workers, but targeting Chrome-only would miss the primary audience.

Therefore the GPU pipeline **must run on the main thread**, not inside the worker.

### Chosen Approach: Main-Thread GPU with Worker CPU Fallback

The `imageWorkerClient.ts` intercepts render/export results from the worker and optionally routes pixel processing through a main-thread `WebGPUPipeline`:

1. **Worker responsibility (unchanged):** Decode, preview pyramid, rotation, crop, `getImageData()`. When GPU is unavailable or disabled, the worker also runs `processImageData()` (the full CPU pipeline) as it does today.
2. **When GPU is enabled:** The worker skips `processImageData()` and returns **raw (unprocessed) ImageData** to the main thread. The worker client runs `WebGPUPipeline.processImageData()` on the main thread, then returns the final `RenderResult` to App.tsx. The GPU dispatch is non-blocking (async) and does not jank the UI because WebGPU command submission is fire-and-forget; only the readback `mapAsync` awaits, and it yields to the event loop.
3. **Fallback:** If `navigator.gpu` is unavailable, the user disabled GPU, or GPU init fails, the worker runs the CPU path and the client passes results through unchanged — identical to today's behavior.

This approach:
- Works on Safari 18+, macOS Tahoe WKWebView, and Chrome (all main-thread WebGPU).
- Keeps the worker message protocol almost unchanged (one new field: `skipProcessing` flag on `RenderRequest`).
- Reuses the same WGSL shaders regardless of where WebGPU is called from.
- Allows a future upgrade to worker-internal GPU on Chrome without changing the shaders or pipeline class.

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/gpu/WebGPUPipeline.ts` | **New** | GPU device lifecycle, buffer management, dispatch orchestration (main thread) |
| `src/utils/gpu/shaders/conversion.wgsl` | **New** | Per-pixel conversion compute shader |
| `src/utils/gpu/shaders/blur.wgsl` | **New** | Separable Gaussian blur compute shader |
| `src/utils/gpu/shaders/histogram.wgsl` | **New** | Parallel histogram reduction compute shader |
| `src/utils/gpu/shaders/sharpen.wgsl` | **New** | Unsharp mask compute shader (blur + diff) |
| `src/utils/gpu/shaders/noiseReduction.wgsl` | **New** | Luminance-preserving noise reduction shader |
| `src/utils/imageWorkerClient.ts` | **Edit** | GPU intercept layer — run WebGPUPipeline on raw ImageData from worker |
| `src/utils/imageWorker.ts` | **Edit** | Support `skipProcessing` flag to return raw ImageData without CPU pipeline |
| `src/types.ts` | **Edit** | Add `skipProcessing` to `RenderRequest`/`ExportRequest`, GPU diagnostic types |
| `src/utils/imagePipeline.ts` | **Edit** | Extract uniform struct builder; no logic changes |
| `src/components/SettingsModal.tsx` | **Edit** | GPU toggle in General tab, status in Diagnostics tab |
| `vite.config.ts` | **Edit** | Configure `.wgsl` file imports |

---

## Step-by-Step Implementation

### Step 1: Vite WGSL Import Support

WGSL shader files need to be importable as raw strings in TypeScript.

**`vite.config.ts`** — add a raw import rule for `.wgsl` files:

```ts
{
  assetsInclude: ['**/*.wgsl'],
}
```

And create a type declaration so TypeScript accepts `.wgsl` imports:

**`src/wgsl.d.ts`** (new):
```ts
declare module '*.wgsl?raw' {
  const shader: string;
  export default shader;
}
```

Shaders will be imported as `import conversionShader from './shaders/conversion.wgsl?raw'`.

---

### Step 2: WebGPUPipeline Class (Main Thread)

**`src/utils/gpu/WebGPUPipeline.ts`**

This is the central GPU orchestrator. It runs on the **main thread** (not in the worker) because Safari/WebKit and Tauri's WKWebView only expose `navigator.gpu` on the `Window` context. It is instantiated and owned by `imageWorkerClient.ts`, and provides a drop-in replacement for `processImageData()` with the same inputs and outputs.

#### 2.1 Class Structure

```ts
export class WebGPUPipeline {
  private device: GPUDevice;
  private conversionPipeline: GPUComputePipeline;
  private blurHorizontalPipeline: GPUComputePipeline;
  private blurVerticalPipeline: GPUComputePipeline;
  private histogramPipeline: GPUComputePipeline;
  private sharpenPipeline: GPUComputePipeline;
  private noiseReductionPipeline: GPUComputePipeline;

  // Reusable buffers (resized as needed)
  private pixelBuffer: GPUBuffer | null = null;      // RGBA float32 pixel data
  private uniformBuffer: GPUBuffer;                    // Conversion parameters
  private lutBuffer: GPUBuffer;                        // 4×256 curve LUTs
  private histogramBuffer: GPUBuffer;                  // 4×256 uint32 bins
  private histogramReadBuffer: GPUBuffer;              // Mappable readback
  private blurTempBuffer: GPUBuffer | null = null;     // Intermediate blur pass
  private blurParamsBuffer: GPUBuffer;                 // Kernel radius, sigma

  private currentPixelCount: number = 0;

  private constructor(device: GPUDevice) { ... }

  static async create(): Promise<WebGPUPipeline | null> { ... }

  async processImageData(
    imageData: ImageData,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
  ): Promise<HistogramData> { ... }

  destroy(): void { ... }
}
```

#### 2.2 Initialization (`static async create()`)

```ts
static async create(): Promise<WebGPUPipeline | null> {
  // 1. Check for WebGPU availability
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) return null;

    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupSizeX: 256,
      },
    });

    const pipeline = new WebGPUPipeline(device);
    await pipeline.initPipelines();
    return pipeline;
  } catch {
    return null;
  }
}
```

#### 2.3 Buffer Management

Buffers are allocated lazily and reused across renders. The pixel buffer is only reallocated when the image dimensions change (different preview level or export vs preview).

```ts
private ensurePixelBuffer(pixelCount: number): void {
  if (this.pixelBuffer && this.currentPixelCount >= pixelCount) return;

  this.pixelBuffer?.destroy();
  this.blurTempBuffer?.destroy();

  // RGBA float32 = 4 channels × 4 bytes × pixelCount
  const byteSize = pixelCount * 4 * 4;
  this.pixelBuffer = this.device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  this.blurTempBuffer = this.device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.STORAGE,
  });
  this.currentPixelCount = pixelCount;
}
```

#### 2.4 Main Dispatch: `processImageData()`

This method mirrors the CPU `processImageData()` signature exactly. It:

1. Converts `Uint8ClampedArray` → `Float32Array` and uploads to GPU.
2. Uploads uniform parameters (exposure factor, contrast factor, etc.) and curve LUTs.
3. Dispatches the conversion compute shader.
4. Optionally dispatches noise reduction and sharpen shaders.
5. Dispatches the histogram reduction shader.
6. Reads back the pixel data and histogram.
7. Writes results back to the `ImageData` and returns `HistogramData`.

```ts
async processImageData(
  imageData: ImageData,
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
  maskTuning?: MaskTuning,
  colorMatrix?: ColorMatrix,
  tonalCharacter?: TonalCharacter,
): Promise<HistogramData> {
  const { width, height, data } = imageData;
  const pixelCount = width * height;

  this.ensurePixelBuffer(pixelCount);

  // 1. Upload pixel data as float32
  const floatPixels = new Float32Array(pixelCount * 4);
  for (let i = 0; i < data.length; i++) {
    floatPixels[i] = data[i] / 255;
  }
  this.device.queue.writeBuffer(this.pixelBuffer!, 0, floatPixels);

  // 2. Build and upload uniforms
  const uniforms = this.buildUniforms(settings, isColor, comparisonMode, maskTuning, colorMatrix, tonalCharacter);
  this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

  // 3. Build and upload curve LUTs (4×256 float32)
  const luts = this.buildCurveLuts(settings);
  this.device.queue.writeBuffer(this.lutBuffer, 0, luts);

  // 4. Create command encoder
  const encoder = this.device.createCommandEncoder();

  // 5. Conversion pass
  if (comparisonMode === 'processed') {
    const workgroups = Math.ceil(pixelCount / 256);
    const convPass = encoder.beginComputePass();
    convPass.setPipeline(this.conversionPipeline);
    convPass.setBindGroup(0, this.createConversionBindGroup(pixelCount));
    convPass.dispatchWorkgroups(workgroups);
    convPass.end();
  }

  // 6. Noise reduction pass (two blur passes + blend)
  if (comparisonMode === 'processed' &&
      settings.noiseReduction.enabled &&
      settings.noiseReduction.luminanceStrength > 0) {
    this.encodeNoiseReduction(encoder, width, height, settings.noiseReduction.luminanceStrength);
  }

  // 7. Sharpen pass (two blur passes + unsharp mask)
  if (comparisonMode === 'processed' &&
      settings.sharpen.enabled &&
      settings.sharpen.amount > 0) {
    this.encodeSharpen(encoder, width, height, settings.sharpen.radius, settings.sharpen.amount);
  }

  // 8. Histogram reduction pass
  // Clear histogram buffer first
  encoder.clearBuffer(this.histogramBuffer);
  const histPass = encoder.beginComputePass();
  histPass.setPipeline(this.histogramPipeline);
  histPass.setBindGroup(0, this.createHistogramBindGroup(pixelCount));
  histPass.dispatchWorkgroups(Math.ceil(pixelCount / 256));
  histPass.end();

  // 9. Copy results to mappable buffers
  const pixelReadBuffer = this.device.createBuffer({
    size: pixelCount * 4 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyBufferToBuffer(this.pixelBuffer!, 0, pixelReadBuffer, 0, pixelCount * 4 * 4);
  encoder.copyBufferToBuffer(this.histogramBuffer, 0, this.histogramReadBuffer, 0, 256 * 4 * 4);

  // 10. Submit and read back
  this.device.queue.submit([encoder.finish()]);

  await Promise.all([
    pixelReadBuffer.mapAsync(GPUMapMode.READ),
    this.histogramReadBuffer.mapAsync(GPUMapMode.READ),
  ]);

  // 11. Write pixels back to ImageData
  const resultPixels = new Float32Array(pixelReadBuffer.getMappedRange());
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.round(clamp(resultPixels[i], 0, 1) * 255);
    data[i + 1] = Math.round(clamp(resultPixels[i + 1], 0, 1) * 255);
    data[i + 2] = Math.round(clamp(resultPixels[i + 2], 0, 1) * 255);
    // Alpha untouched
  }
  pixelReadBuffer.unmap();
  pixelReadBuffer.destroy();

  // 12. Read histogram
  const histData = new Uint32Array(this.histogramReadBuffer.getMappedRange().slice(0));
  this.histogramReadBuffer.unmap();

  const histogram: HistogramData = {
    r: Array.from(histData.subarray(0, 256)),
    g: Array.from(histData.subarray(256, 512)),
    b: Array.from(histData.subarray(512, 768)),
    l: Array.from(histData.subarray(768, 1024)),
  };

  return histogram;
}
```

#### 2.5 Uniform Struct Builder

Extracts all scalar conversion parameters into a flat `Float32Array` matching the WGSL struct layout. This function is shared between the GPU pipeline and potential future use.

```ts
private buildUniforms(
  settings: ConversionSettings,
  isColor: boolean,
  comparisonMode: 'processed' | 'original',
  maskTuning?: MaskTuning,
  colorMatrix?: ColorMatrix,
  tonalCharacter?: TonalCharacter,
): Float32Array {
  const effective = maskTuning ? {
    ...settings,
    highlightProtection: clamp(settings.highlightProtection + maskTuning.highlightProtectionBias * 100, 0, 100),
    blackPoint: clamp(settings.blackPoint + maskTuning.blackPointBias * 100, 0, 80),
  } : settings;

  const filmBase = getFilmBaseBalance(effective.filmBaseSample);

  // 48 floats (192 bytes, 12 vec4s for alignment)
  return new Float32Array([
    // vec4 0: mode flags
    comparisonMode === 'processed' ? 1 : 0,  // u_processMode
    isColor ? 1 : 0,                          // u_isColor
    0, 0,                                      // padding

    // vec4 1: exposure, contrast, saturation
    Math.pow(2, effective.exposure / 50),                              // u_exposureFactor
    (259 * (effective.contrast + 255)) / (255 * (259 - effective.contrast)),  // u_contrastFactor
    effective.saturation / 100,                                         // u_saturationFactor
    0,                                                                  // padding

    // vec4 2: film base balance
    filmBase.red, filmBase.green, filmBase.blue, 0,

    // vec4 3: channel balance
    effective.redBalance, effective.greenBalance, effective.blueBalance, 0,

    // vec4 4: temperature, tint, black/white point
    effective.temperature / 255,   // u_temperatureShift
    effective.tint / 255,          // u_tintShift
    effective.blackPoint / 255,    // u_blackPoint
    effective.whitePoint / 255,    // u_whitePoint

    // vec4 5: highlight protection & tonal character
    effective.highlightProtection,
    tonalCharacter?.shadowLift ?? 0,
    tonalCharacter?.midtoneAnchor ?? 0,
    tonalCharacter?.highlightRolloff ?? 0.5,

    // vec4 6-8: color matrix (3×3, padded to 3×vec4)
    colorMatrix?.[0] ?? 1, colorMatrix?.[1] ?? 0, colorMatrix?.[2] ?? 0, 0,
    colorMatrix?.[3] ?? 0, colorMatrix?.[4] ?? 1, colorMatrix?.[5] ?? 0, 0,
    colorMatrix?.[6] ?? 0, colorMatrix?.[7] ?? 0, colorMatrix?.[8] ?? 1, 0,

    // vec4 9: flags
    colorMatrix ? 1 : 0,  // u_hasColorMatrix
    0, 0, 0,
  ]);
}
```

#### 2.6 Curve LUT Builder

Packs 4 curve LUTs into a single `Float32Array` buffer (4 × 256 = 1024 floats).

```ts
private buildCurveLuts(settings: ConversionSettings): Float32Array {
  const lutRGB = createCurveLut(settings.curves.rgb);
  const lutR = createCurveLut(settings.curves.red);
  const lutG = createCurveLut(settings.curves.green);
  const lutB = createCurveLut(settings.curves.blue);

  const result = new Float32Array(1024);
  for (let i = 0; i < 256; i++) {
    result[i]       = lutRGB[i] / 255;  // Normalized to 0-1
    result[256 + i] = lutR[i] / 255;
    result[512 + i] = lutG[i] / 255;
    result[768 + i] = lutB[i] / 255;
  }
  return result;
}
```

---

### Step 3: Conversion Compute Shader

**`src/utils/gpu/shaders/conversion.wgsl`**

This shader is a direct port of the `processImageData()` per-pixel loop (lines 341–417 of `imagePipeline.ts`). Each invocation processes one pixel.

```wgsl
struct Uniforms {
  processMode: f32,       // 1.0 = processed, 0.0 = original
  isColor: f32,
  _pad0: f32, _pad1: f32,

  exposureFactor: f32,
  contrastFactor: f32,
  saturationFactor: f32,
  _pad2: f32,

  filmBaseR: f32, filmBaseG: f32, filmBaseB: f32, _pad3: f32,
  chanBalR: f32, chanBalG: f32, chanBalB: f32, _pad4: f32,
  tempShift: f32, tintShift: f32, blackPoint: f32, whitePoint: f32,

  highlightProtection: f32,
  shadowLift: f32,
  midtoneAnchor: f32,
  highlightRolloff: f32,

  // Color matrix rows (3×3 in 3×vec4)
  cm0: f32, cm1: f32, cm2: f32, _pad5: f32,
  cm3: f32, cm4: f32, cm5: f32, _pad6: f32,
  cm6: f32, cm7: f32, cm8: f32, _pad7: f32,

  hasColorMatrix: f32,
  _pad8: f32, _pad9: f32, _pad10: f32,
};

@group(0) @binding(0) var<storage, read_write> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<storage, read> curveLuts: array<f32>;  // 1024 floats

fn clampF(v: f32, lo: f32, hi: f32) -> f32 {
  return max(lo, min(hi, v));
}

fn applyWhiteBlackPoint(value: f32, bp: f32, wp: f32) -> f32 {
  let range = max(1.0 / 255.0, wp - bp);
  return (value - bp) / range;
}

fn applyTonalCharacter(value: f32) -> f32 {
  var v = value;

  // Shadow lift
  if (u.shadowLift > 0.0 && v < 0.5) {
    let t = v / 0.5;
    let gamma = 1.0 - u.shadowLift * 0.6;
    v = 0.5 * pow(clampF(t, 0.0, 1.0), gamma);
  }

  // Midtone anchor
  v += u.midtoneAnchor;

  // Highlight protection + rolloff
  let threshold = 200.0 / 255.0;
  if (u.highlightProtection > 0.0 && v > threshold) {
    let protection = clampF(u.highlightProtection / 100.0, 0.0, 0.95);
    let shoulder = (v - threshold) / (1.0 - threshold);
    let rolloff = max(u.highlightRolloff, 0.05);
    let softness = 1.0 - protection * pow(clampF(shoulder, 0.0, 1.0), rolloff);
    v = threshold + shoulder * (1.0 - threshold) * softness;
  }

  return clampF(v, 0.0, 1.0);
}

fn lookupCurve(channel: u32, value: f32) -> f32 {
  // channel: 0=RGB, 1=R, 2=G, 3=B
  let idx = clamp(u32(round(clampF(value, 0.0, 1.0) * 255.0)), 0u, 255u);
  return curveLuts[channel * 256u + idx];
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&pixels)) {
    return;
  }

  var px = pixels[idx];
  var r = px.x;
  var g = px.y;
  var b = px.z;

  if (u.processMode > 0.5) {
    // Inversion
    r = 1.0 - r;
    g = 1.0 - g;
    b = 1.0 - b;

    // Color matrix
    if (u.hasColorMatrix > 0.5) {
      let nr = u.cm0 * r + u.cm1 * g + u.cm2 * b;
      let ng = u.cm3 * r + u.cm4 * g + u.cm5 * b;
      let nb = u.cm6 * r + u.cm7 * g + u.cm8 * b;
      r = nr; g = ng; b = nb;
    }

    // Film base compensation
    r *= u.filmBaseR;
    g *= u.filmBaseG;
    b *= u.filmBaseB;

    // Color / B&W path
    if (u.isColor > 0.5) {
      r *= u.chanBalR;
      g *= u.chanBalG;
      b *= u.chanBalB;
      r += u.tempShift;
      b -= u.tempShift;
      g += u.tintShift;
    } else {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray; g = gray; b = gray;
    }

    // Exposure
    r *= u.exposureFactor;
    g *= u.exposureFactor;
    b *= u.exposureFactor;

    // White/black point
    r = applyWhiteBlackPoint(r, u.blackPoint, u.whitePoint);
    g = applyWhiteBlackPoint(g, u.blackPoint, u.whitePoint);
    b = applyWhiteBlackPoint(b, u.blackPoint, u.whitePoint);

    // Contrast
    r = u.contrastFactor * (r - 0.5) + 0.5;
    g = u.contrastFactor * (g - 0.5) + 0.5;
    b = u.contrastFactor * (b - 0.5) + 0.5;

    // Tonal character + highlight protection
    r = applyTonalCharacter(r);
    g = applyTonalCharacter(g);
    b = applyTonalCharacter(b);

    // Saturation
    if (u.isColor > 0.5) {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * u.saturationFactor;
      g = gray + (g - gray) * u.saturationFactor;
      b = gray + (b - gray) * u.saturationFactor;
    } else {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray; g = gray; b = gray;
    }

    // Curve LUT: chain RGB → per-channel
    r = lookupCurve(1u, lookupCurve(0u, r));  // lutR[lutRGB[r]]
    g = lookupCurve(2u, lookupCurve(0u, g));  // lutG[lutRGB[g]]
    b = lookupCurve(3u, lookupCurve(0u, b));  // lutB[lutRGB[b]]
  }

  // Final clamp
  pixels[idx] = vec4<f32>(clampF(r, 0.0, 1.0), clampF(g, 0.0, 1.0), clampF(b, 0.0, 1.0), px.w);
}
```

**Workgroup strategy:** 256 threads per workgroup, 1D dispatch. For a 40 MP image (40,000,000 pixels), this is ~156,250 workgroups — well within WebGPU limits.

---

### Step 4: Separable Gaussian Blur Compute Shader

**`src/utils/gpu/shaders/blur.wgsl`**

Two pipelines share this shader: one configured for horizontal passes, one for vertical. The shader reads from one storage buffer and writes to another, enabling ping-pong between passes.

```wgsl
struct BlurParams {
  width: u32,
  height: u32,
  kernelRadius: u32,
  horizontal: u32,   // 1 = horizontal, 0 = vertical
  sigma: f32,
  _pad0: f32, _pad1: f32, _pad2: f32,
};

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: BlurParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixelIdx = gid.x;
  let totalPixels = params.width * params.height;
  if (pixelIdx >= totalPixels) { return; }

  let x = pixelIdx % params.width;
  let y = pixelIdx / params.width;
  let radius = i32(params.kernelRadius);

  var sumR: f32 = 0.0;
  var sumG: f32 = 0.0;
  var sumB: f32 = 0.0;
  var weightSum: f32 = 0.0;

  for (var k: i32 = -radius; k <= radius; k++) {
    var sx: u32;
    var sy: u32;
    if (params.horizontal > 0u) {
      sx = u32(clamp(i32(x) + k, 0, i32(params.width) - 1));
      sy = y;
    } else {
      sx = x;
      sy = u32(clamp(i32(y) + k, 0, i32(params.height) - 1));
    }

    let sIdx = sy * params.width + sx;
    let d = f32(k);
    let w = exp(-(d * d) / (2.0 * params.sigma * params.sigma));
    weightSum += w;

    let pixel = src[sIdx];
    sumR += pixel.x * w;
    sumG += pixel.y * w;
    sumB += pixel.z * w;
  }

  let inv = 1.0 / weightSum;
  dst[pixelIdx] = vec4<f32>(sumR * inv, sumG * inv, sumB * inv, src[pixelIdx].w);
}
```

**Dispatch pattern for a full blur:**
1. Upload blur params with `horizontal = 1`.
2. Dispatch: `src = pixelBuffer`, `dst = blurTempBuffer`.
3. Upload blur params with `horizontal = 0`.
4. Dispatch: `src = blurTempBuffer`, `dst = blurOutputBuffer` (or back to a dedicated buffer).

---

### Step 5: Sharpen Compute Shader

**`src/utils/gpu/shaders/sharpen.wgsl`**

After the blur passes produce a blurred copy, this shader applies the unsharp mask: `result = original + factor * (original - blurred)`.

```wgsl
struct SharpenParams {
  pixelCount: u32,
  factor: f32,       // amount / 100
  _pad0: f32, _pad1: f32,
};

@group(0) @binding(0) var<storage, read_write> pixels: array<vec4<f32>>;   // Original (modified in place)
@group(0) @binding(1) var<storage, read> blurred: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: SharpenParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) { return; }

  let orig = pixels[idx];
  let blur = blurred[idx];

  let r = clamp(orig.x + params.factor * (orig.x - blur.x), 0.0, 1.0);
  let g = clamp(orig.y + params.factor * (orig.y - blur.y), 0.0, 1.0);
  let b = clamp(orig.z + params.factor * (orig.z - blur.z), 0.0, 1.0);

  pixels[idx] = vec4<f32>(r, g, b, orig.w);
}
```

---

### Step 6: Noise Reduction Compute Shader

**`src/utils/gpu/shaders/noiseReduction.wgsl`**

Blends original and blurred pixels by luminance ratio, preserving color.

```wgsl
struct NRParams {
  pixelCount: u32,
  factor: f32,       // strength / 100
  _pad0: f32, _pad1: f32,
};

@group(0) @binding(0) var<storage, read_write> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> blurred: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: NRParams;

fn luminance(r: f32, g: f32, b: f32) -> f32 {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) { return; }

  let orig = pixels[idx];
  let blur = blurred[idx];

  let lumOrig = luminance(orig.x, orig.y, orig.z);
  let lumBlur = luminance(blur.x, blur.y, blur.z);
  let lumNew = lumOrig + (lumBlur - lumOrig) * params.factor;

  var scale: f32 = 1.0;
  if (lumOrig > 0.001) {
    scale = lumNew / lumOrig;
  }

  let r = clamp(orig.x * scale, 0.0, 1.0);
  let g = clamp(orig.y * scale, 0.0, 1.0);
  let b = clamp(orig.z * scale, 0.0, 1.0);

  pixels[idx] = vec4<f32>(r, g, b, orig.w);
}
```

---

### Step 7: Histogram Reduction Compute Shader

**`src/utils/gpu/shaders/histogram.wgsl`**

Each invocation reads one pixel, quantizes to 0–255, and atomically increments the corresponding histogram bin. The histogram buffer has 1024 `u32` entries: bins 0–255 for R, 256–511 for G, 512–767 for B, 768–1023 for L.

```wgsl
@group(0) @binding(0) var<storage, read> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&pixels)) { return; }

  let px = pixels[idx];
  let r = u32(round(clamp(px.x, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(px.y, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(px.z, 0.0, 1.0) * 255.0));
  let l = u32(round(0.299 * px.x + 0.587 * px.y + 0.114 * px.z) * 255.0);

  atomicAdd(&histogram[r], 1u);          // R channel: bins 0-255
  atomicAdd(&histogram[256u + g], 1u);   // G channel: bins 256-511
  atomicAdd(&histogram[512u + b], 1u);   // B channel: bins 512-767
  atomicAdd(&histogram[768u + clamp(l, 0u, 255u)], 1u);  // L channel: bins 768-1023
}
```

**Note:** Atomic operations on storage buffers are well-supported in WebGPU. For very large images (>40 MP), contention on popular bins (e.g., bin 0 or 255 in clipped images) could create some serialization, but in practice this is negligible compared to the CPU alternative.

---

### Step 8: Main-Thread GPU Intercept & Worker Changes

Since WebGPU runs on the main thread (required for Safari/WKWebView), the integration point is `imageWorkerClient.ts`, not the worker itself. The worker gains a `skipProcessing` flag; the client gains GPU pipeline ownership.

#### 8.1 Worker Changes (`imageWorker.ts`)

Minimal changes. Add support for a `skipProcessing` flag on render and export requests:

```ts
function handleRender(payload: RenderRequest) {
  const document = getStoredDocument(payload.documentId);
  const level = selectPreviewLevel(
    document.previews.map((p) => p.level),
    payload.targetMaxDimension,
  );
  const preview = document.previews.find((c) => c.level.id === level.id)
    ?? document.previews[document.previews.length - 1];
  const transformed = renderTransformedCanvas(preview.canvas, payload.settings);
  const ctx = transformed.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read rendered preview.');

  const imageData = ctx.getImageData(0, 0, transformed.width, transformed.height);

  // When skipProcessing is true, return raw ImageData for main-thread GPU processing
  let histogram: HistogramData;
  if (payload.skipProcessing) {
    histogram = buildEmptyHistogram();  // Placeholder; GPU will compute on main thread
  } else {
    histogram = processImageData(
      imageData,
      payload.settings,
      payload.isColor,
      payload.comparisonMode,
      payload.maskTuning,
      payload.colorMatrix,
      payload.tonalCharacter,
    );
    ctx.putImageData(imageData, 0, 0);
  }

  return {
    documentId: payload.documentId,
    revision: payload.revision,
    width: transformed.width,
    height: transformed.height,
    previewLevelId: preview.level.id,
    imageData,
    histogram,
  } satisfies RenderResult;
}
```

The same `skipProcessing` pattern applies to `handleExport()`. When skipping, the worker returns raw ImageData and the client processes it on the main thread before calling `convertToBlob`.

#### 8.2 Type Changes (`types.ts`)

```ts
interface RenderRequest {
  // ... existing fields ...
  skipProcessing?: boolean;  // When true, worker returns raw ImageData for GPU processing
}

interface ExportRequest {
  // ... existing fields ...
  skipProcessing?: boolean;
}
```

#### 8.3 Worker Client GPU Integration (`imageWorkerClient.ts`)

The client owns the `WebGPUPipeline` instance and intercepts render/export responses:

```ts
import { WebGPUPipeline } from './gpu/WebGPUPipeline';

class ImageWorkerClient {
  private worker: Worker;
  private gpuPipeline: WebGPUPipeline | null = null;
  private gpuInitAttempted = false;
  private gpuEnabled = true;  // User preference, default on

  constructor() {
    this.worker = this.createWorker();
  }

  private async ensureGPU(): Promise<WebGPUPipeline | null> {
    if (!this.gpuEnabled) return null;
    if (!this.gpuInitAttempted) {
      this.gpuInitAttempted = true;
      this.gpuPipeline = await WebGPUPipeline.create();
    }
    return this.gpuPipeline;
  }

  setGPUEnabled(enabled: boolean): void {
    this.gpuEnabled = enabled;
    if (!enabled && this.gpuPipeline) {
      this.gpuPipeline.destroy();
      this.gpuPipeline = null;
      this.gpuInitAttempted = false;
    }
    if (enabled) {
      this.gpuInitAttempted = false;  // Re-init on next render
    }
  }

  async getGPUDiagnostics(): Promise<{
    gpuAvailable: boolean;
    gpuActive: boolean;
    gpuAdapterName: string | null;
    gpuDisabledByUser: boolean;
  }> {
    const gpu = await this.ensureGPU();
    return {
      gpuAvailable: 'gpu' in navigator,
      gpuActive: gpu !== null,
      gpuAdapterName: gpu?.adapterName ?? null,
      gpuDisabledByUser: !this.gpuEnabled,
    };
  }

  async render(payload: RenderRequest): Promise<RenderResult> {
    const gpu = await this.ensureGPU();

    // If GPU is available, tell the worker to skip CPU processing
    const workerPayload = gpu
      ? { ...payload, skipProcessing: true }
      : payload;

    const result = await this.request<RenderResult>('render', workerPayload);

    // GPU path: process the raw ImageData on the main thread
    if (gpu && workerPayload.skipProcessing) {
      const histogram = await gpu.processImageData(
        result.imageData,
        payload.settings,
        payload.isColor,
        payload.comparisonMode,
        payload.maskTuning,
        payload.colorMatrix,
        payload.tonalCharacter,
      );
      return { ...result, histogram };
    }

    return result;
  }

  async export(payload: ExportRequest): Promise<ExportResult> {
    const gpu = await this.ensureGPU();

    const workerPayload = gpu
      ? { ...payload, skipProcessing: true }
      : payload;

    // For export with GPU, worker returns raw ImageData + we process + re-encode
    // The worker still handles convertToBlob, so for GPU exports we need a
    // two-step: get raw data → GPU process → send back for blob encoding
    // OR: handle blob encoding on main thread too
    //
    // Simplest approach: for GPU exports, the worker returns the raw ImageData
    // and dimensions. The client processes via GPU, creates a canvas,
    // puts the processed data, and calls convertToBlob on the main thread.
    if (gpu && workerPayload.skipProcessing) {
      const result = await this.request<ExportResult>('export', workerPayload);
      // Export with GPU is handled via the two-phase approach below in Step 10
      return result;
    }

    return this.request<ExportResult>('export', workerPayload);
  }

  // ... existing methods unchanged ...
}
```

**Main-thread GPU processing does not block the UI** because:
- `device.queue.writeBuffer()` and `device.queue.submit()` are non-blocking GPU command submissions.
- Only `mapAsync()` is async and yields to the event loop while the GPU executes.
- For preview-sized images (~4 MP), the entire GPU round-trip completes in <10 ms.
- For large exports (~40 MP), the async nature means the UI remains responsive during the ~50–100 ms GPU execution.

#### 8.4 Lifecycle Management

The `WebGPUPipeline` is destroyed when:
- The user disables GPU rendering via `setGPUEnabled(false)`.
- The `ImageWorkerClient` is terminated (`terminate()` method).
- The `GPUDevice` is lost (driver crash, sleep/wake) — detected via `device.lost` promise, which triggers automatic re-initialization on the next render.

---

### Step 9: GPU Preference Toggle & Diagnostics

#### 9.1 User Preference: GPU Rendering Toggle

**Default behavior:** GPU rendering is **on by default** on macOS (both Tauri/WKWebView and Safari/Chrome). On other platforms where WebGPU is available, it is also on by default. Users can disable it in Settings to force CPU mode.

**`src/utils/preferenceStore.ts`** — add a new persisted preference:

```ts
// New preference key
gpuRendering: boolean  // default: true
// Persisted to localStorage as part of darkslide_preferences_v1
```

The preference is read by `imageWorkerClient.ts` on initialization. When `gpuRendering` is `false`, the client's `ensureGPU()` returns `null` and the worker runs the full CPU pipeline as it does today. No worker message is needed — the toggle is entirely main-thread side.

When the user toggles the setting, the App calls `workerClient.setGPUEnabled(enabled)` which immediately destroys or schedules re-init of the GPU pipeline. No re-render is triggered automatically — the next render request will use the new path.

#### 9.2 Settings UI

**`src/components/SettingsModal.tsx`** — General tab

Add a "Render Backend" section with:

- **Toggle switch:** "Use GPU acceleration (WebGPU)" — on/off
  - Default: on
  - When toggled off: sends `set-gpu-preference` to worker, persists to preferences
  - When toggled on: sends `set-gpu-preference` to worker, GPU initializes on next render
- **Status label** below the toggle showing current state:
  - "Active — GPU (WebGPU)" with adapter name (e.g., "Apple M2 Pro")
  - "Active — CPU" when GPU is disabled or unavailable
  - "Unavailable — your browser does not support WebGPU" when `navigator.gpu` is missing
- Subtle help text: "Disable GPU acceleration if you experience rendering artifacts or crashes."

#### 9.3 Diagnostics Tab

**`src/components/SettingsModal.tsx`** — Diagnostics tab

Add a "Render Backend" row showing:
- Current active path (GPU or CPU)
- GPU adapter name and vendor (when available)
- Whether GPU was disabled by user preference vs. browser limitation

The Settings modal calls `workerClientRef.current.getGPUDiagnostics()` on mount (see Step 8.3 for the method). This is a main-thread-only call — no worker round-trip needed.

---

### Step 10: Export Path

Exports with GPU require a two-phase approach since `canvas.convertToBlob()` needs to run after GPU processing:

**CPU path (unchanged):** Worker does everything — `processImageData()` → `putImageData()` → `convertToBlob()` → returns `ExportResult` with blob.

**GPU path:**
1. Worker receives `ExportRequest` with `skipProcessing: true`.
2. Worker applies rotation + crop to the **full-resolution source** (not a preview), calls `getImageData()`, and returns the raw `ImageData` along with dimensions in a new `RawExportResult` response type.
3. `imageWorkerClient.ts` receives the raw data, runs `WebGPUPipeline.processImageData()` on the main thread.
4. Client creates an `OffscreenCanvas`, puts the processed `ImageData`, calls `convertToBlob()` on the main thread.
5. Returns the final `ExportResult` with blob + filename to `App.tsx`.

```ts
// New response type for GPU exports
interface RawExportResult {
  imageData: ImageData;
  width: number;
  height: number;
  filename: string;
  format: ExportFormat;
  quality: number;
}
```

The `fileBridge.ts` download logic and export UI are unchanged — they receive the same `ExportResult` shape regardless of which path produced it.

---

## Buffer Lifecycle & Memory

| Buffer | Size (40 MP image) | Lifetime |
|--------|-------------------|----------|
| `pixelBuffer` | 640 MB (40M × 16 bytes) | Reused across renders, resized on dimension change |
| `blurTempBuffer` | 640 MB | Same as pixelBuffer |
| `uniformBuffer` | 192 bytes | Created once, rewritten per render |
| `lutBuffer` | 4 KB (1024 × 4 bytes) | Created once, rewritten per render |
| `histogramBuffer` | 4 KB (1024 × 4 bytes) | Created once, cleared per render |
| `histogramReadBuffer` | 4 KB | Created once, mapped/unmapped per render |
| `pixelReadBuffer` | 640 MB | Created per render, destroyed after readback |

**Total GPU memory for 40 MP:** ~1.9 GB peak (during readback). For preview renders at 2048px max dimension (~4 MP), this drops to ~192 MB.

**Optimization note:** The `pixelReadBuffer` allocation per render is wasteful. A future optimization can use a persistent mappable buffer and double-buffer the pixel storage. For beta, the per-render allocation is simpler and correct.

---

## Correctness Validation Strategy

### Pixel-exact regression tests

The existing test suite in `src/__tests__/` includes per-slider pipeline tests and golden-pixel profile round-trips. These tests call `processImageData()` directly on the CPU path.

To validate GPU correctness:

1. **Add a `GPU_VALIDATION` test mode** that runs each existing pipeline test through both the CPU and GPU paths, then compares outputs pixel-by-pixel.
2. **Tolerance:** Allow ±1 on each 0–255 channel due to floating-point rounding differences between CPU (f64 JS math) and GPU (f32 WGSL math). The existing CPU path already rounds intermediate values, so single-LSB differences are expected and acceptable.
3. **Test entry point:** A new test file `src/__tests__/gpuPipeline.test.ts` that conditionally runs when WebGPU is available in the test environment. Skip gracefully otherwise.

### Manual validation

After implementation, visually compare CPU and GPU renders of the same image with identical settings. Toggle the GPU flag in diagnostics to switch paths. Key things to verify:
- Curves with extreme control points
- High highlight protection values
- B&W conversion
- Film base compensation with strong orange mask
- Sharpen at maximum radius + amount
- Noise reduction at maximum strength
- Histogram bins match between paths (within ±1 count tolerance from rounding)

---

## Implementation Order

| # | Task | Depends On | Estimated Complexity |
|---|------|-----------|---------------------|
| 1 | Vite WGSL config + type declaration | — | Trivial |
| 2 | `conversion.wgsl` shader | — | Medium (port 14 per-pixel ops) |
| 3 | `blur.wgsl` shader | — | Low (standard separable Gaussian) |
| 4 | `sharpen.wgsl` shader | — | Low (unsharp mask) |
| 5 | `noiseReduction.wgsl` shader | — | Low (luminance blend) |
| 6 | `histogram.wgsl` shader | — | Low (atomic bins) |
| 7 | `WebGPUPipeline.ts` class (main thread) | 2, 3, 4, 5, 6 | High (buffer mgmt, dispatch orchestration) |
| 8 | Worker `skipProcessing` flag (`imageWorker.ts` + `types.ts`) | — | Low (conditional skip) |
| 9 | Client GPU intercept (`imageWorkerClient.ts`) | 7, 8 | Medium (GPU ownership, render/export routing) |
| 10 | GPU preference in `preferenceStore.ts` | — | Low (new boolean pref, default true) |
| 11 | Settings UI toggle + diagnostics display | 9, 10 | Medium (toggle in General tab, status in Diagnostics) |
| 12 | GPU export path (main-thread blob encoding) | 9 | Medium (OffscreenCanvas + convertToBlob) |
| 13 | Regression tests | 7 | Medium (dual-path comparison) |

**Suggested build order:** 1 → 2 → 3 → 7 (minimal: conversion only) → 8 → 9 → manual test on Safari → 4 → 5 → 6 → integrate remaining shaders → 10 → 11 → 12 → 13.

**Critical:** Test on Safari/WebKit early (after step 9). Chrome may accept WGSL constructs that WebKit rejects. Validate shader compilation on both engines before building out remaining shaders.

Start with just the conversion shader to validate the full GPU→readback roundtrip before adding the spatial filters. This isolates buffer management bugs from shader logic bugs.

---

## Browser Compatibility

Since the GPU pipeline runs on the main thread (`Window` context), WebGPU worker support is irrelevant.

| Browser | WebGPU on Main Thread | GPU Rendering | Status |
|---------|----------------------|---------------|--------|
| Safari 18+ (macOS Tahoe) | Yes | Active by default | **Primary target** |
| Tauri WKWebView (macOS 15+/Tahoe) | Yes | Active by default | **Primary target** |
| Chrome 113+ | Yes | Active by default | Bonus target |
| Edge 113+ | Yes | Active by default | Bonus target |
| Firefox | Behind flag | CPU fallback | Not targeted |
| Older Safari (<18) | No | CPU fallback | Graceful degradation |

The fallback is transparent — users on unsupported browsers get the same experience as today. The Diagnostics panel and Settings toggle make it clear which path is active.

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Main-thread GPU jank during large renders | UI freezes during GPU readback | `mapAsync` is non-blocking and yields to the event loop. Preview renders (~4 MP) complete in <10 ms. For large exports, show a progress indicator. |
| f32 vs f64 precision differences produce visible artifacts | Color shifts in extreme settings | ±1 tolerance in tests. If visible, add f32 clamping to CPU path to match. |
| GPU memory pressure on large exports (40 MP) | Render failure or browser tab crash | Catch `GPUDevice.lost` promise, fall back to CPU for that render. Cap GPU path at configurable pixel limit (e.g., 20 MP). |
| `GPUDevice` lost mid-session (driver crash, sleep/wake) | Subsequent GPU renders fail | Listen for `device.lost`, set `gpuPipeline = null`, re-attempt `ensureGPU()` on next render. |
| WGSL shader compilation failure on specific GPU drivers | GPU path broken on affected hardware | Wrap pipeline creation in try/catch, fall back silently. Log adapter info in diagnostics. |
| Atomic histogram contention degrades performance | Histogram pass slower than expected | Acceptable — histogram is a tiny fraction of total work. If needed, use workgroup-local histograms + merge. |
| WebKit WGSL compatibility gaps | Shader fails to compile on WebKit but works on Chrome | Test shaders on Safari/WebKit during development. Avoid Chrome-only WGSL extensions. Safari's WebGPU implementation is Metal-backed and well-tested for compute. |
| ImageData transfer overhead (worker → main → GPU) | Extra copy for GPU path vs CPU-in-worker | For previews (~4 MP), overhead is ~2 ms. For exports (~40 MP), overhead is ~50 ms but offset by ~20× GPU speedup. Structured clone of ImageData is efficient. |

---

## Performance Expectations

Based on typical WebGPU compute throughput on Apple M-series GPUs:

| Operation | CPU (current) | GPU (expected) | Speedup |
|-----------|--------------|----------------|---------|
| Per-pixel conversion (40 MP) | ~800 ms | ~40 ms | ~20× |
| Gaussian blur (40 MP, radius 3) | ~1200 ms | ~60 ms | ~20× |
| Sharpen (40 MP) | ~1400 ms (blur + mask) | ~70 ms | ~20× |
| Noise reduction (40 MP) | ~1400 ms (blur + blend) | ~70 ms | ~20× |
| Histogram (40 MP) | ~100 ms | ~10 ms | ~10× |
| **Total pipeline (all enabled)** | **~4900 ms** | **~250 ms** | **~20×** |

For preview renders at 2048px (~4 MP), the CPU path is already fast (~100–200 ms). The GPU path will reduce this to ~10–20 ms, making slider adjustments feel instantaneous even without debouncing.

**Data transfer overhead:** Uploading and reading back 40 MP of float32 RGBA data adds ~50–100 ms. For previews this is negligible (~5 ms). This is the primary reason the GPU path shines most on large exports and high-zoom previews.

---

## What This Phase Does NOT Change

- **React components** — no changes to any component except the Settings modal (GPU toggle in General tab, status in Diagnostics tab).
- **Worker message protocol** — `RenderRequest` and `ExportRequest` gain one optional `skipProcessing` boolean; `RenderResult` and `ExportResult` shapes are unchanged from the caller's perspective.
- **`imageWorkerClient.ts`** — public API is unchanged (`render()`, `export()` return the same types). Internally gains GPU pipeline ownership and two new methods (`setGPUEnabled()`, `getGPUDiagnostics()`).
- **Crop, rotation, preview pyramid** — these continue to use 2D canvas operations (already GPU-accelerated by the browser).
- **Undo/redo, presets, settings persistence** — no changes.
- **Tauri desktop shell** — no Rust-side changes. WebGPU is accessed via the WKWebView's JavaScript context, not through Tauri commands.
