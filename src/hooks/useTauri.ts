import { invoke } from '@tauri-apps/api/core';
import type { ModInfo, Profile, GameInfo, GitHubRepo, ModUpdate, QuickAddResult, ShareResult, BackupInfo } from '../types';

export async function detectGamePath(): Promise<GameInfo> {
  return invoke('detect_game_path');
}

export async function setGamePath(path: string): Promise<GameInfo> {
  return invoke('set_game_path', { path });
}

export async function getInstalledMods(): Promise<ModInfo[]> {
  return invoke('get_installed_mods');
}

export async function toggleMod(name: string, enable: boolean): Promise<void> {
  return invoke('toggle_mod', { name, enable });
}

export async function deleteMod(name: string): Promise<void> {
  return invoke('delete_mod_cmd', { name });
}

export async function searchGithubMods(query: string): Promise<GitHubRepo[]> {
  return invoke('search_github_mods', { query });
}

export async function downloadGithubMod(owner: string, repo: string, tag?: string): Promise<ModInfo> {
  return invoke('download_github_mod', { owner, repo, tag });
}

export async function downloadUrlMod(url: string): Promise<ModInfo> {
  return invoke('download_url_mod', { url });
}

export async function listProfiles(): Promise<Profile[]> {
  return invoke('list_profiles_cmd');
}

export async function createProfile(name: string): Promise<Profile> {
  return invoke('create_profile', { name });
}

export async function switchProfile(name: string): Promise<void> {
  return invoke('switch_profile', { name });
}

export async function snapshotProfile(name: string): Promise<Profile> {
  return invoke('snapshot_profile', { name });
}

export async function deleteProfile(name: string): Promise<void> {
  return invoke('delete_profile_cmd', { name });
}

export async function exportProfile(name: string): Promise<string> {
  return invoke('export_profile_cmd', { name });
}

export async function importProfile(json: string): Promise<Profile> {
  return invoke('import_profile_cmd', { json });
}

export async function setNexusApiKey(key: string): Promise<void> {
  return invoke('set_nexus_api_key', { key });
}

export async function installModFromFile(path: string): Promise<ModInfo> {
  return invoke('install_mod_from_file', { path });
}

export async function checkForUpdates(): Promise<ModUpdate[]> {
  return invoke('check_for_updates');
}

export async function updateMod(name: string): Promise<ModInfo> {
  return invoke('update_mod', { name });
}

export async function updateAllMods(): Promise<ModInfo[]> {
  return invoke('update_all_mods');
}

export async function quickAddMod(url: string): Promise<QuickAddResult> {
  return invoke('quick_add_mod', { url });
}

export async function shareProfile(name: string): Promise<ShareResult> {
  return invoke('share_profile', { name });
}

export async function reshareProfile(name: string): Promise<ShareResult> {
  return invoke('reshare_profile', { name });
}

export async function fetchSharedProfile(id: string): Promise<Profile> {
  return invoke('fetch_shared_profile_cmd', { id });
}

export async function installSharedProfile(id: string): Promise<Profile> {
  return invoke('install_shared_profile', { id });
}

// ── Dependency Resolution ──────────────────────────────────────────────────

export async function checkModDependencies(name: string): Promise<string[]> {
  return invoke('check_mod_dependencies', { name });
}

export async function getModDependents(name: string): Promise<string[]> {
  return invoke('get_mod_dependents', { name });
}

// ── Backup & Safety ────────────────────────────────────────────────────────

export async function createBackup(): Promise<string> {
  return invoke('create_backup_cmd');
}

export async function listBackups(): Promise<BackupInfo[]> {
  return invoke('list_backups_cmd');
}

export async function restoreBackup(name: string): Promise<void> {
  return invoke('restore_backup_cmd', { name });
}

export async function resetToVanilla(): Promise<void> {
  return invoke('reset_to_vanilla_cmd');
}
