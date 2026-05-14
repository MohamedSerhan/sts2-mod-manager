//! Outbound-HTTP intercept layer for the QA harness.
//!
//! When the binary is built with `--features qa-cassette` AND the
//! `STS2_CASSETTE_DIR` environment variable points at a fixtures
//! directory, GitHub + Nexus HTTP calls are answered from disk instead
//! of hitting the wire. This lets the WebDriver smoke harness drive
//! audit / update / subscription flows deterministically without
//! burning rate limits or coupling test outcomes to upstream state.
//!
//! When the feature is OFF (the default — i.e. every shipped build),
//! `intercept_get` is a no-op that always returns `None`. The compiler
//! collapses the call-site branch to nothing in release builds, so
//! production paths pay no overhead and no fixture files ever ship.
//!
//! ## Layout under `$STS2_CASSETTE_DIR`
//!
//! Cassette files mirror the upstream URL path under a per-host bucket:
//!
//! ```text
//! $STS2_CASSETTE_DIR/
//! ├── github/
//! │   └── repos/<owner>/<repo>/releases/latest.json
//! │   └── repos/<owner>/<repo>/releases.json    (paginated list — query ignored)
//! │   └── repos/<owner>/<repo>/releases/tags/<tag>.json
//! └── nexus/
//!     └── v1/games/<game>/mods/<id>.json
//!     └── v1/games/<game>/mods/<id>/files.json
//! ```
//!
//! Query parameters on the URL are ignored when resolving to disk. The
//! harness only needs one cassette per logical endpoint; we don't
//! generally need to capture page 2.
//!
//! Paths that have no extension on the wire (e.g. `/releases/latest`)
//! get `.json` appended on disk. Paths that already end in `.json` (the
//! Nexus convention) are used as-is.

use std::path::PathBuf;

/// True if cassette playback is currently active for this process.
///
/// Both conditions must hold:
///   1. The binary was built with `--features qa-cassette`.
///   2. The `STS2_CASSETTE_DIR` environment variable is set.
///
/// Surfaced so call sites can log a one-liner at startup ("cassettes
/// rooted at …") and so the integration tests can skip themselves
/// cleanly when invoked against a non-cassette build.
pub fn is_active() -> bool {
    cfg!(feature = "qa-cassette") && std::env::var_os("STS2_CASSETTE_DIR").is_some()
}

/// Look up a cassette for an HTTP GET to `url`. Returns the file bytes
/// on a hit, `None` on a miss (either the cassette is disabled, the URL
/// host isn't routed, or no file exists on disk for it).
///
/// Callers pass the *full* URL string they were about to hand to
/// `reqwest::Client::get(...)`, including any query string they assembled
/// with `.query(...)`. Query params are stripped during path resolution
/// — see the module docs.
pub fn intercept_get(url: &str) -> Option<Vec<u8>> {
    if !cfg!(feature = "qa-cassette") {
        return None;
    }
    let dir = std::env::var_os("STS2_CASSETTE_DIR").map(PathBuf::from)?;
    let path = url_to_path(&dir, url)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            log::info!(
                "[cassette] HIT {} -> {} ({} bytes)",
                url,
                path.display(),
                bytes.len()
            );
            Some(bytes)
        }
        Err(e) => {
            // Miss is a real signal — either we're missing a fixture or the
            // path mapping is off. Logged at warn so a test author chasing
            // a flake can grep for it.
            log::warn!("[cassette] MISS {} -> {} ({})", url, path.display(), e);
            None
        }
    }
}

/// Resolve a URL to its on-disk cassette path. Returns `None` for hosts
/// we don't route (so the call falls through to the network rather than
/// erroring on a missing file we never intended to cassette).
///
/// Pulled out so it can be unit-tested without a real filesystem.
fn url_to_path(dir: &std::path::Path, url: &str) -> Option<PathBuf> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let bucket = match host {
        "api.github.com" => "github",
        "api.nexusmods.com" => "nexus",
        "raw.githubusercontent.com" => "github-raw",
        "github.com" => "github-releases",
        _ => return None,
    };
    let path = parsed.path().trim_start_matches('/');
    let mut full = dir.join(bucket).join(path);

    // Paths with no file extension (`/repos/foo/bar/releases/latest`) get
    // a `.json` suffix on disk. Paths that already end in `.json` (the
    // Nexus convention, e.g. `/v1/games/x/mods/123.json`) are used as-is.
    // Paths that end in `.zip` are passed through too — that's how a
    // release-asset download maps to a fixture zip.
    let has_ext = full.extension().is_some();
    if !has_ext {
        let mut s = full.into_os_string();
        s.push(".json");
        full = PathBuf::from(s);
    }
    Some(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn maps_github_release_latest_to_json_file() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(dir, "https://api.github.com/repos/foo/bar/releases/latest").unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github/repos/foo/bar/releases/latest.json"),
        );
    }

    #[test]
    fn maps_github_releases_list_strips_query() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.github.com/repos/foo/bar/releases?page=1&per_page=30",
        )
        .unwrap();
        assert_eq!(p, Path::new("/fixtures/github/repos/foo/bar/releases.json"));
    }

    #[test]
    fn maps_nexus_mod_info_preserving_existing_json_suffix() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.nexusmods.com/v1/games/slaythespire2/mods/123.json",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/nexus/v1/games/slaythespire2/mods/123.json"),
        );
    }

    #[test]
    fn maps_release_asset_download_to_github_releases_bucket() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github-releases/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip"),
        );
    }

    #[test]
    fn unrouted_host_returns_none_so_call_falls_through_to_network() {
        let dir = Path::new("/fixtures");
        assert!(url_to_path(dir, "https://example.com/foo").is_none());
    }

    #[test]
    fn is_active_is_false_without_env_var() {
        // Sanity — without the env var set, we never report active even
        // when built with the feature. (Can't usefully test the positive
        // case here without mutating the process env, which would race
        // other tests.)
        std::env::remove_var("STS2_CASSETTE_DIR");
        assert!(!is_active());
    }
}
