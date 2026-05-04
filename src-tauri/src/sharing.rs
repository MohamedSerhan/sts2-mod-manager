use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::profiles::Profile;
use crate::state::AppState;

const DEFAULT_SHARING_URL: &str = "https://sts2mm.workers.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareResult {
    pub id: String,
    pub url: String,
    pub secret_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedProfile {
    pub id: String,
    pub profile: Profile,
}

/// Share a profile by uploading it to the sharing service.
pub async fn upload_profile(profile: &Profile, base_url: Option<&str>) -> Result<ShareResult> {
    let url = format!("{}/api/profiles", base_url.unwrap_or(DEFAULT_SHARING_URL));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "profile": profile }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to share profile: {}",
            text
        )));
    }

    Ok(resp.json().await?)
}

/// Update an existing shared profile.
pub async fn update_shared_profile(
    id: &str,
    profile: &Profile,
    secret_token: &str,
    base_url: Option<&str>,
) -> Result<ShareResult> {
    let url = format!(
        "{}/api/profiles/{}",
        base_url.unwrap_or(DEFAULT_SHARING_URL),
        id
    );
    let client = reqwest::Client::new();
    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", secret_token))
        .json(&serde_json::json!({ "profile": profile }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to update profile: {}",
            text
        )));
    }

    Ok(resp.json().await?)
}

/// Fetch a shared profile by ID.
pub async fn fetch_shared_profile(id: &str, base_url: Option<&str>) -> Result<Profile> {
    let url = format!(
        "{}/api/profiles/{}",
        base_url.unwrap_or(DEFAULT_SHARING_URL),
        id
    );
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("Profile not found: {}", text)));
    }

    Ok(resp.json().await?)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn share_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let profiles_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.profiles_path.clone()
    };

    let profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    let result = upload_profile(&profile, None)
        .await
        .map_err(|e| e.to_string())?;

    // Store the share info (id + secret) in a local file for re-sharing
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info = serde_json::json!({
        "id": result.id,
        "secret_token": result.secret_token,
        "url": result.url,
    });
    std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn reshare_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let profiles_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.profiles_path.clone()
    };

    let profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    // Load existing share info
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet. Use 'Share' first.".to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let id = share_info["id"]
        .as_str()
        .ok_or("Missing share ID")?
        .to_string();
    let secret = share_info["secret_token"]
        .as_str()
        .ok_or("Missing secret token")?
        .to_string();

    let result = update_shared_profile(&id, &profile, &secret, None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn fetch_shared_profile_cmd(
    id: String,
) -> std::result::Result<Profile, String> {
    fetch_shared_profile(&id, None)
        .await
        .map_err(|e| e.to_string())
}

/// Install a shared profile AND automatically subscribe to it for future updates.
/// This is the flow friends use: click a link -> app opens -> install + subscribe.
#[tauri::command]
pub async fn install_shared_profile(
    id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let profile = fetch_shared_profile(&id, None)
        .await
        .map_err(|e| e.to_string())?;

    let (mods_path, disabled_path, profiles_path, config_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s
            .mods_path
            .clone()
            .ok_or_else(|| "Game path not set".to_string())?;
        let disabled = s
            .disabled_mods_path
            .clone()
            .ok_or_else(|| "Game path not set".to_string())?;
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        (mods, disabled, profiles, config)
    };

    // Save the profile locally
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // Apply it
    crate::profiles::apply_profile(&profile, &mods_path, &disabled_path)
        .map_err(|e| e.to_string())?;

    // Auto-subscribe so the friend gets notified of future updates
    let share_url = format!("{}/p/{}", DEFAULT_SHARING_URL, id);
    let now = chrono::Utc::now();
    let sub = crate::subscriptions::Subscription {
        share_id: id.clone(),
        share_url,
        profile_name: profile.name.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: profile.clone(),
        last_checked: now,
        last_synced: now,
    };
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    db.subscriptions.insert(id, sub);
    let _ = crate::subscriptions::save_subscriptions(&db, &config_path);

    Ok(profile)
}
