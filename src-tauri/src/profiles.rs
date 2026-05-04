use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::{scan_disabled_mods, scan_mods};
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// A mod entry within a profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMod {
    pub name: String,
    pub version: String,
    pub source: Option<String>,
    pub hash: Option<String>,
    pub files: Vec<String>,
    /// The actual folder name on disk (for matching mods across installs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    /// The mod's `id` from manifest (used by game for dependency resolution)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    /// Whether this mod should be enabled when the profile is applied.
    /// Defaults to true for backwards compatibility with older profiles.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Direct download URL for mods bundled in the curator's profiles repo.
    /// Set automatically when sharing for mods without a GitHub source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_url: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// A saved profile capturing a snapshot of installed/enabled mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub game_version: Option<String>,
    pub created_by: Option<String>,
    pub mods: Vec<ProfileMod>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── Core Functions ──────────────────────────────────────────────────────────

/// List all saved profiles.
/// Includes profiles that only have a .share file (remote profiles not yet fetched).
pub fn list_profiles(profiles_path: &Path) -> Vec<Profile> {
    let mut profiles = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    if !profiles_path.exists() {
        return profiles;
    }

    // First pass: load all .json profiles
    if let Ok(entries) = fs::read_dir(profiles_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(profile) = serde_json::from_str::<Profile>(&content) {
                        seen_names.insert(profile.name.clone());
                        profiles.push(profile);
                    }
                }
            }
        }
    }

    // Second pass: create placeholder entries for .share files without matching .json
    if let Ok(entries) = fs::read_dir(profiles_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("share") {
                let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                if !seen_names.contains(&stem) {
                    // Create a placeholder profile -- will be fetched from GitHub on activation
                    profiles.push(Profile {
                        name: stem.clone(),
                        game_version: None,
                        created_by: Some("Shared (click Activate to fetch)".to_string()),
                        mods: vec![],
                        created_at: chrono::Utc::now(),
                        updated_at: chrono::Utc::now(),
                    });
                    seen_names.insert(stem);
                }
            }
        }
    }

    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

/// Save a profile to disk.
pub fn save_profile(profile: &Profile, profiles_path: &Path) -> Result<()> {
    let _ = fs::create_dir_all(profiles_path);
    let file_name = sanitize_filename(&profile.name);
    let path = profiles_path.join(format!("{}.json", file_name));
    let json = serde_json::to_string_pretty(profile)?;
    fs::write(&path, json)?;
    Ok(())
}

/// Load a profile by name.
pub fn load_profile(name: &str, profiles_path: &Path) -> Result<Profile> {
    let file_name = sanitize_filename(name);
    let path = profiles_path.join(format!("{}.json", file_name));
    if !path.exists() {
        return Err(AppError::InvalidProfile(format!(
            "Profile '{}' not found",
            name
        )));
    }
    let content = fs::read_to_string(&path)?;
    let profile: Profile = serde_json::from_str(&content)?;
    Ok(profile)
}

/// Delete a profile (both .json and .share files).
pub fn delete_profile(name: &str, profiles_path: &Path) -> Result<()> {
    let file_name = sanitize_filename(name);
    let json_path = profiles_path.join(format!("{}.json", file_name));
    let share_path = profiles_path.join(format!("{}.share", file_name));
    // Also try with the raw name (spaces preserved) for .share files
    let share_path_raw = profiles_path.join(format!("{}.share", name));

    let mut deleted_any = false;

    if json_path.exists() {
        fs::remove_file(&json_path)?;
        deleted_any = true;
    }
    if share_path.exists() {
        fs::remove_file(&share_path)?;
        deleted_any = true;
    }
    if share_path_raw.exists() && share_path_raw != share_path {
        fs::remove_file(&share_path_raw)?;
        deleted_any = true;
    }

    if !deleted_any {
        return Err(AppError::InvalidProfile(format!(
            "Profile '{}' not found",
            name
        )));
    }
    Ok(())
}

/// Create a snapshot of currently installed (enabled) mods as a profile.
/// Enriches source links with mod_sources DB so shared profiles include download info.
pub fn snapshot_current(
    name: &str,
    mods_path: &Path,
    profiles_path: &Path,
) -> Result<Profile> {
    snapshot_current_with_sources(name, mods_path, profiles_path, None)
}

/// Create a snapshot with optional source enrichment from config_path.
/// Captures BOTH enabled and disabled mods with their current state.
pub fn snapshot_current_with_sources(
    name: &str,
    mods_path: &Path,
    profiles_path: &Path,
    config_path: Option<&Path>,
) -> Result<Profile> {
    let enabled_mods = scan_mods(mods_path);
    // Also get the disabled mods path (sibling of mods_path)
    let disabled_path = mods_path.parent()
        .map(|p| p.join("mods_disabled"))
        .unwrap_or_else(|| mods_path.with_file_name("mods_disabled"));
    let disabled_mods = scan_disabled_mods(&disabled_path);
    let now = Utc::now();

    // Load mod sources DB if config_path provided, to enrich profile with download links
    let sources_db = config_path
        .map(|p| crate::mod_sources::load_sources(p))
        .unwrap_or_default();

    let mut profile_mods: Vec<ProfileMod> = Vec::new();

    // Add enabled mods
    for m in enabled_mods {
        let source = m.source.clone().or_else(|| {
            sources_db.mods.get(&m.name)
                .and_then(|e| e.github_repo.as_ref())
                .map(|repo| format!("github:{}", repo))
        });
        profile_mods.push(ProfileMod {
            name: m.name,
            version: m.version,
            source,
            hash: m.hash,
            files: m.files,
            folder_name: m.folder_name,
            mod_id: m.mod_id,
            enabled: true,
            bundle_url: None,
        });
    }

    // Add disabled mods
    for m in disabled_mods {
        let source = m.source.clone().or_else(|| {
            sources_db.mods.get(&m.name)
                .and_then(|e| e.github_repo.as_ref())
                .map(|repo| format!("github:{}", repo))
        });
        profile_mods.push(ProfileMod {
            name: m.name,
            version: m.version,
            source,
            hash: m.hash,
            files: m.files,
            folder_name: m.folder_name,
            mod_id: m.mod_id,
            enabled: false,
            bundle_url: None,
        });
    }

    let profile = Profile {
        name: name.to_string(),
        game_version: None,
        created_by: Some("sts2-mod-manager".to_string()),
        mods: profile_mods,
        created_at: now,
        updated_at: now,
    };

    save_profile(&profile, profiles_path)?;
    Ok(profile)
}

/// Apply a profile: restore exact enabled/disabled state for all listed mods.
/// Mods not in the profile are disabled. Uses move_mod_by_info with fallback.
pub fn apply_profile(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<()> {
    use std::collections::HashMap;

    // Build a map of profile mod states
    let profile_state: HashMap<String, bool> = profile.mods.iter()
        .map(|m| (m.name.clone(), m.enabled))
        .collect();

    // Step 1: Move mods that should be DISABLED from enabled to disabled
    let current_enabled = scan_mods(mods_path);
    for m in &current_enabled {
        let should_be_enabled = profile_state.get(&m.name).copied().unwrap_or(false);
        if !should_be_enabled {
            log::info!("Profile apply: disabling '{}'", m.name);
            if crate::mods::move_mod_by_info(m, mods_path, disabled_path).is_err() {
                let _ = crate::mods::disable_mod(&m.name, mods_path, disabled_path);
            }
        }
    }

    // Step 2: Move mods that should be ENABLED from disabled to enabled
    let current_disabled = scan_disabled_mods(disabled_path);
    for m in &current_disabled {
        let should_be_enabled = profile_state.get(&m.name).copied().unwrap_or(false);
        if should_be_enabled {
            log::info!("Profile apply: enabling '{}'", m.name);
            if crate::mods::move_mod_by_info(m, disabled_path, mods_path).is_err() {
                let _ = crate::mods::enable_mod(&m.name, mods_path, disabled_path);
            }
        }
    }

    Ok(())
}

/// Export a profile as a JSON string.
pub fn export_profile(profile: &Profile) -> String {
    serde_json::to_string_pretty(profile).unwrap_or_else(|_| "{}".to_string())
}

/// Import a profile from a JSON string and save it.
pub fn import_profile(json: &str, profiles_path: &Path) -> Result<Profile> {
    let profile: Profile = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidProfile(format!("Invalid profile JSON: {}", e)))?;
    save_profile(&profile, profiles_path)?;
    Ok(profile)
}

/// Sanitize a profile name for use as a filename.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_profiles_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<Vec<Profile>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(list_profiles(&s.profiles_path))
}

#[tauri::command]
pub fn create_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    snapshot_current_with_sources(&name, mods_path, &s.profiles_path, Some(&s.config_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile_cmd(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    delete_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Duplicate an existing profile with a new name.
#[tauri::command]
pub fn duplicate_profile(
    name: String,
    new_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut profile = load_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;
    profile.name = new_name;
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, &s.profiles_path).map_err(|e| e.to_string())?;
    log::info!("Duplicated profile '{}' as '{}'", name, profile.name);
    Ok(profile)
}

/// Switch to a profile: auto-snapshots current state first, downloads missing mods,
/// then applies the target profile's exact enabled/disabled state.
#[tauri::command]
pub async fn switch_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<SwitchProfileResult, String> {
    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token, current_profile_name) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
        let disabled = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        let current = s.active_profile.clone();
        (mods, disabled, profiles, config, cache, token, current)
    };

    // Auto-snapshot current state before switching (so user can switch back)
    // BUT: don't snapshot if switching to the same profile (re-activating)
    // AND: don't snapshot if current state has no mods (nothing to preserve)
    let current_mods_count = scan_mods(&mods_path).len() + scan_disabled_mods(&disabled_path).len();
    if current_mods_count > 0 {
        if let Some(ref current_name) = current_profile_name {
            if current_name != &name {
                log::info!("Auto-snapshotting current state as '{}' before switching to '{}'", current_name, name);
                let _ = snapshot_current_with_sources(current_name, &mods_path, &profiles_path, Some(&config_path));
            }
        } else {
            log::info!("No active profile -- saving current state as '_Previous State'");
            let _ = snapshot_current_with_sources("_Previous State", &mods_path, &profiles_path, Some(&config_path));
        }
    } else {
        log::info!("Skipping auto-snapshot: no mods on disk to preserve");
    }

    // Load target profile -- try local JSON first, then re-fetch from share code if missing
    let profile = match load_profile(&name, &profiles_path) {
        Ok(p) => p,
        Err(_) => {
            // Local .json missing -- check for .share file to re-fetch from GitHub
            let share_file = profiles_path.join(format!("{}.share", sanitize_filename(&name)));
            if share_file.exists() {
                log::info!("Profile '{}' JSON missing, re-fetching from share code", name);
                let share_content = std::fs::read_to_string(&share_file).map_err(|e| e.to_string())?;
                let share_info: serde_json::Value = serde_json::from_str(&share_content).map_err(|e| e.to_string())?;
                let owner = share_info["owner"].as_str().ok_or("Share file missing owner")?;
                let code = share_info["code"].as_str().ok_or("Share file missing code")?;
                let filename = format!("{}.json", code.replace('-', "").to_lowercase());
                let fetched = crate::sharing::fetch_shared_profile(owner, &filename)
                    .await
                    .map_err(|e| format!("Failed to re-fetch shared profile: {}", e))?;
                // Save locally so we have it next time
                let _ = save_profile(&fetched, &profiles_path);
                fetched
            } else {
                return Err(format!("Profile '{}' not found (no local data or share code)", name));
            }
        }
    };

    if profile.mods.is_empty() {
        // Update active profile even if empty
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.active_profile = Some(name.clone());
        return Ok(SwitchProfileResult {
            applied: true,
            missing_mods: vec![],
            downloaded: 0,
            failed_downloads: vec![],
        });
    }

    // ── STEP 1: Download missing mods ──
    let all_on_disk: Vec<crate::mods::ModInfo> = scan_mods(&mods_path)
        .into_iter()
        .chain(scan_disabled_mods(&disabled_path).into_iter())
        .collect();
    // Build lookup sets by name, folder_name, and mod_id for robust matching
    let mut on_disk_identifiers: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in &all_on_disk {
        on_disk_identifiers.insert(m.name.clone());
        if let Some(ref folder) = m.folder_name {
            on_disk_identifiers.insert(folder.clone());
        }
        if let Some(ref id) = m.mod_id {
            on_disk_identifiers.insert(id.clone());
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let mut downloaded_count = 0u32;
    let mut download_failures: Vec<String> = Vec::new();

    for pm in &profile.mods {
        let already_exists = on_disk_identifiers.contains(&pm.name)
            || pm.folder_name.as_ref().map_or(false, |f| on_disk_identifiers.contains(f))
            || pm.mod_id.as_ref().map_or(false, |id| on_disk_identifiers.contains(id));
        if already_exists {
            continue;
        }

        log::info!("Mod '{}' missing from disk -- attempting download", pm.name);

        let mut downloaded = false;

        // Prefer bundle_url -- the curator bundled it because the GitHub
        // source may be wrong/unreliable (e.g., wrong game's repo)
        if let Some(ref bundle_url) = pm.bundle_url {
            log::info!("Downloading bundled mod '{}' from profiles repo", pm.name);
            match crate::sharing::download_bundle(bundle_url, &pm.name, &mods_path).await {
                Ok(_) => {
                    log::info!("Installed bundled mod '{}'", pm.name);
                    downloaded_count += 1;
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
                            log::info!("Downloaded mod '{}' from GitHub", info.name);
                            downloaded_count += 1;
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
            log::warn!("No download source for mod '{}' -- cannot restore", pm.name);
            download_failures.push(pm.name.clone());
        }
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    apply_profile(&profile, &mods_path, &disabled_path).map_err(|e| e.to_string())?;

    // ── STEP 3: Check what's still missing ──
    let final_on_disk: Vec<crate::mods::ModInfo> = scan_mods(&mods_path)
        .into_iter()
        .chain(scan_disabled_mods(&disabled_path).into_iter())
        .collect();
    let final_names: std::collections::HashSet<String> = final_on_disk.iter().map(|m| m.name.clone()).collect();
    let still_missing: Vec<String> = profile.mods.iter()
        .filter(|pm| !final_names.contains(&pm.name))
        .map(|pm| pm.name.clone())
        .collect();

    // Update active profile
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = Some(name.clone());

    Ok(SwitchProfileResult {
        applied: true,
        missing_mods: still_missing,
        downloaded: downloaded_count,
        failed_downloads: download_failures,
    })
}

/// Result of switching profiles, including download stats and any mods that couldn't be restored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchProfileResult {
    pub applied: bool,
    pub missing_mods: Vec<String>,
    pub downloaded: u32,
    pub failed_downloads: Vec<String>,
}

#[tauri::command]
pub fn snapshot_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    snapshot_current_with_sources(&name, mods_path, &s.profiles_path, Some(&s.config_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_profile_cmd(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<String, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let profile = load_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;
    Ok(export_profile(&profile))
}

#[tauri::command]
pub fn import_profile_cmd(
    json: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    import_profile(&json, &s.profiles_path).map_err(|e| e.to_string())
}
