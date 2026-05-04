use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::profiles::Profile;
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareResult {
    /// The profile code (formatted gist ID, e.g. "AA5A-315D-61AE")
    pub code: String,
    /// The raw gist ID (for API calls)
    pub gist_id: String,
    /// The gist URL for viewing in browser
    pub gist_url: String,
}

/// Local share info stored per profile for re-sharing
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareInfo {
    gist_id: String,
    code: String,
}

/// GitHub Gist API response
#[derive(Debug, Deserialize)]
struct GistResponse {
    id: String,
    html_url: String,
    files: std::collections::HashMap<String, GistFile>,
}

#[derive(Debug, Deserialize)]
struct GistFile {
    content: Option<String>,
}

// ── Profile Code Encoding ──────────────────────────────────────────────────

/// Convert a hex gist ID to a short profile code: "aa5a315d61ae..." -> "AA5A-315D-61AE"
/// Takes the first 12 hex chars (48 bits of entropy = 281 trillion combinations)
fn gist_id_to_code(gist_id: &str) -> String {
    let hex: String = gist_id
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(12)
        .collect::<String>()
        .to_uppercase();
    
    // Format as XXXX-XXXX-XXXX
    let mut parts = Vec::new();
    for chunk in hex.as_bytes().chunks(4) {
        parts.push(std::str::from_utf8(chunk).unwrap_or("????"));
    }
    parts.join("-")
}

/// Convert a profile code back to a search-friendly prefix.
/// "AA5A-315D-61AE" -> "aa5a315d61ae"
fn code_to_gist_prefix(code: &str) -> String {
    code.replace('-', "").to_lowercase()
}

/// Normalize user input: accept either a code, raw gist ID, or gist URL.
fn normalize_code_input(input: &str) -> String {
    let trimmed = input.trim();
    
    // If it's a gist URL: extract the ID from the end
    if trimmed.contains("gist.github.com") {
        if let Some(id) = trimmed.rsplit('/').next() {
            return id.to_string();
        }
    }
    
    // If it looks like a code (contains dashes, short): convert to prefix
    if trimmed.contains('-') && trimmed.len() <= 20 {
        return code_to_gist_prefix(trimmed);
    }
    
    // Otherwise treat as raw gist ID
    trimmed.to_string()
}

// ── GitHub Gist API ────────────────────────────────────────────────────────

fn build_gist_client(token: &str) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        "sts2-mod-manager/0.1".parse().unwrap(),
    );
    if let Ok(val) = format!("Bearer {}", token).parse() {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_default()
}

/// Create a new secret gist with the profile JSON.
async fn create_gist(profile: &Profile, token: &str) -> Result<GistResponse> {
    let client = build_gist_client(token);
    let profile_json = serde_json::to_string_pretty(profile)?;
    
    let body = serde_json::json!({
        "description": format!("STS2 Mod Manager - {} ({} mods)", profile.name, profile.mods.len()),
        "public": false,
        "files": {
            "sts2mm-profile.json": {
                "content": profile_json
            }
        }
    });

    let resp = client
        .post("https://api.github.com/gists")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AppError::Other(format!(
                "GitHub authentication failed ({}). Make sure you're using a Classic Personal Access Token with the 'gist' scope enabled. Fine-grained tokens do NOT support Gists. Error: {}",
                status, text
            )));
        }
        return Err(AppError::Other(format!(
            "Failed to create gist ({}): {}",
            status, text
        )));
    }

    Ok(resp.json().await?)
}

/// Update an existing gist with new profile data.
async fn update_gist(gist_id: &str, profile: &Profile, token: &str) -> Result<GistResponse> {
    let client = build_gist_client(token);
    let profile_json = serde_json::to_string_pretty(profile)?;
    
    let body = serde_json::json!({
        "description": format!("STS2 Mod Manager - {} ({} mods)", profile.name, profile.mods.len()),
        "files": {
            "sts2mm-profile.json": {
                "content": profile_json
            }
        }
    });

    let resp = client
        .patch(&format!("https://api.github.com/gists/{}", gist_id))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to update gist ({}): {}",
            status, text
        )));
    }

    Ok(resp.json().await?)
}

/// Fetch a gist by ID (no auth needed for public/secret gists with direct ID).
pub async fn fetch_gist(gist_id: &str) -> Result<Profile> {
    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();
    
    let resp = client
        .get(&format!("https://api.github.com/gists/{}", gist_id))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Profile not found ({}): {}. Check the code and try again.",
            status, text
        )));
    }

    let gist: GistResponse = resp.json().await?;
    
    // Find the profile file
    let content = gist
        .files
        .get("sts2mm-profile.json")
        .and_then(|f| f.content.as_ref())
        .ok_or_else(|| AppError::Other(
            "This gist doesn't contain a valid STS2 profile. Make sure you have the right code.".to_string()
        ))?;

    let profile: Profile = serde_json::from_str(content)
        .map_err(|e| AppError::Other(format!("Invalid profile data: {}", e)))?;

    Ok(profile)
}

/// Search user's gists to find one by code prefix (for resolving short codes).
async fn find_gist_by_prefix(prefix: &str, token: &str) -> Result<String> {
    let client = build_gist_client(token);
    
    // List user's gists and find one whose ID starts with the prefix
    let resp = client
        .get("https://api.github.com/gists?per_page=100")
        .send()
        .await?;
    
    if !resp.status().is_success() {
        // If we can't list gists, try the prefix as a full gist ID directly
        return Ok(prefix.to_string());
    }
    
    let gists: Vec<GistResponse> = resp.json().await?;
    
    for gist in &gists {
        if gist.id.starts_with(prefix) && gist.files.contains_key("sts2mm-profile.json") {
            return Ok(gist.id.clone());
        }
    }
    
    // Not found in user's gists - try as full ID
    Ok(prefix.to_string())
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Share a profile by creating a GitHub Gist. Returns a short profile code.
/// Requires a GitHub token to be set in Settings.
#[tauri::command]
pub async fn share_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let (profiles_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required to share profiles. Set a Classic Personal Access Token (with 'gist' scope) in Settings. Note: Fine-grained tokens do NOT support Gists."
        )?;
        (s.profiles_path.clone(), token)
    };

    let profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    let gist = create_gist(&profile, &token)
        .await
        .map_err(|e| e.to_string())?;

    let code = gist_id_to_code(&gist.id);

    // Store share info locally for re-sharing
    let share_info = ShareInfo {
        gist_id: gist.id.clone(),
        code: code.clone(),
    };
    let share_info_path = profiles_path.join(format!("{}.share", name));
    std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(ShareResult {
        code,
        gist_id: gist.id,
        gist_url: gist.html_url,
    })
}

/// Re-share (update) an already-shared profile. Same code, updated content.
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let (profiles_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required. Set a Classic Personal Access Token (with 'gist' scope) in Settings."
        )?;
        (s.profiles_path.clone(), token)
    };

    let profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    // Load existing share info
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet. Use 'Share' first.".to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let gist = update_gist(&share_info.gist_id, &profile, &token)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ShareResult {
        code: share_info.code,
        gist_id: gist.id,
        gist_url: gist.html_url,
    })
}

/// Fetch a shared profile by code/gist ID. Friends use this to preview before installing.
#[tauri::command]
pub async fn fetch_shared_profile_cmd(
    code: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let gist_id = normalize_code_input(&code);
    
    // If the input looks like a short prefix (from our code format), try to resolve
    if gist_id.len() < 20 {
        // Try fetching with optional token for better rate limits
        let token = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.github_token.clone()
        };
        
        if let Some(ref tok) = token {
            if let Ok(full_id) = find_gist_by_prefix(&gist_id, tok).await {
                return fetch_gist(&full_id).await.map_err(|e| e.to_string());
            }
        }
    }
    
    fetch_gist(&gist_id).await.map_err(|e| e.to_string())
}

/// Install a shared profile from a code AND auto-subscribe for updates.
#[tauri::command]
pub async fn install_shared_profile(
    code: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let gist_id = normalize_code_input(&code);
    
    // Resolve short codes
    let resolved_id = if gist_id.len() < 20 {
        let token = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.github_token.clone()
        };
        if let Some(ref tok) = token {
            find_gist_by_prefix(&gist_id, tok).await.unwrap_or(gist_id.clone())
        } else {
            gist_id.clone()
        }
    } else {
        gist_id.clone()
    };
    
    let profile = fetch_gist(&resolved_id)
        .await
        .map_err(|e| e.to_string())?;

    let (mods_path, disabled_path, profiles_path, config_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        (mods, disabled, profiles, config)
    };

    // Save the profile locally
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // Apply it
    crate::profiles::apply_profile(&profile, &mods_path, &disabled_path)
        .map_err(|e| e.to_string())?;

    // Auto-subscribe for future updates
    let now = chrono::Utc::now();
    let sub = crate::subscriptions::Subscription {
        share_id: resolved_id.clone(),
        share_url: format!("gist:{}", resolved_id),
        profile_name: profile.name.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: profile.clone(),
        last_checked: now,
        last_synced: now,
    };
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    db.subscriptions.insert(resolved_id, sub);
    let _ = crate::subscriptions::save_subscriptions(&db, &config_path);

    Ok(profile)
}
