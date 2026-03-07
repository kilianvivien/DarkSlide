# DarkSlide

Film scan negative converter — React 19 + Vite 6 + TypeScript + Tailwind 4.

## Commands
- `npm run dev` — dev server on port 3000
- `npm run build` — production build to dist/
- `npm run lint` — type-check (tsc --noEmit)
- `npm run test` — run tests (vitest)

## Architecture
- **Single-document model**: one active image, state in `WorkspaceDocument` (see `types.ts`).
- **Worker pipeline**: all decode/render/export runs in a Web Worker (`src/utils/imageWorker.ts`), coordinated by `imageWorkerClient.ts`. Never block the React thread with imaging work.
- **Preview pyramids**: generated at decode time (512/1024/2048 + source). Pick the smallest level >= target dimension.
- **Conversion order** (`imagePipeline.ts`): orientation → crop → inversion → film-base compensation → color/bw → temperature/tint → exposure → black/white point → contrast → highlight protection → saturation → curves.
- **Non-destructive editing**: original source preserved in worker memory. Crop stored as normalized 0-1 coordinates.
- **Stale render detection**: `renderRevision` counter prevents race conditions from rapid edits.

## Key Files
- `src/App.tsx` — main component, layout, keyboard shortcuts, render orchestration
- `src/types.ts` — all shared types (WorkspaceDocument, ConversionSettings, FilmProfile, etc.)
- `src/constants.ts` — built-in film profiles, defaults, dimension limits
- `src/utils/imagePipeline.ts` — pixel-level conversion logic
- `src/utils/imageWorker.ts` — Web Worker entry point
- `src/utils/imageWorkerClient.ts` — main-thread worker client
- `src/utils/tiff.ts` — TIFF decoding via utif
- `src/components/` — CropOverlay, CropPane, CurvesControl, Histogram, PresetsPane, Slider

## Conventions
- State lives in React useState/hooks, no external state library.
- Custom presets persist to localStorage (`darkslide_custom_presets_v1`).
- Icons from lucide-react. Animations via motion (Framer fork).
- Supported formats: TIFF, JPEG, PNG, WebP. RAW reserved for future Tauri desktop path.
- Export produces a Blob (not data URL), triggers native download via temporary `<a>` element.

## Roadmap
See `plan.md` for the full beta roadmap. Phases 0-2 are complete. Next: Tauri shell, then editing polish (zoom/pan, more profiles, per-slider undo, sharpen/grain/noise).
