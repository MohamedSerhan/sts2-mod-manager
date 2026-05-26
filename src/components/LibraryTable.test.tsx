/**
 * LibraryTable tests — extracted from Profiles.test.tsx after the
 * 1.7.0 T16 restructure. The component focuses on a single modpack's
 * mod editor: search + sort + bulk Store + per-row toggle membership
 * + per-row store/activate + drag-reorder the in-pack subset.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    await screen.findAllByText('First');
    // Both rows are "in-pack" so both are draggable.
    const rows = container.querySelectorAll('.gf-profile-library-row');
    expect(rows.length).toBe(2);
    const [firstRow, secondRow] = Array.from(rows) as HTMLElement[];
    // Build a minimal DataTransfer mock that satisfies the React drag
    // handlers — they read/write text/plain.
    const dataTransfer = {
      data: new Map<string, string>(),
      setData(type: string, value: string) { this.data.set(type, value); },
      getData(type: string) { return this.data.get(type) ?? ''; },
      effectAllowed: '',
      dropEffect: '',
    };
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.dragStart(secondRow, { dataTransfer });
    fireEvent.dragOver(firstRow, { dataTransfer });
    fireEvent.drop(firstRow, { dataTransfer });

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_load_order'),
      ).toBe(true);
    });
  });
});
