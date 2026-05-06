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
    /// Mod's unique ID (used by game for dependency resolution)
    #[serde(alias = "Id", alias = "ID")]
    id: Option<String>,
    /// PCK resource name
    #[serde(alias = "PckName", alias = "pck_name")]
    pck_name: Option<String>,
    /// Additional fields that might contain URLs
    #[serde(alias = "Homepage", alias = "homepage")]
    homepage: Option<String>,
    #[serde(alias = "Repository", alias = "repository", alias = "Repo", alias = "repo")]
    repository: Option<String>,
    #[serde(alias = "Url", alias = "url", alias = "URL")]
    url: Option<String>,
    #[serde(alias = "Author", alias = "author")]
    author: Option<String>,
}

impl Default for RawManifest {
    fn default() -> Self {
        Self {
            name: String::new(),
            version: "0.0.0".to_string(),
            description: String::new(),
            dependencies: Vec::new(),
            source: None,
            id: None,
            pck_name: None,
            homepage: None,
            repository: None,
            url: None,
            author: None,
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

    // Determine the folder name on disk
    let folder_name = if manifest_path.parent() == Some(base_dir) {
        // Top-level manifest: folder_name is the json stem
        manifest_path.file_stem().map(|s| s.to_string_lossy().to_string())
    } else {
        // Subdirectory manifest: folder_name is the immediate parent dir name
        manifest_path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
    };

    let mod_id = raw.id.clone().or_else(|| raw.pck_name.clone());

    let files = collect_mod_files(manifest_path, base_dir);
    let dll_path = manifest_path.with_extension("dll");
    let file_hash = if dll_path.exists() {
        hash_file(&dll_path)
    } else {
        hash_file(manifest_path)
    };

    let size_bytes = calculate_mod_size(base_dir, &files);

    // Try to extract GitHub/Nexus URLs from manifest fields
    let all_urls: Vec<&str> = [
        raw.source.as_deref(),
        raw.homepage.as_deref(),
        raw.repository.as_deref(),
        raw.url.as_deref(),
    ]
    .iter()
    .filter_map(|u| *u)
    .collect();

    let mut github_url = None;
    let mut nexus_url = None;
    for u in &all_urls {
        if u.contains("github.com/") && github_url.is_none() {
            github_url = Some(u.to_string());
        } else if u.starts_with("github:") && github_url.is_none() {
            let repo = u.strip_prefix("github:").unwrap_or("");
            if !repo.is_empty() {
                github_url = Some(format!("https://github.com/{}", repo));
            }
        }
        if u.contains("nexusmods.com/") && nexus_url.is_none() {
            nexus_url = Some(u.to_string());
        }
    }

    // If we still don't have URLs, try scanning the raw JSON for any URL-like strings
    if github_url.is_none() || nexus_url.is_none() {
        // Look for URLs anywhere in the raw JSON content
        for cap in regex::Regex::new(r#"https?://[^\s",}]+"#)
            .ok()
            .iter()
            .flat_map(|re| re.find_iter(&content))
        {
            let url_str = cap.as_str();
            if github_url.is_none() && url_str.contains("github.com/") {
                // Clean up trailing slashes, .git suffix
                let clean = url_str
                    .trim_end_matches('/')
                    .trim_end_matches(".git");
                github_url = Some(clean.to_string());
            }
            if nexus_url.is_none() && url_str.contains("nexusmods.com/") {
                nexus_url = Some(url_str.to_string());
            }
        }
    }

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
        folder_name,
        mod_id,
        github_url,
        nexus_url,
    })
}

/// Create a ModInfo for a DLL-only mod (no JSON manifest).
fn dll_only_mod(dll_path: &Path, base_dir: &Path, enabled: bool) -> ModInfo {
    let name = dll_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let folder_name = if dll_path.parent() == Some(base_dir) {
        Some(name.clone())
    } else {
        dll_path.parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
    };

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
        folder_name,
        mod_id: None,
        github_url: None,
        nexus_url: None,
    }
}

/// If `dir` contains exactly one entry which is a directory of the same name,
/// return that nested path. Used to recover from doubly-nested mod folders.
fn single_same_named_child(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    if entries.len() != 1 {
        return None;
    }
    let only = &entries[0];
    let only_path = only.path();
    if only_path.is_dir() && only.file_name() == dir.file_name()? {
        Some(only_path)
    } else {
        None
    }
}

/// Try to load a mod from `dir`, looking first for a parsable .json manifest,
/// then falling back to a DLL-only mod. Returns true on success.
fn try_load_mod_from(
    dir: &Path,
    base_dir: &Path,
    enabled: bool,
    found_names: &mut std::collections::HashSet<String>,
    mods: &mut Vec<ModInfo>,
) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let entries: Vec<_> = entries.flatten().collect();

    for sub_entry in &entries {
        let sub_path = sub_entry.path();
        if sub_path.is_file() && sub_path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(info) = parse_manifest(&sub_path, base_dir, enabled) {
                if !found_names.contains(&info.name) {
                    found_names.insert(info.name.clone());
                    mods.push(info);
                }
                return true;
            }
        }
    }

    for sub_entry in &entries {
        let sub_path = sub_entry.path();
        if sub_path.is_file() && sub_path.extension().and_then(|e| e.to_str()) == Some("dll") {
            let info = dll_only_mod(&sub_path, base_dir, enabled);
            if !found_names.contains(&info.name) {
                found_names.insert(info.name.clone());
                mods.push(info);
            }
            return true;
        }
    }

    false
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

            // Try to find a manifest or DLL at this depth, then (as a fallback)
            // one level deeper inside a same-named subdir to recover from
            // packaging quirks where mods land at mods/Foo/Foo/Foo.dll.
            let mut found = try_load_mod_from(&path, dir, enabled, &mut found_names, &mut mods);
            if !found {
                if let Some(nested) = single_same_named_child(&path) {
                    found = try_load_mod_from(&nested, dir, enabled, &mut found_names, &mut mods);
                }
            }
            let _ = found;
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

/// Normalize a name for fuzzy matching: lowercase and strip spaces/hyphens/underscores.
fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Move mod files using the actual file list from ModInfo.
/// Handles destination conflicts by removing existing files before moving.
pub fn move_mod_by_info(mod_info: &ModInfo, src: &Path, dest: &Path) -> Result<()> {
    let _ = fs::create_dir_all(dest);

    let mut moved_any = false;

    for file_rel in &mod_info.files {
        // Normalize path separators for cross-platform compatibility
        let normalized = file_rel.replace('\\', "/");
        let src_file = src.join(&normalized);
        let dest_file = dest.join(&normalized);

        if !src_file.exists() {
            // If the file is already at the destination, count it as moved
            if dest_file.exists() {
                moved_any = true;
            }
            continue;
        }

        // Ensure parent directories exist for subdirectory mods
        if let Some(parent) = dest_file.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Remove destination file if it already exists (handles partial previous moves)
        if dest_file.exists() {
            if dest_file.is_dir() {
                let _ = fs::remove_dir_all(&dest_file);
            } else {
                let _ = fs::remove_file(&dest_file);
            }
        }

        fs::rename(&src_file, &dest_file).or_else(|_| {
            fs::copy(&src_file, &dest_file).and_then(|_| fs::remove_file(&src_file))
        })?;
        moved_any = true;
    }

    // Clean up empty subdirectories left behind in src
    for file_rel in &mod_info.files {
        let rel_path = Path::new(file_rel);
        if let Some(parent_rel) = rel_path.parent() {
            if !parent_rel.as_os_str().is_empty() {
                let parent_dir = src.join(parent_rel);
                if parent_dir.is_dir() {
                    let _ = fs::remove_dir(&parent_dir);
                }
            }
        }
    }

    if !moved_any {
        return Err(AppError::ModNotFound(format!(
            "No files found for mod '{}' in {}",
            mod_info.name,
            src.display()
        )));
    }

    Ok(())
}

/// Move all files associated with a mod between two directories.
/// Uses name matching with fallback to fuzzy (case-insensitive, no-spaces) comparison.
fn move_mod_files(mod_name: &str, src: &Path, dest: &Path) -> Result<()> {
    let _ = fs::create_dir_all(dest);

    let mut found = false;
    let normalized_mod = normalize_name(mod_name);

    // Move files matching the mod name (same stem) - exact or fuzzy
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let fstem = Path::new(&fname)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Exact match or normalized (case-insensitive, no spaces) match
            if fstem == mod_name || normalize_name(&fstem) == normalized_mod {
                let dest_file = dest.join(&fname);
                // Remove destination if it already exists (handles stale/partial state)
                if dest_file.exists() {
                    if dest_file.is_dir() {
                        let _ = fs::remove_dir_all(&dest_file);
                    } else {
                        let _ = fs::remove_file(&dest_file);
                    }
                }
                fs::rename(entry.path(), &dest_file)?;
                found = true;
            }
        }
    }

    // Also check for a subdirectory with the mod name (exact or normalized)
    let sub_dir = src.join(mod_name);
    if sub_dir.is_dir() {
        let dest_dir = dest.join(mod_name);
        move_directory(&sub_dir, &dest_dir)?;
        let _ = fs::remove_dir_all(&sub_dir);
        found = true;
    } else if !found {
        // Try finding a subdirectory by normalized name
        if let Ok(entries) = fs::read_dir(src) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    if normalize_name(&dir_name) == normalized_mod {
                        let dest_dir = dest.join(&dir_name);
                        move_directory(&path, &dest_dir)?;
                        let _ = fs::remove_dir_all(&path);
                        found = true;
                        break;
                    }
                }
            }
        }
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

/// Recursively move a directory (copy + delete source).
pub fn move_directory(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            move_directory(&src_path, &dest_path)?;
        } else {
            fs::rename(&src_path, &dest_path).or_else(|_| {
                fs::copy(&src_path, &dest_path).and_then(|_| fs::remove_file(&src_path))
            })?;
        }
    }
    // Remove the now-empty source directory
    let _ = fs::remove_dir(src);
    Ok(())
}

/// Delete a mod's files from disk using its scanned file list.
/// Used during profile switching to remove version-mismatched mods before reinstalling.
pub fn delete_mod_files_by_info(mod_info: &ModInfo, base_path: &Path) {
    let mut parent_dirs = std::collections::HashSet::new();

    for file_rel in &mod_info.files {
        let normalized = file_rel.replace('\\', "/");
        let file_path = base_path.join(&normalized);
        if file_path.is_dir() {
            let _ = fs::remove_dir_all(&file_path);
        } else if file_path.exists() {
            let _ = fs::remove_file(&file_path);
        }
        if let Some(parent_rel) = Path::new(&normalized).parent() {
            if !parent_rel.as_os_str().is_empty() {
                parent_dirs.insert(base_path.join(parent_rel));
            }
        }
    }

    for dir in &parent_dirs {
        if dir.is_dir() {
            if fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = fs::remove_dir(dir);
            }
        }
    }

    log::info!("Deleted {} files for mod '{}' from {}", mod_info.files.len(), mod_info.name, base_path.display());
}

// ── Local Mod Version Cache ────────────────────────────────────────────────

/// Sanitize a string for use in filenames.
fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Build the local cache path for a specific mod version.
fn mod_cache_path(cache_path: &Path, mod_name: &str, version: &str) -> PathBuf {
    let safe_name = sanitize_for_filename(mod_name);
    let safe_ver = sanitize_for_filename(version.trim_start_matches('v'));
    cache_path.join("mod_versions").join(format!("{}_{}.zip", safe_name, safe_ver))
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
                        let entry_rel = format!("{}/{}", normalized, entry.file_name().to_string_lossy());
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
            log::info!("Cached mod '{}' v{} to local cache", mod_info.name, mod_info.version);
            Some(dest)
        }
        Err(e) => {
            log::warn!("Failed to finalize cache zip for '{}': {}", mod_info.name, e);
            let _ = fs::remove_file(&dest);
            None
        }
    }
}

/// Check if a cached version of a mod exists locally.
pub fn get_cached_mod_path(cache_path: &Path, mod_name: &str, version: &str) -> Option<PathBuf> {
    let path = mod_cache_path(cache_path, mod_name, version);
    if path.exists() { Some(path) } else { None }
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
        let mut entry = archive.by_index(i)
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

/// Strip Nexus Mods filename suffixes.
/// E.g. "STS2-Ritsu-281-0-0-46-1775500710" -> "STS2-Ritsu"
/// "RelicsReminder-284-1-1-0-1775500710" -> "RelicsReminder"
fn strip_nexus_suffix(stem: &str) -> String {
    let bytes = stem.as_bytes();
    let mut cut_pos = stem.len();

    // Walk backwards stripping -digits groups
    let mut pos = stem.len();
    loop {
        let digit_end = pos;
        while pos > 0 && bytes[pos - 1].is_ascii_digit() {
            pos -= 1;
        }
        if pos == digit_end {
            break;
        }
        if pos > 0 && bytes[pos - 1] == b'-' {
            cut_pos = pos - 1;
            pos -= 1;
        } else {
            break;
        }
    }

    if cut_pos > 0 && cut_pos < stem.len() {
        stem[..cut_pos].to_string()
    } else {
        stem.to_string()
    }
}

/// Peek inside a zip archive to find a mod manifest and extract the mod name.
/// Returns the Id/PckName/Name from the first valid manifest found.
fn peek_manifest_name(archive: &mut zip::ZipArchive<fs::File>) -> Option<String> {
    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            let entry_name = entry.name().to_string();
            if !entry_name.to_lowercase().ends_with(".json") {
                continue;
            }
            if entry_name.starts_with("__MACOSX") || entry_name.starts_with("._") {
                continue;
            }
            if entry_name.split('/').count() > 2 {
                continue;
            }
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut entry, &mut buf).is_ok() {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&buf) {
                    // Prefer Id (game uses this for dependency resolution), then PckName, then Name
                    if let Some(id) = val.get("Id").or_else(|| val.get("id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Some(id.to_string());
                    }
                    if let Some(pck) = val.get("PckName").or_else(|| val.get("pck_name"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Some(pck.to_string());
                    }
                    if let Some(name) = val.get("Name").or_else(|| val.get("name"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Install a mod from a zip archive into the mods directory.
pub fn install_mod_from_zip(zip_path: &Path, mods_path: &Path) -> Result<ModInfo> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    let _ = fs::create_dir_all(mods_path);

    // First pass: figure out the zip structure using mod-relevant files
    // (.dll, .json, .pck) to determine extraction strategy.
    // NOTE: We extract ALL files from the zip, not just these — mods may
    // include .xml, .cfg, resource files, dependency DLLs in subfolders, etc.
    let mut relevant_entries: Vec<String> = Vec::new();
    let mut all_entries: Vec<String> = Vec::new();
    let mut top_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut all_top_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if entry.is_dir() || name.starts_with("__MACOSX") || name.starts_with("._") {
            continue;
        }
        all_entries.push(name.clone());
        // Track top-level dirs for ALL files
        if let Some(first) = name.split('/').next() {
            if name.contains('/') {
                all_top_dirs.insert(first.to_string());
            }
        }
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ["dll", "json", "pck"].contains(&ext.as_str()) {
            relevant_entries.push(name.clone());
            // Collect the first path component for mod files
            if let Some(first) = name.split('/').next() {
                if name.contains('/') {
                    top_dirs.insert(first.to_string());
                }
            }
        }
    }

    // Determine extraction strategy based on mod-relevant files:
    // - If mod files share exactly one top-level directory, preserve that subdirectory
    // - If mod files are at root (no subdirectory), put them in a subdir
    // - If there are multiple top-level dirs, extract as-is
    let has_single_subdir = top_dirs.len() == 1 || (top_dirs.is_empty() && all_top_dirs.len() == 1);
    let all_at_root = relevant_entries.iter().all(|n| !n.contains('/'));

    // Detect a packaging quirk where the zip wraps everything in a redundant
    // outer folder of the same name (e.g. "Foo/Foo/Foo.dll"). Strip the outer
    // level so the mod ends up at "Foo/Foo.dll" rather than nested two deep,
    // which would confuse scan_mods (it only descends one level).
    let strip_redundant_outer: Option<String> = if all_top_dirs.len() == 1 && !all_entries.is_empty() {
        let outer = all_top_dirs.iter().next().cloned().unwrap();
        let nested_prefix = format!("{}/{}/", outer, outer);
        if all_entries.iter().all(|n| n.starts_with(&nested_prefix)) {
            Some(outer)
        } else {
            None
        }
    } else {
        None
    };
    
    // Use the all_top_dirs single dir if mod files are at root but other files aren't
    let effective_single_subdir = if top_dirs.len() == 1 {
        top_dirs.iter().next().cloned()
    } else if all_top_dirs.len() == 1 {
        all_top_dirs.iter().next().cloned()
    } else {
        None
    };

    let zip_stem = zip_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // When files are at root and we need to wrap them in a subdirectory,
    // try to determine the correct folder name from the mod manifest or
    // DLL/PCK filenames rather than using the zip filename (which may
    // include Nexus suffixes like "STS2-Ritsu-281-0-0-46-1775500710").
    let wrap_folder_name = if all_at_root && all_entries.len() > 1 {
        // Strategy 1: Peek at manifest JSON inside the zip for mod name/id
        let manifest_name = peek_manifest_name(&mut archive);

        // Strategy 2: Use the DLL/PCK filename stem (most reliable for game dependency resolution)
        let dll_stem = relevant_entries.iter()
            .find(|n| {
                let ext = Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                ext == "dll" || ext == "pck"
            })
            .and_then(|n| Path::new(n).file_stem())
            .map(|s| s.to_string_lossy().to_string());

        // Strategy 3: Strip Nexus suffixes from the zip stem
        let clean_stem = strip_nexus_suffix(&zip_stem);

        // Prefer DLL stem (what the game actually loads), then manifest name, then cleaned zip stem
        dll_stem.or(manifest_name).unwrap_or(clean_stem)
    } else {
        zip_stem.clone()
    };

    let mut extracted_files = Vec::new();
    let mut manifest: Option<ModInfo> = None;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();

        if entry.is_dir() || name.starts_with("__MACOSX") || name.starts_with("._") {
            continue;
        }

        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Extract ALL files, not just .dll/.json/.pck — mods may include
        // .xml configs, .deps.json, additional DLLs in subfolders, resources, etc.
        // The ReflectionTypeLoadException in .NET mods is often caused by
        // missing dependency files that were filtered out.

        // Determine the relative path to extract to
        let rel_path = if let Some(ref outer) = strip_redundant_outer {
            // Doubly-nested same-name folder in the zip — drop the outer
            // "Foo/" prefix so we install at "Foo/<files>" not "Foo/Foo/<files>".
            name.strip_prefix(&format!("{}/", outer)).unwrap_or(&name).to_string()
        } else if has_single_subdir {
            // Keep the subdirectory structure as-is (e.g., ModName/ModName.dll)
            name.clone()
        } else if all_at_root {
            // Mod files are at root: wrap in a subdirectory named after the mod
            // Only if there are multiple files; single file stays flat
            if all_entries.len() == 1 {
                name.clone()
            } else {
                format!("{}/{}", wrap_folder_name, name)
            }
        } else {
            // Multiple top-level dirs or mixed: preserve as-is
            name.clone()
        };

        let dest_path = mods_path.join(&rel_path);

        // Ensure parent directory exists
        if let Some(parent) = dest_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Overwrite if file already exists
        let mut outfile = fs::File::create(&dest_path)?;
        io::copy(&mut entry, &mut outfile)?;
        extracted_files.push(rel_path.clone());

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
            let mod_name = zip_stem;
            Ok(ModInfo {
                name: mod_name.clone(),
                version: "unknown".to_string(),
                description: String::new(),
                enabled: true,
                files: extracted_files,
                source: None,
                hash: hash_file(zip_path),
                dependencies: Vec::new(),
                size_bytes,
                folder_name: Some(mod_name),
                mod_id: None,
                github_url: None,
                nexus_url: None,
            })
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Get all installed mods (active + disabled), enriched with source links.
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

    // Enrich with source metadata (GitHub/Nexus links)
    crate::mod_sources::enrich_mods_with_sources(&mut all_mods, &s.config_path);

    Ok(all_mods)
}

/// Toggle a mod between enabled and disabled.
#[tauri::command]
pub fn toggle_mod(name: String, enable: bool, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?;
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?;

    let (src, dest) = if enable {
        (disabled_path.as_path(), mods_path.as_path())
    } else {
        (mods_path.as_path(), disabled_path.as_path())
    };

    // First try the simple name-based move
    match move_mod_files(&name, src, dest) {
        Ok(()) => return Ok(true),
        Err(_) => {
            // Fallback: scan for actual ModInfo and use file list
            let mods_in_src = scan_mods_inner(src, enable);
            let mod_info = mods_in_src.iter().find(|m| m.name == name);
            if let Some(info) = mod_info {
                move_mod_by_info(info, src, dest).map_err(|e| e.to_string())?;
            } else {
                return Err(format!("No files found for mod '{}' in {}", name, src.display()));
            }
        }
    }

    Ok(true)
}

/// Permanently delete a mod.
#[tauri::command]
pub fn delete_mod_cmd(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
    drop(s);

    // Scan to find the mod by its manifest name and get its actual file paths
    let all_mods: Vec<ModInfo> = scan_mods(&mods_path)
        .into_iter()
        .chain(scan_disabled_mods(&disabled_path).into_iter())
        .collect();

    if let Some(info) = all_mods.iter().find(|m| m.name == name) {
        let base_path = if info.enabled { &mods_path } else { &disabled_path };

        // Collect parent dirs to clean up later
        let mut parent_dirs = std::collections::HashSet::new();

        // Delete each file the mod owns
        for file_rel in &info.files {
            let normalized = file_rel.replace('\\', "/");
            let file_path = base_path.join(&normalized);
            if file_path.is_dir() {
                let _ = fs::remove_dir_all(&file_path);
            } else if file_path.exists() {
                let _ = fs::remove_file(&file_path);
            }
            // Track parent directory for cleanup
            if let Some(parent_rel) = Path::new(&normalized).parent() {
                if !parent_rel.as_os_str().is_empty() {
                    parent_dirs.insert(base_path.join(parent_rel));
                }
            }
        }

        // Remove empty parent directories (subdirectory mods)
        for dir in &parent_dirs {
            if dir.is_dir() {
                // Only remove if empty
                if fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
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
    for search_path in [&mods_path, &disabled_path] {
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

                if fstem == name || normalize_name(&fstem) == norm || normalize_name(&entry_name) == norm {
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
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
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
                fs::rename(&src, &dest).or_else(|_| {
                    fs::copy(&src, &dest).and_then(|_| fs::remove_file(&src))
                }).map(|_| ())
            };

            if let Err(e) = result {
                errors.push(format!("{}: {}", name, e));
            }
        }
    }

    if !errors.is_empty() {
        log::warn!("Some mods failed to enable: {:?}", errors);
    }
    Ok(true)
}

/// Disable all currently enabled mods.
/// Uses direct filesystem iteration instead of scan-then-move for reliability.
#[tauri::command]
pub fn disable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
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
                fs::rename(&src, &dest).or_else(|_| {
                    fs::copy(&src, &dest).and_then(|_| fs::remove_file(&src))
                }).map(|_| ())
            };

            if let Err(e) = result {
                errors.push(format!("{}: {}", name, e));
            }
        }
    }

    if !errors.is_empty() {
        log::warn!("Some mods failed to disable: {:?}", errors);
    }
    Ok(true)
}

/// Delete ALL mods from both enabled and disabled folders.
#[tauri::command]
pub fn delete_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<u32, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s.disabled_mods_path.as_ref().ok_or("Game path not set")?.clone();
    drop(s);

    let mut count = 0u32;
    for search_path in [&mods_path, &disabled_path] {
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
    log::info!("Deleted all mods ({} items)", count);
    Ok(count)
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

