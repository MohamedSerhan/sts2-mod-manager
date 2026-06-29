use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::mods::{install_mod_from_archive, scan_disabled_mods, scan_mods, ModInfo};
use crate::state::AppState;

/// Payload emitted to the frontend when a mod is auto-installed from Downloads.
#[derive(Clone, serde::Serialize)]
pub struct ModAutoInstalled {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
    pub mod_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    pub file_name: String,
    /// If this was an update to an existing mod, the old name
    pub replaced: Option<String>,
    /// Config files we carried forward from the previous install
    /// because the user had edited them. Drives the post-update
    /// "preserved N files" toast. Empty list when this was a fresh
    /// install, when the mod has no tracked configs, or when nothing
    /// was actually user-edited.
    #[serde(default)]
    pub preserved_configs: Vec<String>,
    /// Present when the archive installed cleanly but declares a
    /// `min_game_version` newer than the user's detected STS2 build.
    /// The file remains available to manage, but the game will skip it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incompatible: Option<ModAutoInstalledIncompatible>,
}

#[derive(Clone, serde::Serialize, PartialEq, Eq, Debug)]
pub struct ModAutoInstalledIncompatible {
    pub min_game_version: String,
    pub user_game_version: String,
}

#[derive(Clone, serde::Serialize)]
pub struct ModAutoInstallFailed {
    pub file_name: String,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_version: Option<String>,
}

fn incompatible_install_payload(
    info: &ModInfo,
    user_game_version: Option<&str>,
) -> Option<ModAutoInstalledIncompatible> {
    if !crate::updater::install_is_incompatible(info, user_game_version) {
        return None;
    }
    Some(ModAutoInstalledIncompatible {
        min_game_version: info.min_game_version.clone().unwrap_or_default(),
        user_game_version: user_game_version.unwrap_or_default().to_string(),
    })
}

fn failed_update_install_payload(
    file_name: String,
    error: String,
    existing: &ModInfo,
    skip_version: Option<String>,
) -> ModAutoInstallFailed {
    let skip_version = skip_version.and_then(|version| {
        let trimmed = version.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    if skip_version.is_none() {
        return ModAutoInstallFailed {
            file_name,
            error,
            mod_version_id: None,
            mod_name: None,
            folder_name: None,
            mod_id: None,
            skip_version: None,
        };
    }

    ModAutoInstallFailed {
        file_name,
        error,
        mod_version_id: existing.mod_version_id.clone(),
        mod_name: Some(existing.name.clone()),
        folder_name: existing.folder_name.clone(),
        mod_id: existing.mod_id.clone(),
        skip_version,
    }
}

pub(crate) fn exact_download_source_version(path: &Path, manifest_version: &str) -> Option<String> {
    crate::mods::bundle::nexus_file_version(path)
        .or_else(|| crate::mod_versions::usable_source_version_label(manifest_version))
}

fn display_source_version(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.starts_with(['v', 'V']) {
        trimmed.to_string()
    } else {
        format!("v{trimmed}")
    }
}

fn duplicate_downloaded_update_error(
    existing: &ModInfo,
    downloaded_source_version: Option<&str>,
    config_path: &Path,
) -> Option<String> {
    let downloaded =
        downloaded_source_version.and_then(crate::mod_versions::usable_source_version_label)?;
    let current =
        crate::mod_versions::installed_source_version_label_for_mod(existing, config_path)
            .or_else(|| crate::mod_versions::usable_source_version_label(&existing.version))?;
    match crate::mod_versions::compare_source_version_labels(&current, &downloaded) {
        Some(std::cmp::Ordering::Equal) => Some(format!(
            "Downloaded update for '{}' is {}, which is already the current stored version. Keep showing this update if you want to choose a different Nexus file.",
            existing.name,
            display_source_version(&downloaded),
        )),
        Some(std::cmp::Ordering::Less | std::cmp::Ordering::Greater) => None,
        None => None,
    }
}

/// Determine which directory the watcher should monitor.
///
/// Returns the user-configured `nexus_download_dir` from state when set;
/// falls back to the OS default Downloads directory otherwise.
pub(crate) fn resolve_watch_dir(state: &AppState) -> Option<PathBuf> {
    let configured = state.lock().ok().and_then(|s| s.nexus_download_dir.clone());
    if let Some(dir) = configured {
        return Some(dir);
    }
    dirs::download_dir()
}

/// Start watching the configured (or default) Downloads folder for new mod archives.
/// Runs in a background thread for the lifetime of the app.
pub fn start_downloads_watcher(app: AppHandle, state: AppState) {
    std::thread::spawn(move || {
        let downloads_dir = match resolve_watch_dir(&state) {
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
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }

                    for path in &event.paths {
                        // Only process .zip files
                        let ext = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        // Accept the three archive formats the install
                        // pipeline knows how to read. .7z and .rar route
                        // through extract → repack → zip pipeline.
                        if !matches!(ext.as_str(), "zip" | "7z" | "rar") {
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
                            log::info!("Downloads watcher: skipping {:?} — game is running", path);
                            let _ = app.emit("mod-auto-install-failed", serde_json::json!({
                                "file_name": path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                "error": "Slay the Spire 2 is running. Close the game and re-save the file to install."
                            }));
                            continue;
                        }

                        recent.insert(path.clone(), Instant::now());

                        let (
                            mods_path,
                            disabled_path,
                            profiles_path,
                            cache_path,
                            config_path,
                            game_version,
                        ) = {
                            let s = match state.lock() {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            let mp = match s.mods_path.clone() {
                                Some(p) => p,
                                None => continue,
                            };
                            let dp = s.disabled_mods_path.clone();
                            let pp = s.profiles_path.clone();
                            let cache = s.cache_path.clone();
                            let cp = s.config_path.clone();
                            let gv = s.game_version.clone();
                            (mp, dp, pp, cache, cp, gv)
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
                        let pending_nexus_mod_id =
                            pending_nexus_mod_id_for_download(&path, &incoming_identity, &state);
                        if let (Some(existing), Some(pending_mod_id)) =
                            (existing_mod.as_ref(), pending_nexus_mod_id)
                        {
                            if crate::mod_sources::saved_nexus_source_conflicts(
                                &config_path,
                                existing.folder_name.as_deref(),
                                &existing.name,
                                existing.mod_id.as_deref(),
                                pending_mod_id,
                            ) {
                                log::warn!(
                                    "Downloads watcher: refusing to auto-install {:?} over '{}' because saved Nexus source conflicts with pending Nexus mod_id {}",
                                    path,
                                    existing.name,
                                    pending_mod_id
                                );
                                let _ = app.emit("mod-auto-install-failed", serde_json::json!({
                                    "file_name": path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                    "error": "This Nexus download looks like a different mod than the installed one. The existing mod was left unchanged."
                                }));
                                continue;
                            }
                        }

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
                                        "Downloads watcher: skipping '{}' — mod is frozen",
                                        existing.name
                                    );
                                    let _ = app.emit("mod-auto-install-failed", serde_json::json!({
                                        "file_name": path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                        "error": format!("'{}' is frozen and cannot be auto-updated. Unfreeze it first.", existing.name)
                                    }));
                                    continue;
                                }
                            }
                        }

                        // Two flows: fresh install vs. update. For updates we
                        // read user-edited configs BEFORE deleting the old
                        // install, run the existing delete+install pipeline
                        // unchanged, then overlay the preserved bytes onto
                        // the new folder. Fresh installs just snapshot the
                        // post-install state so the FIRST update preserves
                        // things.
                        let replaced_identity = existing_mod
                            .as_ref()
                            .map(|e| (e.name.clone(), e.folder_name.clone()));

                        if let Some(existing) = existing_mod.as_ref() {
                            let file_name = path
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let mut skip_version = crate::mods::bundle::nexus_file_version(path);
                            let promote_result: std::result::Result<
                                crate::updater::PromotionOutcome,
                                String,
                            > = (|| {
                                let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
                                let mut staged = install_mod_from_archive(path, staging.path())
                                    .map_err(|e| e.to_string())?;
                                attach_pending_nexus_source(
                                    &staged.name,
                                    staged.folder_name.as_deref(),
                                    staged.mod_id.as_deref(),
                                    &file_name,
                                    &config_path,
                                    &state,
                                );
                                if staged.source.is_none() {
                                    staged.source = crate::mod_versions::source_hint_for_mod(
                                        existing,
                                        &config_path,
                                    )
                                    .or_else(|| {
                                        crate::mod_versions::source_hint_for_mod(
                                            &staged,
                                            &config_path,
                                        )
                                    });
                                }
                                let source_version =
                                    exact_download_source_version(path, &staged.version);
                                if skip_version.is_none() {
                                    skip_version = source_version.clone();
                                }
                                if let Some(error) = duplicate_downloaded_update_error(
                                    existing,
                                    source_version.as_deref(),
                                    &config_path,
                                ) {
                                    skip_version = None;
                                    return Err(error);
                                }
                                let source_hint = staged.source.clone().or_else(|| {
                                    crate::mod_versions::source_hint_for_mod(existing, &config_path)
                                });
                                crate::updater::promote_archive_to_library(
                                    path,
                                    existing,
                                    source_hint,
                                    source_version.as_deref(),
                                    "nexus",
                                    &mods_path,
                                    disabled_path.as_deref(),
                                    &profiles_path,
                                    &cache_path,
                                    &config_path,
                                    game_version.as_deref(),
                                )
                            })();

                            match promote_result {
                                Ok(outcome) => {
                                    let mod_info = outcome.mod_info;
                                    let incompatible = incompatible_install_payload(
                                        &mod_info,
                                        game_version.as_deref(),
                                    );
                                    log::info!(
                                        "Downloads watcher: promoted '{}' from {} as the Library version for existing '{}'",
                                        mod_info.name,
                                        file_name,
                                        existing.name
                                    );
                                    crate::mod_sources::emit_configs_lost(
                                        &app,
                                        &mod_info.name,
                                        &outcome.lost_configs,
                                    );
                                    let _ = app.emit(
                                        "mod-auto-installed",
                                        ModAutoInstalled {
                                            mod_version_id: mod_info.mod_version_id,
                                            mod_name: mod_info.name,
                                            folder_name: mod_info.folder_name,
                                            mod_id: mod_info.mod_id,
                                            file_name,
                                            replaced: Some(existing.name.clone()),
                                            preserved_configs: outcome.preserved_configs,
                                            incompatible,
                                        },
                                    );
                                }
                                Err(e) => {
                                    log::error!(
                                        "Downloads watcher: failed to promote {}: {}",
                                        file_name,
                                        e
                                    );
                                    let _ = app.emit(
                                        "mod-auto-install-failed",
                                        failed_update_install_payload(
                                            file_name,
                                            e.to_string(),
                                            existing,
                                            skip_version.clone(),
                                        ),
                                    );
                                }
                            }
                            continue;
                        }

                        // Step 1 (update only): read user-edited configs.
                        // Must happen BEFORE remove_existing_mod_files —
                        // that helper deletes the wrap folder, after which
                        // there's nothing left to preserve.
                        let pre_update_preserved = existing_mod
                            .as_ref()
                            .map(|existing| {
                                let old_folder = existing
                                    .folder_name
                                    .clone()
                                    .unwrap_or_else(|| existing.name.clone());
                                crate::mods::prepare_update_with_preserved_configs(
                                    &old_folder,
                                    &existing.name,
                                    &mods_path,
                                    &config_path,
                                )
                            })
                            .unwrap_or_default();

                        // For an update, move the old mod's files ASIDE rather
                        // than deleting them outright. If the install below
                        // returns Err we restore them, so a failed update can
                        // never leave the user with the old mod gone and no
                        // replacement (audit L-10). On success we discard the
                        // stash. `None` for a fresh install (nothing to stash).
                        let stashed_existing = existing_mod.as_ref().map(|existing| {
                            log::info!(
                                "Downloads watcher: updating existing mod '{}' (folder: {:?}, preserving {} config files)",
                                existing.name,
                                existing.folder_name,
                                pre_update_preserved.len(),
                            );
                            stash_existing_mod_files(existing, &mods_path, disabled_path.as_deref())
                        });

                        let install_outcome: std::result::Result<
                            (crate::mods::ModInfo, Vec<String>, Vec<String>),
                            String,
                        > = install_mod_from_archive(path, &mods_path)
                            .map_err(|e| e.to_string())
                            .and_then(|info| {
                                if existing_mod.is_some() {
                                    // Update path: overlay user edits +
                                    // snapshot the post-restore state.
                                    crate::mods::finalize_update_with_preserved_configs(
                                        &info,
                                        &mods_path,
                                        pre_update_preserved,
                                        &config_path,
                                    )
                                    .map(|outcome| (info, outcome.preserved, outcome.lost))
                                    .map_err(|e| e.to_string())
                                } else {
                                    // Fresh install: just snapshot. No
                                    // preservation possible (nothing to
                                    // preserve from).
                                    crate::mods::snapshot_after_fresh_install(
                                        &info,
                                        &mods_path,
                                        &config_path,
                                    );
                                    Ok((info, Vec::new(), Vec::new()))
                                }
                            });

                        match install_outcome {
                            Ok((mut mod_info, preserved_configs, lost_configs)) => {
                                // Install succeeded — the new mod is in place,
                                // so drop the stashed copy of the old one.
                                if let Some(stash) = stashed_existing {
                                    stash.discard();
                                }
                                crate::mod_versions::ensure_mod_info_id(
                                    &mut mod_info,
                                    &config_path,
                                );

                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();

                                // Carry the source entry forward across the
                                // install. Folder-first lookup + folder-first
                                // write means the new entry sits at the same
                                // key the rest of the codebase reads from —
                                // fixes the "Nexus link reset after update"
                                // bug.
                                if let Some((ref old_name, ref old_folder)) = replaced_identity {
                                    crate::mod_sources::carry_source_entry(
                                        old_folder.as_deref(),
                                        old_name,
                                        mod_info.folder_name.as_deref(),
                                        &mod_info.name,
                                        &config_path,
                                    );
                                }

                                // If the user just queued this mod via Quick Add (Nexus),
                                // attach the Nexus URL to the mod's source entry now.
                                attach_pending_nexus_source(
                                    &mod_info.name,
                                    mod_info.folder_name.as_deref(),
                                    mod_info.mod_id.as_deref(),
                                    &file_name,
                                    &config_path,
                                    &state,
                                );

                                // Update installed_version in mod_sources so the audit
                                // knows we just installed this version.
                                // Resolve the version to record. Priority:
                                //  1. the version in the Nexus download filename
                                //     ("...-979-2-1-..." -> "2.1") — exactly the file the
                                //     user installed, no API key/network needed;
                                //  2. the archive's manifest version if it is usable.
                                let version_to_store_for_bundle;
                                {
                                    let version_to_store =
                                        exact_download_source_version(path, &mod_info.version);
                                    version_to_store_for_bundle = version_to_store.clone();
                                    if let Some(version_to_store) = version_to_store.as_deref() {
                                        // Folder-first key so installed_version is stored
                                        // under the same DB key the folder-first read
                                        // path (enrich/audit/pin) uses.
                                        let install_key = mod_info
                                            .folder_name
                                            .as_deref()
                                            .unwrap_or(mod_info.name.as_str());
                                        crate::mod_sources::update_installed_version_from_source(
                                            install_key,
                                            &version_to_store,
                                            "nexus",
                                            &config_path,
                                        );
                                        log::info!(
                                            "Stored installed_version '{}' for '{}'",
                                            version_to_store,
                                            mod_info.name
                                        );
                                    }
                                }

                                // If this archive produced a bundle container, enrich its
                                // sidecar with the resolved Nexus link + version so the
                                // bundle row can show them. For single-mod installs this
                                // is a no-op (enrich_bundle_sidecar returns false and
                                // leaves no side-effects).
                                {
                                    let install_key = mod_info
                                        .folder_name
                                        .as_deref()
                                        .unwrap_or(mod_info.name.as_str());
                                    let sources_db = crate::mod_sources::load_sources(&config_path);
                                    let nexus_entry = crate::mod_sources::lookup_entry(
                                        &sources_db.mods,
                                        Some(install_key),
                                        &mod_info.name,
                                        mod_info.mod_id.as_deref(),
                                    );
                                    let (nexus_url, nexus_game_domain, nexus_mod_id) = nexus_entry
                                        .map_or((None, None, None), |e| {
                                            (
                                                e.nexus_url.clone(),
                                                e.nexus_game_domain.clone(),
                                                e.nexus_mod_id,
                                            )
                                        });
                                    crate::mods::bundle::enrich_bundle_sidecar(
                                        &mods_path,
                                        path,
                                        None, // human title not available at this point without an extra Nexus API call
                                        nexus_url,
                                        nexus_game_domain,
                                        nexus_mod_id,
                                        version_to_store_for_bundle.clone(),
                                    );
                                }

                                let replaced_name = replaced_identity.map(|(name, _)| name);
                                let incompatible = incompatible_install_payload(
                                    &mod_info,
                                    game_version.as_deref(),
                                );
                                log::info!(
                                    "Auto-installed mod '{}' from {} (replaced: {:?})",
                                    mod_info.name,
                                    file_name,
                                    replaced_name
                                );

                                crate::mod_sources::emit_configs_lost(
                                    &app,
                                    &mod_info.name,
                                    &lost_configs,
                                );
                                let _ = app.emit(
                                    "mod-auto-installed",
                                    ModAutoInstalled {
                                        mod_version_id: mod_info.mod_version_id,
                                        mod_name: mod_info.name,
                                        folder_name: mod_info.folder_name,
                                        mod_id: mod_info.mod_id,
                                        file_name,
                                        replaced: replaced_name,
                                        preserved_configs,
                                        incompatible,
                                    },
                                );
                            }
                            Err(e) => {
                                // Install failed. Put the old mod's files back
                                // so the user isn't left with neither the old
                                // nor the new version (audit L-10). This also
                                // sweeps away any partial output the failed
                                // install left at the old mod's location.
                                if let Some(stash) = stashed_existing {
                                    stash.restore();
                                }

                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();

                                log::error!(
                                    "Downloads watcher: failed to install {}: {}",
                                    file_name,
                                    e
                                );

                                let _ = app.emit(
                                    "mod-auto-install-failed",
                                    ModAutoInstallFailed {
                                        file_name,
                                        error: e.to_string(),
                                        mod_version_id: None,
                                        mod_name: None,
                                        folder_name: None,
                                        mod_id: None,
                                        skip_version: None,
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
        Err(_) => {
            return ZipIdentity {
                name: None,
                mod_id: None,
                folder_name: None,
                zip_stem_clean: None,
            }
        }
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => {
            return ZipIdentity {
                name: None,
                mod_id: None,
                folder_name: None,
                zip_stem_clean: None,
            }
        }
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
                if let Ok(val) =
                    serde_json::from_str::<serde_json::Value>(crate::mods::strip_utf8_bom(&buf))
                {
                    let mod_name = val
                        .get("Name")
                        .or_else(|| val.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let mod_id = val
                        .get("Id")
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

    // Try matching by exact name. Do not collapse variant suffixes such as
    // "Lite": BetterSpire2 and BetterSpire2 Lite are separate mods.
    if let Some(ref incoming_name) = identity.name {
        let normalized = compact_mod_identity(incoming_name);
        for m in &all_mods {
            if compact_mod_identity(&m.name) == normalized {
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
        // Exact compact match against folder name or mod name. Substring
        // matching is intentionally avoided so variants do not replace each
        // other, e.g. BetterSpire2 vs BetterSpire2 Lite.
        for m in &all_mods {
            if compact_mod_identity(&m.name) == compact_mod_identity(&lower_stem) {
                return Some(m.clone());
            }
            if let Some(ref folder) = m.folder_name {
                if compact_mod_identity(folder) == compact_mod_identity(&lower_stem) {
                    return Some(m.clone());
                }
            }
        }
    }

    None
}

/// Normalize a mod name for exact compact matching.
fn normalize_mod_name(name: &str) -> String {
    name.to_lowercase().trim().to_string()
}

/// Compact a mod/file label for loose identity comparisons.
/// Removes punctuation, spaces, and version separators so
/// "STS2BaseCamp V0.4.0" can still match an installed "Base Camp".
fn compact_mod_identity(name: &str) -> String {
    let without_version = strip_display_version_suffix(name);
    let compact: String = without_version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    compact
        .strip_prefix("sts2")
        .unwrap_or(compact.as_str())
        .to_string()
}

fn strip_display_version_suffix(name: &str) -> &str {
    for (idx, ch) in name.char_indices().rev() {
        if (ch == 'v' || ch == 'V')
            && name[idx + ch.len_utf8()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
        {
            return name[..idx].trim();
        }
    }
    name
}

fn identities_overlap(a: &str, b: &str) -> bool {
    let a = compact_mod_identity(&normalize_mod_name(a));
    let b = compact_mod_identity(&normalize_mod_name(b));
    !a.is_empty() && a == b
}

fn labels_match(a: &str, b: &str) -> bool {
    let a_norm = normalize_mod_name(a);
    let b_norm = normalize_mod_name(b);
    (!a_norm.is_empty() && a_norm == b_norm) || identities_overlap(a, b)
}

fn nexus_filename_contains_id(file_name: &str, id: u64) -> bool {
    let stem = Path::new(file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let id = id.to_string();
    stem == id
        || stem.starts_with(&format!("{}-", id))
        || stem.ends_with(&format!("-{}", id))
        || stem.contains(&format!("-{}-", id))
}

fn pending_nexus_name_matches_context(
    pending_name: &str,
    installed_name: &str,
    installed_folder: Option<&str>,
    installed_mod_id: Option<&str>,
    file_name: &str,
) -> bool {
    if pending_name.trim().is_empty() {
        return false;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let clean_stem = strip_nexus_suffix(&stem);

    let matches = [
        Some(installed_name),
        installed_folder,
        installed_mod_id,
        Some(clean_stem.as_str()),
    ]
    .into_iter()
    .flatten()
    .any(|candidate| labels_match(candidate, pending_name));
    matches
}

fn pending_nexus_mod_id_for_download(
    archive_path: &Path,
    identity: &ZipIdentity,
    state: &AppState,
) -> Option<u64> {
    let file_name = archive_path.file_name()?.to_string_lossy().to_string();
    let clean_stem = archive_path
        .file_stem()
        .map(|stem| strip_nexus_suffix(&stem.to_string_lossy()))
        .unwrap_or_default();

    let mut s = state.lock().ok()?;
    s.pending_nexus_installs
        .retain(|p| Instant::now().duration_since(p.queued_at) < Duration::from_secs(30 * 60));

    s.pending_nexus_installs.iter().find_map(|pending| {
        if nexus_filename_contains_id(&file_name, pending.mod_id)
            || pending
                .file_id
                .is_some_and(|file_id| nexus_filename_contains_id(&file_name, file_id))
        {
            return Some(pending.mod_id);
        }
        let pending_name = pending.mod_name.as_str();
        if identity
            .name
            .as_deref()
            .is_some_and(|name| labels_match(name, pending_name))
            || identity
                .folder_name
                .as_deref()
                .is_some_and(|folder| labels_match(folder, pending_name))
            || identity
                .mod_id
                .as_deref()
                .is_some_and(|mod_id| labels_match(mod_id, pending_name))
            || labels_match(&clean_stem, pending_name)
        {
            return Some(pending.mod_id);
        }
        None
    })
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

/// An old mod's files moved ASIDE (not deleted) before an auto-update install,
/// so the update can be rolled back if the install fails. Mirrors the path set
/// the old `remove_existing_mod_files` deleted (mod dir + loose top-level files,
/// in both the enabled and disabled locations), but moves each item to a unique
/// temp sibling on the same filesystem instead of removing it.
///
/// On install success call [`StashedMod::discard`]; on failure call
/// [`StashedMod::restore`] to put the originals back (sweeping away any partial
/// output the failed install left at the original locations).
///
/// Shared with `updater::repair_mod` / `updater::update_mod`, which have the
/// same delete-then-fallible-extract shape (#174).
pub(crate) struct StashedMod {
    /// (original path, temp path it was moved to). Only items that actually
    /// existed are recorded.
    moved: Vec<(PathBuf, PathBuf)>,
}

impl StashedMod {
    /// Success path: the new install is in place, so delete the saved originals.
    pub(crate) fn discard(self) {
        for (_orig, temp) in &self.moved {
            if temp.is_dir() {
                let _ = std::fs::remove_dir_all(temp);
            } else if temp.exists() {
                let _ = std::fs::remove_file(temp);
            }
        }
    }

    /// Failure path: delete whatever now sits at each original location (partial
    /// install output) and move the saved originals back. Done in reverse order
    /// for symmetry with the stash order.
    pub(crate) fn restore(self) {
        for (orig, temp) in self.moved.iter().rev() {
            // Remove any partial install output occupying the original path.
            if orig.is_dir() {
                let _ = std::fs::remove_dir_all(orig);
            } else if orig.exists() {
                let _ = std::fs::remove_file(orig);
            }
            if let Err(e) = std::fs::rename(temp, orig) {
                log::error!(
                    "Failed to restore stashed mod file {:?} -> {:?}: {}",
                    temp,
                    orig,
                    e
                );
            }
        }
    }
}

/// Pick an unused sibling path next to `p` (same parent → same filesystem, so
/// the move is an atomic rename) to hold `p` while the update runs. Works for
/// both files and directories.
fn unique_stash_sibling(p: &Path) -> Option<PathBuf> {
    let parent = p.parent().filter(|p| !p.as_os_str().is_empty())?;
    let base = p.file_name().and_then(|n| n.to_str()).unwrap_or("item");
    for n in 0..100_000u32 {
        let cand = parent.join(format!(".{base}.sts2mm-update-stash-{n}"));
        if !cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// Move `orig` aside to a unique temp sibling and record it in `moved`. No-op if
/// `orig` doesn't exist. On a rename failure the item is left in place (the
/// install will overwrite it as before — we never delete it up front).
fn stash_one(orig: PathBuf, moved: &mut Vec<(PathBuf, PathBuf)>) {
    if !orig.exists() {
        return;
    }
    let Some(temp) = unique_stash_sibling(&orig) else {
        log::error!(
            "Could not allocate a stash path for {:?}; leaving in place",
            orig
        );
        return;
    };
    match std::fs::rename(&orig, &temp) {
        Ok(()) => {
            log::info!("Stashed old mod path {:?} -> {:?}", orig, temp);
            moved.push((orig, temp));
        }
        Err(e) => log::error!("Failed to stash {:?} aside: {} — leaving in place", orig, e),
    }
}

/// Best-effort cleanup of leftover `.<name>.sts2mm-update-stash-*` siblings
/// for `existing`'s folder and top-level files that a crashed earlier
/// update/repair never cleaned up (#174). `unique_stash_sibling` always finds
/// a fresh numbered name, so stale stashes never block a new stash — but
/// without this they'd accumulate forever. Called before stashing the current
/// install so a crash-then-retry doesn't pile up `-0`, `-1`, `-2`, ... dirs.
pub(crate) fn sweep_stale_update_stashes(existing: &ModInfo, mods_path: &Path) {
    let folder = existing.folder_name.as_deref().unwrap_or(&existing.name);
    let mut candidates: Vec<PathBuf> = vec![mods_path.join(folder)];
    candidates.extend(existing.files.iter().map(|f| mods_path.join(f)));

    for orig in &candidates {
        let Some(parent) = orig.parent().filter(|p| !p.as_os_str().is_empty()) else {
            continue;
        };
        let base = match orig.file_name().and_then(|n| n.to_str()) {
            Some(b) => b,
            None => continue,
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        let prefix = format!(".{base}.sts2mm-update-stash-");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with(&prefix) {
                continue;
            }
            let path = entry.path();
            log::warn!(
                "Removing stale update/repair stash left over from a previous run: {:?}",
                path
            );
            let result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(e) = result {
                log::error!("Failed to remove stale stash {:?}: {}", path, e);
            }
        }
    }
}

/// Move an existing mod's files ASIDE (both enabled and disabled paths) so a
/// failed update can restore them. Replaces the old delete-then-install order
/// that left a failed update with the mod gone and no recovery (audit L-10).
pub(crate) fn stash_existing_mod_files(
    existing: &ModInfo,
    mods_path: &Path,
    disabled_path: Option<&Path>,
) -> StashedMod {
    // Determine the folder name to look for
    let folder = existing.folder_name.as_deref().unwrap_or(&existing.name);

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();

    // Move the mod directory in the enabled path aside.
    stash_one(mods_path.join(folder), &mut moved);

    // Also move any top-level manifest/files aside.
    for file in &existing.files {
        stash_one(mods_path.join(file), &mut moved);
    }

    // Same for the disabled path.
    if let Some(dp) = disabled_path {
        stash_one(dp.join(folder), &mut moved);
        for file in &existing.files {
            stash_one(dp.join(file), &mut moved);
        }
    }

    StashedMod { moved }
}

/// Transfer mod_sources entry from old mod name to new mod name.
// The previous `transfer_mod_sources(old_name, new_name, …)` was removed in
// favor of `mod_sources::carry_source_entry`, which is folder-first on both
// read and write. The display-name-only variant left folder-keyed entries
// stranded after a Nexus update — that was the user-reported "link reset"
// bug.

/// If the user recently queued a Nexus mod via Quick Add and this download
/// matches it (by mod_id in the filename or fuzzy name match), attach the
/// Nexus URL to the mod's source entry and consume the pending hint.
fn attach_pending_nexus_source(
    installed_name: &str,
    installed_folder: Option<&str>,
    installed_mod_id: Option<&str>,
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
        s.pending_nexus_installs
            .retain(|p| Instant::now().duration_since(p.queued_at) < Duration::from_secs(30 * 60));

        let idx = s.pending_nexus_installs.iter().position(|p| {
            if crate::mod_sources::saved_nexus_source_conflicts(
                config_path,
                installed_folder,
                installed_name,
                installed_mod_id,
                p.mod_id,
            ) {
                return false;
            }
            // Nexus filenames look like "ModName-{mod_id}-{version}-...zip"
            if nexus_filename_contains_id(file_name, p.mod_id)
                || p.file_id
                    .is_some_and(|file_id| nexus_filename_contains_id(file_name, file_id))
            {
                return true;
            }
            pending_nexus_name_matches_context(
                &p.mod_name,
                installed_name,
                installed_folder,
                installed_mod_id,
                file_name,
            )
        });

        idx.map(|i| s.pending_nexus_installs.remove(i))
    };

    let Some(pending) = consumed else { return };

    let mod_id = pending.mod_id;
    let archive_path = std::path::Path::new(file_name);
    let source_version = crate::mods::bundle::nexus_file_version(archive_path);
    let mut file_identity =
        crate::nexus::nexus_file_identity_from_download(archive_path, source_version.as_deref());
    if file_identity.file_id.is_none() {
        file_identity.file_id = pending.file_id;
    }
    crate::mod_sources::attach_nexus_source_with_file_identity(
        installed_name,
        installed_folder,
        pending.nexus_url,
        pending.game_domain,
        pending.mod_id,
        file_identity.file_id,
        file_identity.file_name,
        file_identity.lane_key,
        config_path,
    );
    log::info!(
        "Auto-attached Nexus source to '{}' (folder {:?}, mod_id {})",
        installed_name,
        installed_folder,
        mod_id
    );
}

/// Quick check: does the archive contain at least one .dll, .pck, or mod .json file?
///
/// For .zip we walk the central directory in-place (cheap).
/// For .7z and .rar we accept-all and let the install pipeline make the
/// real decision after extracting — a "peek" pass would require fully
/// decompressing the archive, defeating the point. False positives just
/// produce a friendly install-failed toast; safe enough.
fn looks_like_mod_zip(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "zip" => {
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
                    if name.ends_with(".json")
                        && !name.contains("package.json")
                        && !name.contains("tsconfig")
                        && name.split('/').count() <= 2
                    {
                        return true;
                    }
                }
            }
            false
        }
        // Optimistic for non-zip formats — the install pipeline either
        // succeeds (good) or emits a `mod-auto-install-failed` event the
        // user sees as a toast (no harm). The auto-install ext gate at
        // the top of the watcher already filters out everything that
        // isn't a known archive extension.
        "7z" | "rar" => true,
        _ => false,
    }
}

#[cfg(test)]
mod watcher_dir_tests {
    use super::resolve_watch_dir;
    use crate::state::create_app_state;
    use std::path::PathBuf;

    #[test]
    fn resolve_watch_dir_prefers_nexus_download_dir_over_os_default() {
        let state = create_app_state();
        let custom = PathBuf::from("/custom/nexus/downloads");
        {
            let mut s = state.lock().unwrap();
            s.nexus_download_dir = Some(custom.clone());
        }
        assert_eq!(resolve_watch_dir(&state), Some(custom));
    }

    #[test]
    fn resolve_watch_dir_falls_back_to_os_default_when_not_configured() {
        let state = create_app_state();
        // nexus_download_dir is None by default in a fresh AppStateInner
        let result = resolve_watch_dir(&state);
        assert_eq!(result, dirs::download_dir());
    }
}

#[cfg(test)]
mod compatibility_payload_tests {
    use super::*;

    fn mod_info_with_min_game_version(min_game_version: Option<&str>) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: "Future Mod".into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some("FutureMod".into()),
            mod_id: Some("future_mod".into()),
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: min_game_version.map(str::to_string),
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn incompatible_install_payload_names_required_and_detected_game_versions() {
        let info = mod_info_with_min_game_version(Some("0.110.0"));

        let payload = incompatible_install_payload(&info, Some("0.105.0"))
            .expect("newer min_game_version should be reported");

        assert_eq!(
            payload,
            ModAutoInstalledIncompatible {
                min_game_version: "0.110.0".into(),
                user_game_version: "0.105.0".into(),
            }
        );
    }

    #[test]
    fn incompatible_install_payload_fails_open_when_versions_are_missing_or_compatible() {
        assert!(incompatible_install_payload(
            &mod_info_with_min_game_version(Some("0.100.0")),
            Some("0.105.0"),
        )
        .is_none());
        assert!(incompatible_install_payload(
            &mod_info_with_min_game_version(Some("0.110.0")),
            None,
        )
        .is_none());
        assert!(incompatible_install_payload(
            &mod_info_with_min_game_version(None),
            Some("0.105.0")
        )
        .is_none());
    }

    #[test]
    fn failed_update_install_payload_names_skip_target_for_matched_update() {
        let mut existing = mod_info_with_min_game_version(None);
        existing.name = "Route Planner".into();
        existing.folder_name = Some("route_planner".into());
        existing.mod_id = Some("route_planner".into());
        existing.mod_version_id = Some("route-planner-v1".into());

        let payload = failed_update_install_payload(
            "RoutePlanner-1260-2-1780.zip".into(),
            "Installed archive did not produce a parseable manifest version.".into(),
            &existing,
            Some("V2".into()),
        );

        assert_eq!(payload.file_name, "RoutePlanner-1260-2-1780.zip");
        assert_eq!(payload.mod_name.as_deref(), Some("Route Planner"));
        assert_eq!(payload.folder_name.as_deref(), Some("route_planner"));
        assert_eq!(payload.mod_id.as_deref(), Some("route_planner"));
        assert_eq!(payload.mod_version_id.as_deref(), Some("route-planner-v1"));
        assert_eq!(payload.skip_version.as_deref(), Some("V2"));
    }

    #[test]
    fn failed_update_install_payload_without_skip_version_stays_toast_only() {
        let existing = mod_info_with_min_game_version(None);

        let payload = failed_update_install_payload(
            "bad.zip".into(),
            "corrupt".into(),
            &existing,
            Some("   ".into()),
        );

        assert_eq!(payload.file_name, "bad.zip");
        assert_eq!(payload.error, "corrupt");
        assert!(payload.mod_name.is_none());
        assert!(payload.folder_name.is_none());
        assert!(payload.mod_id.is_none());
        assert!(payload.mod_version_id.is_none());
        assert!(payload.skip_version.is_none());
    }

    #[test]
    fn watcher_update_rejects_exact_source_version_and_keeps_cached_newer_option() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let source = "https://www.nexusmods.com/slaythespire2/mods/46";

        std::fs::create_dir_all(base.path().join("Watcher")).unwrap();
        std::fs::write(
            base.path().join("Watcher/Watcher.json"),
            r#"{"id":"Watcher","name":"Watcher","version":"v1.4.3"}"#,
        )
        .unwrap();

        let mut existing = mod_info_with_min_game_version(None);
        existing.name = "Watcher".into();
        existing.version = "v1.4.3".into();
        existing.folder_name = Some("Watcher".into());
        existing.mod_id = Some("Watcher".into());
        existing.source = Some(source.into());
        existing.files = vec!["Watcher/Watcher.json".into()];
        existing.hash = Some("watcher-current".into());
        crate::mod_versions::ensure_mod_info_id(&mut existing, config.path()).unwrap();
        crate::mod_versions::set_record_source_version(
            config.path(),
            existing.mod_version_id.as_deref().unwrap(),
            Some("1.4.3"),
        )
        .unwrap();
        crate::mod_sources::attach_nexus_source(
            "Watcher",
            Some("Watcher"),
            source.into(),
            "slaythespire2".into(),
            46,
            config.path(),
        );
        crate::mod_sources::update_installed_version_from_source(
            "Watcher",
            "1.4.3",
            "nexus",
            config.path(),
        );

        std::fs::write(
            base.path().join("Watcher/Watcher.json"),
            r#"{"id":"Watcher","name":"Watcher","version":"1.4.20"}"#,
        )
        .unwrap();
        let mut cached = existing.clone();
        cached.mod_version_id = None;
        cached.version = "1.4.20".into();
        cached.hash = Some("watcher-cached-1420".into());
        crate::mod_versions::cache_mod_version_by_id_with_source_version(
            &mut cached,
            base.path(),
            cache.path(),
            config.path(),
            Some("1.4.20"),
        )
        .expect("cached newer Watcher archive should be written");

        let error = duplicate_downloaded_update_error(&existing, Some("1.4.3"), config.path())
            .expect("same-version watcher download should be rejected");
        assert!(error.contains("already the current stored version"));
        assert!(error.contains("v1.4.3"));
        assert!(
            duplicate_downloaded_update_error(&existing, Some("1.4.2"), config.path()).is_none(),
            "different lower source versions are valid branch choices and should install"
        );
        assert!(
            duplicate_downloaded_update_error(&existing, Some("1.4.20"), config.path()).is_none(),
            "different higher source versions should still install"
        );
        let payload = failed_update_install_payload(
            "The Watcher - 1.4.3 - StS2 - v0.103.2-46-1-4-3-1777364274.zip".into(),
            error,
            &existing,
            None,
        );
        assert!(
            payload.mod_name.is_none(),
            "exact duplicate downloads should stay on the toast-only failure path"
        );
        assert!(payload.skip_version.is_none());

        let options = crate::mod_versions::local_version_options_for_target(
            &[existing.clone()],
            &[],
            config.path(),
            cache.path(),
            &existing.name,
            existing.mod_version_id.as_deref(),
            existing.mod_id.as_deref(),
        );
        assert!(
            options
                .iter()
                .any(|option| option.version == "1.4.20" && option.cached),
            "rejecting the same-version download must leave the newer cached option selectable"
        );
        assert!(
            crate::mod_versions::has_local_version_for_mod(
                config.path(),
                cache.path(),
                &existing,
                "1.4.20",
            ),
            "cached Watcher 1.4.20 should suppress only the exact 1.4.20 update pill"
        );
        assert!(
            !crate::mod_versions::has_local_version_for_mod(
                config.path(),
                cache.path(),
                &existing,
                "1.4.19",
            ),
            "cached Watcher 1.4.20 must not suppress a different branch/file version"
        );
    }
}

#[cfg(test)]
mod stash_tests {
    use super::*;
    use tempfile::tempdir;

    /// Minimal ModInfo fixture for a mod with a folder plus a loose
    /// top-level manifest/config file.
    fn fixture_mod_info(folder: &str, extra_files: &[&str]) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: folder.to_string(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: extra_files.iter().map(|f| f.to_string()).collect(),
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some(folder.to_string()),
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
            ..Default::default()
        }
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn list_dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn stash_moves_mod_folder_and_top_level_files_out_of_mods_dir() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(&mods.join("MyMod").join("manifest.json"), "{}");
        write(&mods.join("MyMod").join("plugin.dll"), "dll-bytes");
        write(&mods.join("MyMod-extra.json"), "{}");

        let info = fixture_mod_info("MyMod", &["MyMod-extra.json"]);
        let stashed = stash_existing_mod_files(&info, &mods, None);

        // Original locations are gone.
        assert!(
            !mods.join("MyMod").exists(),
            "mod folder should be moved aside"
        );
        assert!(
            !mods.join("MyMod-extra.json").exists(),
            "top-level file should be moved aside"
        );

        // Two entries recorded (folder + loose file), both pointing at
        // existing temp siblings inside `mods`.
        assert_eq!(stashed.moved.len(), 2);
        for (orig, temp) in &stashed.moved {
            assert!(temp.exists(), "stash target {:?} should exist", temp);
            assert_eq!(
                temp.parent(),
                orig.parent(),
                "stash sibling must be on the same filesystem as the original"
            );
        }

        // Clean up to avoid leaking a leftover stash dir from this test.
        stashed.discard();
    }

    #[test]
    fn restore_puts_stashed_files_back_exactly_and_discards_partial_output() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(
            &mods.join("MyMod").join("manifest.json"),
            "original-manifest",
        );
        write(&mods.join("MyMod").join("plugin.dll"), "original-dll");
        write(&mods.join("MyMod-extra.json"), "original-extra");

        let info = fixture_mod_info("MyMod", &["MyMod-extra.json"]);
        let stashed = stash_existing_mod_files(&info, &mods, None);

        // Simulate a failed extract that left partial output behind.
        write(
            &mods.join("MyMod").join("manifest.json"),
            "partial-manifest",
        );

        stashed.restore();

        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("manifest.json")).unwrap(),
            "original-manifest",
            "restore should bring back the original file contents, discarding partial output"
        );
        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("plugin.dll")).unwrap(),
            "original-dll"
        );
        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod-extra.json")).unwrap(),
            "original-extra"
        );

        // No stash siblings left behind in `mods`.
        let leftovers: Vec<String> = list_dir_names(&mods)
            .into_iter()
            .filter(|n| n.contains("sts2mm-update-stash"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no stash temp dirs should remain after restore, got {:?}",
            leftovers
        );
    }

    #[test]
    fn discard_removes_stash_after_successful_install() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(
            &mods.join("MyMod").join("manifest.json"),
            "original-manifest",
        );

        let info = fixture_mod_info("MyMod", &[]);
        let stashed = stash_existing_mod_files(&info, &mods, None);

        // Simulate a successful install writing the new mod in place.
        write(&mods.join("MyMod").join("manifest.json"), "new-manifest");

        stashed.discard();

        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("manifest.json")).unwrap(),
            "new-manifest",
            "discard must not touch the freshly-installed files"
        );
        let leftovers: Vec<String> = list_dir_names(&mods)
            .into_iter()
            .filter(|n| n.contains("sts2mm-update-stash"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no stash temp dirs should remain after discard, got {:?}",
            leftovers
        );
    }

    #[test]
    fn sweep_stale_update_stashes_removes_leftovers_from_a_crashed_run() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(&mods.join("MyMod").join("manifest.json"), "current");

        // Simulate leftovers from a crashed earlier run: stale stash dirs
        // for both the mod folder and a loose top-level file.
        write(
            &mods
                .join(".MyMod.sts2mm-update-stash-0")
                .join("manifest.json"),
            "stale-folder-stash",
        );
        write(
            &mods.join(".MyMod-extra.json.sts2mm-update-stash-0"),
            "stale-file-stash",
        );

        let info = fixture_mod_info("MyMod", &["MyMod-extra.json"]);
        sweep_stale_update_stashes(&info, &mods);

        let names = list_dir_names(&mods);
        assert!(
            !names.iter().any(|n| n.contains("sts2mm-update-stash")),
            "stale stashes should be swept, got {:?}",
            names
        );
        // Current install is untouched.
        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("manifest.json")).unwrap(),
            "current"
        );
    }
}

#[cfg(test)]
mod pending_nexus_source_tests {
    use super::*;
    use crate::state::{create_app_state, PendingNexusInstall};
    use tempfile::tempdir;

    #[test]
    fn attach_pending_nexus_source_matches_download_filename_to_pending_page_name() {
        let config = tempdir().unwrap();
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                // Nexus page name and filename overlap, even though the
                // archive has no Nexus mod id suffix.
                mod_name: "STS2BaseCamp".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/526".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 526,
                file_id: None,
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "Base Camp",
            Some("BaseCamp"),
            None,
            "STS2BaseCamp V0.4.0.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        let entry = db
            .mods
            .get("BaseCamp")
            .expect("pending Nexus source should attach to the installed folder key");
        assert_eq!(entry.nexus_mod_id, Some(526));
        assert_eq!(
            entry.nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/526"),
        );
        assert!(
            state.lock().unwrap().pending_nexus_installs.is_empty(),
            "matching pending Nexus install should be consumed"
        );
    }

    #[test]
    fn attach_pending_nexus_source_persists_file_identity_from_download() {
        let config = tempdir().unwrap();
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: "Watcher".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/46".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 46,
                file_id: Some(1780935880),
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "Watcher",
            Some("Watcher"),
            Some("Watcher"),
            "Watcher-46-1-4-22-1780935880.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        let entry = db
            .mods
            .get("Watcher")
            .expect("pending Nexus source should attach to the installed folder key");
        assert_eq!(entry.nexus_mod_id, Some(46));
        assert_eq!(entry.nexus_file_id, Some(1780935880));
        assert_eq!(
            entry.nexus_file_name.as_deref(),
            Some("Watcher-46-1-4-22-1780935880.zip")
        );
        assert!(entry.nexus_file_lane_key.is_some());
    }

    #[test]
    fn attach_pending_nexus_source_does_not_overwrite_different_saved_nexus_mod() {
        let config = tempdir().unwrap();
        crate::mod_sources::attach_nexus_source(
            "Shared Name",
            Some("SharedFolder"),
            "https://www.nexusmods.com/slaythespire2/mods/900".into(),
            "slaythespire2".into(),
            900,
            config.path(),
        );
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: "Shared Name".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/1264".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 1264,
                file_id: None,
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "Shared Name",
            Some("SharedFolder"),
            None,
            "SharedName-1264-1-0-0-1780000000.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        let entry = db.mods.get("SharedFolder").unwrap();
        assert_eq!(entry.nexus_mod_id, Some(900));
        assert_eq!(
            entry.nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/900")
        );
        assert_eq!(
            state.lock().unwrap().pending_nexus_installs.len(),
            1,
            "conflicting pending Nexus hint must not be consumed"
        );
    }

    #[test]
    fn attach_pending_nexus_source_does_not_consume_unrelated_single_pending_hint() {
        let config = tempdir().unwrap();
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: "LizardSilent".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/1264".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 1264,
                file_id: None,
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "ATA Merchant",
            Some("ATA_Merchant"),
            Some("ATA_Merchant"),
            "ATA Merchant-900-0-1-5-1780625182.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        assert!(
            db.mods.get("ATA_Merchant").is_none(),
            "unrelated Nexus 1264 hint must not attach to Nexus 900 install"
        );
        assert_eq!(
            state.lock().unwrap().pending_nexus_installs.len(),
            1,
            "unrelated pending Nexus hint must not be consumed"
        );
    }

    #[test]
    fn attach_pending_nexus_source_matches_clean_lizardsilent_filename_by_folder_name() {
        let config = tempdir().unwrap();
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: "LizardSilent".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/1264".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 1264,
                file_id: None,
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "Lizard Silent Skin",
            Some("LizardSilent"),
            Some("LizardSilent"),
            "LizardSilent.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        let entry = db.mods.get("LizardSilent").unwrap();
        assert_eq!(entry.nexus_mod_id, Some(1264));
        assert!(
            state.lock().unwrap().pending_nexus_installs.is_empty(),
            "matching pending Nexus install should be consumed"
        );
    }

    #[test]
    fn attach_pending_nexus_source_matches_ata_merchant_by_filename_mod_id() {
        let config = tempdir().unwrap();
        let state = create_app_state();
        {
            let mut s = state.lock().unwrap();
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: "Untranslated Nexus Title".into(),
                nexus_url: "https://www.nexusmods.com/slaythespire2/mods/900".into(),
                game_domain: "slaythespire2".into(),
                mod_id: 900,
                file_id: None,
                queued_at: std::time::Instant::now(),
            });
        }

        attach_pending_nexus_source(
            "ATA Merchant",
            Some("ATA_Merchant"),
            Some("ATA_Merchant"),
            "ATA Merchant-900-0-1-5-1780625182.zip",
            config.path(),
            &state,
        );

        let db = crate::mod_sources::load_sources(config.path());
        let entry = db.mods.get("ATA_Merchant").unwrap();
        assert_eq!(entry.nexus_mod_id, Some(900));
        assert!(
            state.lock().unwrap().pending_nexus_installs.is_empty(),
            "filename mod id match should consume the pending Nexus install"
        );
    }

    #[test]
    fn identity_helpers_do_not_merge_lite_variants() {
        assert!(
            !identities_overlap("BetterSpire2", "BetterSpire2 Lite"),
            "variant suffixes must not collapse separate mods"
        );
        assert!(
            !labels_match("BetterSpire2", "BetterSpire2 Lite"),
            "Nexus page-name matching must not treat BetterSpire2 as BetterSpire2 Lite"
        );
    }

    #[test]
    fn find_existing_mod_does_not_replace_lite_variant_by_name() {
        let tmp = tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let lite_dir = disabled_path.join("BetterSpire2Lite");
        std::fs::create_dir_all(&lite_dir).unwrap();
        std::fs::write(
            lite_dir.join("BetterSpire2Lite.json"),
            r#"{"id":"BetterSpire2Lite","name":"BetterSpire2 Lite","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(lite_dir.join("BetterSpire2Lite.dll"), b"dll").unwrap();

        let identity = ZipIdentity {
            name: Some("BetterSpire2".into()),
            mod_id: None,
            folder_name: Some("BetterSpire2".into()),
            zip_stem_clean: Some("BetterSpire2".into()),
        };

        let matched = find_existing_mod(&identity, &mods_path, Some(&disabled_path));

        assert!(
            matched.is_none(),
            "BetterSpire2 must not match an installed BetterSpire2 Lite variant"
        );
    }
}
