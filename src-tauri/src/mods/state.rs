//! Path-sanitization + file-move helpers shared by the enable/disable
//! pipeline, the install path, and the local-cache layer — AND the
//! enable/disable/delete workflows themselves.
//!
//! Split out of the historic `mods.rs` mega-file so the path-safety
//! primitives and the workflows that compose them onto `ModInfo` live
//! next to each other.
//!
//! See `mods/mod.rs` for the Tauri-command orchestrators
//! (`toggle_mod`, `delete_mod_cmd`, `enable_all_mods`, etc.) that wrap
//! these helpers.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, Result};

use super::scan::normalize_name;
use super::ModInfo;

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
        return "mod".to_string();
    }
    // Windows reserved device names: CON, PRN, AUX, NUL, COM1-9, LPT1-9.
    // A bare reserved name (case-insensitive) OR one with an extension
    // (`con.txt`) cannot become a real file on Windows — the OS rejects it
    // before our code even runs. Prefix with `_` so the folder is creatable
    // everywhere without changing user-visible naming much.
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        format!("_{trimmed}")
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

// ── Enable / Disable / Delete Workflows ────────────────────────────────────

/// Enable a mod by moving its files from disabled to active.
pub fn enable_mod(mod_name: &str, mods_path: &Path, disabled_path: &Path) -> Result<()> {
    move_mod_files(mod_name, disabled_path, mods_path)
}

/// Disable a mod by moving its files from active to disabled.
pub fn disable_mod(mod_name: &str, mods_path: &Path, disabled_path: &Path) -> Result<()> {
    move_mod_files(mod_name, mods_path, disabled_path)
}

/// Move mod files using the actual file list from ModInfo.
/// Handles destination conflicts by removing existing files before moving.
pub fn move_mod_by_info(mod_info: &ModInfo, src: &Path, dest: &Path) -> Result<()> {
    let _ = fs::create_dir_all(dest);

    let mut moved_any = false;

    for file_rel in &mod_info.files {
        let Some(rel_path) = safe_mod_relative_path(file_rel) else {
            log::warn!(
                "Skipping unsafe path '{}' while moving mod '{}'",
                file_rel,
                mod_info.name
            );
            continue;
        };
        let src_file = src.join(&rel_path);
        let dest_file = dest.join(&rel_path);

        if !src_file.exists() {
            // If the file is already at the destination, count it as moved
            if dest_file.exists() {
                moved_any = true;
            }
            continue;
        }

        // Ensure parent directories exist for subdirectory mods
        if let Some(parent) = dest_file.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Remove destination file if it already exists (handles partial previous moves)
        if dest_file.exists() {
            if dest_file.is_dir() {
                let _ = fs::remove_dir_all(&dest_file);
            } else {
                let _ = fs::remove_file(&dest_file);
            }
        }

        fs::rename(&src_file, &dest_file).or_else(|_| {
            fs::copy(&src_file, &dest_file).and_then(|_| fs::remove_file(&src_file))
        })?;
        moved_any = true;
    }

    cleanup_empty_parent_dirs(src, &mod_info.files);

    if !moved_any {
        return Err(AppError::ModNotFound(format!(
            "No files found for mod '{}' in {}",
            mod_info.name,
            src.display()
        )));
    }

    Ok(())
}

fn cleanup_empty_parent_dirs(base: &Path, file_rels: &[String]) {
    let mut parent_dirs = HashSet::new();

    for file_rel in file_rels {
        let Some(rel_path) = safe_mod_relative_path(file_rel) else {
            log::warn!(
                "Skipping unsafe path '{}' during parent-dir cleanup",
                file_rel
            );
            continue;
        };
        let mut parent = rel_path.parent();
        while let Some(parent_rel) = parent {
            if parent_rel.as_os_str().is_empty() {
                break;
            }
            parent_dirs.insert(base.join(parent_rel));
            parent = parent_rel.parent();
        }
    }

    let mut parent_dirs: Vec<PathBuf> = parent_dirs.into_iter().collect();
    parent_dirs.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for dir in parent_dirs {
        if dir.is_dir()
            && fs::read_dir(&dir)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
        {
            let _ = fs::remove_dir(&dir);
        }
    }
}

pub(super) fn safe_mod_relative_path(file_rel: &str) -> Option<PathBuf> {
    let normalized = file_rel.replace('\\', "/");
    let rel = Path::new(&normalized);
    let mut cleaned = PathBuf::new();

    for component in rel.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if cleaned.as_os_str().is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Move all files associated with a mod between two directories.
/// Uses name matching with fallback to fuzzy (case-insensitive, no-spaces) comparison.
pub(super) fn move_mod_files(mod_name: &str, src: &Path, dest: &Path) -> Result<()> {
    let _ = fs::create_dir_all(dest);

    let mut found = false;
    let normalized_mod = normalize_name(mod_name);

    // Move files matching the mod name (same stem) - exact or fuzzy
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let fstem = Path::new(&fname)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Exact match or normalized (case-insensitive, no spaces) match
            if fstem == mod_name || normalize_name(&fstem) == normalized_mod {
                let dest_file = dest.join(&fname);
                // Remove destination if it already exists (handles stale/partial state)
                if dest_file.exists() {
                    if dest_file.is_dir() {
                        let _ = fs::remove_dir_all(&dest_file);
                    } else {
                        let _ = fs::remove_file(&dest_file);
                    }
                }
                fs::rename(entry.path(), &dest_file)?;
                found = true;
            }
        }
    }

    // Also check for a subdirectory with the mod name (exact or normalized)
    let sub_dir = src.join(mod_name);
    if sub_dir.is_dir() {
        let dest_dir = dest.join(mod_name);
        move_directory(&sub_dir, &dest_dir)?;
        let _ = fs::remove_dir_all(&sub_dir);
        found = true;
    } else if !found {
        // Try finding a subdirectory by normalized name
        if let Ok(entries) = fs::read_dir(src) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    if normalize_name(&dir_name) == normalized_mod {
                        let dest_dir = dest.join(&dir_name);
                        move_directory(&path, &dest_dir)?;
                        let _ = fs::remove_dir_all(&path);
                        found = true;
                        break;
                    }
                }
            }
        }
    }

    if !found {
        return Err(AppError::ModNotFound(format!(
            "No files found for mod '{}' in {}",
            mod_name,
            src.display()
        )));
    }

    Ok(())
}

/// Delete a mod's files from disk using its scanned file list.
/// Used during profile switching to remove version-mismatched mods before reinstalling.
pub fn delete_mod_files_by_info(mod_info: &ModInfo, base_path: &Path) {
    for file_rel in &mod_info.files {
        let Some(rel_path) = safe_mod_relative_path(file_rel) else {
            log::warn!(
                "Skipping unsafe path '{}' while deleting mod '{}'",
                file_rel,
                mod_info.name
            );
            continue;
        };
        let file_path = base_path.join(&rel_path);
        if file_path.is_dir() {
            let _ = fs::remove_dir_all(&file_path);
        } else if file_path.exists() {
            let _ = fs::remove_file(&file_path);
        }
    }

    cleanup_empty_parent_dirs(base_path, &mod_info.files);

    log::info!(
        "Deleted {} files for mod '{}' from {}",
        mod_info.files.len(),
        mod_info.name,
        base_path.display()
    );
}

#[cfg(test)]
mod path_safety_tests {
    use super::{path_is_inside, sanitize_path_segment};
    use std::path::Path;

    #[test]
    fn sanitize_strips_separators() {
        assert_eq!(sanitize_path_segment("foo/bar"), "foo_bar");
        assert_eq!(sanitize_path_segment("foo\\bar"), "foo_bar");
        assert_eq!(sanitize_path_segment("C:foo"), "C_foo");
    }

    #[test]
    fn sanitize_neutralizes_dotdot() {
        // ".." → "_" → all-underscore → fallback "mod"
        assert_eq!(sanitize_path_segment(".."), "mod");
        // "..foo" → "_foo" — safe (the "_" can't escape a parent dir)
        assert_eq!(sanitize_path_segment("..foo"), "_foo");
        // "foo.." → "foo_" — safe
        assert_eq!(sanitize_path_segment("foo.."), "foo_");
        // "a..b" → "a_b"
        assert_eq!(sanitize_path_segment("a..b"), "a_b");
    }

    #[test]
    fn sanitize_handles_empty_and_dots() {
        assert_eq!(sanitize_path_segment(""), "mod");
        assert_eq!(sanitize_path_segment("..."), "mod");
        assert_eq!(sanitize_path_segment("   "), "mod");
    }

    #[test]
    fn sanitize_preserves_normal_names() {
        assert_eq!(sanitize_path_segment("RitsuLib"), "RitsuLib");
        assert_eq!(sanitize_path_segment("My-Mod_v1.2"), "My-Mod_v1.2");
    }

    #[test]
    fn sanitize_prefixes_windows_reserved_names() {
        // Bare reserved names get `_` prefixed so they're creatable on Windows.
        assert_eq!(sanitize_path_segment("CON"), "_CON");
        assert_eq!(sanitize_path_segment("nul"), "_nul");
        assert_eq!(sanitize_path_segment("Aux"), "_Aux");
        assert_eq!(sanitize_path_segment("PRN"), "_PRN");
        // COM1-9 + LPT1-9 are the device-port reservations.
        assert_eq!(sanitize_path_segment("COM1"), "_COM1");
        assert_eq!(sanitize_path_segment("lpt9"), "_lpt9");
        // Reserved name + extension still triggers — Windows treats the stem.
        assert_eq!(sanitize_path_segment("con.txt"), "_con.txt");
        assert_eq!(sanitize_path_segment("COM3.dll"), "_COM3.dll");
        // Names that merely START with a reserved word but have more letters
        // before the dot are safe — e.g. "CONFIG" is not the reserved "CON".
        assert_eq!(sanitize_path_segment("CONFIG"), "CONFIG");
        assert_eq!(sanitize_path_segment("auxiliary"), "auxiliary");
        // COM10+ and LPT10+ are NOT reserved.
        assert_eq!(sanitize_path_segment("COM10"), "COM10");
        assert_eq!(sanitize_path_segment("LPT0"), "LPT0");
    }

    #[test]
    fn path_inside_accepts_subpath() {
        let root = Path::new("/tmp/mods");
        assert!(path_is_inside(&root.join("foo"), root));
        assert!(path_is_inside(&root.join("foo/bar.dll"), root));
    }

    #[test]
    fn path_inside_rejects_traversal() {
        let root = Path::new("/tmp/mods");
        assert!(!path_is_inside(&root.join("../escaped"), root));
        assert!(!path_is_inside(&root.join("../../etc/passwd"), root));
        assert!(!path_is_inside(&root.join("foo/../../escaped"), root));
    }

    #[test]
    fn path_inside_handles_curdir() {
        let root = Path::new("/tmp/mods");
        assert!(path_is_inside(&root.join("./foo"), root));
        assert!(path_is_inside(&root.join("foo/./bar"), root));
    }
}
