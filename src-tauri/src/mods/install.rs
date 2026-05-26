//! Archive-extraction helpers: 7z and rar decompression, plus the
//! "repack a directory as a stored-compression zip" stub used to
//! funnel non-zip archives back into the zip install path.
//!
//! Split out of the historic `mods.rs` mega-file so the third-party
//! archive-format adapters (sevenz_rust2, unrar) live separately
//! from the zip-aware install orchestration. The big workflow
//! function (`install_mod_from_zip`) stays in `mod.rs` because it
//! depends on `ModInfo`, manifest parsing, and the embedded test
//! modules — splitting it would require moving its 18 helpers and
//! 11 tests in lockstep.
//!
//! See `mods/mod.rs::install_mod_from_archive` for the dispatch
//! that picks the right extractor by extension.

use std::fs;
use std::io::Write as IoWrite;
use std::path::Path;

use walkdir::WalkDir;

use crate::error::{AppError, Result};

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
/// Note: skips its own output file (`__sts2mm_repack.zip`) so an in-place
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
