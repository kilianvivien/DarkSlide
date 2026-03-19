# DarkSlide — Post-Beta Roadmap (Phases 13–16)

## Vision
Position DarkSlide as the best free standalone film negative converter for hobbyist camera scanners on macOS. Compete head-to-head with FilmLab Desktop on ease-of-use and scanning workflow, while offering deeper editing control than SmartConvert — all without subscriptions or Adobe lock-in.

## Guiding Principles
- **Hobbyist-first**: every feature should reduce clicks from scan to shareable image.
- **Tauri/macOS-primary**: desktop experience leads; web follows where feasible.
- **Architecture health front-loaded**: critical stability and maintainability fixes ship first, then weave ongoing cleanup into feature work.
- **Competitive parity with FilmLab 3.5**: auto-crop, flat-field correction, expanded film profiles, and fast batch workflow are table-stakes.

---

## Phase 13: Architecture Health & Stability

The codebase has grown to ~14 K lines across 43 source files. `App.tsx` alone is ~2 975 lines with 35+ `useState` hooks and 18 `useRef`-based callback pointers. This phase pays down the structural debt that would otherwise slow every subsequent feature.

### 13A — App.tsx decomposition

`App.tsx` is the single riskiest file in the project. It mixes render orchestration, file I/O, undo/redo, keyboard/menu handling, tab management, and Tauri IPC into one component. Decompose it into focused modules without changing any user-visible behavior.

- **`useRenderQueue` hook**: extract the 150-line render-queue logic (`schedulePreviewRender`, `drainPreviewRenderQueue`, `scheduleInteractivePreviewRender`, `executePreviewRender`) and its associated refs (`renderQueueRef`, `renderInFlightRef`, `latestRenderRevisionRef`) into a dedicated custom hook. The hook owns the coalescing, stale-check, and interactive-vs-settled logic; App.tsx calls `enqueueRender(settings, priority)` and receives the rendered result via a callback or returned state.
- **`useFileImport` hook**: extract `importFile` (~350 lines) covering RAW detection, session guards, stale-check, tab creation, and error recovery. Split internally into `importRawFile` and `importRasterFile` with shared setup/teardown. Returns `{ importFile, isImporting, importError }`.
- **`useKeyboardShortcuts` hook**: extract all `useEffect`-based keyboard and Tauri menu event listeners into a single hook that receives a handler map. Eliminate the `handleDownloadRef` / `handleResetRef` / `handleOpenInEditorRef` / `handleCopyDebugInfoRef` ref-pointer pattern by using a `useEvent`-style stable-callback wrapper.
- **`useDocumentTabs` hook**: extract the multi-tab state (`docs`, `activeDocumentId`, tab open/close/reorder/eviction, dirty-state tracking) into a hook that exposes `{ docs, activeDoc, openTab, closeTab, reorderTabs, setActiveTab }`.
- **Target**: `App.tsx` drops below 1 200 lines. Each extracted hook gets its own file under `src/hooks/` and is individually testable.

### 13B — Worker protocol type safety

The `WorkerRequest` and `WorkerResponse` discriminated unions are currently defined independently in `imageWorker.ts` and `imageWorkerClient.ts`, kept in sync by hand. A message-type mismatch causes silent data corruption rather than a compile error.

- **Shared protocol module**: create `src/utils/workerProtocol.ts` exporting all request/response discriminated unions, payload interfaces, and the `WorkerMessage` envelope type. Both `imageWorker.ts` and `imageWorkerClient.ts` import from this single source.
- **`RawDecodeResult` deduplication**: the interface is defined independently in `App.tsx` and `batchProcessor.ts`. Move it to `types.ts` and import in both places.
- **Transfer list for pixel buffers**: `imageWorker.ts` `reply()` and `imageWorkerClient.ts` `worker.postMessage()` currently use structured clone for `ImageData` buffers. Add explicit `transfer: [imageData.data.buffer]` to both directions. For a 2048×2048 preview this eliminates a 16 MB copy per render; for a 40 MP export it eliminates ~160 MB.

### 13C — Error boundaries & resilience

- **React error boundaries**: wrap Sidebar, PresetsPane, each modal (Settings, Batch, ContactSheet), and the main viewport in `<ErrorBoundary>` components that catch rendering exceptions and show a "something went wrong — click to retry" fallback instead of crashing the entire app.
- **Browser confirm-on-close**: `fileBridge.ts` `confirmDiscard` currently returns `true` immediately in the browser build. Add a `window.confirm()` fallback so browser users are warned before losing unsaved edits.
- **Export error recovery**: when an export fails mid-way, clear the document's error state after the error toast dismisses so the user can retry without re-importing.
- **Batch crash resilience**: if the worker crashes mid-batch, mark the current item as `error` with a descriptive message and continue to the next item instead of leaving the queue stuck at `processing`.
- **CSP hardening**: set a restrictive Content Security Policy in `tauri.conf.json` (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'`) with only the exceptions needed for WebGPU and blob URLs.

### 13D — Diagnostics & dead code cleanup

- **Buffer diagnostics writes**: `appendDiagnostic` currently does two synchronous `localStorage` round-trips per call (read + write), running 10–20×/s during slider drags. Buffer entries in memory and flush to localStorage on `requestIdleCallback` or at 2 s intervals.
- **Remove dead `isFullscreen` state**: `App.tsx` declares `isFullscreen` but nothing ever sets it to `true`. Fullscreen is handled natively by Tauri. Remove the state and the conditional `fixed inset-0 z-50` styling.
- **Fix success-as-error**: `handleCopyDebugInfo` calls `setError('Debug info copied to clipboard.')` — using the error state for a success message. Introduce a `showTransientNotice(message, type: 'success' | 'error')` pattern or reuse the existing toast with a distinct style.
- **Deduplicate `clamp`**: `clamp` is reimplemented in 6 files. Export from `imagePipeline.ts` (or a shared `src/utils/math.ts`) and import everywhere.
- **Deduplicate `rgbToRgba`**: identical implementations in `App.tsx` and `batchProcessor.ts`. Extract to a shared utility.
- **`pushHistoryEntry` optimization**: replace `JSON.stringify` equality check with a shallow-compare on scalar fields + array-length check for the common case. Fall back to `JSON.stringify` only when the shallow check is inconclusive.

### 13E — Accessibility baseline

- **`aria-label` on icon-only buttons**: all toolbar buttons (`Undo`, `Redo`, `Rotate`, `Compare`, `Crop`, `Open in Editor`, `Panel toggles`) currently rely on `data-tip` for tooltips, which screen readers ignore. Add `aria-label` matching the tooltip text.
- **Label-input association**: the `Slider` component renders a visible label and an `<input type="range">` as siblings but they are not linked via `htmlFor`/`id`. Add matching `id` and `htmlFor` attributes.
- **Focus trapping in modals**: `SettingsModal`, `BatchModal`, and `ContactSheetModal` do not trap keyboard focus. Add a focus-trap (either a lightweight library or a manual `keydown` handler on Tab) so tab navigation stays within the modal while it is open.

---

## Phase 14: Smart Scanning Features

The features in this phase target the camera scanning workflow specifically — the setup where a photographer uses a digital camera + macro lens + light source to photograph film negatives. This is the dominant hobbyist scanning method and where FilmLab, SmartConvert, and Chemvert focus their efforts.

### 14A — Auto-crop & frame detection

Camera scans typically include the film rebate (edge markings), sprocket holes (35mm), and light-source bleed around the frame. Manually cropping every frame is the #1 tedium complaint across scanning forums. FilmLab 3.3 added this; SmartConvert has had it from the start.

- **Edge detection algorithm**: implement a border-detection pass that runs at import time on the decode preview (1024 px level). The algorithm:
  1. Convert to grayscale and compute a horizontal and vertical luminance gradient (Sobel or simple first-difference).
  2. Project gradient magnitude onto the X and Y axes (sum columns / sum rows) to find the four strongest edges.
  3. Refine edge positions to sub-pixel accuracy using a parabolic fit on the gradient peaks.
  4. Detect rotation (skew) from the angle between opposing edges and apply deskew correction.
  5. Return a `DetectedFrame { top, left, bottom, right, angle }` in normalized 0–1 coordinates.
- **Confidence threshold**: if the detected frame covers < 20% or > 98% of the image area, or if gradient peaks are ambiguous, skip auto-crop and leave the image uncropped. Show a subtle "auto-crop skipped — manual crop available" notice.
- **Sprocket hole exclusion (35mm)**: if the detected frame's aspect ratio is close to 3:2 and periodic high-contrast features are found along one long edge, classify as 35mm with sprocket holes and tighten the crop inward past them.
- **User override**: auto-crop sets the initial crop rectangle but does not lock it. The user can adjust or reset via the existing Crop tab. A "Re-detect frame" button re-runs detection if the user has changed rotation.
- **Batch integration**: auto-crop runs automatically during batch import. Each batch item stores its detected frame independently.
- **Performance target**: detection should complete in < 50 ms on the 1024 px preview level so it does not add perceptible delay to import.

### 14B — Flat-field correction

Camera scanning setups suffer from uneven illumination — the light source may have a hot spot, the lens may vignette, or the film holder may cast subtle shadows. Flat-field correction divides each scan by a reference frame (a photo of the light source with no film) to normalize brightness across the field. SmartConvert and Chemvert include this; it is conspicuously absent from FilmLab and NLP.

- **Reference capture flow**: a new "Calibration" section in Settings (or a dedicated first-run wizard) lets the user import a flat-field reference image — a photo of their light source taken with the same camera/lens/distance as their scans, with no film in the holder.
- **Reference processing**: the reference image is decoded, downsampled to 1024×1024, converted to grayscale, and normalized so the brightest pixel = 1.0. The result is stored as a persistent `Float32Array` in `localStorage` (compressed via a simple RLE or delta encoding to stay under the 5 MB localStorage limit) and also cached in worker memory.
- **Per-scanner profiles**: allow multiple named flat-field profiles (e.g., "Macro 60mm f/8", "Valoi easy35") so users with different setups can switch without re-importing.
- **Correction application**: during the render pipeline, after decode and before inversion, divide each pixel's RGB channels by the corresponding flat-field value (bilinearly interpolated from the 1024×1024 reference to the scan's pixel coordinates). Pixels where the reference value is < 0.05 (near-black edges) are clamped to avoid division-by-zero artifacts.
- **Pipeline integration**: add the flat-field correction step to both the CPU path (`imagePipeline.ts`) and the GPU path (`WebGPUPipeline.ts`). The reference texture is uploaded to the GPU as a single-channel `r32float` texture and sampled in the main conversion shader.
- **Bypass toggle**: a "Flat-field correction" on/off toggle in the Adjust tab (visible only when a reference is loaded) lets the user compare corrected vs. uncorrected output. The toggle state persists in `ConversionSettings`.
- **Visual feedback**: when flat-field correction is active, show a small icon/badge in the status bar ("FF" or a grid icon) so the user always knows it is applied.

### 14C — Scanning flare correction

When scanning with a camera, ambient light can reflect off the negative's shiny base and add a low-contrast haze — "scanning flare." FilmLab 3.4 introduced this as a standout feature. The correction estimates the flare contribution from the darkest areas of the negative (which should be pure film base + flare) and subtracts it.

- **Automatic flare estimation**: after decode and flat-field correction (if active), sample the darkest 0.5% of pixels in each channel. The per-channel floor values represent the combined film base density + scanning flare. Subtract this floor from all pixels before inversion, effectively lifting the black point of the raw scan.
- **Relationship to film-base picker**: scanning flare correction is complementary to film-base compensation. Film-base compensation neutralizes the orange mask color cast; flare correction removes the additive light pollution. Both can be active simultaneously. The flare floor is subtracted first (pre-inversion), then film-base compensation adjusts the color balance (post-inversion).
- **Strength slider**: a "Flare correction" slider (0–100%, default 50%) in the Adjust tab controls how much of the estimated floor is subtracted. At 0% no correction is applied. At 100% the full estimated floor is removed. This lets users dial back the correction if it clips shadow detail on dense negatives.
- **Per-image or per-roll**: in single-image mode, flare estimation runs per image. In batch mode, offer a "Use first frame's flare estimate for all" option for rolls scanned under consistent lighting.

### 14D — Light source profiles

Different scanning light sources have different spectral characteristics that affect how the orange mask is rendered. FilmLab 3.5 expanded to support 60+ film/light combinations; SmartConvert adapts per-image. DarkSlide can offer a middle ground: a small set of light-source profiles that adjust the inversion curve.

- **Light source model**: create a `LightSourceProfile` type with fields: `name: string`, `colorTemperature: number` (approximate CCT in Kelvin), `spectralBias: [number, number, number]` (relative R/G/B weights representing the source's spectral output), and `flareCharacteristic: 'low' | 'medium' | 'high'` (affects default flare correction strength).
- **Built-in profiles**: ship 6–8 common light sources:
  - Generic daylight LED panel (~5500 K)
  - CineStill CS-LITE (~5000 K, warm)
  - Skier Sunray Copy Box 3 (~5600 K)
  - VALOI easy35 / Pluto LED (~5000 K)
  - Kaiser Slimlite Plano (~5300 K)
  - Lomography DigitaLIZA+ LED (~6000 K, cool)
  - iPad/tablet backlight (~6500 K, very cool, high flare)
  - Custom (user enters CCT + R/G/B bias)
- **Application**: the light-source spectral bias is factored into the film-base compensation step. When a light source profile is selected, the inversion pre-multiplies the raw scan by the inverse of the spectral bias, effectively normalizing the scan as if it were taken under a spectrally flat source. This reduces the need for aggressive per-channel white-balance correction after inversion.
- **UI**: a "Light source" dropdown in the Adjust tab, below the Film Profile selector. Defaults to "Auto" (no spectral correction). Persists in user preferences.
- **Interaction with film profiles**: the light-source profile and the film profile are independent axes. A Portra 400 negative scanned with a warm LED and the same negative scanned with a cool iPad require different spectral compensation but the same film-profile curve. Keeping them separate avoids the combinatorial explosion that forces FilmLab to maintain 60+ profile combinations.

### 14E — Expanded film stock profiles

The current 12 built-in profiles cover the most popular stocks but miss many that hobbyist scanners regularly shoot. FilmLab 3.5 has 60+; SilverFast has 120+. Expand the built-in library to ~30 profiles, organized by manufacturer.

- **New color profiles** (18 additions):
  - Kodak: UltraMax 400, ColorPlus 200, Gold 100, Portra 800, Ektar 25 (discontinued but commonly found), Pro Image 100, Vision3 250D, Vision3 500T
  - Fuji: C200/C400, Superia X-TRA 400 (newer formulation), Pro 160NS, Velvia 50 (slide, inverted differently), Provia 100F (slide)
  - Agfa: Vista 200, APX 100
  - CineStill: 50D, 400D
  - Lomography: Color Negative 400, 800
- **New B&W profiles** (4 additions):
  - Kodak T-Max 100, T-Max 400
  - Ilford FP4+, Pan F+ 50
- **Profile structure**: each new profile gets the same `FilmProfile` fields as existing ones — `colorMatrix` (3×3), `tonalCharacter` (shadow lift, highlight rolloff, midtone anchor), `maskCompensation` (highlight/black-point bias). Initial values are derived from published characteristic curves (Kodak/Fuji datasheets) and tuned against sample scans.
- **Slide film handling**: slide (positive) film does not need inversion. Add a `filmType: 'negative' | 'slide'` field to `FilmProfile`. When `filmType === 'slide'`, skip the inversion step and apply only color correction, curves, and spatial filters. This lets DarkSlide double as a basic slide scanner workflow tool.
- **Profile categories in UI**: update the presets pane to group profiles by manufacturer (Kodak / Fuji / Ilford / CineStill / Lomography / Other) instead of the current flat list. Each group is collapsible.

---

## Phase 15: Conversion Quality & Minilab Emulation

This phase focuses on output quality — making DarkSlide's conversions look as good as or better than competing tools, particularly for users who care about "the look" of traditional lab prints.

### 15A — Minilab emulation profiles (Frontier / Noritsu)

The #1 feature request across film photography forums is "give me Frontier/Noritsu colors." Negative Lab Pro's killer feature is LUT-based minilab emulation. DarkSlide can offer a lighter-weight version via carefully tuned film profiles that capture the tonal and color signature of these lab scanners.

- **What makes minilab scans distinctive**: Fuji Frontier and Noritsu scanners apply specific tone curves, color channel crossover corrections, and saturation boosts that produce the "lab look" — slightly lifted shadows, warm midtones, compressed highlights, and characteristic color rendering (Frontier leans warmer/more saturated; Noritsu is cooler/more neutral).
- **Implementation approach — "Lab Style" profiles**: rather than reverse-engineering proprietary LUTs (legally and technically complex), create a set of special `FilmProfile` entries that encode the lab scanner's tonal and color signature as enhanced `tonalCharacter` + `colorMatrix` + a new optional `toneCurve: CurvePoint[]` field applied post-inversion. This is not a pixel-accurate emulation but a perceptual approximation.
- **Profile set**:
  - "Lab: Frontier Classic" — warm, saturated, lifted blacks, gentle highlight rolloff. The Frontier SP-3000 look.
  - "Lab: Frontier Modern" — slightly less saturated, cleaner highlights. Frontier LP-5000/DX100 era.
  - "Lab: Noritsu" — cooler, more neutral, linear midtones, slightly harder contrast. HS-1800 look.
  - "Lab: Neutral" — minimal tonal character, flat transfer curve. For users who want to do all grading themselves.
- **Per-film-stock variants**: the lab profiles compound with the selected film profile. Selecting "Portra 400" + "Lab: Frontier Classic" applies Portra's mask/matrix first, then Frontier's tonal character. This avoids the combinatorial explosion while still letting users mix and match.
- **Tone curve field**: add an optional `toneCurve: CurvePoint[]` to `FilmProfile`. When present, this curve is applied after the standard conversion pipeline but before the user's manual curves. It represents the lab scanner's transfer function. The existing `buildFusedLuts` function is extended to composite the profile's tone curve with the user's curves into the fused LUT, adding no per-pixel cost.
- **A/B testing workflow**: users can toggle between lab profiles to compare looks. The existing before/after comparison mode shows original-vs-processed; add a "Profile A / Profile B" split comparison that renders the same image with two different profile+lab combinations side by side.
- **UI**: lab profiles appear as a separate "Lab Style" dropdown or toggle group below the Film Profile selector. Default is "None" (current behavior). When a lab style is active, a badge appears in the status bar.

### 15B — Improved auto-exposure and color balance

SmartConvert and FilmLab both run per-image auto-analysis that sets initial exposure and color balance. DarkSlide currently relies on the film-base picker and manual sliders. Adding auto-analysis reduces the click count for the common case.

- **Auto-exposure**: at import time, after inversion and film-base compensation, compute the luminance histogram of the converted preview. Find the 1st and 99th percentile luminance values. Set `exposure` to center the midpoint of that range at 50% luminance, and set `blackPoint`/`whitePoint` to place the 1st/99th percentiles at 2% and 98% output. This is a one-shot initialization, not a continuous auto-mode.
- **Auto color balance**: after auto-exposure, compute per-channel means of the midtone range (25th–75th percentile). If any channel's mean deviates from the luminance mean by more than a threshold, adjust `temperature` and `tint` to neutralize the cast. This corrects the residual color bias that film-base compensation does not fully remove.
- **"Auto" button**: add an "Auto" button (wand icon) at the top of the Adjust tab that runs both auto-exposure and auto-color-balance in one click. The adjustments are applied as normal settings changes and are fully undoable. If the user has already made manual adjustments, the Auto button warns before overwriting.
- **Per-roll consistency**: in batch mode, offer a "Use auto settings from first frame" option. The first frame's auto-exposure/balance results are computed and then applied as fixed offsets to all subsequent frames, ensuring consistency across the roll while still accounting for the roll's overall characteristics.
- **Comparison with current auto-balance**: the existing "Curves auto-balance" (wand icon in Curves tab) stretches levels per-channel. The new auto-exposure/balance operates on the main exposure/WB sliders and runs earlier in the pipeline. Both can coexist — the curves auto-balance is a fine-tuning step after the main auto has set a good starting point.

### 15C — Split-screen before/after comparison

The current before/after toggle shows the full image in either processed or original mode. A split-screen comparison (like Lightroom's side-by-side or split-view) is more useful for evaluating edits because the user can see both states simultaneously.

- **Split divider mode**: a vertical (or horizontal, user-toggleable) divider splits the viewport. The left/top side shows the processed image; the right/bottom side shows the original scan (or a different profile — see 15A "Profile A/B"). The divider is draggable.
- **Side-by-side mode**: two viewports at half width, each rendering the full image. Zoom and pan are synchronized between both halves.
- **Toggle cycle**: the existing toolbar comparison button cycles through: Off → Toggle (current) → Split → Side-by-side → Off. Or use a dropdown flyout from the comparison button.
- **Implementation**: the split modes render two `<canvas>` elements (or two regions of one canvas) fed by two render results. The "original" result is already produced by the existing `comparisonMode: 'original'` path. For "Profile A/B", the second render uses a different `FilmProfile` + lab style applied to the same source.

### 15D — Highlight recovery improvements

Highlight clipping during inversion is the most consistent quality complaint across all tools (especially SmartConvert). DarkSlide already has highlight protection, but it can be improved.

- **Exposure-aware highlight recovery**: the current `highlightProtection` slider applies a gentle rolloff to the top end of the tone curve. Enhance this by making the rolloff strength adaptive to the image's highlight density — images with dense highlights (lots of near-white areas in the negative, meaning lots of shadow detail in the positive) get a stronger rolloff, while images with thin highlights (bright scenes) get a lighter touch.
- **Per-channel highlight recovery**: currently highlight protection operates on luminance. Extend it to operate per-channel, so a blown red channel (common with tungsten-lit scenes on daylight film) can be recovered independently without affecting green/blue.
- **"Recover highlights" button**: a one-click button that analyzes the current render's histogram, detects any clipped channels, and automatically adjusts `highlightProtection` and `whitePoint` to bring clipped data back into range. Undoable.
- **Visual clipping indicator**: overlay optional "zebra stripes" or colored highlights on clipped areas in the viewport. Red overlay for clipped highlights (R/G/B > 253), blue overlay for clipped shadows (R/G/B < 2). Toggle via a toolbar button or keyboard shortcut. This gives immediate feedback that no histogram alone can provide.

### 15E — Shadow recovery & tonal control

- **Shadow recovery slider**: a new slider in the Adjust tab that selectively lifts shadow detail without affecting midtones or highlights. Implementation: apply a soft toe curve to the lower 25% of the tonal range, controlled by the slider. This is the inverse of highlight protection.
- **Midtone contrast slider**: a new slider that adjusts contrast in the midtone range only (an S-curve centered at 50% luminance), leaving shadows and highlights untouched. This is the "punch" control that SmartConvert's users wish it had.
- **Pipeline placement**: shadow recovery and midtone contrast are applied after the main exposure/contrast/black/white-point block and before curves, so they interact predictably with the existing controls.

---

## Phase 16: Scanning Workflow & Productivity

This phase focuses on the end-to-end scanning session workflow — from capturing scans to exporting finished images. The goal is to make DarkSlide the fastest path from "I just scanned a roll" to "my images are exported and organized."

### 16A — Hot-folder / watch-folder (Tauri desktop)

SmartConvert's hot-folder feature is a major productivity win for tethered camera scanning. The user sets up their camera, starts shooting, and SmartConvert automatically picks up each new file as it is saved. DarkSlide should match this.

- **Folder watcher**: a new Tauri command (`watch_folder(path: String) → ()`) uses `notify` (Rust file-system notification crate) to watch a directory for new files matching supported extensions (TIFF, JPEG, PNG, DNG, CR3, NEF, ARW, RAF, RW2). When a new file appears, emit a Tauri event (`darkslide://new-scan`) with the file path.
- **Auto-import pipeline**: the frontend listens for `darkslide://new-scan` events and automatically runs the import flow for each new file — decode, auto-crop (Phase 14A), flat-field correction (if configured), flare correction (if enabled), and auto-exposure/balance (Phase 15B). The imported image appears as a new tab (or appends to the batch queue).
- **Session mode UI**: a "Scanning Session" panel (accessible from the toolbar or menu) shows: the watched folder path, a "Start Watching" / "Stop Watching" toggle, a live count of imported frames, and a thumbnail strip of the session's scans. Clicking a thumbnail switches to that tab.
- **Auto-export option**: optionally, each imported frame can be auto-exported immediately after auto-processing, using the current export settings. This enables a fully hands-free "scan → convert → save" pipeline.
- **Duplicate detection**: if a file with the same name is re-saved (common when the user re-shoots a frame), detect the duplicate and either skip it or offer to replace the existing tab.
- **Debounce**: wait until a file's size stops changing (poll at 500 ms intervals) before attempting import, to avoid reading a partially-written file.

### 16B — Roll-based workflow

Film photographers think in rolls, not individual files. Filmvert and Grain2Pixel both offer roll-based workflows where settings from one frame can be applied across the roll. DarkSlide's multi-tab model is a foundation but does not yet have the "roll" concept.

- **Roll grouping**: add a `rollId: string | null` field to `WorkspaceDocument`. When multiple files are imported from the same folder (or during a scanning session), they are automatically assigned the same `rollId`. The tab bar visually groups tabs by roll (subtle separator line or color-coded dots).
- **Roll-wide settings sync**: a "Sync to roll" button applies the active tab's `ConversionSettings` and `FilmProfile` to all tabs in the same roll. This is the existing "Paste settings to all tabs" feature, but scoped to the roll rather than all open tabs.
- **Roll navigator**: a filmstrip-style panel below the viewport (togglable) shows thumbnails of all frames in the current roll. Click to navigate; the active frame is highlighted. Arrow keys move between frames. This replaces the need to click individual tabs for sequential editing.
- **Roll-wide film base**: when the user samples the film base on one frame, offer to apply the same film-base values to all frames in the roll. Film base color is consistent within a roll (same emulsion batch, same processing), so this saves N-1 manual samples.
- **Roll metadata**: optional user-editable fields on a roll: film stock name, camera, date shot, notes. Exported in sidecar JSON and optionally embedded in EXIF `ImageDescription`.

### 16C — Quick export presets

Power users want to export to multiple targets (web JPEG, archive TIFF, Instagram square) without reconfiguring export settings each time. Currently DarkSlide has one export configuration.

- **Export preset model**: a `QuickExportPreset` type with fields: `name`, `format` (JPEG/PNG/WebP/TIFF), `quality`, `colorSpace`, `embedMetadata`, `maxDimension` (optional resize), `suffix` (appended to filename, e.g., `_web`, `_archive`).
- **Built-in presets**:
  - "Web (JPEG, sRGB, 2048px, q85)" — default for sharing online.
  - "Archive (TIFF, 16-bit, full res, Adobe RGB)" — lossless preservation.
  - "Instagram (JPEG, sRGB, 1080px, q90)" — square crop pre-applied.
  - "Print (TIFF, full res, Adobe RGB)" — for lab printing.
- **Custom presets**: users can create and name their own export presets. Stored in `localStorage` alongside conversion presets.
- **One-click export**: each preset gets a button in the Export tab. Clicking it runs the export immediately with that preset's settings — no further configuration needed.
- **Multi-export**: a "Export all presets" button runs all enabled presets in sequence, producing multiple output files per image. Useful for users who want both a web JPEG and an archive TIFF.
- **Batch integration**: in batch mode, the user selects one or more export presets. Each batch item is exported once per preset.

### 16D — Sidecar settings files

Edit settings currently live only in memory (and in undo history). There is no way to save, reload, or share the exact settings used for a conversion. This is important for reproducibility and for workflows where the user wants to revisit an old scan.

- **`.darkslide-settings` sidecar files**: when exporting, optionally save a JSON sidecar file alongside the exported image containing: the full `ConversionSettings`, the `FilmProfile` name (built-in) or full profile (custom), the flat-field profile name, the light-source profile, and the auto-crop coordinates. The sidecar filename matches the export filename with a `.darkslide-settings` extension.
- **Auto-load on re-import**: when importing an image, check if a matching sidecar file exists in the same directory. If found, offer to restore the saved settings. This enables a non-destructive "edit later" workflow.
- **Settings in EXIF**: as an alternative to sidecar files, embed a compact JSON string in the JPEG/TIFF `UserComment` EXIF field. This keeps the settings with the image even if the sidecar file is lost. Limited to ~64 KB (EXIF field limit), which is ample for serialized settings.
- **Export toggle**: "Save settings sidecar" checkbox in the Export tab (default off). Separate from the existing "Embed metadata" toggle.

### 16E — Tauri auto-update

- **`tauri-plugin-updater` integration**: configure the Tauri updater plugin to check for updates on launch (and on a 24-hour interval). Use GitHub Releases as the update source. Show a non-intrusive notification bar at the top of the window: "DarkSlide X.Y.Z is available — [Update now] [Later]".
- **Release notes display**: fetch the release notes from the GitHub release body and display them in the update notification, so users know what changed before updating.
- **Update channel**: support a `beta` and `stable` channel. Beta users get more frequent updates; stable users only get tested releases. Channel selection in Settings > General.

---

## Competitive Position After Phase 16

| Capability | DarkSlide | FilmLab 3.5 | SmartConvert | NLP |
|---|---|---|---|---|
| Standalone (no host app) | Yes | Yes | Yes | No (Lightroom) |
| Free | Yes | No ($60–200) | No (€199) | No ($99 + LR) |
| Auto-crop / frame detection | Phase 14 | Yes | Yes | No |
| Flat-field correction | Phase 14 | No | Yes | No |
| Scanning flare correction | Phase 14 | Yes | No | No |
| Light source profiles | Phase 14 | Yes (60+) | No (adaptive) | No |
| Minilab emulation | Phase 15 (profiles) | No | No | Yes (LUT-based) |
| Auto-exposure/color | Phase 15 | Yes | Yes | Yes |
| Split before/after | Phase 15 | No | No | Yes (Lightroom) |
| Hot-folder / tethered | Phase 16 | No | Yes | No |
| Roll-based workflow | Phase 16 | Folder-based | Folder-based | No |
| Quick export presets | Phase 16 | No | Yes (2 folders) | No (Lightroom) |
| Sidecar settings | Phase 16 | No | No | XMP (Lightroom) |
| GPU-accelerated pipeline | Yes (WebGPU) | Yes (GPU) | Unknown | No (CPU) |
| WebGPU compute shaders | Yes | No | No | No |
| Per-channel curves | Yes | No | No | Yes (Lightroom) |
| RAW import (desktop) | Yes | Yes | Yes (via RAW) | Yes (Lightroom) |
| Slide film support | Phase 14E | Yes | No | Yes |
| Custom presets export | Yes | No | No | No |
| Cross-platform (Mac/Win/Linux/Web) | Yes | Yes (no web) | Yes (no web/Linux) | Mac/Win only |
| Batch processing | Yes | Yes | Yes | Yes |
| Contact sheet | Yes | No | No | No |
| Color management (P3/AdobeRGB) | Yes | Yes | No | Yes (Lightroom) |
