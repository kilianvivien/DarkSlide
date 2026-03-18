# Plan: Open in External Editor

## Overview

Add a button that exports the current image (with all adjustments applied) and opens the result in an external image editor such as Pixelmator Pro, Photoshop, Affinity Photo, or any user-configured app. This is a **Tauri-only** feature — the web build shows a disabled state or hides the button entirely.

---

## Context & Motivation

DarkSlide is a negative converter, not a full image editor. After converting a scan, users commonly want to continue editing in a dedicated tool (retouching, healing, layers, masking, sharpening). Today that requires: Export → locate file in Finder → open in editor. This feature collapses that into a single click.

---

## UX Design

### Button Placement

1. **Sidebar Export tab** — third button below "Batch Export…", labeled **"Open in Editor…"** with an `ExternalLink` icon (lucide-react). Secondary style matching "Batch Export…".
2. **Toolbar** — optional; an icon-only button between Crop and the Export button, with tooltip "Open in Editor (⇧⌘E)".
3. **Native menu** — File > "Open in Editor…" (`open-in-editor` menu item ID), shortcut `⇧⌘E`.

### Flow

```
User clicks "Open in Editor…"
  → If no external editor configured → open Settings modal on General tab with editor picker highlighted
  → If editor configured:
      1. Run the full-res export pipeline (same as regular export)
      2. Write the blob to a temp directory as `{filename}_darkslide.{format}`
      3. Open the temp file in the configured editor app
      4. Show a brief toast: "Opened in Pixelmator Pro"
```

### Settings UI (General tab)

Add a new section **"External Editor"** to Settings > General:

| Element | Description |
|---|---|
| App picker button | "Choose Application…" — opens a native file dialog filtered to `.app` bundles (macOS) or executables (Windows/Linux). Displays the selected app name + icon. |
| Clear button | Small `X` to remove the configured editor. |
| Default behavior note | "If no app is chosen, the file opens with your system default for the export format." |

The preference is stored as a full path string (e.g. `/Applications/Pixelmator Pro.app`).

---

## Technical Design

### 1. New Tauri Plugin: `tauri-plugin-opener`

The `tauri-plugin-opener` is Tauri 2's recommended way to open files in external applications. It provides `openPath(path, openWith?)`.

**Changes:**

- `src-tauri/Cargo.toml` — add `tauri-plugin-opener = "2"` dependency
- `src-tauri/src/lib.rs` — register `.plugin(tauri_plugin_opener::init())` in the builder
- `src-tauri/capabilities/default.json` — add `"opener:default"` to the permissions array
- `package.json` — add `@tauri-apps/plugin-opener` JS package

### 2. Preference Store

**`src/utils/preferenceStore.ts`**

```ts
interface UserPreferences {
  // ... existing fields
  externalEditorPath: string | null;   // e.g. "/Applications/Pixelmator Pro.app"
  externalEditorName: string | null;   // e.g. "Pixelmator Pro" (display name)
}
```

Update `isValidPreferences()` to accept the new optional fields. Default both to `null`.

### 3. File Bridge — `openInExternalEditor()`

**`src/utils/fileBridge.ts`**

New exported function:

```ts
import { openPath } from '@tauri-apps/plugin-opener';

export async function openInExternalEditor(
  blob: Blob,
  filename: string,
  editorPath: string | null
): Promise<'opened' | 'error'> {
  if (!isDesktopShell()) return 'error';

  // Write blob to OS temp directory
  const tempDir = await import('@tauri-apps/api/path').then(m => m.tempDir());
  const tempPath = `${tempDir}/${filename}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(tempPath, bytes);

  // Open in configured editor or system default
  if (editorPath) {
    await openPath(tempPath, editorPath);
  } else {
    await openPath(tempPath);
  }

  return 'opened';
}
```

**Temp file management:** Temp files are written to the OS temp directory which is periodically cleaned by the OS. No manual cleanup needed. The filename includes `_darkslide` to avoid collisions.

### 4. Capability: `@tauri-apps/api/path`

The `tempDir()` function requires the `path` plugin capabilities. Check if `path:default` is already in `capabilities/default.json`; if not, add it.

### 5. App.tsx — Handler

New handler `handleOpenInEditor`:

```ts
const handleOpenInEditor = useCallback(async () => {
  if (!doc || isExporting) return;

  const prefs = loadPreferences();
  // If no editor configured and no system default desired, prompt settings
  // (Optional: skip this check and always use system default as fallback)

  setIsExporting(true); // reuse the existing exporting state for the spinner
  try {
    const workerClient = workerClientRef.current;
    if (!workerClient) return;

    const { blob, filename } = await workerClient.export({
      documentId: doc.id,
      settings: doc.settings,
      exportOptions: doc.exportOptions,
      cropRegion: doc.cropRegion,
      orientation: doc.orientation,
    });

    const result = await openInExternalEditor(
      blob,
      filename,
      prefs.externalEditorPath
    );

    if (result === 'opened') {
      // Optional: show toast notification
    }
  } catch (err) {
    console.error('Open in editor failed:', err);
  } finally {
    setIsExporting(false);
  }
}, [doc, isExporting]);
```

Register keyboard shortcut `⇧⌘E` alongside existing shortcuts in the `useEffect` keyboard handler.

### 6. Native Menu Item

**`src-tauri/src/lib.rs`**

Add to the File menu (after "Export…"):

```rust
MenuItem::with_id_and_accelerator(
    app, "open-in-editor", "Open in Editor…", true, Some("Shift+Super+E")
)?
```

Emit `menu-action` with `"open-in-editor"` payload. Handle in `App.tsx` alongside existing menu event listener.

### 7. Sidebar Export Tab

**`src/components/Sidebar.tsx`**

Add below the "Batch Export…" button:

```tsx
{isDesktopShell() && (
  <button
    onClick={onOpenInEditor}
    disabled={!hasImage || isExporting}
    className="w-full py-2.5 px-4 rounded-lg text-sm font-medium
               border border-zinc-800 text-zinc-300 hover:bg-zinc-800/60
               disabled:opacity-40 disabled:cursor-not-allowed
               transition-colors flex items-center justify-center gap-2"
  >
    <ExternalLink size={15} />
    Open in Editor…
  </button>
)}
```

New prop: `onOpenInEditor: () => void`.

### 8. Settings Modal — Editor Picker

**`src/components/SettingsModal.tsx`**

In the General tab, add a section after the existing toggles:

```tsx
<div className="space-y-2">
  <h4 className="text-sm font-medium text-zinc-300">External Editor</h4>
  <p className="text-xs text-zinc-500">
    Choose which app opens when you use "Open in Editor…"
  </p>
  <div className="flex items-center gap-2">
    <button onClick={handleChooseEditor} className="...">
      {editorName || 'Choose Application…'}
    </button>
    {editorName && (
      <button onClick={handleClearEditor} className="...">
        <X size={14} />
      </button>
    )}
  </div>
  <p className="text-xs text-zinc-600">
    If none is set, the file opens with your system default.
  </p>
</div>
```

The `handleChooseEditor` function uses `@tauri-apps/plugin-dialog` `open()` with filters for `.app` on macOS. Extract the app display name from the path (e.g. `/Applications/Pixelmator Pro.app` → `Pixelmator Pro`).

---

## Web Build Behavior

Since this feature depends on Tauri plugins (`opener`, `fs`, `path`), it is **desktop-only**:

- `isDesktopShell()` gates all UI elements (button hidden in web build)
- `fileBridge.openInExternalEditor()` returns `'error'` immediately if not in Tauri
- No Tauri imports are eagerly loaded in the web build (dynamic imports already used throughout `fileBridge.ts`)

---

## Edge Cases & Error Handling

| Scenario | Handling |
|---|---|
| No image loaded | Button disabled (same as Export) |
| Export in progress | Button disabled, shows spinner |
| Configured editor app deleted/moved | `openPath` throws → catch and show error toast: "Could not open [App Name]. Check Settings." |
| No editor configured, no system default for format | OS shows its own "choose application" dialog — acceptable fallback |
| Very large image (100+ MP) | Export may take time — reuse existing export progress indicator |
| User clicks multiple times | Guard with `isExporting` flag (already exists) |
| Temp directory write fails (permissions) | Catch and show error toast |
| Non-macOS platforms (future) | `openPath` with `openWith` uses platform-specific app path; the Settings picker would filter for `.exe` on Windows. For now macOS-only is fine. |

---

## Files to Create/Modify

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-opener` dependency |
| `src-tauri/src/lib.rs` | Register opener plugin + add menu item |
| `src-tauri/capabilities/default.json` | Add `opener:default` permission |
| `package.json` | Add `@tauri-apps/plugin-opener` |
| `src/utils/preferenceStore.ts` | Add `externalEditorPath` / `externalEditorName` fields |
| `src/utils/fileBridge.ts` | Add `openInExternalEditor()` function |
| `src/App.tsx` | Add `handleOpenInEditor`, keyboard shortcut, menu handler |
| `src/components/Sidebar.tsx` | Add "Open in Editor…" button + prop |
| `src/components/SettingsModal.tsx` | Add editor picker UI in General tab |

---

## Implementation Order

1. **Plugin setup** — Cargo dependency, Rust plugin registration, capabilities, JS package
2. **Preference store** — Add fields, validation, defaults
3. **Settings UI** — Editor picker in General tab
4. **fileBridge** — `openInExternalEditor()` function
5. **App.tsx** — Handler, keyboard shortcut, menu event
6. **Sidebar** — Button in Export tab
7. **Native menu** — Menu item in File menu
8. **Testing** — Manual test with Pixelmator Pro, Photoshop, Preview, and system default

---

## Future Enhancements

- **"Edit and Re-import"** — watch the temp file for changes and offer to re-import the edited version back into DarkSlide (requires `tauri-plugin-fs` watch or `notify` crate)
- **Recent editors** — remember the last 3 used editors for quick switching
- **Round-trip TIFF** — export as 16-bit TIFF for lossless round-trip to Photoshop (requires TIFF encoder, currently not in the export pipeline)
- **"Reveal in Finder"** — simpler variant that just shows the exported file in Finder (uses `opener.revealItemInDir()`)
