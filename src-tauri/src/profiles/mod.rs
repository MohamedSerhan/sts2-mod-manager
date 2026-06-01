use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

// ── Submodules ─────────────────────────────────────────────────────────────
//
// `profiles` was a 3.7k-line single file. Compute layers live in their
// own sub-modules — the Tauri commands stay here as thin orchestrators
// so the `#[tauri::command]` proc-macro expands its companion
// `__cmd__*` items at `crate::profiles::*`, the path `lib.rs`'s
// invoke-handler list references.
//
//   - `crud`       — on-disk storage (list/save/load/delete/import/export)
//                    + mod-identity matching helpers used everywhere else.
//   - `apply`      — snapshot + apply pipeline (snapshot_current_*,
//                    apply_profile_with_pins, switch_profile_from_paths)
//                    plus pin-matching helpers shared with `drift`.
//   - `drift`      — drift detection + repair compute layer.
//   - `membership` — per-mod membership grid + manifest mutation +
//                    load-order persistence (incl. settings.save sync).
mod apply;
mod crud;
mod drift;
mod membership;

// Re-exports preserve the historic `crate::profiles::ProfileDrift`,
// `crate::profiles::save_profile`, etc. surface that the rest of the
// codebase reaches via the same paths it used pre-split.
pub use apply::{
    apply_profile_with_pins, snapshot_current_with_paths, snapshot_current_with_sources,
    SwitchProfileResult,
};
pub(crate) use apply::{profile_mod_matches_pin, should_skip_pinned_profile_mod_download};
pub use crud::{export_profile, import_profile, list_profiles, load_profile, save_profile};
pub use drift::{ProfileDrift, RepairProfileResult, VersionMismatch};

use apply::switch_profile_from_paths;
use crud::delete_profile;
use membership::{
    profile_membership_matrix, set_profile_load_order_from_paths,
    set_profile_mod_membership_from_paths, sync_profile_load_order_to_settings,
};

pub(super) const APP_CREATED_BY: &str = "sts2-mod-manager";

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
    /// SHA256 hex digest of the bundle zip's bytes at upload time. Used
    /// by re-share to skip uploads when the bundle hasn't changed
    /// (content-addressing — mod authors who edit a mod without bumping
    /// `version` still get a fresh upload because the hash differs).
    /// `None` for mods without a bundle, or for profiles written by
    /// manager versions before v1.4.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
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
    /// Opt-in flag for the in-app Browse Modpacks tab.
    /// `Some(true)` = listed; `None` / `Some(false)` = unlisted.
    /// Defensive default so any manifest already in a curator's
    /// `sts2mm-profiles` repo (no field present) is treated as opted out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipGrid {
    pub profiles: Vec<ProfileMembershipProfile>,
    pub mods: Vec<ProfileMembershipMod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipProfile {
    pub name: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipMod {
    pub name: String,
    pub version: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub installed_enabled: bool,
    pub profiles: Vec<ProfileMembershipState>,
    /// The folder name of the bundle container this mod belongs to, if any.
    /// Mirrors `ModInfo::bundle_id` — set when the mod is a sidecar-tagged
    /// bundle member; `None` for standalone mods.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipState {
    pub profile_name: String,
    pub included: bool,
    pub enabled: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileModOrderKey {
    pub name: String,
    #[serde(default, alias = "folderName")]
    pub folder_name: Option<String>,
    #[serde(default, alias = "modId")]
    pub mod_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadOrderSettingsStatus {
    Applied,
    SkippedInactive,
    SkippedMissing,
    SkippedMultiple,
    SkippedGameRunning,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileLoadOrderUpdate {
    pub profile: Profile,
    pub settings_status: LoadOrderSettingsStatus,
    pub settings_path: Option<String>,
}

// ── Tauri commands ─────────────────────────────────────────────────────────
//
// These thin orchestrators stay in `mod.rs` so the `#[tauri::command]`
// proc-macro emits its companion `__cmd__*` items at the
// `crate::profiles::*` path that `lib.rs`'s invoke-handler list
// references. The actual work is in the submodules.

#[tauri::command]
pub fn list_profiles_cmd(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<Profile>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(list_profiles(&s.profiles_path))
}

#[tauri::command]
pub fn get_profile_memberships(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ProfileMembershipGrid, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    profile_membership_matrix(mods_path, disabled_path, &s.profiles_path, &s.config_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_profile_mod_membership(
    profile_name: String,
    mod_name: String,
    folder_name: Option<String>,
    mod_id: Option<String>,
    included: bool,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    set_profile_mod_membership_from_paths(
        &profile_name,
        &mod_name,
        folder_name.as_deref(),
        mod_id.as_deref(),
        included,
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_profile_load_order(
    profile_name: String,
    ordered_mods: Vec<ProfileModOrderKey>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ProfileLoadOrderUpdate, String> {
    let (profiles_path, config_path, mods_path, disabled_path, active_profile) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.profiles_path.clone(),
            s.config_path.clone(),
            s.mods_path.clone(),
            s.disabled_mods_path.clone(),
            s.active_profile.clone(),
        )
    };

    let profile = set_profile_load_order_from_paths(
        &profile_name,
        ordered_mods,
        &profiles_path,
        &config_path,
    )
    .map_err(|e| e.to_string())?;

    let (settings_status, settings_path) = if active_profile.as_deref()
        == Some(profile_name.as_str())
    {
        if crate::game::is_game_running() {
            (LoadOrderSettingsStatus::SkippedGameRunning, None)
        } else if let (Some(mods_path), Some(disabled_path)) =
            (mods_path.as_ref(), disabled_path.as_ref())
        {
            sync_profile_load_order_to_settings(&profile, mods_path, disabled_path, &config_path)
        } else {
            (LoadOrderSettingsStatus::SkippedMissing, None)
        }
    } else {
        (LoadOrderSettingsStatus::SkippedInactive, None)
    };

    Ok(ProfileLoadOrderUpdate {
        profile,
        settings_status,
        settings_path,
    })
}

#[tauri::command]
pub fn create_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    // Explicit user action — apply the bug-#21 filter using the cached
    // game_version so incompatible mods don't get saved into a new
    // profile. AppState.game_version is set on the canonical
    // game root, so this is also the macOS-correct source.
    let game_version = s.game_version.clone();
    snapshot_current_with_sources(
        &name,
        mods_path,
        &s.profiles_path,
        Some(&s.config_path),
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile_cmd(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let config_path = s.config_path.clone();
    delete_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;
    drop(s);

    // Also clean up any matching subscription
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    let to_remove: Vec<String> = db
        .subscriptions
        .iter()
        .filter(|(_, sub)| sub.profile_name == name)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &to_remove {
        db.subscriptions.remove(id);
    }
    if !to_remove.is_empty() {
        let _ = crate::subscriptions::save_subscriptions(&db, &config_path);
        log::info!(
            "Cleaned up {} subscription(s) for deleted profile '{}'",
            to_remove.len(),
            name
        );
    }
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

#[tauri::command]
pub async fn switch_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<SwitchProfileResult, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
        let disabled = s
            .disabled_mods_path
            .as_ref()
            .ok_or("Game path not set")?
            .clone();
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods, disabled, profiles, config, cache, token)
    };

    let result = switch_profile_from_paths(
        &name,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        &cache_path,
        token.as_deref(),
    )
    .await?;

    // Update active profile (also persist to disk)
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = Some(name.clone());
    let _ = std::fs::write(s.config_path.join("active_profile.txt"), &name);

    Ok(result)
}

#[tauri::command]
pub fn snapshot_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    // Explicit user action (kebab → Snapshot) — apply the bug-#21
    // filter using the cached game_version (macOS-correct source).
    let game_version = s.game_version.clone();
    snapshot_current_with_sources(
        &name,
        mods_path,
        &s.profiles_path,
        Some(&s.config_path),
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())
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

// ── Drift detection (commands) ─────────────────────────────────────────────
//
// The compute layer lives in `drift.rs`; these are the Tauri-facing
// orchestrators. They stay in `mod.rs` so the `#[tauri::command]` macro
// emits its `__cmd__*` companions at the `crate::profiles::*` path that
// `lib.rs` references.

#[tauri::command]
pub fn get_profile_drift(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ProfileDrift, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    drift::compute_drift_for_profile(&name, mods_path, disabled_path, &s.profiles_path)
}

/// Save the drift: reconcile the manifest to the current loadout by applying
/// only the diff (add enabled extras, drop missing mods, sync toggled/version
/// for mods still present). Unlike `snapshot_profile`, this preserves the
/// pack's curated set instead of pulling the whole install into it.
#[tauri::command]
pub fn save_profile_drift(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    drift::reconcile_profile_with_disk(&name, mods_path, disabled_path, &s.profiles_path, &s.config_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn repair_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<RepairProfileResult, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
        let disabled = s
            .disabled_mods_path
            .as_ref()
            .ok_or("Game path not set")?
            .clone();
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods, disabled, profiles, config, cache, token)
    };

    let result = drift::repair_profile_from_paths(
        &name,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        &cache_path,
        token.as_deref(),
    )
    .await?;

    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = Some(name.clone());
    let _ = std::fs::write(s.config_path.join("active_profile.txt"), &name);

    Ok(result)
}
