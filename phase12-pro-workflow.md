# Phase 12: Pro Workflow — Detailed Implementation Plan

## Overview

Phase 12 lifts the single-document constraint and adds the plumbing needed for professional film scanning workflows. Four independent feature sets ship in order:

1. **Multi-document tabs** — open and switch between multiple images
2. **Batch processing** — apply shared settings and export a batch unattended
3. **Contact sheet export** — render a grid of thumbnails into a single proof image
4. **ICC color management** — embed color profiles in exported files

Each feature builds on the previous one but can be developed and tested incrementally.

---

## Feature 1: Multi-Document Tabs

### Goal

Replace the single `WorkspaceDocument` with an ordered array of tabs. The worker already stores documents in a `Map<string, StoredDocument>` keyed by `documentId` — the main constraint today is that `App.tsx` disposes the previous document on every import.

### New types (`src/types.ts`)

```typescript
export interface DocumentTab {
  id: string;                            // same as WorkspaceDocument.id
  document: WorkspaceDocument;
  historyStack: ConversionSettings[];    // undo entries
  historyIndex: number;                  // pointer into historyStack
  zoom: ZoomLevel;
  pan: { x: number; y: number };
  sidebarScrollTop: number;              // restore sidebar scroll position on switch
}
```

### State changes in `App.tsx`

| Current | New |
|---------|-----|
| `documentState: WorkspaceDocument \| null` | `tabs: DocumentTab[]` + `activeTabId: string \| null` |
| Single `useHistory()` hook | Per-tab `historyStack` / `historyIndex` stored in `DocumentTab` — plain array ops, no hook |
| Single `useViewportZoom()` result | Save/restore `zoom` + `pan` into `DocumentTab` on tab switch |
| `importFile` calls `disposeDocument(prev)` | `importFile` creates a new tab entry; no dispose |

Derive the active document as:
```typescript
const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
const documentState = activeTab?.document ?? null;
```

All existing `setDocumentState(...)` calls become tab-aware updaters:
```typescript
function updateActiveDocument(updater: (doc: WorkspaceDocument) => WorkspaceDocument) {
  setTabs(prev => prev.map(tab =>
    tab.id === activeTabId
      ? { ...tab, document: updater(tab.document) }
      : tab
  ));
}
```

Keep these render/session refs explicit during the refactor:
- `activeDocumentIdRef` remains global and always points at the visible tab.
- `renderRevisionRef` becomes per-tab (`DocumentTab.document.renderRevision` stays authoritative). Do not use a single cross-tab revision counter.
- Queued preview refs (`activeRenderRequestRef`, `pendingPreviewRef`, `queuedPreviewRenderRef`, `pendingInteractivePreviewRef`) remain global because only one tab is visible at a time, but they must be cleared on tab switch.
- Import-session invalidation remains global for file-open races, but import must no longer dispose the previously active document as part of normal success flow.

### Tab lifecycle

#### Open (import)
1. Generate a new `documentId` (UUID).
2. Decode the file via the worker (same flow as today).
3. Push a new `DocumentTab` into `tabs` with default zoom (`'fit'`), empty history, and the decoded `WorkspaceDocument`.
4. Set `activeTabId` to the new tab.
5. Do **not** dispose any previous document.

#### Close
1. `Cmd+W` closes the active tab.
2. If `tab.document.dirty`, show a confirmation prompt ("Discard unsaved changes?").
3. Call `workerClient.disposeDocument(tab.id)` to free worker memory.
4. Remove the tab from `tabs`.
5. Activate the nearest remaining tab, or show the empty state if none remain.

#### Switch
1. Save current zoom/pan into the outgoing tab's `DocumentTab`.
2. Set `activeTabId` to the target tab.
3. Restore zoom/pan from the incoming tab.
4. Update `activeDocumentIdRef.current`.
5. Cancel any in-flight preview render for the old tab.
6. The render effect (keyed on `documentState?.id`) fires automatically for the new tab.

#### Dirty state
- `document.dirty` remains per-document.
- Mark dirty when conversion settings, crop, profile selection, or export options change.
- Do **not** mark dirty for viewport-only state (`zoom`, `pan`, sidebar scroll position), tab order, batch modal choices, or contact-sheet options.
- Exporting a file does not clear `dirty`; it is still a "changes since import/reset" flag, not a save-state tracker.

### Tab bar component (`src/components/TabBar.tsx`)

- Horizontal strip rendered above the viewport canvas.
- Each tab: filename (truncated to ~20 chars), dirty dot indicator, close (X) button.
- "+" button at the right end triggers the file open dialog.
- Drag-to-reorder using HTML5 drag events (no library).
- Keyboard: `Cmd+Shift+[` / `Cmd+Shift+]` to cycle; `Cmd+W` to close.
- Style: compact, matches the existing sidebar aesthetic (dark background, muted text, accent on active tab).

### Per-document undo/redo

Replace the `useHistory` hook with plain logic operating on `DocumentTab.historyStack` and `.historyIndex`:

```typescript
function handleUndo() {
  setTabs(prev => prev.map(tab => {
    if (tab.id !== activeTabId || tab.historyIndex <= 0) return tab;
    const newIndex = tab.historyIndex - 1;
    return {
      ...tab,
      historyIndex: newIndex,
      document: { ...tab.document, settings: tab.historyStack[newIndex] },
    };
  }));
}
```

Commit a new history entry on every `handleSettingsChange` boundary (same debounce/interaction-end logic as today). Cap at 50 entries per tab.

### Per-document zoom/pan

`useViewportZoom` remains a single hook instance. On tab switch, imperatively call `setZoomLevel(incomingTab.zoom)` and `setPan(incomingTab.pan)`. Before switching, snapshot the current values into the outgoing tab.

### Worker client changes (`src/utils/imageWorkerClient.ts`)

- Change `activePreviewJobId: string | null` → `activePreviewJobIds: Map<string, string>` so preview cancellation is per-document.
- `cancelActivePreviewRender(documentId)` cancels only that document's in-flight job.
- `decodeCache` is already per-document — no change needed.

### Memory management

- `MAX_OPEN_TABS = 8` constant in `src/constants.ts`.
- When opening beyond the limit, auto-close the oldest non-dirty tab (dispose its worker document). If all tabs are dirty, show a dialog asking the user to close one manually.
- Optional future optimisation: evict the full-res `sourceCanvas` from inactive tabs while keeping the preview pyramid. Re-decode from the `decodeCache` on export. Not required for initial implementation.

### Files touched

| File | Change |
|------|--------|
| `src/types.ts` | Add `DocumentTab` |
| `src/App.tsx` | Replace single-document state with `tabs`/`activeTabId`; refactor `importFile`, close, undo/redo, settings change, render orchestration; add `TabBar` to layout; add keyboard shortcuts |
| `src/components/TabBar.tsx` | **New** — tab strip UI |
| `src/hooks/useHistory.ts` | Remove or deprecate (logic moves inline into App) |
| `src/utils/imageWorkerClient.ts` | `activePreviewJobIds: Map` |
| `src/constants.ts` | Add `MAX_OPEN_TABS` |

---

## Feature 2: Batch Processing

### Goal

Apply a shared `ConversionSettings` + `FilmProfile` to a set of files and export all of them sequentially without manual intervention.

### Entry point

- "Batch Export..." button at the bottom left corner of the sidebar, left of the settings wheel (always visible, does not require multi-tab).
- Keyboard shortcut: `Cmd+Shift+E`.
- Tauri menu item: File > Batch Export...

### Batch modal (`src/components/BatchModal.tsx`)

A full-screen modal overlay with:

1. **File list panel**
   - "Add Files" button opens a multi-select file picker via `fileBridge.openMultipleImageFiles()`.
   - Each row: filename, file size, status badge (`pending` | `processing` | `done` | `error`).
   - Optional enhancement: desktop-only thumbnail preview via object URL or lazy visible-row decode. Do **not** eagerly decode every queued file just to populate thumbnails.
   - Remove button per row.
   - Drag-and-drop onto the modal to add files.

2. **Settings source** (radio group)
   - "Use current document settings" — copies the active tab's `ConversionSettings` and resolved active `FilmProfile`.
   - "Use built-in profile" — dropdown to select any `FilmProfile`.
   - "Use custom profile" — dropdown to select any custom profile.
   - (Film base sampling is not available in batch mode — each file uses the shared settings as-is.)

3. **Export options**
   - Format (JPEG / PNG / WebP) and quality slider — reuses existing `ExportOptions` UI components.
   - **Output naming**: text input with template tokens: `{original}`, `{n}` (sequence number). Default: `{original}_darkslide`.
   - Filename collisions in the target folder auto-suffix with `-2`, `-3`, etc. Existing files are never overwritten silently.

4. **Output folder** (desktop only)
   - "Choose Folder" button calls `fileBridge.openDirectory()`.
   - Web mode: each file triggers a sequential browser download (or uses File System Access API `showDirectoryPicker` if available).

5. **Start / Cancel** buttons
   - Start disables the file list and begins processing.
   - Cancel sets a flag that aborts after the current file finishes.

### Batch job types (local to `BatchModal`)

```typescript
interface BatchJobEntry {
  id: string;           // UUID for worker documentId
  file: File;
  filename: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  errorMessage?: string;
  progress?: number;    // 0-1, updated during decode/export
}
```

### Processing loop (`src/utils/batchProcessor.ts`)

A pure async function that accepts the worker client and yields progress:

```typescript
export async function* runBatch(
  workerClient: ImageWorkerClient,
  entries: BatchJobEntry[],
  sharedSettings: ConversionSettings,
  sharedProfile: FilmProfile,
  exportOptions: ExportOptions,
  outputPath: string | null,           // null for web
  cancelToken: { cancelled: boolean },
): AsyncGenerator<BatchProgressEvent> {
  for (const entry of entries) {
    if (cancelToken.cancelled) break;
    yield { type: 'start', entryId: entry.id };

    try {
      // 1. Read file buffer
      const buffer = await entry.file.arrayBuffer();

      // 2. Decode
      await workerClient.decode({
        documentId: entry.id,
        buffer,
        fileName: entry.filename,
        mime: entry.file.type || 'application/octet-stream',
        size: entry.file.size,
      });

      // 3. Export at full resolution
      const result = await workerClient.export({
        documentId: entry.id,
        settings: sharedSettings,
        isColor: sharedProfile.type !== 'bw' && !sharedSettings.blackAndWhite.enabled,
        options: exportOptions,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
      });

      // 4. Save
      const outputFilename = applyNamingTemplate(entry.filename, exportOptions.filenameBase);
      await saveBatchExport(result.blob, outputFilename, exportOptions.format, outputPath);

      // 5. Dispose worker memory for this file
      await workerClient.disposeDocument(entry.id);

      yield { type: 'done', entryId: entry.id };
    } catch (err) {
      yield { type: 'error', entryId: entry.id, message: String(err) };
      // Dispose on error too
      try { await workerClient.disposeDocument(entry.id); } catch {}
    }
  }
  yield { type: 'complete' };
}
```

Key design decisions:
- **Sequential, not parallel** — one file at a time avoids GPU/CPU contention and memory spikes.
- **Dispose after each file** — keeps worker memory bounded regardless of batch size.
- **Error resilience** — a failed file does not abort the batch; it is logged and skipped.
- `runBatch(...)` should be specified against the current `DecodeRequest` / `ExportRequest` types in `src/types.ts`. If those request types change as part of Phase 12, update the shared type definitions first and then update this plan to match.

### File bridge additions (`src/utils/fileBridge.ts`)

```typescript
export async function openMultipleImageFiles(): Promise<File[]>;
export async function openDirectory(): Promise<string | null>;  // Tauri only
export async function saveToDirectory(blob: Blob, filename: string, dirPath: string): Promise<void>;  // Tauri only
```

Web fallback for `saveToDirectory`: use `showDirectoryPicker()` (File System Access API) if available, otherwise fall back to sequential `<a download>` clicks.

`saveBatchExport(...)` should wrap the existing `saveExportBlob(...)` path for single-file downloads and use `saveToDirectory(...)` only when the user has selected an output folder.

### Files touched

| File | Change |
|------|--------|
| `src/components/BatchModal.tsx` | **New** |
| `src/utils/batchProcessor.ts` | **New** |
| `src/components/Sidebar.tsx` | Add "Batch Export..." button in Export tab |
| `src/App.tsx` | Add `showBatchModal` state, pass `workerClientRef` to modal |
| `src/utils/fileBridge.ts` | Add `openMultipleImageFiles`, `openDirectory`, `saveToDirectory` |
| `src/types.ts` | Add `BatchProgressEvent` type |

---

## Feature 3: Contact Sheet Export

### Goal

Render multiple open images as a grid on a single output image — a digital version of the photographer's proof sheet.

### Prerequisite

Multi-document tabs (Feature 1) must be implemented — the contact sheet reads from open documents in the worker's `documents` map.

### Entry point

- "Contact Sheet..." button in the Export tab, enabled when 2+ tabs are open.
- Disabled state tooltip: "Open multiple images to create a contact sheet".
- Clicking "Generate" snapshots the selected tab IDs, labels, settings, and resolved profiles at that moment. Closing or editing tabs after generation starts does not affect the in-flight sheet.

### Contact sheet modal (`src/components/ContactSheetModal.tsx`)

1. **Image selector**: checkbox list of all open tabs (filename + small thumbnail). Select all / deselect all toggle.
2. **Grid layout**:
   - Columns: number input, 1–8 (default: auto-calculated from image count).
   - Cell size: Small (256px) / Medium (512px) / Large (1024px) radio.
   - Margin: 0–64px slider (default: 16px).
   - Background: black / white / custom hex picker.
3. **Captions**: checkbox to show filename below each cell. Font size: 12–24px.
4. **Export options**: Format (JPEG / PNG), quality, output filename (default: `contact_sheet`).
5. **Generate** button — triggers the worker, shows a progress spinner, then auto-saves the result.

### Worker message protocol

New message type in `imageWorker.ts`:

```
→ { id, type: 'contact-sheet', payload: ContactSheetRequest }
← existing worker envelope: { id, ok, payload: ContactSheetResult }
```

Types added to `src/types.ts`:

```typescript
export interface ContactSheetCell {
  documentId: string;
  label: string;            // filename caption
}

export interface ContactSheetRequest {
  cells: ContactSheetCell[];
  columns: number;
  cellMaxDimension: number;   // px
  margin: number;             // px
  backgroundColor: [number, number, number];
  showCaptions: boolean;
  captionFontSize: number;
  exportOptions: ExportOptions;
  // Per-cell rendering params (parallel arrays indexed by cell):
  settingsPerCell: ConversionSettings[];
  profilePerCell: FilmProfile[];
}

export interface ContactSheetResult {
  blob: Blob;
  width: number;
  height: number;
}
```

### Worker handler (`handleContactSheet` in `imageWorker.ts`)

```
1. Calculate grid dimensions:
   rows = ceil(cells.length / columns)
   captionHeight = showCaptions ? captionFontSize + 8 : 0
   totalWidth  = columns * cellMaxDimension + (columns + 1) * margin
   totalHeight = rows * (cellMaxDimension + captionHeight) + (rows + 1) * margin

2. Create master OffscreenCanvas(totalWidth, totalHeight).
   Fill with backgroundColor.

3. For each cell (i):
   a. Get StoredDocument from documents.get(cell.documentId).
   b. Pick the smallest preview level >= cellMaxDimension.
   c. Render with processImageData(previewCanvas, settings, profile).
   d. Scale to fit within cellMaxDimension (maintain aspect ratio).
   e. Calculate grid position:
      col = i % columns
      row = floor(i / columns)
      x = margin + col * (cellMaxDimension + margin)
      y = margin + row * (cellMaxDimension + captionHeight + margin)
   f. Draw the processed cell onto the master canvas at (x, y), centered within the cell rect.
   g. If showCaptions, draw cell.label below the image using fillText.

4. Call master.convertToBlob(exportOptions) → return ContactSheetResult.
```

Font rendering: use `ctx.font = '${fontSize}px monospace'` — available on `OffscreenCanvas` without font loading.

### Worker client addition (`src/utils/imageWorkerClient.ts`)

```typescript
async contactSheet(request: ContactSheetRequest): Promise<ContactSheetResult>;
```

Posts the message and awaits the result, same pattern as `export()`.

### Files touched

| File | Change |
|------|--------|
| `src/components/ContactSheetModal.tsx` | **New** |
| `src/types.ts` | Add `ContactSheetCell`, `ContactSheetRequest`, `ContactSheetResult` |
| `src/utils/imageWorker.ts` | Add `'contact-sheet'` message handler |
| `src/utils/imageWorkerClient.ts` | Add `contactSheet()` method |
| `src/components/Sidebar.tsx` | Add "Contact Sheet..." button (disabled when < 2 tabs) |
| `src/App.tsx` | Add `showContactSheetModal` state, wire button |

---

## Feature 4: ICC Color Management

### Goal

Embed a color profile (ICC) into exported JPEG/PNG files so that color-managed applications (Photoshop, Lightroom, print RIPs) interpret the colors correctly.

### Scope

Phase 12 delivers **sRGB profile embedding** only — no color space conversion. The pipeline stays sRGB, and exports may be tagged as sRGB or left untagged. Full gamut mapping (sRGB ↔ Display P3 ↔ AdobeRGB) and arbitrary custom ICC selection are deferred to a future phase because tagging sRGB pixel data as some other color space would be incorrect.

### sRGB profile constant (`src/utils/srgbIccProfile.ts`)

The official sRGB IEC61966-2.1 ICC profile (~3 KB) is stored as a Base64-encoded constant. At runtime:
```typescript
export const SRGB_ICC_PROFILE: Uint8Array = Uint8Array.from(
  atob(SRGB_ICC_BASE64), c => c.charCodeAt(0)
);
```

### ICC embedding utility (`src/utils/iccEmbed.ts`)

Two pure functions that operate on raw bytes:

#### `embedIccInJpeg(jpegBlob: Blob, iccProfile: Uint8Array): Promise<Blob>`

1. Read the blob as `Uint8Array`.
2. Verify the JPEG SOI marker (`0xFF 0xD8`).
3. Build one or more APP2 marker segments:
   - Marker: `0xFF 0xE2`
   - Length: 2 + 12 (signature) + 2 (chunk index/count) + chunk data
   - Signature: `ICC_PROFILE\0`
   - Chunk numbering: split profile into ≤65519-byte chunks (rarely needed for sRGB's ~3 KB)
4. Insert the APP2 segment(s) immediately after SOI (before any existing APP0/APP1).
5. Return new `Blob([header, app2, rest])`.

#### `embedIccInPng(pngBlob: Blob, iccProfile: Uint8Array): Promise<Blob>`

1. Read the blob as `Uint8Array`.
2. Verify the 8-byte PNG signature.
3. Build an `iCCP` chunk:
   - Profile name: `sRGB\0`
   - Compression method: `0` (deflate)
   - Compressed profile data: use `CompressionStream('deflate')` (available in modern browsers/workers)
4. Calculate CRC32 for the chunk.
5. Insert the `iCCP` chunk immediately after the `IHDR` chunk.
6. Return new `Blob([signature, ihdr, iccp, rest])`.

#### `embedIccInBlob(blob: Blob, iccProfile: Uint8Array, format: ExportFormat): Promise<Blob>`

Dispatcher that calls `embedIccInJpeg` or `embedIccInPng` based on format. WebP ICC embedding is not supported in Phase 12 (WebP container format is more complex); skip silently.

### Export pipeline integration

In `imageWorkerClient.ts`, after the export blob is produced (both GPU and CPU paths), add:

```typescript
if (exportOptions.iccEmbedMode === 'srgb') {
  blob = await embedIccInBlob(blob, SRGB_ICC_PROFILE, exportOptions.format);
}
```

This runs on the main thread (fast — just byte splicing) after the worker returns the raw blob.

### Type changes (`src/types.ts`)

Extend `ExportOptions`:
```typescript
export interface ExportOptions {
  format: ExportFormat;
  quality: number;
  filenameBase: string;
  iccEmbedMode: 'srgb' | 'none';   // default: 'srgb'
}
```

### UI changes (Export tab in `src/components/Sidebar.tsx`)

Add a "Color Profile" section below the existing format/quality controls:

```
Color Profile
  ○ sRGB (default)
  ○ None
```

Do not expose custom ICC file selection in Phase 12. That UI belongs in the later phase that also performs real color-space conversion.

### Preference persistence

In `src/utils/preferenceStore.ts`, persist `iccEmbedMode` as part of `UserPreferences.exportOptions`.

Compatibility note: keep `UserPreferences.version = 1` and treat missing `iccEmbedMode` as `'srgb'` on load so existing installations migrate without a storage reset.

### Files touched

| File | Change |
|------|--------|
| `src/utils/iccEmbed.ts` | **New** — `embedIccInJpeg`, `embedIccInPng`, `embedIccInBlob` |
| `src/utils/srgbIccProfile.ts` | **New** — Base64 sRGB ICC profile constant |
| `src/types.ts` | Add `iccEmbedMode` to `ExportOptions` |
| `src/utils/imageWorkerClient.ts` | Post-process export blob with `embedIccInBlob` |
| `src/components/Sidebar.tsx` | Add ICC profile selector in Export tab |
| `src/utils/preferenceStore.ts` | Persist `iccEmbedMode` |
| `src/constants.ts` | Update `DEFAULT_EXPORT_OPTIONS` with `iccEmbedMode: 'srgb'` |

---

## Implementation Order

```
Step 1: Multi-Document Tabs
  ├── 1a. Add DocumentTab type and TabBar component
  ├── 1b. Refactor App.tsx state from single-doc to tabs/activeTabId
  ├── 1c. Per-tab undo/redo (inline, remove useHistory hook)
  ├── 1d. Per-tab zoom/pan save/restore
  ├── 1e. Worker client per-document job tracking
  ├── 1f. Tab close with dirty-check + memory cap
  └── 1g. Keyboard shortcuts (Cmd+W, Cmd+Shift+[/])

Step 2: Batch Processing
  ├── 2a. fileBridge additions (multi-file picker, directory picker)
  ├── 2b. batchProcessor.ts async generator
  ├── 2c. BatchModal.tsx UI
  └── 2d. Wire into Sidebar export tab + Cmd+Shift+E

Step 3: Contact Sheet Export
  ├── 3a. Worker message type + handleContactSheet
  ├── 3b. ImageWorkerClient.contactSheet() method
  ├── 3c. ContactSheetModal.tsx UI
  └── 3d. Wire into Sidebar + gate on tab count

Step 4: ICC Color Management
  ├── 4a. srgbIccProfile.ts constant
  ├── 4b. iccEmbed.ts (JPEG + PNG byte-level injection)
  ├── 4c. ExportOptions type extension + default update
  ├── 4d. Export pipeline post-processing in imageWorkerClient
  ├── 4e. sRGB / None selector UI in Sidebar export tab
  └── 4f. Preference persistence for iccEmbedMode
```

---

## Testing Strategy

### Multi-document tabs
- Open 2–3 images, switch between them, verify settings/zoom/histogram are independent.
- Undo/redo per tab: make changes to tab A, switch to tab B, undo in B — verify A is unaffected.
- Close dirty tab: verify confirmation prompt appears.
- Exceed `MAX_OPEN_TABS`: verify oldest clean tab is auto-closed.
- Render correctness: switch tabs rapidly, verify no stale renders appear.

### Batch processing
- Batch export 5 JPEG files with shared settings: verify all outputs exist with correct filenames.
- Batch with one corrupt file: verify it errors gracefully and the rest succeed.
- Cancel mid-batch: verify processing stops after current file, completed files are saved.
- Web mode: verify sequential downloads work (or File System Access API directory write).

### Contact sheet
- Generate a 2×2 sheet from 4 open images: verify grid layout, captions, and background color.
- Odd number of images (e.g., 5 with 3 columns): verify the last row is correctly laid out with empty cells.
- Large cell size (1024px) with 12 images: verify output dimensions are correct.
- Start generation, then close or edit one of the source tabs: verify the sheet uses the captured snapshot rather than partially updated state.

### ICC embedding
- Export a JPEG with sRGB embedding: open in Photoshop/Preview, verify the profile is detected as sRGB.
- Export a PNG with sRGB embedding: verify the `iCCP` chunk is present (use `pngcheck` or similar).
- Export with "None": verify no ICC data is present.
- Export WebP: verify no crash (ICC embedding silently skipped for WebP).
- Load preferences from a pre-Phase-12 install: verify missing `iccEmbedMode` defaults cleanly to `'srgb'`.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory blowup with many open tabs | Worker OOM on 8× 50 MP TIFFs (~1.9 GB) | `MAX_OPEN_TABS = 8` cap; LRU eviction of clean tabs; future: drop source canvas, keep pyramid only |
| Stale renders on rapid tab switching | Wrong image displayed briefly | `activeDocumentIdRef` check on render result arrival; cancel old tab's in-flight job before switching |
| History refactor breaks undo behavior | Lost edits, unexpected state | Regression test: open → edit → undo → redo → switch tab → undo in other tab |
| JPEG ICC injection breaks file structure | Corrupt output files | Test with JFIF, EXIF, and progressive JPEG variants; validate with `exiftool` |
| Batch export memory leak | Worker memory grows unbounded | Dispose each document immediately after export completes |
| Contact sheet text rendering in worker | `fillText` unavailable or garbled in `OffscreenCanvas` | Use `monospace` fallback font; test in Chromium and Safari/WKWebView |
| Batch filename collision overwrites an existing file | Silent data loss in output folder | Auto-suffix output names; never overwrite silently |

---

## Architecture Notes

- The worker is already multi-document capable (`documents: Map<string, StoredDocument>`). The only change is removing the `disposeDocument` call in `importFile`.
- The GPU pipeline (`WebGPUPipeline`) is stateless per-document — a single `GPUDevice` instance serves all tabs. No changes needed.
- The `decodeCache` in `ImageWorkerClient` is already keyed by `documentId` — it naturally supports multiple documents for crash recovery.
- `renderRevision` should be treated as per-document state. Global visibility refs can stay singular because only one tab is shown at a time, but revision numbering must not let a render in tab B invalidate a newer render in tab A.
- Batch processing deliberately does **not** use the GPU path for simplicity — it decodes and exports via the existing worker `handleExport` flow, which selects GPU or CPU automatically based on capability detection.
- Contact sheet generation should use a frozen request payload built on the main thread from the active tab snapshot, not a live read of mutable React state during worker execution.
