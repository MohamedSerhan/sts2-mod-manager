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

    // Simple VDF parser: look for "path" keys with string values.
    // Format: "path"		"/some/path"
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
/// Checks for sts2.dll and SlayTheSpire2.pck.
pub fn validate_game_path(path: &Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }

    let has_dll = path.join("sts2.dll").exists();
    let has_pck = path.join("SlayTheSpire2.pck").exists();

    has_dll || has_pck
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

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Auto-detect the game path and store it in state.
#[tauri::command]
pub fn detect_game_path(state: tauri::State<'_, AppState>) -> std::result::Result<Option<String>, String> {
    let path = detect_game();
    if let Some(ref p) = path {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.set_game_path(p.clone());
    }
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

/// Manually set the game path after validation.
#[tauri::command]
pub fn set_game_path(path: String, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let game_path = PathBuf::from(&path);
    if !validate_game_path(&game_path) {
        return Err(AppError::GameNotFound(format!(
            "Invalid game path: {}. Expected sts2.dll or SlayTheSpire2.pck.",
            path
        ))
        .to_string());
    }
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.set_game_path(game_path);
    Ok(true)
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
    Ok(GameInfo {
        game_path: s.game_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        mods_path: s.mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        disabled_mods_path: s.disabled_mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        valid,
    })
}
