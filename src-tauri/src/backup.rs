use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::Result;
use crate::state::AppState;

/// Metadata about a single backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    /// Directory name of the backup (e.g. "backup_2026-05-03_17-30-00")
    pub name: String,
    /// ISO 8601 timestamp extracted from the directory name
    pub timestamp: String,
    /// Number of mod files in the backup
    pub mod_count: usize,
    /// Total size of all files in bytes
    pub size_bytes: u64,
}

/// Default and maximum number of backups to retain. Older backups are pruned
/// after each successful create. The user-configurable retention setting is
/// clamped to `0..=MAX_BACKUPS`; `0` disables automatic backups entirely.
pub const MAX_BACKUPS: usize = 10;

/// Default retention used when the persisted setting is absent.
pub const DEFAULT_BACKUP_RETENTION: u8 = 2;

/// Config items stored in the app data directory that are included in every
/// backup and restored alongside mods.
const CONFIG_ITEMS: &[&str] = &[
    "mod_sources.json",
    "subscriptions.json",
    "profiles",
    "active_profile.txt",
    "launch_mode.txt",
];

/// Create a timestamped backup of the current mods directory.
///
/// Copies all files from `mods_path` into a new subdirectory under
/// `backup_dir` named `backup_YYYY-MM-DD_HH-MM-SS`.
/// Returns the backup directory name.
// Retained as a stable test/helper entry point that always uses the default
// retention. Production paths use `create_backup_with_retention` so the user's
// setting is honored, leaving this unused outside tests.
#[allow(dead_code)]
pub fn create_backup(mods_path: &Path, backup_dir: &Path) -> Result<String> {
    create_backup_preserving(mods_path, backup_dir, None)
}

/// Create a backup honoring a user-configured retention count.
///
/// `keep` is the number of newest backups to retain after pruning. When
/// `keep == 0` automatic backups are disabled: no new backup is created and
/// existing backups are left untouched (the user can clean them manually).
/// `keep` is clamped to at most [`MAX_BACKUPS`]. Returns `Ok(None)` when
/// backups are disabled.
pub fn create_backup_with_retention(
    mods_path: &Path,
    backup_dir: &Path,
    keep: u8,
) -> Result<Option<String>> {
    if keep == 0 {
        log::info!("Backup retention is 0 (off); skipping automatic backup creation");
        return Ok(None);
    }
    create_backup_preserving_keep(
        mods_path,
        backup_dir,
        None,
        (keep as usize).min(MAX_BACKUPS),
    )
    .map(Some)
}

/// Create a backup while keeping a named restore target safe from retention
/// pruning. Used by the pre-restore safety backup flow: creating the safety
/// backup must not delete the backup the user is actively trying to restore.
///
/// Backup layout:
/// ```text
/// backup_YYYY-MM-DD_HH-MM-SS/
///   mods/         (copy of mods_path)
///   config/
///     mod_sources.json
///     subscriptions.json
///     profiles/
///     active_profile.txt
///     launch_mode.txt
/// ```
pub fn create_backup_preserving(
    mods_path: &Path,
    backup_dir: &Path,
    preserve_name: Option<&str>,
) -> Result<String> {
    create_backup_preserving_keep(mods_path, backup_dir, preserve_name, MAX_BACKUPS)
}

/// Like [`create_backup_preserving`] but prunes to a caller-supplied retention
/// count instead of the default [`MAX_BACKUPS`].
pub fn create_backup_preserving_keep(
    mods_path: &Path,
    backup_dir: &Path,
    preserve_name: Option<&str>,
    keep: usize,
) -> Result<String> {
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let backup_name = format!("backup_{}", timestamp);
    let dest = backup_dir.join(&backup_name);

    fs::create_dir_all(&dest)?;

    // Copy mods into mods/ subdirectory.
    let dest_mods = dest.join("mods");
    if mods_path.exists() {
        log::info!(
            "Creating backup '{}' from {}",
            backup_name,
            mods_path.display()
        );
        copy_dir_recursive(mods_path, &dest_mods)?;
    } else {
        log::warn!(
            "create_backup: mods_path {} does not exist; backup mods/ will be empty",
            mods_path.display()
        );
        fs::create_dir_all(&dest_mods)?;
    }

    // Copy config files from the app data directory (parent of mods_path).
    if let Some(app_data_dir) = mods_path.parent() {
        let dest_config = dest.join("config");
        fs::create_dir_all(&dest_config)?;

        for &item in CONFIG_ITEMS {
            let src = app_data_dir.join(item);
            if src.exists() {
                let dst = dest_config.join(item);
                if src.is_dir() {
                    copy_dir_recursive(&src, &dst)?;
                } else {
                    fs::copy(&src, &dst)?;
                }
            } else {
                log::warn!("create_backup: config item '{}' not found; skipping", item);
            }
        }
    } else {
        log::warn!("create_backup: mods_path has no parent; config backup skipped");
    }

    log::info!("Backup created: {}", dest.display());

    if let Err(e) = prune_old_backups_preserving(backup_dir, keep, preserve_name) {
        log::warn!("Retention pruning failed: {}", e);
    }

    Ok(backup_name)
}

fn prune_old_backups_preserving(
    backup_dir: &Path,
    keep: usize,
    preserve_name: Option<&str>,
) -> io::Result<()> {
    if !backup_dir.exists() {
        return Ok(());
    }

    let mut names: Vec<String> = fs::read_dir(backup_dir)?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("backup_"))
        .collect();

    names.sort_by(|a, b| b.cmp(a));

    let preserve_name = preserve_name.filter(|name| name.starts_with("backup_"));
    let mut keep_names: Vec<String> = names.iter().take(keep).cloned().collect();
    if keep > 0 {
        if let Some(preserve) = preserve_name {
            if names.iter().any(|name| name == preserve)
                && !keep_names.iter().any(|name| name == preserve)
            {
                keep_names.pop();
                keep_names.push(preserve.to_string());
            }
        }
    }

    for name in names.into_iter().filter(|name| !keep_names.contains(name)) {
        log::info!("Retention: pruning old backup '{}'", name);
        if let Err(e) = fs::remove_dir_all(backup_dir.join(&name)) {
            log::warn!("Failed to prune backup '{}': {}", name, e);
        }
    }

    Ok(())
}

/// Delete a single backup by name. Rejects names that don't start with
/// `backup_` as a sanity check against accidental directory removal.
pub fn delete_backup(name: &str, backup_dir: &Path) -> Result<()> {
    if !name.starts_with("backup_") {
        return Err(crate::error::AppError::Other(format!(
            "Refusing to delete '{}' — not a backup directory",
            name
        )));
    }

    let target = backup_dir.join(name);
    if !target.exists() {
        return Err(crate::error::AppError::Other(format!(
            "Backup '{}' not found",
            name
        )));
    }

    fs::remove_dir_all(&target)?;
    Ok(())
}

/// List all backups in the backup directory.
pub fn list_backups(backup_dir: &Path) -> Vec<BackupInfo> {
    let mut backups = Vec::new();

    if !backup_dir.exists() {
        return backups;
    }

    let entries = match fs::read_dir(backup_dir) {
        Ok(e) => e,
        Err(_) => return backups,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("backup_") {
            continue;
        }

        // Extract timestamp from name: "backup_YYYY-MM-DD_HH-MM-SS"
        let timestamp = name
            .strip_prefix("backup_")
            .unwrap_or(&name)
            .replace('_', "T")
            .replacen('-', ":", 2); // rough ISO conversion for display

        // Count mods (files under mods/ subdirectory) and total backup size.
        // Fix M-11: backups now have mods/ + config/ subdirectories.
        // mod_count reflects mods only; size_bytes covers the whole backup.
        let mut mod_count: usize = 0;
        let mut size_bytes: u64 = 0;

        let mods_subdir = path.join("mods");
        if mods_subdir.exists() {
            // New-style backup: count files under mods/ only.
            for file_entry in WalkDir::new(&mods_subdir).into_iter().flatten() {
                if file_entry.file_type().is_file() {
                    mod_count += 1;
                }
            }
            // Size: entire backup (mods/ + config/).
            for file_entry in WalkDir::new(&path).into_iter().flatten() {
                if file_entry.file_type().is_file() {
                    size_bytes += file_entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        } else {
            // Legacy backup (flat structure): every file is a mod file.
            for file_entry in WalkDir::new(&path).into_iter().flatten() {
                if file_entry.file_type().is_file() {
                    mod_count += 1;
                    size_bytes += file_entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }

        backups.push(BackupInfo {
            name,
            timestamp,
            mod_count,
            size_bytes,
        });
    }

    // Sort newest first
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    backups
}

/// Swap-aside handle for a set of named config items stored directly inside
/// `base_dir` (the app data directory).  Items that exist are renamed to a
/// temporary sibling directory on the same filesystem so the rename is atomic;
/// on success call [`ConfigItemSwap::discard`] to drop the saved originals; on
/// failure call [`ConfigItemSwap::restore`] to move them back.
///
/// Snapshot semantics: because only items present in the backup are copied back
/// in, items that were live but absent from the backup are dropped when the
/// aside is discarded — ensuring restore is a true replace, not a merge.
struct ConfigItemSwap {
    aside_dir: PathBuf,
    base_dir: PathBuf,
    /// Names of items that were physically moved aside (existed before swap).
    moved: Vec<String>,
}

impl ConfigItemSwap {
    fn new(base_dir: &Path, items: &[&str]) -> io::Result<Self> {
        let parent = base_dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let stem = base_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("app-data");

        let aside_dir = (0u32..100_000)
            .map(|n| parent.join(format!(".{stem}.sts2mm-cfg-swap-{n}")))
            .find(|p| !p.exists())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "could not allocate a unique config swap directory",
                )
            })?;

        fs::create_dir_all(&aside_dir)?;

        let mut moved = Vec::new();
        for &item in items {
            let src = base_dir.join(item);
            if src.exists() {
                fs::rename(&src, aside_dir.join(item))?;
                moved.push(item.to_string());
            }
        }

        Ok(ConfigItemSwap {
            aside_dir,
            base_dir: base_dir.to_path_buf(),
            moved,
        })
    }

    /// Success path: drop the saved originals.
    fn discard(self) -> io::Result<()> {
        fs::remove_dir_all(&self.aside_dir)
    }

    /// Failure path: restore saved originals, removing any partial copies first.
    fn restore(self) -> io::Result<()> {
        for item in &self.moved {
            let dst = self.base_dir.join(item);
            if dst.exists() {
                if dst.is_dir() {
                    fs::remove_dir_all(&dst)?;
                } else {
                    fs::remove_file(&dst)?;
                }
            }
            fs::rename(self.aside_dir.join(item), &dst)?;
        }
        let _ = fs::remove_dir_all(&self.aside_dir);
        Ok(())
    }
}

/// Copy config items from `src_config/` into `app_data_dir/`, creating
/// directories as needed.  Only items that exist in `src_config` are copied;
/// items absent from `src_config` are left untouched (the caller is responsible
/// for clearing stale items via [`ConfigItemSwap`]).
fn copy_config_items(src_config: &Path, app_data_dir: &Path) -> io::Result<()> {
    for &item in CONFIG_ITEMS {
        let item_src = src_config.join(item);
        if item_src.exists() {
            let item_dst = app_data_dir.join(item);
            if item_src.is_dir() {
                copy_dir_recursive(&item_src, &item_dst)?;
            } else {
                fs::copy(&item_src, &item_dst)?;
            }
        }
    }
    Ok(())
}

/// Restore a backup by replacing the current mods directory contents.
///
/// Clears the current `mods_path` and copies all files from the named
/// backup directory into it.
pub fn restore_backup(backup_name: &str, backup_dir: &Path, mods_path: &Path) -> Result<()> {
    // Reject anything that isn't a plain "backup_*" snapshot folder. A name
    // containing path separators or ".." could resolve outside backup_dir and
    // copy an arbitrary directory into mods. (Audit M-6; stricter than the
    // prefix-only guard in delete_backup.)
    if !backup_name.starts_with("backup_")
        || backup_name.contains('/')
        || backup_name.contains('\\')
        || backup_name.contains("..")
    {
        return Err(crate::error::AppError::Other(format!(
            "Refusing to restore '{}' — not a valid backup name",
            backup_name
        )));
    }

    let src = backup_dir.join(backup_name);
    if !src.exists() {
        log::error!(
            "restore_backup: backup '{}' not found at {}",
            backup_name,
            src.display()
        );
        return Err(crate::error::AppError::Other(format!(
            "Backup '{}' not found",
            backup_name
        )));
    }

    log::info!(
        "Restoring backup '{}' into {}",
        backup_name,
        mods_path.display()
    );

    // Detect new-style backup (has mods/ subdirectory) vs legacy flat backup.
    let src_mods = src.join("mods");
    let is_new_style = src_mods.exists();
    let mods_src = if is_new_style { &src_mods } else { &src };

    // Move mods aside (H-4 rollback semantics): a failure mid-copy rolls back
    // to the pre-restore state instead of leaving the user with an empty folder.
    let mods_swap = crate::fs_safety::swap_dirs_aside(&[mods_path])?;

    // For new-style backups: also swap config items aside *before* any copy so
    // (a) restore is a true snapshot replace — items absent from the backup are
    // removed rather than left behind — and (b) any failure mid-copy can roll
    // the config back to its pre-restore state.
    let config_swap: Option<(ConfigItemSwap, PathBuf, PathBuf)> = if is_new_style {
        if let Some(app_data_dir) = mods_path.parent() {
            let src_config = src.join("config");
            if src_config.exists() {
                match ConfigItemSwap::new(app_data_dir, CONFIG_ITEMS) {
                    Ok(cs) => Some((cs, app_data_dir.to_path_buf(), src_config)),
                    Err(e) => {
                        if let Err(re) = mods_swap.restore() {
                            log::error!(
                                "restore_backup: mods rollback failed while setting up config swap: {}",
                                re
                            );
                        }
                        return Err(e.into());
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // Copy mods.
    if let Err(e) = copy_dir_recursive(mods_src, mods_path) {
        log::error!("restore_backup: mods copy failed ({}); rolling back", e);
        if let Some((cs, _, _)) = config_swap {
            if let Err(re) = cs.restore() {
                log::error!("restore_backup: config rollback failed: {}", re);
            }
        }
        if let Err(re) = mods_swap.restore() {
            log::error!("restore_backup: mods rollback ALSO failed: {}", re);
        }
        return Err(e.into());
    }

    // Copy config items (new-style backups only).
    if let Some((cs, app_data_dir, src_config)) = config_swap {
        if let Err(e) = copy_config_items(&src_config, &app_data_dir) {
            log::error!("restore_backup: config copy failed ({}); rolling back", e);
            if let Err(re) = cs.restore() {
                log::error!("restore_backup: config rollback failed: {}", re);
            }
            if let Err(re) = mods_swap.restore() {
                log::error!("restore_backup: mods rollback also failed: {}", re);
            }
            return Err(e.into());
        }
        if let Err(e) = cs.discard() {
            log::warn!(
                "restore_backup: config swap cleanup failed (non-critical): {}",
                e
            );
        }
        log::info!("Backup '{}' config restored successfully", backup_name);
    }

    mods_swap.discard()?;
    log::info!("Backup '{}' mods restored successfully", backup_name);
    Ok(())
}

/// Move all mods from mods/ to mods_disabled/ (reset to vanilla state).
pub fn reset_to_vanilla(mods_path: &Path, disabled_path: &Path) -> Result<()> {
    let _ = fs::create_dir_all(disabled_path);

    if !mods_path.exists() {
        log::info!(
            "reset_to_vanilla: mods_path {} doesn't exist; nothing to do",
            mods_path.display()
        );
        return Ok(());
    }

    log::info!(
        "Resetting to vanilla: moving everything from {} to {}",
        mods_path.display(),
        disabled_path.display()
    );
    let mut moved: usize = 0;

    for entry in fs::read_dir(mods_path)?.flatten() {
        let src_path = entry.path();
        let dest_path = disabled_path.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
            fs::remove_dir_all(&src_path)?;
        } else {
            fs::rename(&src_path, &dest_path).or_else(|_| {
                fs::copy(&src_path, &dest_path).and_then(|_| fs::remove_file(&src_path))
            })?;
        }
        moved += 1;
    }

    log::info!("reset_to_vanilla: moved {} item(s) to disabled", moved);
    Ok(())
}

/// Recursively copy a directory's contents into a destination.
fn copy_dir_recursive(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod backup_pure_tests {
    use super::*;
    use std::fs;

    #[test]
    fn create_backup_copies_all_files_recursively() {
        // Fix M-11: backups now use mods/ subdirectory layout.
        // mods_path must have a parent (app_data_dir) for the config items to be looked up.
        let root = tempfile::tempdir().unwrap();
        let mods = root.path().join("mods");
        let backups = root.path().join("backups");
        // Set up: one mod folder with a manifest + dll.
        let modfolder = mods.join("MyMod");
        fs::create_dir_all(&modfolder).unwrap();
        fs::write(modfolder.join("MyMod.json"), b"{}").unwrap();
        fs::write(modfolder.join("MyMod.dll"), b"binary").unwrap();

        let backup_name = create_backup(&mods, &backups).unwrap();
        let backup_dir = backups.join(&backup_name);
        assert!(backup_dir.exists());
        // Mods are under mods/ subdirectory now.
        assert!(backup_dir.join("mods/MyMod/MyMod.json").exists());
        assert!(backup_dir.join("mods/MyMod/MyMod.dll").exists());
    }

    #[test]
    fn create_backup_handles_missing_mods_path_with_empty_dir() {
        let root = tempfile::tempdir().unwrap();
        let backups = root.path().join("backups");
        // mods_path doesn't exist but its parent (root) does.
        let missing = root.path().join("mods");
        let name = create_backup(&missing, &backups).unwrap();
        let dir = backups.join(&name);
        assert!(dir.exists());
        // mods/ subdirectory is created even when mods_path doesn't exist.
        assert!(dir.join("mods").exists());
    }

    #[test]
    fn list_backups_returns_empty_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("no-backups-here");
        assert!(list_backups(&missing).is_empty());
    }

    #[test]
    fn list_backups_returns_entries_with_metadata_and_sorted_newest_first() {
        let backups = tempfile::tempdir().unwrap();
        for (i, ts) in [
            "2026-01-01_10-00-00",
            "2026-05-01_10-00-00",
            "2026-03-01_10-00-00",
        ]
        .iter()
        .enumerate()
        {
            let dir = backups.path().join(format!("backup_{}", ts));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("file{}.txt", i)), b"data").unwrap();
        }
        let list = list_backups(backups.path());
        assert_eq!(list.len(), 3);
        // Newest first by timestamp string (ISO-like).
        assert!(list[0].name.contains("2026-05-01"));
        assert!(list[2].name.contains("2026-01-01"));
        // mod_count and size are populated.
        assert!(list.iter().all(|b| b.size_bytes > 0));
    }

    #[test]
    fn delete_backup_removes_the_named_directory() {
        let backups = tempfile::tempdir().unwrap();
        let dir = backups.path().join("backup_2026-05-01_10-00-00");
        fs::create_dir_all(&dir).unwrap();
        delete_backup("backup_2026-05-01_10-00-00", backups.path()).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn restore_backup_rejects_path_traversal_name() {
        let root = tempfile::tempdir().unwrap();
        let backup_dir = root.path().join("backups");
        fs::create_dir_all(&backup_dir).unwrap();

        // An attacker-controlled directory OUTSIDE backup_dir.
        let evil = root.path().join("evil");
        fs::create_dir_all(&evil).unwrap();
        fs::write(evil.join("evil.txt"), "pwned").unwrap();

        // Current mods the user must not lose.
        let mods = root.path().join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(mods.join("keep.txt"), "keep").unwrap();

        // "../evil" resolves to an existing directory outside backup_dir.
        let res = restore_backup("../evil", &backup_dir, &mods);

        assert!(res.is_err(), "a traversal backup name must be rejected");
        assert!(
            mods.join("keep.txt").exists(),
            "user mods must be untouched"
        );
        assert!(
            !mods.join("evil.txt").exists(),
            "escaped directory contents must not be copied into mods"
        );
    }

    #[test]
    fn restore_backup_restores_named_backup_and_replaces_current() {
        // Fix M-11: test new-style backup (has mods/ subdirectory).
        let root = tempfile::tempdir().unwrap();
        let backup_dir = root.path().join("backups");
        let snap = backup_dir.join("backup_2026-01-01_00-00-00");
        // New-style: mods are under mods/ subdirectory.
        let snap_mods = snap.join("mods");
        fs::create_dir_all(&snap_mods).unwrap();
        fs::write(snap_mods.join("ModA.dll"), "a").unwrap();

        let mods = root.path().join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(mods.join("stale.txt"), "stale").unwrap();

        restore_backup("backup_2026-01-01_00-00-00", &backup_dir, &mods).unwrap();

        assert!(mods.join("ModA.dll").exists(), "backup contents restored");
        assert!(
            !mods.join("stale.txt").exists(),
            "pre-restore contents replaced by the backup"
        );
    }

    #[test]
    fn restore_backup_legacy_flat_structure_still_works() {
        // Legacy backups (flat, without mods/ subdirectory) should still restore correctly.
        let root = tempfile::tempdir().unwrap();
        let backup_dir = root.path().join("backups");
        let snap = backup_dir.join("backup_2026-01-01_00-00-00");
        fs::create_dir_all(&snap).unwrap();
        fs::write(snap.join("LegacyMod.dll"), "legacy").unwrap();

        let mods = root.path().join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(mods.join("stale.txt"), "stale").unwrap();

        restore_backup("backup_2026-01-01_00-00-00", &backup_dir, &mods).unwrap();

        assert!(
            mods.join("LegacyMod.dll").exists(),
            "legacy backup contents restored"
        );
        assert!(!mods.join("stale.txt").exists(), "stale contents replaced");
    }

    #[test]
    fn restore_backup_swaps_mods_with_backup_contents() {
        let mods = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();

        // Existing mod that should be wiped.
        let existing = mods.path().join("OldMod");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("OldMod.json"), b"{}").unwrap();

        // Backup containing a different mod.
        let backup_dir = backups.path().join("backup_2026-01-01_00-00-00");
        let modfolder = backup_dir.join("RestoredMod");
        fs::create_dir_all(&modfolder).unwrap();
        fs::write(modfolder.join("RestoredMod.json"), b"{}").unwrap();

        restore_backup("backup_2026-01-01_00-00-00", backups.path(), mods.path()).unwrap();
        assert!(!mods.path().join("OldMod").exists());
        assert!(mods.path().join("RestoredMod/RestoredMod.json").exists());
    }

    #[test]
    fn reset_to_vanilla_moves_mods_into_the_disabled_folder() {
        let mods = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();
        // One folder + one loose file in mods/.
        fs::create_dir_all(mods.path().join("ModA")).unwrap();
        fs::write(mods.path().join("ModA/x.json"), b"{}").unwrap();
        fs::write(mods.path().join("loose.txt"), b"x").unwrap();

        reset_to_vanilla(mods.path(), disabled.path()).unwrap();

        // Originals are gone from mods/...
        assert!(!mods.path().join("ModA").exists());
        assert!(!mods.path().join("loose.txt").exists());
        // ...and now live in mods_disabled/.
        assert!(disabled.path().join("ModA/x.json").exists());
        assert!(disabled.path().join("loose.txt").exists());
    }

    #[test]
    fn prune_keeps_only_the_newest_n_backups() {
        let backups = tempfile::tempdir().unwrap();
        // Create 7 named backups.
        for i in 0..7 {
            let dir = backups
                .path()
                .join(format!("backup_2026-0{}-01_10-00-00", i + 1));
            fs::create_dir_all(&dir).unwrap();
        }
        prune_old_backups_preserving(backups.path(), 3, None).unwrap();
        let remaining: Vec<_> = fs::read_dir(backups.path()).unwrap().collect();
        assert_eq!(remaining.len(), 3);
    }

    #[test]
    fn create_backup_with_retention_keeps_newest_n() {
        // A custom retention of 2 must keep only the newest 2 backups after a
        // successful create (the new one + 1 prior).
        let root = tempfile::tempdir().unwrap();
        let mods = root.path().join("mods");
        let backups = root.path().join("backups");
        fs::create_dir_all(mods.join("CurrentMod")).unwrap();
        fs::write(mods.join("CurrentMod/CurrentMod.json"), b"{}").unwrap();

        // Seed 4 pre-existing backups.
        for ts in [
            "2026-01-01_10-00-00",
            "2026-02-01_10-00-00",
            "2026-03-01_10-00-00",
            "2026-04-01_10-00-00",
        ] {
            fs::create_dir_all(backups.join(format!("backup_{}", ts))).unwrap();
        }

        let created = create_backup_with_retention(&mods, &backups, 2).unwrap();
        let created = created.expect("retention 2 must create a backup");

        let remaining = list_backups(&backups);
        assert_eq!(
            remaining.len(),
            2,
            "retention 2 must keep exactly the newest 2 backups"
        );
        // The just-created backup is newest, so it must be present.
        assert!(remaining.iter().any(|b| b.name == created));
    }

    #[test]
    fn create_backup_with_retention_zero_skips_creation_and_keeps_existing() {
        let root = tempfile::tempdir().unwrap();
        let mods = root.path().join("mods");
        let backups = root.path().join("backups");
        fs::create_dir_all(mods.join("CurrentMod")).unwrap();
        fs::write(mods.join("CurrentMod/CurrentMod.json"), b"{}").unwrap();

        // Two pre-existing backups the user should keep.
        fs::create_dir_all(backups.join("backup_2026-01-01_10-00-00")).unwrap();
        fs::create_dir_all(backups.join("backup_2026-02-01_10-00-00")).unwrap();

        let created = create_backup_with_retention(&mods, &backups, 0).unwrap();
        assert!(
            created.is_none(),
            "retention 0 must skip creating a new backup"
        );
        assert_eq!(
            list_backups(&backups).len(),
            2,
            "retention 0 must not delete existing backups"
        );
    }

    #[test]
    fn manual_backup_keep_never_prunes_to_one_when_backups_are_off() {
        // Retention 0 = automatic backups off. A manual "Create backup" click
        // must fall back to the historical cap, not keep=1 (which would wipe
        // every other hand-made backup).
        assert_eq!(super::manual_backup_keep(0), MAX_BACKUPS);
        assert_eq!(super::manual_backup_keep(2), 2);
        assert_eq!(super::manual_backup_keep(5), 5);
        // Out-of-range values clamp to the cap.
        assert_eq!(super::manual_backup_keep(99), MAX_BACKUPS);
    }

    #[test]
    fn default_backup_retention_is_two_with_ten_allowed() {
        assert_eq!(DEFAULT_BACKUP_RETENTION, 2);
        assert_eq!(MAX_BACKUPS, 10);
    }

    #[test]
    fn clamp_retention_bounds_to_max() {
        assert_eq!(clamp_retention(0), 0);
        assert_eq!(clamp_retention(3), 3);
        assert_eq!(clamp_retention(5), 5);
        assert_eq!(clamp_retention(10), 10);
        assert_eq!(clamp_retention(99), 10);
    }

    #[test]
    fn load_persisted_backup_retention_defaults_and_clamps() {
        let dir = tempfile::tempdir().unwrap();
        // Absent file ⇒ default 2.
        assert_eq!(load_persisted_backup_retention(dir.path()), 2);
        // Valid value round-trips.
        fs::write(dir.path().join("backup_retention.txt"), b"2").unwrap();
        assert_eq!(load_persisted_backup_retention(dir.path()), 2);
        // 0 (off) round-trips.
        fs::write(dir.path().join("backup_retention.txt"), b"0").unwrap();
        assert_eq!(load_persisted_backup_retention(dir.path()), 0);
        // Out-of-range is clamped.
        fs::write(dir.path().join("backup_retention.txt"), b"42").unwrap();
        assert_eq!(load_persisted_backup_retention(dir.path()), 10);
        // Garbage falls back to default.
        fs::write(dir.path().join("backup_retention.txt"), b"nope").unwrap();
        assert_eq!(load_persisted_backup_retention(dir.path()), 2);
    }

    #[test]
    fn pre_restore_backup_pruning_preserves_restore_target() {
        let root = tempfile::tempdir().unwrap();
        let mods = root.path().join("mods");
        let backups = root.path().join("backups");
        fs::create_dir_all(mods.join("CurrentMod")).unwrap();
        fs::write(mods.join("CurrentMod/CurrentMod.json"), b"{}").unwrap();

        let restore_target = "backup_2026-01-01_10-00-00";
        for ts in [
            "2026-01-01_10-00-00",
            "2026-02-01_10-00-00",
            "2026-03-01_10-00-00",
            "2026-04-01_10-00-00",
            "2026-05-01_10-00-00",
        ] {
            let dir = backups.join(format!("backup_{}", ts));
            fs::create_dir_all(&dir).unwrap();
        }

        create_backup_preserving(&mods, &backups, Some(restore_target)).unwrap();

        assert!(
            backups.join(restore_target).exists(),
            "creating the pre-restore backup must not prune the backup being restored"
        );
        assert!(
            list_backups(&backups).len() <= MAX_BACKUPS,
            "retention should still keep the list bounded by pruning another old backup"
        );
    }

    #[test]
    fn create_backup_includes_config_files() {
        // Fix M-11: config files are backed up into config/ subdirectory.
        let root = tempfile::tempdir().unwrap();
        let app_data_dir = root.path(); // acts as the app data directory
        let mods = app_data_dir.join("mods");
        let backups = app_data_dir.join("backups");

        // Set up a mod.
        let modfolder = mods.join("ConfigMod");
        fs::create_dir_all(&modfolder).unwrap();
        fs::write(modfolder.join("ConfigMod.json"), b"{}").unwrap();

        // Set up config files.
        fs::write(app_data_dir.join("mod_sources.json"), b"{}").unwrap();
        fs::write(app_data_dir.join("subscriptions.json"), b"[]").unwrap();
        fs::write(app_data_dir.join("active_profile.txt"), b"default").unwrap();
        fs::write(app_data_dir.join("launch_mode.txt"), b"standard").unwrap();
        let profiles_dir = app_data_dir.join("profiles");
        fs::create_dir_all(&profiles_dir).unwrap();
        fs::write(profiles_dir.join("default.json"), b"{}").unwrap();

        let backup_name = create_backup(&mods, &backups).unwrap();
        let backup_dir = backups.join(&backup_name);

        // Mods are under mods/.
        assert!(backup_dir.join("mods/ConfigMod/ConfigMod.json").exists());
        // Config files are under config/.
        assert!(backup_dir.join("config/mod_sources.json").exists());
        assert!(backup_dir.join("config/subscriptions.json").exists());
        assert!(backup_dir.join("config/active_profile.txt").exists());
        assert!(backup_dir.join("config/launch_mode.txt").exists());
        assert!(backup_dir.join("config/profiles/default.json").exists());
    }

    #[test]
    fn restore_backup_restores_config_files() {
        // Fix M-11: restoring a new-style backup also restores config files.
        let root = tempfile::tempdir().unwrap();
        let app_data_dir = root.path();
        let mods = app_data_dir.join("mods");
        fs::create_dir_all(&mods).unwrap();

        let backup_dir = app_data_dir.join("backups");
        let snap = backup_dir.join("backup_2026-01-01_00-00-00");

        // New-style backup with mods/ and config/.
        let snap_mods = snap.join("mods");
        fs::create_dir_all(&snap_mods).unwrap();
        fs::write(snap_mods.join("Mod.dll"), "x").unwrap();

        let snap_config = snap.join("config");
        fs::create_dir_all(&snap_config).unwrap();
        fs::write(
            snap_config.join("mod_sources.json"),
            b"{\"from\":\"backup\"}",
        )
        .unwrap();
        fs::write(snap_config.join("active_profile.txt"), b"restored-profile").unwrap();

        restore_backup("backup_2026-01-01_00-00-00", &backup_dir, &mods).unwrap();

        // Mods restored.
        assert!(mods.join("Mod.dll").exists(), "mod file must be restored");
        // Config restored.
        assert!(
            app_data_dir.join("mod_sources.json").exists(),
            "mod_sources.json must be restored"
        );
        let content = fs::read_to_string(app_data_dir.join("mod_sources.json")).unwrap();
        assert!(
            content.contains("backup"),
            "restored config content must match backup"
        );
        assert!(
            app_data_dir.join("active_profile.txt").exists(),
            "active_profile.txt must be restored"
        );
    }

    #[test]
    fn list_backups_counts_mods_from_mods_subdir_not_config() {
        // Fix M-11: mod_count should only count files under mods/, not config/.
        let backups = tempfile::tempdir().unwrap();
        let snap = backups.path().join("backup_2026-01-01_10-00-00");
        let snap_mods = snap.join("mods");
        fs::create_dir_all(&snap_mods).unwrap();
        fs::write(snap_mods.join("ModA.dll"), b"a").unwrap();
        fs::write(snap_mods.join("ModB.dll"), b"b").unwrap();
        let snap_config = snap.join("config");
        fs::create_dir_all(&snap_config).unwrap();
        fs::write(snap_config.join("mod_sources.json"), b"{}").unwrap();

        let list = list_backups(backups.path());
        assert_eq!(list.len(), 1);
        // mod_count should be 2 (only mods), not 3 (mods + config).
        assert_eq!(
            list[0].mod_count, 2,
            "mod_count must count only files in mods/ subdir"
        );
        // size_bytes should include the config file too (1 + 1 + 2 = 4 bytes minimum).
        assert!(
            list[0].size_bytes >= 4,
            "size_bytes must include config files"
        );
    }

    #[test]
    fn restore_backup_removes_stale_profile_not_in_backup() {
        // A profile present in the live config but absent from the backup must
        // be removed after restore — restore is a snapshot replace, not a merge.
        let root = tempfile::tempdir().unwrap();
        let app_data_dir = root.path();
        let mods = app_data_dir.join("mods");
        fs::create_dir_all(&mods).unwrap();

        // Live config has profiles/ with an extra profile not in the backup.
        let profiles_live = app_data_dir.join("profiles");
        fs::create_dir_all(&profiles_live).unwrap();
        fs::write(profiles_live.join("default.json"), b"{}").unwrap();
        fs::write(profiles_live.join("extra.json"), b"{}").unwrap();

        // Backup has profiles/ with only "default.json".
        let backup_dir = app_data_dir.join("backups");
        let snap = backup_dir.join("backup_2026-01-01_00-00-00");
        let snap_mods = snap.join("mods");
        fs::create_dir_all(&snap_mods).unwrap();
        fs::write(snap_mods.join("Mod.dll"), b"m").unwrap();
        let snap_profiles = snap.join("config").join("profiles");
        fs::create_dir_all(&snap_profiles).unwrap();
        fs::write(snap_profiles.join("default.json"), b"{}").unwrap();
        // extra.json is intentionally absent from the backup.

        restore_backup("backup_2026-01-01_00-00-00", &backup_dir, &mods).unwrap();

        assert!(
            profiles_live.join("default.json").exists(),
            "profile from backup must be present after restore"
        );
        assert!(
            !profiles_live.join("extra.json").exists(),
            "stale profile absent from backup must be removed by restore"
        );
    }
}

/// Clamp an arbitrary retention value to the valid `0..=MAX_BACKUPS` range.
pub fn clamp_retention(value: u8) -> u8 {
    value.min(MAX_BACKUPS as u8)
}

/// Read the persisted backup-retention setting from `<config>/backup_retention.txt`.
/// Returns [`DEFAULT_BACKUP_RETENTION`] when the file is absent or unparseable,
/// preserving the historical behavior for existing users. The value is clamped
/// to `0..=MAX_BACKUPS` to defend against a hand-edited config.
pub fn load_persisted_backup_retention(config_path: &Path) -> u8 {
    let file = config_path.join("backup_retention.txt");
    match fs::read_to_string(&file) {
        Ok(raw) => match raw.trim().parse::<u8>() {
            Ok(n) => clamp_retention(n),
            Err(_) => {
                log::warn!(
                    "Ignoring unrecognized backup_retention.txt content: {:?}",
                    raw.trim()
                );
                DEFAULT_BACKUP_RETENTION
            }
        },
        Err(_) => DEFAULT_BACKUP_RETENTION,
    }
}

/// Persist the backup-retention setting to `<config>/backup_retention.txt`.
fn persist_backup_retention(config_path: &Path, value: u8) -> io::Result<()> {
    fs::write(config_path.join("backup_retention.txt"), value.to_string())
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Create a backup of the current mods directory.
#[tauri::command]
pub fn create_backup_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<String, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    let _ = fs::create_dir_all(&backup_dir);
    // An explicit "Create backup" click always honors the user's intent even
    // when automatic retention is set to 0 (off).
    let keep = manual_backup_keep(s.backup_retention);
    create_backup_preserving_keep(mods_path, &backup_dir, None, keep).map_err(|e| e.to_string())
}

/// Retention used by the explicit "Create backup" command. With automatic
/// backups off (retention 0) we prune to the historical MAX_BACKUPS cap —
/// never to 1, which would silently delete every other backup a backups-off
/// user deliberately created by hand.
fn manual_backup_keep(retention: u8) -> usize {
    match clamp_retention(retention) {
        0 => MAX_BACKUPS,
        n => n as usize,
    }
}

/// Return the user-configured backup-retention count (`0..=MAX_BACKUPS`).
#[tauri::command]
pub fn get_backup_retention(state: tauri::State<'_, AppState>) -> std::result::Result<u8, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(clamp_retention(s.backup_retention))
}

/// Persist a new backup-retention count. Validated/clamped to `0..=MAX_BACKUPS`
/// server-side. `0` disables automatic backups (existing backups are kept).
#[tauri::command]
pub fn set_backup_retention(
    count: u8,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<u8, String> {
    let clamped = clamp_retention(count);
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let config_path = s.config_path.clone();
    if let Err(e) = persist_backup_retention(&config_path, clamped) {
        log::error!("Couldn't persist backup_retention: {}", e);
        return Err(format!("Could not save backup retention: {}", e));
    }
    s.backup_retention = clamped;
    log::info!("Backup retention set to {}", clamped);
    Ok(clamped)
}

/// Create a backup while preserving another named backup from retention.
#[tauri::command]
pub fn create_backup_preserving_cmd(
    preserve_name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<String, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    let _ = fs::create_dir_all(&backup_dir);
    create_backup_preserving(mods_path, &backup_dir, Some(&preserve_name))
        .map_err(|e| e.to_string())
}

/// List all available backups.
#[tauri::command]
pub fn list_backups_cmd(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<BackupInfo>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let backup_dir = s.config_path.join("backups");
    Ok(list_backups(&backup_dir))
}

/// Restore a specific backup.
#[tauri::command]
pub fn restore_backup_cmd(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    restore_backup(&name, &backup_dir, mods_path).map_err(|e| e.to_string())
}

/// Delete a specific backup.
#[tauri::command]
pub fn delete_backup_cmd(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let backup_dir = s.config_path.join("backups");
    delete_backup(&name, &backup_dir).map_err(|e| e.to_string())
}

/// Reset to vanilla by moving all mods to disabled.
#[tauri::command]
pub fn reset_to_vanilla_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<(), String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    reset_to_vanilla(mods_path, disabled_path).map_err(|e| e.to_string())
}
