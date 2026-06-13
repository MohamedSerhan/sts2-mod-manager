import { describe, expect, it } from 'vitest';

import {
  applySubscriptionUpdate,
  auditModVersions,
  autoDetectSources,
  checkForUpdates,
  checkModDependencies,
  checkSubscriptionUpdates,
  createBackup,
  createBackupPreserving,
  createProfile,
  deleteAllMods,
  deleteBackup,
  deleteMod,
  deleteProfile,
  detectGamePath,
  disableAllMods,
  downloadGithubMod,
  downloadUrlMod,
  duplicateProfile,
  enableAllMods,
  exportProfileToFile,
  fetchSharedProfile,
  findGithubFromNexus,
  getApiKeyStatus,
  getGameInfo,
  getInstalledMods,
  getLaunchMode,
  getLogPath,
  getModDependents,
  getModSources,
  getProfileDrift,
  getShareInfo,
  getSubscriptions,
  importSts2pack,
  installModFromFile,
  installSharedProfile,
  isGameRunning,
  launchGame,
  launchVanilla,
  listBackups,
  listProfiles,
  nexusGetLatestAdded,
  nexusGetTrending,
  openGameFolder,
  openLogFile,
  openModsFolder,
  pinMod,
  quickAddMod,
  readLogTail,
  removeModSource,
  repairMod,
  repairModpackSubscription,
  repairProfile,
  resetToVanilla,
  rollbackMod,
  reshareProfile,
  restoreBackup,
  searchGithubMods,
  setGamePath,
  setGithubToken,
  setLaunchMode,
  setModSnooze,
  setModTags,
  setModSource,
  setModSourcesFull,
  setNexusApiKey,
  shareProfile,
  switchProfile,
  toggleMod,
  unpinMod,
  unsubscribe,
  updateAllMods,
  updateMod,
} from './useTauri';
import {
  getInvokeCalls,
  registerInvokeFallback,
  registerInvokeHandler,
} from '../__test__/setup';

/**
 * Every function in useTauri.ts is a thin wrapper around `invoke`.
 * The risk to users isn't that they're complicated — it's that the
 * COMMAND NAME or ARG SHAPE drifts from the Rust side. These tests
 * pin both: each call must invoke the documented command with the
 * documented arg names.
 *
 * If you rename a Tauri command in `lib.rs::invoke_handler!`, this
 * suite catches the JS side immediately.
 */

function lastCall() {
  const calls = getInvokeCalls();
  return calls[calls.length - 1];
}

describe('useTauri wrappers — command names + arg shapes', () => {
  it('game detection / settings commands', async () => {
    registerInvokeFallback(() => true);
    await detectGamePath();
    expect(lastCall()).toEqual({ cmd: 'detect_game_path', args: undefined });

    await setGamePath('/tmp/game');
    expect(lastCall()).toEqual({ cmd: 'set_game_path', args: { path: '/tmp/game' } });

    await getGameInfo();
    expect(lastCall().cmd).toBe('get_game_info');

    await openModsFolder();
    expect(lastCall().cmd).toBe('open_mods_folder');

    await openGameFolder();
    expect(lastCall().cmd).toBe('open_game_folder');

    await launchGame();
    expect(lastCall().cmd).toBe('launch_game');

    await setGithubToken('ghp_xxx');
    expect(lastCall()).toEqual({ cmd: 'set_github_token', args: { token: 'ghp_xxx' } });

    await getApiKeyStatus();
    expect(lastCall().cmd).toBe('get_api_key_status');
  });

  it('launch mode read/write', async () => {
    registerInvokeFallback(() => 'steam');
    await getLaunchMode();
    expect(lastCall().cmd).toBe('get_launch_mode');
    await setLaunchMode('direct');
    expect(lastCall()).toEqual({ cmd: 'set_launch_mode', args: { mode: 'direct' } });
  });

  it('mod management commands carry folderName for disambiguation', async () => {
    registerInvokeFallback(() => null);
    await getInstalledMods();
    expect(lastCall().cmd).toBe('get_installed_mods');

    await toggleMod('CardArtEditor', 'CardArtEditor-v1', false);
    expect(lastCall()).toEqual({
      cmd: 'toggle_mod',
      args: { name: 'CardArtEditor', folderName: 'CardArtEditor-v1', enable: false },
    });

    // Two same-named mods → folder_name is the disambiguator. Make sure
    // it's threaded through.
    await deleteMod('CardArtEditor', 'CardArtEditor-v2');
    expect(lastCall()).toEqual({
      cmd: 'delete_mod_cmd',
      args: { name: 'CardArtEditor', folderName: 'CardArtEditor-v2' },
    });

    await enableAllMods();
    expect(lastCall().cmd).toBe('enable_all_mods');
    await disableAllMods();
    expect(lastCall().cmd).toBe('disable_all_mods');
    await deleteAllMods();
    expect(lastCall().cmd).toBe('delete_all_mods');
    await installModFromFile('/tmp/x.zip');
    expect(lastCall()).toEqual({ cmd: 'install_mod_from_file', args: { path: '/tmp/x.zip' } });
  });

  it('downloads / nexus / search', async () => {
    registerInvokeFallback(() => []);
    await searchGithubMods('autopath');
    expect(lastCall()).toEqual({ cmd: 'search_github_mods', args: { query: 'autopath' } });

    await downloadGithubMod('owner', 'repo');
    expect(lastCall()).toEqual({
      cmd: 'download_github_mod',
      args: { owner: 'owner', repo: 'repo', tag: undefined },
    });
    await downloadGithubMod('owner', 'repo', 'v1.0.0');
    expect(lastCall()).toEqual({
      cmd: 'download_github_mod',
      args: { owner: 'owner', repo: 'repo', tag: 'v1.0.0' },
    });

    await downloadUrlMod('https://example.com/mod.zip');
    expect(lastCall()).toEqual({
      cmd: 'download_url_mod',
      args: { url: 'https://example.com/mod.zip' },
    });

    await setNexusApiKey('nx_xxx');
    expect(lastCall()).toEqual({ cmd: 'set_nexus_api_key', args: { key: 'nx_xxx' } });

    await nexusGetTrending();
    expect(lastCall().cmd).toBe('nexus_get_trending');
    await nexusGetLatestAdded();
    expect(lastCall().cmd).toBe('nexus_get_latest_added');
  });

  it('profile lifecycle', async () => {
    registerInvokeFallback(() => null);
    await listProfiles();
    expect(lastCall().cmd).toBe('list_profiles_cmd');

    await createProfile('My Pack');
    expect(lastCall()).toEqual({ cmd: 'create_profile', args: { name: 'My Pack' } });

    await switchProfile('My Pack');
    expect(lastCall()).toEqual({ cmd: 'switch_profile', args: { name: 'My Pack' } });

    await repairProfile('My Pack');
    expect(lastCall()).toEqual({ cmd: 'repair_profile', args: { name: 'My Pack' } });

    await deleteProfile('Old');
    expect(lastCall()).toEqual({ cmd: 'delete_profile_cmd', args: { name: 'Old' } });

    await duplicateProfile('Source', 'Copy');
    expect(lastCall()).toEqual({
      cmd: 'duplicate_profile',
      args: { name: 'Source', newName: 'Copy' },
    });

    await exportProfileToFile('Source', '/tmp/Source.sts2pack');
    expect(lastCall()).toEqual({
      cmd: 'export_profile_to_file',
      args: { name: 'Source', path: '/tmp/Source.sts2pack' },
    });

    await importSts2pack('/tmp/Source.sts2pack');
    expect(lastCall()).toEqual({
      cmd: 'import_sts2pack',
      args: { path: '/tmp/Source.sts2pack' },
    });

    await getProfileDrift('My Pack');
    expect(lastCall()).toEqual({ cmd: 'get_profile_drift', args: { name: 'My Pack' } });
  });

  it('curator workflow (audit / update / repair)', async () => {
    registerInvokeFallback(() => []);
    await checkForUpdates();
    expect(lastCall().cmd).toBe('check_for_updates');

    await updateMod('BaseLib');
    expect(lastCall()).toEqual({
      cmd: 'update_mod',
      args: { name: 'BaseLib', folderName: null },
    });
    await updateMod('BaseLib', 'BaseLib-v2');
    expect(lastCall()).toEqual({
      cmd: 'update_mod',
      args: { name: 'BaseLib', folderName: 'BaseLib-v2' },
    });

    await repairMod('BaseLib', 'BaseLib-v2');
    expect(lastCall()).toEqual({
      cmd: 'repair_mod',
      args: { name: 'BaseLib', folderName: 'BaseLib-v2' },
    });

    await rollbackMod('BaseLib', 'BaseLib-v2');
    expect(lastCall()).toEqual({
      cmd: 'rollback_mod',
      args: { name: 'BaseLib', folderName: 'BaseLib-v2' },
    });

    await updateAllMods();
    expect(lastCall().cmd).toBe('update_all_mods');

    // The audit command omits the `only` field when no filter is passed,
    // mirroring how the Rust side distinguishes "audit everything" from
    // "audit this list".
    await auditModVersions();
    expect(lastCall()).toEqual({ cmd: 'audit_mod_versions', args: {} });
    await auditModVersions(['BaseLib']);
    expect(lastCall()).toEqual({
      cmd: 'audit_mod_versions',
      args: { only: ['BaseLib'] },
    });

    await quickAddMod('https://github.com/owner/repo');
    expect(lastCall()).toEqual({
      cmd: 'quick_add_mod',
      args: { url: 'https://github.com/owner/repo' },
    });
  });

  it('mod-source linking carries folderName', async () => {
    registerInvokeFallback(() => null);
    await getModSources();
    expect(lastCall().cmd).toBe('get_mod_sources');

    await setModSource('BaseLib', 'github:foo/bar');
    expect(lastCall()).toEqual({
      cmd: 'set_mod_source',
      args: { modName: 'BaseLib', folderName: null, sourceUrl: 'github:foo/bar' },
    });
    await setModSource('BaseLib', 'github:foo/bar', 'BaseLib-folder');
    expect(lastCall().args!.folderName).toBe('BaseLib-folder');

    await setModSourcesFull('BaseLib', 'foo/bar', null, 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'set_mod_sources_full',
      args: {
        modName: 'BaseLib',
        folderName: 'BaseLib-folder',
        githubRepo: 'foo/bar',
        nexusUrl: null,
      },
    });

    await removeModSource('BaseLib', 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'remove_mod_source',
      args: { modName: 'BaseLib', folderName: 'BaseLib-folder' },
    });

    await pinMod('BaseLib', 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'pin_mod',
      args: { modName: 'BaseLib', folderName: 'BaseLib-folder' },
    });
    await unpinMod('BaseLib');
    expect(lastCall()).toEqual({
      cmd: 'unpin_mod',
      args: { modName: 'BaseLib', folderName: null },
    });

    await setModSnooze('BaseLib', 'v3.2.0', 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'set_mod_snooze',
      args: { modName: 'BaseLib', folderName: 'BaseLib-folder', latestTag: 'v3.2.0' },
    });

    await setModTags('BaseLib', ['utility', 'beta'], 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'set_mod_tags',
      args: { modName: 'BaseLib', folderName: 'BaseLib-folder', tags: ['utility', 'beta'] },
    });

    await autoDetectSources();
    expect(lastCall().cmd).toBe('auto_detect_sources');

    await findGithubFromNexus('BaseLib', 'BaseLib-folder');
    expect(lastCall()).toEqual({
      cmd: 'find_github_from_nexus',
      args: { modName: 'BaseLib', folderName: 'BaseLib-folder' },
    });
  });

  it('sharing + subscriptions', async () => {
    registerInvokeFallback(() => null);
    await shareProfile('My Pack', null);
    expect(lastCall()).toEqual({
      cmd: 'share_profile',
      args: { name: 'My Pack', listPublic: null, includeNotes: null },
    });
    await reshareProfile('My Pack', null);
    expect(lastCall().cmd).toBe('reshare_profile');
    await fetchSharedProfile('alice/abcd1234');
    expect(lastCall()).toEqual({
      cmd: 'fetch_shared_profile_cmd',
      args: { code: 'alice/abcd1234' },
    });
    await installSharedProfile('alice/abcd1234');
    expect(lastCall()).toEqual({
      cmd: 'install_shared_profile',
      args: { code: 'alice/abcd1234' },
    });
    await getShareInfo('My Pack');
    expect(lastCall()).toEqual({ cmd: 'get_share_info', args: { name: 'My Pack' } });

    await getSubscriptions();
    expect(lastCall().cmd).toBe('get_subscriptions');
    await unsubscribe('share-id');
    expect(lastCall()).toEqual({ cmd: 'unsubscribe', args: { shareId: 'share-id' } });
    await checkSubscriptionUpdates();
    expect(lastCall().cmd).toBe('check_subscription_updates');
    await applySubscriptionUpdate('share-id');
    expect(lastCall()).toEqual({
      cmd: 'apply_subscription_update',
      args: { shareId: 'share-id' },
    });
    await repairModpackSubscription('share-id');
    expect(lastCall()).toEqual({
      cmd: 'repair_modpack_subscription',
      args: { shareId: 'share-id' },
    });
  });

  it('launch / vanilla / game-running', async () => {
    registerInvokeFallback(() => false);
    await launchVanilla();
    expect(lastCall().cmd).toBe('launch_vanilla');
    await isGameRunning();
    expect(lastCall().cmd).toBe('is_game_running_cmd');
  });

  it('dependencies', async () => {
    registerInvokeFallback(() => []);
    await checkModDependencies('Foo');
    expect(lastCall()).toEqual({ cmd: 'check_mod_dependencies', args: { name: 'Foo' } });
    await getModDependents('Foo');
    expect(lastCall()).toEqual({ cmd: 'get_mod_dependents', args: { name: 'Foo' } });
  });

  it('backups', async () => {
    registerInvokeFallback(() => null);
    await createBackup();
    expect(lastCall().cmd).toBe('create_backup_cmd');
    await createBackupPreserving('backup_2026-05-12_15-00-00');
    expect(lastCall()).toEqual({
      cmd: 'create_backup_preserving_cmd',
      args: { preserveName: 'backup_2026-05-12_15-00-00' },
    });
    await listBackups();
    expect(lastCall().cmd).toBe('list_backups_cmd');
    await restoreBackup('b1');
    expect(lastCall()).toEqual({ cmd: 'restore_backup_cmd', args: { name: 'b1' } });
    await deleteBackup('b1');
    expect(lastCall()).toEqual({ cmd: 'delete_backup_cmd', args: { name: 'b1' } });
    await resetToVanilla();
    expect(lastCall().cmd).toBe('reset_to_vanilla_cmd');
  });

  it('logging helpers', async () => {
    registerInvokeFallback(() => '');
    await getLogPath();
    expect(lastCall().cmd).toBe('get_log_path');
    await openLogFile();
    expect(lastCall().cmd).toBe('open_log_file');
    await readLogTail();
    expect(lastCall()).toEqual({ cmd: 'read_log_tail', args: { lines: 500 } });
    await readLogTail(200);
    expect(lastCall()).toEqual({ cmd: 'read_log_tail', args: { lines: 200 } });
  });

  it('returns whatever the backend handler returns (passthrough)', async () => {
    const fakeMod = { name: 'X', version: '1.0', enabled: true, files: [] };
    registerInvokeHandler('get_installed_mods', () => [fakeMod]);
    const result = await getInstalledMods();
    expect(result).toEqual([fakeMod]);
  });
});
