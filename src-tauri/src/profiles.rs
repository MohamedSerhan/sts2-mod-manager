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
pub fn list_profiles(profiles_path: &Path) -> Vec<Profile> {
    let mut profiles = Vec::new();
    if !profiles_path.exists() {
        return profiles;
    }

    if let Ok(entries) = fs::read_dir(profiles_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(profile) = serde_json::from_str::<Profile>(&content) {
                        profiles.push(profile);
                    }
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

/// Delete a profile.
pub fn delete_profile(name: &str, profiles_path: &Path) -> Result<()> {
    let file_name = sanitize_filename(name);
    let path = profiles_path.join(format!("{}.json", file_name));
    if !path.exists() {
        return Err(AppError::InvalidProfile(format!(
            "Profile '{}' not found",
            name
        )));
    }
    fs::remove_file(&path)?;
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
pub fn snapshot_current_with_sources(
    name: &str,
    mods_path: &Path,
    profiles_path: &Path,
    config_path: Option<&Path>,
) -> Result<Profile> {
    let installed = scan_mods(mods_path);
    let now = Utc::now();

    // Load mod sources DB if config_path provided, to enrich profile with download links
    let sources_db = config_path
        .map(|p| crate::mod_sources::load_sources(p))
        .unwrap_or_default();

    let profile_mods: Vec<ProfileMod> = installed
        .into_iter()
        .map(|m| {
            // Try to enrich source with GitHub repo from mod_sources DB
            let source = m.source.clone().or_else(|| {
                sources_db.mods.get(&m.name)
                    .and_then(|e| e.github_repo.as_ref())
                    .map(|repo| format!("github:{}", repo))
            });
            ProfileMod {
                name: m.name,
                version: m.version,
                source,
                hash: m.hash,
                files: m.files,
            }
        })
        .collect();

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

/// Apply a profile: enable only the mods listed, disable everything else.
/// Uses move_mod_by_info (actual file list) with fallback to name-based matching.
pub fn apply_profile(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<()> {
    let profile_mod_names: std::collections::HashSet<String> =
        profile.mods.iter().map(|m| m.name.clone()).collect();

    // First, disable all currently enabled mods that are NOT in the profile
    let current_enabled = scan_mods(mods_path);
    for m in &current_enabled {
        if !profile_mod_names.contains(&m.name) {
            // Try file-list-based move first, fall back to name-based
            if crate::mods::move_mod_by_info(m, mods_path, disabled_path).is_err() {
                let _ = crate::mods::disable_mod(&m.name, mods_path, disabled_path);
            }
        }
    }

    // Then, enable all mods that ARE in the profile but currently disabled
    let current_disabled = scan_disabled_mods(disabled_path);
    for m in &current_disabled {
        if profile_mod_names.contains(&m.name) {
            // Try file-list-based move first, fall back to name-based
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

#[tauri::command]
pub fn switch_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
    let profile = load_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;
    s.active_profile = Some(name);
    drop(s); // Release lock before applying
    apply_profile(&profile, &mods_path, &disabled_path).map_err(|e| e.to_string())?;
    Ok(true)
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
