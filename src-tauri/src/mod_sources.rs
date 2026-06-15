use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::download::{
    fetch_latest_release, quota_is_low, search_github_repos_relevance,
    search_github_repos_relevance_outcome, GitHubRepo, RateLimitInfo, SearchOutcome,
};
use crate::error::{AppError, Result};
use crate::mods::ModInfo;
use crate::state::AppState;

// ── Types ───────────────────────────────────────────────────────────────────

/// Source links for a single mod, persisted in mod_sources.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModSourceEntry {
    /// GitHub owner/repo (e.g. "owner/repo")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
    /// Whether the GitHub link was auto-detected (vs manually set by user).
    /// Auto-detected links stay lower-confidence until Source Editor/inline update promotes them.
    #[serde(default, skip_serializing_if = "is_false")]
    pub github_auto_detected: bool,
    /// Full Nexus Mods URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    /// Nexus game domain (e.g. "slaythespire2")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_game_domain: Option<String>,
    /// Nexus mod ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_mod_id: Option<u64>,
    /// Tracks the version (release tag) that was last installed via the updater
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// If true, this mod is pinned — excluded from update checks, audit flags,
    /// and auto-install from Downloads. Must be updated manually.
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    /// Free-form user note about the mod. Surfaces in the mod row so the user
    /// can remember things like "downloaded from Patreon" or "compat patch
    /// for the v1.8 build". Not used for matching, search, or update logic —
    /// purely informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// A non-GitHub, non-Nexus URL the user wants to remember for this mod
    /// (Patreon page, Discord thread, an X post — whatever they got the mod
    /// from). Surfaces as an external-link button alongside the existing
    /// GitHub/Nexus chips. Single URL by design; a typed list can be added
    /// later without breaking this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    /// Manager-owned organization tags/categories. These are purely
    /// presentation/filtering metadata and are never used for mod identity,
    /// updates, or profile matching.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Optional user-facing display name. Stored separately from manifest
    /// identity so users can label confusing upstream mods without changing
    /// profile/update matching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Optional user-facing description shown in the Mods list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_description: Option<String>,
    /// When set and equal to the audit's `latest_release_with_assets_tag`,
    /// the audit's update suggestion is suppressed for this mod. The user
    /// uses this when the website's announced version doesn't actually
    /// match what's inside the file (Nexus version drift is the common case),
    /// or when they've decided to skip a specific release. When a NEWER
    /// release appears upstream, this auto-expires — `snoozed_until_tag`
    /// is matched against the actual current release tag or Nexus version,
    /// so a new upstream version stops the
    /// match and the suggestion comes back. Distinct from `pinned`, which
    /// is a hard freeze on auto-update entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until_tag: Option<String>,
    /// SHA256 of each tracked config file at install time, keyed by the
    /// file's path relative to the mod folder (forward-slash separators,
    /// even on Windows, to match the rest of the codebase).
    ///
    /// Compared against on-disk hashes during the next update to decide
    /// which files the user has edited and must be preserved. Rewritten
    /// at the end of every install — short-lived rolling cache, not a
    /// permanent audit log. Empty when the mod was last installed before
    /// this feature shipped, in which case no preservation runs (update
    /// behaves as it did pre-v1.3.6).
    ///
    /// Tracked extensions are restricted to actual config formats —
    /// .cfg, .ini, .toml, .txt. STS2's .json files are game-readable
    /// manifest data, never user-tunable, so they're intentionally
    /// excluded to avoid preserving a stale manifest into a fresh
    /// install.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub config_hashes: HashMap<String, String>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// The entire mod sources database. Entries are keyed either by
/// `folder_name` (newer write path; preferred since folders are unique
/// on disk) or by display name (legacy). See `lookup_entry` for the
/// resolution order.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModSourcesDb {
    pub mods: HashMap<String, ModSourceEntry>,
}

/// Folder-first source-entry lookup. Use this instead of `db.mods.get(&m.name)`
/// at every read site so two mods sharing a display name don't share state
/// in the sources DB (pin, installed_version, github_repo, nexus_url).
///
/// Order matters:
///   1. `folder_name` — unique on disk; matches new pin writes
///   2. display `name` — matches legacy pin writes and any external
///      tooling that still keys by name
///   3. `mod_id` — last resort, used by mods that ship a stable id in
///      their manifest
pub fn lookup_entry<'a>(
    db: &'a HashMap<String, ModSourceEntry>,
    folder_name: Option<&str>,
    display_name: &str,
    mod_id: Option<&str>,
) -> Option<&'a ModSourceEntry> {
    folder_name
        .and_then(|f| db.get(f))
        .or_else(|| db.get(display_name))
        .or_else(|| mod_id.and_then(|i| db.get(i)))
}

fn compact_source_identity(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn trim_windows_copy_suffix(stem: &str) -> &str {
    let trimmed = stem.trim();
    let Some(prefix) = trimmed.strip_suffix(')') else {
        return trimmed;
    };
    let Some(open_idx) = prefix.rfind(" (") else {
        return trimmed;
    };
    if prefix[open_idx + 2..].chars().all(|c| c.is_ascii_digit()) {
        prefix[..open_idx].trim_end()
    } else {
        trimmed
    }
}

fn strip_nexus_download_suffix(stem: &str) -> String {
    let stem = trim_windows_copy_suffix(stem);
    let bytes = stem.as_bytes();
    let mut cut_pos = stem.len();
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
        stem[..cut_pos].trim_end().to_string()
    } else {
        stem.to_string()
    }
}

fn nexus_download_stem_matches_mod(
    stem: &str,
    folder_name: Option<&str>,
    display_name: &str,
) -> bool {
    let cleaned = compact_source_identity(&strip_nexus_download_suffix(stem));
    if cleaned.len() < 4 {
        return false;
    }

    [folder_name, Some(display_name)]
        .into_iter()
        .flatten()
        .any(|candidate| {
            let candidate = compact_source_identity(candidate);
            if candidate.len() < 4 {
                return false;
            }
            if cleaned == candidate {
                return true;
            }
            cleaned
                .strip_prefix(&candidate)
                .map(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false)
        })
}

fn find_nexus_download_stem_entry<'a>(
    db: &'a HashMap<String, ModSourceEntry>,
    folder_name: Option<&str>,
    display_name: &str,
) -> Option<(&'a str, &'a ModSourceEntry)> {
    db.iter().find_map(|(key, entry)| {
        let has_nexus_source = entry.nexus_url.is_some() || entry.nexus_mod_id.is_some();
        if has_nexus_source && nexus_download_stem_matches_mod(key, folder_name, display_name) {
            Some((key.as_str(), entry))
        } else {
            None
        }
    })
}

fn merge_missing_entry_fields(dest: &mut ModSourceEntry, old: ModSourceEntry) -> bool {
    let mut changed = false;

    if old.github_repo.is_some()
        && (dest.github_repo.is_none() || (dest.github_auto_detected && !old.github_auto_detected))
    {
        dest.github_repo = old.github_repo;
        dest.github_auto_detected = old.github_auto_detected;
        changed = true;
    }
    if dest.nexus_url.is_none() && old.nexus_url.is_some() {
        dest.nexus_url = old.nexus_url;
        dest.nexus_game_domain = old.nexus_game_domain;
        dest.nexus_mod_id = old.nexus_mod_id;
        changed = true;
    }
    if !dest.pinned && old.pinned {
        dest.pinned = true;
        changed = true;
    }
    if dest.installed_version.is_none() && old.installed_version.is_some() {
        dest.installed_version = old.installed_version;
        changed = true;
    }
    if dest.note.is_none() && old.note.is_some() {
        dest.note = old.note;
        changed = true;
    }
    if dest.custom_url.is_none() && old.custom_url.is_some() {
        dest.custom_url = old.custom_url;
        changed = true;
    }
    if dest.tags.is_empty() && !old.tags.is_empty() {
        dest.tags = old.tags;
        changed = true;
    }
    if dest.display_name.is_none() && old.display_name.is_some() {
        dest.display_name = old.display_name;
        changed = true;
    }
    if dest.display_description.is_none() && old.display_description.is_some() {
        dest.display_description = old.display_description;
        changed = true;
    }
    if dest.snoozed_until_tag.is_none() && old.snoozed_until_tag.is_some() {
        dest.snoozed_until_tag = old.snoozed_until_tag;
        changed = true;
    }
    if dest.config_hashes.is_empty() && !old.config_hashes.is_empty() {
        dest.config_hashes = old.config_hashes;
        changed = true;
    }

    changed
}

/// Result of auto-detecting sources for mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDetectResult {
    pub matched: Vec<AutoDetectMatch>,
    pub unmatched: Vec<String>,
    /// How many installed mods we skipped because they already had a
    /// source linked (GitHub or Nexus). Surfaced so the UI can
    /// distinguish "auto-detect found nothing" from "auto-detect had
    /// nothing to do because every mod already has a source".
    #[serde(default)]
    pub skipped_already_linked: u32,
    /// `true` when at least one search call was cut short by GitHub's
    /// rate-limiter (HTTP 403/429). When true the `not_checked` list
    /// contains mods whose search was abandoned — they are NOT "no match",
    /// they simply weren't searched. The UI shows a prominent banner.
    #[serde(default)]
    pub rate_limited: bool,
    /// Unix timestamp (seconds) when the GitHub search quota is expected
    /// to reset. Only meaningful when `rate_limited` is true. Used by
    /// the UI to show "try again in ~N minutes".
    #[serde(default)]
    pub rate_limit_reset_at: Option<i64>,
    /// Mods whose search was abandoned due to rate-limiting (subset of
    /// what would have been `unmatched`). These must NOT be shown as
    /// "no candidates" — they simply weren't searched.
    #[serde(default)]
    pub not_checked: Vec<String>,
    /// Whether an authenticated GitHub token was used. Authenticated
    /// searches get 30 req/min vs 10/min unauthenticated, so this is
    /// useful context when diagnosing rate-limit hits.
    #[serde(default)]
    pub authenticated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoDetectMatch {
    pub mod_name: String,
    pub github_repo: String,
    pub confidence: String,
}

// ── Persistence ─────────────────────────────────────────────────────────────

fn sources_path(config_path: &Path) -> std::path::PathBuf {
    config_path.join("mod_sources.json")
}

pub fn load_sources(config_path: &Path) -> ModSourcesDb {
    let path = sources_path(config_path);
    if !path.exists() {
        return ModSourcesDb::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(db) => db,
            Err(e) => {
                // A present-but-corrupt file is a data-loss hazard: defaulting
                // here silently discards every saved source link. Don't stay
                // silent — surface it so the user/log shows why links vanished.
                // (Empty/whitespace-only files are a normal "no data" state.)
                if !content.trim().is_empty() {
                    log::error!(
                        "Failed to parse mod sources at {}: {} — falling back to empty defaults (saved source links will not be loaded)",
                        path.display(),
                        e
                    );
                }
                ModSourcesDb::default()
            }
        },
        Err(_) => ModSourcesDb::default(),
    }
}

pub fn save_sources(db: &ModSourcesDb, config_path: &Path) -> Result<()> {
    let path = sources_path(config_path);
    let json = serde_json::to_string_pretty(db)?;
    crate::fs_safety::atomic_write(&path, json.as_bytes())?;
    Ok(())
}

/// Load the set of pinned mod names from mod_sources.json.
/// Returns a set of names — the caller can match these against ModInfo.name,
/// ModInfo.folder_name, or ModInfo.mod_id since pinning is keyed by display name
/// in the sources DB but mods on disk may be matched by any of those identifiers.
pub fn load_pinned_set(config_path: &Path) -> std::collections::HashSet<String> {
    let db = load_sources(config_path);
    db.mods
        .iter()
        .filter(|(_, e)| e.pinned)
        .map(|(name, _)| name.clone())
        .collect()
}

/// Update just the installed_version for a mod in mod_sources.json.
pub fn update_installed_version(mod_name: &str, version: &str, config_path: &Path) {
    let mut db = load_sources(config_path);
    let entry = db.mods.entry(mod_name.to_string()).or_default();
    entry.installed_version = Some(version.to_string());
    if let Err(e) = save_sources(&db, config_path) {
        log::error!("Failed to save installed_version for '{}': {}", mod_name, e);
    }
}

/// Tauri event payload emitted whenever a mod update preserved one or
/// more user-edited config files. Frontend listens and shows a
/// non-blocking toast naming what was kept.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigsPreservedEvent {
    pub mod_name: String,
    pub files: Vec<String>,
}

/// Emit `mod-configs-preserved` when an update finalized with a
/// non-empty preserved list. No-op for empty lists so the frontend
/// doesn't need a separate "nothing to report" branch.
pub fn emit_configs_preserved<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    mod_name: &str,
    files: &[String],
) {
    use tauri::Emitter;
    if files.is_empty() {
        return;
    }
    let _ = app.emit(
        "mod-configs-preserved",
        ConfigsPreservedEvent {
            mod_name: mod_name.to_string(),
            files: files.to_vec(),
        },
    );
}

/// Tauri event payload emitted when a mod update could NOT re-apply one or
/// more user-edited config files (they were overwritten by the new release and
/// the restore failed). Frontend listens and shows a non-blocking WARNING toast
/// naming them so the user knows those edits need redoing.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigsLostEvent {
    pub mod_name: String,
    pub files: Vec<String>,
}

/// Emit `mod-configs-lost` when an update finalized with a non-empty lost
/// list. No-op for empty lists.
pub fn emit_configs_lost<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    mod_name: &str,
    files: &[String],
) {
    use tauri::Emitter;
    if files.is_empty() {
        return;
    }
    let _ = app.emit(
        "mod-configs-lost",
        ConfigsLostEvent {
            mod_name: mod_name.to_string(),
            files: files.to_vec(),
        },
    );
}

/// Read a mod's stored config-file hash snapshot. Returns an empty map
/// when the mod has no entry, no snapshot, or was last installed before
/// the config-overwrite-detection feature shipped — in any of those
/// cases the caller treats it as "no preservation possible" and the
/// update path behaves as it did pre-feature.
///
/// Lookup is folder-first (matches `enrich_mods_with_sources` and
/// every other read site) so a mod pinned / linked under its folder
/// name resolves to the same entry the snapshot was written under.
pub fn load_config_snapshot(
    folder_name: Option<&str>,
    mod_name: &str,
    config_path: &Path,
) -> HashMap<String, String> {
    let db = load_sources(config_path);
    lookup_entry(&db.mods, folder_name, mod_name, None)
        .map(|e| e.config_hashes.clone())
        .unwrap_or_default()
}

/// Replace a mod's config-file hash snapshot with a fresh one (called
/// after every successful install / update). Folder-first write key.
pub fn save_config_snapshot(
    folder_name: Option<&str>,
    mod_name: &str,
    snapshot: HashMap<String, String>,
    config_path: &Path,
) {
    let mut db = load_sources(config_path);
    let key = folder_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_name.to_string());
    let entry = db.mods.entry(key).or_default();
    entry.config_hashes = snapshot;
    if let Err(e) = save_sources(&db, config_path) {
        log::error!(
            "Failed to save config snapshot for '{}' (folder {:?}): {}",
            mod_name,
            folder_name,
            e
        );
    }
}

/// Carry a mod's source bindings (github repo, nexus link, pin state) from
/// `old_name` to `new_name` after the install renamed the mod.
///
/// The audit looks up sources by mod name, so when an updated zip declares
/// a different `Name` field in its manifest (e.g. "Show Player Hand Cards"
/// → "ShowPlayerHandCards", or BAKAOLC's STS2-ShowPlayerHandCards repo
/// changing its manifest casing) the old entry gets stranded and the new
/// entry has nothing — the audit then reports "no source" and the user
/// has to relink the repo manually. This is what the user reported.
///
/// We move the link, the pin state, the source-detection origin, and the
/// previously-recorded installed version. We DON'T delete the old entry
/// because other parts of the app (subscription manifests, exported
/// modpacks) may still reference it. Both entries pointing at the same
/// repo is harmless; an empty new entry is not.
pub fn migrate_source_entry(old_name: &str, new_name: &str, config_path: &Path) {
    if old_name == new_name {
        return;
    }
    let mut db = load_sources(config_path);
    let old = match db.mods.get(old_name).cloned() {
        Some(e) => e,
        None => return, // nothing to migrate
    };
    let dest = db.mods.entry(new_name.to_string()).or_default();
    merge_missing_entry_fields(dest, old);
    if let Err(e) = save_sources(&db, config_path) {
        log::error!(
            "Failed to migrate source entry from '{}' to '{}': {}",
            old_name,
            new_name,
            e
        );
    } else {
        log::info!(
            "Migrated source entry on rename: '{}' → '{}'",
            old_name,
            new_name
        );
    }
}

/// Carry a mod's source entry forward across an install/update where the
/// folder name and/or display name may have changed. The "fixed" cousin of
/// `migrate_source_entry`: that one only knows about display names and
/// strands folder-keyed entries, which was the documented Nexus-update
/// "link reset" bug (user feedback v1.x).
///
/// Lookup order matches `lookup_entry` (folder-first → name → mod_id).
/// Destination key prefers `new_folder` over `new_name` to match the
/// folder-first write convention the rest of the codebase already follows.
///
/// Fields are MERGED rather than overwritten — we only fill an empty
/// destination slot from the old entry. This matters when the new entry
/// already exists (e.g. someone set a fresh Nexus link mid-install): we
/// preserve their newer choice, only filling in fields they hadn't set.
///
/// We don't delete the old entry. Other parts of the app (subscriptions,
/// modpacks) may still reference it by the old key; leaving it harmless
/// is preferable to breaking those references. The new entry takes
/// precedence on read because of the lookup order.
pub fn carry_source_entry(
    old_folder: Option<&str>,
    old_name: &str,
    new_folder: Option<&str>,
    new_name: &str,
    config_path: &Path,
) {
    if old_folder == new_folder && old_name == new_name {
        return;
    }
    let mut db = load_sources(config_path);
    let old = match lookup_entry(&db.mods, old_folder, old_name, None).cloned() {
        Some(e) => e,
        None => return,
    };
    let dest_key = new_folder
        .map(|s| s.to_string())
        .unwrap_or_else(|| new_name.to_string());
    let dest = db.mods.entry(dest_key).or_default();
    merge_missing_entry_fields(dest, old);
    if let Err(e) = save_sources(&db, config_path) {
        log::error!(
            "Failed to carry source entry forward from ({:?}/{}) to ({:?}/{}): {}",
            old_folder,
            old_name,
            new_folder,
            new_name,
            e
        );
    } else {
        log::info!(
            "Carried source entry forward: ({:?}/{}) → ({:?}/{})",
            old_folder,
            old_name,
            new_folder,
            new_name
        );
    }
}

/// Attach a Nexus link to a mod's source entry. Folder-first write so the
/// resulting entry sits at the same key the rest of the codebase reads from
/// (`enrich_mods_with_sources`, audit, pin). The pre-fix path wrote keyed by
/// display name only, which fragmented state across two keys when the mod
/// already had a folder-keyed pin/version entry — the user-visible symptom
/// was "I set a Nexus URL, audit still says no source".
pub fn attach_nexus_source(
    mod_name: &str,
    folder_name: Option<&str>,
    nexus_url: String,
    game_domain: String,
    mod_id: u64,
    config_path: &Path,
) {
    let mut db = load_sources(config_path);
    let key = folder_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_name.to_string());
    let entry = db.mods.entry(key).or_default();
    entry.nexus_url = Some(nexus_url);
    entry.nexus_game_domain = Some(game_domain);
    entry.nexus_mod_id = Some(mod_id);
    if let Err(e) = save_sources(&db, config_path) {
        log::error!(
            "Failed to attach Nexus source for '{}' (folder {:?}): {}",
            mod_name,
            folder_name,
            e
        );
    }
}

/// Returns true when a mod already has a saved Nexus identity and a pending
/// Nexus install points at a different Nexus mod page. Fuzzy filename/name
/// matching must not cross this boundary, or one Nexus mod can overwrite
/// another when authors use similar archive names.
pub fn saved_nexus_source_conflicts(
    config_path: &Path,
    folder_name: Option<&str>,
    display_name: &str,
    manifest_mod_id: Option<&str>,
    pending_nexus_mod_id: u64,
) -> bool {
    let db = load_sources(config_path);
    let Some(entry) = lookup_entry(&db.mods, folder_name, display_name, manifest_mod_id) else {
        return false;
    };
    let saved_id = entry.nexus_mod_id.or_else(|| {
        entry
            .nexus_url
            .as_deref()
            .and_then(parse_source_url)
            .and_then(|parsed| parsed.nexus_mod_id)
    });
    saved_id.is_some_and(|id| id != pending_nexus_mod_id)
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/// Merge source metadata into ModInfo structs.
/// This enriches scanned mods with their linked GitHub/Nexus URLs.
/// Only overwrites URLs that are not already set from the manifest.
pub fn enrich_mods_with_sources(mods: &mut [ModInfo], config_path: &Path) {
    let mut db = load_sources(config_path);
    let mut db_dirty = false;
    for m in mods.iter_mut() {
        // Look up by folder_name FIRST, then display name, then mod_id.
        //
        // Folder-first matters when two mods share a display name: each
        // mod's folder is unique on disk, so pinning state stays per-folder
        // instead of leaking across both rows. Display-name lookup is kept
        // as a fallback for legacy entries created before pin_mod started
        // saving by folder.
        let folder_name = m.folder_name.as_deref();
        if let Some(folder) = folder_name {
            for legacy_key in [Some(m.name.as_str()), m.mod_id.as_deref()]
                .into_iter()
                .flatten()
                .filter(|key| *key != folder)
            {
                if let Some(old) = db.mods.get(legacy_key).cloned() {
                    let dest = db.mods.entry(folder.to_string()).or_default();
                    if merge_missing_entry_fields(dest, old) {
                        db_dirty = true;
                        log::info!(
                            "Merged legacy source entry '{}' into folder-keyed entry '{}' for '{}'",
                            legacy_key,
                            folder,
                            m.name
                        );
                    }
                }
            }
        }
        let entry = lookup_entry(&db.mods, folder_name, &m.name, m.mod_id.as_deref())
            .cloned()
            .or_else(|| {
                let (stranded_key, stranded_entry) =
                    find_nexus_download_stem_entry(&db.mods, folder_name, &m.name)?;
                let target_key = folder_name.unwrap_or(m.name.as_str());
                if stranded_key != target_key {
                    migrate_source_entry(stranded_key, target_key, config_path);
                    log::info!(
                        "Recovered Nexus source for '{}' from archive-stem key '{}' into '{}'",
                        m.name,
                        stranded_key,
                        target_key
                    );
                }
                Some(stranded_entry.clone())
            });
        if let Some(entry) = entry.as_ref() {
            // GitHub override precedence:
            //   * Manual entry (user typed into SourceEditor) WINS over the
            //     manifest URL — the user edited sources precisely because
            //     the manifest was wrong or missing. This matches
            //     `resolve_github_repo` in updater.rs, so the badge link,
            //     the editor's display value, and the audit's fetch all
            //     reference the same repo.
            //   * Auto-detected entry (the manager's own guess) only
            //     fills in when the manifest didn't provide a URL.
            //   * Normalize the stored value before formatting so legacy
            //     URL-form entries (pre-1.4.3 saves) don't produce
            //     "https://github.com/https://github.com/..." double
            //     prefixes.
            if let Some(ref repo) = entry.github_repo {
                let canonical = normalize_github_repo_input(repo);
                if let Some(c) = canonical {
                    // A manual entry always wins; an auto-detected guess only
                    // fills in when the manifest didn't supply a URL.
                    if !entry.github_auto_detected || m.github_url.is_none() {
                        m.github_url = Some(format!("https://github.com/{}", c));
                        m.github_auto_detected = entry.github_auto_detected;
                    }
                }
            }
            if m.nexus_url.is_none() {
                m.nexus_url = entry.nexus_url.clone();
            }
            m.pinned = entry.pinned;
            // User-saved extras: surface on the row so they show up next
            // to the GitHub/Nexus chips and the kebab menu.
            m.note = entry.note.clone();
            m.custom_url = entry.custom_url.clone();
            m.tags = entry.tags.clone();
            m.display_name = entry.display_name.clone();
            m.display_description = entry.display_description.clone();
        }
        // Also try to infer from the legacy `source` field if no explicit link
        if m.github_url.is_none() {
            if let Some(ref src) = m.source {
                if let Some(repo) = src.strip_prefix("github:") {
                    m.github_url = Some(format!("https://github.com/{}", repo));
                } else if src.starts_with("https://github.com/") {
                    m.github_url = Some(src.clone());
                }
            }
        }
    }
    if db_dirty {
        if let Err(e) = save_sources(&db, config_path) {
            log::error!("Failed to save merged legacy source entries: {}", e);
        }
    }
}

/// Parse a user-provided URL/shorthand into a ModSourceEntry.
/// Accepts:
///   - https://github.com/owner/repo
///   - github.com/owner/repo
///   - github:owner/repo
///   - owner/repo (assumed GitHub)
///   - https://www.nexusmods.com/game/mods/123
///   - nexus:game/mods/123
pub fn parse_source_url(url: &str) -> Option<ModSourceEntry> {
    let trimmed = url.trim();

    // GitHub shorthand: github:owner/repo
    if let Some(rest) = trimmed.strip_prefix("github:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            let repo = parts[1].trim_end_matches(".git");
            if repo.is_empty() {
                return None;
            }
            return Some(ModSourceEntry {
                github_repo: Some(format!("{}/{}", parts[0], repo)),
                ..Default::default()
            });
        }
    }

    // GitHub URL. Accepts normal URLs and the scheme-less form shown in
    // the SourceEditor hint (`github.com/owner/repo`).
    if trimmed.contains("github.com/") {
        let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else {
            format!("https://{}", trimmed.trim_start_matches("//"))
        };
        if let Ok(parsed) = url::Url::parse(&candidate) {
            let host = parsed.host_str()?.to_ascii_lowercase();
            if host != "github.com" && host != "www.github.com" {
                return None;
            }
            let segs: Vec<&str> = parsed
                .path_segments()
                .map(|s| s.collect())
                .unwrap_or_default();
            if segs.len() >= 2 && !segs[0].is_empty() && !segs[1].is_empty() {
                // Strip ".git" clone-URL suffix so the canonical form
                // matches what parse_github_url (in updater.rs) produces.
                let repo = segs[1].trim_end_matches(".git");
                if !repo.is_empty() {
                    return Some(ModSourceEntry {
                        github_repo: Some(format!("{}/{}", segs[0], repo)),
                        ..Default::default()
                    });
                }
            }
        }
    }

    // Nexus shorthand: nexus:game/mods/123
    if let Some(rest) = trimmed.strip_prefix("nexus:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 3 && parts[1] == "mods" {
            if let Ok(mod_id) = parts[2].parse::<u64>() {
                let game = parts[0].to_string();
                return Some(ModSourceEntry {
                    nexus_url: Some(format!(
                        "https://www.nexusmods.com/{}/mods/{}",
                        game, mod_id
                    )),
                    nexus_game_domain: Some(game),
                    nexus_mod_id: Some(mod_id),
                    ..Default::default()
                });
            }
        }
    }

    // Nexus URL
    if trimmed.contains("nexusmods.com/") {
        if let Ok(parsed) = url::Url::parse(trimmed) {
            let segs: Vec<&str> = parsed
                .path_segments()
                .map(|s| s.collect())
                .unwrap_or_default();
            if segs.len() >= 3 && segs[1] == "mods" {
                if let Ok(mod_id) = segs[2].parse::<u64>() {
                    return Some(ModSourceEntry {
                        nexus_url: Some(format!(
                            "https://www.nexusmods.com/{}/mods/{}",
                            segs[0], mod_id
                        )),
                        nexus_game_domain: Some(segs[0].to_string()),
                        nexus_mod_id: Some(mod_id),
                        ..Default::default()
                    });
                }
            }
        }
    }

    // Bare owner/repo (assume GitHub)
    if !trimmed.contains("://") && !trimmed.contains(' ') {
        let parts: Vec<&str> = trimmed.split('/').collect();
        if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            let repo = parts[1].trim_end_matches(".git");
            if repo.is_empty() {
                return None;
            }
            return Some(ModSourceEntry {
                github_repo: Some(format!("{}/{}", parts[0], repo)),
                ..Default::default()
            });
        }
    }

    None
}

pub fn source_entries_match(a: &ModSourceEntry, b: &ModSourceEntry) -> bool {
    let github_match = match (a.github_repo.as_deref(), b.github_repo.as_deref()) {
        (Some(left), Some(right)) => {
            normalize_github_repo_input(left).as_deref()
                == normalize_github_repo_input(right).as_deref()
        }
        _ => false,
    };
    if github_match {
        return true;
    }

    match (
        a.nexus_game_domain.as_deref(),
        a.nexus_mod_id,
        b.nexus_game_domain.as_deref(),
        b.nexus_mod_id,
    ) {
        (Some(left_domain), Some(left_id), Some(right_domain), Some(right_id)) => {
            left_id == right_id && left_domain.eq_ignore_ascii_case(right_domain)
        }
        _ => false,
    }
}

pub fn profile_source_matches_entry(source: Option<&str>, entry: &ModSourceEntry) -> bool {
    source
        .and_then(parse_source_url)
        .is_some_and(|parsed| source_entries_match(&parsed, entry))
}

pub fn mod_info_source_matches_entry(info: &ModInfo, entry: &ModSourceEntry) -> bool {
    if profile_source_matches_entry(info.source.as_deref(), entry) {
        return true;
    }
    if info
        .github_url
        .as_deref()
        .and_then(parse_source_url)
        .is_some_and(|parsed| source_entries_match(&parsed, entry))
    {
        return true;
    }
    info.nexus_url
        .as_deref()
        .and_then(parse_source_url)
        .is_some_and(|parsed| source_entries_match(&parsed, entry))
}

/// Normalize a user-provided GitHub repo input ("owner/repo", a full
/// GitHub URL, or the `github:owner/repo` shorthand) into the canonical
/// `owner/repo` form that everything else in the codebase expects.
///
/// Returns `None` for empty input, Nexus URLs, or anything we don't
/// recognize as a GitHub repo. The caller decides whether to clear the
/// stored value (empty input → None) or surface an error to the user
/// (non-empty unparseable → None).
///
/// Pre-1.4.3, `set_mod_sources_full` stored the raw user input as-is,
/// which let URL-form values flow through to the audit's
/// `parse_owner_repo` and produce malformed API calls like
/// `repos/https://github.com/owner/repo/releases/latest`. Routing every
/// save through this helper kills that class of bug at the source.
pub(crate) fn normalize_github_repo_input(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    parse_source_url(trimmed).and_then(|e| e.github_repo)
}

// ── Shared-profile source plumbing ───────────────────────────────────────────
//
// Two halves of the same job: the import side fills the importer's source
// DB from a curator's link (`fill_source_if_absent`), and the export side
// reads the curator's own source DB to stamp links into a pack they're
// publishing (`shareable_source_for`). Both are deliberately fill-/read-
// only so they can never clobber a user's hand-edited links, notes, pins,
// or preserved config hashes.

/// Merge a curator-provided source into the sources DB for `key`, filling
/// ONLY fields that are currently empty. An existing `github_repo` or
/// `nexus_url` is never overwritten, and `note` / `custom_url` / `tags` /
/// `pinned` / `config_hashes` are never touched. Returns `true` when a
/// field was actually written (so the caller can skip an unnecessary save).
///
/// Used by the modpack-install and subscription paths so a mod installed
/// from a shared pack shows its GitHub/Nexus chip instead of "Unlinked".
/// Because the fill is empty-only, re-installing or re-subscribing can't
/// undo a link the user later corrected by hand.
///
/// The GitHub case is marked `github_auto_detected = true`: the link came
/// from someone else's pack, not the user, so the updater treats it with
/// the same caution as any other auto-detected guess.
pub fn fill_source_if_absent(db: &mut ModSourcesDb, key: &str, parsed: &ModSourceEntry) -> bool {
    // Nothing to contribute — don't insert an empty entry that would just
    // serialize as noise.
    if parsed.github_repo.is_none() && parsed.nexus_url.is_none() {
        return false;
    }
    let entry = db.mods.entry(key.to_string()).or_default();
    let mut changed = false;
    if entry.github_repo.is_none() {
        if let Some(ref repo) = parsed.github_repo {
            entry.github_repo = Some(repo.clone());
            entry.github_auto_detected = true;
            changed = true;
        }
    }
    if entry.nexus_url.is_none() {
        if let Some(ref url) = parsed.nexus_url {
            entry.nexus_url = Some(url.clone());
            entry.nexus_game_domain = parsed.nexus_game_domain.clone();
            entry.nexus_mod_id = parsed.nexus_mod_id;
            changed = true;
        }
    }
    changed
}

/// Build a shareable `source` string for a profile mod from the curator's
/// sources DB, preferring a GitHub link and falling back to Nexus. Returns
/// the `github:owner/repo` or `nexus:domain/mods/id` shorthand that
/// `parse_source_url` round-trips, or `None` when the mod has no link.
///
/// This is what lets a shared (or re-shared) pack carry the curator's
/// source links: at publish time each mod is looked up here and the result
/// stamped into `ProfileMod.source`, so friends installing the pack get the
/// chip even when the mod's own manifest never declared a `Source`.
pub fn shareable_source_for(
    db: &ModSourcesDb,
    folder_name: Option<&str>,
    display_name: &str,
    mod_id: Option<&str>,
) -> Option<String> {
    let entry = lookup_entry(&db.mods, folder_name, display_name, mod_id)?;
    if let Some(ref repo) = entry.github_repo {
        if let Some(canonical) = normalize_github_repo_input(repo) {
            return Some(format!("github:{}", canonical));
        }
    }
    if let (Some(domain), Some(id)) = (entry.nexus_game_domain.as_ref(), entry.nexus_mod_id) {
        return Some(format!("nexus:{}/mods/{}", domain, id));
    }
    None
}

/// Fill-only merge of a shared pack's curator extras (note / custom link
/// / tags) into the local sources DB after install/sync (Solo FR,
/// 2026-06-10). The receiver's OWN notes/links/tags always win — a
/// curator's note never clobbers something the user wrote themselves.
/// Tags merge only when the local entry has none, so a user's curated
/// tag taxonomy isn't polluted by every pack they follow.
pub fn merge_shared_extras(
    extras: &HashMap<String, crate::profiles::SharedModExtras>,
    config_path: &Path,
) {
    if extras.is_empty() {
        return;
    }
    let mut db = load_sources(config_path);
    let mut changed = false;
    for (key, ex) in extras {
        let entry = db.mods.entry(key.clone()).or_default();
        if entry.note.is_none() && ex.note.is_some() {
            entry.note = ex.note.clone();
            changed = true;
        }
        if entry.custom_url.is_none() && ex.custom_url.is_some() {
            entry.custom_url = ex.custom_url.clone();
            changed = true;
        }
        if entry.tags.is_empty() && !ex.tags.is_empty() {
            entry.tags = ex.tags.clone();
            changed = true;
        }
    }
    if changed {
        if let Err(e) = save_sources(&db, config_path) {
            log::warn!("Failed to persist shared pack extras: {}", e);
        } else {
            log::info!("Merged curator notes/links for {} mod(s)", extras.len());
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

/// Get all mod source links.
#[tauri::command]
pub fn get_mod_sources(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<HashMap<String, ModSourceEntry>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let db = load_sources(&s.config_path);
    Ok(db.mods)
}

/// Set or update the source link for a mod. Accepts a URL or shorthand string.
/// The `source_url` can be a GitHub URL, Nexus URL, or shorthand.
/// Pass empty string to clear.
#[tauri::command]
pub fn set_mod_source(
    mod_name: String,
    folder_name: Option<String>,
    source_url: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    // Write under folder_name when provided so two same-named mods can
    // each carry independent source links. Falls back to display name
    // for legacy callers / mods with no folder.
    let key = folder_name.clone().unwrap_or_else(|| mod_name.clone());

    if source_url.trim().is_empty() {
        return clear_mod_source_links_from_path(&mod_name, folder_name.as_deref(), &s.config_path)
            .map_err(|e| e.to_string());
    }

    let entry = parse_source_url(&source_url).ok_or_else(|| {
        format!(
            "Could not parse source URL: {}. Try: github:owner/repo, a GitHub URL, or a Nexus Mods URL",
            source_url
        )
    })?;

    // Merge with existing entry (so setting GitHub doesn't erase Nexus and vice versa)
    let existing = db.mods.entry(key).or_default();
    if entry.github_repo.is_some() {
        existing.github_repo = entry.github_repo;
        existing.github_auto_detected = false; // manually set by user
    }
    if entry.nexus_url.is_some() {
        existing.nexus_url = entry.nexus_url;
        existing.nexus_game_domain = entry.nexus_game_domain;
        existing.nexus_mod_id = entry.nexus_mod_id;
    }

    let result = existing.clone();
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Set both GitHub and Nexus sources for a mod at once.
///
/// MERGE semantics: only `github_repo` and the Nexus fields are touched.
/// Pre-existing `pinned`, `installed_version`, `note`, `custom_url`, and
/// `snoozed_until_tag` survive. The previous implementation overwrote the
/// whole entry with a fresh one — that silently destroyed pin state and
/// notes every time the user opened SourceEditor and clicked Save.
pub(crate) fn set_mod_sources_full_from_path(
    mod_name: &str,
    folder_name: Option<&str>,
    github_repo: Option<String>,
    nexus_url: Option<String>,
    config_path: &Path,
) -> Result<ModSourceEntry> {
    let mut db = load_sources(config_path);
    // Folder-first write key matches the rest of the codebase. Fall back
    // to display name for legacy callers / mods scanned without a folder.
    let key = folder_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_name.to_string());

    // Normalize the GitHub field BEFORE looking at existing state so a bad
    // input bails out without mutating the entry. Pre-1.4.3 this stored the
    // raw string, which let full URLs ("https://github.com/owner/repo")
    // flow through to the audit's parse_owner_repo and produce malformed
    // API calls (the user-reported 404 on STS2-MultiPlayerPotionView).
    let normalized_github_repo: Option<String> = match github_repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None, // empty/None = explicit clear
        Some(raw) => match normalize_github_repo_input(raw) {
            Some(canonical) => Some(canonical),
            None => {
                return Err(AppError::Other(format!(
                    "Could not parse GitHub repo '{}'. Use owner/repo or a full GitHub URL.",
                    raw
                )));
            }
        },
    };

    let entry = db.mods.entry(key).or_default();

    entry.github_repo = normalized_github_repo;
    entry.github_auto_detected = false; // manually set by user

    if let Some(ref nurl) = nexus_url {
        if let Some(parsed) = parse_source_url(nurl) {
            entry.nexus_url = parsed.nexus_url.or(Some(nurl.clone()));
            entry.nexus_game_domain = parsed.nexus_game_domain;
            entry.nexus_mod_id = parsed.nexus_mod_id;
        } else {
            entry.nexus_url = Some(nurl.clone());
        }
    } else {
        // Explicit clear: the SourceEditor's `null` means "remove this link".
        entry.nexus_url = None;
        entry.nexus_game_domain = None;
        entry.nexus_mod_id = None;
    }

    let result = entry.clone();
    save_sources(&db, config_path)?;
    Ok(result)
}

#[tauri::command]
pub fn set_mod_sources_full(
    mod_name: String,
    folder_name: Option<String>,
    github_repo: Option<String>,
    nexus_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    set_mod_sources_full_from_path(
        &mod_name,
        folder_name.as_deref(),
        github_repo,
        nexus_url,
        &s.config_path,
    )
    .map_err(|e| e.to_string())
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut cleaned = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            cleaned.push(trimmed.to_string());
        }
    }
    cleaned
}

fn clear_source_link_fields(entry: &mut ModSourceEntry) {
    entry.github_repo = None;
    entry.github_auto_detected = false;
    entry.nexus_url = None;
    entry.nexus_game_domain = None;
    entry.nexus_mod_id = None;
}

fn source_entry_has_any_metadata(entry: &ModSourceEntry) -> bool {
    entry.github_repo.is_some()
        || entry.github_auto_detected
        || entry.nexus_url.is_some()
        || entry.nexus_game_domain.is_some()
        || entry.nexus_mod_id.is_some()
        || entry.installed_version.is_some()
        || entry.pinned
        || entry.note.is_some()
        || entry.custom_url.is_some()
        || !entry.tags.is_empty()
        || entry.display_name.is_some()
        || entry.display_description.is_some()
        || entry.snoozed_until_tag.is_some()
        || !entry.config_hashes.is_empty()
}

fn clear_source_links_for_key(db: &mut ModSourcesDb, key: &str) -> Option<ModSourceEntry> {
    let entry = db.mods.get_mut(key)?;
    clear_source_link_fields(entry);
    let result = entry.clone();
    if !source_entry_has_any_metadata(entry) {
        db.mods.remove(key);
    }
    Some(result)
}

pub(crate) fn clear_mod_source_links_from_path(
    mod_name: &str,
    folder_name: Option<&str>,
    config_path: &Path,
) -> Result<ModSourceEntry> {
    let mut db = load_sources(config_path);
    let key = folder_name.unwrap_or(mod_name);
    let primary = clear_source_links_for_key(&mut db, key);
    let legacy = if key != mod_name {
        clear_source_links_for_key(&mut db, mod_name)
    } else {
        None
    };
    let result = primary.or(legacy).unwrap_or_else(ModSourceEntry::default);
    save_sources(&db, config_path)?;
    Ok(result)
}

/// Set or clear a mod's free-form note and/or custom (non-GitHub/Nexus)
/// link. Empty strings clear the corresponding field. Folder-first write.
/// Other fields on the entry (github, nexus, pin, snooze, version) are
/// untouched.
#[tauri::command]
pub fn set_mod_extras(
    mod_name: String,
    folder_name: Option<String>,
    note: Option<String>,
    custom_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    let key = folder_name.unwrap_or(mod_name);
    let entry = db.mods.entry(key).or_default();

    entry.note = clean_optional_string(note);
    entry.custom_url = clean_optional_string(custom_url);

    let result = entry.clone();
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(result)
}

pub(crate) fn set_mod_tags_from_path(
    mod_name: &str,
    folder_name: Option<&str>,
    tags: Vec<String>,
    config_path: &Path,
) -> Result<ModSourceEntry> {
    let mut db = load_sources(config_path);
    let key = folder_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_name.to_string());
    let entry = db.mods.entry(key.clone()).or_default();
    entry.tags = clean_tags(tags);
    let result = entry.clone();
    if !source_entry_has_any_metadata(entry) {
        db.mods.remove(&key);
    }
    save_sources(&db, config_path)?;
    Ok(result)
}

/// Set manager-only organization tags/categories for a mod. Tags are
/// display/filter metadata only; they never affect mod identity, profile
/// membership, or update matching.
#[tauri::command]
pub fn set_mod_tags(
    mod_name: String,
    folder_name: Option<String>,
    tags: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    set_mod_tags_from_path(&mod_name, folder_name.as_deref(), tags, &s.config_path)
        .map_err(|e| e.to_string())
}

pub(crate) fn set_mod_display_overrides_from_path(
    mod_name: &str,
    folder_name: Option<&str>,
    display_name: Option<String>,
    display_description: Option<String>,
    config_path: &Path,
) -> Result<ModSourceEntry> {
    let mut db = load_sources(config_path);
    let key = folder_name
        .map(|s| s.to_string())
        .unwrap_or_else(|| mod_name.to_string());
    let entry = db.mods.entry(key).or_default();
    entry.display_name = clean_optional_string(display_name);
    entry.display_description = clean_optional_string(display_description);
    let result = entry.clone();
    save_sources(&db, config_path)?;
    Ok(result)
}

/// Set or clear the user-facing display name/description for a mod. These
/// are presentation-only overrides; the manifest name remains the identity
/// used for profiles, updates, and file operations.
#[tauri::command]
pub fn set_mod_display_overrides(
    mod_name: String,
    folder_name: Option<String>,
    display_name: Option<String>,
    display_description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    set_mod_display_overrides_from_path(
        &mod_name,
        folder_name.as_deref(),
        display_name,
        display_description,
        &s.config_path,
    )
    .map_err(|e| e.to_string())
}

/// Snooze update suggestions for this mod until an upstream version newer
/// than `latest_tag` appears. Passing an empty string or None clears the snooze.
/// Folder-first write. Distinct from pin (which is a hard freeze): a
/// snoozed mod can still be updated manually, and the snooze auto-expires
/// when upstream advances past `latest_tag`.
#[tauri::command]
pub fn set_mod_snooze(
    mod_name: String,
    folder_name: Option<String>,
    latest_tag: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ModSourceEntry, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    let key = folder_name.unwrap_or(mod_name);
    let entry = db.mods.entry(key).or_default();
    entry.snoozed_until_tag = latest_tag.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let result = entry.clone();
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Remove source links for a mod. Clears both the folder-keyed entry
/// (when folder_name is provided) AND any legacy name-keyed entry so a
/// "clear" action actually clears while preserving non-link metadata.
#[tauri::command]
pub fn remove_mod_source(
    mod_name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    clear_mod_source_links_from_path(&mod_name, folder_name.as_deref(), &s.config_path)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Pin a mod — excludes it from update checks, audit flags, and auto-install.
///
/// `folder_name` (when provided) is the preferred DB key, so two mods that
/// share a display name can be pinned independently. The `enrich_mods_with_sources`
/// lookup already falls back through name → folder_name → mod_id, so reads
/// of folder-keyed entries still resolve to the right ModInfo on display.
#[tauri::command]
pub fn pin_mod(
    mod_name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    let key = folder_name.unwrap_or(mod_name);
    let entry = db.mods.entry(key).or_default();
    entry.pinned = true;
    save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Unpin a mod — re-enables update checks and auto-install for it.
///
/// Tries the folder-name key first (current pin path), then falls back to
/// the display-name key for entries created by older versions of pin_mod.
#[tauri::command]
pub fn unpin_mod(
    mod_name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut db = load_sources(&s.config_path);
    let mut changed = false;
    if let Some(ref folder) = folder_name {
        if let Some(entry) = db.mods.get_mut(folder) {
            if entry.pinned {
                entry.pinned = false;
                changed = true;
            }
        }
    }
    if let Some(entry) = db.mods.get_mut(&mod_name) {
        if entry.pinned {
            entry.pinned = false;
            changed = true;
        }
    }
    if changed {
        save_sources(&db, &s.config_path).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// For a mod with a Nexus URL, try to find its GitHub repo by:
/// 1. Querying the Nexus API and extracting GitHub links from the description
/// 2. Falling back to GitHub search using the mod name + Nexus author name
/// Saves the result to the sources DB if found.
#[tauri::command]
pub async fn find_github_from_nexus(
    mod_name: String,
    folder_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<String>, String> {
    let (config_path, nexus_key, github_token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let key = s
            .nexus_api_key
            .clone()
            .ok_or("Nexus API key not set. Add it in Settings.")?;
        (s.config_path.clone(), key, s.github_token.clone())
    };

    let db = load_sources(&config_path);
    // Folder-first read so we resolve the right entry when two mods share
    // a display name. Write key for the new github_repo follows the same
    // preference so we don't fragment the entry across two keys.
    let entry = lookup_entry(&db.mods, folder_name.as_deref(), &mod_name, None)
        .ok_or(format!("No source entry for '{}'", mod_name))?;
    let write_key = folder_name.clone().unwrap_or_else(|| mod_name.clone());

    let game_domain = entry
        .nexus_game_domain
        .clone()
        .unwrap_or_else(|| "slaythespire2".to_string());
    let mod_id = entry
        .nexus_mod_id
        .ok_or("No Nexus mod ID for this mod. Set a Nexus URL first.")?;

    // Step 1: Try extracting from Nexus description
    let repo = extract_github_from_nexus(&nexus_key, &game_domain, mod_id).await;

    if let Some(ref repo) = repo {
        let mut db = load_sources(&config_path);
        let entry = db.mods.entry(write_key.clone()).or_default();
        entry.github_repo = Some(repo.clone());
        entry.github_auto_detected = true;
        save_sources(&db, &config_path).map_err(|e| e.to_string())?;
        return Ok(Some(repo.clone()));
    }

    // Step 2: Fallback - get Nexus author name and search GitHub
    let client = crate::nexus::NexusClient::new(&nexus_key);
    if let Ok(info) = client.get_mod_info(&game_domain, mod_id).await {
        let nexus_name = info.name.unwrap_or_default();
        let author = info.author.unwrap_or_default();

        // Try searching GitHub with mod name + author
        let queries = vec![
            format!("{} {}", nexus_name, author),
            nexus_name.clone(),
            mod_name.clone(),
        ];

        for query in queries {
            if query.trim().is_empty() {
                continue;
            }
            let search_query =
                format!("{} slay-the-spire-2 OR sts2 OR \"slay the spire 2\"", query);
            let results = search_github_repos_relevance(&search_query, github_token.as_deref())
                .await
                .unwrap_or_default();

            // Find a result that matches by name similarity
            let norm_name = query
                .to_lowercase()
                .replace(' ', "")
                .replace('-', "")
                .replace('_', "");
            for r in &results {
                let norm_repo = r
                    .name
                    .to_lowercase()
                    .replace(' ', "")
                    .replace('-', "")
                    .replace('_', "");
                if norm_repo.contains(&norm_name) || norm_name.contains(&norm_repo) {
                    let repo = r.full_name.clone();
                    let mut db = load_sources(&config_path);
                    let entry = db.mods.entry(write_key.clone()).or_default();
                    entry.github_repo = Some(repo.clone());
                    entry.github_auto_detected = true;
                    save_sources(&db, &config_path).map_err(|e| e.to_string())?;
                    return Ok(Some(repo));
                }
            }
        }
    }

    Ok(None)
}

// ── Nexus → GitHub Extraction ──────────────────────────────────────────────

/// Fetch a Nexus mod's description via the API and extract any GitHub repo URL from it.
/// Returns the "owner/repo" string if found.
/// Handles HTML-encoded descriptions (Nexus returns BBCode/HTML in description fields).
pub async fn extract_github_from_nexus(
    nexus_api_key: &str,
    game_domain: &str,
    mod_id: u64,
) -> Option<String> {
    let client = crate::nexus::NexusClient::new(nexus_api_key);
    let info = match client.get_mod_info(game_domain, mod_id).await {
        Ok(i) => i,
        Err(e) => {
            log::warn!(
                "Nexus API call failed for {}/{}: {}",
                game_domain,
                mod_id,
                e
            );
            return None;
        }
    };

    // Collect all text fields to search
    let mut texts = Vec::new();
    if let Some(ref desc) = info.description {
        texts.push(desc.clone());
        // Also decode HTML entities and try again (Nexus often HTML-encodes descriptions)
        let decoded = desc
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&#x27;", "'")
            .replace("&#x2F;", "/")
            .replace("&#47;", "/")
            .replace("&#x3A;", ":")
            .replace("&#58;", ":")
            .replace("&#x2E;", ".")
            .replace("&#46;", ".")
            .replace("%2F", "/")
            .replace("%3A", ":");
        if decoded != *desc {
            texts.push(decoded);
        }
    }
    if let Some(ref summary) = info.summary {
        texts.push(summary.clone());
    }
    // Also try the author field (some authors put their GitHub username there)
    if let Some(ref author) = info.author {
        texts.push(author.clone());
    }

    let re = regex::Regex::new(r#"github\.com/([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)"#).ok()?;

    for text in &texts {
        // Also try matching inside href="..." attributes and [url=...] BBCode
        // by searching the raw text
        for caps in re.captures_iter(text) {
            if let Some(m) = caps.get(1) {
                let repo = m
                    .as_str()
                    .trim_end_matches('/')
                    .trim_end_matches(".git")
                    .to_string();
                // Validate it looks like owner/repo (not owner/repo/something)
                let parts: Vec<&str> = repo.split('/').collect();
                if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                    // Skip common false positives
                    if parts[1] != "issues" && parts[1] != "releases" && parts[1] != "wiki" {
                        log::info!(
                            "Found GitHub repo '{}' in Nexus description for mod {}",
                            repo,
                            mod_id
                        );
                        return Some(repo);
                    }
                }
            }
        }
    }

    log::info!(
        "No GitHub link found in Nexus description for mod {} (searched {} text fields)",
        mod_id,
        texts.len()
    );
    None
}

// ── STS2 Evidence Gate ──────────────────────────────────────────────────────

/// Auto-detect picks from a broad relevance search, so we require independent evidence
/// that a candidate is actually an STS2 mod before linking it. Without this, a generic
/// repo named "AutoPath" can outrank the real `jadistanbelly/autopath-sts2`.
fn is_sts2_related(repo: &GitHubRepo) -> bool {
    let name_lower = repo.name.to_lowercase();
    if name_lower.contains("sts2")
        || name_lower.contains("slay-the-spire-2")
        || name_lower.contains("spire-2")
        || name_lower.contains("slaythespire2")
    {
        return true;
    }

    for topic in &repo.topics {
        let t = topic.to_lowercase();
        // ⚠️ Don't accept "slay-the-spire" alone — that's the StS-1 topic.
        // Auto-detect was matching against StS-1 mods that happened to share
        // a name fragment with the user's STS2 mod (e.g. "ModConfig").
        if t == "sts2" || t == "slay-the-spire-2" || t == "slay-the-spire-ii" {
            return true;
        }
    }

    if let Some(ref desc) = repo.description {
        let d = desc.to_lowercase();
        if d.contains("sts2")
            || d.contains("slay the spire 2")
            || d.contains("slay the spire ii")
            || d.contains("slaythespire2")
            || d.contains("slay-the-spire-2")
        {
            return true;
        }
    }

    false
}

// ── Normalization Helpers ───────────────────────────────────────────────────

/// Normalize a name by lowercasing and stripping separators.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace(' ', "")
        .replace('-', "")
        .replace('_', "")
}

/// Strip common STS2 prefixes/suffixes from a mod name for broader matching.
fn strip_sts2_affixes(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let prefixes = [
        "sts2",
        "sts2-",
        "sts2_",
        "slay the spire 2 ",
        "slaythe spire2",
    ];
    let suffixes = [
        " sts2",
        "-sts2",
        "_sts2",
        " for sts2",
        " for slay the spire 2",
    ];

    let mut stripped = lower.clone();
    for p in &prefixes {
        if let Some(rest) = stripped.strip_prefix(p) {
            stripped = rest.trim().to_string();
            break;
        }
    }
    for s in &suffixes {
        if let Some(rest) = stripped.strip_suffix(s) {
            stripped = rest.trim().to_string();
            break;
        }
    }
    let stripped = stripped.trim().to_string();
    if stripped != lower && !stripped.is_empty() {
        Some(stripped)
    } else {
        None
    }
}

/// Extract the folder name from a mod's files list (first path component of a subdirectory mod).
fn extract_folder_name(m: &ModInfo) -> Option<String> {
    for f in &m.files {
        if let Some(idx) = f.find('/') {
            let folder = &f[..idx];
            if !folder.is_empty() && folder != "." {
                return Some(folder.to_string());
            }
        }
        if let Some(idx) = f.find('\\') {
            let folder = &f[..idx];
            if !folder.is_empty() && folder != "." {
                return Some(folder.to_string());
            }
        }
    }
    None
}

/// Extract the author name from a mod's source field if it looks like "github:owner/repo".
/// Retained for potential future use; currently not called from the auto-detect search loop
/// because author-prefixed queries produced too many false positives.
#[allow(dead_code)]
fn extract_author(m: &ModInfo) -> Option<String> {
    if let Some(ref src) = m.source {
        if let Some(rest) = src.strip_prefix("github:") {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if !parts.is_empty() && !parts[0].is_empty() {
                return Some(parts[0].to_string());
            }
        }
        if let Some(rest) = src.strip_prefix("https://github.com/") {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if !parts.is_empty() && !parts[0].is_empty() {
                return Some(parts[0].to_string());
            }
        }
    }
    None
}

// ── Matching / Scoring ──────────────────────────────────────────────────────

/// Score a candidate repo against a mod. Higher is better; 0 = no match.
fn score_repo(repo: &GitHubRepo, mod_name: &str, folder_name: Option<&str>) -> u32 {
    let norm_mod = normalize(mod_name);
    let norm_repo = normalize(&repo.name);
    let desc_lower = repo.description.as_deref().unwrap_or("").to_lowercase();

    // Exact normalized name match → highest score
    if norm_repo == norm_mod {
        return 100;
    }

    // Folder name exact match
    if let Some(folder) = folder_name {
        if normalize(folder) == norm_repo {
            return 95;
        }
    }

    // Repo name contains mod name or vice versa (normalized)
    if norm_repo.contains(&norm_mod) || norm_mod.contains(&norm_repo) {
        // Prefer closer length matches
        let len_ratio =
            norm_mod.len().min(norm_repo.len()) as f64 / norm_mod.len().max(norm_repo.len()) as f64;
        return 60 + (len_ratio * 30.0) as u32;
    }

    // Stripped name (without STS2 affixes) matches repo
    if let Some(stripped) = strip_sts2_affixes(mod_name) {
        let norm_stripped = normalize(&stripped);
        if norm_repo == norm_stripped {
            return 90;
        }
        if norm_repo.contains(&norm_stripped) || norm_stripped.contains(&norm_repo) {
            return 70;
        }
    }

    // Description mentions the mod name
    let name_lower = mod_name.to_lowercase();
    if desc_lower.contains(&name_lower) {
        return 50;
    }

    // Description mentions individual significant words from the mod name
    let words: Vec<&str> = mod_name
        .split(|c: char| c == ' ' || c == '-' || c == '_')
        .filter(|w| w.len() > 2)
        .collect();
    if words.len() >= 2 {
        let word_matches = words
            .iter()
            .filter(|w| {
                let wl = w.to_lowercase();
                norm_repo.contains(&normalize(&wl)) || desc_lower.contains(&wl)
            })
            .count();
        if word_matches == words.len() {
            return 45;
        }
    }

    0
}

/// Represents a candidate match with its score.
struct Candidate {
    repo: GitHubRepo,
    score: u32,
}

// ── Scope filter (pure helper) ──────────────────────────────────────────────

/// Retain only the mod identified by `only` (matched by folder_name first,
/// then by name). `None` means no filter — all mods are returned unchanged.
fn scope_installed(
    mut installed: Vec<crate::mods::ModInfo>,
    only: Option<&str>,
) -> Vec<crate::mods::ModInfo> {
    if let Some(key) = only {
        installed.retain(|m| m.folder_name.as_deref() == Some(key) || m.name == key);
    }
    installed
}

// ── Main Auto-Detect ────────────────────────────────────────────────────────

/// Auto-detect GitHub sources for mods that don't have one linked.
/// Searches GitHub for each unlinked mod name using multiple query strategies
/// and picks the best match via fuzzy scoring.
#[tauri::command]
pub async fn auto_detect_sources(
    state: tauri::State<'_, AppState>,
    only_mod: Option<String>,
) -> std::result::Result<AutoDetectResult, String> {
    let (config_path, mods_path, disabled_mods_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let config_path = s.config_path.clone();
        let mods_path = s.mods_path.clone().ok_or("Game path not set")?;
        let disabled_mods_path = s.disabled_mods_path.clone();
        let token = s.github_token.clone();
        (config_path, mods_path, disabled_mods_path, token)
    };

    let mut db = load_sources(&config_path);

    // Scan BOTH the active game folder and the stored (disabled) folder so
    // auto-detect covers every installed mod — not just the ones currently
    // active in the game. Mirrors get_installed_mods' union + folder-dedup
    // so a half-toggled mod present in both folders isn't scanned twice.
    // Without this, auto-detect silently skipped stored mods and reported
    // counts like "12 installed" when the library actually had 22.
    let active = crate::mods::scan_mods(&mods_path);
    let active_keys: std::collections::HashSet<String> =
        active.iter().map(crate::mods::dedup_key).collect();
    let mut installed = active;
    if let Some(ref dp) = disabled_mods_path {
        for stored in crate::mods::scan_disabled_mods(dp) {
            if !active_keys.contains(&crate::mods::dedup_key(&stored)) {
                installed.push(stored);
            }
        }
    }

    let installed = scope_installed(installed, only_mod.as_deref());

    let authenticated = token.is_some();
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut not_checked = Vec::new();
    let mut rate_limited = false;
    let mut rate_limit_reset_at: Option<i64> = None;

    // Cross-mod query result cache: avoid issuing the same search term twice
    // in one auto-detect run. Key = query string (lowercase), Value = the
    // Vec<Candidate> already collected from that query.
    let mut query_cache: std::collections::HashMap<String, Vec<(GitHubRepo, u32)>> =
        std::collections::HashMap::new();

    // Rate-limit state shared across all mod iterations.
    // Updated after each successful search response.
    let mut last_rl: Option<RateLimitInfo> = None;

    // Phase 0: Save any manifest-extracted URLs to the sources DB —
    // ONLY for mods that don't already have a source linked.
    //
    // Per user instruction (v1.0.11): the absence of a link on a mod that
    // ALREADY has one source attached is intentional. They may have
    // unlinked the manifest-declared GitHub on purpose, or they prefer
    // Nexus as the canonical source for that mod, etc. Re-running auto-
    // detect was overwriting their choice every time.
    //
    // We still seed both fields together for first-time mods that have
    // never had a source set — manifest-declared URLs are author-intent,
    // not a guess, so initial population is OK.
    for m in &installed {
        let already_linked = lookup_entry(
            &db.mods,
            m.folder_name.as_deref(),
            &m.name,
            m.mod_id.as_deref(),
        )
        .map(|e| e.github_repo.is_some() || e.nexus_url.is_some() || e.nexus_mod_id.is_some())
        .unwrap_or(false);
        if already_linked {
            continue;
        }

        // Write under folder_name when available so the new entry sits
        // alongside any other folder-keyed state for this mod. Falls back
        // to display name for mods scanned without a folder (shouldn't
        // happen post-1.3.0 but defensive).
        let key = m.folder_name.clone().unwrap_or_else(|| m.name.clone());
        let entry = db.mods.entry(key).or_default();
        let mut changed = false;

        // Save manifest-extracted GitHub URL
        if let Some(ref gh_url) = m.github_url {
            if let Some(parsed) = parse_source_url(gh_url) {
                entry.github_repo = parsed.github_repo;
                entry.github_auto_detected = true;
                changed = true;
            }
        }
        if entry.github_repo.is_none() {
            if let Some(ref src) = m.source {
                if src.starts_with("github:") || src.contains("github.com") {
                    if let Some(parsed) = parse_source_url(src) {
                        entry.github_repo = parsed.github_repo;
                        entry.github_auto_detected = true;
                        changed = true;
                    }
                }
            }
        }

        // Save manifest-extracted Nexus URL
        if let Some(ref nx_url) = m.nexus_url {
            if let Some(parsed) = parse_source_url(nx_url) {
                entry.nexus_url = parsed.nexus_url;
                entry.nexus_game_domain = parsed.nexus_game_domain;
                entry.nexus_mod_id = parsed.nexus_mod_id;
                changed = true;
            }
        }

        if changed {
            let _ = save_sources(&db, &config_path);
        }
    }

    // Phase 0.5 (REMOVED in v1.0.11): we used to scrape GitHub links out
    // of Nexus mod descriptions and auto-attach them when the user had a
    // Nexus link but no GitHub. Per user instruction, the absence of a
    // GitHub link on a Nexus-linked mod is INTENTIONAL — the user may
    // prefer Nexus as the canonical source, or the GitHub repo may be
    // unrelated/abandoned. Auto-attaching GitHub on top of a deliberate
    // Nexus pick was overwriting that choice.
    //
    // The same outcome is still reachable explicitly via the Mods view's
    // per-row source editor, which lets the user add a GitHub link if
    // they actually want one for this mod.

    let mut skipped_already_linked: u32 = 0;
    for m in &installed {
        // Skip mods that ALREADY have any linked source — GitHub OR Nexus.
        //
        // The previous behavior only skipped on github_repo, which meant a
        // mod the user had deliberately linked to Nexus (because it lives
        // on Nexus only, or because they prefer Nexus updates) would still
        // get a GitHub repo guessed and auto-attached on top. That guessed
        // repo was the source of "auto-detect keeps messing up" — it was
        // overwriting deliberate user choices with low-confidence matches.
        //
        // Now: if the user (or earlier Phase 0 / 0.5) already attached a
        // Nexus link OR a GitHub repo, we leave the mod alone. The user
        // can still trigger a manual re-link from the Mods view if they
        // genuinely want a different source.
        if let Some(entry) = lookup_entry(
            &db.mods,
            m.folder_name.as_deref(),
            &m.name,
            m.mod_id.as_deref(),
        ) {
            let has_github = entry.github_repo.is_some();
            let has_nexus = entry.nexus_mod_id.is_some() || entry.nexus_url.is_some();
            if has_github || has_nexus {
                skipped_already_linked += 1;
                continue;
            }
        }

        // If we are already rate-limited, skip remaining mods entirely
        // and record them as "not_checked" rather than "unmatched".
        if rate_limited {
            not_checked.push(m.name.clone());
            continue;
        }

        let folder_name = extract_folder_name(m);

        // Build a reduced set of high-signal queries (2–3 per mod) to minimise
        // GitHub Search API consumption (cap: 30 req/min authenticated, 10/min
        // unauthenticated). Empirically the two highest-signal queries are:
        //   1. Exact mod name + "sts2" qualifier (matches repos whose name or
        //      description contains the word "sts2").
        //   2. Folder name when it differs substantially from the display name.
        // A third fallback query uses the stripped name (without STS2 affixes)
        // for mods whose name IS "sts2-<something>" or "<something>-sts2".
        // Individual-word queries (the old query 6) are dropped: they produce
        // too many false positives and consume too many API calls per mod.
        // Author-prefixed queries are also dropped: authors aren't reliably
        // available in the manifest for most mods.
        //
        // Net effect: ≤ 3 queries per mod (down from 6–8) while preserving
        // match quality for the mods that actually have GitHub repos.
        let mut queries: Vec<String> = Vec::new();

        // Query 1 (highest signal): mod name + "sts2" qualifier.
        let name_hyphenated = m.name.replace(' ', "-");
        queries.push(format!("{} sts2", name_hyphenated));

        // Query 2: folder name when it's meaningfully different from the display name.
        if let Some(ref folder) = folder_name {
            let folder_norm = normalize(folder);
            if folder_norm != normalize(&m.name) {
                queries.push(folder.replace(' ', "-"));
            }
        }

        // Query 3 (fallback): stripped name without STS2 affixes, with sts2 qualifier.
        if let Some(stripped) = strip_sts2_affixes(&m.name) {
            let stripped_q = format!("{} sts2", stripped.replace(' ', "-"));
            if !queries.contains(&stripped_q) {
                queries.push(stripped_q);
            }
        }

        // Deduplicate within this mod (case-insensitive).
        let mut seen_q = std::collections::HashSet::new();
        queries.retain(|q| seen_q.insert(q.to_lowercase()));

        // Search GitHub with each query and collect all unique candidates.
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut seen_repos = std::collections::HashSet::new();

        // Bumped from 70 → 80 to cut false-positive auto-attaches. Score 70
        // was just "one normalized name contains the other" which is too
        // loose for short / generic mod names like "ModConfig" or "ModSync"
        // — a StS-1 mod with the same fragment scored 70 and got attached
        // even though it had nothing to do with STS2.
        const MIN_SCORE: u32 = 80;

        for query in &queries {
            let cache_key = query.to_lowercase();

            // Cross-mod deduplication: if we already issued this exact query
            // in this run, reuse its cached results instead of hitting the API.
            let repos: Vec<GitHubRepo> = if let Some(cached) = query_cache.get(&cache_key) {
                log::debug!("Auto-detect: cache hit for query '{}'", query);
                cached.iter().map(|(r, _)| r.clone()).collect()
            } else {
                // Adaptive pacing: if the last response told us quota is
                // nearly exhausted, wait until the reset window rather than
                // burning the last few requests and triggering a hard 429.
                if let Some(ref rl) = last_rl {
                    if quota_is_low(rl) {
                        let wait = rl.secs_until_reset();
                        // Cap at 5 s to avoid blocking the UI for too long;
                        // if the reset is further away we mark as rate-limited.
                        if wait > 5 {
                            log::warn!(
                                "Auto-detect: quota low (remaining={}) and reset is {}s away — \
                                 stopping search to avoid hard rate-limit",
                                rl.remaining,
                                wait
                            );
                            rate_limited = true;
                            rate_limit_reset_at = Some(rl.reset_at);
                            not_checked.push(m.name.clone());
                            break;
                        } else if wait > 0 {
                            log::info!("Auto-detect: quota low, waiting {}s for reset", wait);
                            tokio::time::sleep(std::time::Duration::from_secs(wait as u64)).await;
                        }
                    }
                }

                match search_github_repos_relevance_outcome(query, token.as_deref()).await {
                    SearchOutcome::Ok(repos) => {
                        // Cache results for potential reuse by other mods.
                        let pairs: Vec<_> = repos.iter().map(|r| (r.clone(), 0u32)).collect();
                        query_cache.insert(cache_key.clone(), pairs);
                        repos
                    }
                    SearchOutcome::RateLimited(info) => {
                        rate_limited = true;
                        // Keep the earliest/latest reset_at (take the latest,
                        // which is the most conservative).
                        let reset = info.reset_at;
                        rate_limit_reset_at = Some(match rate_limit_reset_at {
                            Some(existing) => existing.max(reset),
                            None => reset,
                        });
                        last_rl = Some(info);
                        not_checked.push(m.name.clone());
                        break; // stop issuing queries for this mod
                    }
                    SearchOutcome::Err(e) => {
                        log::warn!("Auto-detect search error for query '{}': {}", query, e);
                        Vec::new()
                    }
                }
            };

            // If we already hit a rate-limit this iteration, exit inner loop.
            if rate_limited && not_checked.last().map(|n| n == &m.name).unwrap_or(false) {
                break;
            }

            for repo in repos {
                if seen_repos.contains(&repo.full_name) {
                    continue;
                }
                let sc = score_repo(&repo, &m.name, folder_name.as_deref());
                if sc >= MIN_SCORE {
                    seen_repos.insert(repo.full_name.clone());
                    candidates.push(Candidate { repo, score: sc });
                } else if sc > 0 {
                    log::info!(
                        "Auto-detect candidate {} score={} (below threshold {})",
                        repo.full_name,
                        sc,
                        MIN_SCORE
                    );
                }
            }

            // If we already have a high-confidence match, stop searching
            if candidates.iter().any(|c| c.score >= 90) {
                break;
            }
        }

        // If this mod was added to not_checked (rate-limited mid-search), skip
        // the candidate-evaluation block below.
        if rate_limited && not_checked.last().map(|n| n == &m.name).unwrap_or(false) {
            continue;
        }

        // Sort candidates by score descending
        candidates.sort_by(|a, b| b.score.cmp(&a.score));

        let best_score = candidates.first().map(|c| c.score).unwrap_or(0);

        // Try candidates in score order, verify they're STS2-related and have releases
        let mut found = false;
        for candidate in &candidates {
            if !is_sts2_related(&candidate.repo) {
                log::info!(
                    "Auto-detect candidate {} score={} (rejected: not STS2-related)",
                    candidate.repo.full_name,
                    candidate.score
                );
                continue;
            }

            let has_release = fetch_latest_release(
                &candidate.repo.owner.login,
                &candidate.repo.name,
                token.as_deref(),
            )
            .await
            .is_ok();

            if has_release {
                let full_name = candidate.repo.full_name.clone();
                let confidence = if candidate.score >= 90 {
                    "high"
                } else {
                    "medium"
                };

                let key = m.folder_name.clone().unwrap_or_else(|| m.name.clone());
                let entry = db.mods.entry(key).or_default();
                entry.github_repo = Some(full_name.clone());
                entry.github_auto_detected = true;
                save_sources(&db, &config_path).map_err(|e| e.to_string())?;

                log::info!(
                    "Auto-detect: '{}' resolved to {} (score={})",
                    m.name,
                    full_name,
                    candidate.score
                );

                matched.push(AutoDetectMatch {
                    mod_name: m.name.clone(),
                    github_repo: full_name,
                    confidence: confidence.to_string(),
                });
                found = true;
                break;
            }
        }

        if !found {
            log::info!(
                "Auto-detect: no acceptable candidate for '{}' (best score={})",
                m.name,
                best_score
            );
            unmatched.push(m.name.clone());
        }
    }

    Ok(AutoDetectResult {
        matched,
        unmatched,
        skipped_already_linked,
        rate_limited,
        rate_limit_reset_at,
        not_checked,
        authenticated,
    })
}

#[cfg(test)]
mod enrich_priority_tests {
    //! Regression coverage for the "save reverts to old broken link" UX bug.
    //!
    //! Pre-1.4.3, `enrich_mods_with_sources` only filled `m.github_url`
    //! from mod_sources.json when the manifest didn't already provide
    //! one — manifest-wins priority. The audit/update path
    //! (`resolve_github_repo` in updater.rs) used the opposite priority
    //! (user-override-wins), so a user could edit the SourceEditor to
    //! fix a broken manifest URL, have the backend accept the change,
    //! but see the editor and the GitHub badge keep showing the old
    //! manifest value. Aligning enrich to the same priority makes the
    //! editor display, the row badge link, and the audit all consistent.
    use super::*;
    use crate::mods::ModInfo;
    use tempfile::tempdir;

    fn mod_with(name: &str, folder: Option<&str>, github_url: Option<&str>) -> ModInfo {
        ModInfo {
            name: name.into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: folder.map(str::to_string),
            mod_id: None,
            github_url: github_url.map(str::to_string),
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

    fn write_entry(config: &Path, key: &str, entry: ModSourceEntry) {
        let mut db = ModSourcesDb::default();
        db.mods.insert(key.to_string(), entry);
        save_sources(&db, config).unwrap();
    }

    #[test]
    fn manual_override_replaces_a_broken_manifest_github_url() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "STS2-MultiPlayerPotionView",
            ModSourceEntry {
                github_repo: Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
                github_auto_detected: false, // user edited via SourceEditor
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with(
            "Multiplayer Potion View",
            Some("STS2-MultiPlayerPotionView"),
            // Manifest shipped a wrong/typo URL — user's override should win.
            Some("https://github.com/wrong/wrong"),
        )];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].github_url.as_deref(),
            Some("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView"),
        );
    }

    #[test]
    fn auto_detected_entry_does_not_override_existing_manifest_url() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "SomeMod",
            ModSourceEntry {
                github_repo: Some("auto/guess".into()),
                github_auto_detected: true, // manager guessed it
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with(
            "SomeMod",
            Some("SomeMod"),
            Some("https://github.com/real/repo"),
        )];

        enrich_mods_with_sources(&mut mods, config);

        // Auto-detected entries are guesses; the manifest is authoritative
        // when it provides a URL.
        assert_eq!(
            mods[0].github_url.as_deref(),
            Some("https://github.com/real/repo"),
        );
        assert!(
            !mods[0].github_auto_detected,
            "the displayed manifest GitHub URL is author-provided, not the manager's auto guess"
        );
    }

    #[test]
    fn url_form_db_entry_does_not_double_prefix_the_display_url() {
        // Legacy mod_sources.json entries (from pre-1.4.3 saves) may have
        // stored the github_repo as a full URL rather than owner/repo. The
        // naive `format!("https://github.com/{}", repo)` would produce
        // "https://github.com/https://github.com/...". Normalize first.
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "STS2-MultiPlayerPotionView",
            ModSourceEntry {
                github_repo: Some("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView".into()),
                github_auto_detected: false,
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with(
            "Multiplayer Potion View",
            Some("STS2-MultiPlayerPotionView"),
            None,
        )];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].github_url.as_deref(),
            Some("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView"),
        );
    }

    #[test]
    fn auto_detected_entry_still_fills_missing_manifest_url() {
        // Pre-1.4.3 behavior preserved for the common case: when the
        // manifest doesn't ship a URL, the auto-detected guess fills in.
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "SomeMod",
            ModSourceEntry {
                github_repo: Some("guess/from-nexus".into()),
                github_auto_detected: true,
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with("SomeMod", Some("SomeMod"), None)];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].github_url.as_deref(),
            Some("https://github.com/guess/from-nexus"),
        );
        assert!(
            mods[0].github_auto_detected,
            "frontend needs to know this repo is informational until the user saves it"
        );
    }

    #[test]
    fn manual_source_save_promotes_auto_detected_github_to_user_confirmed() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "SomeMod",
            ModSourceEntry {
                github_repo: Some("guess/from-nexus".into()),
                github_auto_detected: true,
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/42".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(42),
                ..Default::default()
            },
        );

        let saved = set_mod_sources_full_from_path(
            "SomeMod",
            Some("SomeMod"),
            Some("guess/from-nexus".into()),
            Some("https://www.nexusmods.com/slaythespire2/mods/42".into()),
            config,
        )
        .unwrap();

        assert_eq!(saved.github_repo.as_deref(), Some("guess/from-nexus"));
        assert!(
            !saved.github_auto_detected,
            "clicking Save in SourceEditor confirms the repo for GitHub updates"
        );
    }

    #[test]
    fn enrich_merges_legacy_display_key_into_folder_key_without_overwriting_manual_folder_source() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "UnifiedSavePath".into(),
            ModSourceEntry {
                github_repo: Some("manual/folder".into()),
                github_auto_detected: false,
                ..Default::default()
            },
        );
        db.mods.insert(
            "Unified Save Path".into(),
            ModSourceEntry {
                github_repo: Some("auto/legacy".into()),
                github_auto_detected: true,
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/6".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(6),
                installed_version: Some("1.1.3".into()),
                tags: vec!["utility".into()],
                ..Default::default()
            },
        );
        save_sources(&db, config).unwrap();

        let mut mods = vec![mod_with("Unified Save Path", Some("UnifiedSavePath"), None)];
        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].github_url.as_deref(),
            Some("https://github.com/manual/folder"),
            "folder-keyed manual GitHub source wins over legacy auto-detect"
        );
        assert_eq!(
            mods[0].nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/6"),
            "missing Nexus metadata is carried from the legacy display-name key"
        );
        assert_eq!(
            mods[0].version, "1.0.0",
            "source installed_version must not overwrite the manifest version"
        );

        let saved = load_sources(config);
        let folder_entry = saved.mods.get("UnifiedSavePath").unwrap();
        assert_eq!(folder_entry.github_repo.as_deref(), Some("manual/folder"));
        assert_eq!(folder_entry.installed_version.as_deref(), Some("1.1.3"));
        assert_eq!(folder_entry.nexus_mod_id, Some(6));
        assert_eq!(folder_entry.tags, vec!["utility"]);
    }

    #[test]
    fn display_overrides_enrich_without_replacing_identity_name() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "UnreadableFolder",
            ModSourceEntry {
                display_name: Some("Readable Name".into()),
                display_description: Some("Human-maintained description".into()),
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with(
            "manifest-gibberish",
            Some("UnreadableFolder"),
            None,
        )];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(mods[0].name, "manifest-gibberish");
        assert_eq!(mods[0].display_name.as_deref(), Some("Readable Name"));
        assert_eq!(
            mods[0].display_description.as_deref(),
            Some("Human-maintained description"),
        );
    }

    #[test]
    fn tags_enrich_as_manager_owned_categories() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "ReadableFolder",
            ModSourceEntry {
                tags: vec!["utility".into(), "beta".into()],
                ..Default::default()
            },
        );
        let mut mods = vec![mod_with("ManifestName", Some("ReadableFolder"), None)];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].tags,
            vec!["utility".to_string(), "beta".to_string()]
        );
    }

    #[test]
    fn enrich_recovers_nexus_source_stranded_under_download_stem_key() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "Flagellant 0.1.7-1073-0-1-7-1781082503 (1)",
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/1073".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(1073),
                installed_version: Some("0.1.7".into()),
                ..Default::default()
            },
        );
        let mut mod_info = mod_with("Flagellant", Some("Flagellant"), None);
        mod_info.version = "unknown".into();
        let mut mods = vec![mod_info];

        enrich_mods_with_sources(&mut mods, config);

        assert_eq!(
            mods[0].nexus_url.as_deref(),
            Some("https://www.nexusmods.com/slaythespire2/mods/1073"),
            "the scanned Flagellant row should show Nexus instead of Unlinked"
        );
        assert_eq!(
            mods[0].version, "unknown",
            "source enrichment must not overwrite the scanned manifest version"
        );
        let db = load_sources(config);
        let recovered = db
            .mods
            .get("Flagellant")
            .expect("source metadata should be migrated to the real folder key");
        assert_eq!(recovered.nexus_mod_id, Some(1073));
        assert_eq!(recovered.installed_version.as_deref(), Some("0.1.7"));
    }

    #[test]
    fn set_tags_trims_deduplicates_and_clears_values() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();

        let saved = set_mod_tags_from_path(
            "ManifestName",
            Some("FolderName"),
            vec![
                " utility ".into(),
                "beta".into(),
                "utility".into(),
                " ".into(),
            ],
            config,
        )
        .unwrap();
        assert_eq!(saved.tags, vec!["utility".to_string(), "beta".to_string()]);

        let cleared =
            set_mod_tags_from_path("ManifestName", Some("FolderName"), vec![], config).unwrap();
        assert!(cleared.tags.is_empty());
    }

    #[test]
    fn set_display_overrides_trims_and_clears_values() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();

        let saved = set_mod_display_overrides_from_path(
            "ManifestName",
            Some("FolderName"),
            Some("  Friendly Name  ".into()),
            Some("  Better description  ".into()),
            config,
        )
        .unwrap();
        assert_eq!(saved.display_name.as_deref(), Some("Friendly Name"));
        assert_eq!(
            saved.display_description.as_deref(),
            Some("Better description")
        );

        let cleared = set_mod_display_overrides_from_path(
            "ManifestName",
            Some("FolderName"),
            Some(" ".into()),
            None,
            config,
        )
        .unwrap();
        assert_eq!(cleared.display_name, None);
        assert_eq!(cleared.display_description, None);
    }

    #[test]
    fn clear_source_links_preserves_non_link_metadata() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "FolderName",
            ModSourceEntry {
                github_repo: Some("owner/repo".into()),
                github_auto_detected: true,
                nexus_url: Some("https://www.nexusmods.com/sts2/mods/77".into()),
                nexus_game_domain: Some("sts2".into()),
                nexus_mod_id: Some(77),
                installed_version: Some("v1.0.0".into()),
                pinned: true,
                note: Some("keep note".into()),
                custom_url: Some("https://example.test/post".into()),
                tags: vec!["utility".into()],
                display_name: Some("Readable Name".into()),
                display_description: Some("Human-maintained description".into()),
                snoozed_until_tag: Some("v1.1.0".into()),
                config_hashes: std::collections::HashMap::from([(
                    "FolderName/config.ini".into(),
                    "sha256".into(),
                )]),
            },
        );

        let cleared =
            clear_mod_source_links_from_path("ManifestName", Some("FolderName"), config).unwrap();

        assert_eq!(cleared.github_repo, None);
        assert_eq!(cleared.nexus_url, None);
        assert_eq!(cleared.nexus_mod_id, None);
        assert!(!cleared.github_auto_detected);
        assert_eq!(cleared.display_name.as_deref(), Some("Readable Name"));
        assert_eq!(
            cleared.display_description.as_deref(),
            Some("Human-maintained description"),
        );
        assert_eq!(cleared.note.as_deref(), Some("keep note"));
        assert_eq!(cleared.tags, vec!["utility".to_string()]);
        assert!(cleared.pinned);
        assert_eq!(cleared.installed_version.as_deref(), Some("v1.0.0"));
        assert_eq!(cleared.snoozed_until_tag.as_deref(), Some("v1.1.0"));
        assert!(cleared.config_hashes.contains_key("FolderName/config.ini"));

        let db = load_sources(config);
        let saved = db.mods.get("FolderName").unwrap();
        assert_eq!(saved.github_repo, None);
        assert_eq!(saved.nexus_url, None);
        assert_eq!(saved.display_name.as_deref(), Some("Readable Name"));
    }

    #[test]
    fn clear_source_links_keeps_legacy_metadata_without_creating_empty_folder_shadow() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "ManifestName",
            ModSourceEntry {
                github_repo: Some("owner/repo".into()),
                display_name: Some("Readable Legacy Name".into()),
                ..Default::default()
            },
        );

        let cleared =
            clear_mod_source_links_from_path("ManifestName", Some("FolderName"), config).unwrap();

        assert_eq!(cleared.github_repo, None);
        assert_eq!(
            cleared.display_name.as_deref(),
            Some("Readable Legacy Name")
        );
        let db = load_sources(config);
        assert!(
            !db.mods.contains_key("FolderName"),
            "clearing links should not create an empty folder-keyed entry that hides legacy metadata"
        );
        assert_eq!(
            db.mods
                .get("ManifestName")
                .and_then(|entry| entry.display_name.as_deref()),
            Some("Readable Legacy Name"),
        );
    }

    #[test]
    fn carry_source_entry_preserves_display_overrides_across_update_rename() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "OldFolder",
            ModSourceEntry {
                github_repo: Some("owner/repo".into()),
                display_name: Some("Readable Old Name".into()),
                display_description: Some("User-maintained description".into()),
                ..Default::default()
            },
        );

        carry_source_entry(
            Some("OldFolder"),
            "old-manifest-name",
            Some("NewFolder"),
            "new-manifest-name",
            config,
        );

        let db = load_sources(config);
        let saved = db.mods.get("NewFolder").unwrap();
        assert_eq!(saved.github_repo.as_deref(), Some("owner/repo"));
        assert_eq!(saved.display_name.as_deref(), Some("Readable Old Name"));
        assert_eq!(
            saved.display_description.as_deref(),
            Some("User-maintained description"),
        );
    }

    #[test]
    fn migrate_source_entry_preserves_display_overrides_across_manifest_rename() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_entry(
            config,
            "old-manifest-name",
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/sts2/mods/77".into()),
                display_name: Some("Readable Nexus Name".into()),
                display_description: Some("Explains the upstream mod".into()),
                ..Default::default()
            },
        );

        migrate_source_entry("old-manifest-name", "new-manifest-name", config);

        let db = load_sources(config);
        let saved = db.mods.get("new-manifest-name").unwrap();
        assert_eq!(
            saved.nexus_url.as_deref(),
            Some("https://www.nexusmods.com/sts2/mods/77"),
        );
        assert_eq!(saved.display_name.as_deref(), Some("Readable Nexus Name"));
        assert_eq!(
            saved.display_description.as_deref(),
            Some("Explains the upstream mod"),
        );
    }
}

#[cfg(test)]
mod normalize_input_tests {
    //! Regression coverage for the "save reverts to broken link" / 404 audit
    //! bug. Pre-1.4.3, `set_mod_sources_full` stored whatever string the
    //! user typed into the GitHub field as-is, so a paste of
    //! `https://github.com/owner/repo` landed in mod_sources.json verbatim.
    //! The audit then called `parse_owner_repo` on that value, silently
    //! splitting it into garbage owner/repo and producing a 404 like
    //! `repos/https://github.com/owner/repo/releases/latest`.
    //!
    //! These tests pin the canonicalization rules `set_mod_sources_full`
    //! now applies before storing.
    use super::normalize_github_repo_input;

    #[test]
    fn normalize_owner_repo_passes_through() {
        assert_eq!(
            normalize_github_repo_input("BAKAOLC/STS2-MultiPlayerPotionView"),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
    }

    #[test]
    fn normalize_full_github_url_strips_to_owner_repo() {
        assert_eq!(
            normalize_github_repo_input("https://github.com/BAKAOLC/STS2-MultiPlayerPotionView"),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
    }

    #[test]
    fn normalize_github_url_with_trailing_path_or_git_suffix() {
        assert_eq!(
            normalize_github_repo_input(
                "https://github.com/BAKAOLC/STS2-MultiPlayerPotionView/releases"
            ),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
        assert_eq!(
            normalize_github_repo_input(
                "https://github.com/BAKAOLC/STS2-MultiPlayerPotionView.git"
            ),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
    }

    #[test]
    fn normalize_scheme_less_github_url() {
        assert_eq!(
            normalize_github_repo_input("github.com/BAKAOLC/STS2-MultiPlayerPotionView"),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
        assert_eq!(
            normalize_github_repo_input(
                "www.github.com/BAKAOLC/STS2-MultiPlayerPotionView/releases"
            ),
            Some("BAKAOLC/STS2-MultiPlayerPotionView".into()),
        );
    }

    #[test]
    fn normalize_github_shorthand() {
        assert_eq!(
            normalize_github_repo_input("github:owner/repo"),
            Some("owner/repo".into()),
        );
    }

    #[test]
    fn normalize_rejects_bare_owner_repo_with_extra_segments() {
        assert_eq!(normalize_github_repo_input("owner/repo/releases"), None);
    }

    #[test]
    fn normalize_rejects_empty_or_unrecognized() {
        assert_eq!(normalize_github_repo_input(""), None);
        assert_eq!(normalize_github_repo_input("   "), None);
        assert_eq!(normalize_github_repo_input("just-words-no-slash"), None);
    }

    #[test]
    fn normalize_rejects_nexus_url() {
        // A Nexus URL pasted into the GitHub field must not be silently
        // accepted — the user clearly meant the wrong field.
        assert_eq!(
            normalize_github_repo_input("https://www.nexusmods.com/slaythespire2/mods/168"),
            None,
        );
    }
}

#[cfg(test)]
mod carry_and_attach_tests {
    //! Regression coverage for the user-reported "Nexus link reset on update" bug.
    //!
    //! Before the fix, source-entry transfer and Nexus-link attach both keyed
    //! by display name only. When the rest of the codebase had moved to
    //! folder-first keying, an update could leave the source entry stranded
    //! at the old folder key while a fresh display-name-keyed entry got the
    //! new Nexus URL — `enrich_mods_with_sources` would then read the empty
    //! folder-keyed entry and the audit would report "no source".
    //!
    //! These tests exercise the folder-first variants directly. They run
    //! against a real temp dir so the serialization round-trip is part of
    //! the contract, not just the in-memory hashmap shape.
    use super::*;
    use tempfile::tempdir;

    fn write_initial(config: &Path, key: &str, entry: ModSourceEntry) {
        let mut db = ModSourcesDb::default();
        db.mods.insert(key.to_string(), entry);
        save_sources(&db, config).unwrap();
    }

    #[test]
    fn carry_preserves_nexus_link_when_entry_is_folder_keyed_and_folder_unchanged() {
        // Setup: a Nexus-linked mod stored under its folder name (the post-1.3
        // write convention). The display name happens to differ from the
        // folder — common when manifests show "Card Art Editor" but the
        // folder is "CardArtEditor".
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        let folder = "CardArtEditor";
        write_initial(
            config,
            folder,
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/42".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(42),
                installed_version: Some("1.0.0".into()),
                ..Default::default()
            },
        );

        // Simulate update: display name renames "Card Art Editor" → "CardArtEditor"
        // (the manifest field changed between releases), folder stays put.
        carry_source_entry(
            Some(folder),
            "Card Art Editor",
            Some(folder),
            "CardArtEditor",
            config,
        );

        // The folder-keyed entry must still expose the Nexus link unchanged.
        let db = load_sources(config);
        let entry = db
            .mods
            .get(folder)
            .expect("folder-keyed entry must still exist");
        assert_eq!(
            entry.nexus_mod_id,
            Some(42),
            "Nexus mod ID must survive the carry — losing it is the user-reported bug"
        );
        assert!(
            entry.nexus_url.is_some(),
            "Nexus URL must survive the carry"
        );
    }

    #[test]
    fn carry_moves_entry_when_folder_renames_between_releases() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        write_initial(
            config,
            "OldFolder",
            ModSourceEntry {
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/7".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(7),
                pinned: true,
                installed_version: Some("0.9.0".into()),
                ..Default::default()
            },
        );

        carry_source_entry(
            Some("OldFolder"),
            "SomeMod",
            Some("NewFolder"),
            "SomeMod",
            config,
        );

        // The destination (new folder) must carry the full entry.
        let db = load_sources(config);
        let dest = db
            .mods
            .get("NewFolder")
            .expect("new-folder destination must exist after carry");
        assert_eq!(dest.nexus_mod_id, Some(7));
        assert!(dest.pinned, "pinned state must survive the folder rename");
        assert_eq!(dest.installed_version.as_deref(), Some("0.9.0"));
    }

    #[test]
    fn carry_is_a_noop_when_old_entry_does_not_exist() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        // No initial DB write. Carry should not create a phantom destination.
        carry_source_entry(
            Some("NoSuchFolder"),
            "NoSuchMod",
            Some("Whatever"),
            "Whatever",
            config,
        );
        let db = load_sources(config);
        assert!(
            db.mods.is_empty() || !db.mods.contains_key("Whatever"),
            "carry must not synthesize a destination entry when the source is missing"
        );
    }

    #[test]
    fn carry_does_not_clobber_existing_destination_fields() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        // Old folder-keyed entry has a GitHub link.
        write_initial(
            config,
            "OldFolder",
            ModSourceEntry {
                github_repo: Some("user/old-repo".into()),
                ..Default::default()
            },
        );
        // Destination already has a DIFFERENT GitHub link (newer choice).
        // Carry must NOT overwrite it.
        {
            let mut db = load_sources(config);
            db.mods.insert(
                "NewFolder".to_string(),
                ModSourceEntry {
                    github_repo: Some("user/new-repo".into()),
                    ..Default::default()
                },
            );
            save_sources(&db, config).unwrap();
        }

        carry_source_entry(Some("OldFolder"), "x", Some("NewFolder"), "x", config);

        let db = load_sources(config);
        let dest = db.mods.get("NewFolder").unwrap();
        assert_eq!(
            dest.github_repo.as_deref(),
            Some("user/new-repo"),
            "destination's existing github_repo must win — merge fills empty slots only"
        );
    }

    #[test]
    fn attach_nexus_writes_under_folder_key_when_folder_is_known() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        // An existing folder-keyed entry (e.g. with installed_version set
        // by an earlier install) must receive the Nexus link, not get a
        // sibling display-name-keyed entry created next to it.
        write_initial(
            config,
            "MyMod",
            ModSourceEntry {
                installed_version: Some("1.2.3".into()),
                ..Default::default()
            },
        );

        attach_nexus_source(
            "MyMod Display Name",
            Some("MyMod"),
            "https://www.nexusmods.com/slaythespire2/mods/100".into(),
            "slaythespire2".into(),
            100,
            config,
        );

        let db = load_sources(config);
        assert_eq!(
            db.mods.len(),
            1,
            "must reuse the existing folder-keyed entry, not split state across two keys — \
             the split was the underlying bug behind 'I set a Nexus URL, audit still says no source'"
        );
        let entry = db
            .mods
            .get("MyMod")
            .expect("folder-keyed entry must persist");
        assert_eq!(entry.nexus_mod_id, Some(100));
        assert_eq!(
            entry.installed_version.as_deref(),
            Some("1.2.3"),
            "attach must not blow away pre-existing fields on the same entry"
        );
    }

    #[test]
    fn attach_nexus_falls_back_to_name_when_no_folder_known() {
        let tmp = tempdir().unwrap();
        let config = tmp.path();
        attach_nexus_source(
            "LegacyMod",
            None,
            "https://www.nexusmods.com/slaythespire2/mods/200".into(),
            "slaythespire2".into(),
            200,
            config,
        );
        let db = load_sources(config);
        assert_eq!(
            db.mods.get("LegacyMod").and_then(|e| e.nexus_mod_id),
            Some(200),
            "without a folder hint, attach writes under display name"
        );
    }
}

#[cfg(test)]
mod shared_profile_source_tests {
    //! Coverage for the two helpers that move source links across a shared
    //! pack: `fill_source_if_absent` (import side) and `shareable_source_for`
    //! (export side). The contract that matters most for the user-reported
    //! "everything shows Unlinked after importing a pack" bug is the
    //! fill-only, never-clobber behaviour — re-installing or re-subscribing a
    //! pack must not erase a link, note, or preserved config the user owns.
    use super::*;

    fn gh(repo: &str) -> ModSourceEntry {
        parse_source_url(&format!("github:{}", repo)).unwrap()
    }

    #[test]
    fn fills_github_into_an_empty_db() {
        let mut db = ModSourcesDb::default();
        let wrote = fill_source_if_absent(&mut db, "AutoPath", &gh("foo/AutoPath"));
        assert!(wrote, "writing a brand-new link must report a change");
        let entry = db.mods.get("AutoPath").expect("entry created");
        assert_eq!(entry.github_repo.as_deref(), Some("foo/AutoPath"));
        assert!(
            entry.github_auto_detected,
            "a curator-supplied link is auto-detected, not user-authored"
        );
    }

    fn extras(
        note: Option<&str>,
        url: Option<&str>,
        tags: &[&str],
    ) -> crate::profiles::SharedModExtras {
        crate::profiles::SharedModExtras {
            note: note.map(String::from),
            custom_url: url.map(String::from),
            tags: tags.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn merge_shared_extras_fills_empty_fields_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let mut shared = HashMap::new();
        shared.insert(
            "AutoPath".to_string(),
            extras(
                Some("compat patch for beta"),
                Some("https://patreon.com/x"),
                &["QoL"],
            ),
        );
        merge_shared_extras(&shared, tmp.path());

        let db = load_sources(tmp.path());
        let entry = db.mods.get("AutoPath").expect("entry created");
        assert_eq!(entry.note.as_deref(), Some("compat patch for beta"));
        assert_eq!(entry.custom_url.as_deref(), Some("https://patreon.com/x"));
        assert_eq!(entry.tags, vec!["QoL".to_string()]);
    }

    #[test]
    fn merge_shared_extras_never_clobbers_user_annotations() {
        // The receiver wrote their own note + tags; the curator's version
        // of those fields must lose. The curator's custom_url fills the
        // one field the user left empty.
        let tmp = tempfile::tempdir().unwrap();
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".into(),
            ModSourceEntry {
                note: Some("MY note".into()),
                tags: vec!["my-tag".into()],
                ..Default::default()
            },
        );
        save_sources(&db, tmp.path()).unwrap();

        let mut shared = HashMap::new();
        shared.insert(
            "AutoPath".to_string(),
            extras(
                Some("curator note"),
                Some("https://example.com"),
                &["curator-tag"],
            ),
        );
        merge_shared_extras(&shared, tmp.path());

        let db = load_sources(tmp.path());
        let entry = db.mods.get("AutoPath").unwrap();
        assert_eq!(entry.note.as_deref(), Some("MY note"), "user's note wins");
        assert_eq!(entry.tags, vec!["my-tag".to_string()], "user's tags win");
        assert_eq!(
            entry.custom_url.as_deref(),
            Some("https://example.com"),
            "the field the user left empty is filled"
        );
    }

    #[test]
    fn never_clobbers_a_users_existing_github_link() {
        // The user hand-linked this mod to the CORRECT repo. A pack that
        // happens to point at a different repo must not overwrite it.
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".into(),
            ModSourceEntry {
                github_repo: Some("realauthor/AutoPath".into()),
                github_auto_detected: false,
                ..Default::default()
            },
        );
        let wrote = fill_source_if_absent(&mut db, "AutoPath", &gh("impostor/AutoPath"));
        assert!(!wrote, "an already-linked mod reports no change");
        let entry = db.mods.get("AutoPath").unwrap();
        assert_eq!(
            entry.github_repo.as_deref(),
            Some("realauthor/AutoPath"),
            "the user's link wins"
        );
        assert!(
            !entry.github_auto_detected,
            "and stays marked user-authored"
        );
    }

    #[test]
    fn fills_github_while_preserving_unrelated_user_fields() {
        // A mod with a note + preserved config hash + pin, but no source yet.
        // Filling the source must leave every other field untouched.
        let mut db = ModSourcesDb::default();
        let mut hashes = HashMap::new();
        hashes.insert("settings.cfg".to_string(), "deadbeef".to_string());
        db.mods.insert(
            "stats_the_spire".into(),
            ModSourceEntry {
                note: Some("got it from Discord".into()),
                custom_url: Some("https://discord.gg/x".into()),
                pinned: true,
                config_hashes: hashes,
                ..Default::default()
            },
        );
        let wrote =
            fill_source_if_absent(&mut db, "stats_the_spire", &gh("author/stats_the_spire"));
        assert!(wrote);
        let entry = db.mods.get("stats_the_spire").unwrap();
        assert_eq!(entry.github_repo.as_deref(), Some("author/stats_the_spire"));
        assert_eq!(entry.note.as_deref(), Some("got it from Discord"));
        assert_eq!(entry.custom_url.as_deref(), Some("https://discord.gg/x"));
        assert!(entry.pinned, "pin survives a source fill");
        assert_eq!(
            entry.config_hashes.get("settings.cfg").map(String::as_str),
            Some("deadbeef"),
            "preserved config hashes survive a source fill"
        );
    }

    #[test]
    fn fills_nexus_without_disturbing_an_existing_github_link() {
        // Mod already GitHub-linked by hand; the pack carries a Nexus link.
        // The two are independent: Nexus fills in, GitHub stays as-is.
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "ModX".into(),
            ModSourceEntry {
                github_repo: Some("me/ModX".into()),
                github_auto_detected: false,
                ..Default::default()
            },
        );
        let nexus = parse_source_url("nexus:slaythespire2/mods/77").unwrap();
        let wrote = fill_source_if_absent(&mut db, "ModX", &nexus);
        assert!(wrote, "filling the empty Nexus side is a change");
        let entry = db.mods.get("ModX").unwrap();
        assert_eq!(entry.github_repo.as_deref(), Some("me/ModX"));
        assert_eq!(entry.nexus_mod_id, Some(77));
        assert_eq!(entry.nexus_game_domain.as_deref(), Some("slaythespire2"));
    }

    #[test]
    fn empty_parsed_entry_writes_nothing() {
        let mut db = ModSourcesDb::default();
        let wrote = fill_source_if_absent(&mut db, "ModX", &ModSourceEntry::default());
        assert!(!wrote);
        assert!(
            db.mods.is_empty(),
            "a sourceless fill must not create a noise entry"
        );
    }

    #[test]
    fn shareable_source_round_trips_github_through_parse() {
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "RegentCardsAnimeRework".into(),
            gh("DoublePigeon/RegentCardsAnimeRework"),
        );
        let src = shareable_source_for(&db, Some("RegentCardsAnimeRework"), "RegentCards", None)
            .expect("github link is shareable");
        assert_eq!(src, "github:DoublePigeon/RegentCardsAnimeRework");
        // The whole point: the shorthand we publish parses back to the same link.
        let reparsed = parse_source_url(&src).unwrap();
        assert_eq!(
            reparsed.github_repo.as_deref(),
            Some("DoublePigeon/RegentCardsAnimeRework")
        );
    }

    #[test]
    fn shareable_source_prefers_github_then_falls_back_to_nexus() {
        // GitHub present → GitHub wins.
        let mut db = ModSourcesDb::default();
        db.mods.insert(
            "Both".into(),
            ModSourceEntry {
                github_repo: Some("o/Both".into()),
                nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/5".into()),
                nexus_game_domain: Some("slaythespire2".into()),
                nexus_mod_id: Some(5),
                ..Default::default()
            },
        );
        assert_eq!(
            shareable_source_for(&db, Some("Both"), "Both", None).as_deref(),
            Some("github:o/Both")
        );

        // Nexus-only → Nexus shorthand, and it round-trips.
        let mut db2 = ModSourcesDb::default();
        db2.mods.insert(
            "NexusOnly".into(),
            parse_source_url("nexus:slaythespire2/mods/123").unwrap(),
        );
        let src = shareable_source_for(&db2, Some("NexusOnly"), "NexusOnly", None).unwrap();
        assert_eq!(src, "nexus:slaythespire2/mods/123");
        assert_eq!(parse_source_url(&src).unwrap().nexus_mod_id, Some(123));
    }

    #[test]
    fn shareable_source_is_none_for_unlinked_mod() {
        let db = ModSourcesDb::default();
        assert!(shareable_source_for(&db, Some("Unknown"), "Unknown", None).is_none());
    }

    // ── scope_installed unit tests ────────────────────────────────────────────

    fn make_mod(name: &str, folder: Option<&str>) -> crate::mods::ModInfo {
        crate::mods::ModInfo {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            enabled: true,
            files: vec![],
            source: None,
            hash: None,
            dependencies: vec![],
            size_bytes: 0,
            folder_name: folder.map(String::from),
            mod_id: None,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            pinned: false,
            min_game_version: None,
            author: None,
            tags: vec![],
            display_name: None,
            display_description: None,
            note: None,
            custom_url: None,
            bundle_members: vec![],
        }
    }

    #[test]
    fn scope_installed_none_returns_all() {
        let installed = vec![
            make_mod("Alpha", Some("alpha-folder")),
            make_mod("Beta", Some("beta-folder")),
        ];
        let result = scope_installed(installed, None);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn scope_installed_matches_by_folder_name() {
        let installed = vec![
            make_mod("Alpha", Some("alpha-folder")),
            make_mod("Beta", Some("beta-folder")),
        ];
        let result = scope_installed(installed, Some("alpha-folder"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Alpha");
    }

    #[test]
    fn scope_installed_matches_by_mod_name_when_no_folder() {
        let installed = vec![make_mod("AlicePack", None), make_mod("BobPack", None)];
        let result = scope_installed(installed, Some("AlicePack"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "AlicePack");
    }

    #[test]
    fn scope_installed_no_match_returns_empty() {
        let installed = vec![make_mod("Alpha", Some("alpha-folder"))];
        let result = scope_installed(installed, Some("nonexistent"));
        assert!(result.is_empty());
    }
}
