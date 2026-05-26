//! Pure filesystem-scan + hashing primitives. No `tauri::*`, no
//! `AppState`, no async — just helpers that take paths and produce
//! sizes / hashes / file lists.
//!
//! Split out of the historic `mods.rs` mega-file so the testable
//! "what's on disk" layer (mod-size accounting, file enumeration,
//! BOM-stripping for manifest reads) lives separately from the
//! enable/disable + install orchestration in `mod.rs`. The richer
//! scanners (`scan_mods`, `parse_manifest`, `dedup_key`,
//! `merge_active_disabled_mods`) stay in `mod.rs` for now — they're
//! deeply intertwined with `ModInfo`/`RawManifest` and the embedded
//! test modules use `super::*` so splitting them risks more than the
//! win justifies.
//!
//! See `mods/mod.rs` for the consumers.

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// SHA-256 of the entire file at `path`, hex-encoded. Returns `None`
/// if the file can't be read (missing, permission denied, etc.).
///
/// Used at scan time to give every installed mod a content-derived
/// identity that survives folder renames, and at publish time to
/// pick a release-asset filename suffix that's unique per content.
pub(super) fn hash_file(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Some(format!("{:x}", hasher.finalize()))
}

/// Calculate total size of files in a list relative to a base directory.
///
/// Missing entries silently contribute 0 — this is a display helper,
/// not a publish-readiness check, so an absent file is reported as
/// "size 0" rather than aborting the scan.
pub(super) fn calculate_mod_size(base_dir: &Path, files: &[String]) -> u64 {
    files
        .iter()
        .map(|f| {
            let path = base_dir.join(f);
            path.metadata().map(|m| m.len()).unwrap_or(0)
        })
        .sum()
}

/// Collect all files belonging to a mod entry (the .json and
/// co-located .dll/.pck files for a flat-layout mod, or every file
/// in the mod's subdirectory for a directory-layout mod).
///
/// The returned paths are relative to `base_dir` so they round-trip
/// through serialization without leaking absolute paths into a
/// shareable manifest.
pub(super) fn collect_mod_files(manifest_path: &Path, base_dir: &Path) -> Vec<String> {
    let parent = match manifest_path.parent() {
        Some(p) => p,
        None => return vec![manifest_path.to_string_lossy().to_string()],
    };

    let mut files = Vec::new();

    // If the manifest is inside the base mods dir (not a subdirectory)
    if parent == base_dir {
        let stem = manifest_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Look for same-named .dll, .pck, .json files
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                let fstem = Path::new(&fname)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if fstem == stem && entry.path().is_file() {
                    files.push(fname);
                }
            }
        }
    } else {
        // Manifest is in a subdirectory - collect all files in that subdirectory
        for entry in WalkDir::new(parent).into_iter().flatten() {
            if entry.file_type().is_file() {
                if let Ok(rel) = entry.path().strip_prefix(base_dir) {
                    files.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    if files.is_empty() {
        if let Ok(rel) = manifest_path.strip_prefix(base_dir) {
            files.push(rel.to_string_lossy().to_string());
        } else {
            files.push(
                manifest_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }

    files
}

/// Strip a leading UTF-8 BOM (`EF BB BF` / `U+FEFF`) from a manifest body.
///
/// Windows tooling (Notepad, some authoring editors) writes JSON with a BOM
/// by default. `serde_json::from_str` refuses to parse content that doesn't
/// start with a JSON character — so any BOM-prefixed manifest fails strict
/// parsing AND the lenient Value-based fallback. That's the actual cause of
/// the "vunknown" report on BaseLib (a popular library mod whose author
/// ships a BOM in `BaseLib.json`): both parsers gave up and the install
/// fell through to the stub. Stripping once at read time fixes every
/// manifest read in the codebase.
pub fn strip_utf8_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}
