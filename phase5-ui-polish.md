# Phase 5: UI Polish — Implementation Plan

Detailed breakdown of every item in Phase 5 of `plan.md`. Each section identifies the current state, the target, the files to change, and the concrete implementation steps.

---

## 1. Settings Modal + Toolbar Tooltips

### Current State
- All toolbar buttons are icon-only with native `title` tooltips (App.tsx ~1094–1188).
- No keyboard shortcut reference exists anywhere in the UI.
- "Copy Debug Info" is only in the Tauri native menu (Help → Copy Debug Info); invisible in browser builds.
- No centralized app settings surface.

### Target
- Create a **Settings modal** accessible from a gear button at the very bottom of the left sidebar, and from the Tauri menu bar (App name menu → Settings).
- The modal has multiple tabs — at minimum: **General**, **Keyboard Shortcuts**, **Diagnostics**.
- Toolbar buttons remain icon-only; ensure each has a descriptive hover tooltip (via `title`). No visible text labels.

### Implementation

**A. Settings Modal Component**

1. **Create `src/components/SettingsModal.tsx`** — a centered overlay modal with:
   - A tab bar on the left or top: `General` | `Shortcuts` | `Diagnostics`.
   - Dismiss on click-outside, `Escape`, or a close button.
   - Uses `motion` for enter/exit animation consistent with the rest of the app.

2. **General tab** (initially minimal, designed to grow):
   - Placeholder for future settings: default export format, default film profile, theme preference, etc.
   - For now, can show app version and a brief "About DarkSlide" blurb.

3. **Shortcuts tab** — read-only reference listing all shortcuts in a 2-column grid:
   - `Cmd+O` Open, `Cmd+W` Close, `Cmd+Z` Undo, `Cmd+Shift+Z` Redo
   - `Cmd+0` Fit, `Cmd+1` 100%, `Cmd+=`/`Cmd+-` Zoom in/out
   - `Space` (hold) Pan mode
   - `Cmd+E` Export (if added — see item 2)
   - Action label on the left, keyboard shortcut badge on the right.
   - Platform-aware: show `Cmd` on macOS, `Ctrl` on Windows/Linux.

4. **Diagnostics tab**:
   - "Copy Debug Info" button — reuses the existing `handleCopyDebugInfo` logic (App.tsx ~850–870). Extracts it into a shared callable handler.
   - Shows structured summary: app version, platform, current document info (format, dimensions, profile), worker status.
   - A "Copy to Clipboard" action for the full diagnostic report.

**B. Settings Button in Left Sidebar**

1. Place a `Settings` (gear) icon button **pinned to the bottom** of the left sidebar, below all tab content and scroll area. Use `<Settings size={16} />` from lucide-react.
2. Wire it to toggle `showSettingsModal` state in App.tsx.
3. Style: subtle, muted zinc icon matching the sidebar aesthetic. Not part of the scrollable content — absolute/sticky positioned at sidebar bottom.

**C. Tauri Menu Integration**

1. Add a "Settings…" item to the app-name menu in `src-tauri/src/lib.rs` (the standard macOS `Preferences` location, typically under the app name menu with `Cmd+,` shortcut).
2. Emit a `show-settings` event, handled in App.tsx to open the modal.
3. Register `Cmd+,` as a global keyboard shortcut to toggle the settings modal.

**D. Toolbar Tooltips**

1. Audit all existing toolbar buttons — each already has a `title` attribute. Ensure they are descriptive and include the keyboard shortcut where applicable (e.g., `title="Undo (Cmd+Z)"` — most already do this).
2. No additional visible labels.

### Files
- `src/components/SettingsModal.tsx` (new)
- `src/App.tsx` (settings button in sidebar, modal state, Tauri event handler, `Cmd+,` shortcut)
- `src-tauri/src/lib.rs` (add "Settings…" menu item)

---

## 2. Export Flow

### Current State
- The Export tab (Sidebar.tsx ~219–276) contains format, filename, and quality controls but **no export button**.
- The header has an "Export" pill button (App.tsx ~1156–1163) that triggers `handleDownload`.
- Users must configure in the sidebar, then visually locate a different element in the header to fire.

### Target
- Add an "Export" action button directly inside the Export tab so settings and trigger are co-located.
- Keep the header button as a shortcut.

### Implementation

1. **Sidebar.tsx** — Add an export button at the bottom of the Export tab:
   ```tsx
   <button onClick={onExport} disabled={isExporting} className="...">
     {isExporting ? 'Exporting…' : 'Export Image'}
   </button>
   ```
   Style it like a primary call-to-action — filled, full-width, prominent.

2. **Props threading**: The Sidebar already receives the document state and settings. Add `onExport: () => void` and `isExporting: boolean` as new props, passed from App.tsx (the existing `handleDownload` handler).

3. **Keyboard shortcut**: Register `Cmd+E` for export in the keydown handler (App.tsx ~787). List it in the Settings modal Shortcuts tab.

### Files
- `src/components/Sidebar.tsx` (add button + props)
- `src/App.tsx` (pass `onExport`/`isExporting` to Sidebar, register `Cmd+E`)

---

## 3. Reset Adjustments Safeguard

### Current State
- Reset button (App.tsx ~1134–1140) fires `handleReset` immediately — no confirmation.
- `handleReset` (App.tsx ~918–927) replaces settings with `activeProfile.defaultSettings` and **wipes undo history** via `resetHistory`.
- After reset, there is no way to undo.

### Target
- Make reset undoable so `Cmd+Z` restores the previous settings.

### Implementation

1. Change `handleReset` so it pushes the current settings onto the undo stack before applying the reset. Instead of calling `resetHistory()`, use the normal `updateDocument` path so the undo hook captures the pre-reset state as a single entry.
2. The undo hook (`useUndoHistory` or equivalent) already captures deltas on `updateDocument` calls. Ensure the reset produces exactly one undo entry by committing a single atomic update.
3. After this change, `Cmd+Z` after reset restores the previous settings — no data loss. The reset button tooltip should update to indicate undoability: `title="Reset Adjustments (undoable)"`.

### Files
- `src/App.tsx` (`handleReset` logic — stop calling `resetHistory`, use `updateDocument` instead)
- Possibly `src/hooks/useUndoHistory.ts` if the hook needs adjustment to handle large deltas cleanly.

---

## 4. Before/After Deduplication

### Current State
- **Toolbar button** (App.tsx ~1141–1147): `SplitSquareVertical` icon toggles `comparisonMode`.
- **Status bar chip** (App.tsx ~1344–1346): displays `'Processed'` or `'Original'` as a read-only label.
- The status chip is redundant with the toolbar button's active state (which already highlights when in "original" mode).

### Target
- Consolidate to one place (toolbar button).
- Remove the redundant status chip.

### Implementation

1. **Remove the status chip**: Delete the `comparisonMode` span from the status bar pill (App.tsx ~1344–1346). Keep the profile name and dimensions.

2. **Enhance the toolbar button** to make the current mode obvious:
   - When `comparisonMode === 'original'`, the button is already highlighted (white bg). Update the tooltip dynamically: `"Showing Original — click to return"` vs `"Toggle Before/After"`.
   - Optionally use a slightly different icon or add a small dot indicator when showing the original.

3. **Verify Tauri menu** still works: the `toggle-comparison` menu event (App.tsx ~771) toggles the same state — no changes needed there.

### Files
- `src/App.tsx` (remove status chip, enhance toolbar button tooltip)

---

## 5. Histogram Legend

### Current State
- Histogram.tsx renders four overlapping SVG paths (R/G/B/Luminosity) with no labels, no color swatches, and no axis markers.
- Only decoration: three faint vertical guide lines at 25/50/75%.

### Target
- Add channel color swatches (R/G/B/L) and min/max axis markers so the chart is self-explanatory.

### Implementation

1. **Channel legend row** below the SVG:
   - Four small items: `● L` (white/gray), `● R` (red), `● G` (green), `● B` (blue).
   - Each swatch is a small colored circle matching the fill color used in the SVG path.
   - Use `text-[9px] font-mono text-zinc-500` for labels, inline-flex row with `gap-3`.

2. **Axis markers**:
   - X-axis: labels at left (`0`) and right (`255`) edges, below the SVG.
   - Y-axis: no numeric labels needed (relative scale), but the existing vertical guides at 25/50/75% can get subtle tick marks at the bottom edge.
   - Keep it minimal — two small numbers at the corners plus the existing guides.

3. **Interactive toggle (stretch goal, optional)**: Clicking a legend swatch toggles that channel's visibility. Add a `visibleChannels` local state set. Conditionally render each `<path>` based on membership. Skip if it adds unnecessary complexity.

### Files
- `src/components/Histogram.tsx` (legend row, axis labels)

---

## 6. Status Bar Readability

### Current State
- Status bar (App.tsx ~1339–1363) shows a left pill with three items: profile name, comparison mode, and raw dimensions (`{width}×{height}`).
- Dimensions have no thousands separator.
- All items use identical `text-[10px] font-mono text-zinc-500` styling.

### Target
- Format dimensions with separator (e.g., `4,017 × 5,048`).
- Label the resolution chip clearly.

### Implementation

1. **Format dimensions**: Use `n.toLocaleString()` for thousands separators. Render as `{formatDim(width)} × {formatDim(height)}`.

2. **Label the resolution**: Add a `px` suffix and/or a small icon (`<Maximize2 size={10} />` from lucide) so the chip is clearly identified as dimensions.

3. **Remove comparison mode chip** (covered in item 4). After deduplication, the status bar left pill shows: `[Profile Name] | [Formatted Dimensions]`.

4. **Consider output dimensions**: Showing post-crop, post-rotation dimensions is more useful than source dimensions. Compute from `source.width/height` + `crop` + `orientation`. If complex, defer to a follow-up.

### Files
- `src/App.tsx` (status bar section ~1339–1363)

---

## 7. Film Base Section Compactness

### Current State
- Film Base section (Sidebar.tsx ~90–108) has:
  - Section header: `Pipette` icon + "Film Base"
  - Full-width Sample button (prominent, changes appearance when active)
  - Description paragraph (always visible): "Sample an unexposed section of the negative…" (~3 lines of italic text)
- The description takes vertical space and pushes adjustment controls down.

### Target
- Collapse the description text to a tooltip or `(i)` icon.
- Let the Sample button stand alone so adjustments appear higher without scrolling.

### Implementation

1. **Replace the description paragraph** with a small `(i)` info icon next to the section header:
   ```tsx
   <h2 className="...">
     <Pipette size={12} /> Film Base
     <button title="Sample an unexposed section of the negative. DarkSlide uses that film-base color before inversion for both color and B&W conversions.">
       <Info size={10} />
     </button>
   </h2>
   ```
   Use the `Info` icon from lucide-react. The native `title` attribute gives a hover tooltip.

2. **Remove the `<p>` element** (Sidebar.tsx ~105–107).

3. **Resulting layout**: Section header with info icon → Sample button → (next section starts immediately below). Saves ~40–50px of vertical space.

### Files
- `src/components/Sidebar.tsx` (~90–108)

---

## 8. Crop UX Clarity

### Current State
- CropPane.tsx has Orientation (rotate + level) and Aspect Ratio Presets sections.
- **No "Done" button** — crop changes apply live via overlay drag handles.
- **No "Reset Crop" button** — the only way to reset is selecting the "Free" aspect preset, which sets crop to `{x:0, y:0, width:1, height:1}`.
- The crop overlay and the crop tab are independent toggles.

### Target
- Add a visible "Done" / "Reset Crop" affordance inside the Crop tab.
- Make the non-destructive workflow obvious to new users.

### Implementation

1. **Add action buttons at the bottom of CropPane**:
   - "Reset Crop" — resets crop to `{x:0, y:0, width:1, height:1}` and level to 0. Styled as a secondary/ghost button.
   - "Done" — switches the active sidebar tab back to `adjust` and hides the crop overlay. Styled as a primary filled button.

2. **Props for CropPane**:
   - `onDone: () => void` — callback to exit crop mode.
   - `onResetCrop: () => void` — callback to reset crop region and level.
   - Pass from App.tsx. `onDone` switches `activeTab` away from `crop`. `onResetCrop` resets `documentState.settings.crop` and `documentState.settings.levelAdjustment`.

3. **Auto-show crop overlay**: When the user switches to the Crop tab, automatically enable the crop overlay if it isn't already visible. When they click "Done", hide it. This ties the overlay to the crop workflow rather than requiring a separate toggle.

4. **Informational hint** (optional): A brief one-liner at the top of CropPane: "Drag the overlay handles to adjust. Changes apply live."

### Files
- `src/components/CropPane.tsx` (add Done/Reset buttons, optional hint)
- `src/App.tsx` (wire callbacks, auto-show overlay on crop tab)

---

## 9. Custom Presets Discoverability

### Current State
- PresetsPane.tsx (~43–164) shows a single scrollable list with three sections: "Custom Presets" (only if any exist), "Generic", "Film Stocks".
- Custom presets section header + items are hidden when empty.
- The `+` (Plus) button in the pane header is the only way to create a custom preset — it has a `title` tooltip but no visible label.
- New users have no indication that custom presets exist.

### Target
- Label the custom presets section explicitly with a tab header.

### Implementation — Tab Switcher

1. Add a two-tab switcher at the top of the PresetsPane: `Built-in` | `Custom`.
   - `Built-in` tab shows the Generic + Film Stocks sections (current behavior).
   - `Custom` tab shows the custom presets list, **plus** a visible empty state when none exist: "No custom presets yet. Click + to save your current settings as a preset." This makes the feature discoverable.
   - The `+` button remains in the header and is always visible.

2. **State**: `activePresetTab: 'builtin' | 'custom'` — local state in PresetsPane. Default to `builtin`.

3. **Tab styling**: Use small pill/underline tabs matching the sidebar tab style. Keep the overall header compact.

### Files
- `src/components/PresetsPane.tsx` (tab UI, empty state)

---

## 10. Curves Point Tools (Black / White / Grey)

### Current State
- The Curves tab (Sidebar.tsx ~189–203) renders only the `CurvesControl` component — a draggable SVG curve editor with per-channel tabs (RGB / R / G / B).
- The existing black point and white point sliders live in the Adjust tab (Sidebar.tsx ~117–118) and control `settings.blackPoint` / `settings.whitePoint` (numeric 0–80 / 180–255 range). These are global tone-mapping parameters applied in the pipeline (`imagePipeline.ts:applyWhiteBlackPoint`).
- There is no eyedropper/picker tool for setting black, white, or grey point by clicking on the image.
- CurvesControl.tsx ends at line 181 with no content below the SVG besides the hint overlay.

### Target
- Below the curves editor, add three eyedropper tools: **Set Black Point**, **Set White Point**, and **Set Grey Point** (midtone/neutral balance).
- Each lets the user click a pixel on the image to calibrate that tonal anchor.

### Implementation

**A. UI — Point Picker Buttons**

1. **Add a row of three tool buttons below the `CurvesControl`** in the curves tab section (Sidebar.tsx ~201, after the `<CurvesControl />` call):
   ```tsx
   <div className="flex gap-2 mt-4">
     <button title="Set Black Point — click the darkest area" ...>
       <Pipette size={14} /> Black
     </button>
     <button title="Set Grey Point — click a neutral mid-tone" ...>
       <Pipette size={14} /> Grey
     </button>
     <button title="Set White Point — click the brightest area" ...>
       <Pipette size={14} /> White
     </button>
   </div>
   ```
   - Style each button with a subtle color accent: dark swatch for black, mid-grey for grey, white/light swatch for white.
   - When active (picking mode), highlight the active button (similar to the Film Base picker glow).
   - Only one picker can be active at a time. Clicking the same button again cancels.

2. **State**: Add `activePointPicker: 'black' | 'white' | 'grey' | null` to App.tsx (or lift from Sidebar via callback props).

**B. Canvas Click Handling**

1. When a point picker is active, the canvas enters picker mode (crosshair cursor, same pattern as `isPickingFilmBase`).
2. On click, sample the pixel at the clicked coordinate from the current preview:
   - **Black point**: Take the sampled pixel's luminance and set `settings.blackPoint` to that value (clamped to valid range 0–80). The idea: everything at or below this luminance becomes pure black.
   - **White point**: Take the sampled pixel's luminance and set `settings.whitePoint` to that value (clamped to 180–255). Everything at or above becomes pure white.
   - **Grey point**: This is a **neutral balance / color correction** tool. Take the sampled pixel's RGB values and compute per-channel correction factors to make that pixel neutral grey. Apply as curve adjustments or as a temperature/tint offset. Implementation options:
     - **Option 1 — Temperature/tint adjustment**: Compute the color cast of the sampled pixel relative to neutral and adjust `settings.temperature` and `settings.tint` to compensate.
     - **Option 2 — Curves midpoint shift**: For each channel, shift the curve midpoint so the sampled value maps to 128 (middle grey). This is more precise but modifies the curves data.
     - **Recommended**: Option 1 (temperature/tint) is simpler and more intuitive for users.
3. After sampling, deactivate the picker (`activePointPicker = null`), trigger a re-render.

**C. Props and Wiring**

1. Sidebar.tsx needs new props: `activePointPicker`, `onSetPointPicker: (mode: 'black' | 'white' | 'grey' | null) => void`.
2. App.tsx holds `activePointPicker` state, passes it to Sidebar for button highlighting and to the canvas for click interception.
3. The canvas `onClick` handler (or a new overlay handler) checks `activePointPicker` before `isPickingFilmBase`, samples the pixel, updates the relevant setting via `updateDocument`, and clears the picker.

**D. Pipeline Considerations**

- Black and white point already exist in the pipeline (`imagePipeline.ts:applyWhiteBlackPoint`). The picker just sets their values by sampling.
- Grey point is new behavior. If using temperature/tint: these settings already exist in `ConversionSettings` and are applied in the pipeline. The picker computes the correction and writes to those fields.
- Ensure the sampled pixel is read from the **inverted + film-base-compensated** image (post-inversion, pre-tone-mapping), so the picked values correspond to the tone range the black/white point sliders operate on.

### Files
- `src/components/Sidebar.tsx` (point picker buttons below curves)
- `src/App.tsx` (picker state, canvas click handler, pixel sampling logic)
- Possibly `src/utils/imagePipeline.ts` (if grey point needs a new correction path)
- `src/types.ts` (if grey point introduces new settings fields)

---

## Implementation Order

Suggested order based on complexity and dependencies:

| Order | Item | Effort | Notes |
|-------|------|--------|-------|
| 1 | Film Base compactness (#7) | Small | Single element removal + icon add |
| 2 | Status bar readability (#6) | Small | Formatting + chip cleanup |
| 3 | Before/After dedup (#4) | Small | Remove chip, tweak tooltip |
| 4 | Histogram legend (#5) | Small | Add legend row + axis markers |
| 5 | Export flow (#2) | Small | Add button + thread props |
| 6 | Reset safeguard (#3) | Small–Med | Make undoable via updateDocument path |
| 7 | Custom presets tabs (#9) | Medium | Tab UI + empty state |
| 8 | Crop UX clarity (#8) | Medium | Buttons + auto-show overlay logic |
| 9 | Curves point tools (#10) | Medium–Large | Picker UI + canvas sampling + grey point |
| 10 | Settings modal (#1) | Large | New modal component + Tauri integration |

Items 1–5 are quick wins. Items 6–8 are medium effort. Items 9–10 are the most substantial — the Settings modal becomes the home for future preferences (Phase 6) so it's worth getting right, and the curves point tools involve canvas interaction + pipeline work.
