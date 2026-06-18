use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::{install_mod_from_zip, ModInfo};
use crate::state::AppState;

/// Total request timeout for HTTP clients. Long enough for a large
/// release-asset download on a slow link, short enough that a stalled
/// connection can't pin the download worker forever.
const HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Connect timeout for HTTP clients. A connect that's still pending
/// after 10s is almost certainly a routing/DNS issue, not a slow handshake.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// One initial download try plus two automatic retries for transient
/// network/server failures. Auth/not-found/validation failures still stop
/// immediately because another attempt cannot repair them.
const DOWNLOAD_RETRY_MAX_ATTEMPTS: u32 = 3;
#[cfg(not(test))]
const DOWNLOAD_RETRY_BASE_DELAY: Duration = Duration::from_secs(2);
#[cfg(test)]
const DOWNLOAD_RETRY_BASE_DELAY: Duration = Duration::from_millis(1);

// ── GitHub API Types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub assets: Vec<GitHubAsset>,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    pub content_type: String,
    pub download_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepo {
    pub full_name: String,
    pub name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub stargazers_count: u64,
    pub updated_at: String,
    pub owner: GitHubOwner,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubOwner {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubSearchResponse {
    total_count: u64,
    items: Vec<GitHubRepo>,
}

// ── Core Functions ──────────────────────────────────────────────────────────

fn build_client(token: Option<&str>) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION"))
            .parse()
            .unwrap(),
    );
    if let Some(tok) = token {
        if let Ok(val) = format!("Bearer {}", tok).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    crate::http::https_client_builder()
        .default_headers(headers)
        .timeout(HTTP_TOTAL_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
}

fn download_status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::FORBIDDEN
}

fn download_error_is_transient(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

enum DownloadAttemptError {
    Transient(String),
    Permanent(AppError),
}

async fn download_file_once<F>(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    on_progress: &F,
) -> std::result::Result<(), DownloadAttemptError>
where
    F: Fn(u64, u64),
{
    let resp = client.get(url).send().await.map_err(|e| {
        if download_error_is_transient(&e) {
            DownloadAttemptError::Transient(e.to_string())
        } else {
            DownloadAttemptError::Permanent(e.into())
        }
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(if download_status_is_transient(status) {
            DownloadAttemptError::Transient(format!("HTTP {}", status))
        } else {
            DownloadAttemptError::Permanent(AppError::Other(format!(
                "Download failed with HTTP {}",
                status
            )))
        });
    }
    let total = resp.content_length().unwrap_or(0);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(AppError::from)
            .map_err(DownloadAttemptError::Permanent)?;
    }

    let mut file = std::fs::File::create(dest)
        .map_err(AppError::from)
        .map_err(DownloadAttemptError::Permanent)?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            if download_error_is_transient(&e) {
                DownloadAttemptError::Transient(e.to_string())
            } else {
                DownloadAttemptError::Permanent(e.into())
            }
        })?;
        file.write_all(&chunk)
            .map_err(AppError::from)
            .map_err(DownloadAttemptError::Permanent)?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total);
    }

    file.flush()
        .map_err(AppError::from)
        .map_err(DownloadAttemptError::Permanent)?;
    Ok(())
}

/// Fetch the latest release from a GitHub repository.
pub async fn fetch_latest_release(
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<GitHubRelease> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let release: GitHubRelease = serde_json::from_slice(&bytes)?;
        return Ok(release);
    }
    let client = build_client(token);
    log::debug!(
        "GitHub API: fetch latest release {}/{} (token={})",
        owner,
        repo,
        token.is_some()
    );
    let resp = client.get(&url).send().await.map_err(|e| {
        log::warn!(
            "GitHub fetch_latest_release request failed for {}/{}: {}",
            owner,
            repo,
            e
        );
        e
    })?;
    let resp = resp.error_for_status().map_err(|e| {
        log::warn!(
            "GitHub fetch_latest_release HTTP error for {}/{}: {}",
            owner,
            repo,
            e
        );
        e
    })?;
    let release: GitHubRelease = resp.json().await?;
    log::debug!(
        "GitHub API: {}/{} latest = {} ({} assets)",
        owner,
        repo,
        release.tag_name,
        release.assets.len()
    );
    Ok(release)
}

/// Fetch multiple releases from a GitHub repository (paginated).
/// Returns up to `per_page` releases from the given page.
pub async fn fetch_releases(
    owner: &str,
    repo: &str,
    page: u32,
    per_page: u32,
    token: Option<&str>,
) -> Result<Vec<GitHubRelease>> {
    let url = format!("https://api.github.com/repos/{}/{}/releases", owner, repo);
    // Cassette layer strips query params, so paginated calls all resolve
    // to the same on-disk file. The harness only ever needs page 1.
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let releases: Vec<GitHubRelease> = serde_json::from_slice(&bytes)?;
        return Ok(releases);
    }
    let client = build_client(token);
    let resp = client
        .get(&url)
        .query(&[
            ("page", page.to_string()),
            ("per_page", per_page.to_string()),
        ])
        .send()
        .await?
        .error_for_status()?;
    let releases: Vec<GitHubRelease> = resp.json().await?;
    Ok(releases)
}

/// Fetch a specific tagged release.
pub async fn fetch_release_by_tag(
    owner: &str,
    repo: &str,
    tag: &str,
    token: Option<&str>,
) -> Result<GitHubRelease> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/tags/{}",
        owner, repo, tag
    );
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let release: GitHubRelease = serde_json::from_slice(&bytes)?;
        return Ok(release);
    }
    let client = build_client(token);
    let resp = client.get(&url).send().await?.error_for_status()?;
    let release: GitHubRelease = resp.json().await?;
    Ok(release)
}

/// Returns true iff the repo's metadata explicitly references STS2.
///
/// We require a strong signal — "sts2", "slay-the-spire-2", "slay the spire 2",
/// or "slay the spire ii" — somewhere in name / full_name / description / topics.
/// A repo that only says "slay the spire" (no 2) is for the first game and
/// must be rejected. Without this filter the search picks up StS-1 mods that
/// happen to match part of the user's query, which is the bug report.
fn repo_mentions_sts2(repo: &GitHubRepo) -> bool {
    let mut haystack = String::with_capacity(256);
    haystack.push_str(&repo.full_name);
    haystack.push(' ');
    haystack.push_str(&repo.name);
    haystack.push(' ');
    if let Some(desc) = &repo.description {
        haystack.push_str(desc);
        haystack.push(' ');
    }
    for t in &repo.topics {
        haystack.push_str(t);
        haystack.push(' ');
    }
    haystack.make_ascii_lowercase();

    // Normalize separators so "slay-the-spire-2" and "slay the spire 2" and
    // "slaythespire2" all look the same to the matcher.
    let collapsed: String = haystack
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '.' | '/' | '\\'))
        .collect();

    const SIGNALS: [&str; 3] = ["sts2", "slaythespire2", "slaythespireii"];
    SIGNALS.iter().any(|s| collapsed.contains(s))
}

async fn fetch_one_search(client: &reqwest::Client, q: &str) -> Result<Vec<GitHubRepo>> {
    let resp = client
        .get("https://api.github.com/search/repositories")
        .query(&[("q", q), ("per_page", "100")])
        .send()
        .await?
        .error_for_status()?;
    let search: GitHubSearchResponse = resp.json().await?;
    Ok(search.items)
}

// ── Rate-limit resilience ────────────────────────────────────────────────────

/// Parsed rate-limit info extracted from GitHub response headers.
/// Used to decide how long to pause (or whether to abort) before the next
/// search call in `auto_detect_sources`.
#[derive(Debug, Clone)]
pub struct RateLimitInfo {
    /// Remaining requests in the current window (X-RateLimit-Remaining).
    pub remaining: u32,
    /// Unix timestamp when the window resets (X-RateLimit-Reset).
    /// Also used as the reset time when a 429/403 carries Retry-After.
    pub reset_at: i64,
}

impl RateLimitInfo {
    /// How many seconds until the rate-limit window resets.
    /// Returns 0 if the window has already passed.
    pub fn secs_until_reset(&self) -> i64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        (self.reset_at - now).max(0)
    }
}

/// Outcome of a single search call that distinguishes rate-limiting from
/// other errors so callers can adapt pacing instead of silently dropping results.
#[derive(Debug)]
pub enum SearchOutcome {
    /// Search succeeded — here are the repos.
    Ok(Vec<GitHubRepo>),
    /// GitHub returned 403 or 429 with rate-limit headers; search quota
    /// is exhausted. The `reset_at` is a Unix timestamp the caller can
    /// wait until (or surface to the user).
    RateLimited(RateLimitInfo),
    /// Any other error (network, DNS, parse, etc.).
    Err(crate::error::AppError),
}

/// Extract `X-RateLimit-Remaining` and `X-RateLimit-Reset` from response headers.
/// Returns `None` when the headers are absent (non-search endpoint, local server, etc.)
pub fn parse_rate_limit_headers(headers: &reqwest::header::HeaderMap) -> Option<RateLimitInfo> {
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u32>().ok())?;
    let reset_at = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())?;
    Some(RateLimitInfo {
        remaining,
        reset_at,
    })
}

/// Infer a `reset_at` timestamp from a `Retry-After` header (seconds delta)
/// when the standard `X-RateLimit-Reset` header is absent.
fn retry_after_reset_at(headers: &reqwest::header::HeaderMap) -> Option<i64> {
    let delta = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    Some(now + delta)
}

/// `true` when `remaining` is low enough that we should slow down.
/// Threshold: ≤ 3 remaining (generous enough to not stall on the last
/// few calls before a healthy window restores).
pub fn quota_is_low(info: &RateLimitInfo) -> bool {
    info.remaining <= 3
}

/// Search GitHub repositories sorted by best-match relevance.
/// Returns a `SearchOutcome` so the caller can distinguish rate-limiting
/// from other errors instead of silently treating throttled calls as
/// "no candidates."
///
/// Design: reads `X-RateLimit-*` and `Retry-After` headers so the caller
/// can adaptively pace the next call rather than burning through quota
/// with a fixed delay.
pub async fn search_github_repos_relevance_outcome(
    query: &str,
    token: Option<&str>,
) -> SearchOutcome {
    let client = build_client(token);
    let url = "https://api.github.com/search/repositories";

    let req = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.github.mercy-preview+json",
        )
        .query(&[("q", query), ("per_page", "30")]);

    log::debug!("Auto-detect search: GET {}?q={}&per_page=30", url, query);

    let raw_resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return SearchOutcome::Err(e.into()),
    };

    let status = raw_resp.status();
    let headers = raw_resp.headers().clone();

    // 403/429 → treat as rate-limited regardless of body content.
    // GitHub may return 403 for burst violations in addition to the
    // primary-rate-limit 429. Both carry X-RateLimit-Reset or Retry-After.
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        let info = parse_rate_limit_headers(&headers).unwrap_or_else(|| {
            let reset_at = retry_after_reset_at(&headers).unwrap_or_else(|| {
                // Fallback: assume the window resets in 60 s.
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                now + 60
            });
            RateLimitInfo {
                remaining: 0,
                reset_at,
            }
        });
        log::warn!(
            "Auto-detect: rate-limited (HTTP {}) for query '{}'; reset_at={} ({}s away)",
            status,
            query,
            info.reset_at,
            info.secs_until_reset()
        );
        return SearchOutcome::RateLimited(info);
    }

    // For other non-2xx statuses, propagate as an error.
    let resp = match raw_resp.error_for_status() {
        Ok(r) => r,
        Err(e) => return SearchOutcome::Err(e.into()),
    };

    // On a successful 2xx response, check remaining quota from headers so
    // the caller can slow down proactively before the next call.
    let maybe_rl = parse_rate_limit_headers(&headers);
    if let Some(ref rl) = maybe_rl {
        log::debug!(
            "Auto-detect: quota remaining={} reset_at={} (query: {})",
            rl.remaining,
            rl.reset_at,
            query
        );
    }

    match resp.json::<GitHubSearchResponse>().await {
        Ok(search) => SearchOutcome::Ok(search.items),
        Err(e) => SearchOutcome::Err(e.into()),
    }
}

/// Search GitHub for STS2 mod repositories.
///
/// Strategy: THREE parallel API calls, merged + STS2-filtered.
///
/// Empirically tested against the live GitHub API on 2026-05-09 with the
/// query "path" — these are the queries that actually return
/// `jadistanbelly/autopath-sts2`:
///
/// 1. `<query> sts2` — implicit AND. Matches any repo where both the
///    user's term AND the literal "sts2" token appear. Most STS2 mods
///    have "sts2" somewhere in name / description / readme.
/// 2. `<query> topic:slay-the-spire-2` — repos topic-tagged for STS2.
/// 3. `<query> topic:sts2` — same idea, alt topic. (autopath-sts2 has
///    NO topics, so falls back to query 1; other mods are tagged.)
///
/// Earlier attempts using `<query> slay-the-spire-2 OR sts2 OR "slay the
/// spire 2"` returned 304k results sorted by best-match against `path`
/// alone — none STS2-related — because GitHub's OR operator made the
/// STS2 qualifier optional. The OR-joined `topic:` version returned 0
/// because GitHub's parser doesn't handle that combination cleanly.
/// Sticking to implicit-AND queries keeps results predictable.
pub async fn search_github_repos(query: &str, token: Option<&str>) -> Result<Vec<GitHubRepo>> {
    let client = build_client(token);
    let q1 = format!("{} sts2", query);
    let q2 = format!("{} topic:slay-the-spire-2", query);
    let q3 = format!("{} topic:sts2", query);

    let (a, b, c) = futures_util::future::join3(
        fetch_one_search(&client, &q1),
        fetch_one_search(&client, &q2),
        fetch_one_search(&client, &q3),
    )
    .await;

    let mut merged: Vec<GitHubRepo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push_unique = |list: Vec<GitHubRepo>| {
        for repo in list {
            if seen.insert(repo.full_name.clone()) {
                merged.push(repo);
            }
        }
    };
    match a {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!("search_github_repos query (sts2 AND) failed: {}", e),
    }
    match b {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!(
            "search_github_repos query (topic:slay-the-spire-2) failed: {}",
            e
        ),
    }
    match c {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!("search_github_repos query (topic:sts2) failed: {}", e),
    }

    let total = merged.len();
    let filtered: Vec<GitHubRepo> = merged.into_iter().filter(repo_mentions_sts2).collect();
    log::debug!(
        "search_github_repos: kept {}/{} repos after STS2 relevance filter (query: {})",
        filtered.len(),
        total,
        query
    );
    Ok(filtered)
}

/// Search GitHub repositories sorted by best-match relevance (no STS2 qualifier appended).
/// Used by auto-detect so the most semantically relevant repo wins, not the most recently
/// updated one. Includes the mercy-preview Accept header so `topics` is reliably populated.
///
/// This is the legacy `Result`-returning wrapper kept for callers outside
/// the auto-detect loop. The auto-detect path uses
/// `search_github_repos_relevance_outcome` to distinguish rate-limiting.
pub async fn search_github_repos_relevance(
    query: &str,
    token: Option<&str>,
) -> Result<Vec<GitHubRepo>> {
    match search_github_repos_relevance_outcome(query, token).await {
        SearchOutcome::Ok(repos) => Ok(repos),
        SearchOutcome::RateLimited(info) => Err(crate::error::AppError::Other(format!(
            "GitHub search rate-limited; reset in {}s",
            info.secs_until_reset()
        ))),
        SearchOutcome::Err(e) => Err(e),
    }
}

/// Download a file from a URL to a destination path with progress callback.
pub async fn download_file<F>(url: &str, dest: &Path, on_progress: F) -> Result<()>
where
    F: Fn(u64, u64),
{
    // Cassette playback: zip assets and other binary downloads can be
    // served from disk so the walk-back peek (peek_zip_min_game_version)
    // gets the deterministic bytes a test wrote. The fixture path mirrors
    // the URL — e.g. an asset hosted at github-releases.githubusercontent.
    // com is routed via the GitHub bucket if mapped, or simply ignored
    // here so the call falls through to the wire when there's no fixture.
    if let Some(bytes) = crate::qa_cassette::intercept_get(url) {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let total = bytes.len() as u64;
        std::fs::write(dest, &bytes)?;
        on_progress(total, total);
        return Ok(());
    }
    let client = crate::http::https_client_builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .timeout(HTTP_TOTAL_TIMEOUT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default();

    let mut attempt = 0;
    loop {
        attempt += 1;
        match download_file_once(&client, url, dest, &on_progress).await {
            Ok(()) => return Ok(()),
            Err(DownloadAttemptError::Permanent(e)) => return Err(e),
            Err(DownloadAttemptError::Transient(reason)) => {
                if attempt >= DOWNLOAD_RETRY_MAX_ATTEMPTS {
                    let _ = std::fs::remove_file(dest);
                    return Err(AppError::Other(format!(
                        "Download failed after {} attempts: {}",
                        DOWNLOAD_RETRY_MAX_ATTEMPTS, reason
                    )));
                }
                log::warn!(
                    "Transient download failure for '{}' (attempt {}/{}): {}",
                    url,
                    attempt,
                    DOWNLOAD_RETRY_MAX_ATTEMPTS,
                    reason
                );
                let _ = std::fs::remove_file(dest);
                let backoff = DOWNLOAD_RETRY_BASE_DELAY.saturating_mul(1u32 << (attempt - 1));
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

/// Sanitize an arbitrary string into a path-safe slug. Used to scope
/// cached release zips by owner/repo/tag without colliding on disk.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Download a specific tagged release's primary zip asset into a cache
/// path scoped by owner/repo/tag. When `game_version` is known, releases
/// with per-game compatibility assets (for example RitsuLib's
/// `Compat.0.103.2...github.zip`) choose the best asset for that game
/// build instead of blindly taking the first zip.
///
/// Returns the cached path. Used by the Repair walk-back (which downloads
/// multiple candidate releases and
/// peeks their manifests to find a compatible one) — keeping each
/// candidate at a distinct path means parallel walk-backs of the same
/// repo don't clobber each other and the cache survives across runs.
///
/// Skips the actual HTTP download if a non-empty cached file already
/// exists for the same tag — useful for repeat repair attempts.
pub async fn download_release_zip_to_cache(
    owner: &str,
    repo: &str,
    tag: &str,
    cache_path: &Path,
    game_version: Option<&str>,
    token: Option<&str>,
) -> Result<PathBuf> {
    let release = fetch_release_by_tag(owner, repo, tag, token).await?;
    let asset = find_best_asset_for_game_version(&release, game_version).ok_or_else(|| {
        AppError::Other(format!(
            "Release {} for {}/{} has no downloadable asset",
            tag, owner, repo
        ))
    })?;

    if !asset.name.to_ascii_lowercase().ends_with(".zip") {
        return Err(AppError::Other(format!(
            "Release {} for {}/{} is not a zip ({}) — walk-back can only inspect zip releases",
            tag, owner, repo, asset.name
        )));
    }

    let dir =
        cache_path
            .join("repair-walkback")
            .join(format!("{}__{}", slugify(owner), slugify(repo)));
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("{}__{}", slugify(tag), asset.name));

    // Reuse the cached zip if it's already there and non-empty.
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.is_file() && meta.len() > 0 {
            log::debug!("Walk-back: reusing cached {}", dest.display());
            return Ok(dest);
        }
    }

    download_file(&asset.browser_download_url, &dest, |_, _| {})
        .await
        .map_err(|e| {
            log::error!(
                "Walk-back: download failed for {}/{}@{} asset '{}': {}",
                owner,
                repo,
                tag,
                asset.name,
                e
            );
            e
        })?;
    log::debug!(
        "Walk-back: downloaded {}/{}@{} -> {}",
        owner,
        repo,
        tag,
        dest.display()
    );
    Ok(dest)
}

/// Open a downloaded mod zip and read the `min_game_version` field from
/// whichever JSON manifest it contains (top-level `mod_manifest.json` or
/// the first `*.json` we find that has a `min_game_version` key). Used
/// by the Repair walk-back to pre-screen each candidate release before
/// committing to install it.
///
/// Returns:
///   - `Ok(Some("0.105.0"))` — manifest declares a minimum
///   - `Ok(None)` — manifest exists but doesn't declare one (mod runs on
///     any build)
///   - `Err(...)` — couldn't open the zip or no manifest at all
pub fn peek_zip_min_game_version(zip_path: &Path) -> Result<Option<String>> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Open zip {}: {}", zip_path.display(), e)))?;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if !name.to_lowercase().ends_with(".json") {
            continue;
        }
        if name.starts_with("__MACOSX") || name.starts_with("._") {
            continue;
        }
        // Mod manifests live at root or one folder deep — skip anything
        // buried inside a deep subdirectory.
        if name.split('/').count() > 2 {
            continue;
        }

        let mut buf = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut buf).is_err() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(crate::mods::strip_utf8_bom(&buf)) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Try both case variants the ecosystem uses.
        let mgv = val
            .get("min_game_version")
            .or_else(|| val.get("MinGameVersion"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_start_matches('v').to_string())
            .filter(|s| !s.is_empty());
        return Ok(mgv);
    }
    Err(AppError::Other(format!(
        "No JSON manifest found inside {}",
        zip_path.display()
    )))
}

/// Install a GitHub mod, picking the latest release that's actually
/// compatible with the user's game version. If `user_game_version` is
/// None we don't have anything to compare against — install latest
/// (legacy behavior).
///
/// Used by every "first install from GitHub" entry point — Browse →
/// Install, Add by URL with a github.com URL, the friend-pack apply
/// flow. Repair has its own caller because it also handles the
/// pre-existing on-disk install (defensive folder sweep).
///
/// Returns (info, chosen_tag, walked_back) so the frontend can toast a
/// version-aware message ("Installed AutoPath v1.3.0 — latest compatible
/// for your game v0.103.2") instead of just "Installed".
pub async fn install_compatible_github_mod(
    owner: &str,
    repo: &str,
    mods_path: &Path,
    cache_path: &Path,
    user_game_version: Option<&str>,
    token: Option<&str>,
) -> Result<(crate::mods::ModInfo, String, bool)> {
    if user_game_version.is_none() {
        // No way to compare — fall through to legacy "install latest" path.
        let info = download_and_install_github_mod(owner, repo, None, mods_path, cache_path, token)
            .await?;
        return Ok((info, String::new(), false));
    }

    let chosen =
        crate::updater::pick_compatible_release(owner, repo, user_game_version, cache_path, token)
            .await?;

    // Determine if this was actually a walk-back (i.e. we picked something
    // older than latest) so the caller can toast about it. Cheap second
    // call to fetch_latest_release — already cached server-side via the
    // GitHub API's CDN.
    let walked_back = match fetch_latest_release(owner, repo, token).await {
        Ok(latest) => latest.tag_name != chosen.tag,
        Err(_) => false,
    };

    let info = crate::mods::install_mod_from_zip(&chosen.zip_path, mods_path)
        .map_err(|e| AppError::Other(format!("install_mod_from_zip failed: {}", e)))?;

    if walked_back {
        log::info!(
            "install_compatible_github_mod: picked {}/{}@{} for game v{} (skipped newer release with min_game_version={})",
            owner,
            repo,
            chosen.tag,
            user_game_version.unwrap_or("?"),
            chosen.min_game_version.as_deref().unwrap_or("?"),
        );
    }
    Ok((info, chosen.tag, walked_back))
}

/// Find the best asset to download from a release.
///
/// Most STS2 mods publish exactly one `.zip`, but RitsuLib-style releases
/// publish several variants in one tag:
///
/// - `*.variant-pack.zip` — a bundle of variants, not the install target.
/// - `*.github.zip` — the default/latest-game asset.
/// - `*.Compat.<game-version>.*.github.zip` — install target for a specific
///   STS2 build line.
///
/// If we know the user's game version, prefer the newest compatible
/// `Compat.X.Y.Z` asset. Otherwise prefer the normal GitHub zip and avoid
/// variant packs.
fn find_best_asset_for_game_version<'a>(
    release: &'a GitHubRelease,
    game_version: Option<&str>,
) -> Option<&'a GitHubAsset> {
    let archive_assets: Vec<&GitHubAsset> = release
        .assets
        .iter()
        .filter(|a| is_supported_archive_asset(&a.name))
        .collect();
    let zip_assets: Vec<&GitHubAsset> = archive_assets
        .iter()
        .copied()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".zip"))
        .collect();
    let single_file_assets: Vec<&GitHubAsset> = release
        .assets
        .iter()
        .filter(|a| is_single_file_mod_asset(&a.name))
        .collect();

    if let Some(current) = game_version.and_then(parse_asset_version) {
        let compat_assets: Vec<(&GitHubAsset, semver::Version)> = zip_assets
            .iter()
            .filter_map(|asset| {
                let required = compat_version_from_asset_name(&asset.name)
                    .and_then(|v| parse_asset_version(&v))?;
                Some((*asset, required))
            })
            .collect();

        if let Some(asset) = compat_assets
            .iter()
            .filter(|(_, required)| &current >= required)
            .max_by(|(_, a), (_, b)| a.cmp(b))
            .map(|(asset, _)| *asset)
        {
            return Some(asset);
        }

        if let Some(asset) = compat_assets
            .iter()
            .min_by(|(_, a), (_, b)| a.cmp(b))
            .map(|(asset, _)| *asset)
        {
            return Some(asset);
        }
    }

    let normal_github_zip = zip_assets.iter().copied().find(|a| {
        let name = a.name.to_ascii_lowercase();
        name.ends_with(".github.zip")
            && !name.contains(".compat.")
            && !name.contains("variant-pack")
    });
    if normal_github_zip.is_some() {
        return normal_github_zip;
    }

    let non_variant_archive = archive_assets
        .iter()
        .copied()
        .find(|a| !a.name.to_ascii_lowercase().contains("variant-pack"));
    if non_variant_archive.is_some() {
        return non_variant_archive;
    }

    archive_assets
        .first()
        .copied()
        .or_else(|| single_file_assets.first().copied())
        .or_else(|| release.assets.first())
}

fn is_supported_archive_asset(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip") || lower.ends_with(".7z") || lower.ends_with(".rar")
}

fn is_single_file_mod_asset(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".dll") || lower.ends_with(".pck")
}

fn parse_asset_version(version: &str) -> Option<semver::Version> {
    // Lenient on purpose: the game-version side can carry a Steam beta
    // suffix ("0.106.1b"). The old digit-only parse returned None for
    // those, which skipped the whole Compat-asset branch and downloaded
    // the latest-game main file on beta builds (the RitsuLib bug).
    crate::updater::parse_loose_version(version)
}

fn compat_version_from_asset_name(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let marker = ".compat.";
    let idx = lower.find(marker)? + marker.len();
    let rest = &name[idx..];
    let mut parts = rest.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if [major, minor, patch]
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    {
        Some(format!("{}.{}.{}", major, minor, patch))
    } else {
        None
    }
}

/// Download and install a mod from a GitHub release.
pub async fn download_and_install_github_mod(
    owner: &str,
    repo: &str,
    tag: Option<&str>,
    mods_path: &Path,
    cache_path: &Path,
    token: Option<&str>,
) -> Result<ModInfo> {
    log::info!(
        "Downloading GitHub mod {}/{} (tag={}, mods_path={}, cache_path={})",
        owner,
        repo,
        tag.unwrap_or("<latest>"),
        mods_path.display(),
        cache_path.display()
    );
    let release = match tag {
        Some(t) => fetch_release_by_tag(owner, repo, t, token).await?,
        None => fetch_latest_release(owner, repo, token).await?,
    };

    let asset = find_best_asset_for_game_version(&release, None)
        .ok_or_else(|| {
            log::error!(
                "No downloadable assets in release {} for {}/{} (assets: {:?})",
                release.tag_name,
                owner,
                repo,
                release.assets.iter().map(|a| &a.name).collect::<Vec<_>>()
            );
            AppError::Other(format!(
                "No downloadable assets found in release {} for {}/{}",
                release.tag_name, owner, repo
            ))
        })?
        .clone();

    log::info!(
        "Selected asset '{}' for {}/{} v{} ({} bytes)",
        asset.name,
        owner,
        repo,
        release.tag_name,
        asset.size
    );

    // `asset.name` comes from the GitHub release API and is publisher-
    // controlled — a crafted asset name like `..%2F..%2Fevil.dll` (or one
    // containing path separators) would otherwise traverse out of the cache
    // or mods folder when joined below. Sanitize to a single safe segment
    // before any join, matching the URL-download path. (Audit M-8)
    let safe_asset_name = crate::mods::sanitize_path_segment(&asset.name);

    let dest = cache_path.join(&safe_asset_name);

    download_file(&asset.browser_download_url, &dest, |downloaded, total| {
        log::debug!("Downloading {}: {}/{}", asset.name, downloaded, total);
    })
    .await
    .map_err(|e| {
        log::error!(
            "Download failed for {}/{} asset '{}': {}",
            owner,
            repo,
            asset.name,
            e
        );
        e
    })?;

    log::info!("Downloaded '{}' to {}", asset.name, dest.display());

    // Install the downloaded file
    let ext = dest
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "zip" | "7z" | "rar") {
        crate::mods::install_mod_from_archive(&dest, mods_path)
    } else if matches!(ext.as_str(), "dll" | "pck") {
        // Single DLL file - copy directly
        let dest_path = mods_path.join(&safe_asset_name);
        // Defense-in-depth: even after sanitize_path_segment, confirm the
        // join didn't escape the mods folder before writing.
        if !crate::mods::path_is_inside(&dest_path, mods_path) {
            return Err(AppError::Other(format!(
                "Refusing to write outside mods folder: {}",
                dest_path.display()
            )));
        }
        std::fs::copy(&dest, &dest_path)?;
        let mod_name = safe_asset_name
            .trim_end_matches(".dll")
            .trim_end_matches(".DLL")
            .trim_end_matches(".pck")
            .trim_end_matches(".PCK")
            .to_string();
        Ok(ModInfo {
            mod_version_id: None,
            name: mod_name,
            version: release.tag_name.clone(),
            description: release.body.clone().unwrap_or_default(),
            enabled: true,
            files: vec![safe_asset_name.clone()],
            source: Some(format!("github:{}/{}", owner, repo)),
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            github_url: Some(format!("https://github.com/{}/{}", owner, repo)),
            github_auto_detected: false,
            nexus_url: None,
            folder_name: None,
            mod_id: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        })
    } else {
        Err(AppError::Other(format!(
            "Unsupported asset type: {}",
            asset.name
        )))
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Search for STS2 mods on GitHub.
#[tauri::command]
pub async fn search_github_mods(
    query: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<GitHubRepo>, String> {
    let token = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.github_token.clone()
    };
    search_github_repos(&query, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download and install a mod from GitHub, and auto-save the source link.
#[tauri::command]
pub async fn download_github_mod(
    owner: String,
    repo: String,
    tag: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path, token, config_path, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        let config_path = s.config_path.clone();
        let game_version = s.game_version.clone();
        (mods_path, cache_path, token, config_path, game_version)
    };

    // When the caller asked for a specific tag, install that exact tag —
    // they know what they want. When asking for "latest" (tag=None),
    // route through the compatibility-aware installer so we don't land
    // a release the game can't load.
    let mut mod_info = if let Some(t) = tag.as_deref() {
        download_and_install_github_mod(
            &owner,
            &repo,
            Some(t),
            &mods_path,
            &cache_path,
            token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?
    } else {
        let (info, _chosen_tag, _walked_back) = install_compatible_github_mod(
            &owner,
            &repo,
            &mods_path,
            &cache_path,
            game_version.as_deref(),
            token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
        info
    };

    // Fix M-13: snapshot config files after a fresh install so future updates
    // can detect user edits and preserve them.
    crate::mods::snapshot_after_fresh_install(&mod_info, &mods_path, &config_path);

    // Auto-save the GitHub source link so updates work later. Key by
    // folder_name when available so two same-named mods with different
    // GitHub origins each retain their own source link.
    let mut db = crate::mod_sources::load_sources(&config_path);
    let key = mod_info
        .folder_name
        .clone()
        .unwrap_or_else(|| mod_info.name.clone());
    let entry = db.mods.entry(key).or_default();
    entry.github_repo = Some(format!("{}/{}", owner, repo));
    let _ = crate::mod_sources::save_sources(&db, &config_path);

    crate::mod_versions::ensure_mod_info_id(&mut mod_info, &config_path);

    Ok(mod_info)
}

/// Download and install a mod from a direct URL.
#[tauri::command]
pub async fn download_url_mod(
    url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path, config_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        (mods_path, cache_path, config_path)
    };

    // Derive a filename from the URL.
    // The raw last-path-segment is attacker-influenced (the user pastes the
    // URL into Quick Add, or a hostile profile points at one). URL-decoded
    // `..%2F..%2F` would otherwise traverse out of the cache or mods folder
    // when joined below — sanitize to a single safe segment first.
    let raw_file_name = url::Url::parse(&url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|seg| seg.last().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "download.zip".to_string());
    let file_name = crate::mods::sanitize_path_segment(&raw_file_name);

    let dest = cache_path.join(&file_name);

    download_file(&url, &dest, |downloaded, total| {
        log::debug!("Downloading {}: {}/{}", file_name, downloaded, total);
    })
    .await
    .map_err(|e| e.to_string())?;

    if dest.extension().and_then(|e| e.to_str()) == Some("zip") {
        let mut info = install_mod_from_zip(&dest, &mods_path).map_err(|e| e.to_string())?;
        crate::mod_versions::ensure_mod_info_id(&mut info, &config_path);
        Ok(info)
    } else if dest.extension().and_then(|e| e.to_str()) == Some("dll") {
        let dest_path = mods_path.join(&file_name);
        // Defense-in-depth: even after sanitize_path_segment, confirm the
        // join didn't escape the mods folder.
        if !crate::mods::path_is_inside(&dest_path, &mods_path) {
            return Err(format!(
                "Refusing to write outside mods folder: {}",
                dest_path.display()
            ));
        }
        std::fs::copy(&dest, &dest_path).map_err(|e| e.to_string())?;
        let mod_name = file_name.trim_end_matches(".dll").to_string();
        let mut info = ModInfo {
            mod_version_id: None,
            name: mod_name.clone(),
            version: "unknown".to_string(),
            description: String::new(),
            enabled: true,
            files: vec![file_name],
            source: Some(url),
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            folder_name: Some(mod_name),
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        };
        crate::mod_versions::ensure_mod_info_id(&mut info, &config_path);
        Ok(info)
    } else {
        Err(format!("Unsupported file type: {}", file_name))
    }
}

#[cfg(test)]
mod download_retry_tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn download_file_retries_transient_500_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/mod.zip"))
            .respond_with(ResponseTemplate::new(500).set_body_string("not yet"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/mod.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"zip-bytes"))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("mod.zip");
        download_file(&format!("{}/mod.zip", server.uri()), &dest, |_, _| {})
            .await
            .expect("transient 500 should be retried");

        assert_eq!(std::fs::read(&dest).unwrap(), b"zip-bytes");
    }

    #[tokio::test]
    async fn download_file_does_not_retry_permanent_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing.zip"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("missing.zip");
        let err = download_file(&format!("{}/missing.zip", server.uri()), &dest, |_, _| {})
            .await
            .expect_err("permanent 404 should fail without retry");

        assert!(err.to_string().contains("404"));
        assert!(!dest.exists());
    }
}

#[cfg(test)]
mod asset_selection_tests {
    use super::*;
    use std::path::Path;

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("https://example.com/{name}"),
            content_type: "application/zip".to_string(),
            download_count: 0,
        }
    }

    fn release(names: &[&str]) -> GitHubRelease {
        GitHubRelease {
            tag_name: "v0.2.31".to_string(),
            name: None,
            body: None,
            prerelease: false,
            published_at: None,
            assets: names.iter().map(|name| asset(name)).collect(),
            html_url: "https://example.com/release".to_string(),
        }
    }

    fn make_owner() -> GitHubOwner {
        GitHubOwner {
            login: "octocat".to_string(),
            avatar_url: "https://example.invalid/avatar.png".to_string(),
        }
    }

    fn make_repo(
        full_name: &str,
        name: &str,
        description: Option<&str>,
        topics: &[&str],
    ) -> GitHubRepo {
        GitHubRepo {
            full_name: full_name.to_string(),
            name: name.to_string(),
            description: description.map(|s| s.to_string()),
            html_url: format!("https://github.com/{}", full_name),
            stargazers_count: 0,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            owner: make_owner(),
            topics: topics.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// RitsuLib v0.4.17's real asset list (2026-06-10) — the multi-variant
    /// release shape that motivated find_best_asset_for_game_version.
    fn ritsulib_release() -> GitHubRelease {
        release(&[
            "STS2-RitsuLib.0.4.17.variant-pack.zip",
            "STS2.RitsuLib.0.4.17.github.zip",
            "STS2.RitsuLib.0.4.17.nupkg",
            "STS2.RitsuLib.Compat.0.103.2.0.4.17.github.zip",
            "STS2.RitsuLib.Compat.0.103.2.0.4.17.nupkg",
            "STS2.RitsuLib.Compat.0.106.1.0.4.17.github.zip",
            "STS2.RitsuLib.Compat.0.106.1.0.4.17.nupkg",
        ])
    }

    #[test]
    fn ritsulib_known_game_version_picks_matching_compat_asset() {
        let rel = ritsulib_release();
        let asset = find_best_asset_for_game_version(&rel, Some("0.106.1")).unwrap();
        assert_eq!(asset.name, "STS2.RitsuLib.Compat.0.106.1.0.4.17.github.zip");
        let asset = find_best_asset_for_game_version(&rel, Some("0.103.2")).unwrap();
        assert_eq!(asset.name, "STS2.RitsuLib.Compat.0.103.2.0.4.17.github.zip");
        // Between the two compat lines → newest satisfied line wins.
        let asset = find_best_asset_for_game_version(&rel, Some("0.105.0")).unwrap();
        assert_eq!(asset.name, "STS2.RitsuLib.Compat.0.103.2.0.4.17.github.zip");
    }

    #[test]
    fn ritsulib_beta_suffixed_game_version_still_picks_compat_asset() {
        // Solo's bug (2026-06-10): Steam beta builds report suffixed
        // versions. The old strict parse returned None for them, the
        // Compat branch was skipped, and the latest-game main file got
        // installed on a beta build → RitsuLib patch failures at boot.
        let rel = ritsulib_release();
        for beta in ["0.106.1b", "0.106.1-beta.4257", "v0.106.1 beta"] {
            let asset = find_best_asset_for_game_version(&rel, Some(beta)).unwrap();
            assert_eq!(
                asset.name, "STS2.RitsuLib.Compat.0.106.1.0.4.17.github.zip",
                "beta version string {:?} must still select the Compat asset",
                beta
            );
        }
    }

    #[test]
    fn ritsulib_unknown_game_version_prefers_main_github_zip_over_variant_pack() {
        let rel = ritsulib_release();
        let asset = find_best_asset_for_game_version(&rel, None).unwrap();
        assert_eq!(asset.name, "STS2.RitsuLib.0.4.17.github.zip");
    }

    #[test]
    fn slugify_preserves_ascii_alphanumeric_and_allowed_punctuation() {
        let out = slugify("AutoPath-STS2_v1.0");
        assert_eq!(out, "AutoPath-STS2_v1.0");
    }

    #[test]
    fn slugify_replaces_spaces_slashes_and_special_characters() {
        assert_eq!(slugify("foo bar/baz\\qux"), "foo_bar_baz_qux");
        assert_eq!(
            slugify("user@host:path?q=1#frag!"),
            "user_host_path_q_1_frag_"
        );
    }

    #[test]
    fn slugify_replaces_non_ascii_with_underscore() {
        assert_eq!(slugify("café"), "caf_");
    }

    #[test]
    fn slugify_empty_string_returns_empty() {
        assert_eq!(slugify(""), "");
    }

    #[test]
    fn repo_mentions_sts2_detects_supported_signals() {
        assert!(repo_mentions_sts2(&make_repo(
            "foo/autopath-sts2",
            "autopath-sts2",
            None,
            &[]
        )));
        assert!(repo_mentions_sts2(&make_repo(
            "foo/bar",
            "bar",
            Some("A mod for Slay the Spire 2"),
            &[]
        )));
        assert!(repo_mentions_sts2(&make_repo(
            "foo/bar",
            "bar",
            None,
            &["slay-the-spire-2"]
        )));
        assert!(repo_mentions_sts2(&make_repo(
            "foo/bar",
            "bar",
            Some("Slay The Spire II tools"),
            &[]
        )));
        assert!(repo_mentions_sts2(&make_repo(
            "acme/sts2-utility",
            "utility",
            None,
            &[]
        )));
    }

    #[test]
    fn repo_mentions_sts2_rejects_sts1_and_unrelated_repos() {
        assert!(!repo_mentions_sts2(&make_repo(
            "foo/stsmod",
            "stsmod",
            Some("A mod for Slay the Spire"),
            &["slay-the-spire"]
        )));
        assert!(!repo_mentions_sts2(&make_repo(
            "foo/rustlib",
            "rustlib",
            Some("A general-purpose library"),
            &["rust", "library"]
        )));
    }

    #[test]
    fn game_version_asset_selection_prefers_matching_compat_zip() {
        let release = release(&[
            "STS2-RitsuLib.0.2.31.variant-pack.zip",
            "STS2.RitsuLib.0.2.31.github.zip",
            "STS2.RitsuLib.Compat.0.103.2.0.2.31.github.zip",
            "STS2.RitsuLib.Compat.0.104.0.0.2.31.github.zip",
        ]);

        let chosen = find_best_asset_for_game_version(&release, Some("0.103.2"))
            .expect("should choose a zip");

        assert_eq!(
            chosen.name,
            "STS2.RitsuLib.Compat.0.103.2.0.2.31.github.zip"
        );
    }

    #[test]
    fn default_asset_selection_skips_variant_pack_when_normal_github_zip_exists() {
        let release = release(&[
            "STS2-RitsuLib.0.2.31.variant-pack.zip",
            "STS2.RitsuLib.0.2.31.github.zip",
        ]);

        let chosen = find_best_asset_for_game_version(&release, None).expect("should choose a zip");

        assert_eq!(chosen.name, "STS2.RitsuLib.0.2.31.github.zip");
    }

    #[test]
    fn game_version_asset_selection_uses_incompatible_compat_zip_over_plain_for_rejection() {
        let release = release(&[
            "STS2.RitsuLib.0.2.31.github.zip",
            "STS2.RitsuLib.Compat.0.104.0.0.2.31.github.zip",
        ]);

        let chosen = find_best_asset_for_game_version(&release, Some("0.103.2"))
            .expect("should choose a zip");

        assert_eq!(
            chosen.name, "STS2.RitsuLib.Compat.0.104.0.0.2.31.github.zip",
            "when a release has compat-specific assets but none support the user's game, \
             pick the lowest incompatible compat asset rather than the plain latest asset. \
             The walk-back layer can then reject the release from that asset's manifest."
        );
    }

    #[test]
    fn asset_selection_prefers_zip_over_other_extensions() {
        let release = release(&["readme.txt", "AutoPath.dll", "AutoPath-v1.0.0.zip"]);
        let chosen = find_best_asset_for_game_version(&release, None).expect("expected an asset");
        assert_eq!(chosen.name, "AutoPath-v1.0.0.zip");
    }

    #[test]
    fn asset_selection_returns_first_zip_when_multiple_zips() {
        let release = release(&["first.zip", "second.zip"]);
        let chosen = find_best_asset_for_game_version(&release, None).expect("expected an asset");
        assert_eq!(chosen.name, "first.zip");
    }

    #[test]
    fn asset_selection_prefers_single_file_asset_when_no_archive() {
        let release = release(&["readme.txt", "AutoPath.dll"]);
        let chosen = find_best_asset_for_game_version(&release, None).expect("expected an asset");
        assert_eq!(chosen.name, "AutoPath.dll");
    }

    #[test]
    fn asset_selection_prefers_supported_archives_over_readme_when_no_zip() {
        let release = release(&["readme.txt", "HighlightPotionCards.7z", "older.rar"]);
        let chosen = find_best_asset_for_game_version(&release, None).expect("expected an asset");
        assert_eq!(chosen.name, "HighlightPotionCards.7z");
    }

    #[test]
    fn asset_selection_returns_none_for_empty_release() {
        let release = release(&[]);
        assert!(find_best_asset_for_game_version(&release, None).is_none());
    }

    #[test]
    fn peek_zip_min_game_version_reads_manifest_field() {
        let path = Path::new("tests/fixtures/min_game_version.zip");
        let out = peek_zip_min_game_version(path)
            .expect("peek_zip_min_game_version should succeed on fixture zip");
        assert_eq!(out.as_deref(), Some("0.105.0"));
    }

    #[test]
    fn peek_zip_min_game_version_returns_none_when_field_absent() {
        let path = Path::new("tests/fixtures/no_min_game_version.zip");
        let out = peek_zip_min_game_version(path)
            .expect("peek_zip_min_game_version should succeed without min_game_version");
        assert!(out.is_none());
    }

    #[test]
    fn peek_zip_min_game_version_errors_on_missing_file() {
        let path = Path::new("tests/fixtures/does_not_exist.zip");
        assert!(peek_zip_min_game_version(path).is_err());
    }

    #[test]
    fn peek_zip_min_game_version_errors_on_non_zip_file() {
        let path = Path::new("src/download.rs");
        assert!(peek_zip_min_game_version(path).is_err());
    }

    // ── Rate-limit header parsing ────────────────────────────────────────────

    fn make_headers(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
        let mut m = reqwest::header::HeaderMap::new();
        for (k, v) in pairs {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                m.insert(name, val);
            }
        }
        m
    }

    #[test]
    fn parse_rate_limit_headers_extracts_remaining_and_reset() {
        let headers = make_headers(&[
            ("x-ratelimit-remaining", "5"),
            ("x-ratelimit-reset", "1800000000"),
        ]);
        let info = parse_rate_limit_headers(&headers).expect("headers present — should parse");
        assert_eq!(info.remaining, 5);
        assert_eq!(info.reset_at, 1_800_000_000);
    }

    #[test]
    fn parse_rate_limit_headers_returns_none_when_headers_absent() {
        let headers = make_headers(&[]);
        assert!(parse_rate_limit_headers(&headers).is_none());
    }

    #[test]
    fn parse_rate_limit_headers_returns_none_when_only_remaining_present() {
        // Both headers are required — missing reset_at → None.
        let headers = make_headers(&[("x-ratelimit-remaining", "0")]);
        assert!(parse_rate_limit_headers(&headers).is_none());
    }

    #[test]
    fn quota_is_low_true_at_zero() {
        let info = RateLimitInfo {
            remaining: 0,
            reset_at: 9_999_999_999,
        };
        assert!(quota_is_low(&info));
    }

    #[test]
    fn quota_is_low_true_at_three() {
        let info = RateLimitInfo {
            remaining: 3,
            reset_at: 9_999_999_999,
        };
        assert!(quota_is_low(&info));
    }

    #[test]
    fn quota_is_low_false_at_four() {
        let info = RateLimitInfo {
            remaining: 4,
            reset_at: 9_999_999_999,
        };
        assert!(!quota_is_low(&info));
    }

    #[test]
    fn rate_limit_info_secs_until_reset_returns_zero_for_past_timestamp() {
        let info = RateLimitInfo {
            remaining: 0,
            reset_at: 1,
        }; // epoch + 1s = long ago
        assert_eq!(info.secs_until_reset(), 0);
    }

    #[test]
    fn rate_limit_info_secs_until_reset_returns_positive_for_future_timestamp() {
        let far_future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 120;
        let info = RateLimitInfo {
            remaining: 0,
            reset_at: far_future,
        };
        let secs = info.secs_until_reset();
        // Should be between 119 and 120 (tiny clock drift tolerance).
        assert!((119..=120).contains(&secs), "expected ~120s, got {}", secs);
    }
}
