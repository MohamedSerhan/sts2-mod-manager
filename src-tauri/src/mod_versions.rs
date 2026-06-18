use std::collections::{HashMap, HashSet};
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
    pub source_version: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct LocalModVersionOption {
    pub mod_version_id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub installed: bool,
    pub installed_enabled: bool,
    pub cached: bool,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_by_profiles: Vec<String>,
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
        .map(|value| value.trim_start_matches(['v', 'V']).to_lowercase())
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

fn source_for_mod(info: &ModInfo) -> Option<String> {
    info.source
        .clone()
        .or_else(|| info.github_url.clone())
        .or_else(|| info.nexus_url.clone())
}

fn key_for_mod_with_version(info: &ModInfo, version: &str) -> String {
    let source = source_for_mod(info);
    artifact_identity_key(
        &info.name,
        info.folder_name.as_deref(),
        info.mod_id.as_deref(),
        version,
        info.hash.as_deref(),
        source.as_deref(),
    )
}

fn normalize_family_part(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
}

fn family_key(name: &str, mod_id: Option<&str>, source: Option<&str>) -> String {
    normalize_family_part(mod_id)
        .map(|id| format!("mod_id:{id}"))
        .or_else(|| {
            normalize_family_part(source)
                .map(|source| format!("source:{source}|name:{}", name.trim().to_lowercase()))
        })
        .unwrap_or_else(|| format!("name:{}", name.trim().to_lowercase()))
}

fn family_key_for_mod(info: &ModInfo) -> String {
    family_key(
        &info.name,
        info.mod_id.as_deref(),
        info.source
            .as_deref()
            .or(info.github_url.as_deref())
            .or(info.nexus_url.as_deref()),
    )
}

fn family_key_for_record(record: &ModVersionRecord) -> String {
    family_key(
        &record.name,
        record.mod_id.as_deref(),
        record.source.as_deref(),
    )
}

fn target_family_key(
    db: &ModVersionsDb,
    name: &str,
    mod_version_id: Option<&str>,
    mod_id: Option<&str>,
) -> String {
    mod_version_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(|id| db.records.get(resolve_alias(db, id)))
        .map(family_key_for_record)
        .unwrap_or_else(|| family_key(name, mod_id, None))
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
    upsert_record_for_mod_with_source_version(db, info, requested_id, None)
}

fn upsert_record_for_mod_with_source_version(
    db: &mut ModVersionsDb,
    info: &ModInfo,
    requested_id: Option<&str>,
    source_version: Option<&str>,
) -> (String, bool) {
    let source_version = source_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let identity_key = key_for_mod_with_version(
        info,
        source_version.as_deref().unwrap_or(info.version.as_str()),
    );
    let source = source_for_mod(info);
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
            source_version: source_version.clone(),
            folder_name: info.folder_name.clone(),
            mod_id: info.mod_id.clone(),
            source: source.clone(),
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
    if source_version.is_some() && record.source_version != source_version {
        record.source_version = source_version;
        changed = true;
    }
    if record.source.is_none() && source.is_some() {
        record.source = source;
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
    let sources = crate::mod_sources::load_sources(config_path);
    let mut changed = false;
    for info in mods.iter_mut() {
        let installed_source_version = crate::mod_sources::lookup_entry(
            &sources.mods,
            info.folder_name.as_deref(),
            &info.name,
            info.mod_id.as_deref(),
        )
        .and_then(|entry| entry.installed_version.as_deref());
        let (id, did_change) = upsert_record_for_mod_with_source_version(
            &mut db,
            info,
            info.mod_version_id.as_deref(),
            installed_source_version,
        );
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
                source_version: None,
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

pub fn record_by_id(config_path: &Path, id: &str) -> Option<ModVersionRecord> {
    let db = load(config_path);
    let resolved = resolve_alias(&db, id.trim()).to_string();
    db.records.get(&resolved).cloned()
}

pub fn set_record_source_version(
    config_path: &Path,
    record_id: &str,
    source_version: Option<&str>,
) -> Result<()> {
    let mut db = load(config_path);
    let resolved = resolve_alias(&db, record_id.trim()).to_string();
    if let Some(record) = db.records.get_mut(&resolved) {
        let next = source_version
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if record.source_version != next {
            record.source_version = next;
            save(&db, config_path)?;
        }
    }
    Ok(())
}

fn cached_path_for_record(cache_path: &Path, record: &ModVersionRecord) -> PathBuf {
    record
        .cache_relpath
        .as_deref()
        .map(|rel| cache_path.join(rel))
        .unwrap_or_else(|| cache_path_for_id(cache_path, &record.id))
}

pub fn cached_record_path(cache_path: &Path, record: &ModVersionRecord) -> Option<PathBuf> {
    let path = cached_path_for_record(cache_path, record);
    path.exists().then_some(path)
}

pub fn install_cached_record_to_base(
    record_id: &str,
    cache_path: &Path,
    config_path: &Path,
    dest_base: &Path,
) -> Result<ModInfo> {
    let record = record_by_id(config_path, record_id)
        .ok_or_else(|| AppError::Other(format!("Unknown cached mod version '{}'", record_id)))?;
    let zip_path = cached_record_path(cache_path, &record).ok_or_else(|| {
        AppError::Other(format!(
            "No cached archive for '{}' v{}",
            record.name, record.version
        ))
    })?;
    let mut info = crate::mods::install_mod_from_zip(&zip_path, dest_base)
        .map_err(|e| AppError::Other(format!("Failed to restore cached version: {e}")))?;
    let mut db = load(config_path);
    let (id, changed) = upsert_record_for_mod_with_source_version(
        &mut db,
        &info,
        Some(&record.id),
        record.source_version.as_deref(),
    );
    info.mod_version_id = Some(id);
    if changed {
        save(&db, config_path)?;
    }
    Ok(info)
}

pub fn profile_mod_from_record(
    record_id: &str,
    cache_path: &Path,
    config_path: &Path,
) -> Result<ProfileMod> {
    let staging = tempfile::tempdir()?;
    let record = record_by_id(config_path, record_id)
        .ok_or_else(|| AppError::Other(format!("Unknown cached mod version '{}'", record_id)))?;
    let info = install_cached_record_to_base(record_id, cache_path, config_path, staging.path())?;
    let mut entry = crate::profiles::profile_mod_from_installed(&info);
    if let Some(version) = record.source_version.or(Some(record.version)) {
        entry.version = version;
    }
    Ok(entry)
}

pub fn local_version_options_for_target(
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    config_path: &Path,
    cache_path: &Path,
    name: &str,
    mod_version_id: Option<&str>,
    mod_id: Option<&str>,
) -> Vec<LocalModVersionOption> {
    let db = load(config_path);
    let target_family = target_family_key(&db, name, mod_version_id, mod_id);
    let mut used_by_id: HashMap<String, Vec<String>> = HashMap::new();
    for profile in profiles {
        for pm in &profile.mods {
            if let Some(record) = record_for_profile_mod(pm, config_path) {
                if family_key_for_record(&record) == target_family {
                    used_by_id
                        .entry(record.id)
                        .or_default()
                        .push(profile.name.clone());
                }
            }
        }
    }

    let mut options: HashMap<String, LocalModVersionOption> = HashMap::new();
    let family_pinned = installed_mods
        .iter()
        .any(|info| family_key_for_mod(info) == target_family && info.pinned);

    for info in installed_mods
        .iter()
        .filter(|info| family_key_for_mod(info) == target_family)
    {
        let Some(id) = info.mod_version_id.clone() else {
            continue;
        };
        let record = db.records.get(resolve_alias(&db, &id));
        let cached = record
            .and_then(|record| cached_record_path(cache_path, record))
            .is_some();
        let version = record
            .and_then(|record| record.source_version.clone())
            .unwrap_or_else(|| info.version.clone());
        options.insert(
            id.clone(),
            LocalModVersionOption {
                mod_version_id: id.clone(),
                name: info.name.clone(),
                version,
                folder_name: info.folder_name.clone(),
                mod_id: info.mod_id.clone(),
                display_name: info.display_name.clone(),
                installed: true,
                installed_enabled: info.enabled,
                cached,
                pinned: info.pinned,
                used_by_profiles: used_by_id.remove(&id).unwrap_or_default(),
            },
        );
    }

    for record in db
        .records
        .values()
        .filter(|record| family_key_for_record(record) == target_family)
    {
        if cached_record_path(cache_path, record).is_none() {
            continue;
        }
        options
            .entry(record.id.clone())
            .and_modify(|option| {
                option.cached = true;
                if option.used_by_profiles.is_empty() {
                    option.used_by_profiles = used_by_id.remove(&record.id).unwrap_or_default();
                }
            })
            .or_insert_with(|| LocalModVersionOption {
                mod_version_id: record.id.clone(),
                name: record.name.clone(),
                version: record
                    .source_version
                    .clone()
                    .unwrap_or_else(|| record.version.clone()),
                folder_name: record.folder_name.clone(),
                mod_id: record.mod_id.clone(),
                display_name: None,
                installed: false,
                installed_enabled: false,
                cached: true,
                pinned: family_pinned,
                used_by_profiles: used_by_id.remove(&record.id).unwrap_or_default(),
            });
    }

    let mut options: Vec<LocalModVersionOption> = options.into_values().collect();
    options.sort_by(|a, b| {
        let version = b.version.to_lowercase().cmp(&a.version.to_lowercase());
        version
            .then_with(|| b.installed_enabled.cmp(&a.installed_enabled))
            .then_with(|| b.installed.cmp(&a.installed))
            .then_with(|| a.name.cmp(&b.name))
    });
    options
}

pub fn has_local_version_for_mod(
    config_path: &Path,
    cache_path: &Path,
    info: &ModInfo,
    version: &str,
) -> bool {
    let mut candidate = info.clone();
    ensure_mod_info_id(&mut candidate, config_path);
    let target_version = normalize_part(Some(version));
    local_version_options_for_target(
        &[candidate.clone()],
        &[],
        config_path,
        cache_path,
        &candidate.name,
        candidate.mod_version_id.as_deref(),
        candidate.mod_id.as_deref(),
    )
    .into_iter()
    .any(|option| normalize_part(Some(&option.version)) == target_version && option.cached)
}

pub fn source_hint_for_mod(info: &ModInfo, config_path: &Path) -> Option<String> {
    info.source
        .clone()
        .or_else(|| info.github_url.clone().map(|url| format!("github:{url}")))
        .or_else(|| info.nexus_url.clone())
        .or_else(|| {
            let db = crate::mod_sources::load_sources(config_path);
            let entry = crate::mod_sources::lookup_entry(
                &db.mods,
                info.folder_name.as_deref(),
                &info.name,
                info.mod_id.as_deref(),
            )?;
            entry
                .github_repo
                .as_ref()
                .map(|repo| format!("github:{repo}"))
                .or_else(|| entry.nexus_url.clone())
        })
}

pub fn mod_infos_share_family(a: &ModInfo, b: &ModInfo) -> bool {
    if let (Some(left), Some(right)) = (a.mod_id.as_deref(), b.mod_id.as_deref()) {
        if !left.trim().is_empty() && left.eq_ignore_ascii_case(right) {
            return true;
        }
    }
    if a.name.eq_ignore_ascii_case(&b.name) {
        return true;
    }
    if let (Some(left), Some(right)) = (a.folder_name.as_deref(), b.folder_name.as_deref()) {
        if left.eq_ignore_ascii_case(right) {
            return true;
        }
    }
    false
}

pub fn cache_archive_as_mod_version(
    archive_path: &Path,
    source_hint: Option<String>,
    cache_path: &Path,
    config_path: &Path,
) -> Result<ModInfo> {
    cache_archive_as_mod_version_with_source_version(
        archive_path,
        source_hint,
        cache_path,
        config_path,
        None,
    )
}

pub fn cache_archive_as_mod_version_with_source_version(
    archive_path: &Path,
    source_hint: Option<String>,
    cache_path: &Path,
    config_path: &Path,
    source_version: Option<&str>,
) -> Result<ModInfo> {
    let staging = tempfile::tempdir()?;
    let mut info = crate::mods::install_mod_from_archive(archive_path, staging.path())?;
    if info.source.is_none() {
        info.source = source_hint;
    }
    cache_mod_version_by_id_with_source_version(
        &mut info,
        staging.path(),
        cache_path,
        config_path,
        source_version,
    )
    .ok_or_else(|| AppError::Other(format!("Failed to cache '{}' v{}", info.name, info.version)))?;
    Ok(info)
}

pub fn prune_cached_versions_around(
    config_path: &Path,
    cache_path: &Path,
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    anchor_ids: &[String],
    keep_ids: &[String],
) -> Result<usize> {
    let mut db = load(config_path);
    let mut target_families = HashSet::new();
    for id in anchor_ids {
        let resolved = resolve_alias(&db, id).to_string();
        if let Some(record) = db.records.get(&resolved) {
            target_families.insert(family_key_for_record(record));
        }
    }
    if target_families.is_empty() {
        return Ok(0);
    }

    let family_is_pinned = installed_mods
        .iter()
        .any(|info| info.pinned && target_families.contains(&family_key_for_mod(info)));
    if family_is_pinned {
        return Ok(0);
    }

    let mut retain_ids: HashSet<String> = keep_ids
        .iter()
        .map(|id| resolve_alias(&db, id).to_string())
        .collect();
    for info in installed_mods {
        if target_families.contains(&family_key_for_mod(info)) {
            if let Some(id) = info.mod_version_id.as_deref() {
                retain_ids.insert(resolve_alias(&db, id).to_string());
            }
        }
    }
    for profile in profiles {
        for pm in &profile.mods {
            if let Some(record) = record_for_profile_mod(pm, config_path) {
                if target_families.contains(&family_key_for_record(&record)) {
                    retain_ids.insert(resolve_alias(&db, &record.id).to_string());
                }
            }
        }
    }

    let prune_ids: Vec<String> = db
        .records
        .values()
        .filter(|record| target_families.contains(&family_key_for_record(record)))
        .filter(|record| !retain_ids.contains(resolve_alias(&db, &record.id)))
        .filter(|record| cached_record_path(cache_path, record).is_some())
        .map(|record| record.id.clone())
        .collect();

    if prune_ids.is_empty() {
        return Ok(0);
    }

    let mut removed = 0usize;
    for id in &prune_ids {
        if let Some(record) = db.records.get(id) {
            if let Some(path) = cached_record_path(cache_path, record) {
                match fs::remove_file(&path) {
                    Ok(()) => removed += 1,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => {
                        log::warn!(
                            "Failed to prune cached mod version {} at {}: {}",
                            id,
                            path.display(),
                            e
                        );
                    }
                }
            }
        }
    }
    for id in &prune_ids {
        if let Some(record) = db.records.remove(id) {
            for alias in record.aliases {
                db.aliases.remove(&alias);
            }
        }
    }
    db.aliases
        .retain(|_, target| db.records.contains_key(target));
    db.conflicts.retain(|_, ids| {
        ids.retain(|id| db.records.contains_key(id));
        !ids.is_empty()
    });
    save(&db, config_path)?;
    Ok(removed)
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
    cache_mod_version_by_id_with_source_version(mod_info, base_path, cache_path, config_path, None)
}

pub fn cache_mod_version_by_id_with_source_version(
    mod_info: &mut ModInfo,
    base_path: &Path,
    cache_path: &Path,
    config_path: &Path,
    source_version: Option<&str>,
) -> Option<PathBuf> {
    let mut db = load(config_path);
    let (id, changed) = upsert_record_for_mod_with_source_version(
        &mut db,
        mod_info,
        mod_info.mod_version_id.as_deref(),
        source_version,
    );
    mod_info.mod_version_id = Some(id.clone());
    if changed {
        if let Err(e) = save(&db, config_path) {
            log::warn!("Failed to save mod version registry: {}", e);
        }
    }
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

    fn write_manifest(base: &Path, version: &str) {
        let mod_dir = base.join("Mod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(
            mod_dir.join("manifest.json"),
            format!(r#"{{"id":"mod-id","name":"Test","version":"{}"}}"#, version),
        )
        .unwrap();
    }

    fn profile_mod(id: String, version: &str, hash: &str) -> ProfileMod {
        ProfileMod {
            mod_version_id: Some(id),
            name: "Test".into(),
            version: version.into(),
            source: Some("github:owner/repo".into()),
            hash: Some(hash.into()),
            files: vec!["Mod/manifest.json".into()],
            folder_name: Some("Mod".into()),
            mod_id: Some("mod-id".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
        }
    }

    #[test]
    fn local_options_use_source_version_and_uppercase_v_for_cached_updates() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "1.0.0");
        let mut installed = mod_info("Test", "1.0.0", Some("old"));
        ensure_mod_info_id(&mut installed, config.path()).unwrap();

        write_manifest(base.path(), "29");
        let mut cached = mod_info("Test", "29", Some("new"));
        let cached_id = ensure_mod_info_id(&mut cached, config.path()).unwrap();
        cache_mod_version_by_id(&mut cached, base.path(), cache.path(), config.path()).unwrap();
        set_record_source_version(config.path(), &cached_id, Some("V29")).unwrap();

        let options = local_version_options_for_target(
            &[installed.clone()],
            &[],
            config.path(),
            cache.path(),
            &installed.name,
            installed.mod_version_id.as_deref(),
            installed.mod_id.as_deref(),
        );
        let cached_option = options
            .iter()
            .find(|option| option.mod_version_id == cached_id)
            .expect("cached version should be selectable");
        assert_eq!(cached_option.version, "V29");
        assert!(cached_option.cached);
        assert!(!cached_option.installed);
        assert!(
            has_local_version_for_mod(config.path(), cache.path(), &installed, "29"),
            "a cached Nexus V29 archive should suppress another update pill for latest 29"
        );
    }

    #[test]
    fn source_version_cache_keeps_same_manifest_nexus_update_selectable() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "0.16.2");
        let mut installed = mod_info("Test", "0.16.2", Some("same-content"));
        let installed_id = ensure_mod_info_id(&mut installed, config.path()).unwrap();

        write_manifest(base.path(), "0.16.2");
        let mut cached = mod_info("Test", "0.16.2", Some("same-content"));
        let cached_path = cache_mod_version_by_id_with_source_version(
            &mut cached,
            base.path(),
            cache.path(),
            config.path(),
            Some("V1"),
        )
        .expect("Nexus source-version cache should be written");
        let cached_id = cached
            .mod_version_id
            .clone()
            .expect("cached artifact should have a source-version id");

        assert_ne!(
            installed_id, cached_id,
            "Nexus file versions must not collapse into the active manifest-version record"
        );
        assert!(cached_path.exists());

        let options = local_version_options_for_target(
            &[installed.clone()],
            &[],
            config.path(),
            cache.path(),
            &installed.name,
            installed.mod_version_id.as_deref(),
            installed.mod_id.as_deref(),
        );
        assert!(
            options
                .iter()
                .any(|option| option.mod_version_id == installed_id
                    && option.version == "0.16.2"
                    && option.installed),
            "active manifest version should remain selectable"
        );
        assert!(
            options
                .iter()
                .any(|option| option.mod_version_id == cached_id
                    && option.version == "V1"
                    && option.cached
                    && !option.installed),
            "same-manifest Nexus update should surface as a cached V1 option"
        );
        assert!(
            has_local_version_for_mod(config.path(), cache.path(), &installed, "1"),
            "cached Nexus V1 should suppress the update pill for latest 1"
        );
    }

    #[test]
    fn prune_cached_versions_keeps_installed_profile_used_and_selected_versions() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "1.0.0");
        let mut installed = mod_info("Test", "1.0.0", Some("installed"));
        let installed_id = ensure_mod_info_id(&mut installed, config.path()).unwrap();

        write_manifest(base.path(), "2.0.0");
        let mut profile_used = mod_info("Test", "2.0.0", Some("profile"));
        let profile_used_id = ensure_mod_info_id(&mut profile_used, config.path()).unwrap();
        let profile_used_zip =
            cache_mod_version_by_id(&mut profile_used, base.path(), cache.path(), config.path())
                .unwrap();

        write_manifest(base.path(), "3.0.0");
        let mut selected = mod_info("Test", "3.0.0", Some("selected"));
        let selected_id = ensure_mod_info_id(&mut selected, config.path()).unwrap();
        let selected_zip =
            cache_mod_version_by_id(&mut selected, base.path(), cache.path(), config.path())
                .unwrap();

        write_manifest(base.path(), "4.0.0");
        let mut stale = mod_info("Test", "4.0.0", Some("stale"));
        let stale_id = ensure_mod_info_id(&mut stale, config.path()).unwrap();
        let stale_zip =
            cache_mod_version_by_id(&mut stale, base.path(), cache.path(), config.path()).unwrap();

        let profile = crate::profiles::Profile {
            id: "stable-id".into(),
            name: "Stable".into(),
            game_version: None,
            created_by: None,
            mods: vec![profile_mod(profile_used_id.clone(), "2.0.0", "profile")],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: std::collections::HashMap::new(),
        };

        let removed = prune_cached_versions_around(
            config.path(),
            cache.path(),
            &[installed],
            &[profile],
            &[installed_id],
            &[selected_id.clone()],
        )
        .unwrap();

        assert_eq!(removed, 1);
        assert!(
            profile_used_zip.exists(),
            "profile-used cached versions must survive pruning"
        );
        assert!(
            selected_zip.exists(),
            "the just-selected cached version must survive pruning"
        );
        assert!(
            !stale_zip.exists(),
            "unused cached versions should not stack forever"
        );
        assert!(record_by_id(config.path(), &stale_id).is_none());
    }
}
