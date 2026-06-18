use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::profiles::Profile;
use crate::sharing::fetch_shared_profile;
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// A subscription to a shared profile (from a curator/friend).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    /// The share ID (the short code from the URL)
    pub share_id: String,
    /// The share URL for display
    pub share_url: String,
    /// Name of the profile as set by the curator
    pub profile_name: String,
    /// Stable local profile id for the installed copy of this share.
    #[serde(default)]
    pub profile_id: String,
    /// Who shared it (if known)
    pub curator: Option<String>,
    /// The profile snapshot we last applied
    pub last_synced_profile: Profile,
    /// When we last checked for updates
    pub last_checked: DateTime<Utc>,
    /// When we last applied an update
    pub last_synced: DateTime<Utc>,
}

/// Result of checking a subscription for updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionUpdate {
    pub share_id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub has_update: bool,
    /// Mods that were added in the remote version
    pub added_mods: Vec<String>,
    /// Mods that were removed in the remote version
    pub removed_mods: Vec<String>,
    /// Mods whose version changed
    pub updated_mods: Vec<ModVersionChange>,
    /// The full remote profile (only if has_update is true)
    pub remote_profile: Option<Profile>,
}

/// Build the snapshot that gets stored as `last_synced_profile`.
///
/// Mods that we skipped during install because their `min_game_version`
/// is above the user's STS2 build aren't actually on disk — keeping them
/// in the saved profile snapshot is a footgun:
///
///   - `repair_modpack_subscription` re-applies `last_synced_profile`
///     to disk → tries to re-install the skipped mod → skips again →
///     every Repair cycle wastes a download.
///   - `check_subscription_updates` diffs the saved snapshot against
///     the freshly-fetched remote manifest. When the user's game
///     version moves up and the previously-skipped mod becomes
///     compatible, the diff currently shows "no change" (both still
///     contain it) and the user can't see that they're now eligible
///     to apply the mod. Filtering keeps the snapshot honest about
///     what's installed, so a later check correctly reports "+1 added"
///     and the user can click Apply Update to retry the install.
///
/// Filter is by exact mod name (the SkippedMod record's `mod_name` is
/// taken from `info.name` at the skip site, which matches what's in
/// `Profile.mods[i].name`). Folder-name / mod-id matching isn't needed
/// here because both sides come from the same manifest.
pub fn build_synced_profile_snapshot(
    profile: &Profile,
    skipped: &[crate::sharing::SkippedMod],
) -> Profile {
    if skipped.is_empty() {
        return profile.clone();
    }
    let skipped_names: std::collections::HashSet<&str> =
        skipped.iter().map(|s| s.mod_name.as_str()).collect();
    let mut snapshot = profile.clone();
    let before = snapshot.mods.len();
    snapshot
        .mods
        .retain(|m| !skipped_names.contains(m.name.as_str()));
    let removed = before - snapshot.mods.len();
    if removed > 0 {
        log::info!(
            "Subscription snapshot: filtered {} game-version-incompatible mod(s) from '{}'",
            removed,
            profile.name,
        );
    }
    snapshot
}

/// After a successful share/re-share, the curator's local profile IS the
/// just-published manifest. If this machine also subscribes to the pack
/// (installing your own share code auto-subscribes), refresh the stored
/// snapshot so the update poll doesn't flag the curator's own publish as
/// a pending update on their own pack (Solo, 2026-06-10). Matching is by
/// profile name, case-insensitive — the share_id encodes owner:code, but
/// the profile name is the field both records share. A different machine
/// subscribed to the same pack keeps its stale snapshot and correctly
/// sees the update. Returns true when a subscription was refreshed.
pub fn sync_own_subscription_after_publish(config_path: &Path, profile: &Profile) -> bool {
    let mut db = load_subscriptions(config_path);
    let mut changed = false;
    for sub in db.subscriptions.values_mut() {
        let matches_id =
            !sub.profile_id.trim().is_empty() && sub.profile_id.eq_ignore_ascii_case(&profile.id);
        let matches_legacy_name = sub.profile_name.eq_ignore_ascii_case(&profile.name);
        if matches_id || matches_legacy_name {
            sub.profile_id = profile.id.clone();
            sub.profile_name = profile.name.clone();
            sub.last_synced_profile = profile.clone();
            sub.last_synced = Utc::now();
            changed = true;
        }
    }
    if changed {
        if let Err(e) = save_subscriptions(&db, config_path) {
            log::warn!(
                "Failed to refresh own subscription for '{}' after publish: {}",
                profile.name,
                e
            );
            return false;
        }
        log::info!(
            "Refreshed own subscription snapshot for '{}' after publish",
            profile.name
        );
    }
    changed
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModVersionChange {
    pub name: String,
    pub old_version: String,
    pub new_version: String,
}

/// Subscriptions database, keyed by share_id.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubscriptionsDb {
    pub subscriptions: HashMap<String, Subscription>,
}

// ── Persistence ─────────────────────────────────────────────────────────────

fn subs_path(config_path: &Path) -> std::path::PathBuf {
    config_path.join("subscriptions.json")
}

pub fn load_subscriptions(config_path: &Path) -> SubscriptionsDb {
    let mut db = load_subscriptions_without_migration(config_path);
    let profiles_path = config_path.join("profiles");
    hydrate_subscription_profile_ids(&mut db, &profiles_path);
    db
}

fn load_subscriptions_without_migration(config_path: &Path) -> SubscriptionsDb {
    let path = subs_path(config_path);
    if !path.exists() {
        return SubscriptionsDb::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(db) => db,
            Err(e) => {
                // A present-but-corrupt file is a data-loss hazard: defaulting
                // here silently drops every subscription. Don't stay silent —
                // surface it so the user/log shows why subscriptions vanished.
                // (Empty/whitespace-only files are a normal "no data" state.)
                if !content.trim().is_empty() {
                    log::error!(
                        "Failed to parse subscriptions at {}: {} — falling back to empty defaults (saved subscriptions will not be loaded)",
                        path.display(),
                        e
                    );
                }
                SubscriptionsDb::default()
            }
        },
        Err(_) => SubscriptionsDb::default(),
    }
}

pub fn migrate_subscription_profile_ids(config_path: &Path, profiles_path: &Path) -> bool {
    let mut db = load_subscriptions_without_migration(config_path);
    if hydrate_subscription_profile_ids(&mut db, profiles_path) {
        if let Err(e) = save_subscriptions(&db, config_path) {
            log::warn!(
                "Failed to persist subscription profile-id migration at {}: {}",
                subs_path(config_path).display(),
                e
            );
            return false;
        }
        return true;
    }
    false
}

fn hydrate_subscription_profile_ids(db: &mut SubscriptionsDb, profiles_path: &Path) -> bool {
    let mut changed = false;
    for sub in db.subscriptions.values_mut() {
        let profile = if sub.profile_id.trim().is_empty() {
            None
        } else {
            crate::profiles::load_profile(&sub.profile_id, profiles_path).ok()
        }
        .or_else(|| crate::profiles::load_profile(&sub.profile_name, profiles_path).ok());

        if let Some(profile) = profile {
            if sub.profile_id != profile.id {
                sub.profile_id = profile.id.clone();
                changed = true;
            }
            if sub.profile_name != profile.name {
                sub.profile_name = profile.name.clone();
                changed = true;
            }
        }
    }
    changed
}

pub fn save_subscriptions(db: &SubscriptionsDb, config_path: &Path) -> Result<()> {
    let path = subs_path(config_path);
    let json = serde_json::to_string_pretty(db)?;
    crate::fs_safety::atomic_write(&path, json.as_bytes())?;
    Ok(())
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Compare two profiles and return what changed.
fn diff_profiles(
    local: &Profile,
    remote: &Profile,
) -> (Vec<String>, Vec<String>, Vec<ModVersionChange>) {
    fn diff_key(m: &crate::profiles::ProfileMod) -> String {
        m.mod_version_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
            .map(|id| format!("id:{id}"))
            .or_else(|| {
                m.mod_id
                    .as_ref()
                    .filter(|id| !id.trim().is_empty())
                    .map(|id| format!("mod_id:{}", id.to_lowercase()))
            })
            .or_else(|| {
                m.folder_name
                    .as_ref()
                    .filter(|folder| !folder.trim().is_empty())
                    .map(|folder| format!("folder:{}", folder.to_lowercase()))
            })
            .unwrap_or_else(|| format!("name:{}", m.name.to_lowercase()))
    }

    let local_mods: HashMap<String, (&str, &str)> = local
        .mods
        .iter()
        .map(|m| (diff_key(m), (m.name.as_str(), m.version.as_str())))
        .collect();
    let remote_mods: HashMap<String, (&str, &str)> = remote
        .mods
        .iter()
        .map(|m| (diff_key(m), (m.name.as_str(), m.version.as_str())))
        .collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut updated = Vec::new();

    // Mods in remote but not in local = added
    for (key, (name, version)) in &remote_mods {
        match local_mods.get(key) {
            None => added.push((*name).to_string()),
            Some((_, local_ver)) if local_ver != version => {
                updated.push(ModVersionChange {
                    name: (*name).to_string(),
                    old_version: (*local_ver).to_string(),
                    new_version: (*version).to_string(),
                });
            }
            _ => {}
        }
    }

    // Mods in local but not in remote = removed
    for (key, (name, _)) in &local_mods {
        if !remote_mods.contains_key(key) {
            removed.push((*name).to_string());
        }
    }

    (added, removed, updated)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Subscribe to a shared profile. Called after a friend imports a profile link.
/// This saves the subscription so the app can check for updates later.
#[tauri::command]
pub fn subscribe_to_profile(
    share_id: String,
    share_url: String,
    profile: Profile,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Subscription, String> {
    let config_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.config_path.clone()
    };

    let mut db = load_subscriptions(&config_path);
    let now = Utc::now();

    let sub = Subscription {
        share_id: share_id.clone(),
        share_url,
        profile_name: profile.name.clone(),
        profile_id: profile.id.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: profile,
        last_checked: now,
        last_synced: now,
    };

    db.subscriptions.insert(share_id, sub.clone());
    save_subscriptions(&db, &config_path).map_err(|e| e.to_string())?;
    Ok(sub)
}

/// Get all active subscriptions.
#[tauri::command]
pub fn get_subscriptions(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<Subscription>, String> {
    let config_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.config_path.clone()
    };
    let db = load_subscriptions(&config_path);
    Ok(db.subscriptions.values().cloned().collect())
}

/// Unsubscribe from a shared profile.
#[tauri::command]
pub fn unsubscribe(
    share_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let config_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.config_path.clone()
    };
    let mut db = load_subscriptions(&config_path);
    db.subscriptions.remove(&share_id);
    save_subscriptions(&db, &config_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Check all subscriptions for updates. Returns a list of updates available.
#[tauri::command]
pub async fn check_subscription_updates(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<SubscriptionUpdate>, String> {
    let (config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.config_path.clone(), s.github_token.clone())
    };

    let mut db = load_subscriptions(&config_path);
    let mut results = Vec::new();

    // Collect share_ids first to avoid borrow issues
    let share_ids: Vec<String> = db.subscriptions.keys().cloned().collect();

    for share_id in &share_ids {
        let sub = match db.subscriptions.get(share_id) {
            Some(s) => s.clone(),
            None => continue,
        };

        // Parse share_id format: "owner:CODE" or just try as-is.
        // Pass the user's PAT when set so the poll uses the 5000/hr authed
        // limit rather than the 60/hr anonymous-per-IP one.
        let fetch_result = if let Some(idx) = share_id.find(':') {
            let owner = &share_id[..idx];
            let code = &share_id[idx + 1..];
            let filename = format!("{}.json", code.to_lowercase());
            fetch_shared_profile(owner, &filename, token.as_deref()).await
        } else {
            // Legacy format - try as direct ID
            Err(crate::error::AppError::Other(format!(
                "Invalid subscription ID: {}",
                share_id
            )))
        };
        match fetch_result {
            Ok(remote) => {
                let (added, removed, updated) = diff_profiles(&sub.last_synced_profile, &remote);
                let has_update = !added.is_empty() || !removed.is_empty() || !updated.is_empty();

                results.push(SubscriptionUpdate {
                    share_id: share_id.clone(),
                    profile_id: sub.profile_id.clone(),
                    profile_name: sub.profile_name.clone(),
                    has_update,
                    added_mods: added,
                    removed_mods: removed,
                    updated_mods: updated,
                    remote_profile: if has_update { Some(remote) } else { None },
                });

                // Update last_checked
                if let Some(s) = db.subscriptions.get_mut(share_id) {
                    s.last_checked = Utc::now();
                }
            }
            Err(e) => {
                log::warn!("Failed to check subscription {}: {}", share_id, e);
            }
        }
    }

    save_subscriptions(&db, &config_path).map_err(|e| e.to_string())?;
    Ok(results)
}

/// Apply a subscription update: download missing mods first, then sync.
/// Mirrors the robust logic from switch_profile / install_shared_profile.
#[tauri::command]
pub async fn apply_subscription_update(
    share_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    crate::game::ensure_game_not_running()?;
    apply_subscription_update_inner(share_id, app_handle, state).await
}

/// Wipe & reinstall a modpack: delete all mod files, then re-run the
/// subscription update flow (which downloads + applies + activates).
#[tauri::command]
pub async fn repair_modpack_subscription(
    share_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.mods_path.clone().ok_or("Game path not set")?,
            s.disabled_mods_path.clone().ok_or("Game path not set")?,
        )
    };

    // Move both mod dirs aside (instead of deleting) so a failed re-download —
    // network error, missing bundle URL, absent Nexus key — rolls back to the
    // user's existing mods instead of leaving them with nothing. (Audit M-9)
    log::info!(
        "Repair: stashing mods + disabled dirs before reinstall for '{}'",
        share_id
    );
    let swap = crate::fs_safety::swap_dirs_aside(&[&mods_path, &disabled_path])
        .map_err(|e| format!("Failed to stash existing mods before repair: {}", e))?;

    match apply_subscription_update_inner(share_id.clone(), app_handle, state).await {
        Ok(profile) => {
            swap.discard().map_err(|e| e.to_string())?;
            log::info!("Repair: completed for '{}'", share_id);
            Ok(profile)
        }
        Err(e) => {
            log::error!(
                "Repair: reinstall failed ({}); restoring the pre-repair mods",
                e
            );
            if let Err(re) = swap.restore() {
                log::error!("Repair: rollback ALSO failed: {}", re);
            }
            Err(e)
        }
    }
}

async fn apply_subscription_update_inner(
    share_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    use tauri::Emitter;
    let (
        config_path,
        mods_path,
        disabled_path,
        profiles_path,
        cache_path,
        token,
        user_game_version,
    ) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.config_path.clone(),
            s.mods_path.clone().ok_or("Game path not set")?,
            s.disabled_mods_path.clone().ok_or("Game path not set")?,
            s.profiles_path.clone(),
            s.cache_path.clone(),
            s.github_token.clone(),
            s.game_version.clone(),
        )
    };

    // Mods skipped because their min_game_version is above the user's
    // STS2 build. Same flow as install_shared_profile — collect, then
    // emit a Tauri event after the loop so the frontend can toast.
    let mut skipped_incompatible: Vec<crate::sharing::SkippedMod> = Vec::new();

    // Fetch the latest remote profile, using the PAT if set for the
    // higher rate limit.
    let mut remote = if let Some(idx) = share_id.find(':') {
        let owner = &share_id[..idx];
        let code = &share_id[idx + 1..];
        let filename = format!("{}.json", code.to_lowercase());
        fetch_shared_profile(owner, &filename, token.as_deref())
            .await
            .map_err(|e| e.to_string())?
    } else {
        return Err(format!("Invalid subscription ID: {}", share_id));
    };
    let subscription = load_subscriptions(&config_path)
        .subscriptions
        .get(&share_id)
        .cloned();
    let subscription_name = subscription
        .as_ref()
        .map(|sub| sub.profile_name.clone())
        .unwrap_or_else(|| remote.name.clone());
    let local_profile = subscription
        .as_ref()
        .and_then(|sub| {
            if sub.profile_id.trim().is_empty() {
                None
            } else {
                crate::profiles::load_profile(&sub.profile_id, &profiles_path).ok()
            }
        })
        .or_else(|| crate::profiles::load_profile(&subscription_name, &profiles_path).ok());
    remote.id = local_profile
        .as_ref()
        .map(|profile| profile.id.clone())
        .unwrap_or_else(crate::profiles::new_profile_id);
    remote.name = local_profile
        .as_ref()
        .map(|profile| profile.name.clone())
        .unwrap_or(subscription_name);

    // Save the profile locally
    crate::profiles::save_profile(&remote, &profiles_path).map_err(|e| e.to_string())?;

    // ── STEP 1: Download missing mods and restore version-mismatched mods ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let mut all_on_disk: Vec<crate::mods::ModInfo> = local_mods
        .into_iter()
        .chain(local_disabled.into_iter())
        .collect();
    crate::mod_sources::enrich_mods_with_sources(&mut all_on_disk, &config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut all_on_disk, &config_path);

    // Build a map from identifiers to on-disk mod info (for version comparison)
    let mut on_disk_by_id: std::collections::HashMap<String, &crate::mods::ModInfo> =
        std::collections::HashMap::new();
    for m in &all_on_disk {
        on_disk_by_id.insert(m.name.clone(), m);
        if let Some(ref version_id) = m.mod_version_id {
            on_disk_by_id.insert(version_id.clone(), m);
        }
        if let Some(ref folder) = m.folder_name {
            on_disk_by_id.insert(folder.clone(), m);
        }
        if let Some(ref id) = m.mod_id {
            on_disk_by_id.insert(id.clone(), m);
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let pinned_set = crate::mod_sources::load_pinned_set(&config_path);

    for pm in &remote.mods {
        // Find matching on-disk mod
        let on_disk_mod = pm
            .mod_version_id
            .as_ref()
            .and_then(|id| on_disk_by_id.get(id))
            .copied()
            .or_else(|| {
                all_on_disk.iter().find(|disk_mod| {
                    crate::profiles::profile_mod_matches_installed_with_registry(
                        pm,
                        disk_mod,
                        &config_path,
                    )
                })
            })
            .or_else(|| on_disk_by_id.get(&pm.name).copied())
            .or_else(|| {
                pm.folder_name
                    .as_ref()
                    .and_then(|f| on_disk_by_id.get(f).copied())
            })
            .or_else(|| {
                pm.mod_id
                    .as_ref()
                    .and_then(|id| on_disk_by_id.get(id).copied())
            });

        // Pinned mods keep their installed version — don't replace files.
        let is_pinned = pinned_set.contains(&pm.name)
            || pm
                .folder_name
                .as_ref()
                .map_or(false, |f| pinned_set.contains(f))
            || pm.mod_id.as_ref().map_or(false, |i| pinned_set.contains(i))
            || on_disk_mod.map_or(false, |d| {
                pinned_set.contains(&d.name)
                    || d.folder_name
                        .as_ref()
                        .map_or(false, |f| pinned_set.contains(f))
                    || d.mod_id.as_ref().map_or(false, |i| pinned_set.contains(i))
            });
        if is_pinned {
            log::info!(
                "Subscription update: skipping frozen mod '{}' (preserving installed version)",
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
            let artifact_ok =
                crate::profiles::profile_mod_artifact_id_matches(pm, disk_mod, &config_path)
                    .unwrap_or(true);

            if version_ok && artifact_ok {
                continue;
            }

            // Version or artifact mismatch -- reinstall from bundle or cache
            log::info!(
                "Subscription update: mod '{}' artifact mismatch (disk: {}, remote: {}, artifact_ok: {})",
                pm.name,
                disk_mod.version,
                pm.version,
                artifact_ok
            );

            // Cache current version before deleting
            let cache_base = if disk_mod.enabled {
                &mods_path
            } else {
                &disabled_path
            };
            let mut disk_snapshot = disk_mod.clone();
            if crate::mod_versions::cache_mod_version_by_id(
                &mut disk_snapshot,
                cache_base,
                &cache_path,
                &config_path,
            )
            .is_none()
            {
                crate::mods::cache_mod_version(disk_mod, cache_base, &cache_path);
            }

            // Try local cache first
            let has_id_cache = crate::mod_versions::get_cached_mod_path_for_profile_mod(
                &cache_path,
                &config_path,
                pm,
            )
            .is_some();
            let has_legacy_cache =
                crate::mods::get_cached_mod_path(&cache_path, &pm.name, &pm.version).is_some();
            if has_id_cache || (has_legacy_cache && !version_ok) {
                let base = if disk_mod.enabled {
                    &mods_path
                } else {
                    &disabled_path
                };
                let previous_profile_mod = crate::profiles::profile_mod_from_installed(disk_mod);
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                let restored = if has_id_cache {
                    crate::mod_versions::restore_mod_from_cache_by_id(
                        &cache_path,
                        &config_path,
                        pm,
                        &mods_path,
                    )
                } else {
                    crate::mods::restore_mod_from_cache(
                        &cache_path,
                        &pm.name,
                        &pm.version,
                        &mods_path,
                    )
                };
                if restored.is_ok() {
                    log::info!("Restored '{}' v{} from local cache", pm.name, pm.version);
                    continue;
                } else if pm.bundle_url.is_none() {
                    log::warn!(
                        "Failed to restore cached artifact for '{}' and no bundle is available; restoring previous disk copy",
                        pm.name
                    );
                    let _ = crate::mod_versions::restore_mod_from_cache_by_id(
                        &cache_path,
                        &config_path,
                        &previous_profile_mod,
                        base,
                    )
                    .or_else(|_| {
                        crate::mods::restore_mod_from_cache(
                            &cache_path,
                            &disk_mod.name,
                            &disk_mod.version,
                            base,
                        )
                    });
                    continue;
                }
            }

            if pm.bundle_url.is_some() {
                let base = if disk_mod.enabled {
                    &mods_path
                } else {
                    &disabled_path
                };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to download
            } else {
                log::info!(
                    "Mod '{}' version mismatch but no bundle or cache -- keeping disk version",
                    pm.name
                );
                continue;
            }
        }

        log::info!("Subscription update: mod '{}' needs download", pm.name);
        let mut downloaded = false;
        let mut skipped_this_mod = false;

        // Prefer bundle_url (curator's bundled copy)
        if let Some(ref bundle_url) = pm.bundle_url {
            match crate::sharing::download_bundle(
                bundle_url,
                &pm.name,
                &mods_path,
                pm.bundle_sha256.as_deref(),
            )
            .await
            {
                Ok(_) => {
                    // Re-scan to read the fresh manifest's min_game_version.
                    let mut after = crate::mods::scan_mods(&mods_path);
                    crate::mod_sources::enrich_mods_with_sources(&mut after, &config_path);
                    crate::mod_versions::enrich_mods_with_versions(&mut after, &config_path);
                    if let Some(installed) = after
                        .iter_mut()
                        .find(|m| m.name == pm.name || Some(&m.name) == pm.folder_name.as_ref())
                    {
                        if crate::updater::install_is_incompatible(
                            installed,
                            user_game_version.as_deref(),
                        ) {
                            log::info!(
                                "Subscription update: skipping '{}' — needs game v{}, user has v{}",
                                installed.name,
                                installed.min_game_version.as_deref().unwrap_or("?"),
                                user_game_version.as_deref().unwrap_or("?"),
                            );
                            crate::mods::delete_mod_files_by_info(installed, &mods_path);
                            skipped_incompatible.push(crate::sharing::SkippedMod {
                                mod_name: installed.name.clone(),
                                min_game_version: installed
                                    .min_game_version
                                    .clone()
                                    .unwrap_or_default(),
                                user_game_version: user_game_version.clone().unwrap_or_default(),
                            });
                            skipped_this_mod = true;
                        } else {
                            if let Some(shared_id) = pm.mod_version_id.as_deref() {
                                crate::mod_versions::alias_shared_id(
                                    shared_id,
                                    installed,
                                    &config_path,
                                );
                            }
                            log::info!(
                                "Installed bundled mod '{}' from subscription update",
                                pm.name
                            );
                            downloaded = true;
                        }
                    } else {
                        log::info!(
                            "Installed bundled mod '{}' from subscription update",
                            pm.name
                        );
                        downloaded = true;
                    }
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

        // Fallback: try GitHub source (only if bundle didn't install AND we
        // didn't already skip this mod for incompatibility above).
        if !downloaded && !skipped_this_mod {
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
                                    "Subscription update: skipping GitHub-installed '{}' — needs game v{}, user has v{}",
                                    info.name,
                                    info.min_game_version.as_deref().unwrap_or("?"),
                                    user_game_version.as_deref().unwrap_or("?"),
                                );
                                crate::mods::delete_mod_files_by_info(&info, &mods_path);
                                skipped_incompatible.push(crate::sharing::SkippedMod {
                                    mod_name: info.name.clone(),
                                    min_game_version: info
                                        .min_game_version
                                        .clone()
                                        .unwrap_or_default(),
                                    user_game_version: user_game_version
                                        .clone()
                                        .unwrap_or_default(),
                                });
                            } else {
                                log::info!(
                                    "Downloaded mod '{}' from GitHub for subscription",
                                    info.name
                                );
                                downloaded = true;
                            }
                        }
                        Err(e) => {
                            log::error!("GitHub download also failed for '{}': {}", pm.name, e);
                        }
                    }
                }
            }
        }

        if !downloaded && !skipped_this_mod {
            log::error!(
                "No download source for mod '{}' in subscription update",
                pm.name
            );
        }
    }

    // Persist every pack mod's curator source link (fill-if-empty) so the
    // Mods view shows GitHub/Nexus chips instead of "Unlinked" — including
    // for mods already on disk at the right version, which the loop skips.
    crate::profiles::persist_profile_mod_sources(&remote.mods, &config_path);
    // Curator notes/links/tags ride in the manifest (Solo FR) — merge
    // them fill-only so the receiver's own annotations always win.
    crate::mod_sources::merge_shared_extras(&remote.mod_extras, &config_path);

    if !skipped_incompatible.is_empty() {
        log::info!(
            "Subscription update: {} mod(s) skipped due to game-version incompatibility",
            skipped_incompatible.len(),
        );
        let _ = app_handle.emit(
            "modpack-mods-skipped",
            serde_json::json!({
                "profile_name": &remote.name,
                "skipped": &skipped_incompatible,
            }),
        );
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    log::info!(
        "Subscription update: applying profile '{}' ({} mods)",
        remote.name,
        remote.mods.len()
    );
    crate::profiles::apply_profile_with_pins(
        &remote,
        &mods_path,
        &disabled_path,
        &pinned_set,
        &config_path,
    )
    .map_err(|e| e.to_string())?;

    // ── STEP 3: Mark this profile as active ──
    // Without this, a previously-active profile would still be reported as
    // active and a later "Activate" of it (or app reload) would undo the sync.
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.active_profile = Some(remote.id.clone());
        crate::profiles::persist_active_profile(&s.config_path, &remote.id);
        log::info!(
            "Subscription update: active profile set to '{}' ({})",
            remote.name,
            remote.id
        );
    }

    // Update subscription record. Use the filtered snapshot so the
    // saved profile reflects what's actually on disk — mods skipped
    // for game-version incompatibility above don't get pinned into
    // the subscription state and dragged through every future Repair.
    let snapshot = build_synced_profile_snapshot(&remote, &skipped_incompatible);
    let mut db = load_subscriptions(&config_path);
    if let Some(sub) = db.subscriptions.get_mut(&share_id) {
        sub.profile_id = remote.id.clone();
        sub.profile_name = remote.name.clone();
        sub.last_synced_profile = snapshot;
        sub.last_synced = Utc::now();
        sub.last_checked = Utc::now();
    }
    save_subscriptions(&db, &config_path).map_err(|e| e.to_string())?;

    Ok(remote)
}

/// Update the cached display name for subscriptions targeting this local profile.
/// Returns true if any entry changed (caller decides whether to save).
pub fn rename_profile_display(db: &mut SubscriptionsDb, profile_id: &str, new: &str) -> bool {
    let mut changed = false;
    for sub in db.subscriptions.values_mut() {
        if sub.profile_id.eq_ignore_ascii_case(profile_id) {
            sub.profile_name = new.to_string();
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod rename_helper_tests {
    use super::*;
    #[test]
    fn repoints_matching_subscriptions() {
        let mut db = SubscriptionsDb::default();
        let now = chrono::Utc::now();
        let profile_id = crate::profiles::new_profile_id();
        db.subscriptions.insert(
            "id1".into(),
            Subscription {
                share_id: "id1".into(),
                share_url: "o/c".into(),
                profile_name: "Old".into(),
                profile_id: profile_id.clone(),
                curator: Some("o".into()),
                last_synced_profile: crate::profiles::Profile {
                    id: profile_id.clone(),
                    name: "Old".into(),
                    game_version: None,
                    created_by: None,
                    mods: vec![],
                    created_at: now,
                    updated_at: now,
                    public: None,
                    mod_extras: Default::default(),
                },
                last_checked: now,
                last_synced: now,
            },
        );
        assert!(rename_profile_display(&mut db, &profile_id, "New"));
        assert_eq!(db.subscriptions["id1"].profile_name, "New");
        assert!(!rename_profile_display(&mut db, "missing", "X"));
    }
}

#[cfg(test)]
mod own_subscription_sync_tests {
    use super::*;

    fn profile(name: &str, mod_names: &[(&str, &str)]) -> Profile {
        let now = chrono::Utc::now();
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: mod_names
                .iter()
                .map(|(n, v)| crate::profiles::ProfileMod {
                    mod_version_id: None,
                    name: (*n).into(),
                    version: (*v).into(),
                    source: None,
                    hash: None,
                    files: vec![format!("{n}/{n}.dll")],
                    folder_name: Some((*n).into()),
                    mod_id: Some((*n).into()),
                    enabled: true,
                    bundle_url: None,
                    bundle_sha256: None,
                    bundle_members: vec![],
                    bundle_member_ids: vec![],
                })
                .collect(),
            created_at: now,
            updated_at: now,
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn subscription(profile_name: &str, snapshot: Profile) -> Subscription {
        let now = chrono::Utc::now();
        let profile_id = snapshot.id.clone();
        Subscription {
            share_id: format!("solomag:{}", profile_name.to_lowercase()),
            share_url: "solomag/CODE".into(),
            profile_name: profile_name.into(),
            profile_id,
            curator: Some("solomag".into()),
            last_synced_profile: snapshot,
            last_checked: now,
            last_synced: now,
        }
    }

    #[test]
    fn diff_profiles_keeps_same_named_artifacts_distinct() {
        let mut local = profile("Pack", &[("Variant", "1.0.0"), ("Variant", "2.0.0")]);
        local.mods[0].mod_version_id = Some("artifact-a".into());
        local.mods[0].folder_name = Some("VariantA".into());
        local.mods[1].mod_version_id = Some("artifact-b".into());
        local.mods[1].folder_name = Some("VariantB".into());

        let mut remote = local.clone();
        remote.mods[1].version = "2.1.0".into();

        let (added, removed, updated) = diff_profiles(&local, &remote);
        assert!(added.is_empty());
        assert!(removed.is_empty());
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].name, "Variant");
        assert_eq!(updated[0].old_version, "2.0.0");
        assert_eq!(updated[0].new_version, "2.1.0");
    }

    #[test]
    fn publish_refreshes_matching_self_subscription_snapshot() {
        // Solo's 2026-06-10 report: re-uploading her own pack made the
        // updater flag her own pack as having updates — the subscription
        // snapshot was stale relative to what she just published.
        let tmp = tempfile::tempdir().unwrap();
        let old_snapshot = profile("My Pack", &[("ModA", "1.0.0")]);
        let mut db = SubscriptionsDb::default();
        let sub = subscription("My Pack", old_snapshot);
        db.subscriptions.insert(sub.share_id.clone(), sub);
        save_subscriptions(&db, tmp.path()).unwrap();

        // Curator re-shares with a changed mod set.
        let published = profile("My Pack", &[("ModA", "1.1.0"), ("ModB", "0.3.0")]);
        assert!(sync_own_subscription_after_publish(tmp.path(), &published));

        let reloaded = load_subscriptions(tmp.path());
        let sub = reloaded.subscriptions.values().next().unwrap();
        // Snapshot now equals the published manifest → the next update
        // poll diffs equal-vs-equal and reports no pending update.
        let (added, removed, updated) = diff_profiles(&sub.last_synced_profile, &published);
        assert!(added.is_empty() && removed.is_empty() && updated.is_empty());
    }

    #[test]
    fn publish_with_no_matching_subscription_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let mut db = SubscriptionsDb::default();
        let sub = subscription("Someone Elses Pack", profile("Someone Elses Pack", &[]));
        db.subscriptions.insert(sub.share_id.clone(), sub);
        save_subscriptions(&db, tmp.path()).unwrap();

        let published = profile("My Pack", &[("ModA", "1.0.0")]);
        assert!(!sync_own_subscription_after_publish(tmp.path(), &published));

        // The unrelated subscription's snapshot is untouched.
        let reloaded = load_subscriptions(tmp.path());
        let sub = reloaded.subscriptions.values().next().unwrap();
        assert!(sub.last_synced_profile.mods.is_empty());
    }

    #[test]
    fn name_match_is_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let mut db = SubscriptionsDb::default();
        let sub = subscription("my pack", profile("my pack", &[]));
        db.subscriptions.insert(sub.share_id.clone(), sub);
        save_subscriptions(&db, tmp.path()).unwrap();

        let published = profile("My Pack", &[("ModA", "1.0.0")]);
        assert!(sync_own_subscription_after_publish(tmp.path(), &published));
    }
}
