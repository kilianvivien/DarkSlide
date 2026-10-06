# Imaging performance improvements

This change updates Rawler to 0.8, Tauri and its matching plugins to 2.12,
React to 19.3, and Vite to 8.3. The Vite browser target remains the previous
ES2020/Chrome 87/Safari 14 floor. CI uses Node 24. Rust requires 1.90 or newer.
The lockfiles are part of the change; image 0.25 and UTIF 3.1 remain in place.

## Changes

- Native RAW decode reuses one mapped source and decoder for image and metadata.
  It avoids the old metadata analyzer's dummy decode and whole-file hash.
  Camera-native encoding uses Rayon; little-endian IPC packing copies contiguous
  u16 bytes without serializing individual samples.
- The image worker receives the native RAW payload, performs flat-field correction,
  builds the preview, estimates film base and startup exposure, and keeps the
  original 16-bit samples. The React thread no longer scans all RAW pixels.
  Recovery retains a path and correction snapshot rather than a second full
  pixel buffer, and coalesces concurrent reopen requests. Native byte responses
  are normalized; WebKit buffers that cannot transfer have a clone fallback.
- Rust WebAssembly kernels handle high-depth geometry, per-pixel conversion,
  and flat-field correction inside the worker. Built-in profiles use the kernels;
  parsed ICC curves and cube LUTs retain the TypeScript reference path.
  Failed WASM loading uses the reference pipeline. Spatial noise reduction and
  sharpening retain their existing order. Large WASM instances are released after
  export because linear memory cannot shrink.
- Tone edits reuse immutable preview pixels and the GPU source upload. Worker
  epochs, document identities, geometry, and dust marks invalidate the relevant
  caches. Dust repair survives tone changes; analysis caches evict oldest entries.
- 16-bit PNG output streams compressed scanlines; TIFF output quantizes bounded
  row strips into Blob parts. Native folder saves use binary IPC rather than a
  JSON array of every byte. JPEG and 8-bit PNG retain browser-native encoding.
- Settings and batch dialogs load on first use and remain mounted afterward.
  Production main JavaScript is approximately 903 KB, with separate 47 KB settings
  and 31 KB batch chunks. The worker includes a separate 44 KB WASM asset.

## TIFF correctness

The supplied Pixelmator TIFF scans contain 8-bit Display P3 RGB with an embedded
profile. The old pipeline transformed the orange negative into sRGB before
inverting it. Out-of-gamut negative channels could clip at that stage, producing
an artificial blue band. Color negatives from Display P3 now invert in their
source primaries and transform the positive into the requested output profile.
Film-base sampling, analysis, TypeScript, Rust, and GPU parameters follow that
same order. sRGB/RAW, slides, LUT conversions, and monochrome profiles retain
their previous behavior.

The automatic base guard also detects a P3 estimate that suppresses two channels
across most of the frame while a surviving third channel hides the failure.
It falls back to the existing conservative bright-percentile reference rather
than changing a manually selected base or color balance. Img596 demonstrates
this case. The flag's flattened red was resolved by the user's lower contrast;
the contrast controls and defaults are unchanged.

The minaret TIFF still benefits from manual white balance and tone corrections.
Its rendered 8-bit source cannot be expected to match the camera-native NEF
exactly. This change does not apply a scan-specific color preset or claim to
recover data clipped while the TIFF was created.

## Measured results

Measurements on the repository's real scans on the development Mac:

| Work | Previous/reference | Updated | Result |
| --- | ---: | ---: | --- |
| Img1875 NEF native decode + binary packing, warm runs | 527–538 ms | 252–256 ms | about 2.1× faster |
| Img1647 NEF native decode + binary packing, warm runs | — | 255–256 ms | second real-file check |
| 24 MP Img1875 float color pipeline, Node TypeScript vs WASM | 8.28 s | 6.35 s | 1.30× faster, maximum sample error 0 |
| Img1875 TIFF decode | — | 356 ms | ICC recognized as Display P3 |

The native comparison combines the pipeline changes and the Rawler upgrade;
it does not isolate the upgrade alone. The old implementation was reproduced
in a temporary Rawler 0.7.2 crate with current compatible transitive dependencies.
RAW demosaic samples intentionally differ: Rawler 0.8 fixes PPG artifact math.
Approximately 36.4% of sensor RGB samples differ, with mean absolute difference
98.2 out of 65535. Dimensions and orientation agree. A zero-error claim applies
to TypeScript/WASM processing of the *same* decoded input, not old/new demosaic.
These stage timings are not whole-app latency predictions.

## Reproduce

The generated WASM asset is checked in so normal web builds do not need Cargo.
After changing the Rust kernels, rebuild and run parity tests:

```sh
rustup target add wasm32-unknown-unknown
npm run build:kernels
npm run test -- src/utils/imageKernels.test.ts
cargo test --locked --manifest-path image-kernels/Cargo.toml
```

CI rebuilds the kernels before type checking and JavaScript tests so source and
binary cannot silently drift. The module has no third-party Rust dependencies.

To measure native RAW stages and save the exact worker payload:

```sh
cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
  --example raw_performance -- Resources/Realscans/Img1875.nef /tmp/darkslide-Img1875.rawipc
```

To compare the full-resolution reference and Rust processing and inspect TIFF
metadata, run the opt-in test (skipped in the normal suite):

```sh
DARKSLIDE_PERFORMANCE_RAW=/tmp/darkslide-Img1875.rawipc \
DARKSLIDE_PERFORMANCE_TIFF=Resources/Realscans/Img1875.tiff \
npm run test -- --reporter=verbose src/utils/performance.test.ts
```

The regular tests cover 16-bit flat-field parity, built-in input/output profiles,
negative/slide and B&W processing, geometry edges, PNG decompression and TIFF
byte parity, RAW ownership/recovery, transfer fallback, dust cache invalidation,
and GPU upload reuse. Verify the native app too: import a real NEF, adjust tone,
and export 16-bit TIFF/PNG; browser mocks cannot validate WebKit IPC behavior.

## Verification in this checkout

Type checking, ESLint, 923 JavaScript tests (plus one intentionally skipped
opt-in benchmark), 12 native tests, two kernel tests, production web build, and
macOS app bundling passed. The rebuilt desktop app imported Img1875.nef and
saved a 6048 × 4032 TIFF with 16 bits per channel and a 516-byte ICC profile.
Automatic native folder saving has unit coverage; its separate desktop UI
smoke check was not completed before the requested wrap-up.
