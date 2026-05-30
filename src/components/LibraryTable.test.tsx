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

// Membership is now changed from the per-row kebab, which only renders
// when the row has a matching ModInfo (passed via modInfoByKey). This
// factory builds that ModInfo so the kebab + its "Add/Remove from pack"
// item are present in membership tests.
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
          profileName: 'Stable',
          modName: 'NewMod',
          folderName: 'NewMod',
          modId: 'NewMod',
          included: true,
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
    await user.selectOptions(screen.getByRole('combobox', { name: /Sort/i }), 'nameDesc');
    expect(titles()[0]).toContain('Zeta');
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
    await user.click(await screen.findByRole('button', { name: /Enable & add/i }));
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
    await user.click(await screen.findByRole('button', { name: /^Enable only$/i }));
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
    await user.click(await screen.findByRole('button', { name: /Keep it stored/i }));
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
    expect(screen.queryByRole('button', { name: /^Enable only$/i })).toBeNull();
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
    expect(screen.queryByRole('button', { name: /^Enable only$/i })).toBeNull();
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
    seedInstalledMods();
    render(<Wrap modpackName={null} />);
    await screen.findAllByText('BaseLib');
    const sortSelect = screen.getByRole('combobox', { name: /Sort/i });
    // Default sort flipped to nameAsc.
    expect(sortSelect).toHaveValue('nameAsc');
    expect(screen.queryByRole('option', { name: /In this modpack first/i })).toBeNull();
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

    it('hides the sort control, explainer, and In-Modpack badge', async () => {
      const modInfoByKey = seedInPack();
      const { container } = render(<Wrap modpackName="Stable" packScoped modInfoByKey={modInfoByKey} />);
      await screen.findByText('PackMod');
      // Search placeholder is just "Search mods…" (not "N library mods").
      expect(screen.getByPlaceholderText(/^Search mods/i)).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/library mods/i)).toBeNull();
      expect(container.querySelector('.gf-sort-control')).toBeNull();
      expect(container.querySelector('.gf-profile-library-help')).toBeNull();
      expect(container.querySelector('.gf-row-inpack')).toBeNull();
      // The visible row action is "Remove from pack", not the disk trash.
      expect(container.querySelector('.gf-row-remove')).not.toBeNull();
      expect(container.querySelector('.gf-row-delete')).toBeNull();
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
});
