use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

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

/// Nexus Mods API response for a file entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusFile {
    pub file_id: u64,
    pub name: String,
    pub version: Option<String>,
    pub size_in_bytes: Option<u64>,
    pub file_name: String,
    pub category_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NexusFilesResponse {
    files: Vec<NexusFile>,
}

/// Nexus download URL response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusDownloadUrl {
    #[serde(alias = "URI")]
    pub uri: String,
    pub name: Option<String>,
    pub short_name: Option<String>,
}

pub struct NexusClient {
    api_key: String,
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
            "sts2-mod-manager/0.1".parse().unwrap(),
        );

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap_or_default();

        Self {
            api_key: api_key.to_string(),
            client,
        }
    }

    /// Get information about a mod.
    pub async fn get_mod_info(&self, game: &str, mod_id: u64) -> Result<NexusModInfo> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}.json",
            game, mod_id
        );
        let resp = self.client.get(&url).send().await?.error_for_status()?;
        let info: NexusModInfo = resp.json().await?;
        Ok(info)
    }

    /// Get file listing for a mod.
    pub async fn get_mod_files(&self, game: &str, mod_id: u64) -> Result<Vec<NexusFile>> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files.json",
            game, mod_id
        );
        let resp = self.client.get(&url).send().await?.error_for_status()?;
        let files_resp: NexusFilesResponse = resp.json().await?;
        Ok(files_resp.files)
    }

    /// Get download URLs for a file.
    pub async fn get_download_urls(
        &self,
        game: &str,
        mod_id: u64,
        file_id: u64,
        key: &str,
        expires: u64,
    ) -> Result<Vec<NexusDownloadUrl>> {
        let url = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json?key={}&expires={}",
            game, mod_id, file_id, key, expires
        );
        let resp = self.client.get(&url).send().await?.error_for_status()?;
        let urls: Vec<NexusDownloadUrl> = resp.json().await?;
        Ok(urls)
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Handle an incoming NXM link, parse it, and fetch mod info.
#[tauri::command]
pub async fn handle_nxm_link(
    url: String,
    _state: tauri::State<'_, AppState>,
) -> std::result::Result<NxmLink, String> {
    let link = parse_nxm_url(&url).map_err(|e| e.to_string())?;
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
