use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;

use crate::error::{AppError, Result};
use crate::profiles::Profile;
use crate::state::AppState;

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
async fn upload_mod_bundle(
    token: &str,
    username: &str,
    mod_name: &str,
    zip_data: &[u8],
) -> Result<String> {
    let client = build_client(token);
    let safe_name = mod_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let filename = format!("mods/{}.zip", safe_name);
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        username, PROFILES_REPO, filename
    );

    // Check if file already exists (get SHA for update)
    let existing_sha = {
        let resp = client.get(&url).send().await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                let info: ContentsResponse = resp.json().await.unwrap_or(ContentsResponse {
                    sha: None, content: None, html_url: None,
                });
                info.sha
            } else { None }
        } else { None }
    };

    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, zip_data);
    let mut body = serde_json::json!({
        "message": format!("Bundle mod: {}", mod_name),
        "content": encoded,
    });
    if let Some(sha) = &existing_sha {
        body["sha"] = serde_json::json!(sha);
    }

    let resp = client.put(&url).json(&body).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to upload mod bundle '{}' ({}): {}",
            mod_name, status, text
        )));
    }

    // Return the raw download URL
    let download_url = format!(
        "https://raw.githubusercontent.com/{}/{}/main/{}",
        username, PROFILES_REPO, filename
    );
    Ok(download_url)
}
/// Download a bundled mod zip from a URL and extract into mods_path.
pub async fn download_bundle(url: &str, mod_name: &str, mods_path: &std::path::Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();

    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Failed to download bundle for '{}': {}",
            mod_name,
            resp.status()
        )));
    }

    let bytes = resp.bytes().await?;
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
pub async fn fetch_shared_profile(owner: &str, filename: &str) -> Result<Profile> {
    // Use raw.githubusercontent.com for public access without auth
    let url = format!(
        "https://raw.githubusercontent.com/{}/{}/main/{}",
        owner, PROFILES_REPO, filename
    );

    let client = reqwest::Client::builder()
        .user_agent("sts2-mod-manager/0.1")
        .build()
        .unwrap_or_default();

    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(AppError::Other(format!(
            "Profile not found ({}). Check the code and try again.",
            status
        )));
    }

    let text = resp.text().await?;
    let profile: Profile = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("Invalid profile data: {}", e)))?;

    Ok(profile)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Share a profile by uploading to a GitHub repo. Returns a short profile code.
/// For mods without a GitHub source, bundles the actual mod files as zips.
#[tauri::command]
pub async fn share_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let (profiles_path, mods_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required to share profiles. Set it in Settings."
        )?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        (s.profiles_path.clone(), mods_path, s.config_path.clone(), token)
    };

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

    // For each mod, validate GitHub source has a downloadable release.
    // If not, bundle the mod files directly.
    for pm in &mut profile.mods {
        if pm.files.is_empty() {
            continue;
        }

        let mut needs_bundle = true;

        // Check if GitHub source has a valid downloadable .zip release
        if let Some(ref source) = pm.source {
            if let Some(repo_path) = source.strip_prefix("github:") {
                let parts: Vec<&str> = repo_path.splitn(2, '/').collect();
                if parts.len() == 2 {
                    log::info!("Validating GitHub source for '{}': {}", pm.name, repo_path);
                    match crate::download::fetch_latest_release(parts[0], parts[1], Some(&token)).await {
                        Ok(release) => {
                            let has_zip = release.assets.iter().any(|a| a.name.ends_with(".zip"));
                            let has_dll = release.assets.iter().any(|a| a.name.ends_with(".dll"));
                            if has_zip || has_dll {
                                // Extra check: if mod had .pck files locally, verify GitHub
                                // release can provide them. Many STS2 mods need .pck resources.
                                let local_has_pck = pm.files.iter().any(|f| f.ends_with(".pck"));
                                if local_has_pck && has_zip {
                                    // Download and check if zip contains .pck
                                    // For now, trust GitHub if it has a zip -- but always bundle
                                    // as fallback too so friends have the complete mod
                                    log::info!("Mod '{}' has .pck files -- bundling as backup alongside GitHub source", pm.name);
                                    // Keep GitHub source AND also bundle
                                    match zip_mod_files(&pm.name, &pm.files, &mods_path) {
                                        Ok(zip_data) => {
                                            if let Ok(url) = upload_mod_bundle(&token, &username, &pm.name, &zip_data).await {
                                                pm.bundle_url = Some(url);
                                            }
                                        }
                                        Err(_) => {}
                                    }
                                    needs_bundle = false;
                                } else {
                                    log::info!("GitHub source valid for '{}': {} ({} assets)", pm.name, release.tag_name, release.assets.len());
                                    needs_bundle = false;
                                }
                            } else {
                                log::warn!("GitHub release for '{}' has no .zip/.dll assets ({}): {:?}",
                                    pm.name, release.tag_name,
                                    release.assets.iter().map(|a| &a.name).collect::<Vec<_>>());
                            }
                        }
                        Err(e) => {
                            log::warn!("GitHub source invalid for '{}' ({}): {}", pm.name, repo_path, e);
                        }
                    }
                }
            }
        }

        if needs_bundle {
            log::info!("Bundling mod '{}' ({} files)", pm.name, pm.files.len());
            // Clear invalid GitHub source so friends don't waste time trying it
            if pm.source.as_ref().map_or(false, |s| s.starts_with("github:")) {
                log::info!("Clearing invalid GitHub source for '{}'", pm.name);
                pm.source = None;
            }
            match zip_mod_files(&pm.name, &pm.files, &mods_path) {
                Ok(zip_data) => {
                    match upload_mod_bundle(&token, &username, &pm.name, &zip_data).await {
                        Ok(url) => {
                            pm.bundle_url = Some(url);
                            log::info!("Bundled mod '{}' successfully", pm.name);
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

/// Re-share (update) an already-shared profile. Same code, updated content.
/// Re-bundles mods without GitHub sources.
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    let (profiles_path, mods_path, config_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or(
            "GitHub token required. Set it in Settings."
        )?;
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        (s.profiles_path.clone(), mods_path, s.config_path.clone(), token)
    };

    let mut profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    // Load existing share info
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet. Use 'Share' first.".to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Validate GitHub sources and bundle mods that can't be downloaded
    for pm in &mut profile.mods {
        if pm.files.is_empty() {
            continue;
        }

        let mut needs_bundle = true;

        if let Some(ref source) = pm.source {
            if let Some(repo_path) = source.strip_prefix("github:") {
                let parts: Vec<&str> = repo_path.splitn(2, '/').collect();
                if parts.len() == 2 {
                    match crate::download::fetch_latest_release(parts[0], parts[1], Some(&token)).await {
                        Ok(release) => {
                            let has_zip = release.assets.iter().any(|a| a.name.ends_with(".zip"));
                            let has_dll = release.assets.iter().any(|a| a.name.ends_with(".dll"));
                            if has_zip || has_dll {
                                needs_bundle = false;
                            }
                        }
                        Err(_) => {}
                    }
                }
            }
        }

        if needs_bundle {
            if pm.source.as_ref().map_or(false, |s| s.starts_with("github:")) {
                pm.source = None;
            }
            match zip_mod_files(&pm.name, &pm.files, &mods_path) {
                Ok(zip_data) => {
                    match upload_mod_bundle(&token, &share_info.owner, &pm.name, &zip_data).await {
                        Ok(url) => {
                            pm.bundle_url = Some(url);
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

    // ── STEP 1: Download missing mods BEFORE applying the profile ──
    let local_mods = crate::mods::scan_mods(&mods_path);
    let local_disabled = crate::mods::scan_disabled_mods(&disabled_path);
    // Build lookup sets by name, folder_name, and mod_id for robust matching
    let mut local_identifiers: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in local_mods.iter().chain(local_disabled.iter()) {
        local_identifiers.insert(m.name.clone());
        if let Some(ref folder) = m.folder_name {
            local_identifiers.insert(folder.clone());
        }
        if let Some(ref id) = m.mod_id {
            local_identifiers.insert(id.clone());
        }
    }

    let mod_sources_db = crate::mod_sources::load_sources(&config_path);
    let mut download_failures: Vec<String> = Vec::new();

    for pm in &profile.mods {
        // Check if mod exists by name, folder_name, or mod_id
        let already_exists = local_identifiers.contains(&pm.name)
            || pm.folder_name.as_ref().map_or(false, |f| local_identifiers.contains(f))
            || pm.mod_id.as_ref().map_or(false, |id| local_identifiers.contains(id));
        if already_exists {
            log::info!("Mod '{}' already on disk (matched by name/folder/id)", pm.name);
            continue;
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
