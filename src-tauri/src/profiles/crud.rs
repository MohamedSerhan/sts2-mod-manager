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

use super::{new_profile_id, Profile, ProfileMod, APP_CREATED_BY};

/// List all saved profiles.
/// Includes profiles that only have a .share file (remote profiles not yet fetched).
pub fn list_profiles(profiles_path: &Path) -> Vec<Profile> {
    let mut profiles = Vec::new();
    let mut seen_profile_stems = std::collections::HashSet::new();

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
                        seen_profile_stems.insert(profile.name.clone());
                        seen_profile_stems.insert(sanitize_filename(&profile.name));
                        if !profile.id.trim().is_empty() {
                            seen_profile_stems.insert(profile.id.clone());
                            seen_profile_stems.insert(sanitize_filename(&profile.id));
                        }
                        seen_profile_stems.insert(profile_file_stem(&profile));
                        profiles.push(profile);
                    }
                }
            }
        }
    }

    profiles.sort_by(|a, b| {
        let name_order = a.name.cmp(&b.name);
        if name_order != std::cmp::Ordering::Equal {
            return name_order;
        }
        let a_has_id = !a.id.trim().is_empty();
        let b_has_id = !b.id.trim().is_empty();
        b_has_id.cmp(&a_has_id)
    });
    profiles.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));

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
                if !seen_profile_stems.contains(&stem) {
                    // Create a placeholder profile -- will be fetched from GitHub on activation
                    profiles.push(Profile {
                        id: new_profile_id(),
                        name: stem.clone(),
                        game_version: None,
                        created_by: Some("Shared (click Activate to fetch)".to_string()),
                        mods: vec![],
                        created_at: chrono::Utc::now(),
                        updated_at: chrono::Utc::now(),
                        public: None,
                        mod_extras: Default::default(),
                    });
                    seen_profile_stems.insert(stem);
                }
            }
        }
    }

    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

/// Save a profile to disk.
pub fn save_profile(profile: &Profile, profiles_path: &Path) -> Result<()> {
    let file_name = profile_file_stem(profile);
    let path = profiles_path.join(format!("{}.json", file_name));
    let json = serde_json::to_string_pretty(profile)?;
    // atomic_write creates the parent dir (propagating any error, unlike the
    // old silent `let _ = create_dir_all`) and renames into place.
    crate::fs_safety::atomic_write(&path, json.as_bytes())?;
    Ok(())
}

/// Load a profile by name.
pub fn load_profile(name: &str, profiles_path: &Path) -> Result<Profile> {
    let path = find_profile_json(name, profiles_path)
        .ok_or_else(|| AppError::InvalidProfile(format!("Profile '{}' not found", name)))?;
    load_profile_from_path(&path)
}

/// Delete a profile (both .json and .share files).
pub fn delete_profile(name: &str, profiles_path: &Path) -> Result<()> {
    let loaded = find_profile_json(name, profiles_path)
        .and_then(|path| load_profile_from_path(&path).ok().map(|profile| (path, profile)));
    let file_name = sanitize_filename(name);
    let json_path = profiles_path.join(format!("{}.json", file_name));
    let share_path = profiles_path.join(format!("{}.share", file_name));
    // Also try with the raw name (spaces preserved) for .share files
    let share_path_raw = profiles_path.join(format!("{}.share", name));

    let mut deleted_any = false;

    if let Some((path, profile)) = loaded {
        if path.exists() {
            fs::remove_file(&path)?;
            deleted_any = true;
        }
        for share in profile_share_candidates(&profile, profiles_path) {
            if share.exists() {
                fs::remove_file(share)?;
                deleted_any = true;
            }
        }
    }
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

/// Rename a profile: move the `.json` (and the `.share` sidecar, preserving
/// its bytes so the share code survives) from `old` to `new`. The remote
/// manifest in the curator's repo is keyed by the stable share CODE, not the
/// name, so a local rename never orphans a shared pack — provided we MOVE the
/// `.share` rather than delete+recreate it.
pub fn rename_profile(old: &str, new: &str, profiles_path: &Path) -> Result<Profile> {
    let new_trimmed = new.trim();
    if new_trimmed.is_empty() {
        return Err(AppError::InvalidProfile("Name can't be empty".into()));
    }
    let old_json = find_profile_json(old, profiles_path)
        .ok_or_else(|| AppError::InvalidProfile(format!("Profile '{}' not found", old)))?;
    let mut profile = load_profile_from_path(&old_json)?;

    // Collision: a DIFFERENT profile already named `new`. (A no-op rename to the
    // same on-disk file is allowed.) Compare by canonical identity, not path
    // string: on a case-insensitive FS a case-only rename ("My Pack" → "my
    // pack") aliases the same inode, so a string `!=` check would wrongly
    // reject it as a collision with itself.
    if profile_name_exists(new_trimmed, profiles_path, Some(&profile.id)) {
        return Err(AppError::InvalidProfile(format!(
            "A modpack named '{}' already exists",
            new_trimmed
        )));
    }

    // Write the renamed profile's .json FIRST, before touching the .share
    // sidecar. Ordering matters for crash-safety: if a later step fails, the
    // new name is already a complete pack (manifest present) rather than a
    // phantom .share with no .json. Full atomicity across two files isn't
    // possible without a transaction, but anchoring on the manifest keeps a
    // mid-failure recoverable (a stray duplicate/sidecar, never a lost pack).
    profile.name = new_trimmed.to_string();
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    let new_json = profiles_path.join(format!("{}.json", profile_file_stem(&profile)));

    // Move the .share sidecar (raw old → raw new), mirroring delete_profile's
    // raw+sanitized lookup. Preserve bytes verbatim so the share code stays.
    let share_candidates = profile_share_candidates(&profile, profiles_path)
        .into_iter()
        .chain([
            profiles_path.join(format!("{}.share", old)),
            profiles_path.join(format!("{}.share", sanitize_filename(old))),
        ])
        .collect::<Vec<_>>();
    let dest_share = profiles_path.join(format!("{}.share", profile_file_stem(&profile)));
    if let Some(src) = share_candidates.iter().find(|p| p.exists()) {
        let bytes = fs::read(src)?;
        crate::fs_safety::atomic_write(&dest_share, &bytes)?;
        for p in &share_candidates {
            // Guard by canonical identity, not path-string inequality: on a
            // case-insensitive FS a case-only rename aliases the same inode as
            // `dest_share`, so a string `!=` check would delete the file we
            // just wrote (losing the share code).
            if p.exists() && !paths_refer_to_same_file(p, &dest_share) {
                let _ = fs::remove_file(p);
            }
        }
    }

    // Remove the stale .json only if it's a genuinely different file. On a
    // case-insensitive FS ("Pack" → "pack") the old and new names alias the
    // same inode that `save_profile` just wrote — a string `!=` check would
    // delete the renamed profile. Guard by canonical identity instead.
    if old_json.exists() && !paths_refer_to_same_file(&old_json, &new_json) {
        fs::remove_file(&old_json)?;
    }
    Ok(profile)
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

/// True when two paths refer to the same file on disk. Handles
/// case-insensitive filesystems (Windows/macOS) where two distinct-cased
/// names alias a single inode. Falls back to a path comparison when
/// canonicalization fails (e.g. a path that no longer exists).
fn paths_refer_to_same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
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

pub(crate) fn profile_file_stem(profile: &Profile) -> String {
    let id = profile.id.trim();
    if id.is_empty() {
        sanitize_filename(&profile.name)
    } else {
        sanitize_filename(id)
    }
}

fn load_profile_from_path(path: &Path) -> Result<Profile> {
    let content = fs::read_to_string(path)?;
    let mut profile: Profile = serde_json::from_str(&content)?;
    if profile.id.trim().is_empty() {
        profile.id = new_profile_id();
    }
    Ok(profile)
}

fn find_profile_json(name_or_id: &str, profiles_path: &Path) -> Option<std::path::PathBuf> {
    let mut name_match: Option<std::path::PathBuf> = None;
    for entry in fs::read_dir(profiles_path).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(profile) = serde_json::from_str::<Profile>(&content) else {
            continue;
        };
        if profile.id.eq_ignore_ascii_case(name_or_id)
        {
            return Some(path);
        }
        if profile.name.eq_ignore_ascii_case(name_or_id) {
            let has_id = !profile.id.trim().is_empty();
            if has_id {
                return Some(path);
            }
            name_match.get_or_insert(path);
        }
    }
    if let Some(path) = name_match {
        return Some(path);
    }
    let direct = profiles_path.join(format!("{}.json", sanitize_filename(name_or_id)));
    direct.exists().then_some(direct)
}

pub(crate) fn profile_name_exists(
    name: &str,
    profiles_path: &Path,
    except_id: Option<&str>,
) -> bool {
    list_profiles(profiles_path).into_iter().any(|profile| {
        profile.name.eq_ignore_ascii_case(name)
            && except_id.is_none_or(|id| !profile.id.eq_ignore_ascii_case(id))
    })
}

pub(crate) fn unique_profile_name(name: &str, profiles_path: &Path) -> String {
    if !profile_name_exists(name, profiles_path, None) {
        return name.to_string();
    }
    for n in 2.. {
        let candidate = format!("{name} ({n})");
        if !profile_name_exists(&candidate, profiles_path, None) {
            return candidate;
        }
    }
    unreachable!()
}

fn profile_share_candidates(profile: &Profile, profiles_path: &Path) -> Vec<std::path::PathBuf> {
    vec![
        profiles_path.join(format!("{}.share", profile_file_stem(profile))),
        profiles_path.join(format!("{}.share", sanitize_filename(&profile.name))),
        profiles_path.join(format!("{}.share", profile.name)),
    ]
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
    let profile_source = pm
        .source
        .as_deref()
        .and_then(crate::mod_sources::parse_source_url);

    if !profile_strong.is_empty() && !installed_strong.is_empty() {
        if identity_lists_intersect(&profile_strong, &installed_strong) {
            return true;
        }
        return profile_source.as_ref().is_some_and(|source| {
            crate::mod_sources::mod_info_source_matches_entry(installed, source)
        });
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
        || profile_source.as_ref().is_some_and(|source| {
            crate::mod_sources::mod_info_source_matches_entry(installed, source)
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
        bundle_members: installed.bundle_members.clone(),
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

/// True when this profile was published by *this* user — i.e. a local
/// `.share` sidecar exists for it. The `.share` file is written only by the
/// share / reshare path (`sharing::share_profile`), so its presence is proof
/// of ownership that no remote actor can forge.
///
/// Checks both the sanitized filename and the raw (spaces-preserved) name,
/// mirroring `delete_profile` — historically `.share` files were written
/// under the raw profile name, so an owned pack like `mods (copy)` has a
/// `mods (copy).share`, not `mods__copy_.share`.
pub(super) fn profile_is_owned(name: &str, profiles_path: &Path) -> bool {
    if let Ok(profile) = load_profile(name, profiles_path) {
        if profile_share_candidates(&profile, profiles_path)
            .into_iter()
            .any(|path| path.exists())
        {
            return true;
        }
    }
    let sanitized = profiles_path.join(format!("{}.share", sanitize_filename(name)));
    let raw = profiles_path.join(format!("{}.share", name));
    sanitized.exists() || raw.exists()
}

/// Whether a profile is locked against local edits. A profile is locked only
/// when it is subscribed (its name matches a subscription) AND it is NOT
/// owned by this user.
///
/// The subscribe-only check was too broad: installing your *own* share code
/// auto-subscribes you to your *own* pack (see `install_shared_profile`), and
/// a subscribed-name-only gate then locked a pack you authored. Gating on
/// "subscribed AND not owned" keeps the intended protection — you can't
/// clobber a pack you merely *follow*, since a sync would overwrite your
/// edits — while letting you freely edit packs you published.
pub(super) fn profile_is_edit_locked(name: &str, profiles_path: &Path, config_path: &Path) -> bool {
    subscribed_profile_names(config_path).contains(&name.to_lowercase())
        && !profile_is_owned(name, profiles_path)
}

pub(super) fn profile_has_json(profile_name: &str, profiles_path: &Path) -> bool {
    find_profile_json(profile_name, profiles_path).is_some()
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
            id: crate::profiles::new_profile_id(),
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("\"public\""), "got: {}", json);
    }

    #[test]
    fn true_value_roundtrips() {
        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(true),
            mod_extras: Default::default(),
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
            bundle_members: vec![],
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
            bundle_members: vec![],
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
            bundle_members: vec![],
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

#[cfg(test)]
mod profile_identity_storage_tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_profile(id: &str, name: &str, mods: usize) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: (0..mods)
                .map(|i| ProfileMod {
                    name: format!("Mod {i}"),
                    version: "1.0.0".into(),
                    source: None,
                    hash: None,
                    files: vec![format!("Mod{i}.dll")],
                    folder_name: None,
                    mod_id: None,
                    enabled: true,
                    bundle_url: None,
                    bundle_sha256: None,
                    bundle_members: vec![],
                })
                .collect(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    #[test]
    fn id_named_share_sidecar_does_not_create_placeholder_profile() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        let profile = sample_profile("profile-123", "TesterW", 2);
        save_profile(&profile, dir).unwrap();
        std::fs::write(dir.join("profile-123.share"), "{}").unwrap();

        let profiles = list_profiles(dir);

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "profile-123");
        assert_eq!(profiles[0].name, "TesterW");
        assert_eq!(profiles[0].mods.len(), 2);
    }

    #[test]
    fn id_backed_duplicate_name_wins_over_legacy_name_file() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        let legacy = sample_profile("", "TesterW", 0);
        std::fs::write(
            dir.join("TesterW.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let profile = sample_profile("profile-123", "TesterW", 2);
        save_profile(&profile, dir).unwrap();

        let profiles = list_profiles(dir);
        let loaded = load_profile("TesterW", dir).unwrap();

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "profile-123");
        assert_eq!(loaded.id, "profile-123");
        assert_eq!(loaded.mods.len(), 2);
    }
}

#[cfg(test)]
mod edit_lock_tests {
    //! Ownership-aware edit lock. Regression coverage for the user-reported
    //! "can't edit my own published modpack" bug: publishing a pack auto-
    //! subscribes you to your own share code, and the old subscribed-name-only
    //! gate then locked a pack you authored. A local `.share` sidecar proves
    //! ownership and must unlock editing.
    use super::*;
    use tempfile::tempdir;

    fn seed_subscription(config_path: &Path, profile_name: &str) {
        let now = chrono::Utc::now();
        let mut db = crate::subscriptions::SubscriptionsDb::default();
        db.subscriptions.insert(
            format!("owner:{profile_name}"),
            crate::subscriptions::Subscription {
                share_id: format!("owner:{profile_name}"),
                share_url: format!("owner/{profile_name}"),
                profile_name: profile_name.to_string(),
                curator: Some("owner".into()),
                last_synced_profile: Profile {
                    id: crate::profiles::new_profile_id(),
                    name: profile_name.to_string(),
                    game_version: None,
                    created_by: Some("owner".into()),
                    mods: vec![],
                    created_at: now,
                    updated_at: now,
                    public: None,
                    mod_extras: Default::default(),
                },
                last_checked: now,
                last_synced: now,
            },
        );
        crate::subscriptions::save_subscriptions(&db, config_path).unwrap();
    }

    #[test]
    fn owned_and_subscribed_pack_is_not_locked() {
        // The reported scenario: you published "mods (copy)", which auto-
        // subscribed you to it. The .share sidecar (written by the share path,
        // under the RAW name with spaces) marks it yours → editable.
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        seed_subscription(dir, "mods (copy)");
        // Raw-name .share, exactly as the share path writes it.
        std::fs::write(dir.join("mods (copy).share"), "{}").unwrap();

        assert!(
            profile_is_owned("mods (copy)", dir),
            "a raw-name .share sidecar marks the pack owned"
        );
        assert!(
            !profile_is_edit_locked("mods (copy)", dir, dir),
            "an owned pack must be editable even while subscribed to its own code"
        );
    }

    #[test]
    fn followed_pack_without_share_file_stays_locked() {
        // A pack you merely follow (someone else's) has a subscription but no
        // local .share — editing it would be clobbered by a sync, so it stays
        // locked.
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        seed_subscription(dir, "Friend Pack");

        assert!(!profile_is_owned("Friend Pack", dir));
        assert!(
            profile_is_edit_locked("Friend Pack", dir, dir),
            "a followed, non-owned pack remains locked"
        );
    }

    #[test]
    fn unsubscribed_local_pack_is_never_locked() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        // No subscriptions seeded, no .share file.
        assert!(
            !profile_is_edit_locked("My Local Pack", dir, dir),
            "a plain local pack is always editable"
        );
    }

    #[test]
    fn ownership_detected_via_sanitized_share_name_too() {
        // Defensive: if a .share is ever written under the sanitized name
        // instead of the raw one, ownership detection still holds.
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        seed_subscription(dir, "mods (copy)");
        std::fs::write(
            dir.join(format!("{}.share", sanitize_filename("mods (copy)"))),
            "{}",
        )
        .unwrap();
        assert!(profile_is_owned("mods (copy)", dir));
        assert!(!profile_is_edit_locked("mods (copy)", dir, dir));
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(name: &str) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    #[test]
    fn renames_json_and_returns_renamed_profile() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("Old Pack"), dir).unwrap();

        let renamed = rename_profile("Old Pack", "New Pack", dir).unwrap();
        assert_eq!(renamed.name, "New Pack");
        assert!(load_profile("New Pack", dir).is_ok(), "new json present");
        assert!(load_profile("Old Pack", dir).is_err(), "old json gone");
    }

    #[test]
    fn moves_share_sidecar_preserving_bytes() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("Old Pack"), dir).unwrap();
        // .share is written under the RAW name by the share path.
        let share_body =
            r#"{"code":"AA5A-315D-61AE","owner":"me","file_sha":"abc","share_format_version":3}"#;
        std::fs::write(dir.join("Old Pack.share"), share_body).unwrap();

        let renamed = rename_profile("Old Pack", "New Pack", dir).unwrap();

        assert!(!dir.join("Old Pack.share").exists(), "old share moved away");
        let moved =
            std::fs::read_to_string(dir.join(format!("{}.share", profile_file_stem(&renamed))))
                .unwrap();
        assert_eq!(moved, share_body, "share code preserved verbatim");
    }

    #[test]
    fn rejects_collision_with_a_different_existing_profile() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("Old Pack"), dir).unwrap();
        save_profile(&sample("Taken"), dir).unwrap();
        assert!(rename_profile("Old Pack", "Taken", dir).is_err());
        // Original still intact after a rejected rename.
        assert!(load_profile("Old Pack", dir).is_ok());
    }

    #[test]
    fn rejects_empty_new_name() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("Old Pack"), dir).unwrap();
        assert!(rename_profile("Old Pack", "   ", dir).is_err());
    }

    #[test]
    fn no_op_rename_to_same_name_succeeds() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("Same"), dir).unwrap();
        let r = rename_profile("Same", "Same", dir).unwrap();
        assert_eq!(r.name, "Same");
        assert!(load_profile("Same", dir).is_ok());
    }

    #[test]
    fn case_only_rename_preserves_json_and_share() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_profile(&sample("My Pack"), dir).unwrap();
        let share_body =
            r#"{"code":"AA5A-315D-61AE","owner":"me","file_sha":"abc","share_format_version":3}"#;
        std::fs::write(dir.join("My Pack.share"), share_body).unwrap();

        let renamed = rename_profile("My Pack", "my pack", dir).unwrap();
        assert_eq!(renamed.name, "my pack");
        // The renamed profile must still load under the new name (not deleted).
        assert!(
            load_profile("my pack", dir).is_ok(),
            "profile must survive a case-only rename"
        );
        // And its share code must be preserved under the new name (not deleted).
        let moved =
            std::fs::read_to_string(dir.join(format!("{}.share", profile_file_stem(&renamed))))
                .unwrap();
        assert_eq!(
            moved, share_body,
            "share code must survive a case-only rename"
        );
    }
}
