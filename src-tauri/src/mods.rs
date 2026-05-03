use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::error::{AppError, Result};
use crate::state::AppState;

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
}

/// Raw manifest structure from STS2 mod JSON files.
#[derive(Debug, Deserialize)]
#[serde(default)]
struct RawManifest {
    #[serde(alias = "Name")]
    name: String,
    #[serde(alias = "Version")]
    version: String,
    #[serde(alias = "Description")]
    description: String,
    #[serde(alias = "Dependencies")]
    dependencies: Vec<String>,
    #[serde(alias = "Source")]
    source: Option<String>,
}

impl Default for RawManifest {
    fn default() -> Self {
        Self {
            name: String::new(),
            version: "0.0.0".to_string(),
            description: String::new(),
            dependencies: Vec::new(),
            source: None,
        }
    }
}

/// Compute SHA256 hash of a file.
fn hash_file(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Some(format!("{:x}", hasher.finalize()))
}

/// Collect all files belonging to a mod entry (the .json and co-located .dll/.pck files).
fn collect_mod_files(manifest_path: &Path) -> Vec<String> {
    let parent = match manifest_path.parent() {
        Some(p) => p,
        None => return vec![manifest_path.to_string_lossy().to_string()],
    };
    let stem = manifest_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut files = Vec::new();

    // If the manifest is directly inside the mods folder
    // look for same-named .dll and .pck files
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let fstem = Path::new(&fname)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if fstem == stem {
                files.push(fname);
            }
        }
    }

    // If the mod lives in a subdirectory, include all files in it
    if files.len() <= 1 {
        let mod_dir = parent.join(&stem);
        if mod_dir.is_dir() {
            for entry in WalkDir::new(&mod_dir).into_iter().flatten() {
                if entry.file_type().is_file() {
                    if let Ok(rel) = entry.path().strip_prefix(parent) {
                        files.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    if files.is_empty() {
        files.push(
            manifest_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        );
    }

    files
}

/// Parse a single manifest JSON into a ModInfo.
fn parse_manifest(manifest_path: &Path, enabled: bool) -> Option<ModInfo> {
    let content = fs::read_to_string(manifest_path).ok()?;
    let raw: RawManifest = serde_json::from_str(&content).ok()?;

    let name = if raw.name.is_empty() {
        manifest_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    } else {
        raw.name
    };

    let files = collect_mod_files(manifest_path);
    let dll_path = manifest_path.with_extension("dll");
    let file_hash = if dll_path.exists() {
        hash_file(&dll_path)
    } else {
        hash_file(manifest_path)
    };

    Some(ModInfo {
        name,
        version: raw.version,
        description: raw.description,
        enabled,
        files,
        source: raw.source,
        hash: file_hash,
        dependencies: raw.dependencies,
    })
}

/// Scan a directory for mod manifests (.json files).
pub fn scan_mods(mods_path: &Path) -> Vec<ModInfo> {
    scan_mods_inner(mods_path, true)
}

/// Scan disabled mods directory.
pub fn scan_disabled_mods(disabled_path: &Path) -> Vec<ModInfo> {
    scan_mods_inner(disabled_path, false)
}

fn scan_mods_inner(dir: &Path, enabled: bool) -> Vec<ModInfo> {
    let mut mods = Vec::new();
    if !dir.exists() {
        return mods;
    }

    // Look for .json files in the top level
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(info) = parse_manifest(&path, enabled) {
                    mods.push(info);
                }
            }
        }
    }

    mods
}

/// Enable a mod by moving its files from disabled to active.
pub fn enable_mod(mod_name: &str, mods_path: &Path, disabled_path: &Path) -> Result<()> {
    move_mod_files(mod_name, disabled_path, mods_path)
}

/// Disable a mod by moving its files from active to disabled.
pub fn disable_mod(mod_name: &str, mods_path: &Path, disabled_path: &Path) -> Result<()> {
    move_mod_files(mod_name, mods_path, disabled_path)
}

/// Move all files associated with a mod between two directories.
fn move_mod_files(mod_name: &str, src: &Path, dest: &Path) -> Result<()> {
    let _ = fs::create_dir_all(dest);

    let mut found = false;

    // Move files matching the mod name (same stem)
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let fstem = Path::new(&fname)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if fstem == mod_name {
                let dest_file = dest.join(&fname);
                fs::rename(entry.path(), &dest_file)?;
                found = true;
            }
        }
    }

    // Also check for a subdirectory with the mod name
    let sub_dir = src.join(mod_name);
    if sub_dir.is_dir() {
        let dest_dir = dest.join(mod_name);
        move_dir_recursive(&sub_dir, &dest_dir)?;
        fs::remove_dir_all(&sub_dir)?;
        found = true;
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

/// Recursively copy a directory.
fn move_dir_recursive(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            move_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::rename(&src_path, &dest_path).or_else(|_| {
                fs::copy(&src_path, &dest_path).map(|_| ())
            })?;
        }
    }
    Ok(())
}

/// Permanently remove a mod and all its files.
pub fn delete_mod_files(mod_name: &str, mods_path: &Path) -> Result<()> {
    let mut found = false;

    if let Ok(entries) = fs::read_dir(mods_path) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let fstem = Path::new(&fname)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if fstem == mod_name {
                fs::remove_file(entry.path())?;
                found = true;
            }
        }
    }

    let sub_dir = mods_path.join(mod_name);
    if sub_dir.is_dir() {
        fs::remove_dir_all(&sub_dir)?;
        found = true;
    }

    if !found {
        return Err(AppError::ModNotFound(format!(
            "Mod '{}' not found in {}",
            mod_name,
            mods_path.display()
        )));
    }

    Ok(())
}

/// Install a mod from a zip archive into the mods directory.
pub fn install_mod_from_zip(zip_path: &Path, mods_path: &Path) -> Result<ModInfo> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    let _ = fs::create_dir_all(mods_path);

    let mut extracted_files = Vec::new();
    let mut manifest: Option<ModInfo> = None;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();

        // Skip directories and __MACOSX junk
        if entry.is_dir() || name.starts_with("__MACOSX") {
            continue;
        }

        // We only care about .dll, .json, and .pck files for STS2 mods
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !["dll", "json", "pck"].contains(&ext.as_str()) {
            continue;
        }

        // Flatten path: extract only the file name part into mods/
        let file_name = Path::new(&name)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let dest_path = mods_path.join(&file_name);

        let mut outfile = fs::File::create(&dest_path)?;
        io::copy(&mut entry, &mut outfile)?;
        extracted_files.push(file_name.clone());

        // If it's a json, try parsing as manifest
        if ext == "json" && manifest.is_none() {
            manifest = parse_manifest(&dest_path, true);
        }
    }

    match manifest {
        Some(mut m) => {
            m.files = extracted_files;
            Ok(m)
        }
        None => {
            // No manifest found, create a minimal ModInfo from the zip name
            let mod_name = zip_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            Ok(ModInfo {
                name: mod_name,
                version: "unknown".to_string(),
                description: String::new(),
                enabled: true,
                files: extracted_files,
                source: None,
                hash: hash_file(zip_path),
                dependencies: Vec::new(),
            })
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Get all installed mods (active + disabled).
#[tauri::command]
pub fn get_installed_mods(state: tauri::State<'_, AppState>) -> std::result::Result<Vec<ModInfo>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut all_mods = Vec::new();

    if let Some(ref mods_path) = s.mods_path {
        all_mods.extend(scan_mods(mods_path));
    }
    if let Some(ref disabled_path) = s.disabled_mods_path {
        all_mods.extend(scan_disabled_mods(disabled_path));
    }

    Ok(all_mods)
}

/// Toggle a mod between enabled and disabled.
#[tauri::command]
pub fn toggle_mod(mod_name: String, enable: bool, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    if enable {
        enable_mod(&mod_name, mods_path, disabled_path).map_err(|e| e.to_string())?;
    } else {
        disable_mod(&mod_name, mods_path, disabled_path).map_err(|e| e.to_string())?;
    }

    Ok(true)
}

/// Permanently delete a mod.
#[tauri::command]
pub fn delete_mod_cmd(mod_name: String, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    // Try removing from both enabled and disabled dirs
    let _ = delete_mod_files(&mod_name, mods_path);
    let _ = delete_mod_files(&mod_name, disabled_path);

    Ok(true)
}

/// Install a mod from a local file (zip archive).
#[tauri::command]
pub fn install_mod_from_file(path: String, state: tauri::State<'_, AppState>) -> std::result::Result<ModInfo, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let zip_path = PathBuf::from(&path);
    install_mod_from_zip(&zip_path, mods_path).map_err(|e| e.to_string())
}

// ── Dependency Resolution ──────────────────────────────────────────────────

/// Check which dependencies of a mod are not currently installed.
///
/// Reads the mod's JSON manifest for its `Dependencies` field and checks
/// whether each dependency has a corresponding manifest in the mods directory.
pub fn check_dependencies(mod_name: &str, mods_path: &Path) -> Vec<String> {
    // Find the manifest for the target mod
    let manifest_path = mods_path.join(format!("{}.json", mod_name));
    let content = match fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let raw: RawManifest = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    // Collect names of all installed mods
    let installed: std::collections::HashSet<String> = scan_mods(mods_path)
        .into_iter()
        .map(|m| m.name)
        .collect();

    // Return dependencies that are not installed
    raw.dependencies
        .into_iter()
        .filter(|dep| !installed.contains(dep))
        .collect()
}

/// Find all installed mods that depend on the given mod.
///
/// Scans every installed mod's manifest and returns the names of those
/// that list `mod_name` in their `Dependencies`.
pub fn get_dependents(mod_name: &str, mods_path: &Path) -> Vec<String> {
    scan_mods(mods_path)
        .into_iter()
        .filter(|m| m.dependencies.iter().any(|d| d == mod_name))
        .map(|m| m.name)
        .collect()
}

/// Tauri command: return missing dependencies for a mod.
#[tauri::command]
pub fn check_mod_dependencies(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<Vec<String>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    Ok(check_dependencies(&name, mods_path))
}

/// Tauri command: return mods that depend on the given mod.
#[tauri::command]
pub fn get_mod_dependents(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<Vec<String>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    Ok(get_dependents(&name, mods_path))
}
