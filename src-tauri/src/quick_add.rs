use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::download::download_and_install_github_mod;
use crate::error::{AppError, Result};
use crate::mod_sources::{load_sources, save_sources};
use crate::mods::ModInfo;
use crate::nexus::{NexusClient, NexusModInfo};
use crate::state::{AppState, PendingNexusInstall};

// ── Types ───────────────────────────────────────────────────────────────────

/// Result of a quick-add operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum QuickAddResult {
    /// A GitHub mod was downloaded and installed successfully.
    #[serde(rename = "github_installed")]
    GithubInstalled { mod_info: ModInfo },
    /// A Nexus mod was identified; the frontend should guide the user to download.
    #[serde(rename = "nexus_info")]
    NexusInfo { nexus_info: NexusModInfo },
}

// ── URL Resolvers ───────────────────────────────────────────────────────────

/// Parse a GitHub URL or shorthand into (owner, repo).
///
/// Supported formats:
/// - `https://github.com/owner/repo`
/// - `https://github.com/owner/repo/releases/tag/v1.0`
/// - `github:owner/repo`
pub fn resolve_github_url(url: &str) -> Result<(String, String)> {
    // Shorthand: github:owner/repo
    if let Some(rest) = url.strip_prefix("github:") {
        let parts: Vec<&str> = rest.splitn(2, '/').collect();
        if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            return Ok((parts[0].to_string(), parts[1].to_string()));
        }
        return Err(AppError::Other(format!(
            "Invalid GitHub shorthand: {}",
            url
        )));
    }

    // Full URL: https://github.com/owner/repo[/...]
    let parsed = url::Url::parse(url)?;

    let host = parsed.host_str().unwrap_or("");
    if host != "github.com" && host != "www.github.com" {
        return Err(AppError::Other(format!(
            "Not a GitHub URL: {}",
            url
        )));
    }

    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();

    if segments.len() >= 2 && !segments[0].is_empty() && !segments[1].is_empty() {
        Ok((segments[0].to_string(), segments[1].to_string()))
    } else {
        Err(AppError::Other(format!(
            "Could not extract owner/repo from GitHub URL: {}",
            url
        )))
    }
}

/// Parse a Nexus Mods URL or shorthand into (game_domain, mod_id).
///
/// Supported formats:
/// - `https://www.nexusmods.com/slaythefire2/mods/1234`
/// - `nexus:slaythefire2/mods/1234`
pub fn resolve_nexus_url(url: &str) -> Result<(String, u64)> {
    // Shorthand: nexus:game_domain/mods/1234
    if let Some(rest) = url.strip_prefix("nexus:") {
        let parts: Vec<&str> = rest.split('/').collect();
        // Expected: ["game_domain", "mods", "1234"]
        if parts.len() >= 3 && parts[1] == "mods" {
            let game_domain = parts[0].to_string();
            let mod_id: u64 = parts[2].parse().map_err(|_| {
                AppError::Other(format!("Invalid mod ID in Nexus shorthand: {}", parts[2]))
            })?;
            return Ok((game_domain, mod_id));
        }
        return Err(AppError::Other(format!(
            "Invalid Nexus shorthand: {}",
            url
        )));
    }

    // Full URL: https://www.nexusmods.com/game/mods/1234
    let parsed = url::Url::parse(url)?;

    let host = parsed.host_str().unwrap_or("");
    if !host.contains("nexusmods.com") {
        return Err(AppError::Other(format!(
            "Not a Nexus Mods URL: {}",
            url
        )));
    }

    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();

    // Expected: ["game_domain", "mods", "1234"]
    if segments.len() >= 3 && segments[1] == "mods" {
        let game_domain = segments[0].to_string();
        let mod_id: u64 = segments[2].parse().map_err(|_| {
            AppError::Other(format!("Invalid mod ID in Nexus URL: {}", segments[2]))
        })?;
        Ok((game_domain, mod_id))
    } else {
        Err(AppError::Other(format!(
            "Could not extract game/mod_id from Nexus URL: {}",
            url
        )))
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Quick-add a mod from a URL. Accepts GitHub URLs/shorthands and Nexus URLs/shorthands.
///
/// - GitHub: downloads and installs the latest release automatically.
/// - Nexus: returns mod info so the frontend can guide the user to download manually.
#[tauri::command]
pub async fn quick_add_mod(
    url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<QuickAddResult, String> {
    crate::game::ensure_game_not_running()?;
    log::info!("Quick add: {}", url);
    // Try GitHub first
    if let Ok((owner, repo)) = resolve_github_url(&url) {
        log::info!("Quick add resolved as GitHub: {}/{}", owner, repo);
        let (mods_path, cache_path, token, config_path) = {
            let s = state.lock().map_err(|e| e.to_string())?;
            let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
            let cache_path = s.cache_path.clone();
            let token = s.github_token.clone();
            let config_path = s.config_path.clone();
            (mods_path, cache_path, token, config_path)
        };

        let mod_info = download_and_install_github_mod(
            &owner,
            &repo,
            None,
            &mods_path,
            &cache_path,
            token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;

        // Persist the GitHub source so the mod shows the link in audit/UI.
        // The user gave us this URL explicitly, so it's not auto-detected.
        let mut db = load_sources(&config_path);
        let entry = db.mods.entry(mod_info.name.clone()).or_default();
        entry.github_repo = Some(format!("{}/{}", owner, repo));
        entry.github_auto_detected = false;
        if let Err(e) = save_sources(&db, &config_path) {
            log::warn!("Quick add: failed to persist GitHub source for '{}': {}", mod_info.name, e);
        }

        return Ok(QuickAddResult::GithubInstalled { mod_info });
    }

    // Try Nexus
    if let Ok((game_domain, mod_id)) = resolve_nexus_url(&url) {
        log::info!("Quick add resolved as Nexus: {}/mods/{}", game_domain, mod_id);
        let api_key = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.nexus_api_key
                .clone()
                .ok_or_else(|| "Nexus API key not set. Configure it in Settings.".to_string())?
        };

        let client = NexusClient::new(&api_key);
        let nexus_info = client
            .get_mod_info(&game_domain, mod_id)
            .await
            .map_err(|e| e.to_string())?;

        // Stash a hint so the downloads watcher can attach the Nexus URL when
        // the user clicks "Mod Manager Download" on Nexus and the zip lands
        // in their Downloads folder.
        {
            let mut s = state.lock().map_err(|e| e.to_string())?;
            // Drop any stale pending entries (older than 30 minutes) and any
            // for the same mod_id (latest Quick Add wins).
            let now = Instant::now();
            s.pending_nexus_installs.retain(|p| {
                p.mod_id != mod_id
                    && now.duration_since(p.queued_at) < std::time::Duration::from_secs(30 * 60)
            });
            s.pending_nexus_installs.push(PendingNexusInstall {
                mod_name: nexus_info.name.clone().unwrap_or_default(),
                nexus_url: format!("https://www.nexusmods.com/{}/mods/{}", game_domain, mod_id),
                game_domain: game_domain.clone(),
                mod_id,
                queued_at: now,
            });
        }

        return Ok(QuickAddResult::NexusInfo { nexus_info });
    }

    log::warn!("Quick add: unrecognized URL format: {}", url);
    Err(format!(
        "Could not recognize URL format: {}. Supported: GitHub URLs, github:owner/repo, Nexus URLs, nexus:game/mods/id",
        url
    ))
}
