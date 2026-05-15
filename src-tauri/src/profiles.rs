use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::{scan_disabled_mods, scan_mods};
use crate::state::AppState;

const APP_CREATED_BY: &str = "sts2-mod-manager";

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

fn hide_app_created_by(mut profile: Profile) -> Profile {
    if profile.created_by.as_deref().map(str::trim) == Some(APP_CREATED_BY) {
        profile.created_by = None;
    }
    profile
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

// ── Core Functions ──────────────────────────────────────────────────────────

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
                let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
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

/// Create a snapshot with optional source enrichment from config_path.
/// Captures BOTH enabled and disabled mods with their current state.
///
/// `game_version_for_filter` controls the bug-#21 incompatibility filter:
///   - `Some(v)` — strip mods whose `min_game_version` exceeds `v`. Use
///     this only when the snapshot is an *explicit* user action (kebab →
///     Snapshot, share/re-share). Pass the cached `AppState.game_version`
///     so the platform-specific mods/release_info layout is irrelevant.
///   - `None` — preserve every scanned mod. Use this for non-publishing
///     internal snapshots where filtering would silently lose user data.
pub fn snapshot_current_with_sources(
    name: &str,
    mods_path: &Path,
    profiles_path: &Path,
    config_path: Option<&Path>,
    game_version_for_filter: Option<&str>,
) -> Result<Profile> {
    // Derive disabled path as sibling of mods_path (consistent with state.rs)
    let disabled_path = mods_path.parent()
        .unwrap_or(mods_path)
        .join("mods_disabled");
    snapshot_current_inner(
        name,
        mods_path,
        &disabled_path,
        profiles_path,
        config_path,
        game_version_for_filter,
    )
}

/// Create a snapshot with an explicit disabled mods path. See
/// `snapshot_current_with_sources` for the meaning of
/// `game_version_for_filter`.
pub fn snapshot_current_with_paths(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: Option<&Path>,
    game_version_for_filter: Option<&str>,
) -> Result<Profile> {
    snapshot_current_inner(
        name,
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        game_version_for_filter,
    )
}

/// Helper: canonical identifier for a mod (prefer mod_id > folder_name > name).
fn mod_key(name: &str, folder_name: Option<&str>, mod_id: Option<&str>) -> String {
    mod_id
        .or(folder_name)
        .unwrap_or(name)
        .to_lowercase()
}

fn mod_identity_keys(name: &str, folder_name: Option<&str>, mod_id: Option<&str>) -> Vec<String> {
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

/// Treat a version string as a wildcard if it's missing or a placeholder.
/// Mirrors the rule used by `apply_subscription_update` and `switch_profile`
/// so drift detection agrees with what the apply path will actually do.
fn version_is_wildcard(v: &str) -> bool {
    let v = v.trim_start_matches('v').trim();
    v.is_empty() || v == "unknown" || v == "0.0.0"
}

fn same_concrete_version(a: &str, b: &str) -> bool {
    a.trim_start_matches('v').trim() == b.trim_start_matches('v').trim()
}

fn should_preserve_existing_bundle_url(existing: &ProfileMod, scanned_version: &str) -> bool {
    existing.bundle_url.is_some()
        && (version_is_wildcard(scanned_version)
            || version_is_wildcard(&existing.version)
            || same_concrete_version(&existing.version, scanned_version))
}

fn snapshot_current_inner(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: Option<&Path>,
    game_version_for_filter: Option<&str>,
) -> Result<Profile> {
    let enabled_mods = scan_mods(mods_path);
    let disabled_mods = scan_disabled_mods(disabled_path);
    let now = Utc::now();

    // Bug #21 mirror: when this snapshot represents an explicit user
    // intent to publish state (kebab → Snapshot, share/re-share), strip
    // mods whose `min_game_version` exceeds the user's current build.
    // The subscription-side fix (build_synced_profile_snapshot in
    // subscriptions.rs, commit 37df97f) filters via the SkippedMod list
    // collected during the download phase; here we don't have that
    // list, so we check each scanned mod's manifest directly with the
    // same compat helper (updater::install_is_incompatible).
    //
    // Non-publishing snapshots can pass `None` so the filter is a no-op.
    // Those flows must preserve every mod that's currently part of the
    // profile; otherwise an incompatible mod already in the profile could
    // be silently stripped, drift would then flag it as `added`, and
    // Repair would keep trying to correct a false drift.
    //
    // The game_version source is the caller's responsibility. It must
    // be the cached `AppState.game_version` (set by `set_game_path`
    // against the canonical game root) rather than something derived
    // from `mods_path.parent()` — on macOS mods live under
    // `<game>/SlayTheSpire2.app/Contents/MacOS/mods`, so a parent-based
    // derivation looks for `release_info.json` in the wrong directory
    // and silently disables the filter.
    let is_incompatible = |info: &crate::mods::ModInfo| -> bool {
        if let Some(game_version) = game_version_for_filter {
            crate::updater::install_is_incompatible(info, Some(game_version))
        } else {
            false
        }
    };

    // Load mod sources DB if config_path provided, to enrich profile with download links
    let sources_db = config_path
        .map(|p| crate::mod_sources::load_sources(p))
        .unwrap_or_default();

    // Load existing profile to preserve durable metadata. Disk scans can be
    // sparse (DLL-only fallback, malformed manifests, missing source fields);
    // explicit snapshots should not degrade a previously-linkable profile
    // unless the scan has concrete newer data.
    let existing_profile = load_profile(name, profiles_path).ok();
    let mut existing_by_key: std::collections::HashMap<String, ProfileMod> =
        std::collections::HashMap::new();
    if let Some(profile) = existing_profile.as_ref() {
        for m in &profile.mods {
            for key in mod_identity_keys(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref()) {
                existing_by_key.entry(key).or_insert_with(|| m.clone());
            }
        }
    }

    let mut profile_mods: Vec<ProfileMod> = Vec::new();
    let mut filtered_incompatible: u32 = 0;

    let build_profile_mod = |m: crate::mods::ModInfo, enabled: bool| -> ProfileMod {
        let existing = mod_identity_keys(&m.name, m.folder_name.as_deref(), m.mod_id.as_deref())
            .into_iter()
            .find_map(|key| existing_by_key.get(&key));

        let source = m.source.clone().or_else(|| {
            crate::mod_sources::lookup_entry(
                &sources_db.mods,
                m.folder_name.as_deref(),
                &m.name,
                m.mod_id.as_deref(),
            )
                .and_then(|e| e.github_repo.as_ref())
                .map(|repo| format!("github:{}", repo))
        }).or_else(|| existing.and_then(|pm| pm.source.clone()));

        let version = if version_is_wildcard(&m.version) {
            existing
                .map(|pm| pm.version.clone())
                .filter(|v| !version_is_wildcard(v))
                .unwrap_or_else(|| m.version.clone())
        } else {
            m.version.clone()
        };

        let bundle_url = existing.and_then(|pm| {
            if should_preserve_existing_bundle_url(pm, &m.version) {
                pm.bundle_url.clone()
            } else {
                None
            }
        });

        ProfileMod {
            name: m.name.clone(),
            version,
            source,
            hash: m.hash.clone().or_else(|| existing.and_then(|pm| pm.hash.clone())),
            files: if m.files.is_empty() {
                existing.map(|pm| pm.files.clone()).unwrap_or_default()
            } else {
                m.files.clone()
            },
            folder_name: m.folder_name.clone()
                .or_else(|| existing.and_then(|pm| pm.folder_name.clone())),
            mod_id: m.mod_id.clone()
                .or_else(|| existing.and_then(|pm| pm.mod_id.clone())),
            enabled,
            bundle_url,
            bundle_sha256: existing.and_then(|pm| {
                if should_preserve_existing_bundle_url(pm, &m.version) {
                    pm.bundle_sha256.clone()
                } else {
                    None
                }
            }),
        }
    };

    // Add enabled mods
    for m in enabled_mods {
        if is_incompatible(&m) {
            log::info!(
                "Snapshot '{}': filtering enabled mod '{}' — needs game v{}, user has v{}",
                name,
                m.name,
                m.min_game_version.as_deref().unwrap_or("?"),
                game_version_for_filter.unwrap_or("?"),
            );
            filtered_incompatible += 1;
            continue;
        }
        profile_mods.push(build_profile_mod(m, true));
    }

    // Add disabled mods
    for m in disabled_mods {
        if is_incompatible(&m) {
            log::info!(
                "Snapshot '{}': filtering disabled mod '{}' — needs game v{}, user has v{}",
                name,
                m.name,
                m.min_game_version.as_deref().unwrap_or("?"),
                game_version_for_filter.unwrap_or("?"),
            );
            filtered_incompatible += 1;
            continue;
        }
        profile_mods.push(build_profile_mod(m, false));
    }

    if filtered_incompatible > 0 {
        log::info!(
            "Snapshot '{}': filtered {} game-version-incompatible mod(s) (user game v{})",
            name,
            filtered_incompatible,
            game_version_for_filter.unwrap_or("?"),
        );
    }

    let profile = Profile {
        name: name.to_string(),
        game_version: existing_profile.as_ref().and_then(|p| p.game_version.clone()),
        created_by: existing_profile
            .as_ref()
            .and_then(|p| p.created_by.clone())
            .filter(|created_by| created_by.trim() != APP_CREATED_BY),
        mods: profile_mods,
        created_at: existing_profile.as_ref().map(|p| p.created_at).unwrap_or(now),
        updated_at: now,
        public: existing_profile.as_ref().and_then(|p| p.public),
    };

    save_profile(&profile, profiles_path)?;
    Ok(profile)
}

/// Apply a profile: restore exact enabled/disabled state for all listed mods.
/// Mods not in the profile are disabled. Uses move_mod_by_info with fallback.
///
/// Matches on-disk mods against the profile by **name OR folder_name OR mod_id**
/// (same multi-key lookup used by `switch_profile` / `apply_subscription_update`).
/// A name-only match is fragile across platforms because names are user-facing
/// strings parsed from `info.json` and may differ in case (Linux is
/// case-sensitive). folder_name and mod_id are stable identifiers that survive
/// renames and case differences.
///
/// Skips any on-disk mod whose name/folder_name/mod_id is in `pinned` —
/// pinned mods retain their current enabled/disabled state. This lets a
/// player permanently disable cosmetic/non-multiplayer-breaking mods while
/// still subscribed to a curator's modpack. Pass an empty set if no pinning
/// is desired.
pub fn apply_profile_with_pins(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
    pinned: &std::collections::HashSet<String>,
) -> Result<()> {
    use std::collections::HashMap;

    let is_pinned = |m: &crate::mods::ModInfo| -> bool {
        if pinned.contains(&m.name) { return true; }
        if let Some(ref folder) = m.folder_name {
            if pinned.contains(folder) { return true; }
        }
        if let Some(ref id) = m.mod_id {
            if pinned.contains(id) { return true; }
        }
        false
    };

    // Build a map from any identifier (name / folder_name / mod_id) to the
    // desired enabled state. Last write wins, but the same ProfileMod owns all
    // its identifiers so collisions only happen if two profile entries share an
    // identifier — in which case the profile itself is malformed.
    let mut profile_state: HashMap<String, bool> = HashMap::new();
    for pm in &profile.mods {
        profile_state.insert(pm.name.clone(), pm.enabled);
        if let Some(ref folder) = pm.folder_name {
            profile_state.insert(folder.clone(), pm.enabled);
        }
        if let Some(ref id) = pm.mod_id {
            profile_state.insert(id.clone(), pm.enabled);
        }
    }

    // Look up an on-disk mod against the multi-key profile state. Returns None
    // if no identifier matched the profile at all (i.e. mod is not part of the
    // profile and should be disabled).
    let lookup = |m: &crate::mods::ModInfo| -> Option<bool> {
        if let Some(v) = profile_state.get(&m.name) {
            return Some(*v);
        }
        if let Some(ref folder) = m.folder_name {
            if let Some(v) = profile_state.get(folder) {
                return Some(*v);
            }
        }
        if let Some(ref id) = m.mod_id {
            if let Some(v) = profile_state.get(id) {
                return Some(*v);
            }
        }
        None
    };

    // Step 1: Move mods that should be DISABLED from enabled to disabled
    let current_enabled = scan_mods(mods_path);
    for m in &current_enabled {
        if is_pinned(m) {
            log::info!("Profile apply: skipping pinned mod '{}' (currently enabled)", m.name);
            continue;
        }
        let should_be_enabled = lookup(m).unwrap_or(false);
        if !should_be_enabled {
            log::info!(
                "Profile apply: disabling '{}' (folder={:?}, mod_id={:?})",
                m.name, m.folder_name, m.mod_id
            );
            if let Err(e) = crate::mods::move_mod_by_info(m, mods_path, disabled_path) {
                log::warn!("move_mod_by_info failed for '{}': {} -- falling back to disable_mod", m.name, e);
                if let Err(e2) = crate::mods::disable_mod(&m.name, mods_path, disabled_path) {
                    log::error!("disable_mod fallback also failed for '{}': {}", m.name, e2);
                }
            }
        }
    }

    // Step 2: Move mods that should be ENABLED from disabled to enabled
    let current_disabled = scan_disabled_mods(disabled_path);
    for m in &current_disabled {
        if is_pinned(m) {
            log::info!("Profile apply: skipping pinned mod '{}' (currently disabled)", m.name);
            continue;
        }
        let should_be_enabled = lookup(m).unwrap_or(false);
        if should_be_enabled {
            log::info!(
                "Profile apply: enabling '{}' (folder={:?}, mod_id={:?})",
                m.name, m.folder_name, m.mod_id
            );
            if let Err(e) = crate::mods::move_mod_by_info(m, disabled_path, mods_path) {
                log::warn!("move_mod_by_info failed for '{}': {} -- falling back to enable_mod", m.name, e);
                if let Err(e2) = crate::mods::enable_mod(&m.name, mods_path, disabled_path) {
                    log::error!("enable_mod fallback also failed for '{}': {}", m.name, e2);
                }
            }
        }
    }

    // Warn about profile mods that we never saw on disk (neither enabled nor
    // disabled). Helps diagnose subscription-update issues where a download
    // landed under a different identifier than the profile expected.
    let on_disk_ids: std::collections::HashSet<String> = current_enabled
        .iter()
        .chain(current_disabled.iter())
        .flat_map(|m| {
            let mut ids = vec![m.name.clone()];
            if let Some(ref f) = m.folder_name { ids.push(f.clone()); }
            if let Some(ref i) = m.mod_id { ids.push(i.clone()); }
            ids
        })
        .collect();
    for pm in &profile.mods {
        if pm.enabled {
            let found = on_disk_ids.contains(&pm.name)
                || pm.folder_name.as_ref().map_or(false, |f| on_disk_ids.contains(f))
                || pm.mod_id.as_ref().map_or(false, |i| on_disk_ids.contains(i));
            if !found {
                log::error!(
                    "Profile apply: profile expects '{}' enabled but no matching mod found on disk (folder={:?}, mod_id={:?})",
                    pm.name, pm.folder_name, pm.mod_id
                );
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
    // Explicit user action — apply the bug-#21 filter using the cached
    // game_version so incompatible mods don't get published into a
    // shared profile. AppState.game_version is set on the canonical
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
    let to_remove: Vec<String> = db.subscriptions.iter()
        .filter(|(_, sub)| sub.profile_name == name)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &to_remove {
        db.subscriptions.remove(id);
    }
    if !to_remove.is_empty() {
        let _ = crate::subscriptions::save_subscriptions(&db, &config_path);
        log::info!("Cleaned up {} subscription(s) for deleted profile '{}'", to_remove.len(), name);
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

pub(crate) fn profile_mod_matches_pin(
    pm: &ProfileMod,
    pinned: &std::collections::HashSet<String>,
) -> bool {
    pinned.contains(&pm.name)
        || pm
            .folder_name
            .as_ref()
            .is_some_and(|folder| pinned.contains(folder))
        || pm
            .mod_id
            .as_ref()
            .is_some_and(|mod_id| pinned.contains(mod_id))
}

fn disk_mod_matches_pin(
    disk_mod: &crate::mods::ModInfo,
    pinned: &std::collections::HashSet<String>,
) -> bool {
    pinned.contains(&disk_mod.name)
        || disk_mod
            .folder_name
            .as_ref()
            .is_some_and(|folder| pinned.contains(folder))
        || disk_mod
            .mod_id
            .as_ref()
            .is_some_and(|mod_id| pinned.contains(mod_id))
}

pub(crate) fn should_skip_pinned_profile_mod_download(
    pm: &ProfileMod,
    disk_mod: Option<&crate::mods::ModInfo>,
    pinned: &std::collections::HashSet<String>,
) -> bool {
    disk_mod.is_some_and(|disk_mod| {
        profile_mod_matches_pin(pm, pinned) || disk_mod_matches_pin(disk_mod, pinned)
    })
}

fn profile_content_matches_disk(pm: &ProfileMod, disk_mod: &crate::mods::ModInfo) -> bool {
    match (pm.hash.as_deref(), disk_mod.hash.as_deref()) {
        (Some(profile_hash), Some(disk_hash)) => profile_hash == disk_hash,
        _ => true,
    }
}

/// Switch to a profile: downloads missing mods, then applies the target
/// profile's exact enabled/disabled state.
async fn switch_profile_from_paths(
    name: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
    token: Option<&str>,
) -> std::result::Result<SwitchProfileResult, String> {
    // Load target profile -- try local JSON first, then re-fetch from share code if missing
    let profile = match load_profile(name, profiles_path) {
        Ok(p) => p,
        Err(_) => {
            // Local .json missing -- check for .share file to re-fetch from GitHub
            let share_file = profiles_path.join(format!("{}.share", sanitize_filename(name)));
            if share_file.exists() {
                log::info!("Profile '{}' JSON missing, re-fetching from share code", name);
                let share_content = std::fs::read_to_string(&share_file).map_err(|e| e.to_string())?;
                let share_info: serde_json::Value = serde_json::from_str(&share_content).map_err(|e| e.to_string())?;
                let owner = share_info["owner"].as_str().ok_or("Share file missing owner")?;
                let code = share_info["code"].as_str().ok_or("Share file missing code")?;
                let filename = format!("{}.json", code.replace('-', "").to_lowercase());
                let fetched = crate::sharing::fetch_shared_profile(owner, &filename, token)
                    .await
                    .map_err(|e| format!("Failed to re-fetch shared profile: {}", e))?;
                // Save locally so we have it next time
                let _ = save_profile(&fetched, profiles_path);
                fetched
            } else {
                return Err(format!("Profile '{}' not found (no local data or share code)", name));
            }
        }
    };

    if profile.mods.is_empty() {
        return Ok(SwitchProfileResult {
            applied: true,
            missing_mods: vec![],
            downloaded: 0,
            failed_downloads: vec![],
        });
    }

    // ── STEP 1: Download missing mods AND restore version-mismatched mods ──
    let all_on_disk: Vec<crate::mods::ModInfo> = scan_mods(mods_path)
        .into_iter()
        .chain(scan_disabled_mods(disabled_path).into_iter())
        .collect();

    // Build a map from identifiers to on-disk mod info (for version comparison)
    let mut on_disk_by_id: std::collections::HashMap<String, &crate::mods::ModInfo> = std::collections::HashMap::new();
    for m in &all_on_disk {
        on_disk_by_id.insert(m.name.clone(), m);
        if let Some(ref folder) = m.folder_name {
            on_disk_by_id.insert(folder.clone(), m);
        }
        if let Some(ref id) = m.mod_id {
            on_disk_by_id.insert(id.clone(), m);
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(config_path);
    let pinned_set = crate::mod_sources::load_pinned_set(config_path);
    let mut downloaded_count = 0u32;
    let mut download_failures: Vec<String> = Vec::new();

    for pm in &profile.mods {
        // Find matching on-disk mod
        let on_disk_mod = on_disk_by_id.get(&pm.name)
            .or_else(|| pm.folder_name.as_ref().and_then(|f| on_disk_by_id.get(f)))
            .or_else(|| pm.mod_id.as_ref().and_then(|id| on_disk_by_id.get(id)))
            .copied();

        if on_disk_mod.is_none() && profile_mod_matches_pin(pm, &pinned_set) {
            log::info!(
                "switch_profile: pinned mod '{}' is missing on disk; restoring from profile",
                pm.name
            );
        }

        // Pinned mods keep their installed version when there is one to preserve.
        if should_skip_pinned_profile_mod_download(pm, on_disk_mod, &pinned_set) {
            log::info!("switch_profile: skipping pinned mod '{}' (preserving installed version)", pm.name);
            continue;
        }

        if let Some(disk_mod) = on_disk_mod {
            let disk_ver = disk_mod.version.trim_start_matches('v');
            let profile_ver = pm.version.trim_start_matches('v');

            let version_ok = disk_ver == profile_ver
                || profile_ver == "unknown" || profile_ver == "0.0.0"
                || disk_ver == "unknown" || disk_ver == "0.0.0";
            let content_ok = profile_content_matches_disk(pm, disk_mod);

            if version_ok && content_ok {
                continue; // Correct version/content on disk
            }

            let version_mismatch = !version_ok;
            if version_mismatch {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) -- restoring profile version",
                    pm.name, disk_mod.version, pm.version
                );
            } else {
                log::info!(
                    "Mod '{}' content hash mismatch at version {} -- restoring bundled profile copy",
                    pm.name, pm.version
                );
            }

            // Cache the current version before deleting (so user can switch back later)
            crate::mods::cache_mod_version(
                disk_mod,
                if disk_mod.enabled { mods_path } else { disabled_path },
                cache_path,
            );

            // Try local cache first for true version mismatches. For same-version
            // content drift the cache key (name + version) is ambiguous, so the
            // exact profile bundle is the only trustworthy restore source.
            if version_mismatch
                && crate::mods::get_cached_mod_path(cache_path, &pm.name, &pm.version).is_some()
            {
                let base = if disk_mod.enabled { mods_path } else { disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                match crate::mods::restore_mod_from_cache(cache_path, &pm.name, &pm.version, mods_path) {
                    Ok(()) => {
                        log::info!("Restored '{}' v{} from local cache", pm.name, pm.version);
                        downloaded_count += 1;
                        continue;
                    }
                    Err(e) => {
                        log::warn!("Cache restore failed for '{}': {} -- trying bundle", pm.name, e);
                    }
                }
            }

            // Try bundle_url next
            if pm.bundle_url.is_some() {
                let base = if disk_mod.enabled { mods_path } else { disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to the download logic below
            } else {
                log::info!(
                    "Mod '{}' differs from profile but has no bundle or cache -- keeping disk version",
                    pm.name
                );
                continue;
            }
        }

        log::info!("Mod '{}' needs download (missing or version mismatch)", pm.name);

        let mut downloaded = false;

        // Prefer bundle_url -- the curator bundled it because the GitHub
        // source may be wrong/unreliable (e.g., wrong game's repo)
        if let Some(ref bundle_url) = pm.bundle_url {
            log::info!("Downloading bundled mod '{}' from profiles repo", pm.name);
            match crate::sharing::download_bundle(bundle_url, &pm.name, mods_path).await {
                Ok(_) => {
                    log::info!("Installed bundled mod '{}'", pm.name);
                    downloaded_count += 1;
                    downloaded = true;
                }
                Err(e) => {
                    log::warn!("Bundle download failed for '{}': {} -- trying GitHub fallback", pm.name, e);
                }
            }
        }

        // Fallback: try GitHub source
        if !downloaded {
            let github_repo = pm.source.as_ref().and_then(|s| {
                if let Some(repo) = s.strip_prefix("github:") {
                    return Some(repo.to_string());
                }
                if s.contains("github.com/") {
                    let parts: Vec<&str> = s.split("github.com/").collect();
                    if parts.len() > 1 {
                        let repo_path = parts[1].trim_end_matches('/');
                        let segs: Vec<&str> = repo_path.splitn(3, '/').collect();
                        if segs.len() >= 2 {
                            return Some(format!("{}/{}", segs[0], segs[1]));
                        }
                    }
                }
                None
            }).or_else(|| {
                crate::mod_sources::lookup_entry(
                    &mod_sources_db.mods,
                    pm.folder_name.as_deref(),
                    &pm.name,
                    pm.mod_id.as_deref(),
                ).and_then(|e| e.github_repo.clone())
            });

            if let Some(repo) = github_repo {
                let parts: Vec<&str> = repo.splitn(2, '/').collect();
                if parts.len() == 2 {
                    match crate::download::download_and_install_github_mod(
                        parts[0], parts[1], None, mods_path, cache_path, token,
                    ).await {
                        Ok(info) => {
                            log::info!("Downloaded mod '{}' from GitHub", info.name);
                            downloaded_count += 1;
                            downloaded = true;
                        }
                        Err(e) => {
                            log::error!("GitHub download also failed for '{}': {}", pm.name, e);
                        }
                    }
                }
            }
        }

        if !downloaded {
            log::error!("No download source for mod '{}' -- cannot restore", pm.name);
            download_failures.push(pm.name.clone());
        }
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    apply_profile_with_pins(&profile, mods_path, disabled_path, &pinned_set)
        .map_err(|e| e.to_string())?;

    // ── STEP 3: Check what's still missing ──
    let final_on_disk: Vec<crate::mods::ModInfo> = scan_mods(mods_path)
        .into_iter()
        .chain(scan_disabled_mods(disabled_path).into_iter())
        .collect();
    // Build comprehensive identifier set (name, folder_name, mod_id)
    let mut final_identifiers: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in &final_on_disk {
        final_identifiers.insert(m.name.clone());
        if let Some(ref folder) = m.folder_name {
            final_identifiers.insert(folder.clone());
        }
        if let Some(ref id) = m.mod_id {
            final_identifiers.insert(id.clone());
        }
    }
    let still_missing: Vec<String> = profile.mods.iter()
        .filter(|pm| {
            !final_identifiers.contains(&pm.name)
                && !pm.folder_name.as_ref().map_or(false, |f| final_identifiers.contains(f))
                && !pm.mod_id.as_ref().map_or(false, |id| final_identifiers.contains(id))
        })
        .map(|pm| pm.name.clone())
        .collect();

    Ok(SwitchProfileResult {
        applied: true,
        missing_mods: still_missing,
        downloaded: downloaded_count,
        failed_downloads: download_failures,
    })
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
        let disabled = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
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

/// Result of switching profiles, including download stats and any mods that couldn't be restored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchProfileResult {
    pub applied: bool,
    pub missing_mods: Vec<String>,
    pub downloaded: u32,
    pub failed_downloads: Vec<String>,
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

// ── Profile drift detection ────────────────────────────────────────────────

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

#[tauri::command]
pub fn get_profile_drift(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ProfileDrift, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    let profile = load_profile(&name, &s.profiles_path).map_err(|e| e.to_string())?;

    Ok(compute_profile_drift(&profile, mods_path, disabled_path))
}

fn compute_profile_drift(profile: &Profile, mods_path: &Path, disabled_path: &Path) -> ProfileDrift {
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

async fn repair_profile_from_paths(
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
        profile_keys.insert(mod_key(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref()));
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

#[tauri::command]
pub async fn repair_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<RepairProfileResult, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
        let disabled = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods, disabled, profiles, config, cache, token)
    };

    let result = repair_profile_from_paths(
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
mod snapshot_metadata_tests {
    use super::*;

    #[test]
    fn explicit_snapshot_preserves_existing_link_and_version_when_scan_is_sparse() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        let now = chrono::Utc::now();
        save_profile(
            &Profile {
                name: "Active Pack".into(),
                game_version: Some("0.105.0".into()),
                created_by: Some("alice".into()),
                mods: vec![ProfileMod {
                    name: "BaseLib".into(),
                    version: "v3.1.2".into(),
                    source: Some("github:Alchyr/STS2-BaseLib".into()),
                    hash: Some("known-hash".into()),
                    files: vec![
                        "BaseLib/BaseLib.json".into(),
                        "BaseLib/BaseLib.dll".into(),
                    ],
                    folder_name: Some("BaseLib".into()),
                    mod_id: Some("baselib".into()),
                    enabled: true,
                    bundle_url: Some("https://example.test/bundles/BaseLib.zip".into()),
                    bundle_sha256: Some("known-sha".into()),
                }],
                created_at: now,
                updated_at: now,
                public: Some(true),
            },
            &profiles_path,
        )
        .unwrap();

        let mod_dir = mods_path.join("BaseLib");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(mod_dir.join("BaseLib.dll"), b"dll-only fallback").unwrap();

        let snapshot = snapshot_current_with_paths(
            "Active Pack",
            &mods_path,
            &disabled_path,
            &profiles_path,
            None,
            Some("0.105.0"),
        )
        .unwrap();

        assert_eq!(snapshot.mods.len(), 1);
        let mod_entry = &snapshot.mods[0];
        assert_eq!(mod_entry.name, "BaseLib");
        assert_eq!(
            mod_entry.version, "v3.1.2",
            "a sparse disk scan must not downgrade a known profile version to unknown"
        );
        assert_eq!(
            mod_entry.source.as_deref(),
            Some("github:Alchyr/STS2-BaseLib"),
            "linked source metadata should survive explicit snapshots when disk has no source"
        );
        assert_eq!(mod_entry.mod_id.as_deref(), Some("baselib"));
        assert_eq!(
            mod_entry.bundle_url.as_deref(),
            Some("https://example.test/bundles/BaseLib.zip")
        );
        assert_eq!(mod_entry.bundle_sha256.as_deref(), Some("known-sha"));
    }

    #[test]
    fn new_local_snapshot_does_not_attribute_profile_to_the_app() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        let mod_dir = mods_path.join("LocalMod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(
            mod_dir.join("LocalMod.json"),
            br#"{"name":"LocalMod","version":"1.0.0"}"#,
        )
        .unwrap();

        let snapshot = snapshot_current_with_paths(
            "Local Pack",
            &mods_path,
            &disabled_path,
            &profiles_path,
            None,
            None,
        )
        .unwrap();

        assert_eq!(snapshot.created_by, None);
    }
}

#[cfg(test)]
mod pinned_download_tests {
    use super::*;

    fn profile_mod() -> ProfileMod {
        ProfileMod {
            name: "Unified Save Path".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: Vec::new(),
            folder_name: Some("UnifiedSavePath".into()),
            mod_id: Some("UnifiedSavePath".into()),
            enabled: true,
            bundle_url: Some("https://example.test/UnifiedSavePath.zip".into()),
            bundle_sha256: None,
        }
    }

    fn disk_mod() -> crate::mods::ModInfo {
        crate::mods::ModInfo {
            name: "Unified Save Path".into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec!["UnifiedSavePath/UnifiedSavePath.dll".into()],
            source: None,
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            folder_name: Some("UnifiedSavePath".into()),
            mod_id: Some("UnifiedSavePath".into()),
            github_url: None,
            nexus_url: None,
            pinned: true,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
        }
    }

    #[test]
    fn pinned_missing_profile_mod_must_still_download() {
        let pm = profile_mod();
        let pinned = std::collections::HashSet::from(["UnifiedSavePath".to_string()]);

        assert!(
            !should_skip_pinned_profile_mod_download(&pm, None, &pinned),
            "pinning preserves an installed mod, but a deleted pinned mod still needs to be restored"
        );
    }

    #[test]
    fn pinned_installed_profile_mod_skips_replacement() {
        let pm = profile_mod();
        let disk = disk_mod();
        let pinned = std::collections::HashSet::from(["UnifiedSavePath".to_string()]);

        assert!(
            should_skip_pinned_profile_mod_download(&pm, Some(&disk), &pinned),
            "an installed pinned mod should keep its local files/version"
        );
    }
}

#[cfg(test)]
mod modpack_flow_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;
    use std::io::Write as _;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use zip::write::SimpleFileOptions;

    struct FlowPaths {
        _game: tempfile::TempDir,
        _config: tempfile::TempDir,
        _cache: tempfile::TempDir,
        mods: std::path::PathBuf,
        disabled: std::path::PathBuf,
        profiles: std::path::PathBuf,
        config: std::path::PathBuf,
        cache: std::path::PathBuf,
    }

    struct PublishedMod {
        profile_mod: ProfileMod,
    }

    fn flow_paths() -> FlowPaths {
        let game = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mods = game.path().join("mods");
        let disabled = game.path().join("mods_disabled");
        let profiles = config.path().join("profiles");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();
        fs::create_dir_all(&profiles).unwrap();

        FlowPaths {
            mods,
            disabled,
            profiles,
            config: config.path().to_path_buf(),
            cache: cache.path().to_path_buf(),
            _game: game,
            _config: config,
            _cache: cache,
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    fn bundle_zip(
        folder: &str,
        mod_id: &str,
        display_name: &str,
        version: &str,
        marker: &str,
    ) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let manifest = format!(
            r#"{{
  "id": "{mod_id}",
  "name": "{display_name}",
  "author": "QA",
  "version": "{version}",
  "has_dll": true,
  "has_pck": true,
  "dependencies": []
}}"#
        );
        zw.start_file(format!("{folder}/{folder}.json"), opts).unwrap();
        zw.write_all(manifest.as_bytes()).unwrap();
        zw.start_file(format!("{folder}/{folder}.dll"), opts).unwrap();
        zw.write_all(marker.as_bytes()).unwrap();
        zw.start_file(format!("{folder}/{folder}.pck"), opts).unwrap();
        zw.write_all(format!("pck:{marker}").as_bytes()).unwrap();
        zw.start_file(format!("{folder}/config/settings.cfg"), opts).unwrap();
        zw.write_all(format!("setting={marker}").as_bytes()).unwrap();
        zw.finish().unwrap().into_inner()
    }

    async fn publish_mod(
        server: &MockServer,
        path_name: &str,
        folder: &str,
        mod_id: &str,
        display_name: &str,
        version: &str,
        marker: &str,
        enabled: bool,
        source: Option<&str>,
    ) -> PublishedMod {
        let zip = bundle_zip(folder, mod_id, display_name, version, marker);
        Mock::given(method("GET"))
            .and(path(path_name))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip.clone()))
            .mount(server)
            .await;
        let dll_hash = sha256_hex(marker.as_bytes());
        PublishedMod {
            profile_mod: ProfileMod {
                name: display_name.into(),
                version: version.into(),
                source: source.map(str::to_string),
                hash: Some(dll_hash),
                files: vec![
                    format!("{folder}/{folder}.json"),
                    format!("{folder}/{folder}.dll"),
                    format!("{folder}/{folder}.pck"),
                    format!("{folder}/config/settings.cfg"),
                ],
                folder_name: Some(folder.into()),
                mod_id: Some(mod_id.into()),
                enabled,
                bundle_url: Some(format!("{}{}", server.uri(), path_name)),
                bundle_sha256: Some(sha256_hex(&zip)),
            },
        }
    }

    fn save_pack(name: &str, profiles: &Path, mods: Vec<PublishedMod>) -> Profile {
        let now = chrono::Utc::now();
        let profile = Profile {
            name: name.into(),
            game_version: Some("0.105.0".into()),
            created_by: Some("qa-curator".into()),
            mods: mods.into_iter().map(|m| m.profile_mod).collect(),
            created_at: now,
            updated_at: now,
            public: Some(false),
        };
        save_profile(&profile, profiles).unwrap();
        profile
    }

    fn clear_mod_dirs(paths: &FlowPaths) {
        for dir in [&paths.mods, &paths.disabled] {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    fs::remove_dir_all(path).unwrap();
                } else {
                    fs::remove_file(path).unwrap();
                }
            }
        }
    }

    fn folder_names(root: &Path) -> HashSet<String> {
        fs::read_dir(root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect()
    }

    fn assert_enabled(paths: &FlowPaths, expected: &[&str]) {
        let actual = folder_names(&paths.mods);
        let expected: HashSet<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(actual, expected, "enabled mods folder mismatch");
    }

    fn assert_disabled_contains(paths: &FlowPaths, expected: &[&str]) {
        let actual = folder_names(&paths.disabled);
        for name in expected {
            assert!(
                actual.contains(*name),
                "expected disabled folder to contain {name}; actual={actual:?}"
            );
        }
    }

    fn assert_marker(root: &Path, folder: &str, marker: &str) {
        let dll = root.join(folder).join(format!("{folder}.dll"));
        let pck = root.join(folder).join(format!("{folder}.pck"));
        let cfg = root.join(folder).join("config").join("settings.cfg");
        assert_eq!(fs::read_to_string(&dll).unwrap(), marker, "wrong DLL marker for {folder}");
        assert_eq!(
            fs::read_to_string(&pck).unwrap(),
            format!("pck:{marker}"),
            "wrong PCK marker for {folder}"
        );
        assert_eq!(
            fs::read_to_string(&cfg).unwrap(),
            format!("setting={marker}"),
            "wrong config marker for {folder}"
        );
    }

    fn assert_no_root_artifacts(paths: &FlowPaths) {
        let game_root = paths.mods.parent().unwrap();
        let direct_children: HashSet<String> = fs::read_dir(game_root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            direct_children,
            HashSet::from(["mods".to_string(), "mods_disabled".to_string()]),
            "unexpected files/folders next to the mods folders"
        );

        for root in [&paths.mods, &paths.disabled] {
            for entry in fs::read_dir(root).unwrap().flatten() {
                assert!(
                    entry.path().is_dir(),
                    "bundle extraction left a loose file at {}",
                    entry.path().display()
                );
            }
        }
    }

    fn install_loose_mod(root: &Path, folder: &str, marker: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{folder}.json")),
            format!(r#"{{"id":"{folder}","name":"{folder}","version":"1.0.0","author":"QA"}}"#),
        )
        .unwrap();
        fs::write(dir.join(format!("{folder}.dll")), marker).unwrap();
    }

    #[tokio::test]
    async fn delete_repair_and_a_b_switches_restore_exact_bundles_without_artifacts() {
        let paths = flow_paths();
        let server = MockServer::start().await;

        save_pack(
            "Pack A",
            &paths.profiles,
            vec![
                publish_mod(&server, "/a/shared.zip", "SharedCore", "SharedCore", "Shared Core", "1.0.0", "shared-from-a", true, Some("github:qa/shared")).await,
                publish_mod(&server, "/a/alpha.zip", "AlphaOnly", "AlphaOnly", "Alpha Only", "1.0.0", "alpha", true, None).await,
                publish_mod(&server, "/a/disabled.zip", "AlphaDisabled", "AlphaDisabled", "Alpha Disabled", "1.0.0", "alpha-disabled", false, None).await,
                publish_mod(&server, "/a/same.zip", "SameInBoth", "SameInBoth", "Same In Both", "1.0.0", "same", true, Some("github:qa/same")).await,
            ],
        );
        save_pack(
            "Pack B",
            &paths.profiles,
            vec![
                publish_mod(&server, "/b/shared.zip", "SharedCore", "SharedCore", "Shared Core", "1.0.0", "shared-from-b", true, Some("github:qa/shared")).await,
                publish_mod(&server, "/b/beta.zip", "BetaOnly", "BetaOnly", "Beta Only", "1.0.0", "beta", true, None).await,
                publish_mod(&server, "/b/disabled.zip", "BetaDisabled", "BetaDisabled", "Beta Disabled", "1.0.0", "beta-disabled", false, None).await,
                publish_mod(&server, "/b/same.zip", "SameInBoth", "SameInBoth", "Same In Both", "1.0.0", "same", true, Some("github:qa/same")).await,
            ],
        );

        clear_mod_dirs(&paths);
        let repair_a = repair_profile_from_paths(
            "Pack A",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert!(repair_a.missing_mods.is_empty(), "repair A missing mods: {:?}", repair_a.missing_mods);
        assert!(repair_a.failed_downloads.is_empty(), "repair A failed downloads: {:?}", repair_a.failed_downloads);
        assert_enabled(&paths, &["SharedCore", "AlphaOnly", "SameInBoth"]);
        assert_disabled_contains(&paths, &["AlphaDisabled"]);
        assert_marker(&paths.mods, "SharedCore", "shared-from-a");
        assert_no_root_artifacts(&paths);

        let switch_b = switch_profile_from_paths(
            "Pack B",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert!(switch_b.missing_mods.is_empty(), "switch B missing mods: {:?}", switch_b.missing_mods);
        assert!(switch_b.failed_downloads.is_empty(), "switch B failed downloads: {:?}", switch_b.failed_downloads);
        assert_enabled(&paths, &["SharedCore", "BetaOnly", "SameInBoth"]);
        assert_disabled_contains(&paths, &["AlphaOnly", "AlphaDisabled", "BetaDisabled"]);
        assert_marker(&paths.mods, "SharedCore", "shared-from-b");
        assert_no_root_artifacts(&paths);

        let switch_a = switch_profile_from_paths(
            "Pack A",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert!(switch_a.missing_mods.is_empty(), "switch A missing mods: {:?}", switch_a.missing_mods);
        assert!(switch_a.failed_downloads.is_empty(), "switch A failed downloads: {:?}", switch_a.failed_downloads);
        assert_enabled(&paths, &["SharedCore", "AlphaOnly", "SameInBoth"]);
        assert_disabled_contains(&paths, &["BetaOnly", "BetaDisabled", "AlphaDisabled"]);
        assert_marker(&paths.mods, "SharedCore", "shared-from-a");
        assert_no_root_artifacts(&paths);

        clear_mod_dirs(&paths);
        let repair_b = repair_profile_from_paths(
            "Pack B",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert!(repair_b.missing_mods.is_empty(), "repair B missing mods: {:?}", repair_b.missing_mods);
        assert!(repair_b.failed_downloads.is_empty(), "repair B failed downloads: {:?}", repair_b.failed_downloads);
        assert_enabled(&paths, &["SharedCore", "BetaOnly", "SameInBoth"]);
        assert_eq!(folder_names(&paths.disabled), HashSet::from(["BetaDisabled".to_string()]));
        assert_marker(&paths.mods, "SharedCore", "shared-from-b");
        assert_no_root_artifacts(&paths);
    }

    #[tokio::test]
    async fn pinned_installed_mod_is_preserved_but_deleted_pinned_mod_restores_from_manifest() {
        let paths = flow_paths();
        let server = MockServer::start().await;

        save_pack(
            "Pack A",
            &paths.profiles,
            vec![publish_mod(&server, "/pin/a.zip", "PinnedShared", "PinnedShared", "Pinned Shared", "1.0.0", "pinned-a", true, None).await],
        );
        save_pack(
            "Pack B",
            &paths.profiles,
            vec![
                publish_mod(&server, "/pin/b.zip", "PinnedShared", "PinnedShared", "Pinned Shared", "1.0.0", "pinned-b", true, None).await,
                publish_mod(&server, "/pin/beta.zip", "PinnedBeta", "PinnedBeta", "Pinned Beta", "1.0.0", "pinned-beta", true, None).await,
            ],
        );
        crate::mod_sources::save_sources(
            &crate::mod_sources::ModSourcesDb {
                mods: std::collections::HashMap::from([(
                    "PinnedShared".into(),
                    crate::mod_sources::ModSourceEntry {
                        pinned: true,
                        ..Default::default()
                    },
                )]),
            },
            &paths.config,
        )
        .unwrap();

        clear_mod_dirs(&paths);
        repair_profile_from_paths(
            "Pack A",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert_marker(&paths.mods, "PinnedShared", "pinned-a");

        switch_profile_from_paths(
            "Pack B",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert_enabled(&paths, &["PinnedShared", "PinnedBeta"]);
        assert_marker(&paths.mods, "PinnedShared", "pinned-a");
        assert_marker(&paths.mods, "PinnedBeta", "pinned-beta");

        clear_mod_dirs(&paths);
        let repair_b = repair_profile_from_paths(
            "Pack B",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();
        assert!(repair_b.missing_mods.is_empty(), "repair B missing mods: {:?}", repair_b.missing_mods);
        assert_enabled(&paths, &["PinnedShared", "PinnedBeta"]);
        assert_marker(&paths.mods, "PinnedShared", "pinned-b");
    }

    #[tokio::test]
    async fn repair_disables_unpinned_orphans_and_preserves_pinned_user_mods() {
        let paths = flow_paths();
        let server = MockServer::start().await;

        save_pack(
            "Clean Pack",
            &paths.profiles,
            vec![publish_mod(&server, "/clean/main.zip", "CleanMain", "CleanMain", "Clean Main", "1.0.0", "clean", true, None).await],
        );
        install_loose_mod(&paths.mods, "PinnedExtra", "pinned-extra");
        install_loose_mod(&paths.mods, "UnpinnedExtra", "unpinned-extra");
        crate::mod_sources::save_sources(
            &crate::mod_sources::ModSourcesDb {
                mods: std::collections::HashMap::from([(
                    "PinnedExtra".into(),
                    crate::mod_sources::ModSourceEntry {
                        pinned: true,
                        ..Default::default()
                    },
                )]),
            },
            &paths.config,
        )
        .unwrap();

        let repair = repair_profile_from_paths(
            "Clean Pack",
            &paths.mods,
            &paths.disabled,
            &paths.profiles,
            &paths.config,
            &paths.cache,
            None,
        )
        .await
        .unwrap();

        assert!(
            repair.disabled_orphans.contains(&"UnpinnedExtra".to_string()),
            "repair should report ordinary orphan mods that were moved out of the active folder"
        );
        assert!(
            !repair.disabled_orphans.contains(&"PinnedExtra".to_string()),
            "repair should not delete pinned user-owned mods"
        );
        assert!(paths.mods.join("PinnedExtra").join("PinnedExtra.dll").exists());
        assert!(!paths.mods.join("UnpinnedExtra").exists());
        assert!(paths.disabled.join("UnpinnedExtra").join("UnpinnedExtra.dll").exists());
    }

    #[test]
    fn drift_ignores_disabled_mods_that_are_not_part_of_the_profile() {
        let paths = flow_paths();
        let profile = save_pack("Drift Pack", &paths.profiles, vec![]);
        install_loose_mod(&paths.disabled, "LibraryOnly", "disabled-library");

        let drift = compute_profile_drift(&profile, &paths.mods, &paths.disabled);

        assert!(
            !drift.added.contains(&"LibraryOnly".to_string()),
            "disabled library mods should not count as active profile drift"
        );
        assert!(!drift.has_drift, "disabled library extras should not keep the Repair banner alive");
    }
}
