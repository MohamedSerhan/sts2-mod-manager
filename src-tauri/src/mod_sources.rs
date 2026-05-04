use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::download::{fetch_latest_release, search_github_repos};
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
    /// Full Nexus Mods URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    /// Nexus game domain (e.g. "slaythefire2")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_game_domain: Option<String>,
    /// Nexus mod ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_mod_id: Option<u64>,
}

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

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Merge source metadata into ModInfo structs.
/// This enriches scanned mods with their linked GitHub/Nexus URLs.
pub fn enrich_mods_with_sources(mods: &mut [ModInfo], config_path: &Path) {
    let db = load_sources(config_path);
    for m in mods.iter_mut() {
        if let Some(entry) = db.mods.get(&m.name) {
            m.github_url = entry
                .github_repo
                .as_ref()
                .map(|r| format!("https://github.com/{}", r));
            m.nexus_url = entry.nexus_url.clone();
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

/// Auto-detect GitHub sources for mods that don't have one linked.
/// Searches GitHub for each unlinked mod name and picks the best match.
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

    for m in &installed {
        // Skip mods that already have a GitHub source
        if let Some(entry) = db.mods.get(&m.name) {
            if entry.github_repo.is_some() {
                continue;
            }
        }
        // Also skip if the mod's own source field has GitHub info
        if let Some(ref src) = m.source {
            if src.starts_with("github:") || src.contains("github.com") {
                continue;
            }
        }

        // Search GitHub for this mod
        let search_query = m.name.replace(' ', "-");
        match search_github_repos(&search_query, token.as_deref()).await {
            Ok(repos) => {
                // Look for an exact or close name match
                let name_lower = m.name.to_lowercase().replace(' ', "").replace('-', "").replace('_', "");

                let best = repos.iter().find(|r| {
                    let repo_lower = r.name.to_lowercase().replace(' ', "").replace('-', "").replace('_', "");
                    repo_lower == name_lower
                });

                if let Some(repo) = best {
                    // Verify it has releases
                    let has_release = fetch_latest_release(
                        &repo.owner.login,
                        &repo.name,
                        token.as_deref(),
                    )
                    .await
                    .is_ok();

                    if has_release {
                        let full_name = repo.full_name.clone();
                        let entry = db.mods.entry(m.name.clone()).or_default();
                        entry.github_repo = Some(full_name.clone());
                        save_sources(&db, &config_path).map_err(|e| e.to_string())?;

                        matched.push(AutoDetectMatch {
                            mod_name: m.name.clone(),
                            github_repo: full_name,
                            confidence: "high".to_string(),
                        });
                        continue;
                    }
                }

                // Try partial match: first repo that has releases
                let partial = repos.iter().find(|r| {
                    let repo_lower = r.name.to_lowercase();
                    let desc_lower = r.description.as_deref().unwrap_or("").to_lowercase();
                    repo_lower.contains(&name_lower) || desc_lower.contains(&name_lower)
                });

                if let Some(repo) = partial {
                    let has_release = fetch_latest_release(
                        &repo.owner.login,
                        &repo.name,
                        token.as_deref(),
                    )
                    .await
                    .is_ok();

                    if has_release {
                        let full_name = repo.full_name.clone();
                        let entry = db.mods.entry(m.name.clone()).or_default();
                        entry.github_repo = Some(full_name.clone());
                        save_sources(&db, &config_path).map_err(|e| e.to_string())?;

                        matched.push(AutoDetectMatch {
                            mod_name: m.name.clone(),
                            github_repo: full_name,
                            confidence: "medium".to_string(),
                        });
                        continue;
                    }
                }

                unmatched.push(m.name.clone());
            }
            Err(_) => {
                unmatched.push(m.name.clone());
            }
        }
    }

    Ok(AutoDetectResult { matched, unmatched })
}
