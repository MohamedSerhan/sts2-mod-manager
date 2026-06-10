//! Asset-bundling helpers: zip a mod's declared files into an in-memory
//! buffer for release-asset upload, validate that every mod in the
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

use std::io::Write;
use std::path::Component;
use walkdir::WalkDir;

use crate::error::{AppError, Result};
use crate::profiles::Profile;

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
    let mut zip_writer = zip::ZipWriter::new(buf);
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
        let file_path = mods_path.join(&normalized);

        if file_path.is_file() {
            zip_writer
                .start_file(&normalized, options)
                .map_err(|e| AppError::Other(format!("Zip error for '{}': {}", mod_name, e)))?;
            let data = std::fs::read(&file_path).map_err(|e| {
                AppError::Other(format!("Read error for '{}': {}", file_path.display(), e))
            })?;
            zip_writer
                .write_all(&data)
                .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
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
                let data = std::fs::read(entry.path())
                    .map_err(|e| AppError::Other(format!("Read error: {}", e)))?;
                zip_writer
                    .write_all(&data)
                    .map_err(|e| AppError::Other(format!("Zip write error: {}", e)))?;
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
    Ok(cursor.into_inner())
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
        return Err(AppError::Other(format!(
            "Could not publish profile '{}': missing bundles for {} mod(s): {}. Restore or reinstall these mods, then share again so the manifest can repair them later.",
            profile.name,
            missing.len(),
            missing.join(", ")
        )));
    }

    Ok(())
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
    fn publish_completion_rejects_any_mod_without_bundle_url() {
        let profile = profile_with_mod(profile_mod(true));
        let err = ensure_profile_publish_complete(&profile, &[])
            .expect_err("publishing a partially restorable manifest must be blocked");

        assert!(
            err.to_string().contains("missing bundles"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn share_owner_replaces_app_default_attribution() {
        let mut profile = profile_with_mod(profile_mod(true));
        profile.created_by = Some("sts2-mod-manager".into());

        let attributed = super::super::attribute_profile_to_owner(profile, "alice");

        assert_eq!(attributed.created_by.as_deref(), Some("alice"));
    }
}
