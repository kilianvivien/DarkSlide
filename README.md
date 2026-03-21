# DarkSlide

<div align="center">
  <p>A clean, hobbyist-friendly film negative converter as both a web app and a Tauri desktop binary.</p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide Screenshot" width="800" />
</div>

## ✨ Features

- **Blazing Fast Conversion**: Worker-backed imaging pipeline with **WebGPU acceleration** for real-time blurs, noise reduction, and the main per-pixel conversion loop.
- **Precision Editing**: Float32 pipeline processes edits in normalized float space and quantizes only on final write-back — professional-grade color accuracy throughout.
- **RAW Import** *(desktop only)*: Native DNG, CR3, NEF, ARW, RAF, and RW2 decoding via the Tauri desktop app. Camera white-balance metadata pre-seeds the temperature/tint sliders; the browser build degrades gracefully with a clear "requires desktop app" notice.
- **Black & White Conversion**: Dedicated B&W layer with per-channel luminance-mix controls, layered on top of the full color pipeline for maximum tonal flexibility.
- **Film Profiles & Presets**: Ships with a broad mix of color and B&W stocks. Non-destructive undo/redo, auto-balance curves, highlight protection, sharpening, noise reduction, and importable/exportable `.darkslide` preset files. Searchable preset pane for quick access by name.
- **Pro Workflow**: Multi-document tabs for working across a roll, batch export (with per-batch preset transforms), and contact sheet generation (RAW-aware). Open the current file directly in an external editor (Photoshop, Affinity Photo, etc.) from the toolbar. Export completion is confirmed with a toast notification.
- **Cross-Platform**: Native desktop app via **Tauri** (native file dialogs, RAW support, external editor integration) with full parity as a browser-based web app.
- **Pro-Level UI Tools**: Multi-level zoom, pan viewport, histogram, split-view before/after toggle, non-destructive crop with film-format ratio presets, and persistent preferences.

## ⚠️ macOS Installation Note

Pre-built macOS binaries are currently **not notarized**. macOS will block the app from opening by default. To run it:

1. Download and move the app to your Applications folder.
2. Try to open it — macOS will show a security warning and refuse.
3. Go to **System Settings → Privacy & Security**, scroll down, and click **"Open Anyway"** next to the DarkSlide entry.
4. Confirm in the follow-up dialog. The app will open normally from that point on.

> This only needs to be done once. Notarization is planned for a future release.

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

DarkSlide is continuously evolving. Here's where things stand:

- ✅ **Phases 0–2:** Baseline stabilization, Worker-backed imaging pipeline, and better conversion quality.
- ✅ **Phase 3:** Tauri desktop shell with native file dialogs and browser fallback.
- ✅ **Phases 4–6:** Editing polish (zoom/pan, film profiles, per-slider undo, sharpen/noise), UI polish, and beta product finish (persistent preferences, recent files, automated tests).
- ✅ **Phase 7:** Float32 color negative science — per-profile color matrices, tonal-character metadata, and synthetic ΔE validation.
- ✅ **Phase 8:** WebGPU-accelerated rendering (GPU blur, main conversion loop, histogram reduction, CPU fallback).
- ✅ **Phase 9:** RAW import (Tauri desktop), film-format crop ratios, and importable/exportable `.darkslide` preset files.
- ✅ **Phases 10–11:** Render performance (memoised components, reduced re-renders) and worker/memory hardening (split caches, bounded eviction).
- ✅ **Phase 12:** Pro workflow — multi-document tabs, batch export, contact sheet export, Open in External Editor, and Display P3 ICC profile recognition on import.
- ✅ **v0.3.1 polish:** Preset search, export toast notifications, per-batch preset transforms, RAW-aware contact sheets, and recent files capped at five entries.
- ✅ **Phase 13 / v0.4.0:** Architecture health — App.tsx decomposition into focused hooks, worker protocol type safety, error boundaries, and accessibility baseline. Settings modal redesign (sidebar nav, Export tab). Batch & Contact Sheet modal polish. Smooth zoom/pan with GPU-accelerated transforms, draft render path, render-target hysteresis, and deferred renders during pan.
- 🔜 **Phase 14:** Smart scanning features.
- 🔜 **Phase 15:** Conversion quality & minilab emulation.
- 🔜 **Phase 16:** Scanning workflow & productivity.

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
