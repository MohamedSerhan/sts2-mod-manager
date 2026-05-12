import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
      expect(screen.getByText(/No profiles yet/i)).toBeInTheDocument();
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

  it('foot buttons call onAddPack / onManageAll AND onClose', async () => {
    registerInvokeHandler('list_profiles_cmd', () => PROFILES);
    const onClose = vi.fn();
    const onAddPack = vi.fn();
    const onManageAll = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} onAddPack={onAddPack} onManageAll={onManageAll} />);
    await waitFor(() => {
      expect(screen.getByText(/Add pack/)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/Add pack/));
    expect(onAddPack).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    await user.click(screen.getByText(/Manage all/));
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
});
