struct BlurParams {
  pixelCount: u32,
  width: u32,
  height: u32,
  kernelRadius: u32,
  horizontal: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  sigma: f32,
  _pad3: f32,
  _pad4: f32,
  _pad5: f32,
};

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: BlurParams;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixelIdx = gid.x;
  if (pixelIdx >= params.pixelCount) {
    return;
  }

  let x = pixelIdx % params.width;
  let y = pixelIdx / params.width;
  let radius = i32(params.kernelRadius);

  var sumR: f32 = 0.0;
  var sumG: f32 = 0.0;
  var sumB: f32 = 0.0;
  var weightSum: f32 = 0.0;

  for (var k: i32 = -radius; k <= radius; k++) {
    var sx: u32;
    var sy: u32;

    if (params.horizontal > 0u) {
      sx = u32(clamp(i32(x) + k, 0, i32(params.width) - 1));
      sy = y;
    } else {
      sx = x;
      sy = u32(clamp(i32(y) + k, 0, i32(params.height) - 1));
    }

    let sourceIndex = sy * params.width + sx;
    let distance = f32(k);
    let weight = exp(-(distance * distance) / (2.0 * params.sigma * params.sigma));
    let pixel = src[sourceIndex];

    weightSum += weight;
    sumR += pixel.x * weight;
    sumG += pixel.y * weight;
    sumB += pixel.z * weight;
  }

  let inverseWeight = 1.0 / weightSum;
  let alpha = src[pixelIdx].w;
  dst[pixelIdx] = vec4<f32>(sumR * inverseWeight, sumG * inverseWeight, sumB * inverseWeight, alpha);
}
