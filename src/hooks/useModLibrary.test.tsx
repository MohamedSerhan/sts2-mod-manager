import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';

import { useModLibrary } from './useModLibrary';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/**
 * Direct unit tests for the useModLibrary hook (otherwise only covered
 * transitively via Mods/ModpackDetail). Focus: the import / quick-add guards
 * and the followed-pack "stop before installing" rule, which are pure decision
 * logic that's easy to regress.
 */
const importCalls = () => getInvokeCalls().filter((c) => c.cmd === 'install_mod_from_file');
const quickAddCalls = () => getInvokeCalls().filter((c) => c.cmd === 'quick_add_mod');

function followPack(name: string) {
  registerInvokeHandler('get_subscriptions', () => [
    { profile_name: name, source_repo: 'x/y', source_owner: 'x', auto_update: true },
  ]);
}

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockResolvedValue(null);
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
});
