use serde::{Deserialize, Serialize};

use crate::download::{download_and_install_github_mod, fetch_latest_release, fetch_releases};
use crate::error::Result;
use crate::mod_sources::{load_sources, save_sources, update_installed_version, ModSourceEntry};
use crate::mods::{scan_mods, ModInfo};
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// Describes an available update for an installed mod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModUpdate {
    pub mod_name: String,
    pub current_version: String,
    pub latest_version: String,
    /// "github" or "nexus"
    pub source_type: String,
    /// GitHub owner/repo or Nexus mod page URL
    pub source_id: String,
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

/// Parse an "owner/repo" string into (owner, repo).
fn parse_owner_repo(full_name: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = full_name.splitn(2, '/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

/// Resolve the GitHub owner/repo for a mod, checking:
/// 1. mod_sources.json (explicit link)
/// 2. ModInfo.source field (legacy github:owner/repo)
fn resolve_github_repo(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<(String, String)> {
    // Check mod_sources.json first
    if let Some(entry) = sources.get(&mod_info.name) {
        if let Some(ref repo) = entry.github_repo {
            if let Some(pair) = parse_owner_repo(repo) {
                return Some(pair);
            }
        }
    }

    // Fall back to legacy source field
    if let Some(ref source) = mod_info.source {
        if let Some(pair) = parse_github_source(source) {
            return Some(pair);
        }
        // Also handle full GitHub URLs in source field
        if source.contains("github.com/") {
            if let Ok(parsed) = url::Url::parse(source) {
                let segs: Vec<&str> = parsed.path_segments().map(|s| s.collect()).unwrap_or_default();
                if segs.len() >= 2 {
                    return Some((segs[0].to_string(), segs[1].to_string()));
                }
            }
        }
    }

    None
}

/// Check installed mods for available updates by querying GitHub releases.
/// Uses mod_sources.json for source resolution, then falls back to legacy source field.
pub async fn check_all_updates(
    mods: &[ModInfo],
    sources: &std::collections::HashMap<String, ModSourceEntry>,
    token: Option<&str>,
) -> Result<Vec<ModUpdate>> {
    let mut updates = Vec::new();

    for m in mods {
        let (owner, repo) = match resolve_github_repo(m, sources) {
            Some(pair) => pair,
            None => continue,
        };

        let release = match fetch_latest_release(&owner, &repo, token).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "Failed to check updates for {} ({}/{}): {}",
                    m.name,
                    owner,
                    repo,
                    e
                );
                continue;
            }
        };

        // Skip releases with no downloadable assets (author published tag without uploading files)
        let has_downloadable_asset = release.assets.iter().any(|a| {
            a.name.ends_with(".zip") || a.name.ends_with(".dll") || a.name.ends_with(".pck")
        });
        if !has_downloadable_asset {
            log::info!(
                "Skipping update for {} ({}/{}): release {} has no downloadable assets",
                m.name, owner, repo, release.tag_name
            );
            continue;
        }

        // Strip leading 'v' for comparison (e.g. "v1.2.0" -> "1.2.0")
        let latest = release.tag_name.trim_start_matches('v');
        let current = m.version.trim_start_matches('v');

        // Check if the installed_version in mod_sources.json matches latest
        let installed_ver_matches = sources
            .get(&m.name)
            .and_then(|e| e.installed_version.as_deref())
            .map(|iv| iv.trim_start_matches('v') == latest)
            .unwrap_or(false);

        // Skip if: installed version matches, OR manifest version matches, OR version is unknown
        if installed_ver_matches || latest == current || current == "unknown" || current == "0.0.0" {
            continue;
        }

        let download_url = release
            .assets
            .first()
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_else(|| release.html_url.clone());

        updates.push(ModUpdate {
            mod_name: m.name.clone(),
            current_version: m.version.clone(),
            latest_version: release.tag_name.clone(),
            source_type: "github".to_string(),
            source_id: format!("{}/{}", owner, repo),
            download_url,
        });
    }

    Ok(updates)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Check all installed mods (with GitHub sources) for available updates.
#[tauri::command]
pub async fn check_for_updates(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModUpdate>, String> {
    let (mods_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        (mods_path, config_path, token)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    check_all_updates(&installed, &sources_db.mods, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download and install the latest version of a specific mod from its GitHub source.
#[tauri::command]
pub async fn update_mod(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    let (mods_path, cache_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        (mods_path, cache_path, config_path, token)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);

    let mod_info = installed
        .iter()
        .find(|m| m.name == name)
        .ok_or_else(|| format!("Mod '{}' not found", name))?;

    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods)
        .ok_or_else(|| format!("Mod '{}' has no GitHub source linked. Link one in the Mods view.", name))?;

    let release = fetch_latest_release(&owner, &repo, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let tag = release.tag_name.clone();

    // Delete the old mod files before installing the update to prevent duplicates
    // (e.g., old mod in "ModConfig-v0.2.1/" and new one in "ModConfig-v0.2.2/")
    {
        let all_mods: Vec<ModInfo> = scan_mods(&mods_path);
        if let Some(old_info) = all_mods.iter().find(|m| m.name == name) {
            let mut parent_dirs = std::collections::HashSet::new();
            for file_rel in &old_info.files {
                let normalized = file_rel.replace('\\', "/");
                let file_path = mods_path.join(&normalized);
                if file_path.is_dir() {
                    let _ = std::fs::remove_dir_all(&file_path);
                } else if file_path.exists() {
                    let _ = std::fs::remove_file(&file_path);
                }
                if let Some(parent_rel) = std::path::Path::new(&normalized).parent() {
                    if !parent_rel.as_os_str().is_empty() {
                        parent_dirs.insert(mods_path.join(parent_rel));
                    }
                }
            }
            for dir in &parent_dirs {
                if dir.is_dir() {
                    if std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                        let _ = std::fs::remove_dir(dir);
                    }
                }
            }
            log::info!("Deleted old files for '{}' before updating", name);
        }
    }

    let info = download_and_install_github_mod(&owner, &repo, None, &mods_path, &cache_path, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // Record the installed version so future checks know this is up-to-date.
    // Save under both the original name AND the manifest name (they may differ).
    update_installed_version(&name, &tag, &config_path);
    if info.name != name {
        update_installed_version(&info.name, &tag, &config_path);
    }

    Ok(info)
}

/// Update all mods that have available GitHub updates.
#[tauri::command]
pub async fn update_all_mods(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModInfo>, String> {
    let (mods_path, cache_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        (mods_path, cache_path, config_path, token)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    let updates = check_all_updates(&installed, &sources_db.mods, token.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for update in &updates {
        let (owner, repo) = match parse_owner_repo(&update.source_id) {
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
            Ok(info) => {
                // Update the source link and record installed version
                let mut db = load_sources(&config_path);
                let entry = db.mods.entry(info.name.clone()).or_default();
                entry.github_repo = Some(format!("{}/{}", owner, repo));
                entry.installed_version = Some(update.latest_version.clone());
                let _ = save_sources(&db, &config_path);
                results.push(info);
            }
            Err(e) => {
                log::error!("Failed to update mod '{}': {}", update.mod_name, e);
            }
        }
    }

    Ok(results)
}

// ── Audit ───────────────────────────────────────────────────────────────────

/// Detailed audit entry for a single mod's version status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModAuditEntry {
    pub mod_name: String,
    pub github_repo: Option<String>,
    pub installed_version: String,
    /// The tag from /releases/latest (may have no assets).
    pub latest_release_tag: Option<String>,
    /// The tag of the most recent release that has downloadable assets.
    pub latest_release_with_assets_tag: Option<String>,
    /// Whether the latest release (by tag) has downloadable assets.
    pub latest_has_assets: bool,
    /// Whether the mod needs updating (installed version != latest release with assets).
    pub needs_update: bool,
    /// Asset file names from the latest release with assets.
    pub asset_names: Vec<String>,
    /// Number of releases scanned to find one with assets.
    pub releases_scanned: u32,
    /// Any error encountered during the audit.
    pub error: Option<String>,
}

/// Valid mod asset extensions for STS2 mods.
fn is_mod_asset(name: &str) -> bool {
    name.ends_with(".zip") || name.ends_with(".dll") || name.ends_with(".pck")
}

/// Audit all installed mods against their latest GitHub releases.
/// For each mod with a GitHub source, fetches releases (paginated) to find
/// the most recent release that actually has downloadable mod files (.zip, .dll, .pck).
/// This validates that the update-checking logic correctly skips empty releases.
#[tauri::command]
pub async fn audit_mod_versions(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModAuditEntry>, String> {
    let (mods_path, disabled_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        (mods_path, disabled_path, config_path, token)
    };

    // Scan both enabled and disabled mods
    let mut all_mods = scan_mods(&mods_path);
    if let Some(ref dp) = disabled_path {
        let disabled = scan_mods(dp);
        all_mods.extend(disabled);
    }

    let sources_db = load_sources(&config_path);
    let mut results: Vec<ModAuditEntry> = Vec::new();

    for m in &all_mods {
        let (owner, repo) = match resolve_github_repo(m, &sources_db.mods) {
            Some(pair) => pair,
            None => {
                // No GitHub source — include in report but skip version check
                results.push(ModAuditEntry {
                    mod_name: m.name.clone(),
                    github_repo: None,
                    installed_version: m.version.clone(),
                    latest_release_tag: None,
                    latest_release_with_assets_tag: None,
                    latest_has_assets: false,
                    needs_update: false,
                    asset_names: Vec::new(),
                    releases_scanned: 0,
                    error: None,
                });
                continue;
            }
        };

        let full_name = format!("{}/{}", owner, repo);

        // Fetch latest release first (the /releases/latest endpoint)
        let latest_release = match fetch_latest_release(&owner, &repo, token.as_deref()).await {
            Ok(r) => Some(r),
            Err(e) => {
                results.push(ModAuditEntry {
                    mod_name: m.name.clone(),
                    github_repo: Some(full_name),
                    installed_version: m.version.clone(),
                    latest_release_tag: None,
                    latest_release_with_assets_tag: None,
                    latest_has_assets: false,
                    needs_update: false,
                    asset_names: Vec::new(),
                    releases_scanned: 0,
                    error: Some(format!("Failed to fetch latest release: {}", e)),
                });
                continue;
            }
        };

        let latest_tag = latest_release.as_ref().map(|r| r.tag_name.clone());
        let latest_has_mod_assets = latest_release
            .as_ref()
            .map(|r| r.assets.iter().any(|a| is_mod_asset(&a.name)))
            .unwrap_or(false);

        // Now scan paginated releases to find the most recent one WITH downloadable assets
        let mut best_release_with_assets: Option<crate::download::GitHubRelease> = None;
        let mut total_scanned: u32 = 0;
        let max_pages: u32 = 3; // Scan up to 3 pages (90 releases)
        let per_page: u32 = 30;

        'outer: for page in 1..=max_pages {
            let releases = match fetch_releases(&owner, &repo, page, per_page, token.as_deref()).await {
                Ok(r) => r,
                Err(_) => break,
            };

            if releases.is_empty() {
                break;
            }

            for release in &releases {
                total_scanned += 1;
                if release.assets.iter().any(|a| is_mod_asset(&a.name)) {
                    best_release_with_assets = Some(release.clone());
                    break 'outer;
                }
            }
        }

        let with_assets_tag = best_release_with_assets
            .as_ref()
            .map(|r| r.tag_name.clone());
        let asset_names: Vec<String> = best_release_with_assets
            .as_ref()
            .map(|r| {
                r.assets
                    .iter()
                    .filter(|a| is_mod_asset(&a.name))
                    .map(|a| a.name.clone())
                    .collect()
            })
            .unwrap_or_default();

        // Determine if an update is needed
        let needs_update = if let Some(ref release) = best_release_with_assets {
            let latest_ver = release.tag_name.trim_start_matches('v');
            let current_ver = m.version.trim_start_matches('v');

            // Also check installed_version from mod_sources.json
            let installed_ver_matches = sources_db
                .mods
                .get(&m.name)
                .and_then(|e| e.installed_version.as_deref())
                .map(|iv| iv.trim_start_matches('v') == latest_ver)
                .unwrap_or(false);

            !installed_ver_matches
                && latest_ver != current_ver
                && current_ver != "unknown"
                && current_ver != "0.0.0"
        } else {
            false
        };

        results.push(ModAuditEntry {
            mod_name: m.name.clone(),
            github_repo: Some(full_name),
            installed_version: m.version.clone(),
            latest_release_tag: latest_tag,
            latest_release_with_assets_tag: with_assets_tag,
            latest_has_assets: latest_has_mod_assets,
            needs_update,
            asset_names,
            releases_scanned: total_scanned,
            error: None,
        });
    }

    Ok(results)
}
