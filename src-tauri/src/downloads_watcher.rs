use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::mods::install_mod_from_zip;
use crate::state::AppState;

/// Payload emitted to the frontend when a mod is auto-installed from Downloads.
#[derive(Clone, serde::Serialize)]
pub struct ModAutoInstalled {
    pub mod_name: String,
    pub file_name: String,
}

#[derive(Clone, serde::Serialize)]
pub struct ModAutoInstallFailed {
    pub file_name: String,
    pub error: String,
}

/// Start watching the user's Downloads folder for new .zip files.
/// Runs in a background thread for the lifetime of the app.
pub fn start_downloads_watcher(app: AppHandle, state: AppState) {
    std::thread::spawn(move || {
        let downloads_dir = match dirs::download_dir() {
            Some(d) => d,
            None => {
                log::warn!("Could not determine Downloads directory; watcher disabled.");
                return;
            }
        };

        log::info!(
            "Downloads watcher started, monitoring: {}",
            downloads_dir.display()
        );

        let (tx, rx) = mpsc::channel();

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to create file watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&downloads_dir, RecursiveMode::NonRecursive) {
            log::error!("Failed to watch Downloads dir: {}", e);
            return;
        }

        // Track recently processed files to avoid duplicates (notify can fire multiple events)
        let mut recent: std::collections::HashMap<PathBuf, Instant> =
            std::collections::HashMap::new();

        loop {
            match rx.recv() {
                Ok(Ok(event)) => {
                    if !matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_)
                    ) {
                        continue;
                    }

                    for path in &event.paths {
                        // Only process .zip files
                        let ext = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        if ext != "zip" {
                            continue;
                        }

                        // Skip if we processed this file in the last 5 seconds
                        if let Some(last) = recent.get(path) {
                            if last.elapsed() < Duration::from_secs(5) {
                                continue;
                            }
                        }

                        // Wait a moment for the download to finish writing
                        std::thread::sleep(Duration::from_millis(1500));

                        // Verify file still exists and is non-empty
                        let meta = match std::fs::metadata(path) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        if meta.len() == 0 {
                            continue;
                        }

                        // Check if it looks like a mod zip (contains .dll, .pck, or .json)
                        if !looks_like_mod_zip(path) {
                            continue;
                        }

                        recent.insert(path.clone(), Instant::now());

                        let mods_path = {
                            let s = match state.lock() {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            match s.mods_path.clone() {
                                Some(p) => p,
                                None => continue,
                            }
                        };

                        log::info!("Downloads watcher: detected mod zip {:?}", path);

                        match install_mod_from_zip(path, &mods_path) {
                            Ok(mod_info) => {
                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();

                                log::info!(
                                    "Auto-installed mod '{}' from {}",
                                    mod_info.name,
                                    file_name
                                );

                                let _ = app.emit(
                                    "mod-auto-installed",
                                    ModAutoInstalled {
                                        mod_name: mod_info.name,
                                        file_name,
                                    },
                                );
                            }
                            Err(e) => {
                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();

                                log::warn!(
                                    "Downloads watcher: failed to install {}: {}",
                                    file_name,
                                    e
                                );

                                let _ = app.emit(
                                    "mod-auto-install-failed",
                                    ModAutoInstallFailed {
                                        file_name,
                                        error: e.to_string(),
                                    },
                                );
                            }
                        }
                    }

                    // Clean up old entries from the dedup map
                    recent.retain(|_, t| t.elapsed() < Duration::from_secs(30));
                }
                Ok(Err(e)) => {
                    log::warn!("File watcher error: {}", e);
                }
                Err(_) => {
                    log::info!("Downloads watcher channel closed, stopping.");
                    break;
                }
            }
        }
    });
}

/// Quick check: does the zip contain at least one .dll, .pck, or mod .json file?
fn looks_like_mod_zip(path: &PathBuf) -> bool {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return false,
    };
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_lowercase();
            if name.ends_with(".dll") || name.ends_with(".pck") {
                return true;
            }
            // A .json at root or one level deep that isn't package.json etc.
            if name.ends_with(".json")
                && !name.contains("package.json")
                && !name.contains("tsconfig")
            {
                // Check if it looks like a mod manifest
                if name.split('/').count() <= 2 {
                    return true;
                }
            }
        }
    }
    false
}
