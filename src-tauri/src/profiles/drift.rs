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
use super::crud::{
    hide_app_created_by, load_profile, mod_key, profile_is_edit_locked, profile_mod_from_installed,
    profile_mod_matches_installed, profile_mod_matches_installed_with_version_db, save_profile,
    version_is_wildcard,
};
use super::{Profile, ProfileMod};
use crate::error::{AppError, Result};
use crate::mods::ModInfo;

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

/// Return value of `reconcile_profile_with_disk` and the `save_profile_drift`
/// Tauri command. Contains the saved profile and any residual drift that
/// could not be reconciled — normally empty, but non-None surfaces a
/// diagnostic instead of a silent success toast.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDriftResult {
    pub profile: super::Profile,
    /// Non-null only when recomputing production drift after save still
    /// detected differences (e.g. a Workshop item that Steam controls).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub residual_drift: Option<ProfileDrift>,
}

fn versions_match(profile_v: &str, disk_v: &str) -> bool {
    let pv = profile_v.trim_start_matches('v');
    let dv = disk_v.trim_start_matches('v');
    pv == dv || version_is_wildcard(pv) || version_is_wildcard(dv)
}

/// Whether the on-disk content matches the manifest's recorded content, so a
/// version-STRING difference with identical content isn't reported as drift.
/// Both hashes must be present and equal; a missing hash means "unknown
/// content", keeping the conservative version-only behaviour. (FB2-B: a pure
/// version-label difference can't be repaired, so flagging it left the drift
/// banner stuck forever even after a successful Repair. Aligns drift with the
/// content check the switch/repair path already uses.)
fn contents_match(profile_hash: Option<&str>, disk_hash: Option<&str>) -> bool {
    match (profile_hash, disk_hash) {
        (Some(p), Some(d)) => !p.is_empty() && p.eq_ignore_ascii_case(d),
        _ => false,
    }
}

/// The fully-enriched loadout scan shared by drift detection and Save
/// reconciliation. Both paths must use the same scan and the same
/// identity-matching logic so the idempotency invariant holds:
/// after a successful Save, recomputed drift is false and a second
/// Save writes nothing.
struct EffectiveLoadoutSnapshot {
    all_mods: Vec<crate::mods::ModInfo>,
    enabled_count: usize,
    version_db: crate::mod_versions::ModVersionsDb,
}

impl EffectiveLoadoutSnapshot {
    fn build(mods_path: &Path, disabled_path: &Path, config_path: &Path) -> Self {
        let mut all_mods = crate::mods::scan_mods(mods_path);
        all_mods.extend(crate::mods::scan_workshop_mods_for_mods_path(mods_path));
        let enabled_count = all_mods.len();
        all_mods.extend(crate::mods::scan_disabled_mods(disabled_path));
        crate::mod_sources::enrich_mods_with_sources(&mut all_mods, config_path);
        crate::mod_versions::enrich_mods_with_versions(&mut all_mods, config_path);
        let version_db = crate::mod_versions::load(config_path);
        EffectiveLoadoutSnapshot {
            all_mods,
            enabled_count,
            version_db,
        }
    }

    fn enabled_mods(&self) -> &[crate::mods::ModInfo] {
        &self.all_mods[..self.enabled_count]
    }

    fn disabled_mods(&self) -> &[crate::mods::ModInfo] {
        &self.all_mods[self.enabled_count..]
    }
}

pub(super) fn compute_drift_for_profile(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> std::result::Result<ProfileDrift, String> {
    let profile = load_profile(name, profiles_path).map_err(|e| e.to_string())?;
    Ok(compute_profile_drift_with_registry(
        &profile,
        mods_path,
        disabled_path,
        config_path,
        Some(cache_path),
    ))
}

#[cfg(test)]
pub(super) fn compute_profile_drift(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
) -> ProfileDrift {
    let enabled_mods = crate::mods::scan_mods(mods_path);
    let disabled_mods = crate::mods::scan_disabled_mods(disabled_path);

    compute_profile_drift_from_mods(profile, &enabled_mods, &disabled_mods, None, None)
}

fn compute_profile_drift_with_registry(
    profile: &super::Profile,
    mods_path: &Path,
    disabled_path: &Path,
    config_path: &Path,
    cache_path: Option<&Path>,
) -> ProfileDrift {
    let snapshot = EffectiveLoadoutSnapshot::build(mods_path, disabled_path, config_path);
    compute_profile_drift_from_mods(
        profile,
        snapshot.enabled_mods(),
        snapshot.disabled_mods(),
        Some(&snapshot.version_db),
        cache_path,
    )
}

fn profile_mod_matches_disk(
    pm: &ProfileMod,
    disk_mod: &ModInfo,
    version_db: Option<&crate::mod_versions::ModVersionsDb>,
) -> bool {
    if let Some(version_db) = version_db {
        profile_mod_matches_installed_with_version_db(pm, disk_mod, version_db)
    } else {
        profile_mod_matches_installed(pm, disk_mod)
    }
}

fn find_disk_mod_for_profile<'a>(
    pm: &ProfileMod,
    enabled_mods: &'a [ModInfo],
    disabled_mods: &'a [ModInfo],
    version_db: Option<&crate::mod_versions::ModVersionsDb>,
) -> Option<(&'a ModInfo, bool)> {
    enabled_mods
        .iter()
        .find(|disk_mod| profile_mod_matches_disk(pm, disk_mod, version_db))
        .map(|disk_mod| (disk_mod, true))
        .or_else(|| {
            disabled_mods
                .iter()
                .find(|disk_mod| profile_mod_matches_disk(pm, disk_mod, version_db))
                .map(|disk_mod| (disk_mod, false))
        })
}

fn profile_mod_has_cached_record(
    pm: &ProfileMod,
    version_db: Option<&crate::mod_versions::ModVersionsDb>,
    cache_path: Option<&Path>,
) -> bool {
    let (Some(version_db), Some(cache_path)) = (version_db, cache_path) else {
        return false;
    };
    crate::mod_versions::record_for_profile_mod_in_db(pm, version_db)
        .and_then(|record| crate::mod_versions::cached_record_path(cache_path, &record))
        .is_some()
}

fn find_family_disk_mod_for_profile<'a>(
    pm: &ProfileMod,
    enabled_mods: &'a [ModInfo],
    disabled_mods: &'a [ModInfo],
) -> Option<(&'a ModInfo, bool)> {
    enabled_mods
        .iter()
        .find(|disk_mod| profile_mod_matches_installed(pm, disk_mod))
        .map(|disk_mod| (disk_mod, true))
        .or_else(|| {
            disabled_mods
                .iter()
                .find(|disk_mod| profile_mod_matches_installed(pm, disk_mod))
                .map(|disk_mod| (disk_mod, false))
        })
}

fn compute_profile_drift_from_mods(
    profile: &Profile,
    enabled_mods: &[ModInfo],
    disabled_mods: &[ModInfo],
    version_db: Option<&crate::mod_versions::ModVersionsDb>,
    cache_path: Option<&Path>,
) -> ProfileDrift {
    let profile_contains_disk_mod = |disk_mod: &ModInfo| {
        profile.mods.iter().any(|pm| {
            profile_mod_matches_disk(pm, disk_mod, version_db)
                || (profile_mod_has_cached_record(pm, version_db, cache_path)
                    && profile_mod_matches_installed(pm, disk_mod))
        })
    };

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut toggled = Vec::new();
    let mut version_changed = Vec::new();

    // Mods active in the loadout but not in profile. Disabled extras are
    // library items, not active profile drift.
    for m in enabled_mods {
        if !profile_contains_disk_mod(m) {
            added.push(m.name.clone());
        }
    }

    // Mods whose enabled state OR version differs
    for pm in &profile.mods {
        let Some((disk_mod, installed_enabled)) =
            find_disk_mod_for_profile(pm, enabled_mods, disabled_mods, version_db)
        else {
            if profile_mod_has_cached_record(pm, version_db, cache_path) {
                if let Some((disk_mod, installed_enabled)) =
                    find_family_disk_mod_for_profile(pm, enabled_mods, disabled_mods)
                {
                    if pm.enabled != installed_enabled {
                        toggled.push(disk_mod.name.clone());
                    }
                    if !versions_match(&pm.version, &disk_mod.version)
                        && !contents_match(pm.hash.as_deref(), disk_mod.hash.as_deref())
                    {
                        version_changed.push(VersionMismatch {
                            name: if disk_mod.name.is_empty() {
                                pm.name.clone()
                            } else {
                                disk_mod.name.clone()
                            },
                            profile_version: pm.version.clone(),
                            disk_version: disk_mod.version.clone(),
                        });
                    }
                    continue;
                }
            }
            removed.push(pm.name.clone());
            continue;
        };

        if pm.enabled != installed_enabled {
            toggled.push(disk_mod.name.clone());
        }
        if !versions_match(&pm.version, &disk_mod.version)
            && !contents_match(pm.hash.as_deref(), disk_mod.hash.as_deref())
        {
            version_changed.push(VersionMismatch {
                name: if disk_mod.name.is_empty() {
                    pm.name.clone()
                } else {
                    disk_mod.name.clone()
                },
                profile_version: pm.version.clone(),
                disk_version: disk_mod.version.clone(),
            });
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

/// Reconcile a profile's manifest with the current active loadout by
/// applying ONLY the drift difference — the inverse of `repair`.
///
/// Uses the same `EffectiveLoadoutSnapshot` and strong-identity matching
/// (`profile_mod_matches_disk` → version DB) as `compute_profile_drift_with_registry`
/// so the idempotency invariant is structurally guaranteed: after a
/// successful Save, recomputed production drift is false and a second
/// Save writes nothing.
///
/// Steam Workshop members are included in the enabled-mods scan so they
/// are never spuriously re-added or dropped on every Save.
///
/// Post-save, a fresh drift computation is run against the saved manifest.
/// Any residual drift is returned in `SaveDriftResult.residual_drift` rather
/// than silently claiming success; in the normal path this field is None.
pub(super) fn reconcile_profile_with_disk(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<SaveDriftResult> {
    if profile_is_edit_locked(name, profiles_path, config_path) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            name
        )));
    }

    let mut profile = load_profile(name, profiles_path)?;
    let snapshot = EffectiveLoadoutSnapshot::build(mods_path, disabled_path, config_path);
    let enabled_count = snapshot.enabled_mods().len();
    let mut claimed = vec![false; enabled_count];
    let mut reconciled: Vec<ProfileMod> = Vec::new();

    // Phase 1: Keep pack mods that exist on disk (sync enabled state +
    // version); drop pack entries with no on-disk counterpart.
    for pm in &profile.mods {
        // Search enabled side first.
        let enabled_match = snapshot
            .enabled_mods()
            .iter()
            .enumerate()
            .find(|(_, disk_mod)| {
                profile_mod_matches_disk(pm, disk_mod, Some(&snapshot.version_db))
            });

        if let Some((idx, disk_mod)) = enabled_match {
            claimed[idx] = true;
            let mut updated = pm.clone();
            updated.enabled = true;
            if !version_is_wildcard(&disk_mod.version) {
                updated.version = disk_mod.version.clone();
            }
            reconciled.push(updated);
            continue;
        }

        // Fall through to disabled folder.
        if let Some(disk_mod) = snapshot
            .disabled_mods()
            .iter()
            .find(|dm| profile_mod_matches_disk(pm, dm, Some(&snapshot.version_db)))
        {
            let mut updated = pm.clone();
            updated.enabled = false;
            if !version_is_wildcard(&disk_mod.version) {
                updated.version = disk_mod.version.clone();
            }
            reconciled.push(updated);
            continue;
        }
        // Not found on disk at all → drop from pack (mirrors `removed` drift).
    }

    // Phase 2: Append enabled-on-disk mods not already in the pack
    // (mirrors the `added` drift category). Disabled extras are library
    // items, intentionally skipped.
    for (idx, disk_mod) in snapshot.enabled_mods().iter().enumerate() {
        if claimed[idx] {
            continue;
        }
        let mut info = disk_mod.clone();
        info.enabled = true;
        reconciled.push(profile_mod_from_installed(&info));
    }

    let manifest_changed =
        serde_json::to_value(&profile.mods)? != serde_json::to_value(&reconciled)?;
    if manifest_changed {
        profile.mods = reconciled;
        profile.updated_at = chrono::Utc::now();
        save_profile(&profile, profiles_path)?;
    }
    let saved_profile = hide_app_created_by(profile);

    // Post-save invariant check: recompute production drift on the saved
    // manifest. In the normal path this returns has_drift=false. Any
    // residual is returned as a diagnostic rather than silently claiming
    // success.
    let post_drift = compute_profile_drift_with_registry(
        &saved_profile,
        mods_path,
        disabled_path,
        config_path,
        Some(cache_path),
    );
    let residual_drift = if post_drift.has_drift {
        Some(post_drift)
    } else {
        None
    };

    Ok(SaveDriftResult {
        profile: saved_profile,
        residual_drift,
    })
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
    /// Mods whose mismatched on-disk copy was replaced with the profile's
    /// version (passed through from the switch step). (Bug 4.)
    #[serde(default)]
    pub replaced_mods: Vec<String>,
    /// Mods whose replace failed; the old on-disk version was rolled back and
    /// kept. (Bug 4.)
    #[serde(default)]
    pub replace_failures: Vec<String>,
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
    let mut profile = load_profile(name, profiles_path).map_err(|e| e.to_string())?;
    let version_db = crate::mod_versions::load(config_path);
    let removed_duplicates =
        crate::profiles::collapse_equivalent_profile_mods(&mut profile, &version_db);
    if removed_duplicates > 0 {
        log::info!(
            "Collapsed {} duplicate mod entry(s) before repairing profile '{}'",
            removed_duplicates,
            profile.name
        );
        if let Err(e) = save_profile(&profile, profiles_path) {
            log::warn!(
                "Could not persist duplicate cleanup for profile '{}': {}",
                profile.name,
                e
            );
        }
    }
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
        replaced_mods: switch_result.replaced_mods,
        replace_failures: switch_result.replace_failures,
    })
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;
    use crate::profiles::crud::save_profile;
    use std::fs;
    use std::path::Path;

    fn write_mod(root: &Path, folder: &str, display: &str, version: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{folder}.json")),
            format!(
                r#"{{"id":"{folder}","name":"{display}","version":"{version}","author":"QA"}}"#
            ),
        )
        .unwrap();
        fs::write(dir.join(format!("{folder}.dll")), b"dll").unwrap();
    }

    fn pack_mod(name: &str, folder: &str, version: &str, enabled: bool) -> ProfileMod {
        ProfileMod {
            mod_version_id: None,
            name: name.into(),
            version: version.into(),
            source: Some(format!("github:example/{folder}")),
            hash: Some(format!("hash-{folder}")),
            files: vec![format!("{folder}/{folder}.dll")],
            folder_name: Some(folder.into()),
            mod_id: Some(folder.into()),
            enabled,
            bundle_url: Some(format!("https://example.test/{folder}.zip")),
            bundle_sha256: Some(format!("sha-{folder}")),
            bundle_members: vec![],
            bundle_member_ids: vec![],
        }
    }

    fn base_profile(name: &str, mods: Vec<ProfileMod>) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: Some("0.105.0".into()),
            created_by: None,
            mods,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    #[test]
    fn version_label_difference_with_matching_content_is_not_drift() {
        // FB2-B: a version-STRING diff where the on-disk content matches the
        // manifest hash isn't actionable drift (Repair can't change a label),
        // so it must NOT show as version-changed — otherwise the banner stays
        // stuck even after a successful Repair.
        let game = tempfile::tempdir().unwrap();
        let mods = game.path().join("mods");
        let disabled = game.path().join("mods_disabled");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();

        write_mod(&mods, "Foo", "Foo", "2.0.0");
        let disk_hash = crate::mods::scan_mods(&mods)[0].hash.clone();
        assert!(disk_hash.is_some(), "scan must produce a content hash");

        // Manifest records v1.0.0 but the SAME content hash → label-only diff.
        let mut pm = pack_mod("Foo", "Foo", "1.0.0", true);
        pm.hash = disk_hash;
        let profile = base_profile("Pack", vec![pm]);

        let drift = compute_profile_drift(&profile, &mods, &disabled);
        assert!(
            drift.version_changed.is_empty(),
            "matching content must not be version drift; got {:?}",
            drift.version_changed
        );
        assert!(!drift.has_drift, "no other drift expected");
    }

    #[test]
    fn version_difference_with_different_content_is_drift() {
        let game = tempfile::tempdir().unwrap();
        let mods = game.path().join("mods");
        let disabled = game.path().join("mods_disabled");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();

        write_mod(&mods, "Foo", "Foo", "2.0.0");
        // Different version AND a different hash → genuine drift.
        let mut pm = pack_mod("Foo", "Foo", "1.0.0", true);
        pm.hash = Some("a-different-content-hash".into());
        let profile = base_profile("Pack", vec![pm]);

        let drift = compute_profile_drift(&profile, &mods, &disabled);
        assert_eq!(
            drift.version_changed.len(),
            1,
            "different content + version is real drift"
        );
    }

    #[test]
    fn cached_profile_artifact_with_newer_disk_sibling_is_version_drift_not_missing() {
        let game = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mods = game.path().join("mods");
        let disabled = game.path().join("mods_disabled");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();

        write_mod(&mods, "BaseLib", "BaseLib", "3.2.1");
        let mut old_info = crate::mods::scan_mods(&mods)
            .into_iter()
            .find(|info| info.folder_name.as_deref() == Some("BaseLib"))
            .unwrap();
        let old_id = crate::mod_versions::ensure_mod_info_id(&mut old_info, config.path())
            .expect("old version should get an artifact id");
        crate::mod_versions::cache_mod_version_by_id(
            &mut old_info,
            &mods,
            cache.path(),
            config.path(),
        )
        .expect("old version should be cached");
        let alias_id = "legacy-regent-source-version-id".to_string();
        fs::rename(
            crate::mod_versions::cache_path_for_id(cache.path(), &old_id),
            crate::mod_versions::cache_path_for_id(cache.path(), &alias_id),
        )
        .unwrap();
        let mut version_db = crate::mod_versions::load(config.path());
        version_db
            .records
            .get_mut(&old_id)
            .unwrap()
            .aliases
            .push(alias_id.clone());
        version_db.aliases.insert(alias_id, old_id.clone());
        crate::mod_versions::save(&version_db, config.path()).unwrap();
        fs::remove_dir_all(mods.join("BaseLib")).unwrap();
        write_mod(&mods, "BaseLib", "BaseLib", "3.3.1");
        fs::write(mods.join("BaseLib").join("BaseLib.dll"), b"new-dll").unwrap();

        let mut pm = pack_mod("BaseLib", "BaseLib", "3.2.1", true);
        pm.mod_version_id = Some(old_id);
        pm.hash = old_info.hash.clone();
        let profile = base_profile("TesterW", vec![pm]);

        let drift = compute_profile_drift_with_registry(
            &profile,
            &mods,
            &disabled,
            config.path(),
            Some(cache.path()),
        );

        assert!(
            drift.added.is_empty(),
            "new sibling must not look like an extra: {drift:?}"
        );
        assert!(
            drift.removed.is_empty(),
            "cached pinned profile version must not look missing: {drift:?}"
        );
        assert_eq!(drift.version_changed.len(), 1);
        assert_eq!(drift.version_changed[0].profile_version, "3.2.1");
        assert_eq!(drift.version_changed[0].disk_version, "3.3.1");
    }

    #[test]
    fn registry_drift_matches_added_library_mod_by_artifact_id_when_identity_fields_drift() {
        let game = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let mods = game.path().join("mods");
        let disabled = game.path().join("mods_disabled");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();

        write_mod(
            &mods,
            "EndRunGraph-v0.3.2-Beta-STS2-v0.107.0",
            "End Run Graph",
            "0.3.2",
        );
        let mut installed = crate::mods::scan_mods(&mods);
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config.path());
        let disk_mod = installed.into_iter().next().unwrap();
        let version_id = disk_mod
            .mod_version_id
            .clone()
            .expect("scan enrichment assigns a local artifact id");

        // Add from Library writes the exact artifact id, but older saved
        // identity fields may still be stale or human-readable. Drift must
        // trust the concrete version id before calling this an active extra.
        let mut pm = pack_mod(
            "End Run Graph",
            "EndRunGraph-v0.3.1-Beta-STS2-v0.107.0",
            "0.3.2",
            true,
        );
        pm.mod_version_id = Some(version_id);
        pm.hash = disk_mod.hash.clone();
        let profile = base_profile("TesterW", vec![pm]);

        let drift =
            compute_profile_drift_with_registry(&profile, &mods, &disabled, config.path(), None);

        assert!(drift.added.is_empty(), "no false active extras: {drift:?}");
        assert!(drift.removed.is_empty(), "saved artifact must match disk");
        assert!(
            !drift.has_drift,
            "adding from Library should not leave drift"
        );
    }

    /// The core bug: "Save changes" used to re-snapshot the whole install,
    /// pulling every enabled AND disabled mod into a curated pack. Reconcile
    /// must apply only the diff.
    #[test]
    fn reconcile_applies_only_the_diff_not_the_whole_install() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // On disk: PackMod (enabled, already in pack), Extra (enabled, NOT in
        // pack → should be added), LibraryOnly (disabled, NOT in pack →
        // must be left out — this is the mod that the old snapshot wrongly
        // pulled in).
        write_mod(&mods_path, "PackMod", "Pack Mod", "1.0.0");
        write_mod(&mods_path, "Extra", "Extra", "1.0.0");
        write_mod(&disabled_path, "LibraryOnly", "Library Only", "1.0.0");

        // Pack also lists GoneMod, which is no longer on disk → should be
        // dropped.
        let profile = base_profile(
            "Stable",
            vec![
                pack_mod("Pack Mod", "PackMod", "1.0.0", true),
                pack_mod("Gone Mod", "GoneMod", "1.0.0", true),
            ],
        );
        save_profile(&profile, &profiles_path).unwrap();

        let save_result = reconcile_profile_with_disk(
            "Stable",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();
        let result = save_result.profile;

        let folders: std::collections::HashSet<&str> = result
            .mods
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        assert!(folders.contains("PackMod"), "kept the existing pack mod");
        assert!(folders.contains("Extra"), "added the enabled extra");
        assert!(!folders.contains("GoneMod"), "dropped the missing pack mod");
        assert!(
            !folders.contains("LibraryOnly"),
            "must NOT pull in the disabled library mod (the bug)"
        );
        assert_eq!(result.mods.len(), 2, "exactly PackMod + Extra");

        // Durable metadata for the kept mod is preserved (not blown away).
        let kept = result
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("PackMod"))
            .unwrap();
        assert_eq!(kept.source.as_deref(), Some("github:example/PackMod"));

        // Post-condition: no drift remains.
        let drift = compute_profile_drift(&result, &mods_path, &disabled_path);
        assert!(!drift.has_drift, "reconcile should leave zero drift");
    }

    /// A pack mod that's been disabled on disk (toggled drift) stays in the
    /// pack but flips to disabled — it is NOT dropped.
    #[test]
    fn reconcile_syncs_toggled_state_without_dropping() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // PackMod is in the pack as enabled, but on disk it's disabled.
        write_mod(&disabled_path, "PackMod", "Pack Mod", "1.0.0");
        let profile = base_profile(
            "Stable",
            vec![pack_mod("Pack Mod", "PackMod", "1.0.0", true)],
        );
        save_profile(&profile, &profiles_path).unwrap();

        let save_result = reconcile_profile_with_disk(
            "Stable",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();
        let result = save_result.profile;

        assert_eq!(result.mods.len(), 1, "mod stays in the pack");
        assert!(
            !result.mods[0].enabled,
            "enabled state synced to disk (disabled)"
        );

        let drift = compute_profile_drift(&result, &mods_path, &disabled_path);
        assert!(!drift.has_drift, "no drift after syncing the toggle");
    }

    /// A FOLLOWED (subscribed) pack — e.g. one you installed from a friend —
    /// must not be editable via drift save. Saving would overwrite the
    /// author's curated manifest with whatever is on your disk.
    #[test]
    fn reconcile_refuses_subscribed_profiles() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // An enabled mod on disk that isn't in the followed pack → there IS
        // drift, but saving it must still be refused.
        write_mod(&mods_path, "Extra", "Extra", "1.0.0");
        let profile = base_profile("Henry Pack", vec![]);
        let profile_id = profile.id.clone();
        save_profile(&profile, &profiles_path).unwrap();
        crate::subscriptions::save_subscriptions(
            &crate::subscriptions::SubscriptionsDb {
                subscriptions: std::collections::HashMap::from([(
                    "henry/AAAA-BBBB-CCCC".into(),
                    crate::subscriptions::Subscription {
                        share_id: "henry/AAAA-BBBB-CCCC".into(),
                        share_url: "https://example.test".into(),
                        profile_name: "Henry Pack".into(),
                        profile_id,
                        curator: Some("henry".into()),
                        last_synced_profile: base_profile("Henry Pack", vec![]),
                        last_checked: "2026-05-19T00:00:00Z".parse().unwrap(),
                        last_synced: "2026-05-19T00:00:00Z".parse().unwrap(),
                    },
                )]),
            },
            config_tmp.path(),
        )
        .unwrap();

        let err = reconcile_profile_with_disk(
            "Henry Pack",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("subscribed profile"),
            "drift save must refuse a followed pack; got: {}",
            err
        );

        // The followed manifest was left untouched (Extra not written in).
        assert!(
            load_profile("Henry Pack", &profiles_path)
                .unwrap()
                .mods
                .is_empty(),
            "the followed manifest must not be mutated"
        );
    }

    /// Reconcile is idempotent: calling Save twice produces zero residual
    /// drift on the second call. This is the core invariant from SM-N04.
    #[test]
    fn reconcile_is_idempotent_second_save_writes_nothing() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "Alpha", "Alpha", "1.0.0");
        write_mod(&mods_path, "Beta", "Beta", "2.0.0");
        write_mod(&disabled_path, "Gamma", "Gamma", "3.0.0");

        let profile = base_profile("Run", vec![pack_mod("Alpha", "Alpha", "1.0.0", true)]);
        save_profile(&profile, &profiles_path).unwrap();

        // First Save: add Beta (enabled extra), keep Alpha, drop nothing.
        let first = reconcile_profile_with_disk(
            "Run",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();
        assert!(
            first.residual_drift.is_none(),
            "first save must leave zero residual: {:?}",
            first.residual_drift
        );

        let manifest_path = fs::read_dir(&profiles_path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .expect("saved profile manifest");
        let after_first = fs::read(&manifest_path).unwrap();

        // Second Save: the manifest already reflects disk state; no write.
        let second = reconcile_profile_with_disk(
            "Run",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();
        assert!(
            second.residual_drift.is_none(),
            "second save must leave zero residual: {:?}",
            second.residual_drift
        );
        assert_eq!(
            fs::read(&manifest_path).unwrap(),
            after_first,
            "second save must not rewrite the manifest"
        );

        // The two profiles should be identical (second write changed nothing).
        let folders_first: std::collections::HashSet<&str> = first
            .profile
            .mods
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        let folders_second: std::collections::HashSet<&str> = second
            .profile
            .mods
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        assert_eq!(
            folders_first, folders_second,
            "second save must not change the manifest"
        );
        // Gamma (disabled extra) must never enter the pack.
        assert!(
            !folders_first.contains("Gamma"),
            "disabled extras must not enter the pack"
        );
    }

    /// Reconcile preserves a pack mod that matches by strong identity (mod_version_id)
    /// even when its display name or folder_name drifted on disk. This mirrors
    /// the drift detection behavior so both agree on the same set.
    #[test]
    fn reconcile_matches_by_strong_identity_when_display_name_drifted() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // Disk has the mod under "NewFolder" — same content hash as the pack
        // entry's hash.  After enrich_mods_with_versions, the disk mod gets
        // the same mod_version_id as the one stored in the pack.
        write_mod(&mods_path, "NewFolder", "RealMod", "1.0.0");
        let mut disk_mods = crate::mods::scan_mods(&mods_path);
        crate::mod_versions::enrich_mods_with_versions(&mut disk_mods, config_tmp.path());
        let version_id = disk_mods[0]
            .mod_version_id
            .clone()
            .expect("enrichment assigns a version id");

        // Pack recorded the old folder name but the correct mod_version_id.
        let mut pm = pack_mod("RealMod", "OldFolder", "1.0.0", true);
        pm.mod_version_id = Some(version_id.clone());
        pm.hash = disk_mods[0].hash.clone();
        let profile = base_profile("Stable", vec![pm]);
        save_profile(&profile, &profiles_path).unwrap();

        let save_result = reconcile_profile_with_disk(
            "Stable",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        assert!(
            save_result.residual_drift.is_none(),
            "strong-identity match must leave zero residual: {:?}",
            save_result.residual_drift
        );
        // The mod stayed in the pack.
        assert_eq!(
            save_result.profile.mods.len(),
            1,
            "mod matched by version id must be kept, not dropped"
        );
    }
}
