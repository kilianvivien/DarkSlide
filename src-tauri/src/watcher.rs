use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use notify::event::{CreateKind, ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL_MS: u64 = 500;
const STABILITY_CHECKS: usize = 10;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "tif", "tiff", "jpg", "jpeg", "png", "webp", "dng", "cr3", "nef", "arw", "raf", "rw2",
];

#[derive(Clone, Serialize)]
struct NewScanPayload {
    path: String,
    filename: String,
}

pub struct FolderWatcher {
    stop_tx: mpsc::Sender<()>,
    running: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<Result<(), String>>>,
}

fn supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| SUPPORTED_EXTENSIONS.iter().any(|supported| value.eq_ignore_ascii_case(supported)))
        .unwrap_or(false)
}

fn supported_event_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(CreateKind::File)
            | EventKind::Create(CreateKind::Any)
            | EventKind::Modify(ModifyKind::Name(RenameMode::To))
    )
}

fn wait_for_stable_size(path: &Path, running: &Arc<AtomicBool>) -> bool {
    let mut last_size = None;

    for _ in 0..STABILITY_CHECKS {
        if !running.load(Ordering::Relaxed) {
            return false;
        }

        let next_size = std::fs::metadata(path).ok().map(|metadata| metadata.len());
        if next_size.is_some() && next_size == last_size {
            return true;
        }

        last_size = next_size;
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }

    false
}

impl FolderWatcher {
    pub fn start(app: AppHandle, path: String) -> Result<Self, String> {
        let watch_path = PathBuf::from(&path);
        if !watch_path.exists() {
            return Err(format!("Watch folder does not exist: {}", watch_path.display()));
        }
        if !watch_path.is_dir() {
            return Err(format!("Watch path is not a directory: {}", watch_path.display()));
        }

        let (stop_tx, stop_rx) = mpsc::channel();
        let running = Arc::new(AtomicBool::new(true));
        let thread_running = Arc::clone(&running);
        let thread_path = watch_path.clone();

        let handle = thread::spawn(move || {
            let callback_running = Arc::clone(&thread_running);
            let callback_app = app.clone();

            let mut watcher = RecommendedWatcher::new(
                move |result: Result<Event, notify::Error>| {
                    if !callback_running.load(Ordering::Relaxed) {
                        return;
                    }

                    let Ok(event) = result else {
                        return;
                    };

                    if !supported_event_kind(&event.kind) {
                        return;
                    }

                    for path in event.paths {
                        if !supported_extension(&path) {
                            continue;
                        }

                        let event_app = callback_app.clone();
                        let event_running = Arc::clone(&callback_running);
                        thread::spawn(move || {
                            if !wait_for_stable_size(&path, &event_running) {
                                return;
                            }

                            let Some(filename) = path.file_name().and_then(|value| value.to_str()) else {
                                return;
                            };

                            if let Some(window) = event_app.get_webview_window("main") {
                                let _ = window.emit(
                                    "darkslide://new-scan",
                                    NewScanPayload {
                                        path: path.to_string_lossy().into_owned(),
                                        filename: filename.to_string(),
                                    },
                                );
                            }
                        });
                    }
                },
                Config::default().with_poll_interval(Duration::from_millis(POLL_INTERVAL_MS)),
            )
            .map_err(|error| format!("Could not create file watcher: {error}"))?;

            watcher
                .watch(&thread_path, RecursiveMode::NonRecursive)
                .map_err(|error| format!("Could not watch {}: {error}", thread_path.display()))?;

            loop {
                if stop_rx.recv_timeout(Duration::from_millis(250)).is_ok() {
                    break;
                }

                if !thread_running.load(Ordering::Relaxed) {
                    break;
                }
            }

            Ok(())
        });

        Ok(Self {
            stop_tx,
            running,
            handle: Some(handle),
        })
    }

    pub fn stop(mut self) -> Result<(), String> {
        self.running.store(false, Ordering::Relaxed);
        let _ = self.stop_tx.send(());

        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .map_err(|_| "Watcher thread panicked.".to_string())??;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{supported_event_kind, supported_extension};
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    use notify::EventKind;
    use std::path::Path;

    #[test]
    fn filters_supported_extensions_case_insensitively() {
        assert!(supported_extension(Path::new("scan.TIF")));
        assert!(supported_extension(Path::new("scan.cr3")));
        assert!(!supported_extension(Path::new("scan.psd")));
    }

    #[test]
    fn only_accepts_create_and_rename_into_folder() {
        assert!(supported_event_kind(&EventKind::Create(CreateKind::File)));
        assert!(supported_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::To))));
        assert!(!supported_event_kind(&EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Any,
        ))));
    }
}
