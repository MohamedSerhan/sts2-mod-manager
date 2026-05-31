use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Total request timeout for the Nexus API client.
const HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Connect timeout for the Nexus API client.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// ── NXM Link Parsing ────────────────────────────────────────────────────────

/// Parsed NXM link from Nexus Mods.
/// Format: nxm://game/mods/123/files/456?key=abc&expires=123
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NxmLink {
    pub game_domain: String,
    pub mod_id: u64,
    pub file_id: u64,
    pub key: Option<String>,
    pub expires: Option<u64>,
}

/// Parse an NXM URL into its components.
pub fn parse_nxm_url(url_str: &str) -> Result<NxmLink> {
    // nxm://slaytheSpire2/mods/123/files/456?key=abc&expires=123
    let url_str = if url_str.starts_with("nxm://") {
        // Replace nxm:// with http:// for URL parsing
        format!("http://{}", &url_str[6..])
    } else {
        return Err(AppError::NxmParseError(
            "URL does not start with nxm://".to_string(),
        ));
    };

    let parsed = url::Url::parse(&url_str)
        .map_err(|e| AppError::NxmParseError(format!("Invalid NXM URL: {}", e)))?;

    let game_domain = parsed
        .host_str()
        .ok_or_else(|| AppError::NxmParseError("Missing game domain".to_string()))?
        .to_string();

    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();

    // Expected path: /mods/{mod_id}/files/{file_id}
    if segments.len() < 4 || segments[0] != "mods" || segments[2] != "files" {
        return Err(AppError::NxmParseError(format!(
            "Invalid NXM path format. Expected /mods/{{id}}/files/{{id}}, got: /{}",
            segments.join("/")
        )));
    }

    let mod_id: u64 = segments[1]
        .parse()
        .map_err(|_| AppError::NxmParseError(format!("Invalid mod_id: {}", segments[1])))?;

    let file_id: u64 = segments[3]
        .parse()
        .map_err(|_| AppError::NxmParseError(format!("Invalid file_id: {}", segments[3])))?;

    let mut key = None;
    let mut expires = None;

    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "key" => key = Some(v.to_string()),
            "expires" => expires = v.parse().ok(),
            _ => {}
        }
    }

    Ok(NxmLink {
        game_domain,
        mod_id,
        file_id,
        key,
        expires,
    })
}

// ── Nexus API Client ────────────────────────────────────────────────────────

/// Nexus Mods API response for mod info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusModInfo {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub category_id: Option<u64>,
    pub mod_id: u64,
    pub picture_url: Option<String>,
}

/// One file entry from Nexus's `/files.json` endpoint.
///
/// Nexus mod pages can host multiple variants of the same mod (e.g.
/// `BetterSpire2` ships both a full and a "Lite" zip). The page-level
/// `version` field only reflects whichever the author bumped most recently,
/// so audits comparing "what's on disk" against "page version" misclassify
/// the inactive variant. The fix is to look at this list and pick the file
/// that matches the local mod's flavor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusFile {
    pub file_id: u64,
    pub name: Option<String>,
    pub file_name: Option<String>,
    pub version: Option<String>,
    /// Nexus category id: 1 = MAIN, 2 = UPDATE/PATCH, 3 = OPTIONAL, 4 = OLD,
    /// 6 = MISCELLANEOUS, 7 = ARCHIVED. We only ever care about MAIN/OPTIONAL
    /// for "what's the latest" — anything ARCHIVED is gone and shouldn't win.
    pub category_id: Option<u64>,
    pub uploaded_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct NexusFilesResponse {
    files: Vec<NexusFile>,
}

pub struct NexusClient {
    client: reqwest::Client,
}

impl NexusClient {
    pub fn new(api_key: &str) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "apikey",
            reqwest::header::HeaderValue::from_str(api_key).unwrap_or_else(|_| {
                reqwest::header::HeaderValue::from_static("")
            }),
        );
        headers.insert(
            reqwest::header::ACCEPT,
            "application/json".parse().unwrap(),
        );
        headers.insert(
            reqwest::header::USER_AGENT,
            concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")).parse().unwrap(),
        );

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(HTTP_TOTAL_TIMEOUT)
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .build()
            .unwrap_or_default();

        Self { client }
    }

    /// Get information about a mod.
    pub async fn get_mod_info(&self, game: &str, mod_id: u64) -> Result<NexusModInfo> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}.json",
            game, mod_id
        );
        if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
            let info: NexusModInfo = serde_json::from_slice(&bytes)?;
            return Ok(info);
        }
        log::debug!("Nexus API: get_mod_info {}/{}", game, mod_id);
        let resp = self.client.get(&url).send().await.map_err(|e| {
            log::warn!("Nexus get_mod_info request failed for {}/{}: {}", game, mod_id, e);
            e
        })?;
        let resp = resp.error_for_status().map_err(|e| {
            log::warn!("Nexus get_mod_info HTTP error for {}/{}: {}", game, mod_id, e);
            e
        })?;
        let info: NexusModInfo = resp.json().await?;
        Ok(info)
    }

    /// Fetch one of the public mod-list endpoints (`trending`, `latest_added`, etc.).
    async fn get_mod_list(&self, game: &str, list_kind: &str) -> Result<Vec<NexusModInfo>> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}.json",
            game, list_kind
        );
        if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
            let mods: Vec<NexusModInfo> = serde_json::from_slice(&bytes)?;
            return Ok(mods);
        }
        log::debug!("Nexus GET {}", url);
        let resp = self.client.get(&url).send().await.map_err(|e| {
            log::warn!("Nexus {} request failed: {}", list_kind, e);
            e
        })?;
        let resp = resp.error_for_status().map_err(|e| {
            log::warn!("Nexus {} HTTP error: {}", list_kind, e);
            e
        })?;
        let mods: Vec<NexusModInfo> = resp.json().await.map_err(|e| {
            log::warn!("Nexus {} decode failed: {}", list_kind, e);
            e
        })?;
        log::debug!("Nexus {} returned {} mods", list_kind, mods.len());
        Ok(mods)
    }

    /// Get the trending mods for a game.
    pub async fn get_trending(&self, game: &str) -> Result<Vec<NexusModInfo>> {
        self.get_mod_list(game, "trending").await
    }

    /// Get the latest added mods for a game.
    pub async fn get_latest_added(&self, game: &str) -> Result<Vec<NexusModInfo>> {
        self.get_mod_list(game, "latest_added").await
    }

    /// List every file uploaded to a mod page. Used to disambiguate variants
    /// (Lite/Full/etc.) that share a single Nexus mod_id.
    pub async fn get_mod_files(&self, game: &str, mod_id: u64) -> Result<Vec<NexusFile>> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files.json",
            game, mod_id
        );
        if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
            let body: NexusFilesResponse = serde_json::from_slice(&bytes)?;
            return Ok(body.files);
        }
        log::debug!("Nexus API: get_mod_files {}/{}", game, mod_id);
        let resp = self.client.get(&url).send().await?;
        let resp = resp.error_for_status()?;
        let body: NexusFilesResponse = resp.json().await?;
        Ok(body.files)
    }
}

/// Score a Nexus file for "is this the latest version of THIS variant?"
///
/// Variant detection is keyword-based: if the local mod name contains "lite"
/// (case-insensitive), prefer files whose name also contains "lite". Same for
/// any other tag we add later. Files with no matching tag are still candidates
/// — we just pick the highest-scoring one.
///
/// Tier-1 boosts: matching variant tag, MAIN category, recent upload.
fn nexus_file_relevance(file: &NexusFile, want_lite: bool) -> i64 {
    let mut score: i64 = 0;
    let blob = format!(
        "{} {}",
        file.name.as_deref().unwrap_or(""),
        file.file_name.as_deref().unwrap_or(""),
    )
    .to_lowercase();

    let has_lite = blob.contains("lite");
    if want_lite {
        if has_lite {
            score += 1000;
        } else {
            score -= 1000;
        }
    } else if has_lite {
        // Looking for the non-lite variant — penalize lite files.
        score -= 1000;
    }

    match file.category_id {
        Some(1) => score += 200,           // MAIN
        Some(3) => score += 80,            // OPTIONAL
        Some(4) | Some(7) => score -= 500, // OLD / ARCHIVED
        Some(6) => score -= 50,            // MISC (readmes etc.)
        _ => {}
    }

    if let Some(ts) = file.uploaded_timestamp {
        // Spread the timestamp into the score so newer wins among equal-tier files.
        score += ts / 1000;
    }
    score
}

/// Pick the version string Nexus should report for a mod, given the local
/// mod's display name (used as a flavor hint).
///
/// Returns None if no file looks like a sensible match — caller then falls
/// back to the page-level `version` field.
pub fn pick_version_for_local_mod(files: &[NexusFile], local_mod_name: &str) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let want_lite = local_mod_name.to_lowercase().contains("lite");
    let mut ranked: Vec<(&NexusFile, i64)> = files
        .iter()
        .map(|f| (f, nexus_file_relevance(f, want_lite)))
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    let winner = ranked.first()?.0;
    winner.version.clone().filter(|v| !v.trim().is_empty())
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Handle an incoming NXM link, parse it, and fetch mod info.
#[tauri::command]
pub async fn handle_nxm_link(
    url: String,
    _state: tauri::State<'_, AppState>,
) -> std::result::Result<NxmLink, String> {
    log::info!("Received NXM link: {}", url);
    let link = parse_nxm_url(&url).map_err(|e| {
        log::warn!("Failed to parse NXM link '{}': {}", url, e);
        e.to_string()
    })?;
    log::info!(
        "Parsed NXM link: game={} mod_id={} file_id={} (has_key={})",
        link.game_domain, link.mod_id, link.file_id, link.key.is_some()
    );
    Ok(link)
}

/// Get Nexus mod information.
#[tauri::command]
pub async fn get_nexus_mod_info(
    game: String,
    mod_id: u64,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<NexusModInfo, String> {
    let api_key = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.nexus_api_key
            .clone()
            .ok_or_else(|| "Nexus API key not set".to_string())?
    };

    let client = NexusClient::new(&api_key);
    client
        .get_mod_info(&game, mod_id)
        .await
        .map_err(|e| e.to_string())
}

/// Hardcoded Nexus game domain for STS2.
const STS2_GAME_DOMAIN: &str = "slaythespire2";

fn nexus_client_from_state(
    state: &tauri::State<'_, AppState>,
) -> std::result::Result<NexusClient, String> {
    let api_key = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.nexus_api_key
            .clone()
            .ok_or_else(|| "Nexus API key not set".to_string())?
    };
    Ok(NexusClient::new(&api_key))
}

/// Get the trending mods on Nexus for STS2.
#[tauri::command]
pub async fn nexus_get_trending(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<NexusModInfo>, String> {
    nexus_client_from_state(&state)?
        .get_trending(STS2_GAME_DOMAIN)
        .await
        .map_err(|e| e.to_string())
}

/// Get the most recently added mods on Nexus for STS2.
#[tauri::command]
pub async fn nexus_get_latest_added(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<NexusModInfo>, String> {
    nexus_client_from_state(&state)?
        .get_latest_added(STS2_GAME_DOMAIN)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod nexus_helper_tests {
    use super::*;

    #[test]
    fn parse_nxm_url_extracts_all_components() {
        let nxm = parse_nxm_url("nxm://slaythespire2/mods/103/files/456?key=abc&expires=42").unwrap();
        assert_eq!(nxm.game_domain, "slaythespire2");
        assert_eq!(nxm.mod_id, 103);
        assert_eq!(nxm.file_id, 456);
        assert_eq!(nxm.key.as_deref(), Some("abc"));
        assert_eq!(nxm.expires, Some(42));
    }

    #[test]
    fn parse_nxm_url_tolerates_missing_query() {
        let nxm = parse_nxm_url("nxm://slaythespire2/mods/103/files/456").unwrap();
        assert!(nxm.key.is_none());
        assert!(nxm.expires.is_none());
    }

    #[test]
    fn parse_nxm_url_rejects_non_nxm_or_malformed() {
        assert!(parse_nxm_url("https://nexusmods.com/slaythespire2/mods/103").is_err());
        assert!(parse_nxm_url("nxm://slaythespire2/posts/103/files/456").is_err());
        assert!(parse_nxm_url("nxm://slaythespire2/mods/abc/files/456").is_err());
        assert!(parse_nxm_url("not-a-url").is_err());
    }

    fn file(file_id: u64, name: &str, version: &str, category_id: Option<u64>, ts: i64) -> NexusFile {
        NexusFile {
            file_id,
            name: Some(name.into()),
            file_name: Some(format!("{}-x.zip", name)),
            version: Some(version.into()),
            category_id,
            uploaded_timestamp: Some(ts),
        }
    }

    #[test]
    fn pick_version_for_local_mod_prefers_lite_for_lite_local_name() {
        // Two files: regular "Full" and "Lite" variant. Local mod's name
        // contains "lite" → picker must return the lite variant's version.
        let files = vec![
            file(1, "BetterSpire2 Full", "2.0.0", Some(1), 1000),
            file(2, "BetterSpire2 Lite", "1.5.0", Some(1), 900),
        ];
        let v = pick_version_for_local_mod(&files, "BetterSpire2Lite").unwrap();
        assert_eq!(v, "1.5.0");
    }

    #[test]
    fn pick_version_for_local_mod_penalizes_lite_when_local_name_is_not_lite() {
        let files = vec![
            file(1, "BetterSpire2 Lite", "2.0.0", Some(1), 1000),
            file(2, "BetterSpire2 Full", "1.5.0", Some(1), 900),
        ];
        // No "lite" in local name → picker must prefer the non-lite file.
        let v = pick_version_for_local_mod(&files, "BetterSpire2").unwrap();
        assert_eq!(v, "1.5.0");
    }

    #[test]
    fn pick_version_for_local_mod_demotes_archived_and_old_categories() {
        let files = vec![
            // category_id 7 = ARCHIVED, large penalty
            file(1, "Old", "5.0.0", Some(7), 2000),
            // category_id 1 = MAIN
            file(2, "Current", "2.0.0", Some(1), 1500),
        ];
        let v = pick_version_for_local_mod(&files, "AnyMod").unwrap();
        assert_eq!(v, "2.0.0");
    }

    #[test]
    fn pick_version_for_local_mod_returns_none_on_empty() {
        assert!(pick_version_for_local_mod(&[], "AnyMod").is_none());
    }

    #[test]
    fn nexus_client_constructs_without_panicking_on_unicode_key() {
        // Defensively, the client uses HeaderValue::from_str which fails on
        // non-printable chars; the code falls back to empty header. We just
        // assert the constructor doesn't panic.
        let _ = NexusClient::new("plain-key-123");
        // Non-ASCII keys (rare but seen in copy-paste mishaps) shouldn't crash.
        let _ = NexusClient::new("café-key");
    }
}

/// Set the Nexus Mods API key (store in state and optionally in keyring).
#[tauri::command]
pub fn set_nexus_api_key(
    key: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.nexus_api_key = Some(key.clone());

    // Attempt to store in system keyring for persistence
    if let Ok(entry) = keyring::Entry::new("sts2-mod-manager", "nexus-api-key") {
        let _ = entry.set_password(&key);
    }

    Ok(true)
}
