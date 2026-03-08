struct EffectParams {
  pixelCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  factor: f32,
  _pad3: f32,
  _pad4: f32,
  _pad5: f32,
};

@group(0) @binding(0) var<storage, read_write> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> blurred: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: EffectParams;

fn luminance(r: f32, g: f32, b: f32) -> f32 {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) {
    return;
  }

  let original = pixels[idx];
  let blur = blurred[idx];

  let originalLuminance = luminance(original.x, original.y, original.z);
  let blurredLuminance = luminance(blur.x, blur.y, blur.z);
  let mixedLuminance = originalLuminance + (blurredLuminance - originalLuminance) * params.factor;

  var scale = 1.0;
  if (originalLuminance > 0.001) {
    scale = mixedLuminance / originalLuminance;
  }

  pixels[idx] = vec4<f32>(
    clamp(original.x * scale, 0.0, 1.0),
    clamp(original.y * scale, 0.0, 1.0),
    clamp(original.z * scale, 0.0, 1.0),
    original.w,
  );
}
