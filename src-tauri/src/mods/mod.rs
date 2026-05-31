use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

// ── Submodules ─────────────────────────────────────────────────────────────
//
// `mods` was a 3.9k-line single file. The full split now lives across
// three focused sub-modules:
//
//   - `scan`    — read-only filesystem walker: manifest parsing
//                 (strict + lenient), `RawManifest`/`RawDependency`,
//                 `dll_only_mod` fallback, dedup, and the
//                 `scan_mods` / `scan_disabled_mods` /
//                 `merge_active_disabled_mods` entry points the UI calls.
//   - `install` — archive-format adapters (7z, rar, repack-as-zip).
//   - `state`   — path-safety primitives (`sanitize_path_segment`,
//                 `path_is_inside`, `move_directory`) shared by the
//                 enable/disable / install / cache layers.
//
// This file is now just the orchestration: enable/disable file moves,
// `install_mod_from_zip`'s wrap-folder + manifest-discovery workflow,
// config-snapshot lifecycle, and the Tauri commands the frontend
// invokes. Re-exports below preserve the
// `crate::mods::function_name` import surface the rest of the codebase
// + integration tests rely on.
mod install;
mod scan;
mod state;

// Re-exports preserve the historic `crate::mods::strip_utf8_bom`,
// `crate::mods::sanitize_path_segment`, etc. surface that the rest
// of the codebase reaches via the same paths it used pre-split.
pub use install::{
    finalize_update_with_preserved_configs, install_mod_from_archive, install_mod_from_zip,
    prepare_update_with_preserved_configs, read_user_edited_configs, restore_preserved_configs,
    snapshot_after_fresh_install, snapshot_mod_configs, PreservedConfig, PreservedConfigOutcome,
};
pub use scan::{scan_disabled_mods, scan_mods, strip_utf8_bom};
pub(crate) use scan::{dedup_key, merge_active_disabled_mods};
pub use state::{
    delete_mod_files_by_info, disable_mod, enable_mod, move_directory, move_mod_by_info,
    path_is_inside, sanitize_path_segment,
};

// Crate-internal helpers used from within `mods/` itself.
use scan::{normalize_name, scan_mods_inner, RawManifest};
use state::{move_mod_files, safe_mod_relative_path, sanitize_for_filename};

/// Information about an installed mod.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub files: Vec<String>,
    pub source: Option<String>,
    pub hash: Option<String>,
    pub dependencies: Vec<String>,
    pub size_bytes: u64,
    /// The actual folder name on disk (e.g. "STS2-RitsuLib", "DamageMeter")
    /// This may differ from the manifest `name` field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    /// The mod's `id` field from the manifest (used by the game for dependency resolution)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    /// Linked GitHub URL (e.g. "https://github.com/owner/repo")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
    /// Linked Nexus Mods URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    /// Whether this mod is pinned. Pinned mods are excluded from update checks
    /// and from automated state changes during modpack/profile applies — they
    /// keep their installed version and current enabled/disabled state.
    /// Populated by `mod_sources::enrich_mods_with_sources`.
    #[serde(default)]
    pub pinned: bool,
    /// Minimum game version required by this mod's manifest. None when
    /// the manifest doesn't declare one (older mods didn't). UI compares
    /// this to the user's detected game_version to show "won't load on
    /// your build" warnings; Repair uses it to walk back to a compatible
    /// release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_game_version: Option<String>,
    /// Author from the manifest, surfaced for UI disambiguation when two
    /// mods share a display name. None when the manifest didn't declare one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Free-form user note from the source DB. Populated by
    /// `mod_sources::enrich_mods_with_sources`. Surfaces in the mod row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// User-saved non-GitHub/non-Nexus URL (Patreon, X, Discord, etc).
    /// Populated by `mod_sources::enrich_mods_with_sources`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    /// Manager-only organization tags/categories from mod_sources.json.
    /// These do not affect mod identity, updates, or profile membership.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// User-facing display name override from mod_sources.json. This does
    /// not replace `name`, because `name` is still part of the stable mod
    /// identity used by profiles, updates, and file operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// User-facing description override from mod_sources.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_description: Option<String>,
}

/// One dependency entry in a mod manifest.
///
/// The ecosystem ships two formats for the `dependencies` array:
///   - Old / simple: `["DepName", "OtherDep"]`
///   - New / structured (BAKAOLC, RitsuLib-based mods): `[{"id": "DepName",
///     "min_version": "1.2.3"}]`
///
/// `#[serde(untagged)]` makes serde try each variant in order and pick the
/// first that matches. Without this, mixing the two formats made
/// serde_json fail the entire manifest parse, which dropped the mod into
/// the dll-only-fallback path with name "<repo-slug>" and version
/// "unknown" — which is exactly the broken state the user kept hitting
/// for `STS2-ShowPlayerHandCards`.

// ── Local Mod Version Cache ────────────────────────────────────────────────

// Path-safety helpers moved to `mods/state.rs`:
//   sanitize_for_filename, sanitize_path_segment, path_is_inside
// — see the `use state::{…}` + `pub use state::{…}` blocks at the top.

/// Build the local cache path for a specific mod version.
fn mod_cache_path(cache_path: &Path, mod_name: &str, version: &str) -> PathBuf {
    let safe_name = sanitize_for_filename(mod_name);
    let safe_ver = sanitize_for_filename(version.trim_start_matches('v'));
    cache_path
        .join("mod_versions")
        .join(format!("{}_{}.zip", safe_name, safe_ver))
}

/// Cache a mod's current files to a local versioned zip.
/// Returns the cache file path if successful. Skips if already cached.
pub fn cache_mod_version(
    mod_info: &ModInfo,
    base_path: &Path,
    cache_path: &Path,
) -> Option<PathBuf> {
    let ver = mod_info.version.trim_start_matches('v');
    if ver == "unknown" || ver == "0.0.0" || ver.is_empty() {
        return None;
    }

    let dest = mod_cache_path(cache_path, &mod_info.name, &mod_info.version);

    if dest.exists() {
        return Some(dest);
    }

    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = match fs::File::create(&dest) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("Failed to create cache file for '{}': {}", mod_info.name, e);
            return None;
        }
    };

    let mut zip_writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for file_rel in &mod_info.files {
        let normalized = file_rel.replace('\\', "/");
        let file_path = base_path.join(&normalized);

        if file_path.is_file() {
            if zip_writer.start_file(&normalized, options).is_err() {
                continue;
            }
            if let Ok(data) = fs::read(&file_path) {
                let _ = io::Write::write_all(&mut zip_writer, &data);
            }
        } else if file_path.is_dir() {
            if let Ok(entries) = fs::read_dir(&file_path) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        let entry_rel =
                            format!("{}/{}", normalized, entry.file_name().to_string_lossy());
                        if zip_writer.start_file(&entry_rel, options).is_err() {
                            continue;
                        }
                        if let Ok(data) = fs::read(entry.path()) {
                            let _ = io::Write::write_all(&mut zip_writer, &data);
                        }
                    }
                }
            }
        }
    }

    match zip_writer.finish() {
        Ok(_) => {
            log::info!(
                "Cached mod '{}' v{} to local cache",
                mod_info.name,
                mod_info.version
            );
            Some(dest)
        }
        Err(e) => {
            log::warn!(
                "Failed to finalize cache zip for '{}': {}",
                mod_info.name,
                e
            );
            let _ = fs::remove_file(&dest);
            None
        }
    }
}

/// Check if a cached version of a mod exists locally.
pub fn get_cached_mod_path(cache_path: &Path, mod_name: &str, version: &str) -> Option<PathBuf> {
    let path = mod_cache_path(cache_path, mod_name, version);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Restore a mod from the local version cache by extracting its zip to mods_path.
pub fn restore_mod_from_cache(
    cache_path: &Path,
    mod_name: &str,
    version: &str,
    mods_path: &Path,
) -> Result<()> {
    let zip_path = mod_cache_path(cache_path, mod_name, version);
    if !zip_path.exists() {
        return Err(AppError::Other(format!(
            "No cached version for '{}' v{}",
            mod_name, version
        )));
    }

    let file = fs::File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Invalid cache zip for '{}': {}", mod_name, e)))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let Some(outpath) = entry.enclosed_name().map(|p| mods_path.join(p)) else {
            continue;
        };
        if entry.name().ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&outpath)?;
            io::copy(&mut entry, &mut outfile)?;
        }
    }

    log::info!("Restored mod '{}' v{} from local cache", mod_name, version);
    Ok(())
}




// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Get all installed mods (active + disabled), enriched with source links.
///
/// If the same mod name exists in BOTH `mods/` and `mods_disabled/` at the
/// same time (typically the result of an interrupted toggle or a half-applied
/// profile switch), the active copy wins and the disabled one is logged but
/// hidden — otherwise the user sees the same mod listed twice with confusing
/// version strings. The disabled files stay on disk so the user can recover
/// them manually if needed.
#[tauri::command]
pub fn get_installed_mods(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ModInfo>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;

    let active_mods = s
        .mods_path
        .as_ref()
        .map(|p| scan_mods(p))
        .unwrap_or_default();
    let disabled_mods = s
        .disabled_mods_path
        .as_ref()
        .map(|p| scan_disabled_mods(p))
        .unwrap_or_default();

    // Build a lookup of active mods by FOLDER identity so the overlap
    // check only fires when the SAME folder appears in both `mods/` and
    // `mods_disabled/` (the half-toggled / interrupted-operation case).
    //
    // Keying by display name here would suppress legitimately distinct
    // mods that happen to share a manifest `name` — e.g. two CardArtEditor
    // installs where the user disabled one. We want both to appear in
    // the UI as separate rows.
    let active_keys: std::collections::HashSet<String> =
        active_mods.iter().map(dedup_key).collect();

    let mut all_mods = active_mods;
    for d in disabled_mods {
        if active_keys.contains(&dedup_key(&d)) {
            log::warn!(
                "Mod folder '{}' has files in BOTH active and disabled folders — showing the active copy only. Re-toggle or repair the profile to clean this up.",
                dedup_key(&d)
            );
            continue;
        }
        all_mods.push(d);
    }

    all_mods.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| dedup_key(a).cmp(&dedup_key(b)))
    });

    // Enrich with source metadata (GitHub/Nexus links)
    crate::mod_sources::enrich_mods_with_sources(&mut all_mods, &s.config_path);
    all_mods.sort_by(|a, b| {
        a.display_name
            .as_deref()
            .unwrap_or(&a.name)
            .to_lowercase()
            .cmp(&b.display_name.as_deref().unwrap_or(&b.name).to_lowercase())
            .then_with(|| dedup_key(a).cmp(&dedup_key(b)))
    });

    Ok(all_mods)
}

/// Toggle a mod between enabled and disabled.
///
/// `folder_name` (when provided) is the preferred identity — two mods can
/// share a display name but never share a folder. The UI always passes
/// folder_name. The optional shape keeps any out-of-band callers using
/// the old name-only contract working.
///
/// Toggling changes the working install only. The saved profile manifest is
/// the contract and changes only through explicit profile actions such as
/// Snapshot current, Save changes, Share, or Re-share. Drift detection reports
/// the difference.
#[tauri::command]
pub fn toggle_mod(
    name: String,
    folder_name: Option<String>,
    enable: bool,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.mods_path.clone().ok_or("Game path not set")?,
            s.disabled_mods_path.clone().ok_or("Game path not set")?,
        )
    };

    let (src, dest) = if enable {
        (disabled_path.as_path(), mods_path.as_path())
    } else {
        (mods_path.as_path(), disabled_path.as_path())
    };

    // Disambiguation: when folder_name is given, find the EXACT mod by
    // folder identity and move only its files. Two mods sharing a display
    // name will have different folders, so name-only matching (the old
    // path) could move the wrong copy.
    let move_result = if let Some(ref folder) = folder_name {
        let mods_in_src = scan_mods_inner(src, enable);
        match mods_in_src
            .iter()
            .find(|m| m.folder_name.as_deref() == Some(folder.as_str()))
            .cloned()
        {
            Some(info) => move_mod_by_info(&info, src, dest),
            None => Err(crate::error::AppError::ModNotFound(format!(
                "No mod with folder '{}' (display name '{}') in {}",
                folder,
                name,
                src.display()
            ))),
        }
    } else {
        // Legacy fallback: name-based move, then scan-by-name as a second try.
        // Still subject to the original same-name ambiguity if two folders
        // share a manifest name — but only reachable from callers that
        // don't pass folder_name (no current UI does).
        move_mod_files(&name, src, dest).or_else(|_| {
            let mods_in_src = scan_mods_inner(src, enable);
            let mod_info = mods_in_src.iter().find(|m| m.name == name).cloned();
            match mod_info {
                Some(info) => move_mod_by_info(&info, src, dest),
                None => Err(crate::error::AppError::ModNotFound(format!(
                    "No files found for mod '{}' in {}",
                    name,
                    src.display()
                ))),
            }
        })
    };
    move_result.map_err(|e| e.to_string())?;

    Ok(true)
}

/// Permanently delete a mod.
///
/// `folder_name` (when provided) disambiguates between two mods that share
/// a display name. Without it, the first scan match wins — which on a
/// system with two same-named folders could delete the wrong one.
#[tauri::command]
pub fn delete_mod_cmd(
    name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s
        .disabled_mods_path
        .as_ref()
        .ok_or("Game path not set")?
        .clone();
    drop(s);

    delete_mod_from_paths(&name, folder_name.as_deref(), &mods_path, &disabled_path)
}

fn delete_mod_from_paths(
    name: &str,
    folder_name: Option<&str>,
    mods_path: &Path,
    disabled_path: &Path,
) -> std::result::Result<bool, String> {
    validate_mod_root_pair(mods_path, disabled_path, "delete mod files")?;

    // Scan to find the mod and get its actual file paths. Match by
    // folder_name first (unique on disk), then by display name as a
    // fallback for legacy callers.
    let all_mods: Vec<ModInfo> = scan_mods(mods_path)
        .into_iter()
        .chain(scan_disabled_mods(disabled_path).into_iter())
        .collect();

    let found = if let Some(folder) = folder_name {
        all_mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some(folder))
    } else {
        all_mods.iter().find(|m| m.name == name)
    };

    if let Some(info) = found {
        let base_path = if info.enabled {
            mods_path
        } else {
            disabled_path
        };

        // Collect parent dirs to clean up later
        let mut parent_dirs = std::collections::HashSet::new();

        // Delete each file the mod owns
        for file_rel in &info.files {
            let Some(rel_path) = safe_mod_relative_path(file_rel) else {
                log::warn!(
                    "Skipping unsafe path '{}' while deleting mod '{}'",
                    file_rel,
                    info.name
                );
                continue;
            };
            let file_path = base_path.join(&rel_path);
            if file_path.is_dir() {
                let _ = fs::remove_dir_all(&file_path);
            } else if file_path.exists() {
                let _ = fs::remove_file(&file_path);
            }
            // Track parent directory for cleanup
            if let Some(parent_rel) = rel_path.parent() {
                if !parent_rel.as_os_str().is_empty() {
                    parent_dirs.insert(base_path.join(parent_rel));
                }
            }
        }

        // Remove empty parent directories (subdirectory mods)
        for dir in &parent_dirs {
            if dir.is_dir() {
                // Only remove if empty
                if fs::read_dir(dir)
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false)
                {
                    let _ = fs::remove_dir(dir);
                }
            }
        }

        log::info!("Deleted mod '{}' ({} files)", name, info.files.len());
        return Ok(true);
    }

    // Fallback: fuzzy name match directly on filesystem
    let norm = normalize_name(&name);
    let mut found = false;
    for search_path in [mods_path, disabled_path] {
        // Check for exact-name subdirectory
        let sub_dir = search_path.join(&name);
        if sub_dir.is_dir() {
            let _ = fs::remove_dir_all(&sub_dir);
            found = true;
            continue;
        }

        // Iterate filesystem entries with fuzzy matching
        if let Ok(entries) = fs::read_dir(search_path) {
            for entry in entries.flatten() {
                let entry_name = entry.file_name().to_string_lossy().to_string();
                let fstem = Path::new(&entry_name)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                if fstem == name
                    || normalize_name(&fstem) == norm
                    || normalize_name(&entry_name) == norm
                {
                    if entry.path().is_dir() {
                        let _ = fs::remove_dir_all(entry.path());
                    } else {
                        let _ = fs::remove_file(entry.path());
                    }
                    found = true;
                }
            }
        }
    }

    if !found {
        return Err(format!("Could not find files for mod '{}' to delete", name));
    }
    log::info!("Deleted mod '{}' via fallback matching", name);
    Ok(true)
}

/// Enable all currently disabled mods.
/// Uses direct filesystem iteration instead of scan-then-move for reliability.
#[tauri::command]
pub fn enable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s
        .disabled_mods_path
        .as_ref()
        .ok_or("Game path not set")?
        .clone();
    drop(s);

    let _ = fs::create_dir_all(&mods_path);
    let mut errors = Vec::new();

    if let Ok(entries) = fs::read_dir(&disabled_path) {
        for entry in entries.flatten() {
            let src = entry.path();
            let dest = mods_path.join(entry.file_name());
            let name = entry.file_name().to_string_lossy().to_string();

            // Remove destination if it already exists (handles stale/partial state)
            if dest.exists() {
                if dest.is_dir() {
                    let _ = fs::remove_dir_all(&dest);
                } else {
                    let _ = fs::remove_file(&dest);
                }
            }

            let result = if src.is_dir() {
                move_directory(&src, &dest).and_then(|_| {
                    let _ = fs::remove_dir_all(&src);
                    Ok(())
                })
            } else {
                fs::rename(&src, &dest)
                    .or_else(|_| fs::copy(&src, &dest).and_then(|_| fs::remove_file(&src)))
                    .map(|_| ())
            };

            if let Err(e) = result {
                errors.push(format!("{}: {}", name, e));
            }
        }
    }

    if !errors.is_empty() {
        log::error!("Some mods failed to enable: {:?}", errors);
    }
    Ok(true)
}

/// Disable all currently enabled mods.
/// Uses direct filesystem iteration instead of scan-then-move for reliability.
#[tauri::command]
pub fn disable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s
        .disabled_mods_path
        .as_ref()
        .ok_or("Game path not set")?
        .clone();
    drop(s);

    let _ = fs::create_dir_all(&disabled_path);
    let mut errors = Vec::new();

    if let Ok(entries) = fs::read_dir(&mods_path) {
        for entry in entries.flatten() {
            let src = entry.path();
            let dest = disabled_path.join(entry.file_name());
            let name = entry.file_name().to_string_lossy().to_string();

            // Remove destination if it already exists (handles stale/partial state)
            if dest.exists() {
                if dest.is_dir() {
                    let _ = fs::remove_dir_all(&dest);
                } else {
                    let _ = fs::remove_file(&dest);
                }
            }

            let result = if src.is_dir() {
                move_directory(&src, &dest).and_then(|_| {
                    let _ = fs::remove_dir_all(&src);
                    Ok(())
                })
            } else {
                fs::rename(&src, &dest)
                    .or_else(|_| fs::copy(&src, &dest).and_then(|_| fs::remove_file(&src)))
                    .map(|_| ())
            };

            if let Err(e) = result {
                errors.push(format!("{}: {}", name, e));
            }
        }
    }

    if !errors.is_empty() {
        log::error!("Some mods failed to disable: {:?}", errors);
    }
    Ok(true)
}

/// Delete ALL mods from both enabled and disabled folders.
#[tauri::command]
pub fn delete_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<u32, String> {
    crate::game::ensure_game_not_running()?;
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s
        .disabled_mods_path
        .as_ref()
        .ok_or("Game path not set")?
        .clone();
    drop(s);

    let count = delete_all_mods_from_paths(&mods_path, &disabled_path)?;
    log::info!("Deleted all mods ({} items)", count);
    // Do not refresh the active profile here. Bulk delete is often used as
    // a reset/repair staging step before re-activating the profile; rewriting
    // the active manifest to an empty mod list would make that recovery
    // impossible. Ordinary disk mutations create drift instead.
    Ok(count)
}

fn delete_all_mods_from_paths(
    mods_path: &Path,
    disabled_path: &Path,
) -> std::result::Result<u32, String> {
    validate_mod_root_pair(mods_path, disabled_path, "delete all mods")?;

    let mut count = 0u32;
    for search_path in [mods_path, disabled_path] {
        if let Ok(entries) = fs::read_dir(search_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(&path);
                } else {
                    let _ = fs::remove_file(&path);
                }
                count += 1;
            }
        }
    }
    Ok(count)
}

fn validate_mod_root_pair(
    mods_path: &Path,
    disabled_path: &Path,
    operation: &str,
) -> std::result::Result<(), String> {
    let mods_name_ok = path_file_name_eq(mods_path, "mods");
    let disabled_name_ok = path_file_name_eq(disabled_path, "mods_disabled");
    let same_parent = mods_path.parent().is_some() && mods_path.parent() == disabled_path.parent();

    if mods_name_ok && disabled_name_ok && same_parent {
        Ok(())
    } else {
        Err(format!(
            "Refusing to {}: expected sibling 'mods' and 'mods_disabled' folders, got '{}' and '{}'",
            operation,
            mods_path.display(),
            disabled_path.display()
        ))
    }
}

fn path_file_name_eq(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

/// Install a mod from a local file (zip / 7z / rar archive).
#[tauri::command]
pub fn install_mod_from_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, config_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
        let config_path = s.config_path.clone();
        (mods_path, config_path)
    };
    let archive_path = PathBuf::from(&path);
    let result = install_mod_from_archive(&archive_path, &mods_path).map_err(|e| e.to_string())?;
    // First-time install: snapshot configs so the next update preserves
    // any edits the user makes in the meantime. No preservation pass
    // happens here — there's nothing to preserve from.
    snapshot_after_fresh_install(&result, &mods_path, &config_path);
    Ok(result)
}

// ── Dependency Resolution ──────────────────────────────────────────────────

/// Check which dependencies of a mod are not currently installed.
pub fn check_dependencies(mod_name: &str, mods_path: &Path) -> Vec<String> {
    let manifest_path = mods_path.join(format!("{}.json", mod_name));
    let content = match fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let raw: RawManifest = match serde_json::from_str(strip_utf8_bom(&content)) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let installed: std::collections::HashSet<String> =
        scan_mods(mods_path).into_iter().map(|m| m.name).collect();

    raw.dependencies
        .into_iter()
        .map(|d| d.id().to_string())
        .filter(|dep| !installed.contains(dep))
        .collect()
}

/// Find all installed mods that depend on the given mod.
pub fn get_dependents(mod_name: &str, mods_path: &Path) -> Vec<String> {
    scan_mods(mods_path)
        .into_iter()
        .filter(|m| m.dependencies.iter().any(|d| d == mod_name))
        .map(|m| m.name)
        .collect()
}

/// Tauri command: return missing dependencies for a mod.
#[tauri::command]
pub fn check_mod_dependencies(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<String>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    Ok(check_dependencies(&name, mods_path))
}

/// Tauri command: return mods that depend on the given mod.
#[tauri::command]
pub fn get_mod_dependents(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<String>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    Ok(get_dependents(&name, mods_path))
}

#[cfg(test)]
mod user_scenario_tests {
    use super::scan::parse_manifest;
    use super::{move_mod_by_info, scan_disabled_mods, scan_mods};
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// Set up a mods/ directory containing two distinct mods that both
    /// declare `name: "Card Art Editor"` in their manifests but live in
    /// different folders — exact mirror of JadeDemon's reported scenario.
    fn make_two_cardarteditor_fixture() -> TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path();

        let a = mods.join("card_art_editor");
        write(
            &a.join("manifest.json"),
            r#"{ "name": "Card Art Editor", "version": "1.0.0", "author": "alice" }"#,
        );
        write(&a.join("card_art_editor.dll"), "fake-binary-A");

        let b = mods.join("card_art_editor_v2");
        write(
            &b.join("manifest.json"),
            r#"{ "name": "Card Art Editor", "version": "2.0.0", "author": "bob" }"#,
        );
        write(&b.join("card_art_editor.dll"), "fake-binary-B");

        tmp
    }

    /// Scan returns BOTH same-named mods as distinct entries.
    /// Pre-fix: one collapsed into the other via normalized-name dedup
    /// and the user saw only one row. Post-fix: folder identity keeps
    /// them separate.
    #[test]
    fn scan_keeps_two_same_named_mods_in_different_folders() {
        let tmp = make_two_cardarteditor_fixture();
        let mods = scan_mods(tmp.path());

        let card_mods: Vec<_> = mods
            .iter()
            .filter(|m| m.name == "Card Art Editor")
            .collect();
        assert_eq!(
            card_mods.len(),
            2,
            "expected both CardArtEditor folders to surface as distinct mods, got {} (mods on disk: {:?})",
            card_mods.len(),
            mods.iter().map(|m| (&m.name, &m.folder_name)).collect::<Vec<_>>(),
        );

        let folders: std::collections::HashSet<&str> = card_mods
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        assert!(folders.contains("card_art_editor"));
        assert!(folders.contains("card_art_editor_v2"));

        // Distinct versions — confirms each row carries its own manifest
        // data rather than reusing one entry for both folders.
        let versions: std::collections::HashSet<&str> =
            card_mods.iter().map(|m| m.version.as_str()).collect();
        assert!(versions.contains("1.0.0"));
        assert!(versions.contains("2.0.0"));

        // Author flows through for the UI disambiguation subtitle.
        let authors: std::collections::HashSet<&str> = card_mods
            .iter()
            .filter_map(|m| m.author.as_deref())
            .collect();
        assert!(authors.contains("alice"));
        assert!(authors.contains("bob"));
    }

    /// Disabling ONE of two same-named mods (by folder_name) moves only
    /// that folder. The other CardArtEditor stays active.
    ///
    /// Pre-fix: the toggle's name-based match could move either copy
    /// (whichever scanned first), causing the "wrong mod disappeared"
    /// surprise JadeDemon reported.
    #[test]
    fn disabling_one_same_named_mod_leaves_the_other_active() {
        let tmp = make_two_cardarteditor_fixture();
        let mods_path = tmp.path();
        let disabled_path = tmp
            .path()
            .parent()
            .unwrap()
            .join("mods_disabled_test_for_scenario");
        fs::create_dir_all(&disabled_path).unwrap();
        // Drop-handler cleanup so a failed assertion doesn't leak a
        // sibling directory next to the tempdir.
        struct DisabledGuard(std::path::PathBuf);
        impl Drop for DisabledGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DisabledGuard(disabled_path.clone());

        let installed = scan_mods(mods_path);
        let target = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor_v2"))
            .expect("v2 fixture must scan");

        move_mod_by_info(target, mods_path, &disabled_path).unwrap();

        let still_active = scan_mods(mods_path);
        let now_disabled = scan_disabled_mods(&disabled_path);

        let active_folders: Vec<&str> = still_active
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        let disabled_folders: Vec<&str> = now_disabled
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();

        assert_eq!(
            active_folders,
            vec!["card_art_editor"],
            "only the untouched CardArtEditor should remain active"
        );
        assert_eq!(
            disabled_folders,
            vec!["card_art_editor_v2"],
            "only the disabled CardArtEditor should be in mods_disabled"
        );

        // The active copy must keep its v1 manifest contents.
        let active_v1 = still_active
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor"))
            .unwrap();
        assert_eq!(active_v1.version, "1.0.0");
        assert_eq!(active_v1.author.as_deref(), Some("alice"));
    }

    /// JadeDemon's "vunknown after BaseLib auto-update" report: a manifest
    /// that's valid JSON with a real `version` string but a `dependencies`
    /// entry the strict struct parse can't handle. Pre-fix the version was
    /// silently replaced with "unknown"; post-fix the lenient fallback
    /// surfaces the real value.
    #[test]
    fn manifest_with_unparseable_dependencies_still_yields_version() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        // `dependencies` contains a raw number — neither the
        // `Name(String)` nor the `Structured { id }` variant of
        // RawDependency accepts that, so strict parse fails the whole
        // struct.
        let manifest_path = base.join("baselib").join("manifest.json");
        write(
            &manifest_path,
            r#"{
                "name": "BaseLib",
                "version": "1.4.2",
                "description": "Core utilities",
                "author": "Curator",
                "dependencies": [123, {"id": "OtherLib"}]
            }"#,
        );
        write(&base.join("baselib").join("baselib.dll"), "fake-dll");

        let parsed = parse_manifest(&manifest_path, base, true)
            .expect("lenient fallback must surface a ModInfo even when strict parse fails");
        assert_eq!(parsed.name, "BaseLib");
        assert_eq!(
            parsed.version, "1.4.2",
            "version must be the manifest's real value, not 'unknown'"
        );
        assert_eq!(parsed.description, "Core utilities");
        assert_eq!(parsed.author.as_deref(), Some("Curator"));
        // folder_name still resolves to the parent dir even when the
        // strict parse stumbled on a sibling field.
        assert_eq!(parsed.folder_name.as_deref(), Some("baselib"));
    }

    /// BaseLib (Nexus mod 103) ships its manifest with a UTF-8 BOM. Both
    /// the strict and lenient `serde_json` paths refuse to parse content
    /// that doesn't start with a JSON character, so pre-this-fix the
    /// entire manifest was discarded and the UI showed "vunknown".
    /// Reproduces the actual bytes from `BaseLib.json` on disk.
    #[test]
    fn bom_prefixed_manifest_parses_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let manifest_path = base.join("BaseLib").join("BaseLib.json");
        if let Some(parent) = manifest_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        // EF BB BF prefix — exact UTF-8 BOM bytes as shipped by BaseLib.
        let bytes: Vec<u8> = {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(
                br#"{
  "id": "BaseLib",
  "name": "BaseLib",
  "author": "Alchyr",
  "description": "Modding utility for Slay the Spire 2",
  "version": "v3.1.2",
  "has_pck": true,
  "has_dll": true,
  "dependencies": [],
  "affects_gameplay": false
}"#,
            );
            v
        };
        fs::write(&manifest_path, &bytes).unwrap();

        let parsed = parse_manifest(&manifest_path, base, true)
            .expect("BOM-prefixed manifest must parse — this is the BaseLib bug");
        assert_eq!(parsed.name, "BaseLib");
        assert_eq!(
            parsed.version, "v3.1.2",
            "version must be the manifest's real value, not 'unknown'"
        );
        assert_eq!(parsed.author.as_deref(), Some("Alchyr"));
        assert_eq!(parsed.mod_id.as_deref(), Some("BaseLib"));
    }

    /// Scenario 005 from `qa/scenarios/`. Closes the install-pipeline
    /// half of the BaseLib regression. The 1.3.3 fix made `parse_manifest`
    /// BOM-tolerant; this test proves that the BOM tolerance survives
    /// `install_mod_from_zip`'s extract → parse pipeline end-to-end.
    ///
    /// Builds a real zip in a tempdir with the EXACT byte layout of the
    /// BaseLib manifest on the user's disk (UTF-8 BOM at byte 0, then
    /// the manifest JSON), runs install_mod_from_zip against it, and
    /// asserts the returned ModInfo carries the real version string
    /// rather than the "unknown" stub.
    #[test]
    fn install_mod_from_zip_handles_bom_manifest() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let src_tmp = tempfile::tempdir().unwrap();
        let zip_path = src_tmp.path().join("BaseLib.zip");

        let bom_manifest: Vec<u8> = {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(
                br#"{
  "id": "BaseLib",
  "name": "BaseLib",
  "author": "Alchyr",
  "description": "Modding utility for Slay the Spire 2",
  "version": "v3.1.2",
  "has_pck": true,
  "has_dll": true,
  "dependencies": [],
  "affects_gameplay": false
}"#,
            );
            v
        };
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zw.start_file("BaseLib/BaseLib.json", opts).unwrap();
            zw.write_all(&bom_manifest).unwrap();
            zw.start_file("BaseLib/BaseLib.dll", opts).unwrap();
            zw.write_all(b"fake-dll-bytes").unwrap();
            zw.start_file("BaseLib/BaseLib.pck", opts).unwrap();
            zw.write_all(b"fake-pck-bytes").unwrap();
            zw.finish().unwrap();
        }

        let mods_tmp = tempfile::tempdir().unwrap();
        let info = super::install_mod_from_zip(&zip_path, mods_tmp.path())
            .expect("install_mod_from_zip must succeed on a BOM-manifest zip");

        assert_eq!(info.name, "BaseLib");
        assert_eq!(
            info.version, "v3.1.2",
            "install must surface the manifest version, NOT 'unknown'. \
             A regression here means the install pipeline lost BOM tolerance \
             even though the read path kept it."
        );
        assert_eq!(info.author.as_deref(), Some("Alchyr"));
        assert_eq!(info.mod_id.as_deref(), Some("BaseLib"));
        assert_eq!(
            info.folder_name.as_deref(),
            Some("BaseLib"),
            "folder_name must resolve to the wrap directory, not the zip stem"
        );

        // The extracted manifest on disk must still have the BOM (we
        // didn't rewrite the user's file).
        let extracted_manifest =
            fs::read(mods_tmp.path().join("BaseLib").join("BaseLib.json")).unwrap();
        assert_eq!(
            &extracted_manifest[0..3],
            &[0xEF, 0xBB, 0xBF],
            "BOM must be preserved on disk — install reads through it, doesn't strip it"
        );
    }

    /// Sanity: a well-formed manifest still goes through the strict path
    /// (the lenient fallback is a recovery hatch, not the default).
    #[test]
    fn well_formed_manifest_parses_via_strict_path() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let manifest_path = base.join("good").join("manifest.json");
        write(
            &manifest_path,
            r#"{
                "name": "GoodMod",
                "version": "3.1.4",
                "dependencies": [{"id": "Dep", "min_version": "1.0"}, "PlainDep"]
            }"#,
        );
        write(&base.join("good").join("good.dll"), "");

        let parsed = parse_manifest(&manifest_path, base, true).unwrap();
        assert_eq!(parsed.name, "GoodMod");
        assert_eq!(parsed.version, "3.1.4");
        assert_eq!(parsed.dependencies, vec!["Dep", "PlainDep"]);
    }
}

#[cfg(test)]
mod profile_manifest_refresh_tests {
    use super::*;
    use crate::profiles::{load_profile, save_profile, Profile, ProfileMod};

    fn write_test_mod(mods_path: &Path, folder: &str, version: &str) {
        let dir = mods_path.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{}.json", folder)),
            format!(
                r#"{{
  "id": "{folder}",
  "name": "{folder}",
  "version": "{version}",
  "author": "qa"
}}"#,
                folder = folder,
                version = version,
            ),
        )
        .unwrap();
        fs::write(dir.join(format!("{}.dll", folder)), b"dll").unwrap();
    }

    fn profile_with_mod(name: &str, mod_name: &str, version: &str) -> Profile {
        let now = chrono::Utc::now();
        Profile {
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![ProfileMod {
                name: mod_name.into(),
                version: version.into(),
                source: None,
                hash: None,
                files: vec![
                    format!("{}/{}.json", mod_name, mod_name),
                    format!("{}/{}.dll", mod_name, mod_name),
                ],
                folder_name: Some(mod_name.into()),
                mod_id: Some(mod_name.into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
            }],
            created_at: now,
            updated_at: now,
            public: None,
        }
    }

    #[test]
    fn delete_all_mods_does_not_rewrite_active_profile_manifest_to_empty() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_test_mod(&mods_path, "BaseLib", "v3.1.2");
        save_profile(
            &profile_with_mod("Active Pack", "BaseLib", "v3.1.2"),
            &profiles_path,
        )
        .unwrap();

        let deleted =
            delete_all_mods_from_paths(&mods_path, &disabled_path).expect("bulk delete succeeds");

        assert_eq!(deleted, 1);
        assert!(
            fs::read_dir(&mods_path).unwrap().next().is_none(),
            "bulk delete should clear the active mods folder"
        );
        assert!(
            fs::read_dir(&disabled_path).unwrap().next().is_none(),
            "bulk delete should leave the disabled mods folder empty too"
        );

        let profile = load_profile("Active Pack", &profiles_path).unwrap();
        assert!(
            profile.mods.iter().any(|m| m.name == "BaseLib"),
            "delete_all_mods must not overwrite the active profile manifest with an empty snapshot"
        );
    }

    #[test]
    fn delete_single_mod_does_not_rewrite_active_profile_manifest() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_test_mod(&mods_path, "BaseLib", "v3.1.2");
        save_profile(
            &profile_with_mod("Active Pack", "BaseLib", "v3.1.2"),
            &profiles_path,
        )
        .unwrap();

        delete_mod_from_paths("BaseLib", Some("BaseLib"), &mods_path, &disabled_path)
            .expect("single delete succeeds");

        assert!(
            fs::read_dir(&mods_path).unwrap().next().is_none(),
            "single delete should remove the mod from disk"
        );

        let profile = load_profile("Active Pack", &profiles_path).unwrap();
        assert_eq!(
            profile.mods.len(),
            1,
            "delete_mod must leave the saved manifest intact so re-activating the profile can restore it"
        );
        assert_eq!(profile.mods[0].name, "BaseLib");
        assert_eq!(profile.mods[0].version, "v3.1.2");
    }

    #[test]
    fn delete_mod_files_by_info_ignores_paths_that_escape_mods_dir() {
        let game_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        fs::create_dir_all(&mods_path).unwrap();
        let protected = game_tmp.path().join("SlayTheSpire2.exe");
        fs::write(&protected, b"game binary").unwrap();

        let info = ModInfo {
            name: "BadManifest".into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![
                "../SlayTheSpire2.exe".into(),
                "BadManifest/BadManifest.dll".into(),
            ],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some("BadManifest".into()),
            mod_id: Some("BadManifest".into()),
            github_url: None,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
        };

        let mod_dir = mods_path.join("BadManifest");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(mod_dir.join("BadManifest.dll"), b"dll").unwrap();

        delete_mod_files_by_info(&info, &mods_path);

        assert!(
            protected.exists(),
            "mod cleanup must never follow profile file paths outside the mods directory"
        );
        assert!(
            !mod_dir.exists(),
            "valid mod-owned empty folders may still be cleaned up"
        );
    }

    #[test]
    fn delete_all_mods_refuses_non_mod_roots() {
        let game_tmp = tempfile::tempdir().unwrap();
        let game_root = game_tmp.path();
        let disabled_path = game_root.join("mods_disabled");
        fs::create_dir_all(&disabled_path).unwrap();
        let protected = game_root.join("SlayTheSpire2.exe");
        fs::write(&protected, b"game binary").unwrap();

        let err = delete_all_mods_from_paths(game_root, &disabled_path)
            .expect_err("bulk delete must reject paths that are not the mods folder");

        assert!(
            err.contains("Refusing to delete all mods"),
            "error should explain the safety refusal, got: {err}"
        );
        assert!(protected.exists(), "game-root files must be left untouched");
    }
}
