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
    let path = subs_path(config_path);
    if !path.exists() {
        return SubscriptionsDb::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => SubscriptionsDb::default(),
    }
}

pub fn save_subscriptions(db: &SubscriptionsDb, config_path: &Path) -> Result<()> {
    let path = subs_path(config_path);
    let json = serde_json::to_string_pretty(db)?;
    fs::write(&path, json)?;
    Ok(())
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Compare two profiles and return what changed.
fn diff_profiles(local: &Profile, remote: &Profile) -> (Vec<String>, Vec<String>, Vec<ModVersionChange>) {
    let local_mods: HashMap<&str, &str> = local
        .mods
        .iter()
        .map(|m| (m.name.as_str(), m.version.as_str()))
        .collect();
    let remote_mods: HashMap<&str, &str> = remote
        .mods
        .iter()
        .map(|m| (m.name.as_str(), m.version.as_str()))
        .collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut updated = Vec::new();

    // Mods in remote but not in local = added
    for (name, version) in &remote_mods {
        match local_mods.get(name) {
            None => added.push(name.to_string()),
            Some(local_ver) if local_ver != version => {
                updated.push(ModVersionChange {
                    name: name.to_string(),
                    old_version: local_ver.to_string(),
                    new_version: version.to_string(),
                });
            }
            _ => {}
        }
    }

    // Mods in local but not in remote = removed
    for name in local_mods.keys() {
        if !remote_mods.contains_key(name) {
            removed.push(name.to_string());
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
    let config_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.config_path.clone()
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

        // Parse share_id format: "owner:CODE" or just try as-is
        let fetch_result = if let Some(idx) = share_id.find(':') {
            let owner = &share_id[..idx];
            let code = &share_id[idx + 1..];
            let filename = format!("{}.json", code.to_lowercase());
            fetch_shared_profile(owner, &filename).await
        } else {
            // Legacy format - try as direct ID
            Err(crate::error::AppError::Other(format!("Invalid subscription ID: {}", share_id)))
        };
        match fetch_result {
            Ok(remote) => {
                let (added, removed, updated) = diff_profiles(&sub.last_synced_profile, &remote);
                let has_update = !added.is_empty() || !removed.is_empty() || !updated.is_empty();

                results.push(SubscriptionUpdate {
                    share_id: share_id.clone(),
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
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let (config_path, mods_path, disabled_path, profiles_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.config_path.clone(),
            s.mods_path.clone().ok_or("Game path not set")?,
            s.disabled_mods_path.clone().ok_or("Game path not set")?,
            s.profiles_path.clone(),
            s.cache_path.clone(),
            s.github_token.clone(),
        )
    };

    // Fetch the latest remote profile
    let remote = if let Some(idx) = share_id.find(':') {
        let owner = &share_id[..idx];
        let code = &share_id[idx + 1..];
        let filename = format!("{}.json", code.to_lowercase());
        fetch_shared_profile(owner, &filename)
            .await
            .map_err(|e| e.to_string())?
    } else {
        return Err(format!("Invalid subscription ID: {}", share_id));
    };

    // Save the profile locally
    crate::profiles::save_profile(&remote, &profiles_path).map_err(|e| e.to_string())?;

    // ── STEP 1: Download missing mods and restore version-mismatched mods ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let all_on_disk: Vec<crate::mods::ModInfo> = local_mods.into_iter()
        .chain(local_disabled.into_iter())
        .collect();

    // Build a map from identifiers to on-disk mod info (for version comparison)
    let mut on_disk_by_id: std::collections::HashMap<String, &crate::mods::ModInfo> = std::collections::HashMap::new();
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

    for pm in &remote.mods {
        // Find matching on-disk mod
        let on_disk_mod = on_disk_by_id.get(&pm.name)
            .or_else(|| pm.folder_name.as_ref().and_then(|f| on_disk_by_id.get(f)))
            .or_else(|| pm.mod_id.as_ref().and_then(|id| on_disk_by_id.get(id)))
            .copied();

        if let Some(disk_mod) = on_disk_mod {
            let disk_ver = disk_mod.version.trim_start_matches('v');
            let profile_ver = pm.version.trim_start_matches('v');

            let version_ok = disk_ver == profile_ver
                || profile_ver == "unknown" || profile_ver == "0.0.0"
                || disk_ver == "unknown" || disk_ver == "0.0.0";

            if version_ok {
                continue;
            }

            // Version mismatch -- reinstall from bundle or cache
            log::info!(
                "Subscription update: mod '{}' version mismatch (disk: {}, remote: {})",
                pm.name, disk_mod.version, pm.version
            );

            // Cache current version before deleting
            crate::mods::cache_mod_version(disk_mod, if disk_mod.enabled { &mods_path } else { &disabled_path }, &cache_path);

            // Try local cache first
            if crate::mods::get_cached_mod_path(&cache_path, &pm.name, &pm.version).is_some() {
                let base = if disk_mod.enabled { &mods_path } else { &disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                if crate::mods::restore_mod_from_cache(&cache_path, &pm.name, &pm.version, &mods_path).is_ok() {
                    log::info!("Restored '{}' v{} from local cache", pm.name, pm.version);
                    continue;
                }
            }

            if pm.bundle_url.is_some() {
                let base = if disk_mod.enabled { &mods_path } else { &disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to download
            } else {
                log::info!("Mod '{}' version mismatch but no bundle or cache -- keeping disk version", pm.name);
                continue;
            }
        }

        log::info!("Subscription update: mod '{}' needs download", pm.name);
        let mut downloaded = false;

        // Prefer bundle_url (curator's bundled copy)
        if let Some(ref bundle_url) = pm.bundle_url {
            match crate::sharing::download_bundle(bundle_url, &pm.name, &mods_path).await {
                Ok(_) => {
                    log::info!("Installed bundled mod '{}' from subscription update", pm.name);
                    downloaded = true;
                }
                Err(e) => {
                    log::warn!("Bundle download failed for '{}': {} -- trying GitHub fallback", pm.name, e);
                }
            }
        }

        // Fallback: try GitHub source
        if !downloaded {
            let github_repo = pm.source.as_ref().and_then(|s| {
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
            }).or_else(|| {
                mod_sources_db.mods.get(&pm.name).and_then(|e| e.github_repo.clone())
            });

            if let Some(repo) = github_repo {
                let parts: Vec<&str> = repo.splitn(2, '/').collect();
                if parts.len() == 2 {
                    match crate::download::download_and_install_github_mod(
                        parts[0], parts[1], None, &mods_path, &cache_path, token.as_deref(),
                    ).await {
                        Ok(info) => {
                            log::info!("Downloaded mod '{}' from GitHub for subscription", info.name);
                            downloaded = true;
                        }
                        Err(e) => {
                            log::warn!("GitHub download also failed for '{}': {}", pm.name, e);
                        }
                    }
                }
            }
        }

        if !downloaded {
            log::warn!("No download source for mod '{}' in subscription update", pm.name);
        }
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    log::info!("Subscription update: applying profile '{}' ({} mods)", remote.name, remote.mods.len());
    crate::profiles::apply_profile(&remote, &mods_path, &disabled_path)
        .map_err(|e| e.to_string())?;

    // ── STEP 3: Mark this profile as active ──
    // Without this, a previously-active profile would still be reported as
    // active and a later "Activate" of it (or app reload) would undo the sync.
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.active_profile = Some(remote.name.clone());
        if let Err(e) = std::fs::write(s.config_path.join("active_profile.txt"), &remote.name) {
            log::warn!("Failed to persist active_profile.txt after subscription update: {}", e);
        }
        log::info!("Subscription update: active profile set to '{}'", remote.name);
    }

    // Update subscription record
    let mut db = load_subscriptions(&config_path);
    if let Some(sub) = db.subscriptions.get_mut(&share_id) {
        sub.last_synced_profile = remote.clone();
        sub.last_synced = Utc::now();
        sub.last_checked = Utc::now();
    }
    save_subscriptions(&db, &config_path).map_err(|e| e.to_string())?;

    Ok(remote)
}
