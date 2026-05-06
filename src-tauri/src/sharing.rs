use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;

use crate::error::{AppError, Result};
use crate::profiles::Profile;
use crate::state::AppState;

/// In-flight guard so a double-click on Share / Re-share for the same profile
/// can't kick off two concurrent uploads that race against the same gist files
/// (which previously produced 409 SHA-mismatch storms on GitHub's API).
/// Holds the lock for the duration of the share/reshare; the Drop impl frees it
/// even if the operation errors out.
struct ShareGuard {
    state: AppState,
    name: String,
}

impl ShareGuard {
    fn try_acquire(state: &AppState, name: &str) -> std::result::Result<Self, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        if !s.sharing_in_flight.insert(name.to_string()) {
            return Err(format!(
                "A share for '{}' is already in progress -- please wait for it to finish.",
                name
            ));
        }
        Ok(Self {
            state: state.clone(),
            name: name.to_string(),
        })
    }
}

impl Drop for ShareGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            s.sharing_in_flight.remove(&self.name);
        }
    }
}

// ── Types ───────────────────────────────────────────────────────────────────

const PROFILES_REPO: &str = "sts2mm-profiles";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareResult {
    /// The profile code (e.g. "AA5A-315D-61AE")
    pub code: String,
    /// The GitHub username who shared it
    pub owner: String,
    /// The raw file path in the repo
    pub file_path: String,
    /// The URL to view on GitHub
    pub url: String,
}

/// Local share info stored per profile for re-sharing
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareInfo {
    code: String,
    /// GitHub username who owns the profiles repo
    owner: String,
    /// SHA of the file in the repo (needed for updates)
    file_sha: Option<String>,
}

/// GitHub Contents API response
#[derive(Debug, Deserialize)]
struct ContentsResponse {
    sha: Option<String>,
    content: Option<String>,
    html_url: Option<String>,
}

/// GitHub repo check response
#[derive(Debug, Deserialize)]
struct RepoResponse {
    full_name: Option<String>,
}

/// GitHub user response
#[derive(Debug, Deserialize)]
struct UserResponse {
    login: String,
}

// ── Profile Code Encoding ──────────────────────────────────────────────────

/// Generate a deterministic short code from profile content.
/// Uses SHA-256 hash of the profile name + timestamp to get a unique code.
fn generate_code(profile: &Profile) -> String {
    let mut hasher = Sha256::new();
    hasher.update(profile.name.as_bytes());
    hasher.update(chrono::Utc::now().timestamp().to_le_bytes());
    let hash = hasher.finalize();
    let hex: String = hash
        .iter()
        .take(6)
        .map(|b| format!("{:02X}", b))
        .collect();
    // Format as XXXX-XXXX-XXXX
    let chars: Vec<char> = hex.chars().collect();
    format!(
        "{}-{}-{}",
        chars[0..4].iter().collect::<String>(),
        chars[4..8].iter().collect::<String>(),
        chars[8..12].iter().collect::<String>()
    )
}

/// Code to filename: "AA5A-315D-61AE" -> "aa5a315d61ae.json"
fn code_to_filename(code: &str) -> String {
    format!("{}.json", code.replace('-', "").to_lowercase())
}

/// Normalize user input: accept code, filename, or full URL
fn normalize_code_input(input: &str) -> String {
    let trimmed = input.trim();

    // If it's a GitHub URL, extract the filename
    if trimmed.contains("github.com") || trimmed.contains("raw.githubusercontent.com") {
        if let Some(name) = trimmed.rsplit('/').next() {
            let name = name.trim_end_matches(".json");
            return name.replace('-', "").to_uppercase();
        }
    }

    // Strip dashes and normalize
    trimmed.replace('-', "").to_uppercase()
}

/// Format a raw code string back to XXXX-XXXX-XXXX
fn format_code(raw: &str) -> String {
    let upper: String = raw.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    if upper.len() >= 12 {
        format!("{}-{}-{}", &upper[0..4], &upper[4..8], &upper[8..12])
    } else {
        upper
    }
}

// ── GitHub API Helpers ─────────────────────────────────────────────────────

fn build_client(token: &str) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        "sts2-mod-manager/0.1".parse().unwrap(),
    );
    if let Ok(val) = format!("Bearer {}", token).parse() {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_default()
}

/// Get the authenticated user's GitHub username.
async fn get_github_username(token: &str) -> Result<String> {
    let client = build_client(token);
    let resp = client.get("https://api.github.com/user").send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "GitHub authentication failed ({}). Check your token in Settings. Error: {}",
            status, text
        )));
    }

    let user: UserResponse = resp.json().await?;
    Ok(user.login)
}

/// Ensure the sts2mm-profiles repo exists. Creates it if not.
async fn ensure_profiles_repo(token: &str, username: &str) -> Result<()> {
    let client = build_client(token);

    // Check if repo exists
    let resp = client
        .get(&format!(
            "https://api.github.com/repos/{}/{}",
            username, PROFILES_REPO
        ))
        .send()
        .await?;

    if resp.status().is_success() {
        return Ok(());
    }

    // Create the repo
    let body = serde_json::json!({
        "name": PROFILES_REPO,
        "description": "Shared mod profiles for STS2 Mod Manager",
        "public": true,
        "auto_init": true  // Creates with a README so we have a branch to push to
    });

    let resp = client
        .post("https://api.github.com/user/repos")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if status.as_u16() == 422 && text.contains("already exists") {
            return Ok(()); // Race condition, it exists
        }

        return Err(AppError::Other(format!(
            "Could not create '{}' repository ({}). You can create it manually on GitHub: go to github.com/new, name it '{}', make it public. Error: {}",
            PROFILES_REPO, status, PROFILES_REPO, text
        )));
    }

    Ok(())
}

/// Create or update a file in the profiles repo.
async fn upsert_file(
    token: &str,
    username: &str,
    filename: &str,
    content: &str,
    existing_sha: Option<&str>,
    message: &str,
) -> Result<(String, String)> {
    let client = build_client(token);
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        username, PROFILES_REPO, filename
    );

    // If we don't have the SHA, try to get it (needed for updates)
    let sha = if let Some(s) = existing_sha {
        Some(s.to_string())
    } else {
        let resp = client.get(&url).send().await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                let info: ContentsResponse = resp.json().await.unwrap_or(ContentsResponse {
                    sha: None,
                    content: None,
                    html_url: None,
                });
                info.sha
            } else {
                None
            }
        } else {
            None
        }
    };

    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, content);
    let mut body = serde_json::json!({
        "message": message,
        "content": encoded,
    });

    if let Some(sha) = &sha {
        body["sha"] = serde_json::json!(sha);
    }

    let resp = client.put(&url).json(&body).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to upload profile ({}): {}",
            status, text
        )));
    }

    let data: serde_json::Value = resp.json().await?;
    let file_sha = data["content"]["sha"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let html_url = data["content"]["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok((file_sha, html_url))
}

/// Zip a mod's files into an in-memory buffer.
fn zip_mod_files(mod_name: &str, files: &[String], mods_path: &std::path::Path) -> Result<Vec<u8>> {
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip_writer = zip::ZipWriter::new(buf);

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for file_rel in files {
        let normalized = file_rel.replace('\\', "/");
        let file_path = mods_path.join(&normalized);

        if file_path.is_file() {
            zip_writer.start_file(&normalized, options)
                .map_err(|e| AppError::Other(format!("Zip error for '{}': {}", mod_name, e)))?;
            let data = std::fs::read(&file_path)
                .map_err(|e| AppError::Other(format!("Read error for '{}': {}", file_path.display(), e)))?;
            zip_writer.write_all(&data)
                .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
        } else if file_path.is_dir() {
            // For directory entries, add all files within
            if let Ok(entries) = std::fs::read_dir(&file_path) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        let entry_rel = format!("{}/{}", normalized, entry.file_name().to_string_lossy());
                        zip_writer.start_file(&entry_rel, options)
                            .map_err(|e| AppError::Other(format!("Zip error: {}", e)))?;
                        let data = std::fs::read(entry.path())
                            .map_err(|e| AppError::Other(format!("Read error: {}", e)))?;
                        zip_writer.write_all(&data)
                            .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
                    }
                }
            }
        }
    }

    let cursor = zip_writer.finish()
        .map_err(|e| AppError::Other(format!("Zip finalize error: {}", e)))?;
    Ok(cursor.into_inner())
}

/// Upload a binary file (mod zip) to the profiles repo using base64 encoding.
/// Uses versioned filenames so different profile versions don't overwrite each other.
async fn upload_mod_bundle(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_data: &[u8],
) -> Result<String> {
    let client = build_client(token);
    let safe_name = mod_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let safe_ver = version
        .trim_start_matches('v')
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect::<String>();
    let filename = format!("mods/{}_{}.zip", safe_name, safe_ver);
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        username, PROFILES_REPO, filename
    );

    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, zip_data);

    // Fetch the current SHA (None if the file does not exist yet) and PUT.
    // GitHub's create-or-update file API rejects with 409/422 if the SHA we
    // pass doesn't match the current file -- which happens when two reshares
    // race for the same path. On 409/422 we re-fetch the SHA and retry once;
    // that's enough for the common case (a stale read followed by another
    // writer landing first) without masking real auth/permission errors.
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt = 0u32;
    loop {
        attempt += 1;

        let existing_sha = fetch_existing_sha(&client, &url).await;

        let mut body = serde_json::json!({
            "message": format!("Bundle mod: {} v{}", mod_name, version),
            "content": encoded.clone(),
        });
        if let Some(ref sha) = existing_sha {
            body["sha"] = serde_json::json!(sha);
        }

        let resp = client.put(&url).json(&body).send().await?;
        let status = resp.status();
        if status.is_success() {
            let download_url = format!(
                "https://raw.githubusercontent.com/{}/{}/main/{}",
                username, PROFILES_REPO, filename
            );
            return Ok(download_url);
        }

        let text = resp.text().await.unwrap_or_default();
        let is_sha_conflict = status.as_u16() == 409 || status.as_u16() == 422;
        if is_sha_conflict && attempt < MAX_ATTEMPTS {
            log::warn!(
                "Upload conflict for '{}' (attempt {}/{}, status {}): {} -- retrying with fresh SHA",
                mod_name, attempt, MAX_ATTEMPTS, status, text.lines().next().unwrap_or("").chars().take(160).collect::<String>()
            );
            continue;
        }

        return Err(AppError::Other(format!(
            "Failed to upload mod bundle '{}' ({}): {}",
            mod_name, status, text
        )));
    }
}

async fn fetch_existing_sha(client: &reqwest::Client, url: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let info: ContentsResponse = resp.json().await.unwrap_or(ContentsResponse {
        sha: None, content: None, html_url: None,
    });
    info.sha
}
/// Download a bundled mod zip from a URL and extract into mods_path.
/// Uses the GitHub API (not raw.githubusercontent.com) to avoid CDN caching issues.
pub async fn download_bundle(url: &str, mod_name: &str, mods_path: &std::path::Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();

    // Parse the raw.githubusercontent.com URL to extract owner/repo/path
    // Format: https://raw.githubusercontent.com/OWNER/REPO/main/PATH
    let bytes = if url.contains("raw.githubusercontent.com") {
        // Use GitHub API to avoid CDN caching issues
        let parts: Vec<&str> = url
            .trim_start_matches("https://raw.githubusercontent.com/")
            .splitn(4, '/')
            .collect();
        if parts.len() >= 4 {
            let (owner, repo, _branch, path) = (parts[0], parts[1], parts[2], parts[3]);
            let api_url = format!(
                "https://api.github.com/repos/{}/{}/contents/{}",
                owner, repo, path
            );
            log::info!("Downloading bundle '{}' via GitHub API: {}", mod_name, api_url);

            let resp = client
                .get(&api_url)
                .header("Accept", "application/vnd.github.raw+json")
                .send()
                .await?;

            if !resp.status().is_success() {
                // Fallback to direct URL if API fails
                log::warn!("GitHub API download failed for '{}' ({}), falling back to direct URL", mod_name, resp.status());
                let resp2 = client.get(url).send().await?;
                if !resp2.status().is_success() {
                    return Err(AppError::Other(format!(
                        "Failed to download bundle for '{}': {}",
                        mod_name, resp2.status()
                    )));
                }
                resp2.bytes().await?
            } else {
                resp.bytes().await?
            }
        } else {
            // Can't parse URL, use direct download
            let resp = client.get(url).send().await?;
            if !resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Failed to download bundle for '{}': {}",
                    mod_name, resp.status()
                )));
            }
            resp.bytes().await?
        }
    } else {
        // Non-GitHub URL, use direct download
        let resp = client.get(url).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Failed to download bundle for '{}': {}",
                mod_name, resp.status()
            )));
        }
        resp.bytes().await?
    };

    log::info!("Downloaded bundle for '{}': {} bytes", mod_name, bytes.len());
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::Other(format!("Invalid bundle zip for '{}': {}", mod_name, e)))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let Some(outpath) = file.enclosed_name().map(|p| mods_path.join(p)) else {
            continue;
        };
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

/// Fetch a profile from any user's profiles repo (public, no auth needed).
/// Uses the GitHub Contents API to avoid CDN caching issues with raw.githubusercontent.com.
/// This ensures that recently reshared profiles are fetched immediately.
pub async fn fetch_shared_profile(owner: &str, filename: &str) -> Result<Profile> {
    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();

    // Primary: use GitHub Contents API with raw accept header to bypass CDN cache.
    // Works without auth for public repos (60 req/hour rate limit, plenty for subscription checks).
    let api_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        owner, PROFILES_REPO, filename
    );
    log::info!("Fetching shared profile via GitHub API: {}", api_url);

    let api_resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github.raw+json")
        .send()
        .await;

    let text = match api_resp {
        Ok(resp) if resp.status().is_success() => resp.text().await?,
        Ok(resp) => {
            let status = resp.status();
            log::warn!(
                "GitHub API fetch failed for profile ({}) -- falling back to raw URL",
                status
            );
            // Fallback: raw.githubusercontent.com (may be cached but better than nothing)
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/main/{}",
                owner, PROFILES_REPO, filename
            );
            let fallback_resp = client.get(&raw_url).send().await?;
            if !fallback_resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Profile not found ({}). Check the code and try again.",
                    fallback_resp.status()
                )));
            }
            fallback_resp.text().await?
        }
        Err(e) => {
            log::warn!(
                "GitHub API request failed for profile: {} -- falling back to raw URL",
                e
            );
            let raw_url = format!(
                "https://raw.githubusercontent.com/{}/{}/main/{}",
                owner, PROFILES_REPO, filename
            );
            let fallback_resp = client.get(&raw_url).send().await?;
            if !fallback_resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Profile not found ({}). Check the code and try again.",
                    fallback_resp.status()
                )));
            }
            fallback_resp.text().await?
        }
    };

    let profile: Profile = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("Invalid profile data: {}", e)))?;

    Ok(profile)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Share a profile by uploading to a GitHub repo. Returns a short profile code.
/// If already shared, reuses the existing code (delegates to reshare logic).
#[tauri::command]
pub async fn share_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let (profiles_path, mods_path, disabled_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required to share profiles. Set it in Settings."
        )?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        (s.profiles_path.clone(), mods_path, disabled_path, s.config_path.clone(), token)
    };

    // If already shared, reuse the existing code (same as reshare). Drop our
    // would-be guard before delegating so reshare_profile can acquire its own
    // without "already in progress" tripping.
    let share_info_path = profiles_path.join(format!("{}.share", name));
    if share_info_path.exists() {
        log::info!("Profile '{}' already shared, reusing code via reshare", name);
        return reshare_profile(name, state).await;
    }

    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    let mut profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    // Get username
    let username = get_github_username(&token)
        .await
        .map_err(|e| e.to_string())?;

    // Ensure repo exists
    ensure_profiles_repo(&token, &username)
        .await
        .map_err(|e| e.to_string())?;

    // Bundle ALL mods to guarantee version matching.
    // Friends get the exact same files the curator has installed.
    // GitHub sources are kept as metadata but bundles are preferred during install.
    for pm in &mut profile.mods {
        if pm.files.is_empty() {
            log::info!("Skipping '{}' -- no files to bundle", pm.name);
            continue;
        }

        log::info!("Bundling mod '{}' ({} files)", pm.name, pm.files.len());
        match zip_mod_files(&pm.name, &pm.files, &mods_path) {
            Ok(zip_data) => {
                match upload_mod_bundle(&token, &username, &pm.name, &pm.version, &zip_data).await {
                    Ok(url) => {
                        pm.bundle_url = Some(url);
                        log::info!("Bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
                    }
                    Err(e) => {
                        log::warn!("Failed to upload bundle for '{}': {}", pm.name, e);
                        // If bundling fails and there's no GitHub source either, this mod won't be downloadable
                        if pm.source.is_none() {
                            log::error!("Mod '{}' has no bundle AND no GitHub source -- friends won't be able to download it", pm.name);
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to zip mod '{}': {}", pm.name, e);
            }
        }
    }

    // Generate code and filename
    let code = generate_code(&profile);
    let filename = code_to_filename(&code);
    let profile_json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;

    // Upload profile JSON
    let (file_sha, html_url) = upsert_file(
        &token,
        &username,
        &filename,
        &profile_json,
        None,
        &format!("Share profile: {} ({} mods)", profile.name, profile.mods.len()),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Save the enriched profile back to local JSON (with bundle_urls)
    // This is critical: switch_profile loads local JSON, which needs bundle_urls
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;
    log::info!("Saved enriched profile '{}' with bundle_urls to local JSON", name);

    // Store share info locally for re-sharing
    let share_info = ShareInfo {
        code: code.clone(),
        owner: username.clone(),
        file_sha: Some(file_sha),
    };
    let share_info_path = profiles_path.join(format!("{}.share", name));
    std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(ShareResult {
        code,
        owner: username,
        file_path: filename,
        url: html_url,
    })
}

/// Get the share info (code + owner) for a profile, if it has been shared.
#[tauri::command]
pub fn get_share_info(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<ShareResult>, String> {
    let profiles_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.profiles_path.clone()
    };
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let content = match std::fs::read_to_string(&share_info_path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let info: ShareInfo = match serde_json::from_str(&content) {
        Ok(i) => i,
        Err(_) => return Ok(None),
    };
    let filename = code_to_filename(&info.code);
    let url = format!(
        "https://github.com/{}/{}/blob/main/{}",
        info.owner, PROFILES_REPO, filename
    );
    Ok(Some(ShareResult {
        code: info.code,
        owner: info.owner,
        file_path: filename,
        url,
    }))
}

/// Re-share (update) an already-shared profile. Same code, updated content.
/// Re-snapshots the current mods from disk so removed mods are excluded.
/// Preserves original created_at and sets created_by to the GitHub username.
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let _guard = ShareGuard::try_acquire(state.inner(), &name)?;

    let (profiles_path, mods_path, disabled_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required. Set it in Settings."
        )?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_path = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        (s.profiles_path.clone(), mods_path, disabled_path, s.config_path.clone(), token)
    };

    // Load existing share info
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet. Use 'Share' first.".to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Load the existing profile to preserve created_at
    let old_profile = crate::profiles::load_profile(&name, &profiles_path).ok();

    // Re-snapshot current mods from disk so removed mods are excluded
    // and newly added mods are included. Use explicit disabled path from state.
    let mut profile = crate::profiles::snapshot_current_with_paths(
        &name, &mods_path, &disabled_path, &profiles_path, Some(&config_path),
    ).map_err(|e| e.to_string())?;

    // Preserve original metadata
    if let Some(ref old) = old_profile {
        profile.created_at = old.created_at;
    }
    profile.created_by = Some(share_info.owner.clone());
    log::info!("Re-snapshot profile '{}': {} mods from disk", name, profile.mods.len());

    // Bundle ALL mods to guarantee version matching (same as share_profile).
    for pm in &mut profile.mods {
        if pm.files.is_empty() {
            continue;
        }

        log::info!("Re-bundling mod '{}' ({} files)", pm.name, pm.files.len());
        match zip_mod_files(&pm.name, &pm.files, &mods_path) {
            Ok(zip_data) => {
                match upload_mod_bundle(&token, &share_info.owner, &pm.name, &pm.version, &zip_data).await {
                    Ok(url) => {
                        pm.bundle_url = Some(url);
                        log::info!("Re-bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
                    }
                    Err(e) => {
                        log::warn!("Failed to upload bundle for '{}': {}", pm.name, e);
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to zip mod '{}': {}", pm.name, e);
            }
        }
    }

    let filename = code_to_filename(&share_info.code);
    let profile_json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;

    let (file_sha, html_url) = upsert_file(
        &token,
        &share_info.owner,
        &filename,
        &profile_json,
        share_info.file_sha.as_deref(),
        &format!("Update profile: {} ({} mods)", profile.name, profile.mods.len()),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Save enriched profile back to local JSON (with bundle_urls)
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;
    log::info!("Saved re-shared enriched profile '{}' to local JSON", name);

    let owner = share_info.owner.clone();
    let code = share_info.code.clone();

    // Update local share info with new SHA
    let updated_info = ShareInfo {
        code: share_info.code,
        owner: share_info.owner,
        file_sha: Some(file_sha),
    };
    let _ = std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&updated_info).unwrap(),
    );

    Ok(ShareResult {
        code,
        owner,
        file_path: filename,
        url: html_url,
    })
}

/// Fetch a shared profile by code. The code format is "OWNER:CODE" where OWNER is
/// the GitHub username and CODE is the profile code. Friends need both parts.
/// Format: "username/AA5A-315D-61AE"
#[tauri::command]
pub async fn fetch_shared_profile_cmd(
    code: String,
    _state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let (owner, profile_code) = parse_share_code(&code)
        .map_err(|e| e.to_string())?;

    let filename = code_to_filename(&profile_code);
    fetch_shared_profile(&owner, &filename)
        .await
        .map_err(|e| e.to_string())
}

/// Install a shared profile from a code AND auto-subscribe for updates.
/// Downloads missing mods FIRST, then applies the profile (enable/disable).
#[tauri::command]
pub async fn install_shared_profile(
    code: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    let (owner, profile_code) = parse_share_code(&code)
        .map_err(|e| e.to_string())?;

    let filename = code_to_filename(&profile_code);
    let profile = fetch_shared_profile(&owner, &filename)
        .await
        .map_err(|e| e.to_string())?;

    let (mods_path, disabled_path, profiles_path, config_path, cache_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled = s.disabled_mods_path.clone().ok_or("Game path not set")?;
        let profiles = s.profiles_path.clone();
        let config = s.config_path.clone();
        let cache = s.cache_path.clone();
        let token = s.github_token.clone();
        (mods, disabled, profiles, config, cache, token)
    };

    // Save the profile locally
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // ── STEP 1: Download missing mods and restore version-mismatched mods ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    let all_on_disk: Vec<crate::mods::ModInfo> = local_mods.into_iter()
        .chain(local_disabled.into_iter())
        .collect();

    // Build a map from identifiers to on-disk mod info (for version comparison)
    let mut on_disk_by_id: std::collections::HashMap<String, &crate::mods::ModInfo> = std::collections::HashMap::new();
    for m in &all_on_disk {
        on_disk_by_id.insert(m.name.clone(), m);
        if let Some(ref folder) = m.folder_name {
            on_disk_by_id.insert(folder.clone(), m);
        }
        if let Some(ref id) = m.mod_id {
            on_disk_by_id.insert(id.clone(), m);
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let mut download_failures: Vec<String> = Vec::new();

    for pm in &profile.mods {
        // Find matching on-disk mod
        let on_disk_mod = on_disk_by_id.get(&pm.name)
            .or_else(|| pm.folder_name.as_ref().and_then(|f| on_disk_by_id.get(f)))
            .or_else(|| pm.mod_id.as_ref().and_then(|id| on_disk_by_id.get(id)))
            .copied();

        if let Some(disk_mod) = on_disk_mod {
            let disk_ver = disk_mod.version.trim_start_matches('v');
            let profile_ver = pm.version.trim_start_matches('v');

            let version_ok = disk_ver == profile_ver
                || profile_ver == "unknown" || profile_ver == "0.0.0"
                || disk_ver == "unknown" || disk_ver == "0.0.0";

            if version_ok {
                log::info!("Mod '{}' already on disk at correct version ({})", pm.name, disk_mod.version);
                continue;
            }

            // Version mismatch -- need to replace with the profile's version
            if pm.bundle_url.is_some() {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) -- will reinstall",
                    pm.name, disk_mod.version, pm.version
                );
                // Cache the current version before deleting (so user can switch back)
                crate::mods::cache_mod_version(disk_mod, if disk_mod.enabled { &mods_path } else { &disabled_path }, &cache_path);
                // Delete old version
                let base = if disk_mod.enabled { &mods_path } else { &disabled_path };
                crate::mods::delete_mod_files_by_info(disk_mod, base);
                // Fall through to download the correct version
            } else {
                log::info!(
                    "Mod '{}' version mismatch (disk: {}, profile: {}) but no bundle -- keeping disk version",
                    pm.name, disk_mod.version, pm.version
                );
                continue;
            }
        }

        // Prefer bundle_url over GitHub -- the curator bundled it because
        // the GitHub source may be wrong/unreliable (e.g., wrong game's repo)
        if let Some(ref bundle_url) = pm.bundle_url {
            log::info!("Downloading bundled mod '{}' from profiles repo", pm.name);
            match download_bundle(bundle_url, &pm.name, &mods_path).await {
                Ok(_) => {
                    log::info!("Installed bundled mod '{}'", pm.name);
                    continue;
                }
                Err(e) => {
                    log::warn!("Bundle download failed for '{}': {} -- trying GitHub fallback", pm.name, e);
                }
            }
        }

        // Fallback: try GitHub source
        let github_repo = pm
            .source
            .as_ref()
            .and_then(|s| {
                if let Some(repo) = s.strip_prefix("github:") {
                    return Some(repo.to_string());
                }
                if s.contains("github.com/") {
                    let parts: Vec<&str> = s.split("github.com/").collect();
                    if parts.len() > 1 {
                        let repo_path = parts[1].trim_end_matches('/');
                        let segs: Vec<&str> = repo_path.splitn(3, '/').collect();
                        if segs.len() >= 2 {
                            return Some(format!("{}/{}", segs[0], segs[1]));
                        }
                    }
                }
                None
            })
            .or_else(|| {
                mod_sources_db
                    .mods
                    .get(&pm.name)
                    .and_then(|e| e.github_repo.clone())
            });

        if let Some(repo) = github_repo {
            let parts: Vec<&str> = repo.splitn(2, '/').collect();
            if parts.len() == 2 {
                match crate::download::download_and_install_github_mod(
                    parts[0],
                    parts[1],
                    None,
                    &mods_path,
                    &cache_path,
                    token.as_deref(),
                )
                .await
                {
                    Ok(info) => {
                        log::info!("Downloaded mod '{}' from GitHub", info.name);
                        continue;
                    }
                    Err(e) => {
                        log::warn!("GitHub download also failed for '{}': {}", pm.name, e);
                    }
                }
            }
        }

        log::warn!("No download source for mod '{}' -- skipping", pm.name);
        download_failures.push(pm.name.clone());
    }

    if !download_failures.is_empty() {
        log::warn!(
            "Could not download {} mods: {:?}. These need to be installed manually.",
            download_failures.len(),
            download_failures
        );
    }

    // ── STEP 2: Apply profile AFTER downloads ──
    // Now all downloadable mods are in mods_path, apply_profile can correctly enable/disable
    crate::profiles::apply_profile(&profile, &mods_path, &disabled_path)
        .map_err(|e| e.to_string())?;

    // ── STEP 3: Auto-subscribe for future updates ──
    let share_key = format!("{}:{}", owner, profile_code);
    let now = chrono::Utc::now();
    let sub = crate::subscriptions::Subscription {
        share_id: share_key.clone(),
        share_url: format!("{}/{}", owner, format_code(&profile_code)),
        profile_name: profile.name.clone(),
        curator: profile.created_by.clone(),
        last_synced_profile: profile.clone(),
        last_checked: now,
        last_synced: now,
    };
    let mut db = crate::subscriptions::load_subscriptions(&config_path);
    db.subscriptions.insert(share_key, sub);
    let _ = crate::subscriptions::save_subscriptions(&db, &config_path);

    Ok(profile)
}

/// Parse a share code like "username/AA5A-315D-61AE" into (owner, code).
fn parse_share_code(input: &str) -> Result<(String, String)> {
    let trimmed = input.trim();

    // Format: "username/AA5A-315D-61AE"
    if let Some(idx) = trimmed.find('/') {
        let owner = trimmed[..idx].to_string();
        let code_raw = normalize_code_input(&trimmed[idx + 1..]);
        if owner.is_empty() || code_raw.is_empty() {
            return Err(AppError::Other(
                "Invalid share code format. Expected: username/XXXX-XXXX-XXXX".to_string(),
            ));
        }
        return Ok((owner, code_raw));
    }

    Err(AppError::Other(
        "Invalid share code format. Expected: username/XXXX-XXXX-XXXX (the curator shares this code with you)".to_string(),
    ))
}
