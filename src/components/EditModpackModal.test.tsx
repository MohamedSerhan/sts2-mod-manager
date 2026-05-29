/**
 * EditModpackModal — bulk membership edit via the shared checkbox picker.
 * On save it applies only the diff (added + removed) against the manifest,
 * and on the active pack also toggles the mods in-game.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EditModpackModal } from './EditModpackModal';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModInfo, Profile, ProfileMod } from '../types';

const modInfo = (overrides: Partial<ModInfo> = {}): ModInfo =>
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
    ...overrides,
  } as ModInfo);

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

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'Sample',
    mods: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    game_version: '0.105.0',
    ...overrides,
  } as Profile);

function Wrap(props: React.ComponentProps<typeof EditModpackModal>) {
  return (
    <AllProviders>
      <EditModpackModal {...props} />
    </AllProviders>
  );
}

describe('<EditModpackModal>', () => {
  it('pre-selects the pack\'s current mods', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'PackMod', folder_name: 'PackMod' }),
      modInfo({ name: 'LibMod', folder_name: 'LibMod' }),
    ]);
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onClose={vi.fn()}
      />,
    );
    // The pack member is checked, the library mod is not.
    const packBox = await screen.findByLabelText('PackMod');
    const libBox = screen.getByLabelText('LibMod');
    expect(packBox).toBeChecked();
    expect(libBox).not.toBeChecked();
  });

  it('saves only the diff: adds newly-checked, removes unchecked', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'Keep', folder_name: 'Keep', mod_id: 'Keep' }),
      modInfo({ name: 'Drop', folder_name: 'Drop', mod_id: 'Drop' }),
      modInfo({ name: 'AddMe', folder_name: 'AddMe', mod_id: 'AddMe' }),
    ]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({
          mods: [
            profileMod({ name: 'Keep', folder_name: 'Keep', mod_id: 'Keep' }),
            profileMod({ name: 'Drop', folder_name: 'Drop', mod_id: 'Drop' }),
          ],
        })}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    // Uncheck Drop, check AddMe; leave Keep alone.
    await user.click(await screen.findByLabelText('Drop'));
    await user.click(screen.getByLabelText('AddMe'));
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const membership = getInvokeCalls().filter((c) => c.cmd === 'set_profile_mod_membership');
    const byMod = Object.fromEntries(membership.map((c) => [c.args?.modName, c.args?.included]));
    expect(byMod).toEqual({ AddMe: true, Drop: false });
    // Keep was untouched (no call for it).
    expect(byMod.Keep).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it('on the ACTIVE pack, also toggles the mods in-game', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'Drop', folder_name: 'Drop' }),
      modInfo({ name: 'AddMe', folder_name: 'AddMe' }),
    ]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Sample' }));
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'Drop', folder_name: 'Drop' })] })}
        onClose={vi.fn()}
      />,
    );
    await user.click(await screen.findByLabelText('AddMe'));
    await user.click(screen.getByLabelText('Drop'));
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const toggles = getInvokeCalls().filter((c) => c.cmd === 'toggle_mod');
      const byMod = Object.fromEntries(toggles.map((c) => [c.args?.name, c.args?.enable]));
      expect(byMod).toEqual({ AddMe: true, Drop: false });
    });
  });

  it('closes without any membership calls when nothing changed', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'PackMod', folder_name: 'PackMod' }),
    ]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onClose={onClose}
      />,
    );
    await screen.findByLabelText('PackMod');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(onClose).toHaveBeenCalled();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  });

  it('surfaces an error toast when a membership write fails', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'AddMe', folder_name: 'AddMe' }),
    ]);
    registerInvokeHandler('set_profile_mod_membership', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap profile={baseProfile({ mods: [] })} onClose={vi.fn()} />);
    await user.click(await screen.findByLabelText('AddMe'));
    await user.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(await screen.findByText(/Couldn't save changes: locked/i)).toBeInTheDocument();
  });

  it('passes null folder_name/mod_id through for sideloaded mods (add + remove)', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      modInfo({ name: 'SideRemove', folder_name: null, mod_id: null }),
      modInfo({ name: 'SideAdd', folder_name: null, mod_id: null }),
    ]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'SideRemove', folder_name: null, mod_id: null })] })}
        onClose={vi.fn()}
      />,
    );
    await user.click(await screen.findByLabelText('SideRemove')); // uncheck → remove
    await user.click(screen.getByLabelText('SideAdd')); // check → add
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const calls = getInvokeCalls().filter((c) => c.cmd === 'set_profile_mod_membership');
      const add = calls.find((c) => c.args?.modName === 'SideAdd');
      const remove = calls.find((c) => c.args?.modName === 'SideRemove');
      expect(add?.args).toMatchObject({ folderName: null, modId: null, included: true });
      expect(remove?.args).toMatchObject({ folderName: null, modId: null, included: false });
    });
  });

  it('Cancel closes without saving', async () => {
    registerInvokeHandler('get_installed_mods', () => [modInfo({ name: 'AddMe', folder_name: 'AddMe' })]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap profile={baseProfile({ mods: [] })} onClose={onClose} />);
    await user.click(await screen.findByLabelText('AddMe'));
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  });
});
