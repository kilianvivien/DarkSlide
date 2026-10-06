# DarkSlide

<div align="center">
  <p>A free, open-source film negative converter for the browser and desktop.</p>
  <p><strong><a href="https://darkslide.vercel.app">Try it in your browser →</a></strong> · <a href="https://github.com/kilianvivien/DarkSlide/releases/latest">Download the desktop app</a></p>
  <img src="./.github/assets/screenshot.png" alt="DarkSlide film negative editor" width="800" />
</div>

Turn scanned color and black & white negatives into positive images, from a single frame to a whole roll. Edit non-destructively with a live preview, then export finished images or contact sheets. Processing stays on your machine, with no cloud upload or subscription.

## What you can do

- **Convert and fine-tune** — film stock profiles, film-base compensation, auto white balance, exposure, contrast, temperature, tint, saturation, curves, and black & white channel mixing.
- **Crop and straighten** — common film ratios, automatic frame detection, reference-line leveling, and crop stabilization across a roll.
- **Repair scans** — manual dust, hair, and scratch repair, plus automatic defect detection *(beta; review marks before exporting)*. Sharpening and noise reduction help finish the image.
- **Work through a roll** — import files or folders, browse frames in the filmstrip, and sync a look across selected frames while keeping their individual crops and repairs.
- **Save and share looks** — organize custom presets, exchange `.darkslide` files, and import or export `.cube` LUTs.
- **Export your results** — save individual frames or selections, batch-convert unopened files with a shared recipe, and create contact sheets. Export JPEG, WebP, PNG, or TIFF, including 16-bit PNG and TIFF output.
- **Inspect your edits** — cursor-anchored zoom, before/after comparison, and a live histogram with channel and clipping controls.

The browser supports **TIFF, JPEG, PNG, and WebP** scans. The desktop app also opens **RAW camera scans** (including DNG, CR3, NEF, ARW, RAF, and RW2) and adds native file dialogs, external-editor integration, and update notifications.

## Latest release — v1.3.0

- Redesigned editor with a tool rail, unified inspector, and filmstrip for working across frames.
- Improved RAW negative conversion, exposure and white balance in linear light, and highlight color preservation.
- Rebuilt automatic dust detection *(beta)* and live contact sheet previews.

See the [full release notes](https://github.com/kilianvivien/DarkSlide/releases/tag/v1.3.0) for details.

## Get started

[Open the web app](https://darkslide.vercel.app) or download an installer from the [latest release](https://github.com/kilianvivien/DarkSlide/releases/latest):

- **macOS:** universal `.dmg` for Apple Silicon and Intel.
- **Windows:** `.msi` or `.exe` *(experimental)*.
- **Linux:** `.deb` or `.AppImage` *(experimental)*.

Desktop builds are unsigned; Windows and Linux builds are not yet production-tested. On macOS, move the app to Applications and try opening it once, then go to **System Settings → Privacy & Security → Open Anyway** to allow the non-notarized app.

## Run from source

Requires Node.js; desktop development also requires [Rust & Cargo](https://rustup.rs/).

```bash
git clone https://github.com/kilianvivien/DarkSlide.git
cd DarkSlide
npm install
npm run dev           # browser app on http://localhost:3000
npm run tauri:dev     # desktop app
```

```bash
npm run build         # web production build → dist/
npm run tauri:build   # desktop production build
npm run typecheck
npm run lint
npm run test
```

Built with React 19, TypeScript, Vite, Tailwind CSS, and Tauri. Image processing uses Web Workers and WebGPU with a CPU fallback.

## Acknowledgements

Thanks to [tdurieux](https://github.com/tdurieux) for contributions to the editor redesign, crop tools, histogram, RAW imports, and color-accuracy tooling, and to the projects that power DarkSlide:

| Project | License |
|---|---|
| [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), [Motion](https://motion.dev/), [UTIF.js](https://github.com/photopea/UTIF.js) | MIT |
| [Tauri](https://tauri.app/) | MIT / Apache-2.0 |
| [Lucide](https://lucide.dev/) | ISC |
| [rawler](https://github.com/dnglab/dnglab) | LGPL-2.1 |

The 126-format test image in [evaluation/online-samples](./evaluation/online-samples/README.md) is derived from a Wikimedia Commons photograph by Bigbear213 and licensed separately under CC BY-SA 4.0.

## License

[MIT](./LICENSE).
