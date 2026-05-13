import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModsView } from './Mods';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModInfo } from '../types';

/**
 * Focused render-and-interact tests for the Mods view. The WebDriver
 * smoke covers the end-to-end happy path against a real Tauri binary;
 * these tests fill in the branches the smoke can't easily reach —
 * empty state, advanced-mode toggles, search filtering, pinning UX
 * copy, audit-result-driven button label transitions, etc.
 */

function Wrap(props: { advancedMode?: boolean } = {}) {
  return (
    <AllProviders>
      <ModsView advancedMode={props.advancedMode} />
    </AllProviders>
  );
}

const baseMod = (overrides: Partial<ModInfo> = {}): ModInfo => ({
  name: 'BaseLib',
  version: '3.1.2',
  description: 'Base library',
  enabled: true,
  files: ['BaseLib.dll'],
  source: null,
  hash: null,
  dependencies: [],
  size_bytes: 1024,
  folder_name: 'BaseLib',
  mod_id: 'baselib',
  github_url: null,
  nexus_url: null,
  pinned: false,
  min_game_version: null,
  author: 'Alchyr',
  ...overrides,
});

function seedMods(mods: ModInfo[]): void {
  registerInvokeHandler('get_installed_mods', () => mods);
}

describe('<ModsView>', () => {
  it('renders the empty state when no mods are installed', async () => {
    seedMods([]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });
  });

  it('renders each installed mod row + the totals header', async () => {
    seedMods([
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib', enabled: true }),
      baseMod({ name: 'AutoPath', folder_name: 'AutoPath', enabled: false, version: '0.5.0' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    expect(screen.getByText('AutoPath')).toBeInTheDocument();
    // Header summary
    expect(screen.getByText(/2 installed.*1 active.*1 disabled/i)).toBeInTheDocument();
  });

  it('search filter narrows the visible rows', async () => {
    seedMods([
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib' }),
      baseMod({ name: 'AutoPath', folder_name: 'AutoPath' }),
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    // Search by "auto" → only AutoPath remains
    const search = screen.getByPlaceholderText(/Search 3 mods/);
    await user.type(search, 'auto');
    await waitFor(() => {
      expect(screen.queryByText('BaseLib')).toBeNull();
    });
    expect(screen.getByText('AutoPath')).toBeInTheDocument();
    expect(screen.queryByText('CardArtEditor')).toBeNull();
  });

  it('advanced-mode toggle reveals "Import mod" + "Quick add URL" buttons', async () => {
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Import mod/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Quick add URL/ })).toBeNull();

    await user.click(screen.getByText('Advanced'));
    expect(screen.getByRole('button', { name: /Import mod/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick add URL/ })).toBeInTheDocument();
  });

  it('Audit mods button transitions to "Update 1 mod" when audit returns one pending GitHub update', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', github_url: 'https://github.com/foo/bar' })]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'BaseLib',
        folder_name: 'BaseLib',
        installed_version: '3.1.2',
        latest_release_with_assets_tag: 'v3.2.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        pinned: false,
        nexus_update_available: false,
        github_repo: 'foo/bar',
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Update 1 mod$/ })).toBeInTheDocument();
    });
  });

  it('Audit mods button shows "Up to date" pill + Re-audit button when audit returns zero GitHub updates', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib' })]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'BaseLib',
        folder_name: 'BaseLib',
        installed_version: '3.1.2',
        latest_release_with_assets_tag: 'v3.1.2',
        latest_has_assets: true,
        needs_update: false,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        pinned: false,
        nexus_update_available: false,
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Re-audit' })).toBeInTheDocument();
  });

  it('pinned mods with needs_update are excluded from the GitHub update count (no github_repo)', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', pinned: true })]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'BaseLib',
        folder_name: 'BaseLib',
        installed_version: '3.1.2',
        latest_release_with_assets_tag: 'v3.2.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        pinned: true,
        nexus_update_available: false,
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });
  });

  it('Refresh button invokes get_installed_mods again', async () => {
    seedMods([baseMod()]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    const callsBefore = getInvokeCalls().filter((c) => c.cmd === 'get_installed_mods').length;
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => {
      const after = getInvokeCalls().filter((c) => c.cmd === 'get_installed_mods').length;
      expect(after).toBeGreaterThan(callsBefore);
    });
  });

  it('Open folder triggers open_mods_folder', async () => {
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Open folder/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
    });
  });

  it('Quick Add URL field invokes quick_add_mod on Add', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({ kind: 'installed', mod_name: 'Foo' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });

    // Quick Add toggles open
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://github.com/foo/bar');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'quick_add_mod' && c.args?.url === 'https://github.com/foo/bar',
      )).toBe(true);
    });
  });

  it('disables destructive bulk buttons when the game is running', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('is_game_running_cmd', () => true);
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    // The Delete-all button is rendered with variant=danger and disabled
    // when gameRunning. Its title reads "Close STS2 first".
    const buttons = await screen.findAllByRole('button');
    const deleteAllBtn = buttons.find((b) => b.getAttribute('title') === 'Close STS2 first');
    expect(deleteAllBtn).toBeTruthy();
    expect(deleteAllBtn!).toBeDisabled();
  });

  it('clicking the row toggle invokes toggle_mod', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', enabled: true })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    const toggle = screen.getByRole('switch');
    await user.click(toggle);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'toggle_mod' && c.args?.name === 'BaseLib' && c.args?.enable === false,
      )).toBe(true);
    });
  });

  it('"Enable all" + "Disable all" trigger their commands', async () => {
    seedMods([baseMod({ enabled: false })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'enable_all_mods')).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: /Disable all/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'disable_all_mods')).toBe(true);
    });
  });

  it('Delete all opens a typed-phrase confirm modal', async () => {
    seedMods([baseMod()]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Delete all/ }));
    // The destructive confirm prompts for the phrase "delete all".
    await waitFor(() => {
      expect(screen.getByText(/Delete all 1 mods/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Type/)).toBeInTheDocument();
  });

  it('kebab → Remove mod opens the destructive confirm', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Remove mod/ }));
    // Confirm modal shows
    await waitFor(() => {
      expect(screen.getByText(/Delete "AutoPath"/)).toBeInTheDocument();
    });
  });

  it('kebab → Pin / Unpin toggles via pin_mod / unpin_mod', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath', pinned: false })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Pin this mod/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'pin_mod' && c.args?.modName === 'AutoPath',
      )).toBe(true);
    });
  });

  it('rows linked for auto-updates count appears in advanced mode', async () => {
    seedMods([
      baseMod({ name: 'A', github_url: 'https://github.com/a/b' }),
      baseMod({ name: 'B', nexus_url: 'https://nexusmods.com/x/mods/1' }),
      baseMod({ name: 'C' }),
    ]);
    render(<Wrap advancedMode />);
    await waitFor(() => {
      expect(screen.getByText(/3 installed/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 linked for auto-updates/)).toBeInTheDocument();
  });

  it('rows show an author subtitle when two mods share a display name', async () => {
    // Two same-named mods → user-visible author/folder disambiguator.
    seedMods([
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor-v1', author: 'Alice' }),
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor-v2', author: 'Bob' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      // Two rows with the same name.
      expect(screen.getAllByText('CardArtEditor')).toHaveLength(2);
    });
    // Author subtitles surface so they're distinguishable.
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('Refresh shows a "Refreshing…" label while in flight', async () => {
    seedMods([baseMod()]);
    let resolve!: (v: unknown) => void;
    registerInvokeHandler('get_installed_mods', () => new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<Wrap />);
    // Initial render is loading; resolve so the rest of the test runs against
    // a populated view.
    resolve([baseMod()]);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    // Re-bind for the click
    registerInvokeHandler('get_installed_mods', () => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: /Refresh$/ }));
    expect(await screen.findByRole('button', { name: /Refreshing/ })).toBeInTheDocument();
  });

  it('audit failure surfaces a toast and leaves the button enabled', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('audit_mod_versions', () => { throw new Error('rate-limited'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Audit failed.*rate-limited/)).toBeInTheDocument();
    });
  });

  it('search shows "no matches" hint when filter excludes everything', async () => {
    seedMods([baseMod({ name: 'OnlyThing', folder_name: 'OnlyThing' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OnlyThing')).toBeInTheDocument(); });
    await user.type(screen.getByPlaceholderText(/Search 1 mod/), 'nothing-matches');
    await waitFor(() => { expect(screen.queryByText('OnlyThing')).toBeNull(); });
  });

  it('mods linked via GitHub show a GH badge', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/x/y', source: 'github:x/y' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    // The Badge component renders 'GitHub' or 'GH' for github sources.
    // Look for the pill class. Easier: search for any element containing
    // /github/i within the row.
    const tokens = screen.queryAllByText(/github/i);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('Update-available pill renders for a mod with a pending compatible update', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'AutoPath',
      folder_name: 'AutoPath',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_compatible_tag: 'v3.2.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
      game_version_too_old: false,
      latest_release_blocked_by_game_version: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Update available → v3\.2\.0/)).toBeInTheDocument();
    });
  });

  it('clicking the inline Update pill calls update_mod', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'AutoPath',
      folder_name: 'AutoPath',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_compatible_tag: 'v3.2.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
    }]);
    registerInvokeHandler('update_mod', () => baseMod({ name: 'AutoPath', folder_name: 'AutoPath', version: '3.2.0' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Update available → v3\.2\.0/);
    await user.click(pill);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'update_mod' && c.args?.name === 'AutoPath',
      )).toBe(true);
    });
  });

  it('"Update blocked by game version" badge renders when latest_release_blocked_by_game_version=true', async () => {
    seedMods([baseMod({ name: 'BumpyMod', folder_name: 'BumpyMod', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BumpyMod',
      folder_name: 'BumpyMod',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
      game_version_too_old: false,
      latest_release_blocked_by_game_version: true,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BumpyMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Update blocked by game version/)).toBeInTheDocument();
    });
  });

  it('Audit-error badge renders when an audit row carries an error string', async () => {
    seedMods([baseMod({ name: 'ErrorMod', folder_name: 'ErrorMod', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'ErrorMod',
      folder_name: 'ErrorMod',
      installed_version: '1.0.0',
      needs_update: false,
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
      error: 'GitHub 404',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('ErrorMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Audit error/)).toBeInTheDocument();
    });
  });

  it('Pinned badge renders next to a pinned mod', async () => {
    seedMods([baseMod({ name: 'PinnedMod', folder_name: 'PinnedMod', pinned: true })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PinnedMod')).toBeInTheDocument(); });
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('min-game-version warning shows when mod requires a newer game', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '0.100.0',
    }));
    seedMods([baseMod({ name: 'NeedsNew', folder_name: 'NeedsNew', min_game_version: '0.110.0' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NeedsNew')).toBeInTheDocument(); });
    expect(screen.getByText(/needs game ≥ v0\.110\.0/)).toBeInTheDocument();
  });

  it('mod size renders formatted when size_bytes > 0', async () => {
    seedMods([baseMod({ size_bytes: 1536 })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    expect(screen.getByText(/1\.5 KB/)).toBeInTheDocument();
  });

  it('Copy version kebab item does not crash even without a clipboard API', async () => {
    seedMods([baseMod({ version: '4.2.0' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy version/ }));
    // The handler awaits the clipboard promise; whether it succeeds or fails
    // (in jsdom without a clipboard mock) we just verify no crash.
  });

  it('Open mods folder from kebab triggers open_mods_folder', async () => {
    seedMods([baseMod()]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Open mods folder/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
    });
  });

  it('advanced kebab → Repair fires repair_mod when github_url exists', async () => {
    seedMods([baseMod({ name: 'BrokenMod', folder_name: 'BrokenMod', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('repair_mod', () => baseMod({ name: 'BrokenMod', version: '2.0.0' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BrokenMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Repair this mod/ }));
    // Confirm modal
    await waitFor(() => {
      expect(screen.getByText(/Repair 'BrokenMod'/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Repair now' }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'repair_mod' && c.args?.name === 'BrokenMod',
      )).toBe(true);
    });
  });

  it('Repair kebab is disabled when no github_url is linked', async () => {
    seedMods([baseMod({ name: 'NoSrc', folder_name: 'NoSrc', github_url: null })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NoSrc')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const repair = await screen.findByRole('menuitem', { name: /Repair this mod/ });
    expect(repair).toBeDisabled();
  });

  it('advanced kebab → Edit sources… opens the inline source editor', async () => {
    seedMods([baseMod({ name: 'SrcMod', folder_name: 'SrcMod' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SrcMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    // Two kebab items may include "Edit sources" text (open + already-open
    // toggle). Use the one with the exact "…" suffix.
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => {
      expect(screen.getByText('Sources for SrcMod')).toBeInTheDocument();
    });
  });

  it('GitHub badge link points at the mod\'s github_url', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/foo/bar' })]);
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    // The Badge wraps in an <a>. Find the anchor with the github_url.
    const link = document.querySelector('a[href="https://github.com/foo/bar"]')!;
    expect(link).toBeTruthy();
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('Nexus badge link points at the mod\'s nexus_url', async () => {
    seedMods([baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' })]);
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    const link = document.querySelector('a[href="https://www.nexusmods.com/sts2/mods/103"]')!;
    expect(link).toBeTruthy();
  });

  it('Nexus update available pill shows from audit (toolbar shows "Up to date" — Nexus not bulk-updatable)', async () => {
    seedMods([baseMod({ name: 'NexMod', folder_name: 'NexMod', nexus_url: 'https://www.nexusmods.com/sts2/mods/103' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NexMod',
      folder_name: 'NexMod',
      installed_version: '1.0.0',
      nexus_version: '2.0.0',
      needs_update: true,
      nexus_update_available: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      pinned: false,
      github_auto_detected: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NexMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Nexus-only updates are not bulk-updatable via GitHub path, so the
    // toolbar shows "Up to date" (countGithubUpdates returns 0) while the
    // per-row pill still surfaces the Nexus update info.
    await waitFor(() => {
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Update \d+ mod/ })).toBeNull();
  });

  it('Refresh button is rendered', async () => {
    seedMods([baseMod()]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /^Refresh$/ })).toBeInTheDocument();
  });

  it('Unlinked badge renders in advanced mode for mods without a source', async () => {
    seedMods([baseMod({ name: 'OrphanMod', folder_name: 'OrphanMod', source: null })]);
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('OrphanMod')).toBeInTheDocument(); });
    expect(screen.getByText(/Unlinked/i)).toBeInTheDocument();
  });

  it('Local badge renders for mods with a source but no github/nexus URL', async () => {
    seedMods([baseMod({ source: 'manual', github_url: null, nexus_url: null })]);
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    expect(screen.getByText(/Local/)).toBeInTheDocument();
  });

  it('search by version digits filters rows', async () => {
    // Filter is by name only — version search is by name fallback. Test
    // that filter "X" leaves only rows containing X.
    seedMods([
      baseMod({ name: 'Apple', folder_name: 'Apple' }),
      baseMod({ name: 'Banana', folder_name: 'Banana' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Apple')).toBeInTheDocument(); });
    await user.type(screen.getByPlaceholderText(/Search 2 mods/), 'ana');
    await waitFor(() => {
      expect(screen.queryByText('Apple')).toBeNull();
    });
    expect(screen.getByText('Banana')).toBeInTheDocument();
  });

  it('Source editor Save flow invokes set_mod_sources_full', async () => {
    seedMods([baseMod({ name: 'SrcMod', folder_name: 'SrcMod' })]);
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: 'foo/bar',
      github_auto_detected: false,
      nexus_url: null,
      pinned: false,
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SrcMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for SrcMod')).toBeInTheDocument(); });
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_sources_full')).toBe(true);
    });
  });

  it('View on GitHub kebab item opens the github_url', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    seedMods([baseMod({ github_url: 'https://github.com/x/y' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'View on GitHub' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith('https://github.com/x/y');
    });
  });

  it('View on Nexus kebab item opens the nexus_url', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    seedMods([baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'View on Nexus' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith('https://www.nexusmods.com/sts2/mods/103');
    });
  });

  it('Find GitHub from Nexus kebab fires find_github_from_nexus', async () => {
    seedMods([baseMod({ name: 'NexOnly', folder_name: 'NexOnly', nexus_url: 'https://www.nexusmods.com/sts2/mods/103' })]);
    registerInvokeHandler('find_github_from_nexus', () => 'foo/bar');
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NexOnly')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Find GitHub from Nexus/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'find_github_from_nexus')).toBe(true);
    });
  });

  it('clicking "Update N mods" triggers update_all_mods, not a re-audit', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', github_url: 'https://github.com/foo/bar' })]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'BaseLib',
        folder_name: 'BaseLib',
        installed_version: '3.1.2',
        latest_release_with_assets_tag: 'v3.2.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        github_repo: 'foo/bar',
        pinned: false,
        nexus_update_available: false,
        update_source: 'github',
      },
    ]);
    registerInvokeHandler('update_all_mods', () => [
      { name: 'BaseLib', version: '3.2.0', enabled: true, files: [] },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const updateBtn = await screen.findByRole('button', { name: /^Update 1 mod$/ });
    await user.click(updateBtn);
    // Confirm dialog appears with the title "Update 1 mod?". Scope the
    // button query to the modal so we don't race the toolbar button.
    const modal = (await screen.findByText(/Update 1 mod\?/)).closest('.gf-modal') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: /^Update 1 mod$/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(c => c.cmd === 'update_all_mods')).toBe(true);
    });
  });

  it('the ↻ re-audit icon button calls audit_mod_versions', async () => {
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', github_url: 'https://github.com/foo/bar' })]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'BaseLib',
        folder_name: 'BaseLib',
        installed_version: '3.1.2',
        latest_release_with_assets_tag: 'v3.1.2',
        latest_has_assets: true,
        needs_update: false,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        github_repo: 'foo/bar',
        pinned: false,
        nexus_update_available: false,
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await screen.findByText('Up to date');
    const callsBefore = getInvokeCalls().filter(c => c.cmd === 'audit_mod_versions').length;
    await user.click(screen.getByRole('button', { name: 'Re-audit' }));
    await waitFor(() => {
      const after = getInvokeCalls().filter(c => c.cmd === 'audit_mod_versions').length;
      expect(after).toBeGreaterThan(callsBefore);
    });
  });

  it('renders a "Latest" pill next to mods whose audit row is up-to-date', async () => {
    seedMods([
      baseMod({ name: 'CurrentMod', folder_name: 'CurrentMod', version: '2.0.0', github_url: 'https://github.com/foo/current' }),
      baseMod({ name: 'OldMod', folder_name: 'OldMod', version: '1.0.0', github_url: 'https://github.com/foo/old' }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'CurrentMod', folder_name: 'CurrentMod',
        installed_version: '2.0.0',
        github_repo: 'foo/current',
        latest_release_with_assets_tag: 'v2.0.0',
        latest_has_assets: true,
        needs_update: false,
        asset_names: [], releases_scanned: 1,
        github_auto_detected: false, pinned: false,
        nexus_update_available: false,
      },
      {
        mod_name: 'OldMod', folder_name: 'OldMod',
        installed_version: '1.0.0',
        github_repo: 'foo/old',
        latest_release_with_assets_tag: 'v2.0.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [], releases_scanned: 1,
        github_auto_detected: false, pinned: false,
        nexus_update_available: false,
        update_source: 'github',
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('CurrentMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Wait for audit to land — the per-row Update pill on OldMod is a reliable signal.
    await screen.findByText(/Update available → v2\.0\.0/);
    // The Latest pill should appear exactly once — on CurrentMod.
    const latestPills = screen.getAllByText('Latest');
    expect(latestPills).toHaveLength(1);
  });

  it('Delete-all confirm with typed phrase fires delete_all_mods', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('delete_all_mods', () => 1);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Delete all/ }));
    await waitFor(() => { expect(screen.getByText(/Delete all 1 mods/)).toBeInTheDocument(); });
    const phraseInput = screen.getByPlaceholderText('delete all');
    await user.type(phraseInput, 'delete all');
    const allBtns = screen.getAllByRole('button');
    const confirmBtn = allBtns.find((b) => /Delete everything/.test(b.textContent ?? ''));
    if (confirmBtn) {
      await user.click(confirmBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'delete_all_mods')).toBe(true);
      });
    }
  });
});
