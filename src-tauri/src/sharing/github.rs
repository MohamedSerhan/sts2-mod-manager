//! Low-level GitHub HTTP plumbing: the reqwest client builder,
//! the `STS2_GITHUB_API_BASE` env-var indirection, basic
//! request/response shapes, AND the release-asset upload/delete/
//! replace orchestration the rest of the sharing layer composes
//! into higher-level workflows.
//!
//! Split out of the historic `sharing.rs` mega-file so the testable
//! "talks to GitHub" surface (Contents/User/Releases API shapes,
//! Bearer-auth header wiring, release-asset CRUD, paginated asset
//! listing, GC sweep, anonymous + authenticated profile fetches,
//! and bundle download) lives separately from the orchestration
//! that stitches share/publish workflows together (`sharing/mod.rs`)
//! and the zip-bundling layer (`sharing/upload.rs`).
//!
//! See `sharing/mod.rs` for the Tauri-command orchestrators that
//! call into these helpers, and `sharing/code.rs` for the pure
//! share-code parsing/validation layer.

use std::future::Future;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, Result};
use crate::profiles::Profile;

use super::code::{decode_asset_name, release_asset_name};
use super::upload::zip_entry_outpath;

/// Total request timeout for sharing HTTP clients. Long enough for a
/// large release-asset download on a slow link, short enough that a
/// stalled connection can't pin the share/publish worker forever.
pub(super) const HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Connect timeout for sharing HTTP clients. A connect that's still
/// pending after 10s is almost certainly a routing/DNS issue.
pub(super) const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);
type CancelCheck<'a> = Option<&'a (dyn Fn() -> bool + Send + Sync)>;

/// Tag used for the rolling "bundles" release on every curator's
/// `sts2mm-profiles` repo. One release = one stable tag = one stable
/// URL prefix for every shared bundle. Asset names carry the version
/// (`<mod>_v<ver>_<sha8>.zip`), so versioning happens at the asset layer.
pub(super) const BUNDLES_RELEASE_TAG: &str = "bundles";

fn sharing_canceled_error() -> AppError {
    AppError::Other("Sharing canceled.".into())
}

fn check_cancel(cancel_requested: CancelCheck<'_>) -> Result<()> {
    if cancel_requested
        .map(|cancelled| cancelled())
        .unwrap_or(false)
    {
        return Err(sharing_canceled_error());
    }
    Ok(())
}

async fn wait_for_cancel(cancel_requested: CancelCheck<'_>) -> Result<()> {
    loop {
        check_cancel(cancel_requested)?;
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
    }
}

async fn await_with_cancel<F, T>(future: F, cancel_requested: CancelCheck<'_>) -> Result<T>
where
    F: Future<Output = T>,
{
    check_cancel(cancel_requested)?;
    if cancel_requested.is_none() {
        return Ok(future.await);
    }
    tokio::select! {
        result = future => Ok(result),
        cancelled = wait_for_cancel(cancel_requested) => {
            cancelled?;
            unreachable!("wait_for_cancel only returns on cancellation")
        }
    }
}

async fn sleep_or_cancel(duration: Duration, cancel_requested: CancelCheck<'_>) -> Result<()> {
    check_cancel(cancel_requested)?;
    if cancel_requested.is_none() {
        tokio::time::sleep(duration).await;
        return Ok(());
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(()),
        cancelled = wait_for_cancel(cancel_requested) => cancelled,
    }
}

// ── GitHub API Response Shapes ─────────────────────────────────────────────

/// GitHub Contents API response — we only need the SHA for upsert ops.
/// serde drops unknown fields by default, so the rest of the payload
/// (content, html_url, etc.) is ignored without us having to declare them.
#[derive(Debug, Deserialize)]
pub(super) struct ContentsResponse {
    pub sha: Option<String>,
}

/// GitHub user response
#[derive(Debug, Deserialize)]
pub(super) struct UserResponse {
    pub login: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ReleaseResponse {
    pub id: u64,
    /// Template like `https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}`.
    /// We strip the `{?name,label}` suffix and append `?name=<filename>` ourselves.
    pub upload_url: String,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ReleaseAsset {
    pub id: u64,
    pub name: String,
    pub browser_download_url: String,
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

// ── HTTP Client ────────────────────────────────────────────────────────────

/// Base URL for GitHub's REST API. Tests override via the
/// `STS2_GITHUB_API_BASE` env var so wiremock can intercept; production
/// always reads the literal default (the env var is only set by tests).
///
/// Pulled out instead of threading a `base_url: &str` parameter through
/// every upload helper because (a) the prod code never varies it and (b)
/// the helpers already form URLs by `format!`, so a single base swap is
/// the minimum surface change for testability.
pub(crate) fn github_api_base() -> String {
    std::env::var("STS2_GITHUB_API_BASE").unwrap_or_else(|_| "https://api.github.com".to_string())
}

/// Build a reqwest `Client` pre-configured with the GitHub API headers
/// (Accept, User-Agent, Bearer auth) and the standard timeouts. Public
/// at `pub(crate)` because `modpack_browser.rs` reuses it to fetch
/// the public-listing index from the same auth context.
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
        concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION"))
            .parse()
            .unwrap(),
    );
    if let Ok(val) = format!("Bearer {}", token).parse() {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    crate::http::https_client_builder()
        .default_headers(headers)
        .timeout(HTTP_TOTAL_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

// ── Basic API Calls ────────────────────────────────────────────────────────

/// Get the authenticated user's GitHub username.
pub(super) async fn get_github_username(token: &str) -> Result<String> {
    let client = build_client(token);
    let resp = client
        .get(&format!("{}/user", github_api_base()))
        .send()
        .await?;

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
pub(super) async fn ensure_profiles_repo(token: &str, username: &str, repo: &str) -> Result<()> {
    let client = build_client(token);

    // Check if repo exists
    let resp = client
        .get(&format!(
            "{}/repos/{}/{}",
            github_api_base(),
            username,
            repo
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
pub(super) async fn upsert_file(
    token: &str,
    username: &str,
    repo: &str,
    filename: &str,
    content: &str,
    existing_sha: Option<&str>,
    message: &str,
) -> Result<(String, String)> {
    let client = build_client(token);
    let url = format!(
        "{}/repos/{}/{}/contents/{}",
        github_api_base(),
        username,
        repo,
        filename
    );

    // If we don't have the SHA, try to get it (needed for updates)
    let sha = if let Some(s) = existing_sha {
        Some(s.to_string())
    } else {
        let resp = client.get(&url).send().await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                let info: ContentsResponse =
                    resp.json().await.unwrap_or(ContentsResponse { sha: None });
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
    let file_sha = data["content"]["sha"].as_str().unwrap_or("").to_string();
    let html_url = data["content"]["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok((file_sha, html_url))
}

// ── Release-Asset Helpers ──────────────────────────────────────────────────

/// Ensure the rolling `bundles` release exists on the profiles repo,
/// creating it on first share. Returns the release as it exists after
/// this call — assets included so the caller can dedupe without a
/// second round-trip.
///
/// Why a single rolling release instead of one per share: asset names
/// carry the version (`<mod>_v<ver>.zip`), so versioning happens at the
/// asset layer. One release = one stable tag (`bundles`) = one stable
/// URL prefix for every shared bundle.
pub(super) async fn ensure_bundles_release(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<ReleaseResponse> {
    let base = github_api_base();
    let tag_url = format!(
        "{}/repos/{}/{}/releases/tags/{}",
        base, owner, repo, BUNDLES_RELEASE_TAG
    );

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
    let assets_url = format!(
        "{}/repos/{}/{}/releases/{}/assets",
        base, owner, repo, release.id
    );
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

/// How many total attempts the bundle transfer retry loops make before
/// giving up on a transient failure (timeouts, connection drops, 5xx,
/// 403/429 rate-limit/abuse). `1` initial try + `RETRY_MAX_ATTEMPTS - 1`
/// retries. Only transient classes retry — permanent 4xx (401/404/422/…)
/// fail on the first attempt, see `RetryClass`.
const RETRY_MAX_ATTEMPTS: u32 = 3;

/// Base delay for the exponential backoff between transfer retries
/// (attempt 1 → BASE, attempt 2 → BASE*2, …). Kept tiny under
/// `cfg(test)` so the retry tests don't add real wall-clock time;
/// production waits seconds so a momentary GitHub blip clears.
#[cfg(not(test))]
const RETRY_BASE_DELAY: Duration = Duration::from_secs(2);
#[cfg(test)]
const RETRY_BASE_DELAY: Duration = Duration::from_millis(1);

/// Upper bound on how long we'll honor a server-sent `Retry-After` before
/// the next transfer attempt. GitHub secondary-rate-limit responses can ask
/// for long waits; we cap so a pathological value can't pin the share
/// worker for minutes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(30);

/// Classification of a failed transfer attempt for the retry loop. (Success
/// is represented as `Ok(...)` by the caller, not a variant here.)
enum RetryClass {
    /// A transient failure worth retrying after a backoff. The optional
    /// `Duration` is a server-requested `Retry-After` (already parsed +
    /// capped); when present the loop waits at least that long.
    Transient(Option<Duration>),
    /// A permanent failure (auth/validation/not-found). Do NOT retry —
    /// the carried message bubbles straight up to the caller. This also
    /// carries the 422 `already_exists` text so the recovering wrapper
    /// can still detect and repair name conflicts.
    Permanent(String),
}

#[derive(Clone, Copy)]
enum AssetUploadPayload<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}

/// Parse a `Retry-After` header value (delay-seconds form only — GitHub's
/// rate-limit responses use integer seconds) into a capped `Duration`.
/// Returns `None` for missing/garbage values so the caller falls back to
/// plain exponential backoff.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let secs: u64 = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs).min(RETRY_AFTER_CAP))
}

/// Whether a non-success HTTP status is a transient class we retry.
/// 5xx are server-side blips; 403/429 are GitHub's secondary-rate-limit /
/// abuse signals (403 with a `Retry-After` or abuse body, 429 always).
/// Every other 4xx (401 auth, 404 missing, 422 validation) is permanent.
fn status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::FORBIDDEN
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
///
/// Transient failures (request timeout / connection drop, HTTP 5xx, and
/// GitHub's 403/429 secondary-rate-limit/abuse responses) are retried up
/// to `RETRY_MAX_ATTEMPTS` times with exponential backoff, honoring a
/// `Retry-After` header when present. This is the primary fix for issue
/// #164: previously any one of those hiccups dropped a random mod into
/// `failed_uploads` and blocked the whole publish. Permanent failures
/// (401/404/422/…) are NOT retried — they fail on the first attempt.
pub(super) async fn upload_release_asset(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    data: &[u8],
) -> Result<ReleaseAsset> {
    upload_release_asset_payload(
        client,
        upload_url_template,
        filename,
        label,
        AssetUploadPayload::Bytes(data),
        None,
    )
    .await
}

#[allow(dead_code)]
pub(super) async fn upload_release_asset_file(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    path: &Path,
) -> Result<ReleaseAsset> {
    upload_release_asset_file_with_cancel(client, upload_url_template, filename, label, path, None)
        .await
}

async fn upload_release_asset_file_with_cancel(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<ReleaseAsset> {
    upload_release_asset_payload(
        client,
        upload_url_template,
        filename,
        label,
        AssetUploadPayload::File(path),
        cancel_requested,
    )
    .await
}

async fn upload_release_asset_payload(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    payload: AssetUploadPayload<'_>,
    cancel_requested: CancelCheck<'_>,
) -> Result<ReleaseAsset> {
    let base = upload_url_template
        .split_once('{')
        .map(|(b, _)| b)
        .unwrap_or(upload_url_template);
    let encoded_name = urlencoding::encode(filename);
    let url = match label {
        // GitHub silently strips non-ASCII chars from the asset filename
        // (Chinese ideographs, emoji, etc.) — documented behavior we can't
        // disable. The separate `label` param ("alternate short
        // description of the asset, used in place of the filename") is
        // shown on the release page UI INSTEAD of the mangled filename,
        // so we pass the original human-readable name through there.
        Some(l) => format!(
            "{}?name={}&label={}",
            base,
            encoded_name,
            urlencoding::encode(l)
        ),
        None => format!("{}?name={}", base, encoded_name),
    };

    let mut attempt: u32 = 0;
    loop {
        check_cancel(cancel_requested)?;
        attempt += 1;

        // Classify this attempt without holding the response borrow across
        // the backoff sleep: resolve to `Ok(asset)`, retry, or a permanent
        // error before we decide whether to loop.
        let mut request = client
            .post(&url)
            .header(reqwest::header::CONTENT_TYPE, "application/zip");
        request = match payload {
            AssetUploadPayload::Bytes(data) => request.body(data.to_vec()),
            AssetUploadPayload::File(path) => {
                let file = await_with_cancel(tokio::fs::File::open(path), cancel_requested)
                    .await?
                    .map_err(|e| {
                        AppError::Other(format!(
                            "Failed to open release asset '{}' for upload from '{}': {}",
                            filename,
                            path.display(),
                            e
                        ))
                    })?;
                let size = await_with_cancel(file.metadata(), cancel_requested)
                    .await?
                    .map_err(|e| {
                        AppError::Other(format!(
                            "Failed to stat release asset '{}' at '{}': {}",
                            filename,
                            path.display(),
                            e
                        ))
                    })?;
                let stream = tokio_util::io::ReaderStream::new(file);
                request
                    .header(reqwest::header::CONTENT_LENGTH, size.len())
                    .body(reqwest::Body::wrap_stream(stream))
            }
        };

        let send_result = await_with_cancel(request.send(), cancel_requested).await?;
        let outcome: std::result::Result<ReleaseAsset, RetryClass> = match send_result {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match await_with_cancel(resp.json::<ReleaseAsset>(), cancel_requested).await? {
                        Ok(asset) => Ok(asset),
                        // A malformed success body isn't something a retry
                        // fixes — surface it.
                        Err(e) => Err(RetryClass::Permanent(format!(
                            "Failed to parse uploaded asset '{}': {}",
                            filename, e
                        ))),
                    }
                } else {
                    let retry_after = parse_retry_after(resp.headers());
                    let text = resp.text().await.unwrap_or_default();
                    let msg = format!(
                        "Failed to upload release asset '{}' ({}): {}",
                        filename, status, text
                    );
                    if status_is_transient(status) {
                        log::warn!(
                            "Transient upload failure for '{}' (attempt {}/{}): {} {}",
                            filename,
                            attempt,
                            RETRY_MAX_ATTEMPTS,
                            status,
                            text
                        );
                        Err(RetryClass::Transient(retry_after))
                    } else {
                        // Permanent — but 422 already_exists must reach the
                        // recovering wrapper, so we carry the message intact.
                        Err(RetryClass::Permanent(msg))
                    }
                }
            }
            Err(e) if e.is_timeout() || e.is_connect() || e.is_request() => {
                log::warn!(
                    "Transient upload error for '{}' (attempt {}/{}): {}",
                    filename,
                    attempt,
                    RETRY_MAX_ATTEMPTS,
                    e
                );
                Err(RetryClass::Transient(None))
            }
            Err(e) => Err(RetryClass::Permanent(format!(
                "Failed to upload release asset '{}': {}",
                filename, e
            ))),
        };

        match outcome {
            Ok(asset) => return Ok(asset),
            Err(RetryClass::Permanent(msg)) => return Err(AppError::Other(msg)),
            Err(RetryClass::Transient(retry_after)) => {
                if attempt >= RETRY_MAX_ATTEMPTS {
                    return Err(AppError::Other(format!(
                        "Failed to upload release asset '{}' after {} attempts (last failure was transient — network or GitHub rate-limit). Try sharing again.",
                        filename, RETRY_MAX_ATTEMPTS
                    )));
                }
                // Exponential backoff: BASE * 2^(attempt-1), or the
                // server-requested Retry-After if it's longer.
                let backoff = RETRY_BASE_DELAY
                    .saturating_mul(1u32 << (attempt - 1))
                    .max(retry_after.unwrap_or(Duration::ZERO));
                sleep_or_cancel(backoff, cancel_requested).await?;
            }
        }
    }
}

/// Upload helper that recovers from GitHub's `422 already_exists`. The
/// in-memory release listing we built ahead of time can lie — GitHub's
/// per-release `assets` array sometimes round-trips non-ASCII names
/// differently from what our `?name=<encoded>` POST produces, so our
/// lookup may legitimately miss an asset that GitHub then refuses to
/// re-create. When that happens we refetch the live asset listing, find
/// the conflicting asset by canonical-decoded name, DELETE it, and POST
/// once more. One retry only — any further conflict bubbles up.
pub(super) async fn upload_release_asset_recovering(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    data: &[u8],
) -> Result<ReleaseAsset> {
    upload_release_asset_recovering_payload(
        client,
        owner,
        repo,
        upload_url_template,
        filename,
        label,
        AssetUploadPayload::Bytes(data),
        None,
    )
    .await
}

#[allow(dead_code)]
pub(super) async fn upload_release_asset_file_recovering(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    path: &Path,
) -> Result<ReleaseAsset> {
    upload_release_asset_file_recovering_with_cancel(
        client,
        owner,
        repo,
        upload_url_template,
        filename,
        label,
        path,
        None,
    )
    .await
}

async fn upload_release_asset_file_recovering_with_cancel(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<ReleaseAsset> {
    upload_release_asset_recovering_payload(
        client,
        owner,
        repo,
        upload_url_template,
        filename,
        label,
        AssetUploadPayload::File(path),
        cancel_requested,
    )
    .await
}

async fn upload_release_asset_recovering_payload(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    filename: &str,
    label: Option<&str>,
    payload: AssetUploadPayload<'_>,
    cancel_requested: CancelCheck<'_>,
) -> Result<ReleaseAsset> {
    match upload_release_asset_payload(
        client,
        upload_url_template,
        filename,
        label,
        payload,
        cancel_requested,
    )
    .await
    {
        Ok(asset) => Ok(asset),
        Err(AppError::Other(msg)) if msg.contains("already_exists") => {
            check_cancel(cancel_requested)?;
            log::warn!(
                "Asset '{}' returned 422 already_exists — refetching release listing and replacing via DELETE-then-POST",
                filename
            );
            for attempt in 1..=RETRY_MAX_ATTEMPTS {
                let fresh = ensure_bundles_release(client, owner, repo).await?;
                check_cancel(cancel_requested)?;
                if let Some(asset) = fresh
                    .assets
                    .iter()
                    .find(|a| release_asset_names_match(&a.name, filename))
                {
                    delete_release_asset(client, owner, repo, asset.id).await?;
                    check_cancel(cancel_requested)?;
                    return upload_release_asset_payload(
                        client,
                        &fresh.upload_url,
                        filename,
                        label,
                        payload,
                        cancel_requested,
                    )
                    .await;
                }
                if attempt < RETRY_MAX_ATTEMPTS {
                    sleep_or_cancel(RETRY_BASE_DELAY.saturating_mul(attempt), cancel_requested)
                        .await?;
                }
            }
            Err(AppError::Other(format!(
                "Upload of '{}' failed with 422 already_exists but the asset is not visible in the release listing after {} checks — \
                 wait a minute and try sharing again, or delete the asset manually from GitHub.",
                filename, RETRY_MAX_ATTEMPTS
            )))
        }
        Err(e) => Err(e),
    }
}

fn release_asset_names_match(existing_name: &str, requested_name: &str) -> bool {
    let existing = decode_asset_name(existing_name);
    let requested = decode_asset_name(requested_name);
    if existing == requested {
        return true;
    }

    let existing_key = github_asset_rename_key(&existing);
    let requested_key = github_asset_rename_key(&requested);
    !existing_key.is_empty() && existing_key == requested_key
}

fn github_asset_rename_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect::<String>()
        .trim_matches(|c| matches!(c, '.' | '_' | '-'))
        .to_string()
}

/// DELETE a release asset. Used by the replace flow to free the canonical
/// name before re-POSTing fresh bytes under the same name.
pub(super) async fn delete_release_asset(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    asset_id: u64,
) -> Result<()> {
    let url = format!(
        "{}/repos/{}/{}/releases/assets/{}",
        github_api_base(),
        owner,
        repo,
        asset_id
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
pub(super) async fn replace_release_asset_via_delete_post(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    canonical_name: &str,
    label: Option<&str>,
    old_asset_id: u64,
    data: &[u8],
) -> Result<String> {
    delete_release_asset(client, owner, repo, old_asset_id).await?;
    let asset =
        upload_release_asset(client, upload_url_template, canonical_name, label, data).await?;
    Ok(asset.browser_download_url)
}

#[allow(dead_code)]
pub(super) async fn replace_release_asset_via_delete_post_file(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    canonical_name: &str,
    label: Option<&str>,
    old_asset_id: u64,
    path: &Path,
) -> Result<String> {
    replace_release_asset_via_delete_post_file_with_cancel(
        client,
        owner,
        repo,
        upload_url_template,
        canonical_name,
        label,
        old_asset_id,
        path,
        None,
    )
    .await
}

async fn replace_release_asset_via_delete_post_file_with_cancel(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    canonical_name: &str,
    label: Option<&str>,
    old_asset_id: u64,
    path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<String> {
    delete_release_asset(client, owner, repo, old_asset_id).await?;
    check_cancel(cancel_requested)?;
    let asset = upload_release_asset_file_with_cancel(
        client,
        upload_url_template,
        canonical_name,
        label,
        path,
        cancel_requested,
    )
    .await?;
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
#[allow(dead_code)]
pub(super) async fn upload_mod_bundle_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_data: &[u8],
    prior_sha256: Option<&str>,
    repo: &str,
) -> Result<(String, String)> {
    use sha2::{Digest, Sha256};

    // Hash first so the asset filename can carry the content prefix.
    // Content-addressed names mean: identical bytes → identical filename
    // (skippable via the prior_sha256 short-circuit below) and different
    // bytes → different filename (no GitHub-side dedup collision, ever).
    // Pre-fix, two re-shares with the same logical version but different
    // bytes would race on the same asset name and trip 422 already_exists
    // even when our lookup correctly identified the conflict — and worse,
    // some past-version uploads left orphan names in GitHub's dedup index
    // that the listing API doesn't surface, so even a fresh POST 422'd.
    let mut hasher = Sha256::new();
    hasher.update(zip_data);
    let local_hash = hex::encode(hasher.finalize());

    upload_mod_bundle_via_release_payload(
        token,
        username,
        mod_name,
        version,
        local_hash,
        prior_sha256,
        repo,
        AssetUploadPayload::Bytes(zip_data),
        None,
    )
    .await
}

#[allow(dead_code)]
pub(super) async fn upload_mod_bundle_file_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_path: &Path,
    prior_sha256: Option<&str>,
    repo: &str,
) -> Result<(String, String)> {
    upload_mod_bundle_file_via_release_with_cancel(
        token,
        username,
        mod_name,
        version,
        zip_path,
        prior_sha256,
        repo,
        None,
    )
    .await
}

pub(super) async fn upload_mod_bundle_file_via_release_with_cancel(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_path: &Path,
    prior_sha256: Option<&str>,
    repo: &str,
    cancel_requested: CancelCheck<'_>,
) -> Result<(String, String)> {
    let local_hash = sha256_hex_file_with_cancel(zip_path, cancel_requested)?;
    upload_mod_bundle_via_release_payload(
        token,
        username,
        mod_name,
        version,
        local_hash,
        prior_sha256,
        repo,
        AssetUploadPayload::File(zip_path),
        cancel_requested,
    )
    .await
}

async fn upload_mod_bundle_via_release_payload(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    local_hash: String,
    prior_sha256: Option<&str>,
    repo: &str,
    payload: AssetUploadPayload<'_>,
    cancel_requested: CancelCheck<'_>,
) -> Result<(String, String)> {
    check_cancel(cancel_requested)?;
    let client = build_client(token);
    let asset_name = release_asset_name(mod_name, version, &local_hash);
    // GitHub strips non-ASCII chars from the asset filename it stores
    // (Chinese ideographs, emoji, etc.) -- undocumented but consistent
    // behavior, see https://docs.github.com/en/rest/releases/assets.
    // The `label` query param is described as "an alternate short
    // description of the asset, used in place of the filename" -- it's
    // shown on the release-page UI instead of the mangled stored name,
    // so we put the human-readable "<mod> v<version>" form there.
    let asset_label = format!("{} v{}", mod_name, version);

    let release = ensure_bundles_release(&client, username, repo).await?;
    check_cancel(cancel_requested)?;

    // Lookup compares percent-decoded names on both sides so the same
    // logical filename matches whether GitHub returns the raw UTF-8 form
    // or an already-encoded one. Without this, mods with non-ASCII names
    // round-tripped to a POST -> 422 already_exists loop.
    if let Some(existing) = release
        .assets
        .iter()
        .find(|a| release_asset_names_match(&a.name, &asset_name))
    {
        let hash_matches = prior_sha256
            .map(|p| p == local_hash.as_str())
            // The canonical asset name already includes the local hash
            // prefix. If GitHub has that exact name but local state lost
            // `prior_sha256` (for example, the app crashed after upload
            // and before saving the manifest), reusing is safer and much
            // faster than deleting and re-uploading identical bytes.
            .unwrap_or(true);
        if hash_matches {
            if prior_sha256.is_some() {
                log::info!(
                    "Bundle for '{}' v{} unchanged (sha256 match) -- reusing existing release asset",
                    mod_name,
                    version
                );
            } else {
                log::info!(
                    "Bundle for '{}' v{} already exists under the content-addressed name -- reusing existing release asset",
                    mod_name,
                    version
                );
            }
            return Ok((existing.browser_download_url.clone(), local_hash));
        }

        // Name collision but content differs (or we can't prove it doesn't).
        // Replace via DELETE-then-POST. Brief atomicity gap on the canonical
        // URL during upload, but it never strands `.stale` orphans that
        // break subsequent replaces (see replace_release_asset_via_delete_post).
        log::info!(
            "Bundle for '{}' v{} content changed since last share -- replacing release asset",
            mod_name,
            version
        );
        let url = match payload {
            AssetUploadPayload::Bytes(data) => {
                replace_release_asset_via_delete_post(
                    &client,
                    username,
                    repo,
                    &release.upload_url,
                    &asset_name,
                    Some(&asset_label),
                    existing.id,
                    data,
                )
                .await?
            }
            AssetUploadPayload::File(path) => {
                replace_release_asset_via_delete_post_file_with_cancel(
                    &client,
                    username,
                    repo,
                    &release.upload_url,
                    &asset_name,
                    Some(&asset_label),
                    existing.id,
                    path,
                    cancel_requested,
                )
                .await?
            }
        };
        return Ok((url, local_hash));
    }

    // Net-new upload, with 422 already_exists recovery; see
    // upload_release_asset_recovering for the rationale.
    let asset = match payload {
        AssetUploadPayload::Bytes(data) => {
            upload_release_asset_recovering(
                &client,
                username,
                repo,
                &release.upload_url,
                &asset_name,
                Some(&asset_label),
                data,
            )
            .await?
        }
        AssetUploadPayload::File(path) => {
            upload_release_asset_file_recovering_with_cancel(
                &client,
                username,
                repo,
                &release.upload_url,
                &asset_name,
                Some(&asset_label),
                path,
                cancel_requested,
            )
            .await?
        }
    };
    Ok((asset.browser_download_url, local_hash))
}
#[allow(dead_code)]
fn sha256_hex_file(path: &Path) -> Result<String> {
    sha256_hex_file_with_cancel(path, None)
}

fn sha256_hex_file_with_cancel(path: &Path, cancel_requested: CancelCheck<'_>) -> Result<String> {
    use sha2::{Digest, Sha256};

    check_cancel(cancel_requested)?;
    let mut file = std::fs::File::open(path).map_err(|e| {
        AppError::Other(format!(
            "Failed to open bundle '{}' for hashing: {}",
            path.display(),
            e
        ))
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        check_cancel(cancel_requested)?;
        let read = file.read(&mut buf).map_err(|e| {
            AppError::Other(format!(
                "Failed to read bundle '{}' for hashing: {}",
                path.display(),
                e
            ))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
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
pub(super) async fn cleanup_orphan_bundle_assets(
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<usize> {
    let client = build_client(token);
    let base = github_api_base();

    // 1. List `.json` profile manifests at the repo root.
    let listing_url = format!("{}/repos/{}/{}/contents", base, owner, repo);
    let listing_resp = match client.get(&listing_url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!(
                "GC: skipping cleanup — could not list contents of {}/{}: {}",
                owner,
                repo,
                e
            );
            return Ok(0);
        }
    };
    if !listing_resp.status().is_success() {
        log::warn!(
            "GC: skipping cleanup — contents listing for {}/{} returned {}",
            owner,
            repo,
            listing_resp.status()
        );
        return Ok(0);
    }
    let entries: Vec<RepoContentEntry> = match listing_resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "GC: skipping cleanup — could not parse contents listing for {}/{}: {}",
                owner,
                repo,
                e
            );
            return Ok(0);
        }
    };

    // 2. For each `.json` manifest, collect referenced bundle URLs.
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in entries
        .iter()
        .filter(|e| e.entry_type == "file" && e.name.ends_with(".json"))
    {
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
        let profile: Profile = match resp.json().await {
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
    let release = match ensure_bundles_release(&client, owner, repo).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!(
                "GC: could not fetch bundles release for {}/{}: {}",
                owner,
                repo,
                e
            );
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
        match delete_release_asset(&client, owner, repo, asset.id).await {
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

// ── Bundle Download + Profile Fetch ────────────────────────────────────────

/// Download a bundled mod zip from a URL and extract into mods_path.
/// Uses the GitHub API (not raw.githubusercontent.com) to avoid CDN caching issues.
/// Whether a modpack bundle may be downloaded from `raw`. The bundle URL comes
/// from an untrusted manifest, so only `https` downloads from GitHub's asset
/// hosts are allowed — this prevents a malicious manifest from pointing the
/// downloader at an internal or arbitrary address (SSRF). (Audit H-1 / M-2)
fn bundle_url_is_allowed(raw: &str) -> bool {
    match url::Url::parse(raw) {
        Ok(u) => {
            u.scheme() == "https"
                && matches!(
                    u.host_str(),
                    Some("github.com")
                        | Some("raw.githubusercontent.com")
                        | Some("objects.githubusercontent.com")
                )
        }
        Err(_) => false,
    }
}

/// Compute the SHA256 hex digest of `bytes`. Used for bundle integrity
/// verification (Fix M-1) and upload content-addressing.
fn sha256_hex_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

async fn download_bundle_bytes_with_retry(
    client: &reqwest::Client,
    url: &str,
    mod_name: &str,
    source_label: &str,
    accept: Option<&str>,
) -> Result<Vec<u8>> {
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let outcome: std::result::Result<Vec<u8>, RetryClass> = match {
            let mut req = client.get(url);
            if let Some(value) = accept {
                req = req.header("Accept", value);
            }
            req.send().await
        } {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.bytes().await {
                        Ok(bytes) => Ok(bytes.to_vec()),
                        Err(e)
                            if e.is_timeout()
                                || e.is_connect()
                                || e.is_request()
                                || e.is_body() =>
                        {
                            log::warn!(
                                "Transient bundle body error for '{}' from {} (attempt {}/{}): {}",
                                mod_name,
                                source_label,
                                attempt,
                                RETRY_MAX_ATTEMPTS,
                                e
                            );
                            Err(RetryClass::Transient(None))
                        }
                        Err(e) => Err(RetryClass::Permanent(format!(
                            "Failed to read bundle for '{}' from {}: {}",
                            mod_name, source_label, e
                        ))),
                    }
                } else {
                    let retry_after = parse_retry_after(resp.headers());
                    let msg = format!(
                        "Failed to download bundle for '{}' from {}: {}",
                        mod_name, source_label, status
                    );
                    if status_is_transient(status) {
                        log::warn!(
                            "Transient bundle download failure for '{}' from {} (attempt {}/{}): {}",
                            mod_name,
                            source_label,
                            attempt,
                            RETRY_MAX_ATTEMPTS,
                            status
                        );
                        Err(RetryClass::Transient(retry_after))
                    } else {
                        Err(RetryClass::Permanent(msg))
                    }
                }
            }
            Err(e) if e.is_timeout() || e.is_connect() || e.is_request() || e.is_body() => {
                log::warn!(
                    "Transient bundle download error for '{}' from {} (attempt {}/{}): {}",
                    mod_name,
                    source_label,
                    attempt,
                    RETRY_MAX_ATTEMPTS,
                    e
                );
                Err(RetryClass::Transient(None))
            }
            Err(e) => Err(RetryClass::Permanent(format!(
                "Failed to download bundle for '{}' from {}: {}",
                mod_name, source_label, e
            ))),
        };

        match outcome {
            Ok(bytes) => return Ok(bytes),
            Err(RetryClass::Permanent(msg)) => return Err(AppError::Other(msg)),
            Err(RetryClass::Transient(retry_after)) => {
                if attempt >= RETRY_MAX_ATTEMPTS {
                    return Err(AppError::Other(format!(
                        "Failed to download bundle for '{}' from {} after {} attempts (last failure was transient).",
                        mod_name, source_label, RETRY_MAX_ATTEMPTS
                    )));
                }
                let backoff = RETRY_BASE_DELAY
                    .saturating_mul(1u32 << (attempt - 1))
                    .max(retry_after.unwrap_or(Duration::ZERO));
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

/// Whether `raw` points at a loopback host. Used only to widen the bundle
/// download guard under `cfg!(test)` so the modpack flow tests can fetch from a
/// local mock server; never relied on in shipped builds.
fn url_host_is_loopback(raw: &str) -> bool {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .map(|h| h == "127.0.0.1" || h == "::1" || h == "localhost")
        .unwrap_or(false)
}

pub async fn download_bundle(
    url: &str,
    mod_name: &str,
    mods_path: &std::path::Path,
    expected_sha256: Option<&str>,
) -> Result<()> {
    // SSRF guard: the bundle URL comes from an untrusted modpack manifest.
    // Refuse anything that isn't an https GitHub asset URL before any fetch so
    // a malicious manifest can't make us hit an internal/arbitrary address.
    // (Audit H-1)
    // Loopback is permitted only under cfg!(test) so the modpack flow tests can
    // download from a local mock server; cfg!(test) is false in release and
    // integration builds, so shipped builds enforce the GitHub-host allowlist.
    let url_allowed = bundle_url_is_allowed(url) || (cfg!(test) && url_host_is_loopback(url));
    if !url_allowed {
        return Err(AppError::Other(format!(
            "Refusing to download bundle for '{}' from a disallowed URL: {}",
            mod_name, url
        )));
    }

    if expected_sha256.is_none() {
        log::warn!(
            "download_bundle: no bundle_sha256 for '{}' — integrity check skipped (legacy profile)",
            mod_name
        );
    }

    let client = crate::http::https_client_builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TOTAL_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
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
            // Fix M-1: verify SHA256 before extracting (cassette path).
            if let Some(expected) = expected_sha256 {
                let actual = sha256_hex_bytes(&cached);
                if actual != expected {
                    return Err(AppError::Other(format!(
                        "SHA256 mismatch for '{}': expected {}, got {}",
                        mod_name, expected, actual
                    )));
                }
            }
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
        log::info!(
            "Downloading release bundle '{}' from {}",
            mod_name,
            effective
        );
        download_bundle_bytes_with_retry(&client, &effective, mod_name, "release asset", None)
            .await?
    } else if url.starts_with("https://raw.githubusercontent.com/") {
        // Use GitHub API to avoid CDN caching issues
        let parts: Vec<&str> = url
            .trim_start_matches("https://raw.githubusercontent.com/")
            .splitn(4, '/')
            .collect();
        if parts.len() >= 4 {
            let (owner, repo, _branch, path) = (parts[0], parts[1], parts[2], parts[3]);
            let api_url = format!(
                "{}/repos/{}/{}/contents/{}",
                github_api_base(),
                owner,
                repo,
                path
            );
            log::info!(
                "Downloading bundle '{}' via GitHub API: {}",
                mod_name,
                api_url
            );

            // Fallback to direct URL if the API route fails after its own
            // retries. Permanent API failures can still be recovered by the
            // raw URL, which is how the legacy path behaved.
            match download_bundle_bytes_with_retry(
                &client,
                &api_url,
                mod_name,
                "GitHub API",
                Some("application/vnd.github.raw+json"),
            )
            .await
            {
                Ok(bytes) => bytes,
                Err(e) => {
                    log::warn!(
                        "GitHub API download failed for '{}' after retries ({}), falling back to direct URL",
                        mod_name,
                        e
                    );
                    download_bundle_bytes_with_retry(&client, url, mod_name, "raw URL", None)
                        .await?
                }
            }
        } else {
            // Can't parse URL, use direct download
            download_bundle_bytes_with_retry(&client, url, mod_name, "direct URL", None).await?
        }
    } else {
        // Non-GitHub URL, use direct download
        download_bundle_bytes_with_retry(&client, url, mod_name, "direct URL", None).await?
    };

    log::info!(
        "Downloaded bundle for '{}': {} bytes",
        mod_name,
        bytes.len()
    );
    // Fix M-1: verify SHA256 before extracting (network path).
    if let Some(expected) = expected_sha256 {
        let actual = sha256_hex_bytes(&bytes);
        if actual != expected {
            return Err(AppError::Other(format!(
                "SHA256 mismatch for '{}': expected {}, got {}",
                mod_name, expected, actual
            )));
        }
    }
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
        // Defense-in-depth (audit L-11): re-assert containment even though
        // zip_entry_outpath already sanitizes, so a future weakening of that
        // helper can't silently reintroduce a zip-slip on this path.
        if !crate::mods::path_is_inside(&outpath, mods_path) {
            log::warn!(
                "Skipping bundle entry '{}' that escapes the mods directory",
                file.name()
            );
            continue;
        }
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
    repo: &str,
) -> Result<Profile> {
    let client = crate::http::https_client_builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TOTAL_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default();

    // Primary: use GitHub Contents API with raw accept header to bypass CDN cache.
    let api_url = format!(
        "{}/repos/{}/{}/contents/{}",
        github_api_base(),
        owner,
        repo,
        filename
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

    Ok(super::attribute_profile_to_owner(profile, owner))
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(super) mod release_upload_tests {
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
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::const_new(());

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
        hex::encode(h.finalize())
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
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 100,
                    "name": "OldMod_v0.1.zip",
                    "browser_download_url": "https://example/old"
                }])),
            )
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

        let page1: Vec<serde_json::Value> = (0..100)
            .map(|i| {
                serde_json::json!({
                    "id": 1000 + i,
                    "name": format!("Page1Mod{:03}_v1.0.0.zip", i),
                    "browser_download_url": format!("https://example/p1-{}", i)
                })
            })
            .collect();
        let page2: Vec<serde_json::Value> = (0..5)
            .map(|i| {
                serde_json::json!({
                    "id": 2000 + i,
                    "name": format!("Page2Mod{:03}_v1.0.0.zip", i),
                    "browser_download_url": format!("https://example/p2-{}", i)
                })
            })
            .collect();

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .and(query_param("per_page", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .and(query_param("per_page", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page2))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("paginated list should succeed");
        assert_eq!(
            release.assets.len(),
            105,
            "expected 100+5 assets across pages"
        );
        assert!(
            release
                .assets
                .iter()
                .any(|a| a.name == "Page1Mod000_v1.0.0.zip"),
            "first page name must be present"
        );
        assert!(
            release
                .assets
                .iter()
                .any(|a| a.name == "Page2Mod004_v1.0.0.zip"),
            "second page name must be present"
        );
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

        let page1: Vec<serde_json::Value> = (0..100)
            .map(|i| {
                serde_json::json!({
                    "id": 1000 + i,
                    "name": format!("Mod{:03}_v1.0.0.zip", i),
                    "browser_download_url": format!("https://example/{}", i)
                })
            })
            .collect();

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(1)
            .mount(&server)
            .await;

        // If the loop runs away to page 3, wiremock will count this expect(0)
        // mock as having received a request and fail the test on drop.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "3"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(0)
            .mount(&server)
            .await;

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
            None,
            b"PK\x03\x04...fake-zip-bytes",
        )
        .await
        .expect("upload should succeed");
        assert_eq!(
            asset.browser_download_url,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
        );
    }

    #[tokio::test]
    async fn upload_release_asset_file_posts_streamed_file_with_content_length() {
        let (server, _env_guard) = mock_github().await;
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"PK\x03\x04...file-backed-zip-bytes").unwrap();

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "LargeArtMod_v1.0.0.zip"))
            .and(header("content-type", "application/zip"))
            .and(header("content-length", "28"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1000,
                "name": "LargeArtMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/LargeArtMod_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );
        let client = build_client("test-token");
        let asset = upload_release_asset_file(
            &client,
            &upload_url_template,
            "LargeArtMod_v1.0.0.zip",
            None,
            tmp.path(),
        )
        .await
        .expect("file-backed upload should succeed");

        assert_eq!(
            asset.browser_download_url,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/LargeArtMod_v1.0.0.zip"
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
            &client,
            "octo",
            "sts2mm-profiles",
            &upload_url_template,
            "TheCursed_v0.2.7.zip",
            None,
            555,
            b"new-bytes",
        )
        .await
        .expect("delete-then-post should succeed");
        assert!(url.contains("releases/download/bundles/TheCursed_v0.2.7.zip"));
    }

    /// Helper: compute the asset filename the orchestrator will produce
    /// for these exact bytes. Asset names are content-addressed
    /// (`<mod>_v<ver>_<sha8>.zip`) so tests can't hardcode them — the
    /// SHA prefix shifts whenever the test fixture bytes change.
    fn expected_asset_name(mod_name: &str, version: &str, data: &[u8]) -> String {
        release_asset_name(mod_name, version, &sha256_hex(data))
    }

    fn expected_download_url(mod_name: &str, version: &str, data: &[u8]) -> String {
        format!(
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/{}",
            expected_asset_name(mod_name, version, data)
        )
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_first_upload_records_hash() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"fake-zip-bytes";
        let name = expected_asset_name("TheCursedMod", "0.2.7", bytes);
        let download_url = expected_download_url("TheCursedMod", "0.2.7", bytes);

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
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100,
                "name": name,
                "browser_download_url": download_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            bytes,
            None,
            "sts2mm-profiles",
        )
        .await
        .expect("first upload should succeed");
        assert_eq!(url, download_url);
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_skips_when_hash_matches() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"fake-zip-bytes";
        let prior_hash = sha256_hex(bytes);
        let name = expected_asset_name("TheCursedMod", "0.2.7", bytes);
        let download_url = expected_download_url("TheCursedMod", "0.2.7", bytes);

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
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": name,
                    "browser_download_url": download_url,
                }])),
            )
            .mount(&server)
            .await;

        // CRITICAL: any POST/DELETE means we regressed. wiremock fails on
        // unstubbed requests, so if the orchestrator tries to upload we'll
        // see it fail.

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            bytes,
            Some(&prior_hash),
            "sts2mm-profiles",
        )
        .await
        .expect("skip should succeed");
        assert_eq!(url, download_url);
        assert_eq!(
            hash, prior_hash,
            "hash returned to caller must match what was on disk"
        );
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_replaces_when_hash_differs_but_name_matches() {
        // The mod-author case: edited locally without bumping version.
        // Both old + new bytes hash differently, so under the content-
        // addressed naming the new bytes produce a brand-new asset name.
        // The orchestrator no longer needs the DELETE-then-POST replace
        // path here — it falls into the net-new POST path because the
        // looked-up canonical (new bytes) name doesn't collide.
        let (server, _env_guard) = mock_github().await;
        let bytes = b"fresh-bytes-after-edit";
        let stale_prior_hash = sha256_hex(b"original-bytes");
        let new_name = expected_asset_name("TheCursedMod", "0.2.7", bytes);
        let new_url = expected_download_url("TheCursedMod", "0.2.7", bytes);
        let stale_name = expected_asset_name("TheCursedMod", "0.2.7", b"original-bytes");

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        // Stale asset under the OLD hash's name is still on the release
        // (the GC sweep will reap it on a later share). Orchestrator
        // doesn't touch it — its canonical name is the new-hash one.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": stale_name,
                    "browser_download_url": "https://example/old"
                }])),
            )
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &new_name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": new_name,
                "browser_download_url": new_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            bytes,
            Some(&stale_prior_hash),
            "sts2mm-profiles",
        )
        .await
        .expect("net-new upload under fresh content-addressed name should succeed");
        assert_eq!(url, new_url);
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_reuses_same_bytes_same_name_no_prior_hash() {
        // Edge case: fresh install (no prior hash in profile JSON) but
        // the canonical content-addressed name happens to be on the
        // release already (curator re-installed app and lost local
        // manifest, or the app crashed after upload but before saving).
        // Because the asset name already embeds the local hash prefix,
        // the exact name match proves this is the same bundle and should
        // skip upload.
        let (server, _env_guard) = mock_github().await;
        let bytes = b"data";
        let name = expected_asset_name("TheCursedMod", "0.2.7", bytes);

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
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": name,
                    "browser_download_url": "https://example/whatever"
                }])),
            )
            .mount(&server)
            .await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            bytes,
            None,
            "sts2mm-profiles",
        )
        .await
        .expect("no-prior-hash + exact content-addressed name should reuse");
        assert_eq!(url, "https://example/whatever");
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_sanitizes_filename() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"data";
        let name = expected_asset_name("My Cool/Mod", "v1.2.3", bytes);
        let download_url = expected_download_url("My Cool/Mod", "v1.2.3", bytes);

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
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999, "name": name,
                "browser_download_url": download_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let _ = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "My Cool/Mod",
            "v1.2.3",
            bytes,
            None,
            "sts2mm-profiles",
        )
        .await
        .expect("ok");
        // Sanitised stem still appears in the filename; SHA prefix follows.
        assert!(name.starts_with("My_Cool_Mod_v1.2.3_"));
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
            .mount(&server)
            .await;

        // "皮皮极速: SpeedX" — colon and space become `_`, but the four
        // ideographs are kept verbatim. With content-addressing the
        // filename has a SHA8 suffix appended: `皮皮极速__SpeedX_v0.11.7_<sha8>.zip`.
        let bytes = b"data";
        let expected_name = expected_asset_name("皮皮极速: SpeedX", "0.11.7", bytes);
        let download_url = expected_download_url("皮皮极速: SpeedX", "0.11.7", bytes);
        assert!(
            expected_name.starts_with("皮皮极速__SpeedX_v0.11.7_"),
            "ideographs must be preserved in the asset name",
        );
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &expected_name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100,
                "name": expected_name,
                "browser_download_url": download_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let _ = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "皮皮极速: SpeedX",
            "0.11.7",
            bytes,
            None,
            "sts2mm-profiles",
        )
        .await
        .expect("non-ascii mod names must round-trip into the asset filename");
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_reuses_github_renamed_unicode_asset() {
        let (server, _env_guard) = mock_github().await;
        let bytes = b"data";
        let prior_hash = sha256_hex(bytes);
        let expected_name = expected_asset_name("皮皮配置: ModConfig", "0.2.3", bytes);
        let renamed_by_github = expected_name.trim_start_matches("皮皮配置__");
        let download_url =
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/renamed.zip";

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": renamed_by_github,
                    "browser_download_url": download_url
                }])),
            )
            .mount(&server)
            .await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "皮皮配置: ModConfig",
            "0.2.3",
            bytes,
            Some(&prior_hash),
            "sts2mm-profiles",
        )
        .await
        .expect("renamed GitHub asset should be reused before posting");

        assert_eq!(url, download_url);
        assert_eq!(hash, prior_hash);
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
        let page1: Vec<serde_json::Value> = (0..100)
            .map(|i| {
                serde_json::json!({
                    "id": 1000 + i,
                    "name": format!("OtherMod{:03}_v1.0.0.zip", i),
                    "browser_download_url": format!("https://example/other-{}", i)
                })
            })
            .collect();
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page1))
            .mount(&server)
            .await;

        // Page 2: the canonical asset (content-addressed name).
        let name = expected_asset_name("TheCursedMod", "0.2.7", bytes);
        let download_url = expected_download_url("TheCursedMod", "0.2.7", bytes);
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "2"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 9999,
                    "name": name,
                    "browser_download_url": download_url,
                }])),
            )
            .mount(&server)
            .await;

        // Hash matches → must SKIP. Any DELETE or POST means the
        // orchestrator failed to find the asset and went to upload-new,
        // which is the bug we're guarding against.
        let (url, hash) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            bytes,
            Some(&prior_hash),
            "sts2mm-profiles",
        )
        .await
        .expect("skip via page-2 lookup must succeed");
        assert_eq!(url, download_url);
        assert_eq!(hash, prior_hash);
    }

    /// Two consecutive re-shares against the same release. Under
    /// content-addressed naming each cycle produces a DIFFERENT asset
    /// filename (`<mod>_v<ver>_<sha8>.zip` differs whenever bytes
    /// differ), so each cycle hits the net-new POST path rather than
    /// the DELETE-then-POST replace path. The pre-fix `.stale`-orphan
    /// failure mode (Bug B) is now impossible — the second upload's
    /// name doesn't collide with the first's.
    #[tokio::test]
    async fn upload_mod_bundle_via_release_two_consecutive_shares_both_succeed() {
        let (server, _env_guard) = mock_github().await;
        let first_bytes = b"v1-bytes";
        let second_bytes = b"v2-bytes";
        let hash_before_first = sha256_hex(b"original-bytes");
        let hash_after_first = sha256_hex(first_bytes);
        let first_name = expected_asset_name("TheCursedMod", "0.2.7", first_bytes);
        let first_url = expected_download_url("TheCursedMod", "0.2.7", first_bytes);
        let second_name = expected_asset_name("TheCursedMod", "0.2.7", second_bytes);
        let second_url = expected_download_url("TheCursedMod", "0.2.7", second_bytes);

        // ── First cycle ────────────────────────────────────────────────
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
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &first_name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": first_name,
                "browser_download_url": first_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (url1, hash1) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            first_bytes,
            Some(&hash_before_first),
            "sts2mm-profiles",
        )
        .await
        .expect("first share must succeed");
        assert_eq!(url1, first_url);
        assert_eq!(hash1, sha256_hex(first_bytes));

        // Reset mocks so cycle 2's listing doesn't shadow cycle 1's.
        server.reset().await;

        // ── Second cycle ───────────────────────────────────────────────
        // Old asset still sits on the release (GC sweep will reap it).
        // Orchestrator looks up by the NEW canonical name, doesn't find
        // it, and POSTs net-new under the new SHA-suffixed name.
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
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 1001,
                    "name": first_name,
                    "browser_download_url": first_url,
                }])),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", &second_name))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 2002,
                "name": second_name,
                "browser_download_url": second_url,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (url2, hash2) = upload_mod_bundle_via_release(
            "test-token",
            "octo",
            "TheCursedMod",
            "0.2.7",
            second_bytes,
            Some(&hash_after_first),
            "sts2mm-profiles",
        )
        .await
        .expect("second share must succeed");
        assert_eq!(url2, second_url);
        assert_eq!(hash2, sha256_hex(second_bytes));
        assert_ne!(
            first_name, second_name,
            "different bytes must produce different content-addressed names"
        );
    }

    // ── Retry-on-transient-failure tests (issue #164) ───────────────────────
    //
    // Pre-fix, a single timeout / 5xx / 403-rate-limit during the bundle
    // upload dropped that mod into `failed_uploads` and blocked the whole
    // publish — and *which* mod hit the blip varied per run, exactly the
    // "different mod fails every time" symptom in #164. `upload_release_asset`
    // now retries transient classes with exponential backoff (tiny under
    // cfg(test)) and only fails permanent 4xx without retrying.

    #[tokio::test]
    async fn upload_release_asset_retries_on_500_then_succeeds() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // First attempt → 500 (transient). wiremock serves mocks in
        // registration order and `up_to_n_times(1)` retires this one after a
        // single match, so attempt 2 falls through to the 201 mock below.
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "Flaky_v1.0.0.zip"))
            .respond_with(ResponseTemplate::new(500).set_body_string("upstream boom"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "Flaky_v1.0.0.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 7,
                "name": "Flaky_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/Flaky_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let asset = upload_release_asset(
            &client,
            &upload_url_template,
            "Flaky_v1.0.0.zip",
            None,
            b"bytes",
        )
        .await
        .expect("a 500 then 201 must succeed after one retry");
        assert_eq!(asset.id, 7);
    }

    #[tokio::test]
    async fn upload_release_asset_retries_on_403_rate_limit_honoring_retry_after() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // First attempt → 403 with a Retry-After. Under cfg(test) the base
        // backoff is 1ms and Retry-After is capped at RETRY_AFTER_CAP, so
        // even a "1" here keeps the test fast while exercising the
        // honor-Retry-After branch (the .max() picks the larger of the two).
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(
                ResponseTemplate::new(403)
                    .insert_header("Retry-After", "0")
                    .set_body_string("You have exceeded a secondary rate limit"),
            )
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 9,
                "name": "Limited_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/Limited_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let asset = upload_release_asset(
            &client,
            &upload_url_template,
            "Limited_v1.0.0.zip",
            None,
            b"bytes",
        )
        .await
        .expect("a 403 rate-limit then 201 must succeed after one retry");
        assert_eq!(asset.id, 9);
    }

    #[tokio::test]
    async fn upload_release_asset_cancel_interrupts_retry_backoff() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use std::time::{Duration, Instant};

        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"bytes").unwrap();

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "CancelMe_v1.0.0.zip"))
            .respond_with(
                ResponseTemplate::new(500)
                    .insert_header("Retry-After", "30")
                    .set_body_string("temporary outage"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_task_flag = Arc::clone(&cancel_flag);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            cancel_task_flag.store(true, Ordering::SeqCst);
        });
        let cancel_check_flag = Arc::clone(&cancel_flag);
        let cancel_check = move || cancel_check_flag.load(Ordering::SeqCst);

        let client = build_client("test-token");
        let started = Instant::now();
        let err = upload_release_asset_file_recovering_with_cancel(
            &client,
            "octo",
            "sts2mm-profiles",
            &upload_url_template,
            "CancelMe_v1.0.0.zip",
            None,
            tmp.path(),
            Some(&cancel_check),
        )
        .await
        .expect_err("cancel should interrupt retry backoff");

        assert!(
            err.to_string().contains("Sharing canceled"),
            "unexpected error: {}",
            err
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancel should not wait out Retry-After backoff"
        );
    }

    #[tokio::test]
    async fn upload_release_asset_does_not_retry_on_401() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // A 401 is a permanent auth failure — it must fail on the FIRST
        // attempt with no retry. expect(1) proves exactly one POST went out.
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(401).set_body_string("Bad credentials"))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let err = upload_release_asset(
            &client,
            &upload_url_template,
            "Unauthed_v1.0.0.zip",
            None,
            b"bytes",
        )
        .await
        .expect_err("a 401 must not be retried");
        assert!(
            err.to_string().contains("401"),
            "error should surface the 401 status, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn upload_release_asset_gives_up_after_max_attempts_on_persistent_500() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // Every attempt 500s. The loop makes exactly RETRY_MAX_ATTEMPTS (3)
        // POSTs and then surfaces a transient-exhausted error.
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(503).set_body_string("still down"))
            .expect(3)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let err = upload_release_asset(
            &client,
            &upload_url_template,
            "Doomed_v1.0.0.zip",
            None,
            b"bytes",
        )
        .await
        .expect_err("a persistent 5xx must eventually fail");
        assert!(
            err.to_string().contains("after 3 attempts"),
            "error should mention attempt exhaustion, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn upload_release_asset_recovering_still_recovers_422_already_exists() {
        // The 422 already_exists recovery path must keep working unchanged:
        // a 422 is permanent (no retry), the recovering wrapper refetches the
        // listing, DELETEs the conflicting asset, and re-POSTs.
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // First POST → 422 already_exists (permanent; recovering wrapper
        // takes over). expect(1) proves the 422 itself was NOT retried.
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "Dup_v1.0.0.zip"))
            .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
                "message": "Validation Failed",
                "errors": [{"code": "already_exists"}]
            })))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;

        // Recovery refetches the release listing to find the conflicting asset.
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": "Dup_v1.0.0.zip",
                    "browser_download_url": "https://example/dup"
                }])),
            )
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        // Re-POST after the DELETE → 201.
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "Dup_v1.0.0.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 777,
                "name": "Dup_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/Dup_v1.0.0.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let asset = upload_release_asset_recovering(
            &client,
            "octo",
            "sts2mm-profiles",
            &upload_url_template,
            "Dup_v1.0.0.zip",
            None,
            b"bytes",
        )
        .await
        .expect("422 already_exists recovery must still succeed");
        assert_eq!(asset.id, 777);
    }

    #[tokio::test]
    async fn upload_release_asset_recovering_matches_github_renamed_unicode_asset() {
        let (server, _env_guard) = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );
        let requested = "皮皮配置__ModConfig_v0.2.3_5a8e5d70.zip";
        let github_name = "ModConfig_v0.2.3_5a8e5d70.zip";

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", requested))
            .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
                "message": "Validation Failed",
                "errors": [{"code": "already_exists"}]
            })))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": 555,
                    "name": github_name,
                    "browser_download_url": "https://example/renamed"
                }])),
            )
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", requested))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 777,
                "name": requested,
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/renamed.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let asset = upload_release_asset_recovering(
            &client,
            "octo",
            "sts2mm-profiles",
            &upload_url_template,
            requested,
            Some("皮皮配置: ModConfig v0.2.3"),
            b"bytes",
        )
        .await
        .expect("renamed GitHub asset should be deleted and reuploaded");

        assert_eq!(asset.id, 777);
    }
}

#[cfg(test)]
mod download_bundle_url_routing_tests {
    use super::*;
    use std::io::Write;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_tiny_zip(inner_name: &str) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(buf);
        zw.start_file(inner_name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"hello").unwrap();
        zw.finish().unwrap().into_inner()
    }

    #[test]
    fn bundle_url_allowlist_accepts_github_hosts_only() {
        // Allowed: https on GitHub's asset hosts.
        assert!(bundle_url_is_allowed(
            "https://github.com/o/r/releases/download/t/a.zip"
        ));
        assert!(bundle_url_is_allowed(
            "https://raw.githubusercontent.com/o/r/main/mods/a.zip"
        ));
        assert!(bundle_url_is_allowed(
            "https://objects.githubusercontent.com/github-production-release-asset/x"
        ));

        // Rejected: SSRF / scheme / host-confusion vectors.
        assert!(
            !bundle_url_is_allowed("http://github.com/o/r/releases/download/t/a.zip"),
            "http must be rejected"
        );
        assert!(
            !bundle_url_is_allowed("http://169.254.169.254/latest/meta-data/"),
            "link-local address must be rejected"
        );
        assert!(
            !bundle_url_is_allowed("http://127.0.0.1:8080/x.zip"),
            "loopback must be rejected"
        );
        assert!(
            !bundle_url_is_allowed("https://evil.com/x.zip"),
            "arbitrary host must be rejected"
        );
        assert!(
            !bundle_url_is_allowed("https://evil.com/?x=raw.githubusercontent.com"),
            "substring of an allowed host in the query must not pass (M-2)"
        );
        assert!(
            !bundle_url_is_allowed("https://raw.githubusercontent.com.evil.com/x.zip"),
            "host suffix attack must not pass"
        );
        assert!(
            !bundle_url_is_allowed("file:///etc/passwd"),
            "file scheme must be rejected"
        );
        assert!(
            !bundle_url_is_allowed("not a url"),
            "garbage must be rejected"
        );
    }

    #[tokio::test]
    async fn download_bundle_handles_raw_githubusercontent_url() {
        // Sets STS2_GITHUB_API_BASE — share the env-var lock with the other suites.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        let zip_bytes = make_tiny_zip("OldMod.json");
        Mock::given(method("GET"))
            .and(path(
                "/repos/owner/sts2mm-profiles/contents/mods/OldMod_v1.zip",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://raw.githubusercontent.com/owner/sts2mm-profiles/main/mods/OldMod_v1.zip",
            "OldMod",
            tmp.path(),
            None,
        )
        .await
        .expect("legacy URL must still work");

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
            .and(path(
                "/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://github.com/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip",
            "NewMod",
            tmp.path(),
            None,
        )
        .await
        .expect("release URL must work");

        assert!(tmp.path().join("NewMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_retries_release_asset_500_then_succeeds() {
        // Sets STS2_GITHUB_RELEASES_BASE — process-global env var, same lock.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        Mock::given(method("GET"))
            .and(path(
                "/owner/sts2mm-profiles/releases/download/bundles/RetryMod_v1.zip",
            ))
            .respond_with(ResponseTemplate::new(503).set_body_string("try again"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/owner/sts2mm-profiles/releases/download/bundles/RetryMod_v1.zip",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(make_tiny_zip("RetryMod.json")))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://github.com/owner/sts2mm-profiles/releases/download/bundles/RetryMod_v1.zip",
            "RetryMod",
            tmp.path(),
            None,
        )
        .await
        .expect("transient release-asset failure should be retried");

        assert!(tmp.path().join("RetryMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_rejects_non_github_url() {
        // An external (non-GitHub, non-loopback) host must be refused before any
        // fetch — the bundle URL is attacker-controlled. (Audit H-1.) Loopback
        // is allowed under cfg!(test) for the flow tests, so use a public host
        // here to exercise the production rejection path.
        let tmp = tempfile::tempdir().unwrap();
        let res = download_bundle(
            "https://evil.example.com/some/path/ExternalMod.zip",
            "ExternalMod",
            tmp.path(),
            None,
        )
        .await;

        assert!(
            res.is_err(),
            "a non-GitHub bundle URL must be rejected even when reachable"
        );
        assert!(
            !tmp.path().join("ExternalMod.json").exists(),
            "nothing should be written for a rejected URL"
        );
    }

    #[tokio::test]
    async fn download_bundle_rejects_sha256_mismatch() {
        // Fix M-1: a wrong expected_sha256 must cause an error before extraction.
        let _env_guard = super::release_upload_tests::ENV_LOCK.lock().await;
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        let zip_bytes = make_tiny_zip("MismatchMod.json");
        Mock::given(method("GET"))
            .and(path(
                "/owner/sts2mm-profiles/releases/download/bundles/MismatchMod_v1.zip",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let res = download_bundle(
            "https://github.com/owner/sts2mm-profiles/releases/download/bundles/MismatchMod_v1.zip",
            "MismatchMod",
            tmp.path(),
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        )
        .await;

        assert!(res.is_err(), "a SHA256 mismatch must be rejected");
        let err_msg = res.unwrap_err().to_string();
        assert!(
            err_msg.contains("SHA256 mismatch"),
            "error message must mention SHA256 mismatch, got: {}",
            err_msg
        );
        assert!(
            !tmp.path().join("MismatchMod.json").exists(),
            "nothing should be extracted when the hash mismatches"
        );
    }
}

#[cfg(test)]
mod github_api_stress_tests {
    use super::*;
    use crate::profiles::ProfileMod;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    const STRESS_SIZE_PLAN_MIB: [u64; 40] = [
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 8, 8, 8, 8, 16, 16, 16, 32, 32,
        48, 64, 80, 96, 128, 160, 192, 224, 256, 288, 300,
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

        let token =
            match std::env::var("STS2_GITHUB_TOKEN").or_else(|_| std::env::var("GITHUB_TOKEN")) {
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
        ensure_profiles_repo(&token, &username, &repo)
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
        let result = run_stress_share_and_verify(
            profile,
            &mods_path,
            &disabled_path,
            &profiles_path,
            &token,
            &username,
            &repo,
            &client,
        )
        .await;

        let cleanup =
            cleanup_stress_artifacts(&client, &username, &repo, &asset_prefix, None).await;
        if let Err(e) = cleanup {
            eprintln!("Stress cleanup warning: {}", e);
        }

        result
            .expect("GitHub API stress test must upload, fetch, download, and verify all bundles");
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
    ) -> Result<()> {
        let result = super::super::share_profile_impl(
            profile,
            mods_path,
            disabled_path,
            profiles_path,
            token,
            None,
            None,
            Vec::new(),
        )
        .await?;

        let verify_result: Result<()> = async {
            let fetched =
                fetch_shared_profile(username, &result.file_path, Some(token), repo).await?;
            if fetched.mods.len() != STRESS_SIZE_PLAN_MIB.len() {
                return Err(AppError::Other(format!(
                    "Fetched profile had {} mods, expected {}",
                    fetched.mods.len(),
                    STRESS_SIZE_PLAN_MIB.len()
                )));
            }

            // Asset names are content-addressed (`<mod>_v<ver>_<sha8>.zip`)
            // so we can't predict them ahead of time. Verify via each
            // mod's bundle_url instead — the manifest is the source of
            // truth for which asset URL the manager will actually fetch.
            let release = ensure_bundles_release(client, username, repo).await?;
            for pm in fetched.mods.iter() {
                let Some(expected_hash) = pm.bundle_sha256.as_deref() else {
                    return Err(AppError::Other(format!(
                        "{} missing bundle_sha256",
                        pm.name
                    )));
                };
                let Some(bundle_url) = pm.bundle_url.as_deref() else {
                    return Err(AppError::Other(format!("{} missing bundle_url", pm.name)));
                };
                let asset = release
                    .assets
                    .iter()
                    .find(|asset| asset.browser_download_url == bundle_url)
                    .ok_or_else(|| {
                        AppError::Other(format!(
                            "Manifest URL {} not present on release",
                            bundle_url
                        ))
                    })?;
                let bytes =
                    download_release_asset_via_api(client, username, repo, asset.id).await?;
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

        if let Err(e) =
            delete_contents_file_if_exists(client, username, repo, &result.file_path).await
        {
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
                files: vec![
                    format!("{}/{}", folder, manifest_name),
                    format!("{}/{}", folder, dll_name),
                ],
                folder_name: Some(folder.clone()),
                mod_id: Some(folder),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
            });
        }

        Ok(Profile {
            id: crate::profiles::new_profile_id(),
            name: profile_name.to_string(),
            game_version: Some("0.105.0".to_string()),
            created_by: Some("stress".to_string()),
            mods,
            created_at: now,
            updated_at: now,
            public: Some(false),
            mod_extras: Default::default(),
        })
    }

    fn write_pseudorandom_file(
        path: &std::path::Path,
        bytes: u64,
        seed: u64,
    ) -> std::io::Result<()> {
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
            github_api_base(),
            owner,
            repo,
            asset_id
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
            for asset in release
                .assets
                .iter()
                .filter(|asset| asset.name.starts_with(asset_prefix))
            {
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
            github_api_base(),
            owner,
            repo,
            filename
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
        let sha = value.get("sha").and_then(|v| v.as_str()).ok_or_else(|| {
            AppError::Other(format!("Cleanup response for {} had no sha", filename))
        })?;
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
        hex::encode(h.finalize())
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
