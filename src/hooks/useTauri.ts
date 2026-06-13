import { invoke } from '@tauri-apps/api/core';
import type { ModInfo, Profile, ProfileMembershipGrid, ProfileLoadOrderUpdate, ProfileModOrderKey, GameInfo, GitHubRepo, ModUpdate, QuickAddResult, ShareResult, BackupInfo, ModSourceEntry, AutoDetectResult, Subscription, SubscriptionUpdate, SwitchProfileResult, RepairProfileResult, SetProfileModsEnabledResult, ModAuditEntry, NexusModInfo, BrowserPage } from '../types';

// ── Game Detection & QOL ───────────────────────────────────────────────────

export async function detectGamePath(): Promise<GameInfo> {
  return invoke('detect_game_path');
}

export async function setGamePath(path: string): Promise<GameInfo> {
  return invoke('set_game_path', { path });
}

export async function getGameInfo(): Promise<GameInfo> {
  return invoke('get_game_info');
}

export async function openModsFolder(): Promise<boolean> {
  return invoke('open_mods_folder');
}

/** Open a single mod's folder in the OS file explorer (Bug 6). Resolves
 *  against the active then disabled mods folders backend-side. */
export async function openModFolder(folderName: string): Promise<boolean> {
  return invoke('open_mod_folder', { folderName });
}

export async function openGameFolder(): Promise<boolean> {
  return invoke('open_game_folder');
}

export async function openExternalUrl(url: string): Promise<boolean> {
  return invoke('open_external_url', { url });
}

export async function launchGame(): Promise<boolean> {
  return invoke('launch_game');
}

export async function setGithubToken(token: string): Promise<boolean> {
  return invoke('set_github_token', { token });
}

export async function getApiKeyStatus(): Promise<{ nexus_api_key_set: boolean; github_token_set: boolean }> {
  return invoke('get_api_key_status');
}

// ── Launch Mode ────────────────────────────────────────────────────────────

/**
 * How the Launch button and `Ctrl/⌘ L` start STS2.
 *
 * - `steam`: go through `steam://rungameid/2868840`. Required for cloud
 *   saves, achievements, and Proton on Linux. Default.
 * - `direct`: invoke the game executable directly. Useful for Family
 *   Sharing borrowers, offline play, and non-Steam copies. Not supported
 *   for Proton-only installs on Linux.
 */
export type LaunchMode = 'steam' | 'direct';

export async function getLaunchMode(): Promise<LaunchMode> {
  return invoke('get_launch_mode');
}

export async function setLaunchMode(mode: LaunchMode): Promise<LaunchMode> {
  return invoke('set_launch_mode', { mode });
}

// ── Nexus Download Folder ──────────────────────────────────────────────────

/** Return the user-configured Nexus download watch folder, or null for the OS default. */
export async function getNexusDownloadDir(): Promise<string | null> {
  return invoke('get_nexus_download_dir');
}

/**
 * Set the folder the downloads watcher monitors for Nexus mod archives.
 * Pass an empty string to reset to the OS default Downloads folder.
 * The change takes effect after restarting the app.
 */
export async function setNexusDownloadDir(path: string): Promise<string | null> {
  return invoke('set_nexus_download_dir', { path });
}

// ── Mod Management ─────────────────────────────────────────────────────────

export async function getInstalledMods(): Promise<ModInfo[]> {
  return invoke('get_installed_mods');
}

/**
 * Toggle a mod's enabled state.
 *
 * `folderName` is the preferred disambiguator — two mods can share a
 * display name but never share an on-disk folder. Pass `mod.folder_name`
 * so the backend acts on the exact mod the user clicked, not whichever
 * one happens to scan first when names collide.
 */
export async function toggleMod(name: string, folderName: string | null, enable: boolean): Promise<void> {
  return invoke('toggle_mod', { name, folderName, enable });
}

/**
 * Permanently delete a mod from disk.
 *
 * Pass `folderName` (from `mod.folder_name`) so the backend can target
 * the exact folder when two mods share a display name.
 */
export async function deleteMod(name: string, folderName: string | null): Promise<void> {
  return invoke('delete_mod_cmd', { name, folderName });
}

export async function enableAllMods(): Promise<boolean> {
  return invoke('enable_all_mods');
}

export async function disableAllMods(): Promise<boolean> {
  return invoke('disable_all_mods');
}

export async function deleteAllMods(): Promise<number> {
  return invoke('delete_all_mods');
}

export async function installModFromFile(path: string): Promise<ModInfo> {
  return invoke('install_mod_from_file', { path });
}

// ── Downloads ──────────────────────────────────────────────────────────────

export async function searchGithubMods(query: string): Promise<GitHubRepo[]> {
  return invoke('search_github_mods', { query });
}

export async function downloadGithubMod(owner: string, repo: string, tag?: string): Promise<ModInfo> {
  return invoke('download_github_mod', { owner, repo, tag });
}

export async function downloadUrlMod(url: string): Promise<ModInfo> {
  return invoke('download_url_mod', { url });
}

// ── Nexus Mods ─────────────────────────────────────────────────────────────

export async function setNexusApiKey(key: string): Promise<void> {
  return invoke('set_nexus_api_key', { key });
}

export async function nexusGetTrending(): Promise<NexusModInfo[]> {
  return invoke('nexus_get_trending');
}

export async function nexusGetLatestAdded(): Promise<NexusModInfo[]> {
  return invoke('nexus_get_latest_added');
}

// ── Profiles ───────────────────────────────────────────────────────────────

export async function listProfiles(): Promise<Profile[]> {
  return invoke('list_profiles_cmd');
}

export async function getActiveProfileId(): Promise<string | null> {
  return invoke('get_active_profile_id');
}

export async function createProfile(name: string): Promise<Profile> {
  return invoke('create_profile', { name });
}

export async function switchProfile(name: string): Promise<SwitchProfileResult> {
  return invoke('switch_profile', { name });
}

/** Repair a profile: re-apply the manifest, restore missing/profile-drifted
 *  mods, and move active extras into `mods_disabled`. Disabled library mods
 *  are preserved and are not treated as garbage. */
export async function repairProfile(name: string): Promise<RepairProfileResult> {
  return invoke('repair_profile', { name });
}

export async function deleteProfile(name: string): Promise<void> {
  return invoke('delete_profile_cmd', { name });
}

export async function duplicateProfile(name: string, newName: string): Promise<Profile> {
  return invoke('duplicate_profile', { name, newName });
}

export async function renameProfile(oldName: string, newName: string): Promise<Profile> {
  return invoke('rename_profile', { oldName, newName });
}

export async function exportProfileToFile(name: string, path: string): Promise<void> {
  return invoke('export_profile_to_file', { name, path });
}

export async function importSts2pack(path: string): Promise<Profile> {
  return invoke('import_sts2pack', { path });
}

export async function getProfileMemberships(): Promise<ProfileMembershipGrid> {
  return invoke('get_profile_memberships');
}

export async function setProfileModMembership(
  profileName: string,
  modName: string,
  folderName: string | null,
  modId: string | null,
  included: boolean,
  sourceHint?: string | null,
): Promise<Profile> {
  return invoke('set_profile_mod_membership', {
    profileName,
    modName,
    folderName,
    modId,
    included,
    sourceHint,
  });
}

export async function setProfileLoadOrder(
  profileName: string,
  orderedMods: ProfileModOrderKey[],
): Promise<ProfileLoadOrderUpdate> {
  return invoke('set_profile_load_order', {
    profileName,
    orderedMods: orderedMods.map((mod) => ({
      name: mod.name,
      folderName: mod.folder_name,
      modId: mod.mod_id,
    })),
  });
}

export interface VersionMismatch {
  name: string;
  profile_version: string;
  disk_version: string;
}

export interface ProfileDrift {
  added: string[];
  removed: string[];
  toggled: string[];
  version_changed: VersionMismatch[];
  has_drift: boolean;
}

export async function getProfileDrift(name: string): Promise<ProfileDrift> {
  return invoke('get_profile_drift', { name });
}

/** Save the drift: reconcile the manifest to the current loadout by applying
 *  only the diff (add enabled extras, drop missing mods, sync toggled/version
 *  for present mods). Unlike a full re-snapshot, this preserves the pack's
 *  curated set rather than absorbing the whole install. */
export async function saveProfileDrift(name: string): Promise<Profile> {
  return invoke('save_profile_drift', { name });
}

// ── Curator Workflow ───────────────────────────────────────────────────────

export async function checkForUpdates(): Promise<ModUpdate[]> {
  return invoke('check_for_updates');
}

export async function updateMod(name: string, folderName: string | null = null): Promise<ModInfo> {
  return invoke('update_mod', { name, folderName });
}

/**
 * Force-reinstall a mod from its linked GitHub source. Use when an
 * install is in a broken state (manifest fails to parse, version reads
 * 'unknown', game won't load it, etc.) — same backend pipeline as
 * updateMod, just messaged differently in the UI.
 *
 * Pass `folderName` (from `mod.folder_name`) so two mods sharing a
 * display name can be repaired independently.
 */
export async function repairMod(name: string, folderName: string | null = null): Promise<ModInfo> {
  return invoke('repair_mod', { name, folderName });
}

export async function rollbackMod(name: string, folderName: string | null = null): Promise<ModInfo> {
  return invoke('rollback_mod', { name, folderName });
}

export async function updateAllMods(): Promise<ModInfo[]> {
  return invoke('update_all_mods');
}

/**
 * Audit installed mods.
 *
 * @param only Optional whitelist of mod names. Pass a list to re-audit just
 *   those rows after an update — much faster than a full audit because it
 *   skips per-mod GitHub/Nexus calls for everything else. Pass undefined
 *   (or omit) for a full audit.
 */
export async function auditModVersions(only?: string[]): Promise<ModAuditEntry[]> {
  return invoke('audit_mod_versions', only ? { only } : {});
}

export async function quickAddMod(url: string): Promise<QuickAddResult> {
  return invoke('quick_add_mod', { url });
}

/** Upload a bug report to the maintainer's ingest endpoint and return its
 *  view URL. Requires NO user token. Rejects when the endpoint isn't
 *  configured for this build or the upload fails, so the caller can fall
 *  back to clipboard + a truncated issue. */
export async function uploadBugReport(content: string): Promise<string> {
  return invoke('upload_bug_report', { content });
}

/** Host of the configured bug-report upload endpoint, or null when this build
 *  has none (dev / fork builds → no upload happens, clipboard fallback). */
export async function bugReportEndpointHost(): Promise<string | null> {
  return invoke('bug_report_endpoint_host');
}

// ── Mod Source Linking ─────────────────────────────────────────────────────

export async function getModSources(): Promise<Record<string, ModSourceEntry>> {
  return invoke('get_mod_sources');
}

/**
 * Set / clear a mod's source URL. Pass `folderName` (from `mod.folder_name`)
 * so two mods sharing a display name carry independent source links.
 */
export async function setModSource(
  modName: string,
  sourceUrl: string,
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_source', { modName, folderName, sourceUrl });
}

export async function setModSourcesFull(
  modName: string,
  githubRepo: string | null,
  nexusUrl: string | null,
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_sources_full', { modName, folderName, githubRepo, nexusUrl });
}

export async function removeModSource(
  modName: string,
  folderName: string | null = null,
): Promise<boolean> {
  return invoke('remove_mod_source', { modName, folderName });
}

/**
 * Set / clear a mod's free-form note and "other link" URL — used for mods
 * that don't live on GitHub or Nexus (Patreon, X, Discord, etc.) or just
 * for remembering where you got the file. Empty strings clear. Folder-keyed
 * write so the data sits next to the rest of the mod's source-entry state.
 */
export async function setModExtras(
  modName: string,
  note: string | null,
  customUrl: string | null,
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_extras', { modName, folderName, note, customUrl });
}

export async function setModDisplayOverrides(
  modName: string,
  displayName: string | null,
  displayDescription: string | null,
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_display_overrides', {
    modName,
    folderName,
    displayName,
    displayDescription,
  });
}

/**
 * Snooze update suggestions for this mod at a specific upstream version.
 * GitHub rows use a release tag; Nexus-only rows use the Nexus version.
 * When upstream advances past that value the snooze auto-expires. Pass
 * `null` or an empty string for `latestTag` to clear the snooze. Distinct
 * from pin, which is a hard freeze.
 */
export async function setModSnooze(
  modName: string,
  latestTag: string | null,
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_snooze', { modName, folderName, latestTag });
}

/**
 * Set manager-only tags/categories for a mod. These are display/filtering
 * metadata only; mod identity and profile membership continue to use the
 * manifest name/folder/id.
 */
export async function setModTags(
  modName: string,
  tags: string[],
  folderName: string | null = null,
): Promise<ModSourceEntry> {
  return invoke('set_mod_tags', { modName, folderName, tags });
}

/**
 * Freeze a mod so its enabled/disabled state and version survive modpack
 * applies and update sweeps. Pass `folderName` (from `mod.folder_name`)
 * so two mods with the same display name can be pinned independently.
 * When omitted (legacy callers, e.g. the Settings audit table), the pin
 * is keyed by display name and shared across same-named mods.
 */
export async function pinMod(modName: string, folderName: string | null = null): Promise<boolean> {
  return invoke('pin_mod', { modName, folderName });
}

export async function unpinMod(modName: string, folderName: string | null = null): Promise<boolean> {
  return invoke('unpin_mod', { modName, folderName });
}

export async function autoDetectSources(onlyMod?: string): Promise<AutoDetectResult> {
  return invoke('auto_detect_sources', { onlyMod });
}

export async function findGithubFromNexus(
  modName: string,
  folderName: string | null = null,
): Promise<string | null> {
  return invoke('find_github_from_nexus', { modName, folderName });
}

// ── Sharing ────────────────────────────────────────────────────────────────

export async function shareProfile(
  name: string,
  listPublic: boolean | null,
  includeNotes: boolean | null = null,
): Promise<ShareResult> {
  return invoke('share_profile', { name, listPublic, includeNotes });
}

export async function cancelProfileShare(name: string): Promise<boolean> {
  return invoke('cancel_profile_share', { name });
}

export async function reshareProfile(
  name: string,
  listPublic: boolean | null,
  includeNotes: boolean | null = null,
): Promise<ShareResult> {
  return invoke('reshare_profile', { name, listPublic, includeNotes });
}

export async function fetchSharedProfile(code: string): Promise<Profile> {
  return invoke('fetch_shared_profile_cmd', { code });
}

export async function installSharedProfile(code: string): Promise<Profile> {
  return invoke('install_shared_profile', { code });
}

export async function getShareInfo(name: string): Promise<ShareResult | null> {
  return invoke('get_share_info', { name });
}

export async function fetchModpackBrowserPage(
  page: number,
  forceRefresh: boolean,
): Promise<BrowserPage> {
  return invoke('fetch_modpack_browser_page', { page, forceRefresh });
}

/** Enable or disable every mod in a modpack at once. Resolves each manifest
 *  entry to its real on-disk mod backend-side, so it works even when the
 *  manifest folder name has drifted. */
export async function setProfileModsEnabled(
  name: string,
  enabled: boolean,
): Promise<SetProfileModsEnabledResult> {
  return invoke('set_profile_mods_enabled', { name, enabled });
}

export async function setModpackListing(
  name: string,
  public_: boolean,
): Promise<void> {
  return invoke('set_modpack_listing', { name, public: public_ });
}

export async function launchVanilla(): Promise<boolean> {
  return invoke('launch_vanilla');
}

export async function isGameRunning(): Promise<boolean> {
  return invoke('is_game_running_cmd');
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

export async function createBackupPreserving(preserveName: string): Promise<string> {
  return invoke('create_backup_preserving_cmd', { preserveName });
}

export async function listBackups(): Promise<BackupInfo[]> {
  return invoke('list_backups_cmd');
}

export async function restoreBackup(name: string): Promise<void> {
  return invoke('restore_backup_cmd', { name });
}

export async function deleteBackup(name: string): Promise<void> {
  return invoke('delete_backup_cmd', { name });
}

export async function resetToVanilla(): Promise<void> {
  return invoke('reset_to_vanilla_cmd');
}

/** How many automatic backups the manager keeps (0..=10; 0 = backups off). */
export async function getBackupRetention(): Promise<number> {
  return invoke('get_backup_retention');
}

/**
 * Set how many automatic backups to keep. Validated/clamped to 0..=10
 * server-side; 0 disables automatic backups (existing backups are kept).
 * Returns the value the backend stored.
 */
export async function setBackupRetention(count: number): Promise<number> {
  return invoke('set_backup_retention', { count });
}

// ── Subscriptions (Friend Sync) ────────────────────────────────────────────

export async function getSubscriptions(): Promise<Subscription[]> {
  return invoke('get_subscriptions');
}

export async function unsubscribe(shareId: string): Promise<boolean> {
  return invoke('unsubscribe', { shareId });
}

export async function checkSubscriptionUpdates(): Promise<SubscriptionUpdate[]> {
  return invoke('check_subscription_updates');
}

export async function applySubscriptionUpdate(shareId: string): Promise<Profile> {
  return invoke('apply_subscription_update', { shareId });
}

export async function repairModpackSubscription(shareId: string): Promise<Profile> {
  return invoke('repair_modpack_subscription', { shareId });
}

// ── Logging ────────────────────────────────────────────────────────────────

export async function getLogPath(): Promise<string> {
  return invoke('get_log_path');
}

export async function openLogFile(): Promise<boolean> {
  return invoke('open_log_file');
}

/** Return the last N lines of the in-app log (newest at end). */
export async function readLogTail(lines: number = 500): Promise<string> {
  return invoke('read_log_tail', { lines });
}

// ── Dev builds (dev-build-only Settings panel) ───────────────────────────────

export interface DevBuildAsset { name: string; url: string; platform: string; }
export interface DevBuild {
  pr: number;
  sha: string;
  title: string;
  published_at: string;
  windows_installer_url: string | null;
  manifest_url: string | null;
  assets: DevBuildAsset[];
}

/** List the open PRs that currently have a dev-build prerelease. */
export async function listDevBuilds(): Promise<DevBuild[]> {
  return invoke('list_dev_builds');
}

/** Point the (Dev) slot at the dev build published at `manifestUrl` and
 *  trigger the updater to switch to it. */
export async function switchDevBuild(manifestUrl: string): Promise<void> {
  return invoke('switch_dev_build', { manifestUrl });
}
