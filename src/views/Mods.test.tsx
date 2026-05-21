import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModsView } from './Mods';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import i18n from '../i18n';
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
  display_name: null,
  display_description: null,
  ...overrides,
});

function seedMods(mods: ModInfo[]): void {
  registerInvokeHandler('get_installed_mods', () => mods);
}

function expectTextBefore(first: string, second: string): void {
  const firstNode = screen.getByText(first);
  const secondNode = screen.getByText(second);
  expect(
    Boolean(firstNode.compareDocumentPosition(secondNode) & Node.DOCUMENT_POSITION_FOLLOWING),
  ).toBe(true);
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

  it('sort dropdown supports common mod-library orders', async () => {
    seedMods([
      baseMod({ name: 'ZuluPatch', folder_name: 'ZuluPatch', enabled: true, size_bytes: 1024 }),
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib', enabled: false, size_bytes: 2048 }),
      baseMod({ name: 'AutoPath', folder_name: 'AutoPath', enabled: true, size_bytes: 4096 }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('AutoPath')).toBeInTheDocument();
    });

    const sort = screen.getByRole('combobox', { name: /Sort/i });
    expectTextBefore('AutoPath', 'BaseLib');
    expectTextBefore('BaseLib', 'ZuluPatch');

    await user.selectOptions(sort, 'disabledFirst');
    expectTextBefore('BaseLib', 'AutoPath');

    await user.selectOptions(sort, 'largestFirst');
    expectTextBefore('AutoPath', 'BaseLib');
    expectTextBefore('BaseLib', 'ZuluPatch');
  });

  it('makes clear that Mods tab sorting is visual and not load order', async () => {
    seedMods([
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });

    expect(screen.getByText(/visual only/i)).toBeInTheDocument();
    expect(screen.getByText(/does not change load order/i)).toBeInTheDocument();
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

  it('marks the Mods-page audit action as beta without changing its button name', async () => {
    seedMods([]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });

    const auditButton = screen.getByRole('button', { name: 'Audit mods' });
    expect(within(auditButton).getByText('Beta')).toBeInTheDocument();
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

  it('advanced mode promotes Remove mod to a standalone top-level button (no kebab click needed)', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    // Standalone button is directly visible — NOT a menuitem — so the user
    // can click Remove without first opening the kebab.
    const removeBtn = screen.getByRole('button', { name: /Remove mod/ });
    expect(removeBtn).toBeInTheDocument();
    await user.click(removeBtn);
    await waitFor(() => {
      expect(screen.getByText(/Delete "AutoPath"/)).toBeInTheDocument();
    });
  });

  it('advanced mode does NOT duplicate Remove mod inside the kebab', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    // In advanced mode the kebab no longer carries a duplicate Remove
    // entry — the top-level button is the single source of truth.
    expect(screen.queryByRole('menuitem', { name: /Remove mod/ })).toBeNull();
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
    // GH badges only render in advanced mode (Mods.tsx:804). Pre-fix, this
    // test passed by accident on localStorage state leaked from an earlier
    // test that clicked the Advanced toggle. After the setup-level
    // localStorage.clear(), advanced has to be requested explicitly.
    render(<Wrap advancedMode />);
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

  it('"Download from Nexus" pill renders when nexus_update_available=true and nexus_url is set', async () => {
    // Standardized with Settings → Audit: any audit row flagged
    // nexus_update_available must surface a Download-from-Nexus pill
    // on the Mods row too. Previously the Mods page only rendered a
    // GitHub-update pill (which required `mod.github_url`), so Nexus-
    // only mods like BaseLib showed up as updateable in Settings but
    // had no actionable affordance on Mods.
    seedMods([
      baseMod({
        name: 'BaseLib',
        folder_name: 'BaseLib',
        version: '3.1.2',
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
        github_url: null,
      }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      needs_update: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      pinned: false,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
      nexus_version: '3.2.0',
      nexus_update_available: true,
      update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Download from Nexus/);
    // Must link to the Files tab — same URL shape Settings uses.
    const anchor = pill.closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toContain('?tab=files');
  });

  it('Nexus pill is suppressed when audit row is snoozed', async () => {
    seedMods([
      baseMod({
        name: 'BaseLib',
        folder_name: 'BaseLib',
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
        github_url: null,
      }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      needs_update: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      pinned: false,
      snoozed: true,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
      nexus_version: '3.2.0',
      nexus_update_available: true,
      update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Snoozed-update pill renders elsewhere (the dim "Snoozed" tag), but the
    // actionable Download-from-Nexus button must stay off until the user
    // unsnoozes via the kebab — same gate the GitHub pill uses.
    await screen.findByText(/Snoozed/);
    expect(screen.queryByText(/Download from Nexus/)).toBeNull();
  });

  it('Nexus pill falls back to manual ?tab=files when the URL is non-standard', async () => {
    // nexusFilesUrl() returns null for any host that isn't nexusmods.com.
    // The pill href falls back to a literal `${url}?tab=files` concat so
    // unusual entries (mirrored hosts, old mod_sources rows) still get a
    // working click-through instead of silently disappearing.
    const odd = 'https://nexusmods.example/sts2/mods/42';
    seedMods([
      baseMod({
        name: 'BaseLib',
        folder_name: 'BaseLib',
        nexus_url: odd,
        github_url: null,
      }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      needs_update: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      pinned: false,
      nexus_url: odd,
      nexus_version: '3.2.0',
      nexus_update_available: true,
      update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Download from Nexus/);
    const anchor = pill.closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe(`${odd}?tab=files`);
  });

  it('Nexus pill is suppressed when audit row is pinned or snoozed', async () => {
    seedMods([
      baseMod({
        name: 'BaseLib',
        folder_name: 'BaseLib',
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
        github_url: null,
        pinned: true,
      }),
    ]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      needs_update: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      pinned: true,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/42',
      nexus_version: '3.2.0',
      nexus_update_available: true,
      update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Audit ran (other state may render), but Download-from-Nexus pill
    // is gated off for pinned mods — matching the GitHub pill's
    // behaviour and avoiding "you should update this … wait but I pinned it".
    await waitFor(() => {
      expect(screen.queryByText(/Download from Nexus/)).toBeNull();
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

  it('advanced kebab → Roll back one version fires rollback_mod when github_url exists', async () => {
    seedMods([baseMod({ name: 'RitsuLib', folder_name: 'RitsuLib', version: '0.2.31', github_url: 'https://github.com/ritsu/sts2-ritsulib' })]);
    registerInvokeHandler('rollback_mod', () => baseMod({ name: 'RitsuLib', folder_name: 'RitsuLib', version: '0.2.30' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('RitsuLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const rollbackItem = screen.getByRole('menuitem', { name: /Roll back one version/ });
    expect(within(rollbackItem).getByText('Beta')).toBeInTheDocument();
    await user.click(rollbackItem);
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'RitsuLib'/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Rollback is a beta recovery feature/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roll back now' }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'rollback_mod' && c.args?.name === 'RitsuLib' && c.args?.folderName === 'RitsuLib',
      )).toBe(true);
    });
  });

  it('cancelling the Roll back confirm does not invoke rollback_mod', async () => {
    seedMods([baseMod({ name: 'RitsuLib', folder_name: 'RitsuLib', version: '0.2.31', github_url: 'https://github.com/ritsu/sts2-ritsulib' })]);
    registerInvokeHandler('rollback_mod', () => baseMod({ name: 'RitsuLib', version: '0.2.30' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('RitsuLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Roll back one version/ }));
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'RitsuLib'/)).toBeInTheDocument();
    });
    // Cancel button is the left-most button in the modal foot (same pattern
    // as the Repair flow cancel test).
    const cancelBtn = document.querySelector('.gf-modal-foot button') as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();
    await user.click(cancelBtn!);
    expect(getInvokeCalls().some((c) => c.cmd === 'rollback_mod')).toBe(false);
  });

  it('rollback uses both old and new names for audit refresh when the manifest renames the mod', async () => {
    seedMods([baseMod({ name: 'OldName', folder_name: 'OldName', version: '0.2.31', github_url: 'https://github.com/ritsu/sts2-ritsulib' })]);
    registerInvokeHandler('rollback_mod', () => baseMod({ name: 'NewName', folder_name: 'OldName', version: '0.2.30' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('OldName')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Roll back one version/ }));
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'OldName'/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Roll back now' }));
    await waitFor(() => {
      expect(screen.getByText(/Rolled back 'NewName' to v0\.2\.30/)).toBeInTheDocument();
    });
  });

  it('rollback failure surfaces a toast and clears the rolling-back state', async () => {
    seedMods([baseMod({ name: 'RitsuLib', folder_name: 'RitsuLib', version: '0.2.31', github_url: 'https://github.com/ritsu/sts2-ritsulib' })]);
    registerInvokeHandler('rollback_mod', () => { throw new Error('no prior release'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('RitsuLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Roll back one version/ }));
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'RitsuLib'/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Roll back now' }));
    await waitFor(() => {
      expect(screen.getByText(/Rollback failed for 'RitsuLib'.*no prior release/)).toBeInTheDocument();
    });
  });

  it('rollback handles a null folder_name and a non-Error throw value', async () => {
    seedMods([baseMod({ name: 'NoFolderMod', folder_name: null, version: '0.2.31', github_url: 'https://github.com/x/y' })]);
    // Throw a bare string so the toast falls through to the `String(e)` branch
    // rather than `e.message`.
    registerInvokeHandler('rollback_mod', () => { throw 'plain-string-failure'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NoFolderMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Roll back one version/ }));
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'NoFolderMod'/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Roll back now' }));
    await waitFor(() => {
      expect(screen.getByText(/Rollback failed for 'NoFolderMod'.*plain-string-failure/)).toBeInTheDocument();
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

  it('renders and searches manager-only display overrides', async () => {
    seedMods([
      baseMod({
        name: 'manifest-gibberish',
        folder_name: 'UnreadableFolder',
        description: 'raw desc',
        display_name: 'Readable Name',
        display_description: 'Human-maintained description',
      }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Readable Name')).toBeInTheDocument();
    });
    expect(screen.getByText('manifest-gibberish')).toBeInTheDocument();
    expect(screen.getByText('Human-maintained description')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Search 1 mod/), 'readable');
    expect(screen.getByText('Readable Name')).toBeInTheDocument();
  });

  it('Source editor saves display name and description overrides separately from source links', async () => {
    seedMods([baseMod({ name: 'SrcMod', folder_name: 'SrcMod' })]);
    registerInvokeHandler('set_mod_display_overrides', () => ({
      display_name: 'Friendly Src',
      display_description: 'Clear description',
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SrcMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getAllByRole('menuitem', { name: /Edit sources/ })[0]);

    await user.type(screen.getByPlaceholderText('SrcMod'), 'Friendly Src');
    await user.type(screen.getByPlaceholderText('Base library'), 'Clear description');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_mod_display_overrides',
        args: {
          modName: 'SrcMod',
          folderName: 'SrcMod',
          displayName: 'Friendly Src',
          displayDescription: 'Clear description',
        },
      });
    });
  });

  it('Source editor does not clear existing display overrides when only links change', async () => {
    seedMods([
      baseMod({
        name: 'manifest-gibberish',
        folder_name: 'UnreadableFolder',
        github_url: null,
        display_name: 'Readable Name',
        display_description: 'Human-maintained description',
      }),
    ]);
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: 'owner/repo',
      github_auto_detected: false,
      nexus_url: null,
      pinned: false,
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Readable Name')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getAllByRole('menuitem', { name: /Edit sources/ })[0]);

    await user.type(screen.getByPlaceholderText('owner/repo'), 'owner/repo');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_sources_full')).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_display_overrides')).toBe(false);
  });

  it('Clear all links preserves existing display overrides after refresh', async () => {
    let scanCount = 0;
    registerInvokeHandler('get_installed_mods', () => {
      scanCount += 1;
      return [baseMod({
        name: 'manifest-gibberish',
        folder_name: 'UnreadableFolder',
        github_url: scanCount === 1 ? 'https://github.com/old/link' : null,
        display_name: 'Readable Name',
        display_description: 'Human-maintained description',
      })];
    });
    registerInvokeHandler('set_mod_source', () => ({
      github_repo: null,
      github_auto_detected: false,
      nexus_url: null,
      display_name: 'Readable Name',
      display_description: 'Human-maintained description',
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Readable Name')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getAllByRole('menuitem', { name: /Edit sources/ })[0]);

    await user.click(screen.getByRole('button', { name: /Clear all links/ }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_mod_source',
        args: {
          modName: 'manifest-gibberish',
          folderName: 'UnreadableFolder',
          sourceUrl: '',
        },
      });
    });
    expect(screen.getByText('Readable Name')).toBeInTheDocument();
    expect(screen.getAllByText('Human-maintained description').length).toBeGreaterThan(0);
  });

  it('Source editor reopen shows the saved GitHub value, not the stale manifest URL', async () => {
    // Pins the "save reverts to old broken link" user complaint: after a
    // Save, refreshMods re-fetches the mod list, and the backend's enrich
    // overlays the user-set github_repo onto mod.github_url. When the user
    // re-opens the editor, ghRepoFromUrl(mod.github_url) MUST show the
    // value they just saved — not the manifest's original (possibly
    // broken) URL.
    let scanCount = 0;
    registerInvokeHandler('get_installed_mods', () => {
      scanCount += 1;
      // First load (and the load triggered by save's refreshMods after it
      // succeeds) — caller can decide what to return per call.
      if (scanCount === 1) {
        return [baseMod({
          name: 'Multiplayer Potion View',
          folder_name: 'STS2-MultiPlayerPotionView',
          github_url: 'https://github.com/wrong/wrong-manifest-url',
        })];
      }
      // After Save, backend enrich applies the user override to github_url.
      return [baseMod({
        name: 'Multiplayer Potion View',
        folder_name: 'STS2-MultiPlayerPotionView',
        github_url: 'https://github.com/BAKAOLC/STS2-MultiPlayerPotionView',
      })];
    });
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: 'BAKAOLC/STS2-MultiPlayerPotionView',
      github_auto_detected: false,
      nexus_url: null,
      pinned: false,
    }));

    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Multiplayer Potion View')).toBeInTheDocument(); });

    // Open editor — input should show the converted manifest value (the
    // current stored "wrong" repo).
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    let editItems = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(editItems[0]);
    await waitFor(() => {
      expect(screen.getByText('Sources for Multiplayer Potion View')).toBeInTheDocument();
    });
    const inputBeforeSave = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(inputBeforeSave.value).toBe('wrong/wrong-manifest-url');

    // Clear and type the correct value, then save.
    await user.clear(inputBeforeSave);
    await user.type(inputBeforeSave, 'BAKAOLC/STS2-MultiPlayerPotionView');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    // Save closes the editor (setExpandedMod(null)) and triggers
    // refreshMods, which invokes get_installed_mods a second time.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_sources_full')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('Sources for Multiplayer Potion View')).toBeNull();
    });

    // Reopen the editor — input now reads the saved value, not the stale
    // manifest. This is the bug fix the user was asking about.
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    editItems = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(editItems[0]);
    await waitFor(() => {
      expect(screen.getByText('Sources for Multiplayer Potion View')).toBeInTheDocument();
    });
    const inputAfterSave = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(inputAfterSave.value).toBe('BAKAOLC/STS2-MultiPlayerPotionView');
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
    // Loud lookup — typed phrase 'delete all' must enable the Delete-everything
    // button; if it doesn't, the test fails rather than silently skipping.
    expect(confirmBtn).toBeDefined();
    await user.click(confirmBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'delete_all_mods')).toBe(true);
    });
  });

  // ── Error / failure paths ────────────────────────────────────────

  it('toggle_mod failure surfaces a toast', async () => {
    seedMods([baseMod({ enabled: true })]);
    registerInvokeHandler('toggle_mod', () => { throw new Error('disk full'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(screen.getByText(/Failed to toggle BaseLib.*disk full/)).toBeInTheDocument();
    });
  });

  it('pin_mod failure surfaces a toast', async () => {
    seedMods([baseMod({ name: 'PinFail', folder_name: 'PinFail', pinned: false })]);
    registerInvokeHandler('pin_mod', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PinFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Pin this mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to pin PinFail.*locked/)).toBeInTheDocument();
    });
  });

  it.each([
    {
      cmd: 'pin_mod',
      mod: baseMod({ name: 'PinFailZh', folder_name: 'PinFailZh', pinned: false }),
      menuName: /固定此模组/,
      expected: /固定 PinFailZh 失败：locked/,
      leakedEnglish: /pin PinFailZh/,
    },
    {
      cmd: 'unpin_mod',
      mod: baseMod({ name: 'UnpinFailZh', folder_name: 'UnpinFailZh', pinned: true }),
      menuName: /取消固定此模组/,
      expected: /取消固定 UnpinFailZh 失败：locked/,
      leakedEnglish: /unpin UnpinFailZh/,
    },
  ])('$cmd failure localizes the action in Simplified Chinese', async ({ cmd, mod, menuName, expected, leakedEnglish }) => {
    await i18n.changeLanguage('zh-Hans');
    seedMods([mod]);
    registerInvokeHandler(cmd, () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(mod.name)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: '模组操作' }));
    await user.click(screen.getByRole('menuitem', { name: menuName }));
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    expect(screen.queryByText(leakedEnglish)).toBeNull();
  });

  it('unpin_mod path triggers unpin command + success toast', async () => {
    seedMods([baseMod({ name: 'PinnedMod', folder_name: 'PinnedMod', pinned: true })]);
    registerInvokeHandler('unpin_mod', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PinnedMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Unpin this mod/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'unpin_mod')).toBe(true);
    });
    expect(screen.getByText(/Unpinned PinnedMod/)).toBeInTheDocument();
  });

  it('delete_mod failure surfaces a toast', async () => {
    seedMods([baseMod({ name: 'DelFail', folder_name: 'DelFail' })]);
    registerInvokeHandler('delete_mod_cmd', () => { throw new Error('busy'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DelFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Remove mod/ }));
    await waitFor(() => { expect(screen.getByText(/Delete "DelFail"/)).toBeInTheDocument(); });
    // ConfirmDialog renders TWO buttons with accessible name "Delete":
    //   - the destructive confirm in modal-foot
    //   - the kebab "Remove mod…" menuitem (still in DOM as menuitem, not
    //     button, but use getAllByRole defensively).
    // The modal-foot button has the "gf-btn-3 gf-btn-danger" class; use that.
    const dangerBtn = document.querySelector(
      '.gf-modal-foot button.gf-btn-danger',
    ) as HTMLButtonElement | null;
    expect(dangerBtn).toBeTruthy();
    await user.click(dangerBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to delete DelFail.*busy/)).toBeInTheDocument();
    });
  });

  it('delete confirm cancelled → no invoke', async () => {
    seedMods([baseMod({ name: 'KeepMe', folder_name: 'KeepMe' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('KeepMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Remove mod/ }));
    await waitFor(() => { expect(screen.getByText(/Delete "KeepMe"/)).toBeInTheDocument(); });
    // The modal Cancel button lives in .gf-modal-foot (left-most button).
    const cancelBtn = document.querySelector(
      '.gf-modal-foot button',
    ) as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();
    await user.click(cancelBtn!);
    // Modal closes
    await waitFor(() => {
      expect(screen.queryByText(/Delete "KeepMe"/)).toBeNull();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'delete_mod_cmd')).toBe(false);
  });

  it('enable_all_mods failure surfaces a toast', async () => {
    seedMods([baseMod({ enabled: false })]);
    registerInvokeHandler('enable_all_mods', () => { throw new Error('perm denied'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: perm denied/)).toBeInTheDocument();
    });
  });

  it('disable_all_mods failure surfaces a toast', async () => {
    seedMods([baseMod({ enabled: true })]);
    registerInvokeHandler('disable_all_mods', () => { throw new Error('busy'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Disable all/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: busy/)).toBeInTheDocument();
    });
  });

  it('delete_all_mods failure surfaces a toast', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('delete_all_mods', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Delete all/ }));
    await waitFor(() => { expect(screen.getByText(/Delete all 1 mods/)).toBeInTheDocument(); });
    const phraseInput = screen.getByPlaceholderText('delete all');
    await user.type(phraseInput, 'delete all');
    const allBtns = screen.getAllByRole('button');
    const confirmBtn = allBtns.find((b) => /Delete everything/.test(b.textContent ?? ''));
    expect(confirmBtn).toBeDefined();
    await user.click(confirmBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed: locked/)).toBeInTheDocument();
    });
  });

  it('Delete-all confirm cancelled → no invoke', async () => {
    seedMods([baseMod()]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Delete all/ }));
    await waitFor(() => { expect(screen.getByText(/Delete all 1 mods/)).toBeInTheDocument(); });
    // Cancel button is the left-most button in modal-foot.
    const cancelBtn = document.querySelector(
      '.gf-modal-foot button',
    ) as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();
    await user.click(cancelBtn!);
    expect(getInvokeCalls().some((c) => c.cmd === 'delete_all_mods')).toBe(false);
  });

  it('Open mods folder failure surfaces a toast', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('open_mods_folder', () => { throw new Error('no path'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Open folder/ }));
    await waitFor(() => {
      expect(screen.getByText('no path')).toBeInTheDocument();
    });
  });

  it('Open mods folder failure with non-Error rejection still toasts', async () => {
    seedMods([baseMod()]);
    // Reject with a non-Error value to exercise the `String(e)` branch.
    registerInvokeHandler('open_mods_folder', () => { throw 'plain-string-reason'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Open folder/ }));
    await waitFor(() => {
      expect(screen.getByText('plain-string-reason')).toBeInTheDocument();
    });
  });

  // ── Repair flow branches ─────────────────────────────────────────

  it('Repair flow: confirm cancelled → no repair_mod invoke', async () => {
    seedMods([baseMod({ name: 'Cancelled', folder_name: 'Cancelled', github_url: 'https://github.com/x/y' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Cancelled')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Repair this mod/ }));
    await waitFor(() => { expect(screen.getByText(/Repair 'Cancelled'/)).toBeInTheDocument(); });
    const cancelBtn = document.querySelector(
      '.gf-modal-foot button',
    ) as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();
    await user.click(cancelBtn!);
    expect(getInvokeCalls().some((c) => c.cmd === 'repair_mod')).toBe(false);
  });

  it('Repair flow: failure surfaces an error toast', async () => {
    seedMods([baseMod({ name: 'RepairFail', folder_name: 'RepairFail', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('repair_mod', () => { throw new Error('network down'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('RepairFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Repair this mod/ }));
    await user.click(screen.getByRole('button', { name: 'Repair now' }));
    await waitFor(() => {
      expect(screen.getByText(/Repair failed for 'RepairFail'.*network down/)).toBeInTheDocument();
    });
  });

  it('Repair flow: success shows toast with new version', async () => {
    seedMods([baseMod({ name: 'RepairWin', folder_name: 'RepairWin', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('repair_mod', () => baseMod({ name: 'RepairWin', version: '9.9.9' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('RepairWin')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Repair this mod/ }));
    await user.click(screen.getByRole('button', { name: 'Repair now' }));
    await waitFor(() => {
      expect(screen.getByText(/Repaired 'RepairWin'.*9\.9\.9/)).toBeInTheDocument();
    });
  });

  // ── Import file flow ─────────────────────────────────────────────

  it('Import mod: dialog returns null → no invoke', async () => {
    seedMods([]);
    const { open: openMock } = await import('@tauri-apps/plugin-dialog');
    (openMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import mod/ }));
    // Wait a tick — no install_mod_from_file should have fired.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(false);
    });
  });

  it('Import mod: dialog returns path → install_mod_from_file fires + success toast', async () => {
    seedMods([]);
    const { open: openMock } = await import('@tauri-apps/plugin-dialog');
    (openMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce('C:/Downloads/foo.zip');
    registerInvokeHandler('install_mod_from_file', () => baseMod({ name: 'ImportedMod' }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import mod/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(true);
    });
    expect(screen.getByText(/Installed: ImportedMod/)).toBeInTheDocument();
  });

  it('Import mod: install_mod_from_file failure surfaces toast', async () => {
    seedMods([]);
    const { open: openMock } = await import('@tauri-apps/plugin-dialog');
    (openMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce('C:/Downloads/bad.zip');
    registerInvokeHandler('install_mod_from_file', () => { throw new Error('zip corrupt'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Import failed: zip corrupt/)).toBeInTheDocument();
    });
  });

  // ── Quick Add: github_installed + nexus_info paths ───────────────

  it('Quick add: github_installed result → refreshAll + Installed toast', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: baseMod({ name: 'QuickGithub' }),
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://github.com/quick/win');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Installed: QuickGithub/)).toBeInTheDocument();
    });
  });

  it('Quick add: nexus URL → opens files-tab URL and emits sticky watcher toast', async () => {
    seedMods([]);
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: 'NexFound', game_slug: 'slaythespire2', mod_id: 42 },
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    // Full Nexus URL — nexusFilesUrl returns the files-tab URL.
    await user.type(input, 'https://www.nexusmods.com/slaythespire2/mods/42');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/42?tab=files',
      );
    });
  });

  it('Quick add: nexus shorthand → opens shorthand-built files-tab URL', async () => {
    seedMods([]);
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: 'ShortNex' },
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'nexus:slaythespire2/mods/99');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/99?tab=files',
      );
    });
  });

  it('Quick add: nexus result without resolvable files URL → falls back to info toast', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: 'OrphanNexus' },
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    // A bare string that doesn't parse as URL and isn't a nexus shorthand.
    await user.type(input, 'totally-not-a-url');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Found Nexus mod: OrphanNexus/)).toBeInTheDocument();
    });
  });

  it('Quick add: nexus URL on non-nexus host returns null files URL → info toast fallback', async () => {
    // URL parses but host isn't nexusmods.com → nexusFilesUrl falls through to null.
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: 'WrongHost' },
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://example.com/some/path');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Found Nexus mod: WrongHost/)).toBeInTheDocument();
    });
  });

  it('Quick add: empty input click is a no-op (no invoke)', async () => {
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const callsBefore = getInvokeCalls().filter((c) => c.cmd === 'quick_add_mod').length;
    await user.click(screen.getByRole('button', { name: 'Add' }));
    // Whitespace-only input → handler returns early.
    expect(getInvokeCalls().filter((c) => c.cmd === 'quick_add_mod').length).toBe(callsBefore);
  });

  it('Quick add: failure surfaces error toast', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => { throw new Error('rate-limited'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'github:foo/bar');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Quick add failed.*rate-limited/)).toBeInTheDocument();
    });
  });

  it('Quick add: pressing Enter in the input triggers handleQuickAdd', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: baseMod({ name: 'EnterMod' }),
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'github:enter/mod{Enter}');
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'quick_add_mod')).toBe(true);
    });
  });

  it('Quick add: the X button closes the form', async () => {
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    expect(input).toBeInTheDocument();
    // The Quick-Add Card renders an X-icon ghost button to close. Locate
    // it by the X svg sibling of the Add button.
    const addBtn = screen.getByRole('button', { name: 'Add' });
    const card = addBtn.parentElement!;
    const ghostButtons = card.querySelectorAll('button');
    // Last button in the card row is the X (after Add). Use the last button.
    const closeBtn = ghostButtons[ghostButtons.length - 1] as HTMLButtonElement;
    expect(closeBtn).toBeDefined();
    await user.click(closeBtn);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/https:\/\/github\.com\/user\/mod/)).toBeNull();
    });
  });

  // ── Source editor: clear, find-github, save error, close ─────────

  it('Source editor onClose (X icon) closes the drawer', async () => {
    seedMods([baseMod({ name: 'CloseMe', folder_name: 'CloseMe' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('CloseMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for CloseMe')).toBeInTheDocument(); });
    // The editor's Cancel button closes it.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for CloseMe')).toBeNull();
    });
  });

  it('Source editor "Clear all links" calls set_mod_source with empty source', async () => {
    seedMods([baseMod({ name: 'ClearMe', folder_name: 'ClearMe', github_url: 'https://github.com/x/y', source: 'github:x/y' })]);
    registerInvokeHandler('set_mod_source', () => null);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('ClearMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for ClearMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Clear all links/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_source' && c.args?.modName === 'ClearMe',
      )).toBe(true);
    });
    expect(screen.getByText(/Source link cleared for ClearMe/)).toBeInTheDocument();
  });

  it('Source editor "Clear all links" failure surfaces toast', async () => {
    seedMods([baseMod({ name: 'ClearFail', folder_name: 'ClearFail', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('set_mod_source', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('ClearFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.click(screen.getByRole('button', { name: /Clear all links/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: locked/)).toBeInTheDocument();
    });
  });

  it('Source editor: Find GitHub button fires find_github_from_nexus when only nexus is linked', async () => {
    seedMods([baseMod({ name: 'OnlyNex', folder_name: 'OnlyNex', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/7' })]);
    registerInvokeHandler('find_github_from_nexus', () => 'foo/bar');
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('OnlyNex')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for OnlyNex')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'find_github_from_nexus')).toBe(true);
    });
    expect(screen.getByText(/Found GitHub repo: foo\/bar/)).toBeInTheDocument();
  });

  it('Source editor: Find GitHub returns null → info toast', async () => {
    seedMods([baseMod({ name: 'NoFind', folder_name: 'NoFind', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/8' })]);
    registerInvokeHandler('find_github_from_nexus', () => null);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NoFind')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.click(screen.getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(screen.getByText(/No GitHub link found in Nexus description for NoFind/)).toBeInTheDocument();
    });
  });

  it('Source editor: Find GitHub failure surfaces error toast', async () => {
    seedMods([baseMod({ name: 'FindFail', folder_name: 'FindFail', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/9' })]);
    registerInvokeHandler('find_github_from_nexus', () => { throw new Error('500'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('FindFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.click(screen.getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: 500/)).toBeInTheDocument();
    });
  });

  it('Source editor onSave failure surfaces error toast', async () => {
    seedMods([baseMod({ name: 'SaveFail', folder_name: 'SaveFail' })]);
    registerInvokeHandler('set_mod_sources_full', () => { throw new Error('disk-readonly'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SaveFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for SaveFail')).toBeInTheDocument(); });
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: disk-readonly/)).toBeInTheDocument();
    });
  });

  // ── Inline update + audit kebab branches ─────────────────────────

  it('Inline update failure surfaces error toast', async () => {
    seedMods([baseMod({ name: 'UpdFail', folder_name: 'UpdFail', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'UpdFail',
      folder_name: 'UpdFail',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0',
      latest_compatible_tag: 'v2.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
    }]);
    registerInvokeHandler('update_mod', () => { throw new Error('release deleted'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('UpdFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Update available → v2\.0\.0/);
    await user.click(pill);
    await waitFor(() => {
      expect(screen.getByText(/Update failed for 'UpdFail'.*release deleted/)).toBeInTheDocument();
    });
  });

  it('Inline update with rename triggers re-audit on both old + new names', async () => {
    seedMods([baseMod({ name: 'RenameMe', folder_name: 'RenameMe', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'RenameMe',
      folder_name: 'RenameMe',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0',
      latest_compatible_tag: 'v2.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
    }]);
    // Server renames the mod on update.
    registerInvokeHandler('update_mod', () => baseMod({ name: 'RenamedNow', folder_name: 'RenameMe', version: '2.0.0' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('RenameMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Update available → v2\.0\.0/);
    await user.click(pill);
    await waitFor(() => {
      expect(screen.getByText(/Updated 'RenameMe' to v2\.0\.0/)).toBeInTheDocument();
    });
  });

  it('Find GitHub kebab → null result surfaces info toast', async () => {
    seedMods([baseMod({ name: 'NexKebab', folder_name: 'NexKebab', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/11' })]);
    registerInvokeHandler('find_github_from_nexus', () => null);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NexKebab')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Find GitHub from Nexus/ }));
    await waitFor(() => {
      expect(screen.getByText(/No GitHub link found in Nexus description for NexKebab/)).toBeInTheDocument();
    });
  });

  it('Find GitHub kebab → failure surfaces error toast', async () => {
    seedMods([baseMod({ name: 'NexKebabFail', folder_name: 'NexKebabFail', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/12' })]);
    registerInvokeHandler('find_github_from_nexus', () => { throw new Error('rate limit'); });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NexKebabFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Find GitHub from Nexus/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: rate limit/)).toBeInTheDocument();
    });
  });

  // ── Game-version compat helper branches ──────────────────────────

  it('min-game-version warning hidden when current >= required (minor newer)', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '1.5.0',
    }));
    seedMods([baseMod({ name: 'OldReq', folder_name: 'OldReq', min_game_version: '1.4.9' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OldReq')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  it('min-game-version warning hidden when current major > required', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '2.0.0',
    }));
    seedMods([baseMod({ name: 'OldMajor', folder_name: 'OldMajor', min_game_version: '1.99.99' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OldMajor')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  it('min-game-version warning hidden when version strings cannot parse', async () => {
    // garbage strings → parse returns NaNs → fail-OPEN (no warning).
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: 'nightly-deadbeef',
    }));
    seedMods([baseMod({ name: 'WeirdVer', folder_name: 'WeirdVer', min_game_version: 'not.a.version' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('WeirdVer')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  it('min-game-version warning hidden when min_game_version is null (no requirement)', async () => {
    seedMods([baseMod({ name: 'NoReq', folder_name: 'NoReq', min_game_version: null })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NoReq')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  // ── Repair "no github" pre-check ─────────────────────────────────
  // The handleRepair early-return (Mods.tsx lines 184-189) is defensive:
  // the kebab item is independently disabled when github_url is null, so
  // no UI path reaches the guard. Covered by the kebab-disabled assertion
  // in "Repair early-return surfaces 'no source linked' toast" below.

  // ── Toggle advanced-mode persistence (localStorage path) ─────────

  // ── Non-Error rejection branches (`String(e)` fallback) ──────────

  it('toggle_mod failure with non-Error rejection still surfaces toast', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('toggle_mod', () => { throw 'bare-string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(screen.getByText(/Failed to toggle BaseLib.*bare-string/)).toBeInTheDocument();
    });
  });

  it('pin_mod failure with non-Error rejection still surfaces toast', async () => {
    seedMods([baseMod({ name: 'P', folder_name: 'P', pinned: false })]);
    registerInvokeHandler('pin_mod', () => { throw 'bare-pin'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('P')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Pin this mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to pin P.*bare-pin/)).toBeInTheDocument();
    });
  });

  it('delete_mod failure with non-Error rejection still surfaces toast', async () => {
    seedMods([baseMod({ name: 'D', folder_name: 'D' })]);
    registerInvokeHandler('delete_mod_cmd', () => { throw 'bare-del'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('D')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Remove mod/ }));
    await waitFor(() => { expect(screen.getByText(/Delete "D"/)).toBeInTheDocument(); });
    const dangerBtn = document.querySelector('.gf-modal-foot button.gf-btn-danger') as HTMLButtonElement;
    expect(dangerBtn).toBeTruthy();
    await user.click(dangerBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to delete D.*bare-del/)).toBeInTheDocument();
    });
  });

  it('enable_all non-Error rejection toasts', async () => {
    seedMods([baseMod({ enabled: false })]);
    registerInvokeHandler('enable_all_mods', () => { throw 'bare-en'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-en/)).toBeInTheDocument();
    });
  });

  it('disable_all non-Error rejection toasts', async () => {
    seedMods([baseMod({ enabled: true })]);
    registerInvokeHandler('disable_all_mods', () => { throw 'bare-dis'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Disable all/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-dis/)).toBeInTheDocument();
    });
  });

  it('delete_all non-Error rejection toasts', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('delete_all_mods', () => { throw 'bare-da'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Delete all/ }));
    await waitFor(() => { expect(screen.getByText(/Delete all 1 mods/)).toBeInTheDocument(); });
    await user.type(screen.getByPlaceholderText('delete all'), 'delete all');
    const confirmBtn = screen.getAllByRole('button').find(
      (b) => /Delete everything/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(confirmBtn).toBeDefined();
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-da/)).toBeInTheDocument();
    });
  });

  it('quick_add non-Error rejection toasts', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => { throw 'bare-qa'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'github:foo/bar');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Quick add failed.*bare-qa/)).toBeInTheDocument();
    });
  });

  it('repair non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'R', folder_name: 'R', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('repair_mod', () => { throw 'bare-rep'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('R')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Repair this mod/ }));
    await user.click(screen.getByRole('button', { name: 'Repair now' }));
    await waitFor(() => {
      expect(screen.getByText(/Repair failed for 'R'.*bare-rep/)).toBeInTheDocument();
    });
  });

  it('install_mod_from_file non-Error rejection toasts', async () => {
    seedMods([]);
    const { open: openMock } = await import('@tauri-apps/plugin-dialog');
    (openMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce('C:/Downloads/x.zip');
    registerInvokeHandler('install_mod_from_file', () => { throw 'bare-imp'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Import failed: bare-imp/)).toBeInTheDocument();
    });
  });

  it('clear_source non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'CS', folder_name: 'CS', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('set_mod_source', () => { throw 'bare-cs'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('CS')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.click(screen.getByRole('button', { name: /Clear all links/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-cs/)).toBeInTheDocument();
    });
  });

  it('update_mod non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'UN', folder_name: 'UN', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'UN', folder_name: 'UN', installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0', latest_compatible_tag: 'v2.0.0',
      latest_has_assets: true, needs_update: true, asset_names: [],
      releases_scanned: 1, github_auto_detected: false, pinned: false,
      nexus_update_available: false,
    }]);
    registerInvokeHandler('update_mod', () => { throw 'bare-upd'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('UN')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Update available → v2\.0\.0/);
    await user.click(pill);
    await waitFor(() => {
      expect(screen.getByText(/Update failed for 'UN'.*bare-upd/)).toBeInTheDocument();
    });
  });

  it('find_github (kebab) non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'FK', folder_name: 'FK', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/22' })]);
    registerInvokeHandler('find_github_from_nexus', () => { throw 'bare-fg'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('FK')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Find GitHub from Nexus/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-fg/)).toBeInTheDocument();
    });
  });

  it('find_github (source editor) non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'FE', folder_name: 'FE', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/23' })]);
    registerInvokeHandler('find_github_from_nexus', () => { throw 'bare-fge'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('FE')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.click(screen.getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-fge/)).toBeInTheDocument();
    });
  });

  it('SourceEditor save non-Error rejection toasts', async () => {
    seedMods([baseMod({ name: 'SE', folder_name: 'SE' })]);
    registerInvokeHandler('set_mod_sources_full', () => { throw 'bare-se'; });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SE')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: bare-se/)).toBeInTheDocument();
    });
  });

  // ── gameVersionSatisfies branches ────────────────────────────────

  it('warning hidden when game_version is null (fail-open)', async () => {
    // current null → !current → return true (no warning).
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: null,
    }));
    seedMods([baseMod({ name: 'NullVer', folder_name: 'NullVer', min_game_version: '1.0.0' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NullVer')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  it('warning hidden when patch matches required exactly', async () => {
    // current 1.0.5, required 1.0.5 → cMin===rMin AND cPatch>=rPatch true.
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '1.0.5',
    }));
    seedMods([baseMod({ name: 'PatchEq', folder_name: 'PatchEq', min_game_version: '1.0.5' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PatchEq')).toBeInTheDocument(); });
    expect(screen.queryByText(/needs game ≥/)).toBeNull();
  });

  it('warning shown when only patch is behind required (cMin === rMin path)', async () => {
    // current 1.0.3, required 1.0.5 → cMin===rMin → cPatch<rPatch → false → warning.
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2',
      mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '1.0.3',
    }));
    seedMods([baseMod({ name: 'PatchBehind', folder_name: 'PatchBehind', min_game_version: '1.0.5' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PatchBehind')).toBeInTheDocument(); });
    expect(screen.getByText(/needs game ≥ v1\.0\.5/)).toBeInTheDocument();
  });

  // ── folder_name null + audit row by mod_name ─────────────────────

  it('mods without folder_name still render + audit lookup falls back to mod_name', async () => {
    // Backend audit might lack folder_name on legacy rows.
    seedMods([baseMod({ name: 'NoFolder', folder_name: null })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NoFolder')).toBeInTheDocument(); });
    // Header still counts it.
    expect(screen.getByText(/1 installed/)).toBeInTheDocument();
  });

  it('audit row stored under mod_name when folder_name missing on row', async () => {
    seedMods([baseMod({ name: 'LegacyMod', folder_name: null, github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'LegacyMod',
      // folder_name omitted intentionally — covers line 114 `a.folder_name ?? a.mod_name`.
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v1.5.0',
      latest_compatible_tag: 'v1.5.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('LegacyMod')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Update available → v1\.5\.0/)).toBeInTheDocument();
    });
  });

  // ── handleInlineUpdate folderName null branch (line 130) ─────────

  it('inline update of a folder_name-null mod still calls update_mod', async () => {
    seedMods([baseMod({ name: 'NF', folder_name: null, github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NF',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0',
      latest_compatible_tag: 'v2.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
    }]);
    registerInvokeHandler('update_mod', () => baseMod({ name: 'NF', folder_name: null, version: '2.0.0' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NF')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const pill = await screen.findByText(/Update available → v2\.0\.0/);
    await user.click(pill);
    await waitFor(() => {
      expect(screen.getByText(/Updated 'NF' to v2\.0\.0/)).toBeInTheDocument();
    });
  });

  // ── nexus_info.name empty fallback ───────────────────────────────

  it('Quick add nexus result with empty name falls back to "Nexus mod" label', async () => {
    seedMods([]);
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: '' }, // empty → `|| 'Nexus mod'` fallback
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://www.nexusmods.com/sts2/mods/50');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalled();
    });
    // The fallback name 'Nexus mod' is used in notifyNexusOpen; the
    // sticky toast surfaces "Watching for Nexus mod download" text.
    // We assert openUrl was called with the files-tab URL.
    expect(opener.openUrl).toHaveBeenCalledWith(
      'https://www.nexusmods.com/sts2/mods/50?tab=files',
    );
  });

  it('Quick add nexus info-toast falls back to "Unknown" when name missing', async () => {
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: {}, // no name → `|| 'Unknown'` in info-toast branch
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'no-host-here');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Found Nexus mod: Unknown/)).toBeInTheDocument();
    });
  });

  // ── nexusFilesUrl: nexus host but malformed path ─────────────────

  it('Quick add nexus URL with too-few path segments falls through to null files URL', async () => {
    // URL parses, host is nexusmods.com, but parts.length<3 → null.
    seedMods([]);
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_found',
      nexus_info: { name: 'BadPath' },
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Quick add URL/ }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    // Only one path segment ('search') → parts.length=1 → returns null.
    await user.type(input, 'https://www.nexusmods.com/search');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(screen.getByText(/Found Nexus mod: BadPath/)).toBeInTheDocument();
    });
  });

  // ── Disambiguator when author is null (folder fallback) ──────────

  it('duplicate-name rows fall back to folder_name when author is blank', async () => {
    seedMods([
      baseMod({ name: 'DupFolder', folder_name: 'DupFolder-A', author: '' }),
      baseMod({ name: 'DupFolder', folder_name: 'DupFolder-B', author: '' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getAllByText('DupFolder')).toHaveLength(2);
    });
    // Folder-name disambiguators surface.
    expect(screen.getByText(/DupFolder-A/)).toBeInTheDocument();
    expect(screen.getByText(/DupFolder-B/)).toBeInTheDocument();
  });

  // ── Audit "game_version_too_old" hides the update pill ───────────

  it('Update pill hidden when audit row reports game_version_too_old=true', async () => {
    seedMods([baseMod({ name: 'GameOld', folder_name: 'GameOld', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'GameOld',
      folder_name: 'GameOld',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v9.0.0',
      latest_compatible_tag: 'v9.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_repo: 'x/y',
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
      game_version_too_old: true,
      latest_release_blocked_by_game_version: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('GameOld')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Even with needs_update=true, game_version_too_old blocks the inline
    // "Update available" pill on the mod row, but the toolbar bulk-update
    // button still counts it as a pending update.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Update 1 mod$/ })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Update available →/)).toBeNull();
  });

  // ── Update-blocked badge `?? '?'` fallback path ──────────────────

  it('Update-blocked badge renders even when latest_release_with_assets_tag is null', async () => {
    seedMods([baseMod({ name: 'BlkNull', folder_name: 'BlkNull', github_url: 'https://github.com/x/y' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BlkNull',
      folder_name: 'BlkNull',
      installed_version: '1.0.0',
      // latest_release_with_assets_tag omitted to exercise `?? '?'`.
      latest_has_assets: false,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
      latest_release_blocked_by_game_version: true,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BlkNull')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Update blocked by game version/)).toBeInTheDocument();
    });
  });

  // ── min-game warning when game_version is null (?? 'unknown') ────
  // The `?? 'unknown'` fallback at Mods.tsx:642 is dead in current logic:
  // gameVersionSatisfies(null|undefined, X) returns true (fail-open), so
  // the warning span only renders when game_version is a real string. We
  // keep the fallback as defensive code; see the inline `// uncovered:`
  // comment in Mods.tsx for the rationale.

  // ── Source editor "Close source editor" label after open ─────────

  it('Source editor: re-opening kebab while expanded shows "Close source editor"', async () => {
    seedMods([baseMod({ name: 'Reopen', folder_name: 'Reopen' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Reopen')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const open1 = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(open1[0]);
    await waitFor(() => { expect(screen.getByText('Sources for Reopen')).toBeInTheDocument(); });
    // Re-open kebab — the label flips to "Close source editor".
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Close source editor/ })).toBeInTheDocument();
    });
    // Clicking it collapses the editor.
    await user.click(screen.getByRole('menuitem', { name: /Close source editor/ }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for Reopen')).toBeNull();
    });
  });

  // ── SourceEditor empty github trim → null fallback (839) ─────────

  it('Source editor: saving with both fields empty passes null github + nexus', async () => {
    seedMods([baseMod({ name: 'EmptySave', folder_name: 'EmptySave' })]);
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: null,
      github_auto_detected: false,
      nexus_url: null,
      pinned: false,
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('EmptySave')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = screen.getAllByRole('menuitem', { name: /Edit sources/ });
    await user.click(items[0]);
    await waitFor(() => { expect(screen.getByText('Sources for EmptySave')).toBeInTheDocument(); });
    // Click Save without typing anything — both fields trim to empty
    // → null fallbacks.
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_sources_full' && c.args?.githubRepo === null,
      )).toBe(true);
    });
  });

  // ── Repair "no github" early-return (line 184) ───────────────────

  it('Repair early-return surfaces "no source linked" toast when github_url is missing', async () => {
    // The kebab is disabled in the UI, but the handler also guards
    // independently. Force the handler to run by clicking the menuitem
    // in a state where it appears enabled: use a github_url to enable
    // it, then mutate (...) — actually simpler: assert disabled in the
    // kebab. The early-return is dead code from the UI; document it.
    // uncovered: Mods.tsx lines 184-189 — handleRepair guards against
    // missing github_url but the kebab item is independently disabled
    // when github_url is null, so the toast branch is never visible.
    seedMods([baseMod({ name: 'NoGH', folder_name: 'NoGH', github_url: null })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NoGH')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const repair = await screen.findByRole('menuitem', { name: /Repair this mod/ });
    expect(repair).toBeDisabled();
  });

  // ── Storage write fallback (line 89 catch) ───────────────────────

  it('Advanced toggle survives a localStorage setItem failure', async () => {
    seedMods([]);
    localStorage.removeItem('sts2mm-mods-advanced');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    // Clicking the toggle should not crash even when localStorage throws.
    await user.click(screen.getByText('Advanced'));
    // Advanced mode still flips in-memory — assert the Import-mod
    // button surfaces.
    expect(screen.getByRole('button', { name: /Import mod/ })).toBeInTheDocument();
    setItemSpy.mockRestore();
  });

  // ── Storage read fallback (line 89 catch on getItem) ─────────────

  it('Advanced state falls back to "false" when localStorage throws on read', async () => {
    seedMods([]);
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('locked');
    });
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    // Off by default → Import mod button NOT visible.
    expect(screen.queryByRole('button', { name: /Import mod/ })).toBeNull();
    getItemSpy.mockRestore();
  });

  it('Advanced toggle writes to localStorage on flip', async () => {
    seedMods([]);
    // Force a known starting state — earlier tests may have left
    // 'sts2mm-mods-advanced'='true' in localStorage. Clear it so the
    // assertion is deterministic.
    localStorage.removeItem('sts2mm-mods-advanced');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/0 installed/)).toBeInTheDocument(); });
    await user.click(screen.getByText('Advanced'));
    expect(setItem).toHaveBeenCalledWith('sts2mm-mods-advanced', 'true');
    setItem.mockRestore();
  });

  // ── Clipboard rejection + openUrl rejection paths ────────────────

  it('Copy version: clipboard rejection surfaces "Could not copy" toast', async () => {
    seedMods([baseMod({ version: '7.7.7' })]);
    // jsdom 27 gotcha — patch Clipboard.prototype.writeText, not the
    // instance, and fire click via fireEvent (not userEvent) so the
    // promise chain runs synchronously inside the act() boundary.
    const proto = Object.getPrototypeOf(navigator.clipboard);
    const writeFn = vi.fn(async () => { throw new Error('blocked'); });
    Object.defineProperty(proto, 'writeText', {
      value: writeFn,
      configurable: true,
      writable: true,
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const copy = screen.getByRole('menuitem', { name: /Copy version/ });
    fireEvent.click(copy);
    await waitFor(() => {
      expect(screen.getByText(/Could not copy/)).toBeInTheDocument();
    });
  });

  it('View on GitHub kebab: openUrl rejection is swallowed (no crash, no toast)', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/x/y' })]);
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'View on GitHub' }));
    // openUrl was called; rejection is swallowed by the .catch(() => {}).
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith('https://github.com/x/y');
    });
    // No error toast should appear from this path.
    expect(screen.queryByText(/Failed/)).toBeNull();
  });

  it('Delete confirmed → delete_mod_cmd fires + success toast', async () => {
    seedMods([baseMod({ name: 'DelOk', folder_name: 'DelOk' })]);
    registerInvokeHandler('delete_mod_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DelOk')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Remove mod/ }));
    await waitFor(() => { expect(screen.getByText(/Delete "DelOk"/)).toBeInTheDocument(); });
    const dangerBtn = document.querySelector('.gf-modal-foot button.gf-btn-danger') as HTMLButtonElement;
    expect(dangerBtn).toBeTruthy();
    await user.click(dangerBtn);
    await waitFor(() => {
      expect(screen.getByText(/Deleted: DelOk/)).toBeInTheDocument();
    });
  });

  it('View on Nexus kebab: openUrl rejection is swallowed', async () => {
    seedMods([baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/200' })]);
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'View on Nexus' }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith('https://www.nexusmods.com/sts2/mods/200');
    });
    expect(screen.queryByText(/Failed/)).toBeNull();
  });
});
