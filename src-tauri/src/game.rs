use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// Information about the detected game installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameInfo {
    pub game_path: Option<String>,
    pub mods_path: Option<String>,
    pub disabled_mods_path: Option<String>,
    pub mods_count: usize,
    pub disabled_count: usize,
    pub valid: bool,
}

/// Find the Steam installation path based on OS.
pub fn find_steam_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir()?;
        let paths = [
            home.join(".steam/steam"),
            home.join(".local/share/Steam"),
        ];
        paths.into_iter().find(|p| p.exists())
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        let path = home.join("Library/Application Support/Steam");
        if path.exists() { Some(path) } else { None }
    }

    #[cfg(target_os = "windows")]
    {
        let paths = [
            PathBuf::from(r"C:\Program Files (x86)\Steam"),
            PathBuf::from(r"C:\Program Files\Steam"),
        ];
        paths.into_iter().find(|p| p.exists())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Parse Steam's libraryfolders.vdf to extract library folder paths.
pub fn parse_library_folders(steam_path: &Path) -> Vec<PathBuf> {
    let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
    let mut libraries = vec![steam_path.to_path_buf()];

    let content = match std::fs::read_to_string(&vdf_path) {
        Ok(c) => c,
        Err(_) => return libraries,
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"path\"") {
            let value = rest.trim().trim_matches('"');
            if !value.is_empty() {
                let path = PathBuf::from(value);
                if path.exists() && !libraries.contains(&path) {
                    libraries.push(path);
                }
            }
        }
    }

    libraries
}

/// Look for "Slay the Spire 2" in the given Steam library directories.
pub fn find_game_in_libraries(libraries: &[PathBuf]) -> Option<PathBuf> {
    for lib in libraries {
        let game_path = lib
            .join("steamapps")
            .join("common")
            .join("Slay the Spire 2");
        if game_path.exists() {
            return Some(game_path);
        }
    }
    None
}

/// Validate that a path is a legitimate STS2 installation.
pub fn validate_game_path(path: &Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }

    let has_exe = path.join("SlayTheSpire2.exe").exists()
        || path.join("Slay the Spire 2.exe").exists();
    let has_dll = path.join("sts2.dll").exists();
    let has_pck = path.join("SlayTheSpire2.pck").exists();
    // macOS install ships the game as a .app bundle (a directory) inside the
    // Steam "common/Slay the Spire 2" folder.
    let has_app = path.join("SlayTheSpire2.app").is_dir();

    has_exe || has_dll || has_pck || has_app
}

/// Normalize a user-provided game path. On macOS the actual game is a
/// `SlayTheSpire2.app` bundle inside the "Slay the Spire 2" Steam folder; if
/// the user points us directly at the `.app`, treat its parent as the game
/// path so `mods/` and `mods_disabled/` end up next to the bundle.
fn normalize_game_path(path: PathBuf) -> PathBuf {
    if path.extension().and_then(|e| e.to_str()) == Some("app") {
        if let Some(parent) = path.parent() {
            return parent.to_path_buf();
        }
    }
    path
}

/// Names the STS2 process can appear under across platforms.
/// Matched case-insensitively, with platform-appropriate `.exe` stripping.
const GAME_PROCESS_NAMES: &[&str] = &[
    "SlayTheSpire2",
    "Slay the Spire 2",
];

/// Check whether STS2 is currently running.
/// File operations on the mods folder while the game is up can corrupt save state,
/// crash the game, or leave the install in a half-applied state — callers gate
/// mutating commands on this.
pub fn is_game_running() -> bool {
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy();
        let stripped = name
            .strip_suffix(".exe")
            .or_else(|| name.strip_suffix(".EXE"))
            .unwrap_or(&name);
        for target in GAME_PROCESS_NAMES {
            if stripped.eq_ignore_ascii_case(target) {
                return true;
            }
        }
    }
    false
}

/// Guard helper: returns an error if STS2 is running, suitable for use in
/// Tauri commands that mutate the mods folder or profile state.
pub fn ensure_game_not_running() -> std::result::Result<(), String> {
    if is_game_running() {
        Err("Slay the Spire 2 is currently running. Close the game before changing mods or profiles to avoid corruption.".to_string())
    } else {
        Ok(())
    }
}

/// Tauri command: report whether the game process is currently running.
/// The frontend polls this to gate UI controls and show a banner.
#[tauri::command]
pub fn is_game_running_cmd() -> bool {
    is_game_running()
}

/// Auto-detect the STS2 game installation.
pub fn detect_game() -> Option<PathBuf> {
    let steam_path = find_steam_path()?;
    let libraries = parse_library_folders(&steam_path);
    let game_path = find_game_in_libraries(&libraries)?;

    if validate_game_path(&game_path) {
        Some(game_path)
    } else {
        None
    }
}

/// Count .json files in a directory (rough mod count).
fn count_mods_in_dir(dir: &Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    let mut count = 0;
    // Count top-level .json files
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
                count += 1;
            } else if path.is_dir() {
                // Count subdirectory mods (one mod per subfolder)
                let has_json = std::fs::read_dir(&path)
                    .map(|entries| {
                        entries.flatten().any(|e| {
                            e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        })
                    })
                    .unwrap_or(false);
                let has_dll = std::fs::read_dir(&path)
                    .map(|entries| {
                        entries.flatten().any(|e| {
                            e.path().extension().and_then(|ext| ext.to_str()) == Some("dll")
                        })
                    })
                    .unwrap_or(false);
                if has_json || has_dll {
                    count += 1;
                }
            }
        }
    }
    // Also count DLL-only mods at top level (DLLs without matching .json)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("dll") {
                let json_path = path.with_extension("json");
                if !json_path.exists() {
                    count += 1;
                }
            }
        }
    }
    count
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Auto-detect the game path and store it in state. Returns GameInfo.
#[tauri::command]
pub fn detect_game_path(state: tauri::State<'_, AppState>) -> std::result::Result<GameInfo, String> {
    let path = detect_game();
    if let Some(ref p) = path {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.set_game_path(p.clone());
    }
    // Return current game info
    get_game_info(state)
}

/// Manually set the game path after validation. Returns GameInfo.
#[tauri::command]
pub fn set_game_path(path: String, state: tauri::State<'_, AppState>) -> std::result::Result<GameInfo, String> {
    let game_path = normalize_game_path(PathBuf::from(&path));
    if !validate_game_path(&game_path) {
        return Err(AppError::GameNotFound(format!(
            "Invalid game path: {}. Could not find STS2 game files.",
            path
        ))
        .to_string());
    }
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.set_game_path(game_path);
    drop(s);
    get_game_info(state)
}

/// Return current game info from state.
#[tauri::command]
pub fn get_game_info(state: tauri::State<'_, AppState>) -> std::result::Result<GameInfo, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let valid = s
        .game_path
        .as_ref()
        .map(|p| validate_game_path(p))
        .unwrap_or(false);

    let mods_count = s.mods_path.as_ref().map(|p| count_mods_in_dir(p)).unwrap_or(0);
    let disabled_count = s.disabled_mods_path.as_ref().map(|p| count_mods_in_dir(p)).unwrap_or(0);

    Ok(GameInfo {
        game_path: s.game_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        mods_path: s.mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        disabled_mods_path: s.disabled_mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        mods_count,
        disabled_count,
        valid,
    })
}

/// Open the mods folder in the system file explorer.
/// Falls back to game folder if mods folder doesn't exist.
#[tauri::command]
pub fn open_mods_folder(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;

    // Try mods folder first
    if let Some(ref mods_path) = s.mods_path {
        if mods_path.exists() {
            open::that_detached(mods_path)
                .map_err(|e| format!("Failed to open mods folder: {}", e))?;
            return Ok(true);
        }
    }

    // Fall back to game folder
    if let Some(ref game_path) = s.game_path {
        if game_path.exists() {
            open::that_detached(game_path)
                .map_err(|e| format!("Failed to open game folder: {}", e))?;
            return Ok(true);
        }
    }

    Err("No game or mods folder found. Set the game path in Settings.".to_string())
}

/// Open the game folder in the system file explorer.
#[tauri::command]
pub fn open_game_folder(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;

    if let Some(ref game_path) = s.game_path {
        if game_path.exists() {
            open::that_detached(game_path)
                .map_err(|e| format!("Failed to open game folder: {}", e))?;
            return Ok(true);
        }
    }

    Err("Game folder not found. Set the game path in Settings.".to_string())
}

/// Launch STS2 via Steam with optional auto-backup.
/// If vanilla_mode was active (from a previous Launch Vanilla), restore mods first.
#[tauri::command]
pub fn launch_game(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    // If we were in vanilla mode, restore all mods first
    if s.vanilla_mode {
        if let (Some(ref mods_path), Some(ref disabled_path)) = (s.mods_path.clone(), s.disabled_mods_path.clone()) {
            log::info!("Restoring mods from vanilla mode before launch");
            restore_all_from_disabled(disabled_path, mods_path);
        }
        s.vanilla_mode = false;
        // Persist the flag reset
        let flag_path = s.config_path.join(".vanilla_mode");
        let _ = std::fs::remove_file(&flag_path);
    }

    // Auto-backup before launch
    if let Some(ref mods_path) = s.mods_path {
        let backup_dir = s.config_path.join("backups");
        let _ = std::fs::create_dir_all(&backup_dir);
        match crate::backup::create_backup(mods_path, &backup_dir) {
            Ok(name) => log::info!("Pre-launch backup created: {}", name),
            Err(e) => log::warn!("Failed to create pre-launch backup: {}", e),
        }
    }
    drop(s);

    // STS2 Steam App ID: 2868840
    open::that_in_background("steam://rungameid/2868840");
    Ok(true)
}

/// Launch STS2 in vanilla mode (disable all mods temporarily).
/// Mods will be automatically restored on the next normal launch.
#[tauri::command]
pub fn launch_vanilla(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    ensure_game_not_running()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();

    // Auto-backup
    let backup_dir = s.config_path.join("backups");
    let _ = std::fs::create_dir_all(&backup_dir);
    let _ = crate::backup::create_backup(&mods_path, &backup_dir);

    // Move all mods to disabled
    crate::backup::reset_to_vanilla(&mods_path, &disabled_path).map_err(|e| e.to_string())?;

    // Set vanilla mode flag so next launch_game restores mods
    s.vanilla_mode = true;
    let flag_path = s.config_path.join(".vanilla_mode");
    let _ = std::fs::write(&flag_path, "1");
    drop(s);

    // Launch
    open::that_in_background("steam://rungameid/2868840");
    Ok(true)
}

/// Move all files/dirs from disabled back to mods (restore from vanilla).
fn restore_all_from_disabled(disabled_path: &std::path::Path, mods_path: &std::path::Path) {
    let _ = std::fs::create_dir_all(mods_path);
    if let Ok(entries) = std::fs::read_dir(disabled_path) {
        for entry in entries.flatten() {
            let src = entry.path();
            let dest = mods_path.join(entry.file_name());
            if src.is_dir() {
                let _ = crate::mods::move_directory(&src, &dest);
            } else {
                let _ = std::fs::rename(&src, &dest).or_else(|_| {
                    std::fs::copy(&src, &dest).and_then(|_| std::fs::remove_file(&src))
                });
            }
        }
    }
}

/// Get the active profile name.
#[tauri::command]
pub fn get_active_profile(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<String>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.active_profile.clone())
}

/// Set the active profile name (also persists to disk).
#[tauri::command]
pub fn set_active_profile(
    name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.active_profile = name.clone();
    // Persist to disk so it survives app restarts
    let path = s.config_path.join("active_profile.txt");
    if let Some(ref n) = name {
        let _ = std::fs::write(&path, n);
    } else {
        let _ = std::fs::remove_file(&path);
    }
    Ok(true)
}

/// Set the GitHub personal access token (store in state and keyring).
#[tauri::command]
pub fn set_github_token(
    token: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.github_token = Some(token.clone());

    if let Ok(entry) = keyring::Entry::new("sts2-mod-manager", "github-token") {
        let _ = entry.set_password(&token);
    }

    Ok(true)
}

/// Check which API keys are configured (without exposing their values).
#[tauri::command]
pub fn get_api_key_status(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ApiKeyStatus, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(ApiKeyStatus {
        nexus_api_key_set: s.nexus_api_key.is_some(),
        github_token_set: s.github_token.is_some(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyStatus {
    pub nexus_api_key_set: bool,
    pub github_token_set: bool,
}

/// Get the path to the log file.
#[tauri::command]
pub fn get_log_path(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<String, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let log_path = s.config_path.join("sts2mm.log");
    Ok(log_path.to_string_lossy().to_string())
}

/// Open the log file in the system's default text editor.
/// Falls back to revealing the parent directory in the file explorer if the
/// file cannot be opened directly (e.g. no handler registered for `.log`).
#[tauri::command]
pub fn open_log_file(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let (log_path, parent) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let log_path = s.config_path.join("sts2mm.log");
        let parent = s.config_path.clone();
        (log_path, parent)
    };

    if log_path.exists() {
        match open::that_detached(&log_path) {
            Ok(()) => return Ok(true),
            Err(e) => {
                log::warn!(
                    "open::that_detached failed for log file {:?}: {}. Falling back to parent dir.",
                    log_path, e
                );
            }
        }
    } else {
        log::info!("Log file {:?} does not exist yet; opening config dir instead.", log_path);
    }

    // Fall back to opening the parent (config) directory so the user can find the log.
    if parent.exists() {
        open::that_detached(&parent).map_err(|e| {
            format!("Failed to open log directory {}: {}", parent.display(), e)
        })?;
        Ok(true)
    } else {
        Err(format!("Log file and config directory not found at {}", parent.display()))
    }
}

