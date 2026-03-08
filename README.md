# DarkSlide

<div align="center">
  <p>A clean, hobbyist-friendly film negative converter as both a web app and a Tauri desktop binary.</p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide Screenshot" width="800" />
</div>

## ✨ Features

- **Blazing Fast Conversion**: Leverages an optimized Worker-backed imaging pipeline and **WebGPU Acceleration** for real-time blurs, noise reduction, and main conversion loops.
- **Precision Editing**: Float32 pipeline ensures edits are processed in normalized float space and only quantized upon final write-back, yielding professional-grade accuracy.
- **Cross-Platform Experience**: Available as a native desktop application powered by **Tauri**, complete with native file dialogues, while still maintaining full compatibility as a browser-based web app. 
- **Film Profiles & Presets**: Ships with a broad mix of color and black-and-white stocks. Edit per-slider with non-destructive undo/redo, auto-balance curves, highlight protection, sharpening, and built-in noise reduction.
- **Pro-Level UI Tools**: Custom toolkit with multi-level zoom capability, pan viewport, histogram, split-view comparison toggle, advanced non-destructive crop overlays, and persistent preferences.

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
- **Image Processing:** Web Workers, WebGPU Compute Shaders, UTIF (TIFF parsing)
- **UI & Animation:** Lucide React, Framer Motion

## 🗺 Roadmap

DarkSlide is continuously evolving. Some of the major phases include:

- ✅ **Phase 0-8:** Baseline stabilization, Worker-backed imaging, Better conversion quality, Tauri shell, Editing/UI polish, Float32 Color Negative Science, and **WebGPU** acceleration. 
- 🔜 **Phase 9 (RAW Import Pipeline):** Incorporating the `rawler` Rust crate for direct DNG, CR3, NEF, ARW, RAF, and RW2 imports via the Tauri Desktop App.
- 🔜 **Phase 10 (Pro Workflow):** Multi-document tabs for rolls of film, batch processing queue, and comprehensive ICC Color Management (P3 Retina XDR priority on macOS).

*See the `plan.md` file for full details on DarkSlide's roadmap and design specifics.*

## � Acknowledgements

DarkSlide is built on top of some amazing open-source projects:
- [React](https://react.dev/) - The library for web and native user interfaces.
- [Tauri](https://tauri.app/) - Build smaller, faster, and more secure desktop applications with a web frontend.
- [Vite](https://vitejs.dev/) - Next Generation Frontend Tooling.
- [Tailwind CSS](https://tailwindcss.com/) - A utility-first CSS framework for rapid UI development.
- [Lucide](https://lucide.dev/) - Beautiful & consistent icon toolkit.
- [Framer Motion](https://www.framer.com/motion/) - An open source motion library for React.
- [UTIF.js](https://github.com/photopea/UTIF.js) - Fast and advanced TIFF decoder.

## �📜 License

This project is licensed under the MIT License - see the [`LICENSE`](./LICENSE) file for details.
