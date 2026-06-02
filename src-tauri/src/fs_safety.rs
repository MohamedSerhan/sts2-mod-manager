//! Filesystem-safety helpers used by the JSON-backed stores and the
//! destructive restore/repair paths.
//!
//! - [`atomic_write`] writes via a same-directory temp file + rename so a
//!   crash mid-write leaves either the old file or the fully-written new
//!   file — never a truncated one. (Audit H-3 / M-10.)

use std::io::{self, Write};
use std::path::Path;

/// Atomically write `contents` to `path`.
///
/// Writes to a freshly-created temp file in the *same directory* as `path`
/// (so the final rename stays on one filesystem and is atomic), then renames
/// it over `path`. The parent directory is created if missing.
pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    // Resolve the directory the temp file must live in so the final rename
    // stays on the same filesystem (a cross-device rename is not atomic and
    // would fail outright). An empty parent means a bare filename → use ".".
    let dir = match path.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(p) => {
            std::fs::create_dir_all(p)?;
            p.to_path_buf()
        }
        None => std::path::PathBuf::from("."),
    };

    let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
    tmp.write_all(contents)?;
    // Flush buffered data to disk before the rename so a crash can't leave a
    // renamed-but-empty file.
    tmp.as_file().sync_all()?;
    // Atomic replace: on success `path` now points at the fully-written file;
    // on a crash before this line the original `path` is untouched.
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_creates_then_overwrites_with_no_leftover_tmp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");

        atomic_write(&path, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        // Overwrite with different-length content.
        atomic_write(&path, b"second-and-longer").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second-and-longer");

        // The directory must contain only the target file — no stray *.tmp.
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["store.json".to_string()],
            "only the target file should remain, got {:?}",
            names
        );
    }

    #[test]
    fn atomic_write_creates_missing_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("store.json");
        atomic_write(&nested, b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "hello");
    }
}
