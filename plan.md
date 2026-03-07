# DarkSlide Beta Roadmap

## Summary
- Stabilize the prototype into a clean frontend baseline.
- Move decode/render/export work off the React thread.
- Improve negative-conversion fidelity and large-file robustness.
- Prepare the app boundary for Tauri and future RAW support.

## Phase 0: Stabilize the Baseline
- Rename package/app metadata to `darkslide` and keep only dependencies the frontend actually uses.
- Fix product correctness issues: custom preset type resolution, export filename extension, DarkSlide branding, safer film-base sampling, and actionable import errors.
- Keep one document-oriented source of truth for the active file, settings, export options, profile, histogram, and status.

## Phase 1: Worker-Backed Imaging Pipeline
- Decode supported images in a dedicated worker.
- Build preview pyramids for responsive editing.
- Render previews from worker-owned preview levels and export from the full-resolution source.
- Use blob exports instead of data URLs.
- Ignore stale render revisions so rapid edits do not overwrite newer previews.

## Phase 2: Better Conversion Quality
- Use a more explicit pipeline order: orientation, crop, inversion, film-base compensation, white/black point remap, tone protection, curves, and output.
- Add controls for black point, white point, highlight protection, and before/after comparison.
- Keep crop non-destructive and editable via an overlay.

## Phase 3: Tauri and RAW Boundary
- Keep browser support focused on TIFF, JPEG, PNG, and WebP.
- Reserve RAW decoding for the future desktop path behind a stable decode interface.
- Preserve the current frontend contract so desktop-native file adapters can plug in later.

## Phase 4: Beta Product Finish
- Continue with stronger zoom/navigation, recent files, persistent preferences, better diagnostics, and desktop-native save/open flows.
- Add automated regression coverage for import, render, export, and profile behavior.

## Current Implementation Status
- Implemented: package cleanup, document model, versioned preset storage, diagnostics, worker-backed decode/render/export, preview pyramids, blob export, before/after toggle, crop overlay, and safer film-base sampling.
- Deferred: desktop-native file APIs, true RAW decoding, recent files, session recovery, and automated regression tests.
