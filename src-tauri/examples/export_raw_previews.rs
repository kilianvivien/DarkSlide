use rawler::imgop::develop::{ProcessingStep, RawDevelop};
use serde::Serialize;
use std::{env, fs, path::PathBuf};

#[derive(Serialize)]
struct Entry {
    name: String,
    width: u32,
    height: u32,
    rgba_path: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(env::args().nth(1).ok_or("missing source directory")?);
    let output = PathBuf::from(env::args().nth(2).ok_or("missing output directory")?);
    fs::create_dir_all(&output)?;
    let mut paths = fs::read_dir(source)?.filter_map(Result::ok).map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("rw2")))
        .collect::<Vec<_>>();
    paths.sort();
    let mut entries = Vec::new();

    for path in paths {
        let raw = rawler::decode_file(&path)?;
        let developed = RawDevelop { steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::Calibrate,
            ProcessingStep::CropDefault,
            ProcessingStep::SRgb,
        ]}.develop_intermediate(&raw)?.to_dynamic_image().ok_or("RAW development failed")?;
        let rgb = developed.to_rgb16();
        let scale = 1024.0 / f64::from(rgb.width().max(rgb.height()));
        let width = (f64::from(rgb.width()) * scale).round().max(1.0) as u32;
        let height = (f64::from(rgb.height()) * scale).round().max(1.0) as u32;
        let rgb = image::imageops::resize(&rgb, width, height, image::imageops::FilterType::Triangle);
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for pixel in rgb.pixels() {
            rgba.extend([pixel[0].to_be_bytes()[0], pixel[1].to_be_bytes()[0], pixel[2].to_be_bytes()[0], 255]);
        }
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let rgba_path = output.join(format!("{name}.rgba"));
        fs::write(&rgba_path, rgba)?;
        entries.push(Entry { name, width, height, rgba_path: rgba_path.to_string_lossy().to_string() });
    }
    fs::write(output.join("manifest.json"), serde_json::to_vec_pretty(&entries)?)?;
    Ok(())
}
