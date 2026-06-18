/**
 * LibraryTable tests — extracted from Profiles.test.tsx after the
 * 1.7.0 T16 restructure. The component focuses on a single modpack's
 * mod editor: search + sort + bulk Store + per-row toggle membership
 * + (kebab) storage toggle + drag-reorder the in-pack subset (gated on
 * enableReorder). The per-row Store/Activate button was removed; the
 * context-driven explainer banner is covered here too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LibraryTable } from './LibraryTable';
import { AllProviders } from '../__test__/providers';
import { chooseOption, openSelect } from '../__test__/selectHelpers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModInfo, Profile } from '../types';

function Wrap(props: React.ComponentProps<typeof LibraryTable>) {
  return (
    <AllProviders>
      <LibraryTable {...props} />
    </AllProviders>
  );
}

// jsdom clipboard varies by version — install a fresh writeText each
// test so assertions observe the mock the component invoked.
let clipboardWrite: ReturnType<typeof vi.fn>;
function installClipboard() {
  clipboardWrite = vi.fn(async () => {});
  const clipboard = window.navigator.clipboard ?? navigator.clipboard ?? {};
  Object.defineProperty(clipboard, 'writeText', {
    value: clipboardWrite,
    configurable: true,
    writable: true,
  });
  const proto = Object.getPrototypeOf(clipboard);
  if (proto) {
    Object.defineProperty(proto, 'writeText', {
      value: clipboardWrite,
      configurable: true,
      writable: true,
    });
  }
}

beforeEach(() => {
  installClipboard();
});

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'Stable',
    mods: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    game_version: '0.105.0',
    ...overrides,
  } as Profile);

// Many row-menu actions only render when the row has a matching ModInfo
// (passed via modInfoByKey). This factory builds that ModInfo for tests that
// exercise the kebab/source/update surface.
const mkModInfo = (overrides: Partial<ModInfo> = {}): ModInfo =>
  ({
    name: 'Mod',
    version: '1.0.0',
    description: '',
    enabled: true,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    folder_name: 'Mod',
    mod_id: 'Mod',
    github_url: null,
    nexus_url: null,
    pinned: false,
    min_game_version: null,
    author: null,
    tags: [],
    display_name: null,
    display_description: null,
    ...overrides,
  } as ModInfo);

describe('<LibraryTable>', () => {
  it('renders all installed mods for the modpack as rows', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [
      baseProfile({ name: 'Stable' }),
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
          ],
        },
        {
          name: 'CardArtEditor',
          version: '2.0.0',
          folder_name: 'CardArtEditor',
          mod_id: 'CardArtEditor',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));

    render(<Wrap modpackName="Stable" />);

    // The mod title appears twice per row (display name + folder hint
    // span); use findAllByText to handle the duplication.
    expect((await screen.findAllByText('BaseLib')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('CardArtEditor').length).toBeGreaterThan(0);
  });

  it('applies the compact density class when compact is the saved view preference', async () => {
    localStorage.setItem('sts2mm-mod-density', 'compact');
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib', version: '1.0.0', folder_name: 'BaseLib', mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    render(<Wrap modpackName="Stable" />);
    expect(await screen.findByTestId('library-table')).toHaveClass('is-compact');
    // A View toggle is offered in the toolbar.
    expect(screen.getByRole('button', { name: /^compact$/i })).toBeInTheDocument();
    localStorage.removeItem('sts2mm-mod-density');
  });

  it('shows the modpack explainer (drag + switching) when enableReorder is set', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    const { container } = render(<Wrap modpackName="Stable" enableReorder />);
    await screen.findAllByText('BaseLib');
    const help = container.querySelector('.gf-profile-library-help');
    expect(help?.textContent).toMatch(/Drag the handle to set load order/i);
    expect(help?.textContent).toMatch(/Switching to this modpack/i);
  });

  it('membership Add (kebab) calls set_profile_mod_membership for the focused modpack', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'NewMod',
          version: '0.1.0',
          folder_name: 'NewMod',
          mod_id: 'NewMod',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));

    const modInfoByKey = new Map([
      ['NewMod', mkModInfo({ name: 'NewMod', folder_name: 'NewMod', mod_id: 'NewMod' })],
    ]);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);

    const row = (await screen.findByText('NewMod')).closest(
      '[data-testid="library-row"]',
    ) as HTMLElement;
    // Read-only indicator starts at "Not in Modpack".
    expect(row.querySelector('.gf-row-inpack')?.textContent).toMatch(/Not in Modpack/i);
    // Membership is changed from the kebab.
    await user.click(within(row).getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /add to "stable"/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_profile_mod_membership',
        args: {
          profileId: 'Stable',
          modName: 'NewMod',
          modVersionId: null,
          folderName: 'NewMod',
          modId: 'NewMod',
          included: true,
          sourceHint: null,
        },
      });
    });
    // Optimistic patch flips the indicator to "In Modpack".
    await waitFor(() => {
      expect(row.querySelector('.gf-row-inpack')?.textContent).toMatch(/In Modpack/i);
    });
  });

  it('search filters visible rows by name / folder', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
        {
          name: 'CardArt',
          version: '1.0',
          folder_name: 'card-art-folder',
          mod_id: 'CardArt',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);
    await screen.findAllByText('BaseLib');
    await user.type(screen.getByRole('textbox', { name: /Search Mod Library/i }), 'card-art');
    await waitFor(() => {
      expect(screen.queryByText('BaseLib')).toBeNull();
    });
    expect(screen.getAllByText('CardArt').length).toBeGreaterThan(0);
  });

  it('sort drop-down reorders rows by name desc', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Alpha',
          version: '1.0',
          folder_name: 'Alpha',
          mod_id: 'Alpha',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
        {
          name: 'Zeta',
          version: '1.0',
          folder_name: 'Zeta',
          mod_id: 'Zeta',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
      ],
    }));

    const user = userEvent.setup();
    const { container } = render(<Wrap modpackName="Stable" />);
    await screen.findAllByText('Alpha');
    const titles = () =>
      Array.from(container.querySelectorAll('.gf-profile-library-title')).map(
        (el) => el.textContent ?? '',
      );
    // Default sort is inPackFirst — Alpha appears first alphabetically
    // among the non-in-pack mods.
    expect(titles()[0]).toContain('Alpha');
    await chooseOption(user, /Sort/i, 'Name Z-A');
    expect(titles()[0]).toContain('Zeta');
  });

  it('sort drop-down moves actionable updates first in the library view', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Alpha',
          version: '1.0',
          folder_name: 'Alpha',
          mod_id: 'Alpha',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
        {
          name: 'Beta',
          version: '1.0',
          folder_name: 'Beta',
          mod_id: 'Beta',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
      ],
    }));
    const auditByKey = new Map([
      ['Beta', {
        mod_name: 'Beta',
        folder_name: 'Beta',
        github_repo: 'owner/beta',
        installed_version: '1.0.0',
        latest_release_tag: 'v2.0.0',
        latest_release_with_assets_tag: 'v2.0.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: ['Beta.zip'],
        releases_scanned: 1,
        error: null,
        nexus_url: null,
        nexus_version: null,
        nexus_update_available: false,
        update_source: 'github',
        github_auto_detected: false,
        pinned: false,
        latest_compatible_tag: 'v2.0.0',
      }],
    ]);

    const user = userEvent.setup();
    const modInfoByKey = new Map([
      ['Alpha', mkModInfo({ name: 'Alpha', folder_name: 'Alpha', mod_id: 'Alpha' })],
      ['Beta', mkModInfo({ name: 'Beta', folder_name: 'Beta', mod_id: 'Beta' })],
    ]);
    const { container } = render(<Wrap modpackName="Stable" auditByKey={auditByKey} modInfoByKey={modInfoByKey} />);
    await screen.findAllByText('Alpha');
    const titles = () =>
      Array.from(container.querySelectorAll('.gf-profile-library-title')).map(
        (el) => el.textContent ?? '',
      );
    expect(titles()[0]).toContain('Alpha');
    await chooseOption(user, /Sort/i, /Updates first/i);
    expect(titles()[0]).toContain('Beta');
  });

  it('pagination footer reveals more rows on click for large libraries', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: Array.from({ length: 110 }, (_, idx) => ({
        name: `Mod${String(idx).padStart(3, '0')}`,
        version: '1.0',
        folder_name: `Mod${idx}`,
        mod_id: `Mod${idx}`,
        installed_enabled: false,
        profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
      })),
    }));

    const user = userEvent.setup();
    const { container } = render(<Wrap modpackName="Stable" pageSize={50} />);
    await screen.findByText('Mod000');
    // Default page = 50 rows visible.
    expect(container.querySelectorAll('.gf-profile-library-row')).toHaveLength(50);
    // Footer offers the "show more" affordance with the remaining count.
    await user.click(screen.getByRole('button', { name: /Show 50 more/i }));
    expect(container.querySelectorAll('.gf-profile-library-row')).toHaveLength(100);
  });

  it('row Active/stored switch calls toggle_mod (the verbose button + kebab item were retired)', async () => {
    // 1.7.0: the per-mod active/stored control is a compact switch on the
    // row. ON = active in the game folder; flipping OFF stores the mod
    // (toggle_mod enable=false). Wiring modInfoByKey renders the switch.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Idle',
          version: '1.0',
          folder_name: 'Idle',
          mod_id: 'Idle',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);

    const modInfoByKey = new Map([
      ['Idle', {
        name: 'Idle',
        version: '1.0',
        description: '',
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
        folder_name: 'Idle',
        mod_id: 'Idle',
        github_url: null,
        nexus_url: null,
        pinned: false,
        min_game_version: null,
        author: null,
        tags: [],
        display_name: null,
        display_description: null,
      }],
    ]);

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    await screen.findAllByText('Idle');
    // No verbose primary-row Store button — the control is a switch.
    expect(screen.queryByRole('button', { name: /Store Idle/i })).toBeNull();
    const sw = screen.getByRole('switch', { name: /toggle whether Idle is active in game/i });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'toggle_mod',
        args: { name: 'Idle', folderName: 'Idle', enable: false },
      });
    });
  });

  it('row Active/stored switch refreshes saved membership state for included modpack rows', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Idle',
          version: '1.0',
          folder_name: 'Idle',
          mod_id: 'Idle',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));
    const onMembershipChanged = vi.fn();
    const modInfoByKey = new Map([['Idle', mkModInfo({ name: 'Idle', folder_name: 'Idle', mod_id: 'Idle' })]]);

    const user = userEvent.setup();
    render(
      <Wrap
        modpackName="Stable"
        modInfoByKey={modInfoByKey}
        onMembershipChanged={onMembershipChanged}
      />,
    );
    await screen.findAllByText('Idle');

    await user.click(screen.getByRole('switch', { name: /toggle whether Idle is active in game/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_profile_mod_membership',
        args: {
          profileId: 'Stable',
          modName: 'Idle',
          modVersionId: null,
          folderName: 'Idle',
          modId: 'Idle',
          included: true,
          sourceHint: null,
        },
      });
    });
    expect(onMembershipChanged).toHaveBeenCalled();
  });

  it('pack-scoped active rows keep core controls even when ModInfo lookup is missing', async () => {
    registerInvokeHandler('get_active_profile', () => 'Stable');
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'RandomVision',
          display_name: '[Cheats] RandomVision',
          version: '0.2.0',
          folder_name: 'RandomVision',
          mod_id: 'RandomVision',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));

    render(
      <Wrap
        modpackName="Stable"
        packScoped
        coupleActiveStorage
        modInfoByKey={new Map()}
      />,
    );

    expect(await screen.findByRole('heading', { name: '[Cheats] RandomVision' })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', {
        name: /toggle whether \[Cheats\] RandomVision is active in game/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Remove \[Cheats\] RandomVision from this modpack/i }),
    ).toBeInTheDocument();
  });

  // ── Enabling a stored mod that isn't in the active pack ──────────────
  // Prompts the user: enable + add to the pack, enable only, or back out.
  function seedStoredNotInPack(included = false) {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Loner',
          version: '1.0',
          folder_name: 'Loner',
          mod_id: 'Loner',
          installed_enabled: false,
          profiles: [{ profile_name: 'Stable', included, enabled: false, editable: true }],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));
    return new Map([
      ['Loner', mkModInfo({ name: 'Loner', folder_name: 'Loner', mod_id: 'Loner', enabled: false })],
    ]);
  }

  it('enable not-in-pack → "Enable & add" activates AND adds to the pack', async () => {
    const modInfoByKey = seedStoredNotInPack(false);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    await user.click(
      await screen.findByRole('switch', { name: /toggle whether Loner is active in game/i }),
    );
    expect(await screen.findByText(/Enable only keeps it active on disk, but it will not be saved in "Stable"/)).toBeInTheDocument();
    expect(screen.getByText(/Friends who install this shared modpack will not get enable-only mods/)).toBeInTheDocument();
    const enableOnly = await screen.findByRole('button', { name: /^Enable only this time$/i });
    const enableAndAdd = await screen.findByRole('button', { name: /Enable and add to "Stable"/i });
    expect(enableOnly.classList.contains('gf-btn')).toBe(true);
    expect(enableOnly.classList.contains('gf-btn-2')).toBe(false);
    expect(enableAndAdd.classList.contains('gf-btn-2')).toBe(true);
    await user.click(await screen.findByRole('button', { name: /Enable and add to "Stable"/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod' && c.args?.enable === true)).toBe(true);
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership' && c.args?.included === true),
      ).toBe(true);
    });
  });

  it('enable not-in-pack → "Enable only" activates without adding to the pack', async () => {
    const modInfoByKey = seedStoredNotInPack(false);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    await user.click(
      await screen.findByRole('switch', { name: /toggle whether Loner is active in game/i }),
    );
    await user.click(await screen.findByRole('button', { name: /^Enable only this time$/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod' && c.args?.enable === true)).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  });

  it('enable not-in-pack → "Keep it stored" makes no changes', async () => {
    const modInfoByKey = seedStoredNotInPack(false);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    await user.click(
      await screen.findByRole('switch', { name: /toggle whether Loner is active in game/i }),
    );
    await user.click(await screen.findByRole('button', { name: /Keep stored \(cancel\)/i }));
    expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
  });

  it('enabling a stored mod that IS already in the pack does not prompt', async () => {
    const modInfoByKey = seedStoredNotInPack(true);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    await user.click(
      await screen.findByRole('switch', { name: /toggle whether Loner is active in game/i }),
    );
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod' && c.args?.enable === true)).toBe(true);
    });
    expect(screen.queryByRole('button', { name: /^Enable only this time$/i })).toBeNull();
  });

  it('enable not-in-pack with a FOLLOWED (non-editable) active pack: no prompt, explains via toast', async () => {
    // A followed pack can't be edited, so enabling a not-in-pack mod can't add
    // it. Instead of the prompt (or a silent enable), an explanatory toast
    // fires and membership is left untouched.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Followed' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Followed', editable: false }],
      mods: [
        {
          name: 'Loner',
          version: '1.0',
          folder_name: 'Loner',
          mod_id: 'Loner',
          installed_enabled: false,
          profiles: [{ profile_name: 'Followed', included: false, enabled: false, editable: false }],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);
    const modInfoByKey = new Map([
      ['Loner', mkModInfo({ name: 'Loner', folder_name: 'Loner', mod_id: 'Loner', enabled: false })],
    ]);
    const user = userEvent.setup();
    render(<Wrap modpackName="Followed" modInfoByKey={modInfoByKey} />);
    await user.click(
      await screen.findByRole('switch', { name: /toggle whether Loner is active in game/i }),
    );
    // No add-to-pack prompt for a followed pack.
    expect(screen.queryByRole('button', { name: /^Enable only this time$/i })).toBeNull();
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod' && c.args?.enable === true)).toBe(true);
    });
    // Explains why it wasn't added; membership stays untouched.
    expect(await screen.findByText(/followed modpack, so it can't be edited/i)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  });

  it('drag reordering an in-pack mod calls set_profile_load_order', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'First',
          version: '1.0',
          folder_name: 'First',
          mod_id: 'First',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
        {
          name: 'Second',
          version: '1.0',
          folder_name: 'Second',
          mod_id: 'Second',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    registerInvokeHandler('set_profile_load_order', () => ({
      profile: baseProfile({ name: 'Stable' }),
      settings_status: 'skipped_inactive',
      settings_path: null,
    }));

    // enableReorder is what gates the drag handlers + rank chip now;
    // ModpackDetail passes it. Without it the drop is a no-op.
    const { container } = render(<Wrap modpackName="Stable" enableReorder />);
    // Wait for the load-order draft to populate. The rank chip ("#1",
    // "#2") only renders once `inPackIndex >= 0`, which is the same
    // condition gating the drag handlers' state mutations. Without
    // this gate, a drag fired before the effect commits sees
    // `inPackIndex === -1` and the drop is a no-op — the original
    // source of the flake in full-suite runs.
    await screen.findByText('#1');
    await screen.findByText('#2');
    // Both rows are "in-pack" so both are draggable.
    const rows = container.querySelectorAll('.gf-profile-library-row');
    expect(rows.length).toBe(2);
    const [firstRow, secondRow] = Array.from(rows) as HTMLElement[];
    // A single DataTransfer mock threads through the whole sequence
    // (dragStart writes via setData, drop reads via getData). The
    // production handler's primary path is the React state
    // `draggedIndex`, but it falls back to the dataTransfer payload
    // if state hasn't propagated — keeping the mock consistent makes
    // both paths work.
    const dataTransfer = {
      data: new Map<string, string>(),
      setData(type: string, value: string) { this.data.set(type, value); },
      getData(type: string) { return this.data.get(type) ?? ''; },
      effectAllowed: '',
      dropEffect: '',
      // The 1.7.0 cleanup gated the in-app reorder handlers on
      // `dataTransfer.types.includes('text/plain')` so OS file drags
      // (Files type) bubble up to App.tsx for installModFromFile. The
      // test's dragStart writes 'text/plain', so types must report it.
      get types() { return Array.from(this.data.keys()); },
    };
    fireEvent.dragStart(secondRow, { dataTransfer });
    fireEvent.dragOver(firstRow, { dataTransfer });
    fireEvent.drop(firstRow, { dataTransfer });
    // dragEnd is a no-op for the assertion but matches a real browser
    // sequence and clears the optimistic indices.
    fireEvent.dragEnd(secondRow, { dataTransfer });

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_load_order'),
      ).toBe(true);
    });
    // And the payload reflects the swap — Second now precedes First.
    const loadOrderCalls = getInvokeCalls().filter(
      (c) => c.cmd === 'set_profile_load_order',
    );
    const lastCall = loadOrderCalls[loadOrderCalls.length - 1];
    const orderedMods = lastCall?.args?.orderedMods as
      | Array<{ name: string }>
      | undefined;
    expect(orderedMods?.map((m) => m.name)).toEqual(['Second', 'First']);
  });

  it('drag reorder failure shows a toast and reloads the membership grid', async () => {
    let membershipLoads = 0;
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => {
      membershipLoads += 1;
      return {
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'First',
            version: '1.0',
            folder_name: 'First',
            mod_id: 'First',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            name: 'Second',
            version: '1.0',
            folder_name: 'Second',
            mod_id: 'Second',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      };
    });
    registerInvokeHandler('set_profile_load_order', () => {
      throw new Error('settings write failed');
    });

    const { container } = render(<Wrap modpackName="Stable" enableReorder />);
    await screen.findByText('#1');
    await screen.findByText('#2');
    const rows = Array.from(container.querySelectorAll('.gf-profile-library-row')) as HTMLElement[];
    const [firstRow, secondRow] = rows;
    const dataTransfer = {
      data: new Map<string, string>(),
      setData(type: string, value: string) { this.data.set(type, value); },
      getData(type: string) { return this.data.get(type) ?? ''; },
      effectAllowed: '',
      dropEffect: '',
      get types() { return Array.from(this.data.keys()); },
    };

    fireEvent.dragStart(secondRow, { dataTransfer });
    fireEvent.dragOver(firstRow, { dataTransfer });
    fireEvent.drop(firstRow, { dataTransfer });
    fireEvent.dragEnd(secondRow, { dataTransfer });

    expect(await screen.findByText(/Failed to save load order: settings write failed/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(membershipLoads).toBeGreaterThanOrEqual(2);
    });
  });

  // ── T16 review fix — migrated from .skip'd Profiles.test.tsx ──────
  // The "Mod Library workspace" was extracted into <LibraryTable> in
  // T16. Seven legacy behaviors stopped being exercised when the old
  // tests went .skip during the row → card-list switch. These tests
  // pin those behaviors so the migration doesn't quietly drop them.

  it('editable=false (followed modpack) → indicator shows status; kebab membership item is disabled', async () => {
    // Followed modpacks come back with `editable: false`. The row shows
    // the read-only "In Modpack" indicator, and the kebab's Remove-from-pack
    // item is disabled so the user can't mutate a pack they don't own.
    registerInvokeHandler('list_profiles_cmd', () => [
      baseProfile({ name: 'Friend Pack', created_by: 'alice' }),
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Friend Pack', editable: false }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Friend Pack', included: true, enabled: true, editable: false },
          ],
        },
      ],
    }));

    const modInfoByKey = new Map([
      ['BaseLib', mkModInfo({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib' })],
    ]);
    const user = userEvent.setup();
    render(<Wrap modpackName="Friend Pack" modInfoByKey={modInfoByKey} />);

    const row = (await screen.findByText('BaseLib')).closest(
      '[data-testid="library-row"]',
    ) as HTMLElement;
    expect(row.querySelector('.gf-row-inpack')?.textContent).toMatch(/In Modpack/i);
    await user.click(within(row).getByRole('button', { name: /mod actions/i }));
    const removeItem = await screen.findByRole('menuitem', {
      name: /remove from "friend pack"/i,
    });
    expect(removeItem).toBeDisabled();
  });

  it('get_profile_memberships failure → error UI + Retry button reloads', async () => {
    // First load throws; the error message + Retry button should
    // appear. Clicking Retry re-invokes the command — the next
    // attempt returns a clean grid and the empty state renders.
    let attempts = 0;
    registerInvokeHandler('get_profile_memberships', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('membership service unavailable');
      return { profiles: [{ name: 'Stable', editable: true }], mods: [] };
    });

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);
    expect(
      await screen.findByText(/membership service unavailable/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText(/No installed mods/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('membership update failure (kebab) → toast fires + indicator stays "Not in Modpack"', async () => {
    // set_profile_mod_membership throws; the optimistic patch must NOT
    // apply, the indicator must stay "Not in Modpack", and the failure
    // toast surfaces the backend error.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Library Only',
          version: '1.2.3',
          folder_name: 'LibraryOnly',
          mod_id: 'LibraryOnly',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('set_profile_mod_membership', () => {
      throw new Error('profile locked');
    });

    const modInfoByKey = new Map([
      ['LibraryOnly', mkModInfo({ name: 'Library Only', folder_name: 'LibraryOnly', mod_id: 'LibraryOnly' })],
    ]);
    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
    const row = (await screen.findByText('Library Only')).closest(
      '[data-testid="library-row"]',
    ) as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /add to "stable"/i }));

    expect(
      await screen.findByText(/Failed to update membership: profile locked/i),
    ).toBeInTheDocument();
    expect(row.querySelector('.gf-row-inpack')?.textContent).toMatch(/Not in Modpack/i);
  });

  it('display_name override is shown in the row title; folder name from manifest renders as the hint', async () => {
    // membershipDisplayName falls back to `name` when display_name is
    // empty (or whitespace). When set, the row title shows the
    // human-readable display name with the raw manifest name as a
    // secondary hint.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'raw-manifest-name',
          display_name: 'Readable Name',
          version: '9.9.9',
          folder_name: null,
          mod_id: 'raw-id',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'NoDisplayName',
          version: '1.0.0',
          folder_name: 'NoDisplayName',
          mod_id: 'no-display',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));

    render(<Wrap modpackName="Stable" />);

    // Mod with display_name renders both strings.
    expect(await screen.findByText('Readable Name')).toBeInTheDocument();
    expect(screen.getByText('raw-manifest-name')).toBeInTheDocument();
    // Mod without display_name falls back to plain `name`.
    expect((await screen.findAllByText('NoDisplayName')).length).toBeGreaterThan(0);
  });

  it('empty state (grid has no mods) renders the "No installed mods" empty card', async () => {
    // When the membership grid returns mods=[] the table shows a
    // dedicated empty state instead of an empty toolbar + body.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [],
    }));

    render(<Wrap modpackName="Stable" />);

    expect(await screen.findByText(/No installed mods/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Install mods first, then use the mod library/i),
    ).toBeInTheDocument();
  });
});

// ── modpackName=null mode (no-focus library view) ───────────────────────
//
// LibraryTable was originally always anchored to a specific modpack. The
// Library view (Mods.tsx) re-uses LibraryTable with modpackName=null so
// that the same row component renders for both surfaces.

describe('<LibraryTable modpackName={null}>', () => {
  // No-focus mode synthesizes rows from AppContext's `mods` (the
  // installed-mods array), so the test fixture only needs to seed
  // get_installed_mods — there's no per-modpack grid fetch in this
  // mode.
  function seedInstalledMods(): void {
    registerInvokeHandler('get_installed_mods', () => [
      {
        name: 'BaseLib',
        version: '1.0.0',
        description: 'Base library',
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
        folder_name: 'BaseLib',
        mod_id: 'BaseLib',
        github_url: null,
        nexus_url: null,
        pinned: false,
        min_game_version: null,
        author: null,
        tags: [],
        display_name: null,
        display_description: null,
      },
    ]);
  }

  it('does not render the per-row checkbox column', async () => {
    seedInstalledMods();
    render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    // No per-modpack membership checkbox in the row.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('does not render drag handles or in-pack rank chips', async () => {
    seedInstalledMods();
    const { container } = render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    // No drag handle.
    expect(container.querySelector('.gf-load-order-drag')).toBeNull();
    // No rank chip (#1, #2…).
    expect(screen.queryByText(/^#\d+$/)).toBeNull();
  });

  it('hides the "In this modpack first" sort option', async () => {
    const user = userEvent.setup();
    seedInstalledMods();
    render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    const sortSelect = screen.getByRole('combobox', { name: /Sort/i });
    // Default sort flipped to nameAsc.
    expect(sortSelect).toHaveTextContent('Name A-Z');
    // Open the dropdown: the in-pack option must not be offered here.
    await user.click(sortSelect);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: /In this modpack first/i })).toBeNull();
  });

  it('Updates first falls back to name order when rows have the same update state', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      mkModInfo({ name: 'Zed', folder_name: 'Zed', mod_id: 'Zed' }),
      mkModInfo({ name: 'Alpha', folder_name: 'Alpha', mod_id: 'Alpha' }),
    ]);
    const user = userEvent.setup();
    const { container } = render(<Wrap modpackName={null} />);
    await screen.findByText('Alpha');

    await chooseOption(user, /Sort/i, /Updates first/i);

    const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Alpha');
    expect(rows[1]).toContain('Zed');
  });

  it('selects a saved version from the Library without changing a modpack', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      mkModInfo({
        mod_version_id: 'watcher-143',
        name: 'Watcher',
        version: '1.4.3',
        folder_name: 'Watcher',
        mod_id: 'Watcher',
        enabled: true,
      }),
      mkModInfo({
        mod_version_id: 'watcher-130',
        name: 'Watcher',
        version: '1.3.0',
        folder_name: 'Watcher-old',
        mod_id: 'Watcher',
        enabled: false,
      }),
    ]);
    registerInvokeHandler('select_library_mod_version', () => mkModInfo({
      mod_version_id: 'watcher-130',
      name: 'Watcher',
      version: '1.3.0',
      folder_name: 'Watcher-old',
      mod_id: 'Watcher',
      enabled: true,
    }));
    const user = userEvent.setup();
    render(<Wrap modpackName={null} />);
    await screen.findAllByText('Watcher');

    await chooseOption(user, /Choose version/i, /1\.3\.0 \(stored\)/i);

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual(expect.objectContaining({
        cmd: 'select_library_mod_version',
        args: expect.objectContaining({
          currentModVersionId: 'watcher-143',
          selectedModVersionId: 'watcher-130',
        }),
      }));
    });
    expect(getInvokeCalls().some((call) => call.cmd === 'select_profile_mod_version')).toBe(false);
  });

  it('shows cached-only backend versions in the no-focus Library selector', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      mkModInfo({
        mod_version_id: 'end-run-031',
        name: 'End Run Graph',
        version: '0.3.1',
        folder_name: 'EndRunGraph-v0.3.1',
        mod_id: 'EndRunGraph',
        enabled: true,
      }),
    ]);
    registerInvokeHandler('get_library_version_options', () => ({
      'end-run-031': [
        {
          mod_version_id: 'end-run-032',
          name: 'End Run Graph',
          version: '0.3.2',
          folder_name: 'EndRunGraph-v0.3.2',
          mod_id: 'EndRunGraph',
          installed: false,
          installed_enabled: false,
          cached: true,
          pinned: false,
          used_by_profiles: [],
        },
        {
          mod_version_id: 'end-run-031',
          name: 'End Run Graph',
          version: '0.3.1',
          folder_name: 'EndRunGraph-v0.3.1',
          mod_id: 'EndRunGraph',
          installed: true,
          installed_enabled: true,
          cached: true,
          pinned: false,
          used_by_profiles: ['TesterW'],
        },
      ],
    }));

    render(<Wrap modpackName={null} />);

    const user = userEvent.setup();
    const listbox = await openSelect(user, /Choose version/i);
    expect(within(listbox).getByRole('option', { name: /0\.3\.2 \(stored\)/i })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /0\.3\.1 \(active\)/i })).toBeInTheDocument();
  });

  it('shows backend bundle options only on the owning bundle row', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      mkModInfo({
        mod_version_id: 'pretty-pack-20',
        name: 'Pretty Pack',
        version: '2.0.0',
        folder_name: 'PrettyPack',
        mod_id: null,
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/979',
        bundle_members: ['BaseLib', 'Kaguya Skin'],
        bundle_member_ids: ['BaseLib', 'KaguyaRegentMSGKSkin'],
      }),
      mkModInfo({
        mod_version_id: 'baselib-10',
        name: 'BaseLib',
        version: '1.0.0',
        folder_name: 'BaseLib',
        mod_id: 'BaseLib',
      }),
    ]);
    registerInvokeHandler('get_library_version_options', () => ({
      'pretty-pack-20': [
        {
          mod_version_id: 'pretty-pack-21',
          name: 'Pretty Pack',
          version: '2.1.0',
          folder_name: 'PrettyPack-v2.1.0',
          mod_id: null,
          bundle_member_ids: ['BaseLib', 'KaguyaRegentMSGKSkin'],
          installed: false,
          installed_enabled: false,
          cached: true,
          pinned: false,
          used_by_profiles: [],
        },
        {
          mod_version_id: 'pretty-pack-20',
          name: 'Pretty Pack',
          version: '2.0.0',
          folder_name: 'PrettyPack',
          mod_id: null,
          bundle_member_ids: ['BaseLib', 'KaguyaRegentMSGKSkin'],
          installed: true,
          installed_enabled: true,
          cached: true,
          pinned: false,
          used_by_profiles: [],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap modpackName={null} />);

    const bundleRow = (await screen.findByRole('heading', { name: 'Pretty Pack' })).closest('[data-testid="library-row"]') as HTMLElement;
    const standaloneRow = screen.getByRole('heading', { name: 'BaseLib' }).closest('[data-testid="library-row"]') as HTMLElement;
    expect(within(bundleRow).getByRole('combobox', { name: /Choose version/i })).toBeInTheDocument();
    expect(within(standaloneRow).queryByRole('combobox', { name: /Choose version/i })).toBeNull();

    const listbox = await openSelect(user, /Choose version/i);
    expect(within(listbox).getByRole('option', { name: /2\.1\.0 \(stored\)/i })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /2\.0\.0 \(active\)/i })).toBeInTheDocument();
  });

  it('shows cached-only GitHub update versions in the no-focus Library selector', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      mkModInfo({
        mod_version_id: 'watcher-142',
        name: 'Watcher',
        version: '1.4.2',
        folder_name: 'Watcher',
        mod_id: 'Watcher',
        github_url: 'https://github.com/owner/watcher',
        enabled: true,
      }),
    ]);
    registerInvokeHandler('get_library_version_options', () => ({
      'watcher-142': [
        {
          mod_version_id: 'watcher-143',
          name: 'Watcher',
          version: '1.4.3',
          folder_name: 'Watcher-v1.4.3',
          mod_id: 'Watcher',
          installed: false,
          installed_enabled: false,
          cached: true,
          pinned: false,
          used_by_profiles: [],
        },
        {
          mod_version_id: 'watcher-142',
          name: 'Watcher',
          version: '1.4.2',
          folder_name: 'Watcher',
          mod_id: 'Watcher',
          installed: true,
          installed_enabled: true,
          cached: true,
          pinned: false,
          used_by_profiles: ['TesterW'],
        },
      ],
    }));

    render(<Wrap modpackName={null} />);

    const user = userEvent.setup();
    const listbox = await openSelect(user, /Choose version/i);
    expect(within(listbox).getByRole('option', { name: /1\.4\.3 \(stored\)/i })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: /1\.4\.2 \(active\)/i })).toBeInTheDocument();
  });

  it('renders rows without the storage chip or per-row Store button', async () => {
    seedInstalledMods();
    const { container } = render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    // The active/stored chip + per-row Store/Activate button were
    // removed from the primary row.
    expect(container.querySelector('.gf-profile-library-storage')).toBeNull();
    expect(screen.queryByRole('button', { name: /Store BaseLib/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Activate BaseLib/i })).toBeNull();
  });

  it('shows the Library explainer (no reorder) and never the modpack explainer', async () => {
    seedInstalledMods();
    const { container } = render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    const help = container.querySelector('.gf-profile-library-help');
    expect(help?.textContent).toMatch(/Every mod installed on your computer/i);
    expect(help?.textContent).not.toMatch(/Drag the handle to set load order/i);
  });

  it('threads optional row action callbacks when matching mod info is available', async () => {
    seedInstalledMods();
    const modInfoByKey = new Map([
      ['BaseLib', mkModInfo({
        name: 'BaseLib',
        folder_name: 'BaseLib',
        mod_id: 'BaseLib',
        github_url: 'https://github.com/owner/baselib',
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/123',
      })],
    ]);
    render(
      <Wrap
        modpackName={null}
        modInfoByKey={modInfoByKey}
        onUpdate={vi.fn()}
        onTogglePin={vi.fn()}
        onSnooze={vi.fn()}
        onUnsnooze={vi.fn()}
        onRepair={vi.fn()}
        onRollback={vi.fn()}
        onDelete={vi.fn()}
        onCopyVersion={vi.fn()}
        onOpenThisModFolder={vi.fn()}
        onEditSources={vi.fn()}
        onFindGithubFromNexus={vi.fn()}
        onOpenExternalUrl={vi.fn()}
        onAutoDetectSource={vi.fn()}
      />,
    );
    expect(await screen.findAllByText('BaseLib')).not.toHaveLength(0);
  });

  // ── packScoped (dedicated modpack view) ───────────────────────────
  describe('packScoped', () => {
    function seedInPack() {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'PackMod',
            version: '1.0.0',
            folder_name: 'PackMod',
            mod_id: 'PackMod',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      }));
      registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));
      return new Map([
        ['PackMod', mkModInfo({ name: 'PackMod', folder_name: 'PackMod', mod_id: 'PackMod' })],
      ]);
    }

    it('hides pack sort controls, explainer, and In-Modpack badge', async () => {
      const modInfoByKey = seedInPack();
      const { container } = render(<Wrap modpackName="Stable" packScoped modInfoByKey={modInfoByKey} />);
      await screen.findByText('PackMod');
      // Search placeholder is just "Search mods…" (not "N library mods").
      expect(screen.getByPlaceholderText(/^Search mods/i)).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/library mods/i)).toBeNull();
      expect(screen.queryByRole('combobox', { name: /Sort/i })).toBeNull();
      expect(container.querySelector('.gf-profile-library-help')).toBeNull();
      expect(container.querySelector('.gf-row-inpack')).toBeNull();
      // The visible row action is "Remove from pack", not the disk trash.
      expect(container.querySelector('.gf-row-remove')).not.toBeNull();
      expect(container.querySelector('.gf-row-delete')).toBeNull();
    });

    it('defaults pack-scoped rows to the saved load order', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'SecondAlphabetically',
            version: '1.0.0',
            folder_name: 'SecondAlphabetically',
            mod_id: 'SecondAlphabetically',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 0 }],
          },
          {
            name: 'Alpha',
            version: '1.0.0',
            folder_name: 'Alpha',
            mod_id: 'Alpha',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 1 }],
          },
        ],
      }));
      const { container } = render(<Wrap modpackName="Stable" packScoped />);
      await screen.findByText('SecondAlphabetically');
      await waitFor(() => {
        const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
        expect(rows[0]).toContain('SecondAlphabetically');
        expect(rows[1]).toContain('Alpha');
      });
    });

    it('keeps pack rows in load order even when one has a download update', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'Alpha',
            version: '1.0.0',
            folder_name: 'Alpha',
            mod_id: 'Alpha',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 0 }],
          },
          {
            name: 'Beta',
            version: '1.0.0',
            folder_name: 'Beta',
            mod_id: 'Beta',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 1 }],
          },
        ],
      }));
      const auditByKey = new Map([
        ['Beta', {
          mod_name: 'Beta',
          folder_name: 'Beta',
          github_repo: 'owner/beta',
          installed_version: '1.0.0',
          latest_release_tag: 'v2.0.0',
          latest_release_with_assets_tag: 'v2.0.0',
          latest_has_assets: true,
          needs_update: true,
          asset_names: ['Beta.zip'],
          releases_scanned: 1,
          error: null,
          nexus_url: null,
          nexus_version: null,
          nexus_update_available: false,
          update_source: 'github',
          github_auto_detected: false,
          pinned: false,
          latest_compatible_tag: 'v2.0.0',
        }],
      ]);
      const modInfoByKey = new Map([
        ['Alpha', mkModInfo({ name: 'Alpha', folder_name: 'Alpha', mod_id: 'Alpha' })],
        ['Beta', mkModInfo({ name: 'Beta', folder_name: 'Beta', mod_id: 'Beta' })],
      ]);
      const { container } = render(<Wrap modpackName="Stable" packScoped auditByKey={auditByKey} modInfoByKey={modInfoByKey} />);
      await screen.findByText('Alpha');
      const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
      expect(rows[0]).toContain('Alpha');
      expect(rows[1]).toContain('Beta');
    });

    it('filters pack rows by tag without changing saved load order', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'Alpha',
            version: '1.0.0',
            folder_name: 'Alpha',
            mod_id: 'Alpha',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 0 }],
          },
          {
            name: 'Beta',
            version: '1.0.0',
            folder_name: 'Beta',
            mod_id: 'Beta',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 1 }],
          },
          {
            name: 'Gamma',
            version: '1.0.0',
            folder_name: 'Gamma',
            mod_id: 'Gamma',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 2 }],
          },
        ],
      }));
      registerInvokeHandler('select_profile_mod_version', () => ({}));
      const modInfoByKey = new Map([
        ['Alpha', mkModInfo({ name: 'Alpha', folder_name: 'Alpha', mod_id: 'Alpha', tags: ['utility'] })],
        ['Beta', mkModInfo({ name: 'Beta', folder_name: 'Beta', mod_id: 'Beta', tags: ['combat'] })],
        ['Gamma', mkModInfo({ name: 'Gamma', folder_name: 'Gamma', mod_id: 'Gamma', tags: ['utility'] })],
      ]);
      const { container } = render(<Wrap modpackName="Stable" packScoped priorityTag="utility" modInfoByKey={modInfoByKey} />);
      await screen.findByText('Alpha');
      const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Alpha');
      expect(rows[1]).toContain('Gamma');
      expect(screen.queryByText('Beta')).toBeNull();
    });

    it('falls back to grid order for legacy pack rows without order indexes', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'SecondAlphabetically',
            version: '1.0.0',
            folder_name: 'SecondAlphabetically',
            mod_id: 'SecondAlphabetically',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            name: 'Alpha',
            version: '1.0.0',
            folder_name: 'Alpha',
            mod_id: 'Alpha',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      }));
      const { container } = render(<Wrap modpackName="Stable" packScoped />);
      await screen.findByText('SecondAlphabetically');
      await waitFor(() => {
        const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
        expect(rows[0]).toContain('SecondAlphabetically');
        expect(rows[1]).toContain('Alpha');
      });
    });

    it('keeps load order as the tie-breaker when every pack row needs an update', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'Beta',
            version: '1.0.0',
            folder_name: 'Beta',
            mod_id: 'Beta',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 0 }],
          },
          {
            name: 'Alpha',
            version: '1.0.0',
            folder_name: 'Alpha',
            mod_id: 'Alpha',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true, order_index: 1 }],
          },
        ],
      }));
      const updateAudit = (name: string) => ({
        mod_name: name,
        folder_name: name,
        github_repo: `owner/${name.toLowerCase()}`,
        installed_version: '1.0.0',
        latest_release_tag: 'v2.0.0',
        latest_release_with_assets_tag: 'v2.0.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [`${name}.zip`],
        releases_scanned: 1,
        error: null,
        nexus_url: null,
        nexus_version: null,
        nexus_update_available: false,
        update_source: 'github',
        github_auto_detected: false,
        pinned: false,
        latest_compatible_tag: 'v2.0.0',
      });
      const { container } = render(
        <Wrap
          modpackName="Stable"
          packScoped
          modInfoByKey={new Map([
            ['Alpha', mkModInfo({ name: 'Alpha', folder_name: 'Alpha', mod_id: 'Alpha' })],
            ['Beta', mkModInfo({ name: 'Beta', folder_name: 'Beta', mod_id: 'Beta' })],
          ])}
          auditByKey={new Map([
            ['Alpha', updateAudit('Alpha')],
            ['Beta', updateAudit('Beta')],
          ])}
        />,
      );
      await screen.findByText('Beta');
      const rows = [...container.querySelectorAll('[data-testid="library-row"]')].map((row) => row.textContent ?? '');
      expect(rows[0]).toContain('Beta');
      expect(rows[1]).toContain('Alpha');
    });

    it('collapses multiple installed versions into one row with a selector', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('toggle_mod', () => true);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: 'v1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: 'V1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
          {
            mod_version_id: 'watcher-unknown',
            name: 'Watcher',
            version: '  ',
            folder_name: 'Watcher-unknown',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const modInfoByKey = new Map([
        ['Watcher', mkModInfo({ name: 'Watcher', folder_name: 'Watcher', mod_id: 'Watcher', version: 'v1.4.3' })],
        ['Watcher-old', mkModInfo({ name: 'Watcher', folder_name: 'Watcher-old', mod_id: 'Watcher', version: 'V1.3.0', enabled: false })],
        ['Watcher-unknown', mkModInfo({ name: 'Watcher', folder_name: 'Watcher-unknown', mod_id: 'Watcher', version: '  ', enabled: false })],
      ]);
      const { container } = render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
      await screen.findByText('Watcher');
      expect(container.querySelectorAll('[data-testid="library-row"]')).toHaveLength(1);
      const user = userEvent.setup();
      const listbox = await openSelect(user, /Choose version/i);
      expect(within(listbox).getByRole('option', { name: /1\.4\.3 \(active\)/i })).toBeInTheDocument();
      expect(within(listbox).getByRole('option', { name: /1\.3\.0 \(stored\)/i })).toBeInTheDocument();
      expect(within(listbox).getByRole('option', { name: /\? \(stored\)/i })).toBeInTheDocument();
      await user.click(within(listbox).getByRole('option', { name: /1\.3\.0 \(stored\)/i }));
      await waitFor(() => {
        expect(getInvokeCalls()).toContainEqual(expect.objectContaining({
          cmd: 'select_profile_mod_version',
          args: expect.objectContaining({
            profileId: 'Stable',
            currentModVersionId: 'watcher-143',
            selectedModVersionId: 'watcher-130',
            applyToDisk: false,
          }),
        }));
    });
  });

    it('uses backend version options so cached downloads are selectable', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            version_options: [
              {
                mod_version_id: 'watcher-150',
                name: 'Watcher',
                version: '1.5.0',
                folder_name: 'Watcher',
                mod_id: 'Watcher',
                installed: false,
                installed_enabled: false,
                cached: true,
                pinned: false,
                used_by_profiles: [],
              },
              {
                mod_version_id: 'watcher-143',
                name: 'Watcher',
                version: '1.4.3',
                folder_name: 'Watcher',
                mod_id: 'Watcher',
                installed: true,
                installed_enabled: true,
                cached: true,
                pinned: false,
                used_by_profiles: ['Stable'],
              },
            ],
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      }));
      registerInvokeHandler('select_profile_mod_version', () => ({}));
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" />);

      await chooseOption(user, /Choose version/i, /1\.5\.0 \(stored\)/i);

      await waitFor(() => {
        expect(getInvokeCalls()).toContainEqual(expect.objectContaining({
          cmd: 'select_profile_mod_version',
          args: expect.objectContaining({
            profileId: 'Stable',
            currentModVersionId: 'watcher-143',
            selectedModVersionId: 'watcher-150',
          }),
        }));
      });
    });

    it('does not collapse same-version installs or legacy rows without artifact ids', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-a',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher-A',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-b',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher-B',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
          {
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-Legacy',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const { container } = render(<Wrap modpackName="Stable" />);
      await screen.findAllByText('Watcher');
      expect(container.querySelectorAll('[data-testid="library-row"]')).toHaveLength(3);
      expect(screen.queryByRole('combobox', { name: /Choose version/i })).toBeNull();
    });

    it('uses version ordering when collapsed library versions have the same storage state', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const { container } = render(<Wrap modpackName="Stable" />);
      await screen.findByText('Watcher');
      expect(container.querySelectorAll('[data-testid="library-row"]')).toHaveLength(1);
      expect(screen.getByTitle('Version')).toHaveTextContent('manifest v1.4.3');
    });

    it('uses saved load order when duplicate included pack versions are collapsed', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      }));
      const { container } = render(<Wrap modpackName="Stable" packScoped />);
      await screen.findByText('Watcher');
      expect(container.querySelectorAll('[data-testid="library-row"]')).toHaveLength(1);
      expect(screen.getByTitle('Version')).toHaveTextContent('manifest v1.3.0');
    });

    it('pack-scoped version selector replaces the profile entry and mirrors active-pack disk state', async () => {
      registerInvokeHandler('get_active_profile', () => 'Stable');
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('toggle_mod', () => true);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const onSelectProfileVersion = vi.fn(async () => {});
      const user = userEvent.setup();
      render(
        <Wrap
          modpackName="Stable"
          packScoped
          filterRow={(row) => row.profiles.some((profile) => profile.included)}
          onSelectProfileVersion={onSelectProfileVersion}
        />,
      );
      const picker = await screen.findByRole('combobox', { name: /Choose version/i });
      await waitFor(() => expect(picker).toHaveTextContent(/1\.4\.3 \(active\)/i));
      await chooseOption(user, /Choose version/i, /1\.3\.0 \(stored\)/i);
      await waitFor(() => {
        expect(onSelectProfileVersion).toHaveBeenCalledWith(
          expect.objectContaining({ mod_version_id: 'watcher-143' }),
          expect.objectContaining({ mod_version_id: 'watcher-130' }),
          true,
        );
      });
    });

    it('pack-scoped version selector does not toggle disk state for an inactive pack', async () => {
      registerInvokeHandler('get_active_profile', () => 'Other Pack');
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('toggle_mod', () => true);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const onSelectProfileVersion = vi.fn(async () => {});
      const user = userEvent.setup();
      render(
        <Wrap
          modpackName="Stable"
          packScoped
          filterRow={(row) => row.profiles.some((profile) => profile.included)}
          onSelectProfileVersion={onSelectProfileVersion}
        />,
      );
      await chooseOption(user, /Choose version/i, /1\.3\.0 \(stored\)/i);
      await waitFor(() => expect(onSelectProfileVersion).toHaveBeenCalledWith(
        expect.objectContaining({ mod_version_id: 'watcher-143' }),
        expect.objectContaining({ mod_version_id: 'watcher-130' }),
        false,
      ));
      expect(getInvokeCalls().some((call) => call.cmd === 'toggle_mod')).toBe(false);
    });

    it('pack-scoped version selector avoids redundant disk toggles when the selected artifact is already active', async () => {
      registerInvokeHandler('get_active_profile', () => 'Stable');
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('toggle_mod', () => true);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      const onSelectProfileVersion = vi.fn(async () => {});
      const user = userEvent.setup();
      render(
        <Wrap
          modpackName="Stable"
          packScoped
          filterRow={(row) => row.profiles.some((profile) => profile.included)}
          onSelectProfileVersion={onSelectProfileVersion}
        />,
      );
      await chooseOption(user, /Choose version/i, /1\.4\.3 \(active\)/i);
      await waitFor(() => expect(onSelectProfileVersion).toHaveBeenCalledWith(
        expect.objectContaining({ mod_version_id: 'watcher-130' }),
        expect.objectContaining({ mod_version_id: 'watcher-143' }),
        true,
      ));
      expect(getInvokeCalls().some((call) => call.cmd === 'toggle_mod')).toBe(false);
    });

    it('version selector failure keeps the row visible and reports the backend error', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      registerInvokeHandler('select_profile_mod_version', () => {
        throw new Error('disk switch failed');
      });
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" />);
      await chooseOption(user, /Choose version/i, /1\.3\.0 \(stored\)/i);
      expect(await screen.findByText(/Could not select that version: disk switch failed/i)).toBeInTheDocument();
      expect(screen.getByText('Watcher')).toBeInTheDocument();
    });

    it('version selector failure reports non-Error backend failures', async () => {
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            mod_version_id: 'watcher-143',
            name: 'Watcher',
            version: '1.4.3',
            folder_name: 'Watcher',
            mod_id: 'Watcher',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
          {
            mod_version_id: 'watcher-130',
            name: 'Watcher',
            version: '1.3.0',
            folder_name: 'Watcher-old',
            mod_id: 'Watcher',
            installed_enabled: false,
            profiles: [{ profile_name: 'Stable', included: false, enabled: false, editable: true }],
          },
        ],
      }));
      registerInvokeHandler('select_profile_mod_version', () => {
        throw 'string failure';
      });
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" />);
      await chooseOption(user, /Choose version/i, /1\.3\.0 \(stored\)/i);
      expect(await screen.findByText(/Could not select that version: string failure/i)).toBeInTheDocument();
    });

    it('the visible Remove button removes the mod from the pack', async () => {
      const modInfoByKey = seedInPack();
      const user = userEvent.setup();
      const { container } = render(<Wrap modpackName="Stable" packScoped modInfoByKey={modInfoByKey} />);
      await screen.findByText('PackMod');
      await user.click(container.querySelector('.gf-row-remove') as HTMLElement);
      await waitFor(() => {
        expect(getInvokeCalls().some(
          (c) => c.cmd === 'set_profile_mod_membership' && c.args?.included === false,
        )).toBe(true);
      });
    });

    it('moves delete-from-disk into the kebab', async () => {
      const modInfoByKey = seedInPack();
      const user = userEvent.setup();
      const onDelete = vi.fn();
      render(<Wrap modpackName="Stable" packScoped modInfoByKey={modInfoByKey} onDelete={onDelete} />);
      const row = (await screen.findByText('PackMod')).closest(
        '[data-testid="library-row"]',
      ) as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /mod actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /Delete from disk/i }));
      expect(onDelete).toHaveBeenCalled();
    });
  });

  // ── coupleActiveStorage (modpack view: pack = live loadout) ───────
  describe('coupleActiveStorage', () => {
    function seedInPackActive() {
      registerInvokeHandler('get_active_profile', () => 'Stable');
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'PackMod',
            version: '1.0.0',
            folder_name: 'PackMod',
            mod_id: 'PackMod',
            installed_enabled: true,
            profiles: [
              { profile_name: 'Stable', included: true, enabled: true, editable: true },
            ],
          },
        ],
      }));
      registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));
      return new Map([
        ['PackMod', mkModInfo({ name: 'PackMod', folder_name: 'PackMod', mod_id: 'PackMod' })],
      ]);
    }

    it('removing from the ACTIVE pack also disables the mod in-game', async () => {
      const modInfoByKey = seedInPackActive();
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" coupleActiveStorage modInfoByKey={modInfoByKey} />);
      const row = (await screen.findByText('PackMod')).closest(
        '[data-testid="library-row"]',
      ) as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /mod actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /remove from "stable"/i }));

      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership' && c.args?.included === false)).toBe(true);
      });
      // Coupling: the active loadout is updated too.
      const toggleCall = getInvokeCalls().find((c) => c.cmd === 'toggle_mod');
      expect(toggleCall?.args).toMatchObject({ name: 'PackMod', folderName: 'PackMod', enable: false });
    });

    it('does NOT couple when coupleActiveStorage is off (default)', async () => {
      const modInfoByKey = seedInPackActive();
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" modInfoByKey={modInfoByKey} />);
      const row = (await screen.findByText('PackMod')).closest(
        '[data-testid="library-row"]',
      ) as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /mod actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /remove from "stable"/i }));

      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership' && c.args?.included === false)).toBe(true);
      });
      // No coupling: membership changes, the game folder is left alone.
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
    });

    it('does NOT couple when the focused pack is not the active one', async () => {
      // Active is some OTHER pack; editing "Stable" must not touch the loadout.
      registerInvokeHandler('get_active_profile', () => 'OtherPack');
      registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
      registerInvokeHandler('get_profile_memberships', () => ({
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'PackMod',
            version: '1.0.0',
            folder_name: 'PackMod',
            mod_id: 'PackMod',
            installed_enabled: true,
            profiles: [
              { profile_name: 'Stable', included: true, enabled: true, editable: true },
            ],
          },
        ],
      }));
      registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));
      const modInfoByKey = new Map([
        ['PackMod', mkModInfo({ name: 'PackMod', folder_name: 'PackMod', mod_id: 'PackMod' })],
      ]);
      const user = userEvent.setup();
      render(<Wrap modpackName="Stable" coupleActiveStorage modInfoByKey={modInfoByKey} />);
      const row = (await screen.findByText('PackMod')).closest(
        '[data-testid="library-row"]',
      ) as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /mod actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /remove from "stable"/i }));

      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership' && c.args?.included === false)).toBe(true);
      });
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
    });
  });

  // ── bundle as normal row (no-focus mode) ─────────────────────────
  // A bundle is now ONE ModInfo with bundle_members. It appears as a
  // single library-row, identical to a normal mod, but with the member
  // list and "N mods" badge rendered inside the row.
  describe('bundle renders as a normal row', () => {
    function mkBundleModInfo(): ModInfo {
      return {
        name: 'Epic Pack',
        version: '3.0.0',
        description: '',
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
        folder_name: 'EpicPack',
        mod_id: null,
        github_url: null,
        nexus_url: 'https://nexusmods.com/pack/42',
        pinned: false,
        bundle_members: ['PackCore', 'PackArt'],
        tags: [],
        display_name: null,
        display_description: null,
      };
    }

    it('a bundle ModInfo appears as ONE library-row (not a bundle-row)', async () => {
      registerInvokeHandler('get_installed_mods', () => [mkBundleModInfo()]);
      render(<Wrap modpackName={null} />);

      // One library-row for the bundle container
      const rows = await screen.findAllByTestId('library-row');
      expect(rows).toHaveLength(1);
      // No bundle-row (old grouping component is deleted)
      expect(screen.queryByTestId('bundle-row')).not.toBeInTheDocument();
    });

    it('bundle row title is the bundle name', async () => {
      registerInvokeHandler('get_installed_mods', () => [mkBundleModInfo()]);
      render(<Wrap modpackName={null} />);
      expect(
        await screen.findByRole('heading', { name: 'Epic Pack' }),
      ).toBeInTheDocument();
    });

    it('bundle row shows member names in comfortable density', async () => {
      registerInvokeHandler('get_installed_mods', () => [mkBundleModInfo()]);
      const modInfoByKey = new Map([
        ['EpicPack', mkBundleModInfo()],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} />);
      await screen.findByRole('heading', { name: 'Epic Pack' });
      expect(screen.getByText('PackCore')).toBeInTheDocument();
      expect(screen.getByText('PackArt')).toBeInTheDocument();
    });

    it('bundle row shows the "N mods" badge', async () => {
      registerInvokeHandler('get_installed_mods', () => [mkBundleModInfo()]);
      const modInfoByKey = new Map([
        ['EpicPack', mkBundleModInfo()],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} />);
      await screen.findByRole('heading', { name: 'Epic Pack' });
      expect(screen.getByText(/2 mods/i)).toBeInTheDocument();
    });
  });

  // ── reloadToken (external re-fetch trigger) ───────────────────────
  it('re-fetches the membership grid when reloadToken changes', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    let memberships = 0;
    registerInvokeHandler('get_profile_memberships', () => {
      memberships += 1;
      return {
        profiles: [{ name: 'Stable', editable: true }],
        mods: [
          {
            name: 'PackMod',
            version: '1.0.0',
            folder_name: 'PackMod',
            mod_id: 'PackMod',
            installed_enabled: true,
            profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
          },
        ],
      };
    });
    const { rerender } = render(<Wrap modpackName="Stable" reloadToken="a" />);
    await screen.findAllByText('PackMod');
    const before = memberships;
    // Bump the token → the table re-pulls the grid.
    rerender(
      <AllProviders>
        <LibraryTable modpackName="Stable" reloadToken="b" />
      </AllProviders>,
    );
    await waitFor(() => {
      expect(memberships).toBeGreaterThan(before);
    });
  });

  // ── Flow-level regression: display_name override survives the full
  //    LibraryTable pipeline (T14 gap — existing test only covered
  //    LibraryRow directly; this test covers the mocked-command →
  //    grid → filteredRows → LibraryRow render path end-to-end for
  //    BOTH focused mode and no-modpack mode).

  it('[flow] focused mode: display_name from ProfileMembershipMod reaches the row title (regression guard)', async () => {
    // In focused mode LibraryTable fetches get_profile_memberships which
    // includes ProfileMembershipMod.display_name enriched by the Rust
    // enrich_mods_with_sources layer. The grid row is passed whole to
    // LibraryRow as `row`; display_name must appear as the visible title
    // and the raw manifest name as the secondary hint only.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'MyPack' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'MyPack', editable: true }],
      mods: [
        {
          name: 'AutoPath',
          display_name: 'Autooo',
          version: '1.0.0',
          folder_name: 'AutoPath',
          mod_id: 'AutoPath',
          installed_enabled: true,
          profiles: [
            { profile_name: 'MyPack', included: true, enabled: true, editable: true },
          ],
        },
      ],
    }));

    render(<Wrap modpackName="MyPack" />);

    // The row title (h3.gf-profile-library-title) must show "Autooo".
    const title = await screen.findByRole('heading', { name: 'Autooo' });
    expect(title).toBeInTheDocument();

    // "AutoPath" must only appear as the secondary raw-name hint — NOT
    // as the heading — so the user sees their saved override prominently.
    const rawHints = screen.getAllByText('AutoPath');
    // Every instance of "AutoPath" must be a .gf-profile-library-rawname
    // span, never an h3 heading.
    for (const el of rawHints) {
      expect(el.tagName.toLowerCase()).not.toBe('h3');
      expect(el.closest('h3')).toBeNull();
    }
  });

  it('[flow] focused mode: fresh ModInfo.version wins over stale membership row version', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'MyPack' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'MyPack', editable: true }],
      mods: [
        {
          name: 'Unified Save Path',
          version: '1.0.0',
          folder_name: 'UnifiedSavePath',
          mod_id: 'UnifiedSavePath',
          installed_enabled: true,
          profiles: [
            { profile_name: 'MyPack', included: true, enabled: true, editable: true },
          ],
        },
      ],
    }));
    const modInfoByKey = new Map([
      [
        'UnifiedSavePath',
        mkModInfo({
          name: 'Unified Save Path',
          version: '1.1.3',
          folder_name: 'UnifiedSavePath',
          mod_id: 'UnifiedSavePath',
        }),
      ],
    ]);

    render(<Wrap modpackName="MyPack" modInfoByKey={modInfoByKey} />);

    expect(await screen.findByText('manifest v1.1.3')).toBeInTheDocument();
    expect(screen.queryByText('v1.0.0')).not.toBeInTheDocument();
  });

  it('[flow] no-modpack mode: display_name from AppContext mods reaches the row title (regression guard)', async () => {
    // In no-modpack mode LibraryTable synthesizes the grid from AppContext's
    // `mods` array (seeded via get_installed_mods). The synthesized row must
    // carry display_name so LibraryRow renders the user's override.
    registerInvokeHandler('get_installed_mods', () => [
      {
        name: 'AutoPath',
        display_name: 'Autooo',
        version: '1.0.0',
        description: '',
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
        folder_name: 'AutoPath',
        mod_id: 'AutoPath',
        github_url: null,
        nexus_url: null,
        pinned: false,
        min_game_version: null,
        author: null,
        tags: [],
        display_description: null,
      },
    ]);

    render(<Wrap modpackName={null} />);

    const title = await screen.findByRole('heading', { name: 'Autooo' });
    expect(title).toBeInTheDocument();

    const rawHints = screen.getAllByText('AutoPath');
    for (const el of rawHints) {
      expect(el.tagName.toLowerCase()).not.toBe('h3');
      expect(el.closest('h3')).toBeNull();
    }
  });

  describe('priorityTag ordering', () => {
    function gridFromInstalled(names: string[]) {
      registerInvokeHandler('get_installed_mods', () =>
        names.map((n) => mkModInfo({ name: n, folder_name: n, mod_id: n })),
      );
    }
    it('brings the priority tag to the top, then orders the rest by tag A–Z (untagged last)', async () => {
      gridFromInstalled(['Apple', 'Zeta', 'Mid', 'Plain']);
      const modInfoByKey = new Map([
        ['Apple', mkModInfo({ name: 'Apple', folder_name: 'Apple', tags: ['ui'] })],
        ['Zeta', mkModInfo({ name: 'Zeta', folder_name: 'Zeta', tags: ['combat'] })],
        ['Mid', mkModInfo({ name: 'Mid', folder_name: 'Mid', tags: ['combat'] })],
        ['Plain', mkModInfo({ name: 'Plain', folder_name: 'Plain', tags: [] })],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} priorityTag="combat" />);
      await screen.findByTestId('library-table');
      const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      const order = titles.filter((tt) => ['Apple', 'Zeta', 'Mid', 'Plain'].includes(tt ?? ''));
      // combat first (Mid, Zeta by name) → other tags A–Z (ui = Apple) → untagged last (Plain).
      expect(order).toEqual(['Mid', 'Zeta', 'Apple', 'Plain']);
    });

    it('is case-insensitive and hides nothing — it only reorders', async () => {
      gridFromInstalled(['Apple', 'Zeta']);
      const modInfoByKey = new Map([
        ['Apple', mkModInfo({ name: 'Apple', folder_name: 'Apple', tags: ['UI'] })],
        ['Zeta', mkModInfo({ name: 'Zeta', folder_name: 'Zeta', tags: ['combat'] })],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} priorityTag="ui" />);
      await screen.findByTestId('library-table');
      // Both rows still render (nothing filtered out); the "UI" mod is on top.
      const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      const order = titles.filter((tt) => ['Apple', 'Zeta'].includes(tt ?? ''));
      expect(order).toEqual(['Apple', 'Zeta']);
    });

    it('filters to only untagged mods when the No-tags sentinel is selected', async () => {
      gridFromInstalled(['Apple', 'Zeta', 'Plain']);
      const modInfoByKey = new Map([
        ['Apple', mkModInfo({ name: 'Apple', folder_name: 'Apple', tags: ['ui'] })],
        ['Zeta', mkModInfo({ name: 'Zeta', folder_name: 'Zeta', tags: ['combat'] })],
        ['Plain', mkModInfo({ name: 'Plain', folder_name: 'Plain', tags: [] })],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} priorityTag="__no_tags__" />);
      await screen.findByTestId('library-table');

      expect(screen.getByText('Plain')).toBeInTheDocument();
      expect(screen.queryByText('Apple')).toBeNull();
      expect(screen.queryByText('Zeta')).toBeNull();
    });

    it('with no priorityTag, uses the normal sort (no tag reordering)', async () => {
      gridFromInstalled(['Zeta', 'Apple']);
      const modInfoByKey = new Map([
        ['Zeta', mkModInfo({ name: 'Zeta', folder_name: 'Zeta', tags: ['combat'] })],
        ['Apple', mkModInfo({ name: 'Apple', folder_name: 'Apple', tags: ['ui'] })],
      ]);
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} />);
      // Default no-focus sort is nameAsc → Apple before Zeta (by name, not tag).
      const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
      const order = titles.filter((tt) => ['Apple', 'Zeta'].includes(tt ?? ''));
      expect(order).toEqual(['Apple', 'Zeta']);
    });

    it('handles a 100-mod library without error', async () => {
      const names = Array.from({ length: 100 }, (_, i) => `Mod${String(i).padStart(3, '0')}`);
      gridFromInstalled(names);
      const modInfoByKey = new Map(names.map((n, i) => [n, mkModInfo({ name: n, folder_name: n, tags: i % 2 ? ['alpha'] : [] })]));
      render(<Wrap modpackName={null} modInfoByKey={modInfoByKey} priorityTag="alpha" pageSize={200} />);
      await screen.findByTestId('library-table');
      // Odd-indexed mods are tagged ['alpha'] → priority → first 50; even (untagged) → last 50.
      const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
      const suffix = (tt: string) => Number(tt.replace('Mod', ''));
      expect(titles).toHaveLength(100);
      expect(titles.slice(0, 50).every((tt) => suffix(tt) % 2 === 1)).toBe(true);   // tagged (odd) on top
      expect(titles.slice(50).every((tt) => suffix(tt) % 2 === 0)).toBe(true);      // untagged (even) last
    });
  });

  it('pins the scroll position when a row mutates, so the user is never yanked to the top', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib', version: '1.0.0', folder_name: 'BaseLib', mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [{ profile_name: 'Stable', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => null);

    const modInfoByKey = new Map([
      ['BaseLib', mkModInfo({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib' })],
    ]);
    const { container } = render(
      <AllProviders>
        <div data-scroller="yes">
          <LibraryTable modpackName="Stable" modInfoByKey={modInfoByKey} />
        </div>
      </AllProviders>,
    );
    await screen.findAllByText('BaseLib');

    // jsdom reports 0 layout, so fake a real scroll container around the table
    // so pinScroll can find it and engage.
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
      await userEvent.click(
        screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
      );
      // Simulate the engine yanking the list to the top mid-operation…
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
});
