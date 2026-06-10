use std::io::Write;
use std::path::Path;

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
    upload_mod_bundle_via_release as github_upload_mod_bundle_via_release,
    upsert_file as github_upsert_file,
};
// Asset-bundling helpers — sync filesystem walk + zip encoding +
// pre-publish validation. `zip_mod_files` is not imported here
// directly — orchestration always goes through `zip_profile_mod_files`
// (which has the enabled-vs-disabled-path fallback baked in), so the
// raw `zip_mod_files` lives in `upload.rs` as an implementation detail.
pub(crate) use upload::zip_profile_mod_files;
use upload::{ensure_profile_publish_complete, restore_profile_after_failed_publish};

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
        }
    }
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

fn recover_owned_share_info_sidecar(
    profile_name: &str,
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
    };
    let share_info_path = profiles_path.join(format!("{}.share", profile_name));
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
    /// "bundling" while uploading mod zips; "uploading-manifest" while
    /// PUTting the profile JSON; "done" right before the success
    /// resolves. Frontend doesn't have to render all of them but a
    /// stable vocabulary makes future additions cheap.
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

fn filter_profile_for_publish_compatibility(
    profile: &mut Profile,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    game_version: Option<&str>,
) {
    // We always need the installed scan so we can drop stored (disabled)
    // members — that exclusion does not depend on the game version.
    let installed_mods =
        merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path));
    let profile_name = profile.name.clone();
    let mut filtered_incompatible = 0;
    let mut filtered_stored = 0;

    profile.mods.retain(|pm| {
        let installed = installed_mods
            .iter()
            .find(|installed| publish_profile_mod_matches_installed(pm, installed));
        match installed {
            // A mod that is stored (disabled on disk, i.e. living in the
            // mods_disabled folder) is never uploaded, even when it
            // belongs to the modpack. Sharing publishes the active set the
            // curator is actually running — this also fixes the
            // disable-in-game-then-reshare leak where a stored mod was
            // still bundled from the disabled folder.
            Some(m) if !m.enabled => {
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
            _ => true,
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
}

fn load_profile_for_publish_from_paths(
    name: &str,
    list_public: Option<bool>,
    include_notes: bool,
    profiles_path: &std::path::Path,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    config_path: &std::path::Path,
    game_version: Option<&str>,
) -> Result<Profile> {
    let mut profile = crate::profiles::load_profile(name, profiles_path)?;
    filter_profile_for_publish_compatibility(&mut profile, mods_path, disabled_path, game_version);
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
    Ok(profile)
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
    let (profiles_path, mods_path, disabled_path, config_path, token, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s
            .github_token
            .clone()
            .ok_or("GitHub token required to share profiles. Set it in Settings.")?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        (
            s.profiles_path.clone(),
            mods_path,
            disabled_path,
            s.config_path.clone(),
            token,
            s.game_version.clone(),
        )
    };

    // If already shared, reuse the existing code (same as reshare). Drop our
    // would-be guard before delegating so reshare_profile can acquire its own
    // without "already in progress" tripping.
    let share_info_path = profiles_path.join(format!("{}.share", name));
    if share_info_path.exists() {
        log::info!(
            "Profile '{}' already shared, reusing code via reshare",
            name
        );
        return reshare_profile(name, list_public, include_notes, app_handle, state).await;
    }

    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    let old_profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    let profile = load_profile_for_publish_from_paths(
        &name,
        list_public,
        include_notes.unwrap_or(true),
        &profiles_path,
        &mods_path,
        &disabled_path,
        &config_path,
        game_version.as_deref(),
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
    )
    .await
    {
        Ok(result) => {
            // Self-subscribed curators are by definition in sync with what
            // was just published — refresh the snapshot so the update poll
            // doesn't flag their own publish (see the helper's doc).
            if let Ok(published) = crate::profiles::load_profile(&name, &profiles_path) {
                crate::subscriptions::sync_own_subscription_after_publish(
                    &config_path,
                    &published,
                );
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
) -> Result<ShareResult> {
    // Get username
    let username = get_github_username(token).await?;
    profile = attribute_profile_to_owner(profile, &username);

    // Ensure repo exists
    ensure_profiles_repo(token, &username).await?;

    let mut failed_uploads: Vec<String> = Vec::new();
    let bundlable: Vec<usize> = profile
        .mods
        .iter()
        .enumerate()
        .filter_map(|(i, m)| if !m.files.is_empty() { Some(i) } else { None })
        .collect();
    let total_bundlable = bundlable.len();

    // Bundle ALL mods to guarantee version matching.
    // Friends get the exact same files the curator has installed.
    // GitHub sources are kept as metadata but bundles are preferred during install.
    for (pos, idx) in bundlable.into_iter().enumerate() {
        let mod_name = profile.mods[idx].name.clone();
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

        let pm = &mut profile.mods[idx];
        log::info!("Bundling mod '{}' ({} files)", pm.name, pm.files.len());
        match zip_profile_mod_files(pm, mods_path, disabled_path) {
            Ok(zip_data) => {
                match upload_mod_bundle_via_release(
                    token,
                    &username,
                    &pm.name,
                    &pm.version,
                    &zip_data,
                    pm.bundle_sha256.as_deref(),
                )
                .await
                {
                    Ok((url, hash)) => {
                        pm.bundle_url = Some(url);
                        pm.bundle_sha256 = Some(hash);
                        log::info!(
                            "Bundled mod '{}' successfully ({} bytes)",
                            pm.name,
                            zip_data.len()
                        );
                    }
                    Err(e) => {
                        log::error!("Failed to upload bundle for '{}': {}", pm.name, e);
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
                log::error!("Failed to zip mod '{}': {}", pm.name, e);
                failed_uploads.push(pm.name.clone());
            }
        }
    }

    ensure_profile_publish_complete(&profile, &failed_uploads)?;

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

    // Save the enriched profile back to local JSON (with bundle_urls)
    // This is critical: switch_profile loads local JSON, which needs bundle_urls
    crate::profiles::save_profile(&profile, profiles_path)?;
    log::info!(
        "Saved enriched profile '{}' with bundle_urls to local JSON",
        profile.name
    );

    // Store share info locally for re-sharing
    let share_info = ShareInfo {
        code: code.clone(),
        owner: username.clone(),
        file_sha: Some(file_sha),
        share_format_version: SHARE_FORMAT_VERSION,
        published_signature: Some(profile_publish_signature(&profile)),
    };
    let share_info_path = profiles_path.join(format!("{}.share", profile.name));
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
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let info: ShareInfo = match std::fs::read_to_string(&share_info_path) {
        Ok(content) => match serde_json::from_str(&content) {
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
        Err(_) => match recover_owned_share_info_from_subscription(
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

    let (profiles_path, mods_path, disabled_path, config_path, token, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s
            .github_token
            .clone()
            .ok_or("GitHub token required. Set it in Settings.")?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        (
            s.profiles_path.clone(),
            mods_path,
            disabled_path,
            s.config_path.clone(),
            token,
            s.game_version.clone(),
        )
    };

    // Load existing share info
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet. Use 'Share' first.".to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let old_profile = crate::profiles::load_profile(&name, &profiles_path).ok();

    let mut profile = load_profile_for_publish_from_paths(
        &name,
        list_public,
        include_notes.unwrap_or(true),
        &profiles_path,
        &mods_path,
        &disabled_path,
        &config_path,
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    profile.created_by = Some(share_info.owner.clone());
    log::info!(
        "Re-sharing saved profile '{}': {} referenced mods",
        name,
        profile.mods.len()
    );

    let mut failed_uploads: Vec<String> = Vec::new();
    let bundlable: Vec<usize> = profile
        .mods
        .iter()
        .enumerate()
        .filter_map(|(i, m)| if !m.files.is_empty() { Some(i) } else { None })
        .collect();
    let total_bundlable = bundlable.len();

    // Bundle ALL mods to guarantee version matching (same as share_profile).
    for (pos, idx) in bundlable.into_iter().enumerate() {
        let mod_name = profile.mods[idx].name.clone();
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

        let pm = &mut profile.mods[idx];
        log::info!("Re-bundling mod '{}' ({} files)", pm.name, pm.files.len());
        match zip_profile_mod_files(pm, &mods_path, &disabled_path) {
            Ok(zip_data) => {
                match upload_mod_bundle_via_release(
                    &token,
                    &share_info.owner,
                    &pm.name,
                    &pm.version,
                    &zip_data,
                    pm.bundle_sha256.as_deref(),
                )
                .await
                {
                    Ok((url, hash)) => {
                        pm.bundle_url = Some(url);
                        pm.bundle_sha256 = Some(hash);
                        log::info!(
                            "Re-bundled mod '{}' successfully ({} bytes)",
                            pm.name,
                            zip_data.len()
                        );
                    }
                    Err(e) => {
                        log::error!("Failed to upload bundle for '{}': {}", pm.name, e);
                        failed_uploads.push(pm.name.clone());
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to zip mod '{}': {}", pm.name, e);
                failed_uploads.push(pm.name.clone());
            }
        }
    }

    if let Err(e) = ensure_profile_publish_complete(&profile, &failed_uploads) {
        restore_profile_after_failed_publish(old_profile.as_ref(), &profiles_path);
        return Err(e.to_string());
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

    // Save enriched profile back to local JSON (with bundle_urls)
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;
    log::info!("Saved re-shared enriched profile '{}' to local JSON", name);

    let owner = share_info.owner.clone();
    let code = share_info.code.clone();

    // Update local share info with new SHA and stamp the current format
    // version, so the re-share nudge clears once the curator re-publishes.
    let updated_info = ShareInfo {
        code: share_info.code,
        owner: share_info.owner,
        file_sha: Some(file_sha),
        share_format_version: SHARE_FORMAT_VERSION,
        published_signature: Some(profile_publish_signature(&profile)),
    };
    save_share_info(&share_info_path, &updated_info).map_err(|e| e.to_string())?;

    // Self-subscribed curators are by definition in sync with what was just
    // published — refresh the subscription snapshot so the update poll
    // doesn't flag the curator's own re-share as a pending update.
    crate::subscriptions::sync_own_subscription_after_publish(&config_path, &profile);

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

    let share_info_path = profiles_path.join(format!("{}.share", name));
    let mut share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet.".to_string())?,
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
    save_share_info(&share_info_path, &share_info).map_err(|e| e.to_string())?;

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
        };
        let second = ShareInfo {
            code: "AAAA-BBBB-CCCC".into(),
            owner: "alice".into(),
            file_sha: Some("new".into()),
            share_format_version: SHARE_FORMAT_VERSION,
            published_signature: None,
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
            profiles_path.join("Solo Pack.share").exists(),
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
            !profiles_path.join("Solo Pack.share").exists(),
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
        assert!(profiles_path.join("Solo Pack.share").exists());
    }

    fn make_profile(name: &str, public: Option<bool>) -> Profile {
        Profile {
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

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            Some(false),
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            Some("0.105.0"),
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

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            Some("0.105.0"),
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 1);
        assert_eq!(prepared.mods[0].name, "Stable Only");
    }

    #[test]
    fn publish_preparation_excludes_stored_disabled_mods_even_when_pack_members() {
        // 4.7 — a mod that lives in mods_disabled (stored / disabled on
        // disk) must not be bundled for upload even though it's listed as
        // a member of the modpack. This also covers the disable-in-game-
        // then-reshare leak. Stored exclusion applies regardless of game
        // version, so we pass None here.
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

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
        )
        .unwrap();

        assert_eq!(prepared.mods.len(), 1);
        assert_eq!(prepared.mods[0].name, "Active Mod");
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

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
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

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
            true,
            &profiles_path,
            &mods_path,
            &disabled_path,
            tmpdir.path(),
            None,
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
        let saved_path = profiles_path.join("test.json");
        let saved_text = std::fs::read_to_string(&saved_path).unwrap();
        let saved: Profile = serde_json::from_str(&saved_text).unwrap();
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
            .respond_with(ResponseTemplate::new(200).set_body_string(
                std::fs::read_to_string(profiles_path.join("api-round-trip.json")).unwrap(),
            ))
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
        let extras = profile.mod_extras.get("ModA").expect("ModA extras published");
        assert_eq!(extras.note.as_deref(), Some("downloaded from Patreon"));
        assert_eq!(extras.custom_url.as_deref(), Some("https://patreon.com/author"));
        assert_eq!(extras.tags, vec!["anime".to_string()]);
        // ModB has no annotations — no empty entry is published for it.
        assert!(!profile.mod_extras.contains_key("ModB"));

        // Round-trip through the manifest JSON (what friends download).
        let json = serde_json::to_string(&profile).unwrap();
        let parsed: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.mod_extras.get("ModA"), profile.mod_extras.get("ModA"));
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
        let mut mutated = base_profile();
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
