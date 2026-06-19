use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::ModInfo;
use crate::state::AppState;

const GAME_LOG_TAIL_LINES: usize = 10_000;
const AUTO_RECOVERY_STATE_FILE: &str = "launch_recovery_state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LaunchLogSignature {
    path: String,
    modified_ms: u64,
    len: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LaunchRecoveryState {
    last_auto_recovered_log: Option<LaunchLogSignature>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchFailureReason {
    ReflectionTypeLoad,
    MissingMethod,
    MissingDependency,
    AssemblyInit,
    CriticalPatch,
    LoadFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchFailureMod {
    pub name: String,
    pub display_name: Option<String>,
    pub version: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub reasons: Vec<LaunchFailureReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchDiagnostics {
    pub log_path: Option<String>,
    pub game_version: Option<String>,
    pub failed_mods: Vec<LaunchFailureMod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchQuarantinedMod {
    pub name: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchQuarantineFailure {
    pub name: String,
    pub folder_name: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchQuarantineResult {
    pub active_profile_id: Option<String>,
    pub moved: Vec<LaunchQuarantinedMod>,
    pub disabled_profile_entries: Vec<LaunchQuarantinedMod>,
    pub failed: Vec<LaunchQuarantineFailure>,
}

#[tauri::command]
pub fn get_launch_diagnostics(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LaunchDiagnostics, String> {
    let (mods_path, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.mods_path.clone(), s.game_version.clone())
    };
    let Some(mods_path) = mods_path else {
        return Ok(LaunchDiagnostics {
            log_path: game_log_path().map(|path| path.to_string_lossy().to_string()),
            game_version,
            failed_mods: Vec::new(),
        });
    };

    let log_path = game_log_path();
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_TAIL_LINES)?;
    let active_mods = crate::mods::scan_mods(&mods_path);
    Ok(diagnose_launch_log(
        &log_text,
        &active_mods,
        game_version,
        log_path.as_deref(),
    ))
}

#[tauri::command]
pub fn quarantine_launch_failures(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LaunchQuarantineResult, String> {
    crate::game::ensure_game_not_running()?;
    let (mods_path, disabled_path, profiles_path, config_path, active_profile_id, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.mods_path.as_ref().ok_or("Game path not set")?.clone(),
            s.disabled_mods_path
                .as_ref()
                .ok_or("Game path not set")?
                .clone(),
            s.profiles_path.clone(),
            s.config_path.clone(),
            s.active_profile.clone(),
            s.game_version.clone(),
        )
    };

    let log_path = game_log_path();
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_TAIL_LINES)?;
    quarantine_launch_failures_from_paths(
        &log_text,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        active_profile_id,
        game_version,
        log_path.as_deref(),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn auto_quarantine_launch_failures(
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    active_profile_id: Option<String>,
    game_version: Option<String>,
) -> Result<LaunchQuarantineResult> {
    let log_path = game_log_path();
    let signature = launch_log_signature(log_path.as_deref())?;
    if signature.as_ref().is_some_and(|sig| {
        launch_recovery_state(config_path)
            .last_auto_recovered_log
            .as_ref()
            == Some(sig)
    }) {
        return Ok(empty_quarantine_result(active_profile_id));
    }

    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_TAIL_LINES)
        .map_err(AppError::Other)?;
    auto_quarantine_launch_failures_from_paths(
        &log_text,
        log_path.as_deref(),
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        active_profile_id,
        game_version,
    )
}

pub(crate) fn diagnose_launch_log(
    log_text: &str,
    active_mods: &[ModInfo],
    game_version: Option<String>,
    log_path: Option<&Path>,
) -> LaunchDiagnostics {
    let mut failures: BTreeMap<String, BTreeSet<LaunchFailureReason>> = BTreeMap::new();
    let mut context: VecDeque<String> = VecDeque::new();
    let explicit_patterns = explicit_mod_patterns();

    for line in log_text.lines() {
        let reason = hard_failure_reason(line);
        if let Some(reason) = reason {
            let explicit_tokens = explicit_patterns
                .iter()
                .filter_map(|re| re.captures(line))
                .filter_map(|captures| captures.name("mod").map(|m| m.as_str().trim()))
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>();

            if explicit_tokens.is_empty() {
                let direct_matches: Vec<&ModInfo> = active_mods
                    .iter()
                    .filter(|installed| mod_mentions_text(installed, line))
                    .collect();
                if direct_matches.is_empty() {
                    let searchable = if context.is_empty() {
                        line.to_string()
                    } else {
                        format!(
                            "{}\n{}",
                            context.iter().cloned().collect::<Vec<_>>().join("\n"),
                            line
                        )
                    };
                    for installed in active_mods {
                        if mod_mentions_text(installed, &searchable) {
                            failures
                                .entry(mod_key(installed))
                                .or_default()
                                .insert(reason);
                        }
                    }
                } else {
                    for installed in direct_matches {
                        failures
                            .entry(mod_key(installed))
                            .or_default()
                            .insert(reason);
                    }
                }
            } else {
                for token in explicit_tokens {
                    for installed in active_mods {
                        if mod_matches_token(installed, token) {
                            failures
                                .entry(mod_key(installed))
                                .or_default()
                                .insert(reason);
                        }
                    }
                }
            }
        }

        context.push_back(line.to_string());
        while context.len() > 4 {
            context.pop_front();
        }
    }

    let by_key: BTreeMap<String, &ModInfo> = active_mods
        .iter()
        .map(|installed| (mod_key(installed), installed))
        .collect();
    let failed_mods = failures
        .into_iter()
        .filter_map(|(key, reasons)| {
            let installed = by_key.get(&key)?;
            Some(LaunchFailureMod {
                name: installed.name.clone(),
                display_name: installed.display_name.clone(),
                version: installed.version.clone(),
                folder_name: installed.folder_name.clone(),
                mod_id: installed.mod_id.clone(),
                reasons: reasons.into_iter().collect(),
            })
        })
        .collect();

    LaunchDiagnostics {
        log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        game_version,
        failed_mods,
    }
}

pub(crate) fn quarantine_launch_failures_from_paths(
    log_text: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    active_profile_id: Option<String>,
    game_version: Option<String>,
    log_path: Option<&Path>,
) -> Result<LaunchQuarantineResult> {
    validate_mod_root_pair(mods_path, disabled_path)?;
    fs::create_dir_all(disabled_path)?;

    let mut active_mods = crate::mods::scan_mods(mods_path);
    crate::mod_versions::enrich_mods_with_versions(&mut active_mods, config_path);
    let diagnostics = diagnose_launch_log(log_text, &active_mods, game_version, log_path);
    let failed_keys = quarantine_target_keys(&diagnostics.failed_mods, &active_mods);
    let target_mods: Vec<&ModInfo> = active_mods
        .iter()
        .filter(|installed| failed_keys.contains(&mod_key(installed)))
        .collect();

    let mut disabled_profile_entries = Vec::new();
    if let Some(profile_id) = active_profile_id.as_deref() {
        let mut profile = crate::profiles::load_profile(profile_id, profiles_path)?;
        let mut changed = false;
        for profile_mod in &mut profile.mods {
            if !profile_mod.enabled {
                continue;
            }
            if target_mods
                .iter()
                .any(|installed| profile_entry_matches_mod(profile_mod, installed))
            {
                profile_mod.enabled = false;
                changed = true;
                disabled_profile_entries.push(LaunchQuarantinedMod {
                    name: profile_mod.name.clone(),
                    folder_name: profile_mod.folder_name.clone(),
                    mod_id: profile_mod.mod_id.clone(),
                    destination: None,
                });
            }
        }
        if changed {
            profile.updated_at = chrono::Utc::now();
            crate::profiles::save_profile(&profile, profiles_path)?;
        }
    }

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for installed in active_mods {
        if !failed_keys.contains(&mod_key(&installed)) {
            continue;
        }
        match move_mod_to_disabled_preserving_conflicts(
            &installed,
            mods_path,
            disabled_path,
            &stamp,
        ) {
            Ok(destination) => moved.push(LaunchQuarantinedMod {
                name: installed.name.clone(),
                folder_name: installed.folder_name.clone(),
                mod_id: installed.mod_id.clone(),
                destination: Some(destination.to_string_lossy().to_string()),
            }),
            Err(err) => failed.push(LaunchQuarantineFailure {
                name: installed.name.clone(),
                folder_name: installed.folder_name.clone(),
                error: err.to_string(),
            }),
        }
    }

    Ok(LaunchQuarantineResult {
        active_profile_id,
        moved,
        disabled_profile_entries,
        failed,
    })
}

pub(crate) fn auto_quarantine_launch_failures_from_paths(
    log_text: &str,
    log_path: Option<&Path>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    active_profile_id: Option<String>,
    game_version: Option<String>,
) -> Result<LaunchQuarantineResult> {
    let signature = launch_log_signature(log_path)?;
    if signature.as_ref().is_some_and(|sig| {
        launch_recovery_state(config_path)
            .last_auto_recovered_log
            .as_ref()
            == Some(sig)
    }) {
        return Ok(empty_quarantine_result(active_profile_id));
    }

    let result = quarantine_launch_failures_from_paths(
        log_text,
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        active_profile_id,
        game_version,
        log_path,
    )?;

    if result.failed.is_empty() {
        if let Some(signature) = signature {
            save_launch_recovery_state(
                config_path,
                &LaunchRecoveryState {
                    last_auto_recovered_log: Some(signature),
                },
            )?;
        }
    }

    Ok(result)
}

fn game_log_path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("SlayTheSpire2").join("logs").join("godot.log"))
}

fn empty_quarantine_result(active_profile_id: Option<String>) -> LaunchQuarantineResult {
    LaunchQuarantineResult {
        active_profile_id,
        moved: Vec::new(),
        disabled_profile_entries: Vec::new(),
        failed: Vec::new(),
    }
}

fn launch_log_signature(log_path: Option<&Path>) -> Result<Option<LaunchLogSignature>> {
    let Some(path) = log_path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path)?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Ok(Some(LaunchLogSignature {
        path: path.to_string_lossy().to_string(),
        modified_ms,
        len: metadata.len(),
    }))
}

fn launch_recovery_state(config_path: &Path) -> LaunchRecoveryState {
    fs::read_to_string(config_path.join(AUTO_RECOVERY_STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_launch_recovery_state(config_path: &Path, state: &LaunchRecoveryState) -> Result<()> {
    fs::create_dir_all(config_path)?;
    fs::write(
        config_path.join(AUTO_RECOVERY_STATE_FILE),
        serde_json::to_vec_pretty(state)?,
    )?;
    Ok(())
}

fn read_log_tail_from_path(
    path: Option<&Path>,
    lines: usize,
) -> std::result::Result<String, String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    if !path.exists() {
        return Ok(String::new());
    }
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read game log {}: {}", path.display(), e))?;
    let collected: Vec<&str> = text.lines().collect();
    let start = collected
        .len()
        .saturating_sub(lines.clamp(1, GAME_LOG_TAIL_LINES));
    Ok(collected[start..].join("\n"))
}

fn explicit_mod_patterns() -> Vec<Regex> {
    [
        r"(?i)while loading mod (?P<mod>[^:!]+)",
        r"(?i)assembly dll for mod (?P<mod>.+?) failed to initialize",
        r"(?i)^mod (?P<mod>.+?) is missing \d+ dependenc",
        r"(?i)tried to load mod (?P<mod>.+?), but it depends on mods",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("valid launch diagnostic regex"))
    .collect()
}

fn hard_failure_reason(line: &str) -> Option<LaunchFailureReason> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("reflectiontypeloadexception")
        || lower.contains("does not have an implementation")
    {
        Some(LaunchFailureReason::ReflectionTypeLoad)
    } else if lower.contains("missingmethodexception") || lower.contains("method not found") {
        Some(LaunchFailureReason::MissingMethod)
    } else if lower.contains("missing") && lower.contains("dependenc") {
        Some(LaunchFailureReason::MissingDependency)
    } else if lower.contains("exception thrown when calling mod initializer") {
        Some(LaunchFailureReason::AssemblyInit)
    } else if lower.contains("failed to initialize") {
        Some(LaunchFailureReason::AssemblyInit)
    } else if lower.contains("critical patch") || lower.contains("mod loading blocked") {
        Some(LaunchFailureReason::CriticalPatch)
    } else if lower.contains("failed to load") || lower.contains("failed while loading") {
        Some(LaunchFailureReason::LoadFailed)
    } else {
        None
    }
}

fn mod_key(info: &ModInfo) -> String {
    info.folder_name
        .as_deref()
        .filter(|folder| !folder.trim().is_empty())
        .unwrap_or(info.name.as_str())
        .to_ascii_lowercase()
}

fn failure_key(failure: &LaunchFailureMod) -> String {
    failure
        .folder_name
        .as_deref()
        .filter(|folder| !folder.trim().is_empty())
        .unwrap_or(failure.name.as_str())
        .to_ascii_lowercase()
}

fn quarantine_target_keys(
    failed_mods: &[LaunchFailureMod],
    active_mods: &[ModInfo],
) -> BTreeSet<String> {
    let mut target_keys: BTreeSet<String> = failed_mods.iter().map(failure_key).collect();
    let mut broken_ids: BTreeSet<String> = BTreeSet::new();
    for failure in failed_mods {
        collect_failure_identity_tokens(failure, &mut broken_ids);
    }

    let mut changed = true;
    while changed {
        changed = false;
        for installed in active_mods {
            if target_keys.contains(&mod_key(installed)) {
                continue;
            }
            let depends_on_broken = installed
                .dependencies
                .iter()
                .any(|dependency| broken_ids.contains(&normalize_token(dependency)));
            if depends_on_broken {
                target_keys.insert(mod_key(installed));
                for token in mod_identity_tokens(installed) {
                    broken_ids.insert(normalize_token(&token));
                }
                changed = true;
            }
        }
    }

    target_keys
}

fn collect_failure_identity_tokens(failure: &LaunchFailureMod, out: &mut BTreeSet<String>) {
    out.insert(normalize_token(&failure.name));
    if let Some(display_name) = failure.display_name.as_deref() {
        out.insert(normalize_token(display_name));
    }
    if let Some(folder_name) = failure.folder_name.as_deref() {
        out.insert(normalize_token(folder_name));
    }
    if let Some(mod_id) = failure.mod_id.as_deref() {
        out.insert(normalize_token(mod_id));
    }
}

fn mod_matches_token(info: &ModInfo, token: &str) -> bool {
    let token = normalize_token(token);
    if token.is_empty() {
        return false;
    }
    mod_identity_tokens(info)
        .into_iter()
        .any(|candidate| normalize_token(&candidate) == token)
}

fn mod_mentions_text(info: &ModInfo, text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    mod_identity_tokens(info).into_iter().any(|candidate| {
        let candidate = candidate.trim().to_ascii_lowercase();
        candidate.len() >= 4 && text.contains(&candidate)
    })
}

fn mod_identity_tokens(info: &ModInfo) -> Vec<String> {
    let mut tokens = Vec::new();
    tokens.push(info.name.clone());
    if let Some(display_name) = info.display_name.as_ref() {
        tokens.push(display_name.clone());
    }
    if let Some(folder_name) = info.folder_name.as_ref() {
        tokens.push(folder_name.clone());
    }
    if let Some(mod_id) = info.mod_id.as_ref() {
        tokens.push(mod_id.clone());
    }
    tokens.extend(info.bundle_member_ids.clone());
    tokens
}

fn normalize_token(token: &str) -> String {
    token
        .trim()
        .trim_matches(|c: char| c == '\'' || c == '"' || c == '`')
        .to_ascii_lowercase()
}

fn profile_entry_matches_mod(profile_mod: &crate::profiles::ProfileMod, info: &ModInfo) -> bool {
    profile_mod
        .folder_name
        .as_deref()
        .zip(info.folder_name.as_deref())
        .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
        || profile_mod
            .mod_id
            .as_deref()
            .zip(info.mod_id.as_deref())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
        || profile_mod.name.eq_ignore_ascii_case(&info.name)
}

fn validate_mod_root_pair(mods_path: &Path, disabled_path: &Path) -> Result<()> {
    let mods_name_ok = path_file_name_eq(mods_path, "mods");
    let disabled_name_ok = path_file_name_eq(disabled_path, "mods_disabled");
    let same_parent = mods_path.parent().is_some() && mods_path.parent() == disabled_path.parent();
    if mods_name_ok && disabled_name_ok && same_parent {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "Refusing to store failed mods: expected sibling 'mods' and 'mods_disabled' folders, got '{}' and '{}'",
            mods_path.display(),
            disabled_path.display()
        )))
    }
}

fn path_file_name_eq(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn move_mod_to_disabled_preserving_conflicts(
    info: &ModInfo,
    mods_path: &Path,
    disabled_path: &Path,
    stamp: &str,
) -> Result<PathBuf> {
    let top_entries = top_level_entries(info)?;
    if top_entries.is_empty() {
        return Err(AppError::ModNotFound(format!(
            "No files found for mod '{}'",
            info.name
        )));
    }

    if top_entries.len() == 1 {
        let entry = top_entries.iter().next().expect("one entry");
        let src = mods_path.join(entry);
        if src.exists() {
            let dest = unique_destination(disabled_path, entry, stamp);
            move_entry(&src, &dest)?;
            return Ok(dest);
        }
    }

    let folder = info
        .folder_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(info.name.as_str());
    let dest_root = unique_destination(disabled_path, folder, stamp);
    fs::create_dir_all(&dest_root)?;
    let mut moved_any = false;
    for file_rel in &info.files {
        let rel = safe_relative_path(file_rel)?;
        let src = mods_path.join(&rel);
        if !src.exists() {
            continue;
        }
        let dest = dest_root.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        move_entry(&src, &dest)?;
        moved_any = true;
    }
    cleanup_empty_dirs(mods_path, &top_entries);
    if moved_any {
        Ok(dest_root)
    } else {
        Err(AppError::ModNotFound(format!(
            "No files found for mod '{}' in {}",
            info.name,
            mods_path.display()
        )))
    }
}

fn top_level_entries(info: &ModInfo) -> Result<BTreeSet<PathBuf>> {
    let mut entries = BTreeSet::new();
    for file_rel in &info.files {
        let rel = safe_relative_path(file_rel)?;
        if let Some(Component::Normal(first)) = rel.components().next() {
            entries.insert(PathBuf::from(first));
        }
    }
    Ok(entries)
}

fn safe_relative_path(file_rel: &str) -> Result<PathBuf> {
    let path = Path::new(file_rel);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(AppError::Other(format!(
                    "Unsafe mod path '{}' cannot be moved",
                    file_rel
                )));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        Err(AppError::Other(
            "Empty mod file path cannot be moved".into(),
        ))
    } else {
        Ok(clean)
    }
}

fn unique_destination(base: &Path, name: impl AsRef<Path>, stamp: &str) -> PathBuf {
    let name = name.as_ref();
    let direct = base.join(name);
    if !direct.exists() {
        return direct;
    }

    let file_name = name
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("failed-mod");
    let parent = name.parent().unwrap_or_else(|| Path::new(""));
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or(file_name);
    let ext = Path::new(file_name)
        .extension()
        .and_then(|part| part.to_str());
    for index in 1..1000u32 {
        let suffix = if index == 1 {
            format!("__failed_launch_{stamp}")
        } else {
            format!("__failed_launch_{stamp}-{index}")
        };
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem}{suffix}.{ext}"),
            _ => format!("{file_name}{suffix}"),
        };
        let candidate = base.join(parent).join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    base.join(parent)
        .join(format!("{file_name}__failed_launch_{stamp}-overflow"))
}

fn move_entry(src: &Path, dest: &Path) -> std::io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if src.is_dir() {
        fs::rename(src, dest).or_else(|_| crate::mods::move_directory(src, dest))?;
        let _ = fs::remove_dir_all(src);
    } else {
        fs::rename(src, dest)
            .or_else(|_| fs::copy(src, dest).and_then(|_| fs::remove_file(src)))?;
    }
    Ok(())
}

fn cleanup_empty_dirs(base: &Path, top_entries: &BTreeSet<PathBuf>) {
    for entry in top_entries {
        let path = base.join(entry);
        if path.is_dir()
            && fs::read_dir(&path)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
        {
            let _ = fs::remove_dir(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{Profile, ProfileMod};
    use chrono::Utc;
    use tempfile::tempdir;

    fn mod_info(name: &str, folder_name: &str, mod_id: &str) -> ModInfo {
        ModInfo {
            mod_version_id: None,
            name: name.into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec![
                format!("{folder_name}/{mod_id}.dll"),
                format!("{folder_name}/{mod_id}.json"),
            ],
            source: None,
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            folder_name: Some(folder_name.into()),
            mod_id: Some(mod_id.into()),
            pinned: false,
            bundle_members: Vec::new(),
            bundle_member_ids: Vec::new(),
            min_game_version: None,
            author: None,
            note: None,
            custom_url: None,
            tags: Vec::new(),
            display_name: None,
            display_description: None,
        }
    }

    #[test]
    fn launch_log_diagnostics_detects_hard_failures_without_migration_noise() {
        let active = vec![
            mod_info("Miyu", "Miyu_character", "Miyu_character"),
            mod_info("BetterRewards", "BetterRewards", "BetterRewards"),
            mod_info(
                "CardsAndRelicsChooser",
                "CardsAndRelicsChooser",
                "CardsAndRelicsChooser",
            ),
            mod_info("OldWarning", "OldWarning", "OldWarning"),
        ];
        let log = [
            "Mod OldWarning has a mod manifest that should be migrated! See logs for more info.",
            "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod Miyu_character! See logs for more info.",
            "Mod BetterRewards is missing 1 dependencies: ModManagerSettings",
            "Exception thrown when calling mod initializer of type CardsAndRelicsChooser.Plugin: System.Reflection.TargetInvocationException",
        ]
        .join("\n");

        let diagnostics = diagnose_launch_log(&log, &active, Some("0.107.1".into()), None);
        let names = diagnostics
            .failed_mods
            .iter()
            .map(|m| m.folder_name.as_deref().unwrap_or(m.name.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["BetterRewards", "CardsAndRelicsChooser", "Miyu_character"]
        );
        assert!(diagnostics
            .failed_mods
            .iter()
            .all(|m| m.folder_name.as_deref() != Some("OldWarning")));
    }

    #[test]
    fn launch_quarantine_moves_failed_mods_without_overwriting_stored_copy() {
        let root = tempdir().unwrap();
        let mods = root.path().join("mods");
        let disabled = root.path().join("mods_disabled");
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(mods.join("STS2-RitsuLib")).unwrap();
        fs::create_dir_all(mods.join("EndRunGraph")).unwrap();
        fs::create_dir_all(disabled.join("STS2-RitsuLib")).unwrap();
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(mods.join("STS2-RitsuLib/STS2-RitsuLib.dll"), b"dll").unwrap();
        fs::write(
            mods.join("STS2-RitsuLib/mod_manifest.json"),
            br#"{"id":"STS2-RitsuLib","name":"RitsuLib","version":"0.4.24"}"#,
        )
        .unwrap();
        fs::write(mods.join("EndRunGraph/EndRunGraph.dll"), b"dll").unwrap();
        fs::write(
            mods.join("EndRunGraph/mod_manifest.json"),
            br#"{"id":"EndRunGraph","name":"EndRunGraph","version":"0.1.0","dependencies":["STS2-RitsuLib"]}"#,
        )
        .unwrap();
        fs::write(disabled.join("STS2-RitsuLib/old.txt"), b"old").unwrap();

        let profile = Profile {
            id: "active".into(),
            name: "Active".into(),
            game_version: None,
            created_by: None,
            mods: vec![
                ProfileMod {
                    mod_version_id: None,
                    name: "RitsuLib".into(),
                    version: "0.4.24".into(),
                    source: None,
                    hash: None,
                    files: vec![],
                    folder_name: Some("STS2-RitsuLib".into()),
                    mod_id: Some("STS2-RitsuLib".into()),
                    enabled: true,
                    bundle_url: None,
                    bundle_sha256: None,
                    bundle_members: Vec::new(),
                    bundle_member_ids: Vec::new(),
                },
                ProfileMod {
                    mod_version_id: None,
                    name: "EndRunGraph".into(),
                    version: "0.1.0".into(),
                    source: None,
                    hash: None,
                    files: vec![],
                    folder_name: Some("EndRunGraph".into()),
                    mod_id: Some("EndRunGraph".into()),
                    enabled: true,
                    bundle_url: None,
                    bundle_sha256: None,
                    bundle_members: Vec::new(),
                    bundle_member_ids: Vec::new(),
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles).unwrap();
        let log = "[com.ritsukage.sts2-RitsuLib] Critical patch(es) failed, mod loading blocked";

        let result = quarantine_launch_failures_from_paths(
            log,
            &mods,
            &disabled,
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
            None,
        )
        .unwrap();

        assert_eq!(result.moved.len(), 2);
        assert!(!mods.join("STS2-RitsuLib").exists());
        assert!(!mods.join("EndRunGraph").exists());
        assert!(disabled.join("STS2-RitsuLib/old.txt").exists());
        assert!(disabled.join("EndRunGraph").exists());
        assert!(disabled.read_dir().unwrap().flatten().any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("STS2-RitsuLib__failed_launch_")));
        let updated = crate::profiles::load_profile("active", &profiles).unwrap();
        assert!(updated.mods.iter().all(|profile_mod| !profile_mod.enabled));
    }

    #[test]
    fn auto_launch_quarantine_handles_each_failed_log_once() {
        let root = tempdir().unwrap();
        let mods = root.path().join("mods");
        let disabled = root.path().join("mods_disabled");
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(mods.join("Miyu_character")).unwrap();
        fs::create_dir_all(&disabled).unwrap();
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(mods.join("Miyu_character/Miyu_character.dll"), b"dll").unwrap();
        fs::write(
            mods.join("Miyu_character/mod_manifest.json"),
            br#"{"id":"Miyu_character","name":"Miyu","version":"1.0.0"}"#,
        )
        .unwrap();

        let profile = Profile {
            id: "active".into(),
            name: "Active".into(),
            game_version: None,
            created_by: None,
            mods: vec![ProfileMod {
                mod_version_id: None,
                name: "Miyu".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec![],
                folder_name: Some("Miyu_character".into()),
                mod_id: Some("Miyu_character".into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: Vec::new(),
                bundle_member_ids: Vec::new(),
            }],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: None,
            mod_extras: Default::default(),
        };
        crate::profiles::save_profile(&profile, &profiles).unwrap();

        let log_path = root.path().join("godot.log");
        let log = "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod Miyu_character! See logs for more info.";
        fs::write(&log_path, log).unwrap();

        let result = auto_quarantine_launch_failures_from_paths(
            log,
            Some(&log_path),
            &mods,
            &disabled,
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
        )
        .unwrap();

        assert_eq!(result.moved.len(), 1);
        assert!(!mods.join("Miyu_character").exists());
        assert!(disabled.join("Miyu_character").exists());
        assert!(config.join(AUTO_RECOVERY_STATE_FILE).exists());
        let updated = crate::profiles::load_profile("active", &profiles).unwrap();
        assert!(!updated.mods[0].enabled);

        fs::rename(disabled.join("Miyu_character"), mods.join("Miyu_character")).unwrap();
        let mut restored_profile = updated;
        restored_profile.mods[0].enabled = true;
        crate::profiles::save_profile(&restored_profile, &profiles).unwrap();

        let skipped = auto_quarantine_launch_failures_from_paths(
            log,
            Some(&log_path),
            &mods,
            &disabled,
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
        )
        .unwrap();

        assert!(skipped.moved.is_empty());
        assert!(skipped.disabled_profile_entries.is_empty());
        assert!(mods.join("Miyu_character").exists());
        let still_restored = crate::profiles::load_profile("active", &profiles).unwrap();
        assert!(still_restored.mods[0].enabled);
    }
}
