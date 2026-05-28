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

use code::{code_to_filename, generate_code, parse_share_code};
// Low-level GitHub plumbing — the release-asset upload retry/recovery
// layer and the orchestration helpers used by share/reshare/install.
pub(crate) use github::build_client;
use github::{
    cleanup_orphan_bundle_assets as github_cleanup_orphan_bundle_assets,
    download_bundle as github_download_bundle,
    ensure_profiles_repo as github_ensure_profiles_repo,
    fetch_shared_profile as github_fetch_shared_profile,
    get_github_username, upload_mod_bundle_via_release as github_upload_mod_bundle_via_release,
    upsert_file as github_upsert_file,
};
// Asset-bundling helpers — sync filesystem walk + zip encoding +
// pre-publish validation. `zip_mod_files` is not imported here
// directly — orchestration always goes through `zip_profile_mod_files`
// (which has the enabled-vs-disabled-path fallback baked in), so the
// raw `zip_mod_files` lives in `upload.rs` as an implementation detail.
use upload::{
    ensure_profile_publish_complete, restore_profile_after_failed_publish, zip_profile_mod_files,
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
    github_upsert_file(token, username, &profiles_repo(), filename, content, existing_sha, message)
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
pub async fn download_bundle(url: &str, mod_name: &str, mods_path: &std::path::Path) -> Result<()> {
    github_download_bundle(url, mod_name, mods_path).await
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
    profiles_path: &std::path::Path,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    _config_path: &std::path::Path,
    game_version: Option<&str>,
) -> Result<Profile> {
    let mut profile = crate::profiles::load_profile(name, profiles_path)?;
    filter_profile_for_publish_compatibility(&mut profile, mods_path, disabled_path, game_version);
    if let Some(public) = list_public {
        profile.public = Some(public);
    }
    Ok(profile)
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
        return reshare_profile(name, list_public, app_handle, state).await;
    }

    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    let old_profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    let profile = load_profile_for_publish_from_paths(
        &name,
        list_public,
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
        Ok(result) => Ok(result),
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
    };
    let share_info_path = profiles_path.join(format!("{}.share", profile.name));
    std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    )?;

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
    })
}

/// Get the share info (code + owner) for a profile, if it has been shared.
#[tauri::command]
pub fn get_share_info(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<ShareResult>, String> {
    let profiles_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.profiles_path.clone()
    };
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let content = match std::fs::read_to_string(&share_info_path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let info: ShareInfo = match serde_json::from_str(&content) {
        Ok(i) => i,
        Err(_) => return Ok(None),
    };
    let filename = code_to_filename(&info.code);
    let url = format!(
        "https://github.com/{}/{}/blob/main/{}",
        info.owner,
        profiles_repo(),
        filename
    );
    let repo_url = build_repo_url(&info.owner);
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
    }))
}

/// Re-share (update) an already-shared profile. Same code, updated content.
/// Re-snapshots the current mods from disk so removed mods are excluded.
/// Preserves original created_at and sets created_by to the GitHub username.
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    list_public: Option<bool>,
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

    // Update local share info with new SHA
    let updated_info = ShareInfo {
        code: share_info.code,
        owner: share_info.owner,
        file_sha: Some(file_sha),
    };
    let _ = std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&updated_info).unwrap(),
    );

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
    let _ = std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    );

    if let Ok(mut s) = state.lock() {
        s.modpack_browser_cache.clear();
    }

    Ok(())
}

#[cfg(test)]
mod listing_tests {
    use super::*;
    use chrono::Utc;

    fn make_profile(name: &str, public: Option<bool>) -> Profile {
        Profile {
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public,
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
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            Some(false),
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
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
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
        };
        crate::profiles::save_profile(&profile, &profiles_path).unwrap();

        let prepared = load_profile_for_publish_from_paths(
            "Stable",
            None,
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
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
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
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(false),
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
        download_bundle(bundle_url, "TestMod", &friend_mods)
            .await
            .expect("release asset bundle should download through the GitHub release URL path");

        assert_eq!(
            std::fs::read(friend_mods.join("TestMod").join("TestMod.dll")).unwrap(),
            b"github-api-uploaded-dll"
        );

        std::env::remove_var("STS2_GITHUB_RELEASES_BASE");
    }
}
