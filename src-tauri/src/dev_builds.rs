//! Sub-project E (build switcher). Lists the repo's per-PR dev builds
//! (`dev-pr<N>` prereleases produced by sub-project D) and installs a chosen
//! one into the "(Dev)" slot. Discovery reuses `download::fetch_releases`;
//! the GitHub fetch + CSP constraints are why this lives in Rust, not the
//! frontend. See docs/superpowers/specs/2026-05-28-build-switcher-design.md.

use serde::Serialize;
use tauri::State;

use crate::download::{fetch_releases, GitHubRelease};
use crate::state::AppState;

const REPO_OWNER: &str = "MohamedSerhan";
const REPO_NAME: &str = "sts2-mod-manager";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DevBuildAsset {
    pub name: String,
    pub url: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DevBuild {
    pub pr: u32,
    pub sha: String,
    pub title: String,
    pub published_at: String,
    pub windows_installer_url: Option<String>,
    pub assets: Vec<DevBuildAsset>,
}

/// `"dev-pr59"` -> `Some(59)`; other tags -> `None`.
fn parse_pr_from_tag(tag: &str) -> Option<u32> {
    tag.strip_prefix("dev-pr")?.parse::<u32>().ok()
}

/// Pull the short sha from a release title like
/// `"Dev build — PR #59 (g837f5ba)"` -> `Some("837f5ba")`.
fn parse_sha_from_title(title: &str) -> Option<String> {
    let start = title.find("(g")? + 2;
    let rest = &title[start..];
    let end = rest.find(')')?;
    let sha = &rest[..end];
    if !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(sha.to_string())
    } else {
        None
    }
}

/// Human platform label for an asset filename.
fn platform_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.ends_with("_portable.zip") {
        "Windows (portable)"
    } else if n.ends_with("-setup.exe") || n.ends_with(".msi") {
        "Windows (installer)"
    } else if n.ends_with(".dmg") {
        "macOS"
    } else if n.ends_with(".deb") {
        "Linux (.deb)"
    } else if n.ends_with(".rpm") {
        "Linux (.rpm)"
    } else if n.ends_with(".appimage") {
        "Linux (AppImage)"
    } else {
        "Other"
    }
}

/// Pure: filter the repo's releases to `dev-pr<N>` prereleases, newest first.
fn parse_dev_builds(releases: Vec<GitHubRelease>) -> Vec<DevBuild> {
    let mut builds: Vec<DevBuild> = releases
        .into_iter()
        .filter(|r| r.prerelease)
        .filter_map(|r| {
            let pr = parse_pr_from_tag(&r.tag_name)?;
            let title = r.name.clone().unwrap_or_else(|| r.tag_name.clone());
            let sha = parse_sha_from_title(&title).unwrap_or_default();
            // Dev builds ship the NSIS `-setup.exe` on Windows (sub-project D
            // drops the MSI target for dev builds), so the in-place swap targets
            // `-setup.exe`. A `.msi`, if ever present, is shown as a download
            // link via `platform_of` but is not auto-installed.
            let windows_installer_url = r
                .assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                .map(|a| a.browser_download_url.clone());
            let assets = r
                .assets
                .iter()
                .map(|a| DevBuildAsset {
                    name: a.name.clone(),
                    url: a.browser_download_url.clone(),
                    platform: platform_of(&a.name).to_string(),
                })
                .collect();
            Some(DevBuild {
                pr,
                sha,
                title,
                published_at: r.published_at.clone().unwrap_or_default(),
                windows_installer_url,
                assets,
            })
        })
        .collect();
    builds.sort_by(|a, b| b.pr.cmp(&a.pr));
    builds
}

/// List the open PRs' dev builds (newest first). Reuses the stored GitHub
/// token for a higher rate limit; works unauthenticated on this public repo.
#[tauri::command]
pub async fn list_dev_builds(state: State<'_, AppState>) -> Result<Vec<DevBuild>, String> {
    let token = {
        let inner = state.lock().map_err(|e| e.to_string())?;
        inner.github_token.clone()
    };
    let releases = fetch_releases(REPO_OWNER, REPO_NAME, 1, 100, token.as_deref())
        .await
        .map_err(|e| {
            log::warn!("list_dev_builds: failed to fetch releases: {e}");
            format!("Failed to list dev builds: {e}")
        })?;
    Ok(parse_dev_builds(releases))
}

/// Download a dev build's Windows NSIS installer and run it. Because every
/// dev build shares the `com.sts2mm.app.dev` identity, the installer replaces
/// the running "(Dev)" app in place and relaunches into the chosen build.
/// The exact silent/relaunch flags are confirmed by the manual gate; this
/// launches the installer, which Tauri's NSIS handles for a running
/// same-identity app.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn install_dev_build(installer_url: String) -> Result<(), String> {
    use std::process::Command;
    let dest = std::env::temp_dir().join("sts2mm-dev-setup.exe");
    crate::download::download_file(&installer_url, &dest, |_, _| {})
        .await
        .map_err(|e| {
            log::warn!("install_dev_build: download failed: {e}");
            format!("Download failed: {e}")
        })?;
    Command::new(&dest)
        .spawn()
        .map_err(|e| {
            log::warn!("install_dev_build: failed to launch installer: {e}");
            format!("Failed to launch installer: {e}")
        })?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn install_dev_build(_installer_url: String) -> Result<(), String> {
    Err("In-app install is Windows-only — use the download link instead.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::{GitHubAsset, GitHubRelease};

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("https://example/{name}"),
            content_type: "application/octet-stream".to_string(),
            download_count: 0,
        }
    }

    fn release(tag: &str, name: &str, prerelease: bool, assets: Vec<GitHubAsset>) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            name: Some(name.to_string()),
            body: None,
            prerelease,
            published_at: Some("2026-05-28T00:00:00Z".to_string()),
            assets,
            html_url: "https://example/release".to_string(),
        }
    }

    #[test]
    fn parses_pr_from_tag() {
        assert_eq!(parse_pr_from_tag("dev-pr59"), Some(59));
        assert_eq!(parse_pr_from_tag("v1.6.1"), None);
        assert_eq!(parse_pr_from_tag("dev-prX"), None);
    }

    #[test]
    fn parses_sha_from_title() {
        assert_eq!(
            parse_sha_from_title("Dev build — PR #59 (g837f5ba)").as_deref(),
            Some("837f5ba")
        );
        assert_eq!(parse_sha_from_title("no sha here"), None);
    }

    #[test]
    fn filters_sorts_and_shapes() {
        let releases = vec![
            release("v1.6.1", "1.6.1", false, vec![asset("STS2_1.6.1_x64-setup.exe")]),
            // dev-pr tag but NOT a prerelease — must be excluded by the prerelease filter.
            release("dev-pr42", "dev-pr42", false, vec![]),
            release(
                "dev-pr59",
                "Dev build — PR #59 (g837f5ba)",
                true,
                vec![
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_x64-setup.exe"),
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_universal.dmg"),
                ],
            ),
            release(
                "dev-pr60",
                "Dev build — PR #60 (gabc1234)",
                true,
                vec![asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr60.gabc1234_universal.dmg")],
            ),
        ];
        let builds = parse_dev_builds(releases);
        assert_eq!(builds.len(), 2, "stable release + non-prerelease dev-pr tag both excluded");
        assert_eq!(builds[0].pr, 60, "newest PR first");
        assert_eq!(builds[1].pr, 59);
        assert_eq!(builds[1].sha, "837f5ba");
        assert!(builds[1].windows_installer_url.is_some());
        assert!(builds[0].windows_installer_url.is_none(), "PR60 has no win setup");
        let dmg = builds[1].assets.iter().find(|a| a.name.ends_with(".dmg")).unwrap();
        assert_eq!(dmg.platform, "macOS");
    }
}
