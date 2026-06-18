//! Filesystem scanner: discovers installed mods, parses their manifests
//! (strict + lenient JSON paths), dedups by folder identity, and merges
//! active + disabled mods into a single sorted listing for the UI.
//!
//! Why a separate file: scanning is read-only and has no dependency on
//! the install/enable/disable orchestration in `mod.rs` — every entry
//! point here takes a `&Path` and returns `Vec<ModInfo>` or
//! `Option<ModInfo>`. Keeping it next to install code muddled the cause
//! of test failures (a parse fix would touch the same file as an install
//! fix, even though they don't share state). The four test modules that
//! exercise scan/parse/dedup live here too.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::ModInfo;

/// SHA-256 of the entire file at `path`, hex-encoded. Returns `None`
/// if the file can't be read (missing, permission denied, etc.).
///
/// Used at scan time to give every installed mod a content-derived
/// identity that survives folder renames, and at publish time to
/// pick a release-asset filename suffix that's unique per content.
pub(crate) fn hash_file(path: &Path) -> Option<String> {
    let data = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Some(hex::encode(hasher.finalize()))
}

/// Calculate total size of files in a list relative to a base directory.
///
/// Missing entries silently contribute 0 — this is a display helper,
/// not a publish-readiness check, so an absent file is reported as
/// "size 0" rather than aborting the scan.
pub(super) fn calculate_mod_size(base_dir: &Path, files: &[String]) -> u64 {
    files
        .iter()
        .map(|f| {
            let path = base_dir.join(f);
            path.metadata().map(|m| m.len()).unwrap_or(0)
        })
        .sum()
}

/// Collect all files belonging to a mod entry (the .json and
/// co-located .dll/.pck files for a flat-layout mod, or every file
/// in the mod's subdirectory for a directory-layout mod).
///
/// The returned paths are relative to `base_dir` so they round-trip
/// through serialization without leaking absolute paths into a
/// shareable manifest.
pub(super) fn collect_mod_files(manifest_path: &Path, base_dir: &Path) -> Vec<String> {
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

/// Strip a leading UTF-8 BOM (`EF BB BF` / `U+FEFF`) from a manifest body.
///
/// Windows tooling (Notepad, some authoring editors) writes JSON with a BOM
/// by default. `serde_json::from_str` refuses to parse content that doesn't
/// start with a JSON character — so any BOM-prefixed manifest fails strict
/// parsing AND the lenient Value-based fallback. That's the actual cause of
/// the "vunknown" report on BaseLib (a popular library mod whose author
/// ships a BOM in `BaseLib.json`): both parsers gave up and the install
/// fell through to the stub. Stripping once at read time fixes every
/// manifest read in the codebase.
pub fn strip_utf8_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

// ── Raw Manifest Types ─────────────────────────────────────────────────────

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
pub(super) enum RawDependency {
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
    pub(super) fn id(&self) -> &str {
        match self {
            RawDependency::Name(s) => s,
            RawDependency::Structured { id } => id,
        }
    }
}

/// Raw manifest structure from STS2 mod JSON files.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub(super) struct RawManifest {
    #[serde(alias = "Name")]
    pub(super) name: String,
    #[serde(alias = "Version")]
    pub(super) version: String,
    #[serde(alias = "Description")]
    pub(super) description: String,
    #[serde(alias = "Dependencies")]
    pub(super) dependencies: Vec<RawDependency>,
    #[serde(alias = "Source")]
    pub(super) source: Option<String>,
    /// Mod's unique ID (used by game for dependency resolution)
    #[serde(alias = "Id", alias = "ID")]
    pub(super) id: Option<String>,
    /// PCK resource name
    #[serde(alias = "PckName", alias = "pck_name")]
    pub(super) pck_name: Option<String>,
    /// Additional fields that might contain URLs
    #[serde(alias = "Homepage", alias = "homepage")]
    homepage: Option<String>,
    #[serde(
        alias = "Repository",
        alias = "repository",
        alias = "Repo",
        alias = "repo"
    )]
    repository: Option<String>,
    #[serde(alias = "Url", alias = "url", alias = "URL")]
    url: Option<String>,
    #[serde(alias = "Author", alias = "author")]
    pub(super) author: Option<String>,
    /// Minimum STS2 build the mod's code targets (e.g. "0.105.0"). Mods
    /// declaring this expect game features / APIs that landed in that
    /// build; the game's loader silently skips mods whose requirement
    /// the current build doesn't satisfy.
    #[serde(alias = "MinGameVersion", alias = "min_game_version")]
    pub(super) min_game_version: Option<String>,
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

// ── Manifest Parsing ───────────────────────────────────────────────────────

/// Last-resort extraction of the fields the UI cares most about (version,
/// name, description, author, id) when strict struct deserialization fails.
///
/// Strict serde_json parsing can fail the WHOLE manifest on one bad field
/// — e.g. a dependency entry in an unexpected shape, or a numeric version
/// where we expect a string. Pre-this-helper the failure silently turned
/// into `version: "unknown"` in the UI, which is the "vunknown after
/// auto-update" bug reported by users. Now: salvage what we can, log
/// loudly so we can still spot real schema drift, and let the install
/// surface real data.
pub(super) fn parse_manifest_lenient(content: &str) -> Option<RawManifest> {
    let v: serde_json::Value = serde_json::from_str(strip_utf8_bom(content)).ok()?;
    let obj = v.as_object()?;

    // Case-insensitive lookup against the small set of aliases we
    // already support in RawManifest's serde annotations.
    let pluck_str = |aliases: &[&str]| -> Option<String> {
        for k in aliases {
            if let Some(val) = obj.get(*k).and_then(|x| x.as_str()) {
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
        None
    };

    let mut raw = RawManifest::default();
    if let Some(name) = pluck_str(&["name", "Name"]) {
        raw.name = name;
    }
    if let Some(version) = pluck_str(&["version", "Version"]) {
        raw.version = version;
    }
    if let Some(desc) = pluck_str(&["description", "Description"]) {
        raw.description = desc;
    }
    raw.author = pluck_str(&["author", "Author"]);
    raw.id = pluck_str(&["id", "Id", "ID"]);
    raw.pck_name = pluck_str(&["pck_name", "PckName"]);
    raw.source = pluck_str(&["source", "Source"]);
    raw.homepage = pluck_str(&["homepage", "Homepage"]);
    raw.repository = pluck_str(&["repository", "Repository", "repo", "Repo"]);
    raw.url = pluck_str(&["url", "Url", "URL"]);
    raw.min_game_version = pluck_str(&["min_game_version", "MinGameVersion"]);
    // Dependencies are intentionally skipped — they're the most common
    // cause of strict-parse failure, and the lenient fallback is about
    // rescuing user-visible fields, not full schema parity.

    Some(raw)
}

/// Parse a single manifest JSON into a ModInfo.
pub(crate) fn parse_manifest(
    manifest_path: &Path,
    base_dir: &Path,
    enabled: bool,
) -> Option<ModInfo> {
    let content = match fs::read_to_string(manifest_path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "parse_manifest: could not read '{}': {}",
                manifest_path.display(),
                e,
            );
            return None;
        }
    };
    let raw: RawManifest = match serde_json::from_str(strip_utf8_bom(&content)) {
        Ok(r) => r,
        Err(e) => {
            // Strict parse failed — likely a new manifest field shape or a
            // dependency entry that doesn't match either of the variants
            // RawDependency accepts. Salvage version/name/etc via a lenient
            // Value-based pass so the user doesn't see "vunknown".
            match parse_manifest_lenient(&content) {
                Some(partial) => {
                    log::warn!(
                        "parse_manifest: strict deserialize failed for '{}': {} — \
                         recovered name='{}' version='{}' via lenient fallback. \
                         File this as a schema drift report with the manifest contents.",
                        manifest_path.display(),
                        e,
                        partial.name,
                        partial.version,
                    );
                    partial
                }
                None => {
                    log::warn!(
                        "parse_manifest: strict deserialize failed for '{}': {} — \
                         lenient fallback could not extract version/name either. \
                         The mod will fall through to the DLL-only path and show \
                         with version 'unknown'.",
                        manifest_path.display(),
                        e,
                    );
                    return None;
                }
            }
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
        manifest_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    } else {
        // Subdirectory manifest: folder_name is the immediate parent dir name
        manifest_path
            .parent()
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
                let clean = url_str.trim_end_matches('/').trim_end_matches(".git");
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
        mod_version_id: None,
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
        github_auto_detected: false,
        nexus_url,
        pinned: false,
        min_game_version: raw.min_game_version,
        author: raw.author,
        note: None,
        custom_url: None,
        tags: vec![],
        display_name: None,
        display_description: None,
        bundle_members: vec![],
        bundle_member_ids: vec![],
    })
}

pub(crate) fn collect_bundle_member_metadata(
    container_path: &Path,
    base_dir: &Path,
    enabled: bool,
) -> (Vec<String>, Vec<String>) {
    let mut bundle_members: Vec<String> = Vec::new();
    let mut bundle_member_ids: Vec<String> = Vec::new();
    let Ok(sub_entries) = fs::read_dir(container_path) else {
        return (bundle_members, bundle_member_ids);
    };

    let mut sub_dirs: Vec<_> = sub_entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    sub_dirs.sort_by_key(|e| e.file_name());

    for sub_entry in sub_dirs {
        let sub_path = sub_entry.path();
        let sub_name = sub_entry.file_name().to_string_lossy().to_string();
        let parsed = fs::read_dir(&sub_path).ok().and_then(|inner| {
            inner
                .flatten()
                .filter(|e| {
                    e.path().is_file()
                        && e.path().extension().and_then(|x| x.to_str()) == Some("json")
                })
                .filter_map(|json_e| parse_manifest(&json_e.path(), base_dir, enabled))
                .next()
        });

        match parsed {
            Some(info) => {
                if let Some(id) = info.mod_id.as_deref() {
                    let id = id.trim();
                    if !id.is_empty()
                        && !bundle_member_ids
                            .iter()
                            .any(|existing| existing.eq_ignore_ascii_case(id))
                    {
                        bundle_member_ids.push(id.to_string());
                    }
                }
                bundle_members.push(info.name);
            }
            None => bundle_members.push(sub_name),
        }
    }

    (bundle_members, bundle_member_ids)
}

/// For a manifest-fallback mod whose primary artifact (`artifact_path`) lives in
/// a subdirectory of `base_dir`, return every file under that subdirectory
/// (relative to `base_dir`, forward slashes). For a flat-layout artifact sitting
/// directly in `base_dir`, return `flat_fallback` unchanged.
///
/// Without this, a folder-layout mod that fell back from a malformed manifest
/// would record only its .dll/.pck and shares would upload an incomplete bundle
/// missing the .json and assets (issue #165).
fn subdir_files_or(
    artifact_path: &Path,
    base_dir: &Path,
    flat_fallback: Vec<String>,
) -> Vec<String> {
    let parent = match artifact_path.parent() {
        Some(p) if p != base_dir => p,
        _ => return flat_fallback,
    };

    let mut files: Vec<String> = WalkDir::new(parent)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(base_dir)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        })
        .collect();

    if files.is_empty() {
        return flat_fallback;
    }
    files.sort();
    files
}

/// Create a ModInfo for a PCK-only mod (no JSON manifest, no DLL).
///
/// Skin/asset/voice mods in STS2 are often pure Godot resource packs (.pck)
/// with no C# assembly. The engine loads them directly, so they need no
/// .dll — but without this constructor the scanner would silently skip them.
pub(super) fn pck_only_mod(pck_path: &Path, base_dir: &Path, enabled: bool) -> ModInfo {
    let name = pck_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let folder_name = if pck_path.parent() == Some(base_dir) {
        Some(name.clone())
    } else {
        pck_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
    };

    let file_name = if let Ok(rel) = pck_path.strip_prefix(base_dir) {
        rel.to_string_lossy().to_string()
    } else {
        pck_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    };

    // For a subdirectory-layout mod, the whole folder is the mod: include every
    // file under it so shares upload the complete bundle (see issue #165).
    // Flat-layout (.pck directly in the mods dir) keeps just the single file.
    let files = subdir_files_or(pck_path, base_dir, vec![file_name]);
    let size_bytes = calculate_mod_size(base_dir, &files);

    ModInfo {
        mod_version_id: None,
        name,
        version: "unknown".to_string(),
        description: String::new(),
        enabled,
        files,
        source: None,
        hash: hash_file(pck_path),
        dependencies: Vec::new(),
        size_bytes,
        folder_name,
        mod_id: None,
        github_url: None,
        github_auto_detected: false,
        nexus_url: None,
        pinned: false,
        min_game_version: None,
        author: None,
        note: None,
        custom_url: None,
        tags: vec![],
        display_name: None,
        display_description: None,
        bundle_members: vec![],
        bundle_member_ids: vec![],
    }
}

/// Create a ModInfo for a DLL-only mod (no JSON manifest).
pub(super) fn dll_only_mod(dll_path: &Path, base_dir: &Path, enabled: bool) -> ModInfo {
    let name = dll_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let folder_name = if dll_path.parent() == Some(base_dir) {
        Some(name.clone())
    } else {
        dll_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
    };

    let file_name = if let Ok(rel) = dll_path.strip_prefix(base_dir) {
        rel.to_string_lossy().to_string()
    } else {
        dll_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    };

    // Flat-layout fallback file set: the .dll plus a co-located same-stem .pck.
    let mut flat_files = vec![file_name];
    let pck_path = dll_path.with_extension("pck");
    if pck_path.exists() {
        if let Ok(rel) = pck_path.strip_prefix(base_dir) {
            flat_files.push(rel.to_string_lossy().to_string());
        }
    }

    // For a subdirectory-layout mod, the whole folder is the mod: include every
    // file under it so shares upload the complete bundle (see issue #165).
    let files = subdir_files_or(dll_path, base_dir, flat_files);
    let size_bytes = calculate_mod_size(base_dir, &files);

    ModInfo {
        mod_version_id: None,
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
        github_auto_detected: false,
        nexus_url: None,
        pinned: false,
        min_game_version: None,
        author: None,
        note: None,
        custom_url: None,
        tags: vec![],
        display_name: None,
        display_description: None,
        bundle_members: vec![],
        bundle_member_ids: vec![],
    }
}

// ── Scan + Dedup ───────────────────────────────────────────────────────────

/// Normalize a name for fuzzy matching: lowercase and strip spaces/hyphens/underscores.
pub(super) fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
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
    found_names: &mut HashSet<String>,
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
                    if let Some(stem) = Path::new(f).file_stem().and_then(|s| s.to_str()) {
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

    // PCK-only fallback: skin/asset/voice mods ship as a .pck with no .dll/.json
    for sub_entry in &entries {
        let sub_path = sub_entry.path();
        if sub_path.is_file() && sub_path.extension().and_then(|e| e.to_str()) == Some("pck") {
            let info = pck_only_mod(&sub_path, base_dir, enabled);
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
    if !v.is_empty() && v != "unknown" && v != "0.0.0" {
        score += 100;
    }
    if !info.description.trim().is_empty() {
        score += 20;
    }
    score += info.files.len() as u32;
    score
}

/// Identity key for a mod entry — used for dedup within a single scan pass.
///
/// Keyed by `folder_name` (the actual on-disk folder/file stem the manager
/// found the mod under). Two mods that happen to share a manifest `name`
/// but live in different folders MUST stay distinct — collapsing them was
/// the silent-data-loss bug where toggling one of two "CardArtEditor" mods
/// moved the wrong copy to `mods_disabled/`.
///
/// Falls back to normalized display name only when `folder_name` is None,
/// which shouldn't happen for any code path that builds a `ModInfo`
/// (parse_manifest, dll_only_mod, install_mod_from_zip all set it). The
/// fallback is defensive — if a future code path forgets, we still get
/// SOME dedup rather than infinite duplicates.
pub(crate) fn dedup_key(info: &ModInfo) -> String {
    info.folder_name
        .clone()
        .unwrap_or_else(|| normalize_name(&info.name))
}

/// Add `info` to `mods`, but if another entry from the SAME folder is
/// already present (typically the result of an interrupted operation or
/// a half-applied profile switch leaving stale files), keep whichever has
/// the richer manifest. Two mods in DIFFERENT folders are kept as
/// distinct entries even if their display names match — that's the whole
/// point of folder-based identity.
pub(super) fn upsert_mod_dedup(mods: &mut Vec<ModInfo>, info: ModInfo, source_hint: &str) {
    let key = dedup_key(&info);
    if let Some(pos) = mods.iter().position(|m| dedup_key(m) == key) {
        let existing_quality = mod_quality(&mods[pos]);
        let new_quality = mod_quality(&info);
        if new_quality > existing_quality {
            log::warn!(
                "Replacing duplicate mod from folder '{}' (existing: '{}') with '{}' from {} — better manifest. Clean up stale files.",
                key,
                mods[pos].name,
                info.name,
                source_hint,
            );
            mods[pos] = info;
        } else {
            log::warn!(
                "Skipping duplicate mod '{}' from {} — folder '{}' already loaded with a richer manifest. Clean up stale files.",
                info.name,
                source_hint,
                key,
            );
        }
        return;
    }
    mods.push(info);
}

pub(super) fn scan_mods_inner(dir: &Path, enabled: bool) -> Vec<ModInfo> {
    let mut mods = Vec::new();
    let mut found_names = HashSet::new();

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
                    if let Some(folder) = info.folder_name.as_deref() {
                        found_names.insert(normalize_name(folder));
                    }
                    for f in &info.files {
                        if let Some(stem) = Path::new(f).file_stem().and_then(|s| s.to_str()) {
                            found_names.insert(normalize_name(stem));
                        }
                    }
                    upsert_mod_dedup(&mut mods, info, &path.display().to_string());
                }
            }
        }
    }

    // PASS 2: Look for subdirectories with manifests
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Bug 5 diagnosability: remember the mod count so we can flag a
                // non-empty folder that produced no installed mod below — that
                // gap is exactly what makes a manifest count exceed the scan.
                let mods_before = mods.len();
                // A sidecar-tagged bundle container is represented as ONE
                // ModInfo for the whole container (Model A). The container's
                // folder_name == container dir name; files includes every file
                // inside (including the sidecar); bundle_members lists the
                // display names of the immediate subdirectory members.
                if crate::mods::bundle::is_bundle_container(&path) {
                    let container_name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let sc = crate::mods::bundle::read_sidecar(&path);

                    let name = sc
                        .as_ref()
                        .map(|s| s.display_name.as_str())
                        .filter(|n| !n.is_empty())
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| container_name.clone());

                    let version = sc
                        .as_ref()
                        .and_then(|s| s.installed_version.as_deref())
                        .map(str::trim)
                        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("unknown"))
                        .map(str::to_string)
                        .or_else(|| crate::mods::bundle::display_name_version(&name))
                        .or_else(|| crate::mods::bundle::display_name_version(&container_name))
                        .unwrap_or_else(|| "unknown".to_string());

                    let nexus_url = sc.as_ref().and_then(|s| s.nexus_url.clone());
                    let github_url = sc.as_ref().and_then(|s| {
                        s.github_repo.as_ref().map(|r| {
                            if r.starts_with("http://") || r.starts_with("https://") {
                                r.clone()
                            } else {
                                format!("https://github.com/{}", r)
                            }
                        })
                    });
                    let source = nexus_url.clone();

                    // Collect every file inside the container (relative to dir)
                    // so move/delete operate on the whole container.
                    let files: Vec<String> = WalkDir::new(&path)
                        .into_iter()
                        .flatten()
                        .filter(|e| e.file_type().is_file())
                        .filter_map(|e| {
                            e.path()
                                .strip_prefix(dir)
                                .ok()
                                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                        })
                        .collect();

                    let size_bytes = calculate_mod_size(dir, &files);

                    let (bundle_members, bundle_member_ids) =
                        collect_bundle_member_metadata(&path, dir, enabled);

                    // Register the container name so PASS 3/4 won't double-count.
                    found_names.insert(normalize_name(&container_name));

                    let info = ModInfo {
                        mod_version_id: None,
                        name,
                        version,
                        description: String::new(),
                        enabled,
                        files,
                        source,
                        hash: None,
                        dependencies: Vec::new(),
                        size_bytes,
                        folder_name: Some(container_name),
                        mod_id: None,
                        github_url,
                        github_auto_detected: false,
                        nexus_url,
                        pinned: false,
                        min_game_version: None,
                        author: None,
                        note: None,
                        custom_url: None,
                        tags: vec![],
                        display_name: None,
                        display_description: None,
                        bundle_members,
                        bundle_member_ids,
                    };
                    mods.push(info);
                    continue;
                }
                // First try at top level
                if try_load_mod_from(&path, dir, enabled, &mut found_names, &mut mods) {
                    continue;
                }
                // If that didn't find anything and we have a single child folder
                // with the same name (recovery from over-nested zips), try that.
                let mut found = false;
                if let Some(child) = single_same_named_child(&path) {
                    found = try_load_mod_from(&child, dir, enabled, &mut found_names, &mut mods);
                }
                if !found {
                    // Multi-mod container: the folder itself contains no mod
                    // files but wraps several sub-mod directories (e.g.
                    // AliceDefectVisualPack/ holding four separate mods).
                    // Try each immediate subdirectory as an independent mod.
                    // (Non-sidecar containers descend and emit each member individually.)
                    if let Ok(sub_entries) = fs::read_dir(&path) {
                        for sub_entry in sub_entries.flatten() {
                            let sub_path = sub_entry.path();
                            if sub_path.is_dir() {
                                try_load_mod_from(
                                    &sub_path,
                                    dir,
                                    enabled,
                                    &mut found_names,
                                    &mut mods,
                                );
                            }
                        }
                    }
                }
                // Bug 5: a folder that holds files yet yielded no mod is the
                // diagnosable cause of a manifest-vs-scan count gap. (Empty /
                // file-less folders are intentionally not mods — content-gating
                // — so we stay silent on those to avoid noise.)
                if mods.len() == mods_before
                    && WalkDir::new(&path)
                        .into_iter()
                        .flatten()
                        .any(|e| e.file_type().is_file())
                {
                    log::warn!(
                        "scan: '{}' contains files but yielded no installed mod; manifest membership may exceed the on-disk count",
                        path.display()
                    );
                }
            }
        }
    }

    // PASS 3: DLL-only fallback for top-level .dll files we haven't recorded yet
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("dll") {
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let stem_norm = normalize_name(&stem);
                if !found_names.contains(&stem_norm) {
                    let info = dll_only_mod(&path, dir, enabled);
                    found_names.insert(stem_norm);
                    upsert_mod_dedup(&mut mods, info, &path.display().to_string());
                }
            }
        }
    }

    // PASS 4: PCK-only fallback for top-level .pck files with no matching .json or .dll
    // Skin/asset/voice mods ship as a standalone .pck (Godot resource pack) with
    // no C# assembly — they are invisible to PASSes 1–3.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("pck") {
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let stem_norm = normalize_name(&stem);
                if !found_names.contains(&stem_norm) {
                    let info = pck_only_mod(&path, dir, enabled);
                    found_names.insert(stem_norm);
                    upsert_mod_dedup(&mut mods, info, &path.display().to_string());
                }
            }
        }
    }

    mods
}

/// Merge active + disabled mod lists into a single sorted listing for the UI.
///
/// When the same folder has files in BOTH directories (a torn state from
/// an interrupted operation), prefer the active copy and log a warning —
/// the user needs to re-toggle or repair the profile to clean up.
pub(crate) fn merge_active_disabled_mods(
    active_mods: Vec<ModInfo>,
    disabled_mods: Vec<ModInfo>,
) -> Vec<ModInfo> {
    let active_keys: HashSet<String> = active_mods.iter().map(dedup_key).collect();

    let mut all_mods = active_mods;
    for d in disabled_mods {
        if active_keys.contains(&dedup_key(&d)) {
            log::warn!(
                "Mod folder '{}' has files in BOTH active and disabled folders - showing the active copy only. Re-toggle or repair the profile to clean this up.",
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
    all_mods
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod bom_helper_tests {
    use super::strip_utf8_bom;

    #[test]
    fn strips_bom_when_present() {
        let s = "\u{FEFF}{\"x\": 1}";
        assert_eq!(strip_utf8_bom(s), "{\"x\": 1}");
    }

    #[test]
    fn passes_through_clean_input() {
        assert_eq!(strip_utf8_bom("{\"x\": 1}"), "{\"x\": 1}");
        assert_eq!(strip_utf8_bom(""), "");
    }

    /// Only the leading BOM gets stripped. Some content tools (or attackers)
    /// might embed U+FEFF deeper in the string — leave those alone.
    #[test]
    fn only_strips_leading_bom() {
        let s = "{\"key\": \"value\u{FEFF}with bom\"}";
        assert_eq!(strip_utf8_bom(s), s);
    }
}

#[cfg(test)]
mod lenient_parse_tests {
    use super::parse_manifest_lenient;

    /// The reported "vunknown after update" path: the manifest is otherwise
    /// fine but a field deeper in the JSON (e.g. dependencies in a new shape)
    /// breaks strict parsing. We should still surface a real version.
    #[test]
    fn pulls_version_when_strict_parse_would_fail() {
        let json = r#"{
            "name": "BaseLib",
            "version": "1.4.2",
            "description": "Core utilities",
            "dependencies": [{"id": "OtherLib", "min_version": "1.0", "extra_field_we_dont_know": {"nested": true}}]
        }"#;
        let raw = parse_manifest_lenient(json).expect("lenient parse must extract fields");
        assert_eq!(raw.name, "BaseLib");
        assert_eq!(raw.version, "1.4.2");
        assert_eq!(raw.description, "Core utilities");
    }

    /// Case-insensitive aliases match RawManifest's serde annotations so the
    /// lenient path is at parity for the field names we care about.
    #[test]
    fn handles_capitalized_field_aliases() {
        let json = r#"{ "Name": "Foo", "Version": "0.9", "Author": "alice" }"#;
        let raw = parse_manifest_lenient(json).expect("lenient parse");
        assert_eq!(raw.name, "Foo");
        assert_eq!(raw.version, "0.9");
        assert_eq!(raw.author.as_deref(), Some("alice"));
    }

    /// If the file isn't even valid JSON, lenient parse must give up
    /// cleanly — we don't want to manufacture fake mod metadata.
    #[test]
    fn returns_none_on_invalid_json() {
        assert!(parse_manifest_lenient("not json").is_none());
        assert!(parse_manifest_lenient("{").is_none());
    }

    /// BOM tolerance at the lenient layer too — covers any code path
    /// that bypasses parse_manifest and calls the lenient helper directly.
    #[test]
    fn lenient_parse_strips_bom() {
        let with_bom = "\u{FEFF}{\"name\": \"X\", \"version\": \"1.0\"}";
        let raw = parse_manifest_lenient(with_bom).expect("BOM-prefixed content must still parse");
        assert_eq!(raw.name, "X");
        assert_eq!(raw.version, "1.0");
    }
}

#[cfg(test)]
mod dedup_identity_tests {
    use super::{merge_active_disabled_mods, upsert_mod_dedup};
    use crate::mods::ModInfo;

    fn mod_with(name: &str, folder: Option<&str>, version: &str) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: name.to_string(),
            version: version.to_string(),
            description: String::new(),
            enabled: true,
            files: Vec::new(),
            source: None,
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            folder_name: folder.map(|s| s.to_string()),
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        }
    }

    /// The CardArtEditor bug. Two mods declare manifest name "Card Art Editor"
    /// but live in different folders. They MUST stay as two distinct entries —
    /// collapsing them is the silent-data-loss the refactor fixes.
    #[test]
    fn keeps_same_name_mods_with_different_folders() {
        let mut mods = Vec::new();
        upsert_mod_dedup(
            &mut mods,
            mod_with("Card Art Editor", Some("card_art_editor"), "1.0.0"),
            "test",
        );
        upsert_mod_dedup(
            &mut mods,
            mod_with("Card Art Editor", Some("card_art_editor_v2"), "2.0.0"),
            "test",
        );
        assert_eq!(
            mods.len(),
            2,
            "Same-name mods in different folders must NOT collapse"
        );
        assert_eq!(mods[0].folder_name.as_deref(), Some("card_art_editor"));
        assert_eq!(mods[1].folder_name.as_deref(), Some("card_art_editor_v2"));
    }

    /// Two scan passes finding the same folder (e.g. PASS 1 picks up the
    /// json manifest, PASS 3 then finds the orphan dll fallback) MUST
    /// collapse — that's the legitimate dedup case the function exists for.
    #[test]
    fn collapses_same_folder_keeps_richer_manifest() {
        let mut mods = Vec::new();
        // First insert: rich manifest with a real version
        upsert_mod_dedup(
            &mut mods,
            mod_with("MyMod", Some("MyMod"), "1.5.0"),
            "manifest pass",
        );
        // Second insert: dll-only fallback with version "unknown" — should lose
        upsert_mod_dedup(
            &mut mods,
            mod_with("MyMod", Some("MyMod"), "unknown"),
            "dll pass",
        );
        assert_eq!(mods.len(), 1, "Same folder must dedup to one entry");
        assert_eq!(mods[0].version, "1.5.0", "Richer manifest must win");
    }

    /// When folder_name is missing (defensive fallback), normalized display
    /// name is the dedup key — preserves the legacy behavior for any code
    /// path that hasn't been updated to populate folder_name.
    #[test]
    fn falls_back_to_normalized_name_when_folder_missing() {
        let mut mods = Vec::new();
        upsert_mod_dedup(&mut mods, mod_with("My Mod", None, "1.0.0"), "test");
        upsert_mod_dedup(&mut mods, mod_with("my-mod", None, "1.0.0"), "test");
        assert_eq!(
            mods.len(),
            1,
            "Normalized-name dedup must still apply when folder is missing"
        );
    }

    #[test]
    fn merged_active_and_disabled_mods_sort_globally_by_name() {
        let active = vec![
            mod_with("Zulu Active", Some("ZuluActive"), "1.0.0"),
            mod_with("BaseLib", Some("BaseLib"), "1.0.0"),
        ];
        let mut disabled_mod = mod_with("AutoPath", Some("AutoPath"), "1.0.0");
        disabled_mod.enabled = false;
        let disabled = vec![disabled_mod];

        let merged = merge_active_disabled_mods(active, disabled);
        let names: Vec<&str> = merged.iter().map(|m| m.name.as_str()).collect();

        assert_eq!(
            names,
            vec!["AutoPath", "BaseLib", "Zulu Active"],
            "get_installed_mods should not look alphabetized only until disabled rows are appended"
        );
    }
}

#[cfg(test)]
mod pck_only_scan_tests {
    use super::{dll_only_mod, pck_only_mod, scan_mods_inner};
    use std::fs;
    use tempfile::TempDir;

    fn write_bytes(path: &std::path::Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// A top-level .pck with no .dll or .json must appear in the scan results.
    /// Reproduces the "anaertailin skin mod not shown in Mod Library" case.
    #[test]
    fn top_level_pck_only_mod_is_detected() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        write_bytes(&mods_dir.join("SkinMod.pck"), b"GDPC");

        let results = scan_mods_inner(mods_dir, true);
        assert_eq!(results.len(), 1, "PCK-only top-level mod must be detected");
        assert_eq!(results[0].name, "SkinMod");
        assert!(results[0].enabled);
        assert_eq!(results[0].version, "unknown");
    }

    /// A subdirectory containing only a .pck must also be detected.
    #[test]
    fn subdir_pck_only_mod_is_detected() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        write_bytes(
            &mods_dir.join("AliceDefectPack").join("AliceDefectPack.pck"),
            b"GDPC",
        );

        let results = scan_mods_inner(mods_dir, true);
        assert_eq!(results.len(), 1, "PCK-only subdir mod must be detected");
        assert_eq!(results[0].name, "AliceDefectPack");
    }

    /// A .pck already covered by a co-located .json manifest must not be
    /// double-counted by PASS 4 (the PCK-only fallback pass).
    #[test]
    fn json_manifest_pck_not_double_counted() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        let json = r#"{"name":"CardMod","version":"1.0.0","description":""}"#;
        write_bytes(&mods_dir.join("CardMod.json"), json.as_bytes());
        write_bytes(&mods_dir.join("CardMod.pck"), b"GDPC");

        let results = scan_mods_inner(mods_dir, true);
        assert_eq!(
            results.len(),
            1,
            "JSON + PCK pair must produce exactly one entry"
        );
        assert_eq!(
            results[0].version, "1.0.0",
            "JSON manifest version must win"
        );
    }

    /// A multi-mod container folder (e.g. AliceDefectVisualPack) that wraps
    /// several sub-mod directories must surface every contained mod individually.
    /// Reproduces the "Alice Defect Visual Pack sub-mods invisible" report.
    #[test]
    fn multi_mod_container_folder_all_submods_detected() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        // Two mods with .dll + .pck, one PCK-only voice pack, one DLL-only voice mod
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("Mod1")
                .join("Mod1.dll"),
            b"",
        );
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("Mod1")
                .join("Mod1.pck"),
            b"GDPC",
        );
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("Mod2")
                .join("Mod2.dll"),
            b"",
        );
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("Mod2")
                .join("Mod2.pck"),
            b"GDPC",
        );
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("VoicePack")
                .join("VoicePack.pck"),
            b"GDPC",
        );
        write_bytes(
            &mods_dir
                .join("AliceDefectPack")
                .join("VoiceMod")
                .join("VoiceMod.dll"),
            b"",
        );

        let results = scan_mods_inner(mods_dir, true);
        assert_eq!(
            results.len(),
            4,
            "All 4 sub-mods inside a container folder must be detected"
        );
        let mut names: Vec<&str> = results.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Mod1", "Mod2", "VoiceMod", "VoicePack"]);
    }

    /// pck_only_mod must not panic or return garbage for an empty file.
    #[test]
    fn pck_only_mod_handles_empty_file() {
        let tmp = TempDir::new().unwrap();
        let pck = tmp.path().join("EmptyMod.pck");
        write_bytes(&pck, b"");

        let info = pck_only_mod(&pck, tmp.path(), true);
        assert_eq!(info.name, "EmptyMod");
        assert_eq!(info.version, "unknown");
        assert!(!info.files.is_empty());
    }

    /// A sidecar container must scan as ONE ModInfo entry (the container itself),
    /// not N separate member entries. The container's folder_name == container dir
    /// name, name == sidecar display_name, bundle_members lists both sub-mods, and
    /// files includes the sidecar path. ModA and ModB must NOT appear as separate entries.
    #[test]
    fn sidecar_container_scans_as_one_bundle_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path();
        write_bytes(
            &mods.join("Pack").join("ModA").join("ModA.json"),
            br#"{"id":"RuntimeA","name":"Member A","version":"1.0.0"}"#,
        );
        write_bytes(&mods.join("Pack").join("ModA").join("ModA.dll"), b"");
        write_bytes(
            &mods.join("Pack").join("ModB").join("ModB.json"),
            br#"{"id":"RuntimeB","name":"Member B","version":"1.0.0"}"#,
        );
        write_bytes(&mods.join("Pack").join("ModB").join("ModB.dll"), b"");
        crate::mods::bundle::write_sidecar(
            &mods.join("Pack"),
            &crate::mods::bundle::BundleSidecar {
                display_name: "Pretty Pack".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let scanned = scan_mods_inner(mods, true);

        // Exactly ONE entry for the whole bundle.
        assert_eq!(
            scanned.len(),
            1,
            "sidecar container must produce exactly one ModInfo, got {}: {:?}",
            scanned.len(),
            scanned.iter().map(|m| &m.folder_name).collect::<Vec<_>>()
        );

        let bundle = &scanned[0];
        assert_eq!(
            bundle.folder_name.as_deref(),
            Some("Pack"),
            "folder_name must be the container dir name"
        );
        assert_eq!(
            bundle.name, "Pretty Pack",
            "name must be the sidecar display_name"
        );
        assert!(
            !bundle.bundle_members.is_empty(),
            "bundle_members must be populated"
        );
        assert_eq!(
            bundle.bundle_members.len(),
            2,
            "bundle_members must list both sub-mods"
        );
        assert_eq!(
            bundle.bundle_member_ids,
            vec!["RuntimeA".to_string(), "RuntimeB".to_string()],
            "bundle_member_ids must list runtime IDs from member manifests"
        );

        // The sidecar file itself must be in the files list.
        let sidecar_rel = format!("Pack/{}", crate::mods::bundle::SIDECAR_FILENAME);
        assert!(
            bundle.files.iter().any(|f| f == &sidecar_rel),
            "files must include the sidecar; got {:?}",
            bundle.files
        );

        // ModA and ModB must NOT be separate entries.
        assert!(
            scanned
                .iter()
                .all(|m| m.folder_name.as_deref() != Some("ModA")),
            "ModA must not appear as a separate entry"
        );
        assert!(
            scanned
                .iter()
                .all(|m| m.folder_name.as_deref() != Some("ModB")),
            "ModB must not appear as a separate entry"
        );
    }

    #[test]
    fn sidecar_container_uses_display_name_version_when_sidecar_version_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path();
        write_bytes(
            &mods
                .join("AliceDefectSkin V2.0")
                .join("AliceDefectSkin")
                .join("AliceDefectSkin.dll"),
            b"",
        );
        write_bytes(
            &mods
                .join("AliceDefectSkin V2.0")
                .join("AliceDefectVoiceBridge")
                .join("AliceDefectVoiceBridge.dll"),
            b"",
        );
        crate::mods::bundle::write_sidecar(
            &mods.join("AliceDefectSkin V2.0"),
            &crate::mods::bundle::BundleSidecar {
                display_name: "AliceDefectSkin V2.0".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let scanned = scan_mods_inner(mods, true);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].name, "AliceDefectSkin V2.0");
        assert_eq!(scanned[0].version, "2.0");
    }

    /// A container WITHOUT a sidecar must still descend and surface each
    /// member individually (the non-sidecar multi-mod container path is
    /// unchanged from Phase 1 — b41666e behaviour).
    #[test]
    fn non_sidecar_container_still_descends() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path();
        write_bytes(&mods.join("Pack").join("ModA").join("ModA.dll"), b"");
        write_bytes(&mods.join("Pack").join("ModB").join("ModB.dll"), b"");
        // No sidecar written — Pack is a plain multi-mod container.

        let scanned = scan_mods_inner(mods, true);

        assert_eq!(
            scanned.len(),
            2,
            "non-sidecar container must descend and emit each member individually, got {:?}",
            scanned.iter().map(|m| &m.folder_name).collect::<Vec<_>>()
        );
        let names: std::collections::HashSet<&str> = scanned
            .iter()
            .filter_map(|m| m.folder_name.as_deref())
            .collect();
        assert!(names.contains("ModA"), "ModA must be a separate entry");
        assert!(names.contains("ModB"), "ModB must be a separate entry");
    }

    /// Issue #165: a folder-layout mod whose manifest is malformed (so it falls
    /// back to dll_only_mod) must record EVERY file in its folder — the .dll, the
    /// (unparsable) .json, and any assets — so a share uploads a complete bundle.
    #[test]
    fn manifest_fallback_subdir_mod_includes_all_folder_files() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        // Malformed JSON → parse_manifest fails → dll_only_mod fallback.
        write_bytes(&mods_dir.join("Flagellant").join("Mod.dll"), b"MZ");
        write_bytes(
            &mods_dir.join("Flagellant").join("Mod.json"),
            b"{ this is not valid json",
        );
        write_bytes(
            &mods_dir.join("Flagellant").join("assets").join("art.png"),
            b"PNG",
        );

        let results = scan_mods_inner(mods_dir, true);
        assert_eq!(results.len(), 1, "exactly one mod expected");
        let info = &results[0];
        assert_eq!(info.version, "unknown", "fallback mods report unknown");

        let mut files = info.files.clone();
        files.sort();
        assert_eq!(
            files,
            vec![
                "Flagellant/Mod.dll".to_string(),
                "Flagellant/Mod.json".to_string(),
                "Flagellant/assets/art.png".to_string(),
            ],
            "all folder files must be recorded with forward slashes; got {:?}",
            info.files
        );
    }

    /// A flat-layout DLL sitting directly in the mods dir must keep the original
    /// behaviour: just the .dll plus a co-located same-stem .pck.
    #[test]
    fn flat_layout_dll_only_mod_keeps_minimal_files() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        write_bytes(&mods_dir.join("Flat.dll"), b"MZ");
        write_bytes(&mods_dir.join("Flat.pck"), b"GDPC");
        // An unrelated sibling file that must NOT be swept in.
        write_bytes(&mods_dir.join("Other.txt"), b"x");

        let info = dll_only_mod(&mods_dir.join("Flat.dll"), mods_dir, true);
        let mut files = info.files.clone();
        files.sort();
        assert_eq!(
            files,
            vec!["Flat.dll".to_string(), "Flat.pck".to_string()],
            "flat-layout mod must keep only the dll + same-stem pck; got {:?}",
            info.files
        );
    }

    /// A PCK-only mod in a subdirectory with an extra asset file must record
    /// every file in the folder (issue #165 applies to pck_only_mod too).
    #[test]
    fn pck_only_subdir_mod_includes_all_folder_files() {
        let tmp = TempDir::new().unwrap();
        let mods_dir = tmp.path();

        write_bytes(&mods_dir.join("ZSproject").join("ZSproject.pck"), b"GDPC");
        write_bytes(&mods_dir.join("ZSproject").join("readme.txt"), b"hi");

        let info = pck_only_mod(
            &mods_dir.join("ZSproject").join("ZSproject.pck"),
            mods_dir,
            true,
        );
        let mut files = info.files.clone();
        files.sort();
        assert_eq!(
            files,
            vec![
                "ZSproject/ZSproject.pck".to_string(),
                "ZSproject/readme.txt".to_string(),
            ],
            "pck-only subdir mod must record all folder files; got {:?}",
            info.files
        );
    }
}
