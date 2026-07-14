use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};
use crate::mods::{ModInfo, ModInstallSource};
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
    pub nexus_file_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_file_lane_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_member_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "ModInstallSource::is_local")]
    pub install_source: ModInstallSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_manifest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_time_updated: Option<i64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    #[serde(default, skip_serializing_if = "ModInstallSource::is_local")]
    pub install_source: ModInstallSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bundle_member_ids: Vec<String>,
    pub installed: bool,
    pub installed_enabled: bool,
    pub cached: bool,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_by_profiles: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArtifactProvider {
    Steam,
    Nexus,
    GitHub,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct LocalModVersionAffectedProfile {
    pub profile_id: String,
    pub profile_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct LocalModVersionRemovalPreview {
    pub target: LocalModVersionOption,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub affected_profiles: Vec<LocalModVersionAffectedProfile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replacement_candidates: Vec<LocalModVersionOption>,
    pub active: bool,
    pub installed: bool,
    pub cached: bool,
    pub pinned: bool,
    pub can_delete_directly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct LocalModVersionDeleteSummary {
    pub removed_record: bool,
    pub deleted_cache: bool,
    pub deleted_disk: bool,
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
    if info.install_source.is_workshop() {
        return info.workshop_url.clone().or_else(|| {
            info.workshop_item_id
                .as_deref()
                .map(crate::mods::workshop_url)
        });
    }
    info.source
        .clone()
        .or_else(|| info.github_url.clone())
        .or_else(|| info.nexus_url.clone())
}

fn source_as_github_url(source: Option<&str>) -> Option<String> {
    let trimmed = source?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("github:") {
        let repo = trimmed.trim_start_matches("github:").trim();
        if repo.contains('/') {
            return Some(format!("https://github.com/{repo}"));
        }
    }
    if trimmed.contains("github.com") {
        return Some(trimmed.to_string());
    }
    None
}

fn source_as_nexus_url(source: Option<&str>) -> Option<String> {
    let trimmed = source?.trim();
    if trimmed.contains("nexusmods.com") {
        return Some(trimmed.to_string());
    }
    None
}

#[derive(Debug, Clone, Default)]
struct VersionSourceHints {
    source: Option<String>,
    github_url: Option<String>,
    nexus_url: Option<String>,
}

fn add_local_source_hints(hints: &mut VersionSourceHints, info: &ModInfo) {
    if info.install_source.is_workshop() {
        return;
    }
    if hints.source.is_none() {
        hints.source = info.source.clone();
    }
    if hints.github_url.is_none() {
        hints.github_url = info
            .github_url
            .clone()
            .or_else(|| source_as_github_url(info.source.as_deref()));
    }
    if hints.nexus_url.is_none() {
        hints.nexus_url = info
            .nexus_url
            .clone()
            .or_else(|| source_as_nexus_url(info.source.as_deref()));
    }
}

fn enrich_local_option_with_source_hints(
    option: &mut LocalModVersionOption,
    hints: Option<&VersionSourceHints>,
) {
    if option.install_source.is_workshop() {
        return;
    }
    if option.source.is_none() {
        option.source = hints.and_then(|hints| hints.source.clone());
    }
    if option.github_url.is_none() {
        option.github_url = source_as_github_url(option.source.as_deref())
            .or_else(|| hints.and_then(|hints| hints.github_url.clone()));
    }
    if option.nexus_url.is_none() {
        option.nexus_url = source_as_nexus_url(option.source.as_deref())
            .or_else(|| hints.and_then(|hints| hints.nexus_url.clone()));
    }
}

fn content_identity_for_mod(info: &ModInfo) -> Option<String> {
    let source = source_for_mod(info);
    if info.install_source.is_workshop() {
        return match (info.hash.as_deref(), source) {
            (Some(hash), Some(source)) => Some(format!("{hash}|source:{source}")),
            (Some(hash), None) => Some(hash.to_string()),
            (None, Some(source)) => Some(source),
            (None, None) => info.workshop_item_id.clone(),
        };
    }
    info.hash.clone().or(source)
}

fn key_for_mod_with_version(info: &ModInfo, version: &str) -> String {
    let mod_id = if info.bundle_member_ids.is_empty() {
        info.mod_id.as_deref()
    } else {
        None
    };
    let content_identity = content_identity_for_mod(info);
    artifact_identity_key(
        &info.name,
        info.folder_name.as_deref(),
        mod_id,
        version,
        content_identity.as_deref(),
        None,
    )
}

fn mod_info_matches_record_identity(info: &ModInfo, record: &ModVersionRecord) -> bool {
    key_for_mod_with_version(info, &info.version) == record.identity_key
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
    let mod_id = if info.bundle_member_ids.is_empty() {
        info.mod_id.as_deref()
    } else {
        None
    };
    let source = source_for_mod(info);
    family_key(&info.name, mod_id, source.as_deref())
}

fn family_key_for_record(record: &ModVersionRecord) -> String {
    let mod_id = if record.bundle_member_ids.is_empty() {
        record.mod_id.as_deref()
    } else {
        None
    };
    family_key(&record.name, mod_id, record.source.as_deref())
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
    let mod_id = if pm.bundle_member_ids.is_empty() {
        pm.mod_id.as_deref()
    } else {
        None
    };
    let source = pm.source.as_deref().or(pm.bundle_url.as_deref());
    let workshop_item_id =
        crate::mods::workshop_item_id_from_reference(source, pm.folder_name.as_deref());
    let source_owned;
    let source = if source.is_none() {
        source_owned = workshop_item_id.as_deref().map(crate::mods::workshop_url);
        source_owned.as_deref()
    } else {
        source
    };
    let is_workshop = workshop_item_id.is_some();
    let content_owned;
    let content = if is_workshop {
        content_owned = match (pm.hash.as_deref().or(pm.bundle_sha256.as_deref()), source) {
            (Some(hash), Some(source)) => Some(format!("{hash}|source:{source}")),
            (Some(hash), None) => Some(hash.to_string()),
            (None, Some(source)) => Some(source.to_string()),
            (None, None) => workshop_item_id.clone(),
        };
        content_owned.as_deref()
    } else {
        pm.hash.as_deref().or(pm.bundle_sha256.as_deref())
    };
    artifact_identity_key(
        &pm.name,
        pm.folder_name.as_deref(),
        mod_id,
        &pm.version,
        content,
        if is_workshop { None } else { source },
    )
}

pub(crate) fn canonical_profile_mod_artifact_id(
    pm: &ProfileMod,
    db: &ModVersionsDb,
) -> Option<String> {
    if let Some(record) = record_for_profile_mod_in_db(pm, db) {
        return Some(record.id);
    }

    let id = pm
        .mod_version_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if db.conflicts.contains_key(id) {
        return None;
    }
    Some(resolve_alias(db, id).to_string())
}

pub(crate) fn artifact_key_for_profile_mod(pm: &ProfileMod, db: &ModVersionsDb) -> String {
    if let Some(item_id) = crate::mods::workshop_item_id_from_reference(
        pm.source.as_deref(),
        pm.folder_name.as_deref(),
    ) {
        return format!("workshop:{item_id}");
    }
    canonical_profile_mod_artifact_id(pm, db)
        .map(|id| format!("artifact:{id}"))
        .unwrap_or_else(|| key_for_profile_mod(pm))
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

pub(crate) fn resolve_alias<'a>(db: &'a ModVersionsDb, id: &'a str) -> &'a str {
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
    let db = load(config_path);
    ids_equivalent_in_db(&db, a, b)
}

pub(crate) fn ids_equivalent_in_db(db: &ModVersionsDb, a: &str, b: &str) -> bool {
    let a = a.trim();
    let b = b.trim();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
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
    let source_version = source_version.and_then(usable_source_version_label);
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
            nexus_file_id: None,
            nexus_file_name: None,
            nexus_file_lane_key: None,
            folder_name: info.folder_name.clone(),
            mod_id: info.mod_id.clone(),
            bundle_member_ids: info.bundle_member_ids.clone(),
            source: source.clone(),
            install_source: info.install_source,
            workshop_item_id: info.workshop_item_id.clone(),
            workshop_url: info.workshop_url.clone(),
            workshop_manifest: info.workshop_manifest.clone(),
            workshop_time_updated: info.workshop_time_updated,
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
    if record.bundle_member_ids != info.bundle_member_ids {
        record.bundle_member_ids = info.bundle_member_ids.clone();
        changed = true;
    }
    if info.install_source.is_workshop() && record.source_version.is_some() {
        record.source_version = None;
        changed = true;
    } else if source_version.is_some() && record.source_version != source_version {
        record.source_version = source_version;
        changed = true;
    }
    if record.source.is_none() && source.is_some() {
        record.source = source;
        changed = true;
    }
    if record.install_source != info.install_source {
        record.install_source = info.install_source;
        changed = true;
    }
    if record.workshop_item_id != info.workshop_item_id {
        record.workshop_item_id = info.workshop_item_id.clone();
        changed = true;
    }
    if record.workshop_url != info.workshop_url {
        record.workshop_url = info.workshop_url.clone();
        changed = true;
    }
    if record.workshop_manifest != info.workshop_manifest {
        record.workshop_manifest = info.workshop_manifest.clone();
        changed = true;
    }
    if record.workshop_time_updated != info.workshop_time_updated {
        record.workshop_time_updated = info.workshop_time_updated;
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

pub(crate) fn usable_source_version_label(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown") {
        return None;
    }
    let unprefixed = trimmed.trim_start_matches(['v', 'V']);
    if unprefixed == "0" || unprefixed == "0.0.0" {
        return None;
    }
    Some(trimmed.to_string())
}

fn parse_source_version_label(raw: &str) -> Option<semver::Version> {
    let label = usable_source_version_label(raw)?;
    let stripped = label.trim_start_matches(['v', 'V']);
    if let Ok(version) = semver::Version::parse(stripped) {
        return Some(version);
    }
    let parts: Vec<&str> = stripped.split('.').collect();
    match parts.len() {
        1 => semver::Version::parse(&format!("{}.0.0", stripped)).ok(),
        2 => semver::Version::parse(&format!("{}.0", stripped)).ok(),
        _ => None,
    }
}

pub(crate) fn compare_source_version_labels(
    current: &str,
    candidate: &str,
) -> Option<std::cmp::Ordering> {
    Some(parse_source_version_label(current)?.cmp(&parse_source_version_label(candidate)?))
}

fn best_source_version_label<'a>(versions: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut first_usable: Option<String> = None;
    let mut best_parseable: Option<(semver::Version, String)> = None;

    for raw in versions {
        let Some(label) = usable_source_version_label(raw) else {
            continue;
        };
        if first_usable.is_none() {
            first_usable = Some(label.clone());
        }
        if let Some(parsed) = parse_source_version_label(&label) {
            match best_parseable.as_ref() {
                Some((best, _)) if parsed <= *best => {}
                _ => best_parseable = Some((parsed, label)),
            }
        }
    }

    best_parseable.map(|(_, label)| label).or(first_usable)
}

pub(crate) fn provider_source_version_label_for_mod(
    info: &ModInfo,
    config_path: &Path,
    provider: &str,
) -> Option<String> {
    let db = load(config_path);
    let family = family_key_for_mod(info);
    best_source_version_label(db.records.values().filter_map(|record| {
        if family_key_for_record(record) != family {
            return None;
        }
        let source = record.source.as_deref()?.trim().to_lowercase();
        let provider_matches = match provider {
            "github" => source.starts_with("github:") || source.contains("github.com/"),
            "nexus" => source.starts_with("nexus:") || source.contains("nexusmods.com/"),
            "steam" => record.install_source.is_workshop(),
            _ => false,
        };
        provider_matches.then_some(
            record
                .source_version
                .as_deref()
                .unwrap_or(record.version.as_str()),
        )
    }))
}

pub(crate) fn installed_source_version_label_for_mod(
    info: &ModInfo,
    config_path: &Path,
) -> Option<String> {
    if info.install_source.is_workshop() {
        return usable_source_version_label(&info.version);
    }

    let record_version = info
        .mod_version_id
        .as_deref()
        .and_then(|id| record_by_id(config_path, id))
        .and_then(|record| record.source_version);
    let sources = crate::mod_sources::load_sources(config_path);
    let source_entry_version = crate::mod_sources::lookup_entry(
        &sources.mods,
        info.folder_name.as_deref(),
        &info.name,
        info.mod_id.as_deref(),
    )
    .and_then(|entry| entry.installed_version.as_deref().map(str::to_string));
    best_source_version_label(
        [
            record_version.as_deref(),
            source_entry_version.as_deref(),
            Some(info.version.as_str()),
        ]
        .into_iter()
        .flatten(),
    )
}

pub fn enrich_mods_with_versions(mods: &mut [ModInfo], config_path: &Path) {
    let mut db = load(config_path);
    let sources = crate::mod_sources::load_sources(config_path);
    let mut changed = false;
    for info in mods.iter_mut() {
        let installed_source_version = if info.install_source.is_workshop() {
            None
        } else {
            crate::mod_sources::lookup_entry(
                &sources.mods,
                info.folder_name.as_deref(),
                &info.name,
                info.mod_id.as_deref(),
            )
            .and_then(|entry| entry.installed_version.as_deref())
        };
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
    let workshop_item_id = crate::mods::workshop_item_id_from_reference(
        pm.source.as_deref(),
        pm.folder_name.as_deref(),
    );
    let install_source = if workshop_item_id.is_some() {
        ModInstallSource::SteamWorkshop
    } else {
        ModInstallSource::Local
    };
    let workshop_url = workshop_item_id.as_deref().map(crate::mods::workshop_url);
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
                nexus_file_id: None,
                nexus_file_name: None,
                nexus_file_lane_key: None,
                folder_name: pm.folder_name.clone(),
                mod_id: pm.mod_id.clone(),
                bundle_member_ids: pm.bundle_member_ids.clone(),
                source: pm
                    .source
                    .clone()
                    .or_else(|| workshop_url.clone())
                    .or_else(|| pm.bundle_url.clone()),
                install_source,
                workshop_item_id,
                workshop_url,
                workshop_manifest: None,
                workshop_time_updated: None,
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
    record_for_profile_mod_in_db(pm, &db)
}

pub(crate) fn record_for_profile_mod_in_db(
    pm: &ProfileMod,
    db: &ModVersionsDb,
) -> Option<ModVersionRecord> {
    let identity_key = key_for_profile_mod(pm);
    if let Some(id) = pm
        .mod_version_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let ambiguous_alias = db.conflicts.contains_key(id);
        if let Some(record) = db.records.get(resolve_alias(&db, id)) {
            if !ambiguous_alias || record.identity_key == identity_key {
                return Some(record.clone());
            }
        }
    }
    record_by_identity(&db, &identity_key).cloned()
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
        let next = source_version.and_then(usable_source_version_label);
        if record.source_version != next {
            record.source_version = next;
            save(&db, config_path)?;
        }
    }
    Ok(())
}

pub fn set_record_nexus_file_identity(
    config_path: &Path,
    record_id: &str,
    identity: &crate::nexus::NexusFileIdentity,
) -> Result<()> {
    if identity.file_id.is_none() && identity.file_name.is_none() && identity.lane_key.is_none() {
        return Ok(());
    }
    let mut db = load(config_path);
    let resolved = resolve_alias(&db, record_id.trim()).to_string();
    if let Some(record) = db.records.get_mut(&resolved) {
        let mut changed = false;
        if identity.file_id.is_some() && record.nexus_file_id != identity.file_id {
            record.nexus_file_id = identity.file_id;
            changed = true;
        }
        if identity.file_name.is_some() && record.nexus_file_name != identity.file_name {
            record.nexus_file_name = identity.file_name.clone();
            changed = true;
        }
        if identity.lane_key.is_some() && record.nexus_file_lane_key != identity.lane_key {
            record.nexus_file_lane_key = identity.lane_key.clone();
            changed = true;
        }
        if changed {
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
    if path.exists() {
        return Some(path);
    }
    record.aliases.iter().find_map(|alias| {
        let alias_path = cache_path_for_id(cache_path, alias);
        alias_path.exists().then_some(alias_path)
    })
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
    let by_family = local_version_options_by_family(installed_mods, profiles, &db, cache_path);
    let target_family = target_family_key(&db, name, mod_version_id, mod_id);
    by_family.get(&target_family).cloned().unwrap_or_default()
}

pub fn preview_local_mod_version_removal(
    config_path: &Path,
    cache_path: &Path,
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    mod_version_id: &str,
) -> Result<LocalModVersionRemovalPreview> {
    let db = load(config_path);
    let requested_id = mod_version_id.trim();
    if requested_id.is_empty() {
        return Err(AppError::Other(
            "No stored version was selected. Refresh the mod list and try again.".into(),
        ));
    }
    let resolved_id = resolve_alias(&db, requested_id).to_string();
    let record = db.records.get(&resolved_id).cloned().ok_or_else(|| {
        AppError::Other(
            "That stored version is no longer available. Refresh the mod list and try again."
                .into(),
        )
    })?;
    let family = family_key_for_record(&record);
    let by_family = local_version_options_by_family(installed_mods, profiles, &db, cache_path);
    let family_options = by_family.get(&family).cloned().unwrap_or_default();
    let installed_matches: Vec<&ModInfo> = installed_mods
        .iter()
        .filter(|info| mod_info_matches_record_identity(info, &record))
        .collect();
    let active = installed_matches.iter().any(|info| info.enabled);
    let installed = !installed_matches.is_empty();
    let cached = cached_record_path(cache_path, &record).is_some()
        || family_options.iter().any(|option| {
            resolve_alias(&db, &option.mod_version_id) == resolved_id && option.cached
        });
    let pinned = family_options
        .iter()
        .any(|option| resolve_alias(&db, &option.mod_version_id) == resolved_id && option.pinned)
        || installed_matches.iter().any(|info| info.pinned)
        || installed_mods
            .iter()
            .any(|info| info.pinned && family_key_for_mod(info) == family);
    let target = LocalModVersionOption {
        mod_version_id: record.id.clone(),
        name: record.name.clone(),
        version: record
            .source_version
            .clone()
            .unwrap_or_else(|| record.version.clone()),
        folder_name: record.folder_name.clone(),
        mod_id: record.mod_id.clone(),
        display_name: installed_matches
            .iter()
            .find_map(|info| info.display_name.clone()),
        source: record.source.clone(),
        github_url: source_as_github_url(record.source.as_deref()),
        nexus_url: source_as_nexus_url(record.source.as_deref()),
        install_source: record.install_source,
        workshop_item_id: record.workshop_item_id.clone(),
        workshop_url: record.workshop_url.clone(),
        bundle_member_ids: record.bundle_member_ids.clone(),
        installed,
        installed_enabled: active,
        cached,
        pinned,
        used_by_profiles: Vec::new(),
    };

    let affected_profiles = profiles
        .iter()
        .filter(|profile| {
            profile.mods.iter().any(|pm| {
                record_for_profile_mod_in_db(pm, &db)
                    .map(|record| record.id == resolved_id)
                    .unwrap_or(false)
            })
        })
        .map(|profile| LocalModVersionAffectedProfile {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
        })
        .collect::<Vec<_>>();

    let replacement_candidates = family_options
        .into_iter()
        .filter(|option| resolve_alias(&db, &option.mod_version_id) != resolved_id)
        .collect::<Vec<_>>();
    let can_delete_directly = !active && !pinned && affected_profiles.is_empty();

    Ok(LocalModVersionRemovalPreview {
        target: LocalModVersionOption {
            installed,
            installed_enabled: active,
            cached,
            pinned,
            used_by_profiles: affected_profiles
                .iter()
                .map(|profile| profile.profile_name.clone())
                .collect(),
            ..target
        },
        affected_profiles,
        replacement_candidates,
        active,
        installed,
        cached,
        pinned,
        can_delete_directly,
    })
}

pub fn local_version_options_by_mod_version_id(
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    config_path: &Path,
    cache_path: &Path,
) -> HashMap<String, Vec<LocalModVersionOption>> {
    let db = load(config_path);
    local_version_options_by_mod_version_id_in_db(installed_mods, profiles, &db, cache_path)
}

pub(crate) fn local_version_options_by_mod_version_id_in_db(
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    db: &ModVersionsDb,
    cache_path: &Path,
) -> HashMap<String, Vec<LocalModVersionOption>> {
    let by_family = local_version_options_by_family(installed_mods, profiles, &db, cache_path);
    let mut by_mod_version_id = HashMap::new();
    for info in installed_mods {
        let Some(id) = info.mod_version_id.as_deref() else {
            continue;
        };
        let target_family = target_family_key(&db, &info.name, Some(id), info.mod_id.as_deref());
        if let Some(options) = by_family.get(&target_family) {
            by_mod_version_id.insert(id.to_string(), options.clone());
            let resolved = resolve_alias(&db, id);
            if resolved != id {
                by_mod_version_id.insert(resolved.to_string(), options.clone());
            }
        }
    }
    for record in db.records.values() {
        if cached_record_path(cache_path, record).is_none() {
            continue;
        }
        let target_family = family_key_for_record(record);
        if let Some(options) = by_family.get(&target_family) {
            by_mod_version_id.insert(record.id.clone(), options.clone());
            for alias in &record.aliases {
                by_mod_version_id.insert(alias.clone(), options.clone());
            }
        }
    }
    by_mod_version_id
}

fn local_version_options_by_family(
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    db: &ModVersionsDb,
    cache_path: &Path,
) -> HashMap<String, Vec<LocalModVersionOption>> {
    let mut used_by_id: HashMap<String, Vec<String>> = HashMap::new();
    for profile in profiles {
        for pm in &profile.mods {
            if let Some(record) = record_for_profile_mod_in_db(pm, db) {
                used_by_id
                    .entry(record.id)
                    .or_default()
                    .push(profile.name.clone());
            }
        }
    }

    let cached_ids: HashSet<String> = db
        .records
        .values()
        .filter(|record| cached_record_path(cache_path, record).is_some())
        .map(|record| record.id.clone())
        .collect();
    let mut family_pinned: HashSet<String> = HashSet::new();
    for info in installed_mods.iter().filter(|info| info.pinned) {
        family_pinned.insert(family_key_for_mod(info));
        if let Some(id) = info.mod_version_id.as_deref() {
            if let Some(record) = db.records.get(resolve_alias(db, id)) {
                family_pinned.insert(family_key_for_record(record));
            }
        }
    }
    let installed_bundle_families: Vec<(String, Option<String>, HashSet<String>)> = installed_mods
        .iter()
        .filter(|info| !info.bundle_member_ids.is_empty())
        .map(|info| {
            (
                family_key_for_mod(info),
                normalize_family_part(source_for_mod(info).as_deref()),
                crate::mods::runtime_mod_ids(info)
                    .into_iter()
                    .filter_map(|id| normalize_family_part(Some(&id)))
                    .collect(),
            )
        })
        .collect();

    let mut source_hints_by_family: HashMap<String, VersionSourceHints> = HashMap::new();
    for info in installed_mods {
        if info.install_source.is_workshop() {
            continue;
        }
        let direct_family = family_key_for_mod(info);
        add_local_source_hints(
            source_hints_by_family.entry(direct_family).or_default(),
            info,
        );
        if let Some(id) = info.mod_version_id.as_deref() {
            if let Some(record) = db.records.get(resolve_alias(db, id)) {
                add_local_source_hints(
                    source_hints_by_family
                        .entry(family_key_for_record(record))
                        .or_default(),
                    info,
                );
            }
        }
    }

    let mut options_by_family: HashMap<String, HashMap<String, LocalModVersionOption>> =
        HashMap::new();
    for info in installed_mods {
        let Some(id) = info.mod_version_id.clone() else {
            continue;
        };
        let resolved_id = resolve_alias(db, &id).to_string();
        let record = db.records.get(&resolved_id);
        let family = record
            .map(family_key_for_record)
            .unwrap_or_else(|| family_key_for_mod(info));
        let cached = cached_ids.contains(&resolved_id);
        let version = record
            .and_then(|record| record.source_version.clone())
            .unwrap_or_else(|| info.version.clone());
        options_by_family.entry(family).or_default().insert(
            id.clone(),
            LocalModVersionOption {
                mod_version_id: id.clone(),
                name: info.name.clone(),
                version,
                folder_name: info.folder_name.clone(),
                mod_id: info.mod_id.clone(),
                display_name: info.display_name.clone(),
                source: info.source.clone(),
                github_url: info.github_url.clone(),
                nexus_url: info.nexus_url.clone(),
                install_source: info.install_source,
                workshop_item_id: info.workshop_item_id.clone(),
                workshop_url: info.workshop_url.clone(),
                bundle_member_ids: info.bundle_member_ids.clone(),
                installed: true,
                installed_enabled: info.enabled,
                cached,
                pinned: info.pinned,
                used_by_profiles: used_by_id.get(&resolved_id).cloned().unwrap_or_default(),
            },
        );
    }

    for record in db.records.values() {
        if !cached_ids.contains(&record.id) {
            continue;
        }
        let mut families = vec![family_key_for_record(record)];
        if record.bundle_member_ids.is_empty() {
            let record_source = normalize_family_part(record.source.as_deref());
            let record_candidates: HashSet<String> = [
                record.mod_id.as_deref(),
                record.folder_name.as_deref(),
                Some(record.name.as_str()),
            ]
            .into_iter()
            .flatten()
            .filter_map(|id| normalize_family_part(Some(id)))
            .collect();
            let mut bundle_alias_families = Vec::new();
            for (bundle_family, bundle_source, bundle_member_ids) in &installed_bundle_families {
                if record_source.is_none() || record_source != *bundle_source {
                    continue;
                }
                if record_candidates
                    .iter()
                    .any(|candidate| bundle_member_ids.contains(candidate))
                    && !bundle_alias_families
                        .iter()
                        .any(|family| family == bundle_family)
                {
                    bundle_alias_families.push(bundle_family.clone());
                }
            }
            if !bundle_alias_families.is_empty() {
                families = bundle_alias_families;
            }
        }
        for family in families {
            let pinned = family_pinned.contains(&family);
            options_by_family
                .entry(family)
                .or_default()
                .entry(record.id.clone())
                .and_modify(|option| {
                    option.cached = true;
                    if option.bundle_member_ids.is_empty() {
                        option.bundle_member_ids = record.bundle_member_ids.clone();
                    }
                    if option.used_by_profiles.is_empty() {
                        option.used_by_profiles =
                            used_by_id.get(&record.id).cloned().unwrap_or_default();
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
                    source: record.source.clone(),
                    github_url: source_as_github_url(record.source.as_deref()),
                    nexus_url: source_as_nexus_url(record.source.as_deref()),
                    install_source: record.install_source,
                    workshop_item_id: record.workshop_item_id.clone(),
                    workshop_url: record.workshop_url.clone(),
                    bundle_member_ids: record.bundle_member_ids.clone(),
                    installed: false,
                    installed_enabled: false,
                    cached: true,
                    pinned,
                    used_by_profiles: used_by_id.get(&record.id).cloned().unwrap_or_default(),
                });
        }
    }

    options_by_family
        .into_iter()
        .map(|(family, options)| {
            let hints = source_hints_by_family.get(&family);
            let mut options: Vec<LocalModVersionOption> = options
                .into_values()
                .map(|mut option| {
                    enrich_local_option_with_source_hints(&mut option, hints);
                    option
                })
                .collect();
            options.sort_by(|a, b| {
                let version = b.version.to_lowercase().cmp(&a.version.to_lowercase());
                version
                    .then_with(|| b.installed_enabled.cmp(&a.installed_enabled))
                    .then_with(|| b.installed.cmp(&a.installed))
                    .then_with(|| b.cached.cmp(&a.cached))
                    .then_with(|| b.used_by_profiles.len().cmp(&a.used_by_profiles.len()))
                    .then_with(|| a.name.cmp(&b.name))
            });
            let mut seen = HashSet::new();
            options.retain(|option| seen.insert(local_option_dedupe_key(option, db)));
            (family, options)
        })
        .collect()
}

fn local_option_dedupe_key(option: &LocalModVersionOption, db: &ModVersionsDb) -> String {
    let record = db
        .records
        .get(resolve_alias(db, option.mod_version_id.as_str()));
    let source = record
        .and_then(|record| normalize_part(record.source.as_deref()))
        .unwrap_or_else(|| "unknown".into());
    let content = record.and_then(|record| {
        normalize_part(record.content_hash.as_deref())
            .or_else(|| normalize_part(record.archive_sha256.as_deref()))
    });
    let folder_guard = if content.is_some() {
        String::new()
    } else {
        format!(
            "|folder:{}",
            normalize_part(option.folder_name.as_deref()).unwrap_or_else(|| "unknown".into())
        )
    };
    let mut member_ids = option
        .bundle_member_ids
        .iter()
        .filter_map(|id| normalize_part(Some(id)))
        .collect::<Vec<_>>();
    member_ids.sort();
    let identity = if !member_ids.is_empty() {
        format!(
            "bundle:{}|members:{}",
            normalize_part(Some(&option.name)).unwrap_or_else(|| "unknown".into()),
            member_ids.join(",")
        )
    } else {
        normalize_part(option.mod_id.as_deref())
            .map(|id| format!("mod_id:{id}"))
            .unwrap_or_else(|| {
                format!(
                    "name:{}",
                    normalize_part(Some(&option.name)).unwrap_or_else(|| "unknown".into())
                )
            })
    };
    format!(
        "{identity}|version:{}|source:{source}|content:{}{folder_guard}",
        normalize_part(Some(&option.version)).unwrap_or_else(|| "unknown".into()),
        content.unwrap_or_else(|| "unknown".into()),
    )
}

pub fn has_local_version_for_mod(
    config_path: &Path,
    cache_path: &Path,
    info: &ModInfo,
    version: &str,
) -> bool {
    local_version_options_for_cached_comparison(config_path, cache_path, info)
        .into_iter()
        .any(|option| {
            normalize_part(Some(&option.version)) == normalize_part(Some(version)) && option.cached
        })
}

fn artifact_provider_for_option(option: &LocalModVersionOption) -> ArtifactProvider {
    if option.install_source.is_workshop() {
        return ArtifactProvider::Steam;
    }
    let source = option
        .source
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if option.nexus_url.is_some()
        || source.starts_with("nexus:")
        || source.contains("nexusmods.com/")
    {
        return ArtifactProvider::Nexus;
    }
    if option.github_url.is_some()
        || source.starts_with("github:")
        || source.contains("github.com/")
    {
        return ArtifactProvider::GitHub;
    }
    ArtifactProvider::Local
}

fn provider_source_identity(provider: ArtifactProvider, raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    match provider {
        ArtifactProvider::GitHub => {
            let repo = lower
                .strip_prefix("github:")
                .or_else(|| lower.split_once("github.com/").map(|(_, path)| path))
                .unwrap_or(lower.as_str());
            let repo = repo.split(['?', '#']).next()?.trim_matches('/');
            let mut parts = repo.split('/');
            let owner = parts.next()?.trim();
            let name = parts.next()?.trim().trim_end_matches(".git");
            if owner.is_empty() || name.is_empty() || parts.next().is_some() {
                return None;
            }
            Some(format!("{owner}/{name}"))
        }
        ArtifactProvider::Nexus => {
            let path = lower
                .strip_prefix("nexus:")
                .or_else(|| lower.split_once("nexusmods.com/").map(|(_, path)| path))?;
            let segments: Vec<&str> = path
                .split(['?', '#'])
                .next()?
                .split('/')
                .filter(|segment| !segment.is_empty())
                .collect();
            let mods_index = segments.iter().position(|segment| *segment == "mods")?;
            let game = segments.get(mods_index.checked_sub(1)?)?;
            let mod_id = segments.get(mods_index + 1)?;
            if game.is_empty() || mod_id.is_empty() {
                return None;
            }
            Some(format!("nexusmods.com/{game}/mods/{mod_id}"))
        }
        ArtifactProvider::Steam => {
            if let Some(item_id) = lower.split("id=").nth(1) {
                return item_id
                    .split(['&', '?', '#', '/'])
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
            }
            Some(lower.trim_matches('/').to_string())
        }
        ArtifactProvider::Local => Some(lower.to_string()),
    }
}

fn provider_source_for_option(
    option: &LocalModVersionOption,
    provider: ArtifactProvider,
) -> Option<&str> {
    match provider {
        ArtifactProvider::Steam => option
            .workshop_item_id
            .as_deref()
            .or(option.workshop_url.as_deref())
            .or(option.source.as_deref()),
        ArtifactProvider::Nexus => option.nexus_url.as_deref().or(option.source.as_deref()),
        ArtifactProvider::GitHub => option.github_url.as_deref().or(option.source.as_deref()),
        ArtifactProvider::Local => option.source.as_deref(),
    }
}

pub(crate) fn has_cached_provider_version_for_mod(
    config_path: &Path,
    cache_path: &Path,
    info: &ModInfo,
    version: &str,
    provider: ArtifactProvider,
    provider_source: Option<&str>,
) -> bool {
    let requested_source_was_supplied =
        provider_source.is_some_and(|source| !source.trim().is_empty());
    let requested_source = provider_source_identity(provider, provider_source);
    if requested_source_was_supplied && requested_source.is_none() {
        return false;
    }
    local_version_options_for_cached_comparison(config_path, cache_path, info)
        .into_iter()
        .filter(|option| option.cached)
        .filter(|option| normalize_part(Some(&option.version)) == normalize_part(Some(version)))
        .filter(|option| artifact_provider_for_option(option) == provider)
        .any(|option| {
            let candidate_source =
                provider_source_identity(provider, provider_source_for_option(&option, provider));
            match (requested_source.as_deref(), candidate_source.as_deref()) {
                (Some(requested), Some(candidate)) => requested == candidate,
                (Some(_), None) => false,
                (None, _) => true,
            }
        })
}

pub(crate) fn cached_source_version_ids_for_mod_family(
    config_path: &Path,
    cache_path: &Path,
    info: &ModInfo,
) -> Vec<String> {
    let db = load(config_path);
    let mut target_families = HashSet::from([family_key_for_mod(info)]);
    if let Some(id) = info.mod_version_id.as_deref() {
        if let Some(record) = db.records.get(resolve_alias(&db, id)) {
            target_families.insert(family_key_for_record(record));
        }
    }
    db.records
        .values()
        .filter(|record| target_families.contains(&family_key_for_record(record)))
        .filter(|record| {
            record
                .source_version
                .as_deref()
                .and_then(usable_source_version_label)
                .is_some()
        })
        .filter(|record| cached_record_path(cache_path, record).is_some())
        .map(|record| record.id.clone())
        .collect()
}

fn local_version_options_for_cached_comparison(
    config_path: &Path,
    cache_path: &Path,
    info: &ModInfo,
) -> Vec<LocalModVersionOption> {
    let mut candidate = info.clone();
    ensure_mod_info_id(&mut candidate, config_path);
    local_version_options_for_target(
        &[candidate.clone()],
        &[],
        config_path,
        cache_path,
        &candidate.name,
        candidate.mod_version_id.as_deref(),
        candidate.mod_id.as_deref(),
    )
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

pub fn remove_local_mod_version(
    config_path: &Path,
    cache_path: &Path,
    disabled_path: &Path,
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    mod_version_id: &str,
) -> Result<()> {
    remove_local_mod_version_with_policy(
        config_path,
        cache_path,
        None,
        disabled_path,
        installed_mods,
        profiles,
        mod_version_id,
        false,
    )
    .map(|_| ())
}

pub(crate) fn remove_local_mod_version_with_policy(
    config_path: &Path,
    cache_path: &Path,
    mods_path: Option<&Path>,
    disabled_path: &Path,
    installed_mods: &[ModInfo],
    profiles: &[crate::profiles::Profile],
    mod_version_id: &str,
    allow_active: bool,
) -> Result<LocalModVersionDeleteSummary> {
    let mut db = load(config_path);
    let requested_id = mod_version_id.trim();
    if requested_id.is_empty() {
        return Err(AppError::Other(
            "No stored version was selected. Refresh the mod list and try again.".into(),
        ));
    }
    let resolved_id = resolve_alias(&db, requested_id).to_string();
    let record = db.records.get(&resolved_id).cloned().ok_or_else(|| {
        AppError::Other(
            "That stored version is no longer available. Refresh the mod list and try again."
                .into(),
        )
    })?;
    let family = family_key_for_record(&record);

    let installed_matches: Vec<&ModInfo> = installed_mods
        .iter()
        .filter(|info| mod_info_matches_record_identity(info, &record))
        .collect();
    let cached = cached_record_path(cache_path, &record).is_some();
    let record_is_workshop = record.install_source == ModInstallSource::SteamWorkshop
        || record.workshop_item_id.is_some();
    if record_is_workshop && !installed_matches.is_empty() {
        return Err(AppError::Other(
            "Steam Workshop mods are managed by Steam. Unsubscribe or remove them in Steam instead."
                .into(),
        ));
    }
    if record_is_workshop && cached {
        return Err(AppError::Other(
            "This Workshop version still has a local cached archive. Switch away from it or remove affected modpacks first."
                .into(),
        ));
    }
    if installed_matches.iter().any(|info| info.enabled) {
        if !allow_active {
            return Err(AppError::Other(
                "Switch away from this active version before removing it.".into(),
            ));
        }
        if mods_path.is_none() {
            return Err(AppError::Other(
                "The active mod folder is unavailable. Set the game path and try again.".into(),
            ));
        }
    }
    if installed_matches
        .iter()
        .any(|info| info.enabled && info.pinned)
    {
        return Err(AppError::Other(
            "Unfreeze this mod before removing one of its stored versions.".into(),
        ));
    }
    if installed_mods
        .iter()
        .any(|info| info.pinned && family_key_for_mod(info) == family)
    {
        return Err(AppError::Other(
            "Unfreeze this mod before removing one of its stored versions.".into(),
        ));
    }

    for profile in profiles {
        for pm in &profile.mods {
            if record_for_profile_mod_in_db(pm, &db)
                .map(|record| record.id == resolved_id)
                .unwrap_or(false)
            {
                return Err(AppError::Other(format!(
                    "Remove this version from \"{}\" before deleting it.",
                    profile.name
                )));
            }
        }
    }

    let mut summary = LocalModVersionDeleteSummary::default();
    for info in installed_matches {
        let base = if info.enabled {
            mods_path.ok_or_else(|| {
                AppError::Other(
                    "The active mod folder is unavailable. Set the game path and try again.".into(),
                )
            })?
        } else {
            disabled_path
        };
        crate::mods::delete_mod_files_by_info(info, base);
        summary.deleted_disk = true;
    }
    if let Some(path) = cached_record_path(cache_path, &record) {
        match fs::remove_file(&path) {
            Ok(()) => {
                summary.deleted_cache = true;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(AppError::Other(format!(
                    "Failed to remove stored version at {}: {}",
                    path.display(),
                    e
                )));
            }
        }
    }

    if let Some(record) = db.records.remove(&resolved_id) {
        summary.removed_record = true;
        for alias in record.aliases {
            db.aliases.remove(&alias);
        }
    }
    db.aliases
        .retain(|_, target| db.records.contains_key(target));
    db.conflicts.retain(|_, ids| {
        ids.retain(|id| db.records.contains_key(id));
        !ids.is_empty()
    });
    save(&db, config_path)?;
    Ok(summary)
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
    cached_record_path(cache_path, &record)
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
            bundle_member_ids: vec![],
            ..Default::default()
        }
    }

    fn workshop_mod_info(item_id: &str, version: &str) -> ModInfo {
        let mut info = mod_info("RitsuLib", version, Some("workshop-hash"));
        info.source = Some(crate::mods::workshop_url(item_id));
        info.install_source = ModInstallSource::SteamWorkshop;
        info.workshop_item_id = Some(item_id.into());
        info.workshop_url = Some(crate::mods::workshop_url(item_id));
        info.folder_name = Some(item_id.into());
        info.mod_id = Some("STS2-RitsuLib".into());
        info
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
    fn cached_record_path_falls_back_to_alias_archive() {
        let cache = tempfile::tempdir().unwrap();
        let alias_id = "legacy-source-version-id";
        let alias_path = cache_path_for_id(cache.path(), alias_id);
        fs::create_dir_all(alias_path.parent().unwrap()).unwrap();
        fs::write(&alias_path, b"cached zip").unwrap();

        let record = ModVersionRecord {
            id: "canonical-id".into(),
            identity_key: "mod_id:regentcardsanimerework|version:0.6|content:hash".into(),
            aliases: vec![alias_id.into()],
            name: "RegentCardsAnimeRework".into(),
            version: "v0.6".into(),
            source_version: Some("v0.6.5".into()),
            folder_name: Some("RegentCardsAnimeRework".into()),
            mod_id: Some("RegentCardsAnimeRework".into()),
            bundle_member_ids: Vec::new(),
            source: Some("github:DoublePigeon/RegentCardsAnimeRework".into()),
            content_hash: Some("hash".into()),
            archive_sha256: None,
            cache_relpath: Some(cache_relpath_for_id("canonical-id")),
            ..ModVersionRecord::default()
        };

        assert_eq!(cached_record_path(cache.path(), &record), Some(alias_path));
    }

    #[test]
    fn artifact_key_for_profile_mod_resolves_aliases_to_canonical_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut info = mod_info("RitsuLib (STS2 0.103.2 compat)", "0.4.24", Some("abc"));
        let canonical_id = ensure_mod_info_id(&mut info, dir.path()).unwrap();
        alias_shared_id("shared-ritsulib-id", &mut info, dir.path()).unwrap();
        let db = load(dir.path());
        let mut pm = profile_mod("shared-ritsulib-id".into(), "0.4.24", "abc");
        pm.name = "RitsuLib (STS2 0.103.2 compat)".into();

        assert_eq!(
            artifact_key_for_profile_mod(&pm, &db),
            format!("artifact:{canonical_id}")
        );
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
            bundle_member_ids: vec![],
        };
        assert_eq!(
            record_for_profile_mod(&pm, dir.path()).map(|record| record.id),
            Some(second_id)
        );
    }

    #[test]
    fn concrete_profile_artifact_id_wins_when_saved_fields_drift() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = mod_info("Test", "1.0.0", Some("abc"));
        let old_id = ensure_mod_info_id(&mut old, dir.path()).unwrap();
        let mut latest = mod_info("Test", "2.0.0", Some("def"));
        let latest_id = ensure_mod_info_id(&mut latest, dir.path()).unwrap();
        assert_ne!(old_id, latest_id);

        let pm = ProfileMod {
            mod_version_id: Some(old_id.clone()),
            name: "Test".into(),
            version: "2.0.0".into(),
            source: Some("github:owner/repo".into()),
            hash: Some("def".into()),
            files: vec!["Mod/manifest.json".into()],
            folder_name: Some("Mod".into()),
            mod_id: Some("mod-id".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        };

        assert_eq!(
            record_for_profile_mod(&pm, dir.path()).map(|record| record.id),
            Some(old_id),
            "a saved concrete version id must stay pinned even if cached display fields drift"
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
            bundle_member_ids: vec![],
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
            bundle_member_ids: vec![],
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
    fn cached_provider_version_does_not_cross_suppress_steam_and_nexus() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let nexus_url = "https://www.nexusmods.com/slaythespire2/mods/103";

        write_manifest(base.path(), "3.3.5");
        let mut workshop = workshop_mod_info("103", "3.3.5");
        workshop.hash = Some("steam-335".into());
        ensure_mod_info_id(&mut workshop, config.path()).unwrap();
        cache_mod_version_by_id(&mut workshop, base.path(), cache.path(), config.path()).unwrap();

        write_manifest(base.path(), "3.3.1");
        let mut nexus = mod_info("RitsuLib", "3.3.1", Some("nexus-331"));
        nexus.mod_id = workshop.mod_id.clone();
        nexus.folder_name = Some("RitsuLib".into());
        nexus.source = Some(nexus_url.into());
        nexus.nexus_url = Some(nexus_url.into());
        nexus.workshop_item_id = Some("103".into());
        nexus.workshop_url = Some(crate::mods::workshop_url("103"));
        let nexus_id = ensure_mod_info_id(&mut nexus, config.path()).unwrap();
        cache_mod_version_by_id(&mut nexus, base.path(), cache.path(), config.path()).unwrap();

        assert_eq!(
            artifact_provider_for_option(
                &local_version_options_for_target(
                    &[workshop.clone()],
                    &[],
                    config.path(),
                    cache.path(),
                    &workshop.name,
                    workshop.mod_version_id.as_deref(),
                    workshop.mod_id.as_deref(),
                )
                .into_iter()
                .find(|option| option.mod_version_id == nexus_id)
                .expect("cached Nexus artifact should remain in the logical family"),
            ),
            ArtifactProvider::Nexus,
        );
        assert!(!has_cached_provider_version_for_mod(
            config.path(),
            cache.path(),
            &workshop,
            "3.3.5",
            ArtifactProvider::Nexus,
            Some(nexus_url),
        ));

        write_manifest(base.path(), "3.3.5");
        let mut nexus_target = nexus.clone();
        nexus_target.hash = Some("nexus-335".into());
        nexus_target.version = "3.3.5".into();
        cache_mod_version_by_id(&mut nexus_target, base.path(), cache.path(), config.path())
            .unwrap();
        assert!(has_cached_provider_version_for_mod(
            config.path(),
            cache.path(),
            &workshop,
            "3.3.5",
            ArtifactProvider::Nexus,
            Some(nexus_url),
        ));
    }

    #[test]
    fn cached_provider_version_does_not_cross_suppress_steam_and_github() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let github_source = "github:owner/ritsu-lib";

        write_manifest(base.path(), "2.0.0");
        let mut workshop = workshop_mod_info("204", "2.0.0");
        workshop.hash = Some("steam-200".into());
        ensure_mod_info_id(&mut workshop, config.path()).unwrap();
        cache_mod_version_by_id(&mut workshop, base.path(), cache.path(), config.path()).unwrap();

        write_manifest(base.path(), "1.0.0");
        let mut github = mod_info("RitsuLib", "1.0.0", Some("github-100"));
        github.mod_id = workshop.mod_id.clone();
        github.folder_name = Some("RitsuLib".into());
        github.source = Some(github_source.into());
        github.github_url = Some("https://github.com/owner/ritsu-lib".into());
        github.workshop_item_id = Some("204".into());
        github.workshop_url = Some(crate::mods::workshop_url("204"));
        ensure_mod_info_id(&mut github, config.path()).unwrap();
        cache_mod_version_by_id(&mut github, base.path(), cache.path(), config.path()).unwrap();

        assert!(!has_cached_provider_version_for_mod(
            config.path(),
            cache.path(),
            &workshop,
            "2.0.0",
            ArtifactProvider::GitHub,
            Some(github_source),
        ));

        write_manifest(base.path(), "2.0.0");
        github.hash = Some("github-200".into());
        github.version = "2.0.0".into();
        cache_mod_version_by_id(&mut github, base.path(), cache.path(), config.path()).unwrap();
        assert!(has_cached_provider_version_for_mod(
            config.path(),
            cache.path(),
            &workshop,
            "2.0.0",
            ArtifactProvider::GitHub,
            Some("https://github.com/owner/ritsu-lib"),
        ));
    }

    #[test]
    fn legacy_member_cached_bundle_record_routes_to_bundle_family_only() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let bundle_source = "https://www.nexusmods.com/slaythespire2/mods/979";

        write_manifest(base.path(), "2.1");
        let mut bundle = mod_info("Pretty Pack", "2.1", Some("bundle-hash"));
        bundle.folder_name = Some("Pretty Pack".into());
        bundle.mod_id = None;
        bundle.source = Some(bundle_source.into());
        bundle.bundle_members = vec!["BaseLib".into(), "Kaguya Regent Skin".into()];
        bundle.bundle_member_ids = vec!["BaseLib".into(), "KaguyaRegentMSGKSkin".into()];
        let bundle_id = ensure_mod_info_id(&mut bundle, config.path()).unwrap();

        let mut standalone = mod_info("BaseLib", "1.0.0", Some("standalone-hash"));
        standalone.name = "BaseLib".into();
        standalone.folder_name = Some("BaseLib".into());
        standalone.mod_id = Some("BaseLib".into());
        standalone.source = Some("github:basemod/baselib".into());
        let standalone_id = ensure_mod_info_id(&mut standalone, config.path()).unwrap();

        let mut legacy_bad_record = mod_info("BaseLib", "2.1", Some("legacy-bad-hash"));
        legacy_bad_record.name = "BaseLib".into();
        legacy_bad_record.folder_name = Some("BaseLib".into());
        legacy_bad_record.mod_id = Some("BaseLib".into());
        legacy_bad_record.source = Some(bundle_source.into());
        let legacy_id = ensure_mod_info_id(&mut legacy_bad_record, config.path()).unwrap();
        cache_mod_version_by_id(
            &mut legacy_bad_record,
            base.path(),
            cache.path(),
            config.path(),
        )
        .expect("legacy cached artifact should be written");

        let installed = vec![bundle.clone(), standalone.clone()];
        let bundle_options = local_version_options_for_target(
            &installed,
            &[],
            config.path(),
            cache.path(),
            &bundle.name,
            Some(&bundle_id),
            bundle.mod_id.as_deref(),
        );
        assert!(
            bundle_options
                .iter()
                .any(|option| option.mod_version_id == legacy_id),
            "legacy member-shaped cache record should recover onto the owning bundle row"
        );

        let standalone_options = local_version_options_for_target(
            &installed,
            &[],
            config.path(),
            cache.path(),
            &standalone.name,
            Some(&standalone_id),
            standalone.mod_id.as_deref(),
        );
        assert!(
            standalone_options
                .iter()
                .all(|option| option.mod_version_id != legacy_id),
            "standalone member row must not offer the cached bundle artifact"
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
    fn stale_installed_source_version_keeps_exact_cached_nexus_choices_distinct() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let source = "https://www.nexusmods.com/slaythespire2/mods/46";

        write_manifest(base.path(), "1.4.3");
        let mut installed = mod_info("Watcher", "1.4.3", Some("watcher-current"));
        installed.source = Some(source.into());
        let installed_id = ensure_mod_info_id(&mut installed, config.path()).unwrap();
        set_record_source_version(config.path(), &installed_id, Some("1.4.3")).unwrap();
        crate::mod_sources::attach_nexus_source(
            "Watcher",
            installed.folder_name.as_deref(),
            source.into(),
            "slaythespire2".into(),
            46,
            config.path(),
        );
        crate::mod_sources::update_installed_version_from_source(
            installed.folder_name.as_deref().unwrap(),
            "1.4.3",
            "nexus",
            config.path(),
        );

        write_manifest(base.path(), "1.4.22");
        let mut cached = mod_info("Watcher", "1.4.22", Some("watcher-cached-1422"));
        cached.source = Some(source.into());
        let cached_path = cache_mod_version_by_id_with_source_version(
            &mut cached,
            base.path(),
            cache.path(),
            config.path(),
            Some("1.4.22"),
        )
        .expect("cached beta Nexus artifact should be written");
        let cached_id = cached.mod_version_id.clone().unwrap();
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
                .any(|option| option.mod_version_id == cached_id
                    && option.version == "1.4.22"
                    && option.cached
                    && !option.installed),
            "stale installed_version metadata must not hide the cached beta Nexus option"
        );
        assert!(
            has_local_version_for_mod(config.path(), cache.path(), &installed, "1.4.22"),
            "cached 1.4.22 should suppress the exact advertised 1.4.22 version"
        );
        assert!(
            !has_local_version_for_mod(config.path(), cache.path(), &installed, "1.4.3"),
            "cached 1.4.22 must not suppress a different main-branch 1.4.3 file"
        );

        write_manifest(base.path(), "1.4.3");
        let mut cached_exact = mod_info("Watcher", "1.4.3", Some("watcher-cached-main-143"));
        cached_exact.source = Some(source.into());
        cache_mod_version_by_id_with_source_version(
            &mut cached_exact,
            base.path(),
            cache.path(),
            config.path(),
            Some("1.4.3"),
        )
        .expect("exact cached Nexus artifact should be written");
        assert!(
            has_local_version_for_mod(config.path(), cache.path(), &installed, "1.4.3"),
            "cached 1.4.3 should suppress only the exact advertised 1.4.3 version"
        );
    }

    #[test]
    fn nested_watcher_cached_archive_shape_stays_selectable() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let source = "https://www.nexusmods.com/slaythespire2/mods/46";

        let mut installed = mod_info("Watcher", "1.4.3", Some("watcher-current"));
        installed.folder_name = Some("Watcher".into());
        installed.mod_id = Some("Watcher".into());
        installed.source = Some(source.into());
        installed.files = vec!["Watcher/Watcher.json".into()];
        ensure_mod_info_id(&mut installed, config.path()).unwrap();

        let nested_manifest = base.path().join("Watcher/Watcher/Watcher.json");
        fs::create_dir_all(nested_manifest.parent().unwrap()).unwrap();
        fs::write(
            &nested_manifest,
            r#"{"id":"Watcher","name":"Watcher","version":"1.4.20"}"#,
        )
        .unwrap();
        let mut cached = mod_info("Watcher", "1.4.20", Some("watcher-nested-cache"));
        cached.folder_name = Some("Watcher".into());
        cached.mod_id = Some("Watcher".into());
        cached.source = Some(source.into());
        cached.files = vec!["Watcher/Watcher/Watcher.json".into()];

        let cached_path = cache_mod_version_by_id_with_source_version(
            &mut cached,
            base.path(),
            cache.path(),
            config.path(),
            Some("1.4.20"),
        )
        .expect("nested Watcher archive should be cached");
        let cached_id = cached.mod_version_id.clone().unwrap();
        let file = fs::File::open(&cached_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(
            archive.by_name("Watcher/Watcher/Watcher.json").is_ok(),
            "nested cache archive should preserve the real Watcher path shape"
        );

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
                .any(|option| option.mod_version_id == cached_id
                    && option.version == "1.4.20"
                    && option.cached),
            "nested Watcher cache should become a selectable stored option"
        );
    }

    #[test]
    fn local_options_collapse_duplicate_stored_artifacts() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let mut installed = mod_info("BaseLib", "3.2.1", Some("hash-321"));
        installed.name = "BaseLib".into();
        installed.folder_name = Some("BaseLib".into());
        installed.mod_id = Some("BaseLib".into());
        installed.source = Some("github:basemod/baselib".into());
        let installed_id = ensure_mod_info_id(&mut installed, config.path()).unwrap();

        let mut db = load(config.path());
        for (id, version, hash) in [
            ("dup-a", "3.2.1", "hash-321"),
            ("dup-b", "3.2.1", "hash-321"),
            ("distinct-new", "3.3.1", "hash-331"),
        ] {
            db.records.insert(
                id.into(),
                ModVersionRecord {
                    id: id.into(),
                    identity_key: format!("legacy:{id}"),
                    aliases: Vec::new(),
                    name: "BaseLib".into(),
                    version: version.into(),
                    source_version: None,
                    folder_name: Some("BaseLib".into()),
                    mod_id: Some("BaseLib".into()),
                    bundle_member_ids: Vec::new(),
                    source: Some("github:basemod/baselib".into()),
                    content_hash: Some(hash.into()),
                    archive_sha256: None,
                    cache_relpath: Some(cache_relpath_for_id(id)),
                    ..ModVersionRecord::default()
                },
            );
            let path = cache_path_for_id(cache.path(), id);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"placeholder").unwrap();
        }
        save(&db, config.path()).unwrap();

        let options = local_version_options_for_target(
            &[installed.clone()],
            &[],
            config.path(),
            cache.path(),
            &installed.name,
            Some(&installed_id),
            installed.mod_id.as_deref(),
        );
        let base_321 = options
            .iter()
            .filter(|option| option.version == "3.2.1")
            .collect::<Vec<_>>();
        assert_eq!(
            base_321.len(),
            1,
            "duplicate stored copies of the same artifact should collapse"
        );
        assert_eq!(base_321[0].mod_version_id, installed_id);
        assert!(
            options.iter().any(|option| option.version == "3.3.1"),
            "distinct artifacts must remain selectable"
        );
    }

    #[test]
    fn readable_nexus_filename_version_suppresses_update_pill() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let source_version = crate::mods::bundle::nexus_file_version(Path::new(
            "EndRunGraph v0.3.2 Release STS2 V0.103.2 (1).zip",
        ))
        .expect("readable Nexus filename should expose the mod file version");

        write_manifest(base.path(), "0.3.1");
        let mut installed = mod_info("End Run Graph", "0.3.1", Some("active-031"));
        let installed_id = ensure_mod_info_id(&mut installed, config.path()).unwrap();

        write_manifest(base.path(), "0.3.1");
        let mut cached = mod_info("End Run Graph", "0.3.1", Some("downloaded-032"));
        let cached_path = cache_mod_version_by_id_with_source_version(
            &mut cached,
            base.path(),
            cache.path(),
            config.path(),
            Some(&source_version),
        )
        .expect("readable Nexus source-version cache should be written");
        let cached_id = cached
            .mod_version_id
            .clone()
            .expect("cached artifact should have a source-version id");

        assert_ne!(
            installed_id, cached_id,
            "filename v0.3.2 must not collapse into the active manifest v0.3.1 record"
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
                .any(|option| option.mod_version_id == cached_id
                    && option.version == "0.3.2"
                    && option.cached
                    && !option.installed),
            "readable Nexus filename version should surface as a cached 0.3.2 option"
        );
        assert!(
            has_local_version_for_mod(config.path(), cache.path(), &installed, "0.3.2"),
            "cached readable Nexus v0.3.2 should suppress another update pill for latest 0.3.2"
        );
    }

    #[test]
    fn batched_local_version_options_match_per_target_for_large_library() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "1.0.0");

        let mut installed = Vec::new();
        let mut profile = crate::profiles::Profile {
            id: "profile-id".into(),
            name: "Large Pack".into(),
            game_version: None,
            created_by: None,
            mods: Vec::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: std::collections::HashMap::new(),
        };

        for index in 0..120 {
            let name = format!("Test {}", index);
            let folder = format!("Mod{}", index);
            let mod_id = format!("mod-id-{}", index);
            let hash = format!("hash-{}", index);
            let mut info = mod_info(&name, "1.0.0", Some(&hash));
            info.folder_name = Some(folder.clone());
            info.mod_id = Some(mod_id.clone());
            info.source = Some(format!("github:owner/repo{}", index));
            let id = ensure_mod_info_id(&mut info, config.path()).unwrap();

            if index % 10 == 0 {
                profile.mods.push(ProfileMod {
                    mod_version_id: Some(id.clone()),
                    name: name.clone(),
                    version: "1.0.0".into(),
                    source: info.source.clone(),
                    hash: info.hash.clone(),
                    files: info.files.clone(),
                    folder_name: Some(folder.clone()),
                    mod_id: Some(mod_id.clone()),
                    enabled: true,
                    bundle_url: None,
                    bundle_sha256: None,
                    bundle_members: vec![],
                    bundle_member_ids: vec![],
                });
            }

            if index == 42 {
                let mut cached = info.clone();
                cached.mod_version_id = None;
                cached.hash = Some("hash-42-new".into());
                cache_mod_version_by_id_with_source_version(
                    &mut cached,
                    base.path(),
                    cache.path(),
                    config.path(),
                    Some("V2"),
                )
                .unwrap();
            }

            installed.push(info);
        }

        let profiles = vec![profile];
        let batched = local_version_options_by_mod_version_id(
            &installed,
            &profiles,
            config.path(),
            cache.path(),
        );

        for info in &installed {
            let id = info
                .mod_version_id
                .as_deref()
                .expect("installed mod should have a local version id");
            let per_target = local_version_options_for_target(
                &installed,
                &profiles,
                config.path(),
                cache.path(),
                &info.name,
                Some(id),
                info.mod_id.as_deref(),
            );
            assert_eq!(
                batched.get(id).cloned().unwrap_or_default(),
                per_target,
                "batched options should match per-target options for {}",
                info.name
            );
        }
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

    #[test]
    fn remove_local_mod_version_deletes_unused_cached_record() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "4.0.0");
        let mut stale = mod_info("Test", "4.0.0", Some("stale"));
        let stale_id = ensure_mod_info_id(&mut stale, config.path()).unwrap();
        let stale_zip =
            cache_mod_version_by_id(&mut stale, base.path(), cache.path(), config.path()).unwrap();

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[],
            &[],
            &stale_id,
        )
        .unwrap();

        assert!(!stale_zip.exists());
        assert!(record_by_id(config.path(), &stale_id).is_none());
    }

    #[test]
    fn remove_local_mod_version_keeps_disabled_sibling_for_saved_source_version() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "0.16.2");
        let mut saved = mod_info("Test", "0.16.2", Some("same-content"));
        let saved_zip = cache_mod_version_by_id_with_source_version(
            &mut saved,
            base.path(),
            cache.path(),
            config.path(),
            Some("V1"),
        )
        .unwrap();
        let saved_id = saved.mod_version_id.clone().unwrap();

        write_manifest(disabled.path(), "0.16.2");
        let mut stored = mod_info("Test", "0.16.2", Some("same-content"));
        stored.enabled = false;
        stored.mod_version_id = Some(saved_id.clone());

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[stored],
            &[],
            &saved_id,
        )
        .unwrap();

        assert!(!saved_zip.exists());
        assert!(record_by_id(config.path(), &saved_id).is_none());
        assert!(
            disabled.path().join("Mod/manifest.json").exists(),
            "removing saved V1 must not delete the stored manifest-version copy"
        );
    }

    #[test]
    fn remove_local_mod_version_keeps_active_sibling_for_saved_source_version() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "0.16.2");
        let mut saved = mod_info("Test", "0.16.2", Some("same-content"));
        let saved_zip = cache_mod_version_by_id_with_source_version(
            &mut saved,
            base.path(),
            cache.path(),
            config.path(),
            Some("V1"),
        )
        .unwrap();
        let saved_id = saved.mod_version_id.clone().unwrap();

        let mut active = mod_info("Test", "0.16.2", Some("same-content"));
        active.mod_version_id = Some(saved_id.clone());

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[active],
            &[],
            &saved_id,
        )
        .unwrap();

        assert!(!saved_zip.exists());
        assert!(record_by_id(config.path(), &saved_id).is_none());
        assert!(
            base.path().join("Mod/manifest.json").exists(),
            "removing saved V1 must not delete the active manifest-version copy"
        );
    }

    #[test]
    fn preview_local_mod_version_removal_reports_saved_sibling_as_cache_only() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "0.16.2");
        let mut saved = mod_info("Test", "0.16.2", Some("same-content"));
        cache_mod_version_by_id_with_source_version(
            &mut saved,
            base.path(),
            cache.path(),
            config.path(),
            Some("V1"),
        )
        .unwrap();
        let saved_id = saved.mod_version_id.clone().unwrap();

        let mut active = mod_info("Test", "0.16.2", Some("same-content"));
        active.mod_version_id = Some(saved_id.clone());

        let preview = preview_local_mod_version_removal(
            config.path(),
            cache.path(),
            &[active],
            &[],
            &saved_id,
        )
        .unwrap();

        assert_eq!(preview.target.version, "V1");
        assert!(preview.target.cached);
        assert!(!preview.target.installed);
        assert!(!preview.target.installed_enabled);
        assert!(preview.can_delete_directly);
    }

    #[test]
    fn workshop_manifest_version_ignores_stale_installed_source_metadata() {
        let config = tempfile::tempdir().unwrap();
        crate::mod_sources::update_installed_version_from_source(
            "3747602295",
            "0.2.26",
            "nexus",
            config.path(),
        );

        let mut workshop = workshop_mod_info("3747602295", "0.4.41");
        enrich_mods_with_versions(std::slice::from_mut(&mut workshop), config.path());

        assert_eq!(
            installed_source_version_label_for_mod(&workshop, config.path()).as_deref(),
            Some("0.4.41")
        );
        let record = record_by_id(config.path(), workshop.mod_version_id.as_deref().unwrap())
            .expect("Workshop scan should create a version record");
        assert_eq!(record.version, "0.4.41");
        assert_eq!(record.source_version, None);
    }

    #[test]
    fn remove_local_mod_version_blocks_installed_workshop_record() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        let mut workshop = workshop_mod_info("3747602295", "0.4.41");
        let workshop_id = ensure_mod_info_id(&mut workshop, config.path()).unwrap();

        let err = remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[workshop],
            &[],
            &workshop_id,
        )
        .unwrap_err();

        assert!(err.to_string().contains("Steam Workshop"));
        assert!(record_by_id(config.path(), &workshop_id).is_some());
    }

    #[test]
    fn remove_local_mod_version_prunes_stale_workshop_metadata_record() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        let mut stale = workshop_mod_info("3747602295", "0.2.26");
        let stale_id = ensure_mod_info_id(&mut stale, config.path()).unwrap();

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[],
            &[],
            &stale_id,
        )
        .unwrap();

        assert!(record_by_id(config.path(), &stale_id).is_none());
    }

    #[test]
    fn remove_local_mod_version_blocks_active_installed_version() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        let mut active = mod_info("Test", "1.0.0", Some("active"));
        let active_id = ensure_mod_info_id(&mut active, config.path()).unwrap();

        let err = remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[active],
            &[],
            &active_id,
        )
        .unwrap_err();

        assert!(err.to_string().contains("active version"));
        assert!(record_by_id(config.path(), &active_id).is_some());
    }

    #[test]
    fn remove_local_mod_version_blocks_profile_used_version() {
        let base = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(base.path(), "2.0.0");
        let mut profile_used = mod_info("Test", "2.0.0", Some("profile"));
        let profile_used_id = ensure_mod_info_id(&mut profile_used, config.path()).unwrap();
        let profile_used_zip =
            cache_mod_version_by_id(&mut profile_used, base.path(), cache.path(), config.path())
                .unwrap();
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

        let err = remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[],
            &[profile],
            &profile_used_id,
        )
        .unwrap_err();

        assert!(err.to_string().contains("Stable"));
        assert!(profile_used_zip.exists());
        assert!(record_by_id(config.path(), &profile_used_id).is_some());
    }

    #[test]
    fn remove_local_mod_version_deletes_disabled_stored_copy() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(disabled.path(), "1.0.0");
        let mut stored = mod_info("Test", "1.0.0", Some("stored"));
        stored.enabled = false;
        let stored_id = ensure_mod_info_id(&mut stored, config.path()).unwrap();

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[stored],
            &[],
            &stored_id,
        )
        .unwrap();

        assert!(!disabled.path().join("Mod/manifest.json").exists());
        assert!(record_by_id(config.path(), &stored_id).is_none());
    }

    #[test]
    fn remove_local_copy_is_provider_scoped_and_does_not_recreate_beside_workshop() {
        let cache = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let disabled = tempfile::tempdir().unwrap();

        write_manifest(disabled.path(), "1.0.0");
        let mut local = mod_info("Test", "1.0.0", Some("stored"));
        local.enabled = false;
        local.mod_id = Some("shared-runtime".into());
        let local_id = ensure_mod_info_id(&mut local, config.path()).unwrap();

        let mut workshop = workshop_mod_info("3747602295", "1.0.0");
        workshop.mod_id = Some("shared-runtime".into());
        let workshop_id = ensure_mod_info_id(&mut workshop, config.path()).unwrap();
        assert_ne!(
            local_id, workshop_id,
            "provider identity must remain distinct"
        );

        remove_local_mod_version(
            config.path(),
            cache.path(),
            disabled.path(),
            &[local, workshop.clone()],
            &[],
            &local_id,
        )
        .unwrap();

        assert!(!disabled.path().join("Mod/manifest.json").exists());
        assert!(record_by_id(config.path(), &local_id).is_none());
        assert!(record_by_id(config.path(), &workshop_id).is_some());

        let mut remaining = vec![workshop];
        enrich_mods_with_versions(&mut remaining, config.path());
        assert_eq!(
            remaining[0].mod_version_id.as_deref(),
            Some(workshop_id.as_str())
        );
        assert!(
            record_by_id(config.path(), &local_id).is_none(),
            "rescanning the Workshop sibling must not recreate the deleted local provider"
        );
    }
}
