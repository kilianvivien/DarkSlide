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

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) {
    return;
  }

  let original = pixels[idx];
  let blur = blurred[idx];

  let r = clamp(original.x + params.factor * (original.x - blur.x), 0.0, 1.0);
  let g = clamp(original.y + params.factor * (original.y - blur.y), 0.0, 1.0);
  let b = clamp(original.z + params.factor * (original.z - blur.z), 0.0, 1.0);

  pixels[idx] = vec4<f32>(r, g, b, original.w);
}
