//! Profile membership grid + load-order persistence helpers.
//!
//! The Tauri commands themselves (`get_profile_memberships`,
//! `set_profile_mod_membership`, `set_profile_load_order`) stay in
//! `mod.rs` so the `#[tauri::command]` proc-macro emits its companion
//! `__cmd__*` items at the `crate::profiles::*` path that `lib.rs`
//! invokes against. This module holds the pure-function compute layer
//! they call into:
//!
//! - `profile_membership_matrix` walks all profiles + installed mods
//!   and returns the grid the UI's per-modpack table consumes.
//! - `set_profile_mod_membership_from_paths` adds/removes a mod from
//!   one profile's manifest, refusing to edit subscribed profiles.
//! - `set_profile_load_order_from_paths` rewrites the in-pack ordering
//!   for a profile (called from the drag-reorder UI).
//! - `write_profile_load_order_to_settings_file` +
//!   `sync_profile_load_order_to_settings` mirror the chosen order
//!   into the game's `settings.save` so the engine respects it on
//!   next launch.
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, Result};
use crate::mods::{
    merge_active_disabled_mods, move_mod_by_info, scan_disabled_mods,
    scan_installed_mods_with_workshop, scan_mods, ModInfo, ModInstallSource,
    SETTINGS_SOURCE_MODS_DIRECTORY, SETTINGS_SOURCE_STEAM_WORKSHOP,
};

use super::apply::disk_mod_matches_pin;
use super::crud::{
    hide_app_created_by, installed_mod_matches_target, list_profiles, load_profile, mod_key,
    profile_has_json, profile_is_edit_locked, profile_mod_from_installed,
    profile_mod_matches_installed_with_registry, profile_mod_matches_installed_with_version_db,
    profile_mod_matches_target, save_profile,
};
use super::{
    LoadOrderSettingsStatus, Profile, ProfileMembershipGrid, ProfileMembershipMod,
    ProfileMembershipProfile, ProfileMembershipState, ProfileMod, ProfileModOrderKey,
};

pub(crate) fn profile_membership_matrix(
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<ProfileMembershipGrid> {
    let profiles = list_profiles(profiles_path);

    let profile_rows: Vec<ProfileMembershipProfile> = profiles
        .iter()
        .map(|profile| {
            // Editable when it has a local manifest and isn't a *followed*
            // (subscribed-but-not-owned) pack. A pack you published is owned —
            // editable even though installing your own code auto-subscribed you.
            let locked = profile_is_edit_locked(&profile.id, profiles_path, config_path);
            ProfileMembershipProfile {
                id: profile.id.clone(),
                name: profile.name.clone(),
                editable: !locked && profile_has_json(&profile.id, profiles_path),
            }
        })
        .collect();

    let mut installed_mods = scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, config_path);
    let version_db = crate::mod_versions::load(config_path);
    let version_options_by_id = crate::mod_versions::local_version_options_by_mod_version_id_in_db(
        &installed_mods,
        &profiles,
        &version_db,
        cache_path,
    );
    let mut mods: Vec<ProfileMembershipMod> = installed_mods
        .iter()
        .map(|installed| {
            let states = profiles
                .iter()
                .zip(profile_rows.iter())
                .map(|(profile, profile_row)| {
                    let matched = profile.mods.iter().enumerate().find(|(_, pm)| {
                        profile_mod_matches_installed_with_version_db(pm, &installed, &version_db)
                    });
                    ProfileMembershipState {
                        profile_id: profile.id.clone(),
                        profile_name: profile.name.clone(),
                        included: matched.is_some(),
                        enabled: matched.is_some(),
                        editable: profile_row.editable,
                        order_index: matched.map(|(index, _)| index),
                    }
                })
                .collect();

            ProfileMembershipMod {
                mod_version_id: installed.mod_version_id.clone(),
                name: installed.name.clone(),
                version: installed.version.clone(),
                folder_name: installed.folder_name.clone(),
                mod_id: installed.mod_id.clone(),
                display_name: installed.display_name.clone(),
                install_source: installed.install_source,
                source: installed.source.clone(),
                workshop_item_id: installed.workshop_item_id.clone(),
                workshop_url: installed.workshop_url.clone(),
                workshop_time_updated: installed.workshop_time_updated,
                workshop_update_pending: installed.workshop_update_pending,
                bundle_members: installed.bundle_members.clone(),
                bundle_member_ids: installed.bundle_member_ids.clone(),
                installed: true,
                cached: installed
                    .mod_version_id
                    .as_deref()
                    .and_then(|id| {
                        version_db
                            .records
                            .get(crate::mod_versions::resolve_alias(&version_db, id))
                    })
                    .and_then(|record| crate::mod_versions::cached_record_path(cache_path, record))
                    .is_some(),
                installed_enabled: installed.enabled,
                version_options: installed
                    .mod_version_id
                    .as_deref()
                    .and_then(|id| version_options_by_id.get(id).cloned())
                    .unwrap_or_default(),
                profiles: states,
            }
        })
        .collect();

    let mut installed_match_ids = HashSet::new();
    for profile in &profiles {
        for pm in &profile.mods {
            if installed_mods.iter().any(|installed| {
                profile_mod_matches_installed_with_version_db(pm, installed, &version_db)
            }) {
                continue;
            }
            let Some(record) = crate::mod_versions::record_for_profile_mod_in_db(pm, &version_db)
            else {
                continue;
            };
            if crate::mod_versions::cached_record_path(cache_path, &record).is_some() {
                installed_match_ids.insert(record.id);
            }
        }
    }

    for record_id in installed_match_ids {
        let Some(record) = version_db.records.get(&record_id) else {
            continue;
        };
        let states = profiles
            .iter()
            .zip(profile_rows.iter())
            .map(|(profile, profile_row)| {
                let matched = profile.mods.iter().enumerate().find(|(_, pm)| {
                    crate::mod_versions::record_for_profile_mod_in_db(pm, &version_db)
                        .is_some_and(|profile_record| profile_record.id == record_id)
                });
                ProfileMembershipState {
                    profile_id: profile.id.clone(),
                    profile_name: profile.name.clone(),
                    included: matched.is_some(),
                    enabled: matched.map(|(_, pm)| pm.enabled).unwrap_or(false),
                    editable: profile_row.editable,
                    order_index: matched.map(|(index, _)| index),
                }
            })
            .collect();

        mods.push(ProfileMembershipMod {
            mod_version_id: Some(record.id.clone()),
            name: record.name.clone(),
            version: record
                .source_version
                .clone()
                .unwrap_or_else(|| record.version.clone()),
            folder_name: record.folder_name.clone(),
            mod_id: record.mod_id.clone(),
            display_name: None,
            install_source: record.install_source,
            source: record.source.clone(),
            workshop_item_id: record.workshop_item_id.clone(),
            workshop_url: record.workshop_url.clone(),
            workshop_time_updated: record.workshop_time_updated,
            workshop_update_pending: false,
            bundle_members: Vec::new(),
            bundle_member_ids: record.bundle_member_ids.clone(),
            installed: false,
            cached: true,
            installed_enabled: false,
            version_options: version_options_by_id
                .get(&record.id)
                .cloned()
                .unwrap_or_default(),
            profiles: states,
        });
    }

    Ok(ProfileMembershipGrid {
        profiles: profile_rows,
        mods,
    })
}

pub(crate) fn set_profile_mod_membership_from_paths(
    profile_name: &str,
    mod_name: &str,
    mod_version_id: Option<&str>,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
    included: bool,
    source_hint: Option<&str>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    if profile_is_edit_locked(profile_name, profiles_path, config_path) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            profile_name
        )));
    }

    let mut profile = load_profile(profile_name, profiles_path)?;
    let version_db = crate::mod_versions::load(config_path);

    if included {
        let source_hint = source_hint.and_then(crate::mod_sources::parse_source_url);
        let mut installed_mods = scan_installed_mods_with_workshop(mods_path, disabled_path);
        crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
        crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, config_path);
        let source_match_count = source_hint.as_ref().map_or(0, |hint| {
            installed_mods
                .iter()
                .filter(|m| crate::mod_sources::mod_info_source_matches_entry(m, hint))
                .count()
        });
        let installed = installed_mods
            .iter()
            .find(|m| {
                installed_mod_matches_target_with_version_db(
                    m,
                    mod_name,
                    mod_version_id,
                    folder_name,
                    mod_id,
                    &version_db,
                )
            })
            .or_else(|| {
                if source_match_count != 1 {
                    return None;
                }
                source_hint.as_ref().and_then(|hint| {
                    installed_mods
                        .iter()
                        .find(|m| crate::mod_sources::mod_info_source_matches_entry(m, hint))
                })
            })
            .ok_or_else(|| {
                AppError::ModNotFound(format!(
                    "Installed mod '{}' was not found; refresh the mod list and try again.",
                    mod_name
                ))
            })?;
        let next_entry = profile_mod_from_installed(installed);
        let existing_index =
            profile_mod_target_indexes(&profile, mod_name, mod_version_id, folder_name, mod_id)
                .into_iter()
                .next()
                .or_else(|| {
                    profile.mods.iter().enumerate().find_map(|(index, pm)| {
                        if profile_mod_matches_installed_with_version_db(pm, installed, &version_db)
                        {
                            Some(index)
                        } else {
                            None
                        }
                    })
                })
                .or_else(|| {
                    if source_match_count != 1 {
                        return None;
                    }
                    source_hint.as_ref().and_then(|hint| {
                        let matches = profile
                            .mods
                            .iter()
                            .enumerate()
                            .filter(|(_, pm)| {
                                crate::mod_sources::profile_source_matches_entry(
                                    pm.source.as_deref(),
                                    hint,
                                )
                            })
                            .map(|(index, _)| index)
                            .collect::<Vec<_>>();
                        if matches.len() == 1 {
                            Some(matches[0])
                        } else {
                            None
                        }
                    })
                });
        if let Some(index) = existing_index {
            let existing = &mut profile.mods[index];
            *existing = next_entry;
        } else {
            profile.mods.push(next_entry);
        }
    } else {
        let remove_indexes =
            profile_mod_target_indexes(&profile, mod_name, mod_version_id, folder_name, mod_id);
        let mut index = 0usize;
        profile.mods.retain(|_| {
            let keep = !remove_indexes.contains(&index);
            index += 1;
            keep
        });
    }

    crate::profiles::collapse_equivalent_profile_mods(&mut profile, &version_db);
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    Ok(hide_app_created_by(profile))
}

fn installed_mod_matches_target_with_version_db(
    installed: &ModInfo,
    name: &str,
    mod_version_id: Option<&str>,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
    version_db: &crate::mod_versions::ModVersionsDb,
) -> bool {
    if installed_mod_matches_target(installed, name, mod_version_id, folder_name, mod_id) {
        return true;
    }
    let Some(target_id) = mod_version_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return false;
    };
    installed
        .mod_version_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .is_some_and(|installed_id| {
            crate::mod_versions::ids_equivalent_in_db(version_db, target_id, installed_id)
        })
}

fn profile_mod_target_indexes(
    profile: &Profile,
    mod_name: &str,
    mod_version_id: Option<&str>,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> Vec<usize> {
    let exact = profile
        .mods
        .iter()
        .enumerate()
        .filter_map(|(index, pm)| {
            if profile_mod_matches_target(pm, mod_name, mod_version_id, folder_name, mod_id) {
                Some(index)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if !exact.is_empty() {
        return exact;
    }

    unique_profile_mod_index(profile.mods.iter().enumerate().filter_map(|(index, pm)| {
        if profile_mod_matches_stable_target(pm, mod_name, folder_name, mod_id) {
            Some(index)
        } else {
            None
        }
    }))
    .map(|index| vec![index])
    .unwrap_or_default()
}

pub(crate) fn select_profile_mod_version_from_paths(
    profile_name: &str,
    current_name: &str,
    current_mod_version_id: Option<&str>,
    current_folder_name: Option<&str>,
    current_mod_id: Option<&str>,
    current_install_source: Option<ModInstallSource>,
    current_workshop_item_id: Option<&str>,
    current_workshop_url: Option<&str>,
    selected_name: &str,
    selected_mod_version_id: Option<&str>,
    selected_folder_name: Option<&str>,
    selected_mod_id: Option<&str>,
    selected_install_source: Option<ModInstallSource>,
    selected_workshop_item_id: Option<&str>,
    selected_workshop_url: Option<&str>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
    apply_to_disk: bool,
) -> Result<super::Profile> {
    if profile_is_edit_locked(profile_name, profiles_path, config_path) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            profile_name
        )));
    }

    let mut profile = load_profile(profile_name, profiles_path)?;
    let mut installed_mods = scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, config_path);
    let version_db = crate::mod_versions::load(config_path);
    let current_target = VersionSelectionTarget {
        name: current_name,
        mod_version_id: current_mod_version_id,
        folder_name: current_folder_name,
        mod_id: current_mod_id,
        install_source: current_install_source,
        workshop_item_id: current_workshop_item_id,
        workshop_url: current_workshop_url,
    };
    let selected_target = VersionSelectionTarget {
        name: selected_name,
        mod_version_id: selected_mod_version_id,
        folder_name: selected_folder_name,
        mod_id: selected_mod_id,
        install_source: selected_install_source,
        workshop_item_id: selected_workshop_item_id,
        workshop_url: selected_workshop_url,
    };

    let index =
        find_profile_mod_for_version_switch(&profile, &installed_mods, &version_db, current_target)
            .ok_or_else(|| {
                AppError::ModNotFound(format!(
                    "Profile '{}' does not contain '{}'. Refresh the modpack and try again.",
                    profile_name, current_name
                ))
            })?;

    let enabled = profile.mods[index].enabled;
    let selected_installed = installed_mods.iter().find(|m| {
        installed_mod_matches_version_target_with_version_db(m, selected_target, &version_db)
    });
    let selected_for_profile = if apply_to_disk {
        select_local_mod_version_on_disk(
            &installed_mods,
            current_name,
            current_mod_id.or(selected_mod_id),
            selected_installed,
            selected_mod_version_id,
            selected_install_source,
            enabled,
            mods_path,
            disabled_path,
            config_path,
            cache_path,
        )?
    } else if let Some(installed) = selected_installed {
        installed.clone()
    } else if let Some(id) = selected_mod_version_id {
        let mut entry = crate::mod_versions::profile_mod_from_record(id, cache_path, config_path)?;
        entry.enabled = enabled;
        profile.mods[index] = entry;
        crate::profiles::collapse_equivalent_profile_mods(&mut profile, &version_db);
        profile.updated_at = chrono::Utc::now();
        save_profile(&profile, profiles_path)?;
        prune_after_version_selection(
            mods_path,
            disabled_path,
            profiles_path,
            config_path,
            cache_path,
            &[
                current_mod_version_id.map(str::to_string),
                Some(id.to_string()),
            ],
            &[id.to_string()],
        );
        return Ok(hide_app_created_by(profile));
    } else {
        return Err(AppError::ModNotFound(format!(
            "Installed mod '{}' was not found; refresh the mod list and try again.",
            selected_name
        )));
    };

    let mut next_entry = profile_mod_from_installed(&selected_for_profile);
    next_entry.enabled = enabled;
    profile.mods[index] = next_entry;
    crate::profiles::collapse_equivalent_profile_mods(&mut profile, &version_db);
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    prune_after_version_selection(
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        cache_path,
        &[
            current_mod_version_id.map(str::to_string),
            selected_for_profile.mod_version_id.clone(),
        ],
        &selected_for_profile
            .mod_version_id
            .clone()
            .into_iter()
            .collect::<Vec<_>>(),
    );
    Ok(hide_app_created_by(profile))
}

fn find_profile_mod_for_version_switch(
    profile: &Profile,
    installed_mods: &[ModInfo],
    version_db: &crate::mod_versions::ModVersionsDb,
    current_target: VersionSelectionTarget<'_>,
) -> Option<usize> {
    if let Some(index) = profile
        .mods
        .iter()
        .position(|pm| profile_mod_matches_version_target(pm, current_target))
    {
        return Some(index);
    }

    unique_profile_mod_index(profile.mods.iter().enumerate().filter_map(|(index, pm)| {
        if profile_mod_matches_target_source(pm, current_target)
            && profile_mod_matches_stable_target(
                pm,
                current_target.name,
                current_target.folder_name,
                current_target.mod_id,
            )
        {
            Some(index)
        } else {
            None
        }
    }))
    .or_else(|| {
        let current_installed = installed_mods
            .iter()
            .find(|m| installed_mod_matches_version_target(m, current_target))
            .or_else(|| {
                installed_mods.iter().find(|m| {
                    installed_mod_matches_version_target_with_version_db(
                        m,
                        current_target,
                        version_db,
                    )
                })
            })
            .or_else(|| {
                installed_mods.iter().find(|m| {
                    mod_info_matches_target_source(m, current_target)
                        && installed_mod_matches_stable_target(
                            m,
                            current_target.name,
                            current_target.folder_name,
                            current_target.mod_id,
                        )
                })
            })?;

        unique_profile_mod_index(profile.mods.iter().enumerate().filter_map(|(index, pm)| {
            if profile_mod_matches_installed_with_version_db(pm, current_installed, version_db) {
                Some(index)
            } else {
                None
            }
        }))
    })
}

fn profile_mod_matches_stable_target(
    pm: &ProfileMod,
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> bool {
    let folder_matches = folder_name
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .is_some_and(|folder| {
            pm.folder_name
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(folder))
        });
    let id_matches = mod_id
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .is_some_and(|id| {
            pm.mod_id
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(id))
        });
    if folder_name.is_some() || mod_id.is_some() {
        folder_matches || id_matches
    } else {
        pm.name.eq_ignore_ascii_case(name)
    }
}

fn installed_mod_matches_stable_target(
    installed: &ModInfo,
    name: &str,
    folder_name: Option<&str>,
    mod_id: Option<&str>,
) -> bool {
    let folder_matches = folder_name
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .is_some_and(|folder| {
            installed
                .folder_name
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(folder))
        });
    let id_matches = mod_id
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .is_some_and(|id| {
            installed
                .mod_id
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(id))
        });
    if folder_name.is_some() || mod_id.is_some() {
        folder_matches || id_matches
    } else {
        installed.name.eq_ignore_ascii_case(name)
    }
}

fn unique_profile_mod_index<I>(indexes: I) -> Option<usize>
where
    I: IntoIterator<Item = usize>,
{
    let mut indexes = indexes.into_iter();
    let first = indexes.next()?;
    if indexes.next().is_some() {
        None
    } else {
        Some(first)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct VersionSelectionTarget<'a> {
    pub name: &'a str,
    pub mod_version_id: Option<&'a str>,
    pub folder_name: Option<&'a str>,
    pub mod_id: Option<&'a str>,
    pub install_source: Option<ModInstallSource>,
    pub workshop_item_id: Option<&'a str>,
    pub workshop_url: Option<&'a str>,
}

impl<'a> VersionSelectionTarget<'a> {
    fn workshop_item_id(self) -> Option<String> {
        self.workshop_item_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .or_else(|| {
                crate::mods::workshop_item_id_from_reference(self.workshop_url, self.folder_name)
            })
    }

    fn wants_local(self) -> bool {
        matches!(self.install_source, Some(ModInstallSource::Local))
    }

    fn wants_workshop(self) -> bool {
        matches!(self.install_source, Some(ModInstallSource::SteamWorkshop))
            || self.workshop_item_id().is_some()
    }
}

fn mod_info_workshop_item_id(info: &ModInfo) -> Option<String> {
    info.workshop_item_id
        .clone()
        .or_else(|| {
            crate::mods::workshop_item_id_from_reference(
                info.workshop_url.as_deref().or(info.source.as_deref()),
                None,
            )
        })
        .or_else(|| {
            if info.install_source.is_workshop() {
                crate::mods::workshop_item_id_from_reference(None, info.folder_name.as_deref())
            } else {
                None
            }
        })
}

fn profile_mod_workshop_item_id(pm: &ProfileMod) -> Option<String> {
    crate::mods::workshop_item_id_from_reference(pm.source.as_deref(), pm.folder_name.as_deref())
}

fn mod_info_matches_target_source(info: &ModInfo, target: VersionSelectionTarget<'_>) -> bool {
    if let Some(target_item_id) = target.workshop_item_id() {
        return info.install_source.is_workshop()
            && mod_info_workshop_item_id(info).as_deref() == Some(target_item_id.as_str());
    }
    if target.wants_workshop() {
        return info.install_source.is_workshop();
    }
    if target.wants_local() {
        return info.install_source.is_local();
    }
    true
}

fn profile_mod_matches_target_source(pm: &ProfileMod, target: VersionSelectionTarget<'_>) -> bool {
    if let Some(target_item_id) = target.workshop_item_id() {
        return profile_mod_workshop_item_id(pm).as_deref() == Some(target_item_id.as_str());
    }
    if target.wants_workshop() {
        return profile_mod_workshop_item_id(pm).is_some();
    }
    if target.wants_local() {
        return profile_mod_workshop_item_id(pm).is_none();
    }
    true
}

fn installed_mod_matches_version_target(
    installed: &ModInfo,
    target: VersionSelectionTarget<'_>,
) -> bool {
    mod_info_matches_target_source(installed, target)
        && installed_mod_matches_target(
            installed,
            target.name,
            target.mod_version_id,
            target.folder_name,
            target.mod_id,
        )
}

fn installed_mod_matches_version_target_with_version_db(
    installed: &ModInfo,
    target: VersionSelectionTarget<'_>,
    version_db: &crate::mod_versions::ModVersionsDb,
) -> bool {
    mod_info_matches_target_source(installed, target)
        && installed_mod_matches_target_with_version_db(
            installed,
            target.name,
            target.mod_version_id,
            target.folder_name,
            target.mod_id,
            version_db,
        )
}

fn profile_mod_matches_version_target(pm: &ProfileMod, target: VersionSelectionTarget<'_>) -> bool {
    profile_mod_matches_target_source(pm, target)
        && profile_mod_matches_target(
            pm,
            target.name,
            target.mod_version_id,
            target.folder_name,
            target.mod_id,
        )
}

pub(crate) fn select_library_mod_version_from_paths(
    current_name: &str,
    current_mod_version_id: Option<&str>,
    current_folder_name: Option<&str>,
    current_mod_id: Option<&str>,
    current_install_source: Option<ModInstallSource>,
    current_workshop_item_id: Option<&str>,
    current_workshop_url: Option<&str>,
    selected_name: &str,
    selected_mod_version_id: Option<&str>,
    selected_folder_name: Option<&str>,
    selected_mod_id: Option<&str>,
    selected_install_source: Option<ModInstallSource>,
    selected_workshop_item_id: Option<&str>,
    selected_workshop_url: Option<&str>,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<ModInfo> {
    let mut installed_mods = scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed_mods, config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed_mods, config_path);
    let current_target = VersionSelectionTarget {
        name: current_name,
        mod_version_id: current_mod_version_id,
        folder_name: current_folder_name,
        mod_id: current_mod_id,
        install_source: current_install_source,
        workshop_item_id: current_workshop_item_id,
        workshop_url: current_workshop_url,
    };
    let selected_target = VersionSelectionTarget {
        name: selected_name,
        mod_version_id: selected_mod_version_id,
        folder_name: selected_folder_name,
        mod_id: selected_mod_id,
        install_source: selected_install_source,
        workshop_item_id: selected_workshop_item_id,
        workshop_url: selected_workshop_url,
    };

    let current = installed_mods
        .iter()
        .find(|m| installed_mod_matches_version_target(m, current_target))
        .ok_or_else(|| {
            AppError::ModNotFound(format!(
                "Installed mod '{}' was not found; refresh the mod list and try again.",
                current_name
            ))
        })?;
    let target_enabled = current.enabled;
    let selected_installed = installed_mods
        .iter()
        .find(|m| installed_mod_matches_version_target(m, selected_target));

    let selected = select_local_mod_version_on_disk(
        &installed_mods,
        current_name,
        current_mod_id.or(selected_mod_id),
        selected_installed,
        selected_mod_version_id,
        selected_install_source,
        target_enabled,
        mods_path,
        disabled_path,
        config_path,
        cache_path,
    )?;
    prune_after_version_selection(
        mods_path,
        disabled_path,
        profiles_path,
        config_path,
        cache_path,
        &[
            current_mod_version_id.map(str::to_string),
            selected.mod_version_id.clone(),
        ],
        &selected
            .mod_version_id
            .clone()
            .into_iter()
            .collect::<Vec<_>>(),
    );
    Ok(selected)
}

fn prune_after_version_selection(
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
    cache_path: &Path,
    anchor_ids: &[Option<String>],
    keep_ids: &[String],
) {
    let anchor_ids: Vec<String> = anchor_ids.iter().flatten().cloned().collect();
    if anchor_ids.is_empty() {
        return;
    }
    let mut installed = scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_sources::enrich_mods_with_sources(&mut installed, config_path);
    crate::mod_versions::enrich_mods_with_versions(&mut installed, config_path);
    let profiles = if profiles_path.as_os_str().is_empty() {
        Vec::new()
    } else {
        list_profiles(profiles_path)
    };
    let _ = crate::mod_versions::prune_cached_versions_around(
        config_path,
        cache_path,
        &installed,
        &profiles,
        &anchor_ids,
        keep_ids,
    );
}

fn select_local_mod_version_on_disk(
    installed_mods: &[ModInfo],
    family_name: &str,
    family_mod_id: Option<&str>,
    selected_installed: Option<&ModInfo>,
    selected_mod_version_id: Option<&str>,
    selected_install_source: Option<ModInstallSource>,
    target_enabled: bool,
    mods_path: &Path,
    disabled_path: &Path,
    config_path: &Path,
    cache_path: &Path,
) -> Result<ModInfo> {
    let selected_id = selected_installed
        .and_then(|m| m.mod_version_id.as_deref())
        .or(selected_mod_version_id)
        .map(str::to_string);
    let selected_is_workshop = selected_installed.is_some_and(|m| m.install_source.is_workshop())
        || matches!(
            selected_install_source,
            Some(ModInstallSource::SteamWorkshop)
        )
        || selected_id
            .as_deref()
            .and_then(|id| crate::mod_versions::record_by_id(config_path, id))
            .is_some_and(|record| {
                record.install_source == ModInstallSource::SteamWorkshop
                    || record.workshop_item_id.is_some()
            });
    let same_family = |m: &ModInfo| {
        if let Some(id) = family_mod_id.map(str::trim).filter(|id| !id.is_empty()) {
            return m
                .mod_id
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(id));
        }
        m.name.eq_ignore_ascii_case(family_name)
    };

    for installed in installed_mods.iter().filter(|m| same_family(m)) {
        let is_selected = selected_id.as_deref().is_some_and(|id| {
            installed
                .mod_version_id
                .as_deref()
                .is_some_and(|candidate| candidate == id)
        });
        let base = if installed.enabled {
            mods_path
        } else {
            disabled_path
        };
        if installed.install_source.is_workshop() {
            continue;
        }
        if selected_is_workshop {
            if installed.enabled {
                move_mod_by_info(installed, mods_path, disabled_path)?;
            }
            continue;
        }
        let mut cache_candidate = installed.clone();
        crate::mod_versions::cache_mod_version_by_id(
            &mut cache_candidate,
            base,
            cache_path,
            config_path,
        );
        if !is_selected {
            crate::mods::delete_mod_files_by_info(installed, base);
        }
    }

    if let Some(selected) = selected_installed {
        let mut selected = selected.clone();
        if selected.install_source.is_workshop() {
            return Ok(selected);
        }
        if selected.enabled != target_enabled {
            let (src, dest) = if selected.enabled {
                (mods_path, disabled_path)
            } else {
                (disabled_path, mods_path)
            };
            move_mod_by_info(&selected, src, dest)?;
            selected.enabled = target_enabled;
        }
        apply_record_source_version(&selected, selected.mod_version_id.as_deref(), config_path);
        if target_enabled {
            let moved = crate::mods::move_runtime_id_conflicts_to_disabled(
                &selected,
                mods_path,
                disabled_path,
            )?;
            if !moved.is_empty() {
                log::warn!(
                    "Version selection moved {} active runtime-ID conflict(s) to disabled storage: {}",
                    moved.len(),
                    moved.join(", ")
                );
            }
        }
        return Ok(selected);
    }

    let selected_id = selected_mod_version_id.ok_or_else(|| {
        AppError::ModNotFound(format!(
            "No local version was selected for '{}'. Refresh the mod list and try again.",
            family_name
        ))
    })?;
    let dest = if target_enabled {
        mods_path
    } else {
        disabled_path
    };
    let mut restored = crate::mod_versions::install_cached_record_to_base(
        selected_id,
        cache_path,
        config_path,
        dest,
    )?;
    restored.enabled = target_enabled;
    apply_record_source_version(&restored, Some(selected_id), config_path);
    if target_enabled {
        let moved = crate::mods::move_runtime_id_conflicts_to_disabled(
            &restored,
            mods_path,
            disabled_path,
        )?;
        if !moved.is_empty() {
            log::warn!(
                "Version restore moved {} active runtime-ID conflict(s) to disabled storage: {}",
                moved.len(),
                moved.join(", ")
            );
        }
    }
    Ok(restored)
}

fn apply_record_source_version(info: &ModInfo, record_id: Option<&str>, config_path: &Path) {
    let Some(record_id) = record_id else { return };
    let Some(record) = crate::mod_versions::record_by_id(config_path, record_id) else {
        return;
    };
    if info.install_source.is_workshop() || record.install_source == ModInstallSource::SteamWorkshop
    {
        return;
    }
    let Some(version) = record
        .source_version
        .as_deref()
        .or(Some(record.version.as_str()))
    else {
        return;
    };
    let source_type = record
        .source
        .as_deref()
        .map(|source| {
            if source.starts_with("github:") || source.contains("github.com") {
                "github"
            } else if source.contains("nexusmods.com") {
                "nexus"
            } else {
                "unknown"
            }
        })
        .unwrap_or("unknown");
    let key = info.folder_name.as_deref().unwrap_or(info.name.as_str());
    crate::mod_sources::update_installed_version_from_source(
        key,
        version,
        source_type,
        config_path,
    );
    if source_type == "nexus" {
        let identity = crate::nexus::NexusFileIdentity {
            file_id: record.nexus_file_id,
            file_name: record.nexus_file_name.clone(),
            lane_key: record.nexus_file_lane_key.clone(),
        };
        crate::mod_sources::set_nexus_file_identity_for_key(key, &identity, config_path);
    }
}

/// Result of bulk enable/disable of a profile's mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetProfileModsEnabledResult {
    pub enabled: bool,
    /// Display names of mods actually moved into the requested state.
    pub toggled: Vec<String>,
    /// Profile mods with no matching installed mod (can't be toggled).
    pub missing: Vec<String>,
    /// Matched mods whose move failed.
    pub failed: Vec<String>,
}

/// Enable or disable EVERY mod in a profile, resolving each manifest entry to
/// its actual on-disk mod via the same matcher the membership grid uses.
///
/// The reported bug: the modpack view's "Enable all / Disable all" toggled by
/// the manifest's `folder_name`, which can drift from the installed folder
/// (e.g. Nexus version-stamped folders like `Foo-21-0-1-7-1778841224`), so
/// `toggle_mod` hard-errored "No mod with folder …". Matching to the installed
/// mod and moving its real folder fixes that. Idempotent (mods already in the
/// requested state are skipped) and best-effort (an unmatched or unmovable mod
/// is reported, not fatal) so one bad entry can't abort the whole operation.
pub(crate) fn set_profile_mods_enabled_from_paths(
    profile_name: &str,
    enabled: bool,
    mods_path: &Path,
    disabled_path: &Path,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<SetProfileModsEnabledResult> {
    let mut profile = load_profile(profile_name, profiles_path)?;
    let mut installed =
        merge_active_disabled_mods(scan_mods(mods_path), scan_disabled_mods(disabled_path));
    crate::mod_versions::enrich_mods_with_versions(&mut installed, config_path);

    let mut toggled = Vec::new();
    let mut missing = Vec::new();
    let mut failed = Vec::new();

    for index in 0..profile.mods.len() {
        let pm = profile.mods[index].clone();
        match installed
            .iter()
            .find(|m| profile_mod_matches_installed_with_registry(&pm, m, config_path))
        {
            None => missing.push(pm.name.clone()),
            Some(inst) => {
                if inst.enabled == enabled {
                    continue; // already in the requested state
                }
                // `inst.enabled` tells us where it currently lives; move it the
                // other way. We use the INSTALLED folder/files (not the
                // manifest's) so the move targets the real on-disk folder.
                let (src, dest) = if inst.enabled {
                    (mods_path, disabled_path)
                } else {
                    (disabled_path, mods_path)
                };
                let label = inst
                    .display_name
                    .clone()
                    .unwrap_or_else(|| inst.name.clone());
                match move_mod_by_info(inst, src, dest) {
                    Ok(()) => {
                        profile.mods[index].enabled = enabled;
                        toggled.push(label);
                    }
                    Err(e) => {
                        log::error!(
                            "set_profile_mods_enabled: failed to move '{}': {}",
                            inst.name,
                            e
                        );
                        failed.push(label);
                    }
                }
            }
        }
    }

    if !toggled.is_empty() {
        profile.updated_at = chrono::Utc::now();
        save_profile(&profile, profiles_path)?;
    }

    Ok(SetProfileModsEnabledResult {
        enabled,
        toggled,
        missing,
        failed,
    })
}

fn order_key_identity(key: &ProfileModOrderKey) -> String {
    if let Some(id) = key
        .mod_version_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return format!("version:{id}");
    }
    mod_key(&key.name, key.folder_name.as_deref(), key.mod_id.as_deref())
}

fn profile_mod_settings_id(pm: &ProfileMod) -> String {
    pm.mod_id
        .as_deref()
        .or(pm.folder_name.as_deref())
        .unwrap_or(&pm.name)
        .trim()
        .to_string()
}

fn disk_mod_settings_id(m: &ModInfo) -> String {
    m.mod_id
        .as_deref()
        .or(m.folder_name.as_deref())
        .unwrap_or(&m.name)
        .trim()
        .to_string()
}

fn normalize_settings_source(source: Option<&str>) -> String {
    match source.map(str::trim).filter(|value| !value.is_empty()) {
        Some(SETTINGS_SOURCE_STEAM_WORKSHOP) => SETTINGS_SOURCE_STEAM_WORKSHOP.to_string(),
        Some(SETTINGS_SOURCE_MODS_DIRECTORY) | None => SETTINGS_SOURCE_MODS_DIRECTORY.to_string(),
        Some(other) => other.to_string(),
    }
}

fn settings_entry_key(id: &str, source: &str) -> String {
    format!(
        "{}|{}",
        id.trim().to_lowercase(),
        source.trim().to_lowercase()
    )
}

fn profile_mod_settings_source(pm: &ProfileMod) -> String {
    if crate::mods::workshop_item_id_from_reference(pm.source.as_deref(), pm.folder_name.as_deref())
        .is_some()
    {
        SETTINGS_SOURCE_STEAM_WORKSHOP.to_string()
    } else {
        SETTINGS_SOURCE_MODS_DIRECTORY.to_string()
    }
}

fn disk_mod_settings_source(m: &ModInfo) -> String {
    if m.install_source == ModInstallSource::SteamWorkshop || m.workshop_item_id.is_some() {
        SETTINGS_SOURCE_STEAM_WORKSHOP.to_string()
    } else {
        m.install_source.settings_source().to_string()
    }
}

pub(crate) fn set_profile_load_order_from_paths(
    profile_name: &str,
    ordered_mods: Vec<ProfileModOrderKey>,
    profiles_path: &Path,
    config_path: &Path,
) -> Result<Profile> {
    if profile_is_edit_locked(profile_name, profiles_path, config_path) {
        return Err(AppError::Other(format!(
            "Cannot edit subscribed profile '{}'. Duplicate it first to make a local copy.",
            profile_name
        )));
    }

    let mut profile = load_profile(profile_name, profiles_path)?;
    if profile.mods.is_empty() && ordered_mods.is_empty() {
        return Ok(hide_app_created_by(profile));
    }
    if !profile.mods.is_empty() && ordered_mods.is_empty() {
        return Err(AppError::InvalidProfile(format!(
            "Load order for profile '{}' cannot be empty.",
            profile_name
        )));
    }

    let mut seen = std::collections::HashSet::new();
    for key in &ordered_mods {
        let identity = order_key_identity(key);
        if identity.trim().is_empty() || !seen.insert(identity.clone()) {
            return Err(AppError::InvalidProfile(format!(
                "Duplicate or blank mod in load order: {}",
                key.name
            )));
        }
    }

    let mut remaining = profile.mods.clone();
    let mut reordered = Vec::with_capacity(profile.mods.len());
    for key in ordered_mods {
        let Some(pos) = remaining.iter().position(|pm| {
            profile_mod_matches_target(
                pm,
                &key.name,
                key.mod_version_id.as_deref(),
                key.folder_name.as_deref(),
                key.mod_id.as_deref(),
            )
        }) else {
            return Err(AppError::ModNotFound(format!(
                "Profile '{}' does not contain '{}'. Refresh and try again.",
                profile_name, key.name
            )));
        };
        reordered.push(remaining.remove(pos));
    }
    reordered.extend(remaining);

    profile.mods = reordered;
    profile.updated_at = chrono::Utc::now();
    save_profile(&profile, profiles_path)?;
    Ok(hide_app_created_by(profile))
}

fn settings_entry_with_state(
    id: &str,
    source: &str,
    enabled: bool,
    existing: Option<&serde_json::Value>,
) -> serde_json::Value {
    let source = normalize_settings_source(Some(source));
    let mut entry = existing
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "id": id, "source": source }));

    if let Some(obj) = entry.as_object_mut() {
        obj.insert("id".into(), serde_json::Value::String(id.to_string()));
        obj.insert("is_enabled".into(), serde_json::Value::Bool(enabled));
        obj.insert("source".into(), serde_json::Value::String(source));
    }
    entry
}

fn backup_settings_save(settings_path: &Path) -> Result<PathBuf> {
    let parent = settings_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = settings_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.save");
    let backup_name = format!(
        "{}.sts2mm-bak-{}",
        file_name,
        chrono::Utc::now().timestamp_millis()
    );
    let mut backup_path = parent.join(&backup_name);
    // u32 (not u8): 256+ same-millisecond backups must not saturate the counter
    // and spin `backup_path` on a fixed name forever. (Audit L-5)
    let mut suffix = 1u32;
    while backup_path.exists() {
        backup_path = parent.join(format!("{}-{}", backup_name, suffix));
        suffix = suffix.saturating_add(1);
    }
    fs::copy(settings_path, &backup_path)?;
    Ok(backup_path)
}

pub(super) fn write_settings_save_with_backup_and_restore<F>(
    settings_path: &Path,
    contents: &str,
    mut write_fn: F,
) -> Result<PathBuf>
where
    F: FnMut(&Path, &str) -> std::io::Result<()>,
{
    let backup_path = backup_settings_save(settings_path)?;
    if let Err(write_err) = write_fn(settings_path, contents) {
        if let Err(restore_err) = fs::copy(&backup_path, settings_path) {
            return Err(AppError::Other(format!(
                "Failed to write settings.save: {}; failed to restore backup from {}: {}",
                write_err,
                backup_path.display(),
                restore_err
            )));
        }
        return Err(AppError::Other(format!(
            "Failed to write settings.save: {}; restored backup from {}",
            write_err,
            backup_path.display()
        )));
    }
    // Success: the rewrite landed cleanly, so the `.sts2mm-bak-<ts>` snapshot is
    // no longer needed. Remove it so repeated load-order edits don't accumulate
    // one stale backup of settings.save per save, forever. (Audit L-6) The
    // backup is only retained on the failure path above, for manual recovery.
    if let Err(e) = fs::remove_file(&backup_path) {
        log::warn!(
            "Failed to remove settings.save backup {} after a successful write: {}",
            backup_path.display(),
            e
        );
    }
    Ok(backup_path)
}

fn parse_settings_save(raw: &str, settings_path: &Path) -> Result<serde_json::Value> {
    let mut stream = serde_json::Deserializer::from_str(raw).into_iter::<serde_json::Value>();
    let settings = stream
        .next()
        .ok_or_else(|| AppError::InvalidProfile("Invalid settings.save JSON: EOF".into()))?
        .map_err(|e| AppError::InvalidProfile(format!("Invalid settings.save JSON: {}", e)))?;

    let trailing = &raw[stream.byte_offset()..];
    if !trailing.trim().is_empty() {
        log::warn!(
            "settings.save at {} contains trailing data after the first JSON object; rewriting will discard the trailing data",
            settings_path.display()
        );
    }

    Ok(settings)
}

pub(crate) fn write_profile_load_order_to_settings_file(
    profile: &Profile,
    settings_path: &Path,
    extra_mods: &[ModInfo],
) -> Result<()> {
    let raw = fs::read_to_string(settings_path)?;
    let mut settings = parse_settings_save(&raw, settings_path)?;

    if !settings.is_object() {
        return Err(AppError::InvalidProfile(
            "settings.save must contain a JSON object".into(),
        ));
    }

    let mut existing_by_id_and_source: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Some(existing) = settings
        .get("mod_settings")
        .and_then(|v| v.get("mod_list"))
        .and_then(|v| v.as_array())
    {
        for entry in existing {
            if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                let source =
                    normalize_settings_source(entry.get("source").and_then(|v| v.as_str()));
                existing_by_id_and_source.insert(settings_entry_key(id, &source), entry.clone());
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut mod_list = Vec::new();
    for pm in &profile.mods {
        let id = profile_mod_settings_id(pm);
        let source = profile_mod_settings_source(pm);
        let key = settings_entry_key(&id, &source);
        if id.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        mod_list.push(settings_entry_with_state(
            &id,
            &source,
            if source == SETTINGS_SOURCE_STEAM_WORKSHOP {
                pm.enabled
            } else {
                true
            },
            existing_by_id_and_source.get(&key),
        ));
    }
    for m in extra_mods {
        let id = disk_mod_settings_id(m);
        let source = disk_mod_settings_source(m);
        let key = settings_entry_key(&id, &source);
        if id.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        mod_list.push(settings_entry_with_state(
            &id,
            &source,
            m.enabled,
            existing_by_id_and_source.get(&key),
        ));
    }

    let mods_enabled =
        profile.mods.iter().any(|pm| pm.enabled) || extra_mods.iter().any(|m| m.enabled);

    let root = settings.as_object_mut().ok_or_else(|| {
        AppError::InvalidProfile("settings.save must contain a JSON object".into())
    })?;
    let mod_settings = root.entry("mod_settings").or_insert_with(|| json!({}));
    if !mod_settings.is_object() {
        *mod_settings = json!({});
    }
    let mod_settings_obj = mod_settings.as_object_mut().unwrap();
    mod_settings_obj.insert("mod_list".into(), serde_json::Value::Array(mod_list));
    mod_settings_obj.insert("mods_enabled".into(), serde_json::Value::Bool(mods_enabled));

    let serialized = serde_json::to_string_pretty(&settings)?;
    write_settings_save_with_backup_and_restore(settings_path, &serialized, |path, contents| {
        fs::write(path, contents)
    })?;
    Ok(())
}

#[derive(Debug)]
enum SettingsSaveResolution {
    Found(PathBuf),
    Missing,
    Multiple(Vec<PathBuf>),
}

fn resolve_settings_save_candidates(mut candidates: Vec<PathBuf>) -> SettingsSaveResolution {
    candidates.sort();
    candidates.dedup();

    let mut resolved = Vec::new();
    for candidate in candidates {
        // Multiple discovered paths are only safe to collapse when the OS can
        // prove they name the same settings.save file.
        let identity = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if resolved
            .iter()
            .any(|(_, existing_identity): &(PathBuf, PathBuf)| existing_identity == &identity)
        {
            continue;
        }
        resolved.push((candidate, identity));
    }

    match resolved.len() {
        0 => SettingsSaveResolution::Missing,
        1 => SettingsSaveResolution::Found(resolved.remove(0).0),
        _ => SettingsSaveResolution::Multiple(
            resolved
                .into_iter()
                .map(|(candidate, _identity)| candidate)
                .collect(),
        ),
    }
}

fn settings_save_candidates_under(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let direct = root.join("settings.save");
    if direct.is_file() {
        candidates.push(direct);
    }

    let steam_root = root.join("steam");
    if let Ok(entries) = fs::read_dir(&steam_root) {
        for entry in entries.flatten() {
            let settings = entry.path().join("settings.save");
            if settings.is_file() {
                candidates.push(settings);
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn find_settings_save_path() -> SettingsSaveResolution {
    if let Ok(path) = std::env::var("STS2_SETTINGS_SAVE") {
        let path = PathBuf::from(path);
        return if path.is_file() {
            SettingsSaveResolution::Found(path)
        } else {
            SettingsSaveResolution::Missing
        };
    }

    let mut candidates = Vec::new();
    if let Ok(root) = std::env::var("STS2_SAVE_DIR") {
        candidates.extend(settings_save_candidates_under(&PathBuf::from(root)));
    }
    if let Some(data_dir) = dirs::data_dir() {
        candidates.extend(settings_save_candidates_under(
            &data_dir.join("SlayTheSpire2"),
        ));
    }
    resolve_settings_save_candidates(candidates)
}

fn profile_contains_disk_mod(profile: &Profile, disk_mod: &ModInfo, config_path: &Path) -> bool {
    profile
        .mods
        .iter()
        .any(|pm| profile_mod_matches_installed_with_registry(pm, disk_mod, config_path))
}

pub(super) fn sync_profile_load_order_to_settings(
    profile: &Profile,
    mods_path: &Path,
    disabled_path: &Path,
    config_path: &Path,
) -> (LoadOrderSettingsStatus, Option<String>) {
    let settings_path = match find_settings_save_path() {
        SettingsSaveResolution::Found(path) => path,
        SettingsSaveResolution::Missing => return (LoadOrderSettingsStatus::SkippedMissing, None),
        SettingsSaveResolution::Multiple(paths) => {
            log::warn!(
                "Load order sync skipped: found multiple settings.save files: {:?}",
                paths
            );
            return (LoadOrderSettingsStatus::SkippedMultiple, None);
        }
    };

    let pinned_set = crate::mod_sources::load_pinned_set(config_path);
    let mut all_mods = scan_installed_mods_with_workshop(mods_path, disabled_path);
    crate::mod_versions::enrich_mods_with_versions(&mut all_mods, config_path);
    let pinned_mods = all_mods
        .into_iter()
        .filter(|m| {
            disk_mod_matches_pin(m, &pinned_set)
                && !profile_contains_disk_mod(profile, m, config_path)
        })
        .collect::<Vec<_>>();

    match write_profile_load_order_to_settings_file(profile, &settings_path, &pinned_mods) {
        Ok(()) => (
            LoadOrderSettingsStatus::Applied,
            Some(settings_path.to_string_lossy().to_string()),
        ),
        Err(e) => {
            log::warn!(
                "Load order sync failed for settings.save at {}: {}",
                settings_path.display(),
                e
            );
            (
                LoadOrderSettingsStatus::Failed,
                Some(settings_path.to_string_lossy().to_string()),
            )
        }
    }
}

#[cfg(test)]
mod profile_membership_tests {
    use super::*;

    static STEAM_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvOverride {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvOverride {
        fn set(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvOverride {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.as_ref() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn write_mod(root: &Path, folder: &str, display: &str, version: &str) {
        write_mod_with_id(root, folder, folder, display, version);
    }

    fn write_mod_with_id(root: &Path, folder: &str, id: &str, display: &str, version: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{folder}.json")),
            format!(r#"{{"id":"{id}","name":"{display}","version":"{version}","author":"QA"}}"#),
        )
        .unwrap();
        fs::write(dir.join(format!("{folder}.dll")), b"dll").unwrap();
    }

    fn write_workshop_mod(
        steam_root: &Path,
        item_id: &str,
        mod_id: &str,
        display: &str,
        version: &str,
    ) {
        let dir = steam_root
            .join("steamapps")
            .join("workshop")
            .join("content")
            .join(crate::game::STS2_STEAM_APPID)
            .join(item_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("mod_manifest.json"),
            format!(
                r#"{{"id":"{mod_id}","name":"{display}","version":"{version}","min_game_version":"0.107.1"}}"#
            ),
        )
        .unwrap();
        fs::write(dir.join(format!("{mod_id}.dll")), b"dll").unwrap();
    }

    fn steam_game_mod_paths(steam_root: &Path) -> (PathBuf, PathBuf) {
        let game_path = steam_root
            .join("steamapps")
            .join("common")
            .join("Slay the Spire 2");
        let mods_path = game_path.join("mods");
        let disabled_path = game_path.join("mods_disabled");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        (mods_path, disabled_path)
    }

    fn write_bundle(
        root: &Path,
        folder: &str,
        display: &str,
        version: &str,
        members: &[(&str, &str)],
    ) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        crate::mods::bundle::write_sidecar(
            &dir,
            &crate::mods::bundle::BundleSidecar {
                display_name: display.into(),
                installed_version: Some(version.into()),
                ..Default::default()
            },
        )
        .unwrap();
        for (member_id, member_name) in members {
            let member_dir = dir.join(member_id);
            fs::create_dir_all(&member_dir).unwrap();
            fs::write(
                member_dir.join(format!("{member_id}.json")),
                format!(r#"{{"id":"{member_id}","name":"{member_name}","version":"{version}"}}"#),
            )
            .unwrap();
            fs::write(member_dir.join(format!("{member_id}.dll")), b"dll").unwrap();
        }
    }

    fn empty_profile(name: &str) -> Profile {
        Profile {
            id: crate::profiles::new_profile_id(),
            name: name.into(),
            game_version: Some("0.105.0".into()),
            created_by: None,
            mods: Vec::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
            mod_extras: Default::default(),
        }
    }

    fn profile_mod_entry(name: &str, folder: &str, version: &str, enabled: bool) -> ProfileMod {
        ProfileMod {
            mod_version_id: None,
            name: name.into(),
            version: version.into(),
            source: Some(format!("github:example/{folder}")),
            hash: Some(format!("hash-{folder}")),
            files: vec![format!("{folder}/{folder}.dll")],
            folder_name: Some(folder.into()),
            mod_id: Some(folder.into()),
            enabled,
            bundle_url: Some(format!("https://example.test/{folder}.zip")),
            bundle_sha256: Some(format!("sha-{folder}")),
            bundle_members: vec![],
            bundle_member_ids: vec![],
        }
    }

    #[test]
    fn set_profile_mod_membership_replaces_alias_equivalent_profile_entry() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = game_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod_with_id(
            &mods_path,
            "RitsuLib",
            "STS2-RitsuLib",
            "RitsuLib (STS2 0.103.2 compat)",
            "0.4.24",
        );
        let mut installed = scan_mods(&mods_path).into_iter().next().unwrap();
        let canonical_id =
            crate::mod_versions::ensure_mod_info_id(&mut installed, config_tmp.path()).unwrap();
        crate::mod_versions::alias_shared_id("ritsu-alias", &mut installed, config_tmp.path())
            .unwrap();

        let mut profile = empty_profile("Pack");
        let mut stale_alias =
            profile_mod_entry("RitsuLib (STS2 0.103.2 compat)", "RitsuLib", "0.4.24", true);
        stale_alias.mod_id = Some("STS2-RitsuLib".into());
        stale_alias.mod_version_id = Some("ritsu-alias".into());
        stale_alias.bundle_url = Some("https://example.test/stale.zip".into());
        profile.mods.push(stale_alias);
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Pack",
            "RitsuLib (STS2 0.103.2 compat)",
            Some(&canonical_id),
            Some("RitsuLib"),
            Some("STS2-RitsuLib"),
            true,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(
            updated.mods[0].mod_version_id.as_deref(),
            Some(canonical_id.as_str())
        );
        assert_eq!(updated.mods[0].mod_id.as_deref(), Some("STS2-RitsuLib"));
        let saved = load_profile("Pack", &profiles_path).unwrap();
        assert_eq!(saved.mods.len(), 1);
        assert_eq!(
            saved.mods[0].mod_version_id.as_deref(),
            Some(canonical_id.as_str())
        );
    }

    #[test]
    fn selecting_bundle_version_moves_active_duplicate_member_ids_to_storage() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();

        write_bundle(
            &mods_path,
            "PrettyPack-old",
            "Pretty Pack",
            "1.0.0",
            &[
                ("BaseLib", "BaseLib"),
                ("KaguyaRegentMSGKSkin", "Kaguya Skin"),
            ],
        );
        write_mod(&mods_path, "BaseLib", "BaseLib", "1.0.0");
        write_bundle(
            &disabled_path,
            "PrettyPack-new",
            "Pretty Pack",
            "2.0.0",
            &[
                ("BaseLib", "BaseLib"),
                ("KaguyaRegentMSGKSkin", "Kaguya Skin"),
            ],
        );

        let mut installed =
            merge_active_disabled_mods(scan_mods(&mods_path), scan_disabled_mods(&disabled_path));
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config_tmp.path());
        let selected = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("PrettyPack-new"))
            .cloned()
            .expect("disabled bundle version should scan");

        let restored = select_local_mod_version_on_disk(
            &installed,
            "Pretty Pack",
            None,
            Some(&selected),
            None,
            None,
            true,
            &mods_path,
            &disabled_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .expect("selecting disabled bundle version should move it active");

        assert_eq!(restored.folder_name.as_deref(), Some("PrettyPack-new"));
        assert!(mods_path.join("PrettyPack-new").is_dir());
        assert!(
            !mods_path.join("BaseLib").exists(),
            "standalone duplicate runtime ID must not remain active"
        );
        assert!(
            disabled_path.join("BaseLib").is_dir(),
            "standalone duplicate runtime ID should be preserved in disabled storage"
        );
    }

    #[test]
    fn set_profile_mods_enabled_matches_by_id_when_manifest_folder_drifted() {
        // Reported bug: the modpack "Enable all" toggled by the manifest's
        // folder_name, which drifts from the installed folder, so toggle_mod
        // hard-errored "No mod with folder …". Match by the installed mod
        // instead and move its real folder.
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // On disk (disabled): real folder "RealFolder" (write_mod sets id == folder).
        write_mod(&disabled_path, "RealFolder", "Cool Mod", "1.0.0");

        // Manifest entry: DRIFTED folder_name but the same mod_id.
        let mut pack = empty_profile("Pack");
        pack.mods.push(ProfileMod {
            mod_version_id: None,
            name: "Cool Mod".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["StaleFolder-21-0-1-7/StaleFolder.dll".into()],
            folder_name: Some("StaleFolder-21-0-1-7".into()),
            mod_id: Some("RealFolder".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&pack, &profiles_path).unwrap();

        let result = set_profile_mods_enabled_from_paths(
            "Pack",
            true,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(result.toggled, vec!["Cool Mod".to_string()]);
        assert!(result.missing.is_empty(), "missing={:?}", result.missing);
        assert!(result.failed.is_empty(), "failed={:?}", result.failed);
        // The REAL on-disk folder moved to active, not the drifted manifest name.
        assert!(mods_path.join("RealFolder").join("RealFolder.dll").exists());
        assert!(!disabled_path.join("RealFolder").exists());
    }

    #[test]
    fn set_profile_mods_enabled_reports_missing_and_skips_already_in_state() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // "Here" is already active; "Ghost" isn't installed at all.
        write_mod(&mods_path, "Here", "Here", "1.0.0");
        let mut pack = empty_profile("Pack");
        pack.mods
            .push(profile_mod_entry("Here", "Here", "1.0.0", true));
        pack.mods
            .push(profile_mod_entry("Ghost", "Ghost", "1.0.0", true));
        save_profile(&pack, &profiles_path).unwrap();

        let result = set_profile_mods_enabled_from_paths(
            "Pack",
            true,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        // "Here" is already active → not re-toggled; "Ghost" is missing.
        assert!(result.toggled.is_empty(), "toggled={:?}", result.toggled);
        assert_eq!(result.missing, vec!["Ghost".to_string()]);
        assert!(mods_path.join("Here").exists());
    }

    #[test]
    fn set_profile_mods_enabled_persists_saved_enabled_state() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "Here", "Here", "1.0.0");
        let mut pack = empty_profile("Pack");
        pack.mods
            .push(profile_mod_entry("Here", "Here", "1.0.0", true));
        save_profile(&pack, &profiles_path).unwrap();

        let result = set_profile_mods_enabled_from_paths(
            "Pack",
            false,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(result.toggled, vec!["Here".to_string()]);
        assert!(disabled_path.join("Here").join("Here.dll").exists());
        let saved = load_profile("Pack", &profiles_path).unwrap();
        assert!(!saved.mods[0].enabled);
    }

    #[test]
    fn membership_matrix_lists_installed_mods_against_profiles_by_folder() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "BaseLib", "BaseLib", "1.0.0");
        write_mod(&disabled_path, "AutoPath", "AutoPath", "2.0.0");

        let mut alpha = empty_profile("Alpha");
        alpha.mods.push(ProfileMod {
            mod_version_id: None,
            name: "BaseLib".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["BaseLib/BaseLib.dll".into()],
            folder_name: Some("BaseLib".into()),
            mod_id: Some("BaseLib".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&alpha, &profiles_path).unwrap();
        save_profile(&empty_profile("Beta"), &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        assert_eq!(
            grid.profiles
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Beta"]
        );
        let base = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("BaseLib"))
            .unwrap();
        let alpha_state = base
            .profiles
            .iter()
            .find(|p| p.profile_name == "Alpha")
            .unwrap();
        assert!(alpha_state.included && alpha_state.enabled);
        assert_eq!(alpha_state.order_index, Some(0));
        let beta_state = base
            .profiles
            .iter()
            .find(|p| p.profile_name == "Beta")
            .unwrap();
        assert!(!beta_state.included);
        assert_eq!(beta_state.order_index, None);

        let auto = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("AutoPath"))
            .unwrap();
        assert!(
            !auto.installed_enabled,
            "disabled library mods should still be visible in the matrix"
        );
    }

    #[test]
    fn set_profile_mod_membership_adds_installed_mod_without_moving_files() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&disabled_path, "LibraryOnly", "Library Only", "1.2.3");
        save_profile(&empty_profile("Stable"), &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Stable",
            "Library Only",
            None,
            Some("LibraryOnly"),
            Some("LibraryOnly"),
            true,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        let entry = &updated.mods[0];
        assert_eq!(entry.name, "Library Only");
        assert_eq!(entry.folder_name.as_deref(), Some("LibraryOnly"));
        assert_eq!(entry.version, "1.2.3");
        assert!(
            !entry.enabled,
            "adding a disabled library mod should preserve its disabled profile state"
        );
        assert!(disabled_path
            .join("LibraryOnly")
            .join("LibraryOnly.dll")
            .exists());
        assert!(
            !mods_path.join("LibraryOnly").exists(),
            "editing membership must not apply the profile"
        );
    }

    #[test]
    fn set_profile_mod_membership_adds_workshop_mod_by_source_hint() {
        let _steam_guard = STEAM_ENV_LOCK.lock().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let steam_tmp = tempfile::tempdir().unwrap();
        let _env = EnvOverride::set("STS2_FIXTURE_STEAM_PATH", steam_tmp.path());
        let (mods_path, disabled_path) = steam_game_mod_paths(steam_tmp.path());
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let workshop_item_id = "3747602295";
        let workshop_url = crate::mods::workshop_url(workshop_item_id);
        write_workshop_mod(
            steam_tmp.path(),
            workshop_item_id,
            "STS2-RitsuLib",
            "RitsuLib",
            "0.4.41",
        );
        save_profile(&empty_profile("TesterW"), &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "TesterW",
            "RitsuLib",
            None,
            Some(workshop_item_id),
            Some("STS2-RitsuLib"),
            true,
            Some(&workshop_url),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        let entry = &updated.mods[0];
        assert_eq!(entry.name, "RitsuLib");
        assert_eq!(entry.version, "0.4.41");
        assert_eq!(entry.folder_name.as_deref(), Some(workshop_item_id));
        assert_eq!(entry.mod_id.as_deref(), Some("STS2-RitsuLib"));
        assert_eq!(entry.source.as_deref(), Some(workshop_url.as_str()));
        assert!(
            !mods_path.join(workshop_item_id).exists(),
            "adding a Workshop mod to a pack must not copy it into mods/"
        );
        assert!(
            !disabled_path.join(workshop_item_id).exists(),
            "adding a Workshop mod to a pack must not move it into mods_disabled/"
        );
    }

    #[test]
    fn membership_matrix_deduplicates_stale_workshop_artifact_rows_by_item_id() {
        let _steam_guard = STEAM_ENV_LOCK.lock().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let steam_tmp = tempfile::tempdir().unwrap();
        let _env = EnvOverride::set("STS2_FIXTURE_STEAM_PATH", steam_tmp.path());
        let (mods_path, disabled_path) = steam_game_mod_paths(steam_tmp.path());
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let workshop_item_id = "3747602295";
        let workshop_url = crate::mods::workshop_url(workshop_item_id);
        write_workshop_mod(
            steam_tmp.path(),
            workshop_item_id,
            "STS2-RitsuLib",
            "RitsuLib",
            "0.4.41",
        );

        let stale_id = "stale-workshop-artifact";
        let mut db = crate::mod_versions::ModVersionsDb::default();
        db.records.insert(
            stale_id.into(),
            crate::mod_versions::ModVersionRecord {
                id: stale_id.into(),
                identity_key: "legacy-stale-workshop-identity".into(),
                aliases: Vec::new(),
                name: "RitsuLib".into(),
                version: "0.4.41".into(),
                source_version: None,
                folder_name: Some(workshop_item_id.into()),
                mod_id: Some("STS2-RitsuLib".into()),
                bundle_member_ids: Vec::new(),
                source: Some(workshop_url.clone()),
                install_source: ModInstallSource::SteamWorkshop,
                workshop_item_id: Some(workshop_item_id.into()),
                workshop_url: Some(workshop_url.clone()),
                workshop_manifest: None,
                workshop_time_updated: None,
                content_hash: Some("old-workshop-hash".into()),
                archive_sha256: None,
                cache_relpath: Some(crate::mod_versions::cache_relpath_for_id(stale_id)),
                ..crate::mod_versions::ModVersionRecord::default()
            },
        );
        crate::mod_versions::save(&db, config_tmp.path()).unwrap();
        let stale_cache = crate::mod_versions::cache_path_for_id(cache_tmp.path(), stale_id);
        fs::create_dir_all(stale_cache.parent().unwrap()).unwrap();
        fs::write(stale_cache, b"stale workshop cache").unwrap();

        let mut profile = empty_profile("TesterW");
        profile.mods.push(ProfileMod {
            mod_version_id: Some(stale_id.into()),
            name: "RitsuLib".into(),
            version: "0.4.41".into(),
            source: Some(workshop_url.clone()),
            hash: None,
            files: vec!["mod_manifest.json".into()],
            folder_name: Some(workshop_item_id.into()),
            mod_id: Some("STS2-RitsuLib".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();
        let ritsu_rows = grid
            .mods
            .iter()
            .filter(|m| m.mod_id.as_deref() == Some("STS2-RitsuLib"))
            .collect::<Vec<_>>();

        assert_eq!(
            ritsu_rows.len(),
            1,
            "same Workshop item must not appear as both installed and stale cached rows"
        );
        assert!(ritsu_rows[0].install_source.is_workshop());
        let tester_state = ritsu_rows[0]
            .profiles
            .iter()
            .find(|state| state.profile_name == "TesterW")
            .unwrap();
        assert!(tester_state.included);
    }

    #[test]
    fn select_library_version_from_workshop_to_local_preserves_workshop_files() {
        let _steam_guard = STEAM_ENV_LOCK.lock().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let steam_tmp = tempfile::tempdir().unwrap();
        let _env = EnvOverride::set("STS2_FIXTURE_STEAM_PATH", steam_tmp.path());
        let (mods_path, disabled_path) = steam_game_mod_paths(steam_tmp.path());
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let workshop_item_id = "3747602295";
        let workshop_url = crate::mods::workshop_url(workshop_item_id);
        write_workshop_mod(
            steam_tmp.path(),
            workshop_item_id,
            "STS2-RitsuLib",
            "RitsuLib",
            "0.4.41",
        );
        write_mod_with_id(
            &disabled_path,
            "STS2-RitsuLib-v0.2.26",
            "STS2-RitsuLib",
            "RitsuLib",
            "0.2.26",
        );

        let mut installed = scan_installed_mods_with_workshop(&mods_path, &disabled_path);
        crate::mod_sources::enrich_mods_with_sources(&mut installed, config_tmp.path());
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config_tmp.path());
        let current = installed
            .iter()
            .find(|m| m.install_source.is_workshop())
            .expect("Workshop RitsuLib should scan")
            .clone();
        let selected = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("STS2-RitsuLib-v0.2.26"))
            .expect("stored local RitsuLib should scan")
            .clone();

        let result = select_library_mod_version_from_paths(
            &current.name,
            current.mod_version_id.as_deref(),
            current.folder_name.as_deref(),
            current.mod_id.as_deref(),
            Some(current.install_source),
            current.workshop_item_id.as_deref(),
            current.workshop_url.as_deref(),
            &selected.name,
            selected.mod_version_id.as_deref(),
            selected.folder_name.as_deref(),
            selected.mod_id.as_deref(),
            Some(selected.install_source),
            selected.workshop_item_id.as_deref(),
            selected.workshop_url.as_deref(),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        assert_eq!(result.folder_name.as_deref(), Some("STS2-RitsuLib-v0.2.26"));
        assert!(mods_path.join("STS2-RitsuLib-v0.2.26").is_dir());
        assert!(!disabled_path.join("STS2-RitsuLib-v0.2.26").exists());
        assert!(
            steam_tmp
                .path()
                .join("steamapps/workshop/content")
                .join(crate::game::STS2_STEAM_APPID)
                .join(workshop_item_id)
                .join("mod_manifest.json")
                .is_file(),
            "switching away from Workshop must not mutate Steam-owned files"
        );
        assert_eq!(current.workshop_url.as_deref(), Some(workshop_url.as_str()));
    }

    #[test]
    fn select_library_version_from_local_to_workshop_stores_local_shadow_copy() {
        let _steam_guard = STEAM_ENV_LOCK.lock().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let steam_tmp = tempfile::tempdir().unwrap();
        let _env = EnvOverride::set("STS2_FIXTURE_STEAM_PATH", steam_tmp.path());
        let (mods_path, disabled_path) = steam_game_mod_paths(steam_tmp.path());
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let workshop_item_id = "3747602295";
        write_mod_with_id(
            &mods_path,
            "STS2-RitsuLib-v0.2.26",
            "STS2-RitsuLib",
            "RitsuLib",
            "0.2.26",
        );
        write_workshop_mod(
            steam_tmp.path(),
            workshop_item_id,
            "STS2-RitsuLib",
            "RitsuLib",
            "0.4.41",
        );

        let mut installed = scan_installed_mods_with_workshop(&mods_path, &disabled_path);
        crate::mod_sources::enrich_mods_with_sources(&mut installed, config_tmp.path());
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config_tmp.path());
        let current = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("STS2-RitsuLib-v0.2.26"))
            .expect("active local RitsuLib should scan")
            .clone();
        let selected = installed
            .iter()
            .find(|m| m.install_source.is_workshop())
            .expect("Workshop RitsuLib should scan")
            .clone();

        let result = select_library_mod_version_from_paths(
            &current.name,
            current.mod_version_id.as_deref(),
            current.folder_name.as_deref(),
            current.mod_id.as_deref(),
            Some(current.install_source),
            current.workshop_item_id.as_deref(),
            current.workshop_url.as_deref(),
            &selected.name,
            selected.mod_version_id.as_deref(),
            selected.folder_name.as_deref(),
            selected.mod_id.as_deref(),
            Some(selected.install_source),
            selected.workshop_item_id.as_deref(),
            selected.workshop_url.as_deref(),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        assert!(result.install_source.is_workshop());
        assert_eq!(result.workshop_item_id.as_deref(), Some(workshop_item_id));
        assert!(
            disabled_path.join("STS2-RitsuLib-v0.2.26").is_dir(),
            "selecting Workshop should store the local mods/ copy that would shadow it"
        );
        assert!(!mods_path.join("STS2-RitsuLib-v0.2.26").exists());
    }

    #[test]
    fn set_profile_mod_membership_does_not_duplicate_same_folder_when_readded() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "LibraryOnly", "Library Only", "1.2.3");
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            mod_version_id: None,
            name: "Library Only".into(),
            version: "1.2.3".into(),
            source: None,
            hash: None,
            files: vec!["LibraryOnly/LibraryOnly.dll".into()],
            folder_name: Some("LibraryOnly".into()),
            mod_id: Some("LibraryOnly".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Stable",
            "Library Only",
            None,
            Some("LibraryOnly"),
            Some("LibraryOnly"),
            true,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(updated.mods[0].folder_name.as_deref(), Some("LibraryOnly"));
    }

    #[test]
    fn set_profile_mod_membership_refreshes_existing_entry_from_disk() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "LibraryOnly", "Library Only", "2.0.0");
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            mod_version_id: None,
            name: "Library Only".into(),
            version: "1.2.3".into(),
            source: None,
            hash: None,
            files: vec!["LibraryOnly/LibraryOnly.dll".into()],
            folder_name: Some("LibraryOnly".into()),
            mod_id: Some("LibraryOnly".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Stable",
            "Library Only",
            None,
            Some("LibraryOnly"),
            Some("LibraryOnly"),
            true,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(updated.mods[0].version, "2.0.0");
        let saved = load_profile("Stable", &profiles_path).unwrap();
        assert_eq!(saved.mods[0].version, "2.0.0");
    }

    #[test]
    fn select_profile_mod_version_recovers_stale_profile_artifact_id_by_runtime_id() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod_with_id(
            &mods_path,
            "STS2-RitsuLib",
            "STS2-RitsuLib",
            "RitsuLib (STS2 0.103.2 compat)",
            "dev-build",
        );
        write_mod_with_id(
            &disabled_path,
            "STS2-RitsuLib-v0.4.24",
            "STS2-RitsuLib",
            "RitsuLib",
            "0.4.24",
        );

        let mut installed =
            merge_active_disabled_mods(scan_mods(&mods_path), scan_disabled_mods(&disabled_path));
        crate::mod_versions::enrich_mods_with_versions(&mut installed, config_tmp.path());
        let current = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("STS2-RitsuLib"))
            .expect("active RitsuLib row should scan")
            .clone();
        let selected = installed
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("STS2-RitsuLib-v0.4.24"))
            .expect("stored RitsuLib row should scan")
            .clone();

        let mut profile = empty_profile("TesterW");
        profile.mods.push(ProfileMod {
            mod_version_id: Some("stale-ritsulib-artifact-id".into()),
            name: "RitsuLib".into(),
            version: "0.4.23".into(),
            source: None,
            hash: None,
            files: vec!["20260618-210749/STS2-RitsuLib.dll".into()],
            folder_name: Some("20260618-210749".into()),
            mod_id: Some("STS2-RitsuLib".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let updated = select_profile_mod_version_from_paths(
            "TesterW",
            &current.name,
            current.mod_version_id.as_deref(),
            current.folder_name.as_deref(),
            current.mod_id.as_deref(),
            None,
            None,
            None,
            &selected.name,
            selected.mod_version_id.as_deref(),
            selected.folder_name.as_deref(),
            selected.mod_id.as_deref(),
            None,
            None,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
            false,
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(updated.mods[0].name, "RitsuLib");
        assert_eq!(updated.mods[0].version, "0.4.24");
        assert_eq!(
            updated.mods[0].folder_name.as_deref(),
            Some("STS2-RitsuLib-v0.4.24")
        );
        assert!(updated.mods[0].enabled);
    }

    #[test]
    fn membership_matrix_keeps_same_named_different_versions_as_separate_rows() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "card_art_editor", "Card Art Editor", "1.0.0");
        write_mod(
            &mods_path,
            "card_art_editor_beta",
            "Card Art Editor",
            "2.0.0-beta",
        );
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            mod_version_id: None,
            name: "Card Art Editor".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec!["card_art_editor/card_art_editor.dll".into()],
            folder_name: Some("card_art_editor".into()),
            mod_id: Some("card_art_editor".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        let rows = grid
            .mods
            .iter()
            .filter(|m| m.name == "Card Art Editor")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        let stable = rows
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor"))
            .unwrap();
        let beta = rows
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("card_art_editor_beta"))
            .unwrap();
        assert_eq!(stable.version, "1.0.0");
        assert_eq!(beta.version, "2.0.0-beta");
        assert!(stable
            .profiles
            .iter()
            .any(|p| p.profile_name == "Stable" && p.included));
        assert!(beta
            .profiles
            .iter()
            .any(|p| p.profile_name == "Stable" && !p.included));
    }

    #[test]
    fn membership_matrix_does_not_move_pinned_profile_to_newer_installed_artifact() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        let mut old_info = ModInfo {
            mod_version_id: None,
            name: "Library Only".into(),
            version: "1.2.3".into(),
            description: String::new(),
            enabled: true,
            files: vec!["LibraryOnly/LibraryOnly.dll".into()],
            source: None,
            hash: Some("old-hash".into()),
            dependencies: Vec::new(),
            size_bytes: 0,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            folder_name: Some("LibraryOnly".into()),
            mod_id: Some("LibraryOnly".into()),
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
        };
        let old_id = crate::mod_versions::ensure_mod_info_id(&mut old_info, config_tmp.path())
            .expect("old version should get an artifact id");

        write_mod(&mods_path, "LibraryOnly", "Library Only", "2.0.0");
        let mut profile = empty_profile("Stable");
        profile.mods.push(ProfileMod {
            mod_version_id: Some(old_id),
            name: "Library Only".into(),
            version: "1.2.3".into(),
            source: None,
            hash: Some("old-hash".into()),
            files: vec!["LibraryOnly/LibraryOnly.dll".into()],
            folder_name: Some("LibraryOnly".into()),
            mod_id: Some("LibraryOnly".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        let row = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("LibraryOnly"))
            .unwrap();
        assert_eq!(row.version, "2.0.0");
        assert!(row
            .profiles
            .iter()
            .any(|p| p.profile_name == "Stable" && !p.included));
    }

    #[test]
    fn membership_matrix_lists_cached_profile_version_after_library_promotion() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "BaseLib", "BaseLib", "3.2.1");
        let mut old_info = scan_mods(&mods_path)
            .into_iter()
            .find(|info| info.folder_name.as_deref() == Some("BaseLib"))
            .unwrap();
        let old_id = crate::mod_versions::ensure_mod_info_id(&mut old_info, config_tmp.path())
            .expect("old version should get an artifact id");
        assert!(
            crate::mod_versions::cache_mod_version_by_id(
                &mut old_info,
                &mods_path,
                cache_tmp.path(),
                config_tmp.path(),
            )
            .is_some(),
            "old promoted-away version must be cached"
        );
        let alias_id = "legacy-regent-source-version-id".to_string();
        fs::rename(
            crate::mod_versions::cache_path_for_id(cache_tmp.path(), &old_id),
            crate::mod_versions::cache_path_for_id(cache_tmp.path(), &alias_id),
        )
        .unwrap();
        let mut version_db = crate::mod_versions::load(config_tmp.path());
        version_db
            .records
            .get_mut(&old_id)
            .unwrap()
            .aliases
            .push(alias_id.clone());
        version_db.aliases.insert(alias_id, old_id.clone());
        crate::mod_versions::save(&version_db, config_tmp.path()).unwrap();
        fs::remove_dir_all(mods_path.join("BaseLib")).unwrap();
        write_mod(&mods_path, "BaseLib", "BaseLib", "3.3.1");

        let mut profile = empty_profile("TesterW");
        profile.mods.push(ProfileMod {
            mod_version_id: Some(old_id.clone()),
            name: "BaseLib".into(),
            version: "3.2.1".into(),
            source: None,
            hash: old_info.hash.clone(),
            files: old_info.files.clone(),
            folder_name: Some("BaseLib".into()),
            mod_id: Some("BaseLib".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        let current_row = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("BaseLib") && m.version == "3.3.1")
            .unwrap();
        assert!(current_row.installed);
        assert!(current_row
            .profiles
            .iter()
            .any(|p| p.profile_name == "TesterW" && !p.included));

        let cached_row = grid
            .mods
            .iter()
            .find(|m| m.mod_version_id.as_deref() == Some(old_id.as_str()))
            .unwrap();
        assert!(!cached_row.installed);
        assert!(cached_row.cached);
        assert_eq!(cached_row.version, "3.2.1");
        assert!(cached_row
            .profiles
            .iter()
            .any(|p| p.profile_name == "TesterW" && p.included));
        assert!(
            cached_row
                .version_options
                .iter()
                .any(|option| option.version == "3.3.1"),
            "cached profile row should still offer the promoted library version"
        );
    }

    #[test]
    fn set_profile_mod_membership_removes_matching_folder_only() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "card_art_editor", "Card Art Editor", "1.0.0");
        write_mod(&mods_path, "card_art_editor_v2", "Card Art Editor", "2.0.0");
        let mut profile = empty_profile("Beta");
        for (folder, version) in [
            ("card_art_editor", "1.0.0"),
            ("card_art_editor_v2", "2.0.0"),
        ] {
            profile.mods.push(ProfileMod {
                mod_version_id: None,
                name: "Card Art Editor".into(),
                version: version.into(),
                source: None,
                hash: None,
                files: vec![format!("{folder}/{folder}.dll")],
                folder_name: Some(folder.into()),
                mod_id: Some(folder.into()),
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
                bundle_members: vec![],
                bundle_member_ids: vec![],
            });
        }
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Beta",
            "Card Art Editor",
            None,
            Some("card_art_editor_v2"),
            Some("card_art_editor_v2"),
            false,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(
            updated.mods[0].folder_name.as_deref(),
            Some("card_art_editor")
        );
        assert!(mods_path
            .join("card_art_editor_v2")
            .join("card_art_editor_v2.dll")
            .exists());
    }

    #[test]
    fn set_profile_mod_membership_removes_unique_stable_match_when_artifact_id_drifted() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        let mut profile = empty_profile("Beta");
        profile.mods.push(ProfileMod {
            mod_version_id: Some("old-hellbandgirls-artifact".into()),
            name: "HellBandGirls".into(),
            version: "0.2.1".into(),
            source: None,
            hash: None,
            files: vec!["HellBand/HellBandGirls.dll".into()],
            folder_name: Some("HellBand".into()),
            mod_id: Some("HellBand".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
            bundle_members: vec![],
            bundle_member_ids: vec![],
        });
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Beta",
            "HellBandGirls",
            Some("new-hellbandgirls-artifact"),
            Some("HellBand"),
            Some("HellBand"),
            false,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert!(
            updated.mods.is_empty(),
            "removal must fall back to the unique folder/mod id when the installed artifact id changed"
        );
    }

    #[test]
    fn set_profile_mod_membership_adds_by_source_when_folder_name_drifted() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "Flagellant", "Flagellant", "unknown");
        crate::mod_sources::attach_nexus_source(
            "Flagellant",
            Some("Flagellant"),
            "https://www.nexusmods.com/slaythespire2/mods/1073".into(),
            "slaythespire2".into(),
            1073,
            config_tmp.path(),
        );
        save_profile(&empty_profile("Solo Pack"), &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Solo Pack",
            "Flagellant 0.1.7-1073-0-1-7-1781082503",
            None,
            Some("Flagellant 0.1.7-1073-0-1-7-1781082503"),
            None,
            true,
            Some("https://www.nexusmods.com/slaythespire2/mods/1073"),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(updated.mods.len(), 1);
        assert_eq!(updated.mods[0].folder_name.as_deref(), Some("Flagellant"));
        assert_eq!(
            updated.mods[0].source.as_deref(),
            None,
            "membership records the installed manifest data; publish backfills source from mod_sources"
        );
    }

    #[test]
    fn set_profile_mod_membership_keeps_same_nexus_page_variants_distinct() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        write_mod(&mods_path, "Necro_Icons", "Necro Icons", "1.0.0");
        write_mod(&mods_path, "Princess_Icons", "Princess Icons", "1.0.0");
        for folder in ["Necro_Icons", "Princess_Icons"] {
            crate::mod_sources::attach_nexus_source(
                folder,
                Some(folder),
                "https://www.nexusmods.com/slaythespire2/mods/895".into(),
                "slaythespire2".into(),
                895,
                config_tmp.path(),
            );
        }
        save_profile(&empty_profile("Icons Pack"), &profiles_path).unwrap();

        let updated = set_profile_mod_membership_from_paths(
            "Icons Pack",
            "Necro Icons",
            None,
            Some("Necro_Icons"),
            Some("Necro_Icons"),
            true,
            Some("https://www.nexusmods.com/slaythespire2/mods/895"),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();
        assert_eq!(updated.mods.len(), 1);

        let updated = set_profile_mod_membership_from_paths(
            "Icons Pack",
            "Princess Icons",
            None,
            Some("Princess_Icons"),
            Some("Princess_Icons"),
            true,
            Some("https://www.nexusmods.com/slaythespire2/mods/895"),
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        let folders = updated
            .mods
            .iter()
            .map(|pm| pm.folder_name.as_deref().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(folders, vec!["Necro_Icons", "Princess_Icons"]);
    }

    #[test]
    fn set_profile_mod_membership_rejects_subscribed_profiles() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();
        write_mod(&mods_path, "BaseLib", "BaseLib", "1.0.0");
        let profile = empty_profile("Friend Pack");
        let profile_id = profile.id.clone();
        save_profile(&profile, &profiles_path).unwrap();
        crate::subscriptions::save_subscriptions(
            &crate::subscriptions::SubscriptionsDb {
                subscriptions: std::collections::HashMap::from([(
                    "alice/AAAA-BBBB-CCCC".into(),
                    crate::subscriptions::Subscription {
                        share_id: "alice/AAAA-BBBB-CCCC".into(),
                        share_url: "https://example.test".into(),
                        profile_name: "Friend Pack".into(),
                        profile_id,
                        curator: Some("alice".into()),
                        last_synced_profile: empty_profile("Friend Pack"),
                        last_checked: "2026-05-19T00:00:00Z".parse().unwrap(),
                        last_synced: "2026-05-19T00:00:00Z".parse().unwrap(),
                    },
                )]),
            },
            config_tmp.path(),
        )
        .unwrap();

        let err = set_profile_mod_membership_from_paths(
            "Friend Pack",
            "BaseLib",
            None,
            Some("BaseLib"),
            Some("BaseLib"),
            true,
            None,
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("subscribed profile"),
            "subscribed packs should be read-only in the library editor; got: {}",
            err
        );
    }

    #[test]
    fn set_profile_load_order_reorders_manifest_without_losing_metadata() {
        let config_tmp = tempfile::tempdir().unwrap();
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&profiles_path).unwrap();

        let mut profile = empty_profile("Stable");
        profile
            .mods
            .push(profile_mod_entry("BaseLib", "BaseLib", "1.0.0", true));
        profile.mods.push(profile_mod_entry(
            "Card Art Editor",
            "CardArtEditor",
            "2.0.0",
            false,
        ));
        save_profile(&profile, &profiles_path).unwrap();

        let updated = set_profile_load_order_from_paths(
            "Stable",
            vec![
                ProfileModOrderKey {
                    mod_version_id: None,
                    name: "Card Art Editor".into(),
                    folder_name: Some("CardArtEditor".into()),
                    mod_id: Some("CardArtEditor".into()),
                },
                ProfileModOrderKey {
                    mod_version_id: None,
                    name: "BaseLib".into(),
                    folder_name: Some("BaseLib".into()),
                    mod_id: Some("BaseLib".into()),
                },
            ],
            &profiles_path,
            config_tmp.path(),
        )
        .unwrap();

        assert_eq!(
            updated
                .mods
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Card Art Editor", "BaseLib"]
        );
        assert_eq!(
            updated.mods[0].bundle_url.as_deref(),
            Some("https://example.test/CardArtEditor.zip"),
            "reordering must not rebuild or lose share/download metadata"
        );
        assert_eq!(
            updated.mods[1].source.as_deref(),
            Some("github:example/BaseLib")
        );
    }

    #[test]
    fn write_profile_load_order_to_settings_save_uses_profile_order_and_preserves_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(
            &settings_path,
            r#"{
  "audio": { "master": 80 },
  "mod_settings": {
    "mod_list": [
      { "id": "BaseLib", "is_enabled": true, "source": "mods_directory", "note": "keep" },
      { "id": "CardArtEditor", "is_enabled": true, "source": "mods_directory" },
      { "id": "PinnedUtility", "is_enabled": true, "source": "mods_directory", "custom": 9 }
    ],
    "mods_enabled": false
  }
}"#,
        )
        .unwrap();

        let mut profile = empty_profile("Stable");
        profile.mods.push(profile_mod_entry(
            "Card Art Editor",
            "CardArtEditor",
            "2.0.0",
            true,
        ));
        profile
            .mods
            .push(profile_mod_entry("BaseLib", "BaseLib", "1.0.0", false));
        let pinned = vec![ModInfo {
            mod_version_id: None,
            name: "Pinned Utility".into(),
            version: "1.0.0".into(),
            description: String::new(),
            enabled: true,
            files: vec!["PinnedUtility/PinnedUtility.dll".into()],
            source: None,
            hash: None,
            dependencies: Vec::new(),
            size_bytes: 0,
            github_url: None,
            github_auto_detected: false,
            nexus_url: None,
            folder_name: Some("PinnedUtility".into()),
            mod_id: Some("PinnedUtility".into()),
            pinned: true,
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
        }];

        write_profile_load_order_to_settings_file(&profile, &settings_path, &pinned).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        let mod_list = saved["mod_settings"]["mod_list"].as_array().unwrap();
        let ids = mod_list
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["CardArtEditor", "BaseLib", "PinnedUtility"]);
        assert_eq!(mod_list[1]["is_enabled"].as_bool(), Some(true));
        assert_eq!(mod_list[1]["note"].as_str(), Some("keep"));
        assert_eq!(mod_list[2]["custom"].as_i64(), Some(9));
        assert_eq!(saved["mod_settings"]["mods_enabled"].as_bool(), Some(true));
        assert_eq!(saved["audio"]["master"].as_i64(), Some(80));
        // L-6: on a successful rewrite the pre-write backup is cleaned up so it
        // doesn't accumulate one stale settings.save copy per load-order edit.
        assert!(
            !fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.save.sts2mm-bak")),
            "a successful settings.save rewrite must remove its temporary backup"
        );
    }

    #[test]
    fn write_profile_load_order_to_settings_save_preserves_workshop_source_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(
            &settings_path,
            r#"{
  "mod_settings": {
    "mod_list": [
      { "id": "STS2-RitsuLib", "is_enabled": true, "source": "mods_directory", "note": "local copy" },
      { "id": "STS2-RitsuLib", "is_enabled": true, "source": "steam_workshop", "note": "steam copy" }
    ],
    "mods_enabled": true
  }
}"#,
        )
        .unwrap();

        let mut profile = empty_profile("Mixed");
        let mut local = profile_mod_entry("RitsuLib", "RitsuLib", "0.4.26", true);
        local.mod_id = Some("STS2-RitsuLib".into());
        local.source = Some("github:example/RitsuLib".into());
        let mut workshop = profile_mod_entry("RitsuLib", "3747602295", "0.4.41", false);
        workshop.mod_id = Some("STS2-RitsuLib".into());
        workshop.source = Some(crate::mods::workshop_url("3747602295"));
        workshop.hash = None;
        workshop.bundle_url = None;
        workshop.bundle_sha256 = None;
        profile.mods.push(local);
        profile.mods.push(workshop);

        write_profile_load_order_to_settings_file(&profile, &settings_path, &[]).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        let mod_list = saved["mod_settings"]["mod_list"].as_array().unwrap();
        assert_eq!(mod_list.len(), 2);
        assert_eq!(mod_list[0]["id"].as_str(), Some("STS2-RitsuLib"));
        assert_eq!(mod_list[0]["source"].as_str(), Some("mods_directory"));
        assert_eq!(mod_list[0]["is_enabled"].as_bool(), Some(true));
        assert_eq!(mod_list[0]["note"].as_str(), Some("local copy"));
        assert_eq!(mod_list[1]["id"].as_str(), Some("STS2-RitsuLib"));
        assert_eq!(mod_list[1]["source"].as_str(), Some("steam_workshop"));
        assert_eq!(mod_list[1]["is_enabled"].as_bool(), Some(false));
        assert_eq!(mod_list[1]["note"].as_str(), Some("steam copy"));
    }

    #[test]
    fn write_profile_load_order_to_settings_save_repairs_trailing_fragment() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(
            &settings_path,
            r#"{
  "schema_version": 5,
  "mod_settings": null,
  "volume_master": 0.5
}
  "schema_version": 5,
  "volume_master": 0.5
}"#,
        )
        .unwrap();

        let mut profile = empty_profile("Stable");
        profile.mods.push(profile_mod_entry(
            "Card Art Editor",
            "CardArtEditor",
            "2.0.0",
            true,
        ));

        write_profile_load_order_to_settings_file(&profile, &settings_path, &[]).unwrap();

        let saved_raw = fs::read_to_string(&settings_path).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&saved_raw).unwrap();
        let mod_list = saved["mod_settings"]["mod_list"].as_array().unwrap();
        assert_eq!(mod_list[0]["id"].as_str(), Some("CardArtEditor"));
        assert_eq!(saved["schema_version"].as_i64(), Some(5));
        assert!(
            !saved_raw.contains("}\n  \"schema_version\"")
                && !saved_raw.contains("}\r\n  \"schema_version\""),
            "rewrite should not leave a stale top-level fragment after the root object"
        );
    }

    #[test]
    fn settings_save_resolution_uses_single_candidate() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(&settings_path, "{}").unwrap();

        match resolve_settings_save_candidates(vec![settings_path.clone()]) {
            SettingsSaveResolution::Found(path) => assert_eq!(path, settings_path),
            other => panic!("expected single settings.save candidate, got {:?}", other),
        }
    }

    #[test]
    fn settings_save_resolution_refuses_distinct_multiple_candidates() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("steam").join("111").join("settings.save");
        let second = tmp.path().join("steam").join("222").join("settings.save");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&first, r#"{"account":111}"#).unwrap();
        fs::write(&second, r#"{"account":222}"#).unwrap();

        match resolve_settings_save_candidates(vec![first.clone(), second.clone()]) {
            SettingsSaveResolution::Multiple(paths) => assert_eq!(paths, vec![first, second]),
            other => panic!(
                "expected distinct settings.save files to remain ambiguous, got {:?}",
                other
            ),
        }
    }

    #[test]
    fn settings_save_resolution_deduplicates_aliases_to_same_candidate() {
        let tmp = tempfile::tempdir().unwrap();
        let account_dir = tmp.path().join("steam").join("111");
        fs::create_dir_all(&account_dir).unwrap();
        let settings_path = account_dir.join("settings.save");
        fs::write(&settings_path, "{}").unwrap();
        let alias = account_dir.join("..").join("111").join("settings.save");

        match resolve_settings_save_candidates(vec![settings_path.clone(), alias]) {
            SettingsSaveResolution::Found(path) => assert_eq!(
                path.canonicalize().unwrap(),
                settings_path.canonicalize().unwrap()
            ),
            other => panic!(
                "expected aliased settings.save paths to resolve to one file, got {:?}",
                other
            ),
        }
    }

    #[test]
    fn settings_save_write_removes_backup_on_success() {
        // L-6: a clean rewrite must not leave a `.sts2mm-bak-<ts>` snapshot
        // behind. Use the low-level helper directly so the assertion is about
        // the backup lifecycle, not the JSON rewrite.
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        let original = r#"{"mod_settings":{"mod_list":[]}}"#;
        fs::write(&settings_path, original).unwrap();

        let returned = write_settings_save_with_backup_and_restore(
            &settings_path,
            "{\"mod_settings\":{\"mod_list\":[],\"mods_enabled\":true}}",
            |path, contents| fs::write(path, contents),
        )
        .unwrap();

        // The new contents landed...
        assert!(fs::read_to_string(&settings_path)
            .unwrap()
            .contains("mods_enabled"));
        // ...and the temporary backup was deleted on the success path.
        assert!(
            !returned.exists(),
            "the returned backup path must be removed after a successful write"
        );
        assert!(
            !fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.save.sts2mm-bak")),
            "no settings.save backup should remain after a successful write"
        );
    }

    #[test]
    fn settings_save_backup_disambiguates_when_same_timestamp_name_exists() {
        // L-5: the collision suffix counter is u32, so a same-millisecond name
        // clash picks a fresh `-1` suffix instead of overwriting the existing
        // backup (and, at 256+ clashes, must not saturate into an infinite
        // loop on a fixed name). Pre-seed the un-suffixed backup name and
        // confirm the write still produces a *distinct* backup file.
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        fs::write(&settings_path, "{}").unwrap();

        // Pre-create every backup name the helper would pick this millisecond,
        // forcing the suffix loop to advance past the first candidate.
        let ts = chrono::Utc::now().timestamp_millis();
        let base = tmp.path().join(format!("settings.save.sts2mm-bak-{}", ts));
        fs::write(&base, "pre-existing").unwrap();

        let returned = write_settings_save_with_backup_and_restore(
            &settings_path,
            "{\"written\":true}",
            |path, contents| fs::write(path, contents),
        )
        .unwrap();

        // The pre-existing backup must be untouched (a different file was used).
        assert_eq!(
            fs::read_to_string(&base).unwrap(),
            "pre-existing",
            "the collision path must not clobber an existing backup of the same name"
        );
        assert_ne!(
            returned, base,
            "the suffix counter must pick a distinct backup path on a name clash"
        );
        // And the write itself still succeeded.
        assert_eq!(
            fs::read_to_string(&settings_path).unwrap(),
            "{\"written\":true}"
        );
    }

    #[test]
    fn settings_save_write_restores_backup_when_rewrite_fails_after_damage() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.save");
        let original = r#"{"mod_settings":{"mod_list":[{"id":"BaseLib","is_enabled":true}]}}"#;
        fs::write(&settings_path, original).unwrap();

        let err = write_settings_save_with_backup_and_restore(
            &settings_path,
            "{\"mod_settings\":{\"mod_list\":[]}}",
            |path, _content| {
                fs::write(path, "BROKEN PARTIAL WRITE")?;
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "simulated write failure",
                ))
            },
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("simulated write failure"),
            "caller should still see the original hard failure; got: {}",
            err
        );
        assert_eq!(
            fs::read_to_string(&settings_path).unwrap(),
            original,
            "a hard settings.save rewrite failure must restore the pre-write backup"
        );
        assert!(
            fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.save.sts2mm-bak")),
            "the backup should be retained for manual inspection"
        );
    }

    /// Regression guard: `enrich_mods_with_sources` runs before the grid is
    /// assembled, so a `display_name` saved in `mod_sources.json` (keyed by
    /// folder name) must appear on the resulting `ProfileMembershipMod` row.
    ///
    /// Steps:
    ///   1. Write a minimal mod manifest into `mods/AutoPath/`.
    ///   2. Write a `mod_sources.json` entry for "AutoPath" with
    ///      `display_name = "Autooo"` and `tags = ["teez"]`.
    ///   3. Call `profile_membership_matrix`.
    ///   4. Assert the row for AutoPath carries `display_name == Some("Autooo")`.
    #[test]
    fn membership_matrix_applies_display_name_override_from_sources() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // 1. Minimal mod on disk (folder name == "AutoPath", manifest name == "AutoPath").
        write_mod(&mods_path, "AutoPath", "AutoPath", "1.0.0");

        // 2. Save a mod_sources entry that overrides display_name.
        let mut db = crate::mod_sources::ModSourcesDb::default();
        db.mods.insert(
            "AutoPath".to_string(),
            crate::mod_sources::ModSourceEntry {
                display_name: Some("Autooo".to_string()),
                tags: vec!["teez".to_string()],
                ..Default::default()
            },
        );
        crate::mod_sources::save_sources(&db, config_tmp.path()).unwrap();

        // 3. Empty profile so the grid still has a profiles column.
        save_profile(&empty_profile("TestPack"), &profiles_path).unwrap();

        // 4. Build the grid.
        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        // 5. Assert the row for AutoPath carries the enriched display_name.
        let row = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("AutoPath"))
            .expect("AutoPath must appear as a row in the membership grid");
        assert_eq!(
            row.display_name.as_deref(),
            Some("Autooo"),
            "enrich_mods_with_sources must carry the saved display_name override into the grid row"
        );
    }

    /// A sidecar bundle container appears as a SINGLE row in the membership grid
    /// with folder_name == container name. The individual member mods are NOT
    /// separate rows. A standalone mod alongside still appears as its own row.
    ///
    /// Fixture: a sidecar bundle container `Pack/` holding two member mods
    /// (`ModA`, `ModB`) plus one top-level standalone mod (`StandAlone`).
    #[test]
    fn membership_matrix_lists_bundle_as_one_row() {
        let game_tmp = tempfile::tempdir().unwrap();
        let config_tmp = tempfile::tempdir().unwrap();
        let cache_tmp = tempfile::tempdir().unwrap();
        let mods_path = game_tmp.path().join("mods");
        let disabled_path = game_tmp.path().join("mods_disabled");
        let profiles_path = config_tmp.path().join("profiles");
        fs::create_dir_all(&mods_path).unwrap();
        fs::create_dir_all(&disabled_path).unwrap();
        fs::create_dir_all(&profiles_path).unwrap();

        // Create bundle container Pack/ with two member mods.
        let pack_dir = mods_path.join("Pack");
        let mod_a_dir = pack_dir.join("ModA");
        let mod_b_dir = pack_dir.join("ModB");
        fs::create_dir_all(&mod_a_dir).unwrap();
        fs::create_dir_all(&mod_b_dir).unwrap();
        fs::write(mod_a_dir.join("ModA.dll"), b"dll").unwrap();
        fs::write(mod_b_dir.join("ModB.dll"), b"dll").unwrap();
        crate::mods::bundle::write_sidecar(
            &pack_dir,
            &crate::mods::bundle::BundleSidecar {
                display_name: "Pretty Pack".into(),
                ..Default::default()
            },
        )
        .unwrap();

        // Create a standalone top-level mod.
        write_mod(&mods_path, "StandAlone", "StandAlone", "1.0.0");

        save_profile(&empty_profile("TestPack"), &profiles_path).unwrap();

        let grid = profile_membership_matrix(
            &mods_path,
            &disabled_path,
            &profiles_path,
            config_tmp.path(),
            cache_tmp.path(),
        )
        .unwrap();

        // The bundle container must appear as ONE row with folder_name == "Pack".
        let pack_row = grid
            .mods
            .iter()
            .find(|m| m.folder_name.as_deref() == Some("Pack"))
            .expect("Bundle container Pack must appear as a single row in the grid");
        assert_eq!(
            pack_row.name, "Pretty Pack",
            "bundle row name must be the sidecar display_name"
        );

        // ModA and ModB must NOT be separate rows.
        assert!(
            grid.mods
                .iter()
                .all(|m| m.folder_name.as_deref() != Some("ModA")),
            "ModA must not appear as a separate grid row — it is a bundle member"
        );
        assert!(
            grid.mods
                .iter()
                .all(|m| m.folder_name.as_deref() != Some("ModB")),
            "ModB must not appear as a separate grid row — it is a bundle member"
        );

        // Standalone mod must still appear as its own row.
        assert!(
            grid.mods
                .iter()
                .any(|m| m.folder_name.as_deref() == Some("StandAlone")),
            "StandAlone must still appear as its own row"
        );
    }
}
