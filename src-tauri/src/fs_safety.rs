//! Filesystem-safety helpers used by the JSON-backed stores and the
//! destructive restore/repair paths.
//!
//! - [`atomic_write`] writes via a same-directory temp file + rename so a
//!   crash mid-write leaves either the old file or the fully-written new
//!   file — never a truncated one. (Audit H-3 / M-10.)
//! - [`swap_dirs_aside`] moves directories to temp siblings before a
//!   destructive "wipe then rebuild" so the rebuild can be rolled back if it
//!   fails, instead of leaving the user with an emptied mods folder.
//!   (Audit H-4 / M-9.)

use std::io::{self, Write};
use std::path::{Path, PathBuf};

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

/// Handle returned by [`swap_dirs_aside`] for directories temporarily moved
/// aside before a destructive "wipe then rebuild" operation. Call
/// [`DirSwap::discard`] when the rebuild succeeded (deletes the saved
/// originals) or [`DirSwap::restore`] when it failed (puts the originals back,
/// discarding any partial output).
pub struct DirSwap {
    /// (original path, Some(temp path) if the dir existed and was moved).
    moved: Vec<(PathBuf, Option<PathBuf>)>,
}

/// Move each existing dir in `dirs` to a temp sibling (same filesystem, so the
/// rename is atomic) and recreate it empty so the caller's operation can write
/// into it. A dir that does not exist is created empty and recorded so
/// [`DirSwap::restore`] can remove it again on rollback.
pub fn swap_dirs_aside(dirs: &[&Path]) -> io::Result<DirSwap> {
    let mut moved: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    for d in dirs {
        let d: &Path = d;
        if d.exists() {
            let temp = unique_sibling(d)?;
            std::fs::rename(d, &temp)?;
            moved.push((d.to_path_buf(), Some(temp)));
        } else {
            moved.push((d.to_path_buf(), None));
        }
        // Recreate an empty dir so the caller's operation has somewhere to write.
        std::fs::create_dir_all(d)?;
    }
    Ok(DirSwap { moved })
}

impl DirSwap {
    /// Success path: delete the saved originals.
    pub fn discard(self) -> io::Result<()> {
        for (_orig, temp) in &self.moved {
            if let Some(t) = temp {
                if t.exists() {
                    std::fs::remove_dir_all(t)?;
                }
            }
        }
        Ok(())
    }

    /// Failure path: delete whatever is now at each original location and move
    /// the saved originals back (or just remove dirs that didn't exist before).
    pub fn restore(self) -> io::Result<()> {
        for (orig, temp) in self.moved.iter().rev() {
            if orig.exists() {
                std::fs::remove_dir_all(orig)?;
            }
            if let Some(t) = temp {
                std::fs::rename(t, orig)?;
            }
        }
        Ok(())
    }
}

/// Find an unused sibling path next to `d` (same parent → same filesystem, so
/// the stash/restore renames are atomic) to hold `d` while it is rebuilt.
fn unique_sibling(d: &Path) -> io::Result<PathBuf> {
    let parent = d
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let base = d.file_name().and_then(|n| n.to_str()).unwrap_or("dir");
    for n in 0..100_000u32 {
        let cand = parent.join(format!(".{base}.sts2mm-swap-{n}"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique swap directory name",
    ))
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

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn leftover_swap_dirs(base: &Path) -> Vec<String> {
        std::fs::read_dir(base)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("sts2mm-swap"))
            .collect()
    }

    #[test]
    fn swap_discard_keeps_rebuilt_contents_and_drops_originals() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(&mods.join("old.txt"), "old");

        let swap = swap_dirs_aside(&[&mods]).unwrap();
        assert!(mods.exists(), "dir is recreated empty for the rebuild");
        assert!(
            !mods.join("old.txt").exists(),
            "original contents moved aside"
        );

        write(&mods.join("new.txt"), "new"); // simulate a successful rebuild
        swap.discard().unwrap();

        assert!(mods.join("new.txt").exists());
        assert!(!mods.join("old.txt").exists());
        assert!(
            leftover_swap_dirs(base.path()).is_empty(),
            "no swap temp should be left behind"
        );
    }

    #[test]
    fn swap_restore_recovers_originals_after_failed_rebuild() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        write(&mods.join("old.txt"), "old");

        let swap = swap_dirs_aside(&[&mods]).unwrap();
        write(&mods.join("partial.txt"), "partial"); // simulate a partial/failed rebuild
        swap.restore().unwrap();

        assert_eq!(
            std::fs::read_to_string(mods.join("old.txt")).unwrap(),
            "old"
        );
        assert!(
            !mods.join("partial.txt").exists(),
            "partial output discarded"
        );
        assert!(
            leftover_swap_dirs(base.path()).is_empty(),
            "no swap temp should be left behind"
        );
    }

    #[test]
    fn swap_restore_handles_multiple_dirs() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods");
        let disabled = base.path().join("mods_disabled");
        write(&mods.join("a.txt"), "a");
        write(&disabled.join("b.txt"), "b");

        let swap = swap_dirs_aside(&[&mods, &disabled]).unwrap();
        write(&mods.join("new.txt"), "new");
        swap.restore().unwrap();

        assert!(mods.join("a.txt").exists());
        assert!(disabled.join("b.txt").exists());
        assert!(!mods.join("new.txt").exists());
    }

    #[test]
    fn swap_restore_removes_dir_absent_before_the_operation() {
        let base = tempdir().unwrap();
        let mods = base.path().join("mods"); // does NOT exist yet

        let swap = swap_dirs_aside(&[&mods]).unwrap();
        assert!(mods.exists(), "swap recreates an empty dir for the rebuild");
        write(&mods.join("new.txt"), "new");
        swap.restore().unwrap();

        assert!(
            !mods.exists(),
            "a dir absent before should be absent after rollback"
        );
    }
}
