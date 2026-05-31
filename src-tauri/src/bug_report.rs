//! Bug-report log upload.
//!
//! The "Report a bug" flow builds a redacted diagnostic report on the
//! frontend. To get the FULL report into a GitHub issue without truncating
//! it into the issue URL — and without the user needing any token — we POST
//! it to a maintainer-hosted ingest endpoint (a small Cloudflare Worker;
//! see tools/bug-report-worker/). The endpoint stores the report and returns
//! a short view URL that the issue links to. This is the standard
//! vendor-hosted telemetry pattern: the app talks to the maintainer's
//! endpoint, the reporter authenticates with nothing.
//!
//! The endpoint is configured at build time via the STS2_BUG_REPORT_ENDPOINT
//! env var (so it ships only in release builds the maintainer cuts). When
//! it's unset — or the upload fails — the command errors and the frontend
//! falls back to the copy-to-clipboard + truncated-issue path.

use std::time::Duration;

use serde::Deserialize;

/// Maintainer-hosted ingest endpoint, baked in at build time. `None` when
/// the env var wasn't set for this build → the frontend falls back.
const BUG_REPORT_ENDPOINT: Option<&str> = option_env!("STS2_BUG_REPORT_ENDPOINT");
/// Optional shared key sent as `x-app-key`, so the endpoint can reject
/// traffic that isn't from the app. Baked in at build time alongside the URL.
const BUG_REPORT_KEY: Option<&str> = option_env!("STS2_BUG_REPORT_KEY");

const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
struct UploadResponse {
    /// Public view URL for the stored report.
    url: String,
}

/// Extract the view URL from the endpoint's JSON response. Pure helper so
/// the contract is unit-testable without the network.
fn parse_upload_response(body: &str) -> Result<String, String> {
    let parsed: UploadResponse =
        serde_json::from_str(body).map_err(|e| format!("Unexpected upload response: {}", e))?;
    if parsed.url.trim().is_empty() {
        return Err("Upload response had no URL".to_string());
    }
    Ok(parsed.url)
}

/// Upload the bug report to the maintainer's ingest endpoint and return the
/// view URL. Errors (so the frontend can fall back) when no endpoint is
/// configured, the report is empty, or the request is rejected. Requires NO
/// user token — the endpoint is the maintainer's, not the reporter's.
#[tauri::command]
pub async fn upload_bug_report(content: String) -> Result<String, String> {
    let endpoint = BUG_REPORT_ENDPOINT
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .ok_or_else(|| "Bug report upload endpoint not configured".to_string())?;

    if content.trim().is_empty() {
        return Err("Empty report".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
        .timeout(UPLOAD_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .post(endpoint)
        .json(&serde_json::json!({ "report": content }));
    if let Some(key) = BUG_REPORT_KEY.map(str::trim).filter(|k| !k.is_empty()) {
        req = req.header("x-app-key", key);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Upload failed ({}): {}", status, text));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    parse_upload_response(&body)
}

/// Pull the host out of an endpoint URL without a URL-parsing crate: drop the
/// scheme, take up to the first '/', '?' or '#', then drop any `userinfo@`.
fn endpoint_host(endpoint: &str) -> Option<String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return None;
    }
    let after_scheme = endpoint.split("://").nth(1).unwrap_or(endpoint);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// The HOST of the configured upload endpoint (e.g. "reports.example.dev"), or
/// None when no endpoint is configured for this build (dev / fork builds never
/// upload). Lets the UI tell the user exactly where a report will be sent — and
/// whether it will be sent at all — before they consent.
#[tauri::command]
pub fn bug_report_endpoint_host() -> Option<String> {
    BUG_REPORT_ENDPOINT.and_then(endpoint_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_upload_response_extracts_url() {
        let url = parse_upload_response(r#"{"url":"https://reports.example.dev/r/abc123"}"#).unwrap();
        assert_eq!(url, "https://reports.example.dev/r/abc123");
    }

    #[test]
    fn parse_upload_response_rejects_missing_or_blank_url() {
        assert!(parse_upload_response(r#"{"url":""}"#).is_err());
        assert!(parse_upload_response(r#"{"nope":1}"#).is_err());
        assert!(parse_upload_response("not json").is_err());
    }

    #[test]
    fn endpoint_host_extracts_host() {
        assert_eq!(
            endpoint_host("https://reports.example.dev/ingest"),
            Some("reports.example.dev".into())
        );
        assert_eq!(
            endpoint_host("https://u:p@h.example.com/x?y#z"),
            Some("h.example.com".into())
        );
        assert_eq!(
            endpoint_host("reports.example.dev/x"),
            Some("reports.example.dev".into())
        );
        assert_eq!(endpoint_host("   "), None);
        assert_eq!(endpoint_host(""), None);
    }
}
