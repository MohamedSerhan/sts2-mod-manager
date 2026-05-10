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
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum RawDependency {
    Name(String),
    /// Structured form. We deserialize via the explicit `id` alias; any
    /// other fields the upstream manifest carries (e.g. `min_version`)
    /// are tolerated and ignored — serde drops unknown fields by default,
    /// so this stays forward-compatible with manifest schema additions
    /// without us tracking what we don't currently consume.
    Structured {
        #[serde(alias = "Id", alias = "ID", alias = "id")]
        id: String,
    },
}

impl RawDependency {
    /// Reduce to just the dep's identifier — that's all the rest of our
    /// dependency-resolution code currently consumes.
    fn id(&self) -> &str {
        match self {
            RawDependency::Name(s) => s,
            RawDependency::Structured { id } => id,
        }
    }
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
    dependencies: Vec<RawDependency>,
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
    /// Minimum STS2 build the mod's code targets (e.g. "0.105.0"). Mods
    /// declaring this expect game features / APIs that landed in that
    /// build; the game's loader silently skips mods whose requirement
    /// the current build doesn't satisfy.
    #[serde(alias = "MinGameVersion", alias = "min_game_version")]
    min_game_version: Option<String>,
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
            min_game_version: None,
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
    let content = match fs::read_to_string(manifest_path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "parse_manifest: could not read '{}': {}",
                manifest_path.display(), e,
            );
            return None;
        }
    };
    let raw: RawManifest = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(e) => {
            // The mod's manifest exists on disk but doesn't match our struct.
            // Loud-log the path + parse error so we can spot new manifest
            // format drift instead of silently falling back to a broken
            // dll-only stub.
            log::warn!(
                "parse_manifest: failed to deserialize '{}': {} — \
                 the mod will fall through to the DLL-only path and show \
                 with version 'unknown'. This is almost always a manifest \
                 schema change upstream; please open an issue with the \
                 manifest contents.",
                manifest_path.display(), e,
            );
            return None;
        }
    };

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

    // Reduce the deserialized dependencies to plain ID strings — that's
    // what the rest of the codebase consumes today (dependency-resolution
    // command, profile manifests). We may want to surface min_version in
    // the future, but plumbing it everywhere is a separate change.
    let deps_as_ids: Vec<String> = raw
        .dependencies
        .iter()
        .map(|d| d.id().to_string())
        .collect();

    Some(ModInfo {
        name,
        version: raw.version,
        description: raw.description,
        enabled,
        files,
        source: raw.source,
        hash: file_hash,
        dependencies: deps_as_ids,
        size_bytes,
        folder_name,
        mod_id,
        github_url,
        nexus_url,
        pinned: false,
        min_game_version: raw.min_game_version,
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
        pinned: false,
        min_game_version: None,
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
                // Same dedup-key registration as scan_mods_inner PASS 1 — see
                // that block for the rationale. Without these extra keys a
                // subdir mod gets double-counted by the top-level DLL pass
                // when its manifest Name differs from the DLL filename.
                found_names.insert(normalize_name(&info.name));
                if let Some(stem) = sub_path.file_stem().and_then(|s| s.to_str()) {
                    found_names.insert(normalize_name(stem));
                }
                if let Some(folder) = info.folder_name.as_deref() {
                    found_names.insert(normalize_name(folder));
                }
                for f in &info.files {
                    if let Some(stem) = std::path::Path::new(f).file_stem().and_then(|s| s.to_str()) {
                        found_names.insert(normalize_name(stem));
                    }
                }
                upsert_mod_dedup(mods, info, &sub_path.display().to_string());
                return true;
            }
        }
    }

    for sub_entry in &entries {
        let sub_path = sub_entry.path();
        if sub_path.is_file() && sub_path.extension().and_then(|e| e.to_str()) == Some("dll") {
            let info = dll_only_mod(&sub_path, base_dir, enabled);
            found_names.insert(normalize_name(&info.name));
            if let Some(folder) = info.folder_name.as_deref() {
                found_names.insert(normalize_name(folder));
            }
            upsert_mod_dedup(mods, info, &sub_path.display().to_string());
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

/// "Quality" score for a ModInfo entry — used to pick the best match when
/// the same mod (after name normalization) is detected by multiple scan
/// passes. A proper JSON manifest with a real version beats a DLL-only
/// fallback every time.
fn mod_quality(info: &ModInfo) -> u32 {
    let mut score = 0;
    let v = info.version.trim();
    if !v.is_empty() && v != "unknown" && v != "0.0.0" { score += 100; }
    if !info.description.trim().is_empty() { score += 20; }
    score += info.files.len() as u32;
    score
}

/// Add `info` to `mods`, but if another entry with a normalized-equivalent
/// name is already present, keep whichever has the richer manifest. Logs a
/// warning either way so the user knows there are duplicate files on disk.
fn upsert_mod_dedup(mods: &mut Vec<ModInfo>, info: ModInfo, source_hint: &str) {
    let key = normalize_name(&info.name);
    if let Some(pos) = mods.iter().position(|m| normalize_name(&m.name) == key) {
        let existing_quality = mod_quality(&mods[pos]);
        let new_quality = mod_quality(&info);
        if new_quality > existing_quality {
            log::warn!(
                "Replacing duplicate mod '{}' (existing) with '{}' from {} — better manifest. Clean up the older copy in your mods folder.",
                mods[pos].name,
                info.name,
                source_hint,
            );
            mods[pos] = info;
        } else {
            log::warn!(
                "Skipping duplicate mod '{}' from {} — '{}' already loaded with a richer manifest. Clean up the older copy in your mods folder.",
                info.name,
                source_hint,
                mods[pos].name,
            );
        }
        return;
    }
    mods.push(info);
}

fn scan_mods_inner(dir: &Path, enabled: bool) -> Vec<ModInfo> {
    let mut mods = Vec::new();
    let mut found_names = std::collections::HashSet::new();

    if !dir.exists() {
        return mods;
    }

    // PASS 1: Look for .json manifests at the top level.
    // Dedup by NORMALIZED name within the same folder — two manifests with
    // the same Name (allowing whitespace / case / dash differences) are
    // almost always leftover stale files. We keep whichever has the richer
    // manifest and log so the user can investigate.
    //
    // We register THREE keys per loaded mod into `found_names`:
    //   - normalized manifest Name (the user-facing name)
    //   - normalized json file stem (e.g. "HighlightPotionCards" when the
    //     manifest declares Name: "Highlight Card Types in Potion
    //     Description")
    //   - normalized stem of every sibling .dll/.pck file the manifest
    //     pulled in via collect_mod_files
    // PASS 3 (DLL-only fallback) checks the DLL stem, so without these
    // extra registrations a mod whose manifest Name doesn't match the DLL
    // filename gets DOUBLE-COUNTED — once as the JSON manifest and once
    // as an "orphan" DLL. That was the +1 in the user's count vs the
    // game's.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(info) = parse_manifest(&path, dir, enabled) {
                    found_names.insert(normalize_name(&info.name));
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        found_names.insert(normalize_name(stem));
                    }
                    for f in &info.files {
                        if let Some(stem) = std::path::Path::new(f).file_stem().and_then(|s| s.to_str()) {
                            found_names.insert(normalize_name(stem));
                        }
                    }
                    upsert_mod_dedup(&mut mods, info, &path.display().to_string());
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
    // Dedup by normalized name so an orphan `BetterSpire2Lite.dll` doesn't
    // re-register the same mod that PASS 1 already loaded as
    // `"BetterSpire2 Lite"` from a JSON manifest.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("dll") {
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !found_names.contains(&normalize_name(&stem)) {
                    let info = dll_only_mod(&path, dir, enabled);
                    found_names.insert(normalize_name(&info.name));
                    upsert_mod_dedup(&mut mods, info, &path.display().to_string());
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

/// Sanitize an attacker-influenced single path segment so it can't escape
/// when joined onto a destination root. Replaces any path-separator-like
/// characters and `..` with underscores. Used for `wrap_folder_name` and
/// for URL-derived filenames in the download path — those strings can come
/// from a manifest's Name/Id field, a zip stem, or a redirect URL, all of
/// which are publisher-controlled and therefore untrusted.
pub fn sanitize_path_segment(s: &str) -> String {
    let mapped: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            _ => c,
        })
        .collect();
    let no_dotdot = mapped.replace("..", "_");
    let trimmed = no_dotdot.trim_matches(|c: char| c == '.' || c.is_whitespace());
    // Empty after trim → fall back. Also fall back if everything we have
    // is the underscore replacement marker — that happens when the input
    // was 100% path-special characters (e.g. "..", "...", "/", "\\:")
    // and the result would be a useless folder name like "_".
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        "mod".to_string()
    } else {
        trimmed.to_string()
    }
}

/// True if `path` resolves inside `root`. Handles the common case where
/// `path` doesn't exist yet (we're about to create it) by walking the
/// component list and tracking depth — `..` decrements depth, normal
/// components increment it. Negative depth means the path escapes.
///
/// Falls through to canonicalize-and-prefix-check when both ends exist,
/// for the symlink-resolved guarantee.
pub fn path_is_inside(path: &Path, root: &Path) -> bool {
    if let (Ok(p), Ok(r)) = (path.canonicalize(), root.canonicalize()) {
        return p.starts_with(&r);
    }
    // Component walk: starting from `root`'s depth, ensure we never go below.
    use std::path::Component;
    let mut depth: i32 = 0;
    // Strip the `root` prefix off `path` if it's there; otherwise treat
    // `path` as the relative payload appended to `root`.
    let rel = path.strip_prefix(root).unwrap_or(path);
    for comp in rel.components() {
        match comp {
            Component::ParentDir => depth -= 1,
            Component::CurDir | Component::Prefix(_) | Component::RootDir => {}
            Component::Normal(_) => depth += 1,
        }
        if depth < 0 {
            return false;
        }
    }
    true
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

    let zip_stem = zip_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Compute a stable wrap folder name regardless of the zip's internal
    // layout. We may not end up using it (clean single-subdir zips are
    // preserved as-is below), but for everything else — root-only AND
    // mixed-root-plus-subfolder layouts — we MUST wrap so a future update
    // can delete a single self-contained folder and avoid the leftovers
    // bug RitsuLib hit (zip had RitsuLib.dll + manifest.json at root and
    // a separate `Translations/` subfolder; old code extracted everything
    // to the mods root, then update's same-stem deletion couldn't reach
    // the surviving Translations files, and dependents loaded against a
    // half-old / half-new RitsuLib).
    //
    // Strategy: prefer manifest Id (game uses this for dependency resolution),
    // then DLL/PCK stem, then a Nexus-suffix-stripped zip stem.
    let wrap_folder_name = {
        let manifest_name = peek_manifest_name(&mut archive);
        let dll_stem = relevant_entries.iter()
            .find(|n| {
                let ext = Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                ext == "dll" || ext == "pck"
            })
            .and_then(|n| Path::new(n).file_name())
            .and_then(|n| Path::new(n).file_stem())
            .map(|s| s.to_string_lossy().to_string());
        let clean_stem = strip_nexus_suffix(&zip_stem);
        manifest_name.or(dll_stem).unwrap_or(clean_stem)
    };

    // True when the zip already has every file under a single top-level
    // directory. Those zips are well-behaved — preserve their structure.
    let has_clean_single_top_dir = all_top_dirs.len() == 1
        && all_entries.iter().all(|n| n.contains('/'));

    let mut extracted_files = Vec::new();
    let mut manifest: Option<ModInfo> = None;

    // wrap_folder_name comes from manifest fields / DLL stems / zip stems —
    // mostly attacker-influenceable for a hostile share-code or Quick Add
    // URL. Sanitize once before it gets joined into a destination path so a
    // malicious manifest with `Name: "../.."` can't redirect extraction.
    let wrap_folder_name = sanitize_path_segment(&wrap_folder_name);

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let raw_name = entry.name().to_string();

        if entry.is_dir() || raw_name.starts_with("__MACOSX") || raw_name.starts_with("._") {
            continue;
        }

        // Reject zip entries whose path would escape the mods folder.
        // `enclosed_name()` returns None for any entry containing absolute
        // paths, drive prefixes, or `..` components that traverse upward.
        // Without this gate, a hostile zip from a share-code, Quick Add
        // URL, drag-drop, or downloads-watcher catch could write anywhere
        // the user has write access (zip-slip).
        let safe_rel = match entry.enclosed_name() {
            Some(p) => p,
            None => {
                log::warn!(
                    "Refusing zip entry with unsafe path {:?} in {}",
                    raw_name,
                    zip_path.display()
                );
                continue;
            }
        };
        // The rest of this file does its path math on forward-slash strings;
        // normalize once after the safety check.
        let name = safe_rel.to_string_lossy().replace('\\', "/");

        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Extract ALL files, not just .dll/.json/.pck — mods may include
        // .xml configs, .deps.json, additional DLLs in subfolders, resources, etc.
        // The ReflectionTypeLoadException in .NET mods is often caused by
        // missing dependency files that were filtered out.

        // Determine the relative path to extract to.
        //
        // Priority order:
        //   1. If the zip is doubly-wrapped in a same-name folder, peel the
        //      outer layer so we don't end up at mods/Foo/Foo/...
        //   2. If the zip already wraps everything in a single clean
        //      top-level dir (`has_clean_single_top_dir`) — keep that
        //      structure verbatim. This handles the well-behaved release
        //      format (`ModName/ModName.dll, ModName/manifest.json`).
        //   3. Single-file zip — drop in at the root with no wrapping.
        //   4. Otherwise (root-only OR mixed-root-plus-subfolder) — wrap
        //      EVERYTHING into `wrap_folder_name` so the install is one
        //      self-contained directory we can fully delete on update.
        //
        // The previous "preserve as-is" fallback for mixed layouts was the
        // RitsuLib bug: it spilled root files alongside subfolders, and
        // updates couldn't clean leftovers because tracking was stem-based.
        let rel_path = if let Some(ref outer) = strip_redundant_outer {
            name.strip_prefix(&format!("{}/", outer)).unwrap_or(&name).to_string()
        } else if has_clean_single_top_dir {
            name.clone()
        } else if all_entries.len() == 1 {
            name.clone()
        } else {
            format!("{}/{}", wrap_folder_name, name)
        };

        let dest_path = mods_path.join(&rel_path);

        // Belt-and-braces: even after the enclosed_name() filter, verify the
        // resolved destination stays inside mods_path. Catches any drift
        // from wrap_folder_name sanitization or future refactors.
        if !path_is_inside(&dest_path, mods_path) {
            log::warn!(
                "Refusing extraction outside mods folder: {} (rel: {})",
                dest_path.display(),
                rel_path
            );
            continue;
        }

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
                pinned: false,
                min_game_version: None,
            })
        }
    }
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
pub fn get_installed_mods(state: tauri::State<'_, AppState>) -> std::result::Result<Vec<ModInfo>, String> {
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

    // Build a lookup of active names by NORMALIZED key so disabled mods
    // with whitespace / case differences (e.g. "BetterSpire2 Lite" vs
    // "BetterSpire2Lite") still collapse to a single entry.
    let active_keys: std::collections::HashSet<String> =
        active_mods.iter().map(|m| normalize_name(&m.name)).collect();

    let mut all_mods = active_mods;
    for d in disabled_mods {
        if active_keys.contains(&normalize_name(&d.name)) {
            log::warn!(
                "Mod '{}' has files in BOTH active and disabled folders — showing the active copy only. Re-toggle or repair the profile to clean this up.",
                d.name
            );
            continue;
        }
        all_mods.push(d);
    }

    // Enrich with source metadata (GitHub/Nexus links)
    crate::mod_sources::enrich_mods_with_sources(&mut all_mods, &s.config_path);

    Ok(all_mods)
}

/// Toggle a mod between enabled and disabled.
///
/// After the file move succeeds, re-snapshots the active profile so its
/// manifest reflects the new state immediately. This makes "the profile is
/// the complete state" actually true — without it, a toggle would only
/// affect disk, leaving the manifest stale until the next profile switch.
/// A subsequent Repair (which re-applies the manifest) would then undo
/// the user's toggle, which is the source of the "switching profiles
/// doesn't remember state" complaint.
#[tauri::command]
pub fn toggle_mod(name: String, enable: bool, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
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

    // First try the simple name-based move; fall back to scanning for the
    // actual ModInfo and using its file list when the name doesn't match a
    // top-level file (e.g. mod is in a subfolder).
    let move_result = move_mod_files(&name, src, dest).or_else(|_| {
        let mods_in_src = scan_mods_inner(src, enable);
        let mod_info = mods_in_src.iter().find(|m| m.name == name).cloned();
        match mod_info {
            Some(info) => move_mod_by_info(&info, src, dest),
            None => Err(crate::error::AppError::ModNotFound(format!(
                "No files found for mod '{}' in {}",
                name, src.display()
            ))),
        }
    });
    move_result.map_err(|e| e.to_string())?;

    refresh_active_profile_manifest(&state);
    Ok(true)
}

/// Re-snapshot the currently active profile from disk so its manifest is
/// always live. Called after every disk mutation (toggle, enable-all,
/// disable-all, delete). Failures are logged but never bubbled — a stale
/// manifest is recoverable, but blocking the user's mutation isn't worth it.
fn refresh_active_profile_manifest(state: &tauri::State<'_, AppState>) {
    let Ok(s) = state.lock() else { return };
    let Some(active_name) = s.active_profile.clone() else { return };
    let mods_path = match s.mods_path.clone() { Some(p) => p, None => return };
    let disabled_path = match s.disabled_mods_path.clone() { Some(p) => p, None => return };
    let profiles_path = s.profiles_path.clone();
    let config_path = s.config_path.clone();
    drop(s);

    if let Err(e) = crate::profiles::snapshot_current_with_paths(
        &active_name,
        &mods_path,
        &disabled_path,
        &profiles_path,
        Some(&config_path),
    ) {
        log::warn!(
            "Failed to refresh active profile manifest for '{}' after mutation: {} \
             — manifest is now stale; next profile switch will re-snapshot.",
            active_name, e
        );
    } else {
        log::debug!("Refreshed active profile manifest for '{}'", active_name);
    }
}

/// Permanently delete a mod.
#[tauri::command]
pub fn delete_mod_cmd(name: String, state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
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
        refresh_active_profile_manifest(&state);
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
    refresh_active_profile_manifest(&state);
    Ok(true)
}

/// Enable all currently disabled mods.
/// Uses direct filesystem iteration instead of scan-then-move for reliability.
#[tauri::command]
pub fn enable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
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
    refresh_active_profile_manifest(&state);
    Ok(true)
}

/// Disable all currently enabled mods.
/// Uses direct filesystem iteration instead of scan-then-move for reliability.
#[tauri::command]
pub fn disable_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<bool, String> {
    crate::game::ensure_game_not_running()?;
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
    refresh_active_profile_manifest(&state);
    Ok(true)
}

/// Delete ALL mods from both enabled and disabled folders.
#[tauri::command]
pub fn delete_all_mods(state: tauri::State<'_, AppState>) -> std::result::Result<u32, String> {
    crate::game::ensure_game_not_running()?;
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
    refresh_active_profile_manifest(&state);
    Ok(count)
}

/// Install a mod from a local file (zip archive).
#[tauri::command]
pub fn install_mod_from_file(path: String, state: tauri::State<'_, AppState>) -> std::result::Result<ModInfo, String> {
    crate::game::ensure_game_not_running()?;
    let mods_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.mods_path.as_ref().ok_or("Game path not set")?.clone()
    };
    let zip_path = PathBuf::from(&path);
    let result = install_mod_from_zip(&zip_path, &mods_path).map_err(|e| e.to_string())?;
    refresh_active_profile_manifest(&state);
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

#[cfg(test)]
mod path_safety_tests {
    use super::{path_is_inside, sanitize_path_segment};
    use std::path::Path;

    #[test]
    fn sanitize_strips_separators() {
        assert_eq!(sanitize_path_segment("foo/bar"), "foo_bar");
        assert_eq!(sanitize_path_segment("foo\\bar"), "foo_bar");
        assert_eq!(sanitize_path_segment("C:foo"), "C_foo");
    }

    #[test]
    fn sanitize_neutralizes_dotdot() {
        // ".." → "_" → all-underscore → fallback "mod"
        assert_eq!(sanitize_path_segment(".."), "mod");
        // "..foo" → "_foo" — safe (the "_" can't escape a parent dir)
        assert_eq!(sanitize_path_segment("..foo"), "_foo");
        // "foo.." → "foo_" — safe
        assert_eq!(sanitize_path_segment("foo.."), "foo_");
        // "a..b" → "a_b"
        assert_eq!(sanitize_path_segment("a..b"), "a_b");
    }

    #[test]
    fn sanitize_handles_empty_and_dots() {
        assert_eq!(sanitize_path_segment(""), "mod");
        assert_eq!(sanitize_path_segment("..."), "mod");
        assert_eq!(sanitize_path_segment("   "), "mod");
    }

    #[test]
    fn sanitize_preserves_normal_names() {
        assert_eq!(sanitize_path_segment("RitsuLib"), "RitsuLib");
        assert_eq!(sanitize_path_segment("My-Mod_v1.2"), "My-Mod_v1.2");
    }

    #[test]
    fn path_inside_accepts_subpath() {
        let root = Path::new("/tmp/mods");
        assert!(path_is_inside(&root.join("foo"), root));
        assert!(path_is_inside(&root.join("foo/bar.dll"), root));
    }

    #[test]
    fn path_inside_rejects_traversal() {
        let root = Path::new("/tmp/mods");
        assert!(!path_is_inside(&root.join("../escaped"), root));
        assert!(!path_is_inside(&root.join("../../etc/passwd"), root));
        assert!(!path_is_inside(&root.join("foo/../../escaped"), root));
    }

    #[test]
    fn path_inside_handles_curdir() {
        let root = Path::new("/tmp/mods");
        assert!(path_is_inside(&root.join("./foo"), root));
        assert!(path_is_inside(&root.join("foo/./bar"), root));
    }
}

