use std::io::Write as IoWrite;
use std::path::Path;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::{install_mod_from_zip, ModInfo};
use crate::state::AppState;

// ── GitHub API Types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub assets: Vec<GitHubAsset>,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    pub content_type: String,
    pub download_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepo {
    pub full_name: String,
    pub name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub stargazers_count: u64,
    pub updated_at: String,
    pub owner: GitHubOwner,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubOwner {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubSearchResponse {
    total_count: u64,
    items: Vec<GitHubRepo>,
}

// ── Core Functions ──────────────────────────────────────────────────────────

fn build_client(token: Option<&str>) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        "sts2-mod-manager/0.1".parse().unwrap(),
    );
    if let Some(tok) = token {
        if let Ok(val) = format!("Bearer {}", tok).parse() {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_default()
}

/// Fetch the latest release from a GitHub repository.
pub async fn fetch_latest_release(
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<GitHubRelease> {
    let client = build_client(token);
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    let resp = client.get(&url).send().await?.error_for_status()?;
    let release: GitHubRelease = resp.json().await?;
    Ok(release)
}

/// Fetch a specific tagged release.
pub async fn fetch_release_by_tag(
    owner: &str,
    repo: &str,
    tag: &str,
    token: Option<&str>,
) -> Result<GitHubRelease> {
    let client = build_client(token);
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/tags/{}",
        owner, repo, tag
    );
    let resp = client.get(&url).send().await?.error_for_status()?;
    let release: GitHubRelease = resp.json().await?;
    Ok(release)
}

/// Search GitHub for STS2 mod repositories.
pub async fn search_github_repos(
    query: &str,
    token: Option<&str>,
) -> Result<Vec<GitHubRepo>> {
    let client = build_client(token);
    let search_query = format!("{} slay-the-spire-2 OR sts2 OR \"slay the spire 2\"", query);

    let resp = client
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", search_query.as_str()),
            ("sort", "updated"),
            ("per_page", "30"),
        ])
        .send()
        .await?
        .error_for_status()?;

    let search: GitHubSearchResponse = resp.json().await?;
    Ok(search.items)
}

/// Download a file from a URL to a destination path with progress callback.
pub async fn download_file<F>(url: &str, dest: &Path, on_progress: F) -> Result<()>
where
    F: Fn(u64, u64),
{
    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();

    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut file = std::fs::File::create(dest)?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total);
    }

    file.flush()?;
    Ok(())
}

/// Find the best asset to download from a release (prefer .zip containing mod files).
fn find_best_asset(release: &GitHubRelease) -> Option<&GitHubAsset> {
    // Prefer zip files
    let zip_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".zip"));

    if zip_asset.is_some() {
        return zip_asset;
    }

    // Fall back to any asset
    release.assets.first()
}

/// Download and install a mod from a GitHub release.
pub async fn download_and_install_github_mod(
    owner: &str,
    repo: &str,
    tag: Option<&str>,
    mods_path: &Path,
    cache_path: &Path,
    token: Option<&str>,
) -> Result<ModInfo> {
    let release = match tag {
        Some(t) => fetch_release_by_tag(owner, repo, t, token).await?,
        None => fetch_latest_release(owner, repo, token).await?,
    };

    let asset = find_best_asset(&release).ok_or_else(|| {
        AppError::Other(format!(
            "No downloadable assets found in release {} for {}/{}",
            release.tag_name, owner, repo
        ))
    })?
    .clone();

    let dest = cache_path.join(&asset.name);

    download_file(&asset.browser_download_url, &dest, |downloaded, total| {
        log::debug!(
            "Downloading {}: {}/{}",
            asset.name,
            downloaded,
            total
        );
    })
    .await?;

    // Install the downloaded file
    if dest.extension().and_then(|e| e.to_str()) == Some("zip") {
        install_mod_from_zip(&dest, mods_path)
    } else if dest.extension().and_then(|e| e.to_str()) == Some("dll") {
        // Single DLL file - copy directly
        let dest_path = mods_path.join(&asset.name);
        std::fs::copy(&dest, &dest_path)?;
        Ok(ModInfo {
            name: asset
                .name
                .trim_end_matches(".dll")
                .to_string(),
            version: release.tag_name.clone(),
            description: release.body.clone().unwrap_or_default(),
            enabled: true,
            files: vec![asset.name.clone()],
            source: Some(format!("github:{}/{}", owner, repo)),
            hash: None,
            dependencies: Vec::new(),
        })
    } else {
        Err(AppError::Other(format!(
            "Unsupported asset type: {}",
            asset.name
        )))
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Search for STS2 mods on GitHub.
#[tauri::command]
pub async fn search_github_mods(
    query: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<GitHubRepo>, String> {
    let token = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.github_token.clone()
    };
    search_github_repos(&query, token.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download and install a mod from GitHub.
#[tauri::command]
pub async fn download_github_mod(
    owner: String,
    repo: String,
    tag: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    let (mods_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods_path, cache_path, token)
    };

    download_and_install_github_mod(
        &owner,
        &repo,
        tag.as_deref(),
        &mods_path,
        &cache_path,
        token.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Download and install a mod from a direct URL.
#[tauri::command]
pub async fn download_url_mod(
    url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    let (mods_path, cache_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        (mods_path, cache_path)
    };

    // Derive a filename from the URL
    let file_name = url::Url::parse(&url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|seg| seg.last().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "download.zip".to_string());

    let dest = cache_path.join(&file_name);

    download_file(&url, &dest, |downloaded, total| {
        log::debug!("Downloading {}: {}/{}", file_name, downloaded, total);
    })
    .await
    .map_err(|e| e.to_string())?;

    if dest.extension().and_then(|e| e.to_str()) == Some("zip") {
        install_mod_from_zip(&dest, &mods_path).map_err(|e| e.to_string())
    } else if dest.extension().and_then(|e| e.to_str()) == Some("dll") {
        let dest_path = mods_path.join(&file_name);
        std::fs::copy(&dest, &dest_path).map_err(|e| e.to_string())?;
        Ok(ModInfo {
            name: file_name.trim_end_matches(".dll").to_string(),
            version: "unknown".to_string(),
            description: String::new(),
            enabled: true,
            files: vec![file_name],
            source: Some(url),
            hash: None,
            dependencies: Vec::new(),
        })
    } else {
        Err(format!("Unsupported file type: {}", file_name))
    }
}
