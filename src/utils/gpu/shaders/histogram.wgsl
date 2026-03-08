struct DispatchParams {
  pixelCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: DispatchParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.pixelCount) {
    return;
  }

  let pixel = pixels[idx];
  let r = u32(round(clamp(pixel.x, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(pixel.y, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(pixel.z, 0.0, 1.0) * 255.0));
  let l = u32(round(clamp(0.299 * pixel.x + 0.587 * pixel.y + 0.114 * pixel.z, 0.0, 1.0) * 255.0));

  atomicAdd(&histogram[r], 1u);
  atomicAdd(&histogram[256u + g], 1u);
  atomicAdd(&histogram[512u + b], 1u);
  atomicAdd(&histogram[768u + l], 1u);
}
