mod watcher;

use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rawler::analyze::{analyze_metadata, AnalyzerData};
use rawler::imgop::develop::{ProcessingStep, RawDevelop};
use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri_plugin_updater::UpdaterExt;

const GITHUB_REPOSITORY_URL: &str = env!("CARGO_PKG_REPOSITORY");
const RAW_PREVIEW_CACHE_VERSION: u16 = 2;
const RAW_PREVIEW_CACHE_MAGIC: &[u8; 8] = b"DSRAW001";
const RAW_IPC_MAGIC: &[u8; 8] = b"DSRIPC01";
const RAW_IPC_VERSION: u16 = 1;
const RAW_PREVIEW_CACHE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
// Two decoders keep the batch pipeline fed without letting several full-size
// RAW buffers compete for memory at once. Image processing has its own pool.
const RAW_DECODE_CONCURRENCY: usize = 2;
const RAW_REGION_MAX_DIMENSION: u32 = 4096;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct RawRegionBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct RawDecodeResult {
    width: u32,
    height: u32,
    #[serde(rename = "sourceWidth")]
    source_width: u32,
    #[serde(rename = "sourceHeight")]
    source_height: u32,
    data: Vec<u16>,
    color_space: String,
    #[serde(rename = "bitDepth")]
    bit_depth: u8,
    transfer: String,
    orientation: Option<u16>,
    #[serde(rename = "cacheHit")]
    cache_hit: bool,
    #[serde(rename = "queueWaitMs")]
    queue_wait_ms: u64,
    #[serde(rename = "decodeMs")]
    decode_ms: u64,
    #[serde(rename = "cacheReadMs")]
    cache_read_ms: u64,
}

#[derive(Clone)]
struct RawDecodeScheduler {
    limiter: Arc<DecodeLimiter>,
}

impl Default for RawDecodeScheduler {
    fn default() -> Self {
        Self {
            limiter: Arc::new(DecodeLimiter::new(RAW_DECODE_CONCURRENCY)),
        }
    }
}

struct DecodeLimiter {
    available: Mutex<usize>,
    ready: Condvar,
    capacity: usize,
}

impl DecodeLimiter {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity.max(1)),
            ready: Condvar::new(),
            capacity: capacity.max(1),
        }
    }

    fn acquire(&self) -> Result<DecodePermit<'_>, String> {
        let mut available = self.available.lock().map_err(|error| error.to_string())?;
        while *available == 0 {
            available = self.ready.wait(available).map_err(|error| error.to_string())?;
        }
        *available -= 1;
        Ok(DecodePermit { limiter: self })
    }
}

struct DecodePermit<'a> {
    limiter: &'a DecodeLimiter,
}

impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut available) = self.limiter.available.lock() {
            *available = (*available + 1).min(self.limiter.capacity);
            self.limiter.ready.notify_one();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedFileResult {
    saved_path: String,
}

#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Default)]
struct PendingOpenedFiles(Mutex<PendingOpenedFilesState>);

#[derive(Default)]
struct PendingOpenedFilesState {
    paths: Vec<String>,
    listener_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterStatus {
    enabled: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    version: String,
    current_version: String,
    release_notes: Option<String>,
}

fn updater_enabled() -> bool {
    matches!(option_env!("DARKSLIDE_ENABLE_UPDATER"), Some("1") | Some("true") | Some("TRUE"))
}

fn updater_disabled_reason() -> Option<String> {
    if !updater_enabled() {
        return Some("Desktop updates are fully wired, but disabled for this build.".to_string());
    }

    if option_env!("DARKSLIDE_UPDATER_PUBKEY").is_none() {
        return Some("Updater is enabled, but DARKSLIDE_UPDATER_PUBKEY is missing.".to_string());
    }

    if option_env!("DARKSLIDE_UPDATER_STABLE_ENDPOINT").is_none() {
        return Some("Updater is enabled, but DARKSLIDE_UPDATER_STABLE_ENDPOINT is missing.".to_string());
    }

    None
}

fn updater_endpoint(channel: &str) -> Result<String, String> {
    match channel {
        "beta" => option_env!("DARKSLIDE_UPDATER_BETA_ENDPOINT")
            .or(option_env!("DARKSLIDE_UPDATER_STABLE_ENDPOINT"))
            .map(|value| value.to_string())
            .ok_or_else(|| "Updater beta endpoint is not configured for this build.".to_string()),
        _ => option_env!("DARKSLIDE_UPDATER_STABLE_ENDPOINT")
            .map(|value| value.to_string())
            .ok_or_else(|| "Updater stable endpoint is not configured for this build.".to_string()),
    }
}

fn bounded_dimensions(width: u32, height: u32, max_dimension: Option<u32>) -> (u32, u32) {
    let Some(max_dimension) = max_dimension.filter(|value| *value > 0) else {
        return (width, height);
    };
    let source_max = width.max(height);
    if source_max <= max_dimension {
        return (width, height);
    }

    let scale = max_dimension as f64 / source_max as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn raw_preview_cache_key(path: &Path, max_dimension: u32) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect RAW file {}: {error}", path.display()))?;
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();

    let mut hasher = DefaultHasher::new();
    RAW_PREVIEW_CACHE_VERSION.hash(&mut hasher);
    canonical_path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    max_dimension.hash(&mut hasher);
    Ok(format!("{:016x}.dsraw", hasher.finish()))
}

fn raw_preview_cache_path(cache_directory: &Path, path: &Path, max_dimension: u32) -> Result<PathBuf, String> {
    Ok(cache_directory.join(raw_preview_cache_key(path, max_dimension)?))
}

fn raw_region_cache_path(
    cache_directory: &Path,
    path: &Path,
    region: RawRegionBounds,
    max_dimension: u32,
) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    raw_preview_cache_key(path, max_dimension)?.hash(&mut hasher);
    region.hash(&mut hasher);
    Ok(cache_directory.join(format!("region-{:016x}.dsraw", hasher.finish())))
}

fn read_u16(reader: &mut impl Read) -> Result<u16, String> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, String> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_raw_preview_cache(path: &Path) -> Result<RawDecodeResult, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut magic = [0_u8; 8];
    reader.read_exact(&mut magic).map_err(|error| error.to_string())?;
    if &magic != RAW_PREVIEW_CACHE_MAGIC {
        return Err("RAW preview cache has an invalid header.".to_string());
    }

    let version = read_u16(&mut reader)?;
    if version != RAW_PREVIEW_CACHE_VERSION {
        return Err("RAW preview cache version does not match this build.".to_string());
    }

    let width = read_u32(&mut reader)?;
    let height = read_u32(&mut reader)?;
    let source_width = read_u32(&mut reader)?;
    let source_height = read_u32(&mut reader)?;
    let stored_orientation = read_u16(&mut reader)?;
    let sample_count = read_u64(&mut reader)?;
    let expected_samples = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|value| value.checked_mul(3))
        .ok_or_else(|| "RAW preview cache dimensions overflowed.".to_string())?;
    if width == 0 || height == 0 || sample_count != expected_samples {
        return Err("RAW preview cache dimensions are invalid.".to_string());
    }
    let byte_count = sample_count
        .checked_mul(2)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "RAW preview cache is too large to read.".to_string())?;
    let mut bytes = vec![0_u8; byte_count];
    reader.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    let data = bytes
        .chunks_exact(2)
        .map(|sample| u16::from_le_bytes([sample[0], sample[1]]))
        .collect();

    Ok(RawDecodeResult {
        width,
        height,
        source_width,
        source_height,
        data,
        color_space: "sRGB".to_string(),
        bit_depth: 16,
        transfer: "srgb".to_string(),
        orientation: (stored_orientation != 0).then_some(stored_orientation),
        cache_hit: true,
        queue_wait_ms: 0,
        decode_ms: 0,
        cache_read_ms: 0,
    })
}

fn write_raw_preview_cache(path: &Path, result: &RawDecodeResult) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "RAW preview cache path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let file = fs::File::create(&temporary_path).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);

    writer.write_all(RAW_PREVIEW_CACHE_MAGIC).map_err(|error| error.to_string())?;
    writer
        .write_all(&RAW_PREVIEW_CACHE_VERSION.to_le_bytes())
        .and_then(|_| writer.write_all(&result.width.to_le_bytes()))
        .and_then(|_| writer.write_all(&result.height.to_le_bytes()))
        .and_then(|_| writer.write_all(&result.source_width.to_le_bytes()))
        .and_then(|_| writer.write_all(&result.source_height.to_le_bytes()))
        .and_then(|_| writer.write_all(&result.orientation.unwrap_or(0).to_le_bytes()))
        .and_then(|_| writer.write_all(&(result.data.len() as u64).to_le_bytes()))
        .map_err(|error| error.to_string())?;

    for samples in result.data.chunks(4096) {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        writer.write_all(&bytes).map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())?;
    drop(writer);
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        error.to_string()
    })?;
    Ok(())
}

fn prune_raw_preview_cache(cache_directory: &Path) {
    let Ok(entries) = fs::read_dir(cache_directory) else {
        return;
    };
    let mut cache_files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("dsraw") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((path, metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    let mut total_bytes = cache_files.iter().map(|(_, size, _)| *size).sum::<u64>();
    if total_bytes <= RAW_PREVIEW_CACHE_MAX_BYTES {
        return;
    }

    cache_files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in cache_files {
        if total_bytes <= RAW_PREVIEW_CACHE_MAX_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
        }
    }
}

fn clamp_raw_region(
    source_width: u32,
    source_height: u32,
    requested: RawRegionBounds,
) -> Result<RawRegionBounds, String> {
    if source_width == 0 || source_height == 0 || requested.width == 0 || requested.height == 0 {
        return Err("RAW zoom region dimensions must be greater than zero.".to_string());
    }
    if requested.x >= source_width || requested.y >= source_height {
        return Err("RAW zoom region falls outside the source image.".to_string());
    }

    let x = requested.x;
    let y = requested.y;
    let right = requested.x.saturating_add(requested.width).min(source_width);
    let bottom = requested.y.saturating_add(requested.height).min(source_height);
    if right <= x || bottom <= y {
        return Err("RAW zoom region falls outside the source image.".to_string());
    }

    Ok(RawRegionBounds {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

fn decode_raw_uncached(path: &str, max_dimension: Option<u32>) -> Result<RawDecodeResult, String> {
    let raw_image = rawler::decode_file(&path).map_err(|error| error.to_string())?;
    let developed = RawDevelop {
        // Rawler's calibration matrix expects sensor white-balance gains. If
        // they are omitted, the demosaiced RAW retains the sensor's green bias
        // and film-base analysis mistakes that bias for dye density. The
        // negative inversion removes the orange mask later; this step only
        // brings the camera capture into calibrated RGB.
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::WhiteBalance,
            ProcessingStep::Calibrate,
            ProcessingStep::CropDefault,
            ProcessingStep::SRgb,
        ],
    }
        .develop_intermediate(&raw_image)
        .and_then(|intermediate| {
            intermediate
                .to_dynamic_image()
                .ok_or_else(|| rawler::RawlerError::DecoderFailed("Failed to convert developed RAW image to a dynamic image".to_string()))
        })
        .map_err(|error| error.to_string())?;
    let rgb = developed.to_rgb16();
    let source_width = rgb.width();
    let source_height = rgb.height();
    let (width, height) = bounded_dimensions(source_width, source_height, max_dimension);
    let rgb = if (width, height) == (source_width, source_height) {
        rgb
    } else {
        image::imageops::resize(&rgb, width, height, image::imageops::FilterType::Triangle)
    };

    let orientation = analyze_metadata(&path)
        .ok()
        .and_then(|analysis| match analysis.data {
            Some(AnalyzerData::Metadata(metadata)) => metadata.raw_metadata.exif.orientation,
            _ => None,
        });

    Ok(RawDecodeResult {
        width: rgb.width(),
        height: rgb.height(),
        source_width,
        source_height,
        data: rgb.into_raw(),
        color_space: "sRGB".to_string(),
        bit_depth: 16,
        transfer: "srgb".to_string(),
        orientation,
        cache_hit: false,
        queue_wait_ms: 0,
        decode_ms: 0,
        cache_read_ms: 0,
    })
}

fn decode_raw_region_uncached(
    path: &str,
    requested_region: RawRegionBounds,
    max_dimension: u32,
) -> Result<RawDecodeResult, String> {
    let raw_image = rawler::decode_file(&path).map_err(|error| error.to_string())?;
    let developed = RawDevelop {
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::WhiteBalance,
            ProcessingStep::Calibrate,
            ProcessingStep::CropDefault,
            ProcessingStep::SRgb,
        ],
    }
        .develop_intermediate(&raw_image)
        .and_then(|intermediate| {
            intermediate
                .to_dynamic_image()
                .ok_or_else(|| rawler::RawlerError::DecoderFailed("Failed to convert developed RAW image to a dynamic image".to_string()))
        })
        .map_err(|error| error.to_string())?;
    let rgb = developed.to_rgb16();
    let source_width = rgb.width();
    let source_height = rgb.height();
    let region = clamp_raw_region(source_width, source_height, requested_region)?;
    let cropped = image::imageops::crop_imm(
        &rgb,
        region.x,
        region.y,
        region.width,
        region.height,
    )
    .to_image();
    let bounded_max = max_dimension.clamp(256, RAW_REGION_MAX_DIMENSION);
    let (width, height) = bounded_dimensions(cropped.width(), cropped.height(), Some(bounded_max));
    let cropped = if (width, height) == (cropped.width(), cropped.height()) {
        cropped
    } else {
        image::imageops::resize(&cropped, width, height, image::imageops::FilterType::Triangle)
    };
    let orientation = analyze_metadata(&path)
        .ok()
        .and_then(|analysis| match analysis.data {
            Some(AnalyzerData::Metadata(metadata)) => metadata.raw_metadata.exif.orientation,
            _ => None,
        });

    Ok(RawDecodeResult {
        width: cropped.width(),
        height: cropped.height(),
        source_width,
        source_height,
        data: cropped.into_raw(),
        color_space: "sRGB".to_string(),
        bit_depth: 16,
        transfer: "srgb".to_string(),
        orientation,
        cache_hit: false,
        queue_wait_ms: 0,
        decode_ms: 0,
        cache_read_ms: 0,
    })
}

fn decode_raw_scheduled(
    scheduler: &RawDecodeScheduler,
    cache_directory: &Path,
    path: String,
    max_dimension: Option<u32>,
    queued_at: Instant,
) -> Result<RawDecodeResult, String> {
    let _permit = scheduler.limiter.acquire()?;
    let queue_wait_ms = elapsed_millis(queued_at);
    let cache_path = max_dimension
        .filter(|value| *value > 0)
        .and_then(|value| raw_preview_cache_path(cache_directory, Path::new(&path), value).ok());

    if let Some(cache_path) = cache_path.as_deref() {
        let cache_started_at = Instant::now();
        match read_raw_preview_cache(cache_path) {
            Ok(mut result) => {
                result.queue_wait_ms = queue_wait_ms;
                result.cache_read_ms = elapsed_millis(cache_started_at);
                return Ok(result);
            }
            Err(_) => {
                let _ = fs::remove_file(cache_path);
            }
        }
    }

    let decode_started_at = Instant::now();
    let mut result = decode_raw_uncached(&path, max_dimension)?;
    result.queue_wait_ms = queue_wait_ms;
    result.decode_ms = elapsed_millis(decode_started_at);

    if let Some(cache_path) = cache_path.as_deref() {
        if write_raw_preview_cache(cache_path, &result).is_ok() {
            prune_raw_preview_cache(cache_directory);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn decode_raw(
    app: tauri::AppHandle,
    scheduler: tauri::State<'_, RawDecodeScheduler>,
    path: String,
    max_dimension: Option<u32>,
) -> Result<RawDecodeResult, String> {
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("raw-previews-v1");
    let scheduler = scheduler.inner().clone();
    let queued_at = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        decode_raw_scheduled(&scheduler, &cache_directory, path, max_dimension, queued_at)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn encode_raw_ipc_response(result: RawDecodeResult) -> Vec<u8> {
    let mut response = Vec::with_capacity(62 + result.data.len() * 2);
    response.extend_from_slice(RAW_IPC_MAGIC);
    response.extend_from_slice(&RAW_IPC_VERSION.to_le_bytes());
    response.extend_from_slice(&result.width.to_le_bytes());
    response.extend_from_slice(&result.height.to_le_bytes());
    response.extend_from_slice(&result.source_width.to_le_bytes());
    response.extend_from_slice(&result.source_height.to_le_bytes());
    response.extend_from_slice(&result.orientation.unwrap_or(0).to_le_bytes());
    response.push(result.bit_depth);
    response.push(u8::from(result.cache_hit));
    response.extend_from_slice(&result.queue_wait_ms.to_le_bytes());
    response.extend_from_slice(&result.decode_ms.to_le_bytes());
    response.extend_from_slice(&result.cache_read_ms.to_le_bytes());
    response.extend_from_slice(&(result.data.len() as u64).to_le_bytes());
    for sample in result.data {
        response.extend_from_slice(&sample.to_le_bytes());
    }
    response
}

#[tauri::command]
async fn decode_raw_binary(
    app: tauri::AppHandle,
    scheduler: tauri::State<'_, RawDecodeScheduler>,
    path: String,
    max_dimension: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("raw-previews-v1");
    let scheduler = scheduler.inner().clone();
    let queued_at = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<RawDecodeResult, String> {
        decode_raw_scheduled(&scheduler, &cache_directory, path, max_dimension, queued_at)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(encode_raw_ipc_response(result)))
}

#[tauri::command]
async fn decode_raw_region_binary(
    app: tauri::AppHandle,
    scheduler: tauri::State<'_, RawDecodeScheduler>,
    path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    max_dimension: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("raw-previews-v1");
    let scheduler = scheduler.inner().clone();
    let queued_at = Instant::now();
    let requested_region = RawRegionBounds { x, y, width, height };
    let max_dimension = max_dimension
        .unwrap_or(RAW_REGION_MAX_DIMENSION)
        .clamp(256, RAW_REGION_MAX_DIMENSION);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<RawDecodeResult, String> {
        let _permit = scheduler.limiter.acquire()?;
        let queue_wait_ms = elapsed_millis(queued_at);
        let cache_path = raw_region_cache_path(
            &cache_directory,
            Path::new(&path),
            requested_region,
            max_dimension,
        )?;
        let cache_started_at = Instant::now();
        if let Ok(mut cached) = read_raw_preview_cache(&cache_path) {
            cached.queue_wait_ms = queue_wait_ms;
            cached.cache_read_ms = elapsed_millis(cache_started_at);
            return Ok(cached);
        }
        let _ = fs::remove_file(&cache_path);

        let decode_started_at = Instant::now();
        let mut decoded = decode_raw_region_uncached(&path, requested_region, max_dimension)?;
        decoded.queue_wait_ms = queue_wait_ms;
        decoded.decode_ms = elapsed_millis(decode_started_at);
        if write_raw_preview_cache(&cache_path, &decoded).is_ok() {
            prune_raw_preview_cache(&cache_directory);
        }
        Ok(decoded)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(encode_raw_ipc_response(result)))
}

fn split_filename(filename: &str) -> (String, String) {
    if let Some(extension_index) = filename.rfind('.').filter(|index| *index > 0) {
        (
            filename[..extension_index].to_string(),
            filename[extension_index..].to_string(),
        )
    } else {
        (filename.to_string(), String::new())
    }
}

fn candidate_filename(filename: &str, attempt: usize) -> String {
    if attempt == 0 {
        return filename.to_string();
    }

    let (base_name, extension) = split_filename(filename);
    format!("{base_name}-{}{extension}", attempt + 1)
}

fn next_available_file_path(destination_directory: &Path, filename: &str) -> Result<PathBuf, String> {
    for attempt in 0..1000 {
        let candidate = destination_directory.join(candidate_filename(filename, attempt));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Could not determine a unique filename for the batch export.".to_string())
}

fn save_blob_to_directory_inner(
    bytes: &[u8],
    filename: &str,
    destination_directory: &str,
) -> Result<String, String> {
    let sanitized_filename = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Cannot save exported file without a filename.".to_string())?;
    let destination_path = PathBuf::from(destination_directory);

    if destination_path.exists() {
        if !destination_path.is_dir() {
            return Err(format!(
                "Destination is not a directory: {}",
                destination_path.display()
            ));
        }
    } else {
        fs::create_dir_all(&destination_path).map_err(|error| {
            format!(
                "Failed to create destination directory {}: {error}",
                destination_path.display()
            )
        })?;
    }

    let saved_path = next_available_file_path(&destination_path, sanitized_filename)?;
    fs::write(&saved_path, bytes)
        .map_err(|error| format!("Failed to write exported file {}: {error}", saved_path.display()))?;

    Ok(saved_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_blob_to_directory(
    bytes: Vec<u8>,
    filename: String,
    destination_directory: String,
) -> Result<SavedFileResult, String> {
    let saved_path = save_blob_to_directory_inner(&bytes, &filename, &destination_directory)?;
    Ok(SavedFileResult { saved_path })
}

#[cfg(target_os = "macos")]
fn build_open_saved_file_command(path: &str, editor_path: Option<&str>) -> Command {
    let mut command = Command::new("/usr/bin/open");
    if let Some(editor_path) = editor_path.filter(|value| !value.trim().is_empty()) {
        command.arg("-a").arg(editor_path);
    }
    command.arg(path);
    command
}

#[cfg(target_os = "macos")]
fn build_open_url_command(url: &str) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command.arg(url);
    command
}

#[cfg(target_os = "macos")]
fn run_open_saved_file_command(mut command: Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("Failed to launch /usr/bin/open: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("open failed with status {}", output.status)
    };

    Err(detail)
}

#[cfg(target_os = "macos")]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    let command = build_open_url_command(url);
    run_open_saved_file_command(command)
}

#[cfg(target_os = "windows")]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    let output = Command::new("cmd")
        .args(["/C", "start", "", url])
        .output()
        .map_err(|error| format!("Failed to launch browser: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("browser launch failed with status {}", output.status)
    };

    Err(detail)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    let output = Command::new("xdg-open")
        .arg(url)
        .output()
        .map_err(|error| format!("Failed to launch browser: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("browser launch failed with status {}", output.status)
    };

    Err(detail)
}

#[tauri::command]
fn read_file_by_path(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Failed to read {path}: {error}"))
}

#[tauri::command]
fn read_text_file_by_path(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| format!("Failed to read {path}: {error}"))
}

#[tauri::command]
fn file_size_by_path(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|error| format!("Failed to stat {path}: {error}"))
}

#[tauri::command]
fn write_text_file_by_path(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|error| format!("Failed to write {path}: {error}"))
}

#[tauri::command]
fn drain_opened_files(state: tauri::State<'_, PendingOpenedFiles>) -> Vec<String> {
    let mut pending = state.0.lock().expect("pending opened files mutex poisoned");
    pending.listener_ready = true;
    pending.paths.drain(..).collect()
}

#[derive(Deserialize)]
struct RecentMenuEntry {
    name: String,
    path: String,
}

struct RecentMenuState {
    submenu: std::sync::Mutex<tauri::menu::Submenu<tauri::Wry>>,
}

struct WatcherState(Mutex<Option<watcher::FolderWatcher>>);

#[tauri::command]
fn update_recent_files_menu(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentMenuState>,
    entries: Vec<RecentMenuEntry>,
) -> Result<(), String> {
    let submenu = state.submenu.lock().map_err(|error| error.to_string())?;

    // Remove all existing items.
    for item in submenu.items().map_err(|error| error.to_string())? {
        let _ = submenu.remove(&item);
    }

    // Add new items.
    for entry in &entries {
        let label = &entry.name;
        let id = format!("recent::{}", entry.path);
        let item = MenuItemBuilder::with_id(id, label)
            .build(&app)
            .map_err(|error| error.to_string())?;
        submenu.append(&item).map_err(|error| error.to_string())?;
    }

    if !entries.is_empty() {
        let separator = PredefinedMenuItem::separator(&app)
            .map_err(|error| error.to_string())?;
        submenu.append(&separator).map_err(|error| error.to_string())?;
    }

    let clear_item = MenuItemBuilder::with_id("clear-recent-files", "Clear Recent")
        .enabled(!entries.is_empty())
        .build(&app)
        .map_err(|error| error.to_string())?;
    submenu.append(&clear_item).map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
async fn start_watching(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = guard.take() {
        existing.stop()?;
    }

    let watcher = watcher::FolderWatcher::start(app, path)?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
async fn stop_watching(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = guard.take() {
        existing.stop()?;
    }
    Ok(())
}

#[tauri::command]
fn is_watching(state: tauri::State<'_, WatcherState>) -> bool {
    state.0.lock().map(|guard| guard.is_some()).unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn file_paths_from_opened_urls(urls: Vec<tauri::Url>) -> Vec<String> {
    urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn emit_opened_file_paths(app: &tauri::AppHandle, state: &PendingOpenedFiles, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    {
        let mut pending = state.0.lock().expect("pending opened files mutex poisoned");
        if !pending.listener_ready {
            pending.paths.extend(paths.iter().cloned());
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("app-open-files", paths);
    }
}

#[tauri::command]
#[cfg(target_os = "macos")]
fn open_saved_file_in_editor(path: String, editor_path: Option<String>) -> Result<(), String> {
    let command = build_open_saved_file_command(&path, editor_path.as_deref());
    run_open_saved_file_command(command)
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
fn open_saved_file_in_editor(_path: String, _editor_path: Option<String>) -> Result<(), String> {
    Err("Open in Editor is currently only supported on macOS.".to_string())
}

#[tauri::command]
fn get_updater_status() -> UpdaterStatus {
    UpdaterStatus {
        enabled: updater_disabled_reason().is_none(),
        reason: updater_disabled_reason(),
    }
}

#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    pending_update: tauri::State<'_, PendingUpdate>,
    channel: Option<String>,
) -> Result<Option<UpdateCheckResult>, String> {
    if let Some(reason) = updater_disabled_reason() {
        return Err(reason);
    }

    let endpoint = updater_endpoint(channel.as_deref().unwrap_or("stable"))?;
    let pubkey = option_env!("DARKSLIDE_UPDATER_PUBKEY")
        .ok_or_else(|| "Updater public key is not configured for this build.".to_string())?;

    let update = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint.parse().map_err(|error| format!("Invalid updater endpoint: {error}"))?])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let payload = update.as_ref().map(|update| UpdateCheckResult {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        release_notes: update.body.clone(),
    });

    *pending_update.0.lock().map_err(|error| error.to_string())? = update;

    Ok(payload)
}

#[tauri::command]
async fn install_update_and_restart(
    app: tauri::AppHandle,
    pending_update: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    if let Some(reason) = updater_disabled_reason() {
        return Err(reason);
    }

    let update = pending_update
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or_else(|| "No pending update is available to install.".to_string())?;

    update
        .download_and_install(
            |_chunk_length, _content_length| {},
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Register state on the builder so it is available before `setup` runs.
        // On macOS, AppKit can dispatch `application:openURLs:` (e.g. document
        // restoration on launch) before our setup closure executes; if the
        // RunEvent::Opened handler queries unmanaged state it panics across the
        // FFI boundary and aborts the process.
        .manage(PendingOpenedFiles::default())
        .manage(RawDecodeScheduler::default())
        .invoke_handler(tauri::generate_handler![
            decode_raw,
            decode_raw_binary,
            decode_raw_region_binary,
            save_blob_to_directory,
            open_saved_file_in_editor,
            read_file_by_path,
            read_text_file_by_path,
            file_size_by_path,
            write_text_file_by_path,
            drain_opened_files,
            update_recent_files_menu,
            start_watching,
            stop_watching,
            is_watching,
            get_updater_status,
            check_for_update,
            install_update_and_restart
        ])
        .setup(|app| {
            app.manage(PendingUpdate::default());
            app.manage(WatcherState(Mutex::new(None)));
            let import_item = MenuItemBuilder::with_id("open", "Import...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let export_item = MenuItemBuilder::with_id("export", "Export...")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;
            let open_in_editor_item =
                MenuItemBuilder::with_id("open-in-editor", "Open in Editor…")
                    .accelerator("Shift+CmdOrCtrl+O")
                    .build(app)?;
            let batch_export_item =
                MenuItemBuilder::with_id("batch-export", "Batch Export…")
                    .accelerator("CmdOrCtrl+Shift+E")
                    .build(app)?;
            let close_image_item = MenuItemBuilder::with_id("close-image", "Close Image")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let reset_adjustments_item =
                MenuItemBuilder::with_id("reset-adjustments", "Reset Adjustments")
                    .accelerator("CmdOrCtrl+Shift+R")
                    .build(app)?;
            let settings_item = MenuItemBuilder::with_id("show-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let copy_debug_info_help_item =
                MenuItemBuilder::with_id("copy-debug-info", "Copy Debug Info").build(app)?;
            let check_for_updates_help_item =
                MenuItemBuilder::with_id("check-for-updates", "Check for Updates…").build(app)?;
            let github_repo_help_item =
                MenuItemBuilder::with_id("open-github-repo", "GitHub Repository").build(app)?;
            let toggle_compare_item = MenuItemBuilder::with_id("toggle-comparison", "Toggle Before/After")
                .accelerator("CmdOrCtrl+/")
                .build(app)?;
            let toggle_crop_item =
                MenuItemBuilder::with_id("toggle-crop-overlay", "Toggle Crop Overlay")
                    .accelerator("CmdOrCtrl+Alt+C")
                    .build(app)?;
            let toggle_adjustments_item =
                MenuItemBuilder::with_id("toggle-adjustments-pane", "Toggle Adjustments Pane")
                    .accelerator("CmdOrCtrl+\\")
                    .build(app)?;
            let toggle_profiles_item =
                MenuItemBuilder::with_id("toggle-profiles-pane", "Toggle Profiles Pane")
                    .accelerator("CmdOrCtrl+Shift+\\")
                    .build(app)?;
            let scan_session_item =
                MenuItemBuilder::with_id("scan-session-toggle", "Scanning Session")
                    .accelerator("CmdOrCtrl+Shift+W")
                    .build(app)?;
let zoom_fit_item = MenuItemBuilder::with_id("zoom-fit", "Zoom to Fit")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let zoom_actual_item = MenuItemBuilder::with_id("zoom-100", "Actual Size")
                .accelerator("CmdOrCtrl+1")
                .build(app)?;
            let zoom_in_item = MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out_item = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;

            let recent_submenu = SubmenuBuilder::with_id(app, "open-recent", "Open Recent")
                .item(
                    &MenuItemBuilder::with_id("clear-recent-files", "Clear Recent")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?;

            app.manage(RecentMenuState {
                submenu: std::sync::Mutex::new(recent_submenu.clone()),
            });

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&import_item)
                .item(&recent_submenu)
                .separator()
                .item(&export_item)
                .item(&batch_export_item)
                .item(&open_in_editor_item)
                .separator()
                .item(&scan_session_item)
                .separator()
                .item(&close_image_item)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .item(&reset_adjustments_item)
                .copy()
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&toggle_compare_item)
                .item(&toggle_crop_item)
                .separator()
                .item(&toggle_adjustments_item)
                .item(&toggle_profiles_item)
                .separator()
                .item(&zoom_fit_item)
                .item(&zoom_actual_item)
                .separator()
                .item(&zoom_in_item)
                .item(&zoom_out_item)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&check_for_updates_help_item)
                .separator()
                .item(&github_repo_help_item)
                .separator()
                .item(&copy_debug_info_help_item)
                .build()?;

            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "DarkSlide")
                .about(Some(
                    AboutMetadataBuilder::new()
                        .version(Some(env!("CARGO_PKG_VERSION")))
                        .short_version(Some(env!("CARGO_PKG_VERSION")))
                        .license(Some(env!("CARGO_PKG_LICENSE")))
                        .credits(Some("MIT Licence"))
                        .build(),
                ))
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            #[cfg(target_os = "macos")]
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()?;

            #[cfg(not(target_os = "macos"))]
            let menu = MenuBuilder::new(app)
                .items(&[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                let id = event.id().0.as_str();

                if id == "open-github-repo" {
                    if let Err(error) = open_url_in_browser(GITHUB_REPOSITORY_URL) {
                        eprintln!("failed to open GitHub repository URL: {error}");
                    }
                    return;
                }

                if let Some(path) = id.strip_prefix("recent::") {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("menu-open-recent", path);
                    }
                    return;
                }

                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("menu-action", id);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = event {
                // This callback is invoked from an Objective-C selector
                // (`application:openURLs:`). A Rust panic here cannot unwind
                // across the FFI boundary and would abort the process, so we
                // catch any panic and drop the paths rather than crash.
                let app = app.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    let paths = file_paths_from_opened_urls(urls);
                    if let Some(state) = app.try_state::<PendingOpenedFiles>() {
                        emit_opened_file_paths(&app, &state, paths);
                    }
                }));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_dimensions, candidate_filename, clamp_raw_region, encode_raw_ipc_response,
        next_available_file_path, raw_preview_cache_key, read_raw_preview_cache,
        save_blob_to_directory_inner, write_raw_preview_cache, RawDecodeResult, RawRegionBounds,
        RAW_IPC_MAGIC,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_directory(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("darkslide-{name}-{timestamp}"))
    }

    #[test]
    fn candidate_filename_appends_suffix_before_extension() {
        assert_eq!(candidate_filename("scan.jpg", 0), "scan.jpg");
        assert_eq!(candidate_filename("scan.jpg", 1), "scan-2.jpg");
        assert_eq!(candidate_filename("scan", 2), "scan-3");
    }

    #[test]
    fn raw_preview_dimensions_preserve_aspect_ratio_and_never_upscale() {
        assert_eq!(bounded_dimensions(8192, 5464, Some(2048)), (2048, 1366));
        assert_eq!(bounded_dimensions(3000, 4000, Some(2000)), (1500, 2000));
        assert_eq!(bounded_dimensions(1600, 1200, Some(2048)), (1600, 1200));
        assert_eq!(bounded_dimensions(1600, 1200, None), (1600, 1200));
    }

    #[test]
    fn raw_zoom_region_is_clamped_to_the_source() {
        assert_eq!(
            clamp_raw_region(
                6000,
                4000,
                RawRegionBounds { x: 5500, y: 3500, width: 1000, height: 1000 },
            ),
            Ok(RawRegionBounds { x: 5500, y: 3500, width: 500, height: 500 }),
        );
        assert!(clamp_raw_region(
            6000,
            4000,
            RawRegionBounds { x: 6000, y: 0, width: 10, height: 10 },
        )
        .is_err());
    }

    #[test]
    fn raw_preview_cache_round_trips_pixels_and_metadata() {
        let directory = unique_test_directory("raw-preview-cache");
        fs::create_dir_all(&directory).expect("temp directory should be created");
        let cache_path = directory.join("preview.dsraw");
        let result = RawDecodeResult {
            width: 2,
            height: 1,
            source_width: 8000,
            source_height: 4000,
            data: vec![0, 257, 65_535, 1_024, 32_768, 50_000],
            color_space: "sRGB".to_string(),
            bit_depth: 16,
            transfer: "srgb".to_string(),
            orientation: Some(6),
            cache_hit: false,
            queue_wait_ms: 0,
            decode_ms: 42,
            cache_read_ms: 0,
        };

        write_raw_preview_cache(&cache_path, &result).expect("preview should be cached");
        let cached = read_raw_preview_cache(&cache_path).expect("preview cache should be read");

        assert_eq!(cached.width, 2);
        assert_eq!(cached.height, 1);
        assert_eq!(cached.source_width, 8000);
        assert_eq!(cached.source_height, 4000);
        assert_eq!(cached.orientation, Some(6));
        assert_eq!(cached.data, result.data);
        assert!(cached.cache_hit);

        fs::remove_dir_all(&directory).expect("temp directory should be removed");
    }

    #[test]
    fn raw_ipc_response_packs_metadata_and_pixels_without_json() {
        let result = RawDecodeResult {
            width: 1,
            height: 1,
            source_width: 6000,
            source_height: 4000,
            data: vec![257, 32_768, 65_535],
            color_space: "sRGB".to_string(),
            bit_depth: 16,
            transfer: "srgb".to_string(),
            orientation: Some(6),
            cache_hit: true,
            queue_wait_ms: 3,
            decode_ms: 0,
            cache_read_ms: 7,
        };

        let response = encode_raw_ipc_response(result);

        assert_eq!(&response[..8], RAW_IPC_MAGIC);
        assert_eq!(response.len(), 62 + 6);
        assert_eq!(&response[62..], &[1, 1, 0, 128, 255, 255]);
    }

    #[test]
    fn raw_preview_cache_key_changes_when_source_changes() {
        let directory = unique_test_directory("raw-preview-key");
        fs::create_dir_all(&directory).expect("temp directory should be created");
        let source_path = directory.join("scan.rw2");
        fs::write(&source_path, [1_u8, 2, 3]).expect("source file should be written");
        let first_key = raw_preview_cache_key(&source_path, 2048).expect("cache key should build");

        fs::write(&source_path, [1_u8, 2, 3, 4]).expect("source file should change");
        let changed_source_key =
            raw_preview_cache_key(&source_path, 2048).expect("changed cache key should build");
        let changed_size_key =
            raw_preview_cache_key(&source_path, 1024).expect("resized cache key should build");

        assert_ne!(first_key, changed_source_key);
        assert_ne!(changed_source_key, changed_size_key);

        fs::remove_dir_all(&directory).expect("temp directory should be removed");
    }

    #[test]
    fn next_available_file_path_skips_existing_files() {
        let directory = unique_test_directory("dedupe");
        fs::create_dir_all(&directory).expect("temp directory should be created");
        fs::write(directory.join("scan.jpg"), [1_u8]).expect("seed file should be written");

        let candidate = next_available_file_path(&directory, "scan.jpg")
            .expect("next available path should be generated");

        assert_eq!(candidate, directory.join("scan-2.jpg"));

        fs::remove_dir_all(&directory).expect("temp directory should be removed");
    }

    #[test]
    fn save_blob_to_directory_writes_and_dedupes_files() {
        let directory = unique_test_directory("save");
        let first_path = save_blob_to_directory_inner(&[1, 2, 3], "scan.jpg", &directory.to_string_lossy())
            .expect("first file should be saved");
        let second_path = save_blob_to_directory_inner(&[4, 5, 6], "scan.jpg", &directory.to_string_lossy())
            .expect("second file should be saved");

        assert_eq!(first_path, directory.join("scan.jpg").to_string_lossy());
        assert_eq!(second_path, directory.join("scan-2.jpg").to_string_lossy());
        assert_eq!(fs::read(&first_path).expect("first file should be readable"), vec![1, 2, 3]);
        assert_eq!(fs::read(&second_path).expect("second file should be readable"), vec![4, 5, 6]);

        fs::remove_dir_all(&directory).expect("temp directory should be removed");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::{build_open_saved_file_command, build_open_url_command, run_open_saved_file_command};
    use std::process::Command;

    #[test]
    fn builds_open_command_for_default_app() {
        let command = build_open_saved_file_command("/Users/tester/Downloads/scan.jpg", None);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program().to_string_lossy(), "/usr/bin/open");
        assert_eq!(args, vec!["/Users/tester/Downloads/scan.jpg"]);
    }

    #[test]
    fn builds_open_command_for_specific_editor() {
        let command = build_open_saved_file_command(
            "/Users/tester/Downloads/scan.jpg",
            Some("/Applications/Pixelmator Pro.app"),
        );
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program().to_string_lossy(), "/usr/bin/open");
        assert_eq!(
            args,
            vec![
                "-a",
                "/Applications/Pixelmator Pro.app",
                "/Users/tester/Downloads/scan.jpg",
            ],
        );
    }

    #[test]
    fn builds_open_command_for_repository_url() {
        let command = build_open_url_command("https://github.com/kilianvivien/DarkSlide");
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program().to_string_lossy(), "/usr/bin/open");
        assert_eq!(args, vec!["https://github.com/kilianvivien/DarkSlide"]);
    }

    #[test]
    fn surfaces_non_zero_exit_status() {
        let command = Command::new("/usr/bin/false");
        let error = run_open_saved_file_command(command).unwrap_err();

        assert!(error.contains("open failed with status"));
    }
}
