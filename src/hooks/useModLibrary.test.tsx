import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import { useModLibrary } from './useModLibrary';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModInfo } from '../types';

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
  version: string;
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

describe('useModLibrary — handleCopyVersion', () => {
  it('handleCopyVersion copies the raw version but shows a single-v toast', async () => {
    // jsdom 27: patch Clipboard.prototype.writeText, not navigator.clipboard.
    const writeText = vi.fn().mockResolvedValue(undefined);
    const proto = (globalThis.Clipboard && globalThis.Clipboard.prototype) as Clipboard | undefined;
    if (proto) {
      Object.defineProperty(proto, 'writeText', { configurable: true, value: writeText });
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    }

    const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });
    await act(async () => {
      await result.current.tableActionProps.onCopyVersion(makeMod({ version: 'v1.0.0' }) as Parameters<typeof result.current.tableActionProps.onCopyVersion>[0]);
    });

    expect(writeText).toHaveBeenCalledWith('v1.0.0'); // clipboard unchanged: raw version
    await waitFor(() => expect(screen.getByText('Copied v1.0.0')).toBeInTheDocument());
  });
});
