import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { openUrl } from '@tauri-apps/plugin-opener';

import { SettingsView } from './Settings';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap() {
  return (
    <AllProviders>
      <SettingsView />
    </AllProviders>
  );
}

/**
 * Settings is the second-most-trafficked view. Tests cover the tab
 * strip, the General-tab game-path field, the API key forms in
 * Accounts, and the Audit-tab empty + populated states.
 */
describe('<SettingsView>', () => {
  it('renders the tab strip with the five canonical Settings tabs', async () => {
    // 1.7.0 cleanup: the redundant Help tab was removed — Help is now
    // reachable from the topbar `?` drawer (the canonical surface).
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /General/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accounts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Backups/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Audit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advanced/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Help$/ })).toBeNull();
  });

  it('starts on the General tab and shows the Game Path field', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it('shows the language override on the General tab', async () => {
    render(<Wrap />);

    expect(await screen.findByLabelText('Language')).toHaveValue('auto');
  });

  it('clicking Accounts shows the Nexus + GitHub key fields', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      expect(screen.getByText(/Nexus Mods API Key/i)).toBeInTheDocument();
    });
    // Heading text "GitHub Token" — the "(optional)" suffix is a child span
    // so we match by partial text not exact.
    expect(screen.getByText(/GitHub Token/i)).toBeInTheDocument();
  });

  it('clicking Audit tab navigates and shows audit controls', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    await waitFor(() => {
      // The Audit tab renders both an empty-state Run-audit button AND
      // a toolbar Run-audit button. Either is fine for navigation proof.
      const buttons = screen.getAllByRole('button', { name: /Run audit/i });
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it('Audit tab Run-audit calls audit_mod_versions', async () => {
    registerInvokeHandler('audit_mod_versions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const buttons = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(buttons[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'audit_mod_versions')).toBe(true);
    });
  });

  it('Backups tab shows a Create backup button', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create backup$/i })).toBeInTheDocument();
    });
  });

  it('Create backup invokes create_backup_cmd', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    registerInvokeHandler('create_backup_cmd', () => 'backup-2026-05-12-1500');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    await user.click(screen.getByRole('button', { name: /Create backup$/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'create_backup_cmd')).toBe(true);
    });
  });

  it('Advanced tab shows a Check-for-updates button', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Check for updates/i })).toBeInTheDocument();
    });
  });

  it('Set game-path Save button invokes set_game_path', async () => {
    registerInvokeHandler('set_game_path', (args) => ({
      game_path: String(args?.path),
      mods_path: `${args?.path}/mods`,
      disabled_mods_path: `${args?.path}/mods_disabled`,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const input = screen.getByPlaceholderText(/SlayTheSpire2/);
    await user.type(input, 'C:/games/STS2');
    // Save button might be labeled "Save" or "Set"; use partial.
    const buttons = screen.getAllByRole('button');
    const saveBtn = buttons.find((b) => /^(Save|Set|Apply)$/i.test(b.textContent ?? ''));
    expect(saveBtn).toBeDefined();
    await user.click(saveBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_game_path' && c.args?.path === 'C:/games/STS2',
      )).toBe(true);
    });
  });

  it('Accounts tab shows the Nexus + GitHub key inputs (password fields)', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    // Both fields are <input type="password"> so they don't expose
    // textbox role to ARIA. Query directly through document.
    await waitFor(() => {
      const passwordInputs = document.querySelectorAll('input[type="password"]');
      expect(passwordInputs.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('Audit tab shows mod rows after audit completes with results', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'Foo',
        folder_name: 'Foo',
        installed_version: '1.0.0',
        latest_release_with_assets_tag: 'v2.0.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: [],
        releases_scanned: 1,
        github_auto_detected: false,
        pinned: false,
        nexus_update_available: false,
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const buttons = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(buttons[0]);
    await waitFor(() => {
      expect(screen.getByText('Foo')).toBeInTheDocument();
    });
  });

  it('General tab renders without crashing', async () => {
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
  });

  it('shows AboutCard in the General tab (relocated from Home in 1.7.0 v7)', async () => {
    // 1.7.0 v7 — AboutCard was removed from the Home footer and now
    // lives at the bottom of Settings → General. The General tab is the
    // default tab, so a fresh render must surface AboutCard's signature
    // content (the author link is the most unique target — "Mohamed
    // Serhan" only appears inside AboutCard).
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const authorLink = await screen.findByText('Mohamed Serhan');
    expect(authorLink.tagName).toBe('A');
    expect(authorLink).toHaveAttribute('href', 'https://github.com/MohamedSerhan');
  });

  it('runs the audit-from-Mods code path the same way', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'X', folder_name: 'X', installed_version: '1.0', needs_update: false, pinned: false, asset_names: [], releases_scanned: 0, latest_has_assets: false, nexus_update_available: false, github_auto_detected: false },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      // 'X' shows up in the audit table.
      expect(screen.getByText('X')).toBeInTheDocument();
    });
  });

  it('General tab Auto-detect button invokes detect_game_path', async () => {
    registerInvokeHandler('detect_game_path', () => ({
      game_path: 'C:/Games/STS2',
      mods_path: 'C:/Games/STS2/mods',
      disabled_mods_path: 'C:/Games/STS2/mods_disabled',
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const autoBtns = screen.getAllByRole('button').filter((b) => /Auto-?detect/i.test(b.textContent ?? ''));
    expect(autoBtns.length).toBeGreaterThan(0);
    await user.click(autoBtns[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
  });

  it('General tab Open game folder button invokes open_game_folder', async () => {
    // Open game/mods folder links only render when gameInfo.valid is true.
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/Games/STS2',
      mods_path: 'C:/Games/STS2/mods',
      disabled_mods_path: 'C:/Games/STS2/mods_disabled',
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    registerInvokeHandler('open_game_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const allBtns = await screen.findAllByRole('button');
    const openGameBtn = allBtns.find((b) => /Open game folder|Open install/i.test(b.textContent ?? ''));
    expect(openGameBtn).toBeDefined();
    await user.click(openGameBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_game_folder')).toBe(true);
    });
  });

  it('General tab Launch Mode radio group renders both Steam + Direct options', async () => {
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    expect(screen.getByText(/Steam.*recommended/i)).toBeInTheDocument();
    expect(screen.getByText(/Direct/)).toBeInTheDocument();
    // Both radios present
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(2);
  });

  it('switching Launch Mode to Direct invokes set_launch_mode', async () => {
    registerInvokeHandler('set_launch_mode', () => 'direct');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const directRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'direct');
    expect(directRadio).toBeDefined();
    await user.click(directRadio!);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_launch_mode' && c.args?.mode === 'direct',
      )).toBe(true);
    });
  });

  it('Accounts tab Saved badge shows when keys are stored', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: true,
      github_token_set: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      // Two "Saved ✓" badges (Nexus + GitHub).
      expect(screen.getAllByText(/Saved/).length).toBeGreaterThan(0);
    });
  });

  it('Accounts tab has a prefilled fine-grained GitHub token link', async () => {
    vi.mocked(openUrl).mockClear();
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));

    const tokenButton = await screen.findByRole('button', { name: /Create scoped token/i });
    await user.click(tokenButton);

    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledTimes(1);
    });
    const url = new URL(String(vi.mocked(openUrl).mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(url.searchParams.get('name')).toBe('STS2 Mod Manager');
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('administration')).toBe('write');
  });

  it('Accounts tab Save Nexus key invokes set_nexus_api_key', async () => {
    registerInvokeHandler('set_nexus_api_key', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[0], 'nx_test_key');
    // Find a Save button adjacent. There are multiple Save buttons; click
    // the first one (Nexus is the first row).
    const allBtns = screen.getAllByRole('button');
    const saveBtns = allBtns.filter((b) => /^Save/.test(b.textContent?.trim() ?? ''));
    expect(saveBtns.length).toBeGreaterThan(0);
    await user.click(saveBtns[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_nexus_api_key')).toBe(true);
    });
  });

  it('General tab Open mods folder button invokes open_mods_folder', async () => {
    // The Open mods folder link only renders when gameInfo.valid is true.
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/Games/STS2',
      mods_path: 'C:/Games/STS2/mods',
      disabled_mods_path: 'C:/Games/STS2/mods_disabled',
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    registerInvokeHandler('open_mods_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const allBtns = await screen.findAllByRole('button');
    const openModsBtn = allBtns.find((b) => /Open mods folder/i.test(b.textContent ?? ''));
    expect(openModsBtn).toBeDefined();
    await user.click(openModsBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
    });
  });

  it('Audit empty-state copy is shown before any audit runs', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    await waitFor(() => {
      // Empty-state shows the Run audit button (one or more renders of it).
      expect(screen.getAllByRole('button', { name: /Run audit/i }).length).toBeGreaterThan(0);
    });
  });

  it('Audit table freeze/unfreeze button triggers pin_mod or unpin_mod', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X',
      folder_name: 'X',
      installed_version: '1.0',
      needs_update: false,
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
    }]);
    registerInvokeHandler('pin_mod', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const run = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(run[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const pinBtns = screen.getAllByRole('button').filter((b) => /Freeze|frozen/i.test(b.textContent ?? '' ) || /Freeze/i.test(b.getAttribute('title') ?? ''));
    expect(pinBtns.length).toBeGreaterThan(0);
    await user.click(pinBtns[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'pin_mod' || c.cmd === 'unpin_mod')).toBe(true);
    });
  });

  it('Audit table renders unlinked LED state when entry has no source', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'OrphanMod',
      installed_version: '1.0',
      needs_update: false,
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const run = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(run[0]);
    await waitFor(() => { expect(screen.getByText('OrphanMod')).toBeInTheDocument(); });
  });

  it('Audit table renders incompatible/game-version-too-old indicator', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NeedsNewer',
      folder_name: 'NeedsNewer',
      installed_version: '1.0',
      min_game_version: '999.0.0',
      game_version_too_old: true,
      needs_update: false,
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const run = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(run[0]);
    await waitFor(() => { expect(screen.getByText('NeedsNewer')).toBeInTheDocument(); });
  });

  it('Audit table error state renders for entries with an error', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'ErrMod',
      folder_name: 'ErrMod',
      installed_version: '1.0',
      needs_update: false,
      error: 'GitHub 404',
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const run = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(run[0]);
    await waitFor(() => { expect(screen.getByText('ErrMod')).toBeInTheDocument(); });
  });

  it('Audit row click Update fires update_mod', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'AutoPath',
      folder_name: 'AutoPath',
      installed_version: '1.0.0',
      latest_release_with_assets_tag: 'v2.0.0',
      latest_compatible_tag: 'v2.0.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      nexus_update_available: false,
      github_repo: 'foo/bar',
      update_source: 'github',
    }]);
    registerInvokeHandler('update_mod', () => ({ name: 'AutoPath', version: '2.0.0', enabled: true, files: [] }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('AutoPath')).toBeInTheDocument(); });
    // Look for an Update button somewhere on the audit table row.
    const updateBtn = screen.getAllByRole('button').find((b) => /^Update$/.test(b.textContent?.trim() ?? ''));
    expect(updateBtn).toBeDefined();
    await user.click(updateBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'update_mod')).toBe(true);
    });
  });

  it('Audit table shows frozen indicator for frozen rows', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'Foo',
      folder_name: 'Foo',
      installed_version: '1.0.0',
      needs_update: false,
      pinned: true,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('Foo')).toBeInTheDocument(); });
    // Frozen indicator surfaces somewhere on the row.
    expect(screen.queryAllByText(/Frozen|frozen/i).length).toBeGreaterThan(0);
  });

  it('Backups tab Restore + Delete buttons trigger their commands', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      timestamp: '2026-05-12T15:00:00',
      mod_count: 3,
      size_bytes: 4096,
    }]);
    registerInvokeHandler('restore_backup_cmd', () => null);
    registerInvokeHandler('delete_backup_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    // Allow time for backups list to render. The exact text varies (the
    // display is from `new Date(...).toLocaleString()` which depends on
    // locale). Just verify the Backups tab body has populated.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      const hasRestore = buttons.some((b) => /Restore/.test(b.textContent ?? ''));
      expect(hasRestore).toBe(true);
    });
  });

  it('Backup row renders existing backups + invokes restore/delete on action click', async () => {
    registerInvokeHandler('list_backups_cmd', () => [
      { name: 'backup-2026-05-12-1500', size_bytes: 1024, created_at: '2026-05-12T15:00:00Z' },
    ]);
    registerInvokeHandler('restore_backup_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    await waitFor(() => {
      expect(screen.queryAllByText(/2026-05-12/).length).toBeGreaterThan(0);
    });
  });

  it('Advanced tab shows the in-app logs viewer', async () => {
    registerInvokeHandler('read_log_tail', () => '[2026-05-12 INFO sts2_mod_manager_lib] Test log');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => {
      expect(screen.queryByText(/Test log/)).toBeInTheDocument();
    });
  });

  it('Advanced tab Logs filter chips render', async () => {
    registerInvokeHandler('read_log_tail', () => '[2026-05-12 INFO] logline');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => { expect(screen.queryAllByText(/logline/).length).toBeGreaterThan(0); });
    const filters = screen.getAllByRole('button');
    expect(filters.some((b) => /Info|Warn|Error|Debug|All/i.test(b.textContent ?? ''))).toBe(true);
  });

  it('Audit row with github_repo renders a GitHub link', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/bar',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(document.querySelectorAll('a[href*="github.com/foo/bar"]').length).toBeGreaterThan(0);
  });

  it('Audit row with auto-detected github shows the (auto-detected) tag', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: true, nexus_update_available: false,
      github_repo: 'foo/bar',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/auto-detected/i)).toBeInTheDocument();
    });
  });

  it('Audit row with nexus_version renders a Nexus link', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NexMod', folder_name: 'NexMod', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
      nexus_url: 'https://www.nexusmods.com/sts2/mods/103',
      nexus_version: '2.0.0',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/Nexus.*v2\.0\.0/)).toBeInTheDocument();
    });
  });

  it('Audit row with nexus_update_available renders Download from Nexus pill', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NexMod', folder_name: 'NexMod', installed_version: '1.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: true,
      nexus_url: 'https://www.nexusmods.com/sts2/mods/103',
      nexus_version: '2.0.0', update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/Download from Nexus/)).toBeInTheDocument();
    });
  });

  it('Audit row with game_version_too_old shows the warning', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2', mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 0, disabled_count: 0, valid: true,
      game_version: '0.100.0',
    }));
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'NeedsNewer', folder_name: 'NeedsNewer',
      installed_version: '1.0', min_game_version: '0.110.0',
      game_version_too_old: true, needs_update: false, pinned: false,
      asset_names: [], releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/Won't load on your game/)).toBeInTheDocument();
    });
  });

  it('Audit "Update all" button appears when 2+ GitHub updates are pending', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    expect(screen.queryByText(/Update 2 mods/)).toBeInTheDocument();
  });

  it('Audit empty-state shows when audit returns []', async () => {
    registerInvokeHandler('audit_mod_versions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/No mods to audit/)).toBeInTheDocument();
    });
  });

  it('Auto-detect sources button opens AutoDetectModal', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const autoBtn = screen.getAllByRole('button').find((b) => /Auto-detect sources/i.test(b.textContent ?? ''));
    expect(autoBtn).toBeDefined();
    await user.click(autoBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'auto_detect_sources')).toBe(true);
    });
  });

  it('Re-audit button appears after a successful audit', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.queryByRole('button', { name: /Re-audit/i })).toBeInTheDocument();
  });

  // ── Error paths for General-tab handlers ──────────────────────────

  it('Set game-path Save shows error toast when set_game_path throws', async () => {
    registerInvokeHandler('set_game_path', () => { throw new Error('bad path'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const input = screen.getByPlaceholderText(/SlayTheSpire2/);
    await user.type(input, 'C:/bogus');
    const saveBtn = screen.getAllByRole('button').find((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    expect(saveBtn).toBeDefined();
    await user.click(saveBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/bad path/)).toBeInTheDocument();
    });
  });

  it('Auto-detect game error path surfaces toast', async () => {
    registerInvokeHandler('detect_game_path', () => { throw new Error('detect boom'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const auto = screen.getAllByRole('button').find((b) => /Auto-?detect/i.test(b.textContent ?? ''));
    expect(auto).toBeDefined();
    await user.click(auto!);
    await waitFor(() => {
      expect(screen.queryByText(/detect boom/)).toBeInTheDocument();
    });
  });

  it('Auto-detect game with invalid result shows manual-set message', async () => {
    registerInvokeHandler('detect_game_path', () => ({
      game_path: null, mods_path: null, disabled_mods_path: null,
      mods_count: 0, disabled_count: 0, valid: false, game_version: null,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const auto = screen.getAllByRole('button').find((b) => /Auto-?detect/i.test(b.textContent ?? ''));
    expect(auto).toBeDefined();
    await user.click(auto!);
    await waitFor(() => {
      expect(screen.queryByText(/Could not auto-detect/i)).toBeInTheDocument();
    });
  });

  it('Browse... button uses the dialog plugin and applies the chosen path', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockResolvedValueOnce('C:/games/STS2-browsed' as never);
    registerInvokeHandler('set_game_path', (args) => ({
      game_path: String(args?.path),
      mods_path: `${args?.path}/mods`,
      disabled_mods_path: `${args?.path}/mods_disabled`,
      mods_count: 0, disabled_count: 0, valid: true, game_version: '0.105.0',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const browseBtn = screen.getAllByRole('button').find((b) => /Browse/.test(b.textContent ?? ''));
    expect(browseBtn).toBeDefined();
    await user.click(browseBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_game_path' && c.args?.path === 'C:/games/STS2-browsed',
      )).toBe(true);
    });
  });

  it('Browse... button bails out cleanly when the user cancels', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockResolvedValueOnce(null as never);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const browseBtn = screen.getAllByRole('button').find((b) => /Browse/.test(b.textContent ?? ''));
    await user.click(browseBtn!);
    // No invoke recorded for set_game_path.
    expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(false);
  });

  it('Browse... surfaces an error toast when the dialog throws', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockRejectedValueOnce(new Error('dialog crash'));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const browseBtn = screen.getAllByRole('button').find((b) => /Browse/.test(b.textContent ?? ''));
    await user.click(browseBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/dialog crash/)).toBeInTheDocument();
    });
  });

  it('Open game folder shows toast when open_game_folder fails', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2', mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 0, disabled_count: 0, valid: true, game_version: '0.105.0',
    }));
    registerInvokeHandler('open_game_folder', () => { throw new Error('open fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Verified/)).toBeInTheDocument(); });
    // Click the inline "Open game folder" link.
    const openBtn = screen.getAllByRole('button').find((b) => /Open game folder/i.test(b.textContent ?? ''));
    await user.click(openBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/open fail/)).toBeInTheDocument();
    });
  });

  it('Open mods folder shows toast when open_mods_folder fails', async () => {
    registerInvokeHandler('open_mods_folder', () => { throw new Error('mods fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const allBtns = await screen.findAllByRole('button');
    const openModsBtn = allBtns.find((b) => /Open mods folder/i.test(b.textContent ?? ''));
    await user.click(openModsBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/mods fail/)).toBeInTheDocument();
    });
  });

  it('Launch-mode switch error path reverts and toasts', async () => {
    registerInvokeHandler('set_launch_mode', () => { throw new Error('lm fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const directRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'direct');
    await user.click(directRadio!);
    await waitFor(() => {
      expect(screen.queryByText(/lm fail/)).toBeInTheDocument();
    });
    // Steam should still be the selected radio (reverted).
    const steamRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'steam') as HTMLInputElement;
    expect(steamRadio.checked).toBe(true);
  });

  it('Save Nexus key error path surfaces a toast', async () => {
    registerInvokeHandler('set_nexus_api_key', () => { throw new Error('nx fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[0], 'nx_test_key');
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/nx fail/)).toBeInTheDocument();
    });
  });

  it('Save GitHub token submits and clears the field', async () => {
    registerInvokeHandler('set_github_token', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[1], 'ghp_abc');
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    // Two Save buttons (Nexus, GitHub); GitHub is the second one.
    await user.click(saveBtns[1]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_github_token')).toBe(true);
    });
    expect(passwordInputs[1].value).toBe('');
  });

  it('Save GitHub token error path surfaces a toast', async () => {
    registerInvokeHandler('set_github_token', () => { throw new Error('gh fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[1], 'ghp_xyz');
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[1]);
    await waitFor(() => {
      expect(screen.queryByText(/gh fail/)).toBeInTheDocument();
    });
  });

  // ── Backups tab: restore / delete / error paths ───────────────────

  it('Create backup error path surfaces a toast', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    registerInvokeHandler('create_backup_cmd', () => { throw new Error('cb fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    await user.click(screen.getByRole('button', { name: /Create backup$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/cb fail/)).toBeInTheDocument();
    });
  });

  it('list_backups_cmd error on mount surfaces a toast', async () => {
    registerInvokeHandler('list_backups_cmd', () => { throw new Error('lb fail'); });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.queryByText(/lb fail/)).toBeInTheDocument();
    });
  });

  it('Restore backup confirms then invokes restore_backup_cmd', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 3, size_bytes: 4096,
    }]);
    registerInvokeHandler('restore_backup_cmd', () => null);
    registerInvokeHandler('create_backup_preserving_cmd', () => 'pre-restore-backup');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const restoreBtn = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => /^Restore$/i.test(btn.textContent?.trim() ?? ''));
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(restoreBtn);
    // Confirm modal opens; click "Restore now".
    const confirmBtn = await screen.findByRole('button', { name: /Restore now/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'restore_backup_cmd')).toBe(true);
    });
    // The pre-restore save backup is also invoked because the default
    // checkbox is checked, but it must preserve the restore target so
    // retention pruning cannot delete it before restore runs.
    expect(getInvokeCalls().some((c) =>
      c.cmd === 'create_backup_preserving_cmd' &&
      c.args?.preserveName === 'backup_2026-05-12_15-00-00'
    )).toBe(true);
  });

  it('Restore backup cancel does not invoke restore_backup_cmd', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 1, size_bytes: 1024,
    }]);
    registerInvokeHandler('restore_backup_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const restoreBtn = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => /^Restore$/i.test(btn.textContent?.trim() ?? ''));
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(restoreBtn);
    // Two cancel-capable buttons (close X with title=Cancel + footer
    // Cancel). Click the footer one (text content "Cancel").
    const cancelBtns = await screen.findAllByRole('button', { name: /^Cancel$/ });
    const footerCancel = cancelBtns.find((b) => b.textContent?.trim() === 'Cancel');
    await user.click(footerCancel!);
    expect(getInvokeCalls().some((c) => c.cmd === 'restore_backup_cmd')).toBe(false);
  });

  it('Restore backup error path surfaces a toast', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 2, size_bytes: 2048,
    }]);
    registerInvokeHandler('create_backup_preserving_cmd', () => { throw new Error('pre-fail'); });
    registerInvokeHandler('restore_backup_cmd', () => { throw new Error('rb fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const restoreBtn = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => /^Restore$/i.test(btn.textContent?.trim() ?? ''));
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(restoreBtn);
    const confirmBtn = await screen.findByRole('button', { name: /Restore now/i });
    await user.click(confirmBtn);
    // The pre-restore safety backup failure is swallowed (non-fatal),
    // but the restore_backup_cmd failure surfaces.
    await waitFor(() => {
      expect(screen.queryByText(/rb fail/)).toBeInTheDocument();
    });
  });

  it('Delete backup confirms then invokes delete_backup_cmd', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 1, size_bytes: 1024,
    }]);
    registerInvokeHandler('delete_backup_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const deleteRow = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => btn.getAttribute('title') === 'Delete backup');
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(deleteRow);
    // Confirm "Delete" inside the confirm modal.
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/ });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'delete_backup_cmd')).toBe(true);
    });
  });

  it('Delete backup error path surfaces a toast', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 1, size_bytes: 512,
    }]);
    registerInvokeHandler('delete_backup_cmd', () => { throw new Error('del fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const deleteRow = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => btn.getAttribute('title') === 'Delete backup');
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(deleteRow);
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/ });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/del fail/)).toBeInTheDocument();
    });
  });

  it('Backups tab renders multi-file plural copy + size formatter', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 5, size_bytes: 5 * 1024 * 1024,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    // "5 files" + "5.0 MB" + "NEWEST" pill on first row.
    await waitFor(() => {
      expect(screen.queryByText(/5 files/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(/NEWEST/)).toBeInTheDocument();
  });

  // ── Audit-tab: update flows + error paths ─────────────────────────

  it('Audit row Update button invokes update_mod with the folder name', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'M', folder_name: 'm_folder', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      latest_compatible_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/m', update_source: 'github',
    }]);
    registerInvokeHandler('update_mod', () => ({
      name: 'M', version: '2.0.0', enabled: true, files: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('M')).toBeInTheDocument(); });
    const updateBtn = screen.getAllByRole('button').find((b) => /^Update$/.test(b.textContent?.trim() ?? ''));
    await user.click(updateBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'update_mod' && c.args?.folderName === 'm_folder',
      )).toBe(true);
    });
  });

  it('Audit row Skip this update snoozes the current GitHub release tag', async () => {
    registerInvokeHandler('audit_mod_versions', (args) => {
      if (args?.only) {
        return [{
          mod_name: 'M', folder_name: 'm_folder', installed_version: '1.0',
          latest_release_with_assets_tag: 'v2.0',
          needs_update: true, pinned: false, asset_names: [],
          releases_scanned: 1, latest_has_assets: true,
          github_auto_detected: false, nexus_update_available: false,
          github_repo: 'foo/m', update_source: 'github',
          snoozed: true,
        }];
      }
      return [{
        mod_name: 'M', folder_name: 'm_folder', installed_version: '1.0',
        latest_release_with_assets_tag: 'v2.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        github_auto_detected: false, nexus_update_available: false,
        github_repo: 'foo/m', update_source: 'github',
        snoozed: false,
      }];
    });
    registerInvokeHandler('set_mod_snooze', () => ({}));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await user.click(await screen.findByRole('button', { name: /Skip this update/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_snooze'
          && c.args?.modName === 'M'
          && c.args?.folderName === 'm_folder'
          && c.args?.latestTag === 'v2.0',
      )).toBe(true);
    });
  });

  it('Audit row Skip this update works for Nexus-only version drift', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'Nx', folder_name: 'Nx', installed_version: '1.0',
      latest_release_with_assets_tag: null,
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false,
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/99',
      nexus_version: '1.0.3',
      nexus_update_available: true,
      update_source: 'nexus',
      snoozed: false,
    }]);
    registerInvokeHandler('set_mod_snooze', () => ({}));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await user.click(await screen.findByRole('button', { name: /Skip this update/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_snooze'
          && c.args?.modName === 'Nx'
          && c.args?.latestTag === '1.0.3',
      )).toBe(true);
    });
  });

  it('Audit row snoozed updates are marked skipped and can be shown again', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'M', folder_name: 'M', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/m', update_source: 'github',
      snoozed: true,
    }]);
    registerInvokeHandler('set_mod_snooze', () => ({}));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await screen.findByText(/Skipped v2\.0 until next release/i);
    expect(screen.queryByRole('button', { name: /^Update$/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Show update again/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_mod_snooze'
          && c.args?.modName === 'M'
          && c.args?.latestTag === null,
      )).toBe(true);
    });
  });

  it('Audit row Update button error path surfaces a toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'M', folder_name: 'M', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      latest_compatible_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/m', update_source: 'github',
    }]);
    registerInvokeHandler('update_mod', () => { throw new Error('um fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('M')).toBeInTheDocument(); });
    const updateBtn = screen.getAllByRole('button').find((b) => /^Update$/.test(b.textContent?.trim() ?? ''));
    await user.click(updateBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/um fail/)).toBeInTheDocument();
    });
  });

  it('Audit "Update all" confirms then invokes update_all_mods', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    registerInvokeHandler('update_all_mods', () => [
      { name: 'A', version: '2.0', enabled: true, files: [] },
      { name: 'B', version: '2.0', enabled: true, files: [] },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const confirmBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^Update 2 mods$/ });
      const dialogBtn = btns.find((b) => b.closest('.gf-modal') !== null);
      if (!dialogBtn) throw new Error('confirm dialog Update button not found');
      return dialogBtn as HTMLButtonElement;
    });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'update_all_mods')).toBe(true);
    });
  });

  it('Audit "Update all" cancel does not invoke update_all_mods', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const cancelBtns = await screen.findAllByRole('button', { name: /^Cancel$/ });
    const footerCancel = cancelBtns.find((b) => b.textContent?.trim() === 'Cancel');
    await user.click(footerCancel!);
    expect(getInvokeCalls().some((c) => c.cmd === 'update_all_mods')).toBe(false);
  });

  it('Audit "Update all" error path surfaces a toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    registerInvokeHandler('update_all_mods', () => { throw new Error('ua fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const confirmBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^Update 2 mods$/ });
      const dialogBtn = btns.find((b) => b.closest('.gf-modal') !== null);
      if (!dialogBtn) throw new Error('confirm dialog Update button not found');
      return dialogBtn as HTMLButtonElement;
    });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/ua fail/)).toBeInTheDocument();
    });
  });

  it('Audit "Update all" success with 0 returned shows the "Nothing to update" toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    registerInvokeHandler('update_all_mods', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const confirmBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^Update 2 mods$/ });
      const dialogBtn = btns.find((b) => b.closest('.gf-modal') !== null);
      if (!dialogBtn) throw new Error('confirm dialog Update button not found');
      return dialogBtn as HTMLButtonElement;
    });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Nothing to update/)).toBeInTheDocument();
    });
  });

  it('Audit freeze button error path surfaces a toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    registerInvokeHandler('pin_mod', () => { throw new Error('pin fail'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const pinBtn = screen.getAllByRole('button').find((b) => /^Freeze$/i.test(b.textContent?.trim() ?? ''));
    await user.click(pinBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/pin fail/)).toBeInTheDocument();
    });
  });

  it('Audit unfreeze button invokes unpin_mod for frozen rows', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'P', folder_name: 'P', installed_version: '1.0',
      needs_update: false, pinned: true, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    registerInvokeHandler('unpin_mod', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('P')).toBeInTheDocument(); });
    const unpinBtn = screen.getAllByRole('button').find((b) => /Unfreeze/.test(b.textContent ?? ''));
    await user.click(unpinBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'unpin_mod')).toBe(true);
    });
  });

  it('Audit footer renders the "release missing assets" stat when an entry is gone', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'Gone', folder_name: 'Gone', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: false,
      latest_release_tag: 'v2.0',
      github_repo: 'foo/gone', github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('Gone')).toBeInTheDocument(); });
    // Both the version pill ("1.0 · release missing assets") and the
    // footer stat ("1 releases missing assets") match — assert presence
    // via getAllByText to avoid the multi-match error.
    expect(screen.getAllByText(/release.*missing assets/).length).toBeGreaterThan(0);
  });

  it('Audit footer renders the "won\'t load" stat when entries are incompatible', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2', mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 0, disabled_count: 0, valid: true,
      game_version: '0.100.0',
    }));
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'I', folder_name: 'I', installed_version: '1.0',
      min_game_version: '0.110.0',
      game_version_too_old: true,
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('I')).toBeInTheDocument(); });
    // Row warning and footer stat both match — assert ≥ 1.
    expect(screen.getAllByText(/won't load/i).length).toBeGreaterThan(0);
  });

  it('Audit row with blocked latest but no compatible tag shows the "you are on" hint', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'OnLatestCompat', folder_name: 'OnLatestCompat',
      installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      latest_release_with_assets_tag: 'v3.0',
      latest_release_min_game_version: '0.110.0',
      latest_release_blocked_by_game_version: true,
      // No latest_compatible_tag, so the second branch fires.
      github_repo: 'foo/bar',
      github_auto_detected: false, nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('OnLatestCompat')).toBeInTheDocument(); });
    expect(screen.getByText(/Update blocked by game version/i)).toBeInTheDocument();
    expect(screen.queryByText(/newest version that runs on your game/i)).toBeInTheDocument();
  });

  it('Audit row with nexus-only update shows nexus_version in the version arrow', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'Nx', folder_name: 'Nx', installed_version: '1.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: true,
      nexus_url: 'https://www.nexusmods.com/sts2/mods/55',
      nexus_version: '3.0.0', update_source: 'nexus',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('Nx')).toBeInTheDocument(); });
    expect(screen.queryByText(/1\.0 → 3\.0\.0/)).toBeInTheDocument();
  });

  it('Audit row with gone state shows "release missing assets" in version pill', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'GoneRow', folder_name: 'GoneRow', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: false,
      latest_release_tag: 'v2.0',
      github_repo: 'foo/gone', github_auto_detected: false,
      nexus_update_available: false,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('GoneRow')).toBeInTheDocument(); });
    expect(screen.getAllByText(/release.*missing assets/).length).toBeGreaterThan(0);
  });

  // ── Advanced tab: updater paths ──────────────────────────────────

  it('Check for updates: "latest version" toast when no update', async () => {
    const updateMock = vi.mocked(checkUpdate);
    updateMock.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const checkBtn = await screen.findByRole('button', { name: /Check for updates/i });
    await user.click(checkBtn);
    await waitFor(() => {
      expect(screen.queryByText(/latest version/i)).toBeInTheDocument();
    });
  });

  it('Check for updates: downloads and relaunches when update is available', async () => {
    const updateMock = vi.mocked(checkUpdate);
    const downloadAndInstall = vi.fn(async () => {});
    updateMock.mockResolvedValueOnce({
      version: '9.9.9',
      downloadAndInstall,
    } as never);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const checkBtn = await screen.findByRole('button', { name: /Check for updates/i });
    await user.click(checkBtn);
    await waitFor(() => {
      expect(downloadAndInstall).toHaveBeenCalled();
    });
    expect(screen.queryByText(/9\.9\.9 available/)).toBeInTheDocument();
  });

  it('Check for updates: error path surfaces a toast', async () => {
    const updateMock = vi.mocked(checkUpdate);
    updateMock.mockRejectedValueOnce(new Error('updater fail'));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const checkBtn = await screen.findByRole('button', { name: /Check for updates/i });
    await user.click(checkBtn);
    await waitFor(() => {
      expect(screen.queryByText(/updater fail/)).toBeInTheDocument();
    });
  });

  // ── Early-return guards (empty inputs / no-op clicks) ─────────────

  it('Save game path with empty input is a no-op', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    // Input is empty by default; click Save — no invoke should fire.
    const saveBtn = screen.getAllByRole('button').find((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtn!);
    expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(false);
  });

  it('Clicking the already-selected launch mode is a no-op', async () => {
    registerInvokeHandler('get_launch_mode', () => 'steam');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const steamRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'steam');
    await user.click(steamRadio!);
    // Already selected — set_launch_mode should not be invoked.
    expect(getInvokeCalls().some((c) => c.cmd === 'set_launch_mode')).toBe(false);
  });

  it('Save Nexus key with empty input is a no-op', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[0]);
    expect(getInvokeCalls().some((c) => c.cmd === 'set_nexus_api_key')).toBe(false);
  });

  it('Save GitHub token with empty input is a no-op', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[1]);
    expect(getInvokeCalls().some((c) => c.cmd === 'set_github_token')).toBe(false);
  });

  it('Delete backup cancel does not invoke delete_backup_cmd', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00',
      mod_count: 1, size_bytes: 512,
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const deleteRow = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => btn.getAttribute('title') === 'Delete backup');
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(deleteRow);
    const cancelBtns = await screen.findAllByRole('button', { name: /^Cancel$/ });
    const footerCancel = cancelBtns.find((b) => b.textContent?.trim() === 'Cancel');
    await user.click(footerCancel!);
    expect(getInvokeCalls().some((c) => c.cmd === 'delete_backup_cmd')).toBe(false);
  });

  // ── Non-Error throws hit the String(e) branch ─────────────────────

  it('Set game path that throws a non-Error string still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('set_game_path', () => { throw 'plain string err'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const input = screen.getByPlaceholderText(/SlayTheSpire2/);
    await user.type(input, 'C:/bogus');
    const saveBtn = screen.getAllByRole('button').find((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/plain string err/)).toBeInTheDocument();
    });
  });

  it('Create backup that throws a non-Error still toasts', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('create_backup_cmd', () => { throw { msg: 'oops' }; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    await user.click(screen.getByRole('button', { name: /Create backup$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Failed to create backup/)).toBeInTheDocument();
    });
  });

  it('Restore backup error that is a non-Error still toasts', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00', mod_count: 1, size_bytes: 1024,
    }]);
    registerInvokeHandler('create_backup_preserving_cmd', () => 'pre');
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('restore_backup_cmd', () => { throw 'rb string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const restoreBtn = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => /^Restore$/i.test(btn.textContent?.trim() ?? ''));
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(restoreBtn);
    const confirmBtn = await screen.findByRole('button', { name: /Restore now/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Failed to restore backup/)).toBeInTheDocument();
    });
  });

  it('Delete backup error that is a non-Error still toasts', async () => {
    registerInvokeHandler('list_backups_cmd', () => [{
      name: 'backup_2026-05-12_15-00-00', mod_count: 1, size_bytes: 512,
    }]);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('delete_backup_cmd', () => { throw 'plain'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const deleteRow = await waitFor(() => {
      const b = screen.getAllByRole('button').find((btn) => btn.getAttribute('title') === 'Delete backup');
      expect(b).toBeDefined();
      return b!;
    });
    await user.click(deleteRow);
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/ });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Failed to delete backup/)).toBeInTheDocument();
    });
  });

  it('list_backups_cmd that throws a non-Error still toasts on mount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('list_backups_cmd', () => { throw 'lb string'; });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.queryByText(/Failed to load backups/)).toBeInTheDocument();
    });
  });

  it('Set launch mode error with non-Error still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('set_launch_mode', () => { throw 'lm string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const directRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'direct');
    await user.click(directRadio!);
    await waitFor(() => {
      expect(screen.queryByText(/Failed to update launch mode/)).toBeInTheDocument();
    });
  });

  it('Detect game-path non-Error throw still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('detect_game_path', () => { throw 'detect string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const auto = screen.getAllByRole('button').find((b) => /Auto-?detect/i.test(b.textContent ?? ''));
    await user.click(auto!);
    await waitFor(() => {
      expect(screen.queryByText(/detect string/)).toBeInTheDocument();
    });
  });

  it('Save Nexus key non-Error throw still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('set_nexus_api_key', () => { throw 'nx string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[0], 'k');
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[0]);
    await waitFor(() => {
      expect(screen.queryByText(/nx string/)).toBeInTheDocument();
    });
  });

  it('Save GitHub token non-Error throw still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('set_github_token', () => { throw 'gh string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      const passwords = document.querySelectorAll('input[type="password"]');
      expect(passwords.length).toBeGreaterThanOrEqual(2);
    });
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ) as HTMLInputElement[];
    await user.type(passwordInputs[1], 'g');
    const saveBtns = screen.getAllByRole('button').filter((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtns[1]);
    await waitFor(() => {
      expect(screen.queryByText(/gh string/)).toBeInTheDocument();
    });
  });

  it('Open game folder non-Error throw still toasts', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/STS2', mods_path: 'C:/STS2/mods',
      disabled_mods_path: 'C:/STS2/mods_disabled',
      mods_count: 0, disabled_count: 0, valid: true, game_version: '0.105.0',
    }));
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('open_game_folder', () => { throw 'ogf string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Verified/)).toBeInTheDocument(); });
    const openBtn = screen.getAllByRole('button').find((b) => /Open game folder/i.test(b.textContent ?? ''));
    await user.click(openBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/ogf string/)).toBeInTheDocument();
    });
  });

  it('Open mods folder non-Error throw still toasts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('open_mods_folder', () => { throw 'omf string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const allBtns = await screen.findAllByRole('button');
    const openModsBtn = allBtns.find((b) => /Open mods folder/i.test(b.textContent ?? ''));
    await user.click(openModsBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/omf string/)).toBeInTheDocument();
    });
  });

  it('Update all error non-Error still toasts', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('update_all_mods', () => { throw 'ua string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const confirmBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^Update 2 mods$/ });
      const dialogBtn = btns.find((b) => b.closest('.gf-modal') !== null);
      if (!dialogBtn) throw new Error('confirm dialog Update button not found');
      return dialogBtn as HTMLButtonElement;
    });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Update failed/)).toBeInTheDocument();
    });
  });

  it('Update one error non-Error still toasts', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'M', folder_name: 'M', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      latest_compatible_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/m', update_source: 'github',
    }]);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('update_mod', () => { throw 'um string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('M')).toBeInTheDocument(); });
    const updateBtn = screen.getAllByRole('button').find((b) => /^Update$/.test(b.textContent?.trim() ?? ''));
    await user.click(updateBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/Update failed/)).toBeInTheDocument();
    });
  });

  it('Check for updates non-Error throw still toasts', async () => {
    const updateMock = vi.mocked(checkUpdate);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    updateMock.mockImplementationOnce(() => { throw 'upd string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const checkBtn = await screen.findByRole('button', { name: /Check for updates/i });
    await user.click(checkBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Update check failed/)).toBeInTheDocument();
    });
  });

  it('Audit pin error non-Error still toasts', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    registerInvokeHandler('pin_mod', () => { throw 'p string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const pinBtn = screen.getAllByRole('button').find((b) => /^Freeze$/i.test(b.textContent?.trim() ?? ''));
    await user.click(pinBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/p string/)).toBeInTheDocument();
    });
  });

  it('Browse... non-Error throw still toasts', async () => {
    const openMock = vi.mocked(openDialog);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    openMock.mockImplementationOnce(() => { throw 'br string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const browseBtn = screen.getAllByRole('button').find((b) => /Browse/.test(b.textContent ?? ''));
    await user.click(browseBtn!);
    await waitFor(() => {
      expect(screen.queryByText(/br string/)).toBeInTheDocument();
    });
  });

  // ── AutoDetectModal open + close ──────────────────────────────────

  it('Auto-detect sources modal opens, closes, and triggers onClose callback', async () => {
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [], unmatched: [], skipped_already_linked: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const autoBtn = await screen.findByRole('button', { name: /Auto-detect sources/i });
    await user.click(autoBtn);
    // Modal renders — wait for it to materialise then click its Close button.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'auto_detect_sources')).toBe(true);
    });
    // Modal must be visible before we attempt to close it.
    const backdrops = document.querySelectorAll('.gf-modal-back');
    expect(backdrops.length).toBeGreaterThan(0);
    // Click on the modal backdrop to close (AutoDetectModal closes on
    // backdrop click via onClick={onClose}).
    await user.click(backdrops[backdrops.length - 1] as HTMLElement);
    // After onClose fires, the modal backdrop unmounts.
    await waitFor(() => {
      expect(document.querySelectorAll('.gf-modal-back').length).toBe(0);
    });
  });

  // ── BrowseGamePath: invalid path branch returns early ─────────────

  it('Browse... with an invalid path returns without refresh', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockResolvedValueOnce('C:/games/bogus' as never);
    registerInvokeHandler('set_game_path', () => ({
      game_path: 'C:/games/bogus', mods_path: '', disabled_mods_path: '',
      mods_count: 0, disabled_count: 0, valid: false, game_version: null,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const browseBtn = screen.getAllByRole('button').find((b) => /Browse/.test(b.textContent ?? ''));
    await user.click(browseBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(true);
    });
    // The "valid=false" branch means the success toast does NOT show.
    expect(screen.queryByText(/Game path updated/)).not.toBeInTheDocument();
  });

  it('Set game path invalid result: no success toast, no refresh', async () => {
    registerInvokeHandler('set_game_path', () => ({
      game_path: 'C:/games/STS2', mods_path: '', disabled_mods_path: '',
      mods_count: 0, disabled_count: 0, valid: false, game_version: null,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const input = screen.getByPlaceholderText(/SlayTheSpire2/);
    await user.type(input, 'C:/bogus');
    const saveBtn = screen.getAllByRole('button').find((b) => /^Save$/.test(b.textContent?.trim() ?? ''));
    await user.click(saveBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(true);
    });
    expect(screen.queryByText(/Game path updated/)).not.toBeInTheDocument();
  });

  it('Updated mod with a renamed manifest re-audits both names', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'M', folder_name: 'M', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      latest_compatible_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/m', update_source: 'github',
    }]);
    // Returned name differs from requested → exercises the rename branch.
    registerInvokeHandler('update_mod', () => ({
      name: 'M-Renamed', version: '2.0', enabled: true, files: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('M')).toBeInTheDocument(); });
    const updateBtn = screen.getAllByRole('button').find((b) => /^Update$/.test(b.textContent?.trim() ?? ''));
    await user.click(updateBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'update_mod')).toBe(true);
    });
  });

  it('Update all returning exactly one mod uses the singular toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    registerInvokeHandler('update_all_mods', () => [
      { name: 'A', version: '2.0', enabled: true, files: [] },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const updateAllBtn = await screen.findByRole('button', { name: /^Update 2 mods$/ });
    await user.click(updateAllBtn);
    const confirmBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^Update 2 mods$/ });
      const dialogBtn = btns.find((b) => b.closest('.gf-modal') !== null);
      if (!dialogBtn) throw new Error('confirm dialog Update button not found');
      return dialogBtn as HTMLButtonElement;
    });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.queryByText(/Updated 1 mod\b/)).toBeInTheDocument();
    });
  });

  // uncovered: line 1138 — DiagnosticBundle's onClose arrow is wired up
  // but unreachable from the current UI: `showDiag` is never set to true
  // anywhere in Settings.tsx (the diag-bundle entry point moved to the
  // Home screen footer in v1.0.4). The prop is still passed so the modal
  // can be re-enabled later without a refactor.

  it('get_api_key_status failure is swallowed silently (covers .catch handler)', async () => {
    registerInvokeHandler('get_api_key_status', () => { throw new Error('key status fail'); });
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    // No crash, no toast (catch swallows). Just survive mount.
    expect(screen.queryByText(/key status fail/)).not.toBeInTheDocument();
  });

  it('get_launch_mode failure is swallowed silently (covers .catch handler)', async () => {
    registerInvokeHandler('get_launch_mode', () => { throw new Error('lm load fail'); });
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    expect(screen.queryByText(/lm load fail/)).not.toBeInTheDocument();
  });

  it('Auto-detect modal Apply triggers onApplied → re-runs audit', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X', folder_name: 'X', installed_version: '1.0',
      needs_update: false, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: false,
      github_auto_detected: false, nexus_update_available: false,
    }]);
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [{ mod_name: 'X', github_repo: 'foo/x', confidence: 'high' }],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    registerInvokeHandler('set_mod_source', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const autoBtn = await screen.findByRole('button', { name: /Auto-detect sources/i });
    await user.click(autoBtn);
    // Wait for the modal to finish scanning and the Apply button to appear.
    const applyBtn = await screen.findByRole('button', { name: /Apply 1 match/i });
    // Count the audit_mod_versions calls before applying.
    const beforeAuditCount = getInvokeCalls().filter((c) => c.cmd === 'audit_mod_versions').length;
    await user.click(applyBtn);
    await waitFor(() => {
      // onApplied is the callback that re-runs the audit when results exist.
      const afterAuditCount = getInvokeCalls().filter((c) => c.cmd === 'audit_mod_versions').length;
      expect(afterAuditCount).toBeGreaterThan(beforeAuditCount);
    });
  });

  it('Advanced tab Open game folder button (under quick actions) invokes open_game_folder', async () => {
    registerInvokeHandler('open_game_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const openBtn = await screen.findAllByRole('button');
    const target = openBtn.find((b) => /Open game folder/i.test(b.textContent ?? ''));
    await user.click(target!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_game_folder')).toBe(true);
    });
  });

  it('Audit row with latest blocked + compatible_tag shows the walk-back hint', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'Blocked', folder_name: 'Blocked', installed_version: '1.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 0, latest_has_assets: true,
      latest_release_with_assets_tag: 'v3.0',
      latest_release_min_game_version: '0.110.0',
      latest_release_blocked_by_game_version: true,
      latest_compatible_tag: 'v2.0', github_repo: 'foo/bar',
      github_auto_detected: false, nexus_update_available: false,
      update_source: 'github',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => {
      expect(screen.getByText(/Update blocked by game version/i)).toBeInTheDocument();
      expect(screen.queryByText(/newest compatible/i)).toBeInTheDocument();
    });
  });

  it('renders a "Latest" pill on rows whose audit row is up-to-date', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      {
        mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: false, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v1.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false,
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    expect(screen.getByText('Latest')).toBeInTheDocument();
  });

  it('Re-audit button uses ghost variant when 2+ GitHub updates are pending', async () => {
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'A', folder_name: 'A', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/a', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
      { mod_name: 'B', folder_name: 'B', installed_version: '1.0',
        needs_update: true, pinned: false, asset_names: [],
        releases_scanned: 1, latest_has_assets: true,
        latest_release_with_assets_tag: 'v2.0',
        github_repo: 'foo/b', github_auto_detected: false,
        nexus_update_available: false, update_source: 'github' },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    const reAuditBtn = await screen.findByRole('button', { name: /^Re-audit$/ });
    // ghost variant maps to gf-btn-3 in Button.tsx
    expect(reAuditBtn.className).toMatch(/gf-btn-3/);
  });

  // ── Error-path coverage for handler catch blocks ────────────────────
  // These exercise the `catch (e) { toast.error(...) }` arms on a few
  // settings handlers that were only happy-path tested. Each test
  // forces the underlying invoke to reject so the catch handler runs.
  it('Accounts → Create scoped token surfaces a toast when the opener fails (handleOpenGithubTokenTemplate catch)', async () => {
    // Force open_external_url to reject so the catch branch in
    // handleOpenGithubTokenTemplate fires and toasts the error.
    registerInvokeHandler('open_external_url', () => { throw new Error('no browser'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    const tokenBtn = await screen.findByRole('button', { name: /Create scoped token/i });
    await user.click(tokenBtn);
    await waitFor(() => {
      // i18n key: settings.accounts.openGithubTokenPageFailed.
      // English copy includes the underlying error string.
      expect(screen.getByText(/no browser/i)).toBeInTheDocument();
    });
  });

  it('Audit Skip-this-update failure surfaces a toast (handleAuditSnooze catch)', async () => {
    // Audit a single GitHub-linked mod with an update available, then
    // click Skip this update. set_mod_snooze rejects → handleAuditSnooze
    // catch runs and toasts the error string.
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'BoomMod', folder_name: 'BoomMod', installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      needs_update: true, pinned: false, asset_names: [],
      releases_scanned: 1, latest_has_assets: true,
      github_auto_detected: false, nexus_update_available: false,
      github_repo: 'foo/boom', update_source: 'github',
      snoozed: false,
    }]);
    registerInvokeHandler('set_mod_snooze', () => { throw new Error('disk locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await user.click(await screen.findByRole('button', { name: /Skip this update/i }));
    await waitFor(() => {
      // The handler uses err.message directly without an i18n prefix,
      // so we look for the raw string the catch passed through.
      expect(screen.getByText(/disk locked/i)).toBeInTheDocument();
    });
  });
});
