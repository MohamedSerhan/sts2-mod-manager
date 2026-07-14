use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::download::{fetch_latest_release, fetch_releases};
use crate::error::Result;
use crate::mod_sources::{load_sources, lookup_entry, ModSourceEntry};
use crate::mods::{
    merge_active_disabled_mods, scan_disabled_mods, scan_mods, ModInfo, ModInstallSource,
};
use crate::state::AppState;
use std::path::Path;

// ── Version Comparison ─────────────────────────────────────────────────────

/// Try to parse a version string into a semver::Version.
/// Handles common variants: "1.2.3", "v1.2.3", "V29", "1.2", "1".
fn strip_version_prefix(v: &str) -> &str {
    v.trim().trim_start_matches(['v', 'V'])
}

fn parse_version(v: &str) -> Option<semver::Version> {
    let stripped = strip_version_prefix(v);
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

fn is_walk_back_release_candidate(release: &crate::download::GitHubRelease) -> bool {
    is_version_tag(&release.tag_name) && release.assets.iter().any(|a| is_mod_asset(&a.name))
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

/// Lenient version parse for GAME build strings. Steam beta branches
/// suffix the build number ("0.106.1b", "0.106.1-beta.4257"), which the
/// strict semver parse rejects — and a None game version silently
/// disables every compatibility check downstream (the audit fails open,
/// and asset selection skips the Compat-variant branch entirely, which
/// is how a beta-branch user ended up with RitsuLib's latest-game main
/// file instead of the matching Compat build). Takes the leading digits
/// of each of the first three dot components; requires a numeric major.
pub(crate) fn parse_loose_version(v: &str) -> Option<semver::Version> {
    let stripped = v.trim().trim_start_matches(['v', 'V']);
    let mut nums = stripped.split('.').map(|part| {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse::<u64>().ok()
    });
    let major = nums.next().flatten()?;
    let minor = nums.next().flatten().unwrap_or(0);
    let patch = nums.next().flatten().unwrap_or(0);
    Some(semver::Version::new(major, minor, patch))
}

/// Returns true iff a mod declaring `min_game_version = required` can run
/// on a player whose game version is `current`. Both arguments are
/// semver-ish strings ("0.103.2", "v0.105.0", beta-suffixed "0.106.1b") —
/// we strip the leading "v", tolerate non-numeric suffixes, and compare
/// numerically.
///
/// Fails OPEN on parse errors: if either version doesn't parse, we assume
/// compatible. The audit/Repair codepath would rather show a row than
/// hide a real one because of a quirky version string.
pub fn game_version_satisfies(current: &str, required: &str) -> bool {
    match (parse_loose_version(current), parse_loose_version(required)) {
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

fn validate_update_install_result(
    old_info: &ModInfo,
    new_info: &ModInfo,
    user_game_version: Option<&str>,
) -> std::result::Result<(), String> {
    let version = new_info.version.trim();
    if version.is_empty() || version.eq_ignore_ascii_case("unknown") || version == "0.0.0" {
        return Err(format!(
            "Installed archive for '{}' did not produce a parseable manifest version.",
            old_info.name
        ));
    }
    if new_info.files.is_empty() {
        return Err(format!(
            "Installed archive for '{}' did not produce any mod files.",
            old_info.name
        ));
    }
    if install_is_incompatible(new_info, user_game_version) {
        return Err(format!(
            "Installed archive for '{}' requires STS2 v{} but your game is v{}.",
            new_info.name,
            new_info.min_game_version.as_deref().unwrap_or("?"),
            user_game_version.unwrap_or("?"),
        ));
    }
    if let (Some(old_id), Some(new_id)) = (old_info.mod_id.as_deref(), new_info.mod_id.as_deref()) {
        if old_id != new_id {
            return Err(format!(
                "Installed archive changed mod id from '{}' to '{}'.",
                old_id, new_id,
            ));
        }
    }
    Ok(())
}

/// Describes an available update for an installed mod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModUpdate {
    pub mod_name: String,
    /// Stable installed-artifact identity. Bulk apply must never resolve a
    /// same-named candidate through display text when this is available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateAcquisitionCapability {
    Downloadable,
    Manual,
    SteamManaged,
    Frozen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePlanItem {
    pub target: ModAuditTarget,
    pub current_version: String,
    pub target_version: Option<String>,
    pub provider: String,
    pub source: Option<String>,
    pub capability: UpdateAcquisitionCapability,
    pub reason: String,
    pub selectable: bool,
    /// Source-authoritative pending state computed by the backend. Consumers
    /// must not infer this from capability or the presence of a known version.
    #[serde(default)]
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePlanSelection {
    pub target: ModAuditTarget,
    pub expected_version: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateApplyStatus {
    Updated,
    Stale,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateApplyResult {
    pub target: ModAuditTarget,
    pub provider: String,
    pub mod_name: String,
    pub expected_version: String,
    pub actual_version: Option<String>,
    pub status: UpdateApplyStatus,
    pub message: Option<String>,
    pub updated_mod: Option<ModInfo>,
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

/// Parse a strict "owner/repo" string into (owner, repo).
///
/// Rejects anything that isn't exactly two non-empty, slash-separated
/// segments. In particular, full URLs (containing ':') and inputs with
/// 3+ segments (e.g. "owner/repo/extra") are refused so the caller can
/// fall back to `parse_github_url`. Accepting URLs here was the root
/// cause of malformed GitHub API requests like
/// `repos/https://github.com/owner/repo/releases/latest` returning 404.
fn parse_owner_repo(full_name: &str) -> Option<(String, String)> {
    if full_name.contains(':') {
        return None;
    }
    let parts: Vec<&str> = full_name.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    Some((parts[0].to_string(), parts[1].to_string()))
}

/// Parse a full GitHub repository URL into (owner, repo).
fn parse_github_url(source: &str) -> Option<(String, String)> {
    if !source.contains("github.com/") {
        return None;
    }
    let parsed = url::Url::parse(source).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let segs: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    if segs.len() < 2 || segs[0].is_empty() || segs[1].is_empty() {
        return None;
    }
    let repo = segs[1].trim_end_matches(".git");
    if repo.is_empty() {
        return None;
    }
    Some((segs[0].to_string(), repo.to_string()))
}

/// Resolve the GitHub owner/repo for a mod, checking:
/// 1. mod_sources.json (folder-first explicit link — only if manually set, not auto-detected)
/// 2. ModInfo.github_url extracted from the manifest
/// 3. ModInfo.source field (legacy github:owner/repo)
fn resolve_github_repo(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<(String, String)> {
    // Check mod_sources.json first — skip auto-detected links
    if let Some(entry) = lookup_entry(
        sources,
        mod_info.folder_name.as_deref(),
        &mod_info.name,
        mod_info.mod_id.as_deref(),
    ) {
        if !entry.github_auto_detected {
            if let Some(ref repo) = entry.github_repo {
                // Try strict "owner/repo" first, then fall back to URL
                // parsing. Existing DBs may have URL-form values stored
                // from before set_mod_sources_full normalized input —
                // we recover those instead of silently 404ing.
                if let Some(pair) = parse_owner_repo(repo).or_else(|| parse_github_url(repo)) {
                    return Some(pair);
                }
            }
        }
    }

    if let Some(ref github_url) = mod_info.github_url {
        if let Some(pair) = parse_github_url(github_url) {
            return Some(pair);
        }
    }

    // Fall back to legacy source field (these are from the mod author, trustworthy)
    if let Some(ref source) = mod_info.source {
        if let Some(pair) = parse_github_source(source) {
            return Some(pair);
        }
        if let Some(pair) = parse_github_url(source) {
            return Some(pair);
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
    config_path: Option<&std::path::Path>,
    cache_path: Option<&std::path::Path>,
) -> Result<Vec<ModUpdate>> {
    let mut updates = Vec::new();
    // Track which mods already got a GitHub update so we don't double-list.
    // Keyed by folder_name (falling back to display name) so two mods sharing
    // a display name don't suppress each other from the Nexus pass.
    let mut github_updated: std::collections::HashSet<String> = std::collections::HashSet::new();
    let dedup_id = |m: &ModInfo| m.folder_name.clone().unwrap_or_else(|| m.name.clone());

    // --- Phase 1: GitHub checks (existing logic, untouched) ---
    for m in mods {
        // Skip pinned mods — folder-first so a pin keyed by folder_name is respected
        if let Some(entry) = lookup_entry(
            sources,
            m.folder_name.as_deref(),
            &m.name,
            m.mod_id.as_deref(),
        ) {
            if entry.pinned {
                continue;
            }
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
                m.name,
                owner,
                repo,
                release.tag_name
            );
            continue;
        }

        // Skip non-version tags like "dev-build", "nightly", etc.
        if !is_version_tag(&release.tag_name) {
            log::info!(
                "Skipping update for {} ({}/{}): tag '{}' is not a valid version",
                m.name,
                owner,
                repo,
                release.tag_name
            );
            continue;
        }

        let latest = strip_version_prefix(&release.tag_name);
        let current = strip_version_prefix(&m.version);

        // Check if the installed_version in mod_sources.json matches latest
        // Folder-first so a bundle keyed by folder_name is not missed here.
        let installed_ver_matches = lookup_entry(
            sources,
            m.folder_name.as_deref(),
            &m.name,
            m.mod_id.as_deref(),
        )
        .and_then(|e| e.installed_version.as_deref().map(str::to_owned))
        .map(|iv| strip_version_prefix(&iv).to_owned() == latest)
        .unwrap_or(false);

        // Skip if versions match exactly, or version is unknown
        if installed_ver_matches || latest == current || current == "unknown" || current == "0.0.0"
        {
            continue;
        }

        // Use semver comparison to prevent downgrades
        if !is_newer_version(current, latest) {
            log::info!(
                "Skipping update for {} ({}/{}): installed {} >= latest {}",
                m.name,
                owner,
                repo,
                current,
                latest
            );
            continue;
        }
        if let (Some(config_path), Some(cache_path)) = (config_path, cache_path) {
            if crate::mod_versions::has_cached_provider_version_for_mod(
                config_path,
                cache_path,
                m,
                latest,
                crate::mod_versions::ArtifactProvider::GitHub,
                Some(&format!("github:{owner}/{repo}")),
            ) {
                log::info!(
                    "Skipping update for {} ({}/{}): v{} is already cached locally",
                    m.name,
                    owner,
                    repo,
                    latest
                );
                continue;
            }
        }

        let download_url = release
            .assets
            .first()
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_else(|| release.html_url.clone());

        github_updated.insert(dedup_id(m));
        updates.push(ModUpdate {
            mod_name: m.name.clone(),
            mod_version_id: m.mod_version_id.clone(),
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

            // Skip pinned mods — folder-first lookup so a pin saved under
            // folder_name (the post-1.3.0 write key) is respected here too.
            let source_entry = lookup_entry(
                sources,
                m.folder_name.as_deref(),
                &m.name,
                m.mod_id.as_deref(),
            );
            if let Some(entry) = source_entry {
                if entry.pinned {
                    continue;
                }
            }

            let source_entry = match lookup_entry(
                sources,
                m.folder_name.as_deref(),
                &m.name,
                m.mod_id.as_deref(),
            ) {
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

            let nexus_url = source_entry
                .nexus_url
                .clone()
                .unwrap_or_else(|| format!("https://www.nexusmods.com/{}/mods/{}", domain, mod_id));
            let source_record = config_path.and_then(|config_path| {
                m.mod_version_id
                    .as_deref()
                    .and_then(|id| crate::mod_versions::record_by_id(config_path, id))
            });

            match client.get_mod_info(domain, mod_id).await {
                Ok(info) => {
                    let mut effective_version = info.version.clone();
                    match client.get_mod_files(domain, mod_id).await {
                        Ok(files) if !files.is_empty() => {
                            effective_version = resolve_nexus_version_for_installed_lane(
                                &files,
                                Some(source_entry),
                                source_record.as_ref(),
                            );
                            if effective_version.is_none() {
                                log::info!(
                                    "Skipping Nexus update for {}: multiple files on the page but no installed file lane could be resolved",
                                    m.name
                                );
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            log::warn!(
                                "Nexus files lookup failed for '{}' (mod {}): {} - falling back to page version",
                                m.name,
                                mod_id,
                                e
                            );
                        }
                    }
                    if let Some(ref nv) = effective_version {
                        // Best known installed version (same logic as audit)
                        let sources_ver = source_record
                            .as_ref()
                            .and_then(|record| record.source_version.as_deref())
                            .or(source_entry.installed_version.as_deref())
                            .unwrap_or("");
                        let manifest_ver = strip_version_prefix(&m.version);
                        let current_ver = if !sources_ver.is_empty() {
                            let sv = strip_version_prefix(sources_ver);
                            if is_newer_version(manifest_ver, sv) {
                                sv
                            } else {
                                manifest_ver
                            }
                        } else {
                            manifest_ver
                        };
                        let nexus_ver = strip_version_prefix(nv);

                        if current_ver != "unknown"
                            && current_ver != "0.0.0"
                            && is_newer_version(current_ver, nexus_ver)
                        {
                            if let (Some(config_path), Some(cache_path)) = (config_path, cache_path)
                            {
                                if crate::mod_versions::has_cached_provider_version_for_mod(
                                    config_path,
                                    cache_path,
                                    m,
                                    nexus_ver,
                                    crate::mod_versions::ArtifactProvider::Nexus,
                                    Some(nexus_url.as_str()),
                                ) {
                                    log::info!(
                                        "Skipping Nexus update for {}: v{} is already cached locally",
                                        m.name,
                                        nexus_ver,
                                    );
                                    continue;
                                }
                            }
                            updates.push(ModUpdate {
                                mod_name: m.name.clone(),
                                mod_version_id: m.mod_version_id.clone(),
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
                    log::warn!(
                        "Nexus update check failed for {} (mod {}): {}",
                        m.name,
                        mod_id,
                        e
                    );
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
    let (mods_path, config_path, cache_path, token, nexus_key) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let config_path = s.config_path.clone();
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        let nexus_key = s.nexus_api_key.clone();
        (mods_path, config_path, cache_path, token, nexus_key)
    };

    let installed = scan_mods(&mods_path);
    let sources_db = load_sources(&config_path);
    check_all_updates(
        &installed,
        &sources_db.mods,
        token.as_deref(),
        nexus_key.as_deref(),
        Some(&config_path),
        Some(&cache_path),
    )
    .await
    .map_err(|e| e.to_string())
}

fn find_installed_mod<'a>(
    installed: &'a [ModInfo],
    name: &str,
    folder_name: Option<&str>,
) -> Option<&'a ModInfo> {
    if let Some(folder) = folder_name {
        installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some(folder))
    } else {
        installed.iter().find(|m| m.name == name)
    }
}

/// Decide whether installing `chosen_tag` would no-op (user already on it).
/// Returns `Some(message)` for the gate in `update_mod` to bubble up,
/// `None` when the update should actually proceed.
///
/// Lookup is folder-first via `lookup_entry`, matching every other
/// source-DB read/write in the codebase. Pre-1.4.3 the inline gate used
/// `sources.get(&name)` — name-only — which missed the folder-keyed
/// `installed_version` written by rollback/repair/the regular update
/// path. With that miss, the gate fell back to comparing only the
/// on-disk manifest version, and curator manifests that lag their
/// release tags falsely fired the gate.
///
/// The chosen tag is also normalized (leading `v` stripped) so the
/// formatted message reads `(v0.2.32)` rather than the pre-1.4.3
/// `(vv0.2.32)` cosmetic bug.
fn already_on_chosen_message(
    chosen_tag: &str,
    owner: &str,
    repo: &str,
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
    name: &str,
) -> Option<String> {
    let canonical_chosen = chosen_tag.trim_start_matches('v');
    if canonical_chosen.is_empty() {
        return None;
    }

    let installed_tag = crate::mod_sources::lookup_entry(
        sources,
        mod_info.folder_name.as_deref(),
        name,
        mod_info.mod_id.as_deref(),
    )
    .and_then(|e| e.installed_version.as_deref())
    .map(|s| s.trim_start_matches('v'))
    .unwrap_or("");
    let manifest_ver = mod_info.version.trim_start_matches('v');

    if canonical_chosen == installed_tag || canonical_chosen == manifest_ver {
        Some(format!(
            "Already on the newest version compatible with your Slay the Spire 2 build (v{}). \
             Newer releases of {}/{} require a higher game version — update Slay the Spire 2 \
             (or switch Steam beta branches) to pick up the latest mod release.",
            canonical_chosen, owner, repo
        ))
    } else {
        None
    }
}

fn delete_old_mod_install(old_info: &ModInfo, mods_path: &std::path::Path, label: &str) {
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
            && std::fs::read_dir(dir)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
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
    log::info!("{}: deleted old files for '{}'", label, old_info.name);
}

fn usable_version(raw: &str) -> Option<semver::Version> {
    let trimmed = raw.trim().trim_start_matches('v');
    if trimmed.is_empty() || trimmed == "unknown" || trimmed == "0" || trimmed == "0.0.0" {
        return None;
    }
    parse_version(raw)
}

fn best_known_installed_version(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<semver::Version> {
    if mod_info.install_source.is_workshop() {
        return usable_version(&mod_info.version);
    }
    let mut versions = Vec::new();
    if let Some(version) = lookup_entry(
        sources,
        mod_info.folder_name.as_deref(),
        &mod_info.name,
        mod_info.mod_id.as_deref(),
    )
    .and_then(|entry| entry.installed_version.as_deref())
    .and_then(usable_version)
    {
        versions.push(version);
    }
    if let Some(version) = usable_version(&mod_info.version) {
        versions.push(version);
    }
    versions.into_iter().max()
}

fn installed_source_version_for_display(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<String> {
    if mod_info.install_source.is_workshop() {
        return crate::mod_versions::usable_source_version_label(&mod_info.version)
            .map(|version| version.trim_start_matches(['v', 'V']).to_string());
    }
    lookup_entry(
        sources,
        mod_info.folder_name.as_deref(),
        &mod_info.name,
        mod_info.mod_id.as_deref(),
    )
    .and_then(|entry| entry.installed_version.as_deref())
    .and_then(crate::mod_versions::usable_source_version_label)
    .map(|version| version.trim_start_matches(['v', 'V']).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RollbackReleaseTarget {
    PreviousBelow(semver::Version),
    ReinstallKnownGood(semver::Version),
}

impl RollbackReleaseTarget {
    fn matches_candidate(&self, version: &semver::Version) -> bool {
        match self {
            Self::PreviousBelow(current) => version < current,
            Self::ReinstallKnownGood(known_good) => version == known_good,
        }
    }

    fn label(&self) -> String {
        match self {
            Self::PreviousBelow(current) => format!("below current v{}", current),
            Self::ReinstallKnownGood(known_good) => format!("at last known-good v{}", known_good),
        }
    }

    fn no_candidate_message(&self, owner: &str, repo: &str) -> String {
        match self {
            Self::PreviousBelow(current) => format!(
                "No lower version release found for {}/{} below v{}",
                owner, repo, current,
            ),
            Self::ReinstallKnownGood(known_good) => format!(
                "No GitHub release found for {}/{} at the last known-good version v{}",
                owner, repo, known_good,
            ),
        }
    }

    fn no_compatible_message(
        &self,
        owner: &str,
        repo: &str,
        game_version: Option<&str>,
        last_required: Option<&str>,
    ) -> String {
        match self {
            Self::PreviousBelow(current) => format!(
                "No lower compatible release of {}/{} was found below v{} for your game (v{}). \
                 Lowest required minimum we saw: v{}.",
                owner, repo, current,
                game_version.unwrap_or("?"),
                last_required.unwrap_or("?"),
            ),
            Self::ReinstallKnownGood(known_good) => format!(
                "The last known-good release of {}/{} (v{}) is not compatible with your game (v{}). \
                 Lowest required minimum we saw: v{}.",
                owner, repo, known_good,
                game_version.unwrap_or("?"),
                last_required.unwrap_or("?"),
            ),
        }
    }
}

fn rollback_release_target(
    mod_info: &ModInfo,
    sources: &std::collections::HashMap<String, ModSourceEntry>,
) -> Option<RollbackReleaseTarget> {
    let source_version = lookup_entry(
        sources,
        mod_info.folder_name.as_deref(),
        &mod_info.name,
        mod_info.mod_id.as_deref(),
    )
    .and_then(|entry| entry.installed_version.as_deref())
    .and_then(usable_version);
    let manifest_version = usable_version(&mod_info.version);

    match (manifest_version, source_version) {
        (Some(_), _) => best_known_installed_version(mod_info, sources)
            .map(RollbackReleaseTarget::PreviousBelow),
        (None, Some(source)) => Some(RollbackReleaseTarget::ReinstallKnownGood(source)),
        (None, None) => None,
    }
}

pub(crate) struct PromotionOutcome {
    pub mod_info: ModInfo,
    pub preserved_configs: Vec<String>,
    pub lost_configs: Vec<String>,
}

fn existing_source_version(existing: &ModInfo, config_path: &Path) -> Option<String> {
    crate::mod_versions::installed_source_version_label_for_mod(existing, config_path)
}

fn nexus_identity_from_source_entry(entry: &ModSourceEntry) -> crate::nexus::NexusFileIdentity {
    crate::nexus::NexusFileIdentity {
        file_id: entry.nexus_file_id,
        file_name: entry.nexus_file_name.clone(),
        lane_key: entry.nexus_file_lane_key.clone(),
    }
}

fn identity_has_any_nexus_file_data(identity: &crate::nexus::NexusFileIdentity) -> bool {
    identity.file_id.is_some() || identity.file_name.is_some() || identity.lane_key.is_some()
}

fn remember_record_nexus_identity(
    config_path: &Path,
    record_id: Option<&str>,
    identity: &crate::nexus::NexusFileIdentity,
) {
    if !identity_has_any_nexus_file_data(identity) {
        return;
    }
    let Some(record_id) = record_id else { return };
    if let Err(e) =
        crate::mod_versions::set_record_nexus_file_identity(config_path, record_id, identity)
    {
        log::warn!(
            "Failed to store Nexus file identity for mod version '{}': {}",
            record_id,
            e
        );
    }
}

fn nexus_file_update_sort_key(file: &crate::nexus::NexusFile) -> (i64, i64, u64) {
    let category_score = match file.category_id {
        Some(1) => 300,            // MAIN
        Some(2) => 200,            // UPDATE
        Some(3) => 180,            // OPTIONAL
        Some(4) | Some(7) => -500, // OLD / ARCHIVED
        Some(6) => -50,            // MISC
        _ => 0,
    };
    (
        category_score,
        file.uploaded_timestamp.unwrap_or_default(),
        file.file_id,
    )
}

fn latest_nexus_file_for_lane<'a>(
    files: &'a [crate::nexus::NexusFile],
    lane_key: &str,
) -> Option<&'a crate::nexus::NexusFile> {
    let normalized_lane = crate::nexus::normalize_nexus_file_lane_key(lane_key);
    files
        .iter()
        .filter(|file| {
            crate::nexus::nexus_file_lane_key(file).is_some_and(|candidate| {
                crate::nexus::normalize_nexus_file_lane_key(&candidate) == normalized_lane
            })
        })
        .max_by_key(|file| nexus_file_update_sort_key(file))
}

fn source_versions_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (
        left.and_then(crate::mod_versions::usable_source_version_label),
        right.and_then(crate::mod_versions::usable_source_version_label),
    ) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(&right),
        _ => false,
    }
}

fn resolve_nexus_file_for_installed_lane<'a>(
    files: &'a [crate::nexus::NexusFile],
    source_entry: Option<&ModSourceEntry>,
    record: Option<&crate::mod_versions::ModVersionRecord>,
) -> Option<&'a crate::nexus::NexusFile> {
    let entry_identity = source_entry.map(nexus_identity_from_source_entry);
    let record_identity = record.map(|record| crate::nexus::NexusFileIdentity {
        file_id: record.nexus_file_id,
        file_name: record.nexus_file_name.clone(),
        lane_key: record.nexus_file_lane_key.clone(),
    });
    let file_id = entry_identity
        .as_ref()
        .and_then(|identity| identity.file_id)
        .or_else(|| {
            record_identity
                .as_ref()
                .and_then(|identity| identity.file_id)
        });
    let stored_lane = entry_identity
        .as_ref()
        .and_then(|identity| identity.lane_key.as_deref())
        .or_else(|| {
            record_identity
                .as_ref()
                .and_then(|identity| identity.lane_key.as_deref())
        });

    if let Some(file_id) = file_id {
        if let Some(saved_file) = files.iter().find(|file| file.file_id == file_id) {
            let lane = crate::nexus::nexus_file_lane_key(saved_file)
                .or_else(|| stored_lane.map(str::to_string));
            if let Some(lane) = lane {
                return latest_nexus_file_for_lane(files, &lane).or(Some(saved_file));
            }
            return Some(saved_file);
        }
    }

    if let Some(lane) = stored_lane {
        return latest_nexus_file_for_lane(files, lane);
    }

    let installed_source_version = record
        .and_then(|record| record.source_version.as_deref())
        .or_else(|| source_entry.and_then(|entry| entry.installed_version.as_deref()));
    if installed_source_version.is_some() {
        let exact_matches: Vec<&crate::nexus::NexusFile> = files
            .iter()
            .filter(|file| source_versions_match(file.version.as_deref(), installed_source_version))
            .collect();
        if exact_matches.len() == 1 {
            let matched = exact_matches[0];
            if let Some(lane) = crate::nexus::nexus_file_lane_key(matched) {
                return latest_nexus_file_for_lane(files, &lane).or(Some(matched));
            }
            return Some(matched);
        }
        if exact_matches.len() > 1 {
            return None;
        }
    }

    if files.len() == 1 {
        return files.first();
    }
    None
}

fn resolve_nexus_version_for_installed_lane(
    files: &[crate::nexus::NexusFile],
    source_entry: Option<&ModSourceEntry>,
    record: Option<&crate::mod_versions::ModVersionRecord>,
) -> Option<String> {
    resolve_nexus_file_for_installed_lane(files, source_entry, record)
        .and_then(|file| file.version.clone())
        .filter(|version| !version.trim().is_empty())
}

fn merged_installed_mods(mods_path: &Path, disabled_path: Option<&Path>) -> Vec<ModInfo> {
    merge_active_disabled_mods(
        scan_mods(mods_path),
        disabled_path.map(scan_disabled_mods).unwrap_or_default(),
    )
}

fn enrich_installed_for_updates(installed: &mut [ModInfo], config_path: &Path) {
    crate::mod_sources::enrich_mods_with_sources(installed, config_path);
    crate::mod_versions::enrich_mods_with_versions(installed, config_path);
}

/// Promote a downloaded update archive to the Library's current artifact while
/// keeping saved profile/modpack references pinned to their old artifacts.
pub(crate) fn promote_archive_to_library(
    archive_path: &Path,
    existing: &ModInfo,
    source_hint: Option<String>,
    source_version: Option<&str>,
    source_type: &str,
    mods_path: &Path,
    disabled_path: Option<&Path>,
    profiles_path: &Path,
    cache_path: &Path,
    config_path: &Path,
    game_version: Option<&str>,
) -> std::result::Result<PromotionOutcome, String> {
    let lane_base = if existing.enabled {
        mods_path
    } else {
        disabled_path.ok_or_else(|| "Stored mods path not set".to_string())?
    };
    let source_hint =
        source_hint.or_else(|| crate::mod_versions::source_hint_for_mod(existing, config_path));
    let nexus_file_identity = (source_type == "nexus")
        .then(|| crate::nexus::nexus_file_identity_from_download(archive_path, source_version));

    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut staged = crate::mods::install_mod_from_archive(archive_path, staging.path())
        .map_err(|e| e.to_string())?;
    if staged.source.is_none() {
        staged.source = source_hint
            .clone()
            .or_else(|| crate::mod_versions::source_hint_for_mod(&staged, config_path));
    }
    if let Err(e) = validate_update_install_result(existing, &staged, game_version) {
        return Err(e);
    }

    let old_source_version = existing_source_version(existing, config_path);
    let mut old_cached = existing.clone();
    crate::mod_versions::cache_mod_version_by_id_with_source_version(
        &mut old_cached,
        lane_base,
        cache_path,
        config_path,
        old_source_version.as_deref(),
    )
    .ok_or_else(|| format!("Failed to cache '{}' v{}", existing.name, existing.version))?;
    let sources_db = load_sources(config_path);
    if let Some(old_entry) = lookup_entry(
        &sources_db.mods,
        existing.folder_name.as_deref(),
        &existing.name,
        existing.mod_id.as_deref(),
    ) {
        remember_record_nexus_identity(
            config_path,
            old_cached.mod_version_id.as_deref(),
            &nexus_identity_from_source_entry(old_entry),
        );
    }

    crate::mod_versions::cache_mod_version_by_id_with_source_version(
        &mut staged,
        staging.path(),
        cache_path,
        config_path,
        source_version,
    )
    .ok_or_else(|| format!("Failed to cache '{}' v{}", staged.name, staged.version))?;
    if let Some(identity) = nexus_file_identity.as_ref() {
        remember_record_nexus_identity(config_path, staged.mod_version_id.as_deref(), identity);
    }

    let old_folder = existing
        .folder_name
        .clone()
        .unwrap_or_else(|| existing.name.clone());
    let pre_update_preserved = crate::mods::prepare_update_with_preserved_configs(
        &old_folder,
        &existing.name,
        lane_base,
        config_path,
    );

    crate::downloads_watcher::sweep_stale_update_stashes(existing, lane_base);
    let stashed_existing =
        crate::downloads_watcher::stash_existing_mod_files(existing, lane_base, None);

    let mut installed = match crate::mods::install_mod_from_archive(archive_path, lane_base) {
        Ok(info) => info,
        Err(e) => {
            stashed_existing.restore();
            return Err(e.to_string());
        }
    };
    installed.enabled = existing.enabled;
    if installed.source.is_none() {
        installed.source = source_hint
            .clone()
            .or_else(|| crate::mod_versions::source_hint_for_mod(&installed, config_path));
    }

    if let Err(e) = validate_update_install_result(existing, &installed, game_version) {
        crate::mods::delete_mod_files_by_info(&installed, lane_base);
        stashed_existing.restore();
        return Err(e);
    }

    if crate::mod_versions::cache_mod_version_by_id_with_source_version(
        &mut installed,
        lane_base,
        cache_path,
        config_path,
        source_version,
    )
    .is_none()
    {
        crate::mods::delete_mod_files_by_info(&installed, lane_base);
        stashed_existing.restore();
        return Err(format!(
            "Failed to cache '{}' v{}",
            installed.name, installed.version
        ));
    }
    if let Some(identity) = nexus_file_identity.as_ref() {
        remember_record_nexus_identity(config_path, installed.mod_version_id.as_deref(), identity);
    }

    stashed_existing.discard();

    crate::mod_sources::carry_source_entry(
        existing.folder_name.as_deref(),
        &existing.name,
        installed.folder_name.as_deref(),
        &installed.name,
        config_path,
    );

    let version_to_store = source_version
        .and_then(crate::mod_versions::usable_source_version_label)
        .or_else(|| crate::mod_versions::usable_source_version_label(&installed.version));
    if let Some(version_to_store) = version_to_store.as_deref() {
        let install_key = installed
            .folder_name
            .as_deref()
            .unwrap_or(installed.name.as_str());
        if !existing.install_source.is_workshop() && !installed.install_source.is_workshop() {
            crate::mod_sources::update_installed_version_from_source(
                install_key,
                &version_to_store,
                source_type,
                config_path,
            );
            if let Some(identity) = nexus_file_identity.as_ref() {
                crate::mod_sources::set_nexus_file_identity_for_key(
                    install_key,
                    identity,
                    config_path,
                );
            }
        } else {
            log::info!(
                "Skipping installed_version write for Steam Workshop-owned update '{}'",
                existing.name
            );
        }
    }

    if source_type == "nexus" || !installed.bundle_member_ids.is_empty() {
        let install_key = installed
            .folder_name
            .as_deref()
            .unwrap_or(installed.name.as_str());
        let sources_db = load_sources(config_path);
        let nexus_entry = lookup_entry(
            &sources_db.mods,
            Some(install_key),
            &installed.name,
            installed.mod_id.as_deref(),
        );
        let (nexus_url, nexus_game_domain, nexus_mod_id) =
            nexus_entry.map_or((None, None, None), |entry| {
                (
                    entry.nexus_url.clone(),
                    entry.nexus_game_domain.clone(),
                    entry.nexus_mod_id,
                )
            });
        let bundle_version = version_to_store.clone();
        crate::mods::bundle::enrich_bundle_sidecar(
            lane_base,
            archive_path,
            None,
            nexus_url,
            nexus_game_domain,
            nexus_mod_id,
            bundle_version,
        );
    }

    let outcome = crate::mods::finalize_update_with_preserved_configs(
        &installed,
        lane_base,
        pre_update_preserved,
        config_path,
    )
    .map_err(|e| e.to_string())?;

    if existing.enabled {
        if let Some(disabled_path) = disabled_path {
            let moved = crate::mods::move_runtime_id_conflicts_to_disabled(
                &installed,
                mods_path,
                disabled_path,
            )
            .map_err(|e| e.to_string())?;
            if !moved.is_empty() {
                log::warn!(
                    "Update promotion moved {} active runtime-ID conflict(s) to disabled storage: {}",
                    moved.len(),
                    moved.join(", ")
                );
            }
        }
    }

    if let Some(new_id) = installed.mod_version_id.clone() {
        let mut refreshed = merged_installed_mods(mods_path, disabled_path);
        enrich_installed_for_updates(&mut refreshed, config_path);
        let profiles = crate::profiles::list_profiles(profiles_path);
        let anchor_ids: Vec<String> = [
            old_cached.mod_version_id.clone(),
            existing.mod_version_id.clone(),
            Some(new_id.clone()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let mut keep_ids: Vec<String> = [old_cached.mod_version_id.clone(), Some(new_id)]
            .into_iter()
            .flatten()
            .collect();
        for id in crate::mod_versions::cached_source_version_ids_for_mod_family(
            config_path,
            cache_path,
            &installed,
        ) {
            if !keep_ids.iter().any(|keep_id| keep_id == &id) {
                keep_ids.push(id);
            }
        }
        let _ = crate::mod_versions::prune_cached_versions_around(
            config_path,
            cache_path,
            &refreshed,
            &profiles,
            &anchor_ids,
            &keep_ids,
        );
    }

    Ok(PromotionOutcome {
        mod_info: installed,
        preserved_configs: outcome.preserved,
        lost_configs: outcome.lost,
    })
}

/// Download and cache the newest version of a specific mod from its
/// GitHub source that's compatible with the user's Slay the Spire 2 build.
///
/// This walks releases newest → oldest (same logic as `repair_mod`) so a
/// curator's freshly-published release that requires a beta game build
/// doesn't get saved as the user's next selectable version on a stable branch.
/// The old install-over-active behavior produced the
/// "vunknown" stub state that Repair was invented to fix in the first
/// place. The update pill in the audit calls this; we only refuse if
/// the walk-back lands on a tag the user already has.
///
/// When `game_version` is unknown (release_info.json missing) we fail
/// open and grab the latest release, mirroring legacy update_mod
/// behavior. Logged so we know we skipped the check.
#[tauri::command]
pub async fn update_mod(
    name: String,
    folder_name: Option<String>,
    _profile_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, cache_path, config_path, token, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone();
        let profiles_path = s.profiles_path.clone();
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let game_version = s.game_version.clone();
        (
            mods_path,
            disabled_path,
            profiles_path,
            cache_path,
            config_path,
            token,
            game_version,
        )
    };

    let mut installed = merged_installed_mods(&mods_path, disabled_path.as_deref());
    enrich_installed_for_updates(&mut installed, &config_path);
    let sources_db = load_sources(&config_path);

    // Folder-first lookup so update_mod targets the exact install when two
    // mods share a display name (e.g. two CardArtEditor installs with
    // different GitHub sources).
    let mod_info = find_installed_mod(&installed, &name, folder_name.as_deref())
        .ok_or_else(|| format!("Mod '{}' not found", name))?;

    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods).ok_or_else(|| {
        format!(
            "Mod '{}' has no GitHub source linked. Link one in the Mods view.",
            name
        )
    })?;

    // Resolve which tag we'll actually install BEFORE deleting the old
    // copy — same shape as repair_mod. If the walk-back can't find any
    // compatible release, we want the user to keep what they had.
    let chosen_tag: String;
    let chosen_zip: std::path::PathBuf;
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
        if let Some(msg) = already_on_chosen_message(
            &chosen.tag,
            &owner,
            &repo,
            mod_info,
            &sources_db.mods,
            &name,
        ) {
            return Err(msg);
        }

        chosen_tag = chosen.tag;
        chosen_zip = chosen.zip_path;
    } else {
        // Fail open: no game version means we can't compare. Grab latest.
        let release = fetch_latest_release(&owner, &repo, token.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        let tag = release.tag_name.clone();
        log::warn!(
            "update_mod: no game_version detected — downloading latest {}/{}@{} without compatibility check",
            owner, repo, tag,
        );
        chosen_zip = crate::download::download_release_zip_to_cache(
            &owner,
            &repo,
            &tag,
            &cache_path,
            None,
            token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
        chosen_tag = tag;
    }

    log::info!(
        "update_mod: promoting {}/{}@{} for '{}' into the Library copy",
        owner,
        repo,
        chosen_tag,
        name,
    );
    let outcome = promote_archive_to_library(
        &chosen_zip,
        mod_info,
        Some(format!("github:{}/{}", owner, repo)),
        Some(&chosen_tag),
        "github",
        &mods_path,
        disabled_path.as_deref(),
        &profiles_path,
        &cache_path,
        &config_path,
        game_version.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    crate::mod_sources::emit_configs_preserved(
        &app,
        &outcome.mod_info.name,
        &outcome.preserved_configs,
    );
    crate::mod_sources::emit_configs_lost(&app, &outcome.mod_info.name, &outcome.lost_configs);

    Ok(outcome.mod_info)
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
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    log::info!(
        "repair_mod: walk-back repair requested for '{}' (folder: {:?})",
        name,
        folder_name,
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
        installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
    } else {
        installed.iter().find(|m| m.name == name)
    }
    .ok_or_else(|| format!("Mod '{}' not found", name))?;
    let old_info_for_validation = mod_info.clone();
    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods).ok_or_else(|| {
        format!(
            "Mod '{}' has no GitHub source linked. Link one in the Mods view.",
            name
        )
    })?;

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

    // Read user-edited configs BEFORE the destructive delete pass.
    let pre_update_preserved = mod_info
        .folder_name
        .clone()
        .or_else(|| Some(mod_info.name.clone()))
        .map(|folder| {
            crate::mods::prepare_update_with_preserved_configs(
                &folder,
                &name,
                &mods_path,
                &config_path,
            )
        })
        .unwrap_or_default();

    // Move the broken install ASIDE instead of deleting it outright. Reuse
    // the same folder-first lookup we did above so we stash the exact mod we
    // resolved earlier. If the extract below fails, `stashed_existing` lets
    // us put these files back so a failed Repair can never leave the user
    // with nothing on disk (#174).
    let stashed_existing = {
        let old_info = if let Some(ref folder) = folder_name {
            installed
                .iter()
                .find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
        } else {
            installed.iter().find(|m| m.name == name)
        };
        old_info.map(|old_info| {
            crate::downloads_watcher::sweep_stale_update_stashes(old_info, &mods_path);
            log::info!(
                "repair_mod: stashing old files for '{}' aside (preserving {} configs)",
                name,
                pre_update_preserved.len(),
            );
            crate::downloads_watcher::stash_existing_mod_files(old_info, &mods_path, None)
        })
    };

    // Extract the cached candidate into the live mods folder. On failure,
    // restore the stashed original so the user keeps their existing install
    // instead of ending up with nothing (#174).
    let mut info = match crate::mods::install_mod_from_zip(&chosen.zip_path, &mods_path) {
        Ok(info) => info,
        Err(e) => {
            if let Some(stash) = stashed_existing {
                log::error!(
                    "repair_mod: extract of '{}' from {}/{}@{} failed ({}); restoring previous install",
                    name, owner, repo, chosen.tag, e,
                );
                stash.restore();
            }
            return Err(e.to_string());
        }
    };

    crate::mod_versions::ensure_mod_info_id(&mut info, &config_path);

    if let Err(e) =
        validate_update_install_result(&old_info_for_validation, &info, game_version.as_deref())
    {
        if let Some(stash) = stashed_existing {
            log::error!(
                "repair_mod: validation of '{}' from {}/{}@{} failed ({}); restoring previous install",
                name, owner, repo, chosen.tag, e,
            );
            stash.restore();
        }
        return Err(e);
    }

    // Validation already rejected unknown/empty manifests, wrong identities,
    // empty extracts, and incompatible game versions. Only now is it safe to
    // forget the stash and remember the release tag we chose.
    if let Some(stash) = stashed_existing {
        stash.discard();
    }

    // Same healthy-install gate as update_mod — only persist installed_version
    // when the manifest parsed cleanly.
    let install_healthy = info.version != "unknown" && !info.version.is_empty();
    if install_healthy {
        // Folder-first key for the same reason as update_mod above.
        let install_key = info.folder_name.as_deref().unwrap_or(name.as_str());
        if !mod_info.install_source.is_workshop() {
            crate::mod_sources::update_installed_version_from_source(
                install_key,
                &chosen.tag,
                "github",
                &config_path,
            );
            if info.name != name {
                crate::mod_sources::migrate_source_entry(&name, &info.name, &config_path);
                crate::mod_sources::update_installed_version_from_source(
                    &info.name,
                    &chosen.tag,
                    "github",
                    &config_path,
                );
            }
        } else {
            log::info!(
                "repair_mod: skipping installed_version write for Steam Workshop-owned '{}'",
                name
            );
        }

        // Overlay user-edited configs + refresh snapshot. Repair is a
        // walk-back (re-install of an older release), so preservation
        // matters the same way it does for forward updates — user's
        // tweaks shouldn't die just because they fixed a broken install.
        let outcome = crate::mods::finalize_update_with_preserved_configs(
            &info,
            &mods_path,
            pre_update_preserved,
            &config_path,
        )
        .map_err(|e| e.to_string())?;
        crate::mod_sources::emit_configs_preserved(&app, &info.name, &outcome.preserved);
        crate::mod_sources::emit_configs_lost(&app, &info.name, &outcome.lost);
    } else {
        log::error!(
            "repair_mod: install of '{}' from {}/{}@{} produced an unhealthy ModInfo (version='{}'); \
             leaving installed_version untouched.",
            name, owner, repo, chosen.tag, info.version,
        );
    }

    Ok(info)
}

/// Install the closest lower GitHub release below the currently installed
/// version. If the current on-disk manifest is broken (`unknown`) but we
/// still have a last known-good installed_version, reinstall that exact
/// known-good release instead of skipping below it.
///
/// This is intentionally different from Repair: Repair finds the newest
/// compatible release, while Rollback targets the user's previous-good lane.
#[tauri::command]
pub async fn rollback_mod(
    name: String,
    folder_name: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    log::info!(
        "rollback_mod: requested for '{}' (folder: {:?})",
        name,
        folder_name,
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
    let mod_info = find_installed_mod(&installed, &name, folder_name.as_deref())
        .ok_or_else(|| format!("Mod '{}' not found", name))?;
    let rollback_target = rollback_release_target(mod_info, &sources_db.mods).ok_or_else(|| {
        format!(
            "Mod '{}' does not have a usable manifest version or last known-good version, so the manager cannot choose a rollback release.",
            name
        )
    })?;
    let (owner, repo) = resolve_github_repo(mod_info, &sources_db.mods).ok_or_else(|| {
        format!(
            "Mod '{}' has no GitHub source linked. Link one in the Mods view.",
            name
        )
    })?;

    let chosen = pick_rollback_compatible_release(
        &owner,
        &repo,
        &rollback_target,
        game_version.as_deref(),
        &cache_path,
        token.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    log::info!(
        "rollback_mod: chose tag {} for {}/{} {} (game v{}; min_game_version on chosen release: {})",
        chosen.tag, owner, repo, rollback_target.label(),
        game_version.as_deref().unwrap_or("?"),
        chosen.min_game_version.as_deref().unwrap_or("none"),
    );

    let pre_update_preserved = mod_info
        .folder_name
        .clone()
        .or_else(|| Some(mod_info.name.clone()))
        .map(|folder| {
            crate::mods::prepare_update_with_preserved_configs(
                &folder,
                &name,
                &mods_path,
                &config_path,
            )
        })
        .unwrap_or_default();

    delete_old_mod_install(mod_info, &mods_path, "rollback_mod");

    let mut info = crate::mods::install_mod_from_zip(&chosen.zip_path, &mods_path)
        .map_err(|e| e.to_string())?;
    crate::mod_versions::ensure_mod_info_id(&mut info, &config_path);

    let install_healthy = info.version != "unknown" && !info.version.is_empty();
    if install_healthy {
        let install_key = info.folder_name.as_deref().unwrap_or(name.as_str());
        if !mod_info.install_source.is_workshop() {
            crate::mod_sources::update_installed_version_from_source(
                install_key,
                &chosen.tag,
                "github",
                &config_path,
            );
            if info.name != name {
                crate::mod_sources::migrate_source_entry(&name, &info.name, &config_path);
                crate::mod_sources::update_installed_version_from_source(
                    &info.name,
                    &chosen.tag,
                    "github",
                    &config_path,
                );
            }
        } else {
            log::info!(
                "rollback_mod: skipping installed_version write for Steam Workshop-owned '{}'",
                name
            );
        }

        let outcome = crate::mods::finalize_update_with_preserved_configs(
            &info,
            &mods_path,
            pre_update_preserved,
            &config_path,
        )
        .map_err(|e| e.to_string())?;
        crate::mod_sources::emit_configs_preserved(&app, &info.name, &outcome.preserved);
        crate::mod_sources::emit_configs_lost(&app, &info.name, &outcome.lost);
    } else {
        log::error!(
            "rollback_mod: install of '{}' from {}/{}@{} produced an unhealthy ModInfo (version='{}'); \
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
        if !is_walk_back_release_candidate(release) {
            log::info!(
                "Walk-back: skipping {}/{}@{} (not a versioned release with installable mod assets)",
                owner,
                repo,
                tag
            );
            continue;
        }
        let zip_path = match crate::download::download_release_zip_to_cache(
            owner,
            repo,
            tag,
            cache_path,
            game_version,
            token,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "Walk-back: skipping {}/{}@{} (download failed: {})",
                    owner,
                    repo,
                    tag,
                    e
                );
                continue;
            }
        };
        let mgv = match crate::download::peek_zip_min_game_version(&zip_path) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "Walk-back: skipping {}/{}@{} (manifest peek failed: {})",
                    owner,
                    repo,
                    tag,
                    e
                );
                continue;
            }
        };

        let compatible = match (game_version, mgv.as_deref()) {
            (_, None) => true,       // mod doesn't care
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
            owner,
            repo,
            tag,
            last_required.as_deref().unwrap_or("?"),
            game_version.unwrap_or("?"),
        );
    }

    Err(crate::error::AppError::Other(format!(
        "No release of {}/{} is compatible with your game (v{}). \
         Lowest required minimum we saw: v{}. Update Slay the Spire 2 \
         (or switch Steam beta branches) and try again.",
        owner,
        repo,
        game_version.unwrap_or("?"),
        last_required.as_deref().unwrap_or("?"),
    )))
}

async fn pick_rollback_compatible_release(
    owner: &str,
    repo: &str,
    target: &RollbackReleaseTarget,
    game_version: Option<&str>,
    cache_path: &std::path::Path,
    token: Option<&str>,
) -> crate::error::Result<WalkBackChoice> {
    const MAX_RELEASES_TO_WALK: usize = 30;
    const PER_PAGE: u32 = 30;

    let releases = crate::download::fetch_releases(owner, repo, 1, PER_PAGE, token).await?;
    if releases.is_empty() {
        return Err(crate::error::AppError::Other(format!(
            "{}/{} has no releases",
            owner, repo
        )));
    }

    let mut candidates: Vec<_> = releases
        .iter()
        .filter_map(|release| {
            let version = parse_version(&release.tag_name)?;
            if target.matches_candidate(&version)
                && release.assets.iter().any(|a| is_mod_asset(&a.name))
            {
                Some((release, version))
            } else {
                None
            }
        })
        .collect();
    candidates.sort_by(|a, b| b.1.cmp(&a.1));

    if candidates.is_empty() {
        return Err(crate::error::AppError::Other(
            target.no_candidate_message(owner, repo),
        ));
    }

    let mut last_required: Option<String> = None;
    for (release, _) in candidates.into_iter().take(MAX_RELEASES_TO_WALK) {
        let tag = release.tag_name.as_str();
        let zip_path = match crate::download::download_release_zip_to_cache(
            owner,
            repo,
            tag,
            cache_path,
            game_version,
            token,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "Rollback: skipping {}/{}@{} (download failed: {})",
                    owner,
                    repo,
                    tag,
                    e
                );
                continue;
            }
        };
        let mgv = match crate::download::peek_zip_min_game_version(&zip_path) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "Rollback: skipping {}/{}@{} (manifest peek failed: {})",
                    owner,
                    repo,
                    tag,
                    e
                );
                continue;
            }
        };

        let compatible = match (game_version, mgv.as_deref()) {
            (_, None) => true,
            (None, Some(_)) => true,
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
            "Rollback: {}/{}@{} requires game v{} (you have v{}), trying another release",
            owner,
            repo,
            tag,
            last_required.as_deref().unwrap_or("?"),
            game_version.unwrap_or("?"),
        );
    }

    Err(crate::error::AppError::Other(target.no_compatible_message(
        owner,
        repo,
        game_version,
        last_required.as_deref(),
    )))
}

pub async fn pick_previous_compatible_release(
    owner: &str,
    repo: &str,
    current_version: &semver::Version,
    game_version: Option<&str>,
    cache_path: &std::path::Path,
    token: Option<&str>,
) -> crate::error::Result<WalkBackChoice> {
    pick_rollback_compatible_release(
        owner,
        repo,
        &RollbackReleaseTarget::PreviousBelow(current_version.clone()),
        game_version,
        cache_path,
        token,
    )
    .await
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
    _profile_id: Option<String>,
    selected: Vec<UpdatePlanSelection>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<UpdateApplyResult>, String> {
    crate::game::ensure_game_not_running()?;
    let (
        mods_path,
        disabled_path,
        profiles_path,
        cache_path,
        config_path,
        token,
        nexus_key,
        game_version,
    ) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone();
        let profiles_path = s.profiles_path.clone();
        let cache_path = s.cache_path.clone();
        let config_path = s.config_path.clone();
        let token = s.github_token.clone();
        let nexus_key = s.nexus_api_key.clone();
        let game_version = s.game_version.clone();
        (
            mods_path,
            disabled_path,
            profiles_path,
            cache_path,
            config_path,
            token,
            nexus_key,
            game_version,
        )
    };

    let mut installed = merged_installed_mods(&mods_path, disabled_path.as_deref());
    enrich_installed_for_updates(&mut installed, &config_path);
    let sources_db = load_sources(&config_path);
    let updates = check_all_updates(
        &installed,
        &sources_db.mods,
        token.as_deref(),
        nexus_key.as_deref(),
        Some(&config_path),
        Some(&cache_path),
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for selection in &selected {
        let Some(old_info) = installed
            .iter()
            .find(|info| selection.target.matches(info))
            .cloned()
        else {
            results.push(UpdateApplyResult {
                target: selection.target.clone(),
                provider: selection.provider.clone(),
                mod_name: selection.target.name.clone(),
                expected_version: selection.expected_version.clone(),
                actual_version: None,
                status: UpdateApplyStatus::Stale,
                message: Some("The installed version changed. Preview updates again.".into()),
                updated_mod: None,
            });
            continue;
        };
        if selection.provider != "github" {
            results.push(UpdateApplyResult {
                target: selection.target.clone(),
                provider: selection.provider.clone(),
                mod_name: old_info.name.clone(),
                expected_version: selection.expected_version.clone(),
                actual_version: None,
                status: UpdateApplyStatus::Skipped,
                message: Some("Only GitHub updates can be downloaded automatically.".into()),
                updated_mod: None,
            });
            continue;
        }
        let Some(update) = updates.iter().find(|candidate| {
            candidate.source_type == "github" && selection.target.matches_update(candidate)
        }) else {
            results.push(UpdateApplyResult {
                target: selection.target.clone(),
                provider: selection.provider.clone(),
                mod_name: old_info.name.clone(),
                expected_version: selection.expected_version.clone(),
                actual_version: None,
                status: UpdateApplyStatus::Stale,
                message: Some("The available release changed. Preview updates again.".into()),
                updated_mod: None,
            });
            continue;
        };
        // Skip Nexus updates here — the curator workflow's "Update all"
        // is the GitHub auto-update path; Nexus updates require user
        // interaction (Slow Download / Manual) and surface separately.
        if update.source_type != "github" {
            results.push(UpdateApplyResult {
                target: selection.target.clone(),
                provider: selection.provider.clone(),
                mod_name: old_info.name.clone(),
                expected_version: selection.expected_version.clone(),
                actual_version: None,
                status: UpdateApplyStatus::Stale,
                message: Some("The update provider changed. Preview updates again.".into()),
                updated_mod: None,
            });
            continue;
        }

        let (owner, repo) = match parse_owner_repo(&update.source_id) {
            Some(pair) => pair,
            None => {
                results.push(UpdateApplyResult {
                    target: selection.target.clone(),
                    provider: selection.provider.clone(),
                    mod_name: old_info.name.clone(),
                    expected_version: selection.expected_version.clone(),
                    actual_version: None,
                    status: UpdateApplyStatus::Failed,
                    message: Some("The GitHub update source is invalid.".into()),
                    updated_mod: None,
                });
                continue;
            }
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
                    let installed_tag = update
                        .folder_name
                        .as_ref()
                        .and_then(|f| sources_db.mods.get(f))
                        .or_else(|| sources_db.mods.get(&update.mod_name))
                        .and_then(|e| e.installed_version.as_deref())
                        .map(|s| s.trim_start_matches('v'))
                        .unwrap_or("");
                    let manifest_ver = if let Some(ref folder) = update.folder_name {
                        installed
                            .iter()
                            .find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
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
                        results.push(UpdateApplyResult {
                            target: selection.target.clone(),
                            provider: selection.provider.clone(),
                            mod_name: old_info.name.clone(),
                            expected_version: selection.expected_version.clone(),
                            actual_version: Some(c.tag),
                            status: UpdateApplyStatus::Skipped,
                            message: Some(
                                "The installed version is already the newest compatible release."
                                    .into(),
                            ),
                            updated_mod: None,
                        });
                        continue;
                    }
                    (c.tag, c.zip_path)
                }
                Err(e) => {
                    log::error!(
                        "update_all_mods: walk-back failed for '{}' ({}/{}): {}",
                        update.mod_name,
                        owner,
                        repo,
                        e
                    );
                    results.push(UpdateApplyResult {
                        target: selection.target.clone(),
                        provider: selection.provider.clone(),
                        mod_name: old_info.name.clone(),
                        expected_version: selection.expected_version.clone(),
                        actual_version: None,
                        status: UpdateApplyStatus::Failed,
                        message: Some(e.to_string()),
                        updated_mod: None,
                    });
                    continue;
                }
            }
        } else {
            log::warn!(
                "update_all_mods: no game_version detected — downloading latest {}/{}@{} without compatibility check",
                owner, repo, update.latest_version,
            );
            let zip = match crate::download::download_release_zip_to_cache(
                &owner,
                &repo,
                &update.latest_version,
                &cache_path,
                None,
                token.as_deref(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    log::error!(
                        "update_all_mods: download failed for '{}' ({}/{}@{}): {}",
                        update.mod_name,
                        owner,
                        repo,
                        update.latest_version,
                        e,
                    );
                    results.push(UpdateApplyResult {
                        target: selection.target.clone(),
                        provider: selection.provider.clone(),
                        mod_name: old_info.name.clone(),
                        expected_version: selection.expected_version.clone(),
                        actual_version: None,
                        status: UpdateApplyStatus::Failed,
                        message: Some(e.to_string()),
                        updated_mod: None,
                    });
                    continue;
                }
            };
            (update.latest_version.clone(), zip)
        };

        // Read user-edited configs BEFORE the destructive delete pass —
        // same prepare/finalize pattern as update_mod / repair_mod.
        if chosen_tag.trim_start_matches('v') != selection.expected_version.trim_start_matches('v')
        {
            results.push(UpdateApplyResult {
                target: selection.target.clone(),
                provider: selection.provider.clone(),
                mod_name: old_info.name.clone(),
                expected_version: selection.expected_version.clone(),
                actual_version: Some(chosen_tag),
                status: UpdateApplyStatus::Stale,
                message: Some(
                    "A different release is now available. Preview updates again.".into(),
                ),
                updated_mod: None,
            });
            continue;
        }

        match promote_archive_to_library(
            &chosen_zip,
            &old_info,
            Some(format!("github:{}/{}", owner, repo)),
            Some(&chosen_tag),
            "github",
            &mods_path,
            disabled_path.as_deref(),
            &profiles_path,
            &cache_path,
            &config_path,
            game_version.as_deref(),
        ) {
            Ok(outcome) => {
                crate::mod_sources::emit_configs_preserved(
                    &app,
                    &outcome.mod_info.name,
                    &outcome.preserved_configs,
                );
                crate::mod_sources::emit_configs_lost(
                    &app,
                    &outcome.mod_info.name,
                    &outcome.lost_configs,
                );
                results.push(UpdateApplyResult {
                    target: selection.target.clone(),
                    provider: selection.provider.clone(),
                    mod_name: old_info.name.clone(),
                    expected_version: selection.expected_version.clone(),
                    actual_version: Some(chosen_tag.clone()),
                    status: UpdateApplyStatus::Updated,
                    message: None,
                    updated_mod: Some(outcome.mod_info),
                });
                installed = merged_installed_mods(&mods_path, disabled_path.as_deref());
                enrich_installed_for_updates(&mut installed, &config_path);
            }
            Err(e) => {
                log::error!(
                    "update_all_mods: failed to promote update artifact for '{}': {}",
                    update.mod_name,
                    e,
                );
                results.push(UpdateApplyResult {
                    target: selection.target.clone(),
                    provider: selection.provider.clone(),
                    mod_name: old_info.name.clone(),
                    expected_version: selection.expected_version.clone(),
                    actual_version: Some(chosen_tag.clone()),
                    status: UpdateApplyStatus::Failed,
                    message: Some(e.to_string()),
                    updated_mod: None,
                });
            }
        }
    }

    Ok(results)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod version_helper_tests {
    use super::*;

    #[test]
    fn update_plan_selection_matches_stable_identity_not_same_display_name() {
        let mut github = mod_info(|m| {
            m.name = "Same Name".into();
            m.folder_name = Some("github-copy".into());
            m.mod_version_id = Some("github-id".into());
        });
        let nexus = mod_info(|m| {
            m.name = "Same Name".into();
            m.folder_name = Some("nexus-copy".into());
            m.mod_version_id = Some("nexus-id".into());
        });
        github.source = Some("github:owner/repo".into());
        let selected = ModAuditTarget {
            mod_version_id: Some("github-id".into()),
            folder_name: Some("github-copy".into()),
            mod_id: None,
            name: "Same Name".into(),
        };
        assert!(selected.matches(&github));
        assert!(!selected.matches(&nexus));
    }

    #[test]
    fn update_plan_identity_does_not_fall_back_after_version_id_mismatch() {
        let installed = mod_info(|m| {
            m.name = "Same Name".into();
            m.folder_name = Some("reused-folder".into());
            m.mod_version_id = Some("new-artifact".into());
        });
        let stale = ModAuditTarget {
            mod_version_id: Some("old-artifact".into()),
            folder_name: Some("reused-folder".into()),
            mod_id: installed.mod_id.clone(),
            name: installed.name.clone(),
        };

        assert!(!stale.matches(&installed));
        let mut missing_id = installed.clone();
        missing_id.mod_version_id = None;
        assert!(!stale.matches(&missing_id));
    }

    #[test]
    fn update_candidate_resolution_uses_artifact_identity_before_display_name() {
        let target = ModAuditTarget {
            mod_version_id: Some("wanted-artifact".into()),
            folder_name: Some("wanted-folder".into()),
            mod_id: Some("same-runtime-id".into()),
            name: "Same Name".into(),
        };
        let candidate = |mod_version_id: &str, folder_name: &str| ModUpdate {
            mod_name: "Same Name".into(),
            mod_version_id: Some(mod_version_id.into()),
            folder_name: Some(folder_name.into()),
            current_version: "1".into(),
            latest_version: "2".into(),
            source_type: "github".into(),
            source_id: "owner/repo".into(),
            download_url: String::new(),
        };

        assert!(!target.matches_update(&candidate("other-artifact", "wanted-folder")));
        assert!(target.matches_update(&candidate("wanted-artifact", "other-folder")));
    }

    #[test]
    fn update_plan_capabilities_keep_manual_steam_and_frozen_unselectable() {
        let info = mod_info(|m| {
            m.name = "Example".into();
            m.mod_version_id = Some("stable-id".into());
        });
        for (provider, pinned, capability) in [
            ("nexus", false, UpdateAcquisitionCapability::Manual),
            ("steam", false, UpdateAcquisitionCapability::SteamManaged),
            ("github", true, UpdateAcquisitionCapability::Frozen),
        ] {
            let plan = update_plan_item(
                &info,
                "1".into(),
                Some("2".into()),
                provider,
                None,
                pinned,
                true,
            );
            assert_eq!(plan.capability, capability);
            assert!(!plan.selectable);
            assert!(plan.pending);
            assert_eq!(serde_json::to_value(&plan).unwrap()["pending"], true);
            if provider == "steam" {
                assert_eq!(plan.target_version, None);
            }
        }
        assert!(
            update_plan_item(
                &info,
                "1".into(),
                Some("2".into()),
                "github",
                None,
                false,
                true
            )
            .selectable
        );
    }

    #[test]
    fn mixed_source_records_keep_every_pending_provider_plan() {
        let workshop = mod_info(|m| {
            m.name = "BaseLib".into();
            m.mod_version_id = Some("baselib-workshop".into());
            m.install_source = ModInstallSource::SteamWorkshop;
            m.workshop_url =
                Some("https://steamcommunity.com/sharedfiles/filedetails/?id=123".into());
        });
        let cases = [
            (None, Some("2.0.0"), vec!["steam", "nexus"]),
            (Some("owner/repo"), None, vec!["steam", "github"]),
            (
                Some("owner/repo"),
                Some("2.0.0"),
                vec!["steam", "github", "nexus"],
            ),
        ];

        for (github, nexus_version, expected) in cases {
            let plans = build_update_plans(
                &workshop,
                "1.0.0",
                Some("1.0.0"),
                github,
                github.map(|_| "2.0.0"),
                github.is_some(),
                nexus_version.map(|_| "https://www.nexusmods.com/slaythespire2/mods/1"),
                Some("1.0.0"),
                nexus_version,
                nexus_version.is_some(),
                false,
                false,
                true,
            );
            let pending: Vec<_> = plans
                .iter()
                .filter(|plan| plan.pending)
                .map(|plan| plan.provider.as_str())
                .collect();
            assert_eq!(pending, expected);
            if github.is_some() {
                let github_plan = plans.iter().find(|plan| plan.provider == "github").unwrap();
                assert_eq!(github_plan.capability, UpdateAcquisitionCapability::Manual);
                assert!(!github_plan.selectable);
            }
            assert_eq!(
                plans
                    .iter()
                    .find(|plan| plan.provider == "steam")
                    .unwrap()
                    .target_version,
                None,
                "Steam's manifest/internal revision must never become display version text",
            );
        }
    }

    #[test]
    fn workshop_display_versions_ignore_numeric_source_metadata() {
        let workshop = mod_info(|m| {
            m.name = "Workshop Mod".into();
            m.version = "v3.3.2".into();
            m.install_source = ModInstallSource::SteamWorkshop;
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("7697508620998582885".into()),
                ..Default::default()
            },
        );

        assert_eq!(
            best_known_installed_version(&workshop, &sources)
                .unwrap()
                .to_string(),
            "3.3.2",
        );
        assert_eq!(
            installed_source_version_for_display(&workshop, &sources).as_deref(),
            Some("3.3.2"),
        );
    }

    #[test]
    fn github_pending_uses_newer_source_version_over_stale_manifest() {
        let info = mod_info(|m| m.version = "1.0.0".into());
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("2.0.0".into()),
                ..Default::default()
            },
        );

        let current = best_known_installed_version(&info, &sources).unwrap();
        assert_eq!(current.to_string(), "2.0.0");
        assert!(!is_newer_version(&current.to_string(), "1.5.0"));
    }

    fn mod_info(overrides: impl FnOnce(&mut crate::mods::ModInfo)) -> crate::mods::ModInfo {
        let mut info = crate::mods::ModInfo {
            mod_version_id: None,
            name: "RitsuLib".into(),
            version: "0.2.31".into(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some("RitsuLib".into()),
            mod_id: Some("ritsulib".into()),
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
            ..Default::default()
        };
        overrides(&mut info);
        info
    }

    #[test]
    fn parse_version_handles_v_prefix_and_partial() {
        assert_eq!(parse_version("1.2.3").unwrap().to_string(), "1.2.3");
        assert_eq!(parse_version("v1.2.3").unwrap().to_string(), "1.2.3");
        // Partial versions get .0 padding.
        assert_eq!(parse_version("1.2").unwrap().to_string(), "1.2.0");
        assert_eq!(parse_version("1").unwrap().to_string(), "1.0.0");
        // Whitespace tolerated.
        assert_eq!(parse_version(" v1.2.3 ").unwrap().to_string(), "1.2.3");
    }

    #[test]
    fn parse_version_returns_none_for_nonsense() {
        assert!(parse_version("dev-build").is_none());
        assert!(parse_version("nightly").is_none());
        assert!(parse_version("").is_none());
        assert!(parse_version("x.y.z").is_none());
    }

    #[test]
    fn parse_loose_version_tolerates_steam_beta_suffixes() {
        assert_eq!(
            parse_loose_version("0.106.1b").unwrap(),
            semver::Version::new(0, 106, 1)
        );
        assert_eq!(
            parse_loose_version("0.106.1-beta.4257").unwrap(),
            semver::Version::new(0, 106, 1)
        );
        assert_eq!(
            parse_loose_version("v0.103.2").unwrap(),
            semver::Version::new(0, 103, 2)
        );
        assert_eq!(
            parse_loose_version("1.2").unwrap(),
            semver::Version::new(1, 2, 0)
        );
        // Still refuses strings with no numeric major.
        assert!(parse_loose_version("dev-build").is_none());
        assert!(parse_loose_version("").is_none());
    }

    #[test]
    fn game_version_satisfies_handles_beta_suffixed_current() {
        // The exact shape of Solo's RitsuLib report: a beta-branch game
        // version must compare numerically, not fail open.
        assert!(game_version_satisfies("0.106.1b", "0.106.1"));
        assert!(game_version_satisfies("0.106.1-beta.4257", "0.103.2"));
        assert!(!game_version_satisfies("0.103.2b", "0.106.1"));
    }

    #[test]
    fn is_version_tag_filters_non_semver_tags() {
        assert!(is_version_tag("1.0.0"));
        assert!(is_version_tag("v3.1.2"));
        assert!(!is_version_tag("dev-build"));
        assert!(!is_version_tag("nightly"));
        assert!(!is_version_tag(""));
    }

    #[test]
    fn compare_versions_handles_v_prefix_and_returns_none_for_unparseable() {
        use std::cmp::Ordering;
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.0.0", "v2.0.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("29", "V29"), Some(Ordering::Equal));
        assert_eq!(compare_versions("v2.0.0", "1.0.0"), Some(Ordering::Greater));
        assert_eq!(compare_versions("dev-build", "1.0.0"), None);
    }

    #[test]
    fn is_newer_version_is_false_for_equal_and_downgrade() {
        assert!(is_newer_version("1.0.0", "2.0.0"));
        assert!(is_newer_version("1.0.0", "1.0.1"));
        assert!(!is_newer_version("2.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        // Unparseable → false (fail closed for downgrade-prevention).
        assert!(!is_newer_version("dev", "1.0.0"));
    }

    #[test]
    fn snooze_match_falls_back_to_nexus_version_when_github_tag_is_absent() {
        assert!(audit_snooze_matches(Some("1.0.3"), None, Some("1.0.3")));
        assert!(!audit_snooze_matches(Some("1.0.3"), None, Some("1.0.4")));
    }

    #[test]
    fn game_version_satisfies_fails_open_on_parse_errors() {
        // Strict happy path
        assert!(game_version_satisfies("0.105.0", "0.103.0"));
        assert!(game_version_satisfies("1.0.0", "1.0.0"));
        assert!(!game_version_satisfies("0.103.0", "0.105.0"));
        // Fail-open: any parse error makes the check pass so a quirky version
        // string doesn't lock the user out of installing.
        assert!(game_version_satisfies("dev", "0.105.0"));
        assert!(game_version_satisfies("0.105.0", "unknown"));
    }

    #[test]
    fn install_is_incompatible_only_flags_when_both_known_and_required_higher() {
        use crate::mods::ModInfo;
        let mk = |min: Option<&str>| ModInfo {
            mod_version_id: None,
            name: "x".into(),
            version: "1.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: None,
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: min.map(String::from),
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
            ..Default::default()
        };
        assert!(install_is_incompatible(
            &mk(Some("0.110.0")),
            Some("0.105.0")
        ));
        assert!(!install_is_incompatible(
            &mk(Some("0.100.0")),
            Some("0.105.0")
        ));
        // Either side missing → not incompatible (fail open).
        assert!(!install_is_incompatible(&mk(None), Some("0.105.0")));
        assert!(!install_is_incompatible(&mk(Some("0.110.0")), None));
    }

    #[test]
    fn parse_github_source_extracts_owner_repo() {
        assert_eq!(
            parse_github_source("github:foo/bar"),
            Some(("foo".into(), "bar".into()))
        );
        assert_eq!(parse_github_source("github:foo/"), None);
        assert_eq!(parse_github_source("github:/bar"), None);
        assert_eq!(parse_github_source("foo/bar"), None); // missing prefix
    }

    #[test]
    fn parse_owner_repo_splits_or_fails() {
        assert_eq!(
            parse_owner_repo("foo/bar"),
            Some(("foo".into(), "bar".into()))
        );
        assert_eq!(parse_owner_repo("foo/"), None);
        assert_eq!(parse_owner_repo("/bar"), None);
        assert_eq!(parse_owner_repo("just-one"), None);
    }

    /// Regression: parse_owner_repo used to accept full GitHub URLs and
    /// silently splitn(2) on the first '/', producing owner="https:" and
    /// repo="/github.com/BAKAOLC/STS2-MultiPlayerPotionView". That garbage
    /// pair got pasted into the GitHub API URL, producing 404s like
    /// `repos/https://github.com/.../releases/latest`. URLs (anything
    /// containing ':' or with 3+ slash-separated parts) MUST be rejected
    /// here so the caller can fall back to parse_github_url instead.
    #[test]
    fn parse_owner_repo_rejects_full_github_urls() {
        assert_eq!(
            parse_owner_repo("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView"),
            None,
        );
        assert_eq!(parse_owner_repo("http://github.com/owner/repo"), None,);
        // Three-segment input (owner/repo/extra) is also not a bare pair.
        assert_eq!(parse_owner_repo("foo/bar/baz"), None);
    }

    #[test]
    fn parse_github_url_extracts_owner_repo_and_trims_git_suffix() {
        assert_eq!(
            parse_github_url("https://github.com/ritsu/sts2-ritsulib/releases"),
            Some(("ritsu".into(), "sts2-ritsulib".into())),
        );
        assert_eq!(
            parse_github_url("https://github.com/ritsu/sts2-ritsulib.git"),
            Some(("ritsu".into(), "sts2-ritsulib".into())),
        );
        assert_eq!(
            parse_github_url("https://example.com/ritsu/sts2-ritsulib"),
            None
        );
    }

    #[test]
    fn resolve_github_repo_uses_folder_first_manual_source() {
        let info = mod_info(|m| {
            m.name = "SharedName".into();
            m.folder_name = Some("RitsuLib".into());
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "SharedName".into(),
            ModSourceEntry {
                github_repo: Some("wrong/name-key".into()),
                ..Default::default()
            },
        );
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                github_repo: Some("ritsu/sts2-ritsulib".into()),
                ..Default::default()
            },
        );

        assert_eq!(
            resolve_github_repo(&info, &sources),
            Some(("ritsu".into(), "sts2-ritsulib".into())),
        );
    }

    /// Regression for #139: a tester had BaseLib displayed as
    /// "[BASE] BaseLib" while the manually linked source was saved under
    /// the stable install folder "BaseLib". Update/repair must resolve the
    /// folder-keyed manual GitHub source instead of looking only at the
    /// decorated display name and reporting "no GitHub source linked".
    #[test]
    fn resolve_github_repo_handles_decorated_baselib_display_name() {
        let info = mod_info(|m| {
            m.name = "[BASE] BaseLib".into();
            m.folder_name = Some("BaseLib".into());
            m.mod_id = Some("BaseLib".into());
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "BaseLib".into(),
            ModSourceEntry {
                github_repo: Some("Alchyr/BaseLib-STS2".into()),
                ..Default::default()
            },
        );

        assert_eq!(
            resolve_github_repo(&info, &sources),
            Some(("Alchyr".into(), "BaseLib-STS2".into())),
        );
    }

    /// Regression: pre-1.4.3 the "already on chosen" gate in `update_mod`
    /// formatted the chosen tag with `(v{})` while `chosen.tag` already
    /// started with a `v`, producing `(vv0.2.32)`. The fix strips the
    /// leading `v` before interpolating.
    #[test]
    fn already_on_chosen_message_strips_double_v_prefix() {
        let info = mod_info(|m| {
            m.name = "RitsuLib".into();
            m.version = "0.2.32".into();
        });
        let sources = std::collections::HashMap::new();
        let msg = already_on_chosen_message(
            "v0.2.32",
            "BAKAOLC",
            "STS2-RitsuLib",
            &info,
            &sources,
            "RitsuLib",
        )
        .expect("gate should fire when manifest_ver matches chosen");
        assert!(
            msg.contains("(v0.2.32)"),
            "msg should contain (v0.2.32): {}",
            msg
        );
        assert!(
            !msg.contains("vv0.2.32"),
            "msg should not contain vv0.2.32: {}",
            msg
        );
    }

    /// Regression: pre-1.4.3 the gate's installed_tag lookup was
    /// `sources.get(&name)` — name-key only — even though every other
    /// path (audit, update_mod write, rollback write) used folder-first
    /// via `lookup_entry`. After a rollback wrote `installed_version`
    /// under the folder key, the next Update read empty from the
    /// name key and incorrectly fell back to comparing only against
    /// manifest_ver. This test pins the folder-first lookup so a
    /// folder-key-only entry is found by the gate.
    #[test]
    fn already_on_chosen_message_uses_folder_first_lookup() {
        let info = mod_info(|m| {
            m.name = "RitsuLib (STS2 0.103.2 compat)".into();
            m.folder_name = Some("STS2-RitsuLib".into());
            // manifest version DIFFERS from installed_version — only the
            // folder-keyed sources entry can prove the user is on chosen.
            m.version = "unknown".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "STS2-RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("v0.2.32".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        // chosen=v0.2.32 matches the folder-keyed installed_version → fire
        assert!(already_on_chosen_message(
            "v0.2.32",
            "BAKAOLC",
            "STS2-RitsuLib",
            &info,
            &sources,
            &info.name,
        )
        .is_some());
    }

    /// Inverse of the above: when the folder-keyed installed_version
    /// is BELOW the chosen tag (e.g. the user just rolled back), the
    /// gate must NOT fire — the update should proceed.
    #[test]
    fn already_on_chosen_message_returns_none_after_rollback_to_lower_version() {
        let info = mod_info(|m| {
            m.name = "RitsuLib (STS2 0.103.2 compat)".into();
            m.folder_name = Some("STS2-RitsuLib".into());
            m.version = "0.2.31".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "STS2-RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("v0.2.31".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        // chosen=v0.2.32 vs installed=v0.2.31 → update should proceed
        assert_eq!(
            already_on_chosen_message(
                "v0.2.32",
                "BAKAOLC",
                "STS2-RitsuLib",
                &info,
                &sources,
                &info.name,
            ),
            None,
        );
    }

    /// Regression: pre-1.4.3, the SourceEditor stored whatever string the
    /// user typed into the GitHub field — including full URLs — and the
    /// audit then called parse_owner_repo on that value, silently
    /// splitting "https://github.com/owner/repo" into owner="https:" and
    /// repo="/github.com/owner/repo". 1.4.3 makes parse_owner_repo strict;
    /// resolve_github_repo MUST fall back to parse_github_url so users
    /// with existing URL-form entries still resolve correctly without
    /// editing their mod_sources.json by hand.
    #[test]
    fn resolve_github_repo_recovers_when_db_entry_is_a_full_github_url() {
        let info = mod_info(|m| {
            m.name = "Multiplayer Potion View".into();
            m.folder_name = Some("STS2-MultiPlayerPotionView-168-0-2-0-1774530567".into());
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "STS2-MultiPlayerPotionView-168-0-2-0-1774530567".into(),
            ModSourceEntry {
                github_repo: Some("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView".into()),
                ..Default::default()
            },
        );

        assert_eq!(
            resolve_github_repo(&info, &sources),
            Some(("BAKAOLC".into(), "STS2-MultiPlayerPotionView".into())),
        );
    }

    #[test]
    fn resolve_github_repo_skips_auto_detected_and_uses_manifest_url() {
        let info = mod_info(|m| {
            m.github_url = Some("https://github.com/ritsu/sts2-ritsulib".into());
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                github_repo: Some("wrong/auto-detected".into()),
                github_auto_detected: true,
                ..Default::default()
            },
        );

        assert_eq!(
            resolve_github_repo(&info, &sources),
            Some(("ritsu".into(), "sts2-ritsulib".into())),
        );
    }

    #[test]
    fn best_known_installed_version_prefers_highest_usable_source_or_manifest_version() {
        let info = mod_info(|m| {
            m.version = "0.2.30".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("v0.2.31".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );
        assert_eq!(
            best_known_installed_version(&info, &sources)
                .unwrap()
                .to_string(),
            "0.2.31",
        );

        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("unknown".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );
        assert_eq!(
            best_known_installed_version(&info, &sources)
                .unwrap()
                .to_string(),
            "0.2.30",
        );
    }

    #[test]
    fn installed_source_version_for_display_preserves_source_tag_separately_from_manifest() {
        let info = mod_info(|m| {
            m.name = "Unified Save Path".into();
            m.folder_name = Some("UnifiedSavePath".into());
            m.version = "1.0.0".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "UnifiedSavePath".into(),
            ModSourceEntry {
                installed_version: Some("v1.1.3".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        assert_eq!(
            installed_source_version_for_display(&info, &sources).as_deref(),
            Some("1.1.3"),
        );
        assert_eq!(
            best_known_installed_version(&info, &sources)
                .unwrap()
                .to_string(),
            "1.1.3",
        );
        assert_eq!(info.version, "1.0.0");
    }

    fn write_mod_folder(
        base: &Path,
        folder: &str,
        id: &str,
        name: &str,
        version: &str,
        dll_bytes: &str,
    ) {
        let folder_path = base.join(folder);
        std::fs::create_dir_all(&folder_path).unwrap();
        std::fs::write(
            folder_path.join("manifest.json"),
            format!(r#"{{"id":"{id}","name":"{name}","version":"{version}"}}"#),
        )
        .unwrap();
        std::fs::write(folder_path.join(format!("{id}.dll")), dll_bytes).unwrap();
    }

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut writer, bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn save_profile_with_mod(
        profiles_path: &Path,
        name: &str,
        info: &ModInfo,
    ) -> crate::profiles::Profile {
        let mut profile_mod = crate::profiles::profile_mod_from_installed(info);
        profile_mod.mod_version_id = info.mod_version_id.clone();
        let profile = crate::profiles::Profile {
            id: format!("{name}-id"),
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![profile_mod],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: std::collections::HashMap::new(),
        };
        crate::profiles::save_profile(&profile, profiles_path).unwrap();
        profile
    }

    fn enriched_installed(
        mods_path: &Path,
        disabled_path: &Path,
        config_path: &Path,
    ) -> Vec<ModInfo> {
        let mut installed =
            merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path));
        crate::mod_sources::enrich_mods_with_sources(&mut installed, config_path);
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config_path);
        installed
    }

    #[test]
    fn promote_downloaded_artifact_updates_library_lane_and_keeps_profile_pin() {
        for old_enabled in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let mods_path = tmp.path().join("mods");
            let disabled_path = tmp.path().join("mods_disabled");
            let profiles_path = tmp.path().join("profiles");
            let cache_path = tmp.path().join("cache");
            let config_path = tmp.path().join("config");
            std::fs::create_dir_all(&mods_path).unwrap();
            std::fs::create_dir_all(&disabled_path).unwrap();
            std::fs::create_dir_all(&profiles_path).unwrap();
            std::fs::create_dir_all(&cache_path).unwrap();
            std::fs::create_dir_all(&config_path).unwrap();

            let old_base = if old_enabled {
                &mods_path
            } else {
                &disabled_path
            };
            write_mod_folder(
                old_base,
                "Watcher",
                "Watcher",
                "Watcher",
                "1.4.2",
                "old-bytes",
            );

            let mut installed = enriched_installed(&mods_path, &disabled_path, &config_path);
            let mut old_info = installed.remove(0);
            crate::mod_versions::cache_mod_version_by_id_with_source_version(
                &mut old_info,
                old_base,
                &cache_path,
                &config_path,
                Some("1.4.2"),
            )
            .unwrap();
            crate::mod_sources::update_installed_version_from_source(
                "Watcher",
                "1.4.2",
                "github",
                &config_path,
            );
            let profile = save_profile_with_mod(&profiles_path, "Stable", &old_info);
            let old_profile_id = profile.mods[0].mod_version_id.clone();

            let zip_path = tmp.path().join("Watcher-1.4.3.zip");
            write_archive(
                &zip_path,
                &[
                    (
                        "Watcher/manifest.json",
                        br#"{"id":"Watcher","name":"Watcher","version":"1.4.3"}"#,
                    ),
                    ("Watcher/Watcher.dll", b"new-bytes"),
                ],
            );

            let outcome = promote_archive_to_library(
                &zip_path,
                &old_info,
                Some("github:owner/watcher".into()),
                Some("1.4.3"),
                "github",
                &mods_path,
                Some(&disabled_path),
                &profiles_path,
                &cache_path,
                &config_path,
                None,
            )
            .unwrap();

            assert_eq!(outcome.mod_info.version, "1.4.3");
            assert_eq!(outcome.mod_info.enabled, old_enabled);
            let new_base = if old_enabled {
                &mods_path
            } else {
                &disabled_path
            };
            let other_base = if old_enabled {
                &disabled_path
            } else {
                &mods_path
            };
            assert_eq!(
                std::fs::read_to_string(new_base.join("Watcher").join("Watcher.dll")).unwrap(),
                "new-bytes"
            );
            assert!(
                !other_base.join("Watcher").exists(),
                "promotion should stay in the original active/stored lane"
            );

            let saved = crate::profiles::load_profile("Stable", &profiles_path).unwrap();
            assert_eq!(saved.mods[0].mod_version_id, old_profile_id);
            let old_cached = crate::mod_versions::get_cached_mod_path_for_profile_mod(
                &cache_path,
                &config_path,
                &saved.mods[0],
            )
            .expect("old profile-pinned artifact should remain cached");
            assert!(old_cached.exists());
        }
    }

    #[test]
    fn promote_nexus_update_does_not_relabel_workshop_owned_source() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let profiles_path = tmp.path().join("profiles");
        let cache_path = tmp.path().join("cache");
        let config_path = tmp.path().join("config");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();
        std::fs::create_dir_all(&cache_path).unwrap();
        std::fs::create_dir_all(&config_path).unwrap();

        write_mod_folder(
            &mods_path,
            "Watcher",
            "Watcher",
            "Watcher",
            "1.4.3",
            "steam-owned",
        );
        let mut installed = enriched_installed(&mods_path, &disabled_path, &config_path);
        let mut old_info = installed.remove(0);
        old_info.install_source = crate::mods::ModInstallSource::SteamWorkshop;
        old_info.workshop_item_id = Some("3747602295".into());
        old_info.workshop_url = Some(crate::mods::workshop_url("3747602295"));
        crate::mod_sources::save_sources(
            &crate::mod_sources::ModSourcesDb {
                mods: [(
                    "Watcher".into(),
                    ModSourceEntry {
                        workshop_item_id: Some("3747602295".into()),
                        workshop_url: Some(crate::mods::workshop_url("3747602295")),
                        installed_version: Some("steam-current".into()),
                        installed_version_source: Some("steam_workshop".into()),
                        ..Default::default()
                    },
                )]
                .into_iter()
                .collect(),
            },
            &config_path,
        )
        .unwrap();

        let nexus_zip = tmp
            .path()
            .join("The Watcher - 1.4.22 - StS2 - v0.107.1-46-1-4-22-1780935880.zip");
        write_archive(
            &nexus_zip,
            &[
                (
                    "Watcher/manifest.json",
                    br#"{"id":"Watcher","name":"Watcher","version":"1.4.22"}"#,
                ),
                ("Watcher/Watcher.dll", b"nexus-bytes"),
            ],
        );

        promote_archive_to_library(
            &nexus_zip,
            &old_info,
            Some("https://www.nexusmods.com/slaythespire2/mods/46".into()),
            Some("1.4.22"),
            "nexus",
            &mods_path,
            Some(&disabled_path),
            &profiles_path,
            &cache_path,
            &config_path,
            None,
        )
        .unwrap();

        let sources = crate::mod_sources::load_sources(&config_path);
        let entry = sources.mods.get("Watcher").unwrap();
        assert_eq!(entry.workshop_item_id.as_deref(), Some("3747602295"));
        assert_eq!(entry.installed_version.as_deref(), Some("steam-current"));
        assert_eq!(
            entry.installed_version_source.as_deref(),
            Some("steam_workshop")
        );
        assert_eq!(entry.nexus_file_id, None);
    }

    #[test]
    fn promote_nexus_main_branch_version_keeps_cached_beta_versions_selectable() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let profiles_path = tmp.path().join("profiles");
        let cache_path = tmp.path().join("cache");
        let config_path = tmp.path().join("config");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();
        std::fs::create_dir_all(&cache_path).unwrap();
        std::fs::create_dir_all(&config_path).unwrap();

        let nexus_url = "https://www.nexusmods.com/slaythespire2/mods/46";
        write_mod_folder(
            &mods_path,
            "Watcher",
            "Watcher",
            "Watcher",
            "1.4.20",
            "beta-current",
        );
        let mut installed = enriched_installed(&mods_path, &disabled_path, &config_path);
        let mut old_info = installed.remove(0);
        old_info.source = Some(nexus_url.into());
        crate::mod_versions::cache_mod_version_by_id_with_source_version(
            &mut old_info,
            &mods_path,
            &cache_path,
            &config_path,
            Some("1.4.20"),
        )
        .unwrap();
        crate::mod_sources::update_installed_version_from_source(
            "Watcher",
            "1.4.20",
            "nexus",
            &config_path,
        );

        let beta_cache_base = tmp.path().join("beta-cache");
        write_mod_folder(
            &beta_cache_base,
            "Watcher",
            "Watcher",
            "Watcher",
            "1.4.22",
            "beta-cached",
        );
        let mut cached_beta = scan_mods(&beta_cache_base).remove(0);
        cached_beta.source = Some(nexus_url.into());
        crate::mod_versions::cache_mod_version_by_id_with_source_version(
            &mut cached_beta,
            &beta_cache_base,
            &cache_path,
            &config_path,
            Some("1.4.22"),
        )
        .expect("cached beta branch version should be written");

        let main_zip = tmp
            .path()
            .join("The Watcher - 1.4.3 - StS2 - v0.103.2-46-1-4-3-1777364274.zip");
        write_archive(
            &main_zip,
            &[
                (
                    "Watcher/manifest.json",
                    br#"{"id":"Watcher","name":"Watcher","version":"1.4.3"}"#,
                ),
                ("Watcher/Watcher.dll", b"main-branch"),
            ],
        );

        let outcome = promote_archive_to_library(
            &main_zip,
            &old_info,
            Some(nexus_url.into()),
            Some("1.4.3"),
            "nexus",
            &mods_path,
            Some(&disabled_path),
            &profiles_path,
            &cache_path,
            &config_path,
            None,
        )
        .unwrap();
        assert_eq!(outcome.mod_info.version, "1.4.3");
        assert_eq!(
            std::fs::read_to_string(mods_path.join("Watcher").join("Watcher.dll")).unwrap(),
            "main-branch"
        );

        let mut refreshed = enriched_installed(&mods_path, &disabled_path, &config_path);
        let current = refreshed.pop().unwrap();
        let current_record = crate::mod_versions::record_by_id(
            &config_path,
            current.mod_version_id.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(current_record.source_version.as_deref(), Some("1.4.3"));

        let options = crate::mod_versions::local_version_options_for_target(
            &[current.clone()],
            &[],
            &config_path,
            &cache_path,
            &current.name,
            current.mod_version_id.as_deref(),
            current.mod_id.as_deref(),
        );
        let versions = options
            .iter()
            .map(|option| option.version.as_str())
            .collect::<Vec<_>>();
        assert!(versions.contains(&"1.4.3"));
        assert!(versions.contains(&"1.4.20"));
        assert!(versions.contains(&"1.4.22"));
        assert!(crate::mod_versions::has_local_version_for_mod(
            &config_path,
            &cache_path,
            &current,
            "1.4.3",
        ));
        assert!(crate::mod_versions::has_local_version_for_mod(
            &config_path,
            &cache_path,
            &current,
            "1.4.22",
        ));
        assert!(
            !crate::mod_versions::has_local_version_for_mod(
                &config_path,
                &cache_path,
                &current,
                "1.4.21",
            ),
            "cached beta 1.4.22 must not suppress a different advertised file version"
        );
    }

    #[test]
    fn promote_bundle_uses_nexus_source_version_and_keeps_members_in_container() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let profiles_path = tmp.path().join("profiles");
        let cache_path = tmp.path().join("cache");
        let config_path = tmp.path().join("config");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();
        std::fs::create_dir_all(&cache_path).unwrap();
        std::fs::create_dir_all(&config_path).unwrap();

        let old_zip = tmp
            .path()
            .join("AliceDefectSkin V2.0-979-2-0-1770000000.zip");
        write_archive(
            &old_zip,
            &[
                (
                    "AliceDefectSkin/manifest.json",
                    br#"{"id":"AliceDefectSkin","name":"Alice Defect Skin","version":"0.1.31"}"#,
                ),
                ("AliceDefectSkin/AliceDefectSkin.dll", b"old-skin"),
                (
                    "AliceDefectVoiceBridge/manifest.json",
                    br#"{"id":"AliceDefectVoiceBridge","name":"Alice Defect Voice Bridge","version":"0.1.31"}"#,
                ),
                (
                    "AliceDefectVoiceBridge/AliceDefectVoiceBridge.dll",
                    b"old-voice",
                ),
            ],
        );
        let mut old_info = crate::mods::install_mod_from_archive(&old_zip, &mods_path).unwrap();
        crate::mods::bundle::enrich_bundle_sidecar(
            &mods_path,
            &old_zip,
            Some("AliceDefectSkin V2.0"),
            Some("https://www.nexusmods.com/slaythespire2/mods/979".into()),
            Some("slaythespire2".into()),
            Some(979),
            Some("2.0".into()),
        );
        let mut sources = crate::mod_sources::load_sources(&config_path);
        let old_key = old_info
            .folder_name
            .clone()
            .unwrap_or_else(|| old_info.name.clone());
        sources.mods.insert(
            old_key.clone(),
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/979".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(979),
                installed_version: Some("2.0".into()),
                installed_version_source: Some("nexus".into()),
                ..Default::default()
            },
        );
        crate::mod_sources::save_sources(&sources, &config_path).unwrap();
        crate::mod_sources::enrich_mods_with_sources(
            std::slice::from_mut(&mut old_info),
            &config_path,
        );
        crate::mod_versions::cache_mod_version_by_id_with_source_version(
            &mut old_info,
            &mods_path,
            &cache_path,
            &config_path,
            Some("2.0"),
        )
        .unwrap();
        let profile = save_profile_with_mod(&profiles_path, "AlicePack", &old_info);
        let old_profile_id = profile.mods[0].mod_version_id.clone();

        let new_zip = tmp
            .path()
            .join("AliceDefectSkin V2.0-979-2-1-1780132414.zip");
        write_archive(
            &new_zip,
            &[
                (
                    "AliceDefectSkin/manifest.json",
                    br#"{"id":"AliceDefectSkin","name":"Alice Defect Skin","version":"0.1.31"}"#,
                ),
                ("AliceDefectSkin/AliceDefectSkin.dll", b"new-skin"),
                (
                    "AliceDefectVoiceBridge/manifest.json",
                    br#"{"id":"AliceDefectVoiceBridge","name":"Alice Defect Voice Bridge","version":"0.1.31"}"#,
                ),
                (
                    "AliceDefectVoiceBridge/AliceDefectVoiceBridge.dll",
                    b"new-voice",
                ),
            ],
        );

        let outcome = promote_archive_to_library(
            &new_zip,
            &old_info,
            Some("https://www.nexusmods.com/slaythespire2/mods/979".into()),
            Some("2.1"),
            "nexus",
            &mods_path,
            Some(&disabled_path),
            &profiles_path,
            &cache_path,
            &config_path,
            None,
        )
        .unwrap();

        assert_eq!(outcome.mod_info.bundle_member_ids.len(), 2);
        let mut refreshed = enriched_installed(&mods_path, &disabled_path, &config_path);
        assert_eq!(
            refreshed.len(),
            1,
            "bundle members should stay inside one Library container row"
        );
        let current = refreshed.pop().unwrap();
        assert_eq!(current.bundle_member_ids.len(), 2);
        let current_record = crate::mod_versions::record_by_id(
            &config_path,
            current.mod_version_id.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(current_record.source_version.as_deref(), Some("2.1"));
        assert_eq!(
            std::fs::read_to_string(
                mods_path
                    .join(current.folder_name.as_deref().unwrap())
                    .join("AliceDefectSkin")
                    .join("AliceDefectSkin.dll")
            )
            .unwrap(),
            "new-skin"
        );

        let saved = crate::profiles::load_profile("AlicePack", &profiles_path).unwrap();
        assert_eq!(saved.mods[0].mod_version_id, old_profile_id);
        let old_cached = crate::mod_versions::get_cached_mod_path_for_profile_mod(
            &cache_path,
            &config_path,
            &saved.mods[0],
        )
        .expect("old bundle artifact should remain cached");
        assert!(old_cached.exists());

        let options = crate::mod_versions::local_version_options_for_target(
            &[current.clone()],
            &[saved],
            &config_path,
            &cache_path,
            &current.name,
            current.mod_version_id.as_deref(),
            current.mod_id.as_deref(),
        );
        let versions = options
            .iter()
            .map(|option| option.version.as_str())
            .collect::<Vec<_>>();
        assert!(versions.contains(&"2.1"));
        assert!(versions.contains(&"2.0"));
    }

    #[test]
    fn promote_slaythestats_keeps_filename_versions_when_manifest_is_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let profiles_path = tmp.path().join("profiles");
        let cache_path = tmp.path().join("cache");
        let config_path = tmp.path().join("config");
        std::fs::create_dir_all(&mods_path).unwrap();
        std::fs::create_dir_all(&disabled_path).unwrap();
        std::fs::create_dir_all(&profiles_path).unwrap();
        std::fs::create_dir_all(&cache_path).unwrap();
        std::fs::create_dir_all(&config_path).unwrap();

        let nexus_url = "https://www.nexusmods.com/slaythespire2/mods/349";
        let old_zip = tmp
            .path()
            .join("SlayTheStats v1.2.0-349-v1-2-0-1780935880.zip");
        write_archive(
            &old_zip,
            &[
                (
                    "SlayTheStats/manifest.json",
                    br#"{"id":"SlayTheStats","name":"SlayTheStats","version":"0"}"#,
                ),
                ("SlayTheStats/SlayTheStats.dll", b"old-stats"),
            ],
        );
        let mut old_info = crate::mods::install_mod_from_archive(&old_zip, &mods_path).unwrap();
        old_info.source = Some(nexus_url.into());
        let old_source_version =
            crate::downloads_watcher::exact_download_source_version(&old_zip, &old_info.version)
                .expect("old filename should expose the Nexus file version");
        assert_eq!(old_source_version, "1.2.0");
        crate::mod_versions::cache_mod_version_by_id_with_source_version(
            &mut old_info,
            &mods_path,
            &cache_path,
            &config_path,
            Some(&old_source_version),
        )
        .unwrap();
        crate::mod_sources::update_installed_version_from_source(
            "SlayTheStats",
            "0",
            "nexus",
            &config_path,
        );

        let new_zip = tmp
            .path()
            .join("SlayTheStats v1.2.2-349-v1-2-2-1781935880.zip");
        write_archive(
            &new_zip,
            &[
                (
                    "SlayTheStats/manifest.json",
                    br#"{"id":"SlayTheStats","name":"SlayTheStats","version":"0"}"#,
                ),
                ("SlayTheStats/SlayTheStats.dll", b"new-stats"),
            ],
        );
        let new_source_version =
            crate::downloads_watcher::exact_download_source_version(&new_zip, "0")
                .expect("new filename should expose the Nexus file version");
        assert_eq!(new_source_version, "1.2.2");

        let outcome = promote_archive_to_library(
            &new_zip,
            &old_info,
            Some(nexus_url.into()),
            Some(&new_source_version),
            "nexus",
            &mods_path,
            Some(&disabled_path),
            &profiles_path,
            &cache_path,
            &config_path,
            None,
        )
        .unwrap();
        assert_eq!(outcome.mod_info.version, "0");

        let mut refreshed = enriched_installed(&mods_path, &disabled_path, &config_path);
        assert_eq!(refreshed.len(), 1);
        let current = refreshed.pop().unwrap();
        let current_record = crate::mod_versions::record_by_id(
            &config_path,
            current.mod_version_id.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(current_record.source_version.as_deref(), Some("1.2.2"));
        let old_record = crate::mod_versions::record_by_id(
            &config_path,
            old_info.mod_version_id.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(old_record.source_version.as_deref(), Some("1.2.0"));

        let options = crate::mod_versions::local_version_options_for_target(
            &[current.clone()],
            &[],
            &config_path,
            &cache_path,
            &current.name,
            current.mod_version_id.as_deref(),
            current.mod_id.as_deref(),
        );
        let versions = options
            .iter()
            .map(|option| option.version.as_str())
            .collect::<Vec<_>>();
        assert!(versions.contains(&"1.2.2"));
        assert!(versions.contains(&"1.2.0"));
        assert!(
            !versions.contains(&"0"),
            "manifest version 0 must not become a stored version label"
        );
    }

    #[test]
    fn rollback_release_target_reinstalls_known_good_when_manifest_is_unknown() {
        let info = mod_info(|m| {
            m.version = "unknown".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("v0.2.31".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        assert_eq!(
            rollback_release_target(&info, &sources).unwrap(),
            RollbackReleaseTarget::ReinstallKnownGood(parse_version("0.2.31").unwrap()),
        );
    }

    #[test]
    fn rollback_release_target_rolls_below_highest_known_when_manifest_is_usable() {
        let info = mod_info(|m| {
            m.version = "0.2.30".into();
        });
        let mut sources = std::collections::HashMap::new();
        sources.insert(
            "RitsuLib".into(),
            ModSourceEntry {
                installed_version: Some("v0.2.31".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        assert_eq!(
            rollback_release_target(&info, &sources).unwrap(),
            RollbackReleaseTarget::PreviousBelow(parse_version("0.2.31").unwrap()),
        );
    }

    #[test]
    fn is_mod_asset_recognizes_supported_extensions() {
        assert!(is_mod_asset("BaseLib.zip"));
        assert!(is_mod_asset("HighlightPotionCards.7z"));
        assert!(is_mod_asset("legacy-pack.rar"));
        assert!(is_mod_asset("mod.dll"));
        assert!(is_mod_asset("art.pck"));
        assert!(!is_mod_asset("README.md"));
        assert!(!is_mod_asset("source.tar.gz"));
    }

    fn github_asset(name: &str) -> crate::download::GitHubAsset {
        crate::download::GitHubAsset {
            name: name.into(),
            size: 123,
            browser_download_url: format!("https://example.invalid/{name}"),
            content_type: "application/octet-stream".into(),
            download_count: 0,
        }
    }

    fn github_release(tag: &str, assets: &[&str]) -> crate::download::GitHubRelease {
        crate::download::GitHubRelease {
            tag_name: tag.into(),
            name: Some(tag.into()),
            body: None,
            prerelease: false,
            published_at: None,
            assets: assets.iter().map(|name| github_asset(name)).collect(),
            html_url: format!("https://github.com/example/repo/releases/tag/{tag}"),
        }
    }

    #[test]
    fn first_versioned_release_with_mod_assets_skips_empty_and_non_mod_releases() {
        let releases = vec![
            github_release("v2.0.0", &[]),
            github_release("dev-build", &["DevBuild.zip"]),
            github_release("v1.9.0", &["README.md"]),
            github_release("v1.8.0", &["DependencyRich.zip", "notes.txt"]),
        ];

        let (candidate, scanned) = first_versioned_release_with_mod_assets(&releases);
        assert_eq!(scanned, 4);
        assert_eq!(
            candidate,
            Some(InstallableReleaseCandidate {
                tag_name: "v1.8.0".into(),
                asset_names: vec!["DependencyRich.zip".into()],
            }),
            "audit must not flag a no-assets or docs-only release as the actionable update"
        );
    }

    #[test]
    fn first_versioned_release_with_mod_assets_returns_none_when_no_installable_assets_exist() {
        let releases = vec![
            github_release("v2.0.0", &[]),
            github_release("v1.9.0", &["README.md", "source.tar.gz"]),
        ];

        let (candidate, scanned) = first_versioned_release_with_mod_assets(&releases);
        assert_eq!(scanned, 2);
        assert_eq!(
            candidate, None,
            "empty releases must not create a false update affordance"
        );
    }

    // ── Bundle / Nexus folder-first lookup tests ──────────────────────────

    #[test]
    fn walk_back_candidate_gate_rejects_dev_builds_and_empty_releases() {
        let releases = vec![
            github_release("dev-build", &["RitsuLib.zip"]),
            github_release("v0.4.25", &[]),
            github_release("v0.4.24", &["RitsuLib.github.zip"]),
        ];

        let candidates: Vec<_> = releases
            .iter()
            .filter(|release| is_walk_back_release_candidate(release))
            .map(|release| release.tag_name.as_str())
            .collect();

        assert_eq!(
            candidates,
            vec!["v0.4.24"],
            "bulk update walk-back must not install dev-build or empty releases"
        );
    }

    /// A bundle's `ModInfo` has no display name, no mod_id, and a
    /// `folder_name` set to the container folder. Its Nexus source MUST be
    /// findable via `lookup_entry` keyed by that folder — this is what the
    /// audit's Nexus phase calls after the fix.
    #[test]
    fn lookup_entry_finds_bundle_source_by_container_folder_name() {
        let mut sources = std::collections::HashMap::new();
        // The bundle's source is stored keyed by the container folder.
        sources.insert(
            "FantasyPack".into(),
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/99".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(99),
                installed_version: Some("1.0.0".into()),
                installed_version_source: None,
                ..Default::default()
            },
        );

        // Bundle ModInfo: folder_name="FantasyPack", name might be anything
        // (the container has no manifest-level name for us to trust).
        let entry = crate::mod_sources::lookup_entry(
            &sources,
            Some("FantasyPack"), // folder_name — the container
            "FantasyPack",       // name falls back to folder since bundle has no manifest name
            None,
        );
        assert!(
            entry.is_some(),
            "bundle source should be found by container folder_name"
        );
        let e = entry.unwrap();
        assert_eq!(e.nexus_mod_id, Some(99));
        assert_eq!(
            e.nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/99"),
        );
    }

    /// The `check_all_updates` Nexus phase now calls `lookup_entry` (folder-first).
    /// Verify that a bundle whose source is keyed by container folder is NOT
    /// skipped: it should reach the Nexus check (the source entry is found).
    #[test]
    fn nexus_audit_phase_lookup_finds_bundle_by_folder_not_name() {
        let mut sources = std::collections::HashMap::new();
        // Source keyed by container folder_name (not by m.name).
        sources.insert(
            "Pack".into(),
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/42".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(42),
                installed_version: Some("2.0.0".into()),
                installed_version_source: None,
                pinned: false,
                ..Default::default()
            },
        );

        // Bundle ModInfo: folder_name="Pack", name="Pack Bundle" (different from key)
        let bundle = mod_info(|m| {
            m.name = "Pack Bundle".into();
            m.folder_name = Some("Pack".into());
            m.mod_id = None;
            m.nexus_url = None; // nexus_url not on the ModInfo itself — it's in sources
        });

        // Simulate the fixed lookup from the Nexus phase of check_all_updates.
        let found = crate::mod_sources::lookup_entry(
            &sources,
            bundle.folder_name.as_deref(),
            &bundle.name,
            bundle.mod_id.as_deref(),
        );
        assert!(
            found.is_some(),
            "folder-first lookup should find source keyed by container folder 'Pack'"
        );
        assert_eq!(found.unwrap().nexus_mod_id, Some(42));

        // name-only lookup (the OLD broken path) would miss it.
        let old_path = sources.get(&bundle.name);
        assert!(
            old_path.is_none(),
            "name-only get should NOT find a source keyed by folder (regression guard)"
        );
    }

    /// When a bundle's Nexus version on the server (2.1.0) is newer than the
    /// installed version recorded in mod_sources (2.0.0), `is_newer_version`
    /// should flag an update available.
    #[test]
    fn nexus_update_detected_for_bundle_when_upstream_newer_than_installed() {
        let installed = "2.0.0";
        let upstream = "2.1.0";
        assert!(
            is_newer_version(installed, upstream),
            "upstream 2.1.0 should be flagged as newer than installed 2.0.0"
        );
    }

    /// When the upstream Nexus version matches installed, no update is needed.
    #[test]
    fn nexus_update_not_flagged_when_versions_match() {
        assert!(!is_newer_version("2.1.0", "2.1.0"));
        assert!(!is_newer_version("2.2.0", "2.1.0")); // downgrade also false
    }

    #[test]
    fn nexus_source_version_wins_over_stale_manifest_version() {
        let sources_ver = strip_version_prefix("29");
        let manifest_ver = strip_version_prefix("v1.15.4");
        let current_ver = if is_newer_version(manifest_ver, sources_ver) {
            sources_ver
        } else {
            manifest_ver
        };
        assert_eq!(current_ver, "29");
        assert!(
            !is_newer_version(current_ver, strip_version_prefix("V29")),
            "a Nexus install tracked as 29 should not keep reporting upstream V29"
        );
    }

    fn nexus_file(
        file_id: u64,
        name: &str,
        version: &str,
        uploaded_timestamp: i64,
    ) -> crate::nexus::NexusFile {
        crate::nexus::NexusFile {
            file_id,
            name: Some(name.into()),
            file_name: Some(format!("{name}.zip")),
            version: Some(version.into()),
            category_id: Some(1),
            uploaded_timestamp: Some(uploaded_timestamp),
        }
    }

    #[test]
    fn nexus_lane_resolver_keeps_watcher_release_off_beta_update() {
        let files = vec![
            nexus_file(
                1422,
                "The Watcher - 1.4.22 - StS2 - v0.107.1",
                "1.4.22",
                300,
            ),
            nexus_file(143, "The Watcher - 1.4.3 - StS2 - v0.103.2", "1.4.3", 200),
        ];
        let entry = ModSourceEntry {
            installed_version: Some("1.4.3".into()),
            ..Default::default()
        };

        assert_eq!(
            resolve_nexus_version_for_installed_lane(&files, Some(&entry), None).as_deref(),
            Some("1.4.3")
        );
    }

    #[test]
    fn nexus_lane_resolver_advances_watcher_beta_within_beta_lane() {
        let files = vec![
            nexus_file(
                1420,
                "The Watcher - 1.4.20 - StS2 - v0.107.1",
                "1.4.20",
                200,
            ),
            nexus_file(
                1422,
                "The Watcher - 1.4.22 - StS2 - v0.107.1",
                "1.4.22",
                300,
            ),
            nexus_file(143, "The Watcher - 1.4.3 - StS2 - v0.103.2", "1.4.3", 250),
        ];
        let entry = ModSourceEntry {
            installed_version: Some("1.4.20".into()),
            ..Default::default()
        };

        assert_eq!(
            resolve_nexus_version_for_installed_lane(&files, Some(&entry), None).as_deref(),
            Some("1.4.22")
        );
    }

    #[test]
    fn nexus_lane_resolver_uses_saved_file_id_to_find_newer_same_lane_file() {
        let files = vec![
            nexus_file(
                1420,
                "The Watcher - 1.4.20 - StS2 - v0.107.1",
                "1.4.20",
                200,
            ),
            nexus_file(
                1422,
                "The Watcher - 1.4.22 - StS2 - v0.107.1",
                "1.4.22",
                300,
            ),
            nexus_file(143, "The Watcher - 1.4.3 - StS2 - v0.103.2", "1.4.3", 250),
        ];
        let entry = ModSourceEntry {
            nexus_file_id: Some(1420),
            ..Default::default()
        };

        assert_eq!(
            resolve_nexus_version_for_installed_lane(&files, Some(&entry), None).as_deref(),
            Some("1.4.22")
        );
    }

    #[test]
    fn nexus_lane_resolver_matches_downloads_with_changing_suffixes() {
        let files = vec![
            nexus_file(1779793473, "Download-103-3-1-8-1779793473", "3.1.8", 200),
            nexus_file(1783123686, "Download-103-3-3-5-1783123686", "3.3.5", 300),
        ];
        let entry = ModSourceEntry {
            installed_version: Some("3.1.8".into()),
            nexus_file_id: Some(1779793473),
            nexus_file_lane_key: Some("download 103 1779793473".into()),
            ..Default::default()
        };

        assert_eq!(
            resolve_nexus_version_for_installed_lane(&files, Some(&entry), None).as_deref(),
            Some("3.3.5")
        );
    }

    #[test]
    fn nexus_lane_resolver_suppresses_same_version_multi_file_ambiguity() {
        let files = vec![
            nexus_file(1, "Necro Icons", "0.0.1", 300),
            nexus_file(2, "Silent_Icons", "0.0.1", 250),
            nexus_file(3, "Princess Text", "0.0.1", 200),
        ];
        let entry = ModSourceEntry {
            installed_version: Some("0.0.1".into()),
            ..Default::default()
        };

        assert_eq!(
            resolve_nexus_version_for_installed_lane(&files, Some(&entry), None),
            None
        );
    }

    /// Phase 1 (GitHub) pin check: a mod whose source entry is keyed by
    /// `folder_name` (e.g. a bundle keyed by its container folder "Pack") must
    /// be recognised as pinned even when `m.name` differs from the map key.
    /// Before the fix `sources.get(&m.name)` would return None and the pin
    /// would be silently ignored.
    #[test]
    fn github_phase1_pin_check_respects_folder_keyed_entry() {
        use crate::mod_sources::ModSourceEntry;

        let mut sources = std::collections::HashMap::new();
        // Pin recorded under folder_name "Pack", NOT under m.name "Pack Bundle".
        sources.insert(
            "Pack".into(),
            ModSourceEntry {
                pinned: true,
                ..Default::default()
            },
        );

        // Bundle whose name differs from the map key.
        let bundle = mod_info(|m| {
            m.name = "Pack Bundle".into();
            m.folder_name = Some("Pack".into());
            m.mod_id = None;
        });

        // Folder-first lookup (the fixed path) must find the pinned entry.
        let found = crate::mod_sources::lookup_entry(
            &sources,
            bundle.folder_name.as_deref(),
            &bundle.name,
            bundle.mod_id.as_deref(),
        );
        assert!(
            found.is_some(),
            "folder-first lookup should find source entry keyed by 'Pack'"
        );
        assert!(found.unwrap().pinned, "the found entry should be pinned");

        // Name-only lookup (the OLD broken path) would miss the pin entirely.
        let old_path = sources.get(&bundle.name);
        assert!(
            old_path.is_none(),
            "name-only get must NOT find an entry keyed by folder (regression guard)"
        );
    }

    /// Phase 1 (GitHub) installed_version check: a bundle's `installed_version`
    /// recorded under its folder_name key must suppress a false positive update
    /// when the installed version already matches the latest release tag.
    /// Before the fix `sources.get(&m.name)` would return None, so
    /// `installed_ver_matches` would be false and the update would be reported.
    #[test]
    fn github_phase1_installed_version_check_respects_folder_keyed_entry() {
        use crate::mod_sources::ModSourceEntry;

        let mut sources = std::collections::HashMap::new();
        // installed_version recorded under folder_name "Pack".
        sources.insert(
            "Pack".into(),
            ModSourceEntry {
                installed_version: Some("v1.5.0".into()),
                installed_version_source: None,
                pinned: false,
                ..Default::default()
            },
        );

        // Bundle whose name differs from the map key.
        let bundle = mod_info(|m| {
            m.name = "Pack Bundle".into();
            m.folder_name = Some("Pack".into());
            m.mod_id = None;
        });

        let latest = "1.5.0"; // latest release tag (stripped of 'v')

        // Folder-first lookup (the fixed path) must find installed_version.
        let entry = crate::mod_sources::lookup_entry(
            &sources,
            bundle.folder_name.as_deref(),
            &bundle.name,
            bundle.mod_id.as_deref(),
        );
        let installed_ver_matches = entry
            .and_then(|e| e.installed_version.as_deref().map(str::to_owned))
            .map(|iv| iv.trim_start_matches('v').to_owned() == latest)
            .unwrap_or(false);
        assert!(
            installed_ver_matches,
            "folder-first lookup should detect that installed_version matches latest"
        );

        // Name-only lookup (the OLD broken path) would have returned None →
        // installed_ver_matches = false → spurious update reported.
        let old_path_matches = sources
            .get(&bundle.name)
            .and_then(|e| e.installed_version.as_deref())
            .map(|iv| iv.trim_start_matches('v') == latest)
            .unwrap_or(false);
        assert!(
            !old_path_matches,
            "name-only path must NOT find installed_version for folder-keyed entry (regression guard)"
        );
    }
}

// ── Audit ───────────────────────────────────────────────────────────────────

/// Detailed audit entry for a single mod's version status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModAuditEntry {
    /// Stable installed-artifact identity. Profiles use this to pin a
    /// specific local/shared mod version, and the UI uses it to refresh the
    /// exact row that changed instead of replacing every same-named mod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version_id: Option<String>,
    pub mod_name: String,
    /// On-disk folder name for the installed mod. Surfaced so the UI can
    /// disambiguate (and pin/unpin) two mods that share a display name
    /// but live in different folders — without this, Settings would pin
    /// both same-named entries simultaneously.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    pub github_repo: Option<String>,
    /// Version declared by the installed mod's manifest on disk.
    pub manifest_version: String,
    /// Version/tag the manager last installed from a trusted source. This
    /// can differ from manifest_version when the upstream manifest is stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_source_version: Option<String>,
    /// Legacy display/update field. New UI should prefer manifest_version
    /// and installed_source_version.
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
    /// True when the user has snoozed the update suggestion for this mod
    /// at its current GitHub release tag or Nexus version. The audit still
    /// runs and the entry still appears in the list; the UI suppresses
    /// the "update available" badge and excludes the row from the audit
    /// count. When the upstream version advances past the snoozed one the
    /// flag flips back to false automatically — the snooze auto-expires.
    /// Distinct from `pinned`: pinning is a hard freeze on auto-update,
    /// snoozing is "stop nagging me about THIS specific release."
    #[serde(default)]
    pub snoozed: bool,
    #[serde(default)]
    pub update_plans: Vec<UpdatePlanItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ModAuditSelector {
    Name(String),
    Target(ModAuditTarget),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModAuditTarget {
    #[serde(default)]
    pub mod_version_id: Option<String>,
    #[serde(default)]
    pub folder_name: Option<String>,
    #[serde(default)]
    pub mod_id: Option<String>,
    pub name: String,
}

impl ModAuditTarget {
    fn matches(&self, info: &ModInfo) -> bool {
        if let Some(target) = self.mod_version_id.as_deref().filter(|v| !v.is_empty()) {
            return info.mod_version_id.as_deref().filter(|v| !v.is_empty()) == Some(target);
        }
        if let (Some(target), Some(actual)) = (
            self.folder_name.as_deref().filter(|v| !v.is_empty()),
            info.folder_name.as_deref().filter(|v| !v.is_empty()),
        ) {
            return target == actual;
        }
        if let (Some(target), Some(actual)) = (
            self.mod_id.as_deref().filter(|v| !v.is_empty()),
            info.mod_id.as_deref().filter(|v| !v.is_empty()),
        ) {
            return target == actual;
        }
        self.mod_version_id.as_deref().is_none_or(str::is_empty)
            && self.folder_name.as_deref().is_none_or(str::is_empty)
            && self.mod_id.as_deref().is_none_or(str::is_empty)
            && self.name == info.name
    }

    fn matches_update(&self, update: &ModUpdate) -> bool {
        if let Some(target) = self.mod_version_id.as_deref().filter(|v| !v.is_empty()) {
            return update.mod_version_id.as_deref() == Some(target);
        }
        if let Some(target) = self.folder_name.as_deref().filter(|v| !v.is_empty()) {
            return update.folder_name.as_deref() == Some(target);
        }
        self.name == update.mod_name
    }
}

impl ModAuditSelector {
    fn matches(&self, info: &ModInfo) -> bool {
        match self {
            ModAuditSelector::Name(name) => info.name == *name,
            ModAuditSelector::Target(target) => target.matches(info),
        }
    }
}

/// Valid mod asset extensions for STS2 mods.
fn is_mod_asset(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".7z")
        || lower.ends_with(".rar")
        || lower.ends_with(".dll")
        || lower.ends_with(".pck")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallableReleaseCandidate {
    tag_name: String,
    asset_names: Vec<String>,
}

fn first_versioned_release_with_mod_assets(
    releases: &[crate::download::GitHubRelease],
) -> (Option<InstallableReleaseCandidate>, u32) {
    let mut scanned = 0;
    for release in releases {
        scanned += 1;
        // Skip non-version tags (e.g. "dev-build", "nightly").
        if !is_version_tag(&release.tag_name) {
            continue;
        }
        let asset_names: Vec<String> = release
            .assets
            .iter()
            .filter(|a| is_mod_asset(&a.name))
            .map(|a| a.name.clone())
            .collect();
        if !asset_names.is_empty() {
            return (
                Some(InstallableReleaseCandidate {
                    tag_name: release.tag_name.clone(),
                    asset_names,
                }),
                scanned,
            );
        }
    }
    (None, scanned)
}

/// Audit installed mods against their latest GitHub releases.
///
/// For each mod with a GitHub source, fetches releases (paginated) to find
/// the most recent release that actually has downloadable mod files
/// (.zip, .dll, .pck). This validates that the update-checking logic
/// correctly skips empty releases.
///
/// Immutable inputs the per-mod audit body needs. Held by reference so
/// we can share it across the concurrent stream without cloning per mod.
struct AuditCtx<'a> {
    sources_db: &'a crate::mod_sources::ModSourcesDb,
    nexus_api_key: Option<&'a str>,
    user_game_version: Option<&'a str>,
    config_path: &'a std::path::Path,
    cache_path: &'a std::path::Path,
    token: Option<&'a str>,
}

/// How many per-mod audit tasks can run concurrently. 8 is empirically the
/// sweet spot for GitHub's secondary rate limit on unauthenticated clients —
/// high enough to mask network latency, low enough to stay under the
/// 100/min secondary cap.
const AUDIT_CONCURRENCY: usize = 8;

/// `only` — optional whitelist of mod names. When `Some(names)` we audit
/// only those mods (used by the UI to refresh just the rows that changed
/// after a single-mod or bulk update, instead of forcing a full audit
/// every time). When `None` we audit every installed mod.
#[tauri::command]
pub async fn audit_mod_versions(
    only: Option<Vec<ModAuditSelector>>,
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
    all_mods.extend(crate::mods::scan_workshop_mods_for_mods_path(&mods_path));
    crate::mod_versions::enrich_mods_with_versions(&mut all_mods, &config_path);

    // If the caller asked for a subset, prune everything else up front so
    // we skip the (slow) per-mod GitHub/Nexus calls for mods we don't care
    // about right now.
    if let Some(filter) = only.as_ref() {
        all_mods.retain(|m| filter.iter().any(|selector| selector.matches(m)));
    }

    let sources_db = load_sources(&config_path);

    // Collect Nexus API key + the user's detected game version. The game
    // version drives the per-row "won't load on your build" flag — None
    // means we couldn't read release_info.json, in which case we
    // fail-open (every mod is treated as compatible) rather than blocking
    // every row on a guess.
    let (nexus_api_key, user_game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.nexus_api_key.clone(), s.game_version.clone())
    };

    let ctx = AuditCtx {
        sources_db: &sources_db,
        nexus_api_key: nexus_api_key.as_deref(),
        user_game_version: user_game_version.as_deref(),
        config_path: &config_path,
        cache_path: &cache_path,
        token: token.as_deref(),
    };

    let futures: Vec<_> = all_mods.iter().map(|m| audit_one_mod(m, &ctx)).collect();
    let mut results: Vec<ModAuditEntry> = stream::iter(futures)
        .buffer_unordered(AUDIT_CONCURRENCY)
        .collect()
        .await;

    // buffer_unordered yields results in completion order. Re-sort by the mod's
    // display name so the UI render order is stable across audits (filesystem
    // scan order was non-deterministic anyway).
    results.sort_by(|a, b| a.mod_name.to_lowercase().cmp(&b.mod_name.to_lowercase()));

    Ok(results)
}

/// Audit one mod. Returns an entry even for mods with no source linked.
/// Errors at the per-source level (GitHub 404, Nexus rate-limit, etc.) are
/// captured into `ModAuditEntry.error` — this function returns `ModAuditEntry`
/// rather than `Result` because a single mod failing must not cancel the
/// rest of the stream when this is called concurrently.
fn audit_target(m: &ModInfo) -> ModAuditTarget {
    ModAuditTarget {
        mod_version_id: m.mod_version_id.clone(),
        folder_name: m.folder_name.clone(),
        mod_id: m.mod_id.clone(),
        name: m.name.clone(),
    }
}

fn update_plan_item(
    m: &ModInfo,
    current_version: String,
    target_version: Option<String>,
    provider: &str,
    source: Option<String>,
    pinned: bool,
    pending: bool,
) -> UpdatePlanItem {
    let target_version = (provider != "steam").then_some(target_version).flatten();
    let capability = if pinned {
        UpdateAcquisitionCapability::Frozen
    } else if provider == "steam" {
        UpdateAcquisitionCapability::SteamManaged
    } else if provider == "github" && !m.install_source.is_workshop() {
        UpdateAcquisitionCapability::Downloadable
    } else {
        UpdateAcquisitionCapability::Manual
    };
    let selectable = pending && capability == UpdateAcquisitionCapability::Downloadable;
    let reason = match capability {
        UpdateAcquisitionCapability::Downloadable if pending => {
            "GitHub release is ready to download"
        }
        UpdateAcquisitionCapability::Manual if pending => {
            "Open the provider page to download this update"
        }
        UpdateAcquisitionCapability::SteamManaged if pending => "Steam manages this update",
        UpdateAcquisitionCapability::Frozen => "Frozen versions are excluded",
        _ => "No update is currently pending",
    }
    .to_string();
    UpdatePlanItem {
        target: audit_target(m),
        current_version,
        target_version,
        provider: provider.into(),
        source,
        capability,
        reason,
        selectable,
        pending,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_update_plans(
    m: &ModInfo,
    installed_version: &str,
    github_installed_version: Option<&str>,
    display_github: Option<&str>,
    github_target: Option<&str>,
    github_needs_update: bool,
    nexus_url: Option<&str>,
    nexus_installed_version: Option<&str>,
    nexus_version: Option<&str>,
    nexus_update_available: bool,
    is_pinned: bool,
    snoozed: bool,
    workshop_pending: bool,
) -> Vec<UpdatePlanItem> {
    let mut plans = Vec::new();
    if m.install_source == ModInstallSource::SteamWorkshop {
        plans.push(update_plan_item(
            m,
            installed_version.to_string(),
            None,
            "steam",
            m.workshop_url.clone(),
            false,
            workshop_pending,
        ));
    }
    if let Some(github) = display_github {
        plans.push(update_plan_item(
            m,
            github_installed_version
                .unwrap_or(installed_version)
                .to_string(),
            github_target.map(str::to_string),
            "github",
            Some(github.to_string()),
            is_pinned,
            !is_pinned && !snoozed && github_needs_update,
        ));
    }
    if nexus_url.is_some() || nexus_version.is_some() {
        plans.push(update_plan_item(
            m,
            nexus_installed_version
                .unwrap_or(installed_version)
                .to_string(),
            nexus_version.map(str::to_string),
            "nexus",
            nexus_url.map(str::to_string),
            is_pinned,
            !is_pinned && !snoozed && nexus_update_available,
        ));
    }
    plans
}

async fn audit_one_mod(m: &ModInfo, ctx: &AuditCtx<'_>) -> ModAuditEntry {
    let workshop_pending =
        m.install_source == ModInstallSource::SteamWorkshop && m.workshop_update_pending;
    // Source-entry lookup is folder-first to match enrich_mods_with_sources
    // and the pin_mod write path. Otherwise a mod pinned from the Mods view
    // (saved under its folder_name) wouldn't show as pinned in this audit,
    // and the Settings unpin click would no-op because we'd hand back a
    // pinned=false to the UI for an entry that IS pinned in the DB.
    let source_entry = m
        .folder_name
        .as_ref()
        .and_then(|f| ctx.sources_db.mods.get(f))
        .or_else(|| ctx.sources_db.mods.get(&m.name))
        .or_else(|| m.mod_id.as_ref().and_then(|i| ctx.sources_db.mods.get(i)));
    let is_pinned = source_entry.map(|e| e.pinned).unwrap_or(false);
    let snoozed_until_tag = source_entry.and_then(|e| e.snoozed_until_tag.clone());
    let github_pair = resolve_github_repo(m, &ctx.sources_db.mods);

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
    let has_any_source =
        has_github || has_nexus || auto_detected_github.is_some() || nexus_url.is_some();

    // --- GitHub version check ---
    let mut github_repo_str: Option<String> = None;
    let mut latest_release_tag: Option<String> = None;
    let mut latest_release_with_assets_tag: Option<String> = None;
    let mut latest_has_mod_assets = false;
    let mut github_needs_update = false;
    let mut asset_names: Vec<String> = Vec::new();
    let mut total_scanned: u32 = 0;
    let mut github_error: Option<String> = None;
    let github_registry_version =
        crate::mod_versions::provider_source_version_label_for_mod(m, ctx.config_path, "github");
    let github_installed_version = source_entry
        .filter(|entry| entry.installed_version_source.as_deref() == Some("github"))
        .and_then(|entry| entry.installed_version.clone())
        .or(github_registry_version);
    // Walk-back / compat fields. Populated below when we have an
    // actionable github_needs_update on a row whose latest release
    // declares a min_game_version higher than the user's STS2 build.
    let mut latest_release_min_game_version: Option<String> = None;
    let mut latest_release_blocked_by_game_version = false;
    let mut latest_compatible_tag: Option<String> = None;

    if let Some((owner, repo)) = github_pair {
        let full_name = format!("{}/{}", owner, repo);
        github_repo_str = Some(full_name.clone());

        match fetch_latest_release(&owner, &repo, ctx.token).await {
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
                let releases = match fetch_releases(&owner, &repo, page, per_page, ctx.token).await
                {
                    Ok(r) => r,
                    Err(_) => break,
                };
                if releases.is_empty() {
                    break;
                }

                let (candidate, scanned) = first_versioned_release_with_mod_assets(&releases);
                total_scanned += scanned;
                if let Some(candidate) = candidate {
                    latest_release_with_assets_tag = Some(candidate.tag_name);
                    asset_names = candidate.asset_names;
                    break 'outer;
                }
            }

            // Determine if a GitHub update is needed using semver
            if let Some(ref assets_tag) = latest_release_with_assets_tag {
                let latest_ver = assets_tag.trim_start_matches('v');
                let provider_current_ver =
                    github_installed_version.as_deref().and_then(usable_version);
                let current_ver = provider_current_ver
                    .or_else(|| best_known_installed_version(m, &ctx.sources_db.mods));
                let installed_ver_matches = github_installed_version
                    .as_deref()
                    .map(|version| strip_version_prefix(version) == latest_ver)
                    .unwrap_or(false);

                if !installed_ver_matches && current_ver.is_some() {
                    // Use semver comparison — only flag if latest > current
                    github_needs_update = current_ver
                        .as_ref()
                        .is_some_and(|current| is_newer_version(&current.to_string(), latest_ver));
                    if github_needs_update
                        && crate::mod_versions::has_cached_provider_version_for_mod(
                            ctx.config_path,
                            ctx.cache_path,
                            m,
                            latest_ver,
                            crate::mod_versions::ArtifactProvider::GitHub,
                            Some(full_name.as_str()),
                        )
                    {
                        log::info!(
                            "audit: suppressing GitHub update for '{}' because v{} is already cached locally",
                            m.name,
                            latest_ver,
                        );
                        github_needs_update = false;
                    }
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
                        &owner,
                        &repo,
                        assets_tag,
                        ctx.cache_path,
                        ctx.user_game_version,
                        ctx.token,
                    )
                    .await
                    {
                        Ok(zip_path) => {
                            let peeked = crate::download::peek_zip_min_game_version(&zip_path)
                                .ok()
                                .flatten();
                            latest_release_min_game_version = peeked.clone();
                            let compatible = match (ctx.user_game_version, peeked.as_deref()) {
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
                                    &owner,
                                    &repo,
                                    ctx.user_game_version,
                                    ctx.cache_path,
                                    ctx.token,
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
                                        let installed_tag = github_installed_version
                                            .as_deref()
                                            .map(strip_version_prefix)
                                            .unwrap_or("");
                                        let manifest_ver = m.version.trim_start_matches('v');
                                        let walk_ver = walk.tag.trim_start_matches('v');
                                        let already_on_walked_version =
                                            if github_installed_version.is_some() {
                                                walk_ver == installed_tag
                                            } else {
                                                walk_ver == manifest_ver
                                            };
                                        if already_on_walked_version {
                                            github_needs_update = false;
                                            latest_compatible_tag = None;
                                        } else {
                                            latest_compatible_tag = Some(walk.tag.clone());
                                        }
                                    }
                                    Err(e) => {
                                        log::warn!(
                                            "audit: walk-back failed for {}/{} (game v{}): {}",
                                            owner,
                                            repo,
                                            ctx.user_game_version.unwrap_or("?"),
                                            e,
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
                                owner,
                                repo,
                                assets_tag,
                                e,
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
    let mut nexus_installed_version: Option<String> = None;
    let mut nexus_update_available = false;
    let source_record = m
        .mod_version_id
        .as_deref()
        .and_then(|id| crate::mod_versions::record_by_id(ctx.config_path, id));

    if let (Some(ref domain), Some(mod_id)) = (nexus_game_domain, nexus_mod_id) {
        if let Some(nkey) = ctx.nexus_api_key {
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
                        Ok(files) if !files.is_empty() => {
                            effective_version = resolve_nexus_version_for_installed_lane(
                                &files,
                                source_entry,
                                source_record.as_ref(),
                            );
                            if effective_version.is_none() {
                                log::warn!(
                                    "audit: Nexus lane unresolved for '{}' (domain={}, mod_id={}, active_mod_version_id={:?}, install_source={:?}, source_entry_version={:?}, source_entry_source={:?}, source_entry_file_id={:?}, source_entry_file_name={:?}, source_entry_lane={:?}, page_version={:?}, files={:?})",
                                    m.name,
                                    domain,
                                    mod_id,
                                    m.mod_version_id,
                                    m.install_source,
                                    source_entry.and_then(|entry| entry.installed_version.as_deref()),
                                    source_entry.and_then(|entry| entry.installed_version_source.as_deref()),
                                    source_entry.and_then(|entry| entry.nexus_file_id),
                                    source_entry.and_then(|entry| entry.nexus_file_name.as_deref()),
                                    source_entry.and_then(|entry| entry.nexus_file_lane_key.as_deref()),
                                    info.version,
                                    files.iter().map(|file| (
                                        file.file_id,
                                        file.name.as_deref().or(file.file_name.as_deref()),
                                        file.version.as_deref(),
                                        file.category_id,
                                        file.uploaded_timestamp,
                                    )).collect::<Vec<_>>(),
                                );
                            } else {
                                log::info!(
                                    "audit: Nexus lane resolved for '{}' to v{} (domain={}, mod_id={}, active_mod_version_id={:?}, install_source={:?}, source_entry_version={:?}, source_entry_source={:?}, source_entry_file_id={:?}, source_entry_lane={:?})",
                                    m.name,
                                    effective_version.as_deref().unwrap_or("?"),
                                    domain,
                                    mod_id,
                                    m.mod_version_id,
                                    m.install_source,
                                    source_entry.and_then(|entry| entry.installed_version.as_deref()),
                                    source_entry.and_then(|entry| entry.installed_version_source.as_deref()),
                                    source_entry.and_then(|entry| entry.nexus_file_id),
                                    source_entry.and_then(|entry| entry.nexus_file_lane_key.as_deref()),
                                );
                            }
                        }
                        Ok(_) => {
                            log::debug!(
                                "Nexus files lookup for '{}' (mod {}) returned no files; using page version",
                                m.name,
                                mod_id
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "Nexus files lookup failed for '{}' (mod {}): {} - falling back to page version",
                                m.name, mod_id, e
                            );
                        }
                    }

                    if let Some(ref nv) = effective_version {
                        nexus_version = Some(nv.clone());
                        // Compare a Nexus release against the version that came
                        // from Nexus. The active artifact may instead be a newer
                        // Steam Workshop copy; using its manifest version here
                        // makes Steam silently suppress an independent Nexus
                        // update for the same logical mod (for example BaseLib).
                        // Fall back to the manifest only for legacy entries that
                        // have no persisted Nexus provenance at all.
                        let nexus_registry_version =
                            crate::mod_versions::provider_source_version_label_for_mod(
                                m,
                                ctx.config_path,
                                "nexus",
                            );
                        let nexus_sources_ver = source_entry
                            .filter(|entry| {
                                entry.installed_version_source.as_deref() == Some("nexus")
                            })
                            .and_then(|entry| entry.installed_version.as_deref())
                            .or_else(|| {
                                source_record.as_ref().and_then(|record| {
                                    let source_is_nexus =
                                        record.source.as_deref().is_some_and(|source| {
                                            source.contains("nexusmods.com/")
                                                || source.starts_with("nexus:")
                                        });
                                    source_is_nexus.then_some(
                                        record.source_version.as_deref().unwrap_or(&record.version),
                                    )
                                })
                            })
                            .or(nexus_registry_version.as_deref());
                        let manifest_ver = strip_version_prefix(&m.version);
                        let current_ver = nexus_sources_ver
                            .map(strip_version_prefix)
                            .unwrap_or(manifest_ver);
                        nexus_installed_version = Some(current_ver.to_string());
                        let nexus_ver = strip_version_prefix(nv);
                        if current_ver != "unknown" && current_ver != "0.0.0" {
                            nexus_update_available = is_newer_version(current_ver, nexus_ver);
                            if nexus_update_available
                                && crate::mod_versions::has_cached_provider_version_for_mod(
                                    ctx.config_path,
                                    ctx.cache_path,
                                    m,
                                    nexus_ver,
                                    crate::mod_versions::ArtifactProvider::Nexus,
                                    nexus_url.as_deref(),
                                )
                            {
                                log::info!(
                                    "audit: suppressing Nexus update for '{}' because v{} is already cached locally",
                                    m.name,
                                    nexus_ver,
                                );
                                nexus_update_available = false;
                            }
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
                                    .trim_start_matches(['v', 'V']),
                                nexus_ver,
                            )
                        {
                            log::info!(
                                "audit: suppressing Nexus update for '{}' — Nexus v{} matches \
                                 GitHub's game-version-blocked latest v{}",
                                m.name,
                                nexus_ver,
                                latest_release_with_assets_tag.as_deref().unwrap_or("?"),
                            );
                            nexus_update_available = false;
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "Nexus API check failed for {} (mod {}): {}",
                        m.name,
                        mod_id,
                        e
                    );
                }
            }
        }
    }

    // If no source at all, still include in report
    if !has_any_source {
        let installed_source_version =
            installed_source_version_for_display(m, &ctx.sources_db.mods);
        return ModAuditEntry {
            mod_version_id: m.mod_version_id.clone(),
            mod_name: m.name.clone(),
            folder_name: m.folder_name.clone(),
            github_repo: None,
            manifest_version: m.version.clone(),
            installed_source_version: installed_source_version.clone(),
            installed_version: m.version.clone(),
            latest_release_tag: None,
            latest_release_with_assets_tag: None,
            latest_has_assets: false,
            needs_update: workshop_pending,
            asset_names: Vec::new(),
            releases_scanned: 0,
            error: None,
            nexus_url: None,
            nexus_version: None,
            nexus_update_available: false,
            update_source: workshop_pending.then(|| "steam".into()),
            github_auto_detected: false,
            pinned: is_pinned,
            min_game_version: m.min_game_version.clone(),
            game_version_too_old: matches!(
                (ctx.user_game_version, m.min_game_version.as_deref()),
                (Some(gv), Some(req)) if !game_version_satisfies(gv, req)
            ),
            latest_release_min_game_version: None,
            latest_release_blocked_by_game_version: false,
            latest_compatible_tag: None,
            snoozed: false,
            update_plans: (m.install_source == ModInstallSource::SteamWorkshop)
                .then(|| {
                    update_plan_item(
                        m,
                        m.version.clone(),
                        None,
                        "steam",
                        m.workshop_url.clone(),
                        false,
                        workshop_pending,
                    )
                })
                .into_iter()
                .collect(),
        };
    }

    // For display: use the verified GitHub repo, or fall back to auto-detected for informational display
    let display_github = github_repo_str.clone().or(auto_detected_github);

    // If GitHub errored (e.g. 404) but we have Nexus data, suppress the GitHub error —
    // the Nexus check is the authority. Also mark as auto-detected so UI treats it as informational.
    let (final_error, final_auto_detected) =
        if github_error.is_some() && (nexus_url.is_some() || nexus_version.is_some()) {
            (None, true) // suppress error, mark GitHub as informational
        } else {
            (github_error, is_auto_detected)
        };

    let min_game_version = m.min_game_version.clone();
    let game_version_too_old = matches!(
        (ctx.user_game_version, min_game_version.as_deref()),
        (Some(gv), Some(req)) if !game_version_satisfies(gv, req)
    );

    // Compute needs_update + update_source AFTER the walk-back has had
    // a chance to drop github_needs_update (it does so when the only
    // newer release is incompatible, or when the walked-back tag is
    // already what's installed).
    let needs_update =
        !is_pinned && (workshop_pending || github_needs_update || nexus_update_available);
    let update_source = if [
        workshop_pending,
        github_needs_update,
        nexus_update_available,
    ]
    .into_iter()
    .filter(|pending| *pending)
    .count()
        > 1
    {
        Some("both".to_string())
    } else if workshop_pending {
        Some("steam".to_string())
    } else if github_needs_update {
        Some("github".to_string())
    } else if nexus_update_available {
        Some("nexus".to_string())
    } else {
        None
    };
    // Snooze is matched against the upstream version the user would be
    // prompted about: GitHub release tag first, Nexus version otherwise.
    // When that version advances, the suggestion comes back.
    let snoozed = audit_snooze_matches(
        snoozed_until_tag.as_deref(),
        latest_release_with_assets_tag.as_deref(),
        nexus_version.as_deref(),
    );
    let installed_version = best_known_installed_version(m, &ctx.sources_db.mods)
        .map(|version| version.to_string())
        .unwrap_or_else(|| m.version.clone());
    let installed_source_version = installed_source_version_for_display(m, &ctx.sources_db.mods);
    let github_target = latest_compatible_tag
        .as_deref()
        .or(latest_release_with_assets_tag.as_deref());
    let update_plans = build_update_plans(
        m,
        &installed_version,
        github_installed_version.as_deref(),
        display_github.as_deref(),
        github_target,
        github_needs_update,
        nexus_url.as_deref(),
        nexus_installed_version.as_deref(),
        nexus_version.as_deref(),
        nexus_update_available,
        is_pinned,
        snoozed,
        workshop_pending,
    );
    ModAuditEntry {
        mod_version_id: m.mod_version_id.clone(),
        mod_name: m.name.clone(),
        folder_name: m.folder_name.clone(),
        github_repo: display_github,
        manifest_version: m.version.clone(),
        installed_source_version,
        installed_version,
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
        snoozed,
        update_plans,
    }
}

fn audit_snooze_matches(
    snoozed_until_tag: Option<&str>,
    latest_release_with_assets_tag: Option<&str>,
    nexus_version: Option<&str>,
) -> bool {
    match (
        snoozed_until_tag,
        latest_release_with_assets_tag.or(nexus_version),
    ) {
        (Some(snooze), Some(latest)) => snooze == latest,
        _ => false,
    }
}

// ── Repair/update stash-on-failure (#174) ──────────────────────────────────
//
// `repair_mod` and `update_mod` both follow the same shape: stash the old
// install aside via `downloads_watcher::stash_existing_mod_files`, then try
// `mods::install_mod_from_zip`. On `Err` the stash is restored so the user
// keeps their existing install; on `Ok` the stash is discarded. The
// tauri::command wrappers themselves need a live AppState/network to drive,
// so this test exercises that exact sequence directly against the real
// helpers with a corrupt "zip" to force `install_mod_from_zip` to fail.
#[cfg(test)]
mod repair_stash_on_failed_extract_tests {
    use crate::downloads_watcher::stash_existing_mod_files;
    use crate::mods::ModInfo;
    use tempfile::tempdir;

    fn fixture_mod_info(folder: &str) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: folder.to_string(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some(folder.to_string()),
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
            ..Default::default()
        }
    }

    fn write(path: &std::path::Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// Mirrors the repair_mod/update_mod sequence: stash the old install,
    /// attempt the extract, and on `Err` restore the stash. A corrupt zip
    /// makes `install_mod_from_zip` fail at `ZipArchive::new`, so this
    /// proves the old install survives a failed extract (#174's core hazard).
    #[test]
    fn failed_extract_restores_the_existing_install() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(
            &mods.join("MyMod").join("manifest.json"),
            r#"{"name":"MyMod","version":"1.0.0"}"#,
        );
        write(&mods.join("MyMod").join("plugin.dll"), "original-dll-bytes");

        // A corrupt "zip" — just plain text. ZipArchive::new will fail.
        let bad_zip = base.path().join("corrupt.zip");
        write(&bad_zip, "not a real zip file");

        let info = fixture_mod_info("MyMod");
        let stashed = stash_existing_mod_files(&info, &mods, None);
        assert!(
            !mods.join("MyMod").exists(),
            "old install should be stashed aside before the extract attempt"
        );

        let result = crate::mods::install_mod_from_zip(&bad_zip, &mods);
        assert!(result.is_err(), "corrupt zip must fail to extract");

        // repair_mod/update_mod's failure branch: restore the stash.
        stashed.restore();

        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("manifest.json")).unwrap(),
            r#"{"name":"MyMod","version":"1.0.0"}"#,
            "manifest should be restored after a failed extract"
        );
        assert_eq!(
            std::fs::read_to_string(mods.join("MyMod").join("plugin.dll")).unwrap(),
            "original-dll-bytes",
            "plugin dll should be restored after a failed extract"
        );

        // No leftover stash dirs.
        let leftovers: Vec<String> = std::fs::read_dir(&mods)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("sts2mm-update-stash"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no stash temp dirs should remain after restore, got {:?}",
            leftovers
        );
    }
}
