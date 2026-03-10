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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![decode_raw])
        .setup(|app| {
            let import_item = MenuItemBuilder::with_id("open", "Import...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let export_item = MenuItemBuilder::with_id("export", "Export...")
                .accelerator("CmdOrCtrl+E")
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
