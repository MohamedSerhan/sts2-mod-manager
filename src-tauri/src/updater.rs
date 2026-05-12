use serde::{Deserialize, Serialize};

use crate::download::{fetch_latest_release, fetch_releases};
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

/// Returns true iff a mod declaring `min_game_version = required` can run
/// on a player whose game version is `current`. Both arguments are
/// semver-ish strings ("0.103.2", "v0.105.0") — we strip the leading "v"
/// and compare numerically.
///
/// Fails OPEN on parse errors: if either version doesn't parse, we assume
/// compatible. The audit/Repair codepath would rather show a row than
/// hide a real one because of a quirky version string.
pub fn game_version_satisfies(current: &str, required: &str) -> bool {
    match (parse_version(current), parse_version(required)) {
        (Some(cur), Some(req)) => cur >= req,
        _ => true,
    }
}

/// Returns true iff `info` (a freshly-installed mod) declares a
/// `min_game_version` higher than the user's `user_game_version` —
/// i.e. the install landed but the game's loader will silently skip
/// it. `None` user version = we don't know, fail open (return false).
pub fn install_is_incompatible(
    info: &crate::mods::ModInfo,
    user_game_version: Option<&str>,
) -> bool {
    match (user_game_version, info.min_game_version.as_deref()) {
        (Some(gv), Some(req)) => !game_version_satisfies(gv, req),
        _ => false,
    }
}

// ── Types ───────────────────────────────────────────────────────────────────

/// Describes an available update for an installed mod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModUpdate {
    pub mod_name: String,
    /// On-disk folder of the mod that needs an update. Carries through so
    /// `update_all_mods` (and any single-mod follow-up) can target the
    /// exact install when two mods share a display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
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
    // Track which mods already got a GitHub update so we don't double-list.
    // Keyed by folder_name (falling back to display name) so two mods sharing
    // a display name don't suppress each other from the Nexus pass.
    let mut github_updated: std::collections::HashSet<String> = std::collections::HashSet::new();
    let dedup_id = |m: &ModInfo| m.folder_name.clone().unwrap_or_else(|| m.name.clone());

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

        github_updated.insert(dedup_id(m));
        updates.push(ModUpdate {
            mod_name: m.name.clone(),
            folder_name: m.folder_name.clone(),
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
            if github_updated.contains(&dedup_id(m)) {
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
                                folder_name: m.folder_name.clone(),
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

/// Download and install the newest version of a specific mod from its
/// GitHub source that's compatible with the user's Slay the Spire 2 build.
///
/// This walks releases newest → oldest (same logic as `repair_mod`) so a
/// curator's freshly-published release that requires a beta game build
/// doesn't get installed on a stable-branch user — that produced the
/// "vunknown" stub state that Repair was invented to fix in the first
/// place. The Update button in the audit calls this; we only refuse if
/// the walk-back lands on a tag the user already has.
///
/// When `game_version` is unknown (release_info.json missing) we fail
/// open and grab the latest release, mirroring legacy update_mod
/// behavior. Logged so we know we skipped the check.
#[tauri::command]
pub async fn update_mod(
    name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path, config_path, token, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let game_version = s.game_version.clone();
        (mods_path, cache_path, config_path, token, game_version)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);

    // Folder-first lookup so update_mod targets the exact install when two
    // mods share a display name (e.g. two CardArtEditor installs with
    // different GitHub sources).
    let mod_info = if let Some(ref folder) = folder_name {
        installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
    } else {
        installed.iter().find(|m| m.name == name)
    }
    .ok_or_else(|| format!("Mod '{}' not found", name))?;

    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods)
        .ok_or_else(|| format!("Mod '{}' has no GitHub source linked. Link one in the Mods view.", name))?;

    // Resolve which tag we'll actually install BEFORE deleting the old
    // copy — same shape as repair_mod. If the walk-back can't find any
    // compatible release, we want the user to keep what they had.
    let chosen_tag: String;
    let chosen_zip: std::path::PathBuf;
    let chosen_mgv: Option<String>;
    if game_version.is_some() {
        let chosen = pick_compatible_release(
            &owner,
            &repo,
            game_version.as_deref(),
            &cache_path,
            token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;

        // If the walk-back picked the version the user already has, refuse
        // the update — the audit's "needs_update" flag was based on the
        // absolute latest release, which the user can't run. Tell them so
        // they understand why nothing changed.
        let installed_tag = sources_db
            .mods
            .get(&name)
            .and_then(|e| e.installed_version.as_deref())
            .map(|s| s.trim_start_matches('v'))
            .unwrap_or("");
        let manifest_ver = mod_info.version.trim_start_matches('v');
        let chosen_ver = chosen.tag.trim_start_matches('v');
        let already_on_chosen = chosen_ver == installed_tag || chosen_ver == manifest_ver;
        if already_on_chosen {
            return Err(format!(
                "Already on the newest version compatible with your Slay the Spire 2 build (v{}). \
                 The latest release of {}/{} requires a newer game version{} — update Slay the Spire 2 \
                 (or switch Steam beta branches) to pick up the newer mod release.",
                chosen.tag, owner, repo,
                chosen.min_game_version
                    .as_ref()
                    .map(|v| format!(" (min v{})", v))
                    .unwrap_or_default(),
            ));
        }

        chosen_tag = chosen.tag;
        chosen_mgv = chosen.min_game_version;
        chosen_zip = chosen.zip_path;
    } else {
        // Fail open: no game version means we can't compare. Grab latest.
        let release = fetch_latest_release(&owner, &repo, token.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        let tag = release.tag_name.clone();
        log::warn!(
            "update_mod: no game_version detected — installing latest {}/{}@{} without compatibility check",
            owner, repo, tag,
        );
        chosen_zip = crate::download::download_release_zip_to_cache(
            &owner, &repo, &tag, &cache_path, token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
        chosen_mgv = crate::download::peek_zip_min_game_version(&chosen_zip)
            .ok()
            .flatten();
        chosen_tag = tag;
    }

    // Delete the old mod files before installing the update to prevent duplicates
    // (e.g., old mod in "ModConfig-v0.2.1/" and new one in "ModConfig-v0.2.2/").
    // Reuse the same folder-first resolution so two same-named mods don't
    // step on each other.
    {
        let old_info = if let Some(ref folder) = folder_name {
            installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
        } else {
            installed.iter().find(|m| m.name == name)
        };
        if let Some(old_info) = old_info {
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
                if dir.is_dir()
                    && std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
                {
                    let _ = std::fs::remove_dir(dir);
                }
            }
            if let Some(folder) = old_info.folder_name.as_deref() {
                let folder_path = mods_path.join(folder);
                if folder_path.is_dir() {
                    let _ = std::fs::remove_dir_all(&folder_path);
                }
            }
            log::info!("Deleted old files for '{}' before updating", name);
        }
    }

    log::info!(
        "update_mod: installing {}/{}@{} for {} (game v{}, min_game_version={})",
        owner, repo, chosen_tag, name,
        game_version.as_deref().unwrap_or("?"),
        chosen_mgv.as_deref().unwrap_or("none"),
    );
    let info = crate::mods::install_mod_from_zip(&chosen_zip, &mods_path)
        .map_err(|e| e.to_string())?;

    // Only record the new installed_version if the install RESULT looks
    // healthy. install_mod_from_zip falls through to a stub with
    // version="unknown" when it can't parse the manifest — bumping
    // installed_version in that case loses the previously-known-good
    // version and breaks future Repair walk-backs (we end up not knowing
    // which version was last working).
    let install_healthy = info.version != "unknown" && !info.version.is_empty();
    if install_healthy {
        // Write under folder_name when available so the installed_version
        // travels with the same DB key the pin lookup uses (folder-first).
        let install_key = info.folder_name.as_deref().unwrap_or(name.as_str());
        update_installed_version(install_key, &chosen_tag, &config_path);
        if info.name != name {
            // When the install renamed the mod (manifest's Name field changed
            // between releases — e.g. "STS2-ShowPlayerHandCards" → "Highlight
            // Card Types in Potion Description"), carry the source link / pin /
            // version over so the audit doesn't lose track and report "no
            // source" on the freshly-installed copy.
            crate::mod_sources::migrate_source_entry(&name, &info.name, &config_path);
            update_installed_version(&info.name, &chosen_tag, &config_path);
        }
    } else {
        log::warn!(
            "update_mod: install of '{}' from {}/{}@{} produced an unhealthy ModInfo (version='{}'); \
             leaving installed_version untouched so the previously-recorded value survives for Repair walk-back.",
            name, owner, repo, chosen_tag, info.version,
        );
    }

    Ok(info)
}

/// Force-reinstall a mod from its linked GitHub source, picking the
/// LATEST RELEASE COMPATIBLE WITH THE USER'S GAME VERSION.
///
/// This is meaningfully different from `update_mod`:
///
/// - `update_mod` always grabs the latest release. If that release
///   declares `min_game_version` higher than what the user's STS2 ships,
///   the install lands on disk but the game's loader silently skips it.
///   That's the bug that produced the `STS2-ShowPlayerHandCards` "vunknown"
///   stub state in v1.0.x.
///
/// - `repair_mod` walks the release list newest → oldest. For each
///   candidate, it downloads the zip into a tag-scoped cache slot and
///   peeks the manifest's `min_game_version`. The first compatible one
///   wins. We extract THAT into the live mods folder.
///
/// Failure modes:
///
/// - User has no game_version detected (release_info.json missing) →
///   we fail open and behave like `update_mod` (install latest). Logged.
/// - No compatible release found across the whole release list →
///   return an error WITHOUT touching the existing on-disk install.
///   The user keeps whatever they had before clicking Repair.
/// - Download or peek fails for a candidate → log + skip, try the next
///   candidate. We don't bail on a single transient error.
#[tauri::command]
pub async fn repair_mod(
    name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    log::info!(
        "repair_mod: walk-back repair requested for '{}' (folder: {:?})",
        name, folder_name,
    );
    crate::game::ensure_game_not_running()?;

    let (mods_path, cache_path, config_path, token, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let game_version = s.game_version.clone();
        (mods_path, cache_path, config_path, token, game_version)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    // Folder-first lookup so repair targets the exact install when two
    // mods share a display name. Without this, repair would delete and
    // re-extract whichever copy happens to scan first, possibly nuking
    // the mod the user wasn't trying to fix.
    let mod_info = if let Some(ref folder) = folder_name {
        installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
    } else {
        installed.iter().find(|m| m.name == name)
    }
    .ok_or_else(|| format!("Mod '{}' not found", name))?;
    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods)
        .ok_or_else(|| format!("Mod '{}' has no GitHub source linked. Link one in the Mods view.", name))?;

    // Pick the candidate tag we're going to install BEFORE touching disk.
    // If the walk-back finds nothing compatible, we return an error and
    // the user keeps their existing install untouched.
    let chosen = pick_compatible_release(
        &owner,
        &repo,
        game_version.as_deref(),
        &cache_path,
        token.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    log::info!(
        "repair_mod: walk-back chose tag {} for {}/{} (game v{}; min_game_version on chosen release: {})",
        chosen.tag, owner, repo,
        game_version.as_deref().unwrap_or("?"),
        chosen.min_game_version.as_deref().unwrap_or("none"),
    );

    // Now safe to delete the broken install. Reuse the same folder-first
    // lookup we did above so we delete the exact mod we resolved earlier.
    {
        let old_info = if let Some(ref folder) = folder_name {
            installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
        } else {
            installed.iter().find(|m| m.name == name)
        };
        if let Some(old_info) = old_info {
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
                if dir.is_dir()
                    && std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
                {
                    let _ = std::fs::remove_dir(dir);
                }
            }
            if let Some(folder) = old_info.folder_name.as_deref() {
                let folder_path = mods_path.join(folder);
                if folder_path.is_dir() {
                    let _ = std::fs::remove_dir_all(&folder_path);
                }
            }
            log::info!("repair_mod: deleted old files for '{}'", name);
        }
    }

    // Extract the cached candidate into the live mods folder.
    let info = crate::mods::install_mod_from_zip(&chosen.zip_path, &mods_path)
        .map_err(|e| e.to_string())?;

    // Same healthy-install gate as update_mod — only persist installed_version
    // when the manifest parsed cleanly.
    let install_healthy = info.version != "unknown" && !info.version.is_empty();
    if install_healthy {
        // Folder-first key for the same reason as update_mod above.
        let install_key = info.folder_name.as_deref().unwrap_or(name.as_str());
        crate::mod_sources::update_installed_version(install_key, &chosen.tag, &config_path);
        if info.name != name {
            crate::mod_sources::migrate_source_entry(&name, &info.name, &config_path);
            crate::mod_sources::update_installed_version(&info.name, &chosen.tag, &config_path);
        }
    } else {
        log::warn!(
            "repair_mod: install of '{}' from {}/{}@{} produced an unhealthy ModInfo (version='{}'); \
             leaving installed_version untouched.",
            name, owner, repo, chosen.tag, info.version,
        );
    }

    Ok(info)
}

/// Result of the walk-back: which release we picked + the path to its
/// cached zip (already on disk, ready to extract).
pub struct WalkBackChoice {
    pub tag: String,
    pub min_game_version: Option<String>,
    pub zip_path: std::path::PathBuf,
}

/// Walk a repo's release list newest → oldest, return the first release
/// whose manifest's `min_game_version` is satisfied by the user's
/// `game_version`. Releases with NO declared `min_game_version` always
/// pass (the mod doesn't care which build it runs on).
///
/// If `game_version` is None we can't compare — return the latest release
/// to mirror the legacy update_mod behavior. Logged so we know we
/// skipped the check.
pub async fn pick_compatible_release(
    owner: &str,
    repo: &str,
    game_version: Option<&str>,
    cache_path: &std::path::Path,
    token: Option<&str>,
) -> crate::error::Result<WalkBackChoice> {
    // Cap how far we walk so a misconfigured repo doesn't make us pull
    // hundreds of zips. 30 covers the common cases (mods rarely have more
    // than a year of weekly releases).
    const MAX_RELEASES_TO_WALK: usize = 30;
    const PER_PAGE: u32 = 30;

    let releases = crate::download::fetch_releases(owner, repo, 1, PER_PAGE, token).await?;
    if releases.is_empty() {
        return Err(crate::error::AppError::Other(format!(
            "{}/{} has no releases",
            owner, repo
        )));
    }

    let mut last_required: Option<String> = None;
    for release in releases.iter().take(MAX_RELEASES_TO_WALK) {
        let tag = release.tag_name.as_str();
        let zip_path = match crate::download::download_release_zip_to_cache(
            owner, repo, tag, cache_path, token,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "Walk-back: skipping {}/{}@{} (download failed: {})",
                    owner, repo, tag, e
                );
                continue;
            }
        };
        let mgv = match crate::download::peek_zip_min_game_version(&zip_path) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "Walk-back: skipping {}/{}@{} (manifest peek failed: {})",
                    owner, repo, tag, e
                );
                continue;
            }
        };

        let compatible = match (game_version, mgv.as_deref()) {
            (_, None) => true, // mod doesn't care
            (None, Some(_)) => true, // we don't know game version → fail open
            (Some(gv), Some(req)) => game_version_satisfies(gv, req),
        };
        if compatible {
            return Ok(WalkBackChoice {
                tag: tag.to_string(),
                min_game_version: mgv,
                zip_path,
            });
        }
        last_required = mgv.or(last_required);
        log::info!(
            "Walk-back: {}/{}@{} requires game v{} (you have v{}), trying older release",
            owner, repo, tag,
            last_required.as_deref().unwrap_or("?"),
            game_version.unwrap_or("?"),
        );
    }

    Err(crate::error::AppError::Other(format!(
        "No release of {}/{} is compatible with your game (v{}). \
         Lowest required minimum we saw: v{}. Update Slay the Spire 2 \
         (or switch Steam beta branches) and try again.",
        owner, repo,
        game_version.unwrap_or("?"),
        last_required.as_deref().unwrap_or("?"),
    )))
}

/// Update all mods that have available GitHub updates.
///
/// Per-mod walk-back: each candidate goes through `pick_compatible_release`
/// so we never install a release that requires a newer Slay the Spire 2
/// build than the user has. If the walk-back lands on the version the user
/// is already on, the mod is skipped (the audit's "needs_update" was based
/// on the absolute latest tag which the user can't run). Skipped mods are
/// logged but don't fail the batch.
#[tauri::command]
pub async fn update_all_mods(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModInfo>, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path, config_path, token, nexus_key, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let nexus_key = s.nexus_api_key.clone();
        let game_version = s.game_version.clone();
        (mods_path, cache_path, config_path, token, nexus_key, game_version)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    let updates = check_all_updates(&installed, &sources_db.mods, token.as_deref(), nexus_key.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for update in &updates {
        // Skip Nexus updates here — the curator workflow's "Update all"
        // is the GitHub auto-update path; Nexus updates require user
        // interaction (Slow Download / Manual) and surface separately.
        if update.source_type != "github" {
            continue;
        }

        let (owner, repo) = match parse_owner_repo(&update.source_id) {
            Some(pair) => pair,
            None => continue,
        };

        // Walk-back: find the newest release compatible with the user's
        // game version. Falls open to absolute-latest when game_version
        // is unknown.
        let (chosen_tag, chosen_zip) = if game_version.is_some() {
            match pick_compatible_release(
                &owner,
                &repo,
                game_version.as_deref(),
                &cache_path,
                token.as_deref(),
            )
            .await
            {
                Ok(c) => {
                    // Resolve installed_version + manifest version folder-first so
                    // we compare against the EXACT mod we'd be updating, not
                    // whichever same-named mod scans first.
                    let installed_tag = update.folder_name.as_ref()
                        .and_then(|f| sources_db.mods.get(f))
                        .or_else(|| sources_db.mods.get(&update.mod_name))
                        .and_then(|e| e.installed_version.as_deref())
                        .map(|s| s.trim_start_matches('v'))
                        .unwrap_or("");
                    let manifest_ver = if let Some(ref folder) = update.folder_name {
                        installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
                    } else {
                        installed.iter().find(|m| m.name == update.mod_name)
                    }
                    .map(|m| m.version.trim_start_matches('v'))
                    .unwrap_or("");
                    let chosen_ver = c.tag.trim_start_matches('v');
                    if chosen_ver == installed_tag || chosen_ver == manifest_ver {
                        log::info!(
                            "update_all_mods: skipping '{}' — already on newest compatible release (chosen {}, latest {} requires newer game)",
                            update.mod_name, c.tag, update.latest_version,
                        );
                        continue;
                    }
                    (c.tag, c.zip_path)
                }
                Err(e) => {
                    log::error!(
                        "update_all_mods: walk-back failed for '{}' ({}/{}): {}",
                        update.mod_name, owner, repo, e
                    );
                    continue;
                }
            }
        } else {
            log::warn!(
                "update_all_mods: no game_version detected — installing latest {}/{}@{} without compatibility check",
                owner, repo, update.latest_version,
            );
            let zip = match crate::download::download_release_zip_to_cache(
                &owner, &repo, &update.latest_version, &cache_path, token.as_deref(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    log::error!(
                        "update_all_mods: download failed for '{}' ({}/{}@{}): {}",
                        update.mod_name, owner, repo, update.latest_version, e,
                    );
                    continue;
                }
            };
            (update.latest_version.clone(), zip)
        };

        // Delete old files before extracting the new zip — same shape as
        // update_mod / repair_mod. Folder-first lookup so two same-named
        // mods don't accidentally share or steal each other's installs.
        let old_info_opt = if let Some(ref folder) = update.folder_name {
            installed.iter().find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
        } else {
            installed.iter().find(|m| m.name == update.mod_name)
        };
        if let Some(old_info) = old_info_opt {
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
                if dir.is_dir()
                    && std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
                {
                    let _ = std::fs::remove_dir(dir);
                }
            }
            if let Some(folder) = old_info.folder_name.as_deref() {
                let folder_path = mods_path.join(folder);
                if folder_path.is_dir() {
                    let _ = std::fs::remove_dir_all(&folder_path);
                }
            }
        }

        match crate::mods::install_mod_from_zip(&chosen_zip, &mods_path) {
            Ok(info) => {
                let install_healthy = info.version != "unknown" && !info.version.is_empty();
                if !install_healthy {
                    log::warn!(
                        "update_all_mods: '{}' from {}/{}@{} produced an unhealthy ModInfo (version='{}'); \
                         leaving installed_version untouched.",
                        update.mod_name, owner, repo, chosen_tag, info.version,
                    );
                    results.push(info);
                    continue;
                }

                if info.name != update.mod_name {
                    crate::mod_sources::migrate_source_entry(
                        &update.mod_name,
                        &info.name,
                        &config_path,
                    );
                }
                let mut db = load_sources(&config_path);
                // Write under folder_name when available — keeps two
                // same-named mods independent in the sources DB and matches
                // the folder-first read path in enrich_mods_with_sources.
                let key = info.folder_name.clone().unwrap_or_else(|| info.name.clone());
                let entry = db.mods.entry(key).or_default();
                entry.github_repo = Some(format!("{}/{}", owner, repo));
                entry.installed_version = Some(chosen_tag.clone());
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
    /// On-disk folder name for the installed mod. Surfaced so the UI can
    /// disambiguate (and pin/unpin) two mods that share a display name
    /// but live in different folders — without this, Settings would pin
    /// both same-named entries simultaneously.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
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
    /// `min_game_version` declared by the installed mod's manifest, if any.
    /// None when the mod doesn't care which build it runs on (older mods
    /// often omit this).
    #[serde(default)]
    pub min_game_version: Option<String>,
    /// True iff the installed mod declares a `min_game_version` that the
    /// user's STS2 build doesn't satisfy. Drives the "won't load" warning
    /// row in the audit. Always false when we couldn't detect the game's
    /// version (we fail open in that case).
    #[serde(default)]
    pub game_version_too_old: bool,
    /// `min_game_version` declared by the latest GitHub release that has
    /// downloadable assets. Read by peeking the release zip's manifest
    /// during the audit. None = release didn't declare one (mod doesn't
    /// care) OR we couldn't peek (download/parse failed).
    #[serde(default)]
    pub latest_release_min_game_version: Option<String>,
    /// True iff `latest_release_with_assets_tag` declares a `min_game_version`
    /// the user's STS2 build doesn't satisfy. When this is true, clicking
    /// Update on the row will walk back to an older compatible release —
    /// which `latest_compatible_tag` (below) names so the UI can preview
    /// the actual-installable version.
    #[serde(default)]
    pub latest_release_blocked_by_game_version: bool,
    /// The tag the Update button will actually install — i.e. the newest
    /// release whose `min_game_version` is satisfied by the user's game.
    /// Equal to `latest_release_with_assets_tag` when that release is
    /// compatible. None when no release in the walked-back window is
    /// compatible (the row falls back to "Repair" semantics).
    #[serde(default)]
    pub latest_compatible_tag: Option<String>,
}

/// Valid mod asset extensions for STS2 mods.
fn is_mod_asset(name: &str) -> bool {
    name.ends_with(".zip") || name.ends_with(".dll") || name.ends_with(".pck")
}

/// Audit installed mods against their latest GitHub releases.
///
/// For each mod with a GitHub source, fetches releases (paginated) to find
/// the most recent release that actually has downloadable mod files
/// (.zip, .dll, .pck). This validates that the update-checking logic
/// correctly skips empty releases.
///
/// `only` — optional whitelist of mod names. When `Some(names)` we audit
/// only those mods (used by the UI to refresh just the rows that changed
/// after a single-mod or bulk update, instead of forcing a full audit
/// every time). When `None` we audit every installed mod.
#[tauri::command]
pub async fn audit_mod_versions(
    only: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModAuditEntry>, String> {
    let (mods_path, disabled_path, config_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone();
        let config_path = s.config_path.clone();
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods_path, disabled_path, config_path, cache_path, token)
    };

    // Scan both enabled and disabled mods
    let mut all_mods = scan_mods(&mods_path);
    if let Some(ref dp) = disabled_path {
        let disabled = scan_mods(dp);
        all_mods.extend(disabled);
    }

    // If the caller asked for a subset, prune everything else up front so
    // we skip the (slow) per-mod GitHub/Nexus calls for mods we don't care
    // about right now.
    if let Some(filter) = only.as_ref() {
        let want: std::collections::HashSet<&str> =
            filter.iter().map(|s| s.as_str()).collect();
        all_mods.retain(|m| want.contains(m.name.as_str()));
    }

    let sources_db = load_sources(&config_path);
    let mut results: Vec<ModAuditEntry> = Vec::new();

    // Collect Nexus API key + the user's detected game version. The game
    // version drives the per-row "won't load on your build" flag — None
    // means we couldn't read release_info.json, in which case we
    // fail-open (every mod is treated as compatible) rather than blocking
    // every row on a guess.
    let (nexus_api_key, user_game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.nexus_api_key.clone(), s.game_version.clone())
    };

    for m in &all_mods {
        // Source-entry lookup is folder-first to match enrich_mods_with_sources
        // and the pin_mod write path. Otherwise a mod pinned from the Mods view
        // (saved under its folder_name) wouldn't show as pinned in this audit,
        // and the Settings unpin click would no-op because we'd hand back a
        // pinned=false to the UI for an entry that IS pinned in the DB.
        let source_entry = m.folder_name.as_ref()
            .and_then(|f| sources_db.mods.get(f))
            .or_else(|| sources_db.mods.get(&m.name))
            .or_else(|| m.mod_id.as_ref().and_then(|i| sources_db.mods.get(i)));
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
        // Walk-back / compat fields. Populated below when we have an
        // actionable github_needs_update on a row whose latest release
        // declares a min_game_version higher than the user's STS2 build.
        let mut latest_release_min_game_version: Option<String> = None;
        let mut latest_release_blocked_by_game_version = false;
        let mut latest_compatible_tag: Option<String> = None;

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

                // Compat walk-back — runs only when the basic GitHub check
                // already says an update is available. Cheap when nothing's
                // pending; one zip download (cached) when something is.
                //
                // We peek the latest release with assets first. If its
                // declared min_game_version is satisfied, we're done — that
                // tag is what Update will install. If it's too high for
                // the user's STS2 build, we walk back to find the newest
                // compatible tag and flag the row so the UI can show
                // "Latest vY needs game vZ; will install vX (compatible)".
                if github_needs_update {
                    if let Some(ref assets_tag) = latest_release_with_assets_tag.clone() {
                        match crate::download::download_release_zip_to_cache(
                            &owner, &repo, assets_tag, &cache_path, token.as_deref(),
                        )
                        .await
                        {
                            Ok(zip_path) => {
                                let peeked = crate::download::peek_zip_min_game_version(&zip_path)
                                    .ok()
                                    .flatten();
                                latest_release_min_game_version = peeked.clone();
                                let compatible = match (user_game_version.as_deref(), peeked.as_deref()) {
                                    (_, None) => true,
                                    (None, Some(_)) => true,
                                    (Some(gv), Some(req)) => game_version_satisfies(gv, req),
                                };
                                if compatible {
                                    latest_compatible_tag = Some(assets_tag.clone());
                                } else {
                                    latest_release_blocked_by_game_version = true;
                                    // Walk back from latest. Reuses cache,
                                    // so we don't re-download what we
                                    // already peeked.
                                    match pick_compatible_release(
                                        &owner, &repo,
                                        user_game_version.as_deref(),
                                        &cache_path, token.as_deref(),
                                    )
                                    .await
                                    {
                                        Ok(walk) => {
                                            // Re-evaluate whether the walked-
                                            // back tag is actually newer than
                                            // installed. If not, drop the
                                            // update flag — the user already
                                            // has the newest compatible
                                            // release; the only thing newer
                                            // is the blocked latest. Setting
                                            // latest_compatible_tag = None in
                                            // that case signals "no installable
                                            // GitHub update" to the UI, which
                                            // hides the Update button and
                                            // switches the hint copy to
                                            // "you're already on the newest
                                            // compatible".
                                            let installed_tag = sources_db
                                                .mods
                                                .get(&m.name)
                                                .and_then(|e| e.installed_version.as_deref())
                                                .map(|s| s.trim_start_matches('v'))
                                                .unwrap_or("");
                                            let manifest_ver = m.version.trim_start_matches('v');
                                            let walk_ver = walk.tag.trim_start_matches('v');
                                            if walk_ver == installed_tag || walk_ver == manifest_ver {
                                                github_needs_update = false;
                                                latest_compatible_tag = None;
                                            } else {
                                                latest_compatible_tag = Some(walk.tag.clone());
                                            }
                                        }
                                        Err(e) => {
                                            log::warn!(
                                                "audit: walk-back failed for {}/{} (game v{}): {}",
                                                owner, repo,
                                                user_game_version.as_deref().unwrap_or("?"), e,
                                            );
                                            // Couldn't find a compatible
                                            // release — drop the update flag
                                            // since clicking Update would
                                            // produce a broken install.
                                            github_needs_update = false;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!(
                                    "audit: failed to peek {}/{}@{} for compat check: {}",
                                    owner, repo, assets_tag, e,
                                );
                                // Peek failed → keep github_needs_update as
                                // the basic check decided. Update flow has
                                // its own walk-back as a final safety net.
                            }
                        }
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
                        // For mod pages that host multiple variants under one
                        // mod_id (e.g. "BetterSpire2" + "BetterSpire2Lite"),
                        // the page-level `version` field is one number for
                        // the latest-uploaded file regardless of variant.
                        // Look at the file list and pick the version that
                        // matches the LOCAL mod's flavor — otherwise the
                        // user's lite install gets compared against the
                        // non-lite version and shows a bogus mismatch.
                        let mut effective_version = info.version.clone();
                        match client.get_mod_files(domain, mod_id).await {
                            Ok(files) => {
                                if let Some(picked) =
                                    crate::nexus::pick_version_for_local_mod(&files, &m.name)
                                {
                                    if effective_version.as_deref() != Some(picked.as_str()) {
                                        log::debug!(
                                            "Nexus variant pick for '{}' (mod_id {}): page version {:?} → file version {:?}",
                                            m.name, mod_id, info.version, picked
                                        );
                                    }
                                    effective_version = Some(picked);
                                }
                            }
                            Err(e) => {
                                log::warn!(
                                    "Nexus files lookup failed for '{}' (mod {}): {} — falling back to page version",
                                    m.name, mod_id, e
                                );
                            }
                        }

                        if let Some(ref nv) = effective_version {
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
                            // Nexus and GitHub typically host the same
                            // mod release at the same version. If the
                            // GitHub side proved that release is blocked
                            // by min_game_version, the Nexus zip is the
                            // same incompatible build — suppress the
                            // "Download from Nexus" prompt so we don't
                            // send the user to install something we
                            // know won't load. We require the version
                            // numbers to match (≥, since Nexus could
                            // have an even newer one in flight, but
                            // that's rare); a stricter equality check
                            // would miss the simple case where mod
                            // authors round-trip the same vX.Y.Z to
                            // both hosts.
                            if nexus_update_available
                                && latest_release_blocked_by_game_version
                                && !is_newer_version(
                                    latest_release_with_assets_tag
                                        .as_deref()
                                        .unwrap_or("")
                                        .trim_start_matches('v'),
                                    nexus_ver,
                                )
                            {
                                log::info!(
                                    "audit: suppressing Nexus update for '{}' — Nexus v{} matches \
                                     GitHub's game-version-blocked latest v{}",
                                    m.name, nexus_ver,
                                    latest_release_with_assets_tag.as_deref().unwrap_or("?"),
                                );
                                nexus_update_available = false;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("Nexus API check failed for {} (mod {}): {}", m.name, mod_id, e);
                    }
                }
            }
        }

        // If no source at all, still include in report
        if !has_any_source {
            results.push(ModAuditEntry {
                mod_name: m.name.clone(),
                folder_name: m.folder_name.clone(),
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
                min_game_version: m.min_game_version.clone(),
                game_version_too_old: matches!(
                    (user_game_version.as_deref(), m.min_game_version.as_deref()),
                    (Some(gv), Some(req)) if !game_version_satisfies(gv, req)
                ),
                latest_release_min_game_version: None,
                latest_release_blocked_by_game_version: false,
                latest_compatible_tag: None,
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

        let min_game_version = m.min_game_version.clone();
        let game_version_too_old = matches!(
            (user_game_version.as_deref(), min_game_version.as_deref()),
            (Some(gv), Some(req)) if !game_version_satisfies(gv, req)
        );
        // Compute needs_update + update_source AFTER the walk-back has had
        // a chance to drop github_needs_update (it does so when the only
        // newer release is incompatible, or when the walked-back tag is
        // already what's installed).
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
        results.push(ModAuditEntry {
            mod_name: m.name.clone(),
            folder_name: m.folder_name.clone(),
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
            min_game_version,
            game_version_too_old,
            latest_release_min_game_version,
            latest_release_blocked_by_game_version,
            latest_compatible_tag,
        });
    }

    Ok(results)
}
