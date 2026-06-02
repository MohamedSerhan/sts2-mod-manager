//! Sub-project E (build switcher). Lists the repo's per-PR dev builds
//! (`dev-pr<N>` prereleases produced by sub-project D) and switches to a
//! chosen one in the "(Dev)" slot. Discovery reuses `download::fetch_releases`;
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
    /// URL of the `latest.json` updater manifest attached to this build's
    /// release, if present. Drives the one-click updater-based switch.
    pub manifest_url: Option<String>,
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
            let manifest_url = r
                .assets
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("latest.json"))
                .map(|a| a.browser_download_url.clone());
            let assets = r
                .assets
                .iter()
                .filter(|a| !a.name.eq_ignore_ascii_case("latest.json"))
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
                manifest_url,
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

/// Hosts a dev-build updater manifest is allowed to live on. GitHub serves
/// release assets either from the API/site host (`github.com`) or, after the
/// redirect, from its asset CDN (`objects.githubusercontent.com`); both are
/// legitimate `browser_download_url` hosts. Anything else is rejected.
const ALLOWED_MANIFEST_HOSTS: &[&str] = &["github.com", "objects.githubusercontent.com"];

/// Validate the caller-supplied updater manifest URL before it is ever handed
/// to `updater_builder().endpoints()`.
///
/// The frontend only ever passes a `manifest_url` we ourselves discovered from
/// the GitHub releases API, but the command accepts an arbitrary string over
/// IPC, so we re-check it here: require `https` and a host on the GitHub
/// allowlist. Without this, an attacker who can reach the command could point
/// the updater at an arbitrary endpoint — an SSRF vector and a way to feed a
/// forced-downgrade / attacker-chosen manifest. (Signature verification still
/// gates the actual install, but the endpoint must not be attacker-controlled
/// in the first place.) Returns the parsed URL on success so the caller does
/// not parse twice.
fn validate_manifest_url(manifest_url: &str) -> Result<url::Url, String> {
    let parsed =
        url::Url::parse(manifest_url).map_err(|e| format!("Bad manifest URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "Refusing manifest URL with non-https scheme: {}",
            parsed.scheme()
        ));
    }
    match parsed.host_str() {
        Some(host) if ALLOWED_MANIFEST_HOSTS.contains(&host) => Ok(parsed),
        other => Err(format!(
            "Refusing manifest URL on disallowed host: {}",
            other.unwrap_or("<none>")
        )),
    }
}

/// One-click switch: install a chosen dev build from its `latest.json`
/// updater manifest using tauri-plugin-updater — the same silent
/// download + signature-verify + install + relaunch path the release
/// "Install & Restart" uses. A permissive version_comparator lets the user
/// switch to a LOWER pr (semver ranks pr61 > pr60), which a default
/// updater would refuse. No installer UI (NSIS runs passively on Windows).
/// Unguarded by platform: on non-Windows the updater simply fails at
/// download_and_install (propagated as an Err), so there's no silent misbehavior.
#[tauri::command]
pub async fn switch_dev_build(
    app: tauri::AppHandle,
    manifest_url: String,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let url = validate_manifest_url(&manifest_url)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Updater endpoint error: {e}"))?
        .version_comparator(|_current, _update| true)
        .build()
        .map_err(|e| format!("Updater build error: {e}"))?;
    let maybe_update = updater
        .check()
        .await
        .map_err(|e| {
            log::warn!("switch_dev_build: update check failed: {e}");
            format!("Switch check failed: {e}")
        })?;
    let update = maybe_update.ok_or_else(|| {
        "No installable build found in the dev manifest.".to_string()
    })?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| {
            log::warn!("switch_dev_build: install failed: {e}");
            format!("Switch install failed: {e}")
        })?;
    // Mirror the release "Install & Restart": exit so the (NSIS) installer can
    // finish replacing the running app, then relaunch into the new build.
    app.restart();
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
                    asset("latest.json"),
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
        assert_eq!(
            builds[1].manifest_url.as_deref(),
            Some("https://example/latest.json"),
            "manifest_url surfaced from latest.json asset"
        );
        assert!(builds[0].manifest_url.is_none(), "PR60 has no manifest");
        assert!(
            !builds[1].assets.iter().any(|a| a.name.eq_ignore_ascii_case("latest.json")),
            "latest.json manifest must not appear as a downloadable asset"
        );
        let dmg = builds[1].assets.iter().find(|a| a.name.ends_with(".dmg")).unwrap();
        assert_eq!(dmg.platform, "macOS");
    }
}
