//! Path-sanitization + file-move helpers shared by the enable/disable
//! pipeline, the install path, and the local-cache layer.
//!
//! Split out of the historic `mods.rs` mega-file so the path-safety
//! primitives (which are easy to test in isolation and have no
//! `ModInfo`/`RawManifest` dependency) live separately from the
//! orchestration that calls into them. The enable/disable + delete
//! workflows (`enable_mod`, `disable_mod`, `move_mod_by_info`,
//! `delete_mod_files_by_info`) stay in `mod.rs` because they're
//! co-located with the test modules that exercise them via
//! `super::*`.
//!
//! See `mods/mod.rs` for the orchestration that wraps these helpers.

use std::fs;
use std::io;
use std::path::Path;

/// Sanitize a string for use in filenames.
///
/// Conservative — anything not in `[A-Za-z0-9._-]` becomes `_`.
/// Use `sanitize_path_segment` for stronger guarantees against
/// path-traversal attacks (`..`, separators) when the input is
/// publisher-controlled.
pub(super) fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Sanitize an attacker-influenced single path segment so it can't escape
/// when joined onto a destination root. Replaces any path-separator-like
/// characters and `..` with underscores. Used for `wrap_folder_name` and
/// for URL-derived filenames in the download path — those strings can come
/// from a manifest's Name/Id field, a zip stem, or a redirect URL, all of
/// which are publisher-controlled and therefore untrusted.
pub fn sanitize_path_segment(s: &str) -> String {
    let mapped: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            _ => c,
        })
        .collect();
    let no_dotdot = mapped.replace("..", "_");
    let trimmed = no_dotdot.trim_matches(|c: char| c == '.' || c.is_whitespace());
    // Empty after trim → fall back. Also fall back if everything we have
    // is the underscore replacement marker — that happens when the input
    // was 100% path-special characters (e.g. "..", "...", "/", "\\:")
    // and the result would be a useless folder name like "_".
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        "mod".to_string()
    } else {
        trimmed.to_string()
    }
}

/// True if `path` resolves inside `root`. Handles the common case where
/// `path` doesn't exist yet (we're about to create it) by walking the
/// component list and tracking depth — `..` decrements depth, normal
/// components increment it. Negative depth means the path escapes.
///
/// Falls through to canonicalize-and-prefix-check when both ends exist,
/// for the symlink-resolved guarantee.
pub fn path_is_inside(path: &Path, root: &Path) -> bool {
    if let (Ok(p), Ok(r)) = (path.canonicalize(), root.canonicalize()) {
        return p.starts_with(&r);
    }
    // Component walk: starting from `root`'s depth, ensure we never go below.
    use std::path::Component;
    let mut depth: i32 = 0;
    // Strip the `root` prefix off `path` if it's there; otherwise treat
    // `path` as starting at depth 0.
    let rel = path.strip_prefix(root).unwrap_or(path);
    for component in rel.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir => return false,
        }
    }
    true
}

/// Move a directory tree across filesystems by walking and renaming
/// each entry individually. Uses `fs::rename` when source and dest are
/// on the same drive; falls back to `copy + remove` when they aren't
/// (common on Windows when mods/disabled live on different volumes).
///
/// Recursive — calls itself for subdirectories. The source dir is
/// best-effort removed at the end (silently fails if not empty).
pub fn move_directory(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            move_directory(&src_path, &dest_path)?;
        } else {
            fs::rename(&src_path, &dest_path).or_else(|_| {
                fs::copy(&src_path, &dest_path).and_then(|_| fs::remove_file(&src_path))
            })?;
        }
    }
    // Remove the now-empty source directory
    let _ = fs::remove_dir(src);
    Ok(())
}
