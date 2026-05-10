# DarkSlide

<div align="center">
  <p>Turn your film negatives into beautiful positives — right in your browser or as a desktop app.</p>
  <p><strong><a href="https://darkslide.vercel.app">Try the live demo →</a></strong> — no install required</p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide Screenshot" width="800" />
</div>

## What is DarkSlide?

DarkSlide is a free, open-source tool for converting scanned film negatives into positive images. Whether you shoot 35mm, 120, or large format — just scan your negatives, drop them into DarkSlide, and start editing. No subscription, no cloud upload, everything stays on your machine.

## What's New in v0.9.0

- **Auto dust/hair/scratch removal — major overhaul**
  - **Full-length hair coverage** — the inpainter now measures each defect's width along its path and covers the full visible width, instead of leaving thin residual streaks along long hairs and scratches
  - **Grain-preserving repair** — path repairs now copy texture from a parallel donor strip (structure + texture decomposition), so film grain stays intact instead of getting replaced by a blurred patch
  - **Fewer false positives on grainy scans** — new texture vetoes (per-component noise-floor check + stricter peak isolation on the fallback detector) keep grain-only "peaks" from being flagged as dust
  - **Better faint and curved scratch detection** — a Hessian-based line-likeness map complements the orientation filter for low-contrast and non-straight defects
- **Polish & reliability**
  - **Visible error toasts** — image worker failures, import errors, and export failures now surface as bottom-right toasts with a copy-able diagnostic ID, instead of disappearing silently into the diagnostics log
  - **Color-profile safety** — exports now abort loudly with a clear error if an ICC profile is malformed or a transform can't be built, rather than silently producing a color-corrupt file with the wrong embedded profile
  - **Modal accessibility** — every modal (Settings, Batch, Contact Sheet, Roll Info) now closes with Escape, identifies itself to screen readers as a `dialog`, and only the topmost modal consumes Escape so nested dialogs stack correctly

### Earlier in v0.8.3

- **Corrected 6×4.5 crop preset** — the medium-format 6×4.5 preset now uses the nominal 6 cm × 4.5 cm frame ratio in both landscape and portrait orientations

### Earlier in v0.8.2

- **RAW import fixes** — fixed a startup crash when opening RAW files before any image was loaded, and duplicate tab creation on import
- **Fixed preset auto-apply on RAW imports** — presets now apply correctly on RAW files, with import settings propagating as expected
- **Removed flat-field correction** — the feature added complexity with no meaningful real-world benefit
- **Removed H&D inversion pipeline** — simplifies the conversion pipeline and removes an under-used code path

### Earlier in v0.8.0

- **Film base preserved on profile switch** — switching film stock profiles no longer discards the scan's film base sample or resets the inversion method, so colors stay consistent as you browse profiles
- **Improved density balance and base correction** — profile-based density balance is more accurate, especially for RAW imports with per-channel base estimation
- **Redesigned Dust pane** — cleaner layout with improved repair quality
- **Better dust & hair detection** — auto-marking is more reliable and visible in the viewer

## Features

### Convert & Edit
- **Instant negative-to-positive conversion** with real-time preview
- **Film stock profiles** — 40+ built-in color and black & white stocks to match the look of popular films
- **Full editing controls** — exposure, contrast, saturation, temperature, tint, curves, black & white points, and highlight protection
- **Black & white mode** with per-channel luminance mixing for fine-tuned tonal control
- **Sharpening & noise reduction** to clean up your scans

### Organize & Export
- **Roll management** — group frames into rolls with film stock metadata and a sidebar filmstrip
- **Scanning sessions** — live folder watch that imports frames as your scanner writes them (desktop only)
- **Work on multiple images at once** with tabbed documents
- **Batch export** — convert a whole roll with one click, optionally applying a preset to every frame
- **Contact sheet generation** — create a grid overview of your scans
- **Save and share presets** — create custom looks, organize them in folders, and export/import as `.darkslide` files
- **Searchable preset browser** with sorting and tag display

### Dust & Scratch Removal
- **Manual repair** — paint over dust spots, hairs, and scratches; DarkSlide fills them in using surrounding pixels
- **Auto-detect mode** — automatically marks likely defects across the image so you can review and remove them in one step *(experimental — results may vary depending on scan quality and film type)*

### Crop & Compose
- **Non-destructive crop** with common film format ratios (3:2, 4:5, 1:1, 6x7, etc.)
- **Zoom & pan** for checking fine details
- **Before/after comparison** to see your edits side by side
- **Live histogram** with per-channel display

### Desktop App
- **RAW file support** — open DNG, CR3, NEF, ARW, RAF, and RW2 files directly (desktop only)
- **Native file dialogs** for a smoother experience
- **Open in external editor** — send your image to Photoshop, Affinity Photo, or any other app
- **Auto-update notifications** — get notified when a new version is available

**macOS** builds are universal binaries — native on both Apple Silicon and Intel Macs.

**Windows & Linux** experimental builds are available starting with v0.6.0. Unsigned and not yet production-tested — feedback welcome.

> DarkSlide also works entirely in the browser — no install needed. The desktop app adds RAW support, scanning sessions, and native OS integration.

## macOS Installation Note

Pre-built macOS binaries are currently **not notarized**. macOS will block the app on first launch:

1. Download and move the app to your Applications folder.
2. Try to open it — macOS will show a security warning.
3. Go to **System Settings → Privacy & Security** and click **"Open Anyway"**.
4. Confirm the dialog. It will open normally from then on.

> This only needs to be done once.

## Getting Started

### Install the desktop app

Download the latest `.dmg` installer from the [Releases](https://github.com/kilianvivien/DarkSlide/releases) page — no build step required.

### Run from source (browser)


```bash
git clone https://github.com/kilianvivien/DarkSlide.git
cd DarkSlide
npm install
npm run dev
```

### Run the desktop app

Requires [Rust & Cargo](https://rustup.rs/) in addition to Node.js.

```bash
npm run tauri:dev
```

### Build for production

```bash
npm run build          # web app → dist/
npm run tauri:build    # desktop app
```

## Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS v4, TypeScript
- **Desktop:** Tauri (Rust)
- **Image Processing:** Web Workers, WebGPU (with CPU fallback), UTIF, rawler
- **UI:** Lucide icons, Framer Motion

## 🙏 Acknowledgements

DarkSlide is built on top of some amazing open-source projects:

| Library | License | Description |
|---|---|---|
| [React](https://react.dev/) | MIT | UI library |
| [Tauri](https://tauri.app/) | MIT / Apache-2.0 | Desktop application framework |
| [Vite](https://vitejs.dev/) | MIT | Frontend build tooling |
| [Tailwind CSS](https://tailwindcss.com/) | MIT | Utility-first CSS framework |
| [Lucide](https://lucide.dev/) | ISC | Icon toolkit |
| [Framer Motion](https://www.framer.com/motion/) | MIT | Animation library for React |
| [UTIF.js](https://github.com/photopea/UTIF.js) | MIT | Fast TIFF decoder |
| [rawler](https://github.com/dnglab/dnglab) | LGPL-2.1 | Pure-Rust RAW image decoder |

## 📜 License

This project is licensed under the MIT License - see the [`LICENSE`](./LICENSE) file for details.
