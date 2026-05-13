use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};

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
    #[serde(default)]
    pub topics: Vec<String>,
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
        concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")).parse().unwrap(),
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
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let release: GitHubRelease = serde_json::from_slice(&bytes)?;
        return Ok(release);
    }
    let client = build_client(token);
    log::debug!("GitHub API: fetch latest release {}/{} (token={})", owner, repo, token.is_some());
    let resp = client.get(&url).send().await.map_err(|e| {
        log::warn!("GitHub fetch_latest_release request failed for {}/{}: {}", owner, repo, e);
        e
    })?;
    let resp = resp.error_for_status().map_err(|e| {
        log::warn!("GitHub fetch_latest_release HTTP error for {}/{}: {}", owner, repo, e);
        e
    })?;
    let release: GitHubRelease = resp.json().await?;
    log::debug!("GitHub API: {}/{} latest = {} ({} assets)", owner, repo, release.tag_name, release.assets.len());
    Ok(release)
}

/// Fetch multiple releases from a GitHub repository (paginated).
/// Returns up to `per_page` releases from the given page.
pub async fn fetch_releases(
    owner: &str,
    repo: &str,
    page: u32,
    per_page: u32,
    token: Option<&str>,
) -> Result<Vec<GitHubRelease>> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases",
        owner, repo
    );
    // Cassette layer strips query params, so paginated calls all resolve
    // to the same on-disk file. The harness only ever needs page 1.
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let releases: Vec<GitHubRelease> = serde_json::from_slice(&bytes)?;
        return Ok(releases);
    }
    let client = build_client(token);
    let resp = client
        .get(&url)
        .query(&[
            ("page", page.to_string()),
            ("per_page", per_page.to_string()),
        ])
        .send()
        .await?
        .error_for_status()?;
    let releases: Vec<GitHubRelease> = resp.json().await?;
    Ok(releases)
}

/// Fetch a specific tagged release.
pub async fn fetch_release_by_tag(
    owner: &str,
    repo: &str,
    tag: &str,
    token: Option<&str>,
) -> Result<GitHubRelease> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/tags/{}",
        owner, repo, tag
    );
    if let Some(bytes) = crate::qa_cassette::intercept_get(&url) {
        let release: GitHubRelease = serde_json::from_slice(&bytes)?;
        return Ok(release);
    }
    let client = build_client(token);
    let resp = client.get(&url).send().await?.error_for_status()?;
    let release: GitHubRelease = resp.json().await?;
    Ok(release)
}

/// Returns true iff the repo's metadata explicitly references STS2.
///
/// We require a strong signal — "sts2", "slay-the-spire-2", "slay the spire 2",
/// or "slay the spire ii" — somewhere in name / full_name / description / topics.
/// A repo that only says "slay the spire" (no 2) is for the first game and
/// must be rejected. Without this filter the search picks up StS-1 mods that
/// happen to match part of the user's query, which is the bug report.
fn repo_mentions_sts2(repo: &GitHubRepo) -> bool {
    let mut haystack = String::with_capacity(256);
    haystack.push_str(&repo.full_name);
    haystack.push(' ');
    haystack.push_str(&repo.name);
    haystack.push(' ');
    if let Some(desc) = &repo.description {
        haystack.push_str(desc);
        haystack.push(' ');
    }
    for t in &repo.topics {
        haystack.push_str(t);
        haystack.push(' ');
    }
    haystack.make_ascii_lowercase();

    // Normalize separators so "slay-the-spire-2" and "slay the spire 2" and
    // "slaythespire2" all look the same to the matcher.
    let collapsed: String = haystack
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '.' | '/' | '\\'))
        .collect();

    const SIGNALS: [&str; 3] = ["sts2", "slaythespire2", "slaythespireii"];
    SIGNALS.iter().any(|s| collapsed.contains(s))
}

async fn fetch_one_search(
    client: &reqwest::Client,
    q: &str,
) -> Result<Vec<GitHubRepo>> {
    let resp = client
        .get("https://api.github.com/search/repositories")
        .query(&[("q", q), ("per_page", "100")])
        .send()
        .await?
        .error_for_status()?;
    let search: GitHubSearchResponse = resp.json().await?;
    Ok(search.items)
}

/// Search GitHub for STS2 mod repositories.
///
/// Strategy: THREE parallel API calls, merged + STS2-filtered.
///
/// Empirically tested against the live GitHub API on 2026-05-09 with the
/// query "path" — these are the queries that actually return
/// `jadistanbelly/autopath-sts2`:
///
/// 1. `<query> sts2` — implicit AND. Matches any repo where both the
///    user's term AND the literal "sts2" token appear. Most STS2 mods
///    have "sts2" somewhere in name / description / readme.
/// 2. `<query> topic:slay-the-spire-2` — repos topic-tagged for STS2.
/// 3. `<query> topic:sts2` — same idea, alt topic. (autopath-sts2 has
///    NO topics, so falls back to query 1; other mods are tagged.)
///
/// Earlier attempts using `<query> slay-the-spire-2 OR sts2 OR "slay the
/// spire 2"` returned 304k results sorted by best-match against `path`
/// alone — none STS2-related — because GitHub's OR operator made the
/// STS2 qualifier optional. The OR-joined `topic:` version returned 0
/// because GitHub's parser doesn't handle that combination cleanly.
/// Sticking to implicit-AND queries keeps results predictable.
pub async fn search_github_repos(
    query: &str,
    token: Option<&str>,
) -> Result<Vec<GitHubRepo>> {
    let client = build_client(token);
    let q1 = format!("{} sts2", query);
    let q2 = format!("{} topic:slay-the-spire-2", query);
    let q3 = format!("{} topic:sts2", query);

    let (a, b, c) = futures_util::future::join3(
        fetch_one_search(&client, &q1),
        fetch_one_search(&client, &q2),
        fetch_one_search(&client, &q3),
    )
    .await;

    let mut merged: Vec<GitHubRepo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push_unique = |list: Vec<GitHubRepo>| {
        for repo in list {
            if seen.insert(repo.full_name.clone()) {
                merged.push(repo);
            }
        }
    };
    match a {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!("search_github_repos query (sts2 AND) failed: {}", e),
    }
    match b {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!("search_github_repos query (topic:slay-the-spire-2) failed: {}", e),
    }
    match c {
        Ok(list) => push_unique(list),
        Err(e) => log::warn!("search_github_repos query (topic:sts2) failed: {}", e),
    }

    let total = merged.len();
    let filtered: Vec<GitHubRepo> = merged
        .into_iter()
        .filter(repo_mentions_sts2)
        .collect();
    log::debug!(
        "search_github_repos: kept {}/{} repos after STS2 relevance filter (query: {})",
        filtered.len(),
        total,
        query
    );
    Ok(filtered)
}

/// Search GitHub repositories sorted by best-match relevance (no STS2 qualifier appended).
/// Used by auto-detect so the most semantically relevant repo wins, not the most recently
/// updated one. Includes the mercy-preview Accept header so `topics` is reliably populated.
pub async fn search_github_repos_relevance(
    query: &str,
    token: Option<&str>,
) -> Result<Vec<GitHubRepo>> {
    let client = build_client(token);
    let url = "https://api.github.com/search/repositories";

    let req = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.github.mercy-preview+json",
        )
        .query(&[("q", query), ("per_page", "30")]);

    log::debug!("Auto-detect search: GET {}?q={}&per_page=30", url, query);

    let resp = req.send().await?.error_for_status()?;
    let search: GitHubSearchResponse = resp.json().await?;
    Ok(search.items)
}

/// Download a file from a URL to a destination path with progress callback.
pub async fn download_file<F>(url: &str, dest: &Path, on_progress: F) -> Result<()>
where
    F: Fn(u64, u64),
{
    // Cassette playback: zip assets and other binary downloads can be
    // served from disk so the walk-back peek (peek_zip_min_game_version)
    // gets the deterministic bytes a test wrote. The fixture path mirrors
    // the URL — e.g. an asset hosted at github-releases.githubusercontent.
    // com is routed via the GitHub bucket if mapped, or simply ignored
    // here so the call falls through to the wire when there's no fixture.
    if let Some(bytes) = crate::qa_cassette::intercept_get(url) {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let total = bytes.len() as u64;
        std::fs::write(dest, &bytes)?;
        on_progress(total, total);
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("sts2-mod-manager/", env!("CARGO_PKG_VERSION")))
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

/// Sanitize an arbitrary string into a path-safe slug. Used to scope
/// cached release zips by owner/repo/tag without colliding on disk.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Download a specific tagged release's primary zip asset into a cache
/// path scoped by owner/repo/tag. Returns the cached path. Used by the
/// Repair walk-back (which downloads multiple candidate releases and
/// peeks their manifests to find a compatible one) — keeping each
/// candidate at a distinct path means parallel walk-backs of the same
/// repo don't clobber each other and the cache survives across runs.
///
/// Skips the actual HTTP download if a non-empty cached file already
/// exists for the same tag — useful for repeat repair attempts.
pub async fn download_release_zip_to_cache(
    owner: &str,
    repo: &str,
    tag: &str,
    cache_path: &Path,
    token: Option<&str>,
) -> Result<PathBuf> {
    let release = fetch_release_by_tag(owner, repo, tag, token).await?;
    let asset = find_best_asset(&release).ok_or_else(|| {
        AppError::Other(format!(
            "Release {} for {}/{} has no downloadable asset",
            tag, owner, repo
        ))
    })?;

    if !asset.name.ends_with(".zip") {
        return Err(AppError::Other(format!(
            "Release {} for {}/{} is not a zip ({}) — walk-back can only inspect zip releases",
            tag, owner, repo, asset.name
        )));
    }

    let dir = cache_path
        .join("repair-walkback")
        .join(format!("{}__{}", slugify(owner), slugify(repo)));
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("{}__{}", slugify(tag), asset.name));

    // Reuse the cached zip if it's already there and non-empty.
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.is_file() && meta.len() > 0 {
            log::debug!("Walk-back: reusing cached {}", dest.display());
            return Ok(dest);
        }
    }

    download_file(&asset.browser_download_url, &dest, |_, _| {})
        .await
        .map_err(|e| {
            log::error!(
                "Walk-back: download failed for {}/{}@{} asset '{}': {}",
                owner, repo, tag, asset.name, e
            );
            e
        })?;
    log::debug!("Walk-back: downloaded {}/{}@{} -> {}", owner, repo, tag, dest.display());
    Ok(dest)
}

/// Open a downloaded mod zip and read the `min_game_version` field from
/// whichever JSON manifest it contains (top-level `mod_manifest.json` or
/// the first `*.json` we find that has a `min_game_version` key). Used
/// by the Repair walk-back to pre-screen each candidate release before
/// committing to install it.
///
/// Returns:
///   - `Ok(Some("0.105.0"))` — manifest declares a minimum
///   - `Ok(None)` — manifest exists but doesn't declare one (mod runs on
///     any build)
///   - `Err(...)` — couldn't open the zip or no manifest at all
pub fn peek_zip_min_game_version(zip_path: &Path) -> Result<Option<String>> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Open zip {}: {}", zip_path.display(), e)))?;

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if !name.to_lowercase().ends_with(".json") {
            continue;
        }
        if name.starts_with("__MACOSX") || name.starts_with("._") {
            continue;
        }
        // Mod manifests live at root or one folder deep — skip anything
        // buried inside a deep subdirectory.
        if name.split('/').count() > 2 {
            continue;
        }

        let mut buf = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut buf).is_err() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(crate::mods::strip_utf8_bom(&buf)) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Try both case variants the ecosystem uses.
        let mgv = val.get("min_game_version")
            .or_else(|| val.get("MinGameVersion"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_start_matches('v').to_string())
            .filter(|s| !s.is_empty());
        return Ok(mgv);
    }
    Err(AppError::Other(format!(
        "No JSON manifest found inside {}",
        zip_path.display()
    )))
}

/// Install a GitHub mod, picking the latest release that's actually
/// compatible with the user's game version. If `user_game_version` is
/// None we don't have anything to compare against — install latest
/// (legacy behavior).
///
/// Used by every "first install from GitHub" entry point — Browse →
/// Install, Add by URL with a github.com URL, the friend-pack apply
/// flow. Repair has its own caller because it also handles the
/// pre-existing on-disk install (defensive folder sweep).
///
/// Returns (info, chosen_tag, walked_back) so the frontend can toast a
/// version-aware message ("Installed AutoPath v1.3.0 — latest compatible
/// for your game v0.103.2") instead of just "Installed".
pub async fn install_compatible_github_mod(
    owner: &str,
    repo: &str,
    mods_path: &Path,
    cache_path: &Path,
    user_game_version: Option<&str>,
    token: Option<&str>,
) -> Result<(crate::mods::ModInfo, String, bool)> {
    if user_game_version.is_none() {
        // No way to compare — fall through to legacy "install latest" path.
        let info = download_and_install_github_mod(owner, repo, None, mods_path, cache_path, token).await?;
        return Ok((info, String::new(), false));
    }

    let chosen = crate::updater::pick_compatible_release(
        owner, repo, user_game_version, cache_path, token,
    )
    .await?;

    // Determine if this was actually a walk-back (i.e. we picked something
    // older than latest) so the caller can toast about it. Cheap second
    // call to fetch_latest_release — already cached server-side via the
    // GitHub API's CDN.
    let walked_back = match fetch_latest_release(owner, repo, token).await {
        Ok(latest) => latest.tag_name != chosen.tag,
        Err(_) => false,
    };

    let info = crate::mods::install_mod_from_zip(&chosen.zip_path, mods_path)
        .map_err(|e| AppError::Other(format!("install_mod_from_zip failed: {}", e)))?;

    if walked_back {
        log::info!(
            "install_compatible_github_mod: picked {}/{}@{} for game v{} (skipped newer release with min_game_version={})",
            owner, repo, chosen.tag,
            user_game_version.unwrap_or("?"),
            chosen.min_game_version.as_deref().unwrap_or("?"),
        );
    }
    Ok((info, chosen.tag, walked_back))
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
    log::info!(
        "Downloading GitHub mod {}/{} (tag={}, mods_path={}, cache_path={})",
        owner, repo, tag.unwrap_or("<latest>"),
        mods_path.display(), cache_path.display()
    );
    let release = match tag {
        Some(t) => fetch_release_by_tag(owner, repo, t, token).await?,
        None => fetch_latest_release(owner, repo, token).await?,
    };

    let asset = find_best_asset(&release).ok_or_else(|| {
        log::error!(
            "No downloadable assets in release {} for {}/{} (assets: {:?})",
            release.tag_name, owner, repo,
            release.assets.iter().map(|a| &a.name).collect::<Vec<_>>()
        );
        AppError::Other(format!(
            "No downloadable assets found in release {} for {}/{}",
            release.tag_name, owner, repo
        ))
    })?
    .clone();

    log::info!(
        "Selected asset '{}' for {}/{} v{} ({} bytes)",
        asset.name, owner, repo, release.tag_name, asset.size
    );

    let dest = cache_path.join(&asset.name);

    download_file(&asset.browser_download_url, &dest, |downloaded, total| {
        log::debug!(
            "Downloading {}: {}/{}",
            asset.name,
            downloaded,
            total
        );
    })
    .await
    .map_err(|e| {
        log::error!("Download failed for {}/{} asset '{}': {}", owner, repo, asset.name, e);
        e
    })?;

    log::info!("Downloaded '{}' to {}", asset.name, dest.display());

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
            size_bytes: 0,
            github_url: Some(format!("https://github.com/{}/{}", owner, repo)),
            nexus_url: None,
            folder_name: None,
            mod_id: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
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

/// Download and install a mod from GitHub, and auto-save the source link.
#[tauri::command]
pub async fn download_github_mod(
    owner: String,
    repo: String,
    tag: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path, token, config_path, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        let token = s.github_token.clone();
        let config_path = s.config_path.clone();
        let game_version = s.game_version.clone();
        (mods_path, cache_path, token, config_path, game_version)
    };

    // When the caller asked for a specific tag, install that exact tag —
    // they know what they want. When asking for "latest" (tag=None),
    // route through the compatibility-aware installer so we don't land
    // a release the game can't load.
    let mod_info = if let Some(t) = tag.as_deref() {
        download_and_install_github_mod(&owner, &repo, Some(t), &mods_path, &cache_path, token.as_deref())
            .await
            .map_err(|e| e.to_string())?
    } else {
        let (info, _chosen_tag, _walked_back) = install_compatible_github_mod(
            &owner, &repo, &mods_path, &cache_path, game_version.as_deref(), token.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
        info
    };

    // Auto-save the GitHub source link so updates work later. Key by
    // folder_name when available so two same-named mods with different
    // GitHub origins each retain their own source link.
    let mut db = crate::mod_sources::load_sources(&config_path);
    let key = mod_info.folder_name.clone().unwrap_or_else(|| mod_info.name.clone());
    let entry = db.mods.entry(key).or_default();
    entry.github_repo = Some(format!("{}/{}", owner, repo));
    let _ = crate::mod_sources::save_sources(&db, &config_path);

    Ok(mod_info)
}

/// Download and install a mod from a direct URL.
#[tauri::command]
pub async fn download_url_mod(
    url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, cache_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let cache_path = s.cache_path.clone();
        (mods_path, cache_path)
    };

    // Derive a filename from the URL.
    // The raw last-path-segment is attacker-influenced (the user pastes the
    // URL into Quick Add, or a hostile profile points at one). URL-decoded
    // `..%2F..%2F` would otherwise traverse out of the cache or mods folder
    // when joined below — sanitize to a single safe segment first.
    let raw_file_name = url::Url::parse(&url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|seg| seg.last().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "download.zip".to_string());
    let file_name = crate::mods::sanitize_path_segment(&raw_file_name);

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
        // Defense-in-depth: even after sanitize_path_segment, confirm the
        // join didn't escape the mods folder.
        if !crate::mods::path_is_inside(&dest_path, &mods_path) {
            return Err(format!(
                "Refusing to write outside mods folder: {}",
                dest_path.display()
            ));
        }
        std::fs::copy(&dest, &dest_path).map_err(|e| e.to_string())?;
        let mod_name = file_name.trim_end_matches(".dll").to_string();
        Ok(ModInfo {
            name: mod_name.clone(),
            version: "unknown".to_string(),
            description: String::new(),
            enabled: true,
            files: vec![file_name],
            source: Some(url),
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            folder_name: Some(mod_name),
            mod_id: None,
            github_url: None,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
        })
    } else {
        Err(format!("Unsupported file type: {}", file_name))
    }
}
