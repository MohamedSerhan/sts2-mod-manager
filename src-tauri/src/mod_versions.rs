use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};
use crate::mods::ModInfo;
use crate::profiles::ProfileMod;

const DB_FILE: &str = "mod_versions.json";
const CACHE_DIR: &str = "mod_versions";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModVersionRecord {
    pub id: String,
    pub identity_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_relpath: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModVersionsDb {
    #[serde(default)]
    pub records: HashMap<String, ModVersionRecord>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub aliases: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub conflicts: HashMap<String, Vec<String>>,
}

fn db_path(config_path: &Path) -> PathBuf {
    config_path.join(DB_FILE)
}

pub fn cache_relpath_for_id(id: &str) -> String {
    format!("{}/{}.zip", CACHE_DIR, id)
}

pub fn cache_path_for_id(cache_path: &Path, id: &str) -> PathBuf {
    cache_path.join(CACHE_DIR).join(format!("{}.zip", id))
}

fn normalize_part(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches('v').to_lowercase())
}

pub fn artifact_identity_key(
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
    version: &str,
    content_hash: Option<&str>,
    source: Option<&str>,
) -> String {
    let identity = normalize_part(mod_id)
        .map(|v| format!("mod_id:{v}"))
        .or_else(|| normalize_part(folder_name).map(|v| format!("folder:{v}")))
        .unwrap_or_else(|| format!("name:{}", name.trim().to_lowercase()));
    let version = normalize_part(Some(version)).unwrap_or_else(|| "unknown".into());
    let content = normalize_part(content_hash)
        .or_else(|| normalize_part(source))
        .unwrap_or_else(|| "unknown".into());
    format!("{identity}|version:{version}|content:{content}")
}

fn key_for_mod(info: &ModInfo) -> String {
    artifact_identity_key(
        &info.name,
        info.folder_name.as_deref(),
        info.mod_id.as_deref(),
        &info.version,
        info.hash.as_deref(),
        info.source
            .as_deref()
            .or(info.github_url.as_deref())
            .or(info.nexus_url.as_deref()),
    )
}

fn key_for_profile_mod(pm: &ProfileMod) -> String {
    artifact_identity_key(
        &pm.name,
        pm.folder_name.as_deref(),
        pm.mod_id.as_deref(),
        &pm.version,
        pm.hash.as_deref().or(pm.bundle_sha256.as_deref()),
        pm.source.as_deref().or(pm.bundle_url.as_deref()),
    )
}

pub fn load(config_path: &Path) -> ModVersionsDb {
    let path = db_path(config_path);
    if !path.exists() {
        return ModVersionsDb::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(db) => db,
            Err(e) => {
                if !content.trim().is_empty() {
                    log::error!(
                        "Failed to parse mod version registry at {}: {}",
                        path.display(),
                        e
                    );
                }
                ModVersionsDb::default()
            }
        },
        Err(e) => {
            log::warn!(
                "Failed to read mod version registry {}: {}",
                path.display(),
                e
            );
            ModVersionsDb::default()
        }
    }
}

pub fn save(db: &ModVersionsDb, config_path: &Path) -> Result<()> {
    let path = db_path(config_path);
    let json = serde_json::to_vec_pretty(db)?;
    crate::fs_safety::atomic_write(&path, &json)?;
    Ok(())
}

fn resolve_alias<'a>(db: &'a ModVersionsDb, id: &'a str) -> &'a str {
    db.aliases.get(id).map(String::as_str).unwrap_or(id)
}

fn record_has_canonical_alias(db: &ModVersionsDb, record_id: &str, alias: &str) -> bool {
    db.records
        .get(record_id)
        .is_some_and(|record| record.aliases.iter().any(|existing| existing == alias))
        && db
            .aliases
            .get(alias)
            .is_some_and(|target| resolve_alias(db, target) == record_id)
}

pub fn ids_equivalent(config_path: &Path, a: &str, b: &str) -> bool {
    let a = a.trim();
    let b = b.trim();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let db = load(config_path);
    let resolved_a = resolve_alias(&db, a);
    let resolved_b = resolve_alias(&db, b);
    if resolved_a == resolved_b {
        return true;
    }
    record_has_canonical_alias(&db, resolved_a, b) || record_has_canonical_alias(&db, resolved_b, a)
}

fn record_by_identity<'a>(
    db: &'a ModVersionsDb,
    identity_key: &str,
) -> Option<&'a ModVersionRecord> {
    db.records
        .values()
        .find(|record| record.identity_key == identity_key)
}

fn upsert_record_for_mod(
    db: &mut ModVersionsDb,
    info: &ModInfo,
    requested_id: Option<&str>,
) -> (String, bool) {
    let identity_key = key_for_mod(info);
    let requested_existing_id = requested_id
        .map(|id| resolve_alias(db, id).to_string())
        .filter(|id| db.records.contains_key(id))
        .filter(|id| {
            db.records
                .get(id)
                .is_some_and(|record| record.identity_key == identity_key)
        });
    let existing_id = requested_existing_id
        .or_else(|| record_by_identity(db, &identity_key).map(|record| record.id.clone()));

    let id = existing_id.unwrap_or_else(|| {
        requested_id
            .filter(|id| !id.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    });

    let mut changed = false;
    let record = db.records.entry(id.clone()).or_insert_with(|| {
        changed = true;
        ModVersionRecord {
            id: id.clone(),
            identity_key: identity_key.clone(),
            aliases: Vec::new(),
            name: info.name.clone(),
            version: info.version.clone(),
            folder_name: info.folder_name.clone(),
            mod_id: info.mod_id.clone(),
            source: info
                .source
                .clone()
                .or_else(|| info.github_url.clone())
                .or_else(|| info.nexus_url.clone()),
            content_hash: info.hash.clone(),
            archive_sha256: None,
            cache_relpath: Some(cache_relpath_for_id(&id)),
        }
    });

    if record.identity_key != identity_key {
        record.identity_key = identity_key;
        changed = true;
    }
    if record.name != info.name {
        record.name = info.name.clone();
        changed = true;
    }
    if record.version != info.version {
        record.version = info.version.clone();
        changed = true;
    }
    if record.folder_name != info.folder_name {
        record.folder_name = info.folder_name.clone();
        changed = true;
    }
    if record.mod_id != info.mod_id {
        record.mod_id = info.mod_id.clone();
        changed = true;
    }
    if record.content_hash.is_none() && info.hash.is_some() {
        record.content_hash = info.hash.clone();
        changed = true;
    }
    if record.cache_relpath.is_none() {
        record.cache_relpath = Some(cache_relpath_for_id(&id));
        changed = true;
    }

    if let Some(alias) = requested_id.filter(|alias| *alias != id) {
        if !record.aliases.iter().any(|existing| existing == alias) {
            record.aliases.push(alias.to_string());
            changed = true;
        }
        if db.aliases.insert(alias.to_string(), id.clone()) != Some(id.clone()) {
            changed = true;
        }
    }

    (id, changed)
}

pub fn ensure_mod_info_id(info: &mut ModInfo, config_path: &Path) -> Option<String> {
    let mut db = load(config_path);
    let (id, changed) = upsert_record_for_mod(&mut db, info, info.mod_version_id.as_deref());
    info.mod_version_id = Some(id.clone());
    if changed {
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }
    Some(id)
}

pub fn enrich_mods_with_versions(mods: &mut [ModInfo], config_path: &Path) {
    let mut db = load(config_path);
    let mut changed = false;
    for info in mods.iter_mut() {
        let (id, did_change) = upsert_record_for_mod(&mut db, info, info.mod_version_id.as_deref());
        info.mod_version_id = Some(id);
        changed |= did_change;
    }
    if changed {
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }
}

pub fn ensure_profile_mod_id(pm: &mut ProfileMod, config_path: &Path) -> Option<String> {
    if pm.mod_version_id.is_some() {
        return pm.mod_version_id.clone();
    }
    let key = key_for_profile_mod(pm);
    let mut db = load(config_path);
    let existing = record_by_identity(&db, &key).map(|record| record.id.clone());
    let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if !db.records.contains_key(&id) {
        db.records.insert(
            id.clone(),
            ModVersionRecord {
                id: id.clone(),
                identity_key: key,
                aliases: Vec::new(),
                name: pm.name.clone(),
                version: pm.version.clone(),
                folder_name: pm.folder_name.clone(),
                mod_id: pm.mod_id.clone(),
                source: pm.source.clone().or_else(|| pm.bundle_url.clone()),
                content_hash: pm.hash.clone().or_else(|| pm.bundle_sha256.clone()),
                archive_sha256: pm.bundle_sha256.clone(),
                cache_relpath: Some(cache_relpath_for_id(&id)),
            },
        );
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }
    pm.mod_version_id = Some(id.clone());
    Some(id)
}

pub fn alias_shared_id(
    shared_id: &str,
    installed: &mut ModInfo,
    config_path: &Path,
) -> Option<String> {
    let mut db = load(config_path);
    let (local_id, mut changed) = upsert_record_for_mod(&mut db, installed, None);
    if shared_id != local_id {
        if let Some(record) = db.records.get_mut(&local_id) {
            if !record.aliases.iter().any(|existing| existing == shared_id) {
                record.aliases.push(shared_id.to_string());
                changed = true;
            }
        }
        match db.aliases.get(shared_id) {
            Some(existing) if existing != &local_id => {
                let conflicts = db.conflicts.entry(shared_id.to_string()).or_default();
                if !conflicts.iter().any(|id| id == &local_id) {
                    conflicts.push(local_id.clone());
                    changed = true;
                }
            }
            _ => {
                if db.aliases.insert(shared_id.to_string(), local_id.clone())
                    != Some(local_id.clone())
                {
                    changed = true;
                }
            }
        }
    }
    installed.mod_version_id = Some(local_id.clone());
    if changed {
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }
    Some(local_id)
}

pub fn record_for_profile_mod(pm: &ProfileMod, config_path: &Path) -> Option<ModVersionRecord> {
    let db = load(config_path);
    let identity_key = key_for_profile_mod(pm);
    pm.mod_version_id
        .as_deref()
        .and_then(|id| db.records.get(resolve_alias(&db, id)).cloned())
        .filter(|record| record.identity_key == identity_key)
        .or_else(|| record_by_identity(&db, &identity_key).cloned())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let read = std::io::Read::read(&mut file, &mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn cache_mod_version_by_id(
    mod_info: &mut ModInfo,
    base_path: &Path,
    cache_path: &Path,
    config_path: &Path,
) -> Option<PathBuf> {
    let id = ensure_mod_info_id(mod_info, config_path)?;
    let dest = cache_path_for_id(cache_path, &id);
    if dest.exists() {
        return Some(dest);
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = match fs::File::create(&dest) {
        Ok(file) => file,
        Err(e) => {
            log::warn!(
                "Failed to create version cache for '{}': {}",
                mod_info.name,
                e
            );
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
                let _ = zip_writer.write_all(&data);
            }
        } else if file_path.is_dir() {
            for entry in walkdir::WalkDir::new(&file_path).into_iter().flatten() {
                if !entry.file_type().is_file() {
                    continue;
                }
                let Ok(rel) = entry.path().strip_prefix(base_path) else {
                    continue;
                };
                let rel = rel.to_string_lossy().replace('\\', "/");
                if zip_writer.start_file(&rel, options).is_err() {
                    continue;
                }
                if let Ok(data) = fs::read(entry.path()) {
                    let _ = zip_writer.write_all(&data);
                }
            }
        }
    }

    if let Err(e) = zip_writer.finish() {
        log::warn!(
            "Failed to finalize version cache for '{}': {}",
            mod_info.name,
            e
        );
        let _ = fs::remove_file(&dest);
        return None;
    }

    let archive_sha256 = sha256_file(&dest).ok();
    let mut db = load(config_path);
    if let Some(record) = db.records.get_mut(&id) {
        record.archive_sha256 = archive_sha256;
        record.cache_relpath = Some(cache_relpath_for_id(&id));
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }

    Some(dest)
}

pub fn get_cached_mod_path_for_profile_mod(
    cache_path: &Path,
    config_path: &Path,
    pm: &ProfileMod,
) -> Option<PathBuf> {
    let record = record_for_profile_mod(pm, config_path)?;
    let path = record
        .cache_relpath
        .as_deref()
        .map(|rel| cache_path.join(rel))
        .unwrap_or_else(|| cache_path_for_id(cache_path, &record.id));
    path.exists().then_some(path)
}

pub fn restore_mod_from_cache_by_id(
    cache_path: &Path,
    config_path: &Path,
    pm: &ProfileMod,
    mods_path: &Path,
) -> Result<()> {
    let zip_path =
        get_cached_mod_path_for_profile_mod(cache_path, config_path, pm).ok_or_else(|| {
            AppError::Other(format!(
                "No cached version for '{}' v{}",
                pm.name, pm.version
            ))
        })?;

    let file = fs::File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Invalid cache zip for '{}': {}", pm.name, e)))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mod_info(name: &str, version: &str, hash: Option<&str>) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: name.into(),
            version: version.into(),
            description: String::new(),
            enabled: true,
            files: vec!["Mod/manifest.json".into()],
            source: Some("github:owner/repo".into()),
            hash: hash.map(str::to_string),
            dependencies: Vec::new(),
            size_bytes: 0,
            folder_name: Some("Mod".into()),
            mod_id: Some("mod-id".into()),
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
        }
    }

    #[test]
    fn same_version_and_hash_reuses_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = mod_info("Test", "1.0.0", Some("abc"));
        let mut second = mod_info("Test", "1.0.0", Some("abc"));
        let first_id = ensure_mod_info_id(&mut first, dir.path()).unwrap();
        let second_id = ensure_mod_info_id(&mut second, dir.path()).unwrap();
        assert_eq!(first_id, second_id);
    }

    #[test]
    fn same_version_different_hash_gets_distinct_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = mod_info("Test", "1.0.0", Some("abc"));
        let mut second = mod_info("Test", "1.0.0", Some("def"));
        let first_id = ensure_mod_info_id(&mut first, dir.path()).unwrap();
        let second_id = ensure_mod_info_id(&mut second, dir.path()).unwrap();
        assert_ne!(first_id, second_id);
    }

    #[test]
    fn shared_id_aliases_identical_local_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut info = mod_info("Test", "1.0.0", Some("abc"));
        let local = ensure_mod_info_id(&mut info, dir.path()).unwrap();
        let aliased = alias_shared_id("shared-id", &mut info, dir.path()).unwrap();
        assert_eq!(local, aliased);
        let db = load(dir.path());
        assert_eq!(db.aliases.get("shared-id"), Some(&local));
    }

    #[test]
    fn conflicting_shared_id_keeps_separate_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = mod_info("Test", "1.0.0", Some("abc"));
        let first_id = alias_shared_id("shared-id", &mut first, dir.path()).unwrap();
        let mut second = mod_info("Test", "1.0.0", Some("def"));
        let second_id = alias_shared_id("shared-id", &mut second, dir.path()).unwrap();

        assert_ne!(first_id, second_id);
        let db = load(dir.path());
        assert_eq!(db.aliases.get("shared-id"), Some(&first_id));
        assert!(db
            .conflicts
            .get("shared-id")
            .is_some_and(|ids| ids.contains(&second_id)));
        let shared_id = "shared-id".to_string();
        assert!(db.records[&first_id].aliases.contains(&shared_id));
        assert!(db.records[&second_id].aliases.contains(&shared_id));
        assert!(
            !ids_equivalent(dir.path(), "shared-id", &second_id),
            "ambiguous aliases must not globally match every conflicting artifact"
        );

        let pm = ProfileMod {
            mod_version_id: Some("shared-id".into()),
            name: "Test".into(),
            version: "1.0.0".into(),
            source: Some("github:owner/repo".into()),
            hash: Some("def".into()),
            files: vec!["Mod/manifest.json".into()],
            folder_name: Some("Mod".into()),
            mod_id: Some("mod-id".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        };
        assert_eq!(
            record_for_profile_mod(&pm, dir.path()).map(|record| record.id),
            Some(second_id)
        );
    }

    #[test]
    fn cache_restore_uses_artifact_id() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let restore = tempfile::tempdir().unwrap();
        let mod_dir = base.path().join("Mod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(mod_dir.join("manifest.json"), br#"{"Name":"Test"}"#).unwrap();

        let mut info = mod_info("Test", "1.0.0", Some("abc"));
        let id = ensure_mod_info_id(&mut info, config.path()).unwrap();
        let cached = cache_mod_version_by_id(&mut info, base.path(), cache.path(), config.path());
        assert!(cached.as_ref().is_some_and(|path| path.exists()));

        let pm = ProfileMod {
            mod_version_id: Some(id),
            name: "Test".into(),
            version: "1.0.0".into(),
            source: None,
            hash: Some("abc".into()),
            files: vec!["Mod/manifest.json".into()],
            folder_name: Some("Mod".into()),
            mod_id: Some("mod-id".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        };

        restore_mod_from_cache_by_id(cache.path(), config.path(), &pm, restore.path()).unwrap();
        assert_eq!(
            fs::read_to_string(restore.path().join("Mod/manifest.json")).unwrap(),
            r#"{"Name":"Test"}"#
        );
    }
}
