import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import { useModLibrary } from './useModLibrary';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { AUTO_ADD_INSTALLS_TO_MODPACK_KEY } from '../lib/installPolicy';
import type { ModInfo } from '../types';

/**
 * Direct unit tests for the useModLibrary hook (otherwise only covered
 * transitively via Mods/ModpackDetail). Focus: the import / quick-add guards,
 * the followed-pack "stop before installing" rule, and the Nexus-only update
 * path — all pure decision logic that's easy to regress.
 */
const importCalls = () => getInvokeCalls().filter((c) => c.cmd === 'install_mod_from_file');
const quickAddCalls = () => getInvokeCalls().filter((c) => c.cmd === 'quick_add_mod');
const membershipCalls = () => getInvokeCalls().filter((c) => c.cmd === 'set_profile_mod_membership');
const updateModCalls = () => getInvokeCalls().filter((c) => c.cmd === 'update_mod');

/** Minimal ModInfo shape used by update tests. */
function makeMod(overrides: Partial<ModInfo> = {}): ModInfo {
  return {
    name: 'TestMod',
    version: '1.0.0',
    description: '',
    enabled: true,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    folder_name: 'TestMod',
    mod_id: null,
    pinned: false,
    github_url: null,
    nexus_url: null,
    ...overrides,
  };
}

function followPack(name: string) {
  registerInvokeHandler('get_subscriptions', () => [
    { profile_name: name, source_repo: 'x/y', source_owner: 'x', auto_update: true },
  ]);
}

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
});

describe('useModLibrary', () => {
  it('handleImportFile installs the picked archive (All Mods target)', async () => {
    vi.mocked(open).mockResolvedValueOnce('C:\\downloads\\Cool.zip');
    registerInvokeHandler('install_mod_from_file', () => ({
      name: 'Cool',
      version: '1.0',
      enabled: true,
      folder_name: 'Cool',
      files: [],
    }));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => { await result.current.handleImportFile(); });

    await waitFor(() => expect(importCalls()).toHaveLength(1));
    expect(importCalls()[0].args?.path).toBe('C:\\downloads\\Cool.zip');
  });

  it('handleImportFile installs to the Library by default even with a target pack', async () => {
    vi.mocked(open).mockResolvedValueOnce('C:\\downloads\\Cool.zip');
    registerInvokeHandler('install_mod_from_file', () => makeMod({ name: 'Cool', folder_name: 'Cool' }));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });

    await act(async () => { await result.current.handleImportFile(); });

    await waitFor(() => expect(importCalls()).toHaveLength(1));
    expect(membershipCalls()).toHaveLength(0);
  });

  it('handleImportFile adds the picked archive to the target pack when auto-add is enabled', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    vi.mocked(open).mockResolvedValueOnce('C:\\downloads\\Cool.zip');
    registerInvokeHandler('install_mod_from_file', () => makeMod({ name: 'Cool', folder_name: 'Cool' }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });

    await act(async () => { await result.current.handleImportFile(); });

    await waitFor(() => expect(membershipCalls()).toHaveLength(1));
    expect(membershipCalls()[0].args).toMatchObject({
      profileId: 'MyPack',
      modName: 'Cool',
      folderName: 'Cool',
      included: true,
    });
  });

  it('handleImportFile enables a disabled mod before adding it to the active target pack', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    vi.mocked(open).mockResolvedValueOnce('C:\\downloads\\Cool.zip');
    registerInvokeHandler('get_active_profile_id', () => 'MyPack');
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('install_mod_from_file', () => makeMod({
      name: 'Cool',
      folder_name: 'Cool',
      enabled: false,
    }));
    registerInvokeHandler('toggle_mod', () => ({}));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'get_active_profile')).toBe(true);
    });

    await act(async () => { await result.current.handleImportFile(); });

    const calls = getInvokeCalls();
    const toggleIndex = calls.findIndex((c) => c.cmd === 'toggle_mod');
    const membershipIndex = calls.findIndex((c) => c.cmd === 'set_profile_mod_membership');
    expect(toggleIndex).toBeGreaterThanOrEqual(0);
    expect(membershipIndex).toBeGreaterThan(toggleIndex);
    expect(calls[toggleIndex].args).toMatchObject({
      name: 'Cool',
      folderName: 'Cool',
      enable: true,
    });
  });

  it('handleImportFile installs to the Library only when target-pack auto-add is disabled', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'false');
    followPack('MyPack');
    vi.mocked(open).mockResolvedValueOnce('C:\\downloads\\Cool.zip');
    registerInvokeHandler('install_mod_from_file', () => makeMod({ name: 'Cool', folder_name: 'Cool' }));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });

    await act(async () => { await result.current.handleImportFile(); });

    await waitFor(() => expect(importCalls()).toHaveLength(1));
    expect(membershipCalls()).toHaveLength(0);
  });

  it('handleImportFile does nothing when the picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => { await result.current.handleImportFile(); });

    expect(importCalls()).toHaveLength(0);
  });

  it('handleImportFile refuses (no picker, no install) when auto-add targets a followed pack', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    followPack('MyPack');
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });

    await act(async () => { await result.current.handleImportFile(); });

    // It stops BEFORE opening the file dialog — nothing is half-installed.
    expect(open).not.toHaveBeenCalled();
    expect(importCalls()).toHaveLength(0);
  });

  it('handleQuickAdd ignores an empty/whitespace URL', async () => {
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });
    act(() => result.current.setQuickAddUrl('   '));

    await act(async () => { await result.current.handleQuickAdd(); });

    expect(quickAddCalls()).toHaveLength(0);
  });

  it('handleQuickAdd refuses when auto-add targets a followed pack', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    followPack('MyPack');
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    expect(quickAddCalls()).toHaveLength(0);
  });

  it('handleQuickAdd PROCEEDS when the subscribed target pack is owned (has a .share)', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    // Regression: publishing a pack auto-subscribes you to your own code, so a
    // subscription alone must not block adding to it. Ownership (getShareInfo
    // non-null) overrides the followed-pack guard.
    followPack('MyPack');
    registerInvokeHandler('get_share_info', () => ({
      code: 'AA5A-315D-61AE',
      owner: 'me',
      file_path: 'MyPack.json',
      url: 'https://github.com/me/sts2mm-profiles',
      repo_url: 'https://github.com/me/sts2mm-profiles',
      failed_uploads: [],
    }));
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: { name: 'Cool', version: '1.0', enabled: true, folder_name: 'Cool', files: [] },
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    // Owned → not blocked → the install actually runs.
    await waitFor(() => expect(quickAddCalls()).toHaveLength(1));
  });

  it('handleQuickAdd installs to the Library by default even with a target pack', async () => {
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: makeMod({ name: 'Cool', folder_name: 'Cool' }),
    }));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    await waitFor(() => expect(quickAddCalls()).toHaveLength(1));
    expect(membershipCalls()).toHaveLength(0);
  });

  it('handleQuickAdd adds to the target pack when auto-add is enabled', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: makeMod({ name: 'Cool', folder_name: 'Cool' }),
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    await waitFor(() => expect(membershipCalls()).toHaveLength(1));
    expect(membershipCalls()[0].args).toMatchObject({
      profileId: 'MyPack',
      modName: 'Cool',
      folderName: 'Cool',
      included: true,
    });
  });

  it('toggling the quick-add form is reflected in returned state', () => {
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });
    expect(result.current.showQuickAdd).toBe(false);
    act(() => result.current.setShowQuickAdd(true));
    expect(result.current.showQuickAdd).toBe(true);
  });

  it('handleInlineUpdate on a Nexus-only mod opens Nexus page and does NOT call update_mod', async () => {
    const nexusMod = makeMod({
      name: 'AliceDefectSkin',
      folder_name: 'AliceDefectSkin V2.0',
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
      github_url: null,
    });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(nexusMod);
    });

    // Must have opened the Nexus URL in the browser.
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://www.nexusmods.com/slaythespire2/mods/42');
    });
    // Must NOT have triggered a GitHub-based update.
    expect(updateModCalls()).toHaveLength(0);
  });

  it('handleInlineUpdate on an unlinked local mod shows a no-GitHub-source error', async () => {
    const localMod = makeMod({
      name: 'LocalOnly',
      display_name: 'Local Only',
      github_url: null,
      nexus_url: null,
    });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(localMod);
    });

    expect(updateModCalls()).toHaveLength(0);
    expect(await screen.findByText(/Update failed for 'Local Only'.*has no GitHub source linked/i)).toBeInTheDocument();
  });

  it('handleInlineUpdate promotes auto-detected GitHub plus Nexus before using the GitHub update path', async () => {
    const nexusMod = makeMod({
      name: 'Route Planner',
      folder_name: 'route_planner',
      github_url: 'auto/guess',
      github_auto_detected: true,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    });
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: 'auto/guess',
      github_auto_detected: false,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    }));
    registerInvokeHandler('update_mod', () => makeMod({
      name: 'Route Planner',
      folder_name: 'route_planner',
      version: '2.0.0',
      github_url: 'auto/guess',
      github_auto_detected: false,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    }));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(nexusMod);
    });

    expect(openUrl).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_mod_sources_full',
        args: {
          modName: 'Route Planner',
          folderName: 'route_planner',
          githubRepo: 'auto/guess',
          nexusUrl: 'https://www.nexusmods.com/slaythespire2/mods/1260',
        },
      });
    });
    expect(updateModCalls()).toHaveLength(1);
  });

  it('handleInlineUpdate on a GitHub-linked mod calls update_mod and not openUrl', async () => {
    const githubMod = makeMod({
      name: 'RelicsReminder',
      folder_name: 'RelicsReminder',
      github_url: 'https://github.com/some/relics-reminder',
      nexus_url: null,
    });
    registerInvokeHandler('update_mod', () => ({
      name: 'RelicsReminder',
      version: '2.0.0',
      description: '',
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
      folder_name: 'RelicsReminder',
      mod_id: null,
      pinned: false,
      github_url: 'https://github.com/some/relics-reminder',
      nexus_url: null,
    }));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(githubMod);
    });

    await waitFor(() => expect(updateModCalls()).toHaveLength(1));
    expect(updateModCalls()[0].args?.name).toBe('RelicsReminder');
    // Must NOT have opened any URL in the browser for the GitHub path.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('handleInlineUpdate opens Nexus files as a fallback when GitHub update fails', async () => {
    const bothSourceMod = makeMod({
      name: 'Route Planner',
      folder_name: 'route_planner',
      github_url: 'https://github.com/llzcx/STS2-RoutePlanner',
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    });
    registerInvokeHandler('update_mod', () => {
      throw new Error('GitHub release asset is broken');
    });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(bothSourceMod);
    });

    expect(updateModCalls()).toHaveLength(1);
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://www.nexusmods.com/slaythespire2/mods/1260?tab=files');
    });
  });

  it('handleInlineUpdate reports when the Nexus fallback cannot open after a GitHub update failure', async () => {
    const bothSourceMod = makeMod({
      name: 'Route Planner',
      folder_name: 'route_planner',
      github_url: 'https://github.com/llzcx/STS2-RoutePlanner',
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    });
    registerInvokeHandler('update_mod', () => {
      throw new Error('GitHub release asset is broken');
    });
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('browser blocked'));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(bothSourceMod);
    });

    expect(updateModCalls()).toHaveLength(1);
    expect(await screen.findByText(/browser blocked/i)).toBeInTheDocument();
  });

  it('suppresses duplicate inline update calls before React state catches up', async () => {
    const githubMod = makeMod({
      name: 'RelicsReminder',
      folder_name: 'RelicsReminder',
      github_url: 'https://github.com/some/relics-reminder',
      nexus_url: null,
    });
    let resolveUpdate!: (value: ModInfo) => void;
    registerInvokeHandler('update_mod', () => new Promise<ModInfo>((resolve) => {
      resolveUpdate = resolve;
    }));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.tableActionProps.onUpdate(githubMod);
      second = result.current.tableActionProps.onUpdate(githubMod);
    });
    expect(updateModCalls()).toHaveLength(1);

    await act(async () => {
      resolveUpdate(makeMod({
        name: 'RelicsReminder',
        version: '2.0.0',
        folder_name: 'RelicsReminder',
        github_url: 'https://github.com/some/relics-reminder',
      }));
      await Promise.all([first, second]);
    });
    expect(updateModCalls()).toHaveLength(1);
  });

  it('handleInlineUpdate downloads a targeted modpack update without changing the manifest', async () => {
    const githubMod = makeMod({
      name: 'RelicsReminder',
      folder_name: 'RelicsReminder',
      github_url: 'https://github.com/some/relics-reminder',
      nexus_url: null,
    });
    registerInvokeHandler('update_mod', () => makeMod({
      name: 'RelicsReminder',
      version: '2.0.0',
      folder_name: 'RelicsReminder',
      mod_id: 'relics-reminder',
      github_url: 'https://github.com/some/relics-reminder',
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(githubMod);
    });

    await waitFor(() => expect(updateModCalls()).toHaveLength(1));
    expect(membershipCalls()).toHaveLength(0);
    expect(onTargetPackChanged).not.toHaveBeenCalled();
  });

  it('bulk GitHub updates download versions without changing the target pack manifest', async () => {
    registerInvokeHandler('update_all_mods', () => [
      makeMod({
        name: 'PackMod',
        version: '2.0.0',
        folder_name: 'PackMod',
        mod_id: 'pack-mod',
        github_url: 'https://github.com/some/pack-mod',
      }),
      makeMod({
        name: 'LibraryOnly',
        version: '2.0.0',
        folder_name: 'LibraryOnly',
        mod_id: 'library-only',
        github_url: 'https://github.com/some/library-only',
      }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => []);
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });
    const user = userEvent.setup();

    let updatePromise: Promise<unknown> | null = null;
    act(() => {
      updatePromise = result.current.updateAllGithub(['PackMod']);
    });
    await user.click(await screen.findByRole('button', { name: /^Download 1 update$/ }));
    await updatePromise;

    expect(membershipCalls()).toHaveLength(0);
    expect(onTargetPackChanged).not.toHaveBeenCalled();
  });

  it('does not sync updated mods into a followed target pack', async () => {
    const githubMod = makeMod({
      name: 'FriendPackMod',
      folder_name: 'FriendPackMod',
      github_url: 'https://github.com/some/friend-pack-mod',
      nexus_url: null,
    });
    registerInvokeHandler('get_subscriptions', () => [
      {
        profile_id: 'profile-123',
        profile_name: 'Friend Pack',
        source_repo: 'friend/packs',
        source_owner: 'friend',
        auto_update: true,
      },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('update_mod', () => makeMod({
      name: 'FriendPackMod',
      version: '2.0.0',
      folder_name: 'FriendPackMod',
      github_url: 'https://github.com/some/friend-pack-mod',
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(githubMod);
    });

    expect(updateModCalls()).toHaveLength(1);
    expect(membershipCalls()).toHaveLength(0);
    expect(onTargetPackChanged).not.toHaveBeenCalled();
  });

  it('still avoids manifest sync when subscription lookup fails during update download', async () => {
    const githubMod = makeMod({
      name: 'LocalPackMod',
      folder_name: 'LocalPackMod',
      github_url: 'https://github.com/some/local-pack-mod',
      nexus_url: null,
    });
    registerInvokeHandler('get_subscriptions', () => {
      throw new Error('offline');
    });
    registerInvokeHandler('update_mod', () => makeMod({
      name: 'LocalPackMod',
      version: '2.0.0',
      folder_name: 'LocalPackMod',
      github_url: 'https://github.com/some/local-pack-mod',
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onUpdate(githubMod);
    });

    expect(membershipCalls()).toHaveLength(0);
    expect(onTargetPackChanged).not.toHaveBeenCalled();
  });

  it('repair syncs the refreshed mod into a targeted modpack manifest', async () => {
    const githubMod = makeMod({
      name: 'PackMod',
      folder_name: 'PackMod',
      github_url: 'https://github.com/some/pack-mod',
      nexus_url: null,
    });
    registerInvokeHandler('repair_mod', () => makeMod({
      name: 'PackMod',
      version: '2.0.0',
      folder_name: 'PackMod',
      mod_id: 'pack-mod',
      github_url: 'https://github.com/some/pack-mod',
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });
    const user = userEvent.setup();

    let repairPromise: Promise<void> | null = null;
    act(() => {
      repairPromise = result.current.tableActionProps.onRepair(githubMod);
    });
    await user.click(await screen.findByRole('button', { name: /^Repair now$/i }));
    await repairPromise;

    expect(membershipCalls()).toHaveLength(1);
    expect(membershipCalls()[0].args).toMatchObject({
      profileId: 'profile-123',
      modName: 'PackMod',
      modId: 'pack-mod',
      included: true,
    });
    expect(onTargetPackChanged).toHaveBeenCalledTimes(1);
  });

  it('delete removes the mod from a targeted modpack manifest after deleting from disk', async () => {
    const githubMod = makeMod({
      name: 'PackMod',
      folder_name: 'PackMod',
      github_url: 'https://github.com/some/pack-mod',
    });
    registerInvokeHandler('delete_mod_cmd', () => ({}));
    registerInvokeHandler('set_profile_mod_membership', () => ({}));
    const onTargetPackChanged = vi.fn();
    const { result } = renderHook(() => useModLibrary({
      targetPack: 'profile-123',
      onTargetPackChanged,
    }), { wrapper: AllProviders });
    const user = userEvent.setup();

    let deletePromise: Promise<void> | null = null;
    act(() => {
      deletePromise = result.current.tableActionProps.onDelete(githubMod);
    });
    await user.click(await screen.findByRole('button', { name: /^Delete$/i }));
    await deletePromise;

    expect(getInvokeCalls().some((c) => c.cmd === 'delete_mod_cmd')).toBe(true);
    expect(membershipCalls()).toHaveLength(1);
    expect(membershipCalls()[0].args).toMatchObject({
      profileId: 'profile-123',
      modName: 'PackMod',
      folderName: 'PackMod',
      included: false,
    });
    expect(onTargetPackChanged).toHaveBeenCalledTimes(1);
  });
});

/** Minimal ModInfo for autoDetectSource tests. */
function makeModInfo(overrides: Partial<ModInfo> = {}): ModInfo {
  return {
    name: 'TestMod',
    version: '1.0.0',
    description: '',
    enabled: true,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    folder_name: 'TestMod',
    mod_id: null,
    pinned: false,
    github_url: null,
    nexus_url: null,
    tags: [],
    display_name: null,
    display_description: null,
    ...overrides,
  };
}

describe('useModLibrary — handleAutoDetectSource', () => {
  const autoDetectCalls = () => getInvokeCalls().filter((c) => c.cmd === 'auto_detect_sources');

  it('scoped auto-detect: invokes auto_detect_sources with onlyMod = folder_name for a normal mod', async () => {
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: [],
      not_checked: [],
      skipped_already_linked: 0,
    }));
    const mod = makeModInfo({ name: 'CoolMod', folder_name: 'cool-mod-folder' });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      result.current.tableActionProps.onAutoDetectSource(mod);
    });

    // The modal opens. Render it to trigger its useEffect (which fires the invoke).
    render(
      <AllProviders>
        {result.current.renderAutoDetectModal()}
      </AllProviders>,
    );
    await waitFor(() => expect(autoDetectCalls()).toHaveLength(1));
    expect(autoDetectCalls()[0].args).toMatchObject({ onlyMod: 'cool-mod-folder' });
  });

  it('bundle auto-detect: shows the unsupported toast and does NOT invoke auto_detect_sources', async () => {
    const bundleMod = makeModInfo({
      name: 'AlicePack',
      folder_name: 'alice-pack',
      bundle_members: ['AliceCore', 'AliceArt'],
    });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      result.current.tableActionProps.onAutoDetectSource(bundleMod);
    });

    // Must never have triggered the scan.
    expect(autoDetectCalls()).toHaveLength(0);
  });
});

describe('useModLibrary — handleOpenThisModFolder', () => {
  const openFolderCalls = () => getInvokeCalls().filter((c) => c.cmd === 'open_mod_folder');

  it('opens the mod folder via open_mod_folder using folder_name', async () => {
    registerInvokeHandler('open_mod_folder', () => true);
    const mod = makeModInfo({ name: 'CoolMod', folder_name: 'cool-mod-folder' });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onOpenThisModFolder(mod);
    });

    await waitFor(() => expect(openFolderCalls()).toHaveLength(1));
    expect(openFolderCalls()[0].args?.folderName).toBe('cool-mod-folder');
  });

  it('surfaces an error toast when open_mod_folder rejects', async () => {
    // Drives the catch branch: the backend command throws, so the handler
    // must toast the error message rather than swallow it.
    registerInvokeHandler('open_mod_folder', () => {
      throw new Error('folder is gone');
    });
    const mod = makeModInfo({ name: 'CoolMod', folder_name: 'cool-mod-folder' });
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.tableActionProps.onOpenThisModFolder(mod);
    });

    // The error message (raw, not an i18n key) is shown in a toast.
    expect(await screen.findByText('folder is gone')).toBeInTheDocument();
  });
});

describe('useModLibrary — renderAutoDetectModal callbacks', () => {
  const autoDetectCalls = () => getInvokeCalls().filter((c) => c.cmd === 'auto_detect_sources');
  const auditCalls = () => getInvokeCalls().filter((c) => c.cmd === 'audit_mod_versions');
  const setSourceCalls = () => getInvokeCalls().filter((c) => c.cmd === 'set_mod_source');

  /** A scan result with exactly one high-confidence match so the modal's
   *  "Apply 1 match" button renders and handleApply can run. */
  function oneHighMatchResult() {
    return {
      matched: [{ mod_name: 'CoolMod', github_repo: 'owner/cool', confidence: 'high' }],
      unmatched: [],
      not_checked: [],
      skipped_already_linked: 0,
    };
  }

  it('onClose (Cancel) closes the modal and clears the focused mod', async () => {
    registerInvokeHandler('auto_detect_sources', () => oneHighMatchResult());
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    // Open the modal (renderAutoDetectModal is gated on showAutoDetect).
    act(() => result.current.setShowAutoDetect(true));
    render(
      <AllProviders>{result.current.renderAutoDetectModal()}</AllProviders>,
    );
    // Wait for the scan to finish so the footer (with Cancel) is rendered.
    await screen.findByText('Cancel');

    fireEvent.click(screen.getByText('Cancel'));

    // onClose flipped showAutoDetect back off.
    await waitFor(() => expect(result.current.showAutoDetect).toBe(false));
  });

  it('onApplied refreshes mods but does NOT re-audit when no audit has run (auditResults null)', async () => {
    registerInvokeHandler('auto_detect_sources', () => oneHighMatchResult());
    registerInvokeHandler('set_mod_source', () => ({ github: 'owner/cool', nexus: null }));
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    // No handleCheckUpdates() call → auditResults stays null.
    act(() => result.current.setShowAutoDetect(true));
    render(
      <AllProviders>{result.current.renderAutoDetectModal()}</AllProviders>,
    );

    // Apply the single high-confidence match.
    const applyBtn = await screen.findByText('Apply 1 match');
    await act(async () => {
      fireEvent.click(applyBtn);
    });

    // handleApply wrote the source, then onApplied() ran refreshMods().
    await waitFor(() => expect(setSourceCalls()).toHaveLength(1));
    // auditResults was null → the `if (auditResults) runAudit()` branch is
    // skipped, so NO audit ran as a side effect of applying.
    expect(auditCalls()).toHaveLength(0);
    // Sanity: the scan itself did fire.
    expect(autoDetectCalls()).toHaveLength(1);
  });

  it('onApplied re-audits when a prior audit populated auditResults', async () => {
    registerInvokeHandler('auto_detect_sources', () => oneHighMatchResult());
    registerInvokeHandler('set_mod_source', () => ({ github: 'owner/cool', nexus: null }));
    // A non-empty audit result so auditResults becomes non-null (truthy).
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'CoolMod',
        folder_name: 'cool-mod-folder',
        current_version: '1.0.0',
        latest_release_with_assets_tag: 'v1.1.0',
        update_available: true,
      },
    ]);
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    // Populate auditResults FIRST so the modal's onApplied closure sees it
    // as non-null when it runs.
    await act(async () => {
      await result.current.handleCheckUpdates();
    });
    await waitFor(() => expect(result.current.auditResults).not.toBeNull());
    expect(auditCalls()).toHaveLength(1);

    act(() => result.current.setShowAutoDetect(true));
    render(
      <AllProviders>{result.current.renderAutoDetectModal()}</AllProviders>,
    );

    const applyBtn = await screen.findByText('Apply 1 match');
    await act(async () => {
      fireEvent.click(applyBtn);
    });

    await waitFor(() => expect(setSourceCalls()).toHaveLength(1));
    // onApplied saw a non-null auditResults → ran runAudit() again, so a
    // SECOND audit_mod_versions call lands.
    await waitFor(() => expect(auditCalls()).toHaveLength(2));
  });
});

// ── handleCopyVersion clipboard helper (mirrors DiagnosticBundle / useClipboard pattern) ──
//
// jsdom 27 gotcha: when jsdom exposes a real Clipboard prototype a
// defineProperty on `navigator.clipboard` itself is shadowed by the proto
// getter.  Install on the proto when present; fall back to defining
// `navigator.clipboard` directly.  Called in beforeEach so the spy is fresh
// for every test and the patch is properly overwritten between tests.

let copyVersionSpy: ReturnType<typeof vi.fn>;

function setCopyVersionClipboard(impl: (text: string) => Promise<void> = async () => {}) {
  copyVersionSpy = vi.fn(impl);
  const proto = navigator.clipboard ? Object.getPrototypeOf(navigator.clipboard) : null;
  if (proto && 'writeText' in proto) {
    Object.defineProperty(proto, 'writeText', {
      value: copyVersionSpy,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copyVersionSpy },
      configurable: true,
    });
  }
  return copyVersionSpy;
}

describe('useModLibrary — handleCopyVersion', () => {
  beforeEach(() => {
    setCopyVersionClipboard();
  });

  it('handleCopyVersion copies the raw version but shows a single-v toast', async () => {
    const writeText = setCopyVersionClipboard();

    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });
    await act(async () => {
      await result.current.tableActionProps.onCopyVersion(makeMod({ version: 'v1.0.0' }) as Parameters<typeof result.current.tableActionProps.onCopyVersion>[0]);
    });

    expect(writeText).toHaveBeenCalledWith('v1.0.0'); // clipboard unchanged: raw version
    await waitFor(() => expect(screen.getByText('Copied v1.0.0')).toBeInTheDocument());
  });
});
