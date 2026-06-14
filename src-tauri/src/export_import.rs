use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;
use zip::write::SimpleFileOptions;

use crate::error::{AppError, Result};
use crate::mods::install_mod_from_zip;
use crate::profiles::{load_profile, new_profile_id, save_profile, unique_profile_name, Profile};
use crate::sharing::zip_profile_mod_files;

const PROFILE_ENTRY: &str = "profile.json";

fn safe_archive_segment(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "mod".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn export_profile_to_sts2pack_from_paths(
    name: &str,
    output_path: &Path,
    profiles_path: &Path,
    mods_path: &Path,
    disabled_path: &Path,
) -> Result<()> {
    let profile = load_profile(name, profiles_path)?;
    let parent = output_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let file = fs::File::create(output_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file(PROFILE_ENTRY, options)?;
    zip.write_all(serde_json::to_string_pretty(&profile)?.as_bytes())?;

    for (index, pm) in profile.mods.iter().enumerate() {
        let bytes = zip_profile_mod_files(pm, mods_path, disabled_path)?;
        let entry = format!(
            "mods/{:04}-{}.zip",
            index + 1,
            safe_archive_segment(pm.folder_name.as_deref().unwrap_or(&pm.name))
        );
        zip.start_file(entry, options)?;
        zip.write_all(&bytes)?;
    }

    zip.finish()?;
    Ok(())
}

pub fn import_sts2pack_from_paths(
    input_path: &Path,
    profiles_path: &Path,
    mods_path: &Path,
) -> Result<Profile> {
    fs::create_dir_all(profiles_path)?;
    fs::create_dir_all(mods_path)?;

    let file = fs::File::open(input_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut profile_json = String::new();
    archive
        .by_name(PROFILE_ENTRY)
        .map_err(|_| AppError::InvalidProfile("Missing profile.json in .sts2pack".to_string()))?
        .read_to_string(&mut profile_json)?;
    let mut profile: Profile = serde_json::from_str(&profile_json)
        .map_err(|e| AppError::InvalidProfile(format!("Invalid profile.json: {}", e)))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().replace('\\', "/");
        if !name.starts_with("mods/") || !name.ends_with(".zip") || name.contains("..") {
            continue;
        }
        let mut tmp = NamedTempFile::new()?;
        std::io::copy(&mut entry, &mut tmp)?;
        tmp.as_file_mut().flush()?;
        install_mod_from_zip(tmp.path(), mods_path)?;
    }

    profile.id = new_profile_id();
    profile.name = unique_profile_name(&profile.name, profiles_path);
    save_profile(&profile, profiles_path)?;
    Ok(profile)
}

#[tauri::command]
pub fn export_profile_to_file(
    name: String,
    path: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> std::result::Result<(), String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let disabled_path = s
        .disabled_mods_path
        .as_ref()
        .ok_or("Game path not set")?
        .clone();
    let profiles_path = s.profiles_path.clone();
    drop(s);
    export_profile_to_sts2pack_from_paths(
        &name,
        &PathBuf::from(path),
        &profiles_path,
        &mods_path,
        &disabled_path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_sts2pack(
    path: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> std::result::Result<Profile, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mods_path = s.mods_path.as_ref().ok_or("Game path not set")?.clone();
    let profiles_path = s.profiles_path.clone();
    drop(s);
    import_sts2pack_from_paths(&PathBuf::from(path), &profiles_path, &mods_path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Read;
    use std::path::Path;

    use chrono::Utc;
    use tempfile::TempDir;

    use crate::export_import::{export_profile_to_sts2pack_from_paths, import_sts2pack_from_paths};
    use crate::profiles::{load_profile, save_profile, Profile, ProfileMod};

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn profile(name: &str) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.to_string(),
            game_version: Some("0.105.0".to_string()),
            created_by: Some("tester".to_string()),
            mods: vec![ProfileMod {
                name: "BaseMod".to_string(),
                version: "1.0.0".to_string(),
                source: None,
                hash: None,
                files: vec![
                    "BaseMod/manifest.json".to_string(),
                    "BaseMod/BaseMod.dll".to_string(),
                ],
                folder_name: Some("BaseMod".to_string()),
                mod_id: Some("base_mod".to_string()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: Vec::new(),
            }],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn profile_with_id(name: &str, id: &str) -> Profile {
        let mut profile = profile(name);
        profile.id = id.to_string();
        profile
    }

    fn seed_mod(mods_path: &Path) {
        write(
            &mods_path.join("BaseMod/manifest.json"),
            r#"{ "name": "BaseMod", "version": "1.0.0", "id": "base_mod" }"#,
        );
        write(&mods_path.join("BaseMod/BaseMod.dll"), "fake dll");
    }

    #[test]
    fn export_writes_profile_json_and_mod_bundles() {
        let tmp = TempDir::new().unwrap();
        let profiles_path = tmp.path().join("profiles");
        let mods_path = tmp.path().join("mods");
        let disabled_path = tmp.path().join("mods_disabled");
        fs::create_dir_all(&disabled_path).unwrap();
        seed_mod(&mods_path);
        save_profile(&profile("Daily Pack"), &profiles_path).unwrap();

        let out = tmp.path().join("Daily Pack.sts2pack");
        export_profile_to_sts2pack_from_paths(
            "Daily Pack",
            &out,
            &profiles_path,
            &mods_path,
            &disabled_path,
        )
        .unwrap();

        let file = fs::File::open(out).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        archive.by_name("profile.json").unwrap();
        let mut mod_zip = archive.by_name("mods/0001-BaseMod.zip").unwrap();
        let mut bytes = Vec::new();
        mod_zip.read_to_end(&mut bytes).unwrap();
        drop(mod_zip);

        let mut bundled = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        bundled.by_name("BaseMod/manifest.json").unwrap();
        bundled.by_name("BaseMod/BaseMod.dll").unwrap();
    }

    #[test]
    fn import_installs_mods_suffixes_profile_collisions_and_skips_share_state() {
        let source = TempDir::new().unwrap();
        let source_profiles = source.path().join("profiles");
        let source_mods = source.path().join("mods");
        let source_disabled = source.path().join("mods_disabled");
        fs::create_dir_all(&source_disabled).unwrap();
        seed_mod(&source_mods);
        save_profile(&profile("Daily Pack"), &source_profiles).unwrap();
        let pack = source.path().join("Daily Pack.sts2pack");
        export_profile_to_sts2pack_from_paths(
            "Daily Pack",
            &pack,
            &source_profiles,
            &source_mods,
            &source_disabled,
        )
        .unwrap();

        let dest = TempDir::new().unwrap();
        let dest_profiles = dest.path().join("profiles");
        let dest_mods = dest.path().join("mods");
        save_profile(&profile("Daily Pack"), &dest_profiles).unwrap();
        fs::write(dest_profiles.join("Daily Pack.share"), "{}").unwrap();

        let imported = import_sts2pack_from_paths(&pack, &dest_profiles, &dest_mods).unwrap();

        assert_eq!(imported.name, "Daily Pack (2)");
        assert!(dest_mods.join("BaseMod/manifest.json").exists());
        assert!(dest_mods.join("BaseMod/BaseMod.dll").exists());
        let saved = load_profile("Daily Pack (2)", &dest_profiles).unwrap();
        assert_eq!(saved.mods.len(), 1);
        assert_eq!(saved.mods[0].name, "BaseMod");
        assert!(!dest_profiles.join("Daily Pack (2).share").exists());
        assert!(!dest.path().join("subscriptions.json").exists());
    }

    #[test]
    fn import_assigns_local_id_instead_of_reusing_exported_id() {
        let profile_id = "profile-sharedtester";
        let source = TempDir::new().unwrap();
        let source_profiles = source.path().join("profiles");
        let source_mods = source.path().join("mods");
        let source_disabled = source.path().join("mods_disabled");
        fs::create_dir_all(&source_disabled).unwrap();
        seed_mod(&source_mods);
        let mut remote_profile = profile_with_id("SharedTester", profile_id);
        remote_profile.created_by = Some("remote-author".to_string());
        save_profile(&remote_profile, &source_profiles).unwrap();
        let pack = source.path().join("SharedTester.sts2pack");
        export_profile_to_sts2pack_from_paths(
            "SharedTester",
            &pack,
            &source_profiles,
            &source_mods,
            &source_disabled,
        )
        .unwrap();

        let dest = TempDir::new().unwrap();
        let dest_profiles = dest.path().join("profiles");
        let dest_mods = dest.path().join("mods");
        let mut local_profile = profile_with_id("TesterW", profile_id);
        local_profile.created_by = Some("local-user".to_string());
        save_profile(&local_profile, &dest_profiles).unwrap();

        let imported = import_sts2pack_from_paths(&pack, &dest_profiles, &dest_mods).unwrap();

        assert_ne!(imported.id, profile_id);
        assert_eq!(imported.name, "SharedTester");
        assert_eq!(imported.created_by.as_deref(), Some("remote-author"));
        assert!(dest_mods.join("BaseMod/manifest.json").exists());
        let existing = load_profile(profile_id, &dest_profiles).unwrap();
        assert_eq!(existing.name, "TesterW");
        let saved_import = load_profile(&imported.id, &dest_profiles).unwrap();
        assert_eq!(saved_import.name, "SharedTester");
    }
}
