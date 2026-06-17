//! Asset-bundling helpers: zip a mod's declared files into an in-memory
//! buffer or temporary file, validate that every mod in the
//! profile has a bundle URL before declaring the publish complete,
//! and (best-effort) restore the prior on-disk profile when a publish
//! fails partway through.
//!
//! Split out of the historic `sharing.rs` mega-file so the
//! filesystem-walking + zip-writer + path-safety logic lives separately
//! from the GitHub HTTP plumbing (`sharing/github.rs`) and the
//! orchestration that stitches them together (`sharing/mod.rs`).
//!
//! Everything here is sync — no async, no reqwest. The async upload
//! retry/recovery layer (`upload_release_asset_recovering`,
//! `replace_release_asset_via_delete_post`) lives in `sharing/github.rs`
//! alongside the HTTP plumbing it composes.

use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use crate::error::{AppError, Result};
use crate::profiles::Profile;

type CancelCheck<'a> = Option<&'a (dyn Fn() -> bool + Send + Sync)>;

fn sharing_canceled_error() -> AppError {
    AppError::Other("Sharing canceled.".into())
}

fn check_cancel(cancel_requested: CancelCheck<'_>) -> Result<()> {
    if cancel_requested
        .map(|cancelled| cancelled())
        .unwrap_or(false)
    {
        return Err(sharing_canceled_error());
    }
    Ok(())
}

fn validate_bundle_relpath(mod_name: &str, file_rel: &str) -> Result<String> {
    let normalized = file_rel.replace('\\', "/");
    if std::path::Path::new(&normalized)
        .components()
        .any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(AppError::Other(format!(
            "Mod '{}' has unsafe declared file '{}'",
            mod_name, normalized
        )));
    }
    Ok(normalized)
}

/// Zip a mod's files into an in-memory buffer.
///
/// `files` is the list of relative paths declared in the mod's manifest
/// (or detected by the scanner). Path traversal (`..`, drive prefixes,
/// absolute roots) is refused — every entry must resolve inside
/// `mods_path` or the publish aborts. Returns the finished archive
/// bytes so the caller (`upload_release_asset`) can hand them straight
/// to reqwest without a temp file.
pub(crate) fn zip_mod_files(
    mod_name: &str,
    files: &[String],
    mods_path: &std::path::Path,
) -> Result<Vec<u8>> {
    let buf = std::io::Cursor::new(Vec::new());
    let cursor = zip_mod_files_into_writer(mod_name, files, mods_path, buf, None)?;
    Ok(cursor.into_inner())
}

#[allow(dead_code)]
pub(crate) fn zip_mod_files_to_tempfile(
    mod_name: &str,
    files: &[String],
    mods_path: &std::path::Path,
) -> Result<tempfile::NamedTempFile> {
    zip_mod_files_to_tempfile_with_cancel(mod_name, files, mods_path, None)
}

fn zip_mod_files_to_tempfile_with_cancel(
    mod_name: &str,
    files: &[String],
    mods_path: &std::path::Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<tempfile::NamedTempFile> {
    let file = tempfile::NamedTempFile::new()
        .map_err(|e| AppError::Other(format!("Create temp bundle for '{}': {}", mod_name, e)))?;
    zip_mod_files_into_writer(mod_name, files, mods_path, file, cancel_requested)
}

fn zip_mod_files_into_writer<W: Write + Seek>(
    mod_name: &str,
    files: &[String],
    mods_path: &std::path::Path,
    writer: W,
    cancel_requested: CancelCheck<'_>,
) -> Result<W> {
    let mut zip_writer = zip::ZipWriter::new(writer);
    let mut written_files = 0usize;

    // Deterministic output: pin every entry's mtime to the DOS epoch
    // (1980-01-01). With the zip crate's `time` feature on, the default is
    // the CURRENT time, which changes the archive bytes on every share —
    // so the sha256 in upload_mod_bundle_via_release never matched the
    // prior hash and re-shares re-uploaded every bundle, changed or not.
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default());

    for file_rel in files {
        check_cancel(cancel_requested)?;
        let normalized = validate_bundle_relpath(mod_name, file_rel)?;
        let file_path = mods_path.join(&normalized);

        if file_path.is_file() {
            zip_writer
                .start_file(&normalized, options)
                .map_err(|e| AppError::Other(format!("Zip error for '{}': {}", mod_name, e)))?;
            let mut file = File::open(&file_path).map_err(|e| {
                AppError::Other(format!("Read error for '{}': {}", file_path.display(), e))
            })?;
            copy_file_into_zip(&mut file, &mut zip_writer, cancel_requested)?;
            written_files += 1;
        } else if file_path.is_dir() {
            // sort_by_file_name: walk order must not depend on filesystem
            // enumeration quirks, or identical content could still zip to
            // different bytes and defeat the unchanged-bundle skip.
            for entry in WalkDir::new(&file_path)
                .sort_by_file_name()
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                check_cancel(cancel_requested)?;
                let rel = entry.path().strip_prefix(mods_path).map_err(|e| {
                    AppError::Other(format!(
                        "Could not make '{}' relative to '{}': {}",
                        entry.path().display(),
                        mods_path.display(),
                        e
                    ))
                })?;
                let entry_rel = rel.to_string_lossy().replace('\\', "/");
                zip_writer
                    .start_file(&entry_rel, options)
                    .map_err(|e| AppError::Other(format!("Zip error: {}", e)))?;
                let mut file = File::open(entry.path())
                    .map_err(|e| AppError::Other(format!("Read error: {}", e)))?;
                copy_file_into_zip(&mut file, &mut zip_writer, cancel_requested)?;
                written_files += 1;
            }
        } else {
            return Err(AppError::Other(format!(
                "Mod '{}' is missing declared file '{}'",
                mod_name, normalized
            )));
        }
    }

    if written_files == 0 {
        return Err(AppError::Other(format!(
            "Mod '{}' produced an empty bundle; no declared files were readable",
            mod_name
        )));
    }

    let cursor = zip_writer
        .finish()
        .map_err(|e| AppError::Other(format!("Zip finalize error: {}", e)))?;
    Ok(cursor)
}

fn copy_file_into_zip<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel_requested: CancelCheck<'_>,
) -> Result<()> {
    let mut buf = [0u8; 1024 * 1024];
    loop {
        check_cancel(cancel_requested)?;
        let read = reader
            .read(&mut buf)
            .map_err(|e| AppError::Other(format!("Zip read error: {}", e)))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buf[..read])
            .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
    }
    Ok(())
}

/// Hash the exact source files that would be bundled, without building
/// the zip. This lets re-share skip both compression and upload when the
/// profile already has a bundle URL/hash and the on-disk inputs are
/// byte-for-byte unchanged since the last successful publish.
#[allow(dead_code)]
pub(crate) fn fingerprint_mod_files(
    mod_name: &str,
    files: &[String],
    mods_path: &Path,
) -> Result<String> {
    fingerprint_mod_files_with_cancel(mod_name, files, mods_path, None)
}

fn fingerprint_mod_files_with_cancel(
    mod_name: &str,
    files: &[String],
    mods_path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for file_rel in files {
        check_cancel(cancel_requested)?;
        let normalized = validate_bundle_relpath(mod_name, file_rel)?;
        let file_path = mods_path.join(&normalized);
        if file_path.is_file() {
            entries.push((normalized, file_path));
        } else if file_path.is_dir() {
            for entry in WalkDir::new(&file_path)
                .sort_by_file_name()
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                check_cancel(cancel_requested)?;
                let rel = entry.path().strip_prefix(mods_path).map_err(|e| {
                    AppError::Other(format!(
                        "Could not make '{}' relative to '{}': {}",
                        entry.path().display(),
                        mods_path.display(),
                        e
                    ))
                })?;
                entries.push((
                    rel.to_string_lossy().replace('\\', "/"),
                    entry.path().to_path_buf(),
                ));
            }
        } else {
            return Err(AppError::Other(format!(
                "Mod '{}' is missing declared file '{}'",
                mod_name, normalized
            )));
        }
    }

    if entries.is_empty() {
        return Err(AppError::Other(format!(
            "Mod '{}' produced an empty bundle fingerprint; no declared files were readable",
            mod_name
        )));
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, path) in entries {
        check_cancel(cancel_requested)?;
        let mut file = File::open(&path)
            .map_err(|e| AppError::Other(format!("Read error for '{}': {}", path.display(), e)))?;
        let len = file
            .metadata()
            .map_err(|e| AppError::Other(format!("Stat error for '{}': {}", path.display(), e)))?
            .len();
        hasher.update(rel.as_bytes());
        hasher.update([0x1f]);
        hasher.update(len.to_le_bytes());
        hasher.update([0x1f]);
        let mut buf = [0u8; 1024 * 1024];
        loop {
            check_cancel(cancel_requested)?;
            let read = file.read(&mut buf).map_err(|e| {
                AppError::Other(format!("Read error for '{}': {}", path.display(), e))
            })?;
            if read == 0 {
                break;
            }
            hasher.update(&buf[..read]);
        }
        hasher.update([0x1e]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Fast fingerprint for deciding whether a previously-uploaded bundle's
/// source files changed. This intentionally hashes file identity metadata
/// (relative path, size, modified timestamp) instead of file bytes so repeat
/// shares of large packs do not reread gigabytes just to decide there is
/// nothing to zip or upload.
#[allow(dead_code)]
pub(crate) fn fingerprint_mod_file_metadata(
    mod_name: &str,
    files: &[String],
    mods_path: &Path,
) -> Result<String> {
    fingerprint_mod_file_metadata_with_cancel(mod_name, files, mods_path, None)
}

fn fingerprint_mod_file_metadata_with_cancel(
    mod_name: &str,
    files: &[String],
    mods_path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for file_rel in files {
        check_cancel(cancel_requested)?;
        let normalized = validate_bundle_relpath(mod_name, file_rel)?;
        let file_path = mods_path.join(&normalized);
        if file_path.is_file() {
            entries.push((normalized, file_path));
        } else if file_path.is_dir() {
            for entry in WalkDir::new(&file_path)
                .sort_by_file_name()
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                check_cancel(cancel_requested)?;
                let rel = entry.path().strip_prefix(mods_path).map_err(|e| {
                    AppError::Other(format!(
                        "Could not make '{}' relative to '{}': {}",
                        entry.path().display(),
                        mods_path.display(),
                        e
                    ))
                })?;
                entries.push((
                    rel.to_string_lossy().replace('\\', "/"),
                    entry.path().to_path_buf(),
                ));
            }
        } else {
            return Err(AppError::Other(format!(
                "Mod '{}' is missing declared file '{}'",
                mod_name, normalized
            )));
        }
    }

    if entries.is_empty() {
        return Err(AppError::Other(format!(
            "Mod '{}' produced an empty bundle metadata fingerprint; no declared files were readable",
            mod_name
        )));
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, path) in entries {
        check_cancel(cancel_requested)?;
        let metadata = path
            .metadata()
            .map_err(|e| AppError::Other(format!("Stat error for '{}': {}", path.display(), e)))?;
        let modified = metadata
            .modified()
            .map_err(|e| {
                AppError::Other(format!("Stat mtime error for '{}': {}", path.display(), e))
            })?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| {
                AppError::Other(format!("Invalid mtime for '{}': {}", path.display(), e))
            })?;
        hasher.update(rel.as_bytes());
        hasher.update([0x1f]);
        hasher.update(metadata.len().to_le_bytes());
        hasher.update([0x1f]);
        hasher.update(modified.as_secs().to_le_bytes());
        hasher.update([0x1f]);
        hasher.update(modified.subsec_nanos().to_le_bytes());
        hasher.update([0x1e]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Resolve a relative zip-entry name into an absolute path under
/// `mods_path`, refusing anything that escapes via `..`, an absolute
/// path, or a Windows drive prefix. Returns `None` when the entry is
/// unsafe — callers (in `mod.rs::download_bundle`) treat that as a
/// skip-this-entry signal rather than aborting the whole extraction.
pub(super) fn zip_entry_outpath(
    mods_path: &std::path::Path,
    entry_name: &str,
) -> Option<std::path::PathBuf> {
    let normalized = entry_name.replace('\\', "/");
    let rel = std::path::Path::new(&normalized);
    if normalized.trim_matches('/').is_empty()
        || rel.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return None;
    }
    Some(mods_path.join(rel))
}

/// Zip a profile mod by first trying its declared "enabled or disabled"
/// home, then falling back to the other side. The fallback covers a
/// race where the user disables a mod after the share request was
/// queued but before the bundler reaches it — without the fallback the
/// share would fail mid-stream for a state change that doesn't actually
/// change the mod's content.
pub(crate) fn zip_profile_mod_files(
    pm: &crate::profiles::ProfileMod,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
) -> Result<Vec<u8>> {
    let base = if pm.enabled { mods_path } else { disabled_path };
    match zip_mod_files(&pm.name, &pm.files, base) {
        Ok(zip) => Ok(zip),
        Err(first_err) => {
            let fallback = if pm.enabled { disabled_path } else { mods_path };
            zip_mod_files(&pm.name, &pm.files, fallback).map_err(|_| first_err)
        }
    }
}

pub(crate) fn zip_profile_mod_files_to_tempfile(
    pm: &crate::profiles::ProfileMod,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
) -> Result<tempfile::NamedTempFile> {
    zip_profile_mod_files_to_tempfile_with_cancel(pm, mods_path, disabled_path, None)
}

pub(crate) fn zip_profile_mod_files_to_tempfile_with_cancel(
    pm: &crate::profiles::ProfileMod,
    mods_path: &std::path::Path,
    disabled_path: &std::path::Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<tempfile::NamedTempFile> {
    let base = if pm.enabled { mods_path } else { disabled_path };
    match zip_mod_files_to_tempfile_with_cancel(&pm.name, &pm.files, base, cancel_requested) {
        Ok(zip) => Ok(zip),
        Err(first_err) => {
            if cancel_requested
                .map(|cancelled| cancelled())
                .unwrap_or(false)
            {
                return Err(first_err);
            }
            let fallback = if pm.enabled { disabled_path } else { mods_path };
            zip_mod_files_to_tempfile_with_cancel(&pm.name, &pm.files, fallback, cancel_requested)
                .map_err(|_| first_err)
        }
    }
}

pub(crate) fn fingerprint_profile_mod_files(
    pm: &crate::profiles::ProfileMod,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<String> {
    fingerprint_profile_mod_files_with_cancel(pm, mods_path, disabled_path, None)
}

pub(crate) fn fingerprint_profile_mod_files_with_cancel(
    pm: &crate::profiles::ProfileMod,
    mods_path: &Path,
    disabled_path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<String> {
    let base = if pm.enabled { mods_path } else { disabled_path };
    match fingerprint_mod_files_with_cancel(&pm.name, &pm.files, base, cancel_requested) {
        Ok(fingerprint) => Ok(fingerprint),
        Err(first_err) => {
            if cancel_requested
                .map(|cancelled| cancelled())
                .unwrap_or(false)
            {
                return Err(first_err);
            }
            let fallback = if pm.enabled { disabled_path } else { mods_path };
            fingerprint_mod_files_with_cancel(&pm.name, &pm.files, fallback, cancel_requested)
                .map_err(|_| first_err)
        }
    }
}

pub(crate) fn fingerprint_profile_mod_file_metadata(
    pm: &crate::profiles::ProfileMod,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<String> {
    fingerprint_profile_mod_file_metadata_with_cancel(pm, mods_path, disabled_path, None)
}

pub(crate) fn fingerprint_profile_mod_file_metadata_with_cancel(
    pm: &crate::profiles::ProfileMod,
    mods_path: &Path,
    disabled_path: &Path,
    cancel_requested: CancelCheck<'_>,
) -> Result<String> {
    let base = if pm.enabled { mods_path } else { disabled_path };
    match fingerprint_mod_file_metadata_with_cancel(&pm.name, &pm.files, base, cancel_requested) {
        Ok(fingerprint) => Ok(fingerprint),
        Err(first_err) => {
            if cancel_requested
                .map(|cancelled| cancelled())
                .unwrap_or(false)
            {
                return Err(first_err);
            }
            let fallback = if pm.enabled { disabled_path } else { mods_path };
            fingerprint_mod_file_metadata_with_cancel(
                &pm.name,
                &pm.files,
                fallback,
                cancel_requested,
            )
            .map_err(|_| first_err)
        }
    }
}

/// Final gate before a publish is allowed to finish: every mod in the
/// profile must either have a `bundle_url` (the upload succeeded) or
/// be marked as a known failure (so the curator sees it in the
/// "failed uploads" toast). If any mod is missing both, return an
/// error rather than silently shipping a manifest that friends won't
/// be able to install — the partial-share UX is genuinely confusing
/// and we'd rather block the publish than ship a broken one.
pub(super) fn ensure_profile_publish_complete(
    profile: &Profile,
    failed_uploads: &[String],
    failed_upload_reasons: &[(String, String)],
) -> Result<()> {
    let mut missing: Vec<String> = Vec::new();

    for name in failed_uploads {
        if !missing.contains(name) {
            missing.push(name.clone());
        }
    }

    for pm in &profile.mods {
        if pm.bundle_url.is_none() && !missing.contains(&pm.name) {
            missing.push(pm.name.clone());
        }
    }

    if !missing.is_empty() {
        let details: Vec<String> = failed_upload_reasons
            .iter()
            .filter(|(name, _)| missing.contains(name))
            .map(|(name, reason)| format!("{}: {}", name, compact_publish_error(reason)))
            .collect();
        let detail_suffix = if details.is_empty() {
            String::new()
        } else {
            format!(" Details: {}.", details.join(" | "))
        };
        return Err(AppError::Other(format!(
            "Could not publish profile '{}': missing bundles for {} mod(s): {}.{} Restore or reinstall these mods, then share again so the manifest can repair them later.",
            profile.name,
            missing.len(),
            missing.join(", "),
            detail_suffix
        )));
    }

    Ok(())
}

fn compact_publish_error(reason: &str) -> String {
    const MAX_CHARS: usize = 700;
    let mut text = reason
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_end_matches('.')
        .to_string();
    if text.chars().count() > MAX_CHARS {
        text = text.chars().take(MAX_CHARS).collect();
        text.push_str("...");
    }
    text
}

/// Best-effort rollback: write the prior on-disk copy of the profile
/// back to `profiles_path` after a publish fails partway through. The
/// goal is to keep the curator's local profile JSON pointing at the
/// last-known-good `bundle_url`s rather than the partial state the
/// failed publish wrote. Logs both success and failure — there's no
/// recovery path beyond "tell the user via the log" if even the
/// rollback can't be written.
pub(super) fn restore_profile_after_failed_publish(
    old_profile: Option<&Profile>,
    profiles_path: &std::path::Path,
) {
    if let Some(profile) = old_profile {
        if let Err(e) = crate::profiles::save_profile(profile, profiles_path) {
            log::error!(
                "Failed to restore previous local profile '{}' after publish failure: {}",
                profile.name,
                e
            );
        } else {
            log::info!(
                "Restored previous local profile '{}' after publish failure",
                profile.name
            );
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod publish_bundle_contract_tests {
    use super::*;
    // `zip_mod_files` is the raw bundling primitive — orchestration
    // always reaches it through `zip_profile_mod_files`, but the
    // contract tests below exercise its safety rails directly
    // (rejected unsafe paths, missing-file errors).

    fn profile_with_mod(pm: crate::profiles::ProfileMod) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: "contract".into(),
            game_version: None,
            created_by: None,
            mods: vec![pm],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn profile_mod(enabled: bool) -> crate::profiles::ProfileMod {
        crate::profiles::ProfileMod {
            mod_version_id: None,
            name: "ContractMod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["ContractMod/ContractMod.json".into()],
            folder_name: Some("ContractMod".into()),
            mod_id: Some("ContractMod".into()),
            enabled,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        }
    }

    #[test]
    fn zip_mod_files_errors_when_declared_file_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let err = zip_mod_files(
            "ContractMod",
            &["ContractMod/ContractMod.json".into()],
            tmp.path(),
        )
        .expect_err("missing profile files must fail publish instead of creating an empty bundle");

        assert!(
            err.to_string().contains("missing declared file"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn zip_mod_files_rejects_declared_paths_outside_mods_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let err = zip_mod_files("ContractMod", &["../secrets.txt".into()], tmp.path())
            .expect_err("publish must not read files outside the mods folder");

        assert!(
            err.to_string().contains("unsafe declared file"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn zip_profile_mod_files_reads_disabled_mods_from_disabled_base() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let disabled_mod = disabled_path.join("ContractMod");
        std::fs::create_dir_all(&disabled_mod).unwrap();
        std::fs::write(disabled_mod.join("ContractMod.json"), b"{}").unwrap();

        let zip_data =
            zip_profile_mod_files(&profile_mod(false), &mods_path, &disabled_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_data)).unwrap();
        assert!(
            archive.by_name("ContractMod/ContractMod.json").is_ok(),
            "disabled profile mods must be bundled from mods_disabled"
        );
    }

    #[test]
    fn fingerprint_mod_files_is_stable_for_unchanged_content() {
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("ContractMod");
        std::fs::create_dir_all(mod_dir.join("sub")).unwrap();
        std::fs::write(mod_dir.join("ContractMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("a.txt"), b"alpha").unwrap();
        std::fs::write(mod_dir.join("sub/b.txt"), b"beta").unwrap();

        let files: Vec<String> = vec!["ContractMod".into()];
        let first = fingerprint_mod_files("ContractMod", &files, tmp.path()).unwrap();
        let second = fingerprint_mod_files("ContractMod", &files, tmp.path()).unwrap();

        assert_eq!(
            first, second,
            "unchanged source files must keep the same fingerprint so re-share can skip bundling"
        );
    }

    #[test]
    fn fingerprint_mod_files_changes_when_file_content_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("ContractMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        let dll_path = mod_dir.join("ContractMod.dll");
        std::fs::write(mod_dir.join("ContractMod.json"), b"{}").unwrap();
        std::fs::write(&dll_path, b"alpha").unwrap();

        let files: Vec<String> = vec!["ContractMod".into()];
        let first = fingerprint_mod_files("ContractMod", &files, tmp.path()).unwrap();
        std::fs::write(&dll_path, b"beta").unwrap();
        let second = fingerprint_mod_files("ContractMod", &files, tmp.path()).unwrap();

        assert_ne!(
            first, second,
            "changed source bytes must force a fresh bundle on the next share"
        );
    }

    #[test]
    fn fingerprint_mod_file_metadata_is_stable_for_unchanged_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("ContractMod");
        std::fs::create_dir_all(mod_dir.join("sub")).unwrap();
        std::fs::write(mod_dir.join("ContractMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("sub/data.bin"), b"alpha").unwrap();

        let files: Vec<String> = vec!["ContractMod".into()];
        let first = fingerprint_mod_file_metadata("ContractMod", &files, tmp.path()).unwrap();
        let second = fingerprint_mod_file_metadata("ContractMod", &files, tmp.path()).unwrap();

        assert_eq!(
            first, second,
            "unchanged file metadata should let repeat re-shares skip without rereading bytes"
        );
    }

    #[test]
    fn fingerprint_mod_file_metadata_changes_when_file_size_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("ContractMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        let dll_path = mod_dir.join("ContractMod.dll");
        std::fs::write(mod_dir.join("ContractMod.json"), b"{}").unwrap();
        std::fs::write(&dll_path, b"alpha").unwrap();

        let files: Vec<String> = vec!["ContractMod".into()];
        let first = fingerprint_mod_file_metadata("ContractMod", &files, tmp.path()).unwrap();
        std::fs::write(&dll_path, b"alpha plus more bytes").unwrap();
        let second = fingerprint_mod_file_metadata("ContractMod", &files, tmp.path()).unwrap();

        assert_ne!(
            first, second,
            "size changes must force the next share back onto the zip/upload path"
        );
    }

    #[test]
    fn fingerprint_profile_mod_files_reads_disabled_mods_from_disabled_base() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let disabled_mod = disabled_path.join("ContractMod");
        std::fs::create_dir_all(&disabled_mod).unwrap();
        std::fs::write(disabled_mod.join("ContractMod.json"), b"{}").unwrap();

        let fingerprint =
            fingerprint_profile_mod_files(&profile_mod(false), &mods_path, &disabled_path)
                .expect("disabled profile mods must fingerprint from mods_disabled");

        assert!(
            !fingerprint.is_empty(),
            "fingerprint helper must support the same enabled/disabled fallback as bundling"
        );
    }

    #[test]
    fn fingerprint_profile_mod_file_metadata_reads_disabled_mods_from_disabled_base() {
        let tmp = tempfile::tempdir().unwrap();
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        let disabled_mod = disabled_path.join("ContractMod");
        std::fs::create_dir_all(&disabled_mod).unwrap();
        std::fs::write(disabled_mod.join("ContractMod.json"), b"{}").unwrap();

        let fingerprint =
            fingerprint_profile_mod_file_metadata(&profile_mod(false), &mods_path, &disabled_path)
                .expect("disabled profile mods must fingerprint metadata from mods_disabled");

        assert!(
            !fingerprint.is_empty(),
            "metadata fingerprint helper must support the same enabled/disabled fallback as bundling"
        );
    }

    #[test]
    fn zip_mod_files_is_deterministic_for_unchanged_content() {
        // The re-share diff-upload depends on this: identical mod content
        // must zip to identical bytes (same sha256), or every re-share
        // re-uploads every bundle. Two things can break it — wall-clock
        // entry mtimes (the zip crate's default with the `time` feature)
        // and filesystem-dependent walk order.
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("ContractMod");
        std::fs::create_dir_all(mod_dir.join("sub")).unwrap();
        std::fs::write(mod_dir.join("ContractMod.json"), b"{}").unwrap();
        std::fs::write(mod_dir.join("a.txt"), b"alpha").unwrap();
        std::fs::write(mod_dir.join("sub/b.txt"), b"beta").unwrap();

        let files: Vec<String> = vec!["ContractMod".into()];
        let first = zip_mod_files("ContractMod", &files, tmp.path()).unwrap();
        // Sleep past the 2-second DOS-time resolution so a regression to
        // wall-clock mtimes can't accidentally pass within the same tick.
        std::thread::sleep(std::time::Duration::from_millis(2100));
        let second = zip_mod_files("ContractMod", &files, tmp.path()).unwrap();

        assert_eq!(
            first, second,
            "unchanged content must produce byte-identical bundles"
        );

        // And the entries carry the fixed DOS epoch, not the build time.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(first)).unwrap();
        let entry = archive.by_name("ContractMod/a.txt").unwrap();
        let mtime = entry.last_modified().expect("zip entry has an mtime");
        assert_eq!(
            (mtime.year(), mtime.month(), mtime.day()),
            (1980, 1, 1),
            "entry mtimes must be pinned to the DOS epoch for determinism"
        );
    }

    #[test]
    fn zip_mod_files_streams_large_files_without_losing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("LargeArtMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("LargeArtMod.json"), b"{}").unwrap();
        let large_payload: Vec<u8> = (0..(4 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        std::fs::write(mod_dir.join("art.pck"), &large_payload).unwrap();

        let zip_data = zip_mod_files("LargeArtMod", &["LargeArtMod".into()], tmp.path())
            .expect("large bundle should zip successfully");

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_data)).unwrap();
        let mut entry = archive.by_name("LargeArtMod/art.pck").unwrap();
        let mut roundtripped = Vec::new();
        std::io::copy(&mut entry, &mut roundtripped).unwrap();

        assert_eq!(
            roundtripped, large_payload,
            "streamed bundle entry must preserve large file bytes exactly"
        );
    }

    #[test]
    fn zip_mod_files_to_tempfile_with_cancel_stops_during_large_file_copy() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let tmp = tempfile::tempdir().unwrap();
        let mod_dir = tmp.path().join("LargeArtMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("LargeArtMod.json"), b"{}").unwrap();
        let large_payload: Vec<u8> = (0..(8 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        std::fs::write(mod_dir.join("art.pck"), &large_payload).unwrap();

        let calls = AtomicUsize::new(0);
        let cancel = || calls.fetch_add(1, Ordering::SeqCst) > 1;

        let err = zip_mod_files_to_tempfile_with_cancel(
            "LargeArtMod",
            &["LargeArtMod".into()],
            tmp.path(),
            Some(&cancel),
        )
        .expect_err("cancel should interrupt large bundle compression");

        assert!(
            err.to_string().contains("Sharing canceled"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn publish_completion_rejects_any_mod_without_bundle_url() {
        let profile = profile_with_mod(profile_mod(true));
        let err = ensure_profile_publish_complete(&profile, &[], &[])
            .expect_err("publishing a partially restorable manifest must be blocked");

        assert!(
            err.to_string().contains("missing bundles"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn publish_completion_includes_failed_upload_reason_when_known() {
        let profile = profile_with_mod(profile_mod(true));
        let err = ensure_profile_publish_complete(
            &profile,
            &["Test Mod".to_string()],
            &[(
                "Test Mod".to_string(),
                "Upload of 'Test_Mod_v1.0.0_abc.zip' failed with 422 already_exists.".to_string(),
            )],
        )
        .expect_err("known upload failures should block with details");

        let msg = err.to_string();
        assert!(msg.contains("Details: Test Mod: Upload of"));
        assert!(msg.contains("already_exists"));
    }

    #[test]
    fn share_owner_replaces_app_default_attribution() {
        let mut profile = profile_with_mod(profile_mod(true));
        profile.created_by = Some("sts2-mod-manager".into());

        let attributed = super::super::attribute_profile_to_owner(profile, "alice");

        assert_eq!(attributed.created_by.as_deref(), Some("alice"));
    }
}
