/**
 * LibraryTable tests — extracted from Profiles.test.tsx after the
 * 1.7.0 T16 restructure. The component focuses on a single modpack's
 * mod editor: search + sort + bulk Store + per-row toggle membership
 * + per-row store/activate + drag-reorder the in-pack subset.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LibraryTable } from './LibraryTable';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { Profile } from '../types';

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

  it('membership toggle calls set_profile_mod_membership for the focused modpack', async () => {
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

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);

    await screen.findAllByText('NewMod');
    const checkbox = screen.getByRole('checkbox', { name: /Toggle NewMod in Stable/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

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
    expect(checkbox).toBeChecked();
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

  it('store/activate button calls toggle_mod and updates the row label', async () => {
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

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);
    await screen.findAllByText('Idle');
    await user.click(
      await screen.findByRole('button', { name: /Store Idle/i }),
    );
    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'toggle_mod',
        args: { name: 'Idle', folderName: 'Idle', enable: false },
      });
    });
    // After storage, row's storage chip flips to "Stored".
    expect(await screen.findByText(/^Stored$/i)).toBeInTheDocument();
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

    const { container } = render(<Wrap modpackName="Stable" />);
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

  it('editable=false (followed modpack) disables the checkbox + shows the Read-only badge', async () => {
    // Followed modpacks come back with `editable: false`. The checkbox
    // must be disabled (no toggle attempt fired) and the row must
    // explain why with a Read-only badge.
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

    render(<Wrap modpackName="Friend Pack" />);

    expect(
      await screen.findByRole('checkbox', { name: /Toggle BaseLib in Friend Pack/i }),
    ).toBeDisabled();
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument();
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

  it('membership update failure → toast fires + checkbox stays unchecked', async () => {
    // set_profile_mod_membership throws; the optimistic patch must NOT
    // apply, the checkbox must stay in its pre-click state, and the
    // failure toast surfaces the backend error.
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

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);
    const checkbox = await screen.findByRole('checkbox', { name: /Toggle Library Only in Stable/i });
    await user.click(checkbox);

    expect(
      await screen.findByText(/Failed to update membership: profile locked/i),
    ).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('bulk-store unused active mods — happy path: stores only the unused-active ones + success toast', async () => {
    // The toolbar "Store N unused active mods" button calls
    // handleStoreUnused (LibraryTable.tsx:371-417). Only rows that are
    // (a) installed_enabled=true AND (b) not in ANY profile should be
    // toggled off. Rows in a profile, or already stored, are skipped.
    registerInvokeHandler('list_profiles_cmd', () => [
      baseProfile({ name: 'Stable' }),
      baseProfile({ name: 'Beta' }),
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [
        { name: 'Stable', editable: true },
        { name: 'Beta', editable: true },
      ],
      mods: [
        {
          name: 'Unused Active',
          version: '1.0.0',
          folder_name: 'UnusedActive',
          mod_id: 'unused-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Used Active',
          version: '1.0.0',
          folder_name: 'UsedActive',
          mod_id: 'used-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Unused Stored',
          version: '1.0.0',
          folder_name: 'UnusedStored',
          mod_id: 'unused-stored',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);

    const user = userEvent.setup();
    render(<Wrap modpackName="Stable" />);
    await screen.findAllByText('Unused Active');

    await user.click(screen.getByRole('button', { name: /Store 1 unused active mod/i }));

    await waitFor(() => {
      const toggles = getInvokeCalls().filter((c) => c.cmd === 'toggle_mod');
      // Only the "Unused Active" row gets toggled off.
      expect(toggles).toEqual([
        {
          cmd: 'toggle_mod',
          args: {
            name: 'Unused Active',
            folderName: 'UnusedActive',
            enable: false,
          },
        },
      ]);
    });
    expect(await screen.findByText(/Stored 1 unused active mod/i)).toBeInTheDocument();
  });

  it('bulk-store partial failure → aggregate error + successful items still applied', async () => {
    // Two unused-active mods. One toggle_mod call succeeds, the other
    // fails. The success path should still flip the storage chip on
    // the successful row; the aggregate error toast must list the
    // failed mod by display name.
    registerInvokeHandler('list_profiles_cmd', () => [baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Stores Cleanly',
          version: '1.0.0',
          folder_name: 'StoresCleanly',
          mod_id: 'stores-cleanly',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Fails To Store',
          version: '1.0.0',
          folder_name: 'FailsToStore',
          mod_id: 'fails-to-store',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', (args) => {
      if (args?.name === 'Fails To Store') throw new Error('busy');
      return undefined;
    });

    const user = userEvent.setup();
    const { container } = render(<Wrap modpackName="Stable" />);
    await screen.findAllByText('Stores Cleanly');
    await user.click(screen.getByRole('button', { name: /Store 2 unused active mods/i }));

    await waitFor(() => {
      expect(getInvokeCalls().filter((c) => c.cmd === 'toggle_mod')).toHaveLength(2);
    });
    // Success row flipped to Stored; failed row stayed Active in game.
    const rows = Array.from(container.querySelectorAll('.gf-profile-library-row')) as HTMLElement[];
    const storesRow = rows.find((r) => r.textContent?.includes('Stores Cleanly'));
    const failsRow = rows.find((r) => r.textContent?.includes('Fails To Store'));
    expect(storesRow?.textContent).toMatch(/Stored/);
    expect(failsRow?.textContent).toMatch(/Active in game/);
    expect(
      await screen.findByText(/Stored 1 of 2 unused active mods\. Failed: Fails To Store/i),
    ).toBeInTheDocument();
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
