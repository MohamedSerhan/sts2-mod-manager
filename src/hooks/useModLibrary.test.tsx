import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import { useModLibrary } from './useModLibrary';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/**
 * Direct unit tests for the useModLibrary hook (otherwise only covered
 * transitively via Mods/ModpackDetail). Focus: the import / quick-add guards,
 * the followed-pack "stop before installing" rule, and the Nexus-only update
 * path — all pure decision logic that's easy to regress.
 */
const importCalls = () => getInvokeCalls().filter((c) => c.cmd === 'install_mod_from_file');
const quickAddCalls = () => getInvokeCalls().filter((c) => c.cmd === 'quick_add_mod');
const updateModCalls = () => getInvokeCalls().filter((c) => c.cmd === 'update_mod');

/** Minimal ModInfo shape used by update tests. */
function makeMod(overrides: Partial<{
  name: string;
  folder_name: string | null;
  github_url: string | null;
  nexus_url: string | null;
}> = {}) {
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

  it('handleImportFile does nothing when the picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });

    await act(async () => { await result.current.handleImportFile(); });

    expect(importCalls()).toHaveLength(0);
  });

  it('handleImportFile refuses (no picker, no install) when the target pack is followed', async () => {
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

  it('handleQuickAdd refuses when the target pack is followed', async () => {
    followPack('MyPack');
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    expect(quickAddCalls()).toHaveLength(0);
  });

  it('handleQuickAdd PROCEEDS when the subscribed target pack is owned (has a .share)', async () => {
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
    const { result } = renderHook(() => useModLibrary({ targetPack: 'MyPack' }), {
      wrapper: AllProviders,
    });
    act(() => result.current.setQuickAddUrl('https://github.com/a/b'));

    await act(async () => { await result.current.handleQuickAdd(); });

    // Owned → not blocked → the install actually runs.
    await waitFor(() => expect(quickAddCalls()).toHaveLength(1));
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
});
