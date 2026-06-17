/**
 * ModpackDetail tests — the inline detail view that replaces the modpack
 * list area when a card is clicked (1.7.0 T16).
 *
 * 1.8.x unification: the "In this modpack" section now renders the SAME
 * rich LibraryTable rows as the All Mods view (toggle / source badges /
 * kebab / delete / inline source editor / drag-reorder), filtered to this
 * pack's members. The shared mod-library toolbar (Open folder / Import /
 * Quick add / Auto-detect / Audit / Refresh) sits at the top, and "Add
 * from your Library" is a collapsed-by-default section of simpler add-only
 * rows. Deep per-row behavior (toggle, kebab remove + active-pack coupling)
 * is covered in LibraryTable.test.tsx; here we test the layout, the
 * sections, and the wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModpackDetail } from './ModpackDetail';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { AUTO_ADD_INSTALLS_TO_MODPACK_KEY } from '../lib/installPolicy';
import type { ModInfo, Profile, ProfileMod, ShareResult } from '../types';
import type { ProfileDrift } from '../hooks/useTauri';

function Wrap(props: React.ComponentProps<typeof ModpackDetail>) {
  return (
    <AllProviders>
      <ModpackDetail {...props} />
    </AllProviders>
  );
}

const profileMod = (overrides: Partial<ProfileMod> = {}): ProfileMod =>
  ({
    name: 'PackMod',
    version: '1.0',
    source: null,
    hash: null,
    files: [],
    enabled: true,
    bundle_url: null,
    folder_name: 'PackMod',
    // Defaults to the (possibly overridden) name so two fixtures with
    // different names don't accidentally collide on a literal shared
    // mod_id default — that would make drift-tolerant identity matching
    // (issue #174) see them as the same mod.
    mod_id: overrides.name ?? 'PackMod',
    ...overrides,
  });

const modInfo = (overrides: Partial<ModInfo> = {}): ModInfo =>
  ({
    name: 'LibMod',
    version: '2.0',
    description: '',
    enabled: false,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    github_url: null,
    nexus_url: null,
    folder_name: 'LibMod',
    // See profileMod() above — derive from name to avoid cross-fixture
    // mod_id collisions under drift-tolerant identity matching.
    mod_id: overrides.name ?? 'LibMod',
    pinned: false,
    ...overrides,
  });

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'Sample',
    mods: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    game_version: '0.105.0',
    ...overrides,
  } as Profile);

const baseProps = () => ({
  profile: baseProfile(),
  onBack: vi.fn(),
});

/** Install the given mods into AppContext via get_installed_mods. */
function installMods(mods: ModInfo[]) {
  registerInvokeHandler('get_installed_mods', () => mods);
}

/**
 * Wire up both AppContext (get_installed_mods) AND the membership grid
 * (get_profile_memberships) so the in-pack LibraryTable renders. Returns
 * the profile to pass in (its `mods` mirror the in-pack set).
 */
function setupPack(opts: {
  inPack?: ModInfo[];
  available?: ModInfo[];
  packName?: string;
}): Profile {
  const packName = opts.packName ?? 'Sample';
  const inPack = opts.inPack ?? [];
  const available = opts.available ?? [];
  installMods([...inPack, ...available]);
  registerInvokeHandler('get_profile_memberships', () => ({
    profiles: [{ name: packName, editable: true }],
    mods: [...inPack, ...available].map((m) => {
      const included = inPack.some((p) => (p.folder_name ?? p.name) === (m.folder_name ?? m.name));
      return {
        name: m.name,
        version: m.version,
        folder_name: m.folder_name,
        mod_id: m.mod_id,
        installed_enabled: m.enabled,
        profiles: [{ profile_name: packName, included, enabled: included, editable: true }],
      };
    }),
  }));
  return baseProfile({
    name: packName,
    mods: inPack.map((m) =>
      profileMod({ name: m.name, folder_name: m.folder_name, mod_id: m.mod_id, version: m.version }),
    ),
  });
}

/** Open the "+ Add mods" dropdown (install actions live inside it now). */
async function openAddMods(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Add mods/i }));
}

/** The "Add from your Library" section is collapsed by default; expand it
 *  so its rows are in the DOM. Returns the section element. */
async function expandLibrary(user: ReturnType<typeof userEvent.setup>) {
  const available = await screen.findByTestId('modpack-detail-available');
  await user.click(
    within(available).getByRole('button', { name: /Add from Mod Library/i }),
  );
  return available;
}

describe('<ModpackDetail>', () => {
  it('in-pack rich rows show fresh installed ModInfo version when the membership grid is stale', async () => {
    const fresh = modInfo({
      name: 'Unified Save Path',
      version: '1.1.3',
      folder_name: 'UnifiedSavePath',
      mod_id: 'UnifiedSavePath',
      enabled: true,
    });
    installMods([fresh]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [
        {
          name: 'Unified Save Path',
          version: '1.0.0',
          folder_name: 'UnifiedSavePath',
          mod_id: 'UnifiedSavePath',
          installed_enabled: true,
          profiles: [{ profile_name: 'Sample', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    const profile = baseProfile({
      name: 'Sample',
      mods: [
        profileMod({
          name: 'Unified Save Path',
          version: '1.0.0',
          folder_name: 'UnifiedSavePath',
          mod_id: 'UnifiedSavePath',
        }),
      ],
    });

    render(<Wrap profile={profile} onBack={vi.fn()} />);

    expect(await screen.findByText('v1.1.3')).toBeInTheDocument();
    expect(screen.queryByText('v1.0.0')).not.toBeInTheDocument();
  });

  // ── Unified search (Solo FR, 2026-06-10) ──────────────────────────
  it('typing in the in-pack search auto-opens and filters Add-from-Library, matching tags', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod', enabled: true })],
      available: [
        modInfo({ name: 'WaifuOverhaul', folder_name: 'WaifuOverhaul', tags: ['anime'] }),
        modInfo({ name: 'PlainUtility', folder_name: 'PlainUtility' }),
      ],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    // One query, both sections: type a TAG into the in-pack table's search.
    const search = await screen.findByLabelText('Search mod library');
    await user.type(search, 'anime');
    // The Add-from-Library section pops open by itself and is filtered to
    // the tag match — no second search box, no manual expanding.
    const available = await screen.findByTestId('modpack-detail-available');
    await waitFor(() => {
      expect(within(available).getByText('WaifuOverhaul')).toBeInTheDocument();
    });
    expect(within(available).queryByText('PlainUtility')).toBeNull();
    // And the in-pack rows are filtered by the same query (PackMod has no
    // matching tag, so the table reports no matches rather than ignoring it).
    expect(screen.getByText(/No matching mods/i)).toBeInTheDocument();
    // Clearing the search restores the unfiltered available list.
    await user.clear(search);
    await waitFor(() => {
      expect(within(available).getByText('PlainUtility')).toBeInTheDocument();
    });
  });

  // ── Header ────────────────────────────────────────────────────────
  it('renders the header row with name, Back button, and Switch button for inactive profile', async () => {
    const onBack = vi.fn();
    const onSwitch = vi.fn();
    render(
      <Wrap
        profile={baseProfile({ name: 'Sample' })}
        onBack={onBack}
        onSwitch={onSwitch}
      />,
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Sample' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    // Both the header CTA and the inactive-hint have a "Switch to" button for a non-active pack.
    expect(screen.getAllByRole('button', { name: /Switch to/i })).toHaveLength(2);
  });

  it('omits the Switch button when the modpack is already active', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    render(
      <Wrap
        profile={baseProfile({ name: 'Sample' })}
        onBack={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    const titleRow = (await screen.findByRole('heading', { level: 2, name: 'Sample' }))
      .closest('.gf-modpack-detail-title-row') as HTMLElement;
    // The ACTIVE badge sits next to the name (scoped so it doesn't match
    // the word "active" in the status line).
    expect(within(titleRow).getByText(/active/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/i })).toBeNull();
  });

  it('clicking Back fires onBack', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onBack={onBack} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Back to modpacks/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders Shared badge + Re-share in header when shareInfo is provided', async () => {
    const shareInfo: ShareResult = {
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      file_path: 'Sample.json',
      repo_url: 'https://github.com/alice/sts2mm-profiles',
      failed_uploads: [],
    };
    render(<Wrap {...baseProps()} shareInfo={shareInfo} onShare={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.getByText(/Shared/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-share/i })).toBeInTheDocument();
  });

  it('shows an out-of-sync banner for shared packs with unpublished changes', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    const shareInfo: ShareResult = {
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      file_path: 'Sample.json',
      repo_url: 'https://github.com/alice/sts2mm-profiles',
      failed_uploads: [],
      out_of_sync: true,
    };
    const profile = baseProfile({ name: 'Sample' });
    render(<Wrap profile={profile} onBack={vi.fn()} shareInfo={shareInfo} onShare={onShare} />);
    expect(await screen.findByRole('status', { name: /out of sync/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Re-share to push/i }));
    expect(onShare).toHaveBeenCalledWith(profile);
  });

  it('does not show the out-of-sync banner for current shared packs', async () => {
    const shareInfo: ShareResult = {
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      file_path: 'Sample.json',
      repo_url: 'https://github.com/alice/sts2mm-profiles',
      failed_uploads: [],
      out_of_sync: false,
    };
    render(<Wrap {...baseProps()} shareInfo={shareInfo} onShare={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByRole('status', { name: /out of sync/i })).toBeNull();
  });

  it('consolidates the install actions into the "+ Add mods" dropdown', async () => {
    const profile = setupPack({ inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })] });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Hidden until the dropdown is opened.
    expect(screen.queryByRole('menuitem', { name: /Quick add URL/i })).toBeNull();
    await openAddMods(user);
    expect(screen.getByRole('menuitem', { name: /Quick add URL/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Import mod/i })).toBeInTheDocument();
    // FB3: "Open mods folder" was removed from this dropdown (it lives on the
    // bulk-action bar now), so it must NOT be here.
    expect(screen.queryByRole('menuitem', { name: /Open mods folder/i })).toBeNull();
    // Auto-detect sources is NOT an install action — it lives in the header
    // "Advanced actions" kebab, not this dropdown.
    expect(screen.queryByRole('menuitem', { name: /Auto-detect sources/i })).toBeNull();
  });

  it('status line counts active mods in THIS pack, not the whole library', async () => {
    // Library has 5 installed mods; the pack contains 4 of them, 3 enabled.
    // The status line must read against the pack — never the 5-mod library.
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'A', folder_name: 'A', mod_id: 'A', enabled: true }),
      modInfo({ name: 'B', folder_name: 'B', mod_id: 'B', enabled: false }),
      modInfo({ name: 'C', folder_name: null, mod_id: 'C', enabled: true }),
      modInfo({ name: 'D', folder_name: null, mod_id: null, enabled: true }),
      // A library extra NOT in the pack — must not inflate the active count.
      modInfo({ name: 'X', folder_name: 'X', mod_id: 'X', enabled: true }),
    ]);
    const profile = baseProfile({
      name: 'MyPack',
      mods: [
        profileMod({ name: 'A', folder_name: 'A', mod_id: 'A' }),
        profileMod({ name: 'B', folder_name: 'B', mod_id: 'B' }),
        profileMod({ name: 'C', folder_name: null, mod_id: 'C' }),
        profileMod({ name: 'D', folder_name: null, mod_id: null }),
      ],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'MyPack' });
    // A, C, D are enabled AND in the pack → 3 active of 4; library size (5) ignored.
    expect(screen.getByText(/3 active \/ 4 mods in this modpack/i)).toBeInTheDocument();
    expect(screen.queryByText(/in library/i)).toBeNull();
  });

  it('counts a reinstalled mod with a stale folder_name as active when its mod_id matches an enabled install (#174)', async () => {
    // The pack entry was saved with folder_name "OldFolder" (from the
    // original install). The curator deleted + reinstalled the mod and it
    // now lives on disk as "NewFolder-v2" — a different folder_name, but the
    // SAME mod_id (from the mod's manifest) and the same display name. The
    // old folder-precedence key (folder_name ?? mod_id ?? name) would have
    // compared "OldFolder" against "NewFolder-v2" and missed this entirely;
    // the new matcher resolves it via the shared mod_id, and the header
    // counter must agree.
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({
        name: 'Reinstalled Mod',
        folder_name: 'NewFolder-v2',
        mod_id: 'stable-mod-id',
        enabled: true,
      }),
      modInfo({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod', enabled: true }),
    ]);
    const profile = baseProfile({
      name: 'DriftPack',
      mods: [
        // Stale: saved folder_name no longer exists on disk, but the
        // mod_id still matches "Reinstalled Mod" above.
        profileMod({ name: 'Reinstalled Mod', folder_name: 'OldFolder', mod_id: 'stable-mod-id' }),
        profileMod({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod' }),
      ],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'DriftPack' });
    // Both entries resolve to an enabled installed mod → 2 active / 2.
    expect(screen.getByText(/2 active \/ 2 mods in this modpack/i)).toBeInTheDocument();
  });

  it('does not count a reinstalled mod as active when neither folder_name nor mod_id intersect, even with the same name (#174)', async () => {
    // Both sides have strong keys (folder_name + mod_id), but none of them
    // intersect — only the display name matches. Per the backend matcher,
    // a strong-key set on both sides takes precedence over the name, so
    // this must NOT be treated as the same mod (two different mods can
    // share a display name). This guards against "fixing" the matcher to
    // let the name always win.
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({
        name: 'Reinstalled Mod',
        folder_name: 'NewFolder-v2',
        mod_id: 'new-mod-id',
        enabled: true,
      }),
      modInfo({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod', enabled: true }),
    ]);
    const profile = baseProfile({
      name: 'NoMatchPack',
      mods: [
        // Different folder_name AND different mod_id from the installed
        // "Reinstalled Mod" above — only the name coincides.
        profileMod({ name: 'Reinstalled Mod', folder_name: 'OldFolder', mod_id: 'old-mod-id' }),
        profileMod({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod' }),
      ],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'NoMatchPack' });
    // Only "Stable Mod" resolves to an enabled install → 1 active / 2.
    expect(screen.getByText(/1 active \/ 2 mods in this modpack/i)).toBeInTheDocument();
  });

  it('does not count a genuinely missing or disabled pack entry as active', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod', enabled: true }),
      // Installed but disabled — must not count toward "active".
      modInfo({ name: 'Disabled Mod', folder_name: 'DisabledMod', mod_id: 'DisabledMod', enabled: false }),
    ]);
    const profile = baseProfile({
      name: 'PartialPack',
      mods: [
        profileMod({ name: 'Stable Mod', folder_name: 'StableMod', mod_id: 'StableMod' }),
        profileMod({ name: 'Disabled Mod', folder_name: 'DisabledMod', mod_id: 'DisabledMod' }),
        // Not installed at all anymore (no matching identity in the library).
        profileMod({ name: 'Gone Mod', folder_name: 'GoneFolder', mod_id: 'gone-mod-id' }),
      ],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'PartialPack' });
    // Only "Stable Mod" is both present and enabled → 1 active / 3.
    expect(screen.getByText(/1 active \/ 3 mods in this modpack/i)).toBeInTheDocument();
  });

  it('does not show a reinstalled (drifted) mod in Add-from-library — it is already in the pack (#174)', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      // Same mod as the pack entry below, but reinstalled under a new
      // folder_name. The mod_id (from the manifest) and the display name
      // are unchanged, so the matcher recognizes it via the shared mod_id.
      modInfo({
        name: 'Reinstalled Mod',
        folder_name: 'NewFolder-v2',
        mod_id: 'stable-mod-id',
        enabled: true,
      }),
      // A genuinely-available library mod, unrelated to the pack.
      modInfo({ name: 'Extra Mod', folder_name: 'ExtraMod', mod_id: 'ExtraMod', enabled: true }),
    ]);
    const profile = baseProfile({
      name: 'DriftAddPack',
      mods: [
        // Stale: saved folder_name no longer exists on disk, but the
        // mod_id still matches the install above.
        profileMod({ name: 'Reinstalled Mod', folder_name: 'OldFolder', mod_id: 'stable-mod-id' }),
      ],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'DriftAddPack' });

    const available = await expandLibrary(user);
    // "Extra Mod" is genuinely available.
    expect(within(available).getByText('Extra Mod')).toBeInTheDocument();
    // "Reinstalled Mod" must NOT appear as available — it's already in the
    // pack under its new folder_name (matched via the shared mod_id).
    expect(within(available).queryByText('Reinstalled Mod')).toBeNull();
  });

  it('the Audit action checks ONLY this pack\'s mods (scoped audit)', async () => {
    const profile = setupPack({
      inPack: [
        modInfo({ name: 'PackA', folder_name: 'PackA' }),
        modInfo({ name: 'PackB', folder_name: 'PackB' }),
      ],
      available: [modInfo({ name: 'OutsiderMod', folder_name: 'OutsiderMod' })],
    });
    registerInvokeHandler('audit_mod_versions', () => []);
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Audit is the updates pill in the section header.
    await user.click(screen.getByRole('button', { name: /Check for updates/i }));

    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'audit_mod_versions');
      expect(call).toBeDefined();
      // Scoped to the pack's two mods, not the outsider.
      expect((call?.args?.only as string[]).sort()).toEqual(['PackA', 'PackB']);
    });
  });

  // ── Two-section layout ────────────────────────────────────────────
  it('Section 1 lists the pack mods and Section 2 lists installed mods not in the pack', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });

    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    expect((await within(inPack).findAllByText('PackMod')).length).toBeGreaterThan(0);
    expect(within(inPack).queryByText('LibMod')).toBeNull();

    const available = await expandLibrary(user);
    expect(within(available).getByText('LibMod')).toBeInTheDocument();
    expect(within(available).queryByText('PackMod')).toBeNull();
  });

  it('in-pack rows are the rich LibraryTable rows (toggle + kebab) on the ACTIVE pack', async () => {
    // The active/stored toggle only shows for the active pack (in-game state
    // is meaningful only there), so mark Sample active to see the switch.
    registerInvokeHandler('get_active_profile', () => 'Sample');
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    // Rich row markers: the per-row "Mod actions" kebab and the active/stored
    // switch — the same controls the Mod Library rows use.
    await waitFor(() => {
      expect(within(inPack).getByRole('button', { name: /Mod actions/i })).toBeInTheDocument();
    });
    expect(await within(inPack).findByRole('switch')).toBeInTheDocument();
  });

  it('omits the active/stored toggle for a NON-active modpack', async () => {
    // A non-active pack's members aren't loaded in game, so the in-game toggle
    // would be misleading — it's omitted (no get_active_profile → not active).
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await within(inPack).findByText('PackMod');
    // Kebab/actions remain, but there's no in-game switch on a non-active pack.
    expect(within(inPack).getByRole('button', { name: /Mod actions/i })).toBeInTheDocument();
    expect(within(inPack).queryByRole('switch')).toBeNull();
  });

  it('the in-pack rows have no inline drag handle (reorder is the Load order modal)', async () => {
    const profile = setupPack({
      inPack: [
        modInfo({ name: 'First', folder_name: 'First' }),
        modInfo({ name: 'Second', folder_name: 'Second' }),
      ],
    });
    const { container } = render(<Wrap profile={profile} onBack={vi.fn()} onOpenLoadOrder={vi.fn()} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    // The HTML5 drag handle was removed — it never worked in the webview.
    // Reordering is the Load order modal. (Use the per-row kebab as the
    // "rows rendered" proxy — the in-game switch only shows on the active
    // pack, and this pack isn't active.)
    await waitFor(() => {
      expect(within(inPack).getAllByRole('button', { name: /Mod actions/i }).length).toBeGreaterThan(0);
    });
    expect(container.querySelector('.gf-load-order-drag')).toBeNull();
    expect(within(inPack).getByRole('button', { name: /Load order/i })).toBeInTheDocument();
  });

  it('the modpack rows drop the redundant In-Modpack badge and show a Remove action', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
    });
    const { container } = render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByTestId('modpack-detail-in-pack');
    // Visible "Remove from pack" button on the row…
    await waitFor(() => {
      expect(container.querySelector('.gf-row-remove')).not.toBeNull();
    });
    // …and no "In Modpack" indicator (redundant here) and no disk-delete
    // trash on the row (that moved into the kebab).
    expect(container.querySelector('.gf-row-inpack')).toBeNull();
    expect(container.querySelector('.gf-row-delete')).toBeNull();
  });

  it('the Add-from-library section is collapsed by default and expands on click', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await screen.findByTestId('modpack-detail-available');
    expect(within(available).queryByText('LibMod')).toBeNull();
    expect(within(available).queryByTestId('modpack-mod-row-available')).toBeNull();
    const toggle = within(available).getByRole('button', { name: /Add from Mod Library/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(available).getByText('LibMod')).toBeInTheDocument();
  });

  it('shows the empty in-pack message when the pack has no mods', async () => {
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(
      await screen.findByText(/No mods in this modpack yet/i),
    ).toBeInTheDocument();
  });

  it('hides Section 2 and shows the all-in-pack note when every installed mod is in the pack', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
    });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await waitFor(() => {
      expect(screen.queryByTestId('modpack-detail-available')).toBeNull();
    });
    expect(screen.getByTestId('modpack-detail-all-in-pack')).toBeInTheDocument();
  });

  it('available-row source badges derive from the matching installed ModInfo', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod', nexus_url: 'https://nexusmods.com/z' })],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    expect(within(available).getByText('Nexus')).toBeInTheDocument();
  });

  // ── Membership: Add (available section) ───────────────────────────
  it('Add on an available row calls set_profile_mod_membership with included=true', async () => {
    const profile = setupPack({
      available: [modInfo({
        name: 'LibMod',
        folder_name: 'LibMod',
        mod_id: 'LibMod',
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/1073',
      })],
    });
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} onLibraryChanged={onLibraryChanged} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership'),
      ).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'set_profile_mod_membership');
    expect(call?.args).toMatchObject({
      profileId: 'Sample',
      modName: 'LibMod',
      folderName: 'LibMod',
      modId: 'LibMod',
      included: true,
      sourceHint: 'https://www.nexusmods.com/slaythespire2/mods/1073',
    });
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
  });

  // ── Bug 2: adding from the library must not yank the scroll to the top ──
  // The available list shrinks on each add, so without a scroll pin the page
  // collapses upward and the user loses their place. handleAdd reuses the
  // same pinScroll safety net the LibraryTable rows already use.
  it('pins the scroll position when adding a mod from the library', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod', mod_id: 'PackMod' })],
      available: [
        modInfo({ name: 'LibA', folder_name: 'LibA', mod_id: 'LibA' }),
        modInfo({ name: 'LibB', folder_name: 'LibB', mod_id: 'LibB' }),
      ],
    });
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    const { container } = render(
      <AllProviders>
        <div data-scroller="yes">
          <ModpackDetail profile={profile} onBack={vi.fn()} />
        </div>
      </AllProviders>,
    );
    const available = await expandLibrary(user);

    // jsdom reports 0 layout, so fake a real scroll container around the
    // detail view so pinScroll can find it and engage.
    const scroller = container.querySelector('[data-scroller="yes"]') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    let scrollTopVal = 1800;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v; },
    });
    const realGCS = window.getComputedStyle.bind(window);
    const gcs = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((el: Element, pe?: string | null) =>
        (el === scroller
          ? ({ overflowY: 'auto' } as CSSStyleDeclaration)
          : realGCS(el, pe)));
    const rafCbs: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });

    try {
      await user.click(within(available).getAllByRole('button', { name: /^Add$/i })[0]);
      // Simulate the engine collapsing the list to the top mid-add…
      scrollTopVal = 0;
      // …the pin re-asserts the captured position on the following frames.
      let guard = 0;
      while (rafCbs.length && guard++ < 50) {
        rafCbs.shift()!(0);
      }
      expect(scrollTopVal).toBe(1800);
    } finally {
      gcs.mockRestore();
      raf.mockRestore();
    }
  });

  // ── Bug 5: the header count must reconcile with the on-disk scan ──────
  // profile.mods.length counts manifest membership; the in-pack list shows
  // mods actually on disk. When the manifest references mods that aren't
  // installed (drift.removed), the header surfaces "(N missing)" so the two
  // numbers stop disagreeing.
  it('shows "(N missing)" when the manifest references mods not installed on disk (Bug 5)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'OnDisk1', folder_name: 'OnDisk1', mod_id: 'OnDisk1' })],
    });
    const drift: ProfileDrift = {
      added: [],
      removed: ['Gone1', 'Gone2', 'Gone3'],
      toggled: [],
      version_changed: [],
      has_drift: true,
    };
    render(<Wrap profile={profile} onBack={vi.fn()} drift={drift} />);
    await waitFor(() => {
      expect(screen.getByText(/3 missing/)).toBeInTheDocument();
    });
  });

  it('the "(N missing)" indicator lists the missing mod names on hover (FB-D)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'OnDisk1', folder_name: 'OnDisk1', mod_id: 'OnDisk1' })],
    });
    const drift: ProfileDrift = {
      added: [],
      removed: ['Gone1', 'Gone2', 'Gone3'],
      toggled: [],
      version_changed: [],
      has_drift: true,
    };
    render(<Wrap profile={profile} onBack={vi.fn()} drift={drift} />);
    await waitFor(() => {
      expect(screen.getByText(/3 missing/)).toBeInTheDocument();
    });
    // The names are in the tooltip (present in the DOM, shown on hover/focus).
    expect(screen.getByText('Gone1')).toBeInTheDocument();
    expect(screen.getByText('Gone2')).toBeInTheDocument();
    expect(screen.getByText('Gone3')).toBeInTheDocument();
  });

  it('shows no missing indicator when nothing in the manifest is missing (Bug 5)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'OnDisk1', folder_name: 'OnDisk1', mod_id: 'OnDisk1' })],
    });
    const drift: ProfileDrift = {
      added: [],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: false,
    };
    render(<Wrap profile={profile} onBack={vi.fn()} drift={drift} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByText(/missing/i)).toBeNull();
  });

  // ── Bug 7 / FB-A: enable-all / disable-all scoped to THIS modpack ─────
  // Visible toolbar buttons that call set_profile_mods_enabled, which resolves
  // each manifest entry to its real on-disk mod backend-side (the manifest
  // folder_name can drift) — fixing the reported "mod not found in
  // mods_disabled" error from the old per-manifest-folder toggle loop.
  it('Enable all calls set_profile_mods_enabled with enabled=true (Bug 7 / FB-A)', async () => {
    const profile = setupPack({
      inPack: [
        modInfo({ name: 'PackA', folder_name: 'PackA', mod_id: 'PackA', enabled: false }),
        modInfo({ name: 'PackB', folder_name: 'PackB', mod_id: 'PackB', enabled: false }),
      ],
    });
    registerInvokeHandler('set_profile_mods_enabled', () => ({
      enabled: true, toggled: ['PackA', 'PackB'], missing: [], failed: [],
    }));
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findAllByText('PackA');
    await user.click(await screen.findByRole('button', { name: /^Enable all$/i }));
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'set_profile_mods_enabled');
      expect(call?.args).toMatchObject({ profileId: 'Sample', enabled: true });
    });
  });

  it('Disable all calls set_profile_mods_enabled with enabled=false (Bug 7 / FB-A)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackA', folder_name: 'PackA', mod_id: 'PackA', enabled: true })],
    });
    registerInvokeHandler('set_profile_mods_enabled', () => ({
      enabled: false, toggled: ['PackA'], missing: [], failed: [],
    }));
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findAllByText('PackA');
    await user.click(await screen.findByRole('button', { name: /^Disable all$/i }));
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'set_profile_mods_enabled');
      expect(call?.args).toMatchObject({ profileId: 'Sample', enabled: false });
    });
  });

  it('the modpack toolbar exposes a visible "Open mods folder" button (FB-E)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackA', folder_name: 'PackA', mod_id: 'PackA' })],
    });
    registerInvokeHandler('open_mods_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findAllByText('PackA');
    // A real toolbar button (not the AddModsMenu dropdown item, which is a
    // hidden menuitem) sits next to Enable all / Disable all.
    await user.click(screen.getByRole('button', { name: /^Open mods folder$/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
    });
  });

  it('Enable all surfaces mods that could not be toggled by name (FB-A/FB-C)', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackA', folder_name: 'PackA', mod_id: 'PackA', enabled: false })],
    });
    registerInvokeHandler('set_profile_mods_enabled', () => ({
      enabled: true, toggled: [], missing: ['GhostMod'], failed: [],
    }));
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findAllByText('PackA');
    await user.click(await screen.findByRole('button', { name: /^Enable all$/i }));
    // The toast names the mod that couldn't be toggled (it's not installed).
    await waitFor(() => {
      expect(screen.getByText(/GhostMod/)).toBeInTheDocument();
    });
  });

  it('Enable all in the pack re-fetches the membership grid so the row toggles refresh (Bug 8)', async () => {
    // A bulk toggle changes enabled state but not membership/identity, so
    // without a reload nonce the focused in-pack grid wouldn't re-pull and the
    // row toggles stayed stale. Assert the grid is re-fetched after Enable all.
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackA', folder_name: 'PackA', mod_id: 'PackA', enabled: false })],
    });
    registerInvokeHandler('set_profile_mods_enabled', () => ({
      enabled: true, toggled: ['PackA'], missing: [], failed: [],
    }));
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findAllByText('PackA');
    const before = getInvokeCalls().filter((c) => c.cmd === 'get_profile_memberships').length;
    await user.click(await screen.findByRole('button', { name: /^Enable all$/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mods_enabled')).toBe(true);
    });
    await waitFor(() => {
      expect(getInvokeCalls().filter((c) => c.cmd === 'get_profile_memberships').length)
        .toBeGreaterThan(before);
    });
  });

  it('Add on the ACTIVE pack also calls toggle_mod with enable=true', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    const profile = setupPack({
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'toggle_mod');
    expect(call?.args).toMatchObject({
      name: 'LibMod',
      folderName: 'LibMod',
      enable: true,
    });
  });

  it('Add does NOT call toggle_mod when the pack is not active', async () => {
    const profile = setupPack({
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership'),
      ).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
  });

  it('Quick add URL in the modpack view auto-adds the installed mod to this pack', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: modInfo({ name: 'NewMod', folder_name: 'NewMod', mod_id: 'NewMod' }),
    }));
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });

    await openAddMods(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/i }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const call = getInvokeCalls().find(
        (c) => c.cmd === 'set_profile_mod_membership' && c.args?.modName === 'NewMod',
      );
      expect(call?.args).toMatchObject({
        profileId: 'Sample',
        modName: 'NewMod',
        included: true,
      });
    });
  });

  it('Quick add of an already-active mod does not try to re-enable it (no toggle_mod, no failure)', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    // Regression: re-adding a mod that's already installed + active made
    // the auto-add call toggle_mod(enable=true), which errors ("not in
    // mods_disabled") and surfaced a bogus "Quick add failed" toast.
    registerInvokeHandler('get_active_profile', () => 'Sample');
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: modInfo({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib', enabled: true }),
    }));
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Sample' }));
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });

    await openAddMods(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/i }));
    await user.type(await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/), 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(true);
    });
    // The mod is already active → no toggle, and no "Quick add failed".
    expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
    expect(screen.queryByText(/Quick add failed/i)).toBeNull();
  });

  // ── Followed (subscribed) pack: adds are blocked ──────────────────
  // A followed pack's manifest isn't ours to edit, so the modpack view
  // refuses to install "into" it (which would fail server-side and strand
  // the file in the library) and shows a friendly toast instead. The guard
  // only fires once get_subscriptions reports the target pack as followed.
  it('importing into a followed pack is blocked with a friendly message (no install)', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'henry/AAAA', profile_name: 'Henry Pack' },
    ]);
    const user = userEvent.setup();
    render(<Wrap profile={baseProfile({ name: 'Henry Pack' })} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Henry Pack' });

    await openAddMods(user);
    await user.click(screen.getByRole('menuitem', { name: /Import mod/i }));

    // The friendly toast appears…
    expect(await screen.findByText(/followed modpack/i)).toBeInTheDocument();
    // …and the install never ran (no half-completed add).
    expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(false);
  });

  it('quick-adding into a followed pack is blocked with a friendly message (no install)', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'henry/AAAA', profile_name: 'Henry Pack' },
    ]);
    const user = userEvent.setup();
    render(<Wrap profile={baseProfile({ name: 'Henry Pack' })} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Henry Pack' });

    // Mirror the existing quick-add flow: open Add mods → Quick add URL →
    // type a github URL → click Add.
    await openAddMods(user);
    await user.click(screen.getByRole('menuitem', { name: /Quick add URL/i }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // The friendly toast appears…
    expect(await screen.findByText(/followed modpack/i)).toBeInTheDocument();
    // …and quick_add_mod never ran.
    expect(getInvokeCalls().some((c) => c.cmd === 'quick_add_mod')).toBe(false);
  });

  it('surfaces an error toast when adding a mod fails', async () => {
    const profile = setupPack({
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    registerInvokeHandler('set_profile_mod_membership', () => {
      throw new Error('disk full');
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));
    expect(await screen.findByText(/Couldn't add LibMod: disk full/i)).toBeInTheDocument();
  });

  // ── Edit modpack (checkbox picker) ────────────────────────────────
  it('Edit opens the membership picker pre-filled with the pack\'s mods', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })],
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod' })],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /^Edit$/i }));

    // The picker modal mounts with the pack member checked.
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit "Sample"/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('PackMod')).toBeChecked();
    expect(screen.getByLabelText('LibMod')).not.toBeChecked();
  });

  // ── Pack-scoped Delete all ────────────────────────────────────────
  it('Delete all (in pack) deletes ONLY this pack\'s mods from disk', async () => {
    const profile = setupPack({
      inPack: [
        modInfo({ name: 'PackOne', folder_name: 'PackOne' }),
        modInfo({ name: 'PackTwo', folder_name: 'PackTwo' }),
      ],
      available: [modInfo({ name: 'OutsiderMod', folder_name: 'OutsiderMod' })],
    });
    registerInvokeHandler('delete_mod_cmd', () => true);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Delete all lives in the header kebab now.
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete all/i }));

    // Typed-phrase guard, same as the All Mods destructive delete.
    const phraseInput = await screen.findByPlaceholderText('delete all');
    await user.type(phraseInput, 'delete all');
    const confirmBtn = screen
      .getAllByRole('button')
      .find((b) => /Delete these mods/i.test(b.textContent ?? ''));
    expect(confirmBtn).toBeDefined();
    await user.click(confirmBtn!);

    await waitFor(() => {
      const deletes = getInvokeCalls().filter((c) => c.cmd === 'delete_mod_cmd');
      expect(deletes.map((c) => c.args?.name).sort()).toEqual(['PackOne', 'PackTwo']);
    });
    const removals = getInvokeCalls().filter((c) => c.cmd === 'set_profile_mod_membership');
    expect(removals.map((c) => c.args?.modName).sort()).toEqual(['PackOne', 'PackTwo']);
    expect(removals.every((c) => c.args?.profileId === 'Sample' && c.args?.included === false)).toBe(true);
    // The non-pack mod is never touched.
    expect(
      getInvokeCalls().some((c) => c.cmd === 'delete_mod_cmd' && c.args?.name === 'OutsiderMod'),
    ).toBe(false);
  });

  it('Delete all is omitted from the kebab when the pack is empty', async () => {
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onDelete={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Delete all/i })).toBeNull();
  });

  // ── Load order ────────────────────────────────────────────────────
  it('Load order button in Section 1 calls onOpenLoadOrder', async () => {
    const profile = setupPack({ inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })] });
    const onOpenLoadOrder = vi.fn();
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} onOpenLoadOrder={onOpenLoadOrder} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /Load order/i }));
    expect(onOpenLoadOrder).toHaveBeenCalledWith(profile);
  });

  it('Load order button is disabled when the pack has no mods', async () => {
    const user = userEvent.setup();
    const onOpenLoadOrder = vi.fn();
    render(<Wrap {...baseProps()} onOpenLoadOrder={onOpenLoadOrder} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    const btn = within(inPack).getByRole('button', { name: /Load order/i });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onOpenLoadOrder).not.toHaveBeenCalled();
  });

  // ── Advanced actions (header kebab) ───────────────────────────────
  it('Advanced actions live in the header kebab and fire their handlers', async () => {
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onExportFile = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        {...baseProps()}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onExportFile={onExportFile}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByTestId('modpack-detail-advanced-panel')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.getByRole('menuitem', { name: /Delete modpack/i })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Export .sts2pack/i }));
    expect(onExportFile).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete modpack/i }));
    expect(onDelete).toHaveBeenCalledWith('Sample');
  });

  it('opens the Rename modal from the header kebab', async () => {
    const user = userEvent.setup();
    const profile = setupPack({ packName: 'Sample', inPack: [modInfo({ name: 'M', folder_name: 'M' })] });
    render(<Wrap {...baseProps()} profile={profile} renameExistingNames={['Sample']} onRenamed={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /^rename$/i }));
    expect(await screen.findByRole('dialog', { name: /rename/i })).toBeInTheDocument();
  });

  it('does not offer Rename when onRenamed is not provided (e.g. a placeholder pack)', async () => {
    const user = userEvent.setup();
    const profile = setupPack({ packName: 'Sample', inPack: [modInfo({ name: 'M', folder_name: 'M' })] });
    // baseProps() omits onRenamed, so the kebab must not surface a Rename item.
    render(<Wrap {...baseProps()} profile={profile} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    // The kebab opens (Auto-detect / Refresh are always present)…
    expect(await screen.findByRole('menuitem', { name: /Auto-detect sources/i })).toBeInTheDocument();
    // …but Rename is gated off.
    expect(screen.queryByRole('menuitem', { name: /^rename$/i })).toBeNull();
  });

  it('Auto-detect sources lives in the header kebab (not "+ Add mods") and opens the scan modal', async () => {
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Auto-detect sources/i }));
    // The scan modal opens — its subtitle is distinctive.
    expect(
      await screen.findByText(/Scan installed mods against GitHub/i),
    ).toBeInTheDocument();
  });

  it('Repair drift item shows in the kebab only when drift.has_drift is true and fires its handler', async () => {
    const onRepairDrift = vi.fn();
    const drift: ProfileDrift = {
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    };
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} drift={drift} onRepairDrift={onRepairDrift} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Repair/i }));
    expect(onRepairDrift).toHaveBeenCalledWith('Sample');
  });

  it('Repair modpack is omitted for a non-active pack with no drift', async () => {
    // Non-active pack (no get_active_profile) with no drift → nothing to repair
    // from here; switching to the pack re-applies its manifest instead.
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onDelete={vi.fn()} onRepairDrift={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Repair/i })).toBeNull();
  });

  it('Repair modpack is always available for the ACTIVE pack, even with no drift', async () => {
    // On-demand "reset to the saved version": a user who messed up their active
    // install can repair without waiting for drift to be auto-detected.
    registerInvokeHandler('get_active_profile', () => 'Sample');
    const onRepairDrift = vi.fn();
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onRepairDrift={onRepairDrift} />);
    const titleRow = (await screen.findByRole('heading', { level: 2, name: 'Sample' }))
      .closest('.gf-modpack-detail-title-row') as HTMLElement;
    // Wait for the ACTIVE badge so isActive has propagated from AppContext.
    await within(titleRow).findByText(/active/i);
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Repair modpack/i }));
    expect(onRepairDrift).toHaveBeenCalledWith('Sample');
  });

  // ── Available section search ──────────────────────────────────────
  it('the library search filters the available section by name', async () => {
    const profile = setupPack({
      inPack: [modInfo({ name: 'AlphaPack', folder_name: 'AlphaPack' })],
      available: [
        modInfo({ name: 'BetaLib', folder_name: 'BetaLib' }),
        modInfo({ name: 'GammaLib', folder_name: 'GammaLib' }),
      ],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    expect(within(available).getByText('BetaLib')).toBeInTheDocument();
    expect(within(available).getByText('GammaLib')).toBeInTheDocument();

    await user.type(within(available).getByRole('searchbox'), 'beta');
    expect(within(available).getByText('BetaLib')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(available).queryByText('GammaLib')).toBeNull();
    });
  });

  // ── Updates affordance (section header) ───────────────────────────
  it('shows a "Check for updates" pill before an audit has run', async () => {
    const profile = setupPack({ inPack: [modInfo({ name: 'PackMod', folder_name: 'PackMod' })] });
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    expect(within(inPack).getByRole('button', { name: /Check for updates/i })).toBeInTheDocument();
  });

  // ── Available row presentation edge case ──────────────────────────
  it('shows the Local badge for an available mod with a source but no GitHub/Nexus link', async () => {
    const profile = setupPack({
      available: [
        modInfo({ name: 'SideloadMod', folder_name: 'SideloadMod', source: 'file:///x', github_url: null, nexus_url: null }),
      ],
    });
    const user = userEvent.setup();
    render(<Wrap profile={profile} onBack={vi.fn()} />);
    const available = await expandLibrary(user);
    expect(within(available).getByText(/^Local$/i)).toBeInTheDocument();
  });

  // ── In-pack tag filter ───────────────────────────────────────────
  describe('in-pack tag filter', () => {
    it('filters the pack rows to the chosen tag', async () => {
      const profile = setupPack({
        packName: 'Sample',
        inPack: [
          modInfo({ name: 'CombatMod', folder_name: 'CombatMod', tags: ['combat'] }),
          modInfo({ name: 'UiMod', folder_name: 'UiMod', tags: ['ui'] }),
        ],
      });
      render(<Wrap {...baseProps()} profile={profile} />);
      // Both rows present initially.
      expect((await screen.findAllByText('CombatMod')).length).toBeGreaterThan(0);
      expect(screen.getAllByText('UiMod').length).toBeGreaterThan(0);
      // Filter to "combat".
      const tagSelect = screen.getByLabelText(/tag/i) as HTMLSelectElement;
      fireEvent.change(tagSelect, { target: { value: 'combat' } });
      await waitFor(() => expect(screen.queryByText('UiMod')).toBeNull());
      expect(screen.getAllByText('CombatMod').length).toBeGreaterThan(0);
    });

    it('filters the pack rows to mods with no tags', async () => {
      const profile = setupPack({
        packName: 'Sample',
        inPack: [
          modInfo({ name: 'TaggedMod', folder_name: 'TaggedMod', tags: ['combat'] }),
          modInfo({ name: 'UntaggedMod', folder_name: 'UntaggedMod', tags: [] }),
        ],
      });
      render(<Wrap {...baseProps()} profile={profile} />);
      expect((await screen.findAllByText('TaggedMod')).length).toBeGreaterThan(0);
      expect(screen.getAllByText('UntaggedMod').length).toBeGreaterThan(0);

      const tagSelect = screen.getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement;
      expect(within(tagSelect).getByRole('option', { name: /No tags/i })).toBeInTheDocument();
      fireEvent.change(tagSelect, { target: { value: '__no_tags__' } });

      await waitFor(() => expect(screen.queryByText('TaggedMod')).toBeNull());
      expect(screen.getAllByText('UntaggedMod').length).toBeGreaterThan(0);
    });
  });

  // ── Inactive-pack toggle hint ─────────────────────────────────────
  describe('inactive-pack toggle hint', () => {
    it('shows the hint with a Switch action on a non-active pack', async () => {
      registerInvokeHandler('get_active_profile', () => 'Some Other Pack');
      const profile = setupPack({ packName: 'Sample', inPack: [modInfo({ name: 'M', folder_name: 'M' })] });
      const onSwitch = vi.fn();
      render(<Wrap {...baseProps()} profile={profile} onSwitch={onSwitch} />);
      const hint = await screen.findByText(/only available for the active modpack/i);
      expect(hint).toBeInTheDocument();
      // The hint's Switch control fires onSwitch for THIS pack.
      const region = hint.closest('[data-testid="modpack-detail-inactive-hint"]') as HTMLElement;
      fireEvent.click(within(region).getByRole('button', { name: /switch to/i }));
      expect(onSwitch).toHaveBeenCalledWith('Sample');
    });

    it('hides the hint when the pack is active', async () => {
      registerInvokeHandler('get_active_profile', () => 'Sample');
      const profile = setupPack({ packName: 'Sample', inPack: [modInfo({ name: 'M', folder_name: 'M' })] });
      render(<Wrap {...baseProps()} profile={profile} onSwitch={vi.fn()} />);
      await screen.findByTestId('modpack-detail-in-pack');
      expect(screen.queryByTestId('modpack-detail-inactive-hint')).toBeNull();
    });
  });
});
