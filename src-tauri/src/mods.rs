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
    pub size_bytes: u64,
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

/// Calculate total size of files in a list relative to a base directory.
fn calculate_mod_size(base_dir: &Path, files: &[String]) -> u64 {
    files.iter().map(|f| {
        let path = base_dir.join(f);
        path.metadata().map(|m| m.len()).unwrap_or(0)
    }).sum()
}

/// Collect all files belonging to a mod entry (the .json and co-located .dll/.pck files).
fn collect_mod_files(manifest_path: &Path, base_dir: &Path) -> Vec<String> {
    let parent = match manifest_path.parent() {
        Some(p) => p,
        None => return vec![manifest_path.to_string_lossy().to_string()],
    };

    let mut files = Vec::new();

    // If the manifest is inside the base mods dir (not a subdirectory)
    if parent == base_dir {
        let stem = manifest_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Look for same-named .dll, .pck, .json files
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                let fstem = Path::new(&fname)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if fstem == stem && entry.path().is_file() {
                    files.push(fname);
                }
            }
        }
    } else {
        // Manifest is in a subdirectory - collect all files in that subdirectory
        for entry in WalkDir::new(parent).into_iter().flatten() {
            if entry.file_type().is_file() {
                if let Ok(rel) = entry.path().strip_prefix(base_dir) {
                    files.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    if files.is_empty() {
        if let Ok(rel) = manifest_path.strip_prefix(base_dir) {
            files.push(rel.to_string_lossy().to_string());
        } else {
            files.push(
                manifest_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }

    files
}

/// Parse a single manifest JSON into a ModInfo.
fn parse_manifest(manifest_path: &Path, base_dir: &Path, enabled: bool) -> Option<ModInfo> {
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

    let files = collect_mod_files(manifest_path, base_dir);
    let dll_path = manifest_path.with_extension("dll");
    let file_hash = if dll_path.exists() {
        hash_file(&dll_path)
    } else {
        hash_file(manifest_path)
    };

    let size_bytes = calculate_mod_size(base_dir, &files);

    Some(ModInfo {
        name,
        version: raw.version,
        description: raw.description,
        enabled,
        files,
        source: raw.source,
        hash: file_hash,
        dependencies: raw.dependencies,
        size_bytes,
    })
}

/// Create a ModInfo for a DLL-only mod (no JSON manifest).
fn dll_only_mod(dll_path: &Path, base_dir: &Path, enabled: bool) -> ModInfo {
    let name = dll_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let file_name = if let Ok(rel) = dll_path.strip_prefix(base_dir) {
        rel.to_string_lossy().to_string()
    } else {
        dll_path.file_name().unwrap_or_default().to_string_lossy().to_string()
    };

    let size_bytes = dll_path.metadata().map(|m| m.len()).unwrap_or(0);

    // Also check for a co-located .pck file
    let pck_path = dll_path.with_extension("pck");
    let mut files = vec![file_name];
    if pck_path.exists() {
        if let Ok(rel) = pck_path.strip_prefix(base_dir) {
            files.push(rel.to_string_lossy().to_string());
        }
    }

    ModInfo {
        name,
        version: "unknown".to_string(),
        description: String::new(),
        enabled,
        files,
        source: None,
        hash: hash_file(dll_path),
        dependencies: Vec::new(),
        size_bytes,
    }
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
    let mut found_names = std::collections::HashSet::new();

    if !dir.exists() {
        return mods;
    }

    // PASS 1: Look for .json manifests at the top level
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(info) = parse_manifest(&path, dir, enabled) {
                    found_names.insert(info.name.clone());
                    mods.push(info);
                }
            }
        }
    }

    // PASS 2: Look in subdirectories (one level deep)
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Skip known non-mod directories
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('.') || dir_name == "__MACOSX" {
                continue;
            }

            // Look for .json manifests inside this subdirectory
            let mut found_json = false;
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if sub_path.is_file()
                        && sub_path.extension().and_then(|e| e.to_str()) == Some("json")
                    {
                        if let Some(info) = parse_manifest(&sub_path, dir, enabled) {
                            if !found_names.contains(&info.name) {
                                found_names.insert(info.name.clone());
                                mods.push(info);
                            }
                            found_json = true;
                            break; // One manifest per subdirectory
                        }
                    }
                }
            }

            // If no JSON found, check for DLL-only mod in this subdirectory
            if !found_json {
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub_entry in sub_entries.flatten() {
                        let sub_path = sub_entry.path();
                        if sub_path.is_file()
                            && sub_path.extension().and_then(|e| e.to_str()) == Some("dll")
                        {
                            let info = dll_only_mod(&sub_path, dir, enabled);
                            if !found_names.contains(&info.name) {
                                found_names.insert(info.name.clone());
                                mods.push(info);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // PASS 3: Find DLL-only mods at top level (DLLs without a matching .json)
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("dll") {
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !found_names.contains(&stem) {
                    let info = dll_only_mod(&path, dir, enabled);
                    found_names.insert(info.name.clone());
                    mods.push(info);
                }
            }
        }
    }

    // Sort by name for consistent ordering
    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
            manifest = parse_manifest(&dest_path, mods_path, true);
        }
    }

    let size_bytes = calculate_mod_size(mods_path, &extracted_files);

    match manifest {
        Some(mut m) => {
            m.files = extracted_files;
            m.size_bytes = size_bytes;
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
                size_bytes,
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
pub fn toggle_mod(name: String, enable: bool, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    if enable {
        enable_mod(&name, mods_path, disabled_path).map_err(|e| e.to_string())?;
    } else {
        disable_mod(&name, mods_path, disabled_path).map_err(|e| e.to_string())?;
    }

    Ok(true)
}

/// Permanently delete a mod.
#[tauri::command]
pub fn delete_mod_cmd(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    // Try removing from both enabled and disabled dirs
    let _ = delete_mod_files(&name, mods_path);
    let _ = delete_mod_files(&name, disabled_path);

    Ok(true)
}

/// Enable all currently disabled mods.
#[tauri::command]
pub fn enable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    let disabled = scan_disabled_mods(disabled_path);
    for m in &disabled {
        let _ = enable_mod(&m.name, mods_path, disabled_path);
    }
    Ok(true)
}

/// Disable all currently enabled mods.
#[tauri::command]
pub fn disable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    let enabled = scan_mods(mods_path);
    for m in &enabled {
        let _ = disable_mod(&m.name, mods_path, disabled_path);
    }
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
pub fn check_dependencies(mod_name: &str, mods_path: &Path) -> Vec<String> {
    let manifest_path = mods_path.join(format!("{}.json", mod_name));
    let content = match fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let raw: RawManifest = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let installed: std::collections::HashSet<String> = scan_mods(mods_path)
        .into_iter()
        .map(|m| m.name)
        .collect();

    raw.dependencies
        .into_iter()
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
