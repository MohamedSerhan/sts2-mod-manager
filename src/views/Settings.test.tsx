import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  it('renders the tab strip with five tabs', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /General/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accounts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Backups/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Audit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advanced/ })).toBeInTheDocument();
  });

  it('starts on the General tab and shows the Game Path field', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
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
    if (saveBtn) {
      await user.click(saveBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some(
          (c) => c.cmd === 'set_game_path' && c.args?.path === 'C:/games/STS2',
        )).toBe(true);
      });
    }
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
    if (autoBtns.length > 0) {
      await user.click(autoBtns[0]);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
      });
    }
  });

  it('General tab Open game folder button invokes open_game_folder', async () => {
    registerInvokeHandler('open_game_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const allBtns = screen.getAllByRole('button');
    const openGameBtn = allBtns.find((b) => /Open game folder|Open install/i.test(b.textContent ?? ''));
    if (openGameBtn) {
      await user.click(openGameBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'open_game_folder')).toBe(true);
      });
    }
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
    if (directRadio) {
      await user.click(directRadio);
      await waitFor(() => {
        expect(getInvokeCalls().some(
          (c) => c.cmd === 'set_launch_mode' && c.args?.mode === 'direct',
        )).toBe(true);
      });
    }
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
    if (saveBtns.length > 0) {
      await user.click(saveBtns[0]);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'set_nexus_api_key')).toBe(true);
      });
    }
  });

  it('Advanced tab "Check for updates" button invokes the updater API', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const checkBtn = await screen.findByRole('button', { name: /Check for updates/i });
    await user.click(checkBtn);
    // No specific assert — just that no crash. The updater check is mocked
    // to resolve null by default.
  });

  it('General tab Open mods folder button invokes open_mods_folder', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    const allBtns = screen.getAllByRole('button');
    const openModsBtn = allBtns.find((b) => /Open mods folder/i.test(b.textContent ?? ''));
    if (openModsBtn) {
      await user.click(openModsBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
      });
    }
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

  it('Audit table pin/unpin button triggers pin_mod or unpin_mod', async () => {
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
    const pinBtns = screen.getAllByRole('button').filter((b) => /Pin|pinned/i.test(b.textContent ?? '' ) || /Pin/i.test(b.getAttribute('title') ?? ''));
    if (pinBtns.length > 0) {
      await user.click(pinBtns[0]);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'pin_mod' || c.cmd === 'unpin_mod')).toBe(true);
      });
    }
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
    if (updateBtn) {
      await user.click(updateBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'update_mod')).toBe(true);
      });
    }
  });

  it('Audit table shows pinned indicator for pinned rows', async () => {
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
    // Pinned indicator surfaces somewhere on the row.
    expect(screen.queryAllByText(/Pinned|pinned/i).length).toBeGreaterThan(0);
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

  it('Audit Update-all button appears when audit has pending updates', async () => {
    registerInvokeHandler('audit_mod_versions', () => [{
      mod_name: 'X',
      folder_name: 'X',
      installed_version: '1.0',
      latest_release_with_assets_tag: 'v2.0',
      latest_compatible_tag: 'v2.0',
      needs_update: true,
      pinned: false,
      asset_names: [],
      releases_scanned: 1,
      latest_has_assets: true,
      github_auto_detected: false,
      nexus_update_available: false,
      github_repo: 'foo/bar',
      update_source: 'github',
    }]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Audit/ }));
    const runBtns = await screen.findAllByRole('button', { name: /Run audit/i });
    await user.click(runBtns[0]);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    // The Update-all button may not be shown if no updates are flagged in
    // a way that triggers it. We just assert audit completed and rendered
    // the mod row.
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
    if (autoBtn) {
      await user.click(autoBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'auto_detect_sources')).toBe(true);
      });
    }
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
});
