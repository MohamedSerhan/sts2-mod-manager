use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::{AppState, LaunchMode};

/// STS2's Steam AppID. Used to build the `steam://rungameid/<id>` URL
/// the Steam launcher consumes.
const STS2_STEAM_APPID: &str = "2868840";

/// Information about the detected game installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameInfo {
    pub game_path: Option<String>,
    pub mods_path: Option<String>,
    pub disabled_mods_path: Option<String>,
    pub mods_count: usize,
    pub disabled_count: usize,
    pub valid: bool,
    /// Detected STS2 build version, e.g. "0.103.2". None if release_info.json
    /// is missing or unreadable. Frontend uses this to display the user's
    /// game version next to mod-version warnings ("needs game ≥ X.Y.Z, you
    /// have A.B.C").
    pub game_version: Option<String>,
}

/// Find the Steam installation path based on OS.
///
/// Windows: Steam writes `InstallPath` into both HKCU\Software\Valve\Steam
/// (current user) and HKLM\Software\WOW6432Node\Valve\Steam (machine-wide).
/// We try the registry first since users routinely install Steam on a
/// non-default drive (D:, E:, etc.) and the hardcoded Program Files paths
/// miss those — that was the dominant cause of "Auto-detect always fails"
/// reports. Hardcoded paths remain as a fallback in case the registry
/// values are corrupt or stripped by something like Steam's deletion
/// uninstall.
///
/// Linux: covers native, Flatpak, and Snap installs.
///
/// macOS: only one canonical location, but kept consistent with the
/// "scan multiple candidates" shape so adding e.g. an Application Support
/// alias is a one-line change later.
pub fn find_steam_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir()?;
        let paths = [
            // Native install — most distros.
            home.join(".steam/steam"),
            home.join(".local/share/Steam"),
            // Flatpak (com.valvesoftware.Steam) — its sandboxed home is
            // a separate tree under ~/.var/app.
            home.join(".var/app/com.valvesoftware.Steam/.steam/steam"),
            home.join(".var/app/com.valvesoftware.Steam/data/Steam"),
            // Snap install.
            home.join("snap/steam/common/.local/share/Steam"),
        ];
        paths.into_iter().find(|p| p.exists())
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        let paths = [home.join("Library/Application Support/Steam")];
        paths.into_iter().find(|p| p.exists())
    }

    #[cfg(target_os = "windows")]
    {
        // Registry first.
        if let Some(p) = find_steam_path_from_registry() {
            log::info!("Steam path from registry: {}", p.display());
            return Some(p);
        }

        // Fallback: default install locations on the system drive. Worth
        // probing all common drive letters so a Steam install on D: is
        // found even if the registry got nuked.
        let candidates: Vec<PathBuf> = ["C", "D", "E", "F", "G", "H"]
            .iter()
            .flat_map(|drive| {
                [
                    format!(r"{}:\Program Files (x86)\Steam", drive),
                    format!(r"{}:\Program Files\Steam", drive),
                    format!(r"{}:\Steam", drive),
                    format!(r"{}:\SteamLibrary", drive),
                ]
                .map(PathBuf::from)
            })
            .collect();
        candidates.into_iter().find(|p| p.exists())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Read Steam's install path from the Windows registry. Tries HKCU first
/// (per-user install, more common on modern Windows) then HKLM (machine-
/// wide). Returns None if Steam isn't registered or the value is empty.
#[cfg(target_os = "windows")]
fn find_steam_path_from_registry() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    // (hive, subkey, value name). Steam writes "SteamPath" under HKCU and
    // "InstallPath" under HKLM. Both are forward-slash-delimited absolute
    // paths.
    let candidates: &[(_, &str, &str)] = &[
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];

    for (hive, subkey, value_name) in candidates {
        let key = match RegKey::predef(*hive).open_subkey(subkey) {
            Ok(k) => k,
            Err(_) => continue,
        };
        let value: String = match key.get_value(value_name) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if path.exists() {
            return Some(path);
        }
        log::warn!(
            "Registry says Steam is at {} but the path doesn't exist on disk",
            path.display()
        );
    }
    None
}

/// Parse Steam's libraryfolders.vdf to extract library folder paths.
///
/// VDF escapes backslashes (`"D:\\SteamLibrary"` in the file represents
/// `D:\SteamLibrary`), so we have to unescape after extracting the
/// quoted value or the resulting `PathBuf` won't match anything on
/// disk and alt-drive Steam libraries get silently skipped.
pub fn parse_library_folders(steam_path: &Path) -> Vec<PathBuf> {
    let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
    let mut libraries = vec![steam_path.to_path_buf()];

    let content = match std::fs::read_to_string(&vdf_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "Couldn't read libraryfolders.vdf at {}: {} — auto-detect will only see the main Steam install, missing any alt-drive libraries",
                vdf_path.display(), e
            );
            return libraries;
        }
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"path\"") {
            // Pull out the value between the second pair of quotes on
            // the line. Then unescape VDF: backslash-pair → backslash,
            // backslash-quote → quote. The previous parser just
            // trim_matches('"')'d the value, which left literal `\\`
            // sequences in the path and broke .exists() on Windows
            // alt-drive libraries.
            let after_first_quote = match rest.find('"') {
                Some(i) => &rest[i + 1..],
                None => continue,
            };
            let raw = match after_first_quote.rfind('"') {
                Some(i) => &after_first_quote[..i],
                None => continue,
            };
            let unescaped = raw.replace("\\\\", "\\").replace("\\\"", "\"");
            if unescaped.is_empty() {
                continue;
            }
            let path = PathBuf::from(&unescaped);
            if path.exists() && !libraries.contains(&path) {
                log::debug!("Steam library discovered via VDF: {}", path.display());
                libraries.push(path);
            } else if !path.exists() {
                log::debug!(
                    "VDF lists Steam library at {} but it doesn't exist on disk — skipping",
                    path.display()
                );
            }
        }
    }

    libraries
}

/// Look for an STS2 install in the given Steam library directories.
///
/// Strategy:
///   1. Fast path: check `steamapps/common/Slay the Spire 2`. This is the
///      depot folder name Mega Crit ships today and it's how every existing
///      install resolves.
///   2. Fallback: scan `steamapps/common/*` for any subdir that
///      `validate_game_path` accepts (looks for SlayTheSpire2.exe / .dll /
///      .pck / .app). This means the auto-detector keeps working even if
///      MC renames the depot folder for the 1.0 launch (e.g. dropping the
///      "2", adding "Definitive Edition", etc.) — the file-shape check is
///      what actually identifies the game, not the folder name.
pub fn find_game_in_libraries(libraries: &[PathBuf]) -> Option<PathBuf> {
    // Pass 1: literal name (current convention).
    for lib in libraries {
        let game_path = lib
            .join("steamapps")
            .join("common")
            .join("Slay the Spire 2");
        if game_path.exists() && validate_game_path(&game_path) {
            return Some(game_path);
        }
    }

    // Pass 2: scan common/* for anything that looks like STS2.
    for lib in libraries {
        let common = lib.join("steamapps").join("common");
        let entries = match std::fs::read_dir(&common) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // A second check on name pattern keeps us fast on big libraries —
            // skip directories that obviously aren't STS2 before doing the
            // file-system probe in validate_game_path.
            let name_lower = entry
                .file_name()
                .to_string_lossy()
                .to_lowercase();
            let looks_like_sts2 = name_lower.contains("slay")
                || name_lower.contains("spire")
                || name_lower.contains("sts2");
            if !looks_like_sts2 {
                continue;
            }
            if validate_game_path(&path) {
                log::info!(
                    "Auto-detected STS2 at non-default folder name: {}",
                    path.display()
                );
                return Some(path);
            }
        }
    }
    None
}

/// Validate that a path is a legitimate STS2 installation.
///
/// Per-platform shape:
///   - Windows: `SlayTheSpire2.exe` (or "Slay the Spire 2.exe" with the
///     space variant some builds use) — the `.pck` is always next to it
///     and acts as the cross-platform fallback signature.
///   - macOS:   `SlayTheSpire2.app` bundle (a directory) lives inside
///     Steam's common/Slay the Spire 2 folder; we accept the parent so
///     `mods/` resolves correctly.
///   - Linux:   Godot ships a stripped binary alongside the `.pck`. The
///     binary name varies (`SlayTheSpire2`, `SlayTheSpire2.x86_64`,
///     `Slay the Spire 2.x86_64`) so we don't pin a single executable
///     name — `.pck` presence is what identifies the install.
///
/// `.pck` is also accepted on every platform as a last-resort signature
/// because it's the one file Godot guarantees ships with every build —
/// catches the case where the user pointed us at e.g. an extracted ZIP
/// of the game folder.
pub fn validate_game_path(path: &Path) -> bool {
    if !path.exists() || !path.is_dir() {
        return false;
    }

    // Cross-platform signature: the Godot project archive. Always
    // present, regardless of OS.
    let has_pck = path.join("SlayTheSpire2.pck").exists();

    #[cfg(target_os = "windows")]
    {
        let has_exe = path.join("SlayTheSpire2.exe").exists()
            || path.join("Slay the Spire 2.exe").exists();
        let has_dll = path.join("sts2.dll").exists();
        has_exe || has_dll || has_pck
    }

    #[cfg(target_os = "macos")]
    {
        let has_app = path.join("SlayTheSpire2.app").is_dir()
            || path.join("Slay the Spire 2.app").is_dir();
        has_app || has_pck
    }

    #[cfg(target_os = "linux")]
    {
        // Godot's Linux export drops a stripped ELF binary next to the
        // .pck. Names vary by export config, so we check any plausible
        // shape rather than pin one.
        let has_binary = path.join("SlayTheSpire2").is_file()
            || path.join("SlayTheSpire2.x86_64").is_file()
            || path.join("Slay the Spire 2").is_file()
            || path.join("Slay the Spire 2.x86_64").is_file();
        has_binary || has_pck
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        has_pck
    }
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
    let steam_path = match find_steam_path() {
        Some(p) => p,
        None => {
            log::warn!(
                "Auto-detect: couldn't find Steam. Checked the registry (Windows), \
                 standard install locations across common drive letters, and the \
                 conventional ~/.steam, Library/Application Support/Steam, and \
                 Flatpak/Snap paths (Linux/macOS). User will need to pick the \
                 game folder manually."
            );
            return None;
        }
    };
    log::info!("Auto-detect: Steam at {}", steam_path.display());

    let libraries = parse_library_folders(&steam_path);
    log::info!(
        "Auto-detect: scanning {} Steam library/libraries: {:?}",
        libraries.len(),
        libraries.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    );

    let game_path = match find_game_in_libraries(&libraries) {
        Some(p) => p,
        None => {
            log::warn!(
                "Auto-detect: Steam found at {}, but no Slay the Spire 2 install in any of \
                 its libraries. Check that STS2 is installed via Steam and the libraryfolders.vdf \
                 lists the right drives.",
                steam_path.display()
            );
            return None;
        }
    };

    if validate_game_path(&game_path) {
        log::info!("Auto-detect: STS2 at {}", game_path.display());
        Some(game_path)
    } else {
        log::warn!(
            "Auto-detect: found a candidate folder at {} but it doesn't validate as STS2",
            game_path.display()
        );
        None
    }
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

    // Use the same deduped scan logic the Mods view uses, so the count in
    // Settings matches the Mods page exactly. count_mods_in_dir was a raw
    // filesystem-entry count and would double-count duplicates that the
    // Mods view's normalize-name dedup collapses.
    let mods_count = s
        .mods_path
        .as_ref()
        .map(|p| crate::mods::scan_mods(p).len())
        .unwrap_or(0);
    let disabled_count = s
        .disabled_mods_path
        .as_ref()
        .map(|p| crate::mods::scan_disabled_mods(p).len())
        .unwrap_or(0);

    Ok(GameInfo {
        game_path: s.game_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        mods_path: s.mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        disabled_mods_path: s.disabled_mods_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        mods_count,
        disabled_count,
        valid,
        game_version: s.game_version.clone(),
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

/// Start the game using the user's configured launch mode. Returns an
/// error string when the chosen mode can't run on the current install
/// (e.g. Direct + Proton-only on Linux). No auto-fallback: Direct users
/// explicitly opted out of Steam, so silently reaching for it would
/// defeat the purpose of the setting.
fn spawn_game(mode: LaunchMode, game_path: Option<&Path>) -> std::result::Result<(), String> {
    log::info!("Launching game via {}", mode.as_str());
    match mode {
        LaunchMode::Steam => {
            open::that_in_background(format!("steam://rungameid/{}", STS2_STEAM_APPID));
            Ok(())
        }
        LaunchMode::Direct => spawn_game_direct(game_path),
    }
}

/// STS2 calls Steamworks' `SteamAPI_Init()` on startup. When the game
/// process wasn't spawned by Steam, that call fails with
/// `k_ESteamAPIInitResult_FailedGeneric: No appID found` and the game
/// dies with a "Steam Error!" dialog — unless a `steam_appid.txt`
/// containing the AppID sits in the executable's working directory.
/// That file is the documented Steamworks-side override for running
/// the binary outside Steam's launcher.
///
/// We rewrite it on every Direct launch (idempotent, 7 bytes, no
/// downside if it was already there) so users don't have to do it
/// manually. Failures are logged and non-fatal — the launch still
/// proceeds; the user just sees the same error dialog they'd see
/// without us, which is a clearer signal than a launch that we
/// silently aborted.
///
/// Caveat we DON'T paper over: this file gets the game past
/// `SteamAPI_Init`'s "did you launch from Steam?" check, but Steamworks
/// still needs a running Steam client to connect to. If Steam isn't
/// running at all, the game will still fail to initialize. So Direct
/// launch bypasses the Steam *launcher*, not Steam-the-runtime — Family
/// Sharing borrowers and Steam-offline-mode users (who do have Steam
/// running) are the realistic users for this mode.
fn write_steam_appid_file(dir: &Path) {
    let path = dir.join("steam_appid.txt");
    match std::fs::write(&path, STS2_STEAM_APPID) {
        Ok(_) => log::info!("Wrote {} for Direct launch", path.display()),
        Err(e) => log::warn!(
            "Couldn't write {} (Direct launch may fail with a Steam Error dialog): {}",
            path.display(),
            e
        ),
    }
}

/// Direct (no-Steam) launch. Per platform:
///   - Windows: spawn `<install>/SlayTheSpire2.exe` (or the space-variant).
///   - macOS:   `open` the `.app` bundle. Warn on Apple Silicon that
///              STS2 needs Rosetta 2 — we don't fail the launch; if
///              Rosetta isn't installed macOS surfaces its own prompt.
///   - Linux:   spawn the native binary if one's next to the `.pck`.
///              Proton-only installs (a `.exe` with no Linux binary)
///              are not supported here; we don't try to drive Proton
///              ourselves.
///
/// All platforms write `steam_appid.txt` next to the binary first —
/// without it the game refuses to start outside Steam. See
/// `write_steam_appid_file` for the why.
fn spawn_game_direct(game_path: Option<&Path>) -> std::result::Result<(), String> {
    let game_path = game_path.ok_or_else(|| {
        "Direct launch needs a detected game install. Set the game path in Settings → General first.".to_string()
    })?;

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        let candidates = [
            game_path.join("SlayTheSpire2.exe"),
            game_path.join("Slay the Spire 2.exe"),
        ];
        let exe = match candidates.iter().find(|p| p.exists()) {
            Some(p) => p,
            None => {
                let msg = format!(
                    "Direct launch couldn't find SlayTheSpire2.exe in {}. Verify the game path in Settings → General.",
                    game_path.display()
                );
                log::error!("{}", msg);
                return Err(msg);
            }
        };
        // CWD will be game_path, which is also where the .exe lives,
        // so steam_appid.txt goes right next to it.
        write_steam_appid_file(game_path);
        log::info!("Direct launch: spawning {}", exe.display());
        Command::new(exe)
            .current_dir(game_path)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                let msg = format!("Direct launch failed: {}", e);
                log::error!("{}", msg);
                msg
            })
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let app_candidates = [
            game_path.join("SlayTheSpire2.app"),
            game_path.join("Slay the Spire 2.app"),
        ];
        let bundle = match app_candidates.iter().find(|p| p.is_dir()) {
            Some(p) => p,
            None => {
                let msg = format!(
                    "Direct launch couldn't find SlayTheSpire2.app inside {}. Verify the game path in Settings → General.",
                    game_path.display()
                );
                log::error!("{}", msg);
                return Err(msg);
            }
        };

        // STS2 ships an Intel-only Mac build that runs through Rosetta 2.
        // On Apple Silicon (`aarch64`) the user needs Rosetta installed for
        // the bundle to actually start. We don't gate the launch on
        // detecting Rosetta — macOS will surface its own "Rosetta is
        // required" prompt if it's missing — but we log so the cause is
        // obvious if Direct launch produces nothing visible.
        if std::env::consts::ARCH == "aarch64" {
            log::warn!(
                "Direct launch on Apple Silicon: STS2 ships an Intel build and needs Rosetta 2. \
                 If the game doesn't start, install Rosetta (System Settings → General → Software Update) \
                 or run via Steam launch mode."
            );
        }

        // When `open` launches a .app, the executable's CWD is its
        // Contents/MacOS directory — write the appid file there.
        // Also drop one at the game-path root: cheap insurance for any
        // SteamAPI build that walks up looking for it, and the dialog
        // text itself asks for "your game folder" which Steam users
        // tend to read as the install dir.
        let macos_dir = bundle.join("Contents/MacOS");
        if macos_dir.is_dir() {
            write_steam_appid_file(&macos_dir);
        }
        write_steam_appid_file(game_path);

        log::info!("Direct launch: open {}", bundle.display());
        Command::new("open")
            .arg(bundle)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                let msg = format!("Direct launch failed: {}", e);
                log::error!("{}", msg);
                msg
            })
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let linux_candidates = [
            game_path.join("SlayTheSpire2.x86_64"),
            game_path.join("SlayTheSpire2"),
            game_path.join("Slay the Spire 2.x86_64"),
            game_path.join("Slay the Spire 2"),
        ];
        let binary = linux_candidates.iter().find(|p| p.is_file());

        if let Some(bin) = binary {
            write_steam_appid_file(game_path);
            log::info!("Direct launch: spawning {}", bin.display());
            return Command::new(bin)
                .current_dir(game_path)
                .spawn()
                .map(|_| ())
                .map_err(|e| {
                    let msg = format!("Direct launch failed: {}", e);
                    log::error!("{}", msg);
                    msg
                });
        }

        // Proton install: a Windows .exe in the steamapps/common dir with
        // no native Linux binary alongside. We deliberately don't try to
        // spawn Proton ourselves — picking the right Proton version,
        // wiring up the WINEPREFIX, and matching what Steam would do is
        // brittle and very Steam-specific. Steer the user back to Steam
        // mode (which IS the right tool for Proton).
        let has_exe = game_path.join("SlayTheSpire2.exe").exists()
            || game_path.join("Slay the Spire 2.exe").exists();
        if has_exe {
            let msg = "Direct launch is not supported for Proton installs. Switch to Steam launch in Settings → Launch.".to_string();
            log::error!("{}", msg);
            return Err(msg);
        }

        let msg = format!(
            "Direct launch couldn't find a Slay the Spire 2 binary in {}. Verify the game path in Settings → General.",
            game_path.display()
        );
        log::error!("{}", msg);
        Err(msg)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = game_path;
        let msg = "Direct launch isn't supported on this platform.".to_string();
        log::error!("{}", msg);
        Err(msg)
    }
}

/// Launch STS2 using the configured launch mode, with auto-backup.
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

    let mode = s.launch_mode;
    let game_path = s.game_path.clone();
    drop(s);

    spawn_game(mode, game_path.as_deref())?;
    Ok(true)
}

/// Launch STS2 in vanilla mode (disable all mods temporarily) using the
/// configured launch mode. Mods will be automatically restored on the
/// next normal launch.
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

    let mode = s.launch_mode;
    let game_path = s.game_path.clone();
    drop(s);

    spawn_game(mode, game_path.as_deref())?;
    Ok(true)
}

/// Return the user's configured launch mode.
#[tauri::command]
pub fn get_launch_mode(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LaunchMode, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.launch_mode)
}

/// Persist a new launch mode. Writes `<config>/launch_mode.txt` so the
/// choice survives an app restart.
#[tauri::command]
pub fn set_launch_mode(
    mode: LaunchMode,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LaunchMode, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.launch_mode = mode;
    let path = s.config_path.join("launch_mode.txt");
    if let Err(e) = std::fs::write(&path, mode.as_str()) {
        log::warn!("Couldn't persist launch_mode to {}: {}", path.display(), e);
    }
    log::info!("Launch mode set to {}", mode.as_str());
    Ok(mode)
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

    s.cached_github_username = None;
    s.modpack_browser_cache.clear();

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

/// Return the last `lines` lines of the log file (newest at the end).
/// Returns an empty string if the log doesn't exist yet.
#[tauri::command]
pub fn read_log_tail(
    state: tauri::State<'_, AppState>,
    lines: usize,
) -> std::result::Result<String, String> {
    let log_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.config_path.join("sts2mm.log")
    };
    if !log_path.exists() {
        return Ok(String::new());
    }
    let want = lines.clamp(1, 5000);
    let text = std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read log {}: {}", log_path.display(), e))?;
    let collected: Vec<&str> = text.lines().collect();
    let start = collected.len().saturating_sub(want);
    Ok(collected[start..].join("\n"))
}

