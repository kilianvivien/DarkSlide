# DarkSlide

<div align="center">
  <p>Turn your film negatives into beautiful positives — right in your browser or as a desktop app.</p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide Screenshot" width="800" />
</div>

## What is DarkSlide?

DarkSlide is a free, open-source tool for converting scanned film negatives into positive images. Whether you shoot 35mm, 120, or large format — just scan your negatives, drop them into DarkSlide, and start editing. No subscription, no cloud upload, everything stays on your machine.

## Features

### Convert & Edit
- **Instant negative-to-positive conversion** with real-time preview
- **Film stock profiles** — built-in color and black & white stocks to match the look of popular films
- **Full editing controls** — exposure, contrast, saturation, temperature, tint, curves, black & white points, and highlight protection
- **Black & white mode** with per-channel luminance mixing for fine-tuned tonal control
- **Sharpening & noise reduction** to clean up your scans

### Organize & Export
- **Work on multiple images at once** with tabbed documents
- **Batch export** — convert a whole roll with one click, optionally applying a preset to every frame
- **Contact sheet generation** — create a grid overview of your scans
- **Save and share presets** — create custom looks and export/import them as `.darkslide` files
- **Searchable preset browser** for quick access

### Crop & Compose
- **Non-destructive crop** with common film format ratios (3:2, 4:5, 1:1, 6x7, etc.)
- **Zoom & pan** for checking fine details
- **Before/after comparison** to see your edits side by side
- **Live histogram** with per-channel display

### Desktop App (macOS)
- **RAW file support** — open DNG, CR3, NEF, ARW, RAF, and RW2 files directly (desktop only)
- **Native file dialogs** for a smoother experience
- **Open in external editor** — send your image to Photoshop, Affinity Photo, or any other app

> DarkSlide also works entirely in the browser — no install needed. The desktop app adds RAW support and native OS integration.

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
