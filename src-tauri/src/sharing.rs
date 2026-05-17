use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Component;
use walkdir::WalkDir;

use crate::error::{AppError, Result};
use crate::profiles::Profile;
use crate::state::AppState;

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

#[derive(Debug, Clone, Serialize)]
struct ModpackSkippedEvent<'a> {
    profile_name: &'a str,
    skipped: &'a [SkippedMod],
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

/// GitHub Contents API response — we only need the SHA for upsert ops.
/// serde drops unknown fields by default, so the rest of the payload
/// (content, html_url, etc.) is ignored without us having to declare them.
#[derive(Debug, Deserialize)]
struct ContentsResponse {
    sha: Option<String>,
}

/// GitHub user response
#[derive(Debug, Deserialize)]
struct UserResponse {
    login: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseResponse {
    id: u64,
    /// Template like `https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}`.
    /// We strip the `{?name,label}` suffix and append `?name=<filename>` ourselves.
    upload_url: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseAsset {
    id: u64,
    name: String,
    browser_download_url: String,
}

const BUNDLES_RELEASE_TAG: &str = "bundles";

/// Per-step status emitted to the frontend while a share / re-share is
/// running. Lets the PublishModal show "Bundling mod 5 of 20…" instead
/// of an opaque "Publishing…" spinner — bundling 20 mods of any real
/// size takes minutes, and the old UI gave the curator no way to tell
/// the app from a hang.
#[derive(Debug, Serialize, Clone)]
struct ShareProgress {
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

/// Per-step status emitted while installing a browsed/shared modpack.
/// The browse UI uses this to show that a large pack is actively fetching,
/// downloading, applying, and subscribing instead of looking stuck on a
/// disabled "Installing..." button.
#[derive(Debug, Serialize, Clone)]
struct ModpackInstallProgress {
    profile_name: String,
    /// "fetching-manifest", "checking", "downloading", "applying",
    /// "subscribing", or "done".
    stage: &'static str,
    /// 1-indexed position within the profile's mod list. 0 when the
    /// current stage is not per-mod.
    current: usize,
    /// Total mods in the profile. 0 when unknown or irrelevant.
    total: usize,
    /// Mod name when stage == "checking" or "downloading".
    mod_name: Option<String>,
}

fn emit_modpack_install_progress(
    app_handle: &tauri::AppHandle,
    profile_name: &str,
    stage: &'static str,
    current: usize,
    total: usize,
    mod_name: Option<&str>,
) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "modpack-install-progress",
        ModpackInstallProgress {
            profile_name: profile_name.to_string(),
            stage,
            current,
            total,
            mod_name: mod_name.map(|s| s.to_string()),
        },
    );
}

fn build_repo_url(owner: &str) -> String {
    format!("https://github.com/{}/{}", owner, profiles_repo())
}

// ── Profile Code Encoding ──────────────────────────────────────────────────

/// Generate a deterministic short code from profile content.
/// Uses SHA-256 hash of the profile name + timestamp to get a unique code.
fn generate_code(profile: &Profile) -> String {
    let mut hasher = Sha256::new();
    hasher.update(profile.name.as_bytes());
    hasher.update(chrono::Utc::now().timestamp().to_le_bytes());
    let hash = hasher.finalize();
    let hex: String = hash
        .iter()
        .take(6)
        .map(|b| format!("{:02X}", b))
        .collect();
    // Format as XXXX-XXXX-XXXX
    let chars: Vec<char> = hex.chars().collect();
    format!(
        "{}-{}-{}",
        chars[0..4].iter().collect::<String>(),
        chars[4..8].iter().collect::<String>(),
        chars[8..12].iter().collect::<String>()
    )
}

/// Code to filename: "AA5A-315D-61AE" -> "aa5a315d61ae.json"
fn code_to_filename(code: &str) -> String {
    format!("{}.json", code.replace('-', "").to_lowercase())
}

/// Normalize user input: accept code, filename, or full URL
fn normalize_code_input(input: &str) -> String {
    let trimmed = input.trim();

    // If it's a GitHub URL, extract the filename
    if trimmed.contains("github.com") || trimmed.contains("raw.githubusercontent.com") {
        if let Some(name) = trimmed.rsplit('/').next() {
            let name = name.trim_end_matches(".json");
            return name.replace('-', "").to_uppercase();
        }
    }

    // Strip dashes and normalize
    trimmed.replace('-', "").to_uppercase()
}

/// Format a raw code string back to XXXX-XXXX-XXXX
fn format_code(raw: &str) -> String {
    let upper: String = raw.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    if upper.len() >= 12 {
        format!("{}-{}-{}", &upper[0..4], &upper[4..8], &upper[8..12])
    } else {
        upper
    }
}

// ── GitHub API Helpers ─────────────────────────────────────────────────────

/// Base URL for GitHub's REST API. Tests override via the
/// `STS2_GITHUB_API_BASE` env var so wiremock can intercept; production
/// always reads the literal default (the env var is only set by tests).
///
/// Pulled out instead of threading a `base_url: &str` parameter through
/// every upload helper because (a) the prod code never varies it and (b)
/// the helpers already form URLs by `format!`, so a single base swap is
/// the minimum surface change for testability.
pub(crate) fn github_api_base() -> String {
    std::env::var("STS2_GITHUB_API_BASE")
        .unwrap_or_else(|_| "https://api.github.com".to_string())
}

pub(crate) fn build_client(token: &str) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    // GitHub keys abuse signals off User-Agent — pinning a literal "0.1"
    // forever means every request from every installed version looks
    // identical, which dilutes the signal both for us and for them.
    // Stamping the actual crate version (set by Cargo at compile time)
    // lets GitHub correlate issues to specific releases and lets us
    // grep server logs by version when something starts misbehaving.
    headers.insert(
        reqwest::header::USER_AGENT,
        concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")).parse().unwrap(),
    );
    if let Ok(val) = format!("Bearer {}", token).parse() {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_default()
}

/// Get the authenticated user's GitHub username.
async fn get_github_username(token: &str) -> Result<String> {
    let client = build_client(token);
    let resp = client.get(&format!("{}/user", github_api_base())).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "GitHub authentication failed ({}). Check your token in Settings. Error: {}",
            status, text
        )));
    }

    let user: UserResponse = resp.json().await?;
    Ok(user.login)
}

/// Ensure the sts2mm-profiles repo exists. Creates it if not.
async fn ensure_profiles_repo(token: &str, username: &str) -> Result<()> {
    let client = build_client(token);
    let repo = profiles_repo();

    // Check if repo exists
    let resp = client
        .get(&format!(
            "{}/repos/{}/{}",
            github_api_base(), username, repo
        ))
        .send()
        .await?;

    if resp.status().is_success() {
        return Ok(());
    }

    // Create the repo
    let body = serde_json::json!({
        "name": repo,
        "description": "Shared mod profiles for STS2 Mod Manager",
        "public": true,
        "auto_init": true  // Creates with a README so we have a branch to push to
    });

    let resp = client
        .post(&format!("{}/user/repos", github_api_base()))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if status.as_u16() == 422 && text.contains("already exists") {
            return Ok(()); // Race condition, it exists
        }

        return Err(AppError::Other(format!(
            "Could not create '{}' repository ({}). You can create it manually on GitHub: go to github.com/new, name it '{}', make it public. Error: {}",
            repo, status, repo, text
        )));
    }

    Ok(())
}

/// Create or update a file in the profiles repo.
async fn upsert_file(
    token: &str,
    username: &str,
    filename: &str,
    content: &str,
    existing_sha: Option<&str>,
    message: &str,
) -> Result<(String, String)> {
    let client = build_client(token);
    let repo = profiles_repo();
    let url = format!(
        "{}/repos/{}/{}/contents/{}",
        github_api_base(), username, repo, filename
    );

    // If we don't have the SHA, try to get it (needed for updates)
    let sha = if let Some(s) = existing_sha {
        Some(s.to_string())
    } else {
        let resp = client.get(&url).send().await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                let info: ContentsResponse = resp.json().await.unwrap_or(ContentsResponse { sha: None });
                info.sha
            } else {
                None
            }
        } else {
            None
        }
    };

    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, content);
    let mut body = serde_json::json!({
        "message": message,
        "content": encoded,
    });

    if let Some(sha) = &sha {
        body["sha"] = serde_json::json!(sha);
    }

    let resp = client.put(&url).json(&body).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to upload profile ({}): {}",
            status, text
        )));
    }

    let data: serde_json::Value = resp.json().await?;
    let file_sha = data["content"]["sha"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let html_url = data["content"]["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok((file_sha, html_url))
}

/// Zip a mod's files into an in-memory buffer.
fn zip_mod_files(mod_name: &str, files: &[String], mods_path: &std::path::Path) -> Result<Vec<u8>> {
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip_writer = zip::ZipWriter::new(buf);
    let mut written_files = 0usize;

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for file_rel in files {
        let normalized = file_rel.replace('\\', "/");
        if std::path::Path::new(&normalized)
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
        {
            return Err(AppError::Other(format!(
                "Mod '{}' has unsafe declared file '{}'",
                mod_name, normalized
            )));
        }
        let file_path = mods_path.join(&normalized);

        if file_path.is_file() {
            zip_writer.start_file(&normalized, options)
                .map_err(|e| AppError::Other(format!("Zip error for '{}': {}", mod_name, e)))?;
            let data = std::fs::read(&file_path)
                .map_err(|e| AppError::Other(format!("Read error for '{}': {}", file_path.display(), e)))?;
            zip_writer.write_all(&data)
                .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
            written_files += 1;
        } else if file_path.is_dir() {
            for entry in WalkDir::new(&file_path).into_iter().flatten() {
                if !entry.file_type().is_file() {
                    continue;
                }
                let rel = entry.path().strip_prefix(mods_path).map_err(|e| {
                    AppError::Other(format!(
                        "Could not make '{}' relative to '{}': {}",
                        entry.path().display(),
                        mods_path.display(),
                        e
                    ))
                })?;
                let entry_rel = rel.to_string_lossy().replace('\\', "/");
                zip_writer
                    .start_file(&entry_rel, options)
                    .map_err(|e| AppError::Other(format!("Zip error: {}", e)))?;
                let data = std::fs::read(entry.path())
                    .map_err(|e| AppError::Other(format!("Read error: {}", e)))?;
                zip_writer
                    .write_all(&data)
                    .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
                written_files += 1;
            }
        } else {
            return Err(AppError::Other(format!(
                "Mod '{}' is missing declared file '{}'",
                mod_name, normalized
            )));
        }
    }

    if written_files == 0 {
        return Err(AppError::Other(format!(
            "Mod '{}' produced an empty bundle; no declared files were readable",
            mod_name
        )));
    }

    let cursor = zip_writer.finish()
        .map_err(|e| AppError::Other(format!("Zip finalize error: {}", e)))?;
    Ok(cursor.into_inner())
}

fn zip_entry_outpath(mods_path: &std::path::Path, entry_name: &str) -> Option<std::path::PathBuf> {
    let normalized = entry_name.replace('\\', "/");
    let rel = std::path::Path::new(&normalized);
    if normalized.trim_matches('/').is_empty()
        || rel.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return None;
    }
    Some(mods_path.join(rel))
}

fn zip_profile_mod_files(
    pm: &crate::profiles::ProfileMod,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
) -> Result<Vec<u8>> {
    let base = if pm.enabled { mods_path } else { disabled_path };
    zip_mod_files(&pm.name, &pm.files, base)
}

fn ensure_profile_publish_complete(profile: &Profile, failed_uploads: &[String]) -> Result<()> {
    let mut missing: Vec<String> = Vec::new();

    for name in failed_uploads {
        if !missing.contains(name) {
            missing.push(name.clone());
        }
    }

    for pm in &profile.mods {
        if pm.bundle_url.is_none() && !missing.contains(&pm.name) {
            missing.push(pm.name.clone());
        }
    }

    if !missing.is_empty() {
        return Err(AppError::Other(format!(
            "Could not publish profile '{}': missing bundles for {} mod(s): {}. Restore or reinstall these mods, then share again so the manifest can repair them later.",
            profile.name,
            missing.len(),
            missing.join(", ")
        )));
    }

    Ok(())
}

fn restore_profile_after_failed_publish(old_profile: Option<&Profile>, profiles_path: &std::path::Path) {
    if let Some(profile) = old_profile {
        if let Err(e) = crate::profiles::save_profile(profile, profiles_path) {
            log::error!(
                "Failed to restore previous local profile '{}' after publish failure: {}",
                profile.name,
                e
            );
        } else {
            log::info!(
                "Restored previous local profile '{}' after publish failure",
                profile.name
            );
        }
    }
}

/// Ensure the rolling `bundles` release exists on the profiles repo,
/// creating it on first share. Returns the release as it exists after
/// this call — assets included so the caller can dedupe without a
/// second round-trip.
///
/// Why a single rolling release instead of one per share: asset names
/// carry the version (`<mod>_v<ver>.zip`), so versioning happens at the
/// asset layer. One release = one stable tag (`bundles`) = one stable
/// URL prefix for every shared bundle.
async fn ensure_bundles_release(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<ReleaseResponse> {
    let base = github_api_base();
    let tag_url = format!("{}/repos/{}/{}/releases/tags/{}", base, owner, repo, BUNDLES_RELEASE_TAG);

    let mut release: ReleaseResponse = {
        let resp = client.get(&tag_url).send().await?;
        if resp.status().is_success() {
            resp.json::<ReleaseResponse>().await?
        } else if resp.status().as_u16() == 404 {
            let create_url = format!("{}/repos/{}/{}/releases", base, owner, repo);
            let body = serde_json::json!({
                "tag_name": BUNDLES_RELEASE_TAG,
                "name": "Mod bundles",
                "body": "Auto-managed by STS2 Mod Manager. Holds binary mod bundles attached to shared profiles.",
                "draft": false,
                "prerelease": false,
            });
            let create_resp = client.post(&create_url).json(&body).send().await?;
            if !create_resp.status().is_success() {
                let status = create_resp.status();
                let text = create_resp.text().await.unwrap_or_default();
                return Err(AppError::Other(format!(
                    "Could not create bundles release on {}/{} ({}): {}",
                    owner, repo, status, text
                )));
            }
            create_resp.json::<ReleaseResponse>().await?
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!(
                "Could not check for bundles release on {}/{} ({}): {}",
                owner, repo, status, text
            )));
        }
    };

    // The inline `assets` field on a release JSON is capped at ~30 entries
    // by GitHub. Curators with >30 bundled mods (or even fewer, after a few
    // reshares that left `.stale` assets behind) would silently miss
    // existing assets and fall through to a POST → 422 already_exists.
    //
    // Paginate /releases/{id}/assets explicitly and replace the inline
    // list before returning. per_page=100 is the GitHub max; we walk
    // pages until a page returns fewer than 100 entries (or zero).
    let assets_url = format!("{}/repos/{}/{}/releases/{}/assets", base, owner, repo, release.id);
    let mut all_assets: Vec<ReleaseAsset> = Vec::new();
    let mut page: u32 = 1;
    loop {
        let page_resp = client
            .get(&assets_url)
            .query(&[("per_page", "100"), ("page", &page.to_string()[..])])
            .send()
            .await?;
        if !page_resp.status().is_success() {
            let status = page_resp.status();
            let text = page_resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!(
                "Could not list assets for release {} on {}/{} ({}): {}",
                release.id, owner, repo, status, text
            )));
        }
        let batch: Vec<ReleaseAsset> = page_resp.json().await?;
        let batch_len = batch.len();
        all_assets.extend(batch);
        if batch_len < 100 {
            break;
        }
        page += 1;
    }
    release.assets = all_assets;
    Ok(release)
}

/// Upload a single binary asset to a release. `upload_url_template` is
/// the `upload_url` field returned by the GitHub release endpoint —
/// a URI Template like `https://uploads.github.com/.../assets{?name,label}`.
/// We strip the `{?name,label}` suffix and append `?name=<filename>`.
///
/// Returns the freshly-created `ReleaseAsset` (caller wants `.browser_download_url`
/// for the manifest, but also `.id` and `.name` for any subsequent
/// rename/replace flow — see `upload_mod_bundle_via_release` below).
///
/// Unlike the Contents API, this endpoint takes raw bytes (no base64).
/// That's what removes the ~50 MiB Contents-API ceiling: the asset
/// endpoint accepts up to 2 GB per file.
async fn upload_release_asset(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    data: &[u8],
) -> Result<ReleaseAsset> {
    let base = upload_url_template
        .split_once('{')
        .map(|(b, _)| b)
        .unwrap_or(upload_url_template);
    let encoded_name = urlencoding::encode(filename);
    let url = format!("{}?name={}", base, encoded_name);

    let resp = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/zip")
        .body(data.to_vec())
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to upload release asset '{}' ({}): {}",
            filename, status, text
        )));
    }
    Ok(resp.json::<ReleaseAsset>().await?)
}

/// Upload helper that recovers from GitHub's `422 already_exists`. The
/// in-memory release listing we built ahead of time can lie — GitHub's
/// per-release `assets` array sometimes round-trips non-ASCII names
/// differently from what our `?name=<encoded>` POST produces, so our
/// lookup may legitimately miss an asset that GitHub then refuses to
/// re-create. When that happens we refetch the live asset listing, find
/// the conflicting asset by canonical-decoded name, DELETE it, and POST
/// once more. One retry only — any further conflict bubbles up.
async fn upload_release_asset_recovering(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    filename: &str,
    data: &[u8],
) -> Result<ReleaseAsset> {
    match upload_release_asset(client, upload_url_template, filename, data).await {
        Ok(asset) => Ok(asset),
        Err(AppError::Other(msg)) if msg.contains("already_exists") => {
            log::warn!(
                "Asset '{}' returned 422 already_exists — refetching release listing and replacing via DELETE-then-POST",
                filename
            );
            let fresh = ensure_bundles_release(client, owner, repo).await?;
            let canonical = decode_asset_name(filename);
            let existing = fresh
                .assets
                .iter()
                .find(|a| decode_asset_name(&a.name) == canonical);
            match existing {
                Some(asset) => {
                    delete_release_asset(client, owner, repo, asset.id).await?;
                    upload_release_asset(client, &fresh.upload_url, filename, data).await
                }
                None => Err(AppError::Other(format!(
                    "Upload of '{}' failed with 422 already_exists but the asset is not visible in the release listing — \
                     retry the share or delete the asset manually from GitHub.",
                    filename
                ))),
            }
        }
        Err(e) => Err(e),
    }
}

/// DELETE a release asset. Used by the replace flow to free the canonical
/// name before re-POSTing fresh bytes under the same name.
async fn delete_release_asset(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    asset_id: u64,
) -> Result<()> {
    let url = format!(
        "{}/repos/{}/{}/releases/assets/{}",
        github_api_base(), owner, repo, asset_id
    );
    let resp = client.delete(&url).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to delete release asset {}: {} {}",
            asset_id, status, text
        )));
    }
    Ok(())
}

/// Replace a release asset by DELETEing the old one and POSTing fresh
/// bytes under the canonical name. Used only when a mod author iterates
/// locally without bumping `version` (the hash differs but the asset
/// name is still occupied).
///
/// Earlier iterations used a POST-then-rename dance to avoid a brief
/// window where the canonical URL 404s on a crashed upload. That left
/// `<canonical>.stale` orphans on the release, which collided on every
/// subsequent replace (PATCH old → `.stale` returned 422 already_exists
/// because the previous replace's `.stale` was still there).
///
/// The atomicity window with DELETE-then-POST is bounded by upload
/// duration and only hit on the rare edit-without-version-bump path,
/// so trade complexity for correctness.
async fn replace_release_asset_via_delete_post(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    canonical_name: &str,
    old_asset_id: u64,
    data: &[u8],
) -> Result<String> {
    delete_release_asset(client, owner, repo, old_asset_id).await?;
    let asset = upload_release_asset(client, upload_url_template, canonical_name, data).await?;
    Ok(asset.browser_download_url)
}

/// Upload a mod's zip bundle as a release asset on the curator's
/// `sts2mm-profiles` repo. Returns (download_url, sha256_hex) so the
/// caller can persist the hash to the profile manifest for next-share
/// content-addressing.
///
/// Skip semantics:
///   - If `prior_sha256` is Some AND matches the freshly-computed local
///     hash AND the canonical asset name is present in the release →
///     skip the upload entirely, return the existing browser_download_url.
///   - If the name collides but the hash differs (or no prior hash to
///     compare to) → replace via DELETE-then-POST.
///   - If the name doesn't exist on the release → POST under canonical name.
pub(crate) async fn upload_mod_bundle_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_data: &[u8],
    prior_sha256: Option<&str>,
) -> Result<(String, String)> {
    use sha2::{Digest, Sha256};

    let client = build_client(token);
    let asset_name = release_asset_name(mod_name, version);

    let mut hasher = Sha256::new();
    hasher.update(zip_data);
    let local_hash = format!("{:x}", hasher.finalize());

    let repo = profiles_repo();
    let release = ensure_bundles_release(&client, username, &repo).await?;

    // Lookup compares percent-decoded names on both sides so the same
    // logical filename matches whether GitHub returns the raw UTF-8 form
    // (`皮皮.zip`) or an already-encoded one (`%E7%9A%AE.zip`). Without
    // this, mods with non-ASCII names round-tripped to a POST → 422
    // already_exists loop, which is what motivated the old ASCII-only
    // sanitiser. We can now keep the Unicode in filenames (issue #44).
    let canonical = decode_asset_name(&asset_name);
    if let Some(existing) = release
        .assets
        .iter()
        .find(|a| decode_asset_name(&a.name) == canonical)
    {
        let hash_matches = prior_sha256.map(|p| p == local_hash.as_str()).unwrap_or(false);
        if hash_matches {
            log::info!(
                "Bundle for '{}' v{} unchanged (sha256 match) — reusing existing release asset",
                mod_name, version
            );
            return Ok((existing.browser_download_url.clone(), local_hash));
        }
        // Name collision but content differs (or we can't prove it doesn't).
        // Replace via DELETE-then-POST. Brief atomicity gap on the canonical
        // URL during upload, but it never strands `.stale` orphans that
        // break subsequent replaces (see replace_release_asset_via_delete_post).
        log::info!(
            "Bundle for '{}' v{} content changed since last share — replacing release asset",
            mod_name, version
        );
        let url = replace_release_asset_via_delete_post(
            &client, username, &repo, &release.upload_url,
            &asset_name, existing.id, zip_data,
        ).await?;
        return Ok((url, local_hash));
    }

    // Net-new upload, with 422 already_exists recovery — see
    // upload_release_asset_recovering for the rationale.
    let asset = upload_release_asset_recovering(
        &client, username, &repo, &release.upload_url, &asset_name, zip_data,
    ).await?;
    Ok((asset.browser_download_url, local_hash))
}

/// Minimal shape of a directory-listing entry returned by
/// `GET /repos/{o}/{r}/contents/` — only the fields we read for the
/// bundle-asset GC sweep. (For files in a directory listing, GitHub
/// populates `download_url` with a `raw.githubusercontent.com` URL.)
#[derive(Debug, Deserialize)]
struct RepoContentEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
    download_url: Option<String>,
}

/// Delete every asset on the curator's `bundles` release that no profile
/// manifest in the same `sts2mm-profiles` repo references. Called after
/// each share/re-share completes, so leftover bundles from prior renames,
/// repaired-with-different-content uploads, or the v1.4.x ASCII-only
/// asset names (`___SpeedX_v0.11.7.zip` before issue #44 was fixed) get
/// reclaimed automatically.
///
/// Best-effort: every step that can fail logs and continues. We never
/// fail the surrounding share over a cleanup error — orphan assets are a
/// disk-space concern, not a correctness one, and the next share will
/// retry the sweep anyway.
pub(crate) async fn cleanup_orphan_bundle_assets(
    token: &str,
    owner: &str,
) -> Result<usize> {
    let client = build_client(token);
    let repo = profiles_repo();
    let base = github_api_base();

    // 1. List `.json` profile manifests at the repo root.
    let listing_url = format!("{}/repos/{}/{}/contents", base, owner, repo);
    let listing_resp = match client.get(&listing_url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("GC: skipping cleanup — could not list contents of {}/{}: {}", owner, repo, e);
            return Ok(0);
        }
    };
    if !listing_resp.status().is_success() {
        log::warn!(
            "GC: skipping cleanup — contents listing for {}/{} returned {}",
            owner, repo, listing_resp.status()
        );
        return Ok(0);
    }
    let entries: Vec<RepoContentEntry> = match listing_resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("GC: skipping cleanup — could not parse contents listing for {}/{}: {}", owner, repo, e);
            return Ok(0);
        }
    };

    // 2. For each `.json` manifest, collect referenced bundle URLs.
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in entries.iter().filter(|e| e.entry_type == "file" && e.name.ends_with(".json")) {
        let download_url = match entry.download_url.as_deref() {
            Some(u) => u,
            None => continue,
        };
        let resp = match client.get(download_url).send().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("GC: could not fetch manifest {}: {}", entry.name, e);
                continue;
            }
        };
        if !resp.status().is_success() {
            log::warn!("GC: manifest {} returned {}", entry.name, resp.status());
            continue;
        }
        let profile: crate::profiles::Profile = match resp.json().await {
            Ok(p) => p,
            Err(e) => {
                log::warn!("GC: could not parse manifest {}: {}", entry.name, e);
                continue;
            }
        };
        for pm in profile.mods {
            if let Some(url) = pm.bundle_url {
                referenced.insert(url);
            }
        }
    }

    // 3. List every asset currently on the `bundles` release.
    let release = match ensure_bundles_release(&client, owner, &repo).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("GC: could not fetch bundles release for {}/{}: {}", owner, repo, e);
            return Ok(0);
        }
    };

    // 4. Delete orphans. If `referenced` is empty AND there are assets, we
    // could be looking at a torn repo state (manifest listing failed mid-
    // sweep) — refuse to delete anything in that case so we don't nuke a
    // healthy release.
    if referenced.is_empty() && !release.assets.is_empty() {
        log::warn!(
            "GC: aborting — referenced URL set is empty but release has {} assets. \
             Refusing to delete anything in case the manifest listing was incomplete.",
            release.assets.len()
        );
        return Ok(0);
    }

    let mut deleted = 0usize;
    for asset in &release.assets {
        if referenced.contains(&asset.browser_download_url) {
            continue;
        }
        match delete_release_asset(&client, owner, &repo, asset.id).await {
            Ok(()) => {
                log::info!("GC: deleted orphan bundle asset '{}'", asset.name);
                deleted += 1;
            }
            Err(e) => {
                log::warn!("GC: failed to delete orphan asset '{}': {}", asset.name, e);
            }
        }
    }
    Ok(deleted)
}

/// Compose the release-asset filename for a mod bundle.
///
/// We keep Unicode (Chinese ideographs, emoji, accented chars) so non-
/// English mod names survive the round-trip to GitHub release assets and
/// back — see issue #44 where the previous ASCII-only sanitiser silently
/// turned every Chinese character into `_`. Only path-/URL-unsafe chars
/// are replaced so the result is still a valid filename on every platform
/// and safe to URL-encode for the upload endpoint.
fn release_asset_name(mod_name: &str, version: &str) -> String {
    let safe_name = sanitize_asset_component(mod_name, false);
    let safe_ver = sanitize_asset_component(version.trim_start_matches('v'), true);
    format!("{}_v{}.zip", safe_name, safe_ver)
}

fn sanitize_asset_component(input: &str, allow_dot: bool) -> String {
    input
        .chars()
        .map(|c| {
            // Replace control chars, whitespace, and characters that are
            // unsafe in filenames or URL paths. Anything else — including
            // Unicode letters and digits — passes through unchanged.
            let unsafe_char = c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '%' | '&' | '+'
                );
            if unsafe_char {
                '_'
            } else if !allow_dot && c == '.' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// Best-effort percent-decode so equality checks survive whatever encoding
/// GitHub chooses to put in the asset-list response. Falls back to the
/// raw input on a decode error rather than panicking.
fn decode_asset_name(name: &str) -> String {
    urlencoding::decode(name)
        .map(|cow| cow.into_owned())
        .unwrap_or_else(|_| name.to_string())
}

/// Download a bundled mod zip from a URL and extract into mods_path.
/// Uses the GitHub API (not raw.githubusercontent.com) to avoid CDN caching issues.
pub async fn download_bundle(url: &str, mod_name: &str, mods_path: &std::path::Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default();

    // QA-cassette interception for release-asset downloads. The cassette
    // layer is GET-only and gated on `cfg!(feature = "qa-cassette")`, so
    // `intercept_get` collapses to a no-op `None` in shipped builds and
    // the compiler drops this entire block. The `github-releases` bucket
    // mirrors github.com's URL path under $STS2_CASSETTE_DIR — see
    // qa_cassette::url_to_path. Handled here ahead of the type-unified
    // `let bytes = ...` block below because the cached value is a
    // `Vec<u8>` and the network branches all return `reqwest::Bytes`;
    // pulling cassette out keeps the type-unification clean and avoids
    // pulling `bytes` in as a direct crate dep.
    if url.starts_with("https://github.com/") && url.contains("/releases/download/") {
        if let Some(cached) = crate::qa_cassette::intercept_get(url) {
            log::info!(
                "[cassette] serving release bundle '{}' from disk ({} bytes)",
                mod_name,
                cached.len()
            );
            let cursor = std::io::Cursor::new(cached);
            let mut archive = zip::ZipArchive::new(cursor).map_err(|e| {
                AppError::Other(format!("Invalid bundle zip for '{}': {}", mod_name, e))
            })?;
            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| AppError::Other(e.to_string()))?;
                let Some(outpath) = zip_entry_outpath(mods_path, file.name()) else {
                    continue;
                };
                if file.name().ends_with('/') {
                    std::fs::create_dir_all(&outpath)?;
                } else {
                    if let Some(parent) = outpath.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    let mut outfile = std::fs::File::create(&outpath)?;
                    std::io::copy(&mut file, &mut outfile)?;
                }
            }
            return Ok(());
        }
    }

    // Parse the raw.githubusercontent.com URL to extract owner/repo/path
    // Format: https://raw.githubusercontent.com/OWNER/REPO/main/PATH
    let bytes = if url.starts_with("https://github.com/") && url.contains("/releases/download/") {
        // Release-asset download. github.com 302-redirects to
        // objects.githubusercontent.com; reqwest follows redirects by
        // default. No API auth needed — release assets in a public repo
        // are public.
        //
        // For test interception we honor STS2_GITHUB_RELEASES_BASE — if set,
        // we replace the `https://github.com` prefix with it so wiremock
        // can answer. Production never sets this var.
        let effective = if let Ok(base) = std::env::var("STS2_GITHUB_RELEASES_BASE") {
            url.replacen("https://github.com", &base, 1)
        } else {
            url.to_string()
        };
        log::info!("Downloading release bundle '{}' from {}", mod_name, effective);
        let resp = client.get(&effective).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Failed to download release bundle for '{}': {}",
                mod_name, resp.status()
            )));
        }
        resp.bytes().await?
    } else if url.contains("raw.githubusercontent.com") {
        // Use GitHub API to avoid CDN caching issues
        let parts: Vec<&str> = url
            .trim_start_matches("https://raw.githubusercontent.com/")
            .splitn(4, '/')
            .collect();
        if parts.len() >= 4 {
            let (owner, repo, _branch, path) = (parts[0], parts[1], parts[2], parts[3]);
            let api_url = format!(
                "{}/repos/{}/{}/contents/{}",
                github_api_base(), owner, repo, path
            );
            log::info!("Downloading bundle '{}' via GitHub API: {}", mod_name, api_url);

            let resp = client
                .get(&api_url)
                .header("Accept", "application/vnd.github.raw+json")
                .send()
                .await?;

            if !resp.status().is_success() {
                // Fallback to direct URL if API fails
                log::warn!("GitHub API download failed for '{}' ({}), falling back to direct URL", mod_name, resp.status());
                let resp2 = client.get(url).send().await?;
                if !resp2.status().is_success() {
                    return Err(AppError::Other(format!(
                        "Failed to download bundle for '{}': {}",
                        mod_name, resp2.status()
                    )));
                }
                resp2.bytes().await?
            } else {
                resp.bytes().await?
            }
        } else {
            // Can't parse URL, use direct download
            let resp = client.get(url).send().await?;
            if !resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Failed to download bundle for '{}': {}",
                    mod_name, resp.status()
                )));
            }
            resp.bytes().await?
        }
    } else {
        // Non-GitHub URL, use direct download
        let resp = client.get(url).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Failed to download bundle for '{}': {}",
                mod_name, resp.status()
            )));
        }
        resp.bytes().await?
    };

    log::info!("Downloaded bundle for '{}': {} bytes", mod_name, bytes.len());
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::Other(format!("Invalid bundle zip for '{}': {}", mod_name, e)))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let Some(outpath) = zip_entry_outpath(mods_path, file.name()) else {
            continue;
        };
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

/// Fetch a profile from any user's profiles repo.
///
/// Uses the GitHub Contents API to avoid CDN caching issues with
/// raw.githubusercontent.com — recently re-shared profiles need to be
/// fetched immediately.
///
/// When `token` is `Some`, the request is authenticated and gets the
/// 5000-req/hour rate limit. When `None`, the request is anonymous and
/// shares the per-IP 60-req/hour pool. The subscription poll passes the
/// user's PAT here so a follower with several subscriptions doesn't keep
/// hitting 429s.
pub async fn fetch_shared_profile(
    owner: &str,
    filename: &str,
    token: Option<&str>,
) -> Result<Profile> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default();

    // Primary: use GitHub Contents API with raw accept header to bypass CDN cache.
    let repo = profiles_repo();
    let api_url = format!(
        "{}/repos/{}/{}/contents/{}",
        github_api_base(), owner, repo, filename
    );
    log::info!(
        "Fetching shared profile via GitHub API ({}): {}",
        if token.is_some() { "authed" } else { "anon" },
        api_url
    );

    let mut req = client
        .get(&api_url)
        .header("Accept", "application/vnd.github.raw+json");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let api_resp = req.send().await;

    let text = match api_resp {
        Ok(resp) if resp.status().is_success() => resp.text().await?,
        Ok(resp) => {
            let status = resp.status();
            log::warn!(
                "GitHub API fetch failed for profile ({}) -- falling back to raw URL",
                status
            );
            // Fallback: raw.githubusercontent.com (may be cached but better than nothing)
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/main/{}",
                owner, repo, filename
            );
            let fallback_resp = client.get(&raw_url).send().await?;
            if !fallback_resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Profile not found ({}). Check the code and try again.",
                    fallback_resp.status()
                )));
            }
            fallback_resp.text().await?
        }
        Err(e) => {
            log::warn!(
                "GitHub API request failed for profile: {} -- falling back to raw URL",
                e
            );
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/main/{}",
                owner, repo, filename
            );
            let fallback_resp = client.get(&raw_url).send().await?;
            if !fallback_resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Profile not found ({}). Check the code and try again.",
                    fallback_resp.status()
                )));
            }
            fallback_resp.text().await?
        }
    };

    let profile: Profile = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("Invalid profile data: {}", e)))?;

    Ok(attribute_profile_to_owner(profile, owner))
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
        let token = s.github_token.clone().ok_or(
            "GitHub token required to share profiles. Set it in Settings."
        )?;
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
        log::info!("Profile '{}' already shared, reusing code via reshare", name);
        return reshare_profile(name, list_public, app_handle, state).await;
    }

    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    // Validate the profile exists, then snapshot the current install as an
    // explicit publish action. This matches Re-share and keeps Share from
    // uploading a stale pre-drift manifest.
    let old_profile = crate::profiles::load_profile(&name, &profiles_path)
        .map_err(|e| e.to_string())?;
    let mut profile = crate::profiles::snapshot_current_with_paths(
        &name,
        &mods_path,
        &disabled_path,
        &profiles_path,
        Some(&config_path),
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    if let Some(p) = list_public {
        profile.public = Some(p);
    }

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
async fn share_profile_impl(
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
                        log::info!("Bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
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
        &format!("Share profile: {} ({} mods)", profile.name, profile.mods.len()),
    )
    .await?;

    // Save the enriched profile back to local JSON (with bundle_urls)
    // This is critical: switch_profile loads local JSON, which needs bundle_urls
    crate::profiles::save_profile(&profile, profiles_path)?;
    log::info!("Saved enriched profile '{}' with bundle_urls to local JSON", profile.name);

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
        Ok(n) => log::info!("GC: removed {} orphan bundle asset(s) from {}/{}", n, username, profiles_repo()),
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
        info.owner, profiles_repo(), filename
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
        let token = s.github_token.clone().ok_or(
            "GitHub token required. Set it in Settings."
        )?;
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

    // Load the existing profile to preserve created_at
    let old_profile = crate::profiles::load_profile(&name, &profiles_path).ok();

    // Re-snapshot current mods from disk so removed mods are excluded
    // and newly added mods are included. Use explicit disabled path from state.
    // Reshare is an explicit publish — apply the bug-#21 filter using
    // the cached game_version so an incompatible install doesn't get
    // pushed out to other users.
    let mut profile = crate::profiles::snapshot_current_with_paths(
        &name,
        &mods_path,
        &disabled_path,
        &profiles_path,
        Some(&config_path),
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    // Preserve original metadata
    if let Some(ref old) = old_profile {
        profile.created_at = old.created_at;
        profile.public = old.public;
    }
    if let Some(p) = list_public {
        profile.public = Some(p);
    }
    profile.created_by = Some(share_info.owner.clone());
    log::info!("Re-snapshot profile '{}': {} mods from disk", name, profile.mods.len());

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
                        log::info!("Re-bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
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
        &format!("Update profile: {} ({} mods)", profile.name, profile.mods.len()),
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
    let (owner, profile_code) = parse_share_code(&code)
        .map_err(|e| e.to_string())?;

    let token = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.github_token.clone()
    };

    let filename = code_to_filename(&profile_code);
    fetch_shared_profile(&owner, &filename, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Install a shared profile from a code AND auto-subscribe for updates.
/// Downloads missing mods FIRST, then applies the profile (enable/disable).
///
/// `app_handle` is taken so we can emit a `modpack-mods-skipped`
/// notification when one or more mods in the pack declare a
/// `min_game_version` higher than the user's STS2 build. Those mods
/// can't be loaded by the game on this branch, so we skip the install
/// (rather than landing a useless artifact) and tell the UI to surface
/// the skip with a clear toast.
#[tauri::command]
pub async fn install_shared_profile(
    code: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    use tauri::Emitter;
    crate::game::ensure_game_not_running()?;
    emit_modpack_install_progress(&app_handle, &code, "fetching-manifest", 0, 0, None);
    let (owner, profile_code) = parse_share_code(&code)
        .map_err(|e| e.to_string())?;

    // Pull paths + token from state first so the GitHub fetch can use the
    // user's PAT for the higher rate limit.
    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token, user_game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        let game_version = s.game_version.clone();
        (mods, disabled, profiles, config, cache, token, game_version)
    };

    let filename = code_to_filename(&profile_code);
    let profile = fetch_shared_profile(&owner, &filename, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let total_mods = profile.mods.len();

    // Mods skipped because they declare a min_game_version higher than the
    // user's STS2. We download + extract them (since we can't read the
    // manifest until the zip is on disk), then immediately delete the
    // files and record the skip. The frontend toasts about these.
    let mut skipped_incompatible: Vec<SkippedMod> = Vec::new();

    // Save the profile locally
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // ── STEP 1: Download missing mods and restore version-mismatched mods ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let all_on_disk: Vec<crate::mods::ModInfo> = local_mods.into_iter()
        .chain(local_disabled.into_iter())
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

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let pinned_set = crate::mod_sources::load_pinned_set(&config_path);
    let mut download_failures: Vec<String> = Vec::new();

    for (idx, pm) in profile.mods.iter().enumerate() {
        let current = idx + 1;
        emit_modpack_install_progress(
            &app_handle,
            &profile.name,
            "checking",
            current,
            total_mods,
            Some(&pm.name),
        );

        // Find matching on-disk mod
        let on_disk_mod = on_disk_by_id.get(&pm.name)
            .or_else(|| pm.folder_name.as_ref().and_then(|f| on_disk_by_id.get(f)))
            .or_else(|| pm.mod_id.as_ref().and_then(|id| on_disk_by_id.get(id)))
            .copied();

        if on_disk_mod.is_none() && crate::profiles::profile_mod_matches_pin(pm, &pinned_set) {
            log::info!(
                "install_shared_profile: pinned mod '{}' is missing on disk; restoring from shared profile",
                pm.name
            );
        }

        // Pinned mods keep their installed version when there is one to preserve.
        if crate::profiles::should_skip_pinned_profile_mod_download(pm, on_disk_mod, &pinned_set) {
            log::info!("install_shared_profile: skipping pinned mod '{}' (preserving installed version)", pm.name);
            continue;
        }

        if let Some(disk_mod) = on_disk_mod {
            let disk_ver = disk_mod.version.trim_start_matches('v');
            let profile_ver = pm.version.trim_start_matches('v');

            let version_ok = disk_ver == profile_ver
                || profile_ver == "unknown" || profile_ver == "0.0.0"
                || disk_ver == "unknown" || disk_ver == "0.0.0";

            if version_ok {
                log::info!("Mod '{}' already on disk at correct version ({})", pm.name, disk_mod.version);
                continue;
            }

            // Version mismatch -- need to replace with the profile's version
            if pm.bundle_url.is_some() {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) -- will reinstall",
                    pm.name, disk_mod.version, pm.version
                );
                // Cache the current version before deleting (so user can switch back)
                crate::mods::cache_mod_version(disk_mod, if disk_mod.enabled { &mods_path } else { &disabled_path }, &cache_path);
                // Delete old version
                let base = if disk_mod.enabled { &mods_path } else { &disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to download the correct version
            } else {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) but no bundle -- keeping disk version",
                    pm.name, disk_mod.version, pm.version
                );
                continue;
            }
        }

        // Prefer bundle_url over GitHub -- the curator bundled it because
        // the GitHub source may be wrong/unreliable (e.g., wrong game's repo)
        if let Some(ref bundle_url) = pm.bundle_url {
            emit_modpack_install_progress(
                &app_handle,
                &profile.name,
                "downloading",
                current,
                total_mods,
                Some(&pm.name),
            );
            log::info!("Downloading bundled mod '{}' from profiles repo", pm.name);
            match download_bundle(bundle_url, &pm.name, &mods_path).await {
                Ok(_) => {
                    // Re-scan to find the just-installed mod's parsed manifest.
                    // We need this to read its min_game_version field —
                    // download_bundle returns () so we don't have a ModInfo
                    // back. The fresh scan picks up the install correctly.
                    let after = crate::mods::scan_mods(&mods_path);
                    if let Some(installed) = after.iter().find(|m| m.name == pm.name || Some(&m.name) == pm.folder_name.as_ref()) {
                        if crate::updater::install_is_incompatible(installed, user_game_version.as_deref()) {
                            log::info!(
                                "Modpack apply: skipping '{}' — needs game v{}, user has v{}",
                                installed.name,
                                installed.min_game_version.as_deref().unwrap_or("?"),
                                user_game_version.as_deref().unwrap_or("?"),
                            );
                            crate::mods::delete_mod_files_by_info(installed, &mods_path);
                            skipped_incompatible.push(SkippedMod {
                                mod_name: installed.name.clone(),
                                min_game_version: installed.min_game_version.clone().unwrap_or_default(),
                                user_game_version: user_game_version.clone().unwrap_or_default(),
                            });
                            continue;
                        }
                    }
                    log::info!("Installed bundled mod '{}'", pm.name);
                    continue;
                }
                Err(e) => {
                    log::warn!("Bundle download failed for '{}': {} -- trying GitHub fallback", pm.name, e);
                }
            }
        }

        // Fallback: try GitHub source
        let github_repo = pm
            .source
            .as_ref()
            .and_then(|s| {
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
            })
            .or_else(|| {
                crate::mod_sources::lookup_entry(
                    &mod_sources_db.mods,
                    pm.folder_name.as_deref(),
                    &pm.name,
                    pm.mod_id.as_deref(),
                )
                .and_then(|e| e.github_repo.clone())
            });

        if let Some(repo) = github_repo {
            let parts: Vec<&str> = repo.splitn(2, '/').collect();
            if parts.len() == 2 {
                emit_modpack_install_progress(
                    &app_handle,
                    &profile.name,
                    "downloading",
                    current,
                    total_mods,
                    Some(&pm.name),
                );
                match crate::download::download_and_install_github_mod(
                    parts[0],
                    parts[1],
                    None,
                    &mods_path,
                    &cache_path,
                    token.as_deref(),
                )
                .await
                {
                    Ok(info) => {
                        if crate::updater::install_is_incompatible(&info, user_game_version.as_deref()) {
                            log::info!(
                                "Modpack apply: skipping GitHub-installed '{}' — needs game v{}, user has v{}",
                                info.name,
                                info.min_game_version.as_deref().unwrap_or("?"),
                                user_game_version.as_deref().unwrap_or("?"),
                            );
                            crate::mods::delete_mod_files_by_info(&info, &mods_path);
                            skipped_incompatible.push(SkippedMod {
                                mod_name: info.name.clone(),
                                min_game_version: info.min_game_version.clone().unwrap_or_default(),
                                user_game_version: user_game_version.clone().unwrap_or_default(),
                            });
                            continue;
                        }
                        log::info!("Downloaded mod '{}' from GitHub", info.name);
                        continue;
                    }
                    Err(e) => {
                        log::error!("GitHub download also failed for '{}': {}", pm.name, e);
                    }
                }
            }
        }

        log::error!("No download source for mod '{}' -- skipping", pm.name);
        download_failures.push(pm.name.clone());
    }

    if !download_failures.is_empty() {
        log::error!(
            "Could not download {} mods: {:?}. These need to be installed manually.",
            download_failures.len(),
            download_failures
        );
    }

    if !skipped_incompatible.is_empty() {
        log::info!(
            "Modpack apply: {} mod(s) skipped due to game-version incompatibility: {:?}",
            skipped_incompatible.len(),
            skipped_incompatible.iter().map(|s| &s.mod_name).collect::<Vec<_>>(),
        );
        let _ = app_handle.emit(
            "modpack-mods-skipped",
            ModpackSkippedEvent {
                profile_name: &profile.name,
                skipped: &skipped_incompatible,
            },
        );
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    // Now all downloadable mods are in mods_path, apply_profile can correctly enable/disable
    emit_modpack_install_progress(&app_handle, &profile.name, "applying", 0, total_mods, None);
    crate::profiles::apply_profile_with_pins(&profile, &mods_path, &disabled_path, &pinned_set)
        .map_err(|e| e.to_string())?;

    // ── STEP 3: Mark imported profile as active ──
    // We just rewrote disk to match this profile. If we leave the
    // previously-active profile in state, its saved manifest is now
    // silently drifted from disk — every action that snapshots from
    // disk (Re-share, "Save changes", Snapshot) will capture the
    // imported loadout into the wrong profile's JSON.
    //
    // Mirrors the same step in `apply_subscription_update` (see
    // subscriptions.rs). Both paths apply a foreign profile's loadout
    // to disk, so both must claim ownership of the active slot.
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.active_profile = Some(profile.name.clone());
        if let Err(e) = std::fs::write(s.config_path.join("active_profile.txt"), &profile.name) {
            log::error!(
                "Failed to persist active_profile.txt after install_shared_profile: {}",
                e
            );
        }
        log::info!("install_shared_profile: active profile set to '{}'", profile.name);
    }

    // ── STEP 4: Auto-subscribe for future updates ──
    // last_synced_profile is the snapshot future diffs are computed
    // against, so it has to match what's actually on disk. Mods we
    // skipped above for game-version incompatibility AREN'T on disk
    // — leaving them in the saved snapshot would mean Repair tries
    // to re-install + re-skip them on every cycle, and a later game-
    // version bump wouldn't surface as "+1 mod available to apply"
    // because the diff would treat them as already-present. Filter
    // them out via the shared snapshot helper.
    emit_modpack_install_progress(&app_handle, &profile.name, "subscribing", 0, total_mods, None);
    let share_key = format!("{}:{}", owner, profile_code);
    let now = chrono::Utc::now();
    let snapshot = crate::subscriptions::build_synced_profile_snapshot(&profile, &skipped_incompatible);
    let sub = crate::subscriptions::Subscription {
        share_id: share_key.clone(),
        share_url: format!("{}/{}", owner, format_code(&profile_code)),
        profile_name: profile.name.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: snapshot,
        last_checked: now,
        last_synced: now,
    };
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    db.subscriptions.insert(share_key, sub);
    let _ = crate::subscriptions::save_subscriptions(&db, &config_path);

    emit_modpack_install_progress(&app_handle, &profile.name, "done", total_mods, total_mods, None);
    Ok(profile)
}

/// True iff `s` matches GitHub's username rules: 1-39 chars, alphanumeric
/// or single hyphens, can't start or end with a hyphen, no consecutive
/// hyphens. We use this as a hard gate before interpolating `owner` into
/// any URL — otherwise a malicious share code containing `..`, `/`, `?`,
/// `#`, `@`, etc. could redirect us to the wrong repo or API endpoint
/// when `format!`-built into a `https://api.github.com/repos/{owner}/...`
/// path. `format!` does NOT URL-encode.
fn is_valid_github_username(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 {
        return false;
    }
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        let is_alnum = b.is_ascii_alphanumeric();
        let is_hyphen = b == b'-';
        if !is_alnum && !is_hyphen {
            return false;
        }
        if is_hyphen && prev_hyphen {
            return false;
        }
        prev_hyphen = is_hyphen;
    }
    true
}

/// Parse a share code like "username/AA5A-315D-61AE" into (owner, code).
///
/// `owner` is validated against GitHub's username rules before return so
/// it's safe to interpolate into API URLs. `code_raw` is normalized to
/// lowercase hex by `normalize_code_input` so it can't carry path-special
/// characters either.
fn parse_share_code(input: &str) -> Result<(String, String)> {
    let trimmed = input.trim();

    // Format: "username/AA5A-315D-61AE"
    if let Some(idx) = trimmed.find('/') {
        let owner = trimmed[..idx].to_string();
        let code_raw = normalize_code_input(&trimmed[idx + 1..]);
        if owner.is_empty() || code_raw.is_empty() {
            return Err(AppError::Other(
                "Invalid share code format. Expected: username/XXXX-XXXX-XXXX".to_string(),
            ));
        }
        if !is_valid_github_username(&owner) {
            return Err(AppError::Other(format!(
                "Invalid GitHub username '{}' in share code. Usernames are 1-39 chars, alphanumeric and single hyphens only.",
                owner
            )));
        }
        return Ok((owner, code_raw));
    }

    Err(AppError::Other(
        "Invalid share code format. Expected: username/XXXX-XXXX-XXXX (the curator shares this code with you)".to_string(),
    ))
}

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
    ).map_err(|e| e.to_string())?;

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
mod parse_share_code_tests {
    use super::is_valid_github_username;

    #[test]
    fn accepts_normal_usernames() {
        assert!(is_valid_github_username("MohamedSerhan"));
        assert!(is_valid_github_username("octocat"));
        assert!(is_valid_github_username("a-b-c"));
        assert!(is_valid_github_username("123"));
    }

    #[test]
    fn rejects_traversal_and_separators() {
        assert!(!is_valid_github_username(".."));
        assert!(!is_valid_github_username("a/b"));
        assert!(!is_valid_github_username("a..b"));
        assert!(!is_valid_github_username("foo?bar"));
        assert!(!is_valid_github_username("foo#bar"));
        assert!(!is_valid_github_username("foo@bar"));
        assert!(!is_valid_github_username(""));
    }

    #[test]
    fn rejects_invalid_hyphens() {
        assert!(!is_valid_github_username("-foo"));
        assert!(!is_valid_github_username("foo-"));
        assert!(!is_valid_github_username("foo--bar"));
    }

    #[test]
    fn rejects_too_long() {
        assert!(!is_valid_github_username(&"a".repeat(40)));
    }
}

#[cfg(test)]
mod release_asset_name_tests {
    use super::{decode_asset_name, release_asset_name, sanitize_asset_component};

    #[test]
    fn preserves_unicode_in_mod_names() {
        // Issue #44: Chinese ideographs used to collapse to `___`.
        assert_eq!(release_asset_name("皮皮统计", "1.0.0"), "皮皮统计_v1.0.0.zip");
    }

    #[test]
    fn replaces_only_path_unsafe_chars() {
        assert_eq!(
            sanitize_asset_component("Skada/Recount: helper*", false),
            "Skada_Recount__helper_",
        );
    }

    #[test]
    fn keeps_ascii_alphanumerics_and_separators() {
        assert_eq!(release_asset_name("My-Mod_42", "v2.3.4"), "My-Mod_42_v2.3.4.zip");
    }

    #[test]
    fn decode_asset_name_handles_raw_and_encoded() {
        assert_eq!(decode_asset_name("皮皮.zip"), "皮皮.zip");
        assert_eq!(decode_asset_name("%E7%9A%AE%E7%9A%AE.zip"), "皮皮.zip");
    }

    #[test]
    fn decode_asset_name_falls_back_on_bad_encoding() {
        // Lone % is not valid percent-encoding; should not panic.
        assert_eq!(decode_asset_name("abc%zz.zip"), "abc%zz.zip");
    }
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
mod publish_bundle_contract_tests {
    use super::*;

    fn profile_with_mod(pm: crate::profiles::ProfileMod) -> Profile {
        Profile {
            name: "contract".into(),
            game_version: None,
            created_by: None,
            mods: vec![pm],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
        }
    }

    fn profile_mod(enabled: bool) -> crate::profiles::ProfileMod {
        crate::profiles::ProfileMod {
            name: "ContractMod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["ContractMod/ContractMod.json".into()],
            folder_name: Some("ContractMod".into()),
            mod_id: Some("ContractMod".into()),
            enabled,
            bundle_url: None,
            bundle_sha256: None,
        }
    }

    #[test]
    fn zip_mod_files_errors_when_declared_file_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = zip_mod_files(
            "ContractMod",
            &["ContractMod/ContractMod.json".into()],
            tmp.path(),
        )
        .expect_err("missing profile files must fail publish instead of creating an empty bundle");

        assert!(
            err.to_string().contains("missing declared file"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn zip_mod_files_rejects_declared_paths_outside_mods_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let err = zip_mod_files("ContractMod", &["../secrets.txt".into()], tmp.path())
            .expect_err("publish must not read files outside the mods folder");

        assert!(
            err.to_string().contains("unsafe declared file"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn zip_profile_mod_files_reads_disabled_mods_from_disabled_base() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let disabled_mod = disabled_path.join("ContractMod");
        std::fs::create_dir_all(&disabled_mod).unwrap();
        std::fs::write(disabled_mod.join("ContractMod.json"), b"{}").unwrap();

        let zip_data =
            zip_profile_mod_files(&profile_mod(false), &mods_path, &disabled_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_data)).unwrap();
        assert!(
            archive.by_name("ContractMod/ContractMod.json").is_ok(),
            "disabled profile mods must be bundled from mods_disabled"
        );
    }

    #[test]
    fn publish_completion_rejects_any_mod_without_bundle_url() {
        let profile = profile_with_mod(profile_mod(true));
        let err = ensure_profile_publish_complete(&profile, &[])
            .expect_err("publishing a partially restorable manifest must be blocked");

        assert!(
            err.to_string().contains("missing bundles"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn share_owner_replaces_app_default_attribution() {
        let mut profile = profile_with_mod(profile_mod(true));
        profile.created_by = Some("sts2-mod-manager".into());

        let attributed = attribute_profile_to_owner(profile, "alice");

        assert_eq!(attributed.created_by.as_deref(), Some("alice"));
    }
}

#[cfg(test)]
mod release_upload_tests {
    use super::*;
    use tokio::sync::{Mutex, MutexGuard};
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// `STS2_GITHUB_API_BASE` is process-global. `cargo test` runs `#[tokio::test]`
    /// tests in parallel by default, so without serialization two tests can race
    /// and send requests to each other's mock server. Each test takes this lock
    /// at the top of its body and holds it for the test's lifetime — cheap, and
    /// avoids forcing callers to pass `--test-threads=1`. We use `tokio::sync::Mutex`
    /// rather than `std::sync::Mutex` so the guard is `Send` and can live across
    /// `.await` points on the multi-thread runtime that `#[tokio::test]` uses.
    pub(super) static ENV_LOCK: Mutex<()> = Mutex::const_new(());

    /// Helper: spin up a mock GitHub API and point sharing.rs at it via env.
    /// Caller must hold `ENV_LOCK` for the duration of the test (the env var
    /// is process-global). Each test still gets its own MockServer on a
    /// random port, so they're isolated once the lock orders them.
    async fn mock_github() -> (MockServer, MutexGuard<'static, ()>) {
        let guard = ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());
        (server, guard)
    }

    /// Compute the SHA256 hex digest the same way the uploader does.
    /// Test helper so each test can assert on the returned hash.
    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    #[tokio::test]
    async fn ensure_bundles_release_creates_release_when_404() {
        let (server, _env_guard) = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server)
            .await;

        // Newly-created release has no assets — pagination loop returns an
        // empty page on the first try and stops (len < 100).
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("should create release");
        assert_eq!(release.id, 42);
        assert!(release.assets.is_empty());
    }

    #[tokio::test]
    async fn ensure_bundles_release_reuses_when_200() {
        let (server, _env_guard) = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/7/assets{{?name,label}}", server.uri()),
                "assets": [{
                    "id": 100,
                    "name": "OldMod_v0.1.zip",
                    "browser_download_url": "https://example/old"
                }]
            })))
            .mount(&server)
            .await;

        // Pagination replaces the inline `assets` field with the result of
        // GET /releases/{id}/assets. The inline value is ignored — what
        // the test asserts on is the paginated list.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/7/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 100,
                "name": "OldMod_v0.1.zip",
                "browser_download_url": "https://example/old"
            }])))
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("should reuse release");
        assert_eq!(release.id, 7);
        assert_eq!(release.assets.len(), 1);
    }

    #[tokio::test]
    async fn ensure_bundles_release_paginates_assets_across_pages() {
        // Regression for Bug A: curators with >30 bundles miss existing
        // assets because the inline `assets` field is capped at ~30.
        // We must paginate /releases/{id}/assets explicitly.
        let (server, _env_guard) = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        let page1: Vec<serde_json::Value> = (0..100).map(|i| serde_json::json!({
            "id": 1000 + i,
            "name": format!("Page1Mod{:03}_v1.0.0.zip", i),
            "browser_download_url": format!("https://example/p1-{}", i)
        })).collect();
        let page2: Vec<serde_json::Value> = (0..5).map(|i| serde_json::json!({
            "id": 2000 + i,
            "name": format!("Page2Mod{:03}_v1.0.0.zip", i),
            "browser_download_url": format!("https://example/p2-{}", i)
        })).collect();

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .and(query_param("per_page", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .and(query_param("per_page", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page2))
            .expect(1)
            .mount(&server).await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("paginated list should succeed");
        assert_eq!(release.assets.len(), 105, "expected 100+5 assets across pages");
        assert!(release.assets.iter().any(|a| a.name == "Page1Mod000_v1.0.0.zip"),
            "first page name must be present");
        assert!(release.assets.iter().any(|a| a.name == "Page2Mod004_v1.0.0.zip"),
            "second page name must be present");
    }

    #[tokio::test]
    async fn ensure_bundles_release_stops_when_page_is_empty() {
        // Edge case: page 1 returns exactly 100 (the page-size threshold for
        // "maybe more"), page 2 returns 0. We must NOT fetch page 3.
        let (server, _env_guard) = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        let page1: Vec<serde_json::Value> = (0..100).map(|i| serde_json::json!({
            "id": 1000 + i,
            "name": format!("Mod{:03}_v1.0.0.zip", i),
            "browser_download_url": format!("https://example/{}", i)
        })).collect();

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(1)
            .mount(&server).await;

        // If the loop runs away to page 3, wiremock will count this expect(0)
        // mock as having received a request and fail the test on drop.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "3"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(0)
            .mount(&server).await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("paginated list should stop on empty page");
        assert_eq!(release.assets.len(), 100);
    }

    #[tokio::test]
    async fn upload_release_asset_posts_raw_bytes_with_filename_query() {
        let (server, _env_guard) = mock_github().await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .and(header("content-type", "application/zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );
        let client = build_client("test-token");
        let asset = upload_release_asset(
            &client,
            &upload_url_template,
            "TheCursedMod_v0.2.7.zip",
            b"PK\x03\x04...fake-zip-bytes",
        ).await.expect("upload should succeed");
        assert_eq!(
            asset.browser_download_url,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
        );
    }

    #[tokio::test]
    async fn delete_release_asset_calls_correct_endpoint() {
        let (server, _env_guard) = mock_github().await;
        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        delete_release_asset(&client, "octo", "sts2mm-profiles", 555)
            .await
            .expect("delete should succeed");
    }

    #[tokio::test]
    async fn replace_release_asset_via_delete_post_swaps() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursed_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursed_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let url = replace_release_asset_via_delete_post(
            &client, "octo", "sts2mm-profiles", &upload_url_template,
            "TheCursed_v0.2.7.zip", 555, b"new-bytes"
        ).await.expect("delete-then-post should succeed");
        assert!(url.contains("releases/download/bundles/TheCursed_v0.2.7.zip"));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_first_upload_records_hash() {
        let (server, _env_guard) = mock_github().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server).await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let bytes = b"fake-zip-bytes";
        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, None
        ).await.expect("first upload should succeed");
        assert!(url.contains("releases/download/bundles/TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_skips_when_hash_matches() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"fake-zip-bytes";
        let prior_hash = sha256_hex(bytes);

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 555,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            }])))
            .mount(&server).await;

        // CRITICAL: any POST/DELETE means we regressed. wiremock fails on
        // unstubbed requests, so if the orchestrator tries to upload we'll
        // see it fail.

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, Some(&prior_hash)
        ).await.expect("skip should succeed");
        assert_eq!(url, "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip");
        assert_eq!(hash, prior_hash, "hash returned to caller must match what was on disk");
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_replaces_when_hash_differs_but_name_matches() {
        // The mod-author case: edited locally without bumping version.
        // Asset already on the release with a different hash → orchestrator
        // takes the DELETE-then-POST replace path.
        let (server, _env_guard) = mock_github().await;
        let bytes = b"fresh-bytes-after-edit";
        let stale_prior_hash = sha256_hex(b"original-bytes");

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        // Paginated assets list: page 1 has the existing asset, page 2 empty.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 555,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://example/old"
            }])))
            .mount(&server).await;

        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, Some(&stale_prior_hash)
        ).await.expect("replace path should succeed");
        assert!(url.contains("releases/download/bundles/TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_re_uploads_when_no_prior_hash_but_name_collision() {
        // Edge case: fresh install (no prior hash in profile JSON) but
        // canonical name already exists on the release (curator re-installed
        // app and lost local manifest). Must take the DELETE+POST replace
        // path — we can't trust an asset's hash without checking it.
        let (server, _env_guard) = mock_github().await;
        let bytes = b"data";

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 555,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://example/whatever"
            }])))
            .mount(&server).await;

        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001, "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (_, _) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, None
        ).await.expect("no-prior-hash + name-collision must replace");
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_sanitizes_filename() {
        let (server, _env_guard) = mock_github().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "My_Cool_Mod_v1.2.3.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999, "name": "My_Cool_Mod_v1.2.3.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/My_Cool_Mod_v1.2.3.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let _ = upload_mod_bundle_via_release(
            "test-token", "octo", "My Cool/Mod", "v1.2.3", b"data", None
        ).await.expect("ok");
    }

    /// Regression for issue #44: mod names with non-ASCII characters
    /// (Chinese ideographs, emoji, accented chars) must PRESERVE those
    /// characters in the uploaded asset filename — pre-fix the asset
    /// name collapsed to `___SpeedX_v0.11.7.zip` because the sanitiser
    /// stripped everything outside the ASCII alphanumeric set.
    ///
    /// The orchestrator's old "ASCII-only for round-trip stability"
    /// concern is now handled by `decode_asset_name` on both sides of
    /// the lookup comparison instead of by mangling the filename.
    #[tokio::test]
    async fn upload_mod_bundle_via_release_preserves_unicode_in_asset_name() {
        let (server, _env_guard) = mock_github().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server).await;

        // "皮皮极速: SpeedX" — colon and space become `_`, but the four
        // ideographs are kept verbatim. Final: `皮皮极速__SpeedX_v0.11.7.zip`.
        let expected_name = "皮皮极速__SpeedX_v0.11.7.zip";
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", expected_name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100,
                "name": expected_name,
                "browser_download_url": format!(
                    "https://github.com/octo/sts2mm-profiles/releases/download/bundles/{}",
                    expected_name
                )
            })))
            .expect(1)
            .mount(&server).await;

        let _ = upload_mod_bundle_via_release(
            "test-token", "octo", "皮皮极速: SpeedX", "0.11.7", b"data", None
        ).await.expect("non-ascii mod names must round-trip into the asset filename");
    }

    /// Regression for Bug A through the orchestrator: an asset on page 2
    /// of the paginated list must still be discovered. Pre-fix, the
    /// orchestrator only saw the inline `assets` (capped at ~30) and
    /// missed anything past page 1, falling through to POST → 422.
    #[tokio::test]
    async fn upload_mod_bundle_via_release_finds_asset_on_second_page() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"unchanged-bytes";
        let prior_hash = sha256_hex(bytes);

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        // Page 1: 100 unrelated assets — the canonical name we care about
        // is NOT on this page, simulating the real bug.
        let page1: Vec<serde_json::Value> = (0..100).map(|i| serde_json::json!({
            "id": 1000 + i,
            "name": format!("OtherMod{:03}_v1.0.0.zip", i),
            "browser_download_url": format!("https://example/other-{}", i)
        })).collect();
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .mount(&server).await;

        // Page 2: the canonical asset.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 9999,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            }])))
            .mount(&server).await;

        // Hash matches → must SKIP. Any DELETE or POST means the
        // orchestrator failed to find the asset and went to upload-new,
        // which is the bug we're guarding against.
        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, Some(&prior_hash)
        ).await.expect("skip via page-2 lookup must succeed");
        assert_eq!(url, "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip");
        assert_eq!(hash, prior_hash);
    }

    /// Regression for Bug B: two consecutive replaces against the same
    /// release. Pre-fix, the second replace failed because the rename
    /// flow left a `<canonical>.stale` from the first replace, and the
    /// second PATCH old → `.stale` got 422 already_exists.
    ///
    /// With DELETE-then-POST there's no `.stale` state to accumulate, so
    /// the second replace should succeed exactly like the first.
    #[tokio::test]
    async fn upload_mod_bundle_via_release_two_consecutive_replaces_both_succeed() {
        let (server, _env_guard) = mock_github().await;
        let first_bytes = b"v1-bytes";
        let second_bytes = b"v2-bytes";
        let hash_before_first = sha256_hex(b"original-bytes");
        let hash_after_first = sha256_hex(first_bytes);

        // ── First replace cycle ────────────────────────────────────────
        // Asset id 555 exists; orchestrator must DELETE 555 then POST canonical.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 555,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://example/v0"
            }])))
            .mount(&server).await;
        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (url1, hash1) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7",
            first_bytes, Some(&hash_before_first),
        ).await.expect("first replace must succeed");
        assert!(url1.contains("TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash1, sha256_hex(first_bytes));

        // Reset the server's mocks before the second cycle so the cycle-1
        // listing (which returned asset 555) doesn't shadow cycle 2's
        // listing (which must return asset 1001). Wiremock's mount-order
        // matching makes overlapping mocks hard to reason about; reset is
        // cleanest.
        server.reset().await;

        // ── Second replace cycle ───────────────────────────────────────
        // Now the asset id is 1001 (from the first cycle's POST). New
        // content hashes differently, so orchestrator must DELETE 1001
        // then POST canonical again. Pre-fix, this would 422 on the rename
        // because `.stale` from cycle 1 was still present.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": 1001,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://example/v1"
            }])))
            .mount(&server).await;
        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/1001"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 2002,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (url2, hash2) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7",
            second_bytes, Some(&hash_after_first),
        ).await.expect("second replace must succeed — Bug B regression guard");
        assert!(url2.contains("TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash2, sha256_hex(second_bytes));
    }
}

#[cfg(test)]
mod share_via_releases_e2e_tests {
    use super::*;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Verifies: user lookup -> repo exists -> bundle uploaded via releases
    /// (not Contents API) -> manifest written via Contents API with both
    /// `bundle_url` and `bundle_sha256` set on the persisted profile.
    #[tokio::test]
    async fn share_profile_routes_bundles_through_releases_and_persists_hash() {
        // Reuse the env-var lock from `release_upload_tests` — STS2_GITHUB_API_BASE
        // is process-global, so we serialize against the other wiremock tests.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"name": "sts2mm-profiles"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server).await;

        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "TestMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
            })))
            .expect(1)   // exactly one bundle upload — pins the route
            .mount(&server).await;

        Mock::given(method("GET")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server).await;
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
        assert!(result.failed_uploads.is_empty(), "expected no failures, got {:?}", result.failed_uploads);

        // Verify the persisted profile got both bundle_url and bundle_sha256.
        let saved_path = profiles_path.join("test.json");
        let saved_text = std::fs::read_to_string(&saved_path).unwrap();
        let saved: Profile = serde_json::from_str(&saved_text).unwrap();
        assert_eq!(saved.created_by.as_deref(), Some("octo"));
        let m = &saved.mods[0];
        assert!(m.bundle_url.as_deref().map(|u| u.contains("releases/download/bundles/TestMod_v1.0.0.zip")).unwrap_or(false),
            "expected release URL, got {:?}", m.bundle_url);
        assert!(m.bundle_sha256.is_some(), "expected hash to be persisted");
    }

    #[tokio::test]
    async fn share_fetch_and_download_round_trips_through_github_api() {
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"name": "sts2mm-profiles"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server).await;

        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "TestMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("GET")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .up_to_n_times(1)
            .mount(&server).await;

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
        ).unwrap();
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

        Mock::given(method("GET")).and(path(format!("/repos/octo/sts2mm-profiles/contents/{}", result.file_path)))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                std::fs::read_to_string(profiles_path.join("api-round-trip.json")).unwrap()
            ))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(uploaded_bundle))
            .expect(1)
            .mount(&server).await;

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

#[cfg(test)]
mod github_api_stress_tests {
    use super::*;
    use crate::profiles::ProfileMod;
    use std::io::Write;

    const STRESS_SIZE_PLAN_MIB: [u64; 40] = [
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        2, 2, 2, 2, 2,
        4, 4, 4, 4, 4,
        8, 8, 8, 8,
        16, 16, 16,
        32, 32, 48, 64, 80, 96, 128, 160, 192, 224, 256, 288, 300,
    ];

    #[test]
    fn github_stress_size_plan_has_40_mods_and_reaches_300_mib() {
        assert_eq!(STRESS_SIZE_PLAN_MIB.len(), 40);
        assert_eq!(STRESS_SIZE_PLAN_MIB.iter().max().copied(), Some(300));
        assert!(STRESS_SIZE_PLAN_MIB.windows(2).all(|w| w[0] <= w[1]));
    }

    #[tokio::test]
    #[ignore = "live GitHub API stress test; run npm run qa:github-stress"]
    async fn github_api_stress_40_mods_various_sizes() {
        if std::env::var("STS2_GITHUB_STRESS").ok().as_deref() != Some("1") {
            eprintln!("Skipping: set STS2_GITHUB_STRESS=1 or run npm run qa:github-stress");
            return;
        }

        let token = match std::env::var("STS2_GITHUB_TOKEN").or_else(|_| std::env::var("GITHUB_TOKEN")) {
            Ok(token) if !token.trim().is_empty() => token,
            _ => {
                eprintln!("Skipping: set STS2_GITHUB_TOKEN or GITHUB_TOKEN");
                return;
            }
        };

        let repo = std::env::var("STS2_GITHUB_STRESS_REPO")
            .unwrap_or_else(|_| "sts2mm-profiles-test".to_string());
        let _repo_guard = EnvVarGuard::set("STS2_PROFILES_REPO", &repo);
        let _api_guard = EnvVarGuard::unset("STS2_GITHUB_API_BASE");

        let client = build_client(&token);
        let username = get_github_username(&token)
            .await
            .expect("GitHub token must authenticate");
        ensure_profiles_repo(&token, &username)
            .await
            .expect("stress repo must exist or be creatable");

        let run_id = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
        let asset_prefix = format!("Stress{}_", run_id);
        let profile_name = format!("GitHub API Stress {}", run_id);
        let work = tempfile::tempdir().expect("create stress tempdir");
        let mods_path = work.path().join("mods");
        let disabled_path = work.path().join("mods_disabled");
        let profiles_path = work.path().join("profiles");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = build_stress_profile(&profile_name, &asset_prefix, &mods_path)
            .expect("build stress fixture profile");
        let expected_mods = profile.mods.clone();
        let expected_asset_names: Vec<String> = expected_mods
            .iter()
            .map(|m| release_asset_name(&m.name, &m.version))
            .collect();

        let result = run_stress_share_and_verify(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            &token,
            &username,
            &repo,
            &client,
            &expected_asset_names,
        )
        .await;

        let cleanup = cleanup_stress_artifacts(&client, &username, &repo, &asset_prefix, None).await;
        if let Err(e) = cleanup {
            eprintln!("Stress cleanup warning: {}", e);
        }

        result.expect("GitHub API stress test must upload, fetch, download, and verify all bundles");
    }

    async fn run_stress_share_and_verify(
        profile: Profile,
        mods_path: &std::path::Path,
        disabled_path: &std::path::Path,
        profiles_path: &std::path::Path,
        token: &str,
        username: &str,
        repo: &str,
        client: &reqwest::Client,
        expected_asset_names: &[String],
    ) -> Result<()> {
        let result = share_profile_impl(
            profile,
            mods_path,
            disabled_path,
            profiles_path,
            token,
            None,
        )
        .await?;

        let verify_result: Result<()> = async {
            let fetched = fetch_shared_profile(username, &result.file_path, Some(token)).await?;
            if fetched.mods.len() != STRESS_SIZE_PLAN_MIB.len() {
                return Err(AppError::Other(format!(
                    "Fetched profile had {} mods, expected {}",
                    fetched.mods.len(),
                    STRESS_SIZE_PLAN_MIB.len()
                )));
            }

            let release = ensure_bundles_release(client, username, repo).await?;
            for (pm, expected_asset_name) in fetched.mods.iter().zip(expected_asset_names.iter()) {
                let Some(expected_hash) = pm.bundle_sha256.as_deref() else {
                    return Err(AppError::Other(format!("{} missing bundle_sha256", pm.name)));
                };
                let asset = release
                    .assets
                    .iter()
                    .find(|asset| asset.name == *expected_asset_name)
                    .ok_or_else(|| AppError::Other(format!("Missing release asset {}", expected_asset_name)))?;
                let bytes = download_release_asset_via_api(client, username, repo, asset.id).await?;
                let actual_hash = sha256_hex(&bytes);
                if actual_hash != expected_hash {
                    return Err(AppError::Other(format!(
                        "Hash mismatch for {}: downloaded {}, manifest {}",
                        pm.name, actual_hash, expected_hash
                    )));
                }
            }

            Ok(())
        }
        .await;

        if let Err(e) = delete_contents_file_if_exists(client, username, repo, &result.file_path).await {
            eprintln!("Stress manifest cleanup warning: {}", e);
        }

        verify_result
    }

    fn build_stress_profile(
        profile_name: &str,
        asset_prefix: &str,
        mods_path: &std::path::Path,
    ) -> std::io::Result<Profile> {
        let now = chrono::Utc::now();
        let mut mods = Vec::with_capacity(STRESS_SIZE_PLAN_MIB.len());
        for (idx, size_mib) in STRESS_SIZE_PLAN_MIB.iter().enumerate() {
            let folder = format!("{}Mod{:02}", asset_prefix, idx + 1);
            let version = format!("1.0.{}", idx + 1);
            let dir = mods_path.join(&folder);
            std::fs::create_dir_all(&dir)?;
            let manifest_name = format!("{}.json", folder);
            let dll_name = format!("{}.dll", folder);
            std::fs::write(
                dir.join(&manifest_name),
                format!(
                    r#"{{"id":"{folder}","name":"{folder}","version":"{version}","author":"stress"}}"#
                ),
            )?;
            write_pseudorandom_file(
                &dir.join(&dll_name),
                size_mib * 1024 * 1024,
                0x5354_5332 ^ idx as u64,
            )?;
            mods.push(ProfileMod {
                name: folder.clone(),
                version,
                source: None,
                hash: None,
                files: vec![format!("{}/{}", folder, manifest_name), format!("{}/{}", folder, dll_name)],
                folder_name: Some(folder.clone()),
                mod_id: Some(folder),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
            });
        }

        Ok(Profile {
            name: profile_name.to_string(),
            game_version: Some("0.105.0".to_string()),
            created_by: Some("stress".to_string()),
            mods,
            created_at: now,
            updated_at: now,
            public: Some(false),
        })
    }

    fn write_pseudorandom_file(path: &std::path::Path, bytes: u64, seed: u64) -> std::io::Result<()> {
        let mut file = std::fs::File::create(path)?;
        let mut remaining = bytes;
        let mut state = seed.max(1);
        let mut buf = vec![0u8; 1024 * 1024];
        while remaining > 0 {
            let n = remaining.min(buf.len() as u64) as usize;
            fill_pseudorandom(&mut buf[..n], &mut state);
            file.write_all(&buf[..n])?;
            remaining -= n as u64;
        }
        Ok(())
    }

    fn fill_pseudorandom(buf: &mut [u8], state: &mut u64) {
        for byte in buf {
            let mut x = *state;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *state = x;
            *byte = (x & 0xff) as u8;
        }
    }

    async fn download_release_asset_via_api(
        client: &reqwest::Client,
        owner: &str,
        repo: &str,
        asset_id: u64,
    ) -> Result<Vec<u8>> {
        let url = format!(
            "{}/repos/{}/{}/releases/assets/{}",
            github_api_base(), owner, repo, asset_id
        );
        let resp = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/octet-stream")
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!(
                "Failed to download release asset {} ({}): {}",
                asset_id, status, text
            )));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    async fn cleanup_stress_artifacts(
        client: &reqwest::Client,
        owner: &str,
        repo: &str,
        asset_prefix: &str,
        manifest_filename: Option<&str>,
    ) -> Result<()> {
        if let Ok(release) = ensure_bundles_release(client, owner, repo).await {
            for asset in release.assets.iter().filter(|asset| asset.name.starts_with(asset_prefix)) {
                delete_release_asset(client, owner, repo, asset.id).await?;
            }
        }
        if let Some(filename) = manifest_filename {
            delete_contents_file_if_exists(client, owner, repo, filename).await?;
        }
        Ok(())
    }

    async fn delete_contents_file_if_exists(
        client: &reqwest::Client,
        owner: &str,
        repo: &str,
        filename: &str,
    ) -> Result<()> {
        let url = format!(
            "{}/repos/{}/{}/contents/{}",
            github_api_base(), owner, repo, filename
        );
        let resp = client.get(&url).send().await?;
        if resp.status().as_u16() == 404 {
            return Ok(());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!(
                "Failed to fetch manifest for cleanup {} ({}): {}",
                filename, status, text
            )));
        }
        let value: serde_json::Value = resp.json().await?;
        let sha = value
            .get("sha")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other(format!("Cleanup response for {} had no sha", filename)))?;
        let body = serde_json::json!({
            "message": format!("Delete stress manifest {}", filename),
            "sha": sha,
        });
        let resp = client.delete(&url).json(&body).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!(
                "Failed to delete stress manifest {} ({}): {}",
                filename, status, text
            )));
        }
        Ok(())
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    struct EnvVarGuard {
        key: &'static str,
        old: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, old }
        }

        fn unset(key: &'static str) -> Self {
            let old = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

#[cfg(test)]
mod download_bundle_url_routing_tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_tiny_zip(inner_name: &str) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(buf);
        zw.start_file(inner_name, zip::write::SimpleFileOptions::default()).unwrap();
        zw.write_all(b"hello").unwrap();
        zw.finish().unwrap().into_inner()
    }

    #[tokio::test]
    async fn download_bundle_handles_raw_githubusercontent_url() {
        // Sets STS2_GITHUB_API_BASE — share the env-var lock with the other suites.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        let zip_bytes = make_tiny_zip("OldMod.json");
        Mock::given(method("GET"))
            .and(path("/repos/owner/sts2mm-profiles/contents/mods/OldMod_v1.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://raw.githubusercontent.com/owner/sts2mm-profiles/main/mods/OldMod_v1.zip",
            "OldMod", tmp.path()
        ).await.expect("legacy URL must still work");

        assert!(tmp.path().join("OldMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_handles_release_download_url() {
        // Sets STS2_GITHUB_RELEASES_BASE — process-global env var, same lock.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        let zip_bytes = make_tiny_zip("NewMod.json");
        Mock::given(method("GET"))
            .and(path("/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://github.com/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip",
            "NewMod", tmp.path()
        ).await.expect("release URL must work");

        assert!(tmp.path().join("NewMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_handles_arbitrary_https_url() {
        // No env-var mutation here — direct URL into the mock server, so no lock needed.
        let server = MockServer::start().await;
        let zip_bytes = make_tiny_zip("ExternalMod.json");
        Mock::given(method("GET"))
            .and(path("/some/path/ExternalMod.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            &format!("{}/some/path/ExternalMod.zip", server.uri()),
            "ExternalMod", tmp.path()
        ).await.expect("non-github URL must work");

        assert!(tmp.path().join("ExternalMod.json").exists());
    }
}
