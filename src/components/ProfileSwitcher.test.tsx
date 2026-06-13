import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProfileSwitcher } from './ProfileSwitcher';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap(props: { onClose?: () => void; onAddPack?: () => void; onManageAll?: () => void } = {}) {
  return (
    <AllProviders>
      <ProfileSwitcher
        onClose={props.onClose ?? (() => {})}
        onAddPack={props.onAddPack ?? (() => {})}
        onManageAll={props.onManageAll ?? (() => {})}
      />
    </AllProviders>
  );
}

const PROFILES = [
  { name: 'My Pack', mods: [{ name: 'A' }, { name: 'B' }], created_at: '2026-01-01' },
  { name: 'Other', mods: [], created_at: '2026-02-01' },
  { name: 'vanilla', mods: [], created_at: '2026-01-01' }, // hidden from list
];

describe('<ProfileSwitcher>', () => {
  it('renders a loading state, then the profile list', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('check_subscription_updates', () => []);
    render(<Wrap />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('My Pack')).toBeInTheDocument();
    });
  });

  it('hides any profile literally named "Vanilla"', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('My Pack')).toBeInTheDocument();
    });
    expect(screen.queryByText('vanilla')).toBeNull();
  });

  it('shows the empty state when no profiles exist', async () => {
    registerInvokeHandler('list_profiles_cmd', () => []);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/No modpacks yet/i)).toBeInTheDocument();
    });
  });

  it('counts mods with proper pluralization', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Alpha', mods: [{ name: 'X' }], created_at: '2026-01-01' },
      { name: 'Beta', mods: [{ name: 'X' }, { name: 'Y' }], created_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.getByText('1 mod')).toBeInTheDocument();
    expect(screen.getByText('2 mods')).toBeInTheDocument();
  });

  it('shows pending updates count alongside mods count', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Alpha', mods: [{ name: 'A' }, { name: 'B' }], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: 'Alpha',
        has_update: true,
        added_mods: [{ name: 'X' }],
        updated_mods: [{ name: 'Y' }],
        removed_mods: [],
      },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/2 mods · 2 updates/)).toBeInTheDocument();
    });
  });

  it('shows singular pending-update copy and falls back to P initials when a name has no initials', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: '_', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: '_',
        has_update: true,
        added_mods: [],
        updated_mods: [],
        removed_mods: [{ name: 'Gone' }],
      },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/0 mods .* 1 update/)).toBeInTheDocument();
    });
    expect(screen.getByText('P')).toBeInTheDocument();
  });

  it('treats profile-list and update-check failures as an empty usable list', async () => {
    registerInvokeHandler('list_profiles_cmd', () => {
      throw new Error('profiles unavailable');
    });
    registerInvokeHandler('check_subscription_updates', () => {
      throw new Error('offline');
    });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/No modpacks yet/i)).toBeInTheDocument();
    });
  });

  it('switching to the already-active profile just closes', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('My Pack')).toBeInTheDocument();
    });
    await user.click(screen.getByText('My Pack'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // No switch_profile invoke should have been called.
    expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(false);
  });

  it('switching to a different profile invokes switch_profile + closes on success', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 0,
      missing_mods: [],
      activated: true,
    }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Other')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Other'));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const switched = getInvokeCalls().filter((c) => c.cmd === 'switch_profile');
    expect(switched.length).toBe(1);
    expect(switched[0].args).toEqual({ name: 'Other' });
  });

  it('switching to a different profile records the launch for Home "Recent modpacks"', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 0,
      missing_mods: [],
      activated: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Other')).toBeInTheDocument();
    });
    const before = Date.now();
    await user.click(screen.getByText('Other'));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(true);
    });
    const map = JSON.parse(localStorage.getItem('sts2mm-modpack-launches') ?? '{}');
    expect(typeof map.Other).toBe('number');
    expect(map.Other).toBeGreaterThanOrEqual(before);
  });

  it('keeps the current profile active when drift confirmation is cancelled', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('get_profile_drift', () => ({
      has_drift: true,
      added: ['Loose Mod'],
      removed: [],
      toggled: [],
      version_changed: [],
    }));
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 0,
      missing_mods: [],
      activated: true,
    }));

    const user = userEvent.setup();
    render(<Wrap />);

    await screen.findByText('Other');
    await waitFor(() => {
      expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Other'));

    expect(await screen.findByText(/Switch away from "My Pack"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay here' }));

    await waitFor(() => {
      expect(screen.queryByText(/Switch away from "My Pack"/)).toBeNull();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(false);
  });

  it('switches after confirming drift and reports missing restored-pack mods', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('get_profile_drift', () => ({
      has_drift: true,
      added: ['Loose Mod'],
      removed: [],
      toggled: [],
      version_changed: [],
    }));
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 1,
      missing_mods: ['ManualOnly'],
      activated: true,
    }));

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);

    await screen.findByText('Other');
    await waitFor(() => {
      expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Other'));
    await user.click(await screen.findByRole('button', { name: 'Switch anyway' }));

    await waitFor(() => {
      expect(screen.getByText(/1 mod\(s\) downloaded\. 1 still missing/)).toBeInTheDocument();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('reports installed pack mods that could not be activated after switch retries', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
      failed_enables: ['LockedMod'],
      activated: true,
    }));

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);

    await screen.findByText('Other');
    await user.click(screen.getByText('Other'));

    await waitFor(() => {
      expect(screen.getByText(/1 could not activate: LockedMod/)).toBeInTheDocument();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('foot buttons call onAddPack / onManageAll AND onClose', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    const onClose = vi.fn();
    const onAddPack = vi.fn();
    const onManageAll = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} onAddPack={onAddPack} onManageAll={onManageAll} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add modpack/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Add modpack/i }));
    expect(onAddPack).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    await user.click(screen.getByRole('button', { name: /Manage all/i }));
    expect(onManageAll).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key closes the popover', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('My Pack')).toBeInTheDocument();
    });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('outside click closes the popover after the deferred listener is attached', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    const onClose = vi.fn();
    render(<Wrap onClose={onClose} />);
    await screen.findByText('My Pack');
    await waitFor(() => {
      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalled();
    });
  });
});
