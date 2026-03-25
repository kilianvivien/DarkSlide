# Phase 16: Scanning Workflow & Productivity — Implementation Plan

## Prerequisites (Phases 13–15 assumed complete)

This plan assumes the following are already in place:

- **Phase 13**: `App.tsx` decomposed into hooks (`useRenderQueue`, `useWorkspaceCommands`, `useAppShortcuts`, `useDocumentTabs`, `useCalibration`, `useCustomLightSources`, `useViewportZoom`, `useCustomPresets`). File import logic lives in `useFileImport.ts` (consumed by `useWorkspaceCommands`). `useKeyboardShortcuts` is a generic binding utility; app shortcuts are in `useAppShortcuts`. Worker protocol is type-safe (`workerProtocol.ts`, 16 request types). Error boundaries, idle-tab eviction (via `residentDocsStore.ts`), and diagnostics improvements are live.
- **Phase 14**: Auto-crop/frame detection (`frameDetection.ts`), flat-field correction (`flatField.ts`), flare correction (`flareEstimation.ts`), light source profiles (10 built-in via `LIGHT_SOURCE_PROFILES`), expanded film stock library (~47 profiles including Kodak, Fuji, Ilford, CineStill, Lomography, Foma, Rollei, Generic), and slide film support (`filmType: 'negative' | 'slide'`) are all operational. Calibration profiles stored in IndexedDB via `calibrationStore.ts`.
- **Phase 15**: Minilab emulation profiles (5 lab styles: Frontier Classic, Frontier Modern, Noritsu, Neutral, Agfa d-Lab via `LAB_STYLE_PROFILES`), improved auto-exposure/color balance (`auto-analyze` worker request), comparison mode toggle (processed/original), highlight protection and shadow recovery sliders are shipped. Split-screen before/after UI and clipping overlay are **not yet implemented**.

---

## 16A — Hot-Folder / Watch-Folder (Tauri Desktop)

### Goal

Automatically import new scans as they appear in a watched directory — eliminating the repetitive open-file loop during scanning sessions.

### Rust Backend: File Watcher

**File**: `src-tauri/src/watcher.rs` (new)

- Add `notify = "7"` to `Cargo.toml` dependencies (successor to v6, stable API).
- Create a `FolderWatcher` struct holding a `notify::RecommendedWatcher` and the watched path.
- Use `notify::RecursiveMode::NonRecursive` — we watch a single directory, not subdirectories.
- Poll interval: 500ms (`notify::Config::default().with_poll_interval(Duration::from_millis(500))`).
- Filter events to `EventKind::Create(CreateKind::File)` and `EventKind::Modify(ModifyKind::Name(RenameMode::To))` — covers both new files and files moved into the folder.
- Extension filter: only emit for supported extensions (`.tif`, `.tiff`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.dng`, `.cr3`, `.nef`, `.arw`, `.raf`, `.rw2`). Case-insensitive comparison.

**Write-completion debounce**: After detecting a new file, poll its size at 500ms intervals (up to 5s max). Only emit the event once size stabilizes (two consecutive reads match). This prevents importing partially-written files from the camera/scanner.

**Tauri commands** (in `lib.rs`):

```rust
#[tauri::command]
async fn start_watching(path: String, state: State<'_, WatcherState>) -> Result<(), String>

#[tauri::command]
async fn stop_watching(state: State<'_, WatcherState>) -> Result<(), String>

#[tauri::command]
fn is_watching(state: State<'_, WatcherState>) -> bool
```

**Event emission**: On stable file detection, emit to the frontend:
```rust
window.emit("darkslide://new-scan", json!({ "path": full_path, "filename": name }))
```

**State management**: Use `tauri::Manager::manage()` with a `Mutex<Option<FolderWatcher>>` so only one watcher is active at a time. Calling `start_watching` while already watching stops the previous watcher first.

### Frontend: Scanning Session Hook

**File**: `src/hooks/useScanningSession.ts` (new, ~200 lines)

```typescript
interface ScanningSession {
  watchPath: string | null;
  isWatching: boolean;
  queue: ScanQueueEntry[];
  processedCount: number;
  errorCount: number;
  autoExport: boolean;
  autoExportPath: string | null;
}

interface ScanQueueEntry {
  path: string;
  filename: string;
  status: 'queued' | 'importing' | 'processing' | 'exported' | 'error';
  documentId?: string;
  error?: string;
  timestamp: number;
}
```

**Hook exports**:
```typescript
function useScanningSession(deps: {
  importFile: (path: string) => Promise<string>; // from useFileImport (consumed by useWorkspaceCommands)
  workerClient: ImageWorkerClient;
  autoSettings: AutoAnalysisSettings; // from Phase 15 auto-exposure/color
}): {
  session: ScanningSession;
  startWatching: (path: string) => Promise<void>;
  stopWatching: () => Promise<void>;
  setAutoExport: (enabled: boolean, path?: string) => void;
  clearQueue: () => void;
}
```

**Queue processing**:
- Listen for `darkslide://new-scan` events via `@tauri-apps/api/event::listen()`.
- Maintain a `Set<string>` of seen basenames for **duplicate detection**. If a basename is already seen, push a confirmation prompt before re-importing (use a callback prop or `window.confirm` as interim).
- Drain queue sequentially (one file at a time) to cap memory at ~2× one document (from Phase 13's batch memory pressure work).
- For each queued file:
  1. Import via `useFileImport` (triggers decode + preview pyramid).
  2. Auto-crop via `frameDetection.ts` (Phase 14A) — set initial crop rect.
  3. Flat-field correction applied automatically if a profile is active (Phase 14B).
  4. Auto-exposure + auto-color balance (Phase 15B).
  5. If `autoExport` is enabled: export immediately to `autoExportPath` using current export options, then evict the document's pyramids to free memory.
  6. If `autoExport` is disabled: open as a new tab for manual review.

**Persistence**: Save `watchPath` and `autoExport` preference in `preferenceStore.ts` (add to `UserPreferences` v5 migration). The session itself is ephemeral — not persisted across app restarts.

### Frontend: Session Panel UI

**File**: `src/components/ScanningSessionPanel.tsx` (new, ~250 lines)

- Slides up from the bottom of the viewport (like a drawer). Toggle via toolbar button or `Cmd+Shift+W`.
- **Layout** (3 rows):
  1. **Header row**: folder path display + folder picker button + Start/Stop toggle + auto-export checkbox + close button.
  2. **Thumbnail strip**: horizontal scrollable row of 64×64 thumbnails from processed scans. Each thumbnail shows a colored status dot (blue = queued, yellow = importing, green = done, red = error). Click to switch to that tab.
  3. **Status row**: "12 scanned · 1 error · Watching…" + count badge.
- **Folder picker**: calls `@tauri-apps/plugin-dialog::open({ directory: true })`.
- **Auto-export path**: secondary folder picker, shown when auto-export checkbox is on.
- Height: 120px collapsed (header only), 200px expanded (with thumbnails). Animated via `motion`.
- **Desktop-only**: if `!isDesktopShell()`, hide the toolbar button entirely. Show a note in Settings explaining this feature requires the desktop app.

### Registration in App.tsx

- Import `useScanningSession` in `App.tsx`.
- Pass dependencies from existing hooks (`useFileImport` via `useWorkspaceCommands`, `workerClientRef`).
- Add `ScanningSessionPanel` to the layout, positioned absolutely at the bottom.
- Register `Cmd+Shift+W` in `useAppShortcuts` handler map.
- Add "Scanning Session" item to Tauri View menu (emit `menu-action` with `scan-session-toggle`).

### Testing

- **Unit**: mock `notify` events and verify queue processing order, duplicate detection, write-completion debounce.
- **Integration**: manual test with a real directory — copy files in while watching, verify auto-import + auto-crop + auto-export pipeline.
- **Edge cases**: large RAW files (>100MB), rapid successive files, watcher start/stop cycling, permission-denied directories.

---

## 16B — Roll-Based Workflow

### Goal

Group scans by roll for batch operations, synchronized settings, and visual navigation — matching the physical workflow of scanning a roll of film.

### Data Model Changes

**File**: `src/types.ts`

```typescript
interface Roll {
  id: string;                        // uuid
  name: string;                      // User-editable, default: directory name
  filmStock: string | null;          // e.g., "Portra 400"
  profileId: string | null;          // Linked film profile
  camera: string | null;             // e.g., "Nikon F3"
  date: string | null;               // ISO 8601 date
  notes: string;                     // Freeform
  filmBaseSample: FilmBaseSample | null; // Roll-wide film base
  createdAt: number;                 // Timestamp
}
```

Add to `WorkspaceDocument`:
```typescript
rollId: string | null;               // Association to a Roll
```

Add to `DocumentTab`:
```typescript
rollId: string | null;               // Denormalized for fast access in TabBar
```

### Roll State Management

**File**: `src/hooks/useRolls.ts` (new, ~150 lines)

```typescript
function useRolls(): {
  rolls: Map<string, Roll>;
  createRoll: (name: string, directory?: string) => Roll;
  updateRoll: (id: string, updates: Partial<Roll>) => void;
  deleteRoll: (id: string) => void;
  assignToRoll: (documentIds: string[], rollId: string) => void;
  getDocumentsInRoll: (rollId: string) => string[];
  syncSettingsToRoll: (sourceDocId: string, rollId: string) => void;
  applyFilmBaseToRoll: (filmBase: FilmBaseSample, rollId: string) => void;
}
```

**Auto-assignment**: When a file is imported, derive `rollId` from its parent directory path (Tauri only — `path.dirname(nativePath)`). If a roll with that directory name already exists, assign to it. Otherwise, create a new roll. Browser imports get `rollId = null` (no directory info).

**Settings sync** (`syncSettingsToRoll`): Copy the source document's `ConversionSettings` to all documents in the same roll. This is a bulk operation — iterate all tabs with matching `rollId`, update their settings, and enqueue re-renders. Show a confirmation: "Apply settings from {filename} to {n} frames in {rollName}?"

**Film base sync** (`applyFilmBaseToRoll`): Copy sampled `filmBaseSample` to all documents in the roll. Useful because film base is consistent across a roll.

**Persistence**: Rolls stored in `localStorage` key `darkslide_rolls_v1` as `{ version: 1, rolls: Roll[] }`. Rolls are lightweight metadata — the actual document data lives in the existing tab system.

### TabBar Roll Separators

**File**: `src/components/TabBar.tsx` (modify)

- When rendering tabs, group consecutive tabs by `rollId`.
- Between groups, render a colored vertical separator (4px wide, colored by roll — hash `rollId` to one of 8 muted colors from a palette).
- Tabs within a roll show a small colored dot matching the roll color.
- Drag-reorder constrained within roll group by default (hold `Option` to move across rolls).
- Right-click tab context menu gains: "Roll: {rollName}" submenu with "Sync settings to roll", "Apply film base to roll", "Remove from roll", "Roll info…".

### Roll Navigator (Filmstrip)

**File**: `src/components/RollFilmstrip.tsx` (new, ~200 lines)

- Horizontal strip below the viewport, above the status bar. Toggle: `Cmd+Shift+F`.
- Shows canvas thumbnails (64×64) rendered from the 512px preview level of each document in the active roll.
- Active document highlighted with a border.
- Click a thumbnail to switch to that tab.
- Arrow keys (← →) navigate between frames in the roll when filmstrip is focused.
- Lazy rendering: only draw visible thumbnails (IntersectionObserver on a scrollable container).
- If no roll is active (document has `rollId = null`), filmstrip shows all open tabs instead.

### Roll Metadata Panel

**File**: `src/components/RollInfoModal.tsx` (new, ~150 lines)

- Small modal accessible from TabBar context menu → "Roll info…" or from the filmstrip header.
- Editable fields: name, film stock (dropdown from built-in profiles + freetext), camera (freetext), date (date picker), notes (textarea).
- "Sync to Roll" button: applies active document's conversion settings to all frames.
- "Apply Film Base to Roll" button: copies active document's film base sample to all frames.
- Roll metadata is included in sidecar files (16D) and optionally in EXIF (Phase 16D).

### Integration with Scanning Session (16A)

- When hot-folder imports a file, auto-assign to a roll based on the watched directory.
- All files from the same scanning session share a roll.
- Roll metadata (film stock, camera) can be pre-set in the ScanningSessionPanel before starting.

---

## 16C — Quick Export Presets

### Goal

One-click export with pre-configured format/quality/size settings — eliminating the export dialog for common workflows.

### Data Model

**File**: `src/types.ts`

```typescript
interface QuickExportPreset {
  id: string;                        // uuid or built-in slug
  name: string;                      // "Web", "Archive", "Instagram", "Print"
  format: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/tiff';
  quality: number;                   // 0-1 (ignored for PNG/TIFF)
  outputProfileId: ColorProfileId;   // sRGB, display-p3, adobe-rgb
  embedMetadata: boolean;
  embedOutputProfile: boolean;
  maxDimension: number | null;       // null = full resolution
  suffix: string;                    // e.g., "_web", "_archive"
  cropToSquare: boolean;             // Center-crop to 1:1
  isBuiltIn: boolean;
}
```

### Built-In Presets

**File**: `src/constants.ts` (add)

```typescript
const BUILTIN_QUICK_EXPORT_PRESETS: QuickExportPreset[] = [
  {
    id: 'quick-web',
    name: 'Web',
    format: 'image/jpeg',
    quality: 0.85,
    outputProfileId: 'srgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: 2048,
    suffix: '_web',
    cropToSquare: false,
    isBuiltIn: true,
  },
  {
    id: 'quick-archive',
    name: 'Archive',
    format: 'image/tiff',
    quality: 1.0,
    outputProfileId: 'adobe-rgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: null,
    suffix: '',
    cropToSquare: false,
    isBuiltIn: true,
  },
  {
    id: 'quick-instagram',
    name: 'Instagram',
    format: 'image/jpeg',
    quality: 0.90,
    outputProfileId: 'srgb',
    embedMetadata: false,
    embedOutputProfile: false,
    maxDimension: 1080,
    suffix: '_ig',
    cropToSquare: true,
    isBuiltIn: true,
  },
  {
    id: 'quick-print',
    name: 'Print',
    format: 'image/tiff',
    quality: 1.0,
    outputProfileId: 'adobe-rgb',
    embedMetadata: true,
    embedOutputProfile: true,
    maxDimension: null,
    suffix: '_print',
    cropToSquare: false,
    isBuiltIn: true,
  },
];
```

### Custom Presets Storage

**File**: `src/utils/quickExportStore.ts` (new, ~60 lines)

- localStorage key: `darkslide_quick_export_presets_v1`
- Schema: `{ version: 1, presets: QuickExportPreset[] }`
- Functions: `loadQuickExportPresets()`, `saveQuickExportPresets()`, `createFromCurrentSettings(name, currentExportOptions)`
- Merge built-in + custom at load time, built-ins first. Custom presets can shadow built-in IDs (user override).
- Max 12 custom presets (reasonable limit for UI).

### Export Tab UI Changes

**File**: `src/components/Sidebar.tsx` (modify export tab section)

- **Quick Export section** at the top of the Export tab:
  - Grid of preset buttons (2 columns). Each button shows: icon (based on format — camera for JPEG, archive for TIFF, square for Instagram), name, one-line summary ("JPEG 2048px sRGB").
  - Click a preset button → immediate export with those settings. No intermediate dialog.
  - "+" button at the end → "Save current settings as preset" (prompts for name).
  - Long-press or right-click a custom preset → "Edit" / "Delete" options.
- **Existing export controls** remain below the quick export section, under a "Custom Export" header. These are the current format/quality/filename/profile controls.
- Visual separator between quick export and custom export sections.

### One-Click Export Flow

When a quick export preset button is clicked:

1. Build `ExportOptions` from the preset fields.
2. If `maxDimension` is set, pass it as `targetMaxDimension` in the export request.
3. If `cropToSquare` is true, compute a center-crop `CropSettings` with `aspectRatio: 1` and merge it with the document's existing crop (intersect the two rects).
4. Generate filename: `{originalBasename}{suffix}.{ext}`.
5. **Desktop (Tauri)**: if a default export directory is set in preferences, save directly there. Otherwise, show a save dialog.
6. **Browser**: trigger blob download immediately.
7. Show transient notification: "Exported {filename}" (using existing `showTransientNotice`).

### Multi-Export ("Export All")

- Button below the quick export grid: "Export All Enabled".
- Each preset has a checkbox (enabled by default for built-ins, toggled per-session).
- Clicking "Export All" iterates enabled presets sequentially:
  - For each preset: export → save → next.
  - Progress indicator: "Exporting 2/4: Archive…"
  - All outputs go to the same directory (Tauri) or trigger sequential downloads (browser).
- Cancelable via the same `cancelToken` pattern used in batch processing.

### Batch Modal Integration

**File**: `src/components/BatchModal.tsx` (modify)

- Replace the single export options section with a multi-select checklist of quick export presets.
- Each batch item is exported once per enabled preset.
- Naming: `{original}{suffix}.{ext}` per preset.
- Progress shows: "File 3/20 · Preset: Web (2/4)"

### Keyboard Shortcut

- `Cmd+E`: opens export tab (existing behavior).
- `Cmd+Shift+1` through `Cmd+Shift+4`: trigger quick export presets 1–4 directly (the first four presets in order). Register in `useAppShortcuts`.

---

## 16D — Sidecar Settings Files

### Goal

Persist conversion settings alongside exported files so they can be restored on re-import — enabling non-destructive round-tripping.

### Sidecar File Format

**File**: `src/utils/sidecarSettings.ts` (new, ~200 lines)

```typescript
interface SidecarFile {
  version: 1;
  generator: string;                 // "DarkSlide {appVersion}"
  createdAt: string;                 // ISO 8601
  sourceFile: {
    name: string;
    size: number;
    dimensions: { width: number; height: number };
    hash?: string;                   // SHA-256 of first 64KB (optional, for matching)
  };
  settings: ConversionSettings;
  profileId: string;
  profileName: string;
  isColor: boolean;
  colorManagement: ColorManagementSettings;
  exportOptions: ExportOptions;
  roll?: {                           // From 16B, if assigned
    name: string;
    filmStock: string | null;
    camera: string | null;
    date: string | null;
    notes: string;
  };
  flatFieldProfileId?: string;       // Phase 14B reference
  lightSourceProfileId?: string;     // Phase 14D reference
  labStyleId?: string;               // Phase 15A reference
}
```

**File naming**: `{exportedFilename}.darkslide-settings` (e.g., `scan_001_web.jpg.darkslide-settings`). Placed in the same directory as the export.

### Writing Sidecars

**Integration point**: `batchProcessor.ts` and the single-export path in `App.tsx`.

- After a successful export, if `saveSidecar` is enabled in export options:
  1. Build the `SidecarFile` object from current document state.
  2. Serialize to JSON with 2-space indentation (human-readable).
  3. **Tauri**: write via `writeTextFile()` alongside the export.
  4. **Browser**: offer as a secondary download (or skip — browser users rarely need sidecars since they can't re-import by path).

**Export options addition** (`types.ts`):
```typescript
// Add to ExportOptions:
saveSidecar: boolean;  // default: false
```

Add a "Save settings sidecar" checkbox in the export tab, below the existing metadata toggle.

### Reading Sidecars (Auto-Load on Re-Import)

**Integration point**: `useFileImport` hook (called by `useWorkspaceCommands`).

- After decoding a file (Tauri path only), check for a sidecar:
  1. Look for `{sourcePath}.darkslide-settings` (exact match).
  2. Also check `{sourceBasename}.darkslide-settings` in the same directory (covers renamed files).
  3. If found, parse JSON and validate `version` field.
  4. Present a toast/modal: "Settings found for this file. **Restore** / **Ignore**".
  5. On "Restore": apply `settings`, `profileId`, `colorManagement` from sidecar to the new document. Push to undo stack so the user can revert.
  6. On "Ignore": proceed with default settings. Remember this choice per-file in the session (don't re-prompt if the same file is re-imported).

**Validation** (`sidecarSettings.ts`):
- `parseSidecar(json: string): SidecarFile | null` — validates version, required fields, and setting ranges. Returns `null` on parse failure (log a diagnostic warning).
- Forward-compatible: unknown fields are ignored. Version 1 is the initial and only version.

### Settings in EXIF

**Integration point**: `src/utils/imageMetadata.ts`

- For JPEG exports: embed a compact JSON representation of `ConversionSettings` + `profileId` in the EXIF `UserComment` field via `piexifjs`.
- For TIFF exports: embed in `ImageDescription` field.
- The JSON is compact (no whitespace, short keys) to stay within EXIF field limits (~64KB for UserComment).
- This is a secondary mechanism — the sidecar file is authoritative. EXIF embedding ensures settings survive if the sidecar is deleted.

**Compact schema** (abbreviated keys to save space):
```typescript
interface CompactSettings {
  v: 1;                              // version
  p: string;                         // profileId
  s: Partial<ConversionSettings>;    // Only non-default values (delta encoding)
}
```

`buildCompactSettings(settings, profileId)`: Compare against `createDefaultSettings()` and the profile's `defaultSettings` — only include fields that differ. This keeps the EXIF payload under 2KB for typical edits.

### Export Toggle Persistence

- `saveSidecar` preference saved in `preferenceStore.ts` (v5 migration).
- Per-export override available in the export tab checkbox.
- Quick export presets (16C) each carry their own `saveSidecar` default (false for Web/Instagram, true for Archive/Print).

---

## 16E — Tauri Auto-Update

### Goal

Ship updates to desktop users seamlessly, with opt-in beta channel.

### Plugin Setup

**File**: `src-tauri/Cargo.toml` (modify)

Add dependency:
```toml
tauri-plugin-updater = "2"
```

**File**: `src-tauri/src/lib.rs` (modify)

Register plugin:
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    // ... existing plugins
```

**File**: `src-tauri/tauri.conf.json` (modify)

Add updater configuration:
```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/YOUR_ORG/DarkSlide/releases/latest/download/latest.json"
      ],
      "pubkey": "YOUR_PUBLIC_KEY"
    }
  }
}
```

### Update Check Logic

**File**: `src/hooks/useAutoUpdate.ts` (new, ~120 lines)

```typescript
interface UpdateState {
  available: boolean;
  version: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;  // 0-100 during download, null otherwise
  dismissed: boolean;
  error: string | null;
}

function useAutoUpdate(channel: 'stable' | 'beta'): {
  state: UpdateState;
  checkNow: () => Promise<void>;
  startDownload: () => Promise<void>;
  installAndRestart: () => void;
  dismiss: () => void;
}
```

**Check schedule**:
- On app launch (after 5s delay to not block startup).
- Every 24 hours while the app is open (`setInterval`).
- Manual trigger: Help menu → "Check for Updates…"
- Skip check if last dismissed version matches the available version (stored in `localStorage` key `darkslide_dismissed_update`).

**Channel selection**:
- Stored in `UserPreferences` (v5 migration): `updateChannel: 'stable' | 'beta'`.
- Configurable in SettingsModal under a new "Updates" section.
- Beta channel endpoint: same GitHub releases but includes pre-release tags.
- Channel switch: `tauri_plugin_updater::check()` is called with the appropriate endpoint.

### Update Banner UI

**File**: `src/components/UpdateBanner.tsx` (new, ~80 lines)

- Fixed banner at the top of the app window (above toolbar), 40px height.
- Background: blue gradient (matches app accent color).
- Content: "DarkSlide {version} is available · [Release Notes] [Download] [Dismiss]"
- **Release notes**: clicking opens a small modal rendering the GitHub release body as markdown (use a lightweight markdown renderer or just `<pre>` with whitespace preservation).
- **Download**: button shows progress bar during download. On completion, changes to "Install & Restart".
- **Dismiss**: hides banner for this version. Stores dismissed version in localStorage.
- **Install & Restart**: calls `installAndRestart()` which invokes Tauri's updater install + app restart.
- Banner only renders when `state.available && !state.dismissed`.

### Signing & Release Pipeline

This is a CI/CD concern, documented here for completeness:

1. Generate a keypair: `tauri signer generate -w ~/.tauri/darkslide.key`.
2. Store the private key as a GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY`).
3. Set the public key in `tauri.conf.json` `plugins.updater.pubkey`.
4. GitHub Actions workflow: on tag push (`v*`), build for macOS (aarch64 + x86_64), sign with the private key, create a GitHub Release with the signed bundles + `latest.json` manifest.
5. `latest.json` schema (generated by `tauri-plugin-updater`):
   ```json
   {
     "version": "0.4.0",
     "platforms": {
       "darwin-aarch64": { "url": "...", "signature": "..." },
       "darwin-x86_64": { "url": "...", "signature": "..." }
     },
     "notes": "Release notes markdown..."
   }
   ```

### Settings Modal Integration

**File**: `src/components/SettingsModal.tsx` (modify)

Add an "Updates" section (desktop only):

- **Update channel**: radio buttons — Stable / Beta. Changing channel triggers an immediate check.
- **Current version**: display `appVersion` from `appVersion.ts`.
- **Last checked**: timestamp of last update check.
- **"Check Now" button**: triggers `checkNow()`.

---

## Implementation Order & Dependencies

```
Week 1-2: 16C (Quick Export Presets)
  └─ No dependencies on other 16x features
  └─ Builds on existing export infrastructure
  └─ Delivers immediate user value

Week 2-3: 16D (Sidecar Settings)
  └─ Depends on 16C for preset-aware sidecar defaults
  └─ Builds on existing EXIF/metadata infrastructure

Week 3-5: 16B (Roll-Based Workflow)
  └─ Depends on 16D for roll metadata in sidecars
  └─ Largest feature — data model changes + 3 new components
  └─ Can begin in parallel with 16D after types are defined

Week 5-6: 16A (Hot-Folder / Watch-Folder)
  └─ Depends on 16B for roll auto-assignment
  └─ Depends on Phase 14 (auto-crop) and Phase 15 (auto-exposure)
  └─ Rust + frontend work in parallel

Week 6-7: 16E (Auto-Update)
  └─ Independent of other 16x features
  └─ Deferred to last because it requires CI/CD pipeline setup
  └─ Can be done in parallel with 16A testing
```

### Rationale

- **16C first**: smallest scope, highest immediate impact, no dependencies. Unlocks the preset-aware export options needed by 16D sidecars.
- **16D second**: sidecar format must be defined before 16B can include roll metadata in it.
- **16B third**: the largest sub-phase, but types can be started early. Roll data model informs 16A's auto-assignment logic.
- **16A fourth**: integrates with everything — rolls, auto-crop, auto-exposure, auto-export. Needs the most testing with real hardware.
- **16E last**: standalone infrastructure work. CI/CD pipeline setup can happen any time but shipping it last means the first auto-update delivers all of Phase 16.

---

## Files Created / Modified Summary

### New Files (10)

| File | Sub-phase | Lines (est.) |
|---|---|---|
| `src-tauri/src/watcher.rs` | 16A | ~150 |
| `src/hooks/useScanningSession.ts` | 16A | ~200 |
| `src/components/ScanningSessionPanel.tsx` | 16A | ~250 |
| `src/hooks/useRolls.ts` | 16B | ~150 |
| `src/components/RollFilmstrip.tsx` | 16B | ~200 |
| `src/components/RollInfoModal.tsx` | 16B | ~150 |
| `src/utils/quickExportStore.ts` | 16C | ~60 |
| `src/utils/sidecarSettings.ts` | 16D | ~200 |
| `src/hooks/useAutoUpdate.ts` | 16E | ~120 |
| `src/components/UpdateBanner.tsx` | 16E | ~80 |

### Modified Files (13)

| File | Sub-phase | Changes |
|---|---|---|
| `src/types.ts` | 16B, 16C, 16D | Add `Roll`, `QuickExportPreset`, `SidecarFile` types; extend `WorkspaceDocument` with `rollId`, `ExportOptions` with `saveSidecar` |
| `src/constants.ts` | 16C | Add `BUILTIN_QUICK_EXPORT_PRESETS` |
| `src/App.tsx` | 16A, 16B, 16C | Wire new hooks, add ScanningSessionPanel + RollFilmstrip + UpdateBanner to layout |
| `src/hooks/useFileImport.ts` | 16A, 16D | Sidecar auto-load on re-import, scanning session import integration |
| `src/components/Sidebar.tsx` | 16C, 16D | Quick export preset grid in export tab, sidecar toggle |
| `src/components/TabBar.tsx` | 16B | Roll separators, colored dots, context menu |
| `src/components/BatchModal.tsx` | 16C | Multi-preset checklist |
| `src/components/SettingsModal.tsx` | 16E | Updates section |
| `src/utils/preferenceStore.ts` | 16A, 16D, 16E | v5 migration (watchPath, saveSidecar, updateChannel) — currently at v4 |
| `src/utils/batchProcessor.ts` | 16C, 16D | Multi-preset export loop, sidecar write after export |
| `src/utils/imageMetadata.ts` | 16D | Compact settings in EXIF UserComment/ImageDescription |
| `src-tauri/src/lib.rs` | 16A, 16E | Watcher commands, updater plugin registration |
| `src-tauri/Cargo.toml` | 16A, 16E | `notify`, `tauri-plugin-updater` dependencies |
| `src-tauri/tauri.conf.json` | 16E | Updater endpoint + pubkey config |

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| **File watcher false positives** (temp files, .DS_Store) | Extension whitelist + write-completion debounce |
| **Memory pressure with many roll tabs** | Idle-tab eviction (Phase 13) limits resident documents to 3 |
| **Sidecar format migration** | Versioned schema (`version: 1`) with forward-compatible parsing |
| **EXIF field size limits** | Delta encoding keeps payload under 2KB; fall back to sidecar-only if too large |
| **Auto-update signing errors** | CI validation step: verify signature before publishing release |
| **Roll auto-assignment wrong for mixed directories** | Manual re-assignment via context menu; auto-assign is a hint, not mandatory |
| **Quick export to wrong directory** | Confirm directory on first use; remember per-session; clear on app restart |
