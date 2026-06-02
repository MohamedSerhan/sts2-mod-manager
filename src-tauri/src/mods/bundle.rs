//! A "bundle" is a multi-mod download laid out as one container folder under
//! `mods/`, with member mods in subfolders. The container carries a hidden
//! `.sts2mm-bundle.json` sidecar holding what the folder structure can't:
//! the author's display name, the shared upstream link, and the version.
//! Membership is the filesystem (the member subfolders) — never a registry.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::install::strip_nexus_suffix;
use super::state::sanitize_path_segment;

pub const SIDECAR_FILENAME: &str = ".sts2mm-bundle.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BundleSidecar {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_game_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_mod_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

fn sidecar_path(container: &Path) -> PathBuf {
    container.join(SIDECAR_FILENAME)
}

/// Returns `true` iff `dir` contains a `.sts2mm-bundle.json` sidecar file,
/// identifying it as a bundle container folder.
pub fn is_bundle_container(dir: &Path) -> bool {
    sidecar_path(dir).is_file()
}

/// Read the bundle sidecar from `container`. Returns `None` when the file is
/// absent (the directory is not a bundle) or the JSON is malformed.
pub fn read_sidecar(container: &Path) -> Option<BundleSidecar> {
    let body = fs::read_to_string(sidecar_path(container)).ok()?;
    serde_json::from_str(super::scan::strip_utf8_bom(&body)).ok()
}

/// Write the bundle sidecar into `container`.
pub fn write_sidecar(container: &Path, sidecar: &BundleSidecar) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(sidecar)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // Atomic write so a crash mid-write can't truncate the sidecar (which would
    // drop the bundle's display name / Nexus link / version). (Audit H-3 class.)
    crate::fs_safety::atomic_write(&sidecar_path(container), json.as_bytes())
}

/// Derive a sanitized container folder name from a downloaded archive path.
///
/// Strips a trailing ` (N)` browser-duplicate suffix (e.g. ` (1)`, ` (2)`)
/// if present, then strips the Nexus-style version/upload-id suffix
/// (e.g. `-979-2-1-1780132414`), then runs the result through
/// `sanitize_path_segment` so the name is safe to use as a filesystem folder.
pub fn bundle_container_name(archive_path: &Path) -> String {
    let stem = archive_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Strip trailing browser-duplicate suffix " (N)" before Nexus suffix
    // stripping so the numeric upload-id group is at the end of the string
    // where `strip_nexus_suffix` can reach it.
    let stem = strip_browser_copy_suffix(&stem);
    sanitize_path_segment(&strip_nexus_suffix(&stem))
}

/// Extract the Nexus FILE version embedded in a download filename's suffix.
///
/// Nexus download names look like `{name}-{modId}-{version}-{fileId}.zip`, with
/// the version's dots written as dashes — e.g.
/// `AliceDefectSkin V2.0-979-2-1-1780132414.zip` → `Some("2.1")`
/// (mod 979, version `2-1`, file id `1780132414`).
///
/// This is the most reliable version source for a bundle: it is exactly the file
/// the user downloaded and, unlike the Nexus API, needs no key or network. The
/// pack version is NOT inside the archive — member manifests only carry per-mod
/// versions, which is why a pack used to display a sub-mod's number.
///
/// Returns `None` for manually-renamed downloads with no Nexus suffix, or a
/// suffix with no version segment between the mod id and the file id.
pub fn nexus_file_version(archive_path: &Path) -> Option<String> {
    let stem = archive_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let stem = strip_browser_copy_suffix(&stem); // drop a trailing " (N)"
    let name = strip_nexus_suffix(&stem);
    if name.len() >= stem.len() {
        return None; // nothing stripped → no Nexus suffix present
    }
    // The stripped tail is the numeric suffix "-{modId}-{v..}-{fileId}".
    let segs: Vec<&str> = stem[name.len()..]
        .split('-')
        .filter(|s| !s.is_empty())
        .collect();
    // Need a mod id + at least one version segment + a file id.
    if segs.len() < 3 || !segs.iter().all(|s| s.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let version = segs[1..segs.len() - 1].join(".");
    (!version.is_empty()).then_some(version)
}

/// After a bundle auto-installs, copy the resolved upstream link + version into
/// the container's sidecar. Returns `false` (no-op) when the archive didn't
/// produce a bundle container. Only overwrites fields for which a value is
/// provided — fields with `None` are left unchanged from whatever was already
/// in the sidecar (or the struct default if the sidecar is brand-new).
pub fn enrich_bundle_sidecar(
    mods_path: &std::path::Path,
    archive_path: &std::path::Path,
    display_name: Option<&str>,
    nexus_url: Option<String>,
    nexus_game_domain: Option<String>,
    nexus_mod_id: Option<u64>,
    version: Option<String>,
) -> bool {
    let container = mods_path.join(bundle_container_name(archive_path));
    if !is_bundle_container(&container) {
        return false;
    }
    let mut s = read_sidecar(&container).unwrap_or_default();
    if let Some(n) = display_name {
        if !n.is_empty() {
            s.display_name = n.to_string();
        }
    }
    if nexus_url.is_some() {
        s.nexus_url = nexus_url;
    }
    if nexus_game_domain.is_some() {
        s.nexus_game_domain = nexus_game_domain;
    }
    if nexus_mod_id.is_some() {
        s.nexus_mod_id = nexus_mod_id;
    }
    if version.is_some() {
        s.installed_version = version;
    }
    write_sidecar(&container, &s).is_ok()
}

/// Strip a trailing " (N)" or "_(N)" browser-duplicate suffix from `s`,
/// returning the stem without it. Only strips when the parenthesised group
/// contains purely decimal digits and is at the very end of the string.
fn strip_browser_copy_suffix(s: &str) -> String {
    // Matches e.g. " (1)", " (12)", "_(3)" at the end of the string.
    let bytes = s.as_bytes();
    let len = bytes.len();
    if len < 4 {
        return s.to_string();
    }
    // Must end with ')'
    if bytes[len - 1] != b')' {
        return s.to_string();
    }
    // Walk back over digits
    let mut pos = len - 2;
    let digit_end = pos;
    while pos > 0 && bytes[pos].is_ascii_digit() {
        pos -= 1;
    }
    if pos == digit_end {
        // No digits found
        return s.to_string();
    }
    // Must be preceded by '('
    if bytes[pos] != b'(' {
        return s.to_string();
    }
    // Must be preceded by a separator: ' ' or '_'
    if pos == 0 || (bytes[pos - 1] != b' ' && bytes[pos - 1] != b'_') {
        return s.to_string();
    }
    s[..pos - 1].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sidecar_round_trips() {
        let dir = tempdir().unwrap();
        let s = BundleSidecar {
            display_name: "Alice Defect Visual Pack".into(),
            nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/979".into()),
            nexus_game_domain: Some("slaythespire2".into()),
            nexus_mod_id: Some(979),
            github_repo: None,
            installed_version: Some("2.0".into()),
        };
        write_sidecar(dir.path(), &s).unwrap();
        assert!(is_bundle_container(dir.path()));
        let back = read_sidecar(dir.path()).expect("sidecar reads back");
        assert_eq!(back.display_name, "Alice Defect Visual Pack");
        assert_eq!(back.nexus_mod_id, Some(979));
        assert_eq!(back.installed_version.as_deref(), Some("2.0"));
    }

    #[test]
    fn no_sidecar_is_not_a_bundle() {
        let dir = tempdir().unwrap();
        assert!(!is_bundle_container(dir.path()));
        assert!(read_sidecar(dir.path()).is_none());
    }

    #[test]
    fn container_name_strips_nexus_suffix_and_sanitizes() {
        let name = bundle_container_name(std::path::Path::new(
            "AliceDefectSkin V2.0-979-2-1-1780132414 (1).zip",
        ));
        assert!(
            !name.contains("1780132414"),
            "nexus id suffix stripped, got {name}"
        );
        assert!(!name.is_empty());
    }

    #[test]
    fn nexus_file_version_extracts_version_from_filename() {
        assert_eq!(
            nexus_file_version(std::path::Path::new(
                "AliceDefectSkin V2.0-979-2-1-1780132414.zip"
            )),
            Some("2.1".to_string())
        );
    }

    #[test]
    fn nexus_file_version_handles_browser_copy_and_multi_segment_version() {
        assert_eq!(
            nexus_file_version(std::path::Path::new(
                "RelicsReminder-284-1-1-0-1775500710 (2).zip"
            )),
            Some("1.1.0".to_string())
        );
    }

    #[test]
    fn nexus_file_version_none_without_nexus_suffix() {
        assert_eq!(nexus_file_version(std::path::Path::new("MyMod.zip")), None);
        // A single trailing number is a file id, not a version.
        assert_eq!(
            nexus_file_version(std::path::Path::new("MyMod-1775500710.zip")),
            None
        );
    }
}
