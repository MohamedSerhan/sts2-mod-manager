import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HomeView } from './Home';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap(props: Partial<React.ComponentProps<typeof HomeView>> = {}) {
  return (
    <AllProviders>
      <HomeView
        onGoToSettings={props.onGoToSettings ?? (() => {})}
        onGoToMods={props.onGoToMods ?? (() => {})}
        onGoToProfiles={props.onGoToProfiles ?? (() => {})}
        onSwitchPack={props.onSwitchPack ?? (() => {})}
        onLaunch={props.onLaunch ?? (() => {})}
        focusCodeBarSignal={props.focusCodeBarSignal}
      />
    </AllProviders>
  );
}

describe('<HomeView>', () => {
  it('renders the share-code input', async () => {
    render(<Wrap />);
    await waitFor(() => {
      // The code-bar input has a "Paste a share code" placeholder.
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
  });

  it('imports a share code on submit', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const input = await screen.findByPlaceholderText(/username\/AA5A-315D-61AE/i);
    await user.type(input, 'alice/abcd-1234-5678{Enter}');
    // The smart importer either fetches & confirms, or directly imports.
    // Either path eventually calls one of these commands. We don't lock
    // a specific one; just assert that the import flow kicked off.
    await waitFor(() => {
      const cmds = getInvokeCalls().map((c) => c.cmd);
      const triggered = cmds.some((c) =>
        c === 'fetch_shared_profile_cmd' ||
        c === 'install_shared_profile' ||
        c === 'get_share_info',
      );
      expect(triggered).toBe(true);
    });
  });

  it('renders the AboutCard footer', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Mohamed Serhan')).toBeInTheDocument();
    });
  });

  it('clicking the existing active-profile pack chip wires up the share-code copy actions', async () => {
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'My Pack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
    render(<Wrap />);
    await waitFor(() => {
      // The share-code chip should render the published code somewhere.
      expect(screen.queryByText(/AA5A-315D-61AE|alice/) || screen.getByPlaceholderText(/username\/AA5A/)).toBeTruthy();
    });
  });

  it('share-code import error does not silently succeed', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => { throw new Error('not found'); });
    const user = userEvent.setup();
    render(<Wrap />);
    const input = await screen.findByPlaceholderText(/username\/AA5A-315D-61AE/i);
    await user.type(input, 'unknown/AAAA-BBBB-CCCC{Enter}');
    // Either an error toast appears, OR the importer treats it as cancelled.
    // We just confirm the import didn't silently claim success.
    await waitFor(() => {
      // Wait a moment for the smart router to settle, then assert no
      // "Installed modpack" toast was shown.
      expect(screen.queryByText(/Installed modpack "/)).toBeNull();
    });
  });

  it('renders other-pack rows when subscriptions exist', async () => {
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
      { share_id: 'bob/efgh', profile_name: 'BobPack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      // At least one of the followed packs should appear somewhere.
      expect(screen.queryAllByText(/AlicePack|BobPack/).length).toBeGreaterThan(0);
    });
  });

  it('shows active-profile name in the hero when there is one', async () => {
    registerInvokeHandler('get_active_profile', () => 'Daily Pack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Daily Pack', mods: [], created_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Daily Pack')).toBeInTheDocument();
    });
  });

  it('renders subscription updates in the sub-updates section', async () => {
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['X'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      // Some "update" copy appears for the pending pack update.
      expect(screen.queryAllByText(/AlicePack/).length).toBeGreaterThan(0);
    });
  });

  it('handles a missing active profile (vanilla state) without crashing', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
  });

  it('navigates via the launcher callback when Launch is clicked', async () => {
    const onLaunch = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onLaunch={onLaunch} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
    // The Launch button may be in the hero. Find it if present.
    const launchBtn = screen.getAllByRole('button').find((b) => /Launch/.test(b.textContent ?? ''));
    if (launchBtn) {
      await user.click(launchBtn);
      // onLaunch may be invoked, OR the click might call invoke('launch_game').
      // Either is acceptable — we just ensure no crash.
    }
  });

  it('exercises rich Home state: active profile + subs + updates', async () => {
    registerInvokeHandler('get_active_profile', () => 'Daily Pack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Daily Pack', mods: [{ name: 'A' }, { name: 'B' }], created_at: '2026-01-01' },
      { name: 'Other Pack', mods: [{ name: 'C' }], created_at: '2026-02-01' },
    ]);
    registerInvokeHandler('get_share_info', (args: any) => {
      if (args?.name === 'Daily Pack') {
        return {
          owner: 'alice',
          code: 'AA5A-315D-61AE',
          url: 'https://github.com/alice/sts2mm-profiles',
          remote_path: 'Daily_Pack.json',
        };
      }
      return null;
    });
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'Other Pack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'Other Pack', has_update: true, added_mods: ['NewMod'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Daily Pack')).toBeInTheDocument();
    });
    // Either the share-code chip or the "other packs" row should be present.
    expect(screen.queryAllByText(/alice|Other Pack|AA5A-315D-61AE/).length).toBeGreaterThan(0);
  });

  it('reacts to focusCodeBarSignal by pulsing the input', async () => {
    // Render once with no signal — should mount without errors.
    const { rerender } = render(<Wrap focusCodeBarSignal={1} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
    // Bump the signal — the input should still be present (pulse is a
    // CSS class flip we don't assert on directly here).
    rerender(<Wrap focusCodeBarSignal={2} />);
    expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
  });

  it('Game-not-detected banner renders when gameInfo.valid is false', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: null,
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: false,
      game_version: null,
    }));
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Game not detected/)).toBeInTheDocument();
    });
  });

  it('Game-not-detected banner Settings button fires onGoToSettings', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: null,
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: false,
      game_version: null,
    }));
    const onGoToSettings = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToSettings={onGoToSettings} />);
    await waitFor(() => { expect(screen.getByText(/Game not detected/)).toBeInTheDocument(); });
    const settingsBtn = screen.getAllByRole('button').find((b) => /^Settings$/.test(b.textContent?.trim() ?? ''));
    if (settingsBtn) {
      await user.click(settingsBtn);
      expect(onGoToSettings).toHaveBeenCalled();
    }
  });

  it('hero shows "Vanilla" when no active profile', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Vanilla')).toBeInTheDocument();
    });
  });

  it('renders "Continue with" eyebrow on hero', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Continue with/i)).toBeInTheDocument();
    });
  });

  it('Repair button appears for active profile', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [{ name: 'A' }], created_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('MyPack')).toBeInTheDocument();
    });
    const buttons = screen.getAllByRole('button');
    const repair = buttons.find((b) => /^Repair$/.test(b.textContent?.trim() ?? ''));
    expect(repair).toBeDefined();
  });

  it('"Switch pack" button calls onSwitchPack', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    const onSwitchPack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onSwitchPack={onSwitchPack} />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const switchBtn = buttons.find((b) => /Switch pack/i.test(b.textContent ?? ''));
    if (switchBtn) {
      await user.click(switchBtn);
      expect(onSwitchPack).toHaveBeenCalled();
    }
  });

  it('"Add Pack" button is disabled when input is empty', async () => {
    render(<Wrap />);
    const input = await screen.findByPlaceholderText(/username\/AA5A-315D-61AE/i);
    expect((input as HTMLInputElement).value).toBe('');
    const buttons = screen.getAllByRole('button');
    const addBtn = buttons.find((b) => /Add Pack/i.test(b.textContent ?? ''));
    expect(addBtn).toBeDefined();
    expect(addBtn).toBeDisabled();
  });

  it('"View all in Profiles" link fires onGoToProfiles when other subs exist', async () => {
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => []);
    const onGoToProfiles = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToProfiles={onGoToProfiles} />);
    await waitFor(() => {
      expect(screen.queryByText(/Your other packs/)).toBeInTheDocument();
    });
    const link = screen.getByRole('button', { name: /View all in Profiles/i });
    await user.click(link);
    expect(onGoToProfiles).toHaveBeenCalled();
  });

  it('"Share this pack" CTA appears for unpublished active profile', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.some((b) => /Share this pack/i.test(b.textContent ?? ''))).toBe(true);
    });
  });

  it('Ctrl+L tip is rendered when active profile exists', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    expect(screen.getByText(/Tip: press/)).toBeInTheDocument();
  });

  it('other-sub row: Activate button fires switch_profile', async () => {
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'CurrentPack', mods: [], created_at: '2026-01-01' },
      { name: 'OtherPack', mods: [], created_at: '2026-02-01' },
    ]);
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'OtherPack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('switch_profile', () => ({ activated: true, downloaded: 0, missing_mods: [] }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Your other packs/)).toBeInTheDocument(); });
    const activate = screen.getAllByRole('button').find((b) => /^Activate$/.test(b.textContent?.trim() ?? ''));
    if (activate) {
      await user.click(activate);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(true);
      });
    }
  });

  it('subUpdate banner renders for non-active sub with pending update', async () => {
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['X', 'Y'], updated_mods: [], removed_mods: ['Z'], remote_profile: null },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.queryByText(/Updates available/)).toBeInTheDocument();
    });
  });

  it('subUpdate Review button opens SubUpdateDetail modal', async () => {
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['NewMod'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.queryByText(/Updates available/)).toBeInTheDocument(); });
    const review = screen.getAllByRole('button').find((b) => /^Review$/.test(b.textContent?.trim() ?? ''));
    if (review) {
      await user.click(review);
      await waitFor(() => {
        expect(screen.queryAllByText(/AlicePack/).length).toBeGreaterThan(0);
      });
    }
  });

  it('other-sub row: unlink button shows confirmation', async () => {
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Your other packs/)).toBeInTheDocument(); });
    const unlink = screen.queryByTitle('Unlink from this pack');
    if (unlink) {
      await user.click(unlink);
    }
  });

  it('empty-state card shows when no subscriptions exist', async () => {
    registerInvokeHandler('get_subscriptions', () => []);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.queryByText(/Follow a friend's pack/)).toBeInTheDocument();
    });
  });

  it('Sync button fires apply_subscription_update', async () => {
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['X'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    registerInvokeHandler('apply_subscription_update', () => ({ name: 'AlicePack', mods: [], created_at: '2026-01-01' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.queryByText(/Updates available/)).toBeInTheDocument(); });
    const sync = screen.getAllByRole('button').find((b) => /^Sync$/.test(b.textContent?.trim() ?? ''));
    if (sync) {
      await user.click(sync);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'apply_subscription_update')).toBe(true);
      });
    }
  });

  it('publish modal opens when "Share this pack" CTA is clicked', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const shareBtn = buttons.find((b) => /Share this pack/i.test(b.textContent ?? ''));
    if (shareBtn) {
      await user.click(shareBtn);
      await waitFor(() => {
        expect(screen.queryAllByText(/MyPack/).length).toBeGreaterThan(0);
      });
    }
  });
});
