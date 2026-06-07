//! Pure helpers for share-code parsing/validation and asset-name
//! generation. No I/O, no async, no `reqwest` — every function here is
//! a deterministic value-in / value-out transform safe to call from
//! sync code anywhere in the module.
//!
//! Split out of the historic `sharing.rs` mega-file so the testable
//! "shape rules" (what a valid GitHub username looks like, how an
//! asset filename is built) live separately from the orchestration
//! that calls them. The two dedicated test modules at the bottom of
//! the file move with the functions they cover.
//!
//! All items are `pub(super)` (or `pub(crate)` where reachable from
//! outside the `sharing` module) so the rest of the codebase keeps
//! its previous import surface via `crate::sharing::*`.
//!
//! See `sharing/mod.rs` for re-exports.

use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};
use crate::profiles::Profile;

// ── Profile Code Encoding ──────────────────────────────────────────────────

/// Generate a deterministic short code from profile content.
/// Uses SHA-256 hash of the profile name + timestamp to get a unique code.
pub(super) fn generate_code(profile: &Profile) -> String {
    let mut hasher = Sha256::new();
    hasher.update(profile.name.as_bytes());
    hasher.update(chrono::Utc::now().timestamp().to_le_bytes());
    let hash = hasher.finalize();
    let hex: String = hash.iter().take(6).map(|b| format!("{:02X}", b)).collect();
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
pub(super) fn code_to_filename(code: &str) -> String {
    format!("{}.json", code.replace('-', "").to_lowercase())
}

/// Normalize user input: accept code, filename, or full URL
pub(super) fn normalize_code_input(input: &str) -> String {
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
pub(super) fn format_code(raw: &str) -> String {
    let upper: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .take(12)
        .collect();
    if upper.len() >= 12 {
        format!("{}-{}-{}", &upper[0..4], &upper[4..8], &upper[8..12])
    } else {
        upper
    }
}

// ── Share-Code Parsing & Validation ────────────────────────────────────────

/// Validate a string against GitHub's username rules so it's safe to
/// interpolate into an API URL without further encoding.
///
/// Rules (loosely mirroring GitHub's signup form):
///   - 1-39 chars
///   - ASCII alphanumeric or single hyphens only
///   - cannot start or end with a hyphen, cannot contain consecutive hyphens
///
/// Why this exists: we use `owner` directly in `format!("/repos/{}/...")`,
/// and a maliciously-crafted owner with `/`, `?`, `#`, etc. would smuggle
/// path segments or query strings into the URL. The check stops anything
/// other than the GitHub-shape value from ever being concatenated.
pub(super) fn is_valid_github_username(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 {
        return false;
    }
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        let is_alnum = b.is_ascii_alphanumeric();
        let is_hyphen = b == b'-';
        if !is_alnum && !is_hyphen {
            return false;
        }
        if is_hyphen && prev_hyphen {
            return false;
        }
        prev_hyphen = is_hyphen;
    }
    true
}

/// Parse a share code like "username/AA5A-315D-61AE" into (owner, code).
///
/// `owner` is validated against GitHub's username rules before return so
/// it's safe to interpolate into API URLs. `code_raw` is normalized to
/// lowercase hex by `normalize_code_input` so it can't carry path-special
/// characters either.
pub(super) fn parse_share_code(input: &str) -> Result<(String, String)> {
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
        if !is_valid_github_username(&owner) {
            return Err(AppError::Other(format!(
                "Invalid GitHub username '{}' in share code. Usernames are 1-39 chars, alphanumeric and single hyphens only.",
                owner
            )));
        }
        return Ok((owner, code_raw));
    }

    Err(AppError::Other(
        "Invalid share code format. Expected: username/XXXX-XXXX-XXXX (the curator shares this code with you)".to_string(),
    ))
}

// ── Release-Asset Filename Helpers ─────────────────────────────────────────

/// Build a release-asset filename with a `_<sha8>.zip` suffix so two
/// uploads of the same `(mod_name, version)` pair with different
/// content produce distinct GitHub asset names. The 8-char SHA prefix
/// is short enough to keep names human-scannable but long enough
/// (2^32 space) that collisions are vanishingly unlikely in practice.
///
/// Caller passes the full hex digest; we slice the prefix here so the
/// asset name stays short enough to be readable.
pub(super) fn release_asset_name(mod_name: &str, version: &str, sha256_hex: &str) -> String {
    let safe_name = sanitize_asset_component(mod_name, false);
    let safe_ver = sanitize_asset_component(version.trim_start_matches('v'), true);
    let sha8 = sha256_hex.get(..8).unwrap_or(sha256_hex);
    format!("{}_v{}_{}.zip", safe_name, safe_ver, sha8)
}

/// Replace path-unsafe characters in a filename component. Anything
/// that is a control char, whitespace, or a Windows/POSIX reserved
/// separator becomes `_`. Unicode letters pass through unchanged
/// (issue #44 — Chinese ideographs used to collapse to `___`).
///
/// `allow_dot=true` is used for version strings (`v1.2.3`) where the
/// dots are meaningful; for mod names we replace them too so the
/// filename has at most one dot (the `.zip`).
pub(super) fn sanitize_asset_component(input: &str, allow_dot: bool) -> String {
    input
        .chars()
        .map(|c| {
            // Replace control chars, whitespace, and characters that are
            // unsafe in filenames or URL paths. Anything else — including
            // Unicode letters and digits — passes through unchanged.
            let unsafe_char = c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '%' | '&' | '+'
                );
            if unsafe_char {
                '_'
            } else if !allow_dot && c == '.' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// Best-effort percent-decode so equality checks survive whatever encoding
/// GitHub chooses to put in the asset-list response. Falls back to the
/// raw input on a decode error rather than panicking.
pub(super) fn decode_asset_name(name: &str) -> String {
    urlencoding::decode(name)
        .map(|cow| cow.into_owned())
        .unwrap_or_else(|_| name.to_string())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod parse_share_code_tests {
    use super::is_valid_github_username;

    #[test]
    fn accepts_normal_usernames() {
        assert!(is_valid_github_username("MohamedSerhan"));
        assert!(is_valid_github_username("octocat"));
        assert!(is_valid_github_username("a-b-c"));
        assert!(is_valid_github_username("123"));
    }

    #[test]
    fn rejects_traversal_and_separators() {
        assert!(!is_valid_github_username(".."));
        assert!(!is_valid_github_username("a/b"));
        assert!(!is_valid_github_username("a..b"));
        assert!(!is_valid_github_username("foo?bar"));
        assert!(!is_valid_github_username("foo#bar"));
        assert!(!is_valid_github_username("foo@bar"));
        assert!(!is_valid_github_username(""));
    }

    #[test]
    fn rejects_invalid_hyphens() {
        assert!(!is_valid_github_username("-foo"));
        assert!(!is_valid_github_username("foo-"));
        assert!(!is_valid_github_username("foo--bar"));
    }

    #[test]
    fn rejects_too_long() {
        assert!(!is_valid_github_username(&"a".repeat(40)));
    }
}

#[cfg(test)]
mod release_asset_name_tests {
    use super::{decode_asset_name, release_asset_name, sanitize_asset_component};

    /// SHA-256 of an empty byte slice — used as a stable test fixture.
    const SHA_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn preserves_unicode_in_mod_names() {
        // Issue #44: Chinese ideographs used to collapse to `___`.
        assert_eq!(
            release_asset_name("皮皮统计", "1.0.0", SHA_EMPTY),
            "皮皮统计_v1.0.0_e3b0c442.zip",
        );
    }

    #[test]
    fn replaces_only_path_unsafe_chars() {
        assert_eq!(
            sanitize_asset_component("Skada/Recount: helper*", false),
            "Skada_Recount__helper_",
        );
    }

    #[test]
    fn keeps_ascii_alphanumerics_and_separators() {
        assert_eq!(
            release_asset_name("My-Mod_42", "v2.3.4", SHA_EMPTY),
            "My-Mod_42_v2.3.4_e3b0c442.zip",
        );
    }

    #[test]
    fn includes_short_sha_so_content_changes_produce_distinct_names() {
        // Same name + version with different content hashes must produce
        // distinct asset filenames — that's the property that eliminates
        // the GitHub already_exists / orphan-name failure mode.
        let a = release_asset_name("ModX", "1.0.0", "aaaaaaaa00000000");
        let b = release_asset_name("ModX", "1.0.0", "bbbbbbbb00000000");
        assert_ne!(a, b);
        assert_eq!(a, "ModX_v1.0.0_aaaaaaaa.zip");
        assert_eq!(b, "ModX_v1.0.0_bbbbbbbb.zip");
    }

    #[test]
    fn short_sha_does_not_panic_on_truncated_input() {
        // Defensive — sha8 prefix slice was the obvious panic site if a
        // caller ever passes a hex string under 8 chars.
        assert!(release_asset_name("ModX", "1.0.0", "abc").ends_with("_abc.zip"));
    }

    #[test]
    fn decode_asset_name_handles_raw_and_encoded() {
        assert_eq!(decode_asset_name("皮皮.zip"), "皮皮.zip");
        assert_eq!(decode_asset_name("%E7%9A%AE%E7%9A%AE.zip"), "皮皮.zip");
    }

    #[test]
    fn decode_asset_name_falls_back_on_bad_encoding() {
        // Lone % is not valid percent-encoding; should not panic.
        assert_eq!(decode_asset_name("abc%zz.zip"), "abc%zz.zip");
    }
}
