use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::mod_versions::LocalModVersionOption;
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
pub use crud::{
    export_profile, import_profile, list_profiles, load_profile, persist_profile_mod_sources,
    save_profile,
};
pub(crate) use crud::{
    migrate_profile_identity_storage, profile_file_stem, profile_mod_artifact_id_matches,
    profile_mod_from_installed, profile_mod_matches_installed_with_registry, profile_name_exists,
    unique_profile_name,
};
pub use drift::{ProfileDrift, RepairProfileResult, VersionMismatch};
pub use membership::SetProfileModsEnabledResult;

use apply::switch_profile_from_paths;
use crud::delete_profile;
use membership::{
    profile_membership_matrix, select_library_mod_version_from_paths,
    set_profile_load_order_from_paths, set_profile_mod_membership_from_paths,
    set_profile_mods_enabled_from_paths, sync_profile_load_order_to_settings,
};

pub(super) const APP_CREATED_BY: &str = "sts2-mod-manager";

// ── Types ───────────────────────────────────────────────────────────────────

/// A mod entry within a profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMod {
    /// Stable manager-owned ID for the exact artifact this profile points at.
    /// Legacy profiles deserialize with None and are migrated lazily.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
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
    /// Member-mod display names when this entry is a bundle container.
    /// Non-empty only when the installed `ModInfo` had non-empty
    /// `bundle_members`. Serialized into the shared profile manifest so
    /// friends browsing the pack see a "N mods" badge on the bundle row.
    /// Legacy manifests without this field deserialize as an empty Vec.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_members: Vec<String>,
}

fn default_enabled() -> bool {
    true
}

/// Curator-authored metadata for one mod, carried inside a shared
/// manifest so friends inherit the curator's notes/links/tags
/// (Solo FR, 2026-06-10). Purely informational — never used for mod
/// identity, drift, updates, or the publish signature.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SharedModExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl SharedModExtras {
    pub fn is_empty(&self) -> bool {
        self.note.is_none() && self.custom_url.is_none() && self.tags.is_empty()
    }
}

/// A saved profile capturing a snapshot of installed/enabled mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// Stable local identity for storage and sidecars. Display names can be
    /// renamed; this must not change with them.
    #[serde(default = "new_profile_id")]
    pub id: String,
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
    /// Curator notes/links/tags per mod, keyed folder-first
    /// (`folder_name ?? name`) to match the sources-DB convention.
    /// Populated at publish time from the curator's mod_sources.json
    /// (unless they opt out); merged fill-only into the receiver's
    /// sources DB on install. Older manifests deserialize as empty;
    /// older app versions ignore the unknown field.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub mod_extras: HashMap<String, SharedModExtras>,
}

pub fn new_profile_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipGrid {
    pub profiles: Vec<ProfileMembershipProfile>,
    pub mods: Vec<ProfileMembershipMod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipProfile {
    pub id: String,
    pub name: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipMod {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
    pub name: String,
    pub version: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub installed_enabled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub version_options: Vec<LocalModVersionOption>,
    pub profiles: Vec<ProfileMembershipState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMembershipState {
    pub profile_id: String,
    pub profile_name: String,
    pub included: bool,
    pub enabled: bool,
    pub editable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileModOrderKey {
    #[serde(default, alias = "modVersionId")]
    pub mod_version_id: Option<String>,
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
    profile_membership_matrix(
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_profile_mod_membership(
    profile_id: String,
    mod_name: String,
    mod_version_id: Option<String>,
    folder_name: Option<String>,
    mod_id: Option<String>,
    included: bool,
    source_hint: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    set_profile_mod_membership_from_paths(
        &profile_id,
        &mod_name,
        mod_version_id.as_deref(),
        folder_name.as_deref(),
        mod_id.as_deref(),
        included,
        source_hint.as_deref(),
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn select_profile_mod_version(
    profile_id: String,
    current_name: String,
    current_mod_version_id: Option<String>,
    current_folder_name: Option<String>,
    current_mod_id: Option<String>,
    selected_name: String,
    selected_mod_version_id: Option<String>,
    selected_folder_name: Option<String>,
    selected_mod_id: Option<String>,
    apply_to_disk: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    if apply_to_disk.unwrap_or(false) {
        crate::game::ensure_game_not_running()?;
    }
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    membership::select_profile_mod_version_from_paths(
        &profile_id,
        &current_name,
        current_mod_version_id.as_deref(),
        current_folder_name.as_deref(),
        current_mod_id.as_deref(),
        &selected_name,
        selected_mod_version_id.as_deref(),
        selected_folder_name.as_deref(),
        selected_mod_id.as_deref(),
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
        apply_to_disk.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn select_library_mod_version(
    current_name: String,
    current_mod_version_id: Option<String>,
    current_folder_name: Option<String>,
    current_mod_id: Option<String>,
    selected_name: String,
    selected_mod_version_id: Option<String>,
    selected_folder_name: Option<String>,
    selected_mod_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<crate::mods::ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    select_library_mod_version_from_paths(
        &current_name,
        current_mod_version_id.as_deref(),
        current_folder_name.as_deref(),
        current_mod_id.as_deref(),
        &selected_name,
        selected_mod_version_id.as_deref(),
        selected_folder_name.as_deref(),
        selected_mod_id.as_deref(),
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
    )
    .map_err(|e| e.to_string())
}

/// Enable or disable every mod in a profile at once (the modpack view's
/// "Enable all" / "Disable all"). Resolves each manifest entry to its real
/// on-disk mod, so it works even when the manifest folder name has drifted.
#[tauri::command]
pub fn set_profile_mods_enabled(
    profile_id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<SetProfileModsEnabledResult, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, config_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.mods_path.as_ref().ok_or("Game path not set")?.clone(),
            s.disabled_mods_path
                .as_ref()
                .ok_or("Game path not set")?
                .clone(),
            s.profiles_path.clone(),
            s.config_path.clone(),
        )
    };
    set_profile_mods_enabled_from_paths(
        &profile_id,
        enabled,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_profile_load_order(
    profile_id: String,
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

    let profile =
        set_profile_load_order_from_paths(&profile_id, ordered_mods, &profiles_path, &config_path)
            .map_err(|e| e.to_string())?;

    let (settings_status, settings_path) =
        if active_profile_matches(active_profile.as_deref(), &profile) {
            if crate::game::is_game_running() {
                (LoadOrderSettingsStatus::SkippedGameRunning, None)
            } else if let (Some(mods_path), Some(disabled_path)) =
                (mods_path.as_ref(), disabled_path.as_ref())
            {
                sync_profile_load_order_to_settings(
                    &profile,
                    mods_path,
                    disabled_path,
                    &config_path,
                )
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
    let name = name.trim();
    if name.is_empty() {
        return Err("Name can't be empty".to_string());
    }
    if profile_name_exists(name, &s.profiles_path, None) {
        return Err(format!("A modpack named '{}' already exists", name));
    }
    // Explicit user action — apply the bug-#21 filter using the cached
    // game_version so incompatible mods don't get saved into a new
    // profile. AppState.game_version is set on the canonical
    // game root, so this is also the macOS-correct source.
    let game_version = s.game_version.clone();
    snapshot_current_with_sources(
        name,
        mods_path,
        &s.profiles_path,
        Some(&s.config_path),
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile_cmd(
    profile_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let config_path = s.config_path.clone();
    let mods_path = s.mods_path.clone();
    let disabled_path = s.disabled_mods_path.clone();
    // FB2-D: deleting the ACTIVE pack resets the game folder to vanilla (moves
    // its mods out), which can't happen with the game holding the files. Lock
    // the action down rather than half-doing it — the running-game state
    // already tells the user mods can't be changed. (A non-active pack is just
    // a manifest delete, so it stays allowed while the game runs.)
    let deleted = load_profile(&profile_id, &s.profiles_path).ok();
    let deleted_id = deleted.as_ref().map(|p| p.id.clone());
    let deleted_name = deleted
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| profile_id.clone());
    let is_active = s.active_profile.as_deref().is_some_and(|a| {
        a.eq_ignore_ascii_case(&profile_id)
            || deleted_id
                .as_deref()
                .is_some_and(|id| a.eq_ignore_ascii_case(id))
    });
    if is_active {
        crate::game::ensure_game_not_running()?;
    }
    delete_profile(&profile_id, &s.profiles_path).map_err(|e| e.to_string())?;
    // Bug 3: if the deleted pack was the active one, drop the active-profile
    // pointer (in-memory + active_profile.txt). Without this the UI keeps the
    // gone pack flagged "active" and the next launch tries to restore it.
    let was_active = clear_active_profile_if_deleted(
        &mut s.active_profile,
        &config_path,
        &deleted_name,
        deleted_id.as_deref(),
    );
    drop(s);

    if was_active {
        log::info!(
            "Cleared active profile after deleting active pack '{}'",
            deleted_name
        );
        // FB-B: clearing the pointer left the deleted pack's mods sitting in the
        // active folder, so a "modded" launch loaded them with errors. Empty the
        // active folder (move everything to disabled) so the post-delete state is
        // genuinely vanilla. The game is guaranteed closed by the guard above.
        if let (Some(mods_path), Some(disabled_path)) = (mods_path, disabled_path) {
            let moved = crate::mods::move_all_mods_between(&mods_path, &disabled_path);
            if !moved.is_empty() {
                log::info!(
                    "Reset active mods folder to vanilla after deleting active pack '{}': stored {} mod(s)",
                    deleted_name,
                    moved.len()
                );
            }
        }
    }

    // Also clean up any matching subscription
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    let to_remove: Vec<String> = db
        .subscriptions
        .iter()
        .filter(|(_, sub)| {
            deleted_id
                .as_deref()
                .is_some_and(|id| sub.profile_id.eq_ignore_ascii_case(id))
                || sub.profile_name.eq_ignore_ascii_case(&deleted_name)
        })
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
            deleted_name
        );
    }
    Ok(true)
}

/// Duplicate an existing profile with a new name.
#[tauri::command]
pub async fn duplicate_profile(
    profile_id: String,
    new_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let (profiles_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.profiles_path.clone(), s.github_token.clone())
    };
    let mut profile = load_profile(&profile_id, &profiles_path).map_err(|e| e.to_string())?;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("Name can't be empty".to_string());
    }
    if profile_name_exists(new_name, &profiles_path, None) {
        return Err(format!("A modpack named '{}' already exists", new_name));
    }
    let duplicate_owner = match token.as_deref() {
        Some(token) => match crate::sharing::authenticated_github_username(token).await {
            Ok(username) => Some(username),
            Err(e) => {
                log::warn!(
                    "Could not resolve GitHub username while duplicating '{}': {}",
                    profile_id,
                    e
                );
                None
            }
        },
        None => None,
    };
    profile.id = new_profile_id();
    profile.name = new_name.to_string();
    profile.updated_at = chrono::Utc::now();
    stamp_duplicate_profile_metadata(&mut profile, duplicate_owner.as_deref());
    save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;
    log::info!("Duplicated profile '{}' as '{}'", profile_id, profile.name);
    Ok(profile)
}

fn stamp_duplicate_profile_metadata(profile: &mut Profile, owner: Option<&str>) {
    profile.created_by = owner
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .map(ToString::to_string);
    profile.public = None;
}

pub(crate) fn profile_identifier_matches(profile: &Profile, identifier: &str) -> bool {
    profile.id.eq_ignore_ascii_case(identifier) || profile.name.eq_ignore_ascii_case(identifier)
}

pub(crate) fn active_profile_matches(active_profile: Option<&str>, profile: &Profile) -> bool {
    active_profile.is_some_and(|active| profile_identifier_matches(profile, active))
}

/// Rename a profile, preserving its `.share` code, active state, and any
/// subscriptions pointing at it.
#[tauri::command]
pub fn rename_profile(
    profile_id: String,
    new_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let renamed = crud::rename_profile(&profile_id, &new_name, &s.profiles_path)
        .map_err(|e| e.to_string())?;
    let new = renamed.name.clone();

    // (c) If the renamed pack was active, follow it by stable id. Older
    // installs may still have the active pointer stored as the old display
    // name, so accept both the old name and the profile id.
    if s.active_profile.as_deref().is_some_and(|active| {
        active.eq_ignore_ascii_case(&profile_id) || active.eq_ignore_ascii_case(&renamed.id)
    }) {
        s.active_profile = Some(renamed.id.clone());
        persist_active_profile(&s.config_path, &renamed.id);
    }
    let config_path = s.config_path.clone();
    drop(s);

    // (d) Re-point subscriptions, mirroring delete_profile_cmd's cleanup.
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    if crate::subscriptions::rename_profile_display(&mut db, &renamed.id, &new) {
        let _ = crate::subscriptions::save_subscriptions(&db, &config_path);
    }
    log::info!("Renamed profile '{}' to '{}'", profile_id, new);
    Ok(renamed)
}

#[tauri::command]
pub async fn switch_profile(
    profile_id: String,
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
        &profile_id,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        &cache_path,
        token.as_deref(),
    )
    .await?;

    // Update active profile by stable id (also persist to disk)
    let switched_profile = load_profile(&profile_id, &profiles_path).map_err(|e| e.to_string())?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = Some(switched_profile.id.clone());
    persist_active_profile(&s.config_path, &switched_profile.id);

    Ok(result)
}

/// Persist the active profile id to active_profile.txt, logging (not
/// silently swallowing) any write error. (Audit L-7)
pub(crate) fn persist_active_profile(config_path: &std::path::Path, profile_id: &str) {
    let path = config_path.join("active_profile.txt");
    if let Err(e) = std::fs::write(&path, profile_id) {
        log::error!(
            "Failed to persist active profile to {}: {}",
            path.display(),
            e
        );
    }
}

/// Bug 3: when a profile is deleted, clear the active-profile pointer iff it
/// names the deleted pack (case-insensitive — profile names collide
/// case-insensitively on Windows/macOS filesystems). Clears both the
/// in-memory `active_profile` and `active_profile.txt` (mirroring
/// `set_active_profile(None)`), so neither the UI nor the next app launch
/// keeps treating a now-deleted pack as active. Returns whether it matched.
///
/// Pulled out of `delete_profile_cmd` so the matching + file-clearing logic
/// is unit-testable without a live `tauri::State`.
fn clear_active_profile_if_deleted(
    active_profile: &mut Option<String>,
    config_path: &std::path::Path,
    deleted_name: &str,
    deleted_id: Option<&str>,
) -> bool {
    let was_active = active_profile.as_deref().is_some_and(|a| {
        a.eq_ignore_ascii_case(deleted_name)
            || deleted_id.is_some_and(|id| a.eq_ignore_ascii_case(id))
    });
    if was_active {
        *active_profile = None;
        let path = config_path.join("active_profile.txt");
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::error!(
                "Failed to clear active_profile.txt after deleting active profile '{}': {}",
                deleted_name,
                e
            ),
        }
    }
    was_active
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
    drift::compute_drift_for_profile(
        &name,
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
    )
}

/// Save the drift: reconcile the manifest to the current loadout by applying
/// only the diff (add enabled extras, drop missing mods, sync toggled/version
/// for mods still present). Unlike a full re-snapshot of the install, this preserves the
/// pack's curated set instead of pulling the whole install into it.
#[tauri::command]
pub fn save_profile_drift(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    drift::reconcile_profile_with_disk(
        &name,
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
    )
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

    let repaired_profile = load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = Some(repaired_profile.id.clone());
    persist_active_profile(&s.config_path, &repaired_profile.id);

    Ok(result)
}

#[cfg(test)]
mod duplicate_profile_tests {
    use super::*;

    fn sample_profile() -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: "Friend Pack".into(),
            game_version: None,
            created_by: Some("friend".into()),
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(true),
            mod_extras: Default::default(),
        }
    }

    #[test]
    fn duplicate_metadata_uses_current_owner_and_clears_listing_state() {
        let mut profile = sample_profile();

        stamp_duplicate_profile_metadata(&mut profile, Some("octo"));

        assert_eq!(profile.created_by.as_deref(), Some("octo"));
        assert_eq!(
            profile.public, None,
            "a local duplicate is not published or listed yet"
        );
    }

    #[test]
    fn duplicate_metadata_clears_original_owner_when_current_owner_unknown() {
        let mut profile = sample_profile();

        stamp_duplicate_profile_metadata(&mut profile, None);

        assert_eq!(
            profile.created_by, None,
            "duplicates must not keep showing the original curator as the author"
        );
    }
}

#[cfg(test)]
mod active_profile_clear_tests {
    //! Bug 3: deleting the active modpack must clear the active-profile
    //! pointer (in-memory + active_profile.txt) so the UI / next launch
    //! don't keep showing a deleted pack as active.
    use super::*;
    use tempfile::tempdir;

    fn write_active(config: &std::path::Path, name: &str) {
        std::fs::write(config.join("active_profile.txt"), name).unwrap();
    }

    #[test]
    fn clears_pointer_and_file_when_deleting_the_active_pack() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_active(config, "MyPack");
        let mut active = Some("MyPack".to_string());

        let was_active = clear_active_profile_if_deleted(&mut active, config, "MyPack", None);

        assert!(
            was_active,
            "deleting the active pack must report it was active"
        );
        assert_eq!(active, None, "in-memory active pointer must be cleared");
        assert!(
            !config.join("active_profile.txt").exists(),
            "active_profile.txt must be removed so the next launch has no active pack"
        );
    }

    #[test]
    fn matches_case_insensitively() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_active(config, "MyPack");
        let mut active = Some("MyPack".to_string());

        // The user deletes "mypack" (different case). On a case-insensitive
        // filesystem it's the same pack, so the pointer must still clear.
        let was_active = clear_active_profile_if_deleted(&mut active, config, "mypack", None);

        assert!(was_active);
        assert_eq!(active, None);
        assert!(!config.join("active_profile.txt").exists());
    }

    #[test]
    fn leaves_pointer_and_file_intact_for_a_different_pack() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_active(config, "MyPack");
        let mut active = Some("MyPack".to_string());

        let was_active = clear_active_profile_if_deleted(&mut active, config, "OtherPack", None);

        assert!(
            !was_active,
            "deleting a non-active pack must not report a match"
        );
        assert_eq!(
            active,
            Some("MyPack".to_string()),
            "active pointer untouched"
        );
        assert!(config.join("active_profile.txt").exists());
        assert_eq!(
            std::fs::read_to_string(config.join("active_profile.txt")).unwrap(),
            "MyPack"
        );
    }

    #[test]
    fn no_active_profile_is_a_noop() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        let mut active: Option<String> = None;

        let was_active = clear_active_profile_if_deleted(&mut active, config, "Whatever", None);

        assert!(!was_active);
        assert_eq!(active, None);
    }

    #[test]
    fn clears_pointer_when_active_is_stored_as_profile_id() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        let id = "profile-stable-id";
        write_active(config, id);
        let mut active = Some(id.to_string());

        let was_active =
            clear_active_profile_if_deleted(&mut active, config, "Renamed Pack", Some(id));

        assert!(was_active);
        assert_eq!(active, None);
        assert!(!config.join("active_profile.txt").exists());
    }
}
