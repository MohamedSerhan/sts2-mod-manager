use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::{AppError, Result};
use crate::mod_versions::{
    LibraryVersionCleanupPreview, LocalModVersionAffectedProfile, LocalModVersionOption,
    LocalModVersionRemovalPreview,
};
use crate::mods::{ModInfo, ModInstallSource};
use crate::state::{AppState, AppStateInner};

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
    ApplyProfileResult, SwitchProfileResult,
};
pub(crate) use apply::{profile_mod_matches_pin, should_skip_pinned_profile_mod_download};
pub(crate) use crud::{
    collapse_equivalent_profile_mods, migrate_profile_identity_storage, profile_file_stem,
    profile_mod_artifact_id_matches, profile_mod_from_installed,
    profile_mod_matches_installed_with_registry, profile_mod_matches_installed_with_version_db,
    profile_name_exists, unique_profile_name,
};
pub use crud::{
    export_profile, import_profile, list_profiles, load_profile, persist_profile_mod_sources,
    save_profile,
};
pub use drift::{ProfileDrift, RepairProfileResult, SaveDriftResult, VersionMismatch};
pub use membership::SetProfileModsEnabledResult;

use apply::switch_profile_from_paths;
use crud::delete_profile;
use membership::{
    profile_membership_matrix, select_library_mod_version_from_paths,
    set_profile_load_order_from_paths, set_profile_mod_membership_from_paths,
    set_profile_mods_enabled_from_paths, sync_profile_load_order_to_settings,
};

pub(super) const APP_CREATED_BY: &str = "sts2-mod-manager";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManualModVersionRemovalMode {
    Remap,
    RemoveFromPacks,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManualModVersionProfileReplacement {
    pub profile_id: String,
    pub mod_version_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ManualModVersionRemovalResult {
    pub removed_mod_version_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remapped_profiles: Vec<LocalModVersionAffectedProfile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_profiles: Vec<LocalModVersionAffectedProfile>,
    pub switched_active: bool,
    pub deleted_disk: bool,
    pub deleted_cache: bool,
    pub removed_record: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryVersionCleanupRequestItem {
    pub mod_version_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_mod_version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct LibraryVersionCleanupItemResult {
    pub mod_version_id: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub switched_active: bool,
    pub remapped_profiles: usize,
    pub deleted_disk: bool,
    pub deleted_cache: bool,
    pub removed_record: bool,
}

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
    /// Member-mod runtime IDs when this entry is a bundle container.
    /// Legacy manifests without this field deserialize as an empty Vec.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_member_ids: Vec<String>,
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
    #[serde(default, skip_serializing_if = "ModInstallSource::is_local")]
    pub install_source: ModInstallSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_time_updated: Option<i64>,
    #[serde(default)]
    pub workshop_update_pending: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_members: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_member_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub installed: bool,
    #[serde(default)]
    pub cached: bool,
    pub installed_enabled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub version_options: Vec<LocalModVersionOption>,
    pub profiles: Vec<ProfileMembershipState>,
}

fn default_true() -> bool {
    true
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

fn reconcile_library_provider_exclusivity(
    state: &AppStateInner,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<()> {
    if crate::game::is_game_running() {
        return Ok(());
    }
    let moved = crate::mods::repair_active_runtime_id_duplicates(
        mods_path,
        disabled_path,
        &state.config_path,
        &state.profiles_path,
        state.active_profile.as_deref(),
    )?;
    if !moved.is_empty() {
        log::warn!(
            "Library provider reconciliation moved {} duplicate active artifact(s) to disabled storage: {}",
            moved.len(),
            moved.join(", ")
        );
    }
    Ok(())
}

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
    reconcile_library_provider_exclusivity(&s, mods_path, disabled_path)
        .map_err(|e| e.to_string())?;
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
pub fn get_library_version_options(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<HashMap<String, Vec<LocalModVersionOption>>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    reconcile_library_provider_exclusivity(&s, mods_path, disabled_path)
        .map_err(|e| e.to_string())?;
    let mut installed_mods =
        crate::mods::scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, &s.config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, &s.config_path);
    let profiles = list_profiles(&s.profiles_path);
    Ok(
        crate::mod_versions::local_version_options_by_mod_version_id(
            &installed_mods,
            &profiles,
            &s.config_path,
            &s.cache_path,
        ),
    )
}

fn scan_library_mods_with_versions(
    mods_path: &Path,
    disabled_path: &Path,
    config_path: &Path,
) -> Vec<crate::mods::ModInfo> {
    let mut installed_mods =
        crate::mods::scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, config_path);
    installed_mods
}

#[tauri::command]
pub fn preview_library_version_cleanup(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LibraryVersionCleanupPreview, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, &s.config_path);
    let profiles = list_profiles(&s.profiles_path);
    Ok(crate::mod_versions::preview_library_version_cleanup(
        &installed_mods,
        &profiles,
        &s.config_path,
        &s.cache_path,
    ))
}

#[tauri::command]
pub fn preview_library_mod_version_removal(
    mod_version_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LocalModVersionRemovalPreview, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, &s.config_path);
    let profiles = list_profiles(&s.profiles_path);
    crate::mod_versions::preview_local_mod_version_removal(
        &s.config_path,
        &s.cache_path,
        &installed_mods,
        &profiles,
        &mod_version_id,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_library_mod_version(
    mod_version_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    let mut installed_mods =
        crate::mods::scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, &s.config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, &s.config_path);
    let profiles = list_profiles(&s.profiles_path);
    crate::mod_versions::remove_local_mod_version(
        &s.config_path,
        &s.cache_path,
        disabled_path,
        &installed_mods,
        &profiles,
        &mod_version_id,
    )
    .map(|()| true)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn execute_library_version_cleanup(
    items: Vec<LibraryVersionCleanupRequestItem>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<LibraryVersionCleanupItemResult>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, &s.config_path);
    let profiles = list_profiles(&s.profiles_path);
    let requires_closed_game = items.iter().any(|item| {
        crate::mod_versions::preview_local_mod_version_removal(
            &s.config_path,
            &s.cache_path,
            &installed_mods,
            &profiles,
            &item.mod_version_id,
        )
        .map(|preview| preview.installed)
        .unwrap_or(true)
    });
    if requires_closed_game {
        crate::game::ensure_game_not_running()?;
    }
    execute_library_version_cleanup_from_paths(
        &items,
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn execute_library_version_cleanup_from_paths(
    items: &[LibraryVersionCleanupRequestItem],
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<Vec<LibraryVersionCleanupItemResult>> {
    if items.is_empty() {
        return Err(AppError::Other(
            "Choose at least one stored version to remove.".into(),
        ));
    }
    let mut selected_ids = HashSet::new();
    for item in items {
        let id = item.mod_version_id.trim();
        if id.is_empty() || !selected_ids.insert(id.to_string()) {
            return Err(AppError::Other(
                "The cleanup selection contains an empty or duplicate version. Refresh and try again."
                    .into(),
            ));
        }
    }

    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, config_path);
    let profiles = list_profiles(profiles_path);
    let cleanup_preview = crate::mod_versions::preview_library_version_cleanup(
        &installed_mods,
        &profiles,
        config_path,
        cache_path,
    );
    let candidates = cleanup_preview
        .families
        .into_iter()
        .flat_map(|family| family.candidates)
        .map(|candidate| (candidate.option.mod_version_id.clone(), candidate))
        .collect::<HashMap<_, _>>();

    let mut preflight = Vec::with_capacity(items.len());
    for item in items {
        let candidate = candidates.get(item.mod_version_id.trim()).ok_or_else(|| {
            AppError::Other(
                "The version cleanup preview is stale. Refresh the list before removing anything."
                    .into(),
            )
        })?;
        if candidate.option.pinned {
            return Err(AppError::Other(format!(
                "Unfreeze {} before removing one of its versions.",
                candidate.option.name
            )));
        }
        if candidate
            .reasons
            .contains(&crate::mod_versions::LibraryVersionCleanupReason::SteamManaged)
        {
            return Err(AppError::Other(format!(
                "{} is managed by Steam Workshop and cannot be removed here.",
                candidate.option.name
            )));
        }
        let replacement_id = item
            .replacement_mod_version_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if candidate.protected {
            let replacement_id = replacement_id.ok_or_else(|| {
                AppError::Other(format!(
                    "Choose a replacement before removing {} v{}.",
                    candidate.option.name, candidate.option.version
                ))
            })?;
            if selected_ids.contains(replacement_id) {
                return Err(AppError::Other(
                    "A selected replacement is also marked for removal. Keep that replacement or choose another version."
                        .into(),
                ));
            }
            if !candidate
                .replacement_candidates
                .iter()
                .any(|replacement| replacement.mod_version_id == replacement_id)
            {
                return Err(AppError::Other(
                    "A selected replacement is no longer available. Refresh and choose again."
                        .into(),
                ));
            }
        }
        let removal_preview = crate::mod_versions::preview_local_mod_version_removal(
            config_path,
            cache_path,
            &installed_mods,
            &profiles,
            &item.mod_version_id,
        )?;
        preflight.push((item.clone(), candidate.protected, removal_preview));
    }

    let mut results = Vec::with_capacity(preflight.len());
    for (item, protected, preview) in preflight {
        let replacement_id = item
            .replacement_mod_version_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let operation = if protected && (!preview.affected_profiles.is_empty() || preview.active) {
            let replacement_id = replacement_id.expect("protected cleanup was validated");
            let profile_replacements = preview
                .affected_profiles
                .iter()
                .map(|profile| ManualModVersionProfileReplacement {
                    profile_id: profile.profile_id.clone(),
                    mod_version_id: replacement_id.to_string(),
                })
                .collect::<Vec<_>>();
            remove_library_mod_version_manual_from_paths(
                &item.mod_version_id,
                ManualModVersionRemovalMode::Remap,
                &profile_replacements,
                preview.active.then_some(replacement_id),
                mods_path,
                disabled_path,
                profiles_path,
                config_path,
                cache_path,
            )
            .map(|result| LibraryVersionCleanupItemResult {
                mod_version_id: item.mod_version_id.clone(),
                success: true,
                switched_active: result.switched_active,
                remapped_profiles: result.remapped_profiles.len(),
                deleted_disk: result.deleted_disk,
                deleted_cache: result.deleted_cache,
                removed_record: result.removed_record,
                ..LibraryVersionCleanupItemResult::default()
            })
        } else {
            let installed_mods =
                scan_library_mods_with_versions(mods_path, disabled_path, config_path);
            let profiles = list_profiles(profiles_path);
            crate::mod_versions::remove_local_mod_version_with_policy(
                config_path,
                cache_path,
                Some(mods_path),
                disabled_path,
                &installed_mods,
                &profiles,
                &item.mod_version_id,
                false,
            )
            .map(|summary| LibraryVersionCleanupItemResult {
                mod_version_id: item.mod_version_id.clone(),
                success: true,
                deleted_disk: summary.deleted_disk,
                deleted_cache: summary.deleted_cache,
                removed_record: summary.removed_record,
                ..LibraryVersionCleanupItemResult::default()
            })
        };
        results.push(
            operation.unwrap_or_else(|error| LibraryVersionCleanupItemResult {
                mod_version_id: item.mod_version_id,
                error: Some(error.to_string()),
                ..LibraryVersionCleanupItemResult::default()
            }),
        );
    }
    Ok(results)
}

#[tauri::command]
pub fn remove_library_mod_version_manual(
    mod_version_id: String,
    mode: ManualModVersionRemovalMode,
    profile_replacements: Vec<ManualModVersionProfileReplacement>,
    active_replacement_mod_version_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ManualModVersionRemovalResult, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    remove_library_mod_version_manual_from_paths(
        &mod_version_id,
        mode,
        &profile_replacements,
        active_replacement_mod_version_id.as_deref(),
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn remove_library_mod_version_manual_from_paths(
    mod_version_id: &str,
    mode: ManualModVersionRemovalMode,
    profile_replacements: &[ManualModVersionProfileReplacement],
    active_replacement_mod_version_id: Option<&str>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<ManualModVersionRemovalResult> {
    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, config_path);
    let profiles = list_profiles(profiles_path);
    let preview = crate::mod_versions::preview_local_mod_version_removal(
        config_path,
        cache_path,
        &installed_mods,
        &profiles,
        mod_version_id,
    )?;
    if preview.pinned {
        return Err(AppError::Other(
            "Unfreeze this mod before removing one of its stored versions.".into(),
        ));
    }

    let target = preview.target.clone();
    let target_id = target.mod_version_id.clone();
    let mut result = ManualModVersionRemovalResult {
        removed_mod_version_id: target_id.clone(),
        mode: match mode {
            ManualModVersionRemovalMode::Remap => "remap",
            ManualModVersionRemovalMode::RemoveFromPacks => "remove_from_packs",
        }
        .into(),
        ..ManualModVersionRemovalResult::default()
    };

    match mode {
        ManualModVersionRemovalMode::Remap => {
            if preview.replacement_candidates.is_empty() {
                return Err(AppError::Other(
                    "No replacement version is available. Remove this mod from affected modpacks instead."
                        .into(),
                ));
            }
            validate_profile_replacements(&preview, profile_replacements)?;
            let active_replacement_id = if preview.active {
                let id = active_replacement_mod_version_id
                    .or_else(|| {
                        profile_replacements
                            .iter()
                            .find(|replacement| !replacement.mod_version_id.trim().is_empty())
                            .map(|replacement| replacement.mod_version_id.as_str())
                    })
                    .unwrap_or_else(|| preview.replacement_candidates[0].mod_version_id.as_str());
                removal_replacement_option(&preview, id)?;
                Some(id.to_string())
            } else {
                None
            };
            for affected in &preview.affected_profiles {
                let replacement_id = profile_replacements
                    .iter()
                    .find(|replacement| {
                        replacement.profile_id == affected.profile_id
                            || replacement.profile_id == affected.profile_name
                    })
                    .map(|replacement| replacement.mod_version_id.as_str())
                    .ok_or_else(|| {
                        AppError::Other(format!(
                            "Choose a replacement for \"{}\" before removing this version.",
                            affected.profile_name
                        ))
                    })?;
                let replacement = removal_replacement_option(&preview, replacement_id)?;
                remap_profile_mod_version_for_manual_removal(
                    affected,
                    &target_id,
                    &replacement.mod_version_id,
                    &installed_mods,
                    profiles_path,
                    config_path,
                    cache_path,
                )?;
                result.remapped_profiles.push(affected.clone());
            }

            if let Some(active_replacement_id) = active_replacement_id {
                let replacement = removal_replacement_option(&preview, &active_replacement_id)?;
                select_library_mod_version_from_paths(
                    &target.name,
                    Some(&target.mod_version_id),
                    target.folder_name.as_deref(),
                    target.mod_id.as_deref(),
                    target.install_source.into(),
                    target.workshop_item_id.as_deref(),
                    target.workshop_url.as_deref(),
                    &replacement.name,
                    Some(&replacement.mod_version_id),
                    replacement.folder_name.as_deref(),
                    replacement.mod_id.as_deref(),
                    replacement.install_source.into(),
                    replacement.workshop_item_id.as_deref(),
                    replacement.workshop_url.as_deref(),
                    mods_path,
                    disabled_path,
                    profiles_path,
                    config_path,
                    cache_path,
                )?;
                result.switched_active = true;
            }
        }
        ManualModVersionRemovalMode::RemoveFromPacks => {
            for affected in &preview.affected_profiles {
                remove_profile_mod_version_for_manual_removal(
                    affected,
                    &target_id,
                    profiles_path,
                    config_path,
                )?;
                result.removed_profiles.push(affected.clone());
            }
        }
    }

    let installed_mods = scan_library_mods_with_versions(mods_path, disabled_path, config_path);
    let profiles = list_profiles(profiles_path);
    let delete_summary = if crate::mod_versions::record_by_id(config_path, &target_id).is_some() {
        crate::mod_versions::remove_local_mod_version_with_policy(
            config_path,
            cache_path,
            Some(mods_path),
            disabled_path,
            &installed_mods,
            &profiles,
            &target_id,
            mode == ManualModVersionRemovalMode::RemoveFromPacks,
        )?
    } else {
        crate::mod_versions::LocalModVersionDeleteSummary {
            removed_record: true,
            deleted_cache: preview.cached,
            deleted_disk: preview.installed,
        }
    };
    result.deleted_disk = delete_summary.deleted_disk;
    result.deleted_cache = delete_summary.deleted_cache;
    result.removed_record = delete_summary.removed_record;
    Ok(result)
}

fn profile_mod_targets_version_record(
    pm: &ProfileMod,
    version_db: &crate::mod_versions::ModVersionsDb,
    target_id: &str,
) -> bool {
    crate::mod_versions::record_for_profile_mod_in_db(pm, version_db).is_some_and(|record| {
        crate::mod_versions::ids_equivalent_in_db(version_db, &record.id, target_id)
    })
}

fn installed_mod_targets_version_record(
    info: &ModInfo,
    version_db: &crate::mod_versions::ModVersionsDb,
    target_id: &str,
) -> bool {
    info.mod_version_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .is_some_and(|id| crate::mod_versions::ids_equivalent_in_db(version_db, id, target_id))
}

fn replacement_profile_mod_for_manual_removal(
    replacement_id: &str,
    installed_mods: &[ModInfo],
    version_db: &crate::mod_versions::ModVersionsDb,
    cache_path: &Path,
    config_path: &Path,
) -> Result<ProfileMod> {
    if let Some(installed) = installed_mods
        .iter()
        .find(|info| installed_mod_targets_version_record(info, version_db, replacement_id))
    {
        return Ok(profile_mod_from_installed(installed));
    }

    crate::mod_versions::profile_mod_from_record(replacement_id, cache_path, config_path)
}

fn save_manual_version_cleanup_profile(
    mut profile: Profile,
    version_db: &crate::mod_versions::ModVersionsDb,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    collapse_equivalent_profile_mods(&mut profile, version_db);
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    crate::subscriptions::sync_local_subscription_snapshot_after_profile_cleanup(
        config_path,
        &profile,
    )?;
    Ok(profile)
}

fn remap_profile_mod_version_for_manual_removal(
    affected: &LocalModVersionAffectedProfile,
    target_id: &str,
    replacement_id: &str,
    installed_mods: &[ModInfo],
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<Profile> {
    let version_db = crate::mod_versions::load(config_path);
    let mut profile = load_profile(&affected.profile_id, profiles_path)?;
    let replacement = replacement_profile_mod_for_manual_removal(
        replacement_id,
        installed_mods,
        &version_db,
        cache_path,
        config_path,
    )?;
    let mut changed = false;

    for entry in &mut profile.mods {
        if profile_mod_targets_version_record(entry, &version_db, target_id) {
            let enabled = entry.enabled;
            let mut next = replacement.clone();
            next.enabled = enabled;
            *entry = next;
            changed = true;
        }
    }

    if !changed {
        return Err(AppError::ModNotFound(format!(
            "Profile '{}' no longer contains the version being removed. Refresh the modpack and try again.",
            affected.profile_name
        )));
    }

    save_manual_version_cleanup_profile(profile, &version_db, profiles_path, config_path)
}

fn remove_profile_mod_version_for_manual_removal(
    affected: &LocalModVersionAffectedProfile,
    target_id: &str,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    let version_db = crate::mod_versions::load(config_path);
    let mut profile = load_profile(&affected.profile_id, profiles_path)?;
    let before = profile.mods.len();
    profile
        .mods
        .retain(|entry| !profile_mod_targets_version_record(entry, &version_db, target_id));

    if profile.mods.len() == before {
        return Err(AppError::ModNotFound(format!(
            "Profile '{}' no longer contains the version being removed. Refresh the modpack and try again.",
            affected.profile_name
        )));
    }

    save_manual_version_cleanup_profile(profile, &version_db, profiles_path, config_path)
}

fn validate_profile_replacements(
    preview: &LocalModVersionRemovalPreview,
    profile_replacements: &[ManualModVersionProfileReplacement],
) -> Result<()> {
    for affected in &preview.affected_profiles {
        let Some(replacement) = profile_replacements.iter().find(|replacement| {
            replacement.profile_id == affected.profile_id
                || replacement.profile_id == affected.profile_name
        }) else {
            return Err(AppError::Other(format!(
                "Choose a replacement for \"{}\" before removing this version.",
                affected.profile_name
            )));
        };
        if replacement.mod_version_id.trim().is_empty() {
            return Err(AppError::Other(format!(
                "Choose a replacement for \"{}\" before removing this version.",
                affected.profile_name
            )));
        }
    }
    for replacement in profile_replacements {
        if replacement.mod_version_id == preview.target.mod_version_id {
            return Err(AppError::Other(
                "Choose a replacement version other than the one being removed.".into(),
            ));
        }
        removal_replacement_option(preview, &replacement.mod_version_id)?;
    }
    Ok(())
}

fn removal_replacement_option<'a>(
    preview: &'a LocalModVersionRemovalPreview,
    mod_version_id: &str,
) -> Result<&'a LocalModVersionOption> {
    preview
        .replacement_candidates
        .iter()
        .find(|option| option.mod_version_id == mod_version_id)
        .ok_or_else(|| {
            AppError::Other(
                "That replacement version is no longer available. Refresh the mod list and try again."
                    .into(),
            )
        })
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
    current_install_source: Option<ModInstallSource>,
    current_workshop_item_id: Option<String>,
    current_workshop_url: Option<String>,
    selected_name: String,
    selected_mod_version_id: Option<String>,
    selected_folder_name: Option<String>,
    selected_mod_id: Option<String>,
    selected_install_source: Option<ModInstallSource>,
    selected_workshop_item_id: Option<String>,
    selected_workshop_url: Option<String>,
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
        current_install_source,
        current_workshop_item_id.as_deref(),
        current_workshop_url.as_deref(),
        &selected_name,
        selected_mod_version_id.as_deref(),
        selected_folder_name.as_deref(),
        selected_mod_id.as_deref(),
        selected_install_source,
        selected_workshop_item_id.as_deref(),
        selected_workshop_url.as_deref(),
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
    current_install_source: Option<ModInstallSource>,
    current_workshop_item_id: Option<String>,
    current_workshop_url: Option<String>,
    selected_name: String,
    selected_mod_version_id: Option<String>,
    selected_folder_name: Option<String>,
    selected_mod_id: Option<String>,
    selected_install_source: Option<ModInstallSource>,
    selected_workshop_item_id: Option<String>,
    selected_workshop_url: Option<String>,
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
        current_install_source,
        current_workshop_item_id.as_deref(),
        current_workshop_url.as_deref(),
        &selected_name,
        selected_mod_version_id.as_deref(),
        selected_folder_name.as_deref(),
        selected_mod_id.as_deref(),
        selected_install_source,
        selected_workshop_item_id.as_deref(),
        selected_workshop_url.as_deref(),
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
        &s.cache_path,
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
) -> std::result::Result<SaveDriftResult, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    drift::reconcile_profile_with_disk(
        &name,
        mods_path,
        disabled_path,
        &s.profiles_path,
        &s.config_path,
        &s.cache_path,
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

#[cfg(test)]
mod manual_version_removal_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_mod(root: &Path, folder: &str, id: &str, display: &str, version: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{folder}.json")),
            format!(r#"{{"id":"{id}","name":"{display}","version":"{version}","author":"QA"}}"#),
        )
        .unwrap();
        fs::write(dir.join(format!("{folder}.dll")), b"dll").unwrap();
    }

    fn profile(name: &str, mods: Vec<ProfileMod>) -> Profile {
        Profile {
            id: name.into(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn save_followed_subscription(config_path: &Path, profile: &Profile) {
        let now = chrono::Utc::now();
        crate::subscriptions::save_subscriptions(
            &crate::subscriptions::SubscriptionsDb {
                subscriptions: std::collections::HashMap::from([(
                    format!("curator:{}", profile.id),
                    crate::subscriptions::Subscription {
                        share_id: format!("curator:{}", profile.id),
                        share_url: "https://example.test/share".into(),
                        profile_name: profile.name.clone(),
                        profile_id: profile.id.clone(),
                        curator: Some("curator".into()),
                        last_synced_profile: profile.clone(),
                        last_checked: now,
                        last_synced: now,
                    },
                )]),
            },
            config_path,
        )
        .unwrap();
    }

    fn only_subscription(config_path: &Path) -> crate::subscriptions::Subscription {
        crate::subscriptions::load_subscriptions(config_path)
            .subscriptions
            .values()
            .next()
            .cloned()
            .expect("test should have one subscription")
    }

    fn cache_single_mod(
        config_path: &Path,
        cache_path: &Path,
        folder: &str,
        version: &str,
    ) -> (String, tempfile::TempDir) {
        let source = tempdir().unwrap();
        write_mod(source.path(), folder, "Watcher", "Watcher", version);
        let mut scanned = crate::mods::scan_mods(source.path())
            .into_iter()
            .next()
            .expect("cached test mod should scan");
        crate::mod_versions::cache_mod_version_by_id(
            &mut scanned,
            source.path(),
            cache_path,
            config_path,
        )
        .expect("cached archive should be written");
        (
            scanned
                .mod_version_id
                .clone()
                .expect("cached mod should have a version id"),
            source,
        )
    }

    #[test]
    fn preview_lists_attached_modpacks_and_replacements() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        write_mod(&mods_path, "Watcher", "Watcher", "Watcher", "1.4.3");
        let installed = scan_library_mods_with_versions(&mods_path, &disabled_path, config.path());
        let target = installed[0].clone();
        let target_id = target.mod_version_id.clone().unwrap();
        let (replacement_id, _source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "1.5.0");
        save_profile(
            &profile("Stable", vec![profile_mod_from_installed(&target)]),
            &profiles_path,
        )
        .unwrap();

        let profiles = list_profiles(&profiles_path);
        let preview = crate::mod_versions::preview_local_mod_version_removal(
            config.path(),
            cache.path(),
            &installed,
            &profiles,
            &target_id,
        )
        .unwrap();

        assert!(preview.active);
        assert_eq!(preview.affected_profiles[0].profile_name, "Stable");
        assert!(preview
            .replacement_candidates
            .iter()
            .any(|option| option.mod_version_id == replacement_id));
    }

    #[test]
    fn bulk_cleanup_removes_only_recommended_cached_version() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (old_id, _old_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.0.0");
        let (latest_id, _latest_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "2.0.0");

        let results = execute_library_version_cleanup_from_paths(
            &[LibraryVersionCleanupRequestItem {
                mod_version_id: old_id.clone(),
                replacement_mod_version_id: None,
            }],
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].success);
        assert!(results[0].deleted_cache);
        assert!(crate::mod_versions::record_by_id(config.path(), &old_id).is_none());
        assert!(crate::mod_versions::record_by_id(config.path(), &latest_id).is_some());
    }

    #[test]
    fn bulk_cleanup_requires_replacement_before_touching_profile_used_version() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (old_id, old_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.0.0");
        let (_latest_id, _latest_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "2.0.0");
        let mut old = crate::mods::scan_mods(old_source.path()).remove(0);
        old.mod_version_id = Some(old_id.clone());
        save_profile(
            &profile("Legacy", vec![profile_mod_from_installed(&old)]),
            &profiles_path,
        )
        .unwrap();

        let error = execute_library_version_cleanup_from_paths(
            &[LibraryVersionCleanupRequestItem {
                mod_version_id: old_id.clone(),
                replacement_mod_version_id: None,
            }],
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("Choose a replacement"));
        assert!(crate::mod_versions::record_by_id(config.path(), &old_id).is_some());
        assert_eq!(
            load_profile("Legacy", &profiles_path).unwrap().mods[0]
                .mod_version_id
                .as_deref(),
            Some(old_id.as_str())
        );
    }

    #[test]
    fn bulk_cleanup_remaps_profile_used_version_to_explicit_replacement() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (old_id, old_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.0.0");
        let (latest_id, _latest_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "2.0.0");
        let mut old = crate::mods::scan_mods(old_source.path()).remove(0);
        old.mod_version_id = Some(old_id.clone());
        save_profile(
            &profile("Legacy", vec![profile_mod_from_installed(&old)]),
            &profiles_path,
        )
        .unwrap();

        let results = execute_library_version_cleanup_from_paths(
            &[LibraryVersionCleanupRequestItem {
                mod_version_id: old_id.clone(),
                replacement_mod_version_id: Some(latest_id.clone()),
            }],
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        assert!(results[0].success);
        assert_eq!(results[0].remapped_profiles, 1);
        assert_eq!(
            load_profile("Legacy", &profiles_path).unwrap().mods[0]
                .mod_version_id
                .as_deref(),
            Some(latest_id.as_str())
        );
        assert!(crate::mod_versions::record_by_id(config.path(), &old_id).is_none());
    }

    #[test]
    fn manual_remap_updates_profile_and_switches_active_disk_copy() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        write_mod(&mods_path, "Watcher", "Watcher", "Watcher", "1.4.3");
        let installed = scan_library_mods_with_versions(&mods_path, &disabled_path, config.path());
        let target = installed[0].clone();
        let target_id = target.mod_version_id.clone().unwrap();
        let (replacement_id, _source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "1.5.0");
        save_profile(
            &profile("Stable", vec![profile_mod_from_installed(&target)]),
            &profiles_path,
        )
        .unwrap();

        let result = remove_library_mod_version_manual_from_paths(
            &target_id,
            ManualModVersionRemovalMode::Remap,
            &[ManualModVersionProfileReplacement {
                profile_id: "Stable".into(),
                mod_version_id: replacement_id.clone(),
            }],
            Some(&replacement_id),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        let updated = load_profile("Stable", &profiles_path).unwrap();
        assert_eq!(
            updated.mods[0].mod_version_id.as_deref(),
            Some(replacement_id.as_str())
        );
        assert!(result.switched_active);
        assert!(mods_path.join("Watcher-new").is_dir());
        assert!(!mods_path.join("Watcher").exists());
        assert!(crate::mod_versions::record_by_id(config.path(), &target_id).is_none());
    }

    #[test]
    fn manual_remove_from_packs_deletes_profile_entries_and_cached_record() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (target_id, _source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.3.0");
        let profile_mod =
            crate::mod_versions::profile_mod_from_record(&target_id, cache.path(), config.path())
                .unwrap();
        save_profile(&profile("Legacy", vec![profile_mod]), &profiles_path).unwrap();

        let result = remove_library_mod_version_manual_from_paths(
            &target_id,
            ManualModVersionRemovalMode::RemoveFromPacks,
            &[],
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        let updated = load_profile("Legacy", &profiles_path).unwrap();
        assert!(updated.mods.is_empty());
        assert_eq!(result.removed_profiles[0].profile_name, "Legacy");
        assert!(result.deleted_cache);
        assert!(crate::mod_versions::record_by_id(config.path(), &target_id).is_none());
        assert!(!crate::mod_versions::cache_path_for_id(cache.path(), &target_id).exists());
    }

    #[test]
    fn manual_remap_updates_subscribed_profile_and_snapshot() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (target_id, _target_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.3.0");
        let (replacement_id, _replacement_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-new", "1.5.0");
        let profile_mod =
            crate::mod_versions::profile_mod_from_record(&target_id, cache.path(), config.path())
                .unwrap();
        let followed = profile("SharedTester", vec![profile_mod]);
        save_profile(&followed, &profiles_path).unwrap();
        save_followed_subscription(config.path(), &followed);
        let before_synced = only_subscription(config.path()).last_synced;

        let result = remove_library_mod_version_manual_from_paths(
            &target_id,
            ManualModVersionRemovalMode::Remap,
            &[ManualModVersionProfileReplacement {
                profile_id: followed.id.clone(),
                mod_version_id: replacement_id.clone(),
            }],
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        let updated = load_profile(&followed.id, &profiles_path).unwrap();
        assert_eq!(updated.mods.len(), 1);
        assert_eq!(
            updated.mods[0].mod_version_id.as_deref(),
            Some(replacement_id.as_str())
        );
        let subscription = only_subscription(config.path());
        assert_eq!(subscription.last_synced, before_synced);
        assert_eq!(
            subscription.last_synced_profile.mods[0]
                .mod_version_id
                .as_deref(),
            Some(replacement_id.as_str())
        );
        assert_eq!(result.remapped_profiles[0].profile_name, "SharedTester");
        assert!(crate::mod_versions::record_by_id(config.path(), &target_id).is_none());
    }

    #[test]
    fn manual_remove_from_packs_updates_subscribed_profile_snapshot_and_keeps_other_version() {
        let game = tempdir().unwrap();
        let config = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let mods_path = game.path().join("mods");
        let disabled_path = game.path().join("mods_disabled");
        let profiles_path = config.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        let (target_id, _target_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-old", "1.3.0");
        let (other_id, _other_source) =
            cache_single_mod(config.path(), cache.path(), "Watcher-other", "1.2.0");
        let target_mod =
            crate::mod_versions::profile_mod_from_record(&target_id, cache.path(), config.path())
                .unwrap();
        let other_mod =
            crate::mod_versions::profile_mod_from_record(&other_id, cache.path(), config.path())
                .unwrap();
        let followed = profile("SharedTester", vec![target_mod, other_mod]);
        save_profile(&followed, &profiles_path).unwrap();
        save_followed_subscription(config.path(), &followed);
        let before_synced = only_subscription(config.path()).last_synced;

        let result = remove_library_mod_version_manual_from_paths(
            &target_id,
            ManualModVersionRemovalMode::RemoveFromPacks,
            &[],
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config.path(),
            cache.path(),
        )
        .unwrap();

        let updated = load_profile(&followed.id, &profiles_path).unwrap();
        assert_eq!(updated.mods.len(), 1);
        assert_eq!(
            updated.mods[0].mod_version_id.as_deref(),
            Some(other_id.as_str())
        );
        let subscription = only_subscription(config.path());
        assert_eq!(subscription.last_synced, before_synced);
        assert_eq!(subscription.last_synced_profile.mods.len(), 1);
        assert_eq!(
            subscription.last_synced_profile.mods[0]
                .mod_version_id
                .as_deref(),
            Some(other_id.as_str())
        );
        assert_eq!(result.removed_profiles[0].profile_name, "SharedTester");
        assert!(crate::mod_versions::record_by_id(config.path(), &target_id).is_none());
        assert!(crate::mod_versions::record_by_id(config.path(), &other_id).is_some());
    }
}
