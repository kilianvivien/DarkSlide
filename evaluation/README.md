# Measuring DarkSlide color accuracy

DarkSlide now has a repeatable CIEDE2000 evaluation tool. It measures an exported image against known D50 Lab target values and reports overall, neutral, and per-patch errors. This is separate from the synthetic fixtures in `src/test/fixtures/reference`: those catch code regressions, while this procedure measures real photographic accuracy.

The tool does not manufacture an accuracy score. A useful result still requires a physical target, a controlled film capture, and traceable reference measurements.

## What to capture

Use a ColorChecker, IT8 target, or comparable target with measured Lab or spectral data for that specific chart. Record its serial or lot number and the source of its D50, 2-degree-observer reference data. Generic chart values are adequate for developing the harness, but not for a product accuracy claim: physical targets vary and age.

Make the target fill enough of the film frame that every patch has many clean pixels. Light it evenly with a stable, high-quality source and avoid glare. A D50-like source is convenient, but its measured spectrum and uniformity matter more than its label. Include a neutral card and an area of unexposed film rebate.

For each film and development process under test:

1. Photograph the target at nominal exposure and at -2, -1, +1, and +2 EV on the same roll.
2. Record film stock, emulsion or batch when available, developer, process, temperature, time, and lab.
3. Reserve different frames or rolls for profile fitting and final validation. Fitting and scoring the same capture only measures overfitting.
4. Add real skin, foliage, and mixed-color scenes for visual review, but do not use them as numerical ground truth unless their colors were measured.

## Camera-scanning controls

Hold the scanning system fixed for the complete comparison:

- RAW capture, fixed ISO, fixed aperture, manual focus, and manual exposure.
- One camera, lens, light source, distance, mask, and alignment.
- Exposure high enough to use the sensor range without clipping any channel.
- No automatic camera white balance, picture style, dynamic-range feature, or in-camera correction.
- A blank-light flat-field frame and an unexposed film-base frame for diagnosing illumination and base-removal errors.
- Warm-up time for the backlight and a check that the frame is evenly illuminated.

Change one variable at a time. If DarkSlide, another converter, and a lab scan use different crops or input captures, their scores are not directly comparable.

## DarkSlide export

Create two named runs instead of tuning until the chart looks good:

- **Automatic:** default or auto film-base handling with the selected stock profile.
- **Locked:** a manually sampled film base with all values fixed across the exposure bracket.

Disable creative looks, local edits, and output sharpening. Export the complete chart as an 8-bit sRGB TIFF. Eight-bit output is sufficient for this patch-level test; retain a higher-bit master separately if the workflow supports it.

Define a `sampleRect` for the central 50–60% of every patch. Rectangles use normalized `[x, y, width, height]` coordinates. Avoid borders, dust, scratches, glare, and printed markings. The evaluator averages samples in linear light before converting them to D50 Lab.

Example dataset fragment:

```json
{
  "$schema": "./color-accuracy.schema.json",
  "schemaVersion": 1,
  "id": "portra400-chart01-normal",
  "description": "Held-out ColorChecker validation frame at nominal exposure",
  "referenceWhite": "D50",
  "referenceObserver": "2-degree",
  "capture": {
    "target": "ColorChecker Classic",
    "targetSerial": "replace-with-target-serial",
    "referenceDataSource": "measurement file name or published source",
    "filmStock": "Kodak Portra 400",
    "development": "C-41 lab and batch identifier",
    "camera": "camera body and capture settings",
    "lens": "lens, aperture, and distance",
    "backlight": "model, brightness, and warm-up time",
    "darkslideVersion": "1.2.2",
    "profileId": "profile identifier",
    "profileVersion": 1,
    "profileIntent": "technical",
    "filmBaseMode": "locked",
    "settingsSource": "profile-defaults",
    "settingsSnapshot": {},
    "lightSourceId": null,
    "labStyleId": null,
    "exposureBracketEv": 0
  },
  "patches": [
    {
      "id": "dark-skin",
      "name": "Dark skin",
      "category": "skin",
      "referenceLab": [0, 0, 0],
      "sampleRect": [0.08, 0.12, 0.07, 0.08]
    }
  ]
}
```

Replace the zero reference with the target's measured D50 Lab value. Validate the complete file against [`color-accuracy.schema.json`](./color-accuracy.schema.json).

Run the measurement:

```sh
npm run evaluate:color -- path/to/dataset.json --image path/to/darkslide-output.tif
```

Write a machine-readable report for CI or later analysis:

```sh
npm run evaluate:color -- path/to/dataset.json \
  --image path/to/darkslide-output.tif \
  --format json \
  --output path/to/report.json
```

The dataset can also contain `observedLab` or `observedSrgb` instead of rectangles. That is useful when a spectrophotometer or another trusted tool has already measured the output.

## Reading the report

The headline number is mean CIEDE2000 (`meanDeltaE00`), but it is not sufficient by itself. Always retain:

- median, 95th percentile, and maximum ΔE00;
- neutral-patch mean, which exposes film-base and white-balance errors;
- lightness, chroma, and hue components (hue is omitted for near-neutral patches, where hue angle is not meaningful);
- every per-patch result, film stock, exposure bracket, and processing mode.

Use thresholds only after collecting a baseline corpus. The evaluator has no default pass limit because a universal threshold would hide differences in target uncertainty, film variation, and intended rendering. A provisional engineering target such as mean ΔE00 ≤ 4, 95th percentile ≤ 8, and neutral mean ≤ 3 can guide initial work, but it is not a certification standard or a current DarkSlide claim.

For release comparisons, aggregate held-out results across at least three independently developed rolls, more than one common film stock, all five exposure brackets, and multiple camera-scanning sessions. Publish the individual reports along with the aggregate so regressions and outliers remain visible.

## Validating negative profiles

A named negative profile needs its own evidence. DarkSlide profiles combine adjustment defaults, film-base density balance, a color matrix, mask tuning, and tonal behavior. A score for Generic Color says nothing about Portra 400, Gold 200, or Superia 400.

For every stock under test, export the same held-out target frame twice:

1. Process it with Generic Color. This measures the inversion baseline.
2. Process it with the matching named profile at its defaults. This measures the profile's added value.

Keep the film-base mode, light-source profile, crop, and all other settings identical. Repeat both exports across the exposure bracket. A named technical profile should reduce mean and 95th-percentile ΔE00 relative to Generic Color without making the neutral patches worse. Do not include a mismatched stock and profile in the headline result.

Some profiles deliberately produce a strong look. LomoChrome Purple, redscale, and similar profiles should declare `profileIntent` as `creative`. CIEDE2000 can describe how far they move the chart, but a larger error is not a failure. Evaluate those profiles against a documented reference rendering and blinded visual comparisons instead. Reserve `technical` for profiles that claim to reconstruct the photographed scene accurately.

Record the profile version and complete settings snapshot for every report. DarkSlide currently uses versioned profiles, but a profile ID alone cannot reproduce a result after its matrix or defaults change.

## Comparing converters

Feed every converter the same RAW capture and export the same sRGB TIFF crop. Use its neutral/default negative conversion and document every setting. Compare automatic modes separately from manually profiled modes. A lab scan is a useful practical benchmark, but it is not absolute ground truth: the scanner profile and operator choices are part of its rendering.

The CIEDE2000 implementation is tested against all 34 [numerical reference pairs published by Sharma, Wu, and Dalal](https://www.ece.rochester.edu/~gsharma/ciede2000/ciede2000noteCRNA.pdf). Keep those formula tests, the real capture datasets, and DarkSlide's synthetic image-regression fixtures as three distinct layers of evidence.
