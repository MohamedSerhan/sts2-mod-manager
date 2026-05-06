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

/// Create a timestamped backup of the current mods directory.
///
/// Copies all files from `mods_path` into a new subdirectory under
/// `backup_dir` named `backup_YYYY-MM-DD_HH-MM-SS`.
/// Returns the backup directory name.
pub fn create_backup(mods_path: &Path, backup_dir: &Path) -> Result<String> {
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
    Ok(backup_name)
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
    let src = backup_dir.join(backup_name);
    if !src.exists() {
        log::error!("restore_backup: backup '{}' not found at {}", backup_name, src.display());
        return Err(crate::error::AppError::Other(format!(
            "Backup '{}' not found",
            backup_name
        )));
    }

    log::info!("Restoring backup '{}' into {}", backup_name, mods_path.display());

    // Clear current mods
    if mods_path.exists() {
        for entry in fs::read_dir(mods_path)?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
        }
    } else {
        fs::create_dir_all(mods_path)?;
    }

    // Copy backup contents into mods
    copy_dir_recursive(&src, mods_path)?;

    log::info!("Backup '{}' restored successfully", backup_name);
    Ok(())
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
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let backup_dir = s.config_path.join("backups");
    restore_backup(&name, &backup_dir, mods_path).map_err(|e| e.to_string())
}

/// Reset to vanilla by moving all mods to disabled.
#[tauri::command]
pub fn reset_to_vanilla_cmd(state: tauri::State<'_, AppState>) -> std::result::Result<(), String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;
    reset_to_vanilla(mods_path, disabled_path).map_err(|e| e.to_string())
}
