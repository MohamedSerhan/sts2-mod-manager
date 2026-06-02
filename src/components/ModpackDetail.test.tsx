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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModpackDetail } from './ModpackDetail';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
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
    mod_id: 'PackMod',
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
    mod_id: 'LibMod',
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
    expect(screen.getByRole('button', { name: /Switch to/i })).toBeInTheDocument();
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
    expect(screen.getByRole('menuitem', { name: /Open mods folder/i })).toBeInTheDocument();
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
      available: [modInfo({ name: 'LibMod', folder_name: 'LibMod', mod_id: 'LibMod' })],
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
      profileName: 'Sample',
      modName: 'LibMod',
      folderName: 'LibMod',
      modId: 'LibMod',
      included: true,
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
        profileName: 'Sample',
        modName: 'NewMod',
        included: true,
      });
    });
  });

  it('Quick add of an already-active mod does not try to re-enable it (no toggle_mod, no failure)', async () => {
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
    const onExportJson = vi.fn();
    const onSnapshot = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        {...baseProps()}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onExportJson={onExportJson}
        onSnapshot={onSnapshot}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByTestId('modpack-detail-advanced-panel')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.getByRole('menuitem', { name: /Delete modpack/i })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Export JSON/i }));
    expect(onExportJson).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Snapshot/i }));
    expect(onSnapshot).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete modpack/i }));
    expect(onDelete).toHaveBeenCalledWith('Sample');
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
});
