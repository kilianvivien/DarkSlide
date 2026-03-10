struct Uniforms {
  processMode: f32,
  isColor: f32,
  bwEnabled: f32,
  _pad1: f32,

  exposureFactor: f32,
  contrastFactor: f32,
  saturationFactor: f32,
  _pad2: f32,

  filmBaseR: f32,
  filmBaseG: f32,
  filmBaseB: f32,
  _pad3: f32,

  chanBalR: f32,
  chanBalG: f32,
  chanBalB: f32,
  _pad4: f32,

  tempShift: f32,
  tintShift: f32,
  blackPoint: f32,
  whitePoint: f32,

  highlightProtection: f32,
  shadowLift: f32,
  midtoneAnchor: f32,
  highlightRolloff: f32,

  bwRedMix: f32,
  bwGreenMix: f32,
  bwBlueMix: f32,
  bwTone: f32,

  _pad5: f32,
  _pad6: f32,
  _pad7: f32,
  _pad8: f32,

  cm0: f32,
  cm1: f32,
  cm2: f32,
  _pad9: f32,

  cm3: f32,
  cm4: f32,
  cm5: f32,
  _pad10: f32,

  cm6: f32,
  cm7: f32,
  cm8: f32,
  _pad11: f32,

  hasColorMatrix: f32,
  _pad12: f32,
  _pad13: f32,
  _pad14: f32,
};

struct DispatchParams {
  pixelCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read_write> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<storage, read> curveLuts: array<f32>;
@group(0) @binding(3) var<uniform> params: DispatchParams;

fn clampF(v: f32, lo: f32, hi: f32) -> f32 {
  return max(lo, min(hi, v));
}

fn applyWhiteBlackPoint(value: f32, bp: f32, wp: f32) -> f32 {
  let range = max(1.0 / 255.0, wp - bp);
  return (value - bp) / range;
}

fn applyFilmBaseCompensation(value: f32, sampleValue: f32) -> f32 {
  let invertedFilmBase = 1.0 - clampF(sampleValue, 1.0 / 255.0, 1.0);
  return clampF((value - invertedFilmBase) / max(1.0 / 255.0, 1.0 - invertedFilmBase), 0.0, 1.0);
}

fn applyTonalCharacter(value: f32) -> f32 {
  var v = value;

  if (u.shadowLift > 0.0 && v < 0.5) {
    let t = v / 0.5;
    let gamma = 1.0 - u.shadowLift * 0.6;
    v = 0.5 * pow(clampF(t, 0.0, 1.0), gamma);
  }

  v += u.midtoneAnchor;

  let threshold = 200.0 / 255.0;
  if (u.highlightProtection > 0.0 && v > threshold) {
    let protection = clampF(u.highlightProtection / 100.0, 0.0, 0.95);
    let shoulder = (v - threshold) / (1.0 - threshold);
    let rolloff = max(u.highlightRolloff, 0.05);
    let softness = 1.0 - protection * pow(clampF(shoulder, 0.0, 1.0), rolloff);
    v = threshold + shoulder * (1.0 - threshold) * softness;
  }

  return clampF(v, 0.0, 1.0);
}

fn mixBlackAndWhiteChannels(r: f32, g: f32, b: f32) -> f32 {
  let baseGray = 0.299 * r + 0.587 * g + 0.114 * b;
  return clampF(
    baseGray
      + (r - baseGray) * u.bwRedMix
      + (g - baseGray) * u.bwGreenMix
      + (b - baseGray) * u.bwBlueMix,
    0.0,
    1.0,
  );
}

fn applyBlackAndWhiteTone(gray: f32) -> vec3<f32> {
  let toneStrength = clampF(abs(u.bwTone), 0.0, 1.0);
  if (toneStrength <= 0.0) {
    return vec3<f32>(gray, gray, gray);
  }

  let toneColor = select(
    vec3<f32>(0.84, 0.93, 1.08),
    vec3<f32>(1.08, 0.96, 0.82),
    u.bwTone >= 0.0,
  );
  let mixFactor = toneStrength;
  let neutral = vec3<f32>(gray, gray, gray);
  let toned = gray * toneColor;
  return neutral + (toned - neutral) * mixFactor;
}

fn lookupCurve(channel: u32, value: f32) -> f32 {
  let idx = clamp(u32(round(clampF(value, 0.0, 1.0) * 255.0)), 0u, 255u);
  return curveLuts[channel * 256u + idx];
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) {
    return;
  }

  let px = pixels[idx];
  var r = px.x;
  var g = px.y;
  var b = px.z;

  if (u.processMode > 0.5) {
    r = 1.0 - r;
    g = 1.0 - g;
    b = 1.0 - b;

    r = applyFilmBaseCompensation(r, u.filmBaseR);
    g = applyFilmBaseCompensation(g, u.filmBaseG);
    b = applyFilmBaseCompensation(b, u.filmBaseB);

    if (u.hasColorMatrix > 0.5) {
      let nr = u.cm0 * r + u.cm1 * g + u.cm2 * b;
      let ng = u.cm3 * r + u.cm4 * g + u.cm5 * b;
      let nb = u.cm6 * r + u.cm7 * g + u.cm8 * b;
      r = nr;
      g = ng;
      b = nb;
    }

    if (u.isColor > 0.5) {
      r *= u.chanBalR;
      g *= u.chanBalG;
      b *= u.chanBalB;
      if (u.bwEnabled <= 0.5) {
        r += u.tempShift;
        b -= u.tempShift;
        g += u.tintShift;
      }
    }

    if (u.isColor <= 0.5 || u.bwEnabled > 0.5) {
      let gray = select(
        0.299 * r + 0.587 * g + 0.114 * b,
        mixBlackAndWhiteChannels(r, g, b),
        u.isColor > 0.5,
      );
      r = gray;
      g = gray;
      b = gray;
    }

    r *= u.exposureFactor;
    g *= u.exposureFactor;
    b *= u.exposureFactor;

    r = applyWhiteBlackPoint(r, u.blackPoint, u.whitePoint);
    g = applyWhiteBlackPoint(g, u.blackPoint, u.whitePoint);
    b = applyWhiteBlackPoint(b, u.blackPoint, u.whitePoint);

    r = u.contrastFactor * (r - 0.5) + 0.5;
    g = u.contrastFactor * (g - 0.5) + 0.5;
    b = u.contrastFactor * (b - 0.5) + 0.5;

    r = applyTonalCharacter(r);
    g = applyTonalCharacter(g);
    b = applyTonalCharacter(b);

    if (u.isColor > 0.5 && u.bwEnabled <= 0.5) {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * u.saturationFactor;
      g = gray + (g - gray) * u.saturationFactor;
      b = gray + (b - gray) * u.saturationFactor;
    } else {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      let toned = select(
        vec3<f32>(gray, gray, gray),
        applyBlackAndWhiteTone(gray),
        u.isColor <= 0.5 || u.bwEnabled > 0.5,
      );
      r = toned.x;
      g = toned.y;
      b = toned.z;
    }

    r = lookupCurve(1u, lookupCurve(0u, r));
    g = lookupCurve(2u, lookupCurve(0u, g));
    b = lookupCurve(3u, lookupCurve(0u, b));
  }

  pixels[idx] = vec4<f32>(clampF(r, 0.0, 1.0), clampF(g, 0.0, 1.0), clampF(b, 0.0, 1.0), px.w);
}
