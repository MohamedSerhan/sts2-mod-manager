//! Archive-extraction helpers + the install pipeline: 7z/rar decompression,
//! "repack a directory as a stored-compression zip" stub, `install_mod_from_zip`'s
//! wrap-folder + manifest-discovery workflow, and the `install_mod_from_archive`
//! dispatcher that picks the right extractor by extension.
//!
//! Split out of the historic `mods.rs` mega-file so the install pipeline
//! (which is naturally one workflow — read an archive, detect its layout,
//! lay files into `mods/`, and surface a `ModInfo`) lives separately from
//! the enable/disable file-move orchestration in `mod.rs` and the
//! read-only scan/parse layer in `scan.rs`.
//!
//! See `mods/mod.rs` for the Tauri commands that wrap these install
//! entry points + the post-install snapshot lifecycle.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write as IoWrite};
use std::path::Path;

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::error::{AppError, Result};

use super::scan::{
    calculate_mod_size, collect_bundle_member_metadata, hash_file, parse_manifest, scan_mods,
    strip_utf8_bom,
};
use super::state::{path_is_inside, sanitize_path_segment};
use super::ModInfo;

/// Decompress a `.7z` file into `dest_dir`. Thin wrapper around
/// `sevenz_rust2` so the install path can branch by extension
/// without learning the third-party crate's error type.
pub(super) fn extract_7z_to_dir(seven_z_path: &Path, dest_dir: &Path) -> Result<()> {
    sevenz_rust2::decompress_file(seven_z_path, dest_dir)
        .map_err(|e| AppError::Other(format!("Failed to extract 7z archive: {}", e)))
}

/// Decompress a `.rar` file into `dest_dir`. Skips macOS junk
/// (`__MACOSX/`, `._*`) the same way the zip path does — both formats
/// pick up these turds when archives get repackaged on macOS.
pub(super) fn extract_rar_to_dir(rar_path: &Path, dest_dir: &Path) -> Result<()> {
    let mut archive = unrar::Archive::new(rar_path)
        .open_for_processing()
        .map_err(|e| AppError::Other(format!("Failed to open rar archive: {}", e)))?;
    while let Some(header) = archive
        .read_header()
        .map_err(|e| AppError::Other(format!("Failed to read rar header: {}", e)))?
    {
        let entry_name = header.entry().filename.to_string_lossy().to_string();
        if entry_name.starts_with("__MACOSX")
            || entry_name.contains("/._")
            || entry_name.starts_with("._")
        {
            archive = header.skip().map_err(|e| {
                AppError::Other(format!("Failed to skip rar entry '{}': {}", entry_name, e))
            })?;
            continue;
        }
        if header.entry().is_directory() {
            archive = header.skip().map_err(|e| {
                AppError::Other(format!(
                    "Failed to skip rar directory '{}': {}",
                    entry_name, e
                ))
            })?;
            continue;
        }
        // Use unrar's destination-aware extract so the C library handles
        // path traversal sanitization. install_mod_from_zip's enclosed_name
        // gate then re-checks at the final destination boundary.
        archive = header.extract_with_base(dest_dir).map_err(|e| {
            AppError::Other(format!(
                "Failed to extract rar entry '{}': {}",
                entry_name, e
            ))
        })?;
    }
    Ok(())
}

/// Walk a directory and produce a stored-compression zip of its contents,
/// rooted at `src_dir`. Used by the non-zip install path to funnel 7z and
/// rar extractions back into install_mod_from_zip so the wrap-folder /
/// zip-slip / manifest-discovery code only lives in one place.
///
/// Note: skips its own output file (matched by filename) so an in-place
/// repack doesn't try to include the partially-written zip in itself —
/// would otherwise truncate to zero on the first read pass.
pub(super) fn repack_dir_as_zip(src_dir: &Path, dest_zip: &Path) -> Result<()> {
    let dest_file = fs::File::create(dest_zip).map_err(|e| {
        AppError::Other(format!(
            "Could not create repack zip at {:?}: {}",
            dest_zip, e
        ))
    })?;
    let mut writer = zip::ZipWriter::new(dest_file);
    let opts: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let dest_name = dest_zip.file_name().unwrap_or_default().to_os_string();

    for entry in WalkDir::new(src_dir).into_iter().flatten() {
        let path = entry.path();
        if path == dest_zip || path.file_name() == Some(&dest_name) {
            continue;
        }
        if entry.file_type().is_dir() {
            continue;
        }
        let rel = match path.strip_prefix(src_dir) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        writer.start_file(&rel, opts).map_err(|e| {
            AppError::Other(format!("Repack: start_file failed for {}: {}", rel, e))
        })?;
        let bytes = fs::read(path)
            .map_err(|e| AppError::Other(format!("Repack: read failed for {:?}: {}", path, e)))?;
        IoWrite::write_all(&mut writer, &bytes)
            .map_err(|e| AppError::Other(format!("Repack: write failed for {}: {}", rel, e)))?;
    }
    writer
        .finish()
        .map_err(|e| AppError::Other(format!("Repack: finalize failed: {}", e)))?;
    Ok(())
}

// ── Archive Install Pipeline ───────────────────────────────────────────────

/// Strip a Nexus-style version suffix (`-12345-1234`) from a zip stem so
/// the wrap folder name becomes the actual mod name instead of leaking the
/// upload id. Nexus filenames look like `MyMod-12345-1234-1599999999.zip`
/// — we walk backwards stripping `-digits` groups until we find something
/// that isn't a trailing digit-and-dash run.
pub(super) fn strip_nexus_suffix(stem: &str) -> String {
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
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(strip_utf8_bom(&buf)) {
                    // Prefer Id (game uses this for dependency resolution), then PckName, then Name
                    if let Some(id) = val
                        .get("Id")
                        .or_else(|| val.get("id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Some(id.to_string());
                    }
                    if let Some(pck) = val
                        .get("PckName")
                        .or_else(|| val.get("pck_name"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Some(pck.to_string());
                    }
                    if let Some(name) = val
                        .get("Name")
                        .or_else(|| val.get("name"))
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

/// Install a mod from any supported archive format (.zip, .7z, .rar).
///
/// Belt-and-braces: even though `install_mod_from_zip` accepts archives that
/// don't contain a recognisable mod (they fall through to the "version
/// unknown" stub), `install_mod_from_archive` additionally verifies the
/// extraction produced a mod visible to `scan_mods`. Nested archive uploads
/// (a .zip that contains another .zip) and over-wrapped uploads
/// (`Wrapper/NotTheMod/StillNotTheMod/Mod/...`) leave the mod buried where
/// the scanner can't reach it; failing loudly with cleanup is better than
/// shipping a disappearing-row.
pub fn install_mod_from_archive(archive_path: &Path, mods_path: &Path) -> Result<ModInfo> {
    let info = install_mod_from_archive_unchecked(archive_path, mods_path)?;
    if installed_info_is_visible_after_extract(&info, mods_path) {
        return Ok(info);
    }

    super::delete_mod_files_by_info(&info, mods_path);
    let archive_name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("archive");
    Err(AppError::Other(format!(
        "No installed mod could be detected after extracting '{}'. The archive may contain another archive or an extra wrapper folder; extract the inner mod archive and install that instead.",
        archive_name
    )))
}

fn install_mod_from_archive_unchecked(archive_path: &Path, mods_path: &Path) -> Result<ModInfo> {
    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "zip" => install_mod_from_zip(archive_path, mods_path),
        "7z" => {
            let staging = tempfile::tempdir().map_err(|e| {
                AppError::Other(format!(
                    "Could not create temp staging dir for 7z extract: {}",
                    e
                ))
            })?;
            extract_7z_to_dir(archive_path, staging.path())?;
            let repack_name = format!(
                "{}.zip",
                archive_path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
            let repack_zip = staging.path().join(repack_name);
            repack_dir_as_zip(staging.path(), &repack_zip)?;
            install_mod_from_zip(&repack_zip, mods_path)
        }
        "rar" => {
            let staging = tempfile::tempdir().map_err(|e| {
                AppError::Other(format!(
                    "Could not create temp staging dir for rar extract: {}",
                    e
                ))
            })?;
            extract_rar_to_dir(archive_path, staging.path())?;
            let repack_name = format!(
                "{}.zip",
                archive_path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
            let repack_zip = staging.path().join(repack_name);
            repack_dir_as_zip(staging.path(), &repack_zip)?;
            install_mod_from_zip(&repack_zip, mods_path)
        }
        other => Err(AppError::Other(format!(
            "Unsupported archive format: '.{}'. Supported: .zip, .7z, .rar",
            other
        ))),
    }
}

fn normalized_installed_rel(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .to_lowercase()
}

fn mod_identity_intersects(a: &ModInfo, b: &ModInfo) -> bool {
    let mut a_keys = HashSet::new();
    for candidate in [
        a.mod_id.as_deref(),
        a.folder_name.as_deref(),
        Some(a.name.as_str()),
    ] {
        if let Some(value) = candidate {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                a_keys.insert(trimmed.to_lowercase());
            }
        }
    }

    [
        b.mod_id.as_deref(),
        b.folder_name.as_deref(),
        Some(b.name.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .any(|value| a_keys.contains(&value.to_lowercase()))
}

fn installed_info_is_visible_after_extract(info: &ModInfo, mods_path: &Path) -> bool {
    let installed_files: HashSet<String> = info
        .files
        .iter()
        .map(|f| normalized_installed_rel(f))
        .collect();

    scan_mods(mods_path).into_iter().any(|scanned| {
        mod_identity_intersects(&scanned, info)
            || scanned
                .files
                .iter()
                .map(|f| normalized_installed_rel(f))
                .any(|f| installed_files.contains(&f))
    })
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
    let mut top_dirs: HashSet<String> = HashSet::new();
    let mut all_top_dirs: HashSet<String> = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if entry.is_dir() || name.starts_with("__MACOSX") || name.starts_with("._") {
            continue;
        }
        if entry.enclosed_name().is_none() {
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
    let strip_redundant_outer: Option<String> =
        if all_top_dirs.len() == 1 && !all_entries.is_empty() {
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
        let dll_stem = relevant_entries
            .iter()
            .find(|n| {
                let ext = Path::new(n)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
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
    let has_clean_single_top_dir =
        all_top_dirs.len() == 1 && all_entries.iter().all(|n| n.contains('/'));

    // A "bundle" is an archive where ≥2 distinct top-level member folders
    // each contain files and every file is inside one of those folders (no
    // root-level loose files). Such archives get a named container folder
    // derived from the archive stem rather than the first manifest id.
    let is_bundle = all_top_dirs.len() >= 2
        && !all_entries.is_empty()
        && all_entries.iter().all(|n| n.contains('/'));

    let mut extracted_files = Vec::new();
    let mut manifest: Option<ModInfo> = None;

    // wrap_folder_name comes from manifest fields / DLL stems / zip stems —
    // mostly attacker-influenceable for a hostile share-code or Quick Add
    // URL. Sanitize once before it gets joined into a destination path so a
    // malicious manifest with `Name: "../.."` can't redirect extraction.
    let wrap_folder_name = sanitize_path_segment(&wrap_folder_name);

    // For multi-member bundle archives, override the wrap folder name with
    // the archive-stem-derived container name (sanitized inside
    // bundle_container_name). For everything else, keep wrap_folder_name.
    let container_name = if is_bundle {
        super::bundle::bundle_container_name(zip_path)
    } else {
        wrap_folder_name.clone()
    };

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
            name.strip_prefix(&format!("{}/", outer))
                .unwrap_or(&name)
                .to_string()
        } else if has_clean_single_top_dir {
            name.clone()
        } else if all_entries.len() == 1 {
            name.clone()
        } else {
            // For bundles: container_name = bundle_container_name(zip_path)
            // For everything else: container_name = wrap_folder_name
            format!("{}/{}", container_name, name)
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

    // For bundle archives, write a minimal sidecar into the container folder
    // so scanners and the UI can identify it as a bundle container.
    if is_bundle {
        let dir = mods_path.join(&container_name);
        let installed_version = super::bundle::nexus_file_version(zip_path)
            .or_else(|| super::bundle::display_name_version(&container_name));
        let _ = super::bundle::write_sidecar(
            &dir,
            &super::bundle::BundleSidecar {
                display_name: container_name.clone(),
                installed_version: installed_version.clone(),
                ..Default::default()
            },
        );

        let size_bytes = calculate_mod_size(mods_path, &extracted_files);
        let (bundle_members, bundle_member_ids) =
            collect_bundle_member_metadata(&dir, mods_path, true);
        return Ok(ModInfo {
            mod_version_id: None,
            name: container_name.clone(),
            version: installed_version.unwrap_or_else(|| "unknown".to_string()),
            description: String::new(),
            enabled: true,
            files: extracted_files,
            source: None,
            hash: hash_file(zip_path),
            dependencies: Vec::new(),
            size_bytes,
            folder_name: Some(container_name),
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
            bundle_members,
            bundle_member_ids,
        });
    }

    let size_bytes = calculate_mod_size(mods_path, &extracted_files);

    let fallback_mod_name = if is_bundle {
        container_name.clone()
    } else if has_clean_single_top_dir && all_top_dirs.len() == 1 {
        all_top_dirs
            .iter()
            .next()
            .cloned()
            .unwrap_or_else(|| container_name.clone())
    } else if all_entries.len() == 1 {
        Path::new(all_entries.first().map(String::as_str).unwrap_or(""))
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .filter(|stem| !stem.is_empty())
            .unwrap_or_else(|| container_name.clone())
    } else {
        container_name.clone()
    };

    match manifest {
        Some(mut m) => {
            m.files = extracted_files;
            m.size_bytes = size_bytes;
            Ok(m)
        }
        None => {
            let mod_name = fallback_mod_name;
            Ok(ModInfo {
                mod_version_id: None,
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
            })
        }
    }
}

// ── Config-overwrite detection ─────────────────────────────────────────────

/// Extensions we hash on install and preserve on update. Intentionally
/// excludes `.json` — in the STS2 ecosystem, JSON is always game-readable
/// manifest data, never user-tunable settings. Preserving a stale
/// manifest would lie to the loader / our audit about the installed
/// version.
const TRACKED_CONFIG_EXTENSIONS: &[&str] = &["cfg", "ini", "toml", "txt"];

/// Don't try to preserve a "config" larger than this. Real STS2 configs
/// are kilobytes; multi-MB files with these extensions are almost
/// certainly packaged data. Cap also bounds memory during the
/// read → delete → restore window.
const MAX_TRACKED_CONFIG_BYTES: u64 = 1024 * 1024;

fn is_tracked_config_path(rel_name: &str) -> bool {
    // Skip our own sidecar / backup directories regardless of extension.
    if rel_name.starts_with(".sts2mm-") || rel_name.contains("/.sts2mm-") {
        return false;
    }
    let ext = Path::new(rel_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    TRACKED_CONFIG_EXTENSIONS.iter().any(|e| *e == ext)
}

/// Hash every tracked config file under `mod_folder` (recursive). Returns
/// `{forward-slash relative path: hex SHA256}`. Empty when the folder has
/// no tracked configs.
pub fn snapshot_mod_configs(mod_folder: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if !mod_folder.is_dir() {
        return out;
    }
    for entry in WalkDir::new(mod_folder).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(mod_folder) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !is_tracked_config_path(&rel) {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if len > MAX_TRACKED_CONFIG_BYTES {
            continue;
        }
        if let Some(hash) = hash_file(path) {
            out.insert(rel, hash);
        }
    }
    out
}

/// A user-edited config file that needs to survive an update. Held in
/// memory between the pre-extract delete and the post-extract restore.
#[derive(Debug, Clone)]
pub struct PreservedConfig {
    /// Forward-slash path relative to the mod folder root. Matches the
    /// key shape in `ModSourceEntry.config_hashes`.
    pub rel_path: String,
    pub bytes: Vec<u8>,
}

/// Read every config file under `mod_folder` that the user has edited
/// (hash differs from `snapshot`) OR created since install (present on
/// disk but not in `snapshot`). Returns the file bytes ready to be
/// restored after extract.
///
/// Returns an empty list when `snapshot` is empty — that's the
/// "installed before this feature shipped" case; we have no baseline to
/// compare against and conservatively let the update proceed as before.
pub fn read_user_edited_configs(
    mod_folder: &Path,
    snapshot: &std::collections::HashMap<String, String>,
) -> Vec<PreservedConfig> {
    let mut preserved = Vec::new();
    if !mod_folder.is_dir() || snapshot.is_empty() {
        return preserved;
    }
    for entry in WalkDir::new(mod_folder).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(mod_folder) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !is_tracked_config_path(&rel) {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if len > MAX_TRACKED_CONFIG_BYTES {
            continue;
        }
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                log::warn!(
                    "Could not read config '{}' for preservation: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };
        // Hash the bytes and compare to the snapshot. If the snapshot
        // doesn't have this key (user-created file) OR the hash differs
        // (user edit), preserve.
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let cur_hash = hex::encode(hasher.finalize());
        match snapshot.get(&rel) {
            Some(prev) if prev == &cur_hash => {
                // Unchanged — let the update overwrite freely so the user
                // gets the upstream's possibly-improved defaults.
            }
            _ => {
                preserved.push(PreservedConfig {
                    rel_path: rel,
                    bytes,
                });
            }
        }
    }
    preserved
}

/// Write each preserved config back into the freshly-extracted mod
/// folder. Used by the install pipeline AFTER the new release's files
/// have been laid down.
pub fn restore_preserved_configs(mod_folder: &Path, preserved: &[PreservedConfig]) -> Result<()> {
    for p in preserved {
        let dest = mod_folder.join(&p.rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                AppError::Other(format!(
                    "Could not recreate parent dir '{}' for preserved config '{}': {}",
                    parent.display(),
                    p.rel_path,
                    e
                ))
            })?;
        }
        fs::write(&dest, &p.bytes).map_err(|e| {
            AppError::Other(format!(
                "Could not restore preserved config '{}': {}",
                dest.display(),
                e
            ))
        })?;
    }
    Ok(())
}

/// Read the on-disk snapshot for the installed mod (looked up by old
/// folder + display name) and produce the list of user-edited files
/// ready to be restored after the new release is extracted.
///
/// Empty list when no baseline snapshot exists (mod installed before
/// this feature shipped); the rollout path lets the update proceed
/// without preservation and finalize captures a fresh snapshot.
pub fn prepare_update_with_preserved_configs(
    old_folder_name: &str,
    old_display_name: &str,
    mods_path: &Path,
    config_path: &Path,
) -> Vec<PreservedConfig> {
    let snapshot = crate::mod_sources::load_config_snapshot(
        Some(old_folder_name),
        old_display_name,
        config_path,
    );
    if snapshot.is_empty() {
        return Vec::new();
    }
    let old_folder_abs = mods_path.join(old_folder_name);
    read_user_edited_configs(&old_folder_abs, &snapshot)
}

/// Outcome of finalizing an update's config preservation: which user-edited
/// files were successfully restored onto the new release, and which were LOST
/// because the restore failed after extraction.
#[derive(Debug, Clone, Default)]
pub struct PreservedConfigOutcome {
    /// Edits that were written back onto the new release.
    pub preserved: Vec<String>,
    /// Edits that could NOT be re-applied — the user will need to redo them.
    pub lost: Vec<String>,
}

/// Restore the previously-read user edits and re-snapshot the post-extract
/// state so the next update has a fresh baseline.
///
/// On a *successful* restore the new on-disk configs become the baseline and
/// the restored paths are reported as `preserved`. On a *failed* restore we
/// deliberately do TWO things differently: (1) we do NOT advance the baseline
/// snapshot, so the prior baseline survives and a later update can still detect
/// (and re-attempt to preserve) the edits instead of silently treating the
/// upstream defaults as the user's content — which would lock in the loss; and
/// (2) we report the affected paths as `lost`, never as "preserved", so the UI
/// tells the truth rather than naming wiped files as kept. The update itself
/// still proceeds either way (we don't block on a config-restore hiccup).
pub fn finalize_update_with_preserved_configs(
    new_info: &ModInfo,
    mods_path: &Path,
    preserved: Vec<PreservedConfig>,
    config_path: &Path,
) -> Result<PreservedConfigOutcome> {
    let new_folder_name = new_info
        .folder_name
        .clone()
        .unwrap_or_else(|| new_info.name.clone());
    let new_folder_abs = mods_path.join(&new_folder_name);

    let names: Vec<String> = preserved.iter().map(|p| p.rel_path.clone()).collect();

    if !preserved.is_empty() {
        if let Err(e) = restore_preserved_configs(&new_folder_abs, &preserved) {
            log::warn!(
                "Failed to restore preserved configs for '{}': {} — the update \
                 proceeds, but these edits could not be re-applied and are LOST: \
                 {}. The config baseline is left untouched so a future update can \
                 still recover them.",
                new_info.name,
                e,
                names.join(", "),
            );
            // Leave the baseline as-is (no re-snapshot) and surface the loss.
            return Ok(PreservedConfigOutcome {
                preserved: Vec::new(),
                lost: names,
            });
        }
    }

    let snapshot = snapshot_mod_configs(&new_folder_abs);
    crate::mod_sources::save_config_snapshot(
        Some(&new_folder_name),
        &new_info.name,
        snapshot,
        config_path,
    );

    Ok(PreservedConfigOutcome {
        preserved: names,
        lost: Vec::new(),
    })
}

/// Snapshot the freshly-installed mod's config files so future updates
/// can detect user edits. Called right after a clean (non-update) install.
pub fn snapshot_after_fresh_install(info: &ModInfo, mods_path: &Path, config_path: &Path) {
    let folder_name = info
        .folder_name
        .clone()
        .unwrap_or_else(|| info.name.clone());
    let folder_abs = mods_path.join(&folder_name);
    let snapshot = snapshot_mod_configs(&folder_abs);
    if snapshot.is_empty() {
        return; // mod ships no tracked configs; skip the empty write
    }
    crate::mod_sources::save_config_snapshot(Some(&folder_name), &info.name, snapshot, config_path);
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod archive_dispatch_tests {
    //! Coverage for the user-feedback batch (May 2026) that taught the
    //! install pipeline to read .7z and .rar in addition to .zip. The
    //! integration path is `install_mod_from_archive` → format-specific
    //! extractor → repack to a stored-compression zip → `install_mod_from_zip`.
    //!
    //! .7z is exercised end-to-end because sevenz-rust2 provides
    //! both compression and decompression, so the fixture is built in the
    //! test itself.
    //!
    //! .rar is exercised at the dispatch boundary only: the `unrar` crate
    //! is decompress-only (it wraps RARLab's freeware unrar source), so
    //! the test confirms the right extractor is selected without trying
    //! to fabricate a RAR file at runtime. A full RAR round-trip would
    //! require an external `rar.exe`, which isn't part of CI.

    use super::*;

    fn zip_bytes(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let cursor = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zw.start_file(name, opts).unwrap();
            zw.write_all(&bytes).unwrap();
        }
        zw.finish().unwrap().into_inner()
    }

    fn write_zip_file(path: &Path, entries: Vec<(&str, Vec<u8>)>) {
        fs::write(path, zip_bytes(entries)).unwrap();
    }

    #[test]
    fn install_mod_from_archive_dispatch_rejects_unsupported_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let bogus = tmp.path().join("mod.tar.gz");
        fs::write(&bogus, b"not a real archive").unwrap();
        let mods_tmp = tempfile::tempdir().unwrap();
        let err = install_mod_from_archive(&bogus, mods_tmp.path()).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("Unsupported archive format")
                && msg.contains(".zip")
                && msg.contains(".7z")
                && msg.contains(".rar"),
            "rejection error should list the three supported formats, got: {}",
            msg,
        );
    }

    #[test]
    fn install_mod_from_archive_extracts_a_7z_through_the_zip_pipeline() {
        // Build a real .7z fixture in a tempdir using sevenz-rust2's
        // compression. The layout matches the canonical "one wrap folder"
        // STS2 mod shape: ModName/ModName.json + ModName/ModName.dll.
        let src_tmp = tempfile::tempdir().unwrap();
        let manifest_dir = src_tmp.path().join("Stagger");
        fs::create_dir_all(&manifest_dir).unwrap();
        fs::write(
            manifest_dir.join("Stagger.json"),
            br#"{
  "id": "Stagger",
  "name": "Stagger",
  "version": "0.4.1",
  "author": "Tester",
  "dependencies": [],
  "has_pck": false,
  "has_dll": true,
  "affects_gameplay": false
}"#,
        )
        .unwrap();
        fs::write(manifest_dir.join("Stagger.dll"), b"fake-dll").unwrap();

        let seven_z_path = src_tmp.path().join("Stagger.7z");
        sevenz_rust2::compress_to_path(&manifest_dir, &seven_z_path)
            .expect("compress test fixture to .7z");

        // sevenz-rust2's compress_to_path strips the wrapping folder when
        // given a directory, so re-create it manually if needed.
        // (Some versions preserve it. We don't assert layout here — the
        // install pipeline handles both cases via its wrap-folder logic.)

        let mods_tmp = tempfile::tempdir().unwrap();
        let info = install_mod_from_archive(&seven_z_path, mods_tmp.path())
            .expect(".7z install must succeed for a well-formed fixture");

        // Either name (manifest's "Stagger") or the wrap-folder name —
        // both are valid post-install identities. The strong assertion is
        // that we got a real ModInfo, not the "unknown" stub install_mod_from_zip
        // falls through to when manifest parsing fails.
        assert_eq!(
            info.version, "0.4.1",
            ".7z extract→repack→install must surface the manifest version, not 'unknown'"
        );
        assert_eq!(info.name, "Stagger");
        assert!(
            info.files.iter().any(|f| f.ends_with(".dll")),
            "the .dll from the .7z must end up on the file list, got files: {:?}",
            info.files,
        );
    }

    #[test]
    fn broken_manifest_clean_folder_zip_reports_installed_folder_not_nexus_stem() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp
            .path()
            .join("Flagellant 0.1.7-1073-0-1-7-1781082503 (1).zip");
        write_zip_file(
            &zip_path,
            vec![
                ("Flagellant/Flagellant.dll", b"fake-dll".to_vec()),
                (
                    "Flagellant/Flagellant.json",
                    br#"{
  Name: "Flagellant"
}"#
                    .to_vec(),
                ),
            ],
        );

        let mods_tmp = tempfile::tempdir().unwrap();
        let info = install_mod_from_zip(&zip_path, mods_tmp.path())
            .expect("broken manifest should still install through dll fallback");

        assert_eq!(info.name, "Flagellant");
        assert_eq!(info.folder_name.as_deref(), Some("Flagellant"));
        assert_eq!(info.version, "unknown");
        assert!(
            info.files
                .iter()
                .any(|file| file == "Flagellant/Flagellant.dll"),
            "the fallback ModInfo must still track files from the real installed folder: {:?}",
            info.files
        );
    }

    #[test]
    fn seven_z_bundle_not_named_sts2mm_repack_and_becomes_bundle_container() {
        // Build a .7z fixture containing TWO mod folders so the install
        // pipeline treats it as a multi-member bundle. The critical assertions
        // are:
        //   1. The top-level container is NOT named `__sts2mm_repack`.
        //   2. The container is flagged as a bundle (has a sidecar).
        //   3. Both member subdirectories are present inside the container.
        //
        // Implementation note: sevenz_rust2::compress_to_path walks the
        // given directory and stores its children at the archive root. To
        // prevent the output .7z from being included in its own archive we
        // keep the two mod-folder source tree in a SEPARATE tempdir from
        // the one where the .7z is written.
        use crate::mods::bundle::is_bundle_container;

        // Content tree: two mod folders side-by-side.
        let content_tmp = tempfile::tempdir().unwrap();

        let mod_a_dir = content_tmp.path().join("ModA");
        fs::create_dir_all(&mod_a_dir).unwrap();
        fs::write(
            mod_a_dir.join("ModA.json"),
            br#"{"id":"ModA","name":"Mod A","version":"1.0.0","author":"T","dependencies":[],"has_dll":true,"has_pck":false,"affects_gameplay":false}"#,
        )
        .unwrap();
        fs::write(mod_a_dir.join("ModA.dll"), b"fake-dll-a").unwrap();

        let mod_b_dir = content_tmp.path().join("ModB");
        fs::create_dir_all(&mod_b_dir).unwrap();
        fs::write(
            mod_b_dir.join("ModB.json"),
            br#"{"id":"ModB","name":"Mod B","version":"2.0.0","author":"T","dependencies":[],"has_dll":true,"has_pck":false,"affects_gameplay":false}"#,
        )
        .unwrap();
        fs::write(mod_b_dir.join("ModB.dll"), b"fake-dll-b").unwrap();

        // Write the .7z to a different tempdir so it is not included in
        // the archive's own source walk.
        let output_tmp = tempfile::tempdir().unwrap();
        let seven_z_path = output_tmp.path().join("DualPack.7z");
        sevenz_rust2::compress_to_path(content_tmp.path(), &seven_z_path)
            .expect("compress two-folder fixture to .7z");

        let mods_tmp = tempfile::tempdir().unwrap();
        install_mod_from_archive(&seven_z_path, mods_tmp.path())
            .expect("two-folder .7z bundle install must succeed");

        // Exactly one top-level directory in mods/.
        let tops: Vec<_> = fs::read_dir(mods_tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(tops.len(), 1, "expected one container dir, got {tops:?}");

        let container_name = &tops[0];

        // Must NOT be the internal sentinel name.
        assert_ne!(
            container_name, "__sts2mm_repack",
            "container must be named after the original archive stem, not the internal sentinel"
        );

        // The container must carry a bundle sidecar.
        let container = mods_tmp.path().join(container_name);
        assert!(
            is_bundle_container(&container),
            "7z bundle container must have a sidecar; container dir: {container_name}"
        );

        // Both member subdirs must be present.
        assert!(
            container.join("ModA").is_dir(),
            "ModA subdir must be inside the container"
        );
        assert!(
            container.join("ModB").is_dir(),
            "ModB subdir must be inside the container"
        );
    }

    #[test]
    fn install_mod_from_archive_propagates_a_useful_error_for_a_corrupt_rar() {
        // Confirms .rar dispatch routes through the rar extractor and
        // surfaces a real failure (vs panicking) when the file isn't a
        // valid RAR archive. A clean round-trip test isn't possible
        // without external tooling — see module docstring.
        let tmp = tempfile::tempdir().unwrap();
        let fake_rar = tmp.path().join("mod.rar");
        fs::write(&fake_rar, b"this is not a rar file").unwrap();
        let mods_tmp = tempfile::tempdir().unwrap();
        let err = install_mod_from_archive(&fake_rar, mods_tmp.path()).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.to_lowercase().contains("rar"),
            "error should make clear the rar extractor rejected the file, got: {}",
            msg,
        );
    }

    #[test]
    fn install_mod_from_archive_rejects_nested_archive_that_would_not_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let inner_zip = tmp.path().join("InnerMod.zip");
        write_zip_file(
            &inner_zip,
            vec![
                (
                    "InnerMod/InnerMod.json",
                    br#"{"name":"InnerMod","version":"1.0.0"}"#.to_vec(),
                ),
                ("InnerMod/InnerMod.dll", b"dll".to_vec()),
            ],
        );

        let outer_zip = tmp.path().join("OuterPackage.zip");
        write_zip_file(
            &outer_zip,
            vec![("InnerMod.zip", fs::read(&inner_zip).unwrap())],
        );

        let mods_tmp = tempfile::tempdir().unwrap();
        let err = install_mod_from_archive(&outer_zip, mods_tmp.path()).unwrap_err();
        let msg = err.to_string();

        assert!(
            msg.contains("No installed mod could be detected"),
            "nested archive installs must fail loudly instead of returning a disappearing row; got: {}",
            msg
        );
        assert!(
            fs::read_dir(mods_tmp.path()).unwrap().next().is_none(),
            "failed nested-archive install should clean up the extracted inner archive"
        );
    }

    #[test]
    fn install_mod_from_archive_rejects_deeply_nested_archive_chain_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let inner_mod_zip = zip_bytes(vec![
            (
                "DeepMod/DeepMod.json",
                br#"{"id":"DeepMod","name":"DeepMod","version":"3.0.0"}"#.to_vec(),
            ),
            ("DeepMod/DeepMod.dll", b"dll".to_vec()),
        ]);
        let middle_zip = zip_bytes(vec![("level-two/level-three/DeepMod.zip", inner_mod_zip)]);
        let outer_zip = tmp.path().join("OuterPackage.zip");
        write_zip_file(
            &outer_zip,
            vec![("level-one/level-two/MiddlePackage.zip", middle_zip)],
        );

        let mods_tmp = tempfile::tempdir().unwrap();
        let err = install_mod_from_archive(&outer_zip, mods_tmp.path()).unwrap_err();
        let msg = err.to_string();

        assert!(
            msg.contains("another archive"),
            "deep nested archive installs should tell the user an inner archive is likely involved; got: {}",
            msg,
        );
        assert!(
            fs::read_dir(mods_tmp.path()).unwrap().next().is_none(),
            "failed deep nested-archive install should leave no extracted wrapper folders behind"
        );
    }

    #[test]
    fn multi_member_archive_becomes_one_bundle_container_with_sidecar() {
        use crate::mods::bundle::{is_bundle_container, read_sidecar};
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp
            .path()
            .join("AliceDefectSkin V2.0-979-2-1-1780132414.zip");
        write_zip_file(&zip, vec![
            ("AliceDefectSkin/AliceDefectSkin.json",
                br#"{"id":"AliceDefectSkin","name":"Alice Defect Skin","version":"0.1.31"}"#.to_vec()),
            ("AliceDefectSkin/AliceDefectSkin.dll", b"dll".to_vec()),
            ("AliceDefectVoiceBridge/mod_manifest.json",
                br#"{"id":"AliceDefectVoiceBridge","name":"Alice Defect Voice Bridge","version":"1.0.4"}"#.to_vec()),
            ("AliceDefectVoiceBridge/AliceDefectVoiceBridge.dll", b"dll".to_vec()),
        ]);
        let mods = tempfile::tempdir().unwrap();
        let installed = install_mod_from_archive(&zip, mods.path()).expect("multi-member installs");
        assert_eq!(installed.name, "AliceDefectSkin V2.0");
        assert_eq!(
            installed.folder_name.as_deref(),
            Some("AliceDefectSkin V2.0")
        );
        assert_eq!(installed.mod_id, None);
        assert_eq!(installed.bundle_members.len(), 2);
        assert_eq!(
            installed.bundle_member_ids,
            vec![
                "AliceDefectSkin".to_string(),
                "AliceDefectVoiceBridge".to_string()
            ]
        );
        let tops: Vec<_> = fs::read_dir(mods.path())
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(tops.len(), 1, "one container, got {tops:?}");
        let container = mods.path().join(&tops[0]);
        assert!(is_bundle_container(&container), "container has a sidecar");
        assert!(container.join("AliceDefectSkin").is_dir());
        assert!(container.join("AliceDefectVoiceBridge").is_dir());
        let sidecar = read_sidecar(&container).expect("sidecar parses");
        assert_eq!(sidecar.display_name, "AliceDefectSkin V2.0");
        assert_eq!(sidecar.installed_version.as_deref(), Some("2.1"));

        let scanned = scan_mods(mods.path());
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].version, "2.1");
    }

    #[test]
    fn single_member_archive_is_not_a_bundle() {
        use crate::mods::bundle::is_bundle_container;
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("Solo.zip");
        write_zip_file(
            &zip,
            vec![
                (
                    "Solo/Solo.json",
                    br#"{"id":"Solo","name":"Solo","version":"1.0.0"}"#.to_vec(),
                ),
                ("Solo/Solo.dll", b"dll".to_vec()),
            ],
        );
        let mods = tempfile::tempdir().unwrap();
        install_mod_from_archive(&zip, mods.path()).expect("single installs");
        assert!(!is_bundle_container(&mods.path().join("Solo")));
    }

    #[test]
    fn enrich_sets_link_and_version_on_bundle_container() {
        use crate::mods::bundle::{bundle_container_name, enrich_bundle_sidecar, read_sidecar};

        // Build a 2-member bundle zip (the same shape used by multi_member_archive_becomes_one_bundle_container_with_sidecar)
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("Pretty Pack-979-2-1.zip");
        write_zip_file(
            &zip,
            vec![
                (
                    "AliceDefectSkin/AliceDefectSkin.json",
                    br#"{"id":"AliceDefectSkin","name":"Alice Defect Skin","version":"0.1.31"}"#
                        .to_vec(),
                ),
                ("AliceDefectSkin/AliceDefectSkin.dll", b"dll".to_vec()),
                (
                    "AliceDefectVoiceBridge/mod_manifest.json",
                    br#"{"id":"AliceDefectVoiceBridge","name":"Alice Defect Voice Bridge","version":"1.0.4"}"#
                        .to_vec(),
                ),
                (
                    "AliceDefectVoiceBridge/AliceDefectVoiceBridge.dll",
                    b"dll".to_vec(),
                ),
            ],
        );

        let mods = tempfile::tempdir().unwrap();
        install_mod_from_archive(&zip, mods.path()).expect("bundle installs");

        // Confirm the container exists with a sidecar before enriching.
        let container = mods.path().join(bundle_container_name(&zip));
        assert!(
            crate::mods::bundle::is_bundle_container(&container),
            "container must have a sidecar after install"
        );

        // Enrich: should return true for a real bundle container.
        assert!(enrich_bundle_sidecar(
            mods.path(),
            &zip,
            Some("Pretty Pack"),
            Some("https://www.nexusmods.com/slaythespire2/mods/979".to_string()),
            Some("slaythespire2".to_string()),
            Some(979),
            Some("2.0".to_string()),
        ));

        let s = read_sidecar(&container).expect("sidecar must be readable after enrich");
        assert_eq!(s.display_name, "Pretty Pack");
        assert_eq!(
            s.nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/979")
        );
        assert_eq!(s.nexus_game_domain.as_deref(), Some("slaythespire2"));
        assert_eq!(s.nexus_mod_id, Some(979));
        assert_eq!(s.installed_version.as_deref(), Some("2.0"));

        // A non-bundle archive path (no container on disk) → returns false.
        let solo_dir = tempfile::tempdir().unwrap();
        assert!(
            !enrich_bundle_sidecar(
                solo_dir.path(),
                std::path::Path::new("Nope.zip"),
                None,
                None,
                None,
                None,
                None,
            ),
            "enrich must be a no-op for a path with no bundle container"
        );
    }

    #[test]
    fn install_mod_from_archive_rejects_mod_hidden_behind_extra_wrapper_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let outer_zip = tmp.path().join("TooManyFolders.zip");
        write_zip_file(
            &outer_zip,
            vec![
                (
                    "Wrapper/NotTheMod/StillNotTheMod/DeepMod/DeepMod.json",
                    br#"{"id":"DeepMod","name":"DeepMod","version":"3.0.0"}"#.to_vec(),
                ),
                (
                    "Wrapper/NotTheMod/StillNotTheMod/DeepMod/DeepMod.dll",
                    b"dll".to_vec(),
                ),
            ],
        );

        let mods_tmp = tempfile::tempdir().unwrap();
        let err = install_mod_from_archive(&outer_zip, mods_tmp.path()).unwrap_err();
        let msg = err.to_string();

        assert!(
            msg.contains("extra wrapper folder"),
            "too-deep wrapper installs should point at wrapper-folder packaging; got: {}",
            msg,
        );
        assert!(
            fs::read_dir(mods_tmp.path()).unwrap().next().is_none(),
            "failed deep-wrapper install should clean up every extracted folder"
        );
    }
}

#[cfg(test)]
mod config_snapshot_tests {
    //! Coverage for the config-overwrite-detection feature (#35).
    //!
    //! These tests exercise the pure helpers in isolation. The
    //! end-to-end "install → edit → update → preserved" flow goes
    //! through the wrapper functions in mod_sources.rs + the call
    //! sites in updater.rs / downloads_watcher.rs; those are
    //! exercised by integration tests in `tests/qa_scenarios.rs`
    //! (added in this same change).
    use super::*;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn write_at(root: &Path, rel: &str, content: &[u8]) {
        let abs = root.join(rel);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }

    #[test]
    fn snapshot_picks_up_tracked_extensions_only() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "settings.cfg", b"k=v");
        write_at(folder, "lang.ini", b"[en]");
        write_at(folder, "options.toml", b"opt=1");
        write_at(folder, "notes.txt", b"hello");
        // .json is explicitly NOT tracked — STS2 uses it for manifests.
        write_at(folder, "manifest.json", b"{}");
        // .dll / .pck are content, never config.
        write_at(folder, "code.dll", b"binary");
        write_at(folder, "art.pck", b"resourcepack");
        let snap = snapshot_mod_configs(folder);
        let keys: std::collections::HashSet<&String> = snap.keys().collect();
        assert!(keys.iter().any(|k| k.as_str() == "settings.cfg"));
        assert!(keys.iter().any(|k| k.as_str() == "lang.ini"));
        assert!(keys.iter().any(|k| k.as_str() == "options.toml"));
        assert!(keys.iter().any(|k| k.as_str() == "notes.txt"));
        assert!(
            !keys.iter().any(|k| k.as_str() == "manifest.json"),
            ".json must be excluded — STS2 manifest, not user-tunable config"
        );
        assert!(!keys.iter().any(|k| k.as_str() == "code.dll"));
        assert!(!keys.iter().any(|k| k.as_str() == "art.pck"));
        assert_eq!(snap.len(), 4);
    }

    #[test]
    fn snapshot_walks_subdirectories_with_forward_slash_keys() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "lang/en.ini", b"hello");
        write_at(folder, "lang/fr.ini", b"bonjour");
        let snap = snapshot_mod_configs(folder);
        assert_eq!(snap.len(), 2);
        // Must use forward slashes regardless of OS — matches the rest
        // of the codebase's path conventions.
        assert!(snap.contains_key("lang/en.ini"));
        assert!(snap.contains_key("lang/fr.ini"));
    }

    #[test]
    fn snapshot_skips_our_own_sidecar_directories() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "settings.cfg", b"real");
        write_at(folder, ".sts2mm-backup/old.cfg", b"backup");
        let snap = snapshot_mod_configs(folder);
        assert_eq!(snap.len(), 1, "must not hash our own sidecar artifacts");
        assert!(snap.contains_key("settings.cfg"));
    }

    #[test]
    fn snapshot_skips_oversized_files() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        // Real config — small, included.
        write_at(folder, "small.cfg", b"k=v");
        // Same extension, oversize → packaged data, excluded.
        let big: Vec<u8> = vec![0u8; (MAX_TRACKED_CONFIG_BYTES + 1) as usize];
        write_at(folder, "big.cfg", &big);
        let snap = snapshot_mod_configs(folder);
        assert_eq!(snap.len(), 1);
        assert!(snap.contains_key("small.cfg"));
        assert!(!snap.contains_key("big.cfg"));
    }

    #[test]
    fn snapshot_handles_missing_folder_gracefully() {
        let tmp = tempdir().unwrap();
        let absent = tmp.path().join("does-not-exist");
        let snap = snapshot_mod_configs(&absent);
        assert!(
            snap.is_empty(),
            "missing folder must return empty, not panic"
        );
    }

    #[test]
    fn read_user_edited_returns_files_whose_hash_changed() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "config.cfg", b"original=true");
        // Snapshot the original state.
        let snap = snapshot_mod_configs(folder);
        // User "edits" the file.
        write_at(folder, "config.cfg", b"original=false");
        let preserved = read_user_edited_configs(folder, &snap);
        assert_eq!(preserved.len(), 1);
        assert_eq!(preserved[0].rel_path, "config.cfg");
        assert_eq!(preserved[0].bytes, b"original=false");
    }

    #[test]
    fn read_user_edited_skips_files_matching_snapshot() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "config.cfg", b"same");
        let snap = snapshot_mod_configs(folder);
        // No edit. Preserved list must be empty so the next update can
        // happily overwrite with upstream's possibly-improved defaults.
        let preserved = read_user_edited_configs(folder, &snap);
        assert!(preserved.is_empty());
    }

    #[test]
    fn read_user_edited_includes_user_created_files_not_in_snapshot() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "shipped.cfg", b"vendor");
        let snap = snapshot_mod_configs(folder);
        // User drops in a custom override the mod author never shipped.
        write_at(folder, "override.cfg", b"custom");
        let preserved = read_user_edited_configs(folder, &snap);
        let names: std::collections::HashSet<&str> =
            preserved.iter().map(|p| p.rel_path.as_str()).collect();
        assert!(
            names.contains("override.cfg"),
            "user-created files must be preserved"
        );
        assert!(
            !names.contains("shipped.cfg"),
            "untouched shipped configs stay as-is so upstream defaults can be refreshed"
        );
    }

    #[test]
    fn read_user_edited_with_empty_snapshot_returns_nothing() {
        // Rollout case: mod installed before this feature shipped. No
        // baseline → we can't tell what's user-edited → preserve nothing.
        // (The very next update populates a snapshot, after which the
        // preservation actually kicks in.)
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        write_at(folder, "config.cfg", b"could-be-edited-could-be-vendor");
        let empty: HashMap<String, String> = HashMap::new();
        let preserved = read_user_edited_configs(folder, &empty);
        assert!(preserved.is_empty(), "no snapshot = no preservation");
    }

    #[test]
    fn restore_writes_bytes_back_creating_parent_dirs() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path();
        let preserved = vec![
            PreservedConfig {
                rel_path: "lang/custom.ini".into(),
                bytes: b"[user]\nhello=world".to_vec(),
            },
            PreservedConfig {
                rel_path: "settings.cfg".into(),
                bytes: b"k=2".to_vec(),
            },
        ];
        restore_preserved_configs(folder, &preserved).unwrap();
        assert_eq!(
            fs::read(folder.join("lang/custom.ini")).unwrap(),
            b"[user]\nhello=world"
        );
        assert_eq!(fs::read(folder.join("settings.cfg")).unwrap(), b"k=2");
    }

    #[test]
    fn round_trip_install_edit_update_preserves_edits() {
        // End-to-end happy path of the snapshot → edit → preserve →
        // restore cycle (without going through the actual install
        // pipeline). Mimics what install_update_preserving_configs
        // orchestrates in production.
        let tmp = tempdir().unwrap();
        let mod_folder = tmp.path().join("MyMod");
        fs::create_dir_all(&mod_folder).unwrap();

        // 1. Initial install ships these configs.
        write_at(&mod_folder, "settings.cfg", b"vendor-default");
        write_at(&mod_folder, "lang/en.ini", b"hello");

        // 2. We snapshot at install time.
        let snapshot = snapshot_mod_configs(&mod_folder);

        // 3. User edits one of the configs.
        write_at(&mod_folder, "settings.cfg", b"user-edited");

        // 4. Pre-update: we read user edits BEFORE the destructive
        //    delete that would otherwise nuke them.
        let preserved = read_user_edited_configs(&mod_folder, &snapshot);
        assert_eq!(preserved.len(), 1);
        assert_eq!(preserved[0].rel_path, "settings.cfg");

        // 5. Simulate the update's "delete old folder, extract new"
        //    pair. The new release ships an UPDATED vendor default —
        //    say a new key the author added.
        fs::remove_dir_all(&mod_folder).unwrap();
        fs::create_dir_all(&mod_folder).unwrap();
        write_at(
            &mod_folder,
            "settings.cfg",
            b"vendor-default-v2-with-new-keys",
        );
        write_at(&mod_folder, "lang/en.ini", b"hello");
        write_at(&mod_folder, "lang/de.ini", b"hallo"); // brand new locale shipped upstream

        // 6. Restore the user's edits.
        restore_preserved_configs(&mod_folder, &preserved).unwrap();

        // 7. settings.cfg now holds the user's edit again — upstream's
        //    new keys are lost (a known limitation; see the spec's
        //    "Out of scope: three-way merge"). The new locale file
        //    survives because the user didn't touch it.
        assert_eq!(
            fs::read(mod_folder.join("settings.cfg")).unwrap(),
            b"user-edited",
            "user's edit must survive the update"
        );
        assert_eq!(
            fs::read(mod_folder.join("lang/de.ini")).unwrap(),
            b"hallo",
            "upstream's newly-shipped locale file must remain"
        );

        // 8. Snapshot the post-restore state — this is what
        //    finalize_update_with_preserved_configs writes back.
        //    Critical that the snapshot reflects the user-edited
        //    file's hash, not the upstream's hash. Otherwise the
        //    very next update would treat the still-present user
        //    edit as new and not preserve it.
        let next_snapshot = snapshot_mod_configs(&mod_folder);
        let stored = next_snapshot.get("settings.cfg").unwrap();
        let user_hash = hash_file(&mod_folder.join("settings.cfg")).unwrap();
        assert_eq!(
            stored, &user_hash,
            "post-update snapshot must reflect the actual on-disk file (user's edit), \
             not the upstream's shipped default"
        );
    }

    #[test]
    fn finalize_failed_restore_reports_loss_and_keeps_baseline() {
        // When the post-extract config restore fails, the update still proceeds
        // but the affected files are reported as LOST (never as "preserved"),
        // and — critically — the config baseline is NOT advanced. Re-snapshotting
        // the upstream defaults here would make the loss permanent (a later
        // update couldn't tell defaults from the user's content).
        let game_tmp = tempdir().unwrap();
        let config_tmp = tempdir().unwrap();
        let mods_path = game_tmp.path();
        let config_path = config_tmp.path();

        let info = ModInfo {
            mod_version_id: None,
            name: "MyMod".to_string(),
            version: "2.0".to_string(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: Some("MyMod".to_string()),
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
        };
        let new_folder = mods_path.join("MyMod");
        fs::create_dir_all(&new_folder).unwrap();
        write_at(&new_folder, "ok.cfg", b"upstream-default-v2");

        // The user's prior baseline — what their last install snapshotted.
        crate::mod_sources::save_config_snapshot(
            Some("MyMod"),
            "MyMod",
            std::collections::HashMap::from([(
                "settings.cfg".to_string(),
                "old-baseline-hash".to_string(),
            )]),
            config_path,
        );

        // Force the restore to fail: a DIRECTORY sits where the preserved file
        // must be written, so fs::write errors.
        fs::create_dir_all(new_folder.join("settings.cfg")).unwrap();
        let preserved = vec![PreservedConfig {
            rel_path: "settings.cfg".into(),
            bytes: b"user-edited".to_vec(),
        }];

        let outcome =
            finalize_update_with_preserved_configs(&info, mods_path, preserved, config_path)
                .unwrap();

        assert_eq!(
            outcome.lost,
            vec!["settings.cfg".to_string()],
            "the un-restorable edit is reported as lost"
        );
        assert!(
            outcome.preserved.is_empty(),
            "nothing is reported as preserved on a failed restore"
        );

        let baseline =
            crate::mod_sources::load_config_snapshot(Some("MyMod"), "MyMod", config_path);
        assert_eq!(
            baseline.get("settings.cfg").map(String::as_str),
            Some("old-baseline-hash"),
            "the config baseline must survive a failed restore so recovery stays possible"
        );
    }
}
