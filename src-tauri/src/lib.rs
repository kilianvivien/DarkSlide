use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rawler::analyze::{analyze_metadata, AnalyzerData};
use rawler::imgop::develop::{ProcessingStep, RawDevelop};
use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;

#[derive(Serialize)]
struct RawDecodeResult {
    width: u32,
    height: u32,
    data: Vec<u8>,
    color_space: String,
    white_balance: Option<[f64; 3]>,
    orientation: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedFileResult {
    saved_path: String,
}

#[tauri::command]
fn decode_raw(path: String) -> Result<RawDecodeResult, String> {
    let raw_image = rawler::decode_file(&path).map_err(|error| error.to_string())?;
    let developed = RawDevelop {
        // Camera white balance is tuned for the photographed scene, not for an
        // orange film negative. Applying it here makes DarkSlide's own negative
        // conversion start from an already-skewed source.
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
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
    let rgb = developed.to_rgb8();

    let white_balance = match raw_image.wb_coeffs {
        [r, g, b, _]
            if r.is_finite()
                && g.is_finite()
                && b.is_finite()
                && r > 0.0
                && g > 0.0
                && b > 0.0 =>
        {
            Some([r as f64, g as f64, b as f64])
        }
        _ => None,
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
        data: rgb.into_raw(),
        color_space: "sRGB".to_string(),
        white_balance,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            decode_raw,
            save_blob_to_directory,
            open_saved_file_in_editor
        ])
        .setup(|app| {
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

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&import_item)
                .separator()
                .item(&export_item)
                .item(&batch_export_item)
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
                .item(&copy_debug_info_help_item)
                .build()?;

            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "DarkSlide")
                .about(None)
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
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("menu-action", event.id().0.as_str());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_filename, next_available_file_path, save_blob_to_directory_inner,
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
    use super::{build_open_saved_file_command, run_open_saved_file_command};
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
    fn surfaces_non_zero_exit_status() {
        let command = Command::new("/usr/bin/false");
        let error = run_open_saved_file_command(command).unwrap_err();

        assert!(error.contains("open failed with status"));
    }
}
