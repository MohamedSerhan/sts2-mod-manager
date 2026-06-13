use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::mods::{merge_active_disabled_mods, scan_disabled_mods, scan_mods, ModInfo};
use crate::profiles::{Profile, ProfileMod};
use crate::state::AppState;

// ── Submodules ─────────────────────────────────────────────────────────────
//
// `sharing` was a 4.6k-line single file. The full split now lives across
// three focused sub-modules:
//
//   - `code`   — pure share-code parsing/validation, asset-filename
//                construction (no I/O, no async).
//   - `github` — every reqwest call: client builder, Contents API,
//                Releases API, asset upload/delete/replace, paginated
//                listing, GC sweep, anonymous + authenticated profile
//                fetch, and bundle download.
//   - `upload` — sync asset bundling (zip walking, path-safety),
//                pre-publish validation, on-failure profile restore.
//
// This file is now just the Tauri-command orchestrators + the small
// helpers they share (`ShareGuard`, `ShareResult`, `ShareInfo`, the
// identity-key filters used by the publish-compatibility check).
// Re-exports below preserve the `crate::sharing::function_name` import
// surface the rest of the codebase + integration tests rely on.
mod code;
mod github;
pub mod install;
mod upload;

use code::{code_to_filename, format_code, generate_code, parse_share_code};
// Low-level GitHub plumbing — the release-asset upload retry/recovery
// layer and the orchestration helpers used by share/reshare/install.
pub(crate) use github::build_client;
use github::{
    cleanup_orphan_bundle_assets as github_cleanup_orphan_bundle_assets,
    download_bundle as github_download_bundle, ensure_profiles_repo as github_ensure_profiles_repo,
    fetch_shared_profile as github_fetch_shared_profile, get_github_username,
    upload_mod_bundle_file_via_release_with_cancel as github_upload_mod_bundle_file_via_release_with_cancel,
    upload_mod_bundle_via_release as github_upload_mod_bundle_via_release,
    upsert_file as github_upsert_file,
};
// Asset-bundling helpers — sync filesystem walk + zip encoding +
// pre-publish validation. `zip_mod_files` is not imported here
// directly — orchestration always goes through `zip_profile_mod_files`
// (which has the enabled-vs-disabled-path fallback baked in), so the
// raw `zip_mod_files` lives in `upload.rs` as an implementation detail.
use upload::{ensure_profile_publish_complete, restore_profile_after_failed_publish};
pub(crate) use upload::{
    fingerprint_profile_mod_file_metadata, fingerprint_profile_mod_file_metadata_with_cancel,
    fingerprint_profile_mod_files, fingerprint_profile_mod_files_with_cancel,
    zip_profile_mod_files, zip_profile_mod_files_to_tempfile,
    zip_profile_mod_files_to_tempfile_with_cancel,
};

/// One mod skipped during a modpack install because it declared a
/// `min_game_version` higher than the user's STS2 build. Surfaced in
/// the `modpack-mods-skipped` Tauri event so the frontend can toast
/// "Skipped 1: Show Player Hand Cards needs game v0.105.0; you have v0.103.2".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedMod {
    pub mod_name: String,
    pub min_game_version: String,
    pub user_game_version: String,
}

/// In-flight guard so a double-click on Share / Re-share for the same profile
/// can't kick off two concurrent uploads that race against the same gist files
/// (which previously produced 409 SHA-mismatch storms on GitHub's API).
/// Holds the lock for the duration of the share/reshare; the Drop impl frees it
/// even if the operation errors out.
struct ShareGuard {
    state: AppState,
    name: String,
}

impl ShareGuard {
    fn try_acquire(state: &AppState, name: &str) -> std::result::Result<Self, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        if !s.sharing_in_flight.insert(name.to_string()) {
            return Err(format!(
                "A share for '{}' is already in progress -- please wait for it to finish.",
                name
            ));
        }
        s.sharing_cancel_requested.remove(name);
        Ok(Self {
            state: state.clone(),
            name: name.to_string(),
        })
    }
}

impl Drop for ShareGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            s.sharing_in_flight.remove(&self.name);
            s.sharing_cancel_requested.remove(&self.name);
        }
    }
}

fn sharing_cancel_requested(state: &AppState, name: &str) -> bool {
    state
        .lock()
        .map(|s| s.sharing_cancel_requested.contains(name))
        .unwrap_or(false)
}

fn is_sharing_canceled_error(error: &crate::error::AppError) -> bool {
    error.to_string().contains("Sharing canceled")
}

// ── Types ───────────────────────────────────────────────────────────────────

const PROFILES_REPO: &str = "sts2mm-profiles";
const APP_CREATED_BY: &str = "sts2-mod-manager";

/// Schema/quality version of the share format a `.share` record was last
/// published under. Bump this whenever a fix makes *re-publishing* an
/// existing pack produce a materially better manifest, so the UI can nudge
/// curators to re-share. A `.share` file whose stored version is below this
/// (or absent, i.e. published before the field existed) is "stale".
///
/// History:
///   1 — pre-versioned shares (implicit; never written, only inferred).
///   2 — source links are now backfilled from the curator's mod_sources.json
///       at publish time, so re-sharing links mods that previously imported
///       as "Unlinked". Packs shared before this need a re-share to benefit.
pub const SHARE_FORMAT_VERSION: u32 = 2;

fn profiles_repo() -> String {
    #[cfg(test)]
    {
        std::env::var("STS2_PROFILES_REPO").unwrap_or_else(|_| PROFILES_REPO.to_string())
    }
    #[cfg(not(test))]
    {
        PROFILES_REPO.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareResult {
    /// The profile code (e.g. "AA5A-315D-61AE")
    pub code: String,
    /// The GitHub username who shared it
    pub owner: String,
    /// The raw file path in the repo
    pub file_path: String,
    /// The URL to view the profile manifest on GitHub
    pub url: String,
    /// URL of the `sts2mm-profiles` repo the manager auto-created (or
    /// re-used) on the curator's GitHub. Surfaced in the success state
    /// so the curator knows exactly which repo holds their published
    /// pack — they can visit it to make it private, delete it, or
    /// just confirm it exists.
    pub repo_url: String,
    /// Names of mods whose bundle upload to the profiles repo failed.
    /// Friends installing this share code will see "missing mod" entries
    /// for these. The frontend surfaces them in a toast so the curator
    /// can retry instead of finding out from a confused friend later.
    #[serde(default)]
    pub failed_uploads: Vec<String>,
    /// True when this pack was last published under an older share format
    /// than the app now produces, so re-sharing would improve it (e.g. add
    /// source links the old manifest lacked). Drives the "Re-share
    /// recommended" nudge in the Profiles view. Only ever set by
    /// `get_share_info` (the status read); a fresh share/reshare result
    /// leaves it false since it's already current.
    #[serde(default)]
    pub reshare_recommended: bool,
    /// True when the local manifest differs from what was last published
    /// (owned shares only). Drives the "Out of sync -- Re-share" banner.
    /// Only set by `get_share_info`; fresh share/reshare leaves it false.
    #[serde(default)]
    pub out_of_sync: bool,
}

pub(crate) fn attribute_profile_to_owner(mut profile: Profile, owner: &str) -> Profile {
    let owner = owner.trim();
    if !owner.is_empty() {
        profile.created_by = Some(owner.to_string());
    } else if profile.created_by.as_deref() == Some(APP_CREATED_BY) {
        profile.created_by = None;
    }
    profile
}

/// Local share info stored per profile for re-sharing
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareInfo {
    code: String,
    /// GitHub username who owns the profiles repo
    owner: String,
    /// SHA of the file in the repo (needed for updates)
    file_sha: Option<String>,
    /// Share format version this pack was last published under. Absent in
    /// `.share` files written before the field existed — `serde(default)`
    /// makes those deserialize as 0, which is correctly treated as "older
    /// than current" so they get a re-share nudge.
    #[serde(default)]
    share_format_version: u32,
    /// Fingerprint of the publishable content at last share/re-share.
    /// Lets the UI detect "this owned share has changes not yet pushed".
    /// Absent in `.share` files written before this field existed.
    #[serde(default)]
    published_signature: Option<String>,
    /// Per-mod content fingerprints from the last successful publish.
    /// Legacy strong fingerprints from the last successful publish. Used
    /// as a migration fallback for sidecars written before the fast metadata
    /// map existed.
    #[serde(default)]
    bundle_source_fingerprints: HashMap<String, String>,
    /// Per-mod metadata fingerprints from the last successful publish.
    /// The normal unchanged-bundle skip path reads only paths, sizes, and
    /// modified timestamps instead of hashing and zipping large mod files.
    #[serde(default)]
    bundle_source_fast_fingerprints: HashMap<String, String>,
}

fn save_share_info(path: &Path, info: &ShareInfo) -> Result<()> {
    let json = serde_json::to_vec_pretty(info)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let mut temp = tempfile::Builder::new()
        .prefix(".share-info-")
        .tempfile_in(dir)?;
    temp.write_all(&json)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn load_share_info(path: &Path) -> Result<ShareInfo> {
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn share_info_path_for_profile(profile: &Profile, profiles_path: &Path) -> PathBuf {
    profiles_path.join(format!(
        "{}.share",
        crate::profiles::profile_file_stem(profile)
    ))
}

fn legacy_profile_name_stem(name: &str) -> String {
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

fn find_share_info_path(name: &str, profiles_path: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(profile) = crate::profiles::load_profile(name, profiles_path) {
        candidates.push(share_info_path_for_profile(&profile, profiles_path));
        candidates.push(profiles_path.join(format!("{}.share", profile.name)));
    }
    candidates.push(profiles_path.join(format!("{}.share", legacy_profile_name_stem(name))));
    candidates.push(profiles_path.join(format!("{}.share", name)));
    candidates.into_iter().find(|path| path.exists())
}

fn recover_owned_share_info_sidecar(
    _profile_name: &str,
    profiles_path: &Path,
    owner: &str,
    profile_code: &str,
    published_profile: &Profile,
) -> Result<ShareInfo> {
    let info = ShareInfo {
        code: format_code(profile_code),
        owner: owner.to_string(),
        file_sha: None,
        share_format_version: SHARE_FORMAT_VERSION,
        published_signature: Some(profile_publish_signature(published_profile)),
        bundle_source_fingerprints: HashMap::new(),
        bundle_source_fast_fingerprints: HashMap::new(),
    };
    let share_info_path = share_info_path_for_profile(published_profile, profiles_path);
    save_share_info(&share_info_path, &info)?;
    Ok(info)
}

pub(super) fn recover_owned_share_info_sidecar_for_install(
    profile_name: &str,
    profiles_path: &Path,
    owner: &str,
    profile_code: &str,
    published_profile: &Profile,
) -> Result<()> {
    recover_owned_share_info_sidecar(
        profile_name,
        profiles_path,
        owner,
        profile_code,
        published_profile,
    )
    .map(|_| ())
}

fn parse_subscription_owner_and_code(
    sub: &crate::subscriptions::Subscription,
) -> Option<(String, String)> {
    if let Some((owner, code)) = sub.share_id.split_once(':') {
        if let Ok((owner, code)) = parse_share_code(&format!("{}/{}", owner.trim(), code.trim())) {
            return Some((owner, format_code(&code)));
        }
    }

    parse_share_code(&sub.share_url)
        .ok()
        .map(|(owner, code)| (owner, format_code(&code)))
}

async fn recover_owned_share_info_from_subscription(
    profile_name: &str,
    profiles_path: &Path,
    config_path: &Path,
    token: Option<&str>,
) -> Option<ShareInfo> {
    let token = token?;
    let db = crate::subscriptions::load_subscriptions(config_path);
    let candidates: Vec<_> = db
        .subscriptions
        .values()
        .filter(|sub| sub.profile_name.eq_ignore_ascii_case(profile_name))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let username = match get_github_username(token).await {
        Ok(username) => username,
        Err(e) => {
            log::warn!(
                "get_share_info: cannot recover ownership metadata for '{}': {}",
                profile_name,
                e
            );
            return None;
        }
    };

    for sub in candidates {
        let Some((owner, profile_code)) = parse_subscription_owner_and_code(sub) else {
            continue;
        };
        if !owner.eq_ignore_ascii_case(&username) {
            continue;
        }

        let filename = code_to_filename(&profile_code);
        let published_profile = match fetch_shared_profile(&owner, &filename, Some(token)).await {
            Ok(profile) => profile,
            Err(e) => {
                log::warn!(
                    "get_share_info: cannot fetch owned subscribed manifest '{}' for '{}': {}",
                    filename,
                    profile_name,
                    e
                );
                continue;
            }
        };

        match recover_owned_share_info_sidecar(
            profile_name,
            profiles_path,
            &owner,
            &profile_code,
            &published_profile,
        ) {
            Ok(info) => {
                log::info!(
                    "get_share_info: recovered ownership metadata for '{}' from subscription '{}'",
                    profile_name,
                    sub.share_id
                );
                return Some(info);
            }
            Err(e) => {
                log::warn!(
                    "get_share_info: failed to save recovered ownership metadata for '{}': {}",
                    profile_name,
                    e
                );
                return None;
            }
        }
    }

    None
}

/// Per-step status emitted to the frontend while a share / re-share is
/// running. Lets the PublishModal show "Bundling mod 5 of 20…" instead
/// of an opaque "Publishing…" spinner — bundling 20 mods of any real
/// size takes minutes, and the old UI gave the curator no way to tell
/// the app from a hang.
#[derive(Debug, Serialize, Clone)]
pub(super) struct ShareProgress {
    profile_name: String,
    /// "checking-bundle" while fingerprinting mod files, "bundling"
    /// while building/uploading mod zips, "uploading-manifest" while
    /// PUTting the profile JSON, and "done" right before success resolves.
    /// Frontend doesn't have to render all of them but a stable vocabulary
    /// makes future additions cheap.
    stage: &'static str,
    /// 1-indexed position within the current stage. 0 when irrelevant.
    current: usize,
    /// Total work units in the current stage. 0 when irrelevant.
    total: usize,
    /// Mod name when stage == "bundling".
    mod_name: Option<String>,
}

fn build_repo_url(owner: &str) -> String {
    format!("https://github.com/{}/{}", owner, profiles_repo())
}

// ── Public Wrappers Around github::* Helpers ───────────────────────────────
//
// The github module is split-aware: every function that talks to GitHub
// takes the repo name explicitly so it doesn't have to know about the
// `STS2_PROFILES_REPO` env-var indirection. This file wires the repo
// name in by calling `profiles_repo()` (which honors the test env var)
// before delegating. Doing it here keeps test plumbing in one place.

async fn ensure_profiles_repo(token: &str, username: &str) -> Result<()> {
    github_ensure_profiles_repo(token, username, &profiles_repo()).await
}

pub(crate) async fn authenticated_github_username(token: &str) -> Result<String> {
    get_github_username(token).await
}

async fn upsert_file(
    token: &str,
    username: &str,
    filename: &str,
    content: &str,
    existing_sha: Option<&str>,
    message: &str,
) -> Result<(String, String)> {
    github_upsert_file(
        token,
        username,
        &profiles_repo(),
        filename,
        content,
        existing_sha,
        message,
    )
    .await
}

#[allow(dead_code)]
pub(crate) async fn upload_mod_bundle_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_data: &[u8],
    prior_sha256: Option<&str>,
) -> Result<(String, String)> {
    github_upload_mod_bundle_via_release(
        token,
        username,
        mod_name,
        version,
        zip_data,
        prior_sha256,
        &profiles_repo(),
    )
    .await
}

#[allow(dead_code)]
pub(crate) async fn upload_mod_bundle_file_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_path: &Path,
    prior_sha256: Option<&str>,
) -> Result<(String, String)> {
    upload_mod_bundle_file_via_release_with_cancel(
        token,
        username,
        mod_name,
        version,
        zip_path,
        prior_sha256,
        None,
    )
    .await
}

pub(crate) async fn upload_mod_bundle_file_via_release_with_cancel(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_path: &Path,
    prior_sha256: Option<&str>,
    cancel_requested: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<(String, String)> {
    github_upload_mod_bundle_file_via_release_with_cancel(
        token,
        username,
        mod_name,
        version,
        zip_path,
        prior_sha256,
        &profiles_repo(),
        cancel_requested,
    )
    .await
}

pub(crate) async fn cleanup_orphan_bundle_assets(token: &str, owner: &str) -> Result<usize> {
    github_cleanup_orphan_bundle_assets(token, owner, &profiles_repo()).await
}

/// Download a bundled mod zip from a URL and extract into mods_path.
pub async fn download_bundle(
    url: &str,
    mod_name: &str,
    mods_path: &std::path::Path,
    expected_sha256: Option<&str>,
) -> Result<()> {
    github_download_bundle(url, mod_name, mods_path, expected_sha256).await
}

/// Fetch a profile from any user's profiles repo.
pub async fn fetch_shared_profile(
    owner: &str,
    filename: &str,
    token: Option<&str>,
) -> Result<Profile> {
    github_fetch_shared_profile(owner, filename, token, &profiles_repo()).await
}

// ── Publish Helpers (identity matching for compatibility filter) ───────────

fn publish_identity_keys(
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

fn publish_strong_identity_keys(folder_name: Option<&str>, mod_id: Option<&str>) -> Vec<String> {
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

fn publish_keys_intersect(a: &[String], b: &[String]) -> bool {
    a.iter().any(|key| b.contains(key))
}

fn publish_profile_mod_matches_installed(pm: &ProfileMod, installed: &ModInfo) -> bool {
    let profile_strong =
        publish_strong_identity_keys(pm.folder_name.as_deref(), pm.mod_id.as_deref());
    let installed_strong = publish_strong_identity_keys(
        installed.folder_name.as_deref(),
        installed.mod_id.as_deref(),
    );

    if !profile_strong.is_empty() && !installed_strong.is_empty() {
        return publish_keys_intersect(&profile_strong, &installed_strong);
    }

    let profile_keys =
        publish_identity_keys(&pm.name, pm.folder_name.as_deref(), pm.mod_id.as_deref());
    let installed_keys = publish_identity_keys(
        &installed.name,
        installed.folder_name.as_deref(),
        installed.mod_id.as_deref(),
    );
    publish_keys_intersect(&profile_keys, &installed_keys)
}

/// Same identity-matching convention as `publish_profile_mod_matches_installed`,
/// but between two `ProfileMod`s -- used by `merge_publish_enrichment` to find
/// the on-disk profile entry corresponding to an uploaded (and possibly
/// filtered/refreshed) profile entry. Folder/mod_id ("strong" keys) win when
/// both sides have them; otherwise falls back to name/folder/mod_id keys.
fn publish_profile_mods_match(a: &ProfileMod, b: &ProfileMod) -> bool {
    let a_strong = publish_strong_identity_keys(a.folder_name.as_deref(), a.mod_id.as_deref());
    let b_strong = publish_strong_identity_keys(b.folder_name.as_deref(), b.mod_id.as_deref());

    if !a_strong.is_empty() && !b_strong.is_empty() {
        return publish_keys_intersect(&a_strong, &b_strong);
    }

    let a_keys = publish_identity_keys(&a.name, a.folder_name.as_deref(), a.mod_id.as_deref());
    let b_keys = publish_identity_keys(&b.name, b.folder_name.as_deref(), b.mod_id.as_deref());
    publish_keys_intersect(&a_keys, &b_keys)
}

fn bundle_source_fingerprint_key(pm: &ProfileMod) -> String {
    if let Some(mod_id) = pm
        .mod_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return format!("mod_id:{}", mod_id.to_lowercase());
    }
    if let Some(folder) = pm
        .folder_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return format!("folder:{}", folder.to_lowercase());
    }
    format!("name:{}", pm.name.trim().to_lowercase())
}

fn bundle_source_fingerprint_value(pm: &ProfileMod, file_fingerprint: &str) -> String {
    format!("v1:{}:{}", pm.version.trim(), file_fingerprint)
}

fn bundle_source_fast_fingerprint_value(pm: &ProfileMod, file_fingerprint: &str) -> String {
    format!("v1-meta:{}:{}", pm.version.trim(), file_fingerprint)
}

fn existing_bundle_matches_source(
    pm: &ProfileMod,
    prior_bundle_source_fingerprints: &HashMap<String, String>,
    fingerprint_key: &str,
    source_fingerprint: &str,
) -> bool {
    pm.bundle_url.is_some()
        && pm.bundle_sha256.is_some()
        && prior_bundle_source_fingerprints
            .get(fingerprint_key)
            .map(String::as_str)
            == Some(source_fingerprint)
}

fn existing_bundle_matches_fast_source(
    pm: &ProfileMod,
    prior_bundle_source_fast_fingerprints: &HashMap<String, String>,
    fingerprint_key: &str,
    source_fast_fingerprint: &str,
) -> bool {
    pm.bundle_url.is_some()
        && pm.bundle_sha256.is_some()
        && prior_bundle_source_fast_fingerprints
            .get(fingerprint_key)
            .map(String::as_str)
            == Some(source_fast_fingerprint)
}

#[derive(Clone, Debug)]
struct ReusableBundle {
    bundle_url: String,
    bundle_sha256: String,
    profile_name: String,
}

#[derive(Default)]
struct ReusableBundleIndex {
    fast: HashMap<(String, String), ReusableBundle>,
    strong: HashMap<(String, String), ReusableBundle>,
}

impl ReusableBundleIndex {
    fn find_fast(&self, fingerprint_key: &str, fingerprint_value: &str) -> Option<ReusableBundle> {
        self.fast
            .get(&(fingerprint_key.to_string(), fingerprint_value.to_string()))
            .cloned()
    }

    fn find_strong(
        &self,
        fingerprint_key: &str,
        fingerprint_value: &str,
    ) -> Option<ReusableBundle> {
        self.strong
            .get(&(fingerprint_key.to_string(), fingerprint_value.to_string()))
            .cloned()
    }
}

fn reusable_bundle_index(profiles_path: &Path, owner: &str) -> ReusableBundleIndex {
    let mut index = ReusableBundleIndex::default();
    let owner = owner.trim();
    if owner.is_empty() {
        return index;
    }

    for profile in crate::profiles::list_profiles(profiles_path) {
        let Some(share_info_path) = find_share_info_path(&profile.name, profiles_path) else {
            continue;
        };
        let share_info = match load_share_info(&share_info_path) {
            Ok(info) => info,
            Err(e) => {
                log::warn!(
                    "Share '{}': could not read reusable bundle metadata at '{}': {}",
                    profile.name,
                    share_info_path.display(),
                    e
                );
                continue;
            }
        };
        if !share_info.owner.eq_ignore_ascii_case(owner) {
            continue;
        }

        for pm in &profile.mods {
            let (Some(bundle_url), Some(bundle_sha256)) =
                (pm.bundle_url.as_deref(), pm.bundle_sha256.as_deref())
            else {
                continue;
            };
            let bundle = ReusableBundle {
                bundle_url: bundle_url.to_string(),
                bundle_sha256: bundle_sha256.to_string(),
                profile_name: profile.name.clone(),
            };
            let fingerprint_key = bundle_source_fingerprint_key(pm);
            if let Some(fingerprint) = share_info
                .bundle_source_fast_fingerprints
                .get(&fingerprint_key)
            {
                index
                    .fast
                    .entry((fingerprint_key.clone(), fingerprint.clone()))
                    .or_insert_with(|| bundle.clone());
            }
            if let Some(fingerprint) = share_info.bundle_source_fingerprints.get(&fingerprint_key) {
                index
                    .strong
                    .entry((fingerprint_key.clone(), fingerprint.clone()))
                    .or_insert_with(|| bundle.clone());
            }
        }
    }

    index
}

/// Merge publish-side enrichment from the just-uploaded (filtered) profile
/// back onto the current on-disk profile, WITHOUT overwriting the on-disk
/// profile's membership. The uploaded profile may be missing members (e.g.
/// a non-active pack's stored mods are still excluded by the active-pack-only
/// filter in some flows, or a pack entry that resolved to no installed mod) --
/// those on-disk entries are left untouched, never deleted.
///
/// For each mod in `uploaded`, finds the matching mod in `on_disk` (by the
/// same identity convention used throughout publish) and copies over:
///   - refreshed disk-derived fields (`version`, `files`, `folder_name`,
///     `mod_id`, and bundle members) from publish preparation.
///   - `bundle_url`, `bundle_sha256` -- always, from the upload result.
///   - `source` -- fill-only (mirrors `backfill_profile_sources_from_db`):
///     only set on `on_disk` if it was `None` there.
///
/// Also copies profile-level publish attribution onto `on_disk`:
///   - `created_by` -- the owner attribution the publish set.
///   - `public` -- the `list_public` value the publish set, if any.
///
/// Returns the merged profile (a clone of `on_disk` with the above applied)
/// so callers can both persist it locally and compute the publish signature
/// from it.
fn merge_publish_enrichment(on_disk: &Profile, uploaded: &Profile) -> Profile {
    let mut merged = on_disk.clone();

    for uploaded_pm in &uploaded.mods {
        let Some(target) = merged
            .mods
            .iter_mut()
            .find(|pm| publish_profile_mods_match(pm, uploaded_pm))
        else {
            continue;
        };

        target.version = uploaded_pm.version.clone();
        target.files = uploaded_pm.files.clone();
        target.folder_name = uploaded_pm.folder_name.clone();
        target.mod_id = uploaded_pm.mod_id.clone();
        target.bundle_members = uploaded_pm.bundle_members.clone();
        if uploaded_pm.bundle_url.is_some() {
            target.bundle_url = uploaded_pm.bundle_url.clone();
        }
        if uploaded_pm.bundle_sha256.is_some() {
            target.bundle_sha256 = uploaded_pm.bundle_sha256.clone();
        }
        // Fill-only, mirroring backfill_profile_sources_from_db: never
        // downgrade a source the on-disk profile already had.
        if target.source.is_none() && uploaded_pm.source.is_some() {
            target.source = uploaded_pm.source.clone();
        }
    }

    merged.created_by = uploaded.created_by.clone();
    if uploaded.public.is_some() {
        merged.public = uploaded.public;
    }

    merged
}

/// Refresh a saved pack entry's on-disk-derived fields (`files`,
/// `folder_name`, `version`) from the currently-installed mod it resolves
/// to (issue #174). The saved manifest can go stale when the curator
/// deletes and reinstalls a mod: Nexus archives often unpack into a
/// version-suffixed folder, so `pm.files` ends up pointing at paths that
/// no longer exist and bundling fails with a confusing "missing declared
/// file" error on every subsequent share attempt.
///
/// Curator-authored fields (`source`, `hash`, `mod_id`, `enabled`,
/// `bundle_url`, `bundle_sha256`, `bundle_members`, and the pack-level
/// `mod_extras`/notes/links/tags) are deliberately left untouched here —
/// only the fields that describe "what's actually on disk right now" are
/// refreshed. For an unchanged mod this is a no-op (the installed scan
/// reports the same `files`/`folder_name`/`version` already in `pm`), so
/// re-share's content-addressed bundle hashing is unaffected.
///
/// Returns `true` if `files` actually changed, so the caller can log the
/// drift-repair as a diagnostic trail.
fn refresh_profile_mod_from_installed(pm: &mut ProfileMod, installed: &ModInfo) -> bool {
    let files_changed = pm.files != installed.files;
    if files_changed {
        pm.files = installed.files.clone();
    }
    if installed.folder_name.is_some() && pm.folder_name != installed.folder_name {
        pm.folder_name = installed.folder_name.clone();
    }
    if pm.version != installed.version {
        pm.version = installed.version.clone();
    }
    files_changed
}

fn filter_profile_for_publish_compatibility(
    profile: &mut Profile,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    game_version: Option<&str>,
    exclude_stored_members: bool,
) -> Vec<String> {
    // We always need the installed scan so we can refresh stale paths and
    // (for the active pack) drop stored (disabled) members.
    let installed_mods =
        merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path));
    let profile_name = profile.name.clone();
    let mut filtered_incompatible = 0;
    let mut filtered_stored = 0;
    let mut refreshed_files = 0;
    // Pack entries that resolve to no installed mod at all (issue #174):
    // bundling them would fail with a confusing "missing declared file"
    // zip error. We surface these to the caller so they can be reported
    // through the existing failed/missing-bundles mechanism with a clear
    // "not installed" message instead.
    let mut not_installed: Vec<String> = Vec::new();

    profile.mods.retain_mut(|pm| {
        let installed = installed_mods
            .iter()
            .find(|installed| publish_profile_mod_matches_installed(pm, installed));
        match installed {
            // A mod that is stored (disabled on disk, i.e. living in the
            // mods_disabled folder) is excluded from the ACTIVE pack's
            // publish even when it belongs to the modpack -- sharing the
            // active pack publishes the set the curator is actually
            // running, and this also fixes the disable-in-game-then-reshare
            // leak where a stored mod was still bundled from the disabled
            // folder. Non-active packs publish all members regardless of
            // whether they're currently enabled on disk -- their members
            // are usually stored, and excluding them here would silently
            // drop them from the pack entirely (see Part A).
            Some(m) if !m.enabled && exclude_stored_members => {
                log::info!(
                    "Publish '{}': excluding stored (disabled) mod '{}'",
                    profile_name,
                    pm.name,
                );
                filtered_stored += 1;
                false
            }
            Some(m)
                if game_version
                    .map(|gv| crate::updater::install_is_incompatible(m, Some(gv)))
                    .unwrap_or(false) =>
            {
                log::info!(
                    "Publish '{}': filtering saved profile mod '{}' -- needs game v{}, user has v{}",
                    profile_name,
                    pm.name,
                    m.min_game_version.as_deref().unwrap_or("?"),
                    game_version.unwrap_or("?"),
                );
                filtered_incompatible += 1;
                false
            }
            // Resolved to a live install: refresh the stale manifest paths
            // (and folder_name/version if they drifted) so bundling reads
            // from where the mod actually lives now, not where it lived
            // when the pack entry was first saved.
            Some(m) => {
                if refresh_profile_mod_from_installed(pm, m) {
                    refreshed_files += 1;
                    log::info!(
                        "Publish '{}': refreshed stale file list for '{}' from current install ({} file(s))",
                        profile_name,
                        pm.name,
                        pm.files.len(),
                    );
                }
                true
            }
            // No installed mod matches this pack entry at all -- the
            // curator likely deleted it without removing it from the pack.
            // Keep it in the profile (so it's still visible/removable) but
            // clear its stale `files` so the bundling loop's `!files.is_empty()`
            // filter skips it instead of attempting a zip that's guaranteed
            // to fail with a confusing "missing declared file" error. The
            // caller reports it through the failed/missing-bundles
            // mechanism with the clearer "not installed" message instead.
            None => {
                pm.files.clear();
                not_installed.push(pm.name.clone());
                true
            }
        }
    });

    if filtered_stored > 0 {
        log::info!(
            "Publish '{}': excluded {} stored (disabled) mod(s) from the upload",
            profile_name,
            filtered_stored,
        );
    }
    if filtered_incompatible > 0 {
        log::info!(
            "Publish '{}': filtered {} game-version-incompatible saved profile mod(s)",
            profile_name,
            filtered_incompatible,
        );
    }
    if refreshed_files > 0 {
        log::info!(
            "Publish '{}': refreshed file lists for {} reinstalled mod(s)",
            profile_name,
            refreshed_files,
        );
    }
    for name in &not_installed {
        log::warn!(
            "Publish '{}': '{}' is in this modpack but not installed -- remove it from the pack or reinstall it",
            profile_name,
            name,
        );
    }

    not_installed
}

/// Returns the prepared profile plus the names of any pack entries that
/// resolved to no installed mod at all (issue #174) -- these have already
/// had their stale `files` cleared by `filter_profile_for_publish_compatibility`
/// so bundling skips them; callers should seed `failed_uploads` with this
/// list so `ensure_profile_publish_complete` reports them with a clear
/// "not installed" message instead of letting bundling fail with a raw
/// zip error.
fn load_profile_for_publish_from_paths(
    name: &str,
    list_public: Option<bool>,
    include_notes: bool,
    profiles_path: &std::path::Path,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    config_path: &std::path::Path,
    game_version: Option<&str>,
    exclude_stored_members: bool,
) -> Result<(Profile, Vec<String>)> {
    let mut profile = crate::profiles::load_profile(name, profiles_path)?;
    let not_installed = filter_profile_for_publish_compatibility(
        &mut profile,
        mods_path,
        disabled_path,
        game_version,
        exclude_stored_members,
    );
    backfill_profile_sources_from_db(&mut profile, config_path);
    if include_notes {
        backfill_profile_extras_from_db(&mut profile, config_path);
    } else {
        // Opt-out: also drop extras a previous publish may have left in
        // the saved local JSON, so they don't ride along anyway.
        profile.mod_extras.clear();
    }
    if let Some(public) = list_public {
        profile.public = Some(public);
    }
    Ok((profile, not_installed))
}

/// Populate the manifest's per-mod curator extras (note / custom link /
/// tags) from the local sources DB (Solo FR, 2026-06-10). Folder-first
/// keying to match `enrich_mods_with_sources`. Rebuilt from the DB on
/// every publish — the DB is the source of truth, so edits and removals
/// both propagate on the next share. Deliberately NOT part of the
/// publish signature: editing a note never flags the pack out-of-sync;
/// the new notes simply ride along with the next real re-share.
fn backfill_profile_extras_from_db(profile: &mut Profile, config_path: &std::path::Path) {
    let db = crate::mod_sources::load_sources(config_path);
    let mut extras = std::collections::HashMap::new();
    for pm in &profile.mods {
        let Some(entry) = crate::mod_sources::lookup_entry(
            &db.mods,
            pm.folder_name.as_deref(),
            &pm.name,
            pm.mod_id.as_deref(),
        ) else {
            continue;
        };
        let e = crate::profiles::SharedModExtras {
            note: entry.note.clone(),
            custom_url: entry.custom_url.clone(),
            tags: entry.tags.clone(),
        };
        if !e.is_empty() {
            let key = pm.folder_name.clone().unwrap_or_else(|| pm.name.clone());
            extras.insert(key, e);
        }
    }
    profile.mod_extras = extras;
}

/// Stamp each mod's `source` from the curator's local `mod_sources.json`
/// before publishing, when the saved profile entry doesn't already carry
/// one. This is what lets a shared (or re-shared) pack hand friends the
/// curator's GitHub/Nexus links even though most mod manifests declare no
/// `Source` of their own — the links live in the curator's sources DB, not
/// the manifest, so without this every bundle-only mod would import as
/// "Unlinked".
///
/// Fill-only: a `source` already present on the profile mod (e.g. one a
/// previous share resolved, or a manifest that did declare it) is left
/// untouched, so re-sharing never downgrades a link that was already good.
fn backfill_profile_sources_from_db(profile: &mut Profile, config_path: &std::path::Path) {
    let db = crate::mod_sources::load_sources(config_path);
    for pm in &mut profile.mods {
        if pm.source.is_some() {
            continue;
        }
        pm.source = crate::mod_sources::shareable_source_for(
            &db,
            pm.folder_name.as_deref(),
            &pm.name,
            pm.mod_id.as_deref(),
        );
    }
}

/// A stable fingerprint of the content that actually gets published, so the
/// UI can tell when an owned share has un-pushed local edits. Deliberately
/// excludes volatile / publish-side fields: timestamps and bundle_url/sha
/// (those change on every re-share without the user changing anything).
fn profile_publish_signature(profile: &Profile) -> String {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<String> = profile
        .mods
        .iter()
        .map(|m| {
            format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                m.name,
                m.version,
                m.folder_name.as_deref().unwrap_or(""),
                m.mod_id.as_deref().unwrap_or(""),
                m.enabled,
                m.source.as_deref().unwrap_or(""),
                m.hash.as_deref().unwrap_or(""),
            )
        })
        .collect();
    entries.sort();
    let mut hasher = Sha256::new();
    hasher.update(profile.name.as_bytes());
    hasher.update([0x1e]);
    hasher.update(profile.created_by.as_deref().unwrap_or("").as_bytes());
    hasher.update([0x1e]);
    hasher.update(match profile.public {
        Some(true) => b"1".as_slice(),
        _ => b"0".as_slice(),
    });
    for e in entries {
        hasher.update([0x1d]);
        hasher.update(e.as_bytes());
    }
    hex::encode(hasher.finalize())
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn cancel_profile_share(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if s.sharing_in_flight.contains(&name) {
        s.sharing_cancel_requested.insert(name);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Share a profile by uploading to a GitHub repo. Returns a short profile code.
/// If already shared, reuses the existing code (delegates to reshare logic).
///
/// `app_handle` is taken so we can emit per-mod `share-progress` events
/// during the bundling loop — bundling a 20-mod pack of any real size
/// takes minutes, and the PublishModal used to show only an opaque
/// "Publishing…" spinner which looked identical to a hang. Now the
/// modal advances through "Bundling mod 5 of 20…" as we go.
#[tauri::command]
pub async fn share_profile(
    name: String,
    list_public: Option<bool>,
    include_notes: Option<bool>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    use tauri::Emitter;
    let (
        profiles_path,
        mods_path,
        disabled_path,
        config_path,
        token,
        game_version,
        exclude_stored_members,
    ) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s
            .github_token
            .clone()
            .ok_or("GitHub token required to share profiles. Set it in Settings.")?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        // Only the ACTIVE pack publishes the "currently running" set --
        // excluding members that are stored (disabled on disk). A
        // non-active pack's members are usually stored, so excluding them
        // here would silently drop them from the pack (see Part A of the
        // publish-nonactive-pack fix).
        let exclude_stored_members = crate::profiles::load_profile(&name, &s.profiles_path)
            .ok()
            .is_some_and(|profile| {
                crate::profiles::active_profile_matches(s.active_profile.as_deref(), &profile)
            });
        (
            s.profiles_path.clone(),
            mods_path,
            disabled_path,
            s.config_path.clone(),
            token,
            s.game_version.clone(),
            exclude_stored_members,
        )
    };

    // If already shared, reuse the existing code (same as reshare). Drop our
    // would-be guard before delegating so reshare_profile can acquire its own
    // without "already in progress" tripping.
    if find_share_info_path(&name, &profiles_path).is_some() {
        log::info!(
            "Profile '{}' already shared, reusing code via reshare",
            name
        );
        return reshare_profile(name, list_public, include_notes, app_handle, state).await;
    }

    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;
    let cancel_state = state.inner().clone();
    let cancel_name = name.clone();
    let cancel_check = move || sharing_cancel_requested(&cancel_state, &cancel_name);

    let old_profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    let (profile, not_installed) = load_profile_for_publish_from_paths(
        &name,
        list_public,
        include_notes.unwrap_or(true),
        &profiles_path,
        &mods_path,
        &disabled_path,
        &config_path,
        game_version.as_deref(),
        exclude_stored_members,
    )
    .map_err(|e| e.to_string())?;

    // Forward to the non-IPC impl with an emit closure that bridges to Tauri.
    let app_handle_for_emit = app_handle.clone();
    let emit_fn = move |event: &str, payload: ShareProgress| {
        let _ = app_handle_for_emit.emit(event, payload);
    };
    match share_profile_impl(
        profile,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &token,
        Some(&emit_fn),
        Some(&cancel_check),
        not_installed,
    )
    .await
    {
        Ok(result) => {
            // Self-subscribed curators are by definition in sync with what
            // was just published — refresh the snapshot so the update poll
            // doesn't flag their own publish (see the helper's doc).
            if let Ok(published) = crate::profiles::load_profile(&name, &profiles_path) {
                crate::subscriptions::sync_own_subscription_after_publish(&config_path, &published);
            }
            Ok(result)
        }
        Err(e) => {
            restore_profile_after_failed_publish(Some(&old_profile), &profiles_path);
            Err(e.to_string())
        }
    }
}

/// Non-IPC core of `share_profile` — takes already-loaded paths/token/profile
/// directly so tests can drive it without a Tauri runtime. The `#[tauri::command]`
/// shim above resolves state + builds an emit closure, then forwards here.
///
/// `emit` is invoked for `share-progress` events (bundling each mod, uploading
/// manifest, done). `None` in tests; the shim wires it to `AppHandle::emit`.
pub(super) async fn share_profile_impl(
    mut profile: Profile,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    profiles_path: &std::path::Path,
    token: &str,
    emit: Option<&(dyn Fn(&str, ShareProgress) + Send + Sync)>,
    cancel_requested: Option<&(dyn Fn() -> bool + Send + Sync)>,
    failed_uploads_seed: Vec<String>,
) -> Result<ShareResult> {
    // Get username
    let username = get_github_username(token).await?;
    profile = attribute_profile_to_owner(profile, &username);

    // Ensure repo exists
    ensure_profiles_repo(token, &username).await?;

    // Seeded with pack entries that resolved to no installed mod at all
    // (issue #174) -- `filter_profile_for_publish_compatibility` already
    // cleared their `files` so the bundling loop below skips them, but
    // they still need to surface in `ensure_profile_publish_complete`'s
    // missing-bundles report with a clear "not installed" message.
    let mut failed_uploads: Vec<String> = failed_uploads_seed;
    let mut failed_upload_reasons: Vec<(String, String)> = failed_uploads
        .iter()
        .map(|name| {
            (
                name.clone(),
                "This mod is in the modpack but is not installed locally.".to_string(),
            )
        })
        .collect();
    let bundlable: Vec<usize> = profile
        .mods
        .iter()
        .enumerate()
        .filter_map(|(i, m)| if !m.files.is_empty() { Some(i) } else { None })
        .collect();
    let total_bundlable = bundlable.len();
    let mut bundles_skipped_before_zip = 0usize;
    let mut bundles_reused = 0usize;
    let mut bundles_uploaded = 0usize;
    let mut bundle_source_fingerprints: HashMap<String, String> = HashMap::new();
    let mut bundle_source_fast_fingerprints: HashMap<String, String> = HashMap::new();
    let (prior_bundle_source_fingerprints, prior_bundle_source_fast_fingerprints) =
        find_share_info_path(&profile.id, profiles_path)
            .and_then(|path| match load_share_info(&path) {
                Ok(info) => Some((
                    info.bundle_source_fingerprints,
                    info.bundle_source_fast_fingerprints,
                )),
                Err(e) => {
                    log::warn!(
                        "Share '{}': could not read existing share metadata at '{}': {}",
                        profile.name,
                        path.display(),
                        e
                    );
                    None
                }
            })
            .unwrap_or_default();
    let reusable_bundles = reusable_bundle_index(profiles_path, &username);

    // Bundle ALL mods to guarantee version matching.
    // Friends get the exact same files the curator has installed.
    // GitHub sources are kept as metadata but bundles are preferred during install.
    for (pos, idx) in bundlable.into_iter().enumerate() {
        if cancel_requested
            .map(|cancelled| cancelled())
            .unwrap_or(false)
        {
            return Err(crate::error::AppError::Other("Sharing canceled.".into()));
        }
        let mod_name = profile.mods[idx].name.clone();
        if let Some(e) = emit {
            e(
                "share-progress",
                ShareProgress {
                    profile_name: profile.name.clone(),
                    stage: "checking-bundle",
                    current: pos + 1,
                    total: total_bundlable,
                    mod_name: Some(mod_name.clone()),
                },
            );
        }

        let pm = &mut profile.mods[idx];
        let fingerprint_key = bundle_source_fingerprint_key(pm);
        let source_fast_fingerprint = match fingerprint_profile_mod_file_metadata_with_cancel(
            pm,
            mods_path,
            disabled_path,
            cancel_requested,
        ) {
            Ok(fingerprint) => bundle_source_fast_fingerprint_value(pm, &fingerprint),
            Err(e) => {
                if is_sharing_canceled_error(&e) {
                    return Err(e);
                }
                log::error!("Failed to fingerprint mod metadata '{}': {}", pm.name, e);
                failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                failed_uploads.push(pm.name.clone());
                continue;
            }
        };
        if existing_bundle_matches_fast_source(
            pm,
            &prior_bundle_source_fast_fingerprints,
            &fingerprint_key,
            &source_fast_fingerprint,
        ) {
            bundles_skipped_before_zip += 1;
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Share '{}': skipping bundle for '{}' (source metadata unchanged)",
                profile.name,
                pm.name
            );
            continue;
        }
        if let Some(bundle) = reusable_bundles.find_fast(&fingerprint_key, &source_fast_fingerprint)
        {
            bundles_skipped_before_zip += 1;
            pm.bundle_url = Some(bundle.bundle_url);
            pm.bundle_sha256 = Some(bundle.bundle_sha256);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Share '{}': reusing bundle for '{}' from profile '{}' (source metadata unchanged)",
                profile.name,
                pm.name,
                bundle.profile_name
            );
            continue;
        }
        let source_fingerprint = match fingerprint_profile_mod_files_with_cancel(
            pm,
            mods_path,
            disabled_path,
            cancel_requested,
        ) {
            Ok(fingerprint) => bundle_source_fingerprint_value(pm, &fingerprint),
            Err(e) => {
                if is_sharing_canceled_error(&e) {
                    return Err(e);
                }
                log::error!("Failed to fingerprint mod '{}': {}", pm.name, e);
                failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                failed_uploads.push(pm.name.clone());
                continue;
            }
        };
        if existing_bundle_matches_source(
            pm,
            &prior_bundle_source_fingerprints,
            &fingerprint_key,
            &source_fingerprint,
        ) {
            bundles_skipped_before_zip += 1;
            bundle_source_fingerprints.insert(fingerprint_key.clone(), source_fingerprint);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Share '{}': skipping bundle for '{}' (source fingerprint unchanged)",
                profile.name,
                pm.name
            );
            continue;
        }
        if let Some(bundle) = reusable_bundles.find_strong(&fingerprint_key, &source_fingerprint) {
            bundles_skipped_before_zip += 1;
            pm.bundle_url = Some(bundle.bundle_url);
            pm.bundle_sha256 = Some(bundle.bundle_sha256);
            bundle_source_fingerprints.insert(fingerprint_key.clone(), source_fingerprint);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Share '{}': reusing bundle for '{}' from profile '{}' (source fingerprint unchanged)",
                profile.name,
                pm.name,
                bundle.profile_name
            );
            continue;
        }
        if let Some(e) = emit {
            e(
                "share-progress",
                ShareProgress {
                    profile_name: profile.name.clone(),
                    stage: "bundling",
                    current: pos + 1,
                    total: total_bundlable,
                    mod_name: Some(mod_name.clone()),
                },
            );
        }
        log::info!("Bundling mod '{}' ({} files)", pm.name, pm.files.len());
        if cancel_requested
            .map(|cancelled| cancelled())
            .unwrap_or(false)
        {
            return Err(crate::error::AppError::Other("Sharing canceled.".into()));
        }
        match zip_profile_mod_files_to_tempfile_with_cancel(
            pm,
            mods_path,
            disabled_path,
            cancel_requested,
        ) {
            Ok(zip_file) => {
                let zip_len = zip_file.as_file().metadata().map(|m| m.len()).unwrap_or(0);
                let prior_sha256 = pm.bundle_sha256.clone();
                match upload_mod_bundle_file_via_release_with_cancel(
                    token,
                    &username,
                    &pm.name,
                    &pm.version,
                    zip_file.path(),
                    prior_sha256.as_deref(),
                    cancel_requested,
                )
                .await
                {
                    Ok((url, hash)) => {
                        if prior_sha256.as_deref() == Some(hash.as_str()) {
                            bundles_reused += 1;
                        } else {
                            bundles_uploaded += 1;
                        }
                        pm.bundle_url = Some(url);
                        pm.bundle_sha256 = Some(hash);
                        bundle_source_fingerprints
                            .insert(fingerprint_key.clone(), source_fingerprint.clone());
                        bundle_source_fast_fingerprints
                            .insert(fingerprint_key.clone(), source_fast_fingerprint.clone());
                        log::info!("Bundled mod '{}' successfully ({} bytes)", pm.name, zip_len);
                    }
                    Err(e) => {
                        if is_sharing_canceled_error(&e) {
                            return Err(e);
                        }
                        log::error!("Failed to upload bundle for '{}': {}", pm.name, e);
                        failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                        // If bundling fails AND there's no GitHub source either, the
                        // mod isn't recoverable for friends. Track either way so the
                        // curator sees a clear "X of N failed" toast — they can
                        // retry instead of finding out from a confused friend later.
                        failed_uploads.push(pm.name.clone());
                        if pm.source.is_none() {
                            log::error!("Mod '{}' has no bundle AND no GitHub source -- friends won't be able to download it", pm.name);
                        }
                    }
                }
            }
            Err(e) => {
                if is_sharing_canceled_error(&e) {
                    return Err(e);
                }
                log::error!("Failed to zip mod '{}': {}", pm.name, e);
                failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                failed_uploads.push(pm.name.clone());
            }
        }
    }
    log::info!(
        "Share '{}': bundles {} skipped before zip, {} reused after zip hash, {} uploaded",
        profile.name,
        bundles_skipped_before_zip,
        bundles_reused,
        bundles_uploaded
    );

    ensure_profile_publish_complete(&profile, &failed_uploads, &failed_upload_reasons)?;

    if cancel_requested
        .map(|cancelled| cancelled())
        .unwrap_or(false)
    {
        return Err(crate::error::AppError::Other("Sharing canceled.".into()));
    }

    // Generate code and filename
    let code = generate_code(&profile);
    let filename = code_to_filename(&code);
    let profile_json = serde_json::to_string_pretty(&profile)?;

    if let Some(e) = emit {
        e(
            "share-progress",
            ShareProgress {
                profile_name: profile.name.clone(),
                stage: "uploading-manifest",
                current: 0,
                total: 0,
                mod_name: None,
            },
        );
    }

    // Upload profile JSON
    let (file_sha, html_url) = upsert_file(
        token,
        &username,
        &filename,
        &profile_json,
        None,
        &format!(
            "Share profile: {} ({} mods)",
            profile.name,
            profile.mods.len()
        ),
    )
    .await?;

    // Merge publish enrichment (bundle_url/bundle_sha256/source/created_by/
    // public) onto the CURRENT on-disk profile rather than overwriting it
    // with the filtered upload copy -- the upload copy may be missing
    // members (stored mods on a non-active pack, or pack entries with no
    // installed match), and overwriting would silently delete them from the
    // curator's local manifest. See `merge_publish_enrichment`. Falls back
    // to the uploaded profile itself if the on-disk file is somehow
    // missing (defensive only -- the normal `share_profile` entry point
    // always loads it first).
    let on_disk = crate::profiles::load_profile(&profile.id, profiles_path)
        .unwrap_or_else(|_| profile.clone());
    let merged = merge_publish_enrichment(&on_disk, &profile);
    crate::profiles::save_profile(&merged, profiles_path)?;
    log::info!(
        "Saved enriched profile '{}' with bundle_urls to local JSON ({} mod(s))",
        merged.name,
        merged.mods.len()
    );

    // Store share info locally for re-sharing. The published signature is
    // computed from the MERGED ON-DISK profile (the local manifest as of
    // this publish), not the filtered upload copy -- otherwise an active
    // pack with stored members would mismatch immediately (the upload
    // excludes them, the local manifest keeps them), producing a
    // permanent false "Out of sync" banner.
    let share_info = ShareInfo {
        code: code.clone(),
        owner: username.clone(),
        file_sha: Some(file_sha),
        share_format_version: SHARE_FORMAT_VERSION,
        published_signature: Some(profile_publish_signature(&merged)),
        bundle_source_fingerprints,
        bundle_source_fast_fingerprints,
    };
    let share_info_path = share_info_path_for_profile(&merged, &profiles_path);
    save_share_info(&share_info_path, &share_info)?;

    // Reclaim disk on the `bundles` release: any asset no profile manifest
    // references after this upload is dead weight. Runs after the manifest
    // upsert so the freshly-written manifest's bundle URLs are part of the
    // referenced set. Always best-effort — never fails the share.
    match cleanup_orphan_bundle_assets(token, &username).await {
        Ok(0) => {}
        Ok(n) => log::info!(
            "GC: removed {} orphan bundle asset(s) from {}/{}",
            n,
            username,
            profiles_repo()
        ),
        Err(e) => log::warn!("GC: orphan-asset cleanup failed: {}", e),
    }

    if let Some(e) = emit {
        e(
            "share-progress",
            ShareProgress {
                profile_name: profile.name.clone(),
                stage: "done",
                current: 0,
                total: 0,
                mod_name: None,
            },
        );
    }

    Ok(ShareResult {
        code,
        owner: username.clone(),
        file_path: filename,
        url: html_url,
        repo_url: build_repo_url(&username),
        failed_uploads,
        // Just published under the current format — nothing to nudge.
        reshare_recommended: false,
        // Just published — not out of sync.
        out_of_sync: false,
    })
}

/// Get the share info (code + owner) for a profile, if it has been shared.
#[tauri::command]
pub async fn get_share_info(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<ShareResult>, String> {
    let (profiles_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.profiles_path.clone(),
            s.config_path.clone(),
            s.github_token.clone(),
        )
    };
    let info: ShareInfo = match find_share_info_path(&name, &profiles_path)
        .and_then(|path| std::fs::read_to_string(path).ok())
    {
        Some(content) => match serde_json::from_str(&content) {
            Ok(info) => info,
            Err(e) => {
                log::warn!(
                    "get_share_info: failed to read share metadata for '{}': {}",
                    name,
                    e
                );
                match recover_owned_share_info_from_subscription(
                    &name,
                    &profiles_path,
                    &config_path,
                    token.as_deref(),
                )
                .await
                {
                    Some(info) => info,
                    None => return Ok(None),
                }
            }
        },
        None => match recover_owned_share_info_from_subscription(
            &name,
            &profiles_path,
            &config_path,
            token.as_deref(),
        )
        .await
        {
            Some(info) => info,
            None => return Ok(None),
        },
    };
    let filename = code_to_filename(&info.code);
    let url = format!(
        "https://github.com/{}/{}/blob/main/{}",
        info.owner,
        profiles_repo(),
        filename
    );
    let repo_url = build_repo_url(&info.owner);
    let out_of_sync = match info.published_signature.as_deref() {
        Some(sig) => crate::profiles::load_profile(&name, &profiles_path)
            .map(|p| profile_publish_signature(&p) != sig)
            .unwrap_or(false),
        None => false, // legacy .share with no baseline — don't nag until next share
    };
    Ok(Some(ShareResult {
        code: info.code,
        owner: info.owner,
        file_path: filename,
        url,
        repo_url,
        // get_share_info reads the saved state — we don't re-attempt the
        // failed uploads here. The frontend should treat this as "current
        // share status", not a fresh share result.
        failed_uploads: Vec::new(),
        // A pack published under an older share format benefits from a
        // re-share (e.g. to pick up source-link backfill). Packs already at
        // the current version — and any future-dated version — don't.
        reshare_recommended: info.share_format_version < SHARE_FORMAT_VERSION,
        out_of_sync,
    }))
}

/// Re-share (update) an already-shared profile. Same code, updated content.
/// Re-snapshots the current mods from disk so removed mods are excluded.
/// Preserves original created_at and sets created_by to the GitHub username.
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    list_public: Option<bool>,
    include_notes: Option<bool>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    use tauri::Emitter;
    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;
    let cancel_state = state.inner().clone();
    let cancel_name = name.clone();
    let cancel_check = move || sharing_cancel_requested(&cancel_state, &cancel_name);

    let (
        profiles_path,
        mods_path,
        disabled_path,
        config_path,
        token,
        game_version,
        exclude_stored_members,
    ) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s
            .github_token
            .clone()
            .ok_or("GitHub token required. Set it in Settings.")?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        // See share_profile: only the ACTIVE pack excludes stored
        // (disabled-on-disk) members from the publish.
        let exclude_stored_members = crate::profiles::load_profile(&name, &s.profiles_path)
            .ok()
            .is_some_and(|profile| {
                crate::profiles::active_profile_matches(s.active_profile.as_deref(), &profile)
            });
        (
            s.profiles_path.clone(),
            mods_path,
            disabled_path,
            s.config_path.clone(),
            token,
            s.game_version.clone(),
            exclude_stored_members,
        )
    };

    // Load existing share info
    let existing_share_info_path = find_share_info_path(&name, &profiles_path)
        .ok_or_else(|| "Profile has not been shared yet. Use 'Share' first.".to_string())?;
    let share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&existing_share_info_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let old_profile = crate::profiles::load_profile(&name, &profiles_path).ok();

    let (mut profile, not_installed) = load_profile_for_publish_from_paths(
        &name,
        list_public,
        include_notes.unwrap_or(true),
        &profiles_path,
        &mods_path,
        &disabled_path,
        &config_path,
        game_version.as_deref(),
        exclude_stored_members,
    )
    .map_err(|e| e.to_string())?;

    profile.created_by = Some(share_info.owner.clone());
    log::info!(
        "Re-sharing saved profile '{}': {} referenced mods",
        name,
        profile.mods.len()
    );

    // Seeded with pack entries that resolved to no installed mod at all
    // (issue #174) -- `filter_profile_for_publish_compatibility` already
    // cleared their `files` so the bundling loop below skips them, but
    // they still need to surface in `ensure_profile_publish_complete`'s
    // missing-bundles report with a clear "not installed" message.
    let mut failed_uploads: Vec<String> = not_installed;
    let mut failed_upload_reasons: Vec<(String, String)> = failed_uploads
        .iter()
        .map(|name| {
            (
                name.clone(),
                "This mod is in the modpack but is not installed locally.".to_string(),
            )
        })
        .collect();
    let prior_bundle_source_fingerprints = share_info.bundle_source_fingerprints.clone();
    let prior_bundle_source_fast_fingerprints = share_info.bundle_source_fast_fingerprints.clone();
    let bundlable: Vec<usize> = profile
        .mods
        .iter()
        .enumerate()
        .filter_map(|(i, m)| if !m.files.is_empty() { Some(i) } else { None })
        .collect();
    let total_bundlable = bundlable.len();
    let mut bundles_skipped_before_zip = 0usize;
    let mut bundles_reused = 0usize;
    let mut bundles_uploaded = 0usize;
    let mut bundle_source_fingerprints: HashMap<String, String> = HashMap::new();
    let mut bundle_source_fast_fingerprints: HashMap<String, String> = HashMap::new();
    let reusable_bundles = reusable_bundle_index(&profiles_path, &share_info.owner);

    // Bundle ALL mods to guarantee version matching (same as share_profile).
    for (pos, idx) in bundlable.into_iter().enumerate() {
        if cancel_check() {
            restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
            return Err("Sharing canceled.".to_string());
        }
        let mod_name = profile.mods[idx].name.clone();
        let _ = app_handle.emit(
            "share-progress",
            ShareProgress {
                profile_name: profile.name.clone(),
                stage: "checking-bundle",
                current: pos + 1,
                total: total_bundlable,
                mod_name: Some(mod_name.clone()),
            },
        );

        let pm = &mut profile.mods[idx];
        let fingerprint_key = bundle_source_fingerprint_key(pm);
        let source_fast_fingerprint =
            match fingerprint_profile_mod_file_metadata(pm, &mods_path, &disabled_path) {
                Ok(fingerprint) => bundle_source_fast_fingerprint_value(pm, &fingerprint),
                Err(e) => {
                    log::error!("Failed to fingerprint mod metadata '{}': {}", pm.name, e);
                    failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                    failed_uploads.push(pm.name.clone());
                    continue;
                }
            };
        if existing_bundle_matches_fast_source(
            pm,
            &prior_bundle_source_fast_fingerprints,
            &fingerprint_key,
            &source_fast_fingerprint,
        ) {
            bundles_skipped_before_zip += 1;
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Re-share '{}': skipping bundle for '{}' (source metadata unchanged)",
                profile.name,
                pm.name
            );
            continue;
        }
        if let Some(bundle) = reusable_bundles.find_fast(&fingerprint_key, &source_fast_fingerprint)
        {
            bundles_skipped_before_zip += 1;
            pm.bundle_url = Some(bundle.bundle_url);
            pm.bundle_sha256 = Some(bundle.bundle_sha256);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Re-share '{}': reusing bundle for '{}' from profile '{}' (source metadata unchanged)",
                profile.name,
                pm.name,
                bundle.profile_name
            );
            continue;
        }
        let source_fingerprint = match fingerprint_profile_mod_files(pm, &mods_path, &disabled_path)
        {
            Ok(fingerprint) => bundle_source_fingerprint_value(pm, &fingerprint),
            Err(e) => {
                log::error!("Failed to fingerprint mod '{}': {}", pm.name, e);
                failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                failed_uploads.push(pm.name.clone());
                continue;
            }
        };
        if existing_bundle_matches_source(
            pm,
            &prior_bundle_source_fingerprints,
            &fingerprint_key,
            &source_fingerprint,
        ) {
            bundles_skipped_before_zip += 1;
            bundle_source_fingerprints.insert(fingerprint_key.clone(), source_fingerprint);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Re-share '{}': skipping bundle for '{}' (source fingerprint unchanged)",
                profile.name,
                pm.name
            );
            continue;
        }
        if let Some(bundle) = reusable_bundles.find_strong(&fingerprint_key, &source_fingerprint) {
            bundles_skipped_before_zip += 1;
            pm.bundle_url = Some(bundle.bundle_url);
            pm.bundle_sha256 = Some(bundle.bundle_sha256);
            bundle_source_fingerprints.insert(fingerprint_key.clone(), source_fingerprint);
            bundle_source_fast_fingerprints.insert(fingerprint_key, source_fast_fingerprint);
            log::info!(
                "Re-share '{}': reusing bundle for '{}' from profile '{}' (source fingerprint unchanged)",
                profile.name,
                pm.name,
                bundle.profile_name
            );
            continue;
        }

        let _ = app_handle.emit(
            "share-progress",
            ShareProgress {
                profile_name: profile.name.clone(),
                stage: "bundling",
                current: pos + 1,
                total: total_bundlable,
                mod_name: Some(mod_name.clone()),
            },
        );
        log::info!("Re-bundling mod '{}' ({} files)", pm.name, pm.files.len());
        if cancel_check() {
            restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
            return Err("Sharing canceled.".to_string());
        }
        match zip_profile_mod_files_to_tempfile(pm, &mods_path, &disabled_path) {
            Ok(zip_file) => {
                let zip_len = zip_file.as_file().metadata().map(|m| m.len()).unwrap_or(0);
                let prior_sha256 = pm.bundle_sha256.clone();
                match upload_mod_bundle_file_via_release(
                    &token,
                    &share_info.owner,
                    &pm.name,
                    &pm.version,
                    zip_file.path(),
                    prior_sha256.as_deref(),
                )
                .await
                {
                    Ok((url, hash)) => {
                        if prior_sha256.as_deref() == Some(hash.as_str()) {
                            bundles_reused += 1;
                        } else {
                            bundles_uploaded += 1;
                        }
                        pm.bundle_url = Some(url);
                        pm.bundle_sha256 = Some(hash);
                        bundle_source_fingerprints
                            .insert(fingerprint_key.clone(), source_fingerprint.clone());
                        bundle_source_fast_fingerprints
                            .insert(fingerprint_key.clone(), source_fast_fingerprint.clone());
                        log::info!(
                            "Re-bundled mod '{}' successfully ({} bytes)",
                            pm.name,
                            zip_len
                        );
                    }
                    Err(e) => {
                        log::error!("Failed to upload bundle for '{}': {}", pm.name, e);
                        failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                        failed_uploads.push(pm.name.clone());
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to zip mod '{}': {}", pm.name, e);
                failed_upload_reasons.push((pm.name.clone(), e.to_string()));
                failed_uploads.push(pm.name.clone());
            }
        }
    }
    log::info!(
        "Re-share '{}': bundles {} skipped before zip, {} reused after zip hash, {} uploaded",
        profile.name,
        bundles_skipped_before_zip,
        bundles_reused,
        bundles_uploaded
    );

    if let Err(e) =
        ensure_profile_publish_complete(&profile, &failed_uploads, &failed_upload_reasons)
    {
        restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
        return Err(e.to_string());
    }

    if cancel_check() {
        restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
        return Err("Sharing canceled.".to_string());
    }

    let filename = code_to_filename(&share_info.code);
    let profile_json = match serde_json::to_string_pretty(&profile) {
        Ok(json) => json,
        Err(e) => {
            restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
            return Err(e.to_string());
        }
    };

    let _ = app_handle.emit(
        "share-progress",
        ShareProgress {
            profile_name: profile.name.clone(),
            stage: "uploading-manifest",
            current: 0,
            total: 0,
            mod_name: None,
        },
    );

    let (file_sha, html_url) = match upsert_file(
        &token,
        &share_info.owner,
        &filename,
        &profile_json,
        share_info.file_sha.as_deref(),
        &format!(
            "Update profile: {} ({} mods)",
            profile.name,
            profile.mods.len()
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
            return Err(e.to_string());
        }
    };

    // Merge publish enrichment onto the CURRENT on-disk profile rather than
    // overwriting it with the filtered upload copy -- see
    // `merge_publish_enrichment` and the matching comment in
    // `share_profile_impl`. Reload fresh in case the on-disk profile
    // changed since `old_profile` was captured at the top of this command;
    // fall back to `old_profile` (or the uploaded profile) if the on-disk
    // file is somehow missing.
    let on_disk = crate::profiles::load_profile(&profile.id, &profiles_path)
        .ok()
        .or_else(|| old_profile.clone())
        .unwrap_or_else(|| profile.clone());
    let merged = merge_publish_enrichment(&on_disk, &profile);
    crate::profiles::save_profile(&merged, &profiles_path).map_err(|e| e.to_string())?;
    log::info!(
        "Saved re-shared enriched profile '{}' to local JSON ({} mod(s))",
        merged.name,
        merged.mods.len()
    );

    let owner = share_info.owner.clone();
    let code = share_info.code.clone();

    // Update local share info with new SHA and stamp the current format
    // version, so the re-share nudge clears once the curator re-publishes.
    // The published signature is computed from the MERGED ON-DISK profile
    // (the local manifest as of this publish), not the filtered upload
    // copy -- see the matching comment in `share_profile_impl`.
    let updated_info = ShareInfo {
        code: share_info.code,
        owner: share_info.owner,
        file_sha: Some(file_sha),
        share_format_version: SHARE_FORMAT_VERSION,
        published_signature: Some(profile_publish_signature(&merged)),
        bundle_source_fingerprints,
        bundle_source_fast_fingerprints,
    };
    let share_info_path = share_info_path_for_profile(&merged, &profiles_path);
    save_share_info(&share_info_path, &updated_info).map_err(|e| e.to_string())?;
    if existing_share_info_path != share_info_path && existing_share_info_path.exists() {
        let _ = std::fs::remove_file(&existing_share_info_path);
    }

    // Self-subscribed curators are by definition in sync with what was just
    // published — refresh the subscription snapshot so the update poll
    // doesn't flag the curator's own re-share as a pending update.
    crate::subscriptions::sync_own_subscription_after_publish(&config_path, &merged);

    // Reclaim disk on the `bundles` release: any asset no profile
    // manifest still references after this re-share is dead weight.
    // Always best-effort — never fails the re-share.
    match cleanup_orphan_bundle_assets(&token, &owner).await {
        Ok(0) => {}
        Ok(n) => log::info!(
            "GC: removed {} orphan bundle asset(s) from {}/{}",
            n,
            owner,
            profiles_repo()
        ),
        Err(e) => log::warn!("GC: orphan-asset cleanup failed: {}", e),
    }

    let _ = app_handle.emit(
        "share-progress",
        ShareProgress {
            profile_name: profile.name.clone(),
            stage: "done",
            current: 0,
            total: 0,
            mod_name: None,
        },
    );

    Ok(ShareResult {
        code,
        owner: owner.clone(),
        file_path: filename,
        url: html_url,
        repo_url: build_repo_url(&owner),
        failed_uploads,
        // Just re-published under the current format — nudge cleared.
        reshare_recommended: false,
        // Just re-published — not out of sync.
        out_of_sync: false,
    })
}

/// Fetch a shared profile by code. The code format is "OWNER:CODE" where OWNER is
/// the GitHub username and CODE is the profile code. Friends need both parts.
/// Format: "username/AA5A-315D-61AE"
#[tauri::command]
pub async fn fetch_shared_profile_cmd(
    code: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let (owner, profile_code) = parse_share_code(&code).map_err(|e| e.to_string())?;

    let token = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.github_token.clone()
    };

    let filename = code_to_filename(&profile_code);
    fetch_shared_profile(&owner, &filename, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// `install_shared_profile` lives in `install.rs` — see the `pub use`
// re-export near the top of this file. Keeping it in a sibling module
// rather than inline keeps the orchestration in `mod.rs` focused on
// the share/reshare/set-listing surface.

/// Flip an already-shared profile's `public` flag and re-upload the
/// manifest only (no mod re-bundling). Used by the post-share toggle
/// in PublishModal and by any future manual override surface.
#[tauri::command]
pub async fn set_modpack_listing(
    name: String,
    public: bool,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    let (profiles_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or("GitHub token required")?;
        (s.profiles_path.clone(), token)
    };

    let existing_share_info_path = find_share_info_path(&name, &profiles_path)
        .ok_or_else(|| "Profile has not been shared yet.".to_string())?;
    let mut share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&existing_share_info_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let mut profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    // Idempotency: skip the round-trip when the value already matches.
    if profile.public == Some(public) {
        return Ok(());
    }
    profile.public = Some(public);
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    let filename = code_to_filename(&share_info.code);
    let profile_json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    let (file_sha, _html_url) = upsert_file(
        &token,
        &share_info.owner,
        &filename,
        &profile_json,
        share_info.file_sha.as_deref(),
        &format!("Update profile listing: {} -> {}", profile.name, public),
    )
    .await
    .map_err(|e| e.to_string())?;

    share_info.file_sha = Some(file_sha);
    let share_info_path = share_info_path_for_profile(&profile, &profiles_path);
    save_share_info(&share_info_path, &share_info).map_err(|e| e.to_string())?;
    if existing_share_info_path != share_info_path && existing_share_info_path.exists() {
        let _ = std::fs::remove_file(&existing_share_info_path);
    }

    if let Ok(mut s) = state.lock() {
        s.modpack_browser_cache.clear();
    }

    Ok(())
}

#[cfg(test)]
mod listing_tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn save_share_info_writes_and_replaces_sidecar_without_temp_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owned.share");
        let first = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "alice".into(),
            file_sha: Some("old".into()),
            share_format_version: 1,
            published_signature: None,
            bundle_source_fingerprints: HashMap::new(),
            bundle_source_fast_fingerprints: HashMap::new(),
        };
        let second = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "alice".into(),
            file_sha: Some("new".into()),
            share_format_version: SHARE_FORMAT_VERSION,
            published_signature: None,
            bundle_source_fingerprints: HashMap::new(),
            bundle_source_fast_fingerprints: HashMap::new(),
        };

        save_share_info(&path, &first).unwrap();
        save_share_info(&path, &second).unwrap();

        let saved: ShareInfo =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.file_sha.as_deref(), Some("new"));
        assert_eq!(saved.share_format_version, SHARE_FORMAT_VERSION);

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("share-info"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic sidecar writes should not leave temp files behind"
        );
    }

    #[test]
    fn recovered_owned_share_info_uses_remote_signature() {
        let dir = tempfile::tempdir().unwrap();
        let profiles_path = dir.path().join("profiles");
        std::fs::create_dir_all(&profiles_path).unwrap();

        let mut remote = make_profile("Solo Pack", Some(false));
        remote.created_by = Some("Solomag".into());
        crate::profiles::save_profile(&remote, &profiles_path).unwrap();

        let mut local = remote.clone();
        local.mods.push(crate::profiles::ProfileMod {
            name: "Local Edit".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: Some("LocalEdit".into()),
            mod_id: Some("LocalEdit".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        });
        crate::profiles::save_profile(&local, &profiles_path).unwrap();

        let saved = recover_owned_share_info_sidecar(
            "Solo Pack",
            &profiles_path,
            "Solomag",
            "290a56edb15d",
            &remote,
        )
        .unwrap();

        assert_eq!(saved.owner, "Solomag");
        assert_eq!(saved.code, "290A-56ED-B15D");
        assert_eq!(saved.share_format_version, SHARE_FORMAT_VERSION);
        assert_eq!(
            saved.published_signature.as_deref(),
            Some(profile_publish_signature(&remote).as_str()),
            "recovered sidecar must compare future local edits against the remote manifest, not the already-drifted local one"
        );
        assert!(
            share_info_path_for_profile(&remote, &profiles_path).exists(),
            "the recovery path must leave get_share_info/profile_is_owned with a durable ownership marker"
        );
    }

    #[tokio::test]
    async fn missing_owned_sidecar_recovers_from_subscription_and_token_owner() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path();
        let profiles_path = config_path.join("profiles");
        std::fs::create_dir_all(&profiles_path).unwrap();

        let mut remote = make_profile("Solo Pack", Some(false));
        remote.created_by = Some("Solomag".into());
        crate::profiles::save_profile(&remote, &profiles_path).unwrap();

        let mut local = remote.clone();
        local.mods.push(crate::profiles::ProfileMod {
            name: "Local Edit".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: Some("LocalEdit".into()),
            mod_id: Some("LocalEdit".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        });
        crate::profiles::save_profile(&local, &profiles_path).unwrap();

        let mut db = crate::subscriptions::SubscriptionsDb::default();
        db.subscriptions.insert(
            "Solomag:290a56edb15d".into(),
            crate::subscriptions::Subscription {
                share_id: "Solomag:290a56edb15d".into(),
                share_url: "Solomag/290A-56ED-B15D".into(),
                profile_name: "Solo Pack".into(),
                curator: Some("Solomag".into()),
                last_synced_profile: remote.clone(),
                last_checked: Utc::now(),
                last_synced: Utc::now(),
            },
        );
        crate::subscriptions::save_subscriptions(&db, config_path).unwrap();

        assert!(
            !share_info_path_for_profile(&remote, &profiles_path).exists(),
            "test setup should match the broken install state"
        );

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "Solomag"})),
            )
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path(
                "/repos/Solomag/sts2mm-profiles/contents/290a56edb15d.json",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(serde_json::to_string_pretty(&remote).unwrap()),
            )
            .expect(1)
            .mount(&server)
            .await;

        let saved = recover_owned_share_info_from_subscription(
            "Solo Pack",
            &profiles_path,
            config_path,
            Some("test-token"),
        )
        .await
        .expect("token owner should recover the missing share sidecar");

        assert_eq!(saved.owner, "Solomag");
        assert_eq!(saved.code, "290A-56ED-B15D");
        assert_eq!(
            saved.published_signature.as_deref(),
            Some(profile_publish_signature(&remote).as_str())
        );
        assert_ne!(
            profile_publish_signature(&local),
            saved.published_signature.unwrap(),
            "the recovered marker must keep the tester's local edits visible as drift"
        );
        assert!(share_info_path_for_profile(&remote, &profiles_path).exists());
    }

    fn make_profile(name: &str, public: Option<bool>) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public,
            mod_extras: Default::default(),
        }
    }

    #[test]
    fn reshare_preserves_existing_public_when_no_override() {
        let prior = make_profile("p", Some(true));
        let mut fresh = make_profile("p", None);
        // Mirror the merge from reshare_profile:
        fresh.public = prior.public;
        let list_public: Option<bool> = None;
        if let Some(p) = list_public {
            fresh.public = Some(p);
        }
        assert_eq!(fresh.public, Some(true));
    }

    #[test]
    fn reshare_overrides_when_caller_explicit() {
        let prior = make_profile("p", Some(true));
        let mut fresh = make_profile("p", None);
        fresh.public = prior.public;
        let list_public: Option<bool> = Some(false);
        if let Some(p) = list_public {
            fresh.public = Some(p);
        }
        assert_eq!(fresh.public, Some(false));
    }
}

#[cfg(test)]
mod share_orchestration_tests {
    //! End-to-end orchestration tests that drive `share_profile_impl`
    //! and `load_profile_for_publish_from_paths`. These exercise the
    //! cross-module routing (sharing/mod.rs orchestration → github::
    //! HTTP + upload:: bundling) so they live next to the orchestrator
    //! they verify.
    use super::*;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn write_mod_with_min_game_version(
        root: &std::path::Path,
        folder: &str,
        display: &str,
        min_game_version: Option<&str>,
    ) {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let min_game_version_field = min_game_version
            .map(|version| format!(r#","min_game_version":"{version}""#))
            .unwrap_or_default();
        std::fs::write(
            dir.join(format!("{folder}.json")),
            format!(r#"{{"id":"{folder}","name":"{display}","version":"1.0.0"{min_game_version_field}}}"#),
        )
        .unwrap();
        std::fs::write(dir.join(format!("{folder}.dll")), b"dll").unwrap();
    }

    fn write_mod(root: &std::path::Path, folder: &str, display: &str) {
        write_mod_with_min_game_version(root, folder, display, None);
    }

    fn profile_mod(name: &str, folder: &str) -> crate::profiles::ProfileMod {
        crate::profiles::ProfileMod {
            name: name.into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![format!("{folder}/{folder}.dll")],
            folder_name: Some(folder.into()),
            mod_id: Some(folder.into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        }
    }

    #[test]
    fn publish_preparation_uses_saved_profile_membership_not_entire_library() {
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "CuratedOnly", "Curated Only");
        write_mod(&mods_path, "LibraryExtra", "Library Extra");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: Some("0.105.0".into()),
            created_by: None,
            mods: vec![profile_mod("Curated Only", "CuratedOnly")],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            Some(false),
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            Some("0.105.0"),
            false,
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 1);
        assert_eq!(prepared.mods[0].name, "Curated Only");
        assert_eq!(prepared.public, Some(false));
    }

    #[test]
    fn publish_preparation_filters_saved_profile_mods_incompatible_with_current_game_version() {
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "StableOnly", "Stable Only");
        write_mod_with_min_game_version(&mods_path, "FutureBeta", "Future Beta", Some("9.0.0"));

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: Some("0.105.0".into()),
            created_by: None,
            mods: vec![
                profile_mod("Stable Only", "StableOnly"),
                profile_mod("Future Beta", "FutureBeta"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            Some("0.105.0"),
            false,
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 1);
        assert_eq!(prepared.mods[0].name, "Stable Only");
    }

    #[test]
    fn publish_preparation_refreshes_stale_files_for_reinstalled_mod() {
        // Issue #174: the curator deleted "End Run Graph" and reinstalled
        // it -- the new Nexus archive unpacked into a version-suffixed
        // folder ("EndRunGraph-v2"), so the saved pack entry's `files`
        // (pointing at the old "EndRunGraph" folder) no longer exist on
        // disk. Preparation must resolve the entry to the new install
        // (same identity keys: mod_id/folder_name match the *new*
        // folder... but here we match via `name` since folder_name
        // differs) and refresh `files`/`folder_name`/`version` so
        // bundling reads from the new location.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        // Only the NEW folder exists on disk -- the old one was deleted.
        write_mod(&mods_path, "EndRunGraphV2", "End Run Graph");

        // The saved pack entry still references the OLD folder/files and
        // an older version string. Both `mod_id` and `folder_name` are
        // cleared so identity falls back to matching on `name` -- exactly
        // what happens when a reinstall lands under a fresh
        // version-suffixed folder with a different manifest `id`.
        let mut stale_pm = profile_mod("End Run Graph", "EndRunGraph");
        stale_pm.mod_id = None;
        stale_pm.folder_name = None;
        stale_pm.files = vec![
            "EndRunGraph/EndRunGraph.json".into(),
            "EndRunGraph/EndRunGraph.dll".into(),
        ];
        stale_pm.version = "0.9.0".into();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![stale_pm],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();

        assert!(
            not_installed.is_empty(),
            "the reinstalled mod should resolve to the new install: {not_installed:?}"
        );
        assert_eq!(prepared.mods.len(), 1);
        let pm = &prepared.mods[0];
        assert_eq!(pm.name, "End Run Graph");
        // `files` now point at the NEW folder, matching what's on disk --
        // this is what makes `zip_profile_mod_files` succeed instead of
        // erroring with "missing declared file". (Sorted order: .dll
        // before .json; normalize separators for cross-platform CI.)
        let normalized_files: Vec<String> = pm.files.iter().map(|f| f.replace('\\', "/")).collect();
        assert_eq!(
            normalized_files,
            vec![
                "EndRunGraphV2/EndRunGraphV2.dll".to_string(),
                "EndRunGraphV2/EndRunGraphV2.json".to_string(),
            ]
        );
        assert_eq!(pm.folder_name, Some("EndRunGraphV2".into()));
        assert_eq!(pm.version, "1.0.0");

        // Bundling must now succeed against the refreshed files.
        super::upload::zip_profile_mod_files(pm, &mods_path, &disabled_path)
            .expect("refreshed files must zip successfully from the new install location");
    }

    #[test]
    fn publish_preparation_reports_pack_entry_with_no_installed_match() {
        // Issue #174: if the curator removed a mod entirely (not just
        // reinstalled it under a new folder), the pack entry resolves to
        // NO installed mod. Preparation must not let bundling attempt
        // this (it would fail with a confusing "missing declared file"
        // zip error); instead it reports the mod name via `not_installed`
        // and clears `files` so the bundling loop skips it.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "StillHere", "Still Here");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("Still Here", "StillHere"),
                profile_mod("Long Gone", "LongGone"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();

        // The entry is retained (so the curator can still see/remove it
        // from the pack) but flagged as not installed.
        assert_eq!(prepared.mods.len(), 2);
        assert_eq!(not_installed, vec!["Long Gone".to_string()]);
        let missing_pm = prepared
            .mods
            .iter()
            .find(|m| m.name == "Long Gone")
            .unwrap();
        assert!(
            missing_pm.files.is_empty(),
            "files must be cleared so the bundling loop skips this entry"
        );

        // The other entry resolves normally and keeps its files.
        let ok_pm = prepared
            .mods
            .iter()
            .find(|m| m.name == "Still Here")
            .unwrap();
        assert!(!ok_pm.files.is_empty());
    }

    #[test]
    fn publish_preparation_excludes_stored_disabled_mods_for_active_pack() {
        // 4.7 — a mod that lives in mods_disabled (stored / disabled on
        // disk) must not be bundled for upload even though it's listed as
        // a member of the modpack -- but ONLY when this is the ACTIVE
        // pack (`exclude_stored_members = true`). This also covers the
        // disable-in-game-then-reshare leak. Stored exclusion applies
        // regardless of game version, so we pass None here.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "ActiveMod", "Active Mod");
        write_mod(&disabled_path, "StoredMod", "Stored Mod");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("Active Mod", "ActiveMod"),
                profile_mod("Stored Mod", "StoredMod"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            true,
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 1);
        assert_eq!(prepared.mods[0].name, "Active Mod");
    }

    #[test]
    fn publish_preparation_keeps_stored_disabled_mods_for_nonactive_pack() {
        // Bug fix: a NON-active pack's members are usually stored
        // (disabled on disk) -- excluding them here would silently strip
        // them from the published pack (and, before the merge-not-overwrite
        // fix in Part A, from the local manifest too). With
        // `exclude_stored_members = false`, a stored member survives the
        // filter and is bundled from the disabled folder.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "ActiveMod", "Active Mod");
        write_mod(&disabled_path, "StoredMod", "Stored Mod");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("Active Mod", "ActiveMod"),
                profile_mod("Stored Mod", "StoredMod"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 2);
        assert!(
            prepared.mods.iter().any(|m| m.name == "Stored Mod"),
            "stored member must survive the filter for a non-active pack"
        );

        // Bundling must succeed against the stored member's files --
        // `zip_profile_mod_files` falls back to the disabled folder.
        let stored_pm = prepared
            .mods
            .iter()
            .find(|m| m.name == "Stored Mod")
            .unwrap();
        super::upload::zip_profile_mod_files(stored_pm, &mods_path, &disabled_path)
            .expect("stored member must bundle from the disabled folder");
    }

    #[test]
    fn publish_preparation_backfills_source_from_curator_sources_db() {
        // The export-side half of the "imported pack shows Unlinked" fix:
        // most mod manifests declare no Source, so the curator's GitHub/Nexus
        // link lives only in their mod_sources.json. Publishing must stamp it
        // into ProfileMod.source so friends installing the pack get the chip.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        // Two mods on disk, neither with a manifest Source.
        write_mod(&mods_path, "AutoPath", "AutoPath");
        write_mod(&mods_path, "NexusMod", "Nexus Mod");

        // Curator has linked both locally: one GitHub, one Nexus.
        let mut db = crate::mod_sources::ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".into(),
            crate::mod_sources::parse_source_url("github:author/AutoPath").unwrap(),
        );
        db.mods.insert(
            "NexusMod".into(),
            crate::mod_sources::parse_source_url("nexus:slaythespire2/mods/55").unwrap(),
        );
        crate::mod_sources::save_sources(&db, tmpdir.path()).unwrap();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("AutoPath", "AutoPath"),
                profile_mod("Nexus Mod", "NexusMod"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();

        let by_name = |n: &str| {
            prepared
                .mods
                .iter()
                .find(|m| m.name == n)
                .unwrap_or_else(|| panic!("{n} present"))
        };
        assert_eq!(
            by_name("AutoPath").source.as_deref(),
            Some("github:author/AutoPath"),
            "GitHub link must be stamped from the curator's sources DB"
        );
        assert_eq!(
            by_name("Nexus Mod").source.as_deref(),
            Some("nexus:slaythespire2/mods/55"),
            "Nexus link must be stamped too, not dropped"
        );
    }

    #[test]
    fn publish_preparation_keeps_existing_profile_source_over_db() {
        // Fill-only: a source already on the saved profile mod (e.g. a prior
        // share resolved it, or the manifest declared it) must win over the
        // DB so re-sharing never downgrades a good link.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();
        write_mod(&mods_path, "AutoPath", "AutoPath");

        let mut db = crate::mod_sources::ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".into(),
            crate::mod_sources::parse_source_url("github:wrong/Repo").unwrap(),
        );
        crate::mod_sources::save_sources(&db, tmpdir.path()).unwrap();

        let mut pm = profile_mod("AutoPath", "AutoPath");
        pm.source = Some("github:correct/AutoPath".into());
        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![pm],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let (prepared, _not_installed) = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            prepared.mods[0].source.as_deref(),
            Some("github:correct/AutoPath"),
            "an existing profile source must not be overwritten by the DB"
        );
    }

    /// Verifies: user lookup -> repo exists -> bundle uploaded via releases
    /// (not Contents API) -> manifest written via Contents API with both
    /// `bundle_url` and `bundle_sha256` set on the persisted profile.
    #[tokio::test]
    async fn share_profile_routes_bundles_through_releases_and_persists_hash() {
        // Reuse the env-var lock from `release_upload_tests` — STS2_GITHUB_API_BASE
        // is process-global, so we serialize against the other wiremock tests.
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "TestMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
            })))
            .expect(1)   // exactly one bundle upload — pins the route
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server).await;

        // Build a minimal Profile with one mod that has a file on disk.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();

        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: None,
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };

        let disabled_path = tmpdir.path().join("mods_disabled");
        std::fs::create_dir_all(&disabled_path).unwrap();

        let result = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            None,
            None,
            Vec::new(),
        )
        .await
        .expect("share should succeed");

        assert!(result.repo_url.contains("sts2mm-profiles"));
        assert!(
            result.failed_uploads.is_empty(),
            "expected no failures, got {:?}",
            result.failed_uploads
        );

        // Verify the persisted profile got both bundle_url and bundle_sha256.
        let saved = crate::profiles::load_profile("test", &profiles_path).unwrap();
        assert_eq!(saved.created_by.as_deref(), Some("octo"));
        let m = &saved.mods[0];
        assert!(
            m.bundle_url
                .as_deref()
                .map(|u| u.contains("releases/download/bundles/TestMod_v1.0.0.zip"))
                .unwrap_or(false),
            "expected release URL, got {:?}",
            m.bundle_url
        );
        assert!(m.bundle_sha256.is_some(), "expected hash to be persisted");

        let share_info_text =
            std::fs::read_to_string(share_info_path_for_profile(&saved, &profiles_path)).unwrap();
        let share_info: ShareInfo = serde_json::from_str(&share_info_text).unwrap();
        let fingerprint = share_info
            .bundle_source_fingerprints
            .get("folder:testmod")
            .expect(
                "successful share should persist the source fingerprint for future re-share skips",
            );
        assert!(
            fingerprint.starts_with("v1:1.0.0:"),
            "source fingerprint must include the profile mod version: {fingerprint}"
        );
    }

    #[tokio::test]
    async fn share_profile_skips_existing_bundle_when_source_fingerprint_matches() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server)
            .await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("large.pck"), vec![7u8; 1024 * 1024]).unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile_mod = crate::profiles::ProfileMod {
            name: "TestMod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["TestMod".into()],
            folder_name: Some("TestMod".into()),
            mod_id: None,
            enabled: true,
            bundle_url: Some(
                "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
                    .into(),
            ),
            bundle_sha256: Some("already-uploaded-zip-hash".into()),
            bundle_members: vec![],
        };
        let fingerprint_key = bundle_source_fingerprint_key(&profile_mod);
        let source_fingerprint = bundle_source_fingerprint_value(
            &profile_mod,
            &fingerprint_profile_mod_files(&profile_mod, &mods_path, &disabled_path).unwrap(),
        );
        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![profile_mod],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();
        let share_info = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "octo".into(),
            file_sha: Some("old-sha".into()),
            share_format_version: SHARE_FORMAT_VERSION,
            published_signature: None,
            bundle_source_fingerprints: HashMap::from([(fingerprint_key, source_fingerprint)]),
            bundle_source_fast_fingerprints: HashMap::new(),
        };
        save_share_info(
            &share_info_path_for_profile(&profile, &profiles_path),
            &share_info,
        )
        .unwrap();

        let progress_events =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::<ShareProgress>::new()));
        let progress_events_for_emit = progress_events.clone();
        let emit = move |_event: &str, payload: ShareProgress| {
            progress_events_for_emit.lock().unwrap().push(payload);
        };

        let result = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            Some(&emit),
            None,
            Vec::new(),
        )
        .await
        .expect("share should reuse existing bundle and publish manifest");

        assert!(result.failed_uploads.is_empty());
        let stages: Vec<&'static str> = progress_events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.stage)
            .collect();
        assert!(
            stages.contains(&"checking-bundle"),
            "publish should still fingerprint before deciding to reuse: {stages:?}"
        );
        assert!(
            !stages.contains(&"bundling"),
            "unchanged existing bundles must skip the expensive zip/upload stage: {stages:?}"
        );
        assert!(
            stages.contains(&"uploading-manifest"),
            "publish should still update the profile manifest after reusing bundles: {stages:?}"
        );
        let saved = crate::profiles::load_profile("test", &profiles_path).unwrap();
        assert_eq!(
            saved.mods[0].bundle_sha256.as_deref(),
            Some("already-uploaded-zip-hash"),
            "unchanged bundle should be reused before zip/upload"
        );
        let saved_share_info: ShareInfo = serde_json::from_str(
            &std::fs::read_to_string(share_info_path_for_profile(&saved, &profiles_path)).unwrap(),
        )
        .unwrap();
        assert!(
            saved_share_info
                .bundle_source_fast_fingerprints
                .contains_key("folder:testmod"),
            "legacy strong-fingerprint skips should backfill the fast map for the next re-share"
        );
    }

    #[tokio::test]
    async fn share_profile_skips_existing_bundle_when_fast_metadata_fingerprint_matches() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server)
            .await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("large.pck"), vec![9u8; 1024 * 1024]).unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile_mod = crate::profiles::ProfileMod {
            name: "TestMod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["TestMod".into()],
            folder_name: Some("TestMod".into()),
            mod_id: None,
            enabled: true,
            bundle_url: Some(
                "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
                    .into(),
            ),
            bundle_sha256: Some("already-uploaded-zip-hash".into()),
            bundle_members: vec![],
        };
        let fingerprint_key = bundle_source_fingerprint_key(&profile_mod);
        let source_fast_fingerprint = bundle_source_fast_fingerprint_value(
            &profile_mod,
            &fingerprint_profile_mod_file_metadata(&profile_mod, &mods_path, &disabled_path)
                .unwrap(),
        );
        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "test-fast".into(),
            game_version: None,
            created_by: None,
            mods: vec![profile_mod],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();
        let share_info = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "octo".into(),
            file_sha: Some("old-sha".into()),
            share_format_version: SHARE_FORMAT_VERSION,
            published_signature: None,
            bundle_source_fingerprints: HashMap::new(),
            bundle_source_fast_fingerprints: HashMap::from([(
                fingerprint_key,
                source_fast_fingerprint,
            )]),
        };
        save_share_info(
            &share_info_path_for_profile(&profile, &profiles_path),
            &share_info,
        )
        .unwrap();

        let progress_events =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::<ShareProgress>::new()));
        let progress_events_for_emit = progress_events.clone();
        let emit = move |_event: &str, payload: ShareProgress| {
            progress_events_for_emit.lock().unwrap().push(payload);
        };

        let result = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            Some(&emit),
            None,
            Vec::new(),
        )
        .await
        .expect("share should skip zip/upload from the fast metadata fingerprint");

        assert!(result.failed_uploads.is_empty());
        let stages: Vec<&'static str> = progress_events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.stage)
            .collect();
        assert!(stages.contains(&"checking-bundle"));
        assert!(
            !stages.contains(&"bundling"),
            "fast metadata matches must skip the expensive zip/upload stage: {stages:?}"
        );
        assert!(stages.contains(&"uploading-manifest"));
    }

    #[tokio::test]
    async fn share_profile_reuses_matching_bundle_from_another_owned_profile_before_zip() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server)
            .await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("large.pck"), vec![3u8; 1024 * 1024]).unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let shared_mod = crate::profiles::ProfileMod {
            name: "TestMod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["TestMod".into()],
            folder_name: Some("TestMod".into()),
            mod_id: Some("test.mod".into()),
            enabled: true,
            bundle_url: Some(
                "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
                    .into(),
            ),
            bundle_sha256: Some("already-uploaded-zip-hash".into()),
            bundle_members: vec![],
        };
        let fingerprint_key = bundle_source_fingerprint_key(&shared_mod);
        let source_fast_fingerprint = bundle_source_fast_fingerprint_value(
            &shared_mod,
            &fingerprint_profile_mod_file_metadata(&shared_mod, &mods_path, &disabled_path)
                .unwrap(),
        );
        let seed_profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Seed Pack".into(),
            game_version: None,
            created_by: Some("octo".into()),
            mods: vec![shared_mod],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&seed_profile, &profiles_path).unwrap();
        let seed_share_info = ShareInfo {
            code: "SEED-BBBB-CCCC".into(),
            owner: "octo".into(),
            file_sha: Some("old-sha".into()),
            share_format_version: SHARE_FORMAT_VERSION,
            published_signature: None,
            bundle_source_fingerprints: HashMap::new(),
            bundle_source_fast_fingerprints: HashMap::from([(
                fingerprint_key,
                source_fast_fingerprint,
            )]),
        };
        save_share_info(
            &share_info_path_for_profile(&seed_profile, &profiles_path),
            &seed_share_info,
        )
        .unwrap();

        let current_profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "Current Pack".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: Some("test.mod".into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&current_profile, &profiles_path).unwrap();

        let progress_events =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::<ShareProgress>::new()));
        let progress_events_for_emit = progress_events.clone();
        let emit = move |_event: &str, payload: ShareProgress| {
            progress_events_for_emit.lock().unwrap().push(payload);
        };

        let result = share_profile_impl(
            current_profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            Some(&emit),
            None,
            Vec::new(),
        )
        .await
        .expect("share should reuse another owned profile's matching bundle");

        assert!(result.failed_uploads.is_empty());
        let stages: Vec<&'static str> = progress_events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.stage)
            .collect();
        assert!(stages.contains(&"checking-bundle"));
        assert!(
            !stages.contains(&"bundling"),
            "matching bundles from other owned packs must skip zip/upload: {stages:?}"
        );
        assert!(stages.contains(&"uploading-manifest"));
        let saved = crate::profiles::load_profile("Current Pack", &profiles_path).unwrap();
        assert_eq!(
            saved.mods[0].bundle_url.as_deref(),
            Some("https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip")
        );
        assert_eq!(
            saved.mods[0].bundle_sha256.as_deref(),
            Some("already-uploaded-zip-hash")
        );
    }

    #[tokio::test]
    async fn share_profile_honors_cancel_before_bundling_first_mod() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "cancel-me".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: None,
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };

        let progress_events =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::<ShareProgress>::new()));
        let progress_events_for_emit = progress_events.clone();
        let emit = move |_event: &str, payload: ShareProgress| {
            progress_events_for_emit.lock().unwrap().push(payload);
        };
        let cancel = || true;

        let err = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            Some(&emit),
            Some(&cancel),
            Vec::new(),
        )
        .await
        .expect_err("cancel should stop share before bundling starts");

        assert!(
            err.to_string().contains("Sharing canceled"),
            "unexpected cancel error: {err}"
        );
        assert!(
            progress_events.lock().unwrap().is_empty(),
            "cancel before the first mod should not emit bundling or upload progress"
        );
    }

    #[tokio::test]
    async fn share_profile_bubbles_cancel_from_bundle_checks() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("asset.bin"), vec![42u8; 2 * 1024 * 1024]).unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "cancel-during-check".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: None,
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };

        let calls = AtomicUsize::new(0);
        let cancel = || calls.fetch_add(1, Ordering::SeqCst) > 2;

        let err = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            None,
            Some(&cancel),
            Vec::new(),
        )
        .await
        .expect_err("cancel inside bundle checks should stop the share");

        assert!(
            err.to_string().contains("Sharing canceled"),
            "unexpected cancel error: {err}"
        );
    }

    /// Bug fix (publish-nonactive-pack), test 2: sharing a NON-active pack
    /// with `exclude_stored_members = false` must publish AND keep ALL
    /// members -- including one that's stored (disabled on disk) -- in the
    /// LOCAL on-disk manifest. Before the merge-not-overwrite fix in Part A,
    /// `share_profile_impl` saved the filtered (upload) copy back over the
    /// local JSON, silently deleting the stored member from the pack.
    #[tokio::test]
    async fn share_nonactive_pack_keeps_stored_member_in_local_manifest() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "Bundle_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/Bundle_v1.0.0.zip"
            })))
            .expect(2) // both members get bundled for a non-active pack
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server).await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        // ActiveMod is enabled (in mods/); StoredMod is disabled (in
        // mods_disabled/) -- as it would be for a non-active pack, whose
        // members are usually not the ones currently enabled.
        write_mod(&mods_path, "ActiveMod", "Active Mod");
        write_mod(&disabled_path, "StoredMod", "Stored Mod");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "NonActivePack".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("Active Mod", "ActiveMod"),
                profile_mod("Stored Mod", "StoredMod"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        // Non-active pack: exclude_stored_members = false.
        let (uploaded, not_installed) = load_profile_for_publish_from_paths(
            "NonActivePack",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            false,
        )
        .unwrap();
        assert_eq!(
            uploaded.mods.len(),
            2,
            "both members must survive the filter for a non-active pack"
        );

        let result = share_profile_impl(
            uploaded,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            None,
            None,
            not_installed,
        )
        .await
        .expect("share of a non-active pack should succeed");
        assert!(result.failed_uploads.is_empty());

        // The LOCAL manifest must still contain BOTH members -- the stored
        // one must NOT have been deleted.
        let saved = crate::profiles::load_profile("NonActivePack", &profiles_path).unwrap();
        assert_eq!(
            saved.mods.len(),
            2,
            "local manifest must keep all pack members after sharing a non-active pack"
        );
        assert!(
            saved.mods.iter().any(|m| m.name == "Stored Mod"),
            "stored member must not be deleted from the local manifest: {:?}",
            saved.mods.iter().map(|m| &m.name).collect::<Vec<_>>()
        );
        // And it must have picked up bundle enrichment too.
        let stored = saved.mods.iter().find(|m| m.name == "Stored Mod").unwrap();
        assert!(
            stored.bundle_url.is_some() && stored.bundle_sha256.is_some(),
            "stored member must be enriched with its uploaded bundle info"
        );
    }

    /// Bug fix (publish-nonactive-pack), test 3: sharing the ACTIVE pack
    /// with `exclude_stored_members = true` still excludes the stored
    /// member from the UPLOADED manifest (existing behavior), but the
    /// LOCAL manifest keeps it (no deletion), and the stored
    /// `published_signature` is computed from the LOCAL manifest so
    /// `get_share_info`'s out-of-sync check reports in-sync right after
    /// publish (no false "Out of sync" banner).
    #[tokio::test]
    async fn share_active_pack_excludes_stored_member_from_upload_but_keeps_it_locally() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "Bundle_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/Bundle_v1.0.0.zip"
            })))
            .expect(1) // only the active (non-stored) member is bundled
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server).await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "ActiveMod", "Active Mod");
        write_mod(&disabled_path, "StoredMod", "Stored Mod");

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "ActivePack".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                profile_mod("Active Mod", "ActiveMod"),
                profile_mod("Stored Mod", "StoredMod"),
            ],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        // Active pack: exclude_stored_members = true.
        let (uploaded, not_installed) = load_profile_for_publish_from_paths(
            "ActivePack",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            uploaded.mods.len(),
            1,
            "the stored member must be excluded from the uploaded manifest"
        );
        assert_eq!(uploaded.mods[0].name, "Active Mod");

        let result = share_profile_impl(
            uploaded,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            None,
            None,
            not_installed,
        )
        .await
        .expect("share of the active pack should succeed");
        assert!(result.failed_uploads.is_empty());

        // The LOCAL manifest must still contain BOTH members.
        let saved = crate::profiles::load_profile("ActivePack", &profiles_path).unwrap();
        assert_eq!(
            saved.mods.len(),
            2,
            "local manifest must keep the stored member even though it wasn't uploaded"
        );
        assert!(saved.mods.iter().any(|m| m.name == "Stored Mod"));

        // The stored .share sidecar's published_signature must match the
        // signature of the LOCAL (merged) manifest -- not the filtered
        // upload -- so get_share_info reports in-sync right after publish.
        let share_info_path = share_info_path_for_profile(&saved, &profiles_path);
        let share_info: ShareInfo =
            serde_json::from_str(&std::fs::read_to_string(&share_info_path).unwrap()).unwrap();
        let local_sig = profile_publish_signature(&saved);
        assert_eq!(
            share_info.published_signature.as_deref(),
            Some(local_sig.as_str()),
            "published_signature must be computed from the local (merged) manifest, \
             not the filtered upload, to avoid a false 'Out of sync' banner"
        );
    }

    #[tokio::test]
    async fn share_fetch_and_download_round_trips_through_github_api() {
        let _env_guard = super::github::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})),
            )
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "sts2mm-profiles"})),
            )
            .mount(&server)
            .await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "TestMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("PUT")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server).await;

        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(
            mod_dir.join("TestMod.json"),
            br#"{"id":"TestMod","name":"TestMod","version":"1.0.0","author":"QA"}"#,
        )
        .unwrap();
        std::fs::write(mod_dir.join("TestMod.dll"), b"github-api-uploaded-dll").unwrap();

        let disabled_path = tmpdir.path().join("mods_disabled");
        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = Profile {
            id: crate::profiles::new_profile_id(),
            name: "api-round-trip".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: Some("TestMod".into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(false),
            mod_extras: Default::default(),
        };

        let result = share_profile_impl(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            "test-token",
            None,
            None,
            Vec::new(),
        )
        .await
        .expect("share should upload bundle and manifest through the GitHub API");

        let uploaded_bundle = server
            .received_requests()
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|request| {
                request.method.as_str() == "POST"
                    && request.url.path() == "/repos/octo/sts2mm-profiles/releases/42/assets"
            })
            .map(|request| request.body)
            .expect("release asset upload request should be recorded");

        Mock::given(method("GET"))
            .and(path(format!(
                "/repos/octo/sts2mm-profiles/contents/{}",
                result.file_path
            )))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    serde_json::to_string_pretty(
                        &crate::profiles::load_profile("api-round-trip", &profiles_path).unwrap(),
                    )
                    .unwrap(),
                ),
            )
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path(
                "/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(uploaded_bundle))
            .expect(1)
            .mount(&server)
            .await;

        let fetched = fetch_shared_profile("octo", &result.file_path, Some("test-token"))
            .await
            .expect("shared manifest should be fetched through the GitHub Contents API");
        assert_eq!(fetched.created_by.as_deref(), Some("octo"));
        let bundle_url = fetched.mods[0]
            .bundle_url
            .as_deref()
            .expect("published profile should carry a release bundle URL");
        assert!(bundle_url.contains("/releases/download/bundles/TestMod_v1.0.0.zip"));

        let friend_mods = tmpdir.path().join("friend-mods");
        std::fs::create_dir_all(&friend_mods).unwrap();
        download_bundle(bundle_url, "TestMod", &friend_mods, None)
            .await
            .expect("release asset bundle should download through the GitHub release URL path");

        assert_eq!(
            std::fs::read(friend_mods.join("TestMod").join("TestMod.dll")).unwrap(),
            b"github-api-uploaded-dll"
        );

        std::env::remove_var("STS2_GITHUB_RELEASES_BASE");
    }
}

#[cfg(test)]
mod bundle_share_roundtrip_tests {
    //! Share round-trip for a bundle: zip a sidecar-tagged container with
    //! two member mods, extract into a fresh mods dir, scan → verify the
    //! result is ONE bundle entry whose bundle_members lists both members
    //! and whose files include the sidecar.
    //!
    //! Does NOT touch GitHub (no wiremock needed). We drive
    //! `zip_profile_mod_files` + `zip_entry_outpath` (the same helpers
    //! the real share path uses) to prove the sidecar survives the
    //! zip → extract round-trip.

    use super::upload::{zip_entry_outpath, zip_profile_mod_files};
    use crate::mods::bundle::{write_sidecar, BundleSidecar, SIDECAR_FILENAME};
    use crate::mods::scan_mods;

    /// Build a 2-member bundle container in `mods_path`:
    ///
    /// ```text
    /// mods/
    ///   PackContainer/
    ///     .sts2mm-bundle.json   (sidecar, display_name = "My Pack")
    ///     CoreMod/
    ///       CoreMod.json
    ///       CoreMod.dll
    ///     ArtMod/
    ///       ArtMod.json
    ///       ArtMod.dll
    /// ```
    fn build_bundle_on_disk(mods_path: &std::path::Path) {
        let container = mods_path.join("PackContainer");
        std::fs::create_dir_all(&container).unwrap();

        // Sidecar
        write_sidecar(
            &container,
            &BundleSidecar {
                display_name: "My Pack".into(),
                installed_version: Some("2.0.0".into()),
                ..Default::default()
            },
        )
        .unwrap();

        // Member 1: CoreMod
        let core = container.join("CoreMod");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(
            core.join("CoreMod.json"),
            br#"{"id":"CoreMod","name":"Core Mod","version":"2.0.0"}"#,
        )
        .unwrap();
        std::fs::write(core.join("CoreMod.dll"), b"core-dll").unwrap();

        // Member 2: ArtMod
        let art = container.join("ArtMod");
        std::fs::create_dir_all(&art).unwrap();
        std::fs::write(
            art.join("ArtMod.json"),
            br#"{"id":"ArtMod","name":"Art Mod","version":"2.0.0"}"#,
        )
        .unwrap();
        std::fs::write(art.join("ArtMod.dll"), b"art-dll").unwrap();
    }

    #[test]
    fn shared_bundle_reconstructs_as_bundle_for_friend() {
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        std::fs::create_dir_all(&mods_path).unwrap();

        // Install the bundle on the curator's side.
        build_bundle_on_disk(&mods_path);

        // Scan to get the bundle ModInfo.
        let installed = scan_mods(&mods_path);
        let bundle = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("PackContainer"))
            .expect("scanner must find the bundle container as one ModInfo");

        assert!(
            !bundle.bundle_members.is_empty(),
            "scan must populate bundle_members for the container"
        );
        assert!(
            bundle.files.iter().any(|f| f.contains(SIDECAR_FILENAME)),
            "bundle files must include the sidecar: {:?}",
            bundle.files
        );

        // Build a ProfileMod from the installed ModInfo.
        // This mirrors what profile_mod_from_installed now does: it copies
        // bundle_members from the installed ModInfo into the ProfileMod so
        // the shared manifest carries member info.
        let pm = crate::profiles::ProfileMod {
            name: bundle.name.clone(),
            version: bundle.version.clone(),
            source: bundle.source.clone(),
            hash: bundle.hash.clone(),
            files: bundle.files.clone(),
            folder_name: bundle.folder_name.clone(),
            mod_id: bundle.mod_id.clone(),
            enabled: bundle.enabled,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: bundle.bundle_members.clone(),
        };
        assert_eq!(
            pm.bundle_members, bundle.bundle_members,
            "ProfileMod must carry bundle_members from the installed ModInfo"
        );

        // Zip the bundle (curator side — mirrors share_profile_impl).
        let disabled_path = tmpdir.path().join("mods_disabled");
        std::fs::create_dir_all(&disabled_path).unwrap();
        let zip_data = zip_profile_mod_files(&pm, &mods_path, &disabled_path)
            .expect("zipping the bundle container must succeed");

        // Extract into a FRESH mods dir (friend side — mirrors download_bundle).
        let friend_mods = tmpdir.path().join("friend_mods");
        std::fs::create_dir_all(&friend_mods).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_data)).expect("valid zip");
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("valid entry");
            let name = entry.name().to_string();
            let Some(out_path) = zip_entry_outpath(&friend_mods, &name) else {
                continue;
            };
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            if !name.ends_with('/') {
                let mut file = std::fs::File::create(&out_path).unwrap();
                std::io::copy(&mut entry, &mut file).unwrap();
            }
        }

        // Scan the friend's mods dir — must see exactly ONE bundle entry.
        let friend_installed = scan_mods(&friend_mods);
        assert_eq!(
            friend_installed.len(),
            1,
            "friend must see exactly one bundle entry, not multiple: {:?}",
            friend_installed.iter().map(|m| &m.name).collect::<Vec<_>>()
        );

        let friend_bundle = &friend_installed[0];

        assert!(
            !friend_bundle.bundle_members.is_empty(),
            "reconstructed bundle must list bundle_members"
        );
        assert_eq!(
            friend_bundle.bundle_members.len(),
            2,
            "must list both member mods, got {:?}",
            friend_bundle.bundle_members
        );
        assert!(
            friend_bundle
                .files
                .iter()
                .any(|f| f.contains(SIDECAR_FILENAME)),
            "reconstructed bundle files must include the sidecar: {:?}",
            friend_bundle.files
        );
        assert_eq!(
            friend_bundle.folder_name.as_deref(),
            Some("PackContainer"),
            "folder_name must match the container directory"
        );
    }
}

#[cfg(test)]
mod publish_signature_tests {
    use super::*;
    use chrono::Utc;

    fn make_mod(name: &str, version: &str, enabled: bool) -> crate::profiles::ProfileMod {
        crate::profiles::ProfileMod {
            name: name.into(),
            version: version.into(),
            source: None,
            hash: None,
            files: vec![format!("{name}/{name}.dll")],
            folder_name: Some(name.into()),
            mod_id: Some(name.into()),
            enabled,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        }
    }

    fn base_profile() -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: "TestPack".into(),
            game_version: None,
            created_by: Some("alice".into()),
            mods: vec![
                make_mod("ModA", "1.0.0", true),
                make_mod("ModB", "2.0.0", true),
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: Some(false),
            mod_extras: Default::default(),
        }
    }

    /// Curator extras (notes/links/tags) are publish metadata, not pack
    /// content — editing a note must never flag the pack out-of-sync.
    #[test]
    fn signature_ignores_mod_extras() {
        let plain = base_profile();
        let mut with_extras = base_profile();
        with_extras.mod_extras.insert(
            "ModA".into(),
            crate::profiles::SharedModExtras {
                note: Some("compat patch".into()),
                custom_url: Some("https://example.com".into()),
                tags: vec!["QoL".into()],
            },
        );
        assert_eq!(
            profile_publish_signature(&plain),
            profile_publish_signature(&with_extras),
            "mod_extras must not affect the publish signature"
        );
    }

    /// FR (Solo, 2026-06-10): publishing carries the curator's per-mod
    /// note/link/tags from the local sources DB into the manifest — and
    /// the opt-out path strips them, including stale ones left in the
    /// saved local JSON by a previous opted-in publish.
    #[test]
    fn publish_backfills_extras_and_opt_out_strips_them() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config");
        std::fs::create_dir_all(&config_path).unwrap();

        // The curator annotated ModA in their sources DB.
        let mut db = crate::mod_sources::ModSourcesDb::default();
        db.mods.insert(
            "ModA".into(),
            crate::mod_sources::ModSourceEntry {
                note: Some("downloaded from Patreon".into()),
                custom_url: Some("https://patreon.com/author".into()),
                tags: vec!["anime".into()],
                ..Default::default()
            },
        );
        crate::mod_sources::save_sources(&db, &config_path).unwrap();

        // Opt-in (default): extras ride along.
        let mut profile = base_profile();
        backfill_profile_extras_from_db(&mut profile, &config_path);
        let extras = profile
            .mod_extras
            .get("ModA")
            .expect("ModA extras published");
        assert_eq!(extras.note.as_deref(), Some("downloaded from Patreon"));
        assert_eq!(
            extras.custom_url.as_deref(),
            Some("https://patreon.com/author")
        );
        assert_eq!(extras.tags, vec!["anime".to_string()]);
        // ModB has no annotations — no empty entry is published for it.
        assert!(!profile.mod_extras.contains_key("ModB"));

        // Round-trip through the manifest JSON (what friends download).
        let json = serde_json::to_string(&profile).unwrap();
        let parsed: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.mod_extras.get("ModA"),
            profile.mod_extras.get("ModA")
        );
    }

    /// Step B test 1: signature is stable across updated_at and bundle fields.
    #[test]
    fn signature_stable_across_volatile_fields() {
        let profile1 = base_profile();

        // Build a profile that differs ONLY in updated_at and bundle_url/sha256.
        let mut profile2 = base_profile();
        // Shift updated_at by a second.
        profile2.updated_at = profile1.updated_at + chrono::Duration::seconds(1);
        // Set bundle_url and bundle_sha256 on every mod.
        for m in &mut profile2.mods {
            m.bundle_url = Some("https://example.com/bundle.zip".into());
            m.bundle_sha256 = Some("deadbeef".into());
        }

        assert_eq!(
            profile_publish_signature(&profile1),
            profile_publish_signature(&profile2),
            "signature must not change when only updated_at or bundle fields differ"
        );
    }

    /// Step B test 2: signature changes when a meaningful field changes.
    #[test]
    fn signature_changes_on_real_field_change() {
        let profile_original = base_profile();

        // Flip enabled on ModA.
        let mut profile_toggled = base_profile();
        profile_toggled.mods[0].enabled = false;

        assert_ne!(
            profile_publish_signature(&profile_original),
            profile_publish_signature(&profile_toggled),
            "signature must differ when a mod's enabled state flips"
        );

        // Change version of ModB.
        let mut profile_version_bumped = base_profile();
        profile_version_bumped.mods[1].version = "3.0.0".into();

        assert_ne!(
            profile_publish_signature(&profile_original),
            profile_publish_signature(&profile_version_bumped),
            "signature must differ when a mod's version changes"
        );

        // Add a new mod.
        let mut profile_extra_mod = base_profile();
        profile_extra_mod.mods.push(make_mod("ModC", "1.0.0", true));

        assert_ne!(
            profile_publish_signature(&profile_original),
            profile_publish_signature(&profile_extra_mod),
            "signature must differ when a mod is added"
        );
    }

    /// Step E: out_of_sync is false right after publish (signatures match),
    /// true after the local manifest is mutated, and false for a legacy
    /// .share with no published_signature.
    #[test]
    fn out_of_sync_detection_via_signature() {
        let dir = tempfile::tempdir().unwrap();
        let profiles_path = dir.path().join("profiles");
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = base_profile();
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let sig = profile_publish_signature(&profile);

        // --- Case 1: signature matches → not out of sync ---
        let loaded = crate::profiles::load_profile(&profile.name, &profiles_path).unwrap();
        let is_out_of_sync = profile_publish_signature(&loaded) != sig;
        assert!(
            !is_out_of_sync,
            "freshly saved profile should not be out of sync"
        );

        // --- Case 2: modify the local profile → out of sync ---
        let mut mutated = profile.clone();
        mutated.mods[0].enabled = false; // toggle a mod
        crate::profiles::save_profile(&mutated, &profiles_path).unwrap();

        let reloaded = crate::profiles::load_profile(&profile.name, &profiles_path).unwrap();
        let is_out_of_sync_after_edit = profile_publish_signature(&reloaded) != sig;
        assert!(
            is_out_of_sync_after_edit,
            "modified profile should be out of sync with original signature"
        );

        // --- Case 3: legacy .share (no published_signature) → never nag ---
        let share_info_path = profiles_path.join(format!("{}.share", profile.name));
        let legacy_info = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "alice".into(),
            file_sha: Some("abc123".into()),
            share_format_version: 1,
            published_signature: None,
            bundle_source_fingerprints: HashMap::new(),
            bundle_source_fast_fingerprints: HashMap::new(),
        };
        save_share_info(&share_info_path, &legacy_info).unwrap();

        let content = std::fs::read_to_string(&share_info_path).unwrap();
        let info: ShareInfo = serde_json::from_str(&content).unwrap();
        let out_of_sync_legacy = match info.published_signature.as_deref() {
            Some(saved_sig) => crate::profiles::load_profile(&profile.name, &profiles_path)
                .map(|p| profile_publish_signature(&p) != saved_sig)
                .unwrap_or(false),
            None => false,
        };
        assert!(
            !out_of_sync_legacy,
            "legacy .share with no published_signature should return false (don't nag)"
        );
    }
}

#[cfg(test)]
mod merge_publish_enrichment_tests {
    use super::*;
    use chrono::Utc;

    fn make_mod(name: &str, version: &str) -> crate::profiles::ProfileMod {
        crate::profiles::ProfileMod {
            name: name.into(),
            version: version.into(),
            source: None,
            hash: None,
            files: vec![format!("{name}/{name}.dll")],
            folder_name: Some(name.into()),
            mod_id: Some(name.into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        }
    }

    fn make_profile(name: &str, mods: Vec<crate::profiles::ProfileMod>) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    /// bundle_url/bundle_sha256 from the uploaded (filtered) profile must
    /// land on the matching on-disk mod, without disturbing other fields.
    #[test]
    fn merge_copies_bundle_url_and_sha256_onto_matching_on_disk_mod() {
        let on_disk = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);

        let mut uploaded_mod = make_mod("Mod A", "1.0.0");
        uploaded_mod.bundle_url = Some("https://example.com/a.zip".into());
        uploaded_mod.bundle_sha256 = Some("deadbeef".into());
        let uploaded = make_profile("Pack", vec![uploaded_mod]);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);

        assert_eq!(merged.mods.len(), 1);
        assert_eq!(
            merged.mods[0].bundle_url.as_deref(),
            Some("https://example.com/a.zip")
        );
        assert_eq!(merged.mods[0].bundle_sha256.as_deref(), Some("deadbeef"));
    }

    /// Publish preparation can refresh stale saved entries (for example,
    /// after a mod is reinstalled into a new folder or an older installed
    /// version replaces a stale manifest row). The local manifest must get
    /// those refreshed disk-derived fields back, or later shares compare
    /// bundles against stale visible metadata.
    #[test]
    fn merge_copies_refreshed_disk_fields_onto_matching_on_disk_mod() {
        let mut stale_mod = make_mod("BaseLib", "v3.1.4");
        stale_mod.files = vec!["BaseLib/BaseLib.dll".into()];
        stale_mod.folder_name = Some("BaseLib".into());
        stale_mod.mod_id = Some("BaseLib".into());
        let on_disk = make_profile("Pack", vec![stale_mod]);

        let mut uploaded_mod = make_mod("BaseLib", "v3.1.3");
        uploaded_mod.files = vec![
            "BaseLib/BaseLib.dll".into(),
            "BaseLib/BaseLib.json".into(),
            "BaseLib/assets/config.json".into(),
        ];
        uploaded_mod.folder_name = Some("BaseLib".into());
        uploaded_mod.mod_id = Some("BaseLib".into());
        uploaded_mod.bundle_members = vec!["BaseLib".into(), "BaseLib UI".into()];
        uploaded_mod.bundle_url = Some("https://example.com/BaseLib_v3.1.3.zip".into());
        uploaded_mod.bundle_sha256 = Some("deadbeef".into());
        let uploaded = make_profile("Pack", vec![uploaded_mod]);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);

        assert_eq!(merged.mods[0].version, "v3.1.3");
        assert_eq!(
            merged.mods[0].files,
            vec![
                "BaseLib/BaseLib.dll".to_string(),
                "BaseLib/BaseLib.json".to_string(),
                "BaseLib/assets/config.json".to_string()
            ]
        );
        assert_eq!(merged.mods[0].folder_name.as_deref(), Some("BaseLib"));
        assert_eq!(merged.mods[0].mod_id.as_deref(), Some("BaseLib"));
        assert_eq!(
            merged.mods[0].bundle_members,
            vec!["BaseLib".to_string(), "BaseLib UI".to_string()]
        );
        assert_eq!(
            merged.mods[0].bundle_url.as_deref(),
            Some("https://example.com/BaseLib_v3.1.3.zip")
        );
    }

    /// On-disk members that have no counterpart in the uploaded (filtered)
    /// profile -- e.g. a stored mod excluded from an active-pack upload --
    /// must be preserved untouched by the merge.
    #[test]
    fn merge_preserves_on_disk_members_missing_from_uploaded() {
        let on_disk = make_profile(
            "Pack",
            vec![
                make_mod("Active Mod", "1.0.0"),
                make_mod("Stored Mod", "2.0.0"),
            ],
        );

        // Uploaded copy only has the active mod (stored mod was excluded).
        let mut uploaded_mod = make_mod("Active Mod", "1.0.0");
        uploaded_mod.bundle_url = Some("https://example.com/active.zip".into());
        uploaded_mod.bundle_sha256 = Some("cafef00d".into());
        let uploaded = make_profile("Pack", vec![uploaded_mod]);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);

        assert_eq!(
            merged.mods.len(),
            2,
            "stored mod absent from the upload must still be present after merge"
        );
        let stored = merged.mods.iter().find(|m| m.name == "Stored Mod").unwrap();
        assert!(stored.bundle_url.is_none());
        assert!(stored.bundle_sha256.is_none());

        let active = merged.mods.iter().find(|m| m.name == "Active Mod").unwrap();
        assert_eq!(
            active.bundle_url.as_deref(),
            Some("https://example.com/active.zip")
        );
    }

    /// `source` is fill-only: it's copied from the uploaded profile only
    /// when the on-disk mod doesn't already have one. An existing on-disk
    /// source (e.g. a curator-set value) must never be clobbered.
    #[test]
    fn merge_source_is_fill_only() {
        // Case 1: on-disk has no source -> filled from uploaded.
        let on_disk = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);
        let mut uploaded_mod = make_mod("Mod A", "1.0.0");
        uploaded_mod.source = Some("nexus:123".into());
        let uploaded = make_profile("Pack", vec![uploaded_mod]);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);
        assert_eq!(merged.mods[0].source.as_deref(), Some("nexus:123"));

        // Case 2: on-disk already has a source -> kept, not overwritten.
        let mut existing_mod = make_mod("Mod A", "1.0.0");
        existing_mod.source = Some("curator:override".into());
        let on_disk_with_source = make_profile("Pack", vec![existing_mod]);

        let mut uploaded_mod2 = make_mod("Mod A", "1.0.0");
        uploaded_mod2.source = Some("nexus:123".into());
        let uploaded2 = make_profile("Pack", vec![uploaded_mod2]);

        let merged2 = merge_publish_enrichment(&on_disk_with_source, &uploaded2);
        assert_eq!(
            merged2.mods[0].source.as_deref(),
            Some("curator:override"),
            "existing on-disk source must not be clobbered by the uploaded value"
        );
    }

    /// `created_by` and `public` are publish-time metadata that should be
    /// taken from the uploaded profile (the source of truth for "what was
    /// just published").
    #[test]
    fn merge_updates_created_by_and_public_from_uploaded() {
        let on_disk = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);
        assert_eq!(on_disk.created_by, None);
        assert_eq!(on_disk.public, None);

        let mut uploaded = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);
        uploaded.created_by = Some("octo".into());
        uploaded.public = Some(true);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);
        assert_eq!(merged.created_by.as_deref(), Some("octo"));
        assert_eq!(merged.public, Some(true));
    }

    /// `public = None` on the uploaded profile must not clobber an
    /// existing on-disk `public` value (e.g. when re-sharing without
    /// changing visibility, callers that don't set `public` shouldn't
    /// silently reset it).
    #[test]
    fn merge_keeps_on_disk_public_when_uploaded_public_is_none() {
        let mut on_disk = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);
        on_disk.public = Some(true);

        let uploaded = make_profile("Pack", vec![make_mod("Mod A", "1.0.0")]);
        assert_eq!(uploaded.public, None);

        let merged = merge_publish_enrichment(&on_disk, &uploaded);
        assert_eq!(
            merged.public,
            Some(true),
            "on-disk public flag must survive when uploaded profile doesn't specify one"
        );
    }
}
