use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::download::{fetch_latest_release, GitHubRepo};
use crate::error::Result;
use crate::mods::ModInfo;
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// Source links for a single mod, persisted in mod_sources.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModSourceEntry {
    /// GitHub owner/repo (e.g. "owner/repo")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
    /// Whether the GitHub link was auto-detected (vs manually set by user).
    /// Auto-detected links are NOT used for update checking since they may be wrong.
    #[serde(default, skip_serializing_if = "is_false")]
    pub github_auto_detected: bool,
    /// Full Nexus Mods URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    /// Nexus game domain (e.g. "slaythefire2")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_game_domain: Option<String>,
    /// Nexus mod ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_mod_id: Option<u64>,
    /// Tracks the version (release tag) that was last installed via the updater
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// If true, this mod is pinned — excluded from update checks, audit flags,
    /// and auto-install from Downloads. Must be updated manually.
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
}

fn is_false(v: &bool) -> bool { !*v }

/// The entire mod sources database, keyed by mod name.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModSourcesDb {
    pub mods: HashMap<String, ModSourceEntry>,
}

/// Result of auto-detecting sources for mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDetectResult {
    pub matched: Vec<AutoDetectMatch>,
    pub unmatched: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDetectMatch {
    pub mod_name: String,
    pub github_repo: String,
    pub confidence: String,
}

// ── Persistence ─────────────────────────────────────────────────────────────

fn sources_path(config_path: &Path) -> std::path::PathBuf {
    config_path.join("mod_sources.json")
}

pub fn load_sources(config_path: &Path) -> ModSourcesDb {
    let path = sources_path(config_path);
    if !path.exists() {
        return ModSourcesDb::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ModSourcesDb::default(),
    }
}

pub fn save_sources(db: &ModSourcesDb, config_path: &Path) -> Result<()> {
    let path = sources_path(config_path);
    let json = serde_json::to_string_pretty(db)?;
    fs::write(&path, json)?;
    Ok(())
}

/// Update just the installed_version for a mod in mod_sources.json.
pub fn update_installed_version(mod_name: &str, version: &str, config_path: &Path) {
    let mut db = load_sources(config_path);
    let entry = db.mods.entry(mod_name.to_string()).or_default();
    entry.installed_version = Some(version.to_string());
    if let Err(e) = save_sources(&db, config_path) {
        log::error!("Failed to save installed_version for '{}': {}", mod_name, e);
    }
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Merge source metadata into ModInfo structs.
/// This enriches scanned mods with their linked GitHub/Nexus URLs.
/// Only overwrites URLs that are not already set from the manifest.
pub fn enrich_mods_with_sources(mods: &mut [ModInfo], config_path: &Path) {
    let db = load_sources(config_path);
    for m in mods.iter_mut() {
        if let Some(entry) = db.mods.get(&m.name) {
            // Only set from sources DB if not already extracted from manifest
            if m.github_url.is_none() {
                m.github_url = entry
                    .github_repo
                    .as_ref()
                    .map(|r| format!("https://github.com/{}", r));
            }
            if m.nexus_url.is_none() {
                m.nexus_url = entry.nexus_url.clone();
            }
        }
        // Also try to infer from the legacy `source` field if no explicit link
        if m.github_url.is_none() {
            if let Some(ref src) = m.source {
                if let Some(repo) = src.strip_prefix("github:") {
                    m.github_url = Some(format!("https://github.com/{}", repo));
                } else if src.starts_with("https://github.com/") {
                    m.github_url = Some(src.clone());
                }
            }
        }
    }
}

/// Parse a user-provided URL/shorthand into a ModSourceEntry.
/// Accepts:
///   - https://github.com/owner/repo
///   - github:owner/repo
///   - owner/repo (assumed GitHub)
///   - https://www.nexusmods.com/game/mods/123
///   - nexus:game/mods/123
pub fn parse_source_url(url: &str) -> Option<ModSourceEntry> {
    let trimmed = url.trim();

    // GitHub shorthand: github:owner/repo
    if let Some(rest) = trimmed.strip_prefix("github:") {
        let parts: Vec<&str> = rest.splitn(2, '/').collect();
        if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            return Some(ModSourceEntry {
                github_repo: Some(format!("{}/{}", parts[0], parts[1])),
                ..Default::default()
            });
        }
    }

    // GitHub URL
    if trimmed.contains("github.com/") {
        if let Ok(parsed) = url::Url::parse(trimmed) {
            let segs: Vec<&str> = parsed.path_segments().map(|s| s.collect()).unwrap_or_default();
            if segs.len() >= 2 && !segs[0].is_empty() && !segs[1].is_empty() {
                return Some(ModSourceEntry {
                    github_repo: Some(format!("{}/{}", segs[0], segs[1])),
                    ..Default::default()
                });
            }
        }
    }

    // Nexus shorthand: nexus:game/mods/123
    if let Some(rest) = trimmed.strip_prefix("nexus:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 3 && parts[1] == "mods" {
            if let Ok(mod_id) = parts[2].parse::<u64>() {
                let game = parts[0].to_string();
                return Some(ModSourceEntry {
                    nexus_url: Some(format!(
                        "https://www.nexusmods.com/{}/mods/{}",
                        game, mod_id
                    )),
                    nexus_game_domain: Some(game),
                    nexus_mod_id: Some(mod_id),
                    ..Default::default()
                });
            }
        }
    }

    // Nexus URL
    if trimmed.contains("nexusmods.com/") {
        if let Ok(parsed) = url::Url::parse(trimmed) {
            let segs: Vec<&str> = parsed.path_segments().map(|s| s.collect()).unwrap_or_default();
            if segs.len() >= 3 && segs[1] == "mods" {
                if let Ok(mod_id) = segs[2].parse::<u64>() {
                    return Some(ModSourceEntry {
                        nexus_url: Some(format!(
                            "https://www.nexusmods.com/{}/mods/{}",
                            segs[0], mod_id
                        )),
                        nexus_game_domain: Some(segs[0].to_string()),
                        nexus_mod_id: Some(mod_id),
                        ..Default::default()
                    });
                }
            }
        }
    }

    // Bare owner/repo (assume GitHub)
    if !trimmed.contains("://") && !trimmed.contains(' ') {
        let parts: Vec<&str> = trimmed.splitn(2, '/').collect();
        if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            return Some(ModSourceEntry {
                github_repo: Some(trimmed.to_string()),
                ..Default::default()
            });
        }
    }

    None
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Get all mod source links.
#[tauri::command]
pub fn get_mod_sources(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<HashMap<String, ModSourceEntry>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let db = load_sources(&s.config_path);
    Ok(db.mods)
}

/// Set or update the source link for a mod. Accepts a URL or shorthand string.
/// The `source_url` can be a GitHub URL, Nexus URL, or shorthand.
/// Pass empty string to clear.
#[tauri::command]
pub fn set_mod_source(
    mod_name: String,
    source_url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);

    if source_url.trim().is_empty() {
        db.mods.remove(&mod_name);
        save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
        return Ok(ModSourceEntry::default());
    }

    let entry = parse_source_url(&source_url).ok_or_else(|| {
        format!(
            "Could not parse source URL: {}. Try: github:owner/repo, a GitHub URL, or a Nexus Mods URL",
            source_url
        )
    })?;

    // Merge with existing entry (so setting GitHub doesn't erase Nexus and vice versa)
    let existing = db.mods.entry(mod_name.clone()).or_default();
    if entry.github_repo.is_some() {
        existing.github_repo = entry.github_repo;
        existing.github_auto_detected = false; // manually set by user
    }
    if entry.nexus_url.is_some() {
        existing.nexus_url = entry.nexus_url;
        existing.nexus_game_domain = entry.nexus_game_domain;
        existing.nexus_mod_id = entry.nexus_mod_id;
    }

    let result = existing.clone();
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Set both GitHub and Nexus sources for a mod at once.
#[tauri::command]
pub fn set_mod_sources_full(
    mod_name: String,
    github_repo: Option<String>,
    nexus_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);

    let mut entry = ModSourceEntry::default();
    entry.github_repo = github_repo;
    entry.github_auto_detected = false; // manually set by user

    if let Some(ref nurl) = nexus_url {
        // Parse Nexus URL to extract game domain and mod ID
        if let Some(parsed) = parse_source_url(nurl) {
            entry.nexus_url = parsed.nexus_url.or(Some(nurl.clone()));
            entry.nexus_game_domain = parsed.nexus_game_domain;
            entry.nexus_mod_id = parsed.nexus_mod_id;
        } else {
            entry.nexus_url = Some(nurl.clone());
        }
    }

    db.mods.insert(mod_name, entry.clone());
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Remove source links for a mod.
#[tauri::command]
pub fn remove_mod_source(
    mod_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    db.mods.remove(&mod_name);
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Pin a mod — excludes it from update checks, audit flags, and auto-install.
#[tauri::command]
pub fn pin_mod(
    mod_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    let entry = db.mods.entry(mod_name).or_default();
    entry.pinned = true;
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Unpin a mod — re-enables update checks and auto-install for it.
#[tauri::command]
pub fn unpin_mod(
    mod_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    if let Some(entry) = db.mods.get_mut(&mod_name) {
        entry.pinned = false;
        save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// For a mod with a Nexus URL, try to find its GitHub repo by:
/// 1. Querying the Nexus API and extracting GitHub links from the description
/// 2. Falling back to GitHub search using the mod name + Nexus author name
/// Saves the result to the sources DB if found.
#[tauri::command]
pub async fn find_github_from_nexus(
    mod_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<String>, String> {
    let (config_path, nexus_key, github_token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let key = s.nexus_api_key.clone().ok_or("Nexus API key not set. Add it in Settings.")?;
        (s.config_path.clone(), key, s.github_token.clone())
    };

    let db = load_sources(&config_path);
    let entry = db.mods.get(&mod_name).ok_or(format!("No source entry for '{}'", mod_name))?;

    let game_domain = entry.nexus_game_domain.clone().unwrap_or_else(|| "slaythespire2".to_string());
    let mod_id = entry.nexus_mod_id.ok_or("No Nexus mod ID for this mod. Set a Nexus URL first.")?;

    // Step 1: Try extracting from Nexus description
    let repo = extract_github_from_nexus(&nexus_key, &game_domain, mod_id).await;

    if let Some(ref repo) = repo {
        let mut db = load_sources(&config_path);
        let entry = db.mods.entry(mod_name).or_default();
        entry.github_repo = Some(repo.clone());
        entry.github_auto_detected = true;
        save_sources(&db, &config_path).map_err(|e| e.to_string())?;
        return Ok(Some(repo.clone()));
    }

    // Step 2: Fallback - get Nexus author name and search GitHub
    let client = crate::nexus::NexusClient::new(&nexus_key);
    if let Ok(info) = client.get_mod_info(&game_domain, mod_id).await {
        let nexus_name = info.name.unwrap_or_default();
        let author = info.author.unwrap_or_default();

        // Try searching GitHub with mod name + author
        let queries = vec![
            format!("{} {}", nexus_name, author),
            nexus_name.clone(),
            mod_name.clone(),
        ];

        for query in queries {
            if query.trim().is_empty() {
                continue;
            }
            let search_query = format!("{} slay-the-spire-2 OR sts2 OR \"slay the spire 2\"", query);
            let results = search_github_raw(&search_query, github_token.as_deref()).await;

            // Find a result that matches by name similarity
            let norm_name = query.to_lowercase().replace(' ', "").replace('-', "").replace('_', "");
            for r in &results {
                let norm_repo = r.name.to_lowercase().replace(' ', "").replace('-', "").replace('_', "");
                if norm_repo.contains(&norm_name) || norm_name.contains(&norm_repo) {
                    let repo = r.full_name.clone();
                    let mut db = load_sources(&config_path);
                    let entry = db.mods.entry(mod_name).or_default();
                    entry.github_repo = Some(repo.clone());
                    entry.github_auto_detected = true;
                    save_sources(&db, &config_path).map_err(|e| e.to_string())?;
                    return Ok(Some(repo));
                }
            }
        }
    }

    Ok(None)
}

// ── Nexus → GitHub Extraction ──────────────────────────────────────────────

/// Fetch a Nexus mod's description via the API and extract any GitHub repo URL from it.
/// Returns the "owner/repo" string if found.
/// Handles HTML-encoded descriptions (Nexus returns BBCode/HTML in description fields).
pub async fn extract_github_from_nexus(
    nexus_api_key: &str,
    game_domain: &str,
    mod_id: u64,
) -> Option<String> {
    let client = crate::nexus::NexusClient::new(nexus_api_key);
    let info = match client.get_mod_info(game_domain, mod_id).await {
        Ok(i) => i,
        Err(e) => {
            log::warn!("Nexus API call failed for {}/{}: {}", game_domain, mod_id, e);
            return None;
        }
    };

    // Collect all text fields to search
    let mut texts = Vec::new();
    if let Some(ref desc) = info.description {
        texts.push(desc.clone());
        // Also decode HTML entities and try again (Nexus often HTML-encodes descriptions)
        let decoded = desc
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&#x27;", "'")
            .replace("&#x2F;", "/")
            .replace("&#47;", "/")
            .replace("&#x3A;", ":")
            .replace("&#58;", ":")
            .replace("&#x2E;", ".")
            .replace("&#46;", ".")
            .replace("%2F", "/")
            .replace("%3A", ":");
        if decoded != *desc {
            texts.push(decoded);
        }
    }
    if let Some(ref summary) = info.summary {
        texts.push(summary.clone());
    }
    // Also try the author field (some authors put their GitHub username there)
    if let Some(ref author) = info.author {
        texts.push(author.clone());
    }

    let re = regex::Regex::new(r#"github\.com/([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)"#).ok()?;

    for text in &texts {
        // Also try matching inside href="..." attributes and [url=...] BBCode
        // by searching the raw text
        for caps in re.captures_iter(text) {
            if let Some(m) = caps.get(1) {
                let repo = m.as_str()
                    .trim_end_matches('/')
                    .trim_end_matches(".git")
                    .to_string();
                // Validate it looks like owner/repo (not owner/repo/something)
                let parts: Vec<&str> = repo.split('/').collect();
                if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                    // Skip common false positives
                    if parts[1] != "issues" && parts[1] != "releases" && parts[1] != "wiki" {
                        log::info!(
                            "Found GitHub repo '{}' in Nexus description for mod {}",
                            repo, mod_id
                        );
                        return Some(repo);
                    }
                }
            }
        }
    }

    log::info!(
        "No GitHub link found in Nexus description for mod {} (searched {} text fields)",
        mod_id,
        texts.len()
    );
    None
}

// ── GitHub Search (raw, without STS2 qualifiers) ───────────────────────────

/// Response type for GitHub search API.
#[derive(Debug, Deserialize)]
struct GHSearchResponse {
    items: Vec<GitHubRepo>,
}

/// Search GitHub repositories with an arbitrary query string (no STS2 qualifiers appended).
async fn search_github_raw(query: &str, token: Option<&str>) -> Vec<GitHubRepo> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = "application/vnd.github+json".parse() {
        headers.insert(reqwest::header::ACCEPT, v);
    }
    if let Ok(v) = "sts2-mod-manager/0.1".parse() {
        headers.insert(reqwest::header::USER_AGENT, v);
    }
    if let Some(tok) = token {
        if let Ok(val) = format!("Bearer {}", tok).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_default();

    let resp = client
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", query),
            ("sort", "updated"),
            ("per_page", "30"),
        ])
        .send()
        .await;

    match resp {
        Ok(r) => match r.error_for_status() {
            Ok(r) => r.json::<GHSearchResponse>().await.map(|s| s.items).unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

// ── Normalization Helpers ───────────────────────────────────────────────────

/// Normalize a name by lowercasing and stripping separators.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace(' ', "")
        .replace('-', "")
        .replace('_', "")
}

/// Strip common STS2 prefixes/suffixes from a mod name for broader matching.
fn strip_sts2_affixes(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let prefixes = ["sts2", "sts2-", "sts2_", "slay the spire 2 ", "slaythe spire2"];
    let suffixes = [" sts2", "-sts2", "_sts2", " for sts2", " for slay the spire 2"];

    let mut stripped = lower.clone();
    for p in &prefixes {
        if let Some(rest) = stripped.strip_prefix(p) {
            stripped = rest.trim().to_string();
            break;
        }
    }
    for s in &suffixes {
        if let Some(rest) = stripped.strip_suffix(s) {
            stripped = rest.trim().to_string();
            break;
        }
    }
    let stripped = stripped.trim().to_string();
    if stripped != lower && !stripped.is_empty() {
        Some(stripped)
    } else {
        None
    }
}

/// Extract the folder name from a mod's files list (first path component of a subdirectory mod).
fn extract_folder_name(m: &ModInfo) -> Option<String> {
    for f in &m.files {
        if let Some(idx) = f.find('/') {
            let folder = &f[..idx];
            if !folder.is_empty() && folder != "." {
                return Some(folder.to_string());
            }
        }
        if let Some(idx) = f.find('\\') {
            let folder = &f[..idx];
            if !folder.is_empty() && folder != "." {
                return Some(folder.to_string());
            }
        }
    }
    None
}

/// Extract the author name from a mod's source field if it looks like "github:owner/repo".
fn extract_author(m: &ModInfo) -> Option<String> {
    if let Some(ref src) = m.source {
        if let Some(rest) = src.strip_prefix("github:") {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if !parts.is_empty() && !parts[0].is_empty() {
                return Some(parts[0].to_string());
            }
        }
        if let Some(rest) = src.strip_prefix("https://github.com/") {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if !parts.is_empty() && !parts[0].is_empty() {
                return Some(parts[0].to_string());
            }
        }
    }
    None
}

// ── Matching / Scoring ──────────────────────────────────────────────────────

/// Score a candidate repo against a mod. Higher is better; 0 = no match.
fn score_repo(repo: &GitHubRepo, mod_name: &str, folder_name: Option<&str>) -> u32 {
    let norm_mod = normalize(mod_name);
    let norm_repo = normalize(&repo.name);
    let desc_lower = repo
        .description
        .as_deref()
        .unwrap_or("")
        .to_lowercase();

    // Exact normalized name match → highest score
    if norm_repo == norm_mod {
        return 100;
    }

    // Folder name exact match
    if let Some(folder) = folder_name {
        if normalize(folder) == norm_repo {
            return 95;
        }
    }

    // Repo name contains mod name or vice versa (normalized)
    if norm_repo.contains(&norm_mod) || norm_mod.contains(&norm_repo) {
        // Prefer closer length matches
        let len_ratio = norm_mod.len().min(norm_repo.len()) as f64
            / norm_mod.len().max(norm_repo.len()) as f64;
        return 60 + (len_ratio * 30.0) as u32;
    }

    // Stripped name (without STS2 affixes) matches repo
    if let Some(stripped) = strip_sts2_affixes(mod_name) {
        let norm_stripped = normalize(&stripped);
        if norm_repo == norm_stripped {
            return 90;
        }
        if norm_repo.contains(&norm_stripped) || norm_stripped.contains(&norm_repo) {
            return 70;
        }
    }

    // Description mentions the mod name
    let name_lower = mod_name.to_lowercase();
    if desc_lower.contains(&name_lower) {
        return 50;
    }

    // Description mentions individual significant words from the mod name
    let words: Vec<&str> = mod_name
        .split(|c: char| c == ' ' || c == '-' || c == '_')
        .filter(|w| w.len() > 2)
        .collect();
    if words.len() >= 2 {
        let word_matches = words
            .iter()
            .filter(|w| {
                let wl = w.to_lowercase();
                norm_repo.contains(&normalize(&wl)) || desc_lower.contains(&wl)
            })
            .count();
        if word_matches == words.len() {
            return 45;
        }
    }

    0
}

/// Represents a candidate match with its score.
struct Candidate {
    repo: GitHubRepo,
    score: u32,
}

// ── Main Auto-Detect ────────────────────────────────────────────────────────

/// Auto-detect GitHub sources for mods that don't have one linked.
/// Searches GitHub for each unlinked mod name using multiple query strategies
/// and picks the best match via fuzzy scoring.
#[tauri::command]
pub async fn auto_detect_sources(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<AutoDetectResult, String> {
    let (config_path, mods_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let config_path = s.config_path.clone();
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let token = s.github_token.clone();
        (config_path, mods_path, token)
    };

    let mut db = load_sources(&config_path);
    let installed = crate::mods::scan_mods(&mods_path);

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();

    // Phase 0: Save any manifest-extracted URLs to the sources DB.
    // parse_manifest may have found github/nexus URLs in the mod's JSON,
    // but those are only in ModInfo, not persisted yet.
    for m in &installed {
        let entry = db.mods.entry(m.name.clone()).or_default();
        let mut changed = false;

        // Save manifest-extracted GitHub URL
        if entry.github_repo.is_none() {
            if let Some(ref gh_url) = m.github_url {
                if let Some(parsed) = parse_source_url(gh_url) {
                    entry.github_repo = parsed.github_repo;
                    entry.github_auto_detected = true;
                    changed = true;
                }
            }
            // Also check the source field
            if entry.github_repo.is_none() {
                if let Some(ref src) = m.source {
                    if src.starts_with("github:") || src.contains("github.com") {
                        if let Some(parsed) = parse_source_url(src) {
                            entry.github_repo = parsed.github_repo;
                            entry.github_auto_detected = true;
                            changed = true;
                        }
                    }
                }
            }
        }

        // Save manifest-extracted Nexus URL
        if entry.nexus_url.is_none() {
            if let Some(ref nx_url) = m.nexus_url {
                if let Some(parsed) = parse_source_url(nx_url) {
                    entry.nexus_url = parsed.nexus_url;
                    entry.nexus_game_domain = parsed.nexus_game_domain;
                    entry.nexus_mod_id = parsed.nexus_mod_id;
                    changed = true;
                }
            }
        }

        if changed {
            let _ = save_sources(&db, &config_path);
        }
    }

    // Phase 0.5: For mods with a Nexus URL but no GitHub URL, query the Nexus API
    // to extract GitHub links from the mod description.
    {
        let nexus_api_key = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.nexus_api_key.clone()
        };
        if let Some(ref nkey) = nexus_api_key {
            for m in &installed {
                let entry = db.mods.get(&m.name);
                let has_github = entry.map(|e| e.github_repo.is_some()).unwrap_or(false);
                let has_nexus = entry.map(|e| e.nexus_mod_id.is_some()).unwrap_or(false);

                if !has_github && has_nexus {
                    let entry_ref = db.mods.get(&m.name).unwrap();
                    let game_domain = entry_ref.nexus_game_domain.clone().unwrap_or_else(|| "slaythespire2".to_string());
                    let mod_id = entry_ref.nexus_mod_id.unwrap();

                    // Rate limit
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

                    if let Some(repo) = extract_github_from_nexus(nkey, &game_domain, mod_id).await {
                        let entry_mut = db.mods.entry(m.name.clone()).or_default();
                        entry_mut.github_repo = Some(repo.clone());
                        entry_mut.github_auto_detected = true;
                        let _ = save_sources(&db, &config_path);

                        matched.push(AutoDetectMatch {
                            mod_name: m.name.clone(),
                            github_repo: repo,
                            confidence: "high (nexus description)".to_string(),
                        });
                    }
                }
            }
        }
    }

    for m in &installed {
        // Skip mods that already have a GitHub source (either from DB or just saved from manifest)
        if let Some(entry) = db.mods.get(&m.name) {
            if entry.github_repo.is_some() {
                continue;
            }
        }

        let folder_name = extract_folder_name(m);
        let author = extract_author(m);

        // Build a list of search queries to try (in order of specificity)
        let mut queries: Vec<String> = Vec::new();

        // 1. Just the mod name (hyphenated) – many STS2 mods don't mention "sts2" in repo name
        let name_hyphenated = m.name.replace(' ', "-");
        queries.push(name_hyphenated.clone());

        // 2. Mod name + STS2 qualifier (the original approach)
        queries.push(format!(
            "{} slay-the-spire-2 OR sts2 OR \"slay the spire 2\"",
            name_hyphenated
        ));

        // 3. If the folder name differs from the mod name, search that too
        if let Some(ref folder) = folder_name {
            let folder_norm = normalize(folder);
            if folder_norm != normalize(&m.name) {
                queries.push(folder.replace(' ', "-"));
            }
        }

        // 4. Stripped name (without STS2 prefixes/suffixes)
        if let Some(stripped) = strip_sts2_affixes(&m.name) {
            let stripped_q = stripped.replace(' ', "-");
            if !queries.contains(&stripped_q) {
                queries.push(stripped_q);
            }
        }

        // 5. If we know the author, search "author/mod-name"
        if let Some(ref auth) = author {
            queries.push(format!("{} {}", auth, name_hyphenated));
        }

        // 6. If the mod name has multiple words, try individual significant words + sts2
        let words: Vec<&str> = m
            .name
            .split(|c: char| c == ' ' || c == '-' || c == '_')
            .filter(|w| w.len() > 2)
            .collect();
        if words.len() >= 2 {
            for w in &words {
                let wq = format!("{} sts2", w);
                if !queries.contains(&wq) {
                    queries.push(wq);
                }
            }
        }

        // De-duplicate queries (case-insensitive)
        let mut seen = std::collections::HashSet::new();
        queries.retain(|q| seen.insert(q.to_lowercase()));

        // Search GitHub with each query and collect all unique candidates
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut seen_repos = std::collections::HashSet::new();

        for query in &queries {
            // Rate-limit: 100ms delay between API calls
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

            let repos = search_github_raw(query, token.as_deref()).await;
            for repo in repos {
                if seen_repos.contains(&repo.full_name) {
                    continue;
                }
                let sc = score_repo(&repo, &m.name, folder_name.as_deref());
                if sc > 0 {
                    seen_repos.insert(repo.full_name.clone());
                    candidates.push(Candidate { repo, score: sc });
                }
            }

            // If we already have a high-confidence match, stop searching
            if candidates.iter().any(|c| c.score >= 90) {
                break;
            }
        }

        // Sort candidates by score descending
        candidates.sort_by(|a, b| b.score.cmp(&a.score));

        // Try candidates in score order, verify they have releases
        let mut found = false;
        for candidate in &candidates {
            // Rate-limit before release check
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

            let has_release = fetch_latest_release(
                &candidate.repo.owner.login,
                &candidate.repo.name,
                token.as_deref(),
            )
            .await
            .is_ok();

            if has_release {
                let full_name = candidate.repo.full_name.clone();
                let confidence = if candidate.score >= 90 {
                    "high"
                } else if candidate.score >= 50 {
                    "medium"
                } else {
                    "low"
                };

                let entry = db.mods.entry(m.name.clone()).or_default();
                entry.github_repo = Some(full_name.clone());
                entry.github_auto_detected = true;
                save_sources(&db, &config_path).map_err(|e| e.to_string())?;

                matched.push(AutoDetectMatch {
                    mod_name: m.name.clone(),
                    github_repo: full_name,
                    confidence: confidence.to_string(),
                });
                found = true;
                break;
            }
        }

        if !found {
            unmatched.push(m.name.clone());
        }
    }

    Ok(AutoDetectResult { matched, unmatched })
}
