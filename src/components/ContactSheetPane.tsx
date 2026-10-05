import { memo, useRef } from 'react';
import { Download, FileImage, FolderOpen, LayoutGrid, Loader2, Minus, Palette, Plus, Settings2, X } from 'lucide-react';
import { ContactSheetController } from '../hooks/useContactSheet';
import { getColorProfileDescription } from '../utils/colorProfiles';
import { CONTACT_SHEET_MAX_COLUMNS, ContactSheetCellSize } from '../utils/contactSheetLayout';
import { isDesktopShell } from '../utils/fileBridge';
import { ColorProfileId } from '../types';
import { Slider } from './Slider';
import { FIELD_LABEL, PANEL_BUTTON, SECTION_TITLE, SEGMENT_TRACK, SELECT_INPUT, segmentItem } from './ui';

const CELL_SIZES: Array<{ label: string; value: ContactSheetCellSize }> = [
  { label: 'Small', value: 256 },
  { label: 'Medium', value: 512 },
  { label: 'Large', value: 1024 },
];

const BACKGROUNDS = [
  { label: 'Black', value: '#000000' },
  { label: 'Charcoal', value: '#111111' },
  { label: 'Grey', value: '#3f3f46' },
  { label: 'White', value: '#ffffff' },
];

const OUTPUT_PROFILES: ColorProfileId[] = ['srgb', 'display-p3', 'adobe-rgb', 'linear'];

const CHECKBOX_ROW = 'flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300';

interface ContactSheetPaneProps {
  sheet: ContactSheetController;
}

/** Inspector panel of the Contact sheet tool. The canvas shows the sheet it builds. */
export const ContactSheetPane = memo(function ContactSheetPane({ sheet }: ContactSheetPaneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const desktopShell = isDesktopShell();
  const { layout, setLayout } = sheet;
  const busy = sheet.isGenerating;
  const isCustomBackground = !BACKGROUNDS.some((swatch) => swatch.value === layout.background.toLowerCase());

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        <div className="space-y-7 px-5 py-5">
          <section>
            <h2 className={SECTION_TITLE}>
              <LayoutGrid size={12} /> Frames
            </h2>
            <div role="radiogroup" aria-label="Contact sheet source" className={`${SEGMENT_TRACK} grid-cols-2`}>
              {([
                { id: 'frames', label: 'Open frames' },
                { id: 'files', label: sheet.files.length > 0 ? `Files (${sheet.files.length})` : 'Files' },
              ] as const).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={sheet.source === option.id}
                  disabled={busy}
                  onClick={() => sheet.setSource(option.id)}
                  className={segmentItem(sheet.source === option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {sheet.source === 'frames' ? (
              <div className="mt-2.5 space-y-2">
                <div role="radiogroup" aria-label="Frames on the sheet" className={`${SEGMENT_TRACK} grid-cols-2`}>
                  {([
                    { id: 'selected', label: `Selected${sheet.selectedCount > 1 ? ` (${sheet.selectedCount})` : ''}`, disabled: sheet.selectedCount < 2 },
                    { id: 'all', label: `All (${sheet.frameCount})`, disabled: false },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={sheet.scope === option.id}
                      disabled={option.disabled || busy}
                      onClick={() => sheet.setScope(option.id)}
                      className={segmentItem(sheet.scope === option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] leading-snug text-zinc-500">
                  Each frame keeps its own look. ⌘/Ctrl-click frames in the filmstrip to pick a few.
                </p>
              </div>
            ) : (
              <div className="mt-2.5 space-y-2">
                {sheet.files.length > 0 && (
                  <ul aria-label="Files on the sheet" className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-1 custom-scrollbar">
                    {sheet.files.map((entry) => (
                      <li key={entry.id} className="group flex items-center gap-2 rounded-md py-1 pl-2 pr-1 text-[12px] text-zinc-300 hover:bg-zinc-800/60">
                        <FileImage size={12} className="shrink-0 text-zinc-600" />
                        <span className="min-w-0 flex-1 truncate">{entry.filename}</span>
                        <button
                          type="button"
                          onClick={() => sheet.removeFile(entry.id)}
                          disabled={busy}
                          aria-label={`Remove ${entry.filename}`}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <X size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={`grid gap-1.5 ${desktopShell ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (desktopShell ? void sheet.addFiles() : fileInputRef.current?.click())}
                    className={`${PANEL_BUTTON} px-3 py-2 text-[12px]`}
                  >
                    <Plus size={13} /> Add files
                  </button>
                  {desktopShell && (
                    <button type="button" disabled={busy} onClick={() => void sheet.addFolder()} className={`${PANEL_BUTTON} px-3 py-2 text-[12px]`}>
                      <FolderOpen size={13} /> Add folder
                    </button>
                  )}
                </div>
                {!desktopShell && (
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                    className="hidden"
                    onChange={(event) => {
                      sheet.addBrowserFiles(Array.from(event.target.files ?? []));
                      event.target.value = '';
                    }}
                  />
                )}
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] leading-snug text-zinc-500">
                    Files are not opened. They take the look of the frame you are editing, without its crop.
                  </p>
                  {sheet.files.length > 0 && (
                    <button
                      type="button"
                      onClick={sheet.clearFiles}
                      disabled={busy}
                      className="shrink-0 text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <section>
            <h2 className={SECTION_TITLE}>
              <Settings2 size={12} /> Layout
            </h2>
            <div className="mb-3 flex items-center justify-between">
              <span className={FIELD_LABEL}>Columns</span>
              <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-900/60">
                <button
                  type="button"
                  aria-label="Fewer columns"
                  onClick={() => setLayout({ columns: Math.max(1, layout.columns - 1) })}
                  disabled={layout.columns <= 1}
                  className="grid h-7 w-7 place-items-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-30"
                >
                  <Minus size={12} />
                </button>
                <span aria-live="polite" className="w-7 text-center font-mono text-[12px] tabular-nums text-zinc-100">{layout.columns}</span>
                <button
                  type="button"
                  aria-label="More columns"
                  onClick={() => setLayout({ columns: Math.min(CONTACT_SHEET_MAX_COLUMNS, layout.columns + 1) })}
                  disabled={layout.columns >= CONTACT_SHEET_MAX_COLUMNS}
                  className="grid h-7 w-7 place-items-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-30"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <p className={`mb-1.5 ${FIELD_LABEL}`}>Cell Size</p>
            <div role="radiogroup" aria-label="Cell size" className={`${SEGMENT_TRACK} mb-3 grid-cols-3`}>
              {CELL_SIZES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={layout.cellMaxDimension === option.value}
                  onClick={() => setLayout({ cellMaxDimension: option.value })}
                  className={segmentItem(layout.cellMaxDimension === option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Slider label="Margin" value={layout.margin} min={0} max={64} unit="px" onChange={(margin) => setLayout({ margin })} />
          </section>

          <section>
            <h2 className={SECTION_TITLE}>
              <Palette size={12} /> Appearance
            </h2>
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className={FIELD_LABEL}>Background</span>
              <div role="radiogroup" aria-label="Background" className="flex items-center gap-1.5">
                {BACKGROUNDS.map((swatch) => {
                  const active = layout.background.toLowerCase() === swatch.value;
                  return (
                    <button
                      key={swatch.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={swatch.label}
                      data-tip={swatch.label}
                      onClick={() => setLayout({ background: swatch.value })}
                      className={`h-6 w-6 rounded-full border transition-shadow ${active ? 'border-transparent ring-2 ring-accent-400 ring-offset-2 ring-offset-zinc-950' : 'border-zinc-700 hover:border-zinc-500'}`}
                      style={{ backgroundColor: swatch.value }}
                    />
                  );
                })}
                <label
                  data-tip="Custom color"
                  className={`relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border transition-shadow ${isCustomBackground ? 'border-transparent ring-2 ring-accent-400 ring-offset-2 ring-offset-zinc-950' : 'border-zinc-700 hover:border-zinc-500'}`}
                  style={{ background: isCustomBackground ? layout.background : 'conic-gradient(#f87171, #facc15, #4ade80, #38bdf8, #a78bfa, #f87171)' }}
                >
                  <span className="sr-only">Custom background color</span>
                  <input
                    type="color"
                    value={layout.background}
                    onChange={(event) => setLayout({ background: event.target.value })}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>
            </div>
            <label className={`${CHECKBOX_ROW} mb-3`}>
              <input type="checkbox" checked={layout.showCaptions} onChange={(event) => setLayout({ showCaptions: event.target.checked })} />
              Show file names
            </label>
            {layout.showCaptions && (
              <Slider label="Caption Size" value={layout.captionFontSize} min={12} max={24} unit="px" onChange={(captionFontSize) => setLayout({ captionFontSize })} />
            )}
          </section>

          <section>
            <h2 className={SECTION_TITLE}>
              <Download size={12} /> Output
            </h2>
            <div role="radiogroup" aria-label="Contact sheet format" className={`${SEGMENT_TRACK} mb-3 grid-cols-2`}>
              {(['image/jpeg', 'image/png'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  role="radio"
                  aria-checked={layout.format === format}
                  onClick={() => setLayout({ format })}
                  className={segmentItem(layout.format === format)}
                >
                  {format === 'image/jpeg' ? 'JPEG' : 'PNG'}
                </button>
              ))}
            </div>
            {layout.format === 'image/jpeg' && (
              <Slider
                label="Quality"
                value={Math.round(layout.quality * 100)}
                min={10}
                max={100}
                unit="%"
                onChange={(quality) => setLayout({ quality: quality / 100 })}
              />
            )}
            <div className="mb-3 grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2">
              <label htmlFor="contact-sheet-filename" className={FIELD_LABEL}>Filename</label>
              <input
                id="contact-sheet-filename"
                type="text"
                value={layout.filenameBase}
                onChange={(event) => setLayout({ filenameBase: event.target.value })}
                className={`${SELECT_INPUT} py-1.5`}
              />
              <label htmlFor="contact-sheet-profile" className={FIELD_LABEL}>Output Profile</label>
              <select
                id="contact-sheet-profile"
                value={layout.outputProfileId}
                onChange={(event) => setLayout({ outputProfileId: event.target.value as ColorProfileId })}
                className={`${SELECT_INPUT} py-1.5`}
              >
                {OUTPUT_PROFILES.map((profileId) => (
                  <option key={profileId} value={profileId}>{getColorProfileDescription(profileId)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className={CHECKBOX_ROW}>
                <input type="checkbox" checked={layout.embedOutputProfile} onChange={(event) => setLayout({ embedOutputProfile: event.target.checked })} />
                Embed ICC profile
              </label>
              <label className={CHECKBOX_ROW}>
                <input type="checkbox" checked={layout.embedMetadata} onChange={(event) => setLayout({ embedMetadata: event.target.checked })} />
                Embed metadata
              </label>
            </div>
          </section>
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-t border-zinc-800 bg-zinc-950 px-5 py-4">
        {sheet.error && (
          <p role="alert" className="text-[11px] leading-snug text-red-400">{sheet.error}</p>
        )}
        <button
          type="button"
          onClick={() => void sheet.generate()}
          disabled={busy || sheet.cells.length === 0}
          aria-busy={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-black/20 transition-colors hover:bg-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="shrink-0 animate-spin" /> : <Download size={15} className="shrink-0" />}
          <span className="whitespace-nowrap">
            {busy
              ? 'Building sheet…'
              : sheet.cells.length === 0
                ? (sheet.source === 'files' ? 'Add files to lay out' : 'No frames to lay out')
                : `Export sheet of ${sheet.cells.length} ${sheet.cells.length === 1 ? 'frame' : 'frames'}`}
          </span>
        </button>
      </div>
    </div>
  );
});
