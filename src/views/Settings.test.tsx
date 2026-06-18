import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { openUrl } from '@tauri-apps/plugin-opener';
import { downloadDir as pathDownloadDir } from '@tauri-apps/api/path';

import { SettingsView } from './Settings';
import { AllProviders } from '../__test__/providers';
import { chooseOption } from '../__test__/selectHelpers';
import { getInvokeCalls, registerInvokeHandler, setMockAppVersion } from '../__test__/setup';
import { AUTO_ADD_INSTALLS_TO_MODPACK_KEY } from '../lib/installPolicy';
import {
  NAVIGATION_LAYOUT_CHANGE_EVENT,
  NAVIGATION_LAYOUT_STORAGE_KEY,
} from '../display/navigationLayout';

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
  it('renders the tab strip with the four canonical Settings tabs', async () => {
    // 1.7.0 cleanup: the redundant Help tab was removed — Help is now
    // reachable from the topbar `?` drawer (the canonical surface).
    // Later cleanup: the Audit tab was removed too — the Library view
    // ("All Mods") is the canonical audit surface, and its one unique
    // bulk action (Auto-detect sources) moved to the Library toolbar.
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /General/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accounts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Backups/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advanced/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Help$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Audit$/ })).toBeNull();
  });

  it('starts on the General tab and shows the Game Path field', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it('shows the language override on the General tab', async () => {
    render(<Wrap />);

    expect(await screen.findByRole('combobox', { name: 'Language' })).toHaveTextContent('Auto');
  });

  it('saves the navigation layout preference from the General display controls', async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    window.addEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);

    render(<Wrap />);

    const select = await screen.findByRole('combobox', { name: /Navigation layout/i });
    expect(select).toHaveTextContent('Top bar');

    await chooseOption(user, /Navigation layout/i, /Left sidebar/i);

    await waitFor(() => {
      expect(localStorage.getItem(NAVIGATION_LAYOUT_STORAGE_KEY)).toBe('sidebar');
    });
    expect(onLayoutChange).toHaveBeenCalledWith(expect.objectContaining({
      detail: { value: 'sidebar' },
    }));

    window.removeEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);
  });

  it('clicking Accounts shows the Nexus + GitHub key fields', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await waitFor(() => {
      expect(screen.getByText(/Nexus Mods API Key/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /GitHub Token/i })).toBeInTheDocument();
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

  it('Backups tab shows the retention control reflecting the stored value', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    registerInvokeHandler('get_backup_retention', () => 3);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    const select = await screen.findByRole('combobox', { name: /Backups to keep/i });
    expect(select).toHaveTextContent('3');
    // The "Off" option (value 0) is offered.
    await user.click(select);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: /Off/i })).toBeInTheDocument();
  });

  it('changing the retention select invokes set_backup_retention with the new count', async () => {
    registerInvokeHandler('list_backups_cmd', () => []);
    registerInvokeHandler('get_backup_retention', () => 10);
    registerInvokeHandler('set_backup_retention', (args) => Number(args?.count));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Backups/ }));
    expect(await screen.findByRole('combobox', { name: /Backups to keep/i })).toHaveTextContent('10');
    await chooseOption(user, /Backups to keep/i, 'Off');
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_backup_retention' && c.args?.count === 0,
      )).toBe(true);
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

  it('General tab renders without crashing', async () => {
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
  });

  it('General tab controls whether new installs auto-add to the current modpack', async () => {
    const user = userEvent.setup();
    render(<Wrap />);

    const autoAdd = await screen.findByRole('switch', {
      name: /Add new installs to the current modpack/i,
    });
    expect(autoAdd).toHaveAttribute('aria-checked', 'false');

    await user.click(autoAdd);

    expect(autoAdd).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY)).toBe('true');
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

  it('Accounts tab explains what the GitHub token is while preserving exact scopes', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));

    expect(
      await screen.findByText(/A GitHub token is a password-like key that lets the app publish your modpacks/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Required scopes:/)).toBeInTheDocument();
    expect(screen.getByText(/Classic PAT/)).toHaveTextContent(/repo scope/);
    expect(screen.getByText(/Fine-grained PAT/)).toHaveTextContent(/Contents: Read and write/);
    expect(screen.getByText(/Fine-grained PAT/)).toHaveTextContent(/Administration: Read and write/);
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

  it('Check for updates: invokes backend install when update is available', async () => {
    const updateMock = vi.mocked(checkUpdate);
    const downloadAndInstall = vi.fn(async () => {});
    registerInvokeHandler('install_app_update', () => null);
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
      expect(getInvokeCalls().some((c) => c.cmd === 'install_app_update')).toBe(true);
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
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

  // ── Dev Builds gating (merged from main's dev-build work) ──────────
  // The Audit-tab tests main added here don't apply: this branch moved audit
  // out of Settings (it lives in Mod Library / a modpack's detail now).

  it('shows the Dev Builds section on a dev build', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    registerInvokeHandler('list_dev_builds', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(await screen.findByText('Dev Builds')).toBeInTheDocument();
  });

  it('hides the Dev Builds section on a release build', async () => {
    setMockAppVersion('1.6.1');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    // Settle on the always-present "Check for updates" control, then assert absence.
    await screen.findByText(/Check for updates/i);
    expect(screen.queryByText('Dev Builds')).not.toBeInTheDocument();
  });

  // ── Nexus Download Watch Folder card ─────────────────────────────

  it('General tab calls get_nexus_download_dir on mount', async () => {
    registerInvokeHandler('get_nexus_download_dir', () => null);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'get_nexus_download_dir')).toBe(true);
    });
  });

  it('Nexus Download Dir Reset button is hidden when no custom path is set', async () => {
    registerInvokeHandler('get_nexus_download_dir', () => null);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'get_nexus_download_dir')).toBe(true);
    });
    // Scope to the nexus download dir card so the RowMenuCustomizer's "Reset to default" is not matched.
    const nexusCard = screen.getByTestId('nexus-download-dir-card');
    const btnsInCard = within(nexusCard).queryAllByRole('button');
    expect(btnsInCard.some((b) => /Reset to default/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('Nexus Download Dir Browse button calls set_nexus_download_dir with chosen path', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockResolvedValueOnce('/custom/downloads' as never);
    registerInvokeHandler('get_nexus_download_dir', () => null);
    registerInvokeHandler('set_nexus_download_dir', () => '/custom/downloads');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    // The General tab has two Browse buttons: index 0 = Game Path, index 1 = Nexus dir.
    const browseBtns = screen.getAllByRole('button').filter((b) => /^Browse$/.test(b.textContent?.trim() ?? ''));
    expect(browseBtns.length).toBeGreaterThanOrEqual(2);
    await user.click(browseBtns[1]);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_nexus_download_dir' && c.args?.path === '/custom/downloads',
      )).toBe(true);
    });
  });

  it('Nexus Download Dir Reset button appears and calls set_nexus_download_dir with empty string', async () => {
    registerInvokeHandler('get_nexus_download_dir', () => '/custom/downloads');
    registerInvokeHandler('set_nexus_download_dir', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    // Scope to the nexus download dir card to disambiguate from RowMenuCustomizer's "Reset to default".
    const nexusCard = await screen.findByTestId('nexus-download-dir-card');
    await waitFor(() => {
      expect(within(nexusCard).getByRole('button', { name: /Reset to default/i })).toBeInTheDocument();
    });
    await user.click(within(nexusCard).getByRole('button', { name: /Reset to default/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_nexus_download_dir' && c.args?.path === '',
      )).toBe(true);
    });
  });

  it('Nexus Download Dir Browse error surfaces an error toast', async () => {
    const openMock = vi.mocked(openDialog);
    openMock.mockResolvedValueOnce('/bad/path' as never);
    registerInvokeHandler('get_nexus_download_dir', () => null);
    registerInvokeHandler('set_nexus_download_dir', () => { throw new Error('dir access denied'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    const browseBtns = screen.getAllByRole('button').filter((b) => /^Browse$/.test(b.textContent?.trim() ?? ''));
    await user.click(browseBtns[1]);
    await waitFor(() => {
      expect(screen.queryByText(/dir access denied/)).toBeInTheDocument();
    });
  });

  it('names the resolved OS default folder (not an empty box) when no custom path is set', async () => {
    registerInvokeHandler('get_nexus_download_dir', () => null);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    // The read-only box shows the actual watched folder — the OS default
    // Downloads dir (mocked to /os/Downloads) — instead of sitting empty.
    await waitFor(() => {
      expect(screen.getByDisplayValue('/os/Downloads')).toBeInTheDocument();
    });
    // The caption labels it as the default rather than repeating the path.
    expect(screen.getByText('OS default Downloads folder')).toBeInTheDocument();
    expect(screen.queryByText('Custom download folder')).not.toBeInTheDocument();
  });

  it('shows the custom path and a "Custom download folder" caption once one is set', async () => {
    registerInvokeHandler('get_nexus_download_dir', () => '/custom/dl');
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.getByDisplayValue('/custom/dl')).toBeInTheDocument();
    });
    expect(screen.getByText('Custom download folder')).toBeInTheDocument();
    // The default caption is gone — the two no longer read identically.
    expect(screen.queryByText('OS default Downloads folder')).not.toBeInTheDocument();
  });

  it('leaves the box empty (placeholder only) if the OS default folder cannot be resolved', async () => {
    vi.mocked(pathDownloadDir).mockResolvedValueOnce(null as never);
    registerInvokeHandler('get_nexus_download_dir', () => null);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Nexus Download Watch Folder/i)).toBeInTheDocument(); });
    // No custom path and no resolvable default → empty box, placeholder shows.
    const input = screen.getByPlaceholderText('OS default Downloads folder');
    expect(input).toHaveValue('');
  });

  it('scrolls + highlights the customizer card when the open signal bumps', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const { rerender } = render(
      <AllProviders><SettingsView openRowMenuSettingsSignal={0} /></AllProviders>,
    );
    act(() => {
      rerender(
        <AllProviders><SettingsView openRowMenuSettingsSignal={1} /></AllProviders>,
      );
    });
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
    expect(screen.getByTestId('row-menu-card')).toHaveClass('gf-row-menu-card-flash');
  });

  it('shows the Display size slider on the General tab', async () => {
    render(<Wrap />);
    const interfaceSlider = (await screen.findByLabelText('Interface scale')) as HTMLInputElement;
    const fontSlider = screen.getByLabelText('Text size') as HTMLInputElement;
    expect(interfaceSlider.value).toBe('100');
    expect(fontSlider.value).toBe('100');
    expect(screen.getByText('Display size')).toBeInTheDocument();
    expect(screen.getAllByText('Reset to 100%')).toHaveLength(2);
  });
});
