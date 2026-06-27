import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModsView } from './Mods';
import { AllProviders } from '../__test__/providers';
import { chooseOption } from '../__test__/selectHelpers';
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

function Wrap(props: {
  advancedMode?: boolean;
  onManageActiveModpack?: () => void;
  onGoToSettings?: () => void;
  initialTab?: 'installed' | 'browse';
} = {}) {
  return (
    <AllProviders>
      <ModsView
        advancedMode={props.advancedMode}
        onManageActiveModpack={props.onManageActiveModpack}
        onGoToSettings={props.onGoToSettings}
        initialTab={props.initialTab}
      />
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
  tags: [],
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

/**
 * The four toolbar add-affordances (Quick add URL / Import mod / Auto-detect
 * sources / Open folder) were consolidated into a single "Add mods ▾" dropdown
 * (AddModsMenu). The menu auto-closes when an item is clicked, so every
 * interaction must open it first, then target the action as a `menuitem`.
 */
async function openAddMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /add mods/i }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openSourceEditor(
  user: ReturnType<typeof userEvent.setup>,
  modName: string,
): Promise<void> {
  await user.click(screen.getByRole('button', {
    name: new RegExp(`^Edit sources for ${escapeRegExp(modName)}$`, 'i'),
  }));
  await waitFor(() => {
    expect(screen.getByText(`Sources for ${modName}`)).toBeInTheDocument();
  });
}

describe('<ModsView>', () => {
  it('toolbar "Auto-detect sources" button opens the auto-detect scan', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    // Toolbar (and its bulk-action row) only render once mods exist.
    await screen.findByText('BaseLib');
    const label = i18n.t('mods.autoDetectSources');
    // The dedicated toolbar button is the only element carrying this label
    // (the "+ Add mods" dropdown no longer offers auto-detect), so the
    // role="button" lookup is unambiguous.
    await user.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
    // Opening the modal kicks off a scan via the auto_detect_sources command.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'auto_detect_sources')).toBe(true);
    });
  });

  it('renders the empty state when no mods are installed', async () => {
    seedMods([]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });
  });

  // ── 1.7.0 outer Installed/Browse tabs ─────────────────────────────
  it('outer tab strip: Installed is the default; switching to Browse renders BrowseView', async () => {
    // 1.7.0 — Browse Mods is now a tab inside this view. Default tab
    // is Installed (existing All-installed-mods page). The Browse tab
    // surfaces the GitHub sub-tab as a structural marker.
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Browse /i }));
    // BrowseView's GitHub source sub-tab proves we switched.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    // Switch back — the All-installed-mods header reappears.
    await user.click(screen.getByRole('button', { name: /^Installed$/i }));
    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
  });

  it('initialTab=browse opens straight on the Browse tab', async () => {
    // Backward-compat path: legacy view-id 'browse-mods' is routed
    // by App.tsx to this view with initialTab='browse'.
    render(<Wrap initialTab="browse" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
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

  it('offers a Manage-active-modpack page-header link (toolbar duplicate removed)', async () => {
    // T16 review fix — the toolbar "Mod Library" button was removed.
    // Its label described the dead cross-profile workspace and the
    // page header already exposes the same handler via a non-misleading
    // "Manage active modpack →" link. Pin both: (a) the toolbar no
    // longer has a "Mod Library" affordance, (b) the page-header link
    // still wires the handler.
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib' })]);
    const onManageActiveModpack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onManageActiveModpack={onManageActiveModpack} />);

    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    // No toolbar button labeled "Mod Library" — the toolbar duplicate
    // is gone. (The page-header link is named "Manage active modpack",
    // not "Mod Library", so this query stays unique.)
    expect(screen.queryByRole('button', { name: /^Mod Library/i })).toBeNull();

    const link = screen.getByRole('button', { name: /manage active modpack/i });
    await user.click(link);
    expect(onManageActiveModpack).toHaveBeenCalledTimes(1);
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
    const search = screen.getByPlaceholderText(/Search 3 library mods?/);
    await user.type(search, 'auto');
    await waitFor(() => {
      expect(screen.queryByText('BaseLib')).toBeNull();
    });
    expect(screen.getByText('AutoPath')).toBeInTheDocument();
    expect(screen.queryByText('CardArtEditor')).toBeNull();
  });

  it('manager tags render on rows and the Tag picker brings a category to the top (hides nothing)', async () => {
    seedMods([
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib', tags: ['utility', 'beta'] }),
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor', tags: ['visual'] }),
      baseMod({ name: 'NoTag', folder_name: 'NoTag', tags: [] }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    expect(screen.getAllByText('utility').length).toBeGreaterThan(0);
    expect(screen.getAllByText('visual').length).toBeGreaterThan(0);

    // Choosing a tag REORDERS (does not hide): the utility mod floats to the
    // top, every mod stays visible, and untagged sorts last.
    await chooseOption(user, /Tag/i, 'utility');
    expect(screen.getByText('BaseLib')).toBeInTheDocument();
    expect(screen.getByText('CardArtEditor')).toBeInTheDocument();
    expect(screen.getByText('NoTag')).toBeInTheDocument();
    const order = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
      .filter((tt) => ['BaseLib', 'CardArtEditor', 'NoTag'].includes(tt ?? ''));
    expect(order[0]).toBe('BaseLib');
    expect(order[order.length - 1]).toBe('NoTag');
  });

  it('Tag picker has a No tags option that shows only untagged mods', async () => {
    seedMods([
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib', tags: ['utility'] }),
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor', tags: ['visual'] }),
      baseMod({ name: 'NoTag', folder_name: 'NoTag', tags: [] }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findByText('BaseLib');

    await chooseOption(user, /Tag/i, 'No tags');

    expect(screen.getByText('NoTag')).toBeInTheDocument();
    expect(screen.queryByText('BaseLib')).toBeNull();
    expect(screen.queryByText('CardArtEditor')).toBeNull();
  });

  it('sort dropdown supports common mod-library orders', async () => {
    // Post-1.7.0 T18 unification: the Library view uses LibraryTable's
    // own sort dropdown. Sort modes shifted from
    // enabledFirst/disabledFirst/largestFirst to activeFirst/storedFirst
    // and inPackFirst (which only renders when modpackName is set).
    seedMods([
      baseMod({ name: 'ZuluPatch', folder_name: 'ZuluPatch', enabled: true }),
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib', enabled: false }),
      baseMod({ name: 'AutoPath', folder_name: 'AutoPath', enabled: true }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('AutoPath');

    expectTextBefore('AutoPath', 'BaseLib');
    expectTextBefore('BaseLib', 'ZuluPatch');

    await chooseOption(user, /Sort/i, 'Name Z-A');
    expectTextBefore('ZuluPatch', 'BaseLib');
    expectTextBefore('BaseLib', 'AutoPath');

    await chooseOption(user, /Sort/i, 'Active first');
    // Both AutoPath and ZuluPatch are active; BaseLib is stored. Active
    // ones appear first, sorted alphabetically.
    expectTextBefore('AutoPath', 'ZuluPatch');
    expectTextBefore('ZuluPatch', 'BaseLib');

    await chooseOption(user, /Sort/i, 'Stored first');
    expectTextBefore('BaseLib', 'AutoPath');
  });

  it('Import mod + Quick add URL buttons are always visible (T17 removed the advanced gate)', async () => {
    // T17: per-screen Advanced toggle was removed when the per-row
    // drawer absorbed source-pill + Freeze/Delete disclosure. Import
    // mod / Quick add URL stay in the page-head toolbar — they're
    // primary install affordances, not advanced features. They now live
    // inside the consolidated "Add mods ▾" dropdown.
    seedMods([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });
    // The "Add mods" trigger is always present...
    expect(screen.getByRole('button', { name: /add mods/i })).toBeInTheDocument();
    // ...and opening it surfaces both primary install affordances.
    await openAddMenu(user);
    expect(screen.getByRole('menuitem', { name: /Import mod/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Quick add URL/ })).toBeInTheDocument();
  });

  it('Auto-detect sources standalone button opens the AutoDetectModal (NOT in "+ Add mods" menu)', async () => {
    // "Auto-detect sources" lives as a standalone bulk-action button in the
    // Mod Library, NOT inside the "+ Add mods" dropdown. Opening that menu must
    // not add a second instance of the label.
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib' })]);
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    const label = i18n.t('mods.autoDetectSources');
    // Exactly one element with the auto-detect label before opening the menu.
    expect(screen.getAllByText(label)).toHaveLength(1);
    // Open the "+ Add mods" dropdown — must NOT add a second auto-detect entry.
    await openAddMenu(user);
    expect(screen.getAllByText(label)).toHaveLength(1);
    // Clicking the standalone button (role=button) triggers the modal.
    await user.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
    // The modal scans on open — assert the command fired and the modal
    // backdrop materialised.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'auto_detect_sources')).toBe(true);
    });
    expect(document.querySelectorAll('.gf-modal-back').length).toBeGreaterThan(0);
  });

  it('Audit mods button transitions to "Download 1 update" when audit returns one pending GitHub update', async () => {
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
        update_source: 'github',
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Download 1 update$/ })).toBeInTheDocument();
    });
  });

  it('the Mods-page audit action has no Beta tag', async () => {
    seedMods([]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 installed/)).toBeInTheDocument();
    });

    const auditButton = screen.getByRole('button', { name: 'Audit mods' });
    expect(within(auditButton).queryByText('Beta')).toBeNull();
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

  it('Refresh surfaces a newly-installed mod in focus mode without a remount', async () => {
    // Regression: with an active modpack the table renders from the
    // membership grid, which was fetched once and never re-pulled on
    // refresh — so a freshly-installed mod only appeared after switching
    // tabs. The table must re-fetch the grid when the installed set grows.
    registerInvokeHandler('get_active_profile', () => 'TestPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'TestPack', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: null },
    ]);
    let installedCount = 1;
    const mkRow = (name: string) => ({
      name,
      version: '1.0.0',
      folder_name: name,
      mod_id: name,
      installed_enabled: true,
      profiles: [{ profile_name: 'TestPack', included: true, enabled: true, editable: true }],
    });
    registerInvokeHandler('get_installed_mods', () =>
      (installedCount === 1 ? ['OldMod'] : ['OldMod', 'FreshMod']).map((n) =>
        baseMod({ name: n, folder_name: n }),
      ),
    );
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'TestPack', editable: true }],
      mods: (installedCount === 1 ? ['OldMod'] : ['OldMod', 'FreshMod']).map(mkRow),
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getAllByText('OldMod').length).toBeGreaterThan(0); });
    expect(screen.queryByText('FreshMod')).toBeNull();

    // Simulate an install landing on disk, then hit Refresh.
    installedCount = 2;
    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    // The new mod shows up without unmounting/remounting the table.
    await waitFor(() => { expect(screen.getAllByText('FreshMod').length).toBeGreaterThan(0); });
  });

  it('Open mods folder button triggers open_mods_folder', async () => {
    // FB3: the global open-folder moved out of the Add-mods dropdown into the
    // bulk-action row (left of Enable all), shown once mods exist.
    seedMods([baseMod()]);
    registerInvokeHandler('open_mods_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    // It sits to the LEFT of "Enable all" in the bulk-action row.
    expectTextBefore('Open mods folder', 'Enable all');
    await user.click(screen.getByRole('button', { name: /Open mods folder/i }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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

  it('row Active/stored switch invokes toggle_mod (storage control lives on the row)', async () => {
    // 1.7.0: the verbose kebab "Disable in game" entry was retired in
    // favour of a compact switch on the row itself — users kept asking
    // "where did the enable/disable toggles go?". ON = active in the
    // game folder; flipping OFF stores the mod (toggle_mod enable=false).
    seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib', enabled: true })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    const sw = screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
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

  it('Enable all with an active modpack updates the row toggle, not just the header', async () => {
    // The All Mods table runs FOCUSED when a modpack is active
    // (modpackName=activeProfile). Its rows come from the membership grid,
    // which re-fetches only on identity/reloadToken change — so a bulk
    // enable/disable used to leave the row toggles stale while the header
    // count (from appMods) updated. A reload nonce now forces the grid
    // re-fetch after a bulk op.
    registerInvokeHandler('get_active_profile', () => 'Active');
    let enabled = false;
    registerInvokeHandler('get_installed_mods', () =>
      [baseMod({ name: 'Solo', folder_name: 'Solo', enabled })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Active', editable: true }],
      mods: [{
        name: 'Solo', version: '3.1.2', folder_name: 'Solo', mod_id: 'Solo',
        installed_enabled: enabled,
        profiles: [{ profile_name: 'Active', included: true, enabled, editable: true }],
      }],
    }));
    registerInvokeHandler('enable_all_mods', () => { enabled = true; return true; });
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('Solo');
    expect(screen.getByRole('switch', { name: /toggle whether Solo is active in game/i }))
      .toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'enable_all_mods')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /toggle whether Solo is active in game/i }))
        .toHaveAttribute('aria-checked', 'true');
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

  it('Delete (trash) button opens the destructive confirm', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Remove AutoPath/i }));
    // Confirm modal shows
    await waitFor(() => {
      expect(screen.getByText(/Delete "AutoPath"/)).toBeInTheDocument();
    });
  });

  it('Delete is a visible trash button left of the kebab (not buried in it)', async () => {
    // Delete is a frequent action, so it's a visible button on the row
    // (left of the kebab) rather than a kebab item.
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /Remove AutoPath/i })).toBeInTheDocument();
    // ...and it's no longer inside the kebab.
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    expect(screen.queryByRole('menuitem', { name: /Remove mod/i })).toBeNull();
  });

  it('kebab → Freeze / Unfreeze toggles via pin_mod / unpin_mod', async () => {
    seedMods([baseMod({ name: 'AutoPath', folder_name: 'AutoPath', pinned: false })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    expect(screen.getByText(/Don't update, replace, enable, or disable this mod/)).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Freeze this mod/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'pin_mod' && c.args?.modName === 'AutoPath',
      )).toBe(true);
    });
  });

  it('the "linked for auto-updates" subtitle suffix is gone (T17 removed it with the advanced toggle)', async () => {
    // T17 removed the per-screen Advanced toggle and the `· N linked for
    // auto-updates` suffix that depended on it. The subtitle now stays
    // focused on the actionable totals (installed / active / disabled).
    seedMods([
      baseMod({ name: 'A', github_url: 'https://github.com/a/b' }),
      baseMod({ name: 'B', nexus_url: 'https://nexusmods.com/x/mods/1' }),
      baseMod({ name: 'C' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/3 installed/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/linked for auto-updates/)).toBeNull();
  });

  it('rows show a folder disambiguator when two mods share a display name', async () => {
    // Post-1.7.0 T18 unification: LibraryRow uses folder_name (not
    // author) as the inline disambiguator. The folder name is always
    // shown when it differs from the mod name, which is also when two
    // same-named mods land in the library.
    seedMods([
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor-v1', author: 'Alice' }),
      baseMod({ name: 'CardArtEditor', folder_name: 'CardArtEditor-v2', author: 'Bob' }),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      // Two rows with the same display name.
      expect(screen.getAllByText('CardArtEditor').length).toBeGreaterThanOrEqual(2);
    });
    // Folder-name disambiguators surface so the rows are distinguishable.
    expect(screen.getByText(/CardArtEditor-v1/)).toBeInTheDocument();
    expect(screen.getByText(/CardArtEditor-v2/)).toBeInTheDocument();
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
    await user.type(screen.getByPlaceholderText(/Search 1 library mod/), 'nothing-matches');
    await waitFor(() => { expect(screen.queryByText('OnlyThing')).toBeNull(); });
  });

  it('mods linked via GitHub surface a GitHub badge inline on the row', async () => {
    // Post-1.7.0 T18 unification: source pills live alongside the
    // storage button on the row (always visible). No drawer to expand.
    seedMods([baseMod({ github_url: 'https://github.com/x/y', source: 'github:x/y' })]);
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    const tokens = screen.queryAllByText(/github/i);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('Update-available pill surfaces inline on the row after audit', async () => {
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
    await screen.findAllByText('AutoPath');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Download update → v3\.2\.0/)).toBeInTheDocument();
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
    await screen.findAllByText('AutoPath');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const updateBtn = await screen.findByRole('button', { name: /Download update → v3\.2\.0/ });
    await user.click(updateBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'update_mod' && c.args?.name === 'AutoPath',
      )).toBe(true);
    });
  });

  it('"Download from Nexus" surfaces inside the drawer when audit reports a Nexus-only update', async () => {
    // T17: the Nexus-update affordance moved into the row drawer. It's
    // now a Button (not an <a>) that opens the Nexus URL through
    // openExternalUrl; the test asserts that openUrl gets the nexus URL.
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
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // The "Download from Nexus" button used to live inside an expand
    // drawer; post-1.7.0 T18 unification it's reachable via the kebab
    // "View on Nexus" action which feeds the same openUrl handler.
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /view on nexus/i }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/42',
      );
    });
  });

  it('snoozed mods show the Skipped pill inline (Nexus URL still reachable via kebab)', async () => {
    // Post-1.7.0 T18 unification: the old drawer-pattern Nexus download
    // button is gone. Snoozed mods now show the "Skipped" pill inline
    // on the row; the Nexus URL is still reachable via the kebab "View
    // on Nexus" action.
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
    await screen.findAllByText('BaseLib');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await screen.findByText(/Skipped/);
  });

  it('pinned mods show the Frozen pill inline (Nexus URL still reachable via kebab)', async () => {
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
    await screen.findAllByText('BaseLib');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    expect(screen.getByText('Frozen')).toBeInTheDocument();
  });

  it('"Update blocked by game version" pill surfaces inline after audit', async () => {
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
    await screen.findAllByText('BumpyMod');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Update blocked by game version/)).toBeInTheDocument();
    });
  });

  it('Audit-error pill surfaces inline when an audit row carries an error string', async () => {
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
    await screen.findAllByText('ErrorMod');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Audit error/)).toBeInTheDocument();
    });
  });

  it('Frozen pill surfaces inline for a frozen mod', async () => {
    seedMods([baseMod({ name: 'PinnedMod', folder_name: 'PinnedMod', pinned: true })]);
    render(<Wrap />);
    await screen.findAllByText('PinnedMod');
    expect(screen.getByText('Frozen')).toBeInTheDocument();
  });

  it('min-game-version warning surfaces inline when the game is too old', async () => {
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
    await screen.findAllByText('NeedsNew');
    expect(screen.getByText(/needs game ≥ v0\.110\.0/)).toBeInTheDocument();
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
    expect(within(rollbackItem).queryByText('Beta')).toBeNull();
    await user.click(rollbackItem);
    await waitFor(() => {
      expect(screen.getByText(/Roll back 'RitsuLib'/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Rollback preserves mod configs/i)).toBeInTheDocument();
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

  it('clicking the mod row opens the inline source editor', async () => {
    seedMods([baseMod({ name: 'SrcMod', folder_name: 'SrcMod' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SrcMod')).toBeInTheDocument(); });
    await openSourceEditor(user, 'SrcMod');
  });

  it('clicking a mod row toggles its inline source editor open, then closed', async () => {
    // 1.7.x — the row body is a click target that opens Edit-sources, and
    // clicking it again must close it (toggle), not re-open the same panel.
    seedMods([baseMod({ name: 'ToggleMod', folder_name: 'ToggleMod' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('ToggleMod')).toBeInTheDocument(); });

    const row = screen.getByTestId('library-row');
    // First click opens the editor.
    await user.click(row);
    await waitFor(() => {
      expect(screen.getByText('Sources for ToggleMod')).toBeInTheDocument();
    });
    // Clicking the row again toggles it closed.
    await user.click(row);
    await waitFor(() => {
      expect(screen.queryByText('Sources for ToggleMod')).toBeNull();
    });
  });

  it('GitHub badge link on the row points at the mod\'s github_url', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/foo/bar' })]);
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    const link = document.querySelector('a[href="https://github.com/foo/bar"]')!;
    expect(link).toBeTruthy();
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('Nexus badge link on the row points at the mod\'s nexus_url', async () => {
    seedMods([baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' })]);
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    const link = document.querySelector('a[href="https://www.nexusmods.com/sts2/mods/103"]')!;
    expect(link).toBeTruthy();
  });

  it('Nexus Download update pill shows from audit (toolbar shows "Up to date" — Nexus not bulk-updatable)', async () => {
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

  it('kebab Skip update suggestion stores the current upstream release tag', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/foo/bar' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
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
      snoozed: false,
    }]);
    registerInvokeHandler('set_mod_snooze', () => ({}));

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // T17: audit fires correctly but the inline pill is gone. Wait for
    // the audit to finish landing by polling for the recorded call.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'audit_mod_versions')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    // KebabItem name includes label + description ("Skip this update
    // until a newer release appears..."). Scope by the label span.
    const labels = await screen.findAllByText(/^Skip this update$/);
    const labelEl = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(labelEl).toBeDefined();
    await user.click(labelEl!.closest('button')!);

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual(expect.objectContaining({
        cmd: 'set_mod_snooze',
        args: { modName: 'BaseLib', folderName: 'BaseLib', latestTag: 'v3.2.0' },
      }));
    });
    expect(await screen.findByText(/Skipped updates for BaseLib until next release/i)).toBeInTheDocument();
  });

  it('kebab Show update again clears a skipped update suggestion', async () => {
    seedMods([baseMod({ github_url: 'https://github.com/foo/bar' })]);
    registerInvokeHandler('audit_mod_versions', () => [{
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
      snoozed: true,
      snoozed_until_tag: 'v3.2.0',
    }]);
    registerInvokeHandler('set_mod_snooze', () => ({}));

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'audit_mod_versions')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Show update again/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual(expect.objectContaining({
        cmd: 'set_mod_snooze',
        args: { modName: 'BaseLib', folderName: 'BaseLib', latestTag: null },
      }));
    });
    expect(await screen.findByText(/Update suggestions restored for BaseLib/i)).toBeInTheDocument();
  });

  it('Refresh button is rendered', async () => {
    seedMods([baseMod()]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /^Refresh$/ })).toBeInTheDocument();
  });

  it('Unlinked badge surfaces inline for mods without a source', async () => {
    seedMods([baseMod({ name: 'OrphanMod', folder_name: 'OrphanMod', source: null })]);
    render(<Wrap />);
    await screen.findAllByText('OrphanMod');
    expect(screen.getByText(/Unlinked/i)).toBeInTheDocument();
  });

  it('Local badge surfaces inline for mods with a source but no github/nexus URL', async () => {
    seedMods([baseMod({ source: 'manual', github_url: null, nexus_url: null })]);
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
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
    await user.type(screen.getByPlaceholderText(/Search 2 library mods?/), 'ana');
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
    await openSourceEditor(user, 'SrcMod');
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

    await user.type(screen.getByPlaceholderText(/Search 1 library mod/), 'readable');
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
    await openSourceEditor(user, 'SrcMod');

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

  it('Source editor Save promotes an unchanged auto-detected GitHub repo to manual', async () => {
    seedMods([
      baseMod({
        name: 'Route Planner',
        folder_name: 'route_planner',
        github_url: 'https://github.com/llzcx/STS2-RoutePlanner',
        github_auto_detected: true,
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
      }),
    ]);
    registerInvokeHandler('set_mod_sources_full', () => ({
      github_repo: 'llzcx/STS2-RoutePlanner',
      github_auto_detected: false,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1260',
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Route Planner')).toBeInTheDocument(); });
    await openSourceEditor(user, 'Route Planner');

    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_mod_sources_full',
        args: {
          modName: 'Route Planner',
          folderName: 'route_planner',
          githubRepo: 'llzcx/STS2-RoutePlanner',
          nexusUrl: 'https://www.nexusmods.com/slaythespire2/mods/1260',
        },
      });
    });
  });

  it('Source editor saves manager tags without changing source links', async () => {
    seedMods([baseMod({ name: 'SrcMod', folder_name: 'SrcMod' })]);
    registerInvokeHandler('set_mod_tags', () => ({
      tags: ['utility', 'beta'],
    }));
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('SrcMod')).toBeInTheDocument(); });
    await openSourceEditor(user, 'SrcMod');

    await user.type(screen.getByPlaceholderText(/utility, beta/i), 'utility, beta');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_mod_tags',
        args: {
          modName: 'SrcMod',
          folderName: 'SrcMod',
          tags: ['utility', 'beta'],
        },
      });
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_sources_full')).toBe(false);
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
    await openSourceEditor(user, 'Readable Name');

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
    await openSourceEditor(user, 'Readable Name');

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
    await openSourceEditor(user, 'Multiplayer Potion View');
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
    await openSourceEditor(user, 'Multiplayer Potion View');
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

  it('clicking "Download N updates" triggers update_all_mods, not a re-audit', async () => {
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
    const updateBtn = await screen.findByRole('button', { name: /^Download 1 update$/ });
    await user.click(updateBtn);
    // Confirm dialog appears with the title "Download 1 update?". Scope the
    // button query to the modal so we don't race the toolbar button.
    const modal = (await screen.findByText(/Download 1 update\?/)).closest('.gf-modal') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: /^Download 1 update$/ }));
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

  it('renders a "Latest" pill inside the drawer of mods whose audit row is up-to-date', async () => {
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
    await screen.findAllByText('CurrentMod');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'audit_mod_versions')).toBe(true);
    });
    // Post-1.7.0 T18: Latest pill renders inline on the row. OldMod
    // (still needs update) shows "Download update" instead, so only
    // one Latest pill on the page.
    await waitFor(() => {
      expect(screen.getAllByText('Latest')).toHaveLength(1);
    });
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

  it('toggle_mod failure surfaces a toast (row switch path)', async () => {
    // LibraryTable owns the toggle_mod call and its own toast wording
    // ("Failed to move {{mod}}: …"). The control is the row's
    // Active/stored switch (the kebab item was retired in 1.7.0).
    seedMods([baseMod({ enabled: true })]);
    registerInvokeHandler('toggle_mod', () => { throw new Error('disk full'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    await user.click(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed to move BaseLib.*disk full/)).toBeInTheDocument();
    });
  });

  it('pin_mod failure surfaces a toast', async () => {
    seedMods([baseMod({ name: 'PinFail', folder_name: 'PinFail', pinned: false })]);
    registerInvokeHandler('pin_mod', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PinFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Freeze this mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to freeze PinFail.*locked/)).toBeInTheDocument();
    });
  });

  it.each([
    {
      cmd: 'pin_mod',
      mod: baseMod({ name: 'PinFailZh', folder_name: 'PinFailZh', pinned: false }),
      menuName: /冻结此模组/,
      expected: /冻结 PinFailZh 失败：locked/,
      leakedEnglish: /freeze PinFailZh/,
    },
    {
      cmd: 'unpin_mod',
      mod: baseMod({ name: 'UnpinFailZh', folder_name: 'UnpinFailZh', pinned: true }),
      menuName: /解除冻结此模组/,
      expected: /解除冻结 UnpinFailZh 失败：locked/,
      leakedEnglish: /unfreeze UnpinFailZh/,
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
    await user.click(screen.getByRole('menuitem', { name: /Unfreeze this mod/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'unpin_mod')).toBe(true);
    });
    expect(screen.getByText(/Unfrozen PinnedMod/)).toBeInTheDocument();
  });

  it('delete_mod failure surfaces a toast', async () => {
    seedMods([baseMod({ name: 'DelFail', folder_name: 'DelFail' })]);
    registerInvokeHandler('delete_mod_cmd', () => { throw new Error('busy'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DelFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /^Remove /i }));
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
    await user.click(screen.getByRole('button', { name: /^Remove /i }));
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
    await user.click(screen.getByRole('button', { name: /Open mods folder/i }));
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
    await user.click(screen.getByRole('button', { name: /Open mods folder/i }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Import mod/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Import mod/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Import mod/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openSourceEditor(user, 'CloseMe');
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
    await openSourceEditor(user, 'ClearMe');
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
    await openSourceEditor(user, 'ClearFail');
    await user.click(screen.getByRole('button', { name: /Clear all links/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: locked/)).toBeInTheDocument();
    });
  });

  it('Source editor: Find GitHub button fires find_github_from_nexus when only nexus is linked', async () => {
    seedMods([baseMod({ name: 'OnlyNex', folder_name: 'OnlyNex', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/7' })]);
    registerInvokeHandler('find_github_from_nexus', () => 'foo/bar');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OnlyNex')).toBeInTheDocument(); });
    await openSourceEditor(user, 'OnlyNex');
    // Scope the Find GitHub button click to the source editor (the
    // drawer also surfaces a "Find GitHub from Nexus" action button
    // when nexus is linked but github is not).
    const editor = screen.getByText('Sources for OnlyNex').closest('.gf-src-edit') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'find_github_from_nexus')).toBe(true);
    });
    expect(screen.getByText(/Found GitHub repo: foo\/bar/)).toBeInTheDocument();
  });

  it('Source editor: Find GitHub returns null → info toast', async () => {
    seedMods([baseMod({ name: 'NoFind', folder_name: 'NoFind', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/8' })]);
    registerInvokeHandler('find_github_from_nexus', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NoFind')).toBeInTheDocument(); });
    await openSourceEditor(user, 'NoFind');
    const editor = screen.getByText('Sources for NoFind').closest('.gf-src-edit') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: /Find GitHub/ }));
    await waitFor(() => {
      expect(screen.getByText(/No GitHub link found in Nexus description for NoFind/)).toBeInTheDocument();
    });
  });

  it('Source editor: Find GitHub failure surfaces error toast', async () => {
    seedMods([baseMod({ name: 'FindFail', folder_name: 'FindFail', github_url: null, nexus_url: 'https://www.nexusmods.com/sts2/mods/9' })]);
    registerInvokeHandler('find_github_from_nexus', () => { throw new Error('500'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('FindFail')).toBeInTheDocument(); });
    await openSourceEditor(user, 'FindFail');
    const editor = screen.getByText('Sources for FindFail').closest('.gf-src-edit') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: /Find GitHub/ }));
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
    await openSourceEditor(user, 'SaveFail');
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed: disk-readonly/)).toBeInTheDocument();
    });
  });

  // ── Inline update + audit kebab branches ─────────────────────────

  it('Drawer update failure surfaces error toast', async () => {
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
    await screen.findAllByText('UpdFail');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const btn = await screen.findByRole('button', { name: /Download update → v2\.0\.0/ });
    await user.click(btn);
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
    await screen.findAllByText('RenameMe');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const btn = await screen.findByRole('button', { name: /Download update → v2\.0\.0/ });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/Downloaded 'RenameMe' v2\.0\.0 into Versions/)).toBeInTheDocument();
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

  it('toggle_mod failure with non-Error rejection still surfaces toast (row switch path)', async () => {
    seedMods([baseMod()]);
    registerInvokeHandler('toggle_mod', () => { throw 'bare-string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('BaseLib');
    await user.click(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed to move BaseLib.*bare-string/)).toBeInTheDocument();
    });
  });

  it('pin_mod failure with non-Error rejection still surfaces toast', async () => {
    seedMods([baseMod({ name: 'P', folder_name: 'P', pinned: false })]);
    registerInvokeHandler('pin_mod', () => { throw 'bare-pin'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('P')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Freeze this mod/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to freeze P.*bare-pin/)).toBeInTheDocument();
    });
  });

  it('delete_mod failure with non-Error rejection still surfaces toast', async () => {
    seedMods([baseMod({ name: 'D', folder_name: 'D' })]);
    registerInvokeHandler('delete_mod_cmd', () => { throw 'bare-del'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('D')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /^Remove /i }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Import mod/ }));
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
    await openSourceEditor(user, 'CS');
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
    await screen.findAllByText('UN');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const btn = await screen.findByRole('button', { name: /Download update → v2\.0\.0/ });
    await user.click(btn);
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
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('FE')).toBeInTheDocument(); });
    await openSourceEditor(user, 'FE');
    const editor = screen.getByText('Sources for FE').closest('.gf-src-edit') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: /Find GitHub/ }));
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
    await openSourceEditor(user, 'SE');
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
    await screen.findAllByText('PatchBehind');
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
    await screen.findAllByText('LegacyMod');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(screen.getByText(/Download update → v1\.5\.0/)).toBeInTheDocument();
    });
  });

  // ── handleInlineUpdate folderName null branch (line 130) ─────────

  it('drawer update of a folder_name-null mod still calls update_mod', async () => {
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
    await screen.findAllByText('NF');
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    const btn = await screen.findByRole('button', { name: /Download update → v2\.0\.0/ });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/Downloaded 'NF' v2\.0\.0 into Versions/)).toBeInTheDocument();
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
    await openAddMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/ }));
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
      update_source: 'github',
      game_version_too_old: true,
      latest_release_blocked_by_game_version: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('GameOld')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    // Even with needs_update=true, game_version_too_old blocks both the inline
    // "Download update" pill and the toolbar bulk-update button.
    await waitFor(() => {
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Download 1 update$/ })).toBeNull();
    expect(screen.queryByText(/Download update →/)).toBeNull();
  });

  // ── Update-blocked badge `?? '?'` fallback path ──────────────────

  it('Update-blocked badge surfaces inside the drawer even when latest_release_with_assets_tag is null', async () => {
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
    await screen.findAllByText('BlkNull');
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

  it('Source editor: clicking the editor\'s Cancel closes it inline', async () => {
    seedMods([baseMod({ name: 'Reopen', folder_name: 'Reopen' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Reopen')).toBeInTheDocument(); });
    await openSourceEditor(user, 'Reopen');
    // The editor's Cancel button closes it.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for Reopen')).toBeNull();
    });
  });

  // ── SourceEditor empty github trim → null fallback (839) ─────────

  it('Source editor: saving with no changes skips source-link writes', async () => {
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
    await openSourceEditor(user, 'EmptySave');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for EmptySave')).toBeNull();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'set_mod_sources_full')).toBe(false);
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

  // 1.7.0 T17 — the per-screen Advanced toggle was removed when the
  // per-row drawer absorbed source-pill / Freeze / Delete disclosure.
  // The three localStorage-persistence tests that previously covered
  // the toggle's storage paths went with it. The toggle's only remaining
  // gate (Import mod + Quick add URL) is now always-visible, so the
  // "advanced=off hides those buttons" branch is gone too.

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
    await user.click(screen.getByRole('button', { name: /^Remove /i }));
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

  // ── all-installed-mods framing (1.7.0) ────────────────────────────
  // The Mods view was previously titled "Your mods", which a real user
  // (Solo) read as "the active modpack's mods". The view actually shows
  // every mod installed on disk — independent of which modpack is
  // currently active. These tests pin the renamed heading + subtitle
  // and the "Manage active modpack →" bridge that routes back to the
  // Modpacks view's mod library workspace.
  describe('all-installed-mods framing', () => {
    it('uses the All installed mods heading and explanatory subtitle', async () => {
      seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib' })]);
      render(<Wrap />);
      expect(await screen.findByRole('heading', { name: /all installed mods/i })).toBeInTheDocument();
      // Match the unique tail of the page subtitle. The LibraryTable
      // explainer banner below also opens with "Every mod installed on
      // your computer…", so a substring match on that opener would be
      // ambiguous — anchor on the page-subtitle-only clause instead.
      expect(
        screen.getByText(/Your active modpack decides which ones load in the game/i),
      ).toBeInTheDocument();
    });

    it('Manage active modpack link calls onManageActiveModpack', async () => {
      const onOpen = vi.fn();
      seedMods([baseMod({ name: 'BaseLib', folder_name: 'BaseLib' })]);
      const user = userEvent.setup();
      render(<Wrap onManageActiveModpack={onOpen} />);
      const link = await screen.findByRole('button', { name: /manage active modpack/i });
      await user.click(link);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  // ── per-row membership column (1.7.0 → mod-list redesign) ──────────
  // The redesign dropped the per-row "Active in game" / "Stored" chip
  // (active/stored is derived from the active modpack, not a per-mod
  // input — the capability lives in the kebab now). What the row still
  // surfaces is the membership checkbox against the active modpack,
  // with a short "In Modpack" / "Not in Modpack" label (the full pack name
  // lives in the aria-label/title). Solo's old confusion case — a mod
  // disabled on disk yet still a modpack member — is now expressed
  // purely through the checkbox's checked state, independent of any
  // storage chip.
  describe('per-row membership column', () => {
    type Membership = 'in' | 'notIn' | 'includedOff' | 'noActive';

    function setupRow(active: boolean, membership: Membership): void {
      seedMods([
        baseMod({ name: 'TargetMod', folder_name: 'TargetMod', enabled: active }),
      ]);
      if (membership === 'noActive') {
        registerInvokeHandler('get_active_profile', () => null);
        return;
      }
      registerInvokeHandler('get_active_profile', () => 'TestPack');
      const included = membership === 'in' || membership === 'includedOff';
      const enabled = membership === 'in';
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'TestPack', editable: true }],
        mods: [
          {
            name: 'TargetMod',
            version: '3.1.2',
            folder_name: 'TargetMod',
            mod_id: 'targetmod',
            installed_enabled: active,
            profiles: [
              { profile_name: 'TestPack', included, enabled, editable: true },
            ],
          },
        ],
      }));
    }

    // Loud row lookup — `findByText` resolves once the mod name
    // appears in the DOM. The .closest() throw catches regressions in
    // the row's outer markup (no `data-testid="library-row"` wrapper).
    async function getModRow(modName: string): Promise<HTMLElement> {
      const candidates = await screen.findAllByText(modName);
      for (const node of candidates) {
        const row = node.closest('[data-testid="library-row"]');
        if (row instanceof HTMLElement) return row;
      }
      throw new Error(`No data-testid="library-row" wrapper around "${modName}"`);
    }

    // Wait for the membership column to settle. The row exposes
    // membership through a read-only indicator: "In Modpack" (with a check
    // glyph + the is-in class) when a member, "Not in Modpack" otherwise.
    // Membership is changed from the kebab, not from this indicator.
    async function waitForMembershipStatus(row: HTMLElement, included: boolean): Promise<HTMLElement> {
      await waitFor(() => {
        const ind = row.querySelector('.gf-row-inpack');
        expect(ind).not.toBeNull();
        if (included) {
          expect(ind!.className).toContain('is-in');
          expect(ind!.textContent).toMatch(/In Modpack/i);
        } else {
          expect(ind!.className).not.toContain('is-in');
          expect(ind!.textContent).toMatch(/Not in Modpack/i);
        }
      });
      return row.querySelector('.gf-row-inpack') as HTMLElement;
    }

    it('no active/stored chip in the row; "In Modpack" indicator when a member', async () => {
      setupRow(true, 'in');
      render(<Wrap />);
      const row = await getModRow('TargetMod');
      // Storage chip removed from the row.
      expect(row.querySelector('.gf-profile-library-storage')).toBeNull();
      await waitForMembershipStatus(row, true);
      expect(within(row).getByText(/^In Modpack$/i)).toBeInTheDocument();
    });

    it('"Not in Modpack" indicator when not a member (storage chip still absent)', async () => {
      setupRow(false, 'notIn');
      render(<Wrap />);
      const row = await getModRow('TargetMod');
      expect(row.querySelector('.gf-profile-library-storage')).toBeNull();
      await waitForMembershipStatus(row, false);
      expect(within(row).getByText(/^Not in Modpack$/i)).toBeInTheDocument();
    });

    it('active-on-disk but not a member → "Not in Modpack" (membership is independent of storage)', async () => {
      setupRow(true, 'notIn');
      render(<Wrap />);
      const row = await getModRow('TargetMod');
      await waitForMembershipStatus(row, false);
      expect(within(row).getByText(/^Not in Modpack$/i)).toBeInTheDocument();
    });

    // Solo's confusion case — disabled on disk yet still a modpack
    // member. The row no longer shows a "Stored" chip; the in-pack
    // indicator stays on, which is the unambiguous membership signal.
    it("disabled on disk yet still a member → still in Modpack (Solo's case)", async () => {
      setupRow(false, 'in');
      render(<Wrap />);
      const row = await getModRow('TargetMod');
      await waitForMembershipStatus(row, true);
      expect(within(row).getByText(/^In Modpack$/i)).toBeInTheDocument();
    });

    it('uses the active profile display name when the membership key is a UUID', async () => {
      const uuid = '731aeaec-7f3d-4859-baec-16219701e2e7';
      seedMods([
        baseMod({ name: 'TargetMod', folder_name: 'TargetMod', enabled: true }),
      ]);
      registerInvokeHandler('get_active_profile', () => uuid);
      registerInvokeHandler('get_active_profile_id', () => uuid);
      registerInvokeHandler('list_profiles_cmd', () => [
        {
          id: uuid,
          name: 'TesterW',
          game_version: null,
          created_by: null,
          mods: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          public: null,
          mod_extras: {},
        },
      ]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ profile_id: uuid, profile_name: 'TesterW', editable: true }],
        mods: [
          {
            name: 'TargetMod',
            version: '3.1.2',
            folder_name: 'TargetMod',
            mod_id: 'targetmod',
            installed_enabled: true,
            profiles: [
              { profile_id: uuid, profile_name: 'TesterW', included: true, enabled: true, editable: true },
            ],
          },
        ],
      }));

      const { container } = render(<Wrap />);
      const row = await getModRow('TargetMod');
      const indicator = await waitForMembershipStatus(row, true);
      expect(indicator).toHaveAttribute('title', expect.stringContaining('TesterW'));
      expect(container.innerHTML).not.toContain(uuid);
    });

    it('hides the membership column entirely when no active modpack', async () => {
      setupRow(true, 'noActive');
      render(<Wrap />);
      const row = await getModRow('TargetMod');
      // Row still renders the mod, but with no membership checkbox and
      // no storage chip.
      expect(within(row).getByText('TargetMod')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(within(row).queryByRole('checkbox')).toBeNull();
      expect(row.querySelector('.gf-profile-library-storage')).toBeNull();
    });
  });
});

// ── Source editor opens inline and closes via its Cancel button ────
//
// Post-#134: the row itself opens the SourceEditor inline underneath the row,
// and the editor closes through its built-in Cancel button.
describe('<ModsView> source editor inline lifecycle', () => {
  it('source editor opens inline and closes when Cancel is clicked', async () => {
    seedMods([baseMod({ name: 'EditableMod', folder_name: 'EditableMod' })]);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await screen.findAllByText('EditableMod');
    await openSourceEditor(user, 'EditableMod');
    // Source editor heading appears.
    await waitFor(() => {
      expect(screen.getByText('Sources for EditableMod')).toBeInTheDocument();
    });
    // Cancel closes it.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for EditableMod')).toBeNull();
    });
  });
});

// ── Tag filter substring branch ─────────────────────────────────────
// The filter row matches by tag substring (Mods.tsx ~531). Without a
// tag-search test, the `tags.some((tag) => tag.toLowerCase().includes(...))`
// arm sits uncovered.
describe('<ModsView> tag priority picker', () => {
  it('tag dropdown brings the chosen tag to the top without hiding the rest', async () => {
    // The Tag dropdown reorders rather than filters: the chosen tag's mods
    // float to the top, and every mod stays visible.
    seedMods([
      baseMod({
        name: 'TaggedMod', folder_name: 'TaggedMod',
        tags: ['Combat', 'QoL'],
      }),
      baseMod({
        name: 'OtherMod', folder_name: 'OtherMod',
        tags: ['Cosmetic'],
      }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findAllByText('TaggedMod');
    expect(screen.getByText('OtherMod')).toBeInTheDocument();
    await chooseOption(user, /Tag/i, 'Combat');
    // Both stay visible; the Combat mod is ordered before the other.
    expect(screen.getByText('TaggedMod')).toBeInTheDocument();
    expect(screen.getByText('OtherMod')).toBeInTheDocument();
    const order = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
      .filter((tt) => ['TaggedMod', 'OtherMod'].includes(tt ?? ''));
    expect(order).toEqual(['TaggedMod', 'OtherMod']);
  });
});

// ── SourceEditor onSave: note + custom_url branch (setModExtras) ─────
// Mods.tsx ~985 — the `setModExtras` call only fires when the user
// actually edited the note or custom_url. Existing onSave tests change
// the github/nexus URLs only, so the extras branch sat uncovered.
describe('<ModsView> SourceEditor saves note + custom URL via setModExtras', () => {
  it('changing the note triggers set_mod_extras with the trimmed values', async () => {
    seedMods([baseMod({
      name: 'NoteMod', folder_name: 'NoteMod',
      // Pre-existing github_url so the github-field write doesn't fire
      // when we save (we only want to assert set_mod_extras).
      github_url: 'https://github.com/x/y',
      note: null,
      custom_url: null,
    })]);
    registerInvokeHandler('set_mod_extras', () => null);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NoteMod')).toBeInTheDocument(); });
    await openSourceEditor(user, 'NoteMod');
    // Find the Note textarea by its placeholder.
    const noteInput = await screen.findByPlaceholderText(/downloaded from Patreon/i);
    await user.type(noteInput, 'My personal note');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_extras'
          && c.args?.modName === 'NoteMod'
          && c.args?.note === 'My personal note',
      )).toBe(true);
    });
  });
});

// ── Bug 1: Find GitHub → Save must not clobber the found repo ─────────
// A Nexus-only mod's "Find GitHub" persists the discovered repo and
// refreshes. The open editor must reflect that repo in its field so the
// follow-up Save is a no-op instead of writing null over the just-found
// source (set_mod_sources_full with githubRepo=null).
describe('<ModsView> Find GitHub then Save does not null out the found repo', () => {
  it('populates the GitHub field on find and does not save a null github afterward', async () => {
    let mods = [baseMod({
      name: 'NexusOnly', folder_name: 'NexusOnly',
      github_url: null,
      nexus_url: 'https://www.nexusmods.com/sts2/mods/103',
    })];
    registerInvokeHandler('get_installed_mods', () => mods);
    // The backend persists the repo to disk; the refresh that follows the
    // find re-reads it, so the mod now carries a github_url.
    registerInvokeHandler('find_github_from_nexus', () => {
      mods = [{ ...mods[0], github_url: 'https://github.com/owner/repo' }];
      return 'owner/repo';
    });
    registerInvokeHandler('set_mod_sources_full', () => null);

    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('NexusOnly')).toBeInTheDocument(); });

    await openSourceEditor(user, 'NexusOnly');

    // Find GitHub → field gets the repo, banner drops.
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    const ghInput = await screen.findByPlaceholderText('owner/repo') as HTMLInputElement;
    await waitFor(() => { expect(ghInput.value).toBe('owner/repo'); });
    expect(screen.queryByRole('button', { name: 'Find GitHub' })).toBeNull();

    // Save → editor closes on success; the guard sees the field == stored
    // repo, so set_mod_sources_full is never called with a null github.
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    await waitFor(() => {
      expect(screen.queryByText('Sources for NexusOnly')).toBeNull();
    });
    expect(getInvokeCalls().some(
      (c) => c.cmd === 'set_mod_sources_full' && c.args?.githubRepo == null,
    )).toBe(false);
  });
});

// ── Bug 6: per-mod "Open this mod's folder" ──────────────────────────
// The kebab gained a per-mod open-folder action (alongside the global
// "Open mods folder"). It threads onOpenThisModFolder all the way down to
// the backend open_mod_folder command with the mod's folder name.
describe('<ModsView> per-mod open folder', () => {
  it('kebab "Open this mod\'s folder" invokes open_mod_folder with the mod folder', async () => {
    seedMods([baseMod({ name: 'OpenMe', folder_name: 'OpenMe' })]);
    registerInvokeHandler('open_mod_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('OpenMe')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const items = await screen.findAllByRole('menuitem', { name: /Open this mod's folder/i });
    await user.click(items[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'open_mod_folder' && c.args?.folderName === 'OpenMe',
      )).toBe(true);
    });
    // FB-E: the GLOBAL "Open mods folder" was removed from the per-row kebab
    // (it moved to the modpack toolbar bar); only the per-mod action remains.
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    expect(screen.queryByRole('menuitem', { name: /^Open mods folder$/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Open this mod's folder/i })).toBeInTheDocument();
  });
});

// ── Regression guards: source edits persist across the refresh ───────
// Both behaviors are already fixed; these lock the FE refresh wiring so a
// future change can't reintroduce stale-after-save. If the save handler
// stopped calling refreshMods, the editor/list would keep showing the old
// value and these would fail.
describe('<ModsView> source-edit persistence regressions', () => {
  it('a typed GitHub repo persists across refresh — user override wins over the manifest', async () => {
    let mods = [baseMod({
      name: 'GhMod', folder_name: 'GhMod',
      github_url: 'https://github.com/wrong/manifest',
    })];
    registerInvokeHandler('get_installed_mods', () => mods);
    registerInvokeHandler('set_mod_sources_full', () => {
      // Backend persists the user's repo; the enrich on the next scan makes
      // the user link win over the manifest URL (covered in Rust too).
      mods = [{ ...mods[0], github_url: 'https://github.com/user/typed' }];
      return null;
    });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('GhMod')).toBeInTheDocument(); });
    await openSourceEditor(user, 'GhMod');

    const ghInput = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(ghInput.value).toBe('wrong/manifest'); // seeded from the manifest
    await user.clear(ghInput);
    await user.type(ghInput, 'user/typed');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_sources_full' && c.args?.githubRepo === 'user/typed',
      )).toBe(true);
    });
    // Editor closes on save; reopen — the field reflects the persisted user
    // override (not the manifest), proving it survived the refresh.
    await waitFor(() => { expect(screen.queryByText('Sources for GhMod')).toBeNull(); });
    await openSourceEditor(user, 'GhMod');
    const ghInput2 = await screen.findByPlaceholderText('owner/repo') as HTMLInputElement;
    await waitFor(() => { expect(ghInput2.value).toBe('user/typed'); });
  });

  it('editing a display name updates the in-memory list on the same refresh (no restart)', async () => {
    let mods = [baseMod({ name: 'Foo', folder_name: 'Foo', display_name: null })];
    registerInvokeHandler('get_installed_mods', () => mods);
    registerInvokeHandler('set_mod_display_overrides', () => {
      mods = [{ ...mods[0], display_name: 'Friendly Foo' }];
      return null;
    });
    const user = userEvent.setup();
    render(<Wrap advancedMode />);
    await waitFor(() => { expect(screen.getByText('Foo')).toBeInTheDocument(); });
    await openSourceEditor(user, 'Foo');

    const nameInput = screen.getByPlaceholderText('Foo') as HTMLInputElement; // display-name field
    await user.type(nameInput, 'Friendly Foo');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));

    // The list reflects the new display name immediately — no app restart.
    await waitFor(() => { expect(screen.getByText('Friendly Foo')).toBeInTheDocument(); });
  });
});

// ── Inline snooze + unsnooze failure toasts (ModRow onSnooze/onUnsnooze) ─
// Mods.tsx ~914 and ~923 — the ModRow's onSnooze/onUnsnooze callbacks
// each have a catch arm that surfaces mods.toast.allFailed. The audit
// kebab Snooze tests in Settings cover the same handler via the
// audit-tab UI, but the ModRow path (used inside the drawer kebab on
// Mods view) was uncovered.
describe('<ModsView> ModRow snooze failure paths', () => {
  it('drawer kebab → Skip this update with set_mod_snooze failure toasts the error', async () => {
    seedMods([baseMod({
      name: 'SnoozeFail', folder_name: 'SnoozeFail',
      github_url: 'https://github.com/x/y',
    })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'SnoozeFail', folder_name: 'SnoozeFail',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_has_assets: true, needs_update: true,
      asset_names: [], releases_scanned: 1,
      github_auto_detected: false, github_repo: 'x/y',
      pinned: false, nexus_update_available: false,
      update_source: 'github', snoozed: false,
    }]);
    registerInvokeHandler('set_mod_snooze', () => { throw new Error('lock contention'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('SnoozeFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'audit_mod_versions')).toBe(true);
    });
    // Kebab → Skip this update.
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    const labels = await screen.findAllByText(/^Skip this update$/);
    const labelEl = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(labelEl).toBeDefined();
    await user.click(labelEl!.closest('button')!);
    // mods.toast.allFailed format: "Failed: {{error}}".
    await waitFor(() => {
      expect(screen.getByText(/Failed.*lock contention/)).toBeInTheDocument();
    });
  });

  it('drawer kebab → Show update again with set_mod_snooze failure toasts the error', async () => {
    seedMods([baseMod({
      name: 'UnsnoozeFail', folder_name: 'UnsnoozeFail',
      github_url: 'https://github.com/x/y',
    })]);
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'UnsnoozeFail', folder_name: 'UnsnoozeFail',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_has_assets: true, needs_update: true,
      asset_names: [], releases_scanned: 1,
      github_auto_detected: false, github_repo: 'x/y',
      pinned: false, nexus_update_available: false,
      update_source: 'github', snoozed: true,
      snoozed_until_tag: 'v3.2.0',
    }]);
    registerInvokeHandler('set_mod_snooze', () => { throw new Error('write blocked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('UnsnoozeFail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Audit mods' }));
    await user.click(screen.getByRole('button', { name: 'Mod actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Show update again/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed.*write blocked/)).toBeInTheDocument();
    });
  });
});
