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

## Phase 4: Editing Polish
- **Zoom and pan viewport**: let users inspect at 100% for sharpness and grain evaluation. Render the appropriate preview pyramid level based on zoom.
- **Better film profiles**: expand the built-in set with more popular stocks (e.g., Portra 160, Gold 200, Superia, CineStill, Delta 3200). Refine mask-tuning parameters against real scans.
- **Per-slider undo**: make undo granularity match individual control changes rather than debounce-grouped batches.
- **Sharpen / grain / noise reduction**: add post-conversion sharpening (unsharp mask or similar), optional grain overlay, and basic luminance noise reduction.

## Phase 5: UI Polish
- **Toolbar clarity**: toolbar icon buttons have tooltips but no visible labels; add labels or a keyboard shortcut reference panel (`?` button). Move "Copy Debug Info" out of the main toolbar into a diagnostics/settings panel.
- **Export flow**: add an "Export" action button directly inside the Export tab so settings and the trigger are co-located; the header button can remain as a shortcut.
- **Reset Adjustments safeguard**: require confirmation (or at minimum an undo-friendly approach) for the reset action to prevent accidental data loss.
- **Before/After deduplication**: consolidate the before/after toggle to one place (toolbar button); remove the redundant "PROCESSED" status chip.
- **Histogram legend**: add channel color swatches (R/G/B/L) and min/max axis markers so the chart is self-explanatory.
- **Status bar readability**: format pixel dimensions with separator (e.g., 4017 × 5048), label the resolution chip clearly, and remove or explain the "SAMPLE BASE" chip.
- **Film Base section compactness**: collapse the description text to a tooltip or `(i)` icon; let the Sample button stand alone so adjustments appear higher without scrolling.
- **Crop UX clarity**: add a visible "Done" / "Reset Crop" affordance inside the Crop tab so the non-destructive workflow is obvious to new users.
- **Custom presets discoverability**: label the custom presets section explicitly (e.g., a "Custom" tab header next to "Built-in") rather than relying solely on the `+` icon.

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
- **Implemented**: package cleanup, document model, versioned preset storage, diagnostics, worker-backed decode/render/export, preview pyramids, blob export, before/after toggle, crop overlay, safer film-base sampling, per-channel curves, histogram, undo/redo, keyboard shortcuts, 7 built-in film profiles, custom preset persistence, Tauri desktop shell scaffold, and native desktop file dialogs with browser fallback.
- **Next up**: zoom/pan, expanded profiles, per-slider undo, sharpen/grain/noise, toolbar/UI polish.
- **Deferred**: multi-document tabs, batch processing, ICC profiles, RAW decoding, session recovery.
