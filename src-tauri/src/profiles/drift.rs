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
    save_profile, version_is_wildcard,
};
use super::{Profile, ProfileMod};
use crate::error::{AppError, Result};

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
    let mut profile_map: std::collections::HashMap<String, (bool, String, String, Option<String>)> =
        std::collections::HashMap::new();
    for pm in &profile.mods {
        let key = mod_key(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref());
        profile_map.insert(
            key,
            (
                pm.enabled,
                pm.version.clone(),
                pm.name.clone(),
                pm.hash.clone(),
            ),
        );
    }

    // Build a map of installed mods: key -> (display_name, enabled, version)
    let enabled_mods = crate::mods::scan_mods(mods_path);
    let disabled_mods = crate::mods::scan_disabled_mods(disabled_path);

    let mut installed_map: std::collections::HashMap<
        String,
        (String, bool, String, Option<String>),
    > = std::collections::HashMap::new();
    for m in &enabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_map.insert(
            key,
            (m.name.clone(), true, m.version.clone(), m.hash.clone()),
        );
    }
    for m in &disabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_map.insert(
            key,
            (m.name.clone(), false, m.version.clone(), m.hash.clone()),
        );
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
    for (key, (profile_enabled, profile_version, profile_display, profile_hash)) in &profile_map {
        if let Some((disk_display, installed_enabled, disk_version, disk_hash)) =
            installed_map.get(key)
        {
            if profile_enabled != installed_enabled {
                toggled.push(disk_display.clone());
            }
            if !versions_match(profile_version, disk_version)
                && !contents_match(profile_hash.as_deref(), disk_hash.as_deref())
            {
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

/// Reconcile a profile's manifest with the current active loadout by
/// applying ONLY the drift difference — the inverse of `repair`.
///
/// This is what the "Save changes" button on the drift banner calls. It
/// deliberately does NOT re-snapshot the whole install (the old behavior,
/// which pulled every enabled *and disabled* mod on disk into the pack,
/// flooding a curated pack with the entire library). Instead it mirrors the
/// drift definition exactly:
///   - `added`   → enabled-on-disk mods not in the pack are appended.
///   - `removed` → pack mods no longer present on disk (neither enabled nor
///                 disabled) are dropped.
///   - `toggled` / `version_changed` → pack mods still on disk have their
///                 enabled flag + version synced to disk.
///
/// Disabled extras on disk that aren't in the pack are left alone — they're
/// library items, not active drift. Durable per-mod metadata (source,
/// bundle_url, hash, files) is preserved for mods already in the pack.
///
/// Post-condition: `compute_profile_drift` returns `has_drift == false`
/// immediately after this runs (same `mod_key` matching on both sides).
pub(super) fn reconcile_profile_with_disk(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    // A *followed* (subscribed but not owned) pack's manifest belongs to its
    // author. Saving drift would overwrite their curated set with whatever
    // happens to be on this user's disk, so refuse it — the same gate
    // set_profile_mod_membership and set_profile_load_order enforce. A pack
    // you published is owned (proven by its local .share) and stays editable
    // even though installing your own code auto-subscribed you. Repair stays
    // allowed regardless: it only restores the manifest onto disk, never the
    // reverse.
    if profile_is_edit_locked(name, profiles_path, config_path) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            name
        )));
    }

    let mut profile = load_profile(name, profiles_path)?;

    let enabled_mods = crate::mods::scan_mods(mods_path);
    let disabled_mods = crate::mods::scan_disabled_mods(disabled_path);

    // installed key -> (ModInfo, enabled-on-disk). Enabled scan wins on
    // key collision (a mod can't be in both, but be defensive).
    let mut installed_by_key: std::collections::HashMap<String, (crate::mods::ModInfo, bool)> =
        std::collections::HashMap::new();
    for m in &disabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_by_key
            .entry(key)
            .or_insert_with(|| (m.clone(), false));
    }
    for m in &enabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        installed_by_key.insert(key, (m.clone(), true));
    }

    let mut reconciled: Vec<ProfileMod> = Vec::new();
    let mut kept_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. Keep pack mods still on disk (sync enabled + version); drop the rest.
    for pm in &profile.mods {
        let key = mod_key(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref());
        if let Some((info, enabled)) = installed_by_key.get(&key) {
            let mut updated = pm.clone();
            updated.enabled = *enabled;
            if !version_is_wildcard(&info.version) {
                updated.version = info.version.clone();
            }
            reconciled.push(updated);
            kept_keys.insert(key);
        }
        // else: removed (not on disk at all) → drop from the pack.
    }

    // 2. Append enabled-on-disk mods not already in the pack (the `added`
    //    drift). Disabled extras are intentionally skipped.
    for m in &enabled_mods {
        let key = mod_key(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref());
        if kept_keys.contains(&key) {
            continue;
        }
        let mut info = m.clone();
        info.enabled = true;
        reconciled.push(profile_mod_from_installed(&info));
        kept_keys.insert(key);
    }

    profile.mods = reconciled;
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    Ok(hide_app_created_by(profile))
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

    /// The core bug: "Save changes" used to re-snapshot the whole install,
    /// pulling every enabled AND disabled mod into a curated pack. Reconcile
    /// must apply only the diff.
    #[test]
    fn reconcile_applies_only_the_diff_not_the_whole_install() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
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

        let result = reconcile_profile_with_disk(
            "Stable",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

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

        let result = reconcile_profile_with_disk(
            "Stable",
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

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
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // An enabled mod on disk that isn't in the followed pack → there IS
        // drift, but saving it must still be refused.
        write_mod(&mods_path, "Extra", "Extra", "1.0.0");
        save_profile(&base_profile("Henry Pack", vec![]), &profiles_path).unwrap();
        crate::subscriptions::save_subscriptions(
            &crate::subscriptions::SubscriptionsDb {
                subscriptions: std::collections::HashMap::from([(
                    "henry/AAAA-BBBB-CCCC".into(),
                    crate::subscriptions::Subscription {
                        share_id: "henry/AAAA-BBBB-CCCC".into(),
                        share_url: "https://example.test".into(),
                        profile_name: "Henry Pack".into(),
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
}
