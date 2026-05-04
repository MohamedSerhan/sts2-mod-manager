use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::profiles::Profile;
use crate::sharing::fetch_gist;
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

        match fetch_gist(share_id).await {
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

/// Apply a subscription update: download the remote profile and sync mods.
/// This is the one-click "Apply update" for friends.
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
    let remote = fetch_gist(&share_id)
        .await
        .map_err(|e| e.to_string())?;

    // Save the profile locally
    crate::profiles::save_profile(&remote, &profiles_path).map_err(|e| e.to_string())?;

    // Apply the profile (enable/disable mods to match)
    crate::profiles::apply_profile(&remote, &mods_path, &disabled_path)
        .map_err(|e| e.to_string())?;

    // Try to download any mods from the profile that we don't have locally
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let local_names: std::collections::HashSet<String> = local_mods
        .iter()
        .chain(local_disabled.iter())
        .map(|m| m.name.clone())
        .collect();

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);

    for pm in &remote.mods {
        if local_names.contains(&pm.name) {
            continue; // Already have it
        }

        // Try to download from source
        let github_repo = pm
            .source
            .as_ref()
            .and_then(|s| {
                s.strip_prefix("github:")
                    .map(|r| r.to_string())
            })
            .or_else(|| {
                mod_sources_db
                    .mods
                    .get(&pm.name)
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
                        log::info!("Auto-downloaded mod '{}' for subscription", info.name);
                    }
                    Err(e) => {
                        log::warn!("Could not auto-download '{}': {}", pm.name, e);
                    }
                }
            }
        }
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
