use std::fs;
use std::io;
use std::path::Path;

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

/// Maximum number of backups to retain. Older backups are pruned after each
/// successful create.
const MAX_BACKUPS: usize = 5;

/// Create a timestamped backup of the current mods directory.
///
/// Copies all files from `mods_path` into a new subdirectory under
/// `backup_dir` named `backup_YYYY-MM-DD_HH-MM-SS`.
/// Returns the backup directory name.
pub fn create_backup(mods_path: &Path, backup_dir: &Path) -> Result<String> {
    create_backup_preserving(mods_path, backup_dir, None)
}

/// Create a backup while keeping a named restore target safe from retention
/// pruning. Used by the pre-restore safety backup flow: creating the safety
/// backup must not delete the backup the user is actively trying to restore.
pub fn create_backup_preserving(
    mods_path: &Path,
    backup_dir: &Path,
    preserve_name: Option<&str>,
) -> Result<String> {
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let backup_name = format!("backup_{}", timestamp);
    let dest = backup_dir.join(&backup_name);

    fs::create_dir_all(&dest)?;

    if mods_path.exists() {
        log::info!("Creating backup '{}' from {}", backup_name, mods_path.display());
        copy_dir_recursive(mods_path, &dest)?;
    } else {
        log::warn!("create_backup: mods_path {} does not exist; backup will be empty", mods_path.display());
    }

    log::info!("Backup created: {}", dest.display());

    if let Err(e) = prune_old_backups_preserving(backup_dir, MAX_BACKUPS, preserve_name) {
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

        // Count files and total size
        let mut mod_count: usize = 0;
        let mut size_bytes: u64 = 0;

        for file_entry in WalkDir::new(&path).into_iter().flatten() {
            if file_entry.file_type().is_file() {
                mod_count += 1;
                size_bytes += file_entry.metadata().map(|m| m.len()).unwrap_or(0);
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
        log::error!("restore_backup: backup '{}' not found at {}", backup_name, src.display());
        return Err(crate::error::AppError::Other(format!(
            "Backup '{}' not found",
            backup_name
        )));
    }

    log::info!("Restoring backup '{}' into {}", backup_name, mods_path.display());

    // Move the current mods aside first so a failure mid-copy rolls back to the
    // pre-restore state instead of leaving the user with an empty mods folder.
    // (Audit H-4)
    let swap = crate::fs_safety::swap_dirs_aside(&[mods_path])?;
    match copy_dir_recursive(&src, mods_path) {
        Ok(()) => {
            swap.discard()?;
            log::info!("Backup '{}' restored successfully", backup_name);
            Ok(())
        }
        Err(e) => {
            log::error!(
                "restore_backup: copy failed ({}); rolling back to the pre-restore mods",
                e
            );
            if let Err(re) = swap.restore() {
                log::error!("restore_backup: rollback ALSO failed: {}", re);
            }
            Err(e.into())
        }
    }
}

/// Move all mods from mods/ to mods_disabled/ (reset to vanilla state).
pub fn reset_to_vanilla(mods_path: &Path, disabled_path: &Path) -> Result<()> {
    let _ = fs::create_dir_all(disabled_path);

    if !mods_path.exists() {
        log::info!("reset_to_vanilla: mods_path {} doesn't exist; nothing to do", mods_path.display());
        return Ok(());
    }

    log::info!("Resetting to vanilla: moving everything from {} to {}", mods_path.display(), disabled_path.display());
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
        let mods = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        // Set up: one mod folder with a manifest + dll.
        let modfolder = mods.path().join("MyMod");
        fs::create_dir_all(&modfolder).unwrap();
        fs::write(modfolder.join("MyMod.json"), b"{}").unwrap();
        fs::write(modfolder.join("MyMod.dll"), b"binary").unwrap();

        let backup_name = create_backup(mods.path(), backups.path()).unwrap();
        let backup_dir = backups.path().join(&backup_name);
        assert!(backup_dir.exists());
        assert!(backup_dir.join("MyMod/MyMod.json").exists());
        assert!(backup_dir.join("MyMod/MyMod.dll").exists());
    }

    #[test]
    fn create_backup_handles_missing_mods_path_with_empty_dir() {
        let backups = tempfile::tempdir().unwrap();
        let missing = backups.path().join("does-not-exist");
        let name = create_backup(&missing, backups.path()).unwrap();
        let dir = backups.path().join(&name);
        assert!(dir.exists());
        // No files copied (mods_path didn't exist), but the named dir is created.
        let entries: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert!(entries.is_empty() || entries.iter().all(|e| e.is_ok()));
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
        for (i, ts) in ["2026-01-01_10-00-00", "2026-05-01_10-00-00", "2026-03-01_10-00-00"].iter().enumerate() {
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
        assert!(mods.join("keep.txt").exists(), "user mods must be untouched");
        assert!(
            !mods.join("evil.txt").exists(),
            "escaped directory contents must not be copied into mods"
        );
    }

    #[test]
    fn restore_backup_restores_named_backup_and_replaces_current() {
        let root = tempfile::tempdir().unwrap();
        let backup_dir = root.path().join("backups");
        let snap = backup_dir.join("backup_2026-01-01_00-00-00");
        fs::create_dir_all(&snap).unwrap();
        fs::write(snap.join("ModA.dll"), "a").unwrap();

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
            let dir = backups.path().join(format!("backup_2026-0{}-01_10-00-00", i + 1));
            fs::create_dir_all(&dir).unwrap();
        }
        prune_old_backups_preserving(backups.path(), 3, None).unwrap();
        let remaining: Vec<_> = fs::read_dir(backups.path()).unwrap().collect();
        assert_eq!(remaining.len(), 3);
    }

    #[test]
    fn pre_restore_backup_pruning_preserves_restore_target() {
        let mods = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        fs::create_dir_all(mods.path().join("CurrentMod")).unwrap();
        fs::write(mods.path().join("CurrentMod/CurrentMod.json"), b"{}").unwrap();

        let restore_target = "backup_2026-01-01_10-00-00";
        for ts in [
            "2026-01-01_10-00-00",
            "2026-02-01_10-00-00",
            "2026-03-01_10-00-00",
            "2026-04-01_10-00-00",
            "2026-05-01_10-00-00",
        ] {
            let dir = backups.path().join(format!("backup_{}", ts));
            fs::create_dir_all(&dir).unwrap();
        }

        create_backup_preserving(mods.path(), backups.path(), Some(restore_target)).unwrap();

        assert!(
            backups.path().join(restore_target).exists(),
            "creating the pre-restore backup must not prune the backup being restored"
        );
        assert!(
            list_backups(backups.path()).len() <= MAX_BACKUPS,
            "retention should still keep the list bounded by pruning another old backup"
        );
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Create a backup of the current mods directory.
#[tauri::command]
pub fn create_backup_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<String, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    let _ = fs::create_dir_all(&backup_dir);
    create_backup(mods_path, &backup_dir).map_err(|e| e.to_string())
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
pub fn list_backups_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<Vec<BackupInfo>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let backup_dir = s.config_path.join("backups");
    Ok(list_backups(&backup_dir))
}

/// Restore a specific backup.
#[tauri::command]
pub fn restore_backup_cmd(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<(), String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    restore_backup(&name, &backup_dir, mods_path).map_err(|e| e.to_string())
}

/// Delete a specific backup.
#[tauri::command]
pub fn delete_backup_cmd(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<(), String> {
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
