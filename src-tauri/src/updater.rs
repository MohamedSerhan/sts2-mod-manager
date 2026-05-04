use serde::{Deserialize, Serialize};

use crate::download::{download_and_install_github_mod, fetch_latest_release, fetch_releases};
use crate::error::Result;
use crate::mod_sources::{load_sources, save_sources, update_installed_version, ModSourceEntry};
use crate::mods::{scan_mods, ModInfo};
use crate::state::AppState;

// ── Version Comparison ─────────────────────────────────────────────────────

/// Try to parse a version string into a semver::Version.
/// Handles common variants: "1.2.3", "v1.2.3", "1.2", "1".
fn parse_version(v: &str) -> Option<semver::Version> {
    let stripped = v.trim().trim_start_matches('v');
    // Try direct parse first
    if let Ok(ver) = semver::Version::parse(stripped) {
        return Some(ver);
    }
    // Try adding .0 suffixes for partial versions like "1.2" or "1"
    let parts: Vec<&str> = stripped.split('.').collect();
    match parts.len() {
        1 => semver::Version::parse(&format!("{}.0.0", stripped)).ok(),
        2 => semver::Version::parse(&format!("{}.0", stripped)).ok(),
        _ => None,
    }
}

/// Check if a tag looks like a valid version (not something like "dev-build" or "nightly").
fn is_version_tag(tag: &str) -> bool {
    parse_version(tag).is_some()
}

/// Compare two version strings. Returns:
/// - Some(Ordering::Less) if current < latest (update available)
/// - Some(Ordering::Equal) if they match
/// - Some(Ordering::Greater) if current > latest (would be a downgrade)
/// - None if either version can't be parsed
fn compare_versions(current: &str, latest: &str) -> Option<std::cmp::Ordering> {
    let cur = parse_version(current)?;
    let lat = parse_version(latest)?;
    Some(cur.cmp(&lat))
}

/// Returns true if `latest` is actually newer than `current` (not equal, not a downgrade).
fn is_newer_version(current: &str, latest: &str) -> bool {
    match compare_versions(current, latest) {
        Some(std::cmp::Ordering::Less) => true,
        _ => false,
    }
}

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
/// 1. mod_sources.json (explicit link — only if manually set, not auto-detected)
/// 2. ModInfo.source field (legacy github:owner/repo)
fn resolve_github_repo(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<(String, String)> {
    // Check mod_sources.json first — skip auto-detected links
    if let Some(entry) = sources.get(&mod_info.name) {
        if !entry.github_auto_detected {
            if let Some(ref repo) = entry.github_repo {
                if let Some(pair) = parse_owner_repo(repo) {
                    return Some(pair);
                }
            }
        }
    }

    // Fall back to legacy source field (these are from the mod author, trustworthy)
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

/// Check installed mods for available updates by querying GitHub releases AND Nexus Mods.
/// Uses mod_sources.json for source resolution, then falls back to legacy source field.
pub async fn check_all_updates(
    mods: &[ModInfo],
    sources: &std::collections::HashMap<String, ModSourceEntry>,
    token: Option<&str>,
    nexus_api_key: Option<&str>,
) -> Result<Vec<ModUpdate>> {
    let mut updates = Vec::new();
    // Track which mods already got a GitHub update so we don't double-list
    let mut github_updated: std::collections::HashSet<String> = std::collections::HashSet::new();

    // --- Phase 1: GitHub checks (existing logic, untouched) ---
    for m in mods {
        // Skip pinned mods — they must be updated manually
        if let Some(entry) = sources.get(&m.name) {
            if entry.pinned { continue; }
        }

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

        // Skip non-version tags like "dev-build", "nightly", etc.
        if !is_version_tag(&release.tag_name) {
            log::info!(
                "Skipping update for {} ({}/{}): tag '{}' is not a valid version",
                m.name, owner, repo, release.tag_name
            );
            continue;
        }

        let latest = release.tag_name.trim_start_matches('v');
        let current = m.version.trim_start_matches('v');

        // Check if the installed_version in mod_sources.json matches latest
        let installed_ver_matches = sources
            .get(&m.name)
            .and_then(|e| e.installed_version.as_deref())
            .map(|iv| iv.trim_start_matches('v') == latest)
            .unwrap_or(false);

        // Skip if versions match exactly, or version is unknown
        if installed_ver_matches || latest == current || current == "unknown" || current == "0.0.0" {
            continue;
        }

        // Use semver comparison to prevent downgrades
        if !is_newer_version(current, latest) {
            log::info!(
                "Skipping update for {} ({}/{}): installed {} >= latest {}",
                m.name, owner, repo, current, latest
            );
            continue;
        }

        let download_url = release
            .assets
            .first()
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_else(|| release.html_url.clone());

        github_updated.insert(m.name.clone());
        updates.push(ModUpdate {
            mod_name: m.name.clone(),
            current_version: m.version.clone(),
            latest_version: release.tag_name.clone(),
            source_type: "github".to_string(),
            source_id: format!("{}/{}", owner, repo),
            download_url,
        });
    }

    // --- Phase 2: Nexus checks (for mods not already flagged by GitHub) ---
    if let Some(nkey) = nexus_api_key {
        let client = crate::nexus::NexusClient::new(nkey);

        for m in mods {
            // Skip if already flagged via GitHub
            if github_updated.contains(&m.name) {
                continue;
            }

            // Skip pinned mods
            if let Some(entry) = sources.get(&m.name) {
                if entry.pinned { continue; }
            }

            let source_entry = match sources.get(&m.name) {
                Some(e) => e,
                None => continue,
            };

            let domain = match source_entry.nexus_game_domain.as_ref() {
                Some(d) => d,
                None => continue,
            };
            let mod_id = match source_entry.nexus_mod_id {
                Some(id) => id,
                None => continue,
            };

            let nexus_url = source_entry.nexus_url.clone().unwrap_or_else(|| {
                format!("https://www.nexusmods.com/{}/mods/{}", domain, mod_id)
            });

            match client.get_mod_info(domain, mod_id).await {
                Ok(info) => {
                    if let Some(ref nv) = info.version {
                        // Best known installed version (same logic as audit)
                        let sources_ver = source_entry
                            .installed_version
                            .as_deref()
                            .unwrap_or("");
                        let manifest_ver = m.version.trim_start_matches('v');
                        let current_ver = if !sources_ver.is_empty() {
                            let sv = sources_ver.trim_start_matches('v');
                            if is_newer_version(manifest_ver, sv) { sv } else { manifest_ver }
                        } else {
                            manifest_ver
                        };
                        let nexus_ver = nv.trim_start_matches('v');

                        if current_ver != "unknown" && current_ver != "0.0.0"
                            && is_newer_version(current_ver, nexus_ver)
                        {
                            updates.push(ModUpdate {
                                mod_name: m.name.clone(),
                                current_version: m.version.clone(),
                                latest_version: nv.clone(),
                                source_type: "nexus".to_string(),
                                source_id: nexus_url.clone(),
                                download_url: format!("{}?tab=files", nexus_url),
                            });
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Nexus update check failed for {} (mod {}): {}", m.name, mod_id, e);
                }
            }
        }
    }

    Ok(updates)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Check all installed mods for available updates (GitHub + Nexus).
#[tauri::command]
pub async fn check_for_updates(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModUpdate>, String> {
    let (mods_path, config_path, token, nexus_key) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let nexus_key = s.nexus_api_key.clone();
        (mods_path, config_path, token, nexus_key)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    check_all_updates(&installed, &sources_db.mods, token.as_deref(), nexus_key.as_deref())
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
    let (mods_path, cache_path, config_path, token, nexus_key) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let nexus_key = s.nexus_api_key.clone();
        (mods_path, cache_path, config_path, token, nexus_key)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    let updates = check_all_updates(&installed, &sources_db.mods, token.as_deref(), nexus_key.as_deref())
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
    /// Nexus Mods URL if linked.
    pub nexus_url: Option<String>,
    /// Latest version reported by Nexus Mods API.
    pub nexus_version: Option<String>,
    /// Whether there's a newer version on Nexus vs installed.
    pub nexus_update_available: bool,
    /// Source type that flagged an update: "github", "nexus", or "both".
    pub update_source: Option<String>,
    /// Whether the GitHub link was auto-detected (informational only, not used for updates).
    pub github_auto_detected: bool,
    /// Whether this mod is pinned (excluded from update checks).
    pub pinned: bool,
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

    // Collect Nexus API key for Nexus version checking
    let nexus_api_key = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.nexus_api_key.clone()
    };

    for m in &all_mods {
        let source_entry = sources_db.mods.get(&m.name);
        let is_pinned = source_entry.map(|e| e.pinned).unwrap_or(false);
        let github_pair = resolve_github_repo(m, &sources_db.mods);

        // Also get auto-detected GitHub repo for display (even though it's not used for updates)
        let auto_detected_github = source_entry
            .filter(|e| e.github_auto_detected && e.github_repo.is_some())
            .and_then(|e| e.github_repo.clone());
        let is_auto_detected = auto_detected_github.is_some() && github_pair.is_none();

        // Resolve Nexus info from sources DB or manifest
        let nexus_url = source_entry
            .and_then(|e| e.nexus_url.clone())
            .or_else(|| m.nexus_url.clone());
        let nexus_game_domain = source_entry.and_then(|e| e.nexus_game_domain.clone());
        let nexus_mod_id = source_entry.and_then(|e| e.nexus_mod_id);

        let has_github = github_pair.is_some();
        let has_nexus = nexus_mod_id.is_some();
        let has_any_source = has_github || has_nexus || auto_detected_github.is_some() || nexus_url.is_some();

        // --- GitHub version check ---
        let mut github_repo_str: Option<String> = None;
        let mut latest_release_tag: Option<String> = None;
        let mut latest_release_with_assets_tag: Option<String> = None;
        let mut latest_has_mod_assets = false;
        let mut github_needs_update = false;
        let mut asset_names: Vec<String> = Vec::new();
        let mut total_scanned: u32 = 0;
        let mut github_error: Option<String> = None;

        if let Some((owner, repo)) = github_pair {
            let full_name = format!("{}/{}", owner, repo);
            github_repo_str = Some(full_name.clone());

            match fetch_latest_release(&owner, &repo, token.as_deref()).await {
                Ok(r) => {
                    latest_release_tag = Some(r.tag_name.clone());
                    latest_has_mod_assets = r.assets.iter().any(|a| is_mod_asset(&a.name));
                }
                Err(e) => {
                    github_error = Some(format!("Failed to fetch latest release: {}", e));
                }
            };

            if github_error.is_none() {
                // Scan paginated releases for first one with assets AND a valid version tag
                let max_pages: u32 = 3;
                let per_page: u32 = 30;

                'outer: for page in 1..=max_pages {
                    let releases = match fetch_releases(&owner, &repo, page, per_page, token.as_deref()).await {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    if releases.is_empty() { break; }

                    for release in &releases {
                        total_scanned += 1;
                        // Skip non-version tags (e.g. "dev-build", "nightly")
                        if !is_version_tag(&release.tag_name) {
                            continue;
                        }
                        if release.assets.iter().any(|a| is_mod_asset(&a.name)) {
                            latest_release_with_assets_tag = Some(release.tag_name.clone());
                            asset_names = release.assets.iter()
                                .filter(|a| is_mod_asset(&a.name))
                                .map(|a| a.name.clone())
                                .collect();
                            break 'outer;
                        }
                    }
                }

                // Determine if a GitHub update is needed using semver
                if let Some(ref assets_tag) = latest_release_with_assets_tag {
                    let latest_ver = assets_tag.trim_start_matches('v');
                    let current_ver = m.version.trim_start_matches('v');

                    let installed_ver_matches = sources_db
                        .mods
                        .get(&m.name)
                        .and_then(|e| e.installed_version.as_deref())
                        .map(|iv| iv.trim_start_matches('v') == latest_ver)
                        .unwrap_or(false);

                    if !installed_ver_matches
                        && current_ver != "unknown"
                        && current_ver != "0.0.0"
                    {
                        // Use semver comparison — only flag if latest > current
                        github_needs_update = is_newer_version(current_ver, latest_ver);
                    }
                }
            }
        }

        // --- Nexus version check ---
        let mut nexus_version: Option<String> = None;
        let mut nexus_update_available = false;

        if let (Some(ref domain), Some(mod_id)) = (nexus_game_domain, nexus_mod_id) {
            if let Some(ref nkey) = nexus_api_key {
                let client = crate::nexus::NexusClient::new(nkey);
                match client.get_mod_info(domain, mod_id).await {
                    Ok(info) => {
                        if let Some(ref nv) = info.version {
                            nexus_version = Some(nv.clone());
                            // Use the best known version: check mod_sources installed_version
                            // first (tracks what was actually downloaded), then fall back to
                            // the manifest version on disk (which mod authors don't always update).
                            let sources_ver = source_entry
                                .and_then(|e| e.installed_version.as_deref())
                                .unwrap_or("");
                            let manifest_ver = m.version.trim_start_matches('v');
                            let current_ver = if !sources_ver.is_empty() {
                                // Use whichever is higher: sources DB or manifest
                                let sv = sources_ver.trim_start_matches('v');
                                if is_newer_version(manifest_ver, sv) { sv } else { manifest_ver }
                            } else {
                                manifest_ver
                            };
                            let nexus_ver = nv.trim_start_matches('v');
                            if current_ver != "unknown" && current_ver != "0.0.0" {
                                nexus_update_available = is_newer_version(current_ver, nexus_ver);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("Nexus API check failed for {} (mod {}): {}", m.name, mod_id, e);
                    }
                }
            }
        }

        let needs_update = !is_pinned && (github_needs_update || nexus_update_available);
        let update_source = if github_needs_update && nexus_update_available {
            Some("both".to_string())
        } else if github_needs_update {
            Some("github".to_string())
        } else if nexus_update_available {
            Some("nexus".to_string())
        } else {
            None
        };

        // If no source at all, still include in report
        if !has_any_source {
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
                nexus_url: None,
                nexus_version: None,
                nexus_update_available: false,
                update_source: None,
                github_auto_detected: false,
                pinned: is_pinned,
            });
            continue;
        }

        // For display: use the verified GitHub repo, or fall back to auto-detected for informational display
        let display_github = github_repo_str.clone().or(auto_detected_github);

        // If GitHub errored (e.g. 404) but we have Nexus data, suppress the GitHub error —
        // the Nexus check is the authority. Also mark as auto-detected so UI treats it as informational.
        let (final_error, final_auto_detected) = if github_error.is_some() && (nexus_url.is_some() || nexus_version.is_some()) {
            (None, true) // suppress error, mark GitHub as informational
        } else {
            (github_error, is_auto_detected)
        };

        results.push(ModAuditEntry {
            mod_name: m.name.clone(),
            github_repo: display_github,
            installed_version: m.version.clone(),
            latest_release_tag,
            latest_release_with_assets_tag,
            latest_has_assets: latest_has_mod_assets,
            needs_update,
            asset_names,
            releases_scanned: total_scanned,
            error: final_error,
            nexus_url,
            nexus_version,
            nexus_update_available,
            update_source,
            github_auto_detected: final_auto_detected,
            pinned: is_pinned,
        });
    }

    Ok(results)
}
