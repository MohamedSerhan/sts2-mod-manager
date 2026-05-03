use serde::{Deserialize, Serialize};

use crate::download::{download_and_install_github_mod, fetch_latest_release};
use crate::error::Result;
use crate::mods::{scan_mods, ModInfo};
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// Describes an available update for an installed mod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModUpdate {
    pub mod_name: String,
    pub current_version: String,
    pub latest_version: String,
    pub source: String,
    pub download_url: String,
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Parse a `github:owner/repo` source string into (owner, repo).
fn parse_github_source(source: &str) -> Option<(String, String)> {
    let rest = source.strip_prefix("github:")?;
    let parts: Vec<&str> = rest.splitn(2, '/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

/// Check installed mods that have a `github:owner/repo` source for available
/// updates by querying the GitHub releases API.
pub async fn check_github_updates(
    mods: &[ModInfo],
    token: Option<&str>,
) -> Result<Vec<ModUpdate>> {
    let mut updates = Vec::new();

    for m in mods {
        let source = match &m.source {
            Some(s) if s.starts_with("github:") => s.clone(),
            _ => continue,
        };

        let (owner, repo) = match parse_github_source(&source) {
            Some(pair) => pair,
            None => continue,
        };

        let release = match fetch_latest_release(&owner, &repo, token).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "Failed to check updates for {} ({}): {}",
                    m.name,
                    source,
                    e
                );
                continue;
            }
        };

        // Strip leading 'v' for comparison (e.g. "v1.2.0" -> "1.2.0")
        let latest = release.tag_name.trim_start_matches('v');
        let current = m.version.trim_start_matches('v');

        if latest != current {
            let download_url = release
                .assets
                .first()
                .map(|a| a.browser_download_url.clone())
                .unwrap_or_else(|| release.html_url.clone());

            updates.push(ModUpdate {
                mod_name: m.name.clone(),
                current_version: m.version.clone(),
                latest_version: release.tag_name.clone(),
                source: source.clone(),
                download_url,
            });
        }
    }

    Ok(updates)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Check all installed GitHub-sourced mods for available updates.
#[tauri::command]
pub async fn check_for_updates(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModUpdate>, String> {
    let (mods_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let token = s.github_token.clone();
        (mods_path, token)
    };

    let installed = scan_mods(&mods_path);
    check_github_updates(&installed, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download and install the latest version of a specific mod from its GitHub source.
#[tauri::command]
pub async fn update_mod(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    let (mods_path, cache_path, token, source) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();

        // Find the mod by name to get its source
        let installed = scan_mods(&mods_path);
        let mod_info = installed
            .iter()
            .find(|m| m.name == name)
            .ok_or_else(|| format!("Mod '{}' not found", name))?;

        let source = mod_info
            .source
            .clone()
            .ok_or_else(|| format!("Mod '{}' has no source information", name))?;

        (mods_path, cache_path, token, source)
    };

    let (owner, repo) = parse_github_source(&source)
        .ok_or_else(|| format!("Mod '{}' does not have a valid GitHub source", name))?;

    download_and_install_github_mod(&owner, &repo, None, &mods_path, &cache_path, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Update all mods that have available GitHub updates.
#[tauri::command]
pub async fn update_all_mods(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModInfo>, String> {
    let (mods_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods_path, cache_path, token)
    };

    let installed = scan_mods(&mods_path);
    let updates = check_github_updates(&installed, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for update in &updates {
        let (owner, repo) = match parse_github_source(&update.source) {
            Some(pair) => pair,
            None => continue,
        };

        match download_and_install_github_mod(
            &owner,
            &repo,
            None,
            &mods_path,
            &cache_path,
            token.as_deref(),
        )
        .await
        {
            Ok(info) => results.push(info),
            Err(e) => {
                log::error!("Failed to update mod '{}': {}", update.mod_name, e);
            }
        }
    }

    Ok(results)
}
