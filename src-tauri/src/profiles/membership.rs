//! Profile membership grid + load-order persistence helpers.
//!
//! The Tauri commands themselves (`get_profile_memberships`,
//! `set_profile_mod_membership`, `set_profile_load_order`) stay in
//! `mod.rs` so the `#[tauri::command]` proc-macro emits its companion
//! `__cmd__*` items at the `crate::profiles::*` path that `lib.rs`
//! invokes against. This module holds the pure-function compute layer
//! they call into:
//!
//! - `profile_membership_matrix` walks all profiles + installed mods
//!   and returns the grid the UI's per-modpack table consumes.
//! - `set_profile_mod_membership_from_paths` adds/removes a mod from
//!   one profile's manifest, refusing to edit subscribed profiles.
//! - `set_profile_load_order_from_paths` rewrites the in-pack ordering
//!   for a profile (called from the drag-reorder UI).
//! - `write_profile_load_order_to_settings_file` +
//!   `sync_profile_load_order_to_settings` mirror the chosen order
//!   into the game's `settings.save` so the engine respects it on
//!   next launch.
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::error::{AppError, Result};
use crate::mods::{merge_active_disabled_mods, scan_disabled_mods, scan_mods, ModInfo};

use super::apply::disk_mod_matches_pin;
use super::crud::{
    hide_app_created_by, list_profiles, load_profile, mod_key, profile_has_json,
    profile_mod_from_installed, profile_mod_matches_installed, profile_mod_matches_target,
    installed_mod_matches_target, save_profile, subscribed_profile_names,
};
use super::{
    LoadOrderSettingsStatus, Profile, ProfileMembershipGrid, ProfileMembershipMod,
    ProfileMembershipProfile, ProfileMembershipState, ProfileMod, ProfileModOrderKey,
};

pub(crate) fn profile_membership_matrix(
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<ProfileMembershipGrid> {
    let profiles = list_profiles(profiles_path);
    let subscribed_names = subscribed_profile_names(config_path);

    let profile_rows: Vec<ProfileMembershipProfile> = profiles
        .iter()
        .map(|profile| {
            let subscribed = subscribed_names.contains(&profile.name.to_lowercase());
            ProfileMembershipProfile {
                name: profile.name.clone(),
                editable: !subscribed && profile_has_json(&profile.name, profiles_path),
            }
        })
        .collect();

    let mut installed_mods =
        merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path));
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
    let mods = installed_mods
        .into_iter()
        .map(|installed| {
            let states = profiles
                .iter()
                .zip(profile_rows.iter())
                .map(|(profile, profile_row)| {
                    let matched = profile
                        .mods
                        .iter()
                        .find(|pm| profile_mod_matches_installed(pm, &installed));
                    ProfileMembershipState {
                        profile_name: profile.name.clone(),
                        included: matched.is_some(),
                        enabled: matched.map(|pm| pm.enabled).unwrap_or(false),
                        editable: profile_row.editable,
                    }
                })
                .collect();

            ProfileMembershipMod {
                name: installed.name,
                version: installed.version,
                folder_name: installed.folder_name,
                mod_id: installed.mod_id,
                display_name: installed.display_name,
                installed_enabled: installed.enabled,
                profiles: states,
            }
        })
        .collect();

    Ok(ProfileMembershipGrid {
        profiles: profile_rows,
        mods,
    })
}

pub(crate) fn set_profile_mod_membership_from_paths(
    profile_name: &str,
    mod_name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
    included: bool,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    if subscribed_profile_names(config_path).contains(&profile_name.to_lowercase()) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            profile_name
        )));
    }

    let mut profile = load_profile(profile_name, profiles_path)?;

    if included {
        let already_in_profile = profile
            .mods
            .iter()
            .any(|pm| profile_mod_matches_target(pm, mod_name, folder_name, mod_id));
        if !already_in_profile {
            let installed =
                merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path))
                    .into_iter()
                    .find(|m| installed_mod_matches_target(m, mod_name, folder_name, mod_id))
                    .ok_or_else(|| {
                        AppError::ModNotFound(format!(
                            "Installed mod '{}' was not found; refresh the mod list and try again.",
                            mod_name
                        ))
                    })?;
            profile.mods.push(profile_mod_from_installed(&installed));
        }
    } else {
        profile
            .mods
            .retain(|pm| !profile_mod_matches_target(pm, mod_name, folder_name, mod_id));
    }

    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    Ok(hide_app_created_by(profile))
}

fn order_key_identity(key: &ProfileModOrderKey) -> String {
    mod_key(&key.name, key.folder_name.as_deref(), key.mod_id.as_deref())
}

fn profile_mod_settings_id(pm: &ProfileMod) -> String {
    pm.mod_id
        .as_deref()
        .or(pm.folder_name.as_deref())
        .unwrap_or(&pm.name)
        .trim()
        .to_string()
}

fn disk_mod_settings_id(m: &ModInfo) -> String {
    m.mod_id
        .as_deref()
        .or(m.folder_name.as_deref())
        .unwrap_or(&m.name)
        .trim()
        .to_string()
}

pub(crate) fn set_profile_load_order_from_paths(
    profile_name: &str,
    ordered_mods: Vec<ProfileModOrderKey>,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    if subscribed_profile_names(config_path).contains(&profile_name.to_lowercase()) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            profile_name
        )));
    }

    let mut profile = load_profile(profile_name, profiles_path)?;
    if profile.mods.is_empty() && ordered_mods.is_empty() {
        return Ok(hide_app_created_by(profile));
    }
    if !profile.mods.is_empty() && ordered_mods.is_empty() {
        return Err(AppError::InvalidProfile(format!(
            "Load order for profile '{}' cannot be empty.",
            profile_name
        )));
    }

    let mut seen = std::collections::HashSet::new();
    for key in &ordered_mods {
        let identity = order_key_identity(key);
        if identity.trim().is_empty() || !seen.insert(identity.clone()) {
            return Err(AppError::InvalidProfile(format!(
                "Duplicate or blank mod in load order: {}",
                key.name
            )));
        }
    }

    let mut remaining = profile.mods.clone();
    let mut reordered = Vec::with_capacity(profile.mods.len());
    for key in ordered_mods {
        let Some(pos) = remaining.iter().position(|pm| {
            profile_mod_matches_target(
                pm,
                &key.name,
                key.folder_name.as_deref(),
                key.mod_id.as_deref(),
            )
        }) else {
            return Err(AppError::ModNotFound(format!(
                "Profile '{}' does not contain '{}'. Refresh and try again.",
                profile_name, key.name
            )));
        };
        reordered.push(remaining.remove(pos));
    }
    reordered.extend(remaining);

    profile.mods = reordered;
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    Ok(hide_app_created_by(profile))
}

fn settings_entry_with_state(
    id: &str,
    enabled: bool,
    existing: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut entry = existing
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "id": id, "source": "mods_directory" }));

    if let Some(obj) = entry.as_object_mut() {
        obj.insert("id".into(), serde_json::Value::String(id.to_string()));
        obj.insert("is_enabled".into(), serde_json::Value::Bool(enabled));
        obj.entry("source")
            .or_insert_with(|| serde_json::Value::String("mods_directory".into()));
    }
    entry
}

fn backup_settings_save(settings_path: &Path) -> Result<PathBuf> {
    let parent = settings_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = settings_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.save");
    let backup_name = format!(
        "{}.sts2mm-bak-{}",
        file_name,
        chrono::Utc::now().timestamp_millis()
    );
    let mut backup_path = parent.join(&backup_name);
    let mut suffix = 1u8;
    while backup_path.exists() {
        backup_path = parent.join(format!("{}-{}", backup_name, suffix));
        suffix = suffix.saturating_add(1);
    }
    fs::copy(settings_path, &backup_path)?;
    Ok(backup_path)
}

pub(super) fn write_settings_save_with_backup_and_restore<F>(
    settings_path: &Path,
    contents: &str,
    mut write_fn: F,
) -> Result<PathBuf>
where
    F: FnMut(&Path, &str) -> std::io::Result<()>,
{
    let backup_path = backup_settings_save(settings_path)?;
    if let Err(write_err) = write_fn(settings_path, contents) {
        if let Err(restore_err) = fs::copy(&backup_path, settings_path) {
            return Err(AppError::Other(format!(
                "Failed to write settings.save: {}; failed to restore backup from {}: {}",
                write_err,
                backup_path.display(),
                restore_err
            )));
        }
        return Err(AppError::Other(format!(
            "Failed to write settings.save: {}; restored backup from {}",
            write_err,
            backup_path.display()
        )));
    }
    Ok(backup_path)
}

pub(crate) fn write_profile_load_order_to_settings_file(
    profile: &Profile,
    settings_path: &Path,
    extra_mods: &[ModInfo],
) -> Result<()> {
    let raw = fs::read_to_string(settings_path)?;
    let mut settings: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::InvalidProfile(format!("Invalid settings.save JSON: {}", e)))?;

    if !settings.is_object() {
        return Err(AppError::InvalidProfile(
            "settings.save must contain a JSON object".into(),
        ));
    }

    let mut existing_by_id: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Some(existing) = settings
        .get("mod_settings")
        .and_then(|v| v.get("mod_list"))
        .and_then(|v| v.as_array())
    {
        for entry in existing {
            if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                existing_by_id.insert(id.to_string(), entry.clone());
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut mod_list = Vec::new();
    for pm in &profile.mods {
        let id = profile_mod_settings_id(pm);
        if id.is_empty() || !seen.insert(id.to_lowercase()) {
            continue;
        }
        mod_list.push(settings_entry_with_state(
            &id,
            pm.enabled,
            existing_by_id.get(&id),
        ));
    }
    for m in extra_mods {
        let id = disk_mod_settings_id(m);
        if id.is_empty() || !seen.insert(id.to_lowercase()) {
            continue;
        }
        mod_list.push(settings_entry_with_state(
            &id,
            m.enabled,
            existing_by_id.get(&id),
        ));
    }

    let mods_enabled =
        profile.mods.iter().any(|pm| pm.enabled) || extra_mods.iter().any(|m| m.enabled);

    let root = settings.as_object_mut().ok_or_else(|| {
        AppError::InvalidProfile("settings.save must contain a JSON object".into())
    })?;
    let mod_settings = root.entry("mod_settings").or_insert_with(|| json!({}));
    if !mod_settings.is_object() {
        *mod_settings = json!({});
    }
    let mod_settings_obj = mod_settings.as_object_mut().unwrap();
    mod_settings_obj.insert("mod_list".into(), serde_json::Value::Array(mod_list));
    mod_settings_obj.insert("mods_enabled".into(), serde_json::Value::Bool(mods_enabled));

    let serialized = serde_json::to_string_pretty(&settings)?;
    write_settings_save_with_backup_and_restore(settings_path, &serialized, |path, contents| {
        fs::write(path, contents)
    })?;
    Ok(())
}

enum SettingsSaveResolution {
    Found(PathBuf),
    Missing,
    Multiple(Vec<PathBuf>),
}

fn settings_save_candidates_under(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let direct = root.join("settings.save");
    if direct.is_file() {
        candidates.push(direct);
    }

    let steam_root = root.join("steam");
    if let Ok(entries) = fs::read_dir(&steam_root) {
        for entry in entries.flatten() {
            let settings = entry.path().join("settings.save");
            if settings.is_file() {
                candidates.push(settings);
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn find_settings_save_path() -> SettingsSaveResolution {
    if let Ok(path) = std::env::var("STS2_SETTINGS_SAVE") {
        let path = PathBuf::from(path);
        return if path.is_file() {
            SettingsSaveResolution::Found(path)
        } else {
            SettingsSaveResolution::Missing
        };
    }

    let mut candidates = Vec::new();
    if let Ok(root) = std::env::var("STS2_SAVE_DIR") {
        candidates.extend(settings_save_candidates_under(&PathBuf::from(root)));
    }
    if let Some(data_dir) = dirs::data_dir() {
        candidates.extend(settings_save_candidates_under(
            &data_dir.join("SlayTheSpire2"),
        ));
    }
    candidates.sort();
    candidates.dedup();

    match candidates.len() {
        0 => SettingsSaveResolution::Missing,
        1 => SettingsSaveResolution::Found(candidates.remove(0)),
        _ => SettingsSaveResolution::Multiple(candidates),
    }
}

fn profile_contains_disk_mod(profile: &Profile, disk_mod: &ModInfo) -> bool {
    profile
        .mods
        .iter()
        .any(|pm| profile_mod_matches_installed(pm, disk_mod))
}

pub(super) fn sync_profile_load_order_to_settings(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
    config_path: &Path,
) -> (LoadOrderSettingsStatus, Option<String>) {
    let settings_path = match find_settings_save_path() {
        SettingsSaveResolution::Found(path) => path,
        SettingsSaveResolution::Missing => return (LoadOrderSettingsStatus::SkippedMissing, None),
        SettingsSaveResolution::Multiple(paths) => {
            log::warn!(
                "Load order sync skipped: found multiple settings.save files: {:?}",
                paths
            );
            return (LoadOrderSettingsStatus::SkippedMultiple, None);
        }
    };

    let pinned_set = crate::mod_sources::load_pinned_set(config_path);
    let pinned_mods =
        merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path))
            .into_iter()
            .filter(|m| {
                disk_mod_matches_pin(m, &pinned_set) && !profile_contains_disk_mod(profile, m)
            })
            .collect::<Vec<_>>();

    match write_profile_load_order_to_settings_file(profile, &settings_path, &pinned_mods) {
        Ok(()) => (
            LoadOrderSettingsStatus::Applied,
            Some(settings_path.to_string_lossy().to_string()),
        ),
        Err(e) => {
            log::warn!(
                "Load order sync failed for settings.save at {}: {}",
                settings_path.display(),
                e
            );
            (
                LoadOrderSettingsStatus::Failed,
                Some(settings_path.to_string_lossy().to_string()),
            )
        }
    }
}

#[cfg(test)]
mod profile_membership_tests {
    use super::*;

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

    fn empty_profile(name: &str) -> Profile {
        Profile {
            name: name.into(),
            game_version: Some("0.105.0".into()),
            created_by: None,
            mods: Vec::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
        }
    }

    fn profile_mod_entry(name: &str, folder: &str, version: &str, enabled: bool) -> ProfileMod {
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
        }
    }

    #[test]
    fn membership_matrix_lists_installed_mods_against_profiles_by_folder() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "BaseLib", "BaseLib", "1.0.0");
        write_mod(&disabled_path, "AutoPath", "AutoPath", "2.0.0");

        let mut alpha = empty_profile("Alpha");
        alpha.mods.push(ProfileMod {
            name: "BaseLib".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["BaseLib/BaseLib.dll".into()],
            folder_name: Some("BaseLib".into()),
            mod_id: Some("BaseLib".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        });
        save_profile(&alpha, &profiles_path).unwrap();
        save_profile(&empty_profile("Beta"), &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(
            grid.profiles
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Beta"]
        );
        let base = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("BaseLib"))
            .unwrap();
        assert!(base
            .profiles
            .iter()
            .any(|p| p.profile_name == "Alpha" && p.included && p.enabled));
        assert!(base
            .profiles
            .iter()
            .any(|p| p.profile_name == "Beta" && !p.included));

        let auto = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("AutoPath"))
            .unwrap();
        assert!(
            !auto.installed_enabled,
            "disabled library mods should still be visible in the matrix"
        );
    }

    #[test]
    fn set_profile_mod_membership_adds_installed_mod_without_moving_files() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&disabled_path, "LibraryOnly", "Library Only", "1.2.3");
        save_profile(&empty_profile("Stable"), &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Stable",
            "Library Only",
            Some("LibraryOnly"),
            Some("LibraryOnly"),
            true,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        let entry = &updated.mods[0];
        assert_eq!(entry.name, "Library Only");
        assert_eq!(entry.folder_name.as_deref(), Some("LibraryOnly"));
        assert_eq!(entry.version, "1.2.3");
        assert!(
            !entry.enabled,
            "adding a disabled library mod should preserve its disabled profile state"
        );
        assert!(disabled_path
            .join("LibraryOnly")
            .join("LibraryOnly.dll")
            .exists());
        assert!(
            !mods_path.join("LibraryOnly").exists(),
            "editing membership must not apply the profile"
        );
    }

    #[test]
    fn set_profile_mod_membership_does_not_duplicate_same_folder_when_readded() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "LibraryOnly", "Library Only", "1.2.3");
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            name: "Library Only".into(),
            version: "1.2.3".into(),
            source: None,
            hash: None,
            files: vec!["LibraryOnly/LibraryOnly.dll".into()],
            folder_name: Some("LibraryOnly".into()),
            mod_id: Some("LibraryOnly".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        });
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Stable",
            "Library Only",
            Some("LibraryOnly"),
            Some("LibraryOnly"),
            true,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(updated.mods[0].folder_name.as_deref(), Some("LibraryOnly"));
    }

    #[test]
    fn membership_matrix_keeps_same_named_different_versions_as_separate_rows() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "card_art_editor", "Card Art Editor", "1.0.0");
        write_mod(
            &mods_path,
            "card_art_editor_beta",
            "Card Art Editor",
            "2.0.0-beta",
        );
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            name: "Card Art Editor".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["card_art_editor/card_art_editor.dll".into()],
            folder_name: Some("card_art_editor".into()),
            mod_id: Some("card_art_editor".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        });
        save_profile(&profile, &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        let rows = grid
            .mods
            .iter()
            .filter(|m| m.name == "Card Art Editor")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        let stable = rows
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor"))
            .unwrap();
        let beta = rows
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor_beta"))
            .unwrap();
        assert_eq!(stable.version, "1.0.0");
        assert_eq!(beta.version, "2.0.0-beta");
        assert!(stable
            .profiles
            .iter()
            .any(|p| p.profile_name == "Stable" && p.included));
        assert!(beta
            .profiles
            .iter()
            .any(|p| p.profile_name == "Stable" && !p.included));
    }

    #[test]
    fn set_profile_mod_membership_removes_matching_folder_only() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "card_art_editor", "Card Art Editor", "1.0.0");
        write_mod(&mods_path, "card_art_editor_v2", "Card Art Editor", "2.0.0");
        let mut profile = empty_profile("Beta");
        for (folder, version) in [
            ("card_art_editor", "1.0.0"),
            ("card_art_editor_v2", "2.0.0"),
        ] {
            profile.mods.push(ProfileMod {
                name: "Card Art Editor".into(),
                version: version.into(),
                source: None,
                hash: None,
                files: vec![format!("{folder}/{folder}.dll")],
                folder_name: Some(folder.into()),
                mod_id: Some(folder.into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
            });
        }
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Beta",
            "Card Art Editor",
            Some("card_art_editor_v2"),
            Some("card_art_editor_v2"),
            false,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(
            updated.mods[0].folder_name.as_deref(),
            Some("card_art_editor")
        );
        assert!(mods_path
            .join("card_art_editor_v2")
            .join("card_art_editor_v2.dll")
            .exists());
    }

    #[test]
    fn set_profile_mod_membership_rejects_subscribed_profiles() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        write_mod(&mods_path, "BaseLib", "BaseLib", "1.0.0");
        save_profile(&empty_profile("Friend Pack"), &profiles_path).unwrap();
        crate::subscriptions::save_subscriptions(
            &crate::subscriptions::SubscriptionsDb {
                subscriptions: std::collections::HashMap::from([(
                    "alice/AAAA-BBBB-CCCC".into(),
                    crate::subscriptions::Subscription {
                        share_id: "alice/AAAA-BBBB-CCCC".into(),
                        share_url: "https://example.test".into(),
                        profile_name: "Friend Pack".into(),
                        curator: Some("alice".into()),
                        last_synced_profile: empty_profile("Friend Pack"),
                        last_checked: "2026-05-19T00:00:00Z".parse().unwrap(),
                        last_synced: "2026-05-19T00:00:00Z".parse().unwrap(),
                    },
                )]),
            },
            config_tmp.path(),
        )
        .unwrap();

        let err = set_profile_mod_membership_from_paths(
            "Friend Pack",
            "BaseLib",
            Some("BaseLib"),
            Some("BaseLib"),
            true,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("subscribed profile"),
            "subscribed packs should be read-only in the library editor; got: {}",
            err
        );
    }

    #[test]
    fn set_profile_load_order_reorders_manifest_without_losing_metadata() {
        let config_tmp = tempfile::tempdir().unwrap();
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let mut profile = empty_profile("Stable");
        profile
            .mods
            .push(profile_mod_entry("BaseLib", "BaseLib", "1.0.0", true));
        profile.mods.push(profile_mod_entry(
            "Card Art Editor",
            "CardArtEditor",
            "2.0.0",
            false,
        ));
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_load_order_from_paths(
            "Stable",
            vec![
                ProfileModOrderKey {
                    name: "Card Art Editor".into(),
                    folder_name: Some("CardArtEditor".into()),
                    mod_id: Some("CardArtEditor".into()),
                },
                ProfileModOrderKey {
                    name: "BaseLib".into(),
                    folder_name: Some("BaseLib".into()),
                    mod_id: Some("BaseLib".into()),
                },
            ],
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(
            updated
                .mods
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Card Art Editor", "BaseLib"]
        );
        assert_eq!(
            updated.mods[0].bundle_url.as_deref(),
            Some("https://example.test/CardArtEditor.zip"),
            "reordering must not rebuild or lose share/download metadata"
        );
        assert_eq!(
            updated.mods[1].source.as_deref(),
            Some("github:example/BaseLib")
        );
    }

    #[test]
    fn write_profile_load_order_to_settings_save_uses_profile_order_and_preserves_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(
            &settings_path,
            r#"{
  "audio": { "master": 80 },
  "mod_settings": {
    "mod_list": [
      { "id": "BaseLib", "is_enabled": true, "source": "mods_directory", "note": "keep" },
      { "id": "CardArtEditor", "is_enabled": true, "source": "mods_directory" },
      { "id": "PinnedUtility", "is_enabled": true, "source": "mods_directory", "custom": 9 }
    ],
    "mods_enabled": false
  }
}"#,
        )
        .unwrap();

        let mut profile = empty_profile("Stable");
        profile.mods.push(profile_mod_entry(
            "Card Art Editor",
            "CardArtEditor",
            "2.0.0",
            true,
        ));
        profile
            .mods
            .push(profile_mod_entry("BaseLib", "BaseLib", "1.0.0", false));
        let pinned = vec![ModInfo {
            name: "Pinned Utility".into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec!["PinnedUtility/PinnedUtility.dll".into()],
            source: None,
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            github_url: None,
            nexus_url: None,
            folder_name: Some("PinnedUtility".into()),
            mod_id: Some("PinnedUtility".into()),
            pinned: true,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_id: None,
        }];

        write_profile_load_order_to_settings_file(&profile, &settings_path, &pinned).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        let mod_list = saved["mod_settings"]["mod_list"].as_array().unwrap();
        let ids = mod_list
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["CardArtEditor", "BaseLib", "PinnedUtility"]);
        assert_eq!(mod_list[1]["is_enabled"].as_bool(), Some(false));
        assert_eq!(mod_list[1]["note"].as_str(), Some("keep"));
        assert_eq!(mod_list[2]["custom"].as_i64(), Some(9));
        assert_eq!(saved["mod_settings"]["mods_enabled"].as_bool(), Some(true));
        assert_eq!(saved["audio"]["master"].as_i64(), Some(80));
        assert!(
            fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.save.sts2mm-bak")),
            "settings.save should be backed up before the manager rewrites it"
        );
    }

    #[test]
    fn settings_save_write_restores_backup_when_rewrite_fails_after_damage() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        let original = r#"{"mod_settings":{"mod_list":[{"id":"BaseLib","is_enabled":true}]}}"#;
        fs::write(&settings_path, original).unwrap();

        let err = write_settings_save_with_backup_and_restore(
            &settings_path,
            "{\"mod_settings\":{\"mod_list\":[]}}",
            |path, _content| {
                fs::write(path, "BROKEN PARTIAL WRITE")?;
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "simulated write failure",
                ))
            },
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("simulated write failure"),
            "caller should still see the original hard failure; got: {}",
            err
        );
        assert_eq!(
            fs::read_to_string(&settings_path).unwrap(),
            original,
            "a hard settings.save rewrite failure must restore the pre-write backup"
        );
        assert!(
            fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.save.sts2mm-bak")),
            "the backup should be retained for manual inspection"
        );
    }
}
