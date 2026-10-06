//! Worker-side image kernels. All color calculations use f64, matching JS;
//! only the existing Float32 raster/table boundaries round to f32.

fn clamp(v: f64) -> f64 { v.clamp(0.0, 1.0) }
fn decode(v: f64, gamma: f64) -> f64 {
    if gamma > 0.0 { v.powf(gamma) }
    else if v <= 0.04045 { v / 12.92 }
    else { ((v + 0.055) / 1.055).powf(2.4) }
}
fn encode(v: f64, gamma: f64) -> f64 {
    if gamma > 0.0 { v.powf(1.0 / gamma) }
    else if v <= 0.0031308 { v * 12.92 }
    else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}
fn gray(c: [f64; 3]) -> f64 { 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] }
fn matrix(c: [f64; 3], p: &[f64], offset: usize) -> [f64; 3] {
    std::array::from_fn(|row| {
        let i = offset + row * 4;
        p[i] * c[0] + p[i + 1] * c[1] + p[i + 2] * c[2]
    })
}
fn contrast(v: f64, k: f64) -> f64 {
    let stretched = k * (v - 0.5) + 0.5;
    if k <= 1.0 { return stretched; }
    let floor = 0.5 - 0.5 * k;
    let toe = (-2.0 * floor).min(0.5);
    if stretched >= toe { stretched }
    else if stretched <= floor { 0.0 }
    else { toe * ((stretched - floor) / (toe - floor)).powf((toe - floor) / toe) }
}
fn shoulder(v: f64, protection: f64, rolloff: f64) -> f64 {
    let threshold = 200.0 / 255.0;
    if v <= threshold { return v; }
    if protection <= 0.0 { return v.min(1.0); }
    let s = (v - threshold) / (1.0 - threshold);
    if s <= 1.0 { threshold + s * (1.0 - threshold) * (1.0 - protection * s.powf(rolloff)) }
    else {
        let top = threshold + (1.0 - threshold) * (1.0 - protection);
        let slope = ((1.0 - threshold) * (1.0 - protection * (1.0 + rolloff))).max(0.0);
        (top + slope * (s - 1.0)).min(1.0)
    }
}
fn tone(c: [f64; 3], p: &[f64]) -> [f64; 3] {
    let t = c.map(|v| {
        let mut n = contrast((v - p[18]) / (p[19] - p[18]).max(1.0 / 255.0), p[5]);
        if n < 0.25 && p[28] > 0.0 {
            let t = 1.0 - n / 0.25;
            n += (0.25 - n) * p[28].clamp(0.0, 1.0) * t * t;
        }
        if p[29] != 0.0 {
            let weight = (1.0 - 4.0 * (n - 0.5) * (n - 0.5)).max(0.0);
            n = 0.5 + (n - 0.5) * (1.0 + p[29].clamp(-1.0, 1.0) * weight);
        }
        if p[21] > 0.0 && n < 0.5 { n = 0.5 * clamp(n / 0.5).powf(1.0 - p[21] * 0.6); }
        (n + p[22]).max(0.0)
    });
    let peak = t.into_iter().fold(f64::NEG_INFINITY, f64::max);
    if peak <= 200.0 / 255.0 { return t; }
    let protection = (p[20] / 100.0).clamp(0.0, 0.95);
    let rolloff = (p[23] * (1.0 + clamp(p[30]) * 0.5)).max(0.05);
    let s = t.map(|v| shoulder(v, protection, rolloff));
    let target_gray = gray(s);
    let target_chroma = s.into_iter().fold(f64::NEG_INFINITY, f64::max) - s.into_iter().fold(f64::INFINITY, f64::min);
    let scale = shoulder(peak, protection, rolloff) / peak;
    let hue = t.map(|v| v * scale);
    let hue_gray = gray(hue);
    let d = hue.map(|v| v - hue_gray);
    let max = d.into_iter().fold(f64::NEG_INFINITY, f64::max);
    let min = d.into_iter().fold(f64::INFINITY, f64::min);
    let chroma = max - min;
    if chroma <= 0.0 { return [target_gray; 3]; }
    let mut keep = target_chroma / chroma;
    if max > 0.0 { keep = keep.min((1.0 - target_gray) / max); }
    if min < 0.0 { keep = keep.min(target_gray / -min); }
    d.map(|v| target_gray + v * keep.max(0.0))
}

pub fn process(pixels: &mut [f32], channels: usize, p: &[f64], curves: &[f32]) -> bool {
    if !(3..=4).contains(&channels) || pixels.len() % channels != 0 || p.len() != 93 || curves.len() % 3 != 0 || curves.len() < 6 { return false; }
    let size = curves.len() / 3;
    for pixel in pixels.chunks_exact_mut(channels) {
        let mut c = [pixel[0] as f64, pixel[1] as f64, pixel[2] as f64].map(clamp);
        if p[92] != 0.0 && p[4] == 0.0 {
            c = matrix(c.map(|v| decode(v, p[49])), p, 52).map(|v| clamp(encode(clamp(v), p[50])));
        }
        if p[0] != 0.0 {
            let inversion_mode = if p[4] != 0.0 { p[49] } else { p[50] };
            c = std::array::from_fn(|i| {
                let v = clamp(c[i] - p[32 + i] * p[35]);
                let v = if p[64 + i] == 1.0 { v } else { clamp(encode(decode(v, inversion_mode) / p[64 + i].max(0.05), inversion_mode)) };
                let v = if p[11] != 0.0 {
                    let t = decode(v, inversion_mode).clamp(1e-6, 1.0);
                    let density = (-t.log10() - p[76 + i]).max(0.0) * p[80 + i];
                    clamp(1.0 - 10.0_f64.powf(-density / p[72 + i].max(0.01)))
                } else {
                    let positive = if p[3] == 0.0 { 1.0 - v } else { v };
                    let sample = p[8 + i].clamp(1.0 / 255.0, 1.0);
                    clamp((positive - (1.0 - sample)) / sample.max(1.0 / 255.0))
                };
                (v - p[68 + i]).max(0.0)
            });
            if p[4] != 0.0 {
                c = matrix(c.map(|v| decode(clamp(v), p[49])), p, 52).map(|v| clamp(encode(clamp(v), p[50])));
            }
            if p[48] != 0.0 { c = matrix(c, p, 36); }
            if p[1] != 0.0 { c = std::array::from_fn(|i| c[i] * p[12 + i]); }
            if p[1] == 0.0 || p[2] != 0.0 {
                let g = gray(c);
                let bw = if p[1] != 0.0 { clamp(g + (c[0] - g) * p[24] + (c[1] - g) * p[25] + (c[2] - g) * p[26]) } else { g };
                c = [bw; 3];
            }
            let gains = [p[16], p[7], p[17]];
            c = std::array::from_fn(|i| {
                if gains[i] == 1.0 { c[i] } else {
                    let linear = decode(c[i].abs(), p[50]).copysign(c[i]) * gains[i];
                    encode(linear.abs(), p[50]).copysign(linear)
                }
            });
            c = tone(c, p);
            let g = gray(c);
            if p[1] != 0.0 && p[2] == 0.0 { c = c.map(|v| g + (v - g) * p[6]); }
            else {
                let tint = if p[27] >= 0.0 { [1.08, 0.96, 0.82] } else { [0.84, 0.93, 1.08] };
                c = tint.map(|v| g + (g * v - g) * p[27].abs().clamp(0.0, 1.0));
            }
            c = std::array::from_fn(|i| {
                let t = clamp(c[i]) * (size - 1) as f64;
                let lower = t.floor() as usize;
                let upper = (lower + 1).min(size - 1);
                let a = curves[i * size + lower] as f64;
                a + (curves[i * size + upper] as f64 - a) * (t - lower as f64)
            });
        }
        for i in 0..3 { pixel[i] = clamp(c[i]) as f32; }
    }
    true
}

/// Geometry is passed in double precision and samples encoded RGB, exactly
/// as the existing non-destructive high-depth transform does.
pub fn transform(source: &[u16], width: usize, height: usize, output: &mut [f32], p: &[f64]) -> bool {
    if width == 0 || height == 0 || source.len() != width * height * 3 || p.len() != 9 { return false; }
    let target_width = p[0] as usize;
    if target_width == 0 || output.len() % (target_width * 3) != 0 { return false; }
    for (index, pixel) in output.chunks_exact_mut(3).enumerate() {
        let x = (index % target_width) as f64 + p[1] + 0.5 - p[3] / 2.0;
        let y = (index / target_width) as f64 + p[2] + p[8] + 0.5 - p[4] / 2.0;
        let sx = p[5] * x + p[6] * y + width as f64 / 2.0 - 0.5;
        let sy = -p[6] * x + p[5] * y + height as f64 / 2.0 - 0.5;
        if sx < 0.0 || sy < 0.0 || sx > (width - 1) as f64 || sy > (height - 1) as f64 { pixel.fill(0.0); continue; }
        let x0 = sx.floor() as usize; let y0 = sy.floor() as usize;
        let x1 = (x0 + 1).min(width - 1); let y1 = (y0 + 1).min(height - 1);
        let fx = sx - x0 as f64; let fy = sy - y0 as f64;
        for c in 0..3 {
            let at = |x, y| source[(y * width + x) * 3 + c] as f64 / 65535.0;
            let top = at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx;
            let bottom = at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx;
            pixel[c] = (top * (1.0 - fy) + bottom * fy) as f32;
        }
    }
    true
}

pub fn flat_field(data: &mut [u16], p: &[f64], gains: &[f32], decode: &[f32], encode: &[u16]) -> bool {
    if p.len() != 5 || decode.len() != 65536 || encode.len() < 2 { return false; }
    let width = p[0] as usize; let height = p[1] as usize;
    let gw = p[2] as usize; let gh = p[3] as usize; let start = p[4] as usize;
    if width == 0 || height == 0 || data.len() % (width * 3) != 0 || gains.len() != (gw + 2) * (gh + 2) * 3 { return false; }
    let padded_width = gw + 2;
    let mut row_gains = vec![0.0f32; padded_width * 3];
    for (row, pixels) in data.chunks_exact_mut(width * 3).enumerate() {
        let coordinate = ((start + row) as f64 + 0.5) / height as f64 * gh as f64 + 0.5;
        let lower = (coordinate.floor() as usize).min(gh);
        let wy = (coordinate - lower as f64) as f32 as f64;
        for i in 0..row_gains.len() {
            row_gains[i] = (gains[lower * padded_width * 3 + i] as f64 * (1.0 - wy)
                + gains[(lower + 1) * padded_width * 3 + i] as f64 * wy) as f32;
        }
        for (x, pixel) in pixels.chunks_exact_mut(3).enumerate() {
            let coordinate = (x as f64 + 0.5) / width as f64 * gw as f64 + 0.5;
            let lower = (coordinate.floor() as usize).min(gw);
            let wx = (coordinate - lower as f64) as f32 as f64;
            for c in 0..3 {
                let left = row_gains[lower * 3 + c] as f64;
                let gain = left + (row_gains[(lower + 1) * 3 + c] as f64 - left) * wx;
                let linear = decode[pixel[c] as usize] as f64 * gain;
                pixel[c] = if linear >= 1.0 { 65535 } else { encode[(linear * (encode.len() - 1) as f64 + 0.5) as usize] };
            }
        }
    }
    true
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use std::cell::RefCell;
    enum Buffer { Float(Vec<f32>), Double(Vec<f64>), Short(Vec<u16>) }
    thread_local! { static BUFFERS: RefCell<Vec<Option<Buffer>>> = const { RefCell::new(Vec::new()) }; }
    #[no_mangle]
    pub extern "C" fn allocate(kind: u32, len: usize) -> usize {
        let bytes = match kind { 0 => 4, 1 => 8, 2 => 2, _ => return 0 };
        if len > 512 * 1024 * 1024 / bytes { return 0; }
        let value = match kind { 0 => Buffer::Float(vec![0.0; len]), 1 => Buffer::Double(vec![0.0; len]), 2 => Buffer::Short(vec![0; len]), _ => return 0 };
        BUFFERS.with(|buffers| {
            let mut b = buffers.borrow_mut();
            if let Some(i) = b.iter().position(Option::is_none) { b[i] = Some(value); i + 1 }
            else { b.push(Some(value)); b.len() }
        })
    }
    #[no_mangle]
    pub extern "C" fn pointer(handle: usize) -> usize {
        BUFFERS.with(|b| match b.borrow().get(handle.wrapping_sub(1)).and_then(Option::as_ref) {
            Some(Buffer::Float(v)) => v.as_ptr() as usize,
            Some(Buffer::Double(v)) => v.as_ptr() as usize,
            Some(Buffer::Short(v)) => v.as_ptr() as usize,
            None => 0,
        })
    }
    #[no_mangle]
    pub extern "C" fn release(handle: usize) { BUFFERS.with(|b| { if let Some(v) = b.borrow_mut().get_mut(handle.wrapping_sub(1)) { *v = None; } }); }
    #[no_mangle]
    pub extern "C" fn process(data: usize, channels: usize, params: usize, curves: usize) -> bool {
        if data == params || data == curves { return false; }
        BUFFERS.with(|buffers| {
            let mut b = buffers.borrow_mut();
            let Some(mut value) = b.get_mut(data.wrapping_sub(1)).and_then(Option::take) else { return false; };
            let result = match (&mut value, b.get(params.wrapping_sub(1)).and_then(Option::as_ref), b.get(curves.wrapping_sub(1)).and_then(Option::as_ref)) {
                (Buffer::Float(d), Some(Buffer::Double(p)), Some(Buffer::Float(c))) => super::process(d, channels, p, c), _ => false,
            };
            b[data - 1] = Some(value); result
        })
    }
    #[no_mangle]
    pub extern "C" fn transform(source: usize, width: usize, height: usize, output: usize, params: usize) -> bool {
        if source == output || output == params { return false; }
        BUFFERS.with(|buffers| {
            let mut b = buffers.borrow_mut();
            let Some(mut value) = b.get_mut(output.wrapping_sub(1)).and_then(Option::take) else { return false; };
            let result = match (b.get(source.wrapping_sub(1)).and_then(Option::as_ref), &mut value, b.get(params.wrapping_sub(1)).and_then(Option::as_ref)) {
                (Some(Buffer::Short(s)), Buffer::Float(d), Some(Buffer::Double(p))) => super::transform(s, width, height, d, p), _ => false,
            };
            b[output - 1] = Some(value); result
        })
    }
    #[no_mangle]
    pub extern "C" fn flat_field(data: usize, params: usize, gains: usize, decode: usize, encode: usize) -> bool {
        if [params, gains, decode, encode].contains(&data) { return false; }
        BUFFERS.with(|buffers| {
            let mut b = buffers.borrow_mut();
            let Some(mut value) = b.get_mut(data.wrapping_sub(1)).and_then(Option::take) else { return false; };
            let get = |id: usize| b.get(id.wrapping_sub(1)).and_then(Option::as_ref);
            let result = match (&mut value, get(params), get(gains), get(decode), get(encode)) {
                (Buffer::Short(d), Some(Buffer::Double(p)), Some(Buffer::Float(g)), Some(Buffer::Float(l)), Some(Buffer::Short(e))) => super::flat_field(d, p, g, l, e), _ => false,
            };
            b[data - 1] = Some(value); result
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn identity_transform_keeps_every_sensor_code() {
        let source: Vec<u16> = (0..48).map(|v| v * 1000).collect();
        let mut output = vec![0.0; source.len()];
        assert!(super::transform(&source, 4, 4, &mut output, &[4.0, 0.0, 0.0, 4.0, 4.0, 1.0, 0.0, 0.0, 0.0]));
        assert_eq!(output, source.iter().map(|v| (*v as f64 / 65535.0) as f32).collect::<Vec<_>>());
    }
    #[test]
    fn invalid_buffers_fail_without_processing() {
        assert!(!super::process(&mut [0.0; 4], 3, &[], &[]));
        assert!(!super::transform(&[], 0, 0, &mut [], &[]));
    }
}
