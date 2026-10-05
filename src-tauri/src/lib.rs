
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Condvar, Mutex, OnceLock};

use rawler::analyze::{analyze_metadata, AnalyzerData};
use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri_plugin_updater::UpdaterExt;

const GITHUB_REPOSITORY_URL: &str = env!("CARGO_PKG_REPOSITORY");

// Binary RAW transport. JSON-encoding every 16-bit sample made a 24 MP RAW
// cost ~72 million numbers to serialize and parse; this layout carries the
// same samples as little-endian bytes. Keep in sync with src/utils/rawImport.ts.
//
//  0..8   magic "DSRIPC01"
//  8..10  version (u16)
// 10..12  bits per sample (u16, always 16)
// 12..16  width (u32)
// 16..20  height (u32)
// 20..22  EXIF orientation (u16, 0 = none)
// 22      transfer (u8, 0 = sRGB)
// 23      colour space (u8, 0 = sRGB)
// 24..32  sample count (u64, width * height * 3)
// 32..    RGB samples (u16 little-endian)
const RAW_IPC_MAGIC: &[u8; 8] = b"DSRIPC01";
const RAW_IPC_VERSION: u16 = 1;
const RAW_IPC_HEADER_BYTES: usize = 32;
// Full-size RAW buffers are large; bound how many are developed at once.
const RAW_DECODE_CONCURRENCY: usize = 2;

#[derive(Serialize)]
struct RawDecodeResult {
    width: u32,
    height: u32,
    data: Vec<u16>,
    color_space: String,
    #[serde(rename = "bitDepth")]
    bit_depth: u8,
    transfer: String,
    orientation: Option<u16>,
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

struct DecodedRaw {
    width: u32,
    height: u32,
    data: Vec<u16>,
    orientation: Option<u16>,
}

struct DecodeLimiter {
    available: Mutex<usize>,
    ready: Condvar,
}

struct DecodePermit<'a> {
    limiter: &'a DecodeLimiter,
}

impl DecodeLimiter {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity.max(1)),
            ready: Condvar::new(),
        }
    }

    // Blocks the calling thread; only call from a blocking worker thread.
    fn acquire(&self) -> Result<DecodePermit<'_>, String> {
        let mut available = self.available.lock().map_err(|error| error.to_string())?;
        while *available == 0 {
            available = self.ready.wait(available).map_err(|error| error.to_string())?;
        }
        *available -= 1;
        Ok(DecodePermit { limiter: self })
    }
}

impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut available) = self.limiter.available.lock() {
            *available += 1;
            self.limiter.ready.notify_one();
        }
    }
}

fn raw_decode_limiter() -> &'static DecodeLimiter {
    static LIMITER: OnceLock<DecodeLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| DecodeLimiter::new(RAW_DECODE_CONCURRENCY))
}

fn encode_raw_ipc_payload(decoded: &DecodedRaw) -> Result<Vec<u8>, String> {
    let expected_samples = u64::from(decoded.width)
        .checked_mul(u64::from(decoded.height))
        .and_then(|value| value.checked_mul(3))
        .ok_or_else(|| "RAW dimensions overflowed.".to_string())?;
    if decoded.data.len() as u64 != expected_samples {
        return Err(format!(
            "RAW decode produced {} samples for a {}x{} image.",
            decoded.data.len(),
            decoded.width,
            decoded.height,
        ));
    }

    let mut bytes = Vec::with_capacity(RAW_IPC_HEADER_BYTES + decoded.data.len() * 2);
    bytes.extend_from_slice(RAW_IPC_MAGIC);
    bytes.extend_from_slice(&RAW_IPC_VERSION.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(&decoded.width.to_le_bytes());
    bytes.extend_from_slice(&decoded.height.to_le_bytes());
    bytes.extend_from_slice(&decoded.orientation.unwrap_or(0).to_le_bytes());
    bytes.push(0);
    bytes.push(0);
    bytes.extend_from_slice(&expected_samples.to_le_bytes());
    debug_assert_eq!(bytes.len(), RAW_IPC_HEADER_BYTES);
    for sample in &decoded.data {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(bytes)
}

async fn run_raw_decode<T: Send + 'static>(
    path: String,
    finish: impl FnOnce(DecodedRaw) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // Developing a RAW takes seconds; keep it off the main (UI) thread.
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = raw_decode_limiter().acquire()?;
        finish(decode_raw_pixels(&path)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_raw_binary(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = run_raw_decode(path, |decoded| encode_raw_ipc_payload(&decoded)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

// JSON variant kept for compatibility; the app uses decode_raw_binary.
#[tauri::command]
async fn decode_raw(path: String) -> Result<RawDecodeResult, String> {
    run_raw_decode(path, |decoded| {
        Ok(RawDecodeResult {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
            color_space: "sRGB".to_string(),
            bit_depth: 16,
            transfer: "srgb".to_string(),
            orientation: decoded.orientation,
        })
    })
    .await
}

// sRGB primaries to XYZ (D65), as rawler uses for its own calibration.
const SRGB_TO_XYZ_D65: [[f32; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
];

// Per-channel gains that make a D65-white object neutral in camera space,
// derived from the camera's colour matrix and scaled so the largest gain is 1
// (pure attenuation: nothing that was below sensor clipping can clip here).
fn camera_neutral_gains(raw_image: &rawler::RawImage) -> Option<[f32; 3]> {
    use rawler::imgop::xyz::Illuminant;

    let matrix = raw_image
        .color_matrix
        .get(&Illuminant::D65)
        .or_else(|| raw_image.color_matrix.values().next())?;
    neutral_gains_from_xyz_to_camera(matrix)
}

fn neutral_gains_from_xyz_to_camera(matrix: &[f32]) -> Option<[f32; 3]> {
    if matrix.len() != 9 {
        return None;
    }
    // Camera response to sRGB white: the row sums of xyz2cam * sRGB->XYZ.
    let mut neutral = [0.0f32; 3];
    for (row, value) in neutral.iter_mut().enumerate() {
        for column in 0..3 {
            *value += (0..3)
                .map(|k| matrix[row * 3 + k] * SRGB_TO_XYZ_D65[k][column])
                .sum::<f32>();
        }
    }
    if neutral.iter().any(|value| !value.is_finite() || *value <= 0.0) {
        return None;
    }
    let gains = neutral.map(|value| 1.0 / value);
    let max_gain = gains.iter().copied().fold(0.0f32, f32::max);
    Some(gains.map(|gain| gain / max_gain))
}

fn srgb_encode(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

fn camera_native_to_srgb_u16(pixels: &[[f32; 3]], gains: [f32; 3]) -> Vec<u16> {
    let mut data = Vec::with_capacity(pixels.len() * 3);
    for pixel in pixels {
        for channel in 0..3 {
            data.push((srgb_encode(pixel[channel] * gains[channel]) * 65535.0).round() as u16);
        }
    }
    data
}

fn develop_calibrated_rgb16(raw_image: &rawler::RawImage) -> Result<(u32, u32, Vec<u16>), String> {
    let developed = RawDevelop {
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::Calibrate,
            ProcessingStep::CropDefault,
            ProcessingStep::SRgb,
        ],
    }
        .develop_intermediate(raw_image)
        .and_then(|intermediate| {
            intermediate
                .to_dynamic_image()
                .ok_or_else(|| rawler::RawlerError::DecoderFailed("Failed to convert developed RAW image to a dynamic image".to_string()))
        })
        .map_err(|error| error.to_string())?;
    let rgb = developed.to_rgb16();
    Ok((rgb.width(), rgb.height(), rgb.into_raw()))
}

fn decode_raw_pixels(path: &str) -> Result<DecodedRaw, String> {
    let raw_image = rawler::decode_file(path).map_err(|error| error.to_string())?;

    // Film is inverted in the sensor's own RGB. The camera colour matrix is
    // built for scene light, not for light through an orange mask: without
    // white balance it subtracts a large share of the (bright) green from the
    // (dim) blue, drives the blue of yellow-dense areas below zero and rawler
    // clips it to black. Those pixels then read as maximum blue density and
    // invert to flat, saturated blue skies and highlights. Neutral D65 gains
    // keep the mask orange for the film-base estimator; any per-channel gain
    // cancels out against the film base in the density inversion.
    // Camera white balance is still never applied: it is tuned for the
    // photographed scene, not for an orange film negative.
    let native = match camera_neutral_gains(&raw_image) {
        Some(gains) => RawDevelop {
            steps: vec![
                ProcessingStep::Rescale,
                ProcessingStep::Demosaic,
                ProcessingStep::CropActiveArea,
                ProcessingStep::CropDefault,
            ],
        }
            .develop_intermediate(&raw_image)
            .ok()
            .and_then(|intermediate| match intermediate {
                Intermediate::ThreeColor(pixels) => Some((
                    pixels.width as u32,
                    pixels.height as u32,
                    camera_native_to_srgb_u16(&pixels.data, gains),
                )),
                _ => None,
            }),
        None => None,
    };
    // Monochrome and four-colour sensors keep the calibrated development.
    let (width, height, data) = match native {
        Some(result) => result,
        None => develop_calibrated_rgb16(&raw_image)?,
    };

    let orientation = analyze_metadata(path)
        .ok()
        .and_then(|analysis| match analysis.data {
            Some(AnalyzerData::Metadata(metadata)) => metadata.raw_metadata.exif.orientation,
            _ => None,
        });

    Ok(DecodedRaw {
        width,
        height,
        data,
        orientation,
    })
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
        .invoke_handler(tauri::generate_handler![
            decode_raw,
            decode_raw_binary,
            save_blob_to_directory,
            open_saved_file_in_editor,
            read_file_by_path,
            read_text_file_by_path,
            file_size_by_path,
            write_text_file_by_path,
            drain_opened_files,
            update_recent_files_menu,
            get_updater_status,
            check_for_update,
            install_update_and_restart
        ])
        .setup(|app| {
            app.manage(PendingUpdate::default());
            let import_item = MenuItemBuilder::with_id("open", "Import...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let import_folder_item =
                MenuItemBuilder::with_id("open-folder", "Import Folder...").build(app)?;
            let export_item = MenuItemBuilder::with_id("export", "Export...")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;
            let open_in_editor_item =
                MenuItemBuilder::with_id("open-in-editor", "Open in Editor…")
                    .accelerator("Shift+CmdOrCtrl+O")
                    .build(app)?;
            let batch_export_item =
                MenuItemBuilder::with_id("batch-export", "Export Frames…")
                    .accelerator("CmdOrCtrl+Shift+E")
                    .build(app)?;
            let convert_files_item =
                MenuItemBuilder::with_id("convert-files", "Convert Files…").build(app)?;
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
                MenuItemBuilder::with_id("toggle-adjustments-pane", "Toggle Inspector")
                    .accelerator("CmdOrCtrl+\\")
                    .build(app)?;
            let toggle_profiles_item =
                MenuItemBuilder::with_id("toggle-profiles-pane", "Film Profiles")
                    .accelerator("CmdOrCtrl+Shift+\\")
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
                .item(&import_folder_item)
                .item(&recent_submenu)
                .separator()
                .item(&export_item)
                .item(&batch_export_item)
                .item(&convert_files_item)
                .item(&open_in_editor_item)
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
    #[test]
    fn neutral_gains_balance_a_d65_white_without_boosting_any_channel() {
        // Nikon Z 6 D65 matrix from rawler's camera data.
        let matrix = [0.9943, -0.3269, -0.0839, -0.5323, 1.3269, 0.2259, -0.1198, 0.2083, 0.7557];
        let gains = neutral_gains_from_xyz_to_camera(&matrix).expect("gains");
        assert!((gains[0] - 1.0).abs() < 1e-6);
        assert!((gains[1] - 0.4937).abs() < 1e-3);
        assert!((gains[2] - 0.5743).abs() < 1e-3);
        assert!(neutral_gains_from_xyz_to_camera(&matrix[..6]).is_none());
    }

    #[test]
    fn camera_native_pixels_never_go_negative_or_clip_below_white() {
        let data = camera_native_to_srgb_u16(&[[0.0, 0.5, 1.0], [-0.1, 0.002, 2.0]], [1.0, 0.5, 0.5]);
        assert_eq!(data[0], 0);
        assert_eq!(data[1], (srgb_encode(0.25) * 65535.0).round() as u16);
        assert_eq!(data[2], (srgb_encode(0.5) * 65535.0).round() as u16);
        assert_eq!(data[3], 0);
        assert_eq!(data[4], (0.001 * 12.92 * 65535.0f32).round() as u16);
        assert_eq!(data[5], 65535);
    }

    use super::{
        camera_native_to_srgb_u16, candidate_filename, encode_raw_ipc_payload,
        neutral_gains_from_xyz_to_camera, next_available_file_path, save_blob_to_directory_inner,
        srgb_encode, DecodeLimiter, DecodedRaw, RAW_IPC_HEADER_BYTES,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn encodes_raw_pixels_with_a_versioned_little_endian_header() {
        let decoded = DecodedRaw {
            width: 2,
            height: 1,
            data: vec![0, 1, 0xABCD, 65535, 256, 2],
            orientation: Some(6),
        };
        let bytes = encode_raw_ipc_payload(&decoded).expect("payload");

        assert_eq!(&bytes[0..8], b"DSRIPC01");
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 1);
        assert_eq!(u16::from_le_bytes([bytes[10], bytes[11]]), 16);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 6);
        assert_eq!(u64::from_le_bytes(bytes[24..32].try_into().unwrap()), 6);
        assert_eq!(bytes.len(), RAW_IPC_HEADER_BYTES + 12);
        let samples: Vec<u16> = bytes[RAW_IPC_HEADER_BYTES..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(samples, decoded.data);
    }

    #[test]
    fn rejects_raw_payloads_whose_sample_count_does_not_match() {
        let decoded = DecodedRaw { width: 2, height: 2, data: vec![0; 5], orientation: None };
        assert!(encode_raw_ipc_payload(&decoded).is_err());
    }

    #[test]
    fn bounds_concurrent_raw_decodes() {
        let limiter = Arc::new(DecodeLimiter::new(2));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..6).map(|_| {
            let limiter = Arc::clone(&limiter);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            thread::spawn(move || {
                let _permit = limiter.acquire().expect("permit");
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(20));
                active.fetch_sub(1, Ordering::SeqCst);
            })
        }).collect();
        for worker in workers {
            worker.join().expect("worker");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }
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
