//! Modpack install orchestration. Houses the `install_shared_profile`
//! Tauri command and its modpack-install-progress event types.
//!
//! Why a separate file: the install workflow is ~400 LOC of step-by-step
//! orchestration — download missing mods → apply enable/disable →
//! reclaim active-profile ownership → auto-subscribe for updates — and
//! none of it is shared with the share/reshare path. Keeping it next to
//! `share_profile`/`reshare_profile` in `mod.rs` bloated that file past
//! the orchestration-only budget for the sharing module.
//!
//! See `sharing/mod.rs` for the share/reshare orchestrators that use the
//! same `ShareProgress` / `SkippedMod` event types from the parent.

use serde::Serialize;

use crate::state::AppState;
use crate::profiles::Profile;

use super::code::{code_to_filename, format_code, parse_share_code};
use super::{download_bundle, fetch_shared_profile, SkippedMod};

#[derive(Debug, Clone, Serialize)]
struct ModpackSkippedEvent<'a> {
    profile_name: &'a str,
    skipped: &'a [SkippedMod],
}

/// Per-step status emitted while installing a browsed/shared modpack.
/// The browse UI uses this to show that a large pack is actively fetching,
/// downloading, applying, and subscribing instead of looking stuck on a
/// disabled "Installing..." button.
#[derive(Debug, Serialize, Clone)]
struct ModpackInstallProgress {
    profile_name: String,
    /// "fetching-manifest", "checking", "downloading", "applying",
    /// "subscribing", or "done".
    stage: &'static str,
    /// 1-indexed position within the profile's mod list. 0 when the
    /// current stage is not per-mod.
    current: usize,
    /// Total mods in the profile. 0 when unknown or irrelevant.
    total: usize,
    /// Mod name when stage == "checking" or "downloading".
    mod_name: Option<String>,
}

fn emit_modpack_install_progress(
    app_handle: &tauri::AppHandle,
    profile_name: &str,
    stage: &'static str,
    current: usize,
    total: usize,
    mod_name: Option<&str>,
) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "modpack-install-progress",
        ModpackInstallProgress {
            profile_name: profile_name.to_string(),
            stage,
            current,
            total,
            mod_name: mod_name.map(|s| s.to_string()),
        },
    );
}

/// Install a shared profile from a code AND auto-subscribe for updates.
/// Downloads missing mods FIRST, then applies the profile (enable/disable).
///
/// `app_handle` is taken so we can emit a `modpack-mods-skipped`
/// notification when one or more mods in the pack declare a
/// `min_game_version` higher than the user's STS2 build. Those mods
/// can't be loaded by the game on this branch, so we skip the install
/// (rather than landing a useless artifact) and tell the UI to surface
/// the skip with a clear toast.
#[tauri::command]
pub async fn install_shared_profile(
    code: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    use tauri::Emitter;
    crate::game::ensure_game_not_running()?;
    emit_modpack_install_progress(&app_handle, &code, "fetching-manifest", 0, 0, None);
    let (owner, profile_code) = parse_share_code(&code).map_err(|e| e.to_string())?;

    // Pull paths + token from state first so the GitHub fetch can use the
    // user's PAT for the higher rate limit.
    let (
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        cache_path,
        token,
        user_game_version,
    ) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        let game_version = s.game_version.clone();
        (mods, disabled, profiles, config, cache, token, game_version)
    };

    let filename = code_to_filename(&profile_code);
    let profile = fetch_shared_profile(&owner, &filename, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let total_mods = profile.mods.len();

    // Mods skipped because they declare a min_game_version higher than the
    // user's STS2. We download + extract them (since we can't read the
    // manifest until the zip is on disk), then immediately delete the
    // files and record the skip. The frontend toasts about these.
    let mut skipped_incompatible: Vec<SkippedMod> = Vec::new();

    // Save the profile locally
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // ── STEP 1: Download missing mods and restore version-mismatched mods ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let all_on_disk: Vec<crate::mods::ModInfo> = local_mods
        .into_iter()
        .chain(local_disabled.into_iter())
        .collect();

    // Build a map from identifiers to on-disk mod info (for version comparison)
    let mut on_disk_by_id: std::collections::HashMap<String, &crate::mods::ModInfo> =
        std::collections::HashMap::new();
    for m in &all_on_disk {
        on_disk_by_id.insert(m.name.clone(), m);
        if let Some(ref folder) = m.folder_name {
            on_disk_by_id.insert(folder.clone(), m);
        }
        if let Some(ref id) = m.mod_id {
            on_disk_by_id.insert(id.clone(), m);
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let pinned_set = crate::mod_sources::load_pinned_set(&config_path);
    let mut download_failures: Vec<String> = Vec::new();

    for (idx, pm) in profile.mods.iter().enumerate() {
        let current = idx + 1;
        emit_modpack_install_progress(
            &app_handle,
            &profile.name,
            "checking",
            current,
            total_mods,
            Some(&pm.name),
        );

        // Find matching on-disk mod
        let on_disk_mod = on_disk_by_id
            .get(&pm.name)
            .or_else(|| pm.folder_name.as_ref().and_then(|f| on_disk_by_id.get(f)))
            .or_else(|| pm.mod_id.as_ref().and_then(|id| on_disk_by_id.get(id)))
            .copied();

        if on_disk_mod.is_none() && crate::profiles::profile_mod_matches_pin(pm, &pinned_set) {
            log::info!(
                "install_shared_profile: frozen mod '{}' is missing on disk; restoring from shared profile",
                pm.name
            );
        }

        // Pinned mods keep their installed version when there is one to preserve.
        if crate::profiles::should_skip_pinned_profile_mod_download(pm, on_disk_mod, &pinned_set) {
            log::info!(
                "install_shared_profile: skipping frozen mod '{}' (preserving installed version)",
                pm.name
            );
            continue;
        }

        if let Some(disk_mod) = on_disk_mod {
            let disk_ver = disk_mod.version.trim_start_matches('v');
            let profile_ver = pm.version.trim_start_matches('v');

            let version_ok = disk_ver == profile_ver
                || profile_ver == "unknown"
                || profile_ver == "0.0.0"
                || disk_ver == "unknown"
                || disk_ver == "0.0.0";

            if version_ok {
                log::info!(
                    "Mod '{}' already on disk at correct version ({})",
                    pm.name,
                    disk_mod.version
                );
                continue;
            }

            // Version mismatch -- need to replace with the profile's version
            if pm.bundle_url.is_some() {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) -- will reinstall",
                    pm.name,
                    disk_mod.version,
                    pm.version
                );
                // Cache the current version before deleting (so user can switch back)
                crate::mods::cache_mod_version(
                    disk_mod,
                    if disk_mod.enabled {
                        &mods_path
                    } else {
                        &disabled_path
                    },
                    &cache_path,
                );
                // Delete old version
                let base = if disk_mod.enabled {
                    &mods_path
                } else {
                    &disabled_path
                };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to download the correct version
            } else {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) but no bundle -- keeping disk version",
                    pm.name, disk_mod.version, pm.version
                );
                continue;
            }
        }

        // Prefer bundle_url over GitHub -- the curator bundled it because
        // the GitHub source may be wrong/unreliable (e.g., wrong game's repo)
        if let Some(ref bundle_url) = pm.bundle_url {
            emit_modpack_install_progress(
                &app_handle,
                &profile.name,
                "downloading",
                current,
                total_mods,
                Some(&pm.name),
            );
            log::info!("Downloading bundled mod '{}' from profiles repo", pm.name);
            match download_bundle(bundle_url, &pm.name, &mods_path).await {
                Ok(_) => {
                    // Re-scan to find the just-installed mod's parsed manifest.
                    // We need this to read its min_game_version field —
                    // download_bundle returns () so we don't have a ModInfo
                    // back. The fresh scan picks up the install correctly.
                    let after = crate::mods::scan_mods(&mods_path);
                    if let Some(installed) = after
                        .iter()
                        .find(|m| m.name == pm.name || Some(&m.name) == pm.folder_name.as_ref())
                    {
                        if crate::updater::install_is_incompatible(
                            installed,
                            user_game_version.as_deref(),
                        ) {
                            log::info!(
                                "Modpack apply: skipping '{}' — needs game v{}, user has v{}",
                                installed.name,
                                installed.min_game_version.as_deref().unwrap_or("?"),
                                user_game_version.as_deref().unwrap_or("?"),
                            );
                            crate::mods::delete_mod_files_by_info(installed, &mods_path);
                            skipped_incompatible.push(SkippedMod {
                                mod_name: installed.name.clone(),
                                min_game_version: installed
                                    .min_game_version
                                    .clone()
                                    .unwrap_or_default(),
                                user_game_version: user_game_version.clone().unwrap_or_default(),
                            });
                            continue;
                        }
                    }
                    log::info!("Installed bundled mod '{}'", pm.name);
                    continue;
                }
                Err(e) => {
                    log::warn!(
                        "Bundle download failed for '{}': {} -- trying GitHub fallback",
                        pm.name,
                        e
                    );
                }
            }
        }

        // Fallback: try GitHub source
        let github_repo = pm
            .source
            .as_ref()
            .and_then(|s| {
                if let Some(repo) = s.strip_prefix("github:") {
                    return Some(repo.to_string());
                }
                if s.contains("github.com/") {
                    let parts: Vec<&str> = s.split("github.com/").collect();
                    if parts.len() > 1 {
                        let repo_path = parts[1].trim_end_matches('/');
                        let segs: Vec<&str> = repo_path.splitn(3, '/').collect();
                        if segs.len() >= 2 {
                            return Some(format!("{}/{}", segs[0], segs[1]));
                        }
                    }
                }
                None
            })
            .or_else(|| {
                crate::mod_sources::lookup_entry(
                    &mod_sources_db.mods,
                    pm.folder_name.as_deref(),
                    &pm.name,
                    pm.mod_id.as_deref(),
                )
                .and_then(|e| e.github_repo.clone())
            });

        if let Some(repo) = github_repo {
            let parts: Vec<&str> = repo.splitn(2, '/').collect();
            if parts.len() == 2 {
                emit_modpack_install_progress(
                    &app_handle,
                    &profile.name,
                    "downloading",
                    current,
                    total_mods,
                    Some(&pm.name),
                );
                match crate::download::download_and_install_github_mod(
                    parts[0],
                    parts[1],
                    None,
                    &mods_path,
                    &cache_path,
                    token.as_deref(),
                )
                .await
                {
                    Ok(info) => {
                        if crate::updater::install_is_incompatible(
                            &info,
                            user_game_version.as_deref(),
                        ) {
                            log::info!(
                                "Modpack apply: skipping GitHub-installed '{}' — needs game v{}, user has v{}",
                                info.name,
                                info.min_game_version.as_deref().unwrap_or("?"),
                                user_game_version.as_deref().unwrap_or("?"),
                            );
                            crate::mods::delete_mod_files_by_info(&info, &mods_path);
                            skipped_incompatible.push(SkippedMod {
                                mod_name: info.name.clone(),
                                min_game_version: info.min_game_version.clone().unwrap_or_default(),
                                user_game_version: user_game_version.clone().unwrap_or_default(),
                            });
                            continue;
                        }
                        log::info!("Downloaded mod '{}' from GitHub", info.name);
                        continue;
                    }
                    Err(e) => {
                        log::error!("GitHub download also failed for '{}': {}", pm.name, e);
                    }
                }
            }
        }

        log::error!("No download source for mod '{}' -- skipping", pm.name);
        download_failures.push(pm.name.clone());
    }

    // Persist every pack mod's curator source link (fill-if-empty) so the
    // Mods view shows GitHub/Nexus chips instead of "Unlinked". Done once
    // after the loop and for ALL mods — including ones already on disk that
    // the loop skipped via `continue` — which is the case the previous,
    // download-arm-nested write missed.
    crate::profiles::persist_profile_mod_sources(&profile.mods, &config_path);

    if !download_failures.is_empty() {
        log::error!(
            "Could not download {} mods: {:?}. These need to be installed manually.",
            download_failures.len(),
            download_failures
        );
    }

    if !skipped_incompatible.is_empty() {
        log::info!(
            "Modpack apply: {} mod(s) skipped due to game-version incompatibility: {:?}",
            skipped_incompatible.len(),
            skipped_incompatible
                .iter()
                .map(|s| &s.mod_name)
                .collect::<Vec<_>>(),
        );
        let _ = app_handle.emit(
            "modpack-mods-skipped",
            ModpackSkippedEvent {
                profile_name: &profile.name,
                skipped: &skipped_incompatible,
            },
        );
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    // Now all downloadable mods are in mods_path, apply_profile can correctly enable/disable
    emit_modpack_install_progress(&app_handle, &profile.name, "applying", 0, total_mods, None);
    crate::profiles::apply_profile_with_pins(&profile, &mods_path, &disabled_path, &pinned_set)
        .map_err(|e| e.to_string())?;

    // ── STEP 3: Mark imported profile as active ──
    // We just rewrote disk to match this profile. If we leave the
    // previously-active profile in state, its saved manifest is now
    // silently drifted from disk — every action that snapshots from
    // disk ("Save changes", Snapshot) would capture the imported
    // loadout into the wrong profile's JSON.
    //
    // Mirrors the same step in `apply_subscription_update` (see
    // subscriptions.rs). Both paths apply a foreign profile's loadout
    // to disk, so both must claim ownership of the active slot.
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.active_profile = Some(profile.name.clone());
        if let Err(e) = std::fs::write(s.config_path.join("active_profile.txt"), &profile.name) {
            log::error!(
                "Failed to persist active_profile.txt after install_shared_profile: {}",
                e
            );
        }
        log::info!(
            "install_shared_profile: active profile set to '{}'",
            profile.name
        );
    }

    // ── STEP 4: Auto-subscribe for future updates ──
    // last_synced_profile is the snapshot future diffs are computed
    // against, so it has to match what's actually on disk. Mods we
    // skipped above for game-version incompatibility AREN'T on disk
    // — leaving them in the saved snapshot would mean Repair tries
    // to re-install + re-skip them on every cycle, and a later game-
    // version bump wouldn't surface as "+1 mod available to apply"
    // because the diff would treat them as already-present. Filter
    // them out via the shared snapshot helper.
    emit_modpack_install_progress(
        &app_handle,
        &profile.name,
        "subscribing",
        0,
        total_mods,
        None,
    );
    let share_key = format!("{}:{}", owner, profile_code);
    let now = chrono::Utc::now();
    let snapshot =
        crate::subscriptions::build_synced_profile_snapshot(&profile, &skipped_incompatible);
    let sub = crate::subscriptions::Subscription {
        share_id: share_key.clone(),
        share_url: format!("{}/{}", owner, format_code(&profile_code)),
        profile_name: profile.name.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: snapshot,
        last_checked: now,
        last_synced: now,
    };
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    db.subscriptions.insert(share_key, sub);
    let _ = crate::subscriptions::save_subscriptions(&db, &config_path);

    emit_modpack_install_progress(
        &app_handle,
        &profile.name,
        "done",
        total_mods,
        total_mods,
        None,
    );
    Ok(profile)
}
