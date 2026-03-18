struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

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
  inputTransferMode: f32,
  outputTransferMode: f32,
  _pad12: f32,

  profileMatrix0: f32,
  profileMatrix1: f32,
  profileMatrix2: f32,
  _pad13: f32,

  profileMatrix3: f32,
  profileMatrix4: f32,
  profileMatrix5: f32,
  _pad14: f32,

  profileMatrix6: f32,
  profileMatrix7: f32,
  profileMatrix8: f32,
  _pad15: f32,
};

struct BlurParams {
  radius: u32,
  direction: u32,
  _pad0: u32,
  _pad1: u32,
  sigma: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

struct EffectParams {
  factor: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@vertex
fn fullscreenVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0),
  );

  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

fn clampF(value: f32, minValue: f32, maxValue: f32) -> f32 {
  return max(minValue, min(maxValue, value));
}

fn decodeTransfer(value: f32, mode: f32) -> f32 {
  let normalized = clampF(value, 0.0, 1.0);
  if (mode > 0.5) {
    return pow(normalized, 2.19921875);
  }
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return pow((normalized + 0.055) / 1.055, 2.4);
}

fn encodeTransfer(value: f32, mode: f32) -> f32 {
  let normalized = clampF(value, 0.0, 1.0);
  if (mode > 0.5) {
    return pow(normalized, 1.0 / 2.19921875);
  }
  if (normalized <= 0.0031308) {
    return normalized * 12.92;
  }
  return 1.055 * pow(normalized, 1.0 / 2.4) - 0.055;
}

fn convertInputToOutput(r: f32, g: f32, b: f32, uniforms: Uniforms) -> vec3<f32> {
  let linear = vec3<f32>(
    decodeTransfer(r, uniforms.inputTransferMode),
    decodeTransfer(g, uniforms.inputTransferMode),
    decodeTransfer(b, uniforms.inputTransferMode),
  );
  let transformed = vec3<f32>(
    uniforms.profileMatrix0 * linear.x + uniforms.profileMatrix1 * linear.y + uniforms.profileMatrix2 * linear.z,
    uniforms.profileMatrix3 * linear.x + uniforms.profileMatrix4 * linear.y + uniforms.profileMatrix5 * linear.z,
    uniforms.profileMatrix6 * linear.x + uniforms.profileMatrix7 * linear.y + uniforms.profileMatrix8 * linear.z,
  );
  return vec3<f32>(
    encodeTransfer(transformed.x, uniforms.outputTransferMode),
    encodeTransfer(transformed.y, uniforms.outputTransferMode),
    encodeTransfer(transformed.z, uniforms.outputTransferMode),
  );
}

fn applyWhiteBlackPoint(value: f32, blackPoint: f32, whitePoint: f32) -> f32 {
  let range = max(1.0 / 255.0, whitePoint - blackPoint);
  return (value - blackPoint) / range;
}

fn applyFilmBaseCompensation(value: f32, sampleValue: f32) -> f32 {
  let invertedFilmBase = 1.0 - clampF(sampleValue, 1.0 / 255.0, 1.0);
  return clampF((value - invertedFilmBase) / max(1.0 / 255.0, 1.0 - invertedFilmBase), 0.0, 1.0);
}

fn applyTonalCharacter(value: f32, uniforms: Uniforms) -> f32 {
  var next = value;

  if (uniforms.shadowLift > 0.0 && next < 0.5) {
    let t = next / 0.5;
    let gamma = 1.0 - uniforms.shadowLift * 0.6;
    next = 0.5 * pow(clampF(t, 0.0, 1.0), gamma);
  }

  next += uniforms.midtoneAnchor;

  let threshold = 200.0 / 255.0;
  if (uniforms.highlightProtection > 0.0 && next > threshold) {
    let protection = clampF(uniforms.highlightProtection / 100.0, 0.0, 0.95);
    let shoulder = (next - threshold) / (1.0 - threshold);
    let softness = 1.0 - protection * pow(clampF(shoulder, 0.0, 1.0), max(uniforms.highlightRolloff, 0.05));
    next = threshold + shoulder * (1.0 - threshold) * softness;
  }

  return clampF(next, 0.0, 1.0);
}

fn mixBlackAndWhiteChannels(r: f32, g: f32, b: f32, uniforms: Uniforms) -> f32 {
  let baseGray = 0.299 * r + 0.587 * g + 0.114 * b;
  return clampF(
    baseGray
      + (r - baseGray) * uniforms.bwRedMix
      + (g - baseGray) * uniforms.bwGreenMix
      + (b - baseGray) * uniforms.bwBlueMix,
    0.0,
    1.0,
  );
}

fn applyBlackAndWhiteTone(gray: f32, uniforms: Uniforms) -> vec3<f32> {
  let toneStrength = clampF(abs(uniforms.bwTone), 0.0, 1.0);
  if (toneStrength <= 0.0) {
    return vec3<f32>(gray, gray, gray);
  }

  let toneColor = select(
    vec3<f32>(0.84, 0.93, 1.08),
    vec3<f32>(1.08, 0.96, 0.82),
    uniforms.bwTone >= 0.0,
  );
  let mixFactor = toneStrength;
  let neutral = vec3<f32>(gray, gray, gray);
  let toned = gray * toneColor;
  return neutral + (toned - neutral) * mixFactor;
}

fn textureCoord(position: vec4<f32>) -> vec2<i32> {
  return vec2<i32>(i32(position.x), i32(position.y));
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;
@group(0) @binding(2) var<storage, read> curveLuts: array<f32>;

fn lookupCurve(channel: u32, value: f32) -> f32 {
  let idx = clamp(u32(round(clampF(value, 0.0, 1.0) * 255.0)), 0u, 255u);
  return curveLuts[channel * 256u + idx];
}

@fragment
fn conversionFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = textureCoord(position);
  let source = textureLoad(inputTexture, coord, 0);
  let converted = convertInputToOutput(source.x, source.y, source.z, uniforms);
  var r = converted.x;
  var g = converted.y;
  var b = converted.z;

  if (uniforms.processMode > 0.5) {
    r = 1.0 - r;
    g = 1.0 - g;
    b = 1.0 - b;

    r = applyFilmBaseCompensation(r, uniforms.filmBaseR);
    g = applyFilmBaseCompensation(g, uniforms.filmBaseG);
    b = applyFilmBaseCompensation(b, uniforms.filmBaseB);

    if (uniforms.hasColorMatrix > 0.5) {
      let nr = uniforms.cm0 * r + uniforms.cm1 * g + uniforms.cm2 * b;
      let ng = uniforms.cm3 * r + uniforms.cm4 * g + uniforms.cm5 * b;
      let nb = uniforms.cm6 * r + uniforms.cm7 * g + uniforms.cm8 * b;
      r = nr;
      g = ng;
      b = nb;
    }

    if (uniforms.isColor > 0.5) {
      r *= uniforms.chanBalR;
      g *= uniforms.chanBalG;
      b *= uniforms.chanBalB;
      if (uniforms.bwEnabled <= 0.5) {
        r += uniforms.tempShift;
        b -= uniforms.tempShift;
        g += uniforms.tintShift;
      }
    }

    if (uniforms.isColor <= 0.5 || uniforms.bwEnabled > 0.5) {
      let gray = select(
        0.299 * r + 0.587 * g + 0.114 * b,
        mixBlackAndWhiteChannels(r, g, b, uniforms),
        uniforms.isColor > 0.5,
      );
      r = gray;
      g = gray;
      b = gray;
    }

    r *= uniforms.exposureFactor;
    g *= uniforms.exposureFactor;
    b *= uniforms.exposureFactor;

    r = applyWhiteBlackPoint(r, uniforms.blackPoint, uniforms.whitePoint);
    g = applyWhiteBlackPoint(g, uniforms.blackPoint, uniforms.whitePoint);
    b = applyWhiteBlackPoint(b, uniforms.blackPoint, uniforms.whitePoint);

    r = uniforms.contrastFactor * (r - 0.5) + 0.5;
    g = uniforms.contrastFactor * (g - 0.5) + 0.5;
    b = uniforms.contrastFactor * (b - 0.5) + 0.5;

    r = applyTonalCharacter(r, uniforms);
    g = applyTonalCharacter(g, uniforms);
    b = applyTonalCharacter(b, uniforms);

    if (uniforms.isColor > 0.5 && uniforms.bwEnabled <= 0.5) {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * uniforms.saturationFactor;
      g = gray + (g - gray) * uniforms.saturationFactor;
      b = gray + (b - gray) * uniforms.saturationFactor;
    } else {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      let toned = select(
        vec3<f32>(gray, gray, gray),
        applyBlackAndWhiteTone(gray, uniforms),
        uniforms.isColor <= 0.5 || uniforms.bwEnabled > 0.5,
      );
      r = toned.x;
      g = toned.y;
      b = toned.z;
    }

    r = lookupCurve(1u, lookupCurve(0u, r));
    g = lookupCurve(2u, lookupCurve(0u, g));
    b = lookupCurve(3u, lookupCurve(0u, b));
  }

  return vec4<f32>(clampF(r, 0.0, 1.0), clampF(g, 0.0, 1.0), clampF(b, 0.0, 1.0), source.w);
}

@group(0) @binding(0) var blurInputTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> blurParams: BlurParams;

@fragment
fn blurFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = textureCoord(position);
  let dims = textureDimensions(blurInputTexture);
  let radius = i32(blurParams.radius);

  var sum = vec3<f32>(0.0, 0.0, 0.0);
  var weightSum = 0.0;

  for (var offset = -radius; offset <= radius; offset += 1) {
    let sampleCoord = vec2<i32>(
      clamp(coord.x + select(0, offset, blurParams.direction == 0u), 0, i32(dims.x) - 1),
      clamp(coord.y + select(offset, 0, blurParams.direction == 0u), 0, i32(dims.y) - 1),
    );
    let distance = f32(offset);
    let weight = exp(-(distance * distance) / (2.0 * blurParams.sigma * blurParams.sigma));
    sum += textureLoad(blurInputTexture, sampleCoord, 0).xyz * weight;
    weightSum += weight;
  }

  return vec4<f32>(sum / weightSum, textureLoad(blurInputTexture, coord, 0).w);
}

@group(0) @binding(0) var effectOriginalTexture: texture_2d<f32>;
@group(0) @binding(1) var effectBlurredTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> effectParams: EffectParams;

fn luminance(rgb: vec3<f32>) -> f32 {
  return 0.299 * rgb.x + 0.587 * rgb.y + 0.114 * rgb.z;
}

@fragment
fn sharpenFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = textureCoord(position);
  let original = textureLoad(effectOriginalTexture, coord, 0);
  let blurred = textureLoad(effectBlurredTexture, coord, 0);
  let rgb = clamp(original.xyz + effectParams.factor * (original.xyz - blurred.xyz), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb, original.w);
}

@fragment
fn noiseReductionFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = textureCoord(position);
  let original = textureLoad(effectOriginalTexture, coord, 0);
  let blurred = textureLoad(effectBlurredTexture, coord, 0);
  let lumOrig = luminance(original.xyz);
  let lumBlur = luminance(blurred.xyz);
  let lumNew = lumOrig + (lumBlur - lumOrig) * effectParams.factor;
  var scale = 1.0;
  if (lumOrig > 0.001) {
    scale = lumNew / lumOrig;
  }
  return vec4<f32>(clamp(original.xyz * scale, vec3<f32>(0.0), vec3<f32>(1.0)), original.w);
}

@group(0) @binding(0) var copyInputTexture: texture_2d<f32>;

@fragment
fn copyFragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = textureCoord(position);
  return textureLoad(copyInputTexture, coord, 0);
}
