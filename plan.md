# DarkSlide Beta Roadmap

## Summary
Ship a clean, hobbyist-friendly film negative converter as both a web app and a Tauri desktop binary. Start simple, then layer in pro features post-beta. Single-document workflow for beta; tabs, batch, ICC, and RAW decoding come later.

## Phase 0: Stabilize the Baseline [complete]
- Rename package/app metadata to `darkslide` and keep only dependencies the frontend actually uses.
- Fix product correctness issues: custom preset type resolution, export filename extension, DarkSlide branding, safer film-base sampling, and actionable import errors.
- Keep one document-oriented source of truth for the active file, settings, export options, profile, histogram, and status.

## Phase 1: Worker-Backed Imaging Pipeline [complete]
- Decode supported images in a dedicated worker.
- Build preview pyramids for responsive editing.
- Render previews from worker-owned preview levels and export from the full-resolution source.
- Use blob exports instead of data URLs.
- Ignore stale render revisions so rapid edits do not overwrite newer previews.

## Phase 2: Better Conversion Quality [complete]
- Use a more explicit pipeline order: orientation, crop, inversion, film-base compensation, white/black point remap, tone protection, curves, and output.
- Add controls for black point, white point, highlight protection, and before/after comparison.
- Keep crop non-destructive and editable via an overlay.

## Phase 3: Tauri Desktop Shell [complete]
- Scaffold the Tauri project around the existing Vite frontend and bundle configuration.
- Route import/export through native desktop open/save dialogs when running in Tauri.
- Keep browser deployment working alongside the desktop build through the shared file bridge fallback.
- Continue reserving RAW decoding for a later desktop-native path behind the existing stable decode interface.

## Phase 4: Editing Polish [complete]
- **Zoom and pan viewport**: users can inspect at fit, 50%, 100%, and 200%, pan the image directly, and keep preview selection tied to the effective zoom level.
- **Better film profiles**: the built-in profile set now covers a broader mix of color and black-and-white stocks, with tuned defaults and mask compensation metadata per stock.
- **Per-slider undo**: history is committed at interaction boundaries so individual slider drags and toggle changes undo cleanly instead of collapsing broad batches together.
- **Sharpen / noise reduction**: post-conversion sharpening and basic luminance noise reduction are now part of the editing pipeline and sidebar controls.

## Phase 5: UI Polish [complete]
- **Toolbar clarity**: Settings modal (⌘,) with General / Shortcuts / Diagnostics tabs replaces the old debug toolbar button; gear icon pinned to sidebar bottom; Tauri native menu entry wired up.
- **Export flow**: Export button added inside the Export tab (co-located with format/quality settings); Cmd+E shortcut triggers export from anywhere; sidebar tab state lifted to App so the export tab can be targeted programmatically.
- **Reset Adjustments safeguard**: Reset now pushes the current settings onto the undo stack before applying defaults, making it fully undoable with Cmd+Z.
- **Before/After deduplication**: Comparison toggle lives only in the toolbar; redundant "PROCESSED" status chip removed; toggle button shows dynamic tooltip indicating current state.
- **Histogram legend**: R/G/B/L channel color swatches and 0 / 255 axis labels added below the histogram SVG.
- **Status bar readability**: Pixel dimensions formatted with toLocaleString() + "px" suffix; comparison chip removed from status bar.
- **Film Base section compactness**: Description paragraph replaced by an `(i)` icon button with a tooltip; Sample button now stands alone.
- **Crop UX clarity**: Done and Reset Crop buttons added to the Crop tab; opening the Crop tab auto-shows the crop overlay.
- **Custom presets discoverability**: Built-in / Custom tab bar added to the Presets panel with an empty-state prompt for the Custom tab.
- **Curves auto-balance**: Auto button (wand icon) in the Curves tab stretches levels to histogram data range and corrects per-channel color balance using 0.1% percentile clipping.
- **Custom tooltips**: TooltipPortal component (React portal + event delegation on `[data-tip]`) replaces unreliable native `title` attributes throughout, fixing tooltip display in Tauri's WKWebView.

## Phase 6: Beta Product Finish [complete]
- **Persistent user preferences**: last-used profile, export format/quality, sidebar tab, and pane open/closed state are saved to localStorage and restored on launch.
- **Recent files list**: up to 10 previously imported files shown in the empty state; desktop builds re-open by path, browser builds open the file picker.
- **Automated regression tests**: per-slider pipeline tests (exposure, contrast, black/white point, highlight protection, saturation, temperature/tint, curves), noise reduction and sharpen tests, golden-pixel profile round-trips for all 12 built-in profiles, and store utility tests (preferenceStore, recentFilesStore).

## Phase 7: Color Negative Science Refinement [implemented, with calibration follow-up]
Phase 7 shipped the structural pipeline work and UI refinements, but one planned tonal change was intentionally backed out after real-image testing. The app now runs the hot path in float space, carries per-profile color matrices and tonal-character metadata, and includes synthetic ΔE validation fixtures and expanded crop/curve tooling. The attempted log-space inversion regressed real scans and was removed pending proper calibration against real references.

- **Float32 pipeline**: `imagePipeline.ts` now processes pixels in normalized float space and only quantizes on final write-back.
- **Explicit orange-mask removal**: built-in color stocks now carry optional 3×3 matrices in `FilmProfile`, applied in the worker render/export path.
- **Per-stock tonal latitude**: `FilmProfile` now includes tonal-character metadata for shadow lift, highlight roll-off, and midtone anchoring.
- **Reference validation workflow**: the repo now includes a synthetic reference corpus with ΔE-based validation tests, providing an objective regression gate even though real scanner-measured references are still pending.
- **Curves / loupe / crop UX**: endpoint-aware curves editing, picker loupe, stronger crop handles, additional crop presets, and custom ratio entry have all shipped as part of the Phase 7 UX work.
- **Deferred calibration**: the original log-space inversion idea remains deferred until it is reintroduced with measured real-scan references and profile retuning.

## Phase 8: GPU-Accelerated Rendering (WebGPU, macOS-first) [complete]
The entire render pipeline runs on the CPU inside a Web Worker. For large scans (≥24 MP) the Gaussian blur passes used by sharpen and noise reduction are the dominant bottleneck, and the main per-pixel conversion loop adds further latency. WebGPU compute shaders can parallelise both across GPU cores with no changes to the React layer or the worker message protocol.

- **Capability detection and fallback**: detect `navigator.gpu` inside `imageWorker.ts`. When WebGPU is unavailable (Firefox, older Safari, Windows Chromium without a suitable adapter), fall back transparently to the existing `processImageData()` CPU path. Expose the active path in the Diagnostics panel.
- **GPU blur (sharpen and noise reduction)**: implement a separable Gaussian blur compute shader as the first GPU primitive. Both `applySharpen` and `applyNoiseReduction` in `imagePipeline.ts` use the same double-pass convolution; sharing the shader eliminates redundancy. Expected speedup: 8–20× on a modern Apple Silicon GPU for a 40 MP scan.
- **GPU main conversion loop**: port the single-pass per-pixel loop (`processImageData` lines 306–378) to a compute shader operating on an RGBA float32 texture. Each work-group processes a tile; the LUT arrays (curves) are bound as 1D textures. This covers inversion, film-base compensation, temperature/tint, exposure, black/white point, contrast, highlight protection, saturation, and curve application in a single GPU dispatch instead of sequential CPU passes.
- **GPU histogram reduction**: after the main conversion shader, run a parallel reduction over the output texture to accumulate per-channel histograms without a separate CPU pass. Results are read back asynchronously so the React histogram component updates with no added latency.
- **Export path**: GPU renders to an `OffscreenCanvas` via `canvas.getContext('webgpu')`; `convertToBlob()` on that canvas preserves the existing export interface. No changes to the file-bridge or download logic.
- **Architecture note**: add a `WebGPUPipeline` class alongside `imagePipeline.ts`. `imageWorker.ts` instantiates it on first use, holds a `GPUDevice` reference for the worker's lifetime, and tears it down on the `terminate` message. The worker message protocol (`RenderRequest` / `RenderResult`) is unchanged.

## Phase 9: RAW Import Pipeline (Tauri desktop only)
RAW decoding is intentionally gated behind the Tauri desktop build. The browser worker already returns a `RAW_UNSUPPORTED` error for `.dng`, `.cr3`, `.nef`, `.arw`, `.raf`, and `.rw2` extensions; the desktop path will intercept these before the worker sees them.

- **Rust crate**: use [`rawler`](https://github.com/dnglab/dnglab) (pure Rust, no native deps, supports DNG/CR3/NEF/ARW/RAF/RW2, actively maintained as part of the dnglab project). Add it to `src-tauri/Cargo.toml`. Fallback: `libraw-sys` wraps LibRaw (C++) for maximum format coverage if rawler proves incomplete for a given camera model.
- **Tauri command**: expose a `decode_raw(path: String) → RawDecodeResult { width, height, data: Vec<u8>, color_space: String, bits_per_sample: u16 }` command in `src-tauri/src/lib.rs`. The command demosaics to a 16-bit RGB raster, normalises to 8-bit, and returns the flat buffer. White balance metadata from the RAW header is forwarded so it can optionally pre-seed the temperature/tint sliders.
- **Worker integration**: `imageWorker.ts` detects Tauri (`window.__TAURI__`), calls the Tauri command for RAW files via `fileBridge.ts`, and converts the returned buffer to an `OffscreenCanvas` using the same path as the TIFF raster. The preview pyramid, render, and export pipeline are unchanged — the rest of the app does not know whether the source was a RAW or a TIFF.
- **Colour integrity**: raw sensor data is linear-light. Ensure the Tauri command applies the camera's daylight matrix (from the RAW metadata) before handing off to the JS pipeline, so film profile adjustments start from a neutralised, perceptually correct colour space rather than raw Bayer primaries.
- **Browser graceful degradation**: keep the existing error message and add a "requires desktop app" note in the UI when a RAW file is dropped in the browser build.

## Phase 10: Pro Workflow
The single-document model is the right constraint for beta, but serious film photographers work with rolls, not individual frames. This phase lifts that constraint and adds the colour-management plumbing needed for print-accurate output.

### Multi-document tabs
The app currently holds one `WorkspaceDocument` in `App.tsx` state. The tab model stores an ordered array of documents and an `activeDocumentId`, keeping the existing single-document render path intact for the active tab.

- **Document manager**: replace the single `doc` state with `docs: WorkspaceDocument[]` + `activeDocumentId`. The worker already identifies work by `documentId`; the only change is that multiple documents can coexist in worker memory simultaneously.
- **Tab bar UI**: a horizontal strip above the viewport shows open files (filename + thumbnail). Tabs are reorderable via drag. Closing a tab prompts to save unsaved changes.
- **Memory budget**: the worker enforces a per-document cap on cached preview levels (e.g. the two highest pyramid levels are evicted from inactive tabs and re-decoded on demand). This keeps memory reasonable for a 20-frame roll of 40 MP scans.
- **Cross-tab compare**: a split-view mode shows two tabs side by side at a user-chosen zoom, synchronised pan, so different conversion settings or different frames can be evaluated together.
- **Copy settings across tabs**: a "Paste settings to all tabs" command (or a selectable subset of parameters) propagates `ConversionSettings` from the active tab to every other open document, making it easy to match colour across a roll.

### Batch processing
Applying a consistent look to a full roll is the most time-consuming manual task. Batch mode runs the full render-and-export pipeline unattended.

- **Batch queue UI**: a modal lists a set of files (added via the existing native file dialog or drag-and-drop). Each row shows a thumbnail, filename, and status (queued / processing / done / error).
- **Settings source**: each batch item inherits the current active document's `ConversionSettings` and `FilmProfile`, with an optional per-item override if a film-base sample was already saved for that file.
- **Worker queue**: `imageWorkerClient.ts` gains a `batchExport(items)` method that serialises decode→render→export for each item, reporting progress via the existing callback pattern. One item processes at a time to avoid GPU/CPU contention.
- **Output naming**: configurable filename template (e.g. `{original}_darkslide.jpg`) with sequence numbering, written to a user-chosen output folder via the Tauri `fs` plugin (browser: one-at-a-time download fallback).
- **Error resilience**: failed items are logged with the structured error format from the Diagnostics panel (Phase 6) and do not abort the rest of the queue.

### ICC color management (macOS-first, P3 Retina XDR priority)
The current pipeline renders and exports in uncalibrated sRGB. On MacBook Pro and Pro Display XDR panels — which cover the full Display P3 gamut — this means saturated film colours (Ektar reds, Velvia greens, Kodachrome blues) are silently clipped before they ever reach the screen. The first target is making the viewport and export fully P3-aware on macOS; print workflows follow later.

- **P3 canvas rendering**: switch the preview `<canvas>` to a `colorSpace: 'display-p3'` 2D context (supported in Safari/WebKit and Chrome 111+, both available in the Tauri WKWebView). The worker produces float32 RGBA in the Display P3 primaries; the canvas compositor maps to the physical display profile via macOS ColorSync. No changes to the worker message protocol are needed beyond widening the output buffer from Uint8 to Float32.
- **Wide-gamut export**: expose an "Export color space" selector in the Export tab — sRGB (default, maximum compatibility) and Display P3 for images destined for Apple Photos, iOS, or other P3-aware viewers. Embed the correct ICC profile chunk in the JPEG/PNG blob using a minimal JS ICC writer, since `OffscreenCanvas.convertToBlob()` does not attach profiles automatically.
- **Histogram in P3**: the histogram currently bins 0–255 sRGB values. In P3 mode, extend the range to show out-of-sRGB-gamut headroom so users can see what extra colour information the wide-gamut export preserves.
- **Tauri / macOS integration**: on the desktop build, read the connected display's ICC profile path via a small Tauri command (`get_display_profile() → String`) backed by `CGDisplayCopyColorSpace` on macOS. Pass the profile name to the frontend so the Diagnostics panel can report the active display colour space and the Export tab can offer a "Match display profile" option.
- **Fallback for sRGB displays and browser**: detect P3 support via `matchMedia('(color-gamut: p3)')` and fall back to the current sRGB canvas path with no behaviour change. The feature is purely additive.
- **Print soft-proof (deferred within this phase)**: Fogra39/GRACoL soft-proofing is lower priority than display accuracy and can ship as a follow-on once the P3 pipeline is stable.

## Current Implementation Status
- **Implemented**: package cleanup, document model, versioned preset storage, diagnostics, worker-backed decode/render/export, preview pyramids, blob export, before/after toggle, crop overlay, safer film-base sampling, per-channel curves, histogram, undo/redo, keyboard shortcuts, zoom and pan controls, expanded built-in film profiles, custom preset persistence, sharpening and luminance noise reduction controls, Tauri desktop shell scaffold, native desktop file dialogs with browser fallback, settings modal, export tab button, undoable reset, histogram legend, crop UX improvements, custom presets tabs, curves auto-balance, portal-based custom tooltips, persistent user preferences, recent files list, automated regression test suite, float-space pipeline processing, per-stock color matrices, tonal-character metadata, synthetic ΔE validation, picker loupe, advanced crop ratio controls, WebGPU compute pipeline (GPU blur, main conversion loop, histogram reduction, export path, CPU fallback, Diagnostics panel reporting).
- **Next up**: RAW import pipeline (Phase 9), with a smaller follow-up to revisit calibrated density/log inversion using real scanner references.
- **Deferred**: multi-document tabs, batch processing, ICC profiles, session recovery.
- **Planned (post-beta)**: RAW desktop pipeline (Phase 9), multi-document / batch / ICC work (Phase 10), and a calibrated real-reference revisit of the deferred log-inversion experiment.
