# DarkSlide

<div align="center">
  <p>A clean, hobbyist-friendly film negative converter as both a web app and a Tauri desktop binary.</p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide Screenshot" width="800" />
</div>

## ✨ Features

- **Blazing Fast Conversion**: Optimized Worker-backed imaging pipeline with **WebGPU acceleration** for real-time blurs, noise reduction, and main conversion loops.
- **Precision Editing**: Float32 pipeline processes edits in normalized float space and quantizes only on final write-back — professional-grade color accuracy throughout.
- **RAW Import** *(desktop only)*: Native DNG, CR3, NEF, ARW, RAF, and RW2 decoding via the Tauri desktop app. Camera white-balance metadata pre-seeds the temperature/tint sliders; the browser build degrades gracefully with a clear "requires desktop app" notice.
- **Black & White Conversion**: Dedicated B&W layer with per-channel luminance-mix controls, layered on top of the full color pipeline for maximum tonal flexibility.
- **Film Profiles & Presets**: Ships with a broad mix of color and B&W stocks. Non-destructive undo/redo, auto-balance curves, highlight protection, sharpening, noise reduction, and importable/exportable `.darkslide` preset files.
- **Cross-Platform**: Native desktop app via **Tauri** (native file dialogs, RAW support) with full parity as a browser-based web app.
- **Pro-Level UI Tools**: Multi-level zoom, pan viewport, histogram, split-view before/after toggle, non-destructive crop with film-format ratio presets, and persistent preferences.

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (v18 or higher)
- [Rust & Cargo](https://rustup.rs/) (Required to build the Tauri desktop app)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/kilianvivien/DarkSlide.git
   cd DarkSlide
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   *(Note: You can also use `yarn` or `pnpm`)*

### Running the Application

**To run the Web App in development mode:**
```bash
npm run dev
```

**To run the Tauri Desktop App locally:**
```bash
npm run tauri:dev
```

## 📦 Building for Production

- **Build the Web App:**
  ```bash
  npm run build
  ```
- **Build the Tauri Desktop App:**
  ```bash
  npm run tauri:build
  ```

## 🛠 Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS (v4), TypeScript
- **Desktop Host:** Tauri, Rust
- **Image Processing:** Web Workers, WebGPU Compute Shaders, UTIF (TIFF parsing), rawler (RAW decoding)
- **UI & Animation:** Lucide React, Framer Motion

## 🗺 Roadmap

DarkSlide is continuously evolving. Some of the major phases include:

- ✅ **Phases 0–9:** Baseline stabilization, Worker-backed imaging, better conversion quality, Tauri shell, editing/UI polish, Float32 color negative science, **WebGPU** acceleration, RAW import pipeline (DNG/CR3/NEF/ARW/RAF/RW2), B&W conversion layer, film-format crop ratios, and importable/exportable preset files.
- 🔜 **Phase 10 (Render Performance):** Incremental render diffing, tile-based GPU dispatch, and progressive preview updates for large files.
- 🔜 **Phase 11 (Pro Workflow):** Multi-document tabs for rolls of film, batch processing queue, and comprehensive ICC Color Management (P3 Retina XDR priority on macOS).

*See the `plan.md` file for full details on DarkSlide's roadmap and design specifics.*

## 🙏 Acknowledgements

DarkSlide is built on top of some amazing open-source projects:
- [React](https://react.dev/) - The library for web and native user interfaces.
- [Tauri](https://tauri.app/) - Build smaller, faster, and more secure desktop applications with a web frontend.
- [Vite](https://vitejs.dev/) - Next Generation Frontend Tooling.
- [Tailwind CSS](https://tailwindcss.com/) - A utility-first CSS framework for rapid UI development.
- [Lucide](https://lucide.dev/) - Beautiful & consistent icon toolkit.
- [Framer Motion](https://www.framer.com/motion/) - An open source motion library for React.
- [UTIF.js](https://github.com/photopea/UTIF.js) - Fast and advanced TIFF decoder.
- [rawler](https://github.com/dnglab/dnglab) - Pure-Rust RAW image decoder supporting DNG, CR3, NEF, ARW, RAF, and RW2.

## 📜 License

This project is licensed under the MIT License - see the [`LICENSE`](./LICENSE) file for details.
