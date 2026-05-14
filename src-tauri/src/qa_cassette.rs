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
//! GitHub-bucket paths always get `.json` appended unless they end in a
//! known binary-payload extension (`.zip`, `.tar.gz`, `.tgz`, `.tar`,
//! `.gz` — release-asset downloads). PathBuf::extension() treats version
//! tags like `v1.0.0` as having an extension of `"0"`, so we can't rely
//! on it; we use an explicit allow-list of binary suffixes instead.
//! Nexus-bucket paths already end in `.json` by convention and are used
//! as-is.

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
        _ => return None,
    };
    let path = parsed.path().trim_start_matches('/');
    let mut full = dir.join(bucket).join(path);

    // Decide whether to append `.json` on disk.
    //
    // We can't use PathBuf::extension() here: a tag-path like
    // `/releases/tags/v1.0.0` makes PathBuf report extension "0", which
    // would cause us to silently miss `<tag>.json` fixtures. Instead we
    // use an explicit allow-list of binary-payload suffixes — release
    // asset downloads (`.zip`, `.tar.gz`, etc.) pass through as-is, and
    // the existing `.json` Nexus paths are already covered by the
    // `.json` suffix check. Everything else in the GitHub bucket is a
    // JSON API response, so we always append `.json`.
    let lower = path.to_ascii_lowercase();
    let already_json = lower.ends_with(".json");
    let is_binary = looks_like_binary_payload(&lower);
    if !already_json && !is_binary {
        let mut s = full.into_os_string();
        s.push(".json");
        full = PathBuf::from(s);
    }
    Some(full)
}

/// True if the URL path ends in a suffix that signals a binary payload
/// (release-asset downloads). Lower-case comparison so URL casing
/// doesn't matter. Kept as an explicit allow-list so unrecognised
/// suffixes (including version-tag "extensions" like `v1.0.0`) fall
/// through to the JSON branch — see the note in `url_to_path`.
fn looks_like_binary_payload(lower_path: &str) -> bool {
    lower_path.ends_with(".zip")
        || lower_path.ends_with(".tar.gz")
        || lower_path.ends_with(".tgz")
        || lower_path.ends_with(".tar")
        || lower_path.ends_with(".gz")
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
    fn maps_github_release_by_tag_appends_json_despite_version_dotted_segments() {
        // Regression: PathBuf::extension() reports "0" for `v1.0.0`, so
        // an extension-based check would skip the `.json` suffix and
        // miss the fixture file at `<tag>.json`. Verify the explicit
        // allow-list still appends `.json` here.
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.github.com/repos/foo/bar/releases/tags/v1.0.0",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github/repos/foo/bar/releases/tags/v1.0.0.json"),
        );
    }

    #[test]
    fn maps_github_release_asset_zip_passes_through_without_json_suffix() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.github.com/repos/foo/bar/releases/download/v1.0.0/Foo-v1.0.0.zip",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github/repos/foo/bar/releases/download/v1.0.0/Foo-v1.0.0.zip"),
        );
    }

    #[test]
    fn maps_github_release_asset_tar_gz_passes_through_without_json_suffix() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.github.com/repos/foo/bar/releases/download/v1.0.0/Foo.tar.gz",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github/repos/foo/bar/releases/download/v1.0.0/Foo.tar.gz"),
        );
    }

    #[test]
    fn binary_suffix_check_is_case_insensitive() {
        // URLs are case-sensitive on the wire, but the allow-list
        // shouldn't trip over upstreams that serve `.ZIP`.
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://api.github.com/repos/foo/bar/releases/download/v1.0.0/Foo.ZIP",
        )
        .unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github/repos/foo/bar/releases/download/v1.0.0/Foo.ZIP"),
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
