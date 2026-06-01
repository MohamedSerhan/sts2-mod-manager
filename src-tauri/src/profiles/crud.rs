//! Profile CRUD + on-disk storage helpers and the mod-identity matching
//! primitives that the rest of the profile pipeline uses.
//!
//! The Tauri commands themselves (`list_profiles_cmd`, `create_profile`,
//! `delete_profile_cmd`, `duplicate_profile`, `export_profile_cmd`,
//! `import_profile_cmd`) stay in `mod.rs` so the `#[tauri::command]`
//! proc-macro emits its companion `__cmd__*` items at the
//! `crate::profiles::*` path that `lib.rs` invokes against. This module
//! holds the pure-function layer they (and the other submodules) call
//! into:
//!
//!   - File storage: `list_profiles`, `save_profile`, `load_profile`,
//!     `delete_profile`, `import_profile`, `export_profile`.
//!   - Identity helpers used by drift/membership/apply to decide whether
//!     a profile entry and an installed mod refer to the same thing:
//!     `mod_key`, `mod_identity_keys`, `profile_mod_matches_*`,
//!     `installed_mod_matches_target`, `profile_mod_from_installed`.
//!   - Sanity helpers reused across modules: `sanitize_filename`,
//!     `hide_app_created_by`, `version_is_wildcard`,
//!     `subscribed_profile_names`, `profile_has_json`.
use std::fs;
use std::path::Path;

use crate::error::{AppError, Result};
use crate::mods::ModInfo;

use super::{Profile, ProfileMod, APP_CREATED_BY};

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
                        let profile = hide_app_created_by(profile);
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
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !seen_names.contains(&stem) {
                    // Create a placeholder profile -- will be fetched from GitHub on activation
                    profiles.push(Profile {
                        name: stem.clone(),
                        game_version: None,
                        created_by: Some("Shared (click Activate to fetch)".to_string()),
                        mods: vec![],
                        created_at: chrono::Utc::now(),
                        updated_at: chrono::Utc::now(),
                        public: None,
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
pub(super) fn sanitize_filename(name: &str) -> String {
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

pub(super) fn hide_app_created_by(mut profile: Profile) -> Profile {
    if profile.created_by.as_deref().map(str::trim) == Some(APP_CREATED_BY) {
        profile.created_by = None;
    }
    profile
}

/// Helper: canonical identifier for a mod (prefer mod_id > folder_name > name).
pub(super) fn mod_key(name: &str, folder_name: Option<&str>, mod_id: Option<&str>) -> String {
    mod_id.or(folder_name).unwrap_or(name).to_lowercase()
}

pub(super) fn mod_identity_keys(
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    for candidate in [mod_id, folder_name, Some(name)] {
        let Some(value) = candidate else { continue };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn strong_mod_identity_keys(folder_name: Option<&str>, mod_id: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    for candidate in [mod_id, folder_name] {
        let Some(value) = candidate else { continue };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn identity_lists_intersect(a: &[String], b: &[String]) -> bool {
    a.iter().any(|key| b.contains(key))
}

pub(super) fn profile_mod_matches_installed(pm: &ProfileMod, installed: &ModInfo) -> bool {
    let profile_strong = strong_mod_identity_keys(pm.folder_name.as_deref(), pm.mod_id.as_deref());
    let installed_strong = strong_mod_identity_keys(
        installed.folder_name.as_deref(),
        installed.mod_id.as_deref(),
    );

    if !profile_strong.is_empty() && !installed_strong.is_empty() {
        return identity_lists_intersect(&profile_strong, &installed_strong);
    }

    mod_identity_keys(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref())
        .iter()
        .any(|key| {
            mod_identity_keys(
                &installed.name,
                installed.folder_name.as_deref(),
                installed.mod_id.as_deref(),
            )
            .contains(key)
        })
}

pub(super) fn profile_mod_matches_target(
    pm: &ProfileMod,
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> bool {
    if let Some(folder) = folder_name.map(str::trim).filter(|v| !v.is_empty()) {
        return pm
            .folder_name
            .as_deref()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(folder));
    }
    if let Some(id) = mod_id.map(str::trim).filter(|v| !v.is_empty()) {
        return pm
            .mod_id
            .as_deref()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(id));
    }
    pm.name.eq_ignore_ascii_case(name)
}

pub(super) fn installed_mod_matches_target(
    installed: &ModInfo,
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> bool {
    if let Some(folder) = folder_name.map(str::trim).filter(|v| !v.is_empty()) {
        return installed
            .folder_name
            .as_deref()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(folder));
    }
    if let Some(id) = mod_id.map(str::trim).filter(|v| !v.is_empty()) {
        return installed
            .mod_id
            .as_deref()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(id));
    }
    installed.name.eq_ignore_ascii_case(name)
}

pub(super) fn profile_mod_from_installed(installed: &ModInfo) -> ProfileMod {
    ProfileMod {
        name: installed.name.clone(),
        version: installed.version.clone(),
        source: installed.source.clone(),
        hash: installed.hash.clone(),
        files: installed.files.clone(),
        folder_name: installed.folder_name.clone(),
        mod_id: installed.mod_id.clone(),
        enabled: installed.enabled,
        bundle_url: None,
        bundle_sha256: None,
    }
}

/// Persist each pack mod's curator source link into the importer's
/// `mod_sources.json` so the Mods view shows GitHub/Nexus chips instead of
/// "Unlinked" after installing a shared pack.
///
/// Called once, after the install/update download loop, for EVERY mod the
/// pack declares — not just the ones that happened to download on this run.
/// That distinction is the whole fix: a pack mod already present on disk at
/// the right version is skipped by the download loop (`continue`), so a
/// write nested inside that loop never reached it and the mod stayed
/// unlinked. Writing here, unconditionally, covers already-installed mods.
///
/// Each write is fill-if-empty via `mod_sources::fill_source_if_absent`, so
/// a link the user already set (or a note / pin / preserved config on the
/// same entry) is never clobbered. The DB is loaded and saved once for the
/// whole batch, and only when something actually changed.
pub fn persist_profile_mod_sources(mods: &[ProfileMod], config_path: &Path) {
    let mut db = crate::mod_sources::load_sources(config_path);
    let mut changed = false;
    for pm in mods {
        let Some(ref src) = pm.source else { continue };
        let Some(parsed) = crate::mod_sources::parse_source_url(src) else {
            continue;
        };
        // Folder-first key to match enrich_mods_with_sources' read order;
        // falls back to display name for mods with no folder on disk.
        let key = pm.folder_name.clone().unwrap_or_else(|| pm.name.clone());
        if crate::mod_sources::fill_source_if_absent(&mut db, &key, &parsed) {
            changed = true;
        }
    }
    if changed {
        if let Err(e) = crate::mod_sources::save_sources(&db, config_path) {
            log::warn!("Failed to persist pack mod sources: {}", e);
        }
    }
}

pub(super) fn subscribed_profile_names(config_path: &Path) -> std::collections::HashSet<String> {
    crate::subscriptions::load_subscriptions(config_path)
        .subscriptions
        .values()
        .map(|sub| sub.profile_name.to_lowercase())
        .collect()
}

pub(super) fn profile_has_json(profile_name: &str, profiles_path: &Path) -> bool {
    profiles_path
        .join(format!("{}.json", sanitize_filename(profile_name)))
        .exists()
}

/// Treat a version string as a wildcard if it's missing or a placeholder.
/// Mirrors the rule used by `apply_subscription_update` and `switch_profile`
/// so drift detection agrees with what the apply path will actually do.
pub(super) fn version_is_wildcard(v: &str) -> bool {
    let v = v.trim_start_matches('v').trim();
    v.is_empty() || v == "unknown" || v == "0.0.0"
}

#[cfg(test)]
mod public_field_tests {
    use super::*;

    #[test]
    fn missing_field_deserializes_as_none() {
        let json = r#"{
            "name": "test",
            "game_version": null,
            "created_by": null,
            "mods": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.public, None);
    }

    #[test]
    fn none_value_is_omitted_in_serialized_json() {
        let profile = Profile {
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("\"public\""), "got: {}", json);
    }

    #[test]
    fn true_value_roundtrips() {
        let profile = Profile {
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(true),
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("\"public\":true"));
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.public, Some(true));
    }
}

#[cfg(test)]
mod profile_schema_compat_tests {
    use super::*;

    #[test]
    fn legacy_profile_without_bundle_sha256_deserializes() {
        let legacy = r#"{
            "name": "test",
            "version": "1.0.0",
            "source": null,
            "hash": null,
            "files": [],
            "bundle_url": "https://raw.githubusercontent.com/x/y/main/mods/a.zip"
        }"#;
        let pm: ProfileMod = serde_json::from_str(legacy).expect("legacy deserializes");
        assert_eq!(pm.bundle_sha256, None);
        assert_eq!(
            pm.bundle_url.as_deref(),
            Some("https://raw.githubusercontent.com/x/y/main/mods/a.zip")
        );
    }

    #[test]
    fn profile_without_sha_serializes_without_the_field() {
        let pm = ProfileMod {
            name: "test".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: None,
            mod_id: None,
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        };
        let json = serde_json::to_string(&pm).unwrap();
        assert!(
            !json.contains("bundle_sha256"),
            "expected field to be omitted: {}",
            json
        );
    }

    #[test]
    fn profile_with_sha_round_trips() {
        let pm = ProfileMod {
            name: "test".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: None,
            mod_id: None,
            enabled: true,
            bundle_url: Some(
                "https://github.com/x/y/releases/download/bundles/a_v1.0.0.zip".into(),
            ),
            bundle_sha256: Some("deadbeef".into()),
        };
        let json = serde_json::to_string(&pm).unwrap();
        let round: ProfileMod = serde_json::from_str(&json).unwrap();
        assert_eq!(round.bundle_sha256.as_deref(), Some("deadbeef"));
    }
}

#[cfg(test)]
mod persist_profile_mod_sources_tests {
    //! Import-side half of the "imported pack shows Unlinked" fix. The key
    //! property: sources are written for EVERY pack mod, including ones
    //! already installed (which the download loop skips), and the write is
    //! fill-only so a user's own links/notes are never clobbered.
    use super::*;
    use tempfile::tempdir;

    fn pm_with_source(name: &str, folder: &str, source: Option<&str>) -> ProfileMod {
        ProfileMod {
            name: name.into(),
            version: "1.0.0".into(),
            source: source.map(str::to_string),
            hash: None,
            files: vec![],
            folder_name: Some(folder.into()),
            mod_id: Some(folder.into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        }
    }

    #[test]
    fn writes_source_for_every_pack_mod_even_already_installed_ones() {
        // Mirrors the user's pack: one mod carries a github source, the rest
        // carry none. Every mod here represents an already-installed entry
        // (the download loop would have `continue`d past all of them), so
        // this single call is the only thing that links them.
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        let mods = vec![
            pm_with_source(
                "RegentCardsAnimeRework",
                "RegentCardsAnimeRework",
                Some("github:DoublePigeon/RegentCardsAnimeRework"),
            ),
            pm_with_source("AutoPath", "AutoPath", None),
        ];
        persist_profile_mod_sources(&mods, config);

        let db = crate::mod_sources::load_sources(config);
        assert_eq!(
            db.mods
                .get("RegentCardsAnimeRework")
                .and_then(|e| e.github_repo.as_deref()),
            Some("DoublePigeon/RegentCardsAnimeRework"),
            "the sourced mod gets linked despite being already installed"
        );
        assert!(
            db.mods.get("AutoPath").is_none(),
            "a sourceless mod creates no entry (correctly stays unlinked)"
        );
        assert!(
            db.mods
                .get("RegentCardsAnimeRework")
                .map(|e| e.github_auto_detected)
                .unwrap_or(false),
            "curator-supplied link is marked auto-detected"
        );
    }

    #[test]
    fn does_not_clobber_a_users_existing_link_or_note() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        // User already linked AutoPath to the right repo and left a note.
        let mut db = crate::mod_sources::ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".into(),
            crate::mod_sources::ModSourceEntry {
                github_repo: Some("realauthor/AutoPath".into()),
                github_auto_detected: false,
                note: Some("hand-checked".into()),
                ..Default::default()
            },
        );
        crate::mod_sources::save_sources(&db, config).unwrap();

        // A pack points the same mod at a different repo.
        let mods = vec![pm_with_source(
            "AutoPath",
            "AutoPath",
            Some("github:impostor/AutoPath"),
        )];
        persist_profile_mod_sources(&mods, config);

        let after = crate::mod_sources::load_sources(config);
        let entry = after.mods.get("AutoPath").unwrap();
        assert_eq!(
            entry.github_repo.as_deref(),
            Some("realauthor/AutoPath"),
            "user's link wins"
        );
        assert_eq!(entry.note.as_deref(), Some("hand-checked"), "note survives");
        assert!(!entry.github_auto_detected, "stays user-authored");
    }
}
