//! Low-level GitHub HTTP plumbing: the reqwest client builder,
//! the `STS2_GITHUB_API_BASE` env-var indirection, and the basic
//! request/response shapes the sharing orchestration in `mod.rs`
//! wraps in higher-level workflows.
//!
//! Split out of the historic `sharing.rs` mega-file so the testable
//! "talks to GitHub" surface (Contents/User/Releases API shapes,
//! Bearer-auth header wiring) lives separately from the upload
//! retry/recovery + zip-bundling layered on top. The release-asset
//! upload helpers (`ensure_bundles_release`, `upload_release_asset`,
//! `delete_release_asset`, `replace_release_asset_via_delete_post`)
//! stay in `mod.rs` for now — they're so tightly bound to the test
//! modules that use `super::*` that splitting them risks breaking
//! more invariants than the win justifies.
//!
//! See `sharing/mod.rs` for the orchestration that calls into these
//! helpers, and `sharing/code.rs` for the pure-helper layer.

use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, Result};

/// Total request timeout for sharing HTTP clients. Long enough for a
/// large release-asset download on a slow link, short enough that a
/// stalled connection can't pin the share/publish worker forever.
pub(super) const HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Connect timeout for sharing HTTP clients. A connect that's still
/// pending after 10s is almost certainly a routing/DNS issue.
pub(super) const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
    reqwest::Client::builder()
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
pub(super) async fn ensure_profiles_repo(
    token: &str,
    username: &str,
    repo: &str,
) -> Result<()> {
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
