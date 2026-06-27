use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::mods::ModInfo;
use crate::state::AppState;

// Startup mod-load failures can appear near the top of godot.log while later
// runtime exceptions push the file past 10k lines. The reader already loads the
// current log file into memory, so diagnostics scan the whole file.
const GAME_LOG_SCAN_LINES: usize = usize::MAX;
const AUTO_RECOVERY_STATE_FILE: &str = "launch_recovery_state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LaunchLogSignature {
    path: String,
    modified_ms: u64,
    len: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LaunchRecoveryState {
    #[serde(default)]
    last_auto_recovered_log: Option<LaunchLogSignature>,
    #[serde(default)]
    last_handled_failed_launch_log: Option<LaunchLogSignature>,
    #[serde(default)]
    last_modded_launch_game_versions: BTreeMap<String, String>,
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
pub struct LaunchIncompatibleMod {
    pub name: String,
    pub display_name: Option<String>,
    pub version: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub min_game_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchDependencyBlockedMod {
    pub name: String,
    pub display_name: Option<String>,
    pub version: String,
    pub folder_name: Option<String>,
    pub mod_id: Option<String>,
    pub missing_dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchHealthReport {
    pub active_profile_id: Option<String>,
    pub active_profile_name: Option<String>,
    pub current_game_version: Option<String>,
    pub last_launch_game_version: Option<String>,
    pub profile_game_version: Option<String>,
    pub game_version_changed_since_last_launch: bool,
    pub profile_game_version_changed: bool,
    pub known_incompatible_mods: Vec<LaunchIncompatibleMod>,
    pub dependency_blocked_mods: Vec<LaunchDependencyBlockedMod>,
    pub previous_failed_mods: Vec<LaunchFailureMod>,
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
pub fn get_launch_health(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<LaunchHealthReport, String> {
    let (mods_path, profiles_path, config_path, active_profile_id, game_version) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (
            s.mods_path.clone(),
            s.profiles_path.clone(),
            s.config_path.clone(),
            s.active_profile.clone(),
            s.game_version.clone(),
        )
    };

    let mut active_mods = mods_path
        .as_deref()
        .map(crate::mods::scan_mods)
        .unwrap_or_default();
    crate::mod_sources::enrich_mods_with_sources(&mut active_mods, &config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut active_mods, &config_path);

    let log_path = game_log_path();
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_SCAN_LINES)?;
    launch_health_from_parts(
        &active_mods,
        &profiles_path,
        &config_path,
        active_profile_id,
        game_version,
        &log_text,
        log_path.as_deref(),
    )
    .map_err(|e| e.to_string())
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
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_SCAN_LINES)?;
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
    let signature = launch_log_signature(log_path.as_deref()).map_err(|e| e.to_string())?;
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_SCAN_LINES)?;
    let result = quarantine_launch_failures_from_paths(
        &log_text,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        active_profile_id,
        game_version,
        log_path.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    if result.failed.is_empty() {
        mark_launch_log_handled(&config_path, signature.as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub fn resolve_launch_health_blockers(
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
    let signature = launch_log_signature(log_path.as_deref()).map_err(|e| e.to_string())?;
    let log_text = read_log_tail_from_path(log_path.as_deref(), GAME_LOG_SCAN_LINES)?;
    let result = resolve_launch_health_blockers_from_paths(
        &log_text,
        &mods_path,
        &disabled_path,
        &profiles_path,
        &config_path,
        active_profile_id,
        game_version,
        log_path.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    if result.failed.is_empty() {
        mark_launch_log_handled(&config_path, signature.as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

pub(crate) fn diagnose_launch_log(
    log_text: &str,
    active_mods: &[ModInfo],
    game_version: Option<String>,
    log_path: Option<&Path>,
) -> LaunchDiagnostics {
    let mut failures: BTreeMap<String, BTreeSet<LaunchFailureReason>> = BTreeMap::new();
    let mut finished_initialization: BTreeSet<String> = BTreeSet::new();
    let mut context: VecDeque<String> = VecDeque::new();
    let explicit_patterns = explicit_mod_patterns();
    let finished_initialization_pattern =
        Regex::new(r"(?i)finished mod initialization for '.*?'\s*\((?P<mod>[^)]+)\)")
            .expect("valid finished initialization regex");
    let mut pending_reason: Option<(LaunchFailureReason, usize)> = None;

    for line in log_text.lines() {
        if let Some(token) = finished_initialization_pattern
            .captures(line)
            .and_then(|captures| captures.name("mod").map(|m| m.as_str().trim()))
        {
            for installed in active_mods {
                if mod_matches_token(installed, token) {
                    finished_initialization.insert(mod_key(installed));
                }
            }
        }

        if let Some((reason, remaining)) = pending_reason.take() {
            let direct_matches: Vec<&ModInfo> = active_mods
                .iter()
                .filter(|installed| mod_mentions_text(installed, line))
                .collect();
            if direct_matches.is_empty() {
                if remaining > 1 {
                    pending_reason = Some((reason, remaining - 1));
                }
            } else {
                for installed in direct_matches {
                    failures
                        .entry(mod_key(installed))
                        .or_default()
                        .insert(reason);
                }
            }
        }

        let reason = hard_failure_reason(line);
        if let Some(reason) = reason {
            let mut matched = false;
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
                            matched = true;
                        }
                    }
                } else {
                    for installed in direct_matches {
                        failures
                            .entry(mod_key(installed))
                            .or_default()
                            .insert(reason);
                        matched = true;
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
                            matched = true;
                        }
                    }
                }
            }
            if !matched {
                pending_reason = Some((reason, 8));
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
            if should_ignore_finished_self_reported_patch_failure(
                &key,
                &reasons,
                &finished_initialization,
            ) {
                return None;
            }
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

fn should_ignore_finished_self_reported_patch_failure(
    key: &str,
    reasons: &BTreeSet<LaunchFailureReason>,
    finished_initialization: &BTreeSet<String>,
) -> bool {
    reasons.len() == 1
        && reasons.contains(&LaunchFailureReason::CriticalPatch)
        && finished_initialization.contains(key)
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
    let mut active_mods = crate::mods::scan_mods(mods_path);
    crate::mod_versions::enrich_mods_with_versions(&mut active_mods, config_path);
    let diagnostics = diagnose_launch_log(log_text, &active_mods, game_version, log_path);
    let failed_keys = quarantine_target_keys(&diagnostics.failed_mods, &active_mods);
    store_launch_blocker_mods_from_paths(
        failed_keys,
        active_mods,
        mods_path,
        disabled_path,
        profiles_path,
        active_profile_id,
    )
}

pub(crate) fn resolve_launch_health_blockers_from_paths(
    log_text: &str,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    active_profile_id: Option<String>,
    game_version: Option<String>,
    log_path: Option<&Path>,
) -> Result<LaunchQuarantineResult> {
    let mut active_mods = crate::mods::scan_mods(mods_path);
    crate::mod_versions::enrich_mods_with_versions(&mut active_mods, config_path);
    let diagnostics = diagnose_launch_log(log_text, &active_mods, game_version.clone(), log_path);

    let mut direct_keys: BTreeSet<String> =
        diagnostics.failed_mods.iter().map(failure_key).collect();
    let available_dependencies = active_dependency_tokens(&active_mods);
    for installed in &active_mods {
        if !missing_dependencies_for_mod(installed, &available_dependencies).is_empty() {
            direct_keys.insert(mod_key(installed));
        }
        if crate::updater::install_is_incompatible(installed, game_version.as_deref()) {
            direct_keys.insert(mod_key(installed));
        }
    }
    let target_keys = hard_blocker_target_keys(&active_mods, direct_keys);

    store_launch_blocker_mods_from_paths(
        target_keys,
        active_mods,
        mods_path,
        disabled_path,
        profiles_path,
        active_profile_id,
    )
}

fn store_launch_blocker_mods_from_paths(
    target_keys: BTreeSet<String>,
    active_mods: Vec<ModInfo>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    active_profile_id: Option<String>,
) -> Result<LaunchQuarantineResult> {
    validate_mod_root_pair(mods_path, disabled_path)?;
    fs::create_dir_all(disabled_path)?;

    let mut disabled_profile_entries = Vec::new();
    if let Some(profile_id) = active_profile_id.as_deref() {
        let mut profile = crate::profiles::load_profile(profile_id, profiles_path)?;
        let mut changed = false;
        for profile_mod in &mut profile.mods {
            if !profile_mod.enabled {
                continue;
            }
            if active_mods
                .iter()
                .filter(|installed| target_keys.contains(&mod_key(installed)))
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
        if !target_keys.contains(&mod_key(&installed)) {
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

pub(crate) fn record_successful_modded_launch(
    config_path: &Path,
    active_profile_id: Option<&str>,
    game_version: Option<&str>,
) -> Result<()> {
    let Some(game_version) = game_version
        .map(normalize_game_version)
        .filter(|version| !version.is_empty())
    else {
        return Ok(());
    };
    let mut state = launch_recovery_state(config_path);
    state
        .last_modded_launch_game_versions
        .insert(launch_profile_key(active_profile_id), game_version);
    save_launch_recovery_state(config_path, &state)
}

fn launch_health_from_parts(
    active_mods: &[ModInfo],
    profiles_path: &Path,
    config_path: &Path,
    active_profile_id: Option<String>,
    current_game_version: Option<String>,
    log_text: &str,
    log_path: Option<&Path>,
) -> Result<LaunchHealthReport> {
    let active_profile = active_profile_id
        .as_deref()
        .and_then(|id| crate::profiles::load_profile(id, profiles_path).ok());
    let active_profile_name = active_profile.as_ref().map(|profile| profile.name.clone());
    let profile_game_version = active_profile
        .as_ref()
        .and_then(|profile| profile.game_version.clone());

    let recovery_state = launch_recovery_state(config_path);
    let last_launch_game_version = recovery_state
        .last_modded_launch_game_versions
        .get(&launch_profile_key(active_profile_id.as_deref()))
        .cloned();

    let known_incompatible_mods = active_mods
        .iter()
        .filter(|info| {
            crate::updater::install_is_incompatible(info, current_game_version.as_deref())
        })
        .filter_map(|info| {
            Some(LaunchIncompatibleMod {
                name: info.name.clone(),
                display_name: info.display_name.clone(),
                version: info.version.clone(),
                folder_name: info.folder_name.clone(),
                mod_id: info.mod_id.clone(),
                min_game_version: info.min_game_version.clone()?,
            })
        })
        .collect();

    let dependency_blocked_mods = dependency_blocked_mods(active_mods);

    let signature = launch_log_signature(log_path)?;
    let previous_failed_mods = if launch_log_already_handled(&recovery_state, signature.as_ref()) {
        Vec::new()
    } else {
        diagnose_launch_log(
            log_text,
            active_mods,
            current_game_version.clone(),
            log_path,
        )
        .failed_mods
    };

    Ok(LaunchHealthReport {
        active_profile_id,
        active_profile_name,
        current_game_version: current_game_version.clone(),
        last_launch_game_version: last_launch_game_version.clone(),
        profile_game_version: profile_game_version.clone(),
        game_version_changed_since_last_launch: versions_differ_when_known(
            last_launch_game_version.as_deref(),
            current_game_version.as_deref(),
        ),
        profile_game_version_changed: versions_differ_when_known(
            profile_game_version.as_deref(),
            current_game_version.as_deref(),
        ),
        known_incompatible_mods,
        dependency_blocked_mods,
        previous_failed_mods,
    })
}

fn dependency_blocked_mods(active_mods: &[ModInfo]) -> Vec<LaunchDependencyBlockedMod> {
    let available_dependencies = active_dependency_tokens(active_mods);
    active_mods
        .iter()
        .filter_map(|info| {
            let missing_dependencies = missing_dependencies_for_mod(info, &available_dependencies);
            if missing_dependencies.is_empty() {
                return None;
            }
            Some(LaunchDependencyBlockedMod {
                name: info.name.clone(),
                display_name: info.display_name.clone(),
                version: info.version.clone(),
                folder_name: info.folder_name.clone(),
                mod_id: info.mod_id.clone(),
                missing_dependencies,
            })
        })
        .collect()
}

fn active_dependency_tokens(active_mods: &[ModInfo]) -> BTreeSet<String> {
    active_mods
        .iter()
        .flat_map(mod_identity_tokens)
        .map(|token| normalize_token(&token))
        .filter(|token| !token.is_empty())
        .collect()
}

fn missing_dependencies_for_mod(
    info: &ModInfo,
    available_dependencies: &BTreeSet<String>,
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut missing = Vec::new();
    for dependency in &info.dependencies {
        let normalized = normalize_token(dependency);
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        if !available_dependencies.contains(&normalized) {
            missing.push(dependency.trim().to_string());
        }
    }
    missing
}

fn game_log_path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("SlayTheSpire2").join("logs").join("godot.log"))
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

fn mark_launch_log_handled(
    config_path: &Path,
    signature: Option<&LaunchLogSignature>,
) -> Result<()> {
    let Some(signature) = signature else {
        return Ok(());
    };
    let mut state = launch_recovery_state(config_path);
    state.last_handled_failed_launch_log = Some(signature.clone());
    save_launch_recovery_state(config_path, &state)
}

fn launch_log_already_handled(
    state: &LaunchRecoveryState,
    signature: Option<&LaunchLogSignature>,
) -> bool {
    signature.is_some_and(|sig| state.last_handled_failed_launch_log.as_ref() == Some(sig))
}

fn launch_profile_key(active_profile_id: Option<&str>) -> String {
    active_profile_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("__no_active_profile__")
        .to_string()
}

fn versions_differ_when_known(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            let left = normalize_game_version(left);
            let right = normalize_game_version(right);
            !left.is_empty() && !right.is_empty() && left != right
        }
        _ => false,
    }
}

fn normalize_game_version(version: &str) -> String {
    version.trim().trim_start_matches(['v', 'V']).to_string()
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
        .saturating_sub(lines.clamp(1, GAME_LOG_SCAN_LINES));
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
    } else if lower.contains("mod loading blocked")
        || (lower.contains("critical patch")
            && !lower.contains("succeeded")
            && (lower.contains("failed")
                || lower.contains("rolling back")
                || lower.contains("blocked")))
    {
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
    let target_keys: BTreeSet<String> = failed_mods.iter().map(failure_key).collect();
    let mut broken_ids: BTreeSet<String> = BTreeSet::new();
    for failure in failed_mods {
        collect_failure_identity_tokens(failure, &mut broken_ids);
    }
    cascade_dependent_target_keys(active_mods, target_keys, broken_ids)
}

fn hard_blocker_target_keys(
    active_mods: &[ModInfo],
    direct_keys: BTreeSet<String>,
) -> BTreeSet<String> {
    let mut broken_ids: BTreeSet<String> = BTreeSet::new();
    for installed in active_mods {
        if direct_keys.contains(&mod_key(installed)) {
            for token in mod_identity_tokens(installed) {
                broken_ids.insert(normalize_token(&token));
            }
        }
    }
    cascade_dependent_target_keys(active_mods, direct_keys, broken_ids)
}

fn cascade_dependent_target_keys(
    active_mods: &[ModInfo],
    mut target_keys: BTreeSet<String>,
    mut broken_ids: BTreeSet<String>,
) -> BTreeSet<String> {
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

    fn mod_info_with_min_game_version(
        name: &str,
        folder_name: &str,
        mod_id: &str,
        min_game_version: &str,
    ) -> ModInfo {
        let mut info = mod_info(name, folder_name, mod_id);
        info.min_game_version = Some(min_game_version.into());
        info
    }

    fn profile(id: &str, name: &str, game_version: Option<&str>) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            game_version: game_version.map(String::from),
            created_by: None,
            mods: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn profile_mod(name: &str, folder_name: &str, mod_id: &str) -> ProfileMod {
        ProfileMod {
            mod_version_id: None,
            name: name.into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: Some(folder_name.into()),
            mod_id: Some(mod_id.into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: Vec::new(),
            bundle_member_ids: Vec::new(),
        }
    }

    fn write_mod_fixture(mods_path: &Path, folder_name: &str, manifest: &str) {
        fs::create_dir_all(mods_path.join(folder_name)).unwrap();
        fs::write(
            mods_path
                .join(folder_name)
                .join(format!("{folder_name}.dll")),
            b"dll",
        )
        .unwrap();
        fs::write(
            mods_path.join(folder_name).join("mod_manifest.json"),
            manifest,
        )
        .unwrap();
    }

    #[test]
    fn launch_health_detects_game_version_drift_per_active_profile() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        crate::profiles::save_profile(&profile("active", "TesterW", Some("0.105.0")), &profiles)
            .unwrap();
        record_successful_modded_launch(&config, Some("active"), Some("0.105.0")).unwrap();

        let report = launch_health_from_parts(
            &[],
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert_eq!(report.active_profile_name.as_deref(), Some("TesterW"));
        assert_eq!(report.last_launch_game_version.as_deref(), Some("0.105.0"));
        assert!(report.game_version_changed_since_last_launch);
        assert!(report.profile_game_version_changed);
    }

    #[test]
    fn launch_health_reports_failed_active_mods_without_moving_files() {
        let root = tempdir().unwrap();
        let mods = root.path().join("mods");
        let disabled = root.path().join("mods_disabled");
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(mods.join("Miyu_character")).unwrap();
        fs::create_dir_all(disabled.join("StoredOnly")).unwrap();
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(mods.join("Miyu_character/Miyu_character.dll"), b"dll").unwrap();
        fs::write(disabled.join("StoredOnly/StoredOnly.dll"), b"dll").unwrap();
        let active = vec![mod_info("Miyu", "Miyu_character", "Miyu_character")];
        let log = [
            "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod Miyu_character! See logs for more info.",
            "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod StoredOnly! See logs for more info.",
        ]
        .join("\n");

        let report = launch_health_from_parts(
            &active,
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            &log,
            None,
        )
        .unwrap();

        assert_eq!(report.previous_failed_mods.len(), 1);
        assert_eq!(
            report.previous_failed_mods[0].folder_name.as_deref(),
            Some("Miyu_character")
        );
        assert!(mods.join("Miyu_character/Miyu_character.dll").exists());
        assert!(disabled.join("StoredOnly/StoredOnly.dll").exists());
    }

    #[test]
    fn launch_health_scans_startup_failures_before_long_runtime_tail() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let log_path = root.path().join("godot.log");
        let log = std::iter::once(
            "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod card_editor! See logs for more info.".to_string(),
        )
        .chain((0..12_000).map(|idx| format!("runtime noise {idx}")))
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&log_path, &log).unwrap();
        let scanned = read_log_tail_from_path(Some(&log_path), GAME_LOG_SCAN_LINES).unwrap();

        let report = launch_health_from_parts(
            &[mod_info("Card Editor", "card_editor", "card_editor")],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            &scanned,
            Some(&log_path),
        )
        .unwrap();

        assert_eq!(report.previous_failed_mods.len(), 1);
        assert_eq!(
            report.previous_failed_mods[0].folder_name.as_deref(),
            Some("card_editor")
        );
    }

    #[test]
    fn launch_health_unknown_game_version_fails_open() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let active = vec![mod_info_with_min_game_version(
            "Future", "Future", "Future", "9.0.0",
        )];

        let report =
            launch_health_from_parts(&active, &profiles, &config, None, None, "", None).unwrap();

        assert!(report.known_incompatible_mods.is_empty());
        assert!(!report.game_version_changed_since_last_launch);
        assert!(!report.profile_game_version_changed);
    }

    #[test]
    fn launch_health_reports_known_manifest_incompatibility() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let active = vec![mod_info_with_min_game_version(
            "Future", "Future", "Future", "9.0.0",
        )];

        let report = launch_health_from_parts(
            &active,
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert_eq!(report.known_incompatible_mods.len(), 1);
        assert_eq!(report.known_incompatible_mods[0].min_game_version, "9.0.0");
    }

    #[test]
    fn launch_health_reports_missing_active_dependency() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let mut miyu = mod_info("Miyu", "Miyu_character", "Miyu_character");
        miyu.dependencies = vec!["STS2-RitsuLib".into()];

        let report = launch_health_from_parts(
            &[miyu],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert_eq!(report.dependency_blocked_mods.len(), 1);
        assert_eq!(
            report.dependency_blocked_mods[0].folder_name.as_deref(),
            Some("Miyu_character")
        );
        assert_eq!(
            report.dependency_blocked_mods[0].missing_dependencies,
            vec!["STS2-RitsuLib"]
        );
    }

    #[test]
    fn launch_health_does_not_report_when_dependency_is_active() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let mut miyu = mod_info("Miyu", "Miyu_character", "Miyu_character");
        miyu.dependencies = vec!["STS2-RitsuLib".into()];
        let ritsu = mod_info("RitsuLib", "STS2-RitsuLib", "STS2-RitsuLib");

        let report = launch_health_from_parts(
            &[miyu, ritsu],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert!(report.dependency_blocked_mods.is_empty());
    }

    #[test]
    fn launch_health_treats_stored_dependency_as_missing_for_launch() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        let disabled = root.path().join("mods_disabled");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(disabled.join("STS2-RitsuLib")).unwrap();
        let mut miyu = mod_info("Miyu", "Miyu_character", "Miyu_character");
        miyu.dependencies = vec!["STS2-RitsuLib".into()];

        let report = launch_health_from_parts(
            &[miyu],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert_eq!(report.dependency_blocked_mods.len(), 1);
        assert!(disabled.join("STS2-RitsuLib").exists());
    }

    #[test]
    fn launch_health_matches_dependencies_against_active_mod_identity_tokens() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let mut provider = mod_info("RitsuLib", "STS2-RitsuLib", "com.ritsukage.ritsulib");
        provider.display_name = Some("Ritsu Lib".into());
        provider.bundle_member_ids = vec!["RitsuBundleMember".into()];
        let mut by_mod_id = mod_info("ByModId", "ByModId", "ByModId");
        by_mod_id.dependencies = vec!["com.ritsukage.ritsulib".into()];
        let mut by_folder = mod_info("ByFolder", "ByFolder", "ByFolder");
        by_folder.dependencies = vec!["STS2-RitsuLib".into()];
        let mut by_name = mod_info("ByName", "ByName", "ByName");
        by_name.dependencies = vec!["RitsuLib".into()];
        let mut by_display = mod_info("ByDisplay", "ByDisplay", "ByDisplay");
        by_display.dependencies = vec!["Ritsu Lib".into()];
        let mut by_bundle_member = mod_info("ByBundleMember", "ByBundleMember", "ByBundleMember");
        by_bundle_member.dependencies = vec!["RitsuBundleMember".into()];

        let report = launch_health_from_parts(
            &[
                provider,
                by_mod_id,
                by_folder,
                by_name,
                by_display,
                by_bundle_member,
            ],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            "",
            None,
        )
        .unwrap();

        assert!(report.dependency_blocked_mods.is_empty());
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
    fn launch_log_diagnostics_matches_runtime_exception_stack_frames() {
        let active = vec![
            mod_info("RelicsReminder", "RelicsReminder_dll", "RelicsReminder"),
            mod_info("BaseLib", "BaseLib", "BaseLib"),
        ];
        let log = [
            "ERROR: System.MissingMethodException: Method not found: 'MegaCrit.Sts2.Core.Combat.CombatState MegaCrit.Sts2.Core.Entities.Creatures.Creature.get_CombatState()'.",
            "   at MonoMod.Core.Interop.CoreCLR.V60.InvokeCompileMethod(IntPtr functionPtr)",
            "   at RelicsReminder.ArtOfWarFootIcon._Process(Double delta)",
            "   at Godot.Node.InvokeGodotClassMethod(godot_string_name& method, NativeVariantPtrArgs args, godot_variant& ret)",
        ]
        .join("\n");

        let diagnostics = diagnose_launch_log(&log, &active, Some("0.107.1".into()), None);

        assert_eq!(diagnostics.failed_mods.len(), 1);
        assert_eq!(
            diagnostics.failed_mods[0].folder_name.as_deref(),
            Some("RelicsReminder_dll")
        );
        assert!(diagnostics.failed_mods[0]
            .reasons
            .contains(&LaunchFailureReason::MissingMethod));
    }

    #[test]
    fn launch_log_diagnostics_ignores_successful_critical_patch_warning() {
        let active = vec![mod_info("RitsuLib", "STS2-RitsuLib", "STS2-RitsuLib")];
        let log = "[WARN] [com.ritsukage.sts2-RitsuLib] [Patcher - framework core] Critical patches succeeded, but some optional patches failed";

        let diagnostics = diagnose_launch_log(log, &active, Some("0.107.1".into()), None);

        assert!(diagnostics.failed_mods.is_empty());
    }

    #[test]
    fn launch_log_diagnostics_ignores_finished_self_reported_patch_failure() {
        let active = vec![
            mod_info("RitsuLib", "STS2-RitsuLib", "STS2-RitsuLib"),
            mod_info("Miyu", "Miyu_character", "Miyu_character"),
        ];
        let log = [
            "[ERROR] [com.ritsukage.sts2-RitsuLib] [Patcher - framework core] 1 critical patch(es) failed, mod loading blocked",
            "[ERROR] [com.ritsukage.sts2-RitsuLib] Framework initialization failed: critical framework patches failed.",
            "[INFO] Finished mod initialization for 'RitsuLib (STS2 0.103.2 compat)' (STS2-RitsuLib).",
            "[ERROR] Exception thrown while loading mod Miyu_character: System.Reflection.ReflectionTypeLoadException: Unable to load one or more of the requested types.",
            "Method 'get_Index' in type 'Miyu.Scripts.Act4.SteelContinent' from assembly 'Miyu_character, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null' does not have an implementation.",
        ]
        .join("\n");

        let diagnostics = diagnose_launch_log(&log, &active, Some("0.107.1".into()), None);
        let names = diagnostics
            .failed_mods
            .iter()
            .map(|m| m.folder_name.as_deref().unwrap_or(m.name.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["Miyu_character"]);
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
    fn launch_resolver_stores_dependency_blocked_mods_and_disables_profile_entries() {
        let root = tempdir().unwrap();
        let mods = root.path().join("mods");
        let disabled = root.path().join("mods_disabled");
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        write_mod_fixture(
            &mods,
            "EndRunGraph",
            r#"{"id":"EndRunGraph","name":"EndRunGraph","version":"0.1.0","dependencies":["STS2-RitsuLib"]}"#,
        );
        let mut active_profile = profile("active", "Active", None);
        active_profile.mods = vec![profile_mod("EndRunGraph", "EndRunGraph", "EndRunGraph")];
        crate::profiles::save_profile(&active_profile, &profiles).unwrap();

        let result = resolve_launch_health_blockers_from_paths(
            "",
            &mods,
            &disabled,
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
            None,
        )
        .unwrap();

        assert_eq!(result.moved.len(), 1);
        assert_eq!(result.moved[0].folder_name.as_deref(), Some("EndRunGraph"));
        assert!(result.failed.is_empty());
        assert!(!mods.join("EndRunGraph").exists());
        assert!(disabled.join("EndRunGraph").exists());
        assert!(!disabled.join("STS2-RitsuLib").exists());
        let updated = crate::profiles::load_profile("active", &profiles).unwrap();
        assert!(updated.mods.iter().all(|profile_mod| !profile_mod.enabled));
        assert_eq!(result.disabled_profile_entries.len(), 1);
    }

    #[test]
    fn launch_resolver_cascades_dependents_of_stored_hard_blockers() {
        let root = tempdir().unwrap();
        let mods = root.path().join("mods");
        let disabled = root.path().join("mods_disabled");
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&mods).unwrap();
        fs::create_dir_all(&disabled).unwrap();
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        write_mod_fixture(
            &mods,
            "FutureBase",
            r#"{"id":"FutureBase","name":"FutureBase","version":"1.0.0","min_game_version":"9.0.0"}"#,
        );
        write_mod_fixture(
            &mods,
            "DependsOnFutureBase",
            r#"{"id":"DependsOnFutureBase","name":"DependsOnFutureBase","version":"1.0.0","dependencies":["FutureBase"]}"#,
        );
        let mut active_profile = profile("active", "Active", None);
        active_profile.mods = vec![
            profile_mod("FutureBase", "FutureBase", "FutureBase"),
            profile_mod(
                "DependsOnFutureBase",
                "DependsOnFutureBase",
                "DependsOnFutureBase",
            ),
        ];
        crate::profiles::save_profile(&active_profile, &profiles).unwrap();

        let result = resolve_launch_health_blockers_from_paths(
            "",
            &mods,
            &disabled,
            &profiles,
            &config,
            Some("active".into()),
            Some("0.107.1".into()),
            None,
        )
        .unwrap();

        let moved = result
            .moved
            .iter()
            .map(|item| item.folder_name.as_deref().unwrap_or(item.name.as_str()))
            .collect::<BTreeSet<_>>();
        assert_eq!(moved, BTreeSet::from(["DependsOnFutureBase", "FutureBase"]));
        assert!(!mods.join("FutureBase").exists());
        assert!(!mods.join("DependsOnFutureBase").exists());
        let updated = crate::profiles::load_profile("active", &profiles).unwrap();
        assert!(updated.mods.iter().all(|profile_mod| !profile_mod.enabled));
    }

    #[test]
    fn launch_health_ignores_handled_failed_log_signature() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let log_path = root.path().join("godot.log");
        let log = "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod Miyu_character! See logs for more info.";
        fs::write(&log_path, log).unwrap();
        let active = vec![mod_info("Miyu", "Miyu_character", "Miyu_character")];

        let before = launch_health_from_parts(
            &active,
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            log,
            Some(&log_path),
        )
        .unwrap();
        assert_eq!(before.previous_failed_mods.len(), 1);

        let signature = launch_log_signature(Some(&log_path)).unwrap();
        mark_launch_log_handled(&config, signature.as_ref()).unwrap();

        let after = launch_health_from_parts(
            &active,
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            log,
            Some(&log_path),
        )
        .unwrap();

        assert!(after.previous_failed_mods.is_empty());
    }

    #[test]
    fn launch_health_does_not_trust_legacy_auto_recovered_log_signature() {
        let root = tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let config = root.path().join("config");
        fs::create_dir_all(&profiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        let log_path = root.path().join("godot.log");
        let log = "An exception of type System.Reflection.ReflectionTypeLoadException was thrown while loading mod CardsAndRelicsChooser! See logs for more info.";
        fs::write(&log_path, log).unwrap();
        let signature = launch_log_signature(Some(&log_path)).unwrap();
        save_launch_recovery_state(
            &config,
            &LaunchRecoveryState {
                last_auto_recovered_log: signature,
                last_handled_failed_launch_log: None,
                last_modded_launch_game_versions: BTreeMap::new(),
            },
        )
        .unwrap();

        let report = launch_health_from_parts(
            &[mod_info(
                "CardsAndRelicsChooser",
                "CardsAndRelicsChooser",
                "CardsAndRelicsChooser",
            )],
            &profiles,
            &config,
            None,
            Some("0.107.1".into()),
            log,
            Some(&log_path),
        )
        .unwrap();

        assert_eq!(report.previous_failed_mods.len(), 1);
    }
}
