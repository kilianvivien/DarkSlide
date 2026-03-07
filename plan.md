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

## Phase 6: Beta Product Finish
- Persistent user preferences (last-used profile, export settings, pane layout).
- Recent files list for quick re-open.
- Diagnostics panel: structured error reports users can copy for bug filing (move debug tools here).
- Automated regression tests for import, render, export, and profile behavior.

## Post-Beta Horizon
- Multi-document tabs for comparing edits across a roll.
- Batch processing: apply the same profile and settings to multiple scans.
- ICC color management for accurate soft-proofing.
- RAW decoding via desktop-native backend (LibRaw or similar behind the Tauri bridge).

## Current Implementation Status
- **Implemented**: package cleanup, document model, versioned preset storage, diagnostics, worker-backed decode/render/export, preview pyramids, blob export, before/after toggle, crop overlay, safer film-base sampling, per-channel curves, histogram, undo/redo, keyboard shortcuts, zoom and pan controls, expanded built-in film profiles, custom preset persistence, sharpening and luminance noise reduction controls, Tauri desktop shell scaffold, native desktop file dialogs with browser fallback, settings modal, export tab button, undoable reset, histogram legend, crop UX improvements, custom presets tabs, curves auto-balance, and portal-based custom tooltips.
- **Next up**: persistent preferences, recent files, and broader regression coverage.
- **Deferred**: multi-document tabs, batch processing, ICC profiles, RAW decoding, session recovery.
