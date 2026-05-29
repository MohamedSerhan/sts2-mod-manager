//! Bug-report log upload.
//!
//! The "Report a bug" flow builds a redacted diagnostic report on the
//! frontend. To get the FULL report into a GitHub issue without truncating
//! it into the issue URL (and without asking the user to paste anything),
//! we upload it as a secret GitHub Gist using the GitHub token the user has
//! already configured for modpack sharing, and the issue links to the gist.
//!
//! No token configured (or the token lacks the Gist permission) → the
//! command errors and the frontend falls back to the
//! copy-to-clipboard + truncated-issue path.

use serde::Deserialize;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct GistResponse {
    html_url: String,
}

/// JSON body for the create-gist request. A secret (non-public) gist with
/// the report as a single Markdown file. Pure helper so the shape is
/// unit-testable without hitting the network.
fn gist_request_body(content: &str) -> serde_json::Value {
    serde_json::json!({
        "description": "STS2 Mod Manager — bug report",
        "public": false,
        "files": {
            "sts2-mod-manager-bug-report.md": { "content": content }
        }
    })
}

/// Create a secret gist with the bug report and return its URL. Uses the
/// stored GitHub token; errors (so the frontend can fall back) when there's
/// no token or the API rejects the request.
#[tauri::command]
pub async fn create_bug_report_gist(
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let token = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.github_token.clone()
    };
    let token = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "No GitHub token configured".to_string())?;

    if content.trim().is_empty() {
        return Err("Empty report".to_string());
    }

    let client = crate::sharing::build_client(&token);
    let resp = client
        .post("https://api.github.com/gists")
        .json(&gist_request_body(&content))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        // 403 here is usually "token lacks Gist permission" — surface it so
        // the frontend logs it before falling back.
        return Err(format!("Gist upload failed ({}): {}", status, text));
    }

    let gist: GistResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(gist.html_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gist_body_is_a_secret_single_file_gist() {
        let body = gist_request_body("hello world");
        assert_eq!(body["public"], serde_json::json!(false));
        assert_eq!(
            body["files"]["sts2-mod-manager-bug-report.md"]["content"],
            serde_json::json!("hello world"),
        );
        assert!(body["description"].as_str().unwrap().contains("bug report"));
    }
}
