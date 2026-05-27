//! Profile drift detection helpers + types.
//!
//! "Drift" is the gap between the saved manifest and the actual contents
//! of the active loadout. The Tauri commands that expose this surface
//! (`get_profile_drift`, `repair_profile`) live in `mod.rs` so the
//! `#[tauri::command]` proc-macro emits its companion `__cmd__*` items
//! in the path `crate::profiles::*` that `lib.rs` invokes against.
//!
//! - `compute_profile_drift` compares the manifest against `scan_mods`
//!   + `scan_disabled_mods` and returns added/removed/toggled/version
//!   diffs.
//! - `repair_profile_from_paths` re-applies the manifest and disables
//!   any active mods that aren't in the manifest, preserving the local
//!   library on disk (active extras move to `mods_disabled` rather than
//!   being deleted).
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::apply::{disk_mod_matches_pin, switch_profile_from_paths};
use super::crud::{load_profile, mod_key, version_is_wildcard};
use super::Profile;

/// A mod whose installed version differs from the profile's recorded version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionMismatch {
    /// Display name of the mod (whichever side has a usable name).
    pub name: String,
    /// Version recorded in the profile.
    pub profile_version: String,
    /// Version currently installed on disk.
    pub disk_version: String,
}

/// Describes the difference between installed mods and a saved profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileDrift {
    /// Mods installed on disk but NOT in the profile
    pub added: Vec<String>,
    /// Mods in the profile but NOT installed on disk
    pub removed: Vec<String>,
    /// Mods whose enabled/disabled state differs from the profile
    pub toggled: Vec<String>,
    /// Mods whose installed version differs from the profile version
    #[serde(default)]
    pub version_changed: Vec<VersionMismatch>,
    /// True when there is any difference at all
    pub has_drift: bool,
}

fn versions_match(profile_v: &str, disk_v: &str) -> bool {
    let pv = profile_v.trim_start_matches('v');
    let dv = disk_v.trim_start_matches('v');
    pv == dv || version_is_wildcard(pv) || version_is_wildcard(dv)
}

pub(super) fn compute_drift_for_profile(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
) -> std::result::Result<ProfileDrift, String> {
    let profile = load_profile(name, profiles_path).map_err(|e| e.to_string())?;
    Ok(compute_profile_drift(&profile, mods_path, disabled_path))
}

pub(super) fn compute_profile_drift(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
) -> ProfileDrift {
    // Build a map of profile mods: key -> (enabled, version, display_name)
    let mut profile_map: std::collections::HashMap<String, (bool, String, String)> =
        std::collections::HashMap::new();
    for pm in &profile.mods {
        let key = mod_key(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref());
        profile_map.insert(key, (pm.enabled, pm.version.clone(), pm.name.clone()));
    }

    // Build a map of installed mods: key -> (display_name, enabled, version)
    let enabled_mods = crate::mods::scan_mods(mods_path);
    let disabled_mods = crate::mods::scan_disabled_mods(disabled_path);

    let mut installed_map: std::collections::HashMap<String, (String, bool, String)> =
        std::collections::HashMap::new();
    for m in &enabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_map.insert(key, (m.name.clone(), true, m.version.clone()));
    }
    for m in &disabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_map.insert(key, (m.name.clone(), false, m.version.clone()));
    }

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut toggled = Vec::new();
    let mut version_changed = Vec::new();

    // Mods active in the loadout but not in profile. Disabled extras are
    // library items, not active profile drift.
    for m in &enabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        if !profile_map.contains_key(&key) {
            added.push(m.name.clone());
        }
    }

    // Mods in profile but not installed
    for pm in &profile.mods {
        let key = mod_key(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref());
        if !installed_map.contains_key(&key) {
            removed.push(pm.name.clone());
        }
    }

    // Mods whose enabled state OR version differs
    for (key, (profile_enabled, profile_version, profile_display)) in &profile_map {
        if let Some((disk_display, installed_enabled, disk_version)) = installed_map.get(key) {
            if profile_enabled != installed_enabled {
                toggled.push(disk_display.clone());
            }
            if !versions_match(profile_version, disk_version) {
                version_changed.push(VersionMismatch {
                    name: if disk_display.is_empty() {
                        profile_display.clone()
                    } else {
                        disk_display.clone()
                    },
                    profile_version: profile_version.clone(),
                    disk_version: disk_version.clone(),
                });
            }
        }
    }

    let has_drift = !added.is_empty()
        || !removed.is_empty()
        || !toggled.is_empty()
        || !version_changed.is_empty();

    ProfileDrift {
        added,
        removed,
        toggled,
        version_changed,
        has_drift,
    }
}

/// Repair a profile: re-apply the manifest and disable active orphan mods
/// that are not in the manifest. It intentionally does not delete orphan
/// mods. Like `switch_profile`, it separates the active loadout from the
/// local library: active extras move to mods_disabled, and disabled extras
/// stay there.
///
/// Returns the same shape as `switch_profile` plus the names of active
/// orphan mods that were moved out of the active loadout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairProfileResult {
    pub applied: bool,
    pub missing_mods: Vec<String>,
    pub downloaded: u32,
    pub failed_downloads: Vec<String>,
    #[serde(default)]
    pub disabled_orphans: Vec<String>,
    /// Deprecated compatibility field. Repair no longer deletes orphans.
    #[serde(default)]
    pub deleted_orphans: Vec<String>,
}

pub(super) async fn repair_profile_from_paths(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
    token: Option<&str>,
) -> std::result::Result<RepairProfileResult, String> {
    let profile = load_profile(name, profiles_path).map_err(|e| e.to_string())?;
    let pinned_set = crate::mod_sources::load_pinned_set(config_path);
    let mut profile_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    for pm in &profile.mods {
        profile_keys.insert(mod_key(
            &pm.name,
            pm.folder_name.as_deref(),
            pm.mod_id.as_deref(),
        ));
    }
    let disabled_orphans: Vec<String> = crate::mods::scan_mods(mods_path)
        .into_iter()
        .filter(|m| {
            !disk_mod_matches_pin(m, &pinned_set)
                && !profile_keys.contains(&mod_key(
                    &m.name,
                    m.folder_name.as_deref(),
                    m.mod_id.as_deref(),
                ))
        })
        .map(|m| m.name)
        .collect();

    // Phase 1: standard apply. This intentionally does not snapshot the
    // current disk state; Repair means "restore the saved manifest." The
    // apply path moves active extras to mods_disabled instead of deleting
    // them, preserving config files and the user's local library.
    let switch_result = switch_profile_from_paths(
        name,
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        cache_path,
        token,
    )
    .await?;

    Ok(RepairProfileResult {
        applied: switch_result.applied,
        missing_mods: switch_result.missing_mods,
        downloaded: switch_result.downloaded,
        failed_downloads: switch_result.failed_downloads,
        disabled_orphans,
        deleted_orphans: Vec::new(),
    })
}
