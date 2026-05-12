use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::mod_sources::{load_sources, save_sources};
use crate::mods::{install_mod_from_zip, scan_mods, scan_disabled_mods, ModInfo};
use crate::state::AppState;

/// Payload emitted to the frontend when a mod is auto-installed from Downloads.
#[derive(Clone, serde::Serialize)]
pub struct ModAutoInstalled {
    pub mod_name: String,
    pub file_name: String,
    /// If this was an update to an existing mod, the old name
    pub replaced: Option<String>,
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
        let mut recent: HashMap<PathBuf, Instant> = HashMap::new();

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

                        // Don't auto-install while the game is running — file
                        // moves on the mods folder can crash the game or leave
                        // it in a half-applied state. The user will see the
                        // file in Downloads and can re-trigger the watcher
                        // (e.g., by saving the file again) once the game exits.
                        if crate::game::is_game_running() {
                            log::info!(
                                "Downloads watcher: skipping {:?} — game is running",
                                path
                            );
                            let _ = app.emit("mod-auto-install-failed", serde_json::json!({
                                "file_name": path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                "error": "Slay the Spire 2 is running. Close the game and re-save the file to install."
                            }));
                            continue;
                        }

                        recent.insert(path.clone(), Instant::now());

                        let (mods_path, disabled_path, config_path) = {
                            let s = match state.lock() {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            let mp = match s.mods_path.clone() {
                                Some(p) => p,
                                None => continue,
                            };
                            let dp = s.disabled_mods_path.clone();
                            let cp = s.config_path.clone();
                            (mp, dp, cp)
                        };

                        log::info!("Downloads watcher: detected mod zip {:?}", path);

                        // Peek at the incoming zip to identify the mod
                        let incoming_identity = peek_zip_identity(path);
                        log::info!(
                            "Downloads watcher: zip identity — name: {:?}, mod_id: {:?}, folder: {:?}, clean_stem: {:?}",
                            incoming_identity.name,
                            incoming_identity.mod_id,
                            incoming_identity.folder_name,
                            incoming_identity.zip_stem_clean
                        );

                        // Find existing mod that matches
                        let existing_mod = find_existing_mod(
                            &incoming_identity,
                            &mods_path,
                            disabled_path.as_deref(),
                        );

                        // If the existing mod is pinned, skip auto-install entirely.
                        // Folder-first lookup — without it, a pin saved under
                        // folder_name (the post-1.3.0 write key) wouldn't be
                        // found and the watcher would happily overwrite a
                        // pinned install.
                        if let Some(ref existing) = existing_mod {
                            let sources_db = crate::mod_sources::load_sources(&config_path);
                            let entry = crate::mod_sources::lookup_entry(
                                &sources_db.mods,
                                existing.folder_name.as_deref(),
                                &existing.name,
                                existing.mod_id.as_deref(),
                            );
                            if let Some(entry) = entry {
                                if entry.pinned {
                                    log::info!(
                                        "Downloads watcher: skipping '{}' — mod is pinned",
                                        existing.name
                                    );
                                    let _ = app.emit("mod-auto-install-failed", serde_json::json!({
                                        "file_name": path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                        "error": format!("'{}' is pinned and cannot be auto-updated. Unpin it first.", existing.name)
                                    }));
                                    continue;
                                }
                            }
                        }

                        // If we found an existing mod, remove old files first
                        let replaced_name = if let Some(ref existing) = existing_mod {
                            log::info!(
                                "Downloads watcher: updating existing mod '{}' (folder: {:?})",
                                existing.name,
                                existing.folder_name
                            );
                            remove_existing_mod_files(existing, &mods_path, disabled_path.as_deref());
                            Some(existing.name.clone())
                        } else {
                            None
                        };

                        match install_mod_from_zip(path, &mods_path) {
                            Ok(mod_info) => {
                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();

                                // Transfer mod_sources entry from old name to new name
                                if let Some(ref old_name) = replaced_name {
                                    if old_name != &mod_info.name {
                                        transfer_mod_sources(old_name, &mod_info.name, &config_path);
                                    }
                                }

                                // If the user just queued this mod via Quick Add (Nexus),
                                // attach the Nexus URL to the mod's source entry now.
                                attach_pending_nexus_source(
                                    &mod_info.name,
                                    &file_name,
                                    &config_path,
                                    &state,
                                );

                                // Update installed_version in mod_sources so the audit
                                // knows we just installed this version.
                                // First try to get the real version from Nexus API (mod
                                // manifests often have stale version strings). Fall back
                                // to the manifest version if Nexus isn't available.
                                {
                                    let nexus_ver = fetch_nexus_version_blocking(&mod_info.name, &config_path, &state);
                                    let version_to_store = nexus_ver
                                        .unwrap_or_else(|| mod_info.version.clone());
                                    if version_to_store != "unknown" && version_to_store != "0.0.0" {
                                        // Folder-first key so installed_version is stored
                                        // under the same DB key the folder-first read
                                        // path (enrich/audit/pin) uses.
                                        let install_key = mod_info.folder_name
                                            .as_deref()
                                            .unwrap_or(mod_info.name.as_str());
                                        crate::mod_sources::update_installed_version(
                                            install_key,
                                            &version_to_store,
                                            &config_path,
                                        );
                                        log::info!(
                                            "Stored installed_version '{}' for '{}'",
                                            version_to_store,
                                            mod_info.name
                                        );
                                    }
                                }

                                log::info!(
                                    "Auto-installed mod '{}' from {} (replaced: {:?})",
                                    mod_info.name,
                                    file_name,
                                    replaced_name
                                );

                                let _ = app.emit(
                                    "mod-auto-installed",
                                    ModAutoInstalled {
                                        mod_name: mod_info.name,
                                        file_name,
                                        replaced: replaced_name,
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

/// Identity extracted from an incoming zip's manifest.
struct ZipIdentity {
    name: Option<String>,
    mod_id: Option<String>,
    folder_name: Option<String>,
    /// The zip file stem, cleaned of Nexus suffixes (e.g. "RelicsReminder" from "RelicsReminder-284-1-1-0-1775500710.zip")
    zip_stem_clean: Option<String>,
}

/// Peek inside a zip to extract mod identity from its manifest JSON.
fn peek_zip_identity(zip_path: &Path) -> ZipIdentity {
    let file = match std::fs::File::open(zip_path) {
        Ok(f) => f,
        Err(_) => return ZipIdentity { name: None, mod_id: None, folder_name: None, zip_stem_clean: None },
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return ZipIdentity { name: None, mod_id: None, folder_name: None, zip_stem_clean: None },
    };

    // Also extract the folder name from the zip structure
    let mut top_dir: Option<String> = None;
    let mut top_dirs = std::collections::HashSet::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.contains('/') {
                if let Some(first) = name.split('/').next() {
                    top_dirs.insert(first.to_string());
                }
            }
        }
    }
    if top_dirs.len() == 1 {
        top_dir = top_dirs.into_iter().next();
    }

    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            let entry_name = entry.name().to_string();
            if !entry_name.to_lowercase().ends_with(".json") {
                continue;
            }
            // Skip deep paths, macOS junk
            if entry_name.starts_with("__MACOSX") || entry_name.starts_with("._") {
                continue;
            }
            if entry_name.split('/').count() > 2 {
                continue;
            }
            // Try to read and parse
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut entry, &mut buf).is_ok() {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&buf) {
                    let mod_name = val.get("Name")
                        .or_else(|| val.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let mod_id = val.get("Id")
                        .or_else(|| val.get("id"))
                        .or_else(|| val.get("ModId"))
                        .or_else(|| val.get("mod_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    if mod_name.is_some() || mod_id.is_some() {
                        let zip_stem = zip_path
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        return ZipIdentity {
                            name: mod_name,
                            mod_id,
                            folder_name: top_dir,
                            zip_stem_clean: Some(strip_nexus_suffix(&zip_stem)),
                        };
                    }
                }
            }
        }
    }

    // No manifest found, use zip structure
    let zip_stem = zip_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let clean_stem = strip_nexus_suffix(&zip_stem);

    ZipIdentity {
        name: None,
        mod_id: None,
        folder_name: top_dir.or(Some(zip_stem)),
        zip_stem_clean: Some(clean_stem),
    }
}

/// Find an existing installed mod that matches the incoming zip identity.
fn find_existing_mod(
    identity: &ZipIdentity,
    mods_path: &Path,
    disabled_path: Option<&Path>,
) -> Option<ModInfo> {
    let mut all_mods = scan_mods(mods_path);
    if let Some(dp) = disabled_path {
        all_mods.extend(scan_disabled_mods(dp));
    }

    // Try matching by mod_id first (most reliable)
    if let Some(ref incoming_id) = identity.mod_id {
        let lower_id = incoming_id.to_lowercase();
        for m in &all_mods {
            if let Some(ref mid) = m.mod_id {
                if mid.to_lowercase() == lower_id {
                    return Some(m.clone());
                }
            }
        }
    }

    // Try matching by name (case-insensitive, ignoring common suffixes like "Lite")
    if let Some(ref incoming_name) = identity.name {
        let normalized = normalize_mod_name(incoming_name);
        for m in &all_mods {
            if normalize_mod_name(&m.name) == normalized {
                return Some(m.clone());
            }
        }
        // Also try substring match (e.g., "BetterSpire2" matches "BetterSpire2 Lite")
        for m in &all_mods {
            let existing_norm = normalize_mod_name(&m.name);
            if existing_norm.contains(&normalized) || normalized.contains(&existing_norm) {
                return Some(m.clone());
            }
        }
    }

    // Try matching by folder name
    if let Some(ref incoming_folder) = identity.folder_name {
        let lower_folder = incoming_folder.to_lowercase();
        for m in &all_mods {
            if let Some(ref folder) = m.folder_name {
                if folder.to_lowercase() == lower_folder {
                    return Some(m.clone());
                }
            }
        }
    }

    // Try matching by cleaned zip filename (strips Nexus suffixes like -284-1-1-0-1775500710)
    if let Some(ref clean_stem) = identity.zip_stem_clean {
        let lower_stem = clean_stem.to_lowercase();
        // Exact match against folder name or mod name (without spaces)
        for m in &all_mods {
            let name_nospace = m.name.to_lowercase().replace(' ', "");
            if name_nospace == lower_stem {
                return Some(m.clone());
            }
            if let Some(ref folder) = m.folder_name {
                if folder.to_lowercase().replace(' ', "") == lower_stem {
                    return Some(m.clone());
                }
            }
        }
        // Substring/contains match
        for m in &all_mods {
            let name_nospace = m.name.to_lowercase().replace(' ', "");
            if name_nospace.contains(&lower_stem) || lower_stem.contains(&name_nospace) {
                if !lower_stem.is_empty() && lower_stem.len() >= 4 {
                    return Some(m.clone());
                }
            }
        }
    }

    None
}

/// Normalize a mod name for fuzzy matching: lowercase, strip common suffixes/prefixes.
fn normalize_mod_name(name: &str) -> String {
    name.to_lowercase()
        .replace(" lite", "")
        .replace(" full", "")
        .replace(" plus", "")
        .replace(" pro", "")
        .trim()
        .to_string()
}

/// Strip Nexus Mods filename suffixes.
/// E.g. "RelicsReminder-284-1-1-0-1775500710" -> "RelicsReminder"
/// Pattern: ModName followed by -digits repeated (mod ID, version parts, file ID)
fn strip_nexus_suffix(stem: &str) -> String {
    // Find the first dash followed by only digits-and-dashes until the end
    // Walk from the end backwards to find where the numeric suffix starts
    let bytes = stem.as_bytes();
    let mut cut_pos = stem.len();

    // Try to find the pattern: -digits(-digits)*$ at the end
    let mut pos = stem.len();
    loop {
        // Skip digits backwards
        let digit_end = pos;
        while pos > 0 && bytes[pos - 1].is_ascii_digit() {
            pos -= 1;
        }
        if pos == digit_end {
            // No digits found
            break;
        }
        // Check for dash before the digits
        if pos > 0 && bytes[pos - 1] == b'-' {
            cut_pos = pos - 1;
            pos -= 1;
        } else {
            break;
        }
    }

    if cut_pos > 0 && cut_pos < stem.len() {
        stem[..cut_pos].to_string()
    } else {
        stem.to_string()
    }
}

/// Remove an existing mod's files from disk (both enabled and disabled paths).
fn remove_existing_mod_files(
    existing: &ModInfo,
    mods_path: &Path,
    disabled_path: Option<&Path>,
) {
    // Determine the folder name to look for
    let folder = existing
        .folder_name
        .as_deref()
        .unwrap_or(&existing.name);

    // Try removing from mods path
    let mod_dir = mods_path.join(folder);
    if mod_dir.exists() {
        log::info!("Removing old mod directory: {:?}", mod_dir);
        let _ = std::fs::remove_dir_all(&mod_dir);
    }

    // Also remove any top-level manifest/files
    for file in &existing.files {
        let p = mods_path.join(file);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }

    // Try removing from disabled path
    if let Some(dp) = disabled_path {
        let disabled_dir = dp.join(folder);
        if disabled_dir.exists() {
            log::info!("Removing old disabled mod directory: {:?}", disabled_dir);
            let _ = std::fs::remove_dir_all(&disabled_dir);
        }
        for file in &existing.files {
            let p = dp.join(file);
            if p.exists() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// Transfer mod_sources entry from old mod name to new mod name.
fn transfer_mod_sources(old_name: &str, new_name: &str, config_path: &Path) {
    let mut db = load_sources(config_path);
    if let Some(entry) = db.mods.remove(old_name) {
        log::info!(
            "Transferring mod sources from '{}' to '{}'",
            old_name,
            new_name
        );
        db.mods.insert(new_name.to_string(), entry);
        if let Err(e) = save_sources(&db, config_path) {
            log::error!("Failed to save mod sources after transfer: {}", e);
        }
    }
}

/// Query the Nexus API (blocking) for the current version of a mod.
/// Returns None if the mod has no Nexus source or if the API call fails.
///
/// Pages with multiple variants (e.g. BetterSpire2 + BetterSpire2Lite) report
/// a single page-level `version` that's whichever file the author uploaded
/// last. To stay accurate we also pull the files list and pick the one that
/// matches the local mod's flavor (currently: "lite" detection).
fn fetch_nexus_version_blocking(
    mod_name: &str,
    config_path: &Path,
    state: &AppState,
) -> Option<String> {
    let db = load_sources(config_path);
    let entry = db.mods.get(mod_name)?;
    let domain = entry.nexus_game_domain.as_ref()?;
    let mod_id = entry.nexus_mod_id?;

    let api_key = {
        let s = state.lock().ok()?;
        s.nexus_api_key.clone()?
    };

    let client = reqwest::blocking::Client::new();
    let mk_get = |url: &str| {
        client
            .get(url)
            .header("apikey", &api_key)
            .header("accept", "application/json")
            .header("user-agent", concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
    };

    // 1. Page-level version as the fallback.
    let page_url = format!(
        "https://api.nexusmods.com/v1/games/{}/mods/{}.json",
        domain, mod_id
    );
    let page_version = mk_get(&page_url)
        .send()
        .ok()
        .and_then(|r| r.error_for_status().ok())
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|info| info.get("version")?.as_str().map(|s| s.to_string()))
        .filter(|v| !v.is_empty());

    // 2. Files list — pick the variant matching the local mod's flavor.
    let files_url = format!(
        "https://api.nexusmods.com/v1/games/{}/mods/{}/files.json",
        domain, mod_id
    );
    let picked = mk_get(&files_url)
        .send()
        .ok()
        .and_then(|r| r.error_for_status().ok())
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|v| {
            let arr = v.get("files")?.as_array()?.clone();
            let files: Vec<crate::nexus::NexusFile> = arr
                .into_iter()
                .filter_map(|item| serde_json::from_value(item).ok())
                .collect();
            crate::nexus::pick_version_for_local_mod(&files, mod_name)
        });

    picked.or(page_version)
}

/// If the user recently queued a Nexus mod via Quick Add and this download
/// matches it (by mod_id in the filename or fuzzy name match), attach the
/// Nexus URL to the mod's source entry and consume the pending hint.
fn attach_pending_nexus_source(
    installed_name: &str,
    file_name: &str,
    config_path: &Path,
    state: &AppState,
) {
    let consumed = {
        let mut s = match state.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        // Drop entries older than 30 minutes before searching.
        s.pending_nexus_installs.retain(|p| {
            Instant::now().duration_since(p.queued_at) < Duration::from_secs(30 * 60)
        });

        let stem_lower = file_name.to_lowercase();
        let installed_norm = normalize_mod_name(installed_name);

        let idx = s.pending_nexus_installs.iter().position(|p| {
            // Nexus filenames look like "ModName-{mod_id}-{version}-...zip"
            let id_marker = format!("-{}-", p.mod_id);
            if stem_lower.contains(&id_marker) {
                return true;
            }
            let p_norm = normalize_mod_name(&p.mod_name);
            !p_norm.is_empty()
                && (installed_norm.contains(&p_norm) || p_norm.contains(&installed_norm))
        });

        idx.map(|i| s.pending_nexus_installs.remove(i))
    };

    let Some(pending) = consumed else { return };

    let mut db = crate::mod_sources::load_sources(config_path);
    let entry = db.mods.entry(installed_name.to_string()).or_default();
    entry.nexus_url = Some(pending.nexus_url);
    entry.nexus_game_domain = Some(pending.game_domain);
    entry.nexus_mod_id = Some(pending.mod_id);
    match crate::mod_sources::save_sources(&db, config_path) {
        Ok(_) => log::info!(
            "Auto-attached Nexus source to '{}' (mod_id {})",
            installed_name,
            pending.mod_id
        ),
        Err(e) => log::warn!(
            "Failed to persist auto-attached Nexus source for '{}': {}",
            installed_name,
            e
        ),
    }
}

/// Quick check: does the zip contain at least one .dll, .pck, or mod .json file?
fn looks_like_mod_zip(path: &Path) -> bool {
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
