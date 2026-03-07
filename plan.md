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

## Phase 3: Tauri Desktop Shell
- Scaffold the Tauri project around the existing Vite frontend.
- Implement native file open/save dialogs replacing browser download-based export.
- Keep browser deployment working alongside the desktop build (shared codebase).
- Reserve RAW decoding for a later phase behind the existing stable decode interface.

## Phase 4: Editing Polish
- **Zoom and pan viewport**: let users inspect at 100% for sharpness and grain evaluation. Render the appropriate preview pyramid level based on zoom.
- **Better film profiles**: expand the built-in set with more popular stocks (e.g., Portra 160, Gold 200, Superia, CineStill, Delta 3200). Refine mask-tuning parameters against real scans.
- **Per-slider undo**: make undo granularity match individual control changes rather than debounce-grouped batches.
- **Sharpen / grain / noise reduction**: add post-conversion sharpening (unsharp mask or similar), optional grain overlay, and basic luminance noise reduction.

## Phase 5: Beta Product Finish
- Persistent user preferences (last-used profile, export settings, pane layout).
- Recent files list for quick re-open.
- Diagnostics polish: structured error reports users can copy for bug filing.
- Automated regression tests for import, render, export, and profile behavior.

## Post-Beta Horizon
- Multi-document tabs for comparing edits across a roll.
- Batch processing: apply the same profile and settings to multiple scans.
- ICC color management for accurate soft-proofing.
- RAW decoding via desktop-native backend (LibRaw or similar behind the Tauri bridge).

## Current Implementation Status
- **Implemented**: package cleanup, document model, versioned preset storage, diagnostics, worker-backed decode/render/export, preview pyramids, blob export, before/after toggle, crop overlay, safer film-base sampling, per-channel curves, histogram, undo/redo, keyboard shortcuts, 7 built-in film profiles, custom preset persistence.
- **Next up**: Tauri scaffold, native file dialogs, zoom/pan, expanded profiles, per-slider undo, sharpen/grain/noise.
- **Deferred**: multi-document tabs, batch processing, ICC profiles, RAW decoding, session recovery.
