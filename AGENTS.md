# AGENTS.md

## Project
DarkSlide is a film scan negative converter built with React 19, Vite 6, TypeScript, and Tailwind 4.

## Primary Commands
- `npm run dev` — start the dev server on port 3000
- `npm run build` — create the production build in `dist/`
- `npm run lint` — run TypeScript type-checking with `tsc --noEmit`
- `npm run test` — run the Vitest test suite

## Repository Shape
- `src/App.tsx` — main application shell, layout, shortcuts, and render orchestration
- `src/types.ts` — shared domain types including `WorkspaceDocument`, conversion settings, and film profiles
- `src/constants.ts` — defaults, built-in profiles, and dimension limits
- `src/components/` — UI controls such as crop, histogram, sidebar, presets, curves, and sliders
- `src/hooks/` — stateful React hooks for history and custom presets
- `src/utils/imagePipeline.ts` — pixel-processing pipeline
- `src/utils/imageWorker.ts` — Web Worker entry point for decode, render, and export
- `src/utils/imageWorkerClient.ts` — main-thread worker bridge
- `src/utils/tiff.ts` — TIFF decoding support via `utif`
- `src/utils/presetStore.ts` — persistence for presets

## Architecture Rules
- Preserve the single-document model: one active image, represented by `WorkspaceDocument`.
- Keep imaging work off the React thread. Decode, render, and export belong in the worker pipeline.
- Maintain non-destructive editing. The original source stays intact in worker memory, and crop values remain normalized from `0` to `1`.
- Respect preview pyramid behavior. Use the smallest generated level that still satisfies the requested target dimension.
- Preserve stale render protection through `renderRevision` or equivalent request-versioning.

## Image Pipeline Order
When changing conversion behavior in `src/utils/imagePipeline.ts`, preserve this order unless there is a strong reason to redesign it end-to-end:
1. orientation
2. crop
3. inversion
4. film-base compensation
5. color or black-and-white conversion
6. temperature and tint
7. exposure
8. black point and white point
9. contrast
10. highlight protection
11. saturation
12. curves

## Conventions
- Use React state and hooks; do not introduce an external state library without a clear architectural need.
- Custom presets are persisted locally. Keep compatibility with the existing preset storage unless a migration is intentional.
- Export should continue to use a `Blob` and native download trigger behavior rather than data URLs.
- Supported formats today are TIFF, JPEG, PNG, and WebP. RAW support is future-facing and should not be implied as complete unless the implementation changes.
- Existing UI dependencies include `lucide-react` for icons and `motion` for animation.

## Working Guidelines
- Prefer focused changes that preserve the current app model instead of broad refactors.
- When touching worker, pipeline, or shared types, verify both type-checking and relevant tests.
- Add or update tests when behavior changes, especially around image transforms, worker coordination, presets, and sidebar-driven workflows.
- Treat `plan.md` as the roadmap reference for upcoming product work.
