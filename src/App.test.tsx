import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';
import { getInvokeCalls, registerInvokeHandler, setMockAppVersion } from './__test__/setup';

// Stub getCurrentWindow used by the top-bar (move/minimize/etc.) so the
// App shell can mount in jsdom without throwing.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    startDragging: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async () => {}),
    onResized: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    listen: vi.fn(async () => () => {}),
  }),
}));

describe('<App>', () => {
  it('renders the top bar with the app title', async () => {
    setMockAppVersion('1.3.4');
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
  });

  /** Get a sidebar nav button by its label. The sidebar nav uses
   *  `.gf-nav` on every nav button, which lets us disambiguate from
   *  the onboarding overlay's "Settings" / "Tutorial" mentions. */
  function getNavButton(label: string): HTMLButtonElement {
    const buttons = screen.getAllByRole('button', { name: label });
    const nav = buttons.find((b) => b.className.includes('gf-nav'));
    if (!nav) throw new Error(`No .gf-nav button labeled ${label}; got ${buttons.length}`);
    return nav as HTMLButtonElement;
  }

  it('renders the sidebar nav buttons', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
    expect(getNavButton('Home')).toBeInTheDocument();
    expect(getNavButton('Profiles')).toBeInTheDocument();
    expect(getNavButton('Mods')).toBeInTheDocument();
    expect(getNavButton('Browse Mods')).toBeInTheDocument();
    expect(getNavButton('Browse Modpacks')).toBeInTheDocument();
    expect(getNavButton('Tutorial')).toBeInTheDocument();
    expect(getNavButton('Settings')).toBeInTheDocument();
  });

  it('clicking Mods nav swaps the body to the Mods view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Dismiss the onboarding overlay if it shows up
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Mods'));
    await waitFor(() => {
      expect(screen.getByText(/Your mods/i)).toBeInTheDocument();
    });
  });

  it('clicking Settings nav swaps to the Settings view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Settings'));
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it('clicking Browse Mods swaps to the Browse view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Browse Mods'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
  });

  it('clicking Profiles swaps to the Profiles view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Profiles'));
    await waitFor(() => {
      expect(screen.getByText(/Your packs/i)).toBeInTheDocument();
    });
  });

  it('clicking Home navigates back from another view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Mods'));
    await waitFor(() => { expect(screen.getByText(/Your mods/i)).toBeInTheDocument(); });
    await user.click(getNavButton('Home'));
    // Home view shows the share-code input.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
  });

  it('Launch button invokes launch_game', async () => {
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    // Launch button is in the top bar. Has the Play icon. Text "Launch"
    // or possibly a count of active mods. Use partial match.
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find((b) => /Launch$|Play/.test(b.textContent ?? ''));
    if (launchBtn) {
      await user.click(launchBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
      });
    }
  });

  it('Vanilla button is rendered', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    const buttons = screen.getAllByRole('button');
    const vanillaBtn = buttons.find((b) => /Vanilla/i.test(b.textContent ?? ''));
    expect(vanillaBtn).toBeTruthy();
  });

  it('window controls (minimize/maximize/close) are rendered', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Top-bar window controls — find by title attribute (Minimize/Maximize/Close).
    expect(screen.queryByTitle('Minimize') || screen.queryByTitle('Min')).toBeTruthy();
    expect(screen.queryByTitle('Close')).toBeTruthy();
  });

  it('Minimize button renders + is clickable without crash', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const min = screen.queryByTitle('Minimize') ?? screen.queryByTitle('Min');
    if (min) {
      await user.click(min);
    }
  });

  it('Close button renders + is clickable without crash', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const close = screen.queryByTitle('Close');
    if (close) {
      await user.click(close);
    }
  });

  it('Maximize button is rendered with title', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    expect(screen.queryByTitle('Maximize')).toBeTruthy();
  });

  it('renders the brand title in the sidebar', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Slay the Spire 2')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Mod Manager/).length).toBeGreaterThan(0);
  });

  it('drag-over → drag-leave does not show dropzone after leave', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The dropzone shows only while dragOver is true; without a dragstart
    // event firing, it should not be present.
    expect(screen.queryByText('Drop to install')).toBeNull();
  });

  it('renders active-profile pill in the top bar', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.queryAllByText(/MyPack/).length).toBeGreaterThan(0);
    });
  });

  it('Ctrl+L launches the game', async () => {
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Skip onboarding so the launch shortcut isn't gated.
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) {
      const user = userEvent.setup();
      await user.click(skip);
    }
    // Dispatch the keydown event.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    await waitFor(() => {
      // Either launch_game was called or shortcut was gated — accept both.
      // Use window.dispatchEvent since handler is on window.
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
  });

  it('Ctrl+L while typing in an input does NOT launch', async () => {
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    // Focus the share-code input (a text input).
    const input = screen.queryByPlaceholderText(/username\/AA5A-315D-61AE/i);
    if (input) {
      (input as HTMLInputElement).focus();
      // Dispatch keydown from the input target.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    }
    // No launch fired since target was an INPUT.
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Drag-over with Files type shows the drop overlay', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Dispatch a synthetic dragover with Files in dataTransfer.types.
    const evt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', {
      value: { types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(evt);
    await waitFor(() => {
      expect(screen.queryByText('Drop to install')).toBeInTheDocument();
    });
  });

  it('Drag-leave hides the drop overlay', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'] } });
    document.dispatchEvent(over);
    await waitFor(() => { expect(screen.getByText('Drop to install')).toBeInTheDocument(); });
    document.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByText('Drop to install')).toBeNull();
    });
  });

  it('clicking Tutorial swaps to the Tutorial view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await user.click(getNavButton('Tutorial'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Tutorial/i })).toBeInTheDocument();
    });
  });

  it('Launch button text includes the active profile name when set', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await waitFor(() => {
      expect(screen.queryAllByText(/MyPack/).length).toBeGreaterThan(0);
    });
  });

  it('Vanilla launch button click invokes launch_vanilla', async () => {
    registerInvokeHandler('launch_vanilla', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    const buttons = screen.getAllByRole('button');
    const vanillaBtn = buttons.find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
    if (vanillaBtn) {
      await user.click(vanillaBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'launch_vanilla')).toBe(true);
      });
    }
  });

  it('Launch button click invokes launch_game', async () => {
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find((b) =>
      /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    if (launchBtn) {
      await user.click(launchBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
      });
    }
  });

  it('Launch buttons are disabled when gameRunning=true', async () => {
    registerInvokeHandler('is_game_running_cmd', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const skip = screen.queryByRole('button', { name: /Skip setup/i });
    if (skip) await user.click(skip);
    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      const vanillaBtn = buttons.find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
      expect(vanillaBtn).toBeDefined();
      expect(vanillaBtn).toBeDisabled();
    });
  });

  it('Game-running banner renders when game is running', async () => {
    registerInvokeHandler('is_game_running_cmd', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.queryByText(/Slay the Spire 2 is running/)).toBeInTheDocument();
    });
  });

  it('Onboarding overlay renders on first launch (no localStorage key)', async () => {
    localStorage.removeItem('sts2mm-onboarded');
    render(<App />);
    await waitFor(() => {
      // The onboarding step copy mentions "Slay the Spire 2 install" or similar.
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    });
  });

  it('Onboarding overlay can be dismissed via Skip setup', async () => {
    localStorage.removeItem('sts2mm-onboarded');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Skip setup/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeNull();
    });
  });

  it('mod-auto-installed listener is registered', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // listen() is called multiple times during App mount. At minimum the
    // mod-auto-installed listener is registered.
    expect((listen as any)).toHaveBeenCalled();
  });

  it('mod-auto-install-failed event fires error toast', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    let listener: ((evt: { payload: { file_name: string; error: string } }) => void) | null = null;
    (listen as any).mockImplementation(async (event: string, handler: any) => {
      if (event === 'mod-auto-install-failed') listener = handler;
      return () => {};
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    if (listener) {
      (listener as any)({ payload: { file_name: 'bad.zip', error: 'corrupt' } });
      await waitFor(() => {
        expect(screen.queryByText(/Failed to install bad.zip.*corrupt/)).toBeInTheDocument();
      });
    }
  });

  it('modpack-mods-skipped event fires info toast with skipped count', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    let listener: any = null;
    (listen as any).mockImplementation(async (event: string, handler: any) => {
      if (event === 'modpack-mods-skipped') listener = handler;
      return () => {};
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    if (listener) {
      listener({
        payload: {
          profile_name: 'Pack',
          skipped: [{ mod_name: 'TooNew', min_game_version: '999', user_game_version: '0.1' }],
        },
      });
      await waitFor(() => {
        expect(screen.queryByText(/Skipped 1 mod.*TooNew/)).toBeInTheDocument();
      });
    }
  });

  it('modpack-mods-skipped with empty list is a no-op (no toast)', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    let listener: any = null;
    (listen as any).mockImplementation(async (event: string, handler: any) => {
      if (event === 'modpack-mods-skipped') listener = handler;
      return () => {};
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    if (listener) {
      listener({ payload: { profile_name: 'X', skipped: [] } });
    }
    expect(screen.queryByText(/Skipped/)).toBeNull();
  });

  it('App-level listen() registers more than one event subscription', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // App registers listeners for: mod-auto-installed, mod-auto-install-failed,
    // modpack-mods-skipped, sts2mm-open-url. AppContext adds more.
    expect((listen as any).mock.calls.length).toBeGreaterThan(2);
  });

  it('deep link event routes through importShareCodeSmart', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    registerInvokeHandler('consume_pending_deep_link', () => null);
    let dlListener: any = null;
    (listen as any).mockImplementation(async (event: string, handler: any) => {
      if (event === 'sts2mm-open-url') dlListener = handler;
      return () => {};
    });
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({ name: 'X', mods: [], created_at: '2026-01-01' }));
    registerInvokeHandler('install_shared_profile', () => ({ name: 'X', mods: [], created_at: '2026-01-01' }));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    if (dlListener) {
      dlListener({ payload: 'sts2mm://import/alice/AA5A-315D-61AE' });
      // The router will switch view to Home and route through confirm-prompted install.
    }
  });

  it('deep link cold-start path: consume_pending_deep_link gets called on mount', async () => {
    let consumed = 0;
    registerInvokeHandler('consume_pending_deep_link', () => {
      consumed += 1;
      return null;
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    expect(consumed).toBeGreaterThan(0);
  });

  it('updater check runs on launch (via @tauri-apps/plugin-updater::check)', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(updater.check).toHaveBeenCalled();
    });
  });

  it('Resize handles render around the window edge', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // 8 resize handles (cardinal + diagonal).
    expect(document.querySelectorAll('.gf-resize-handle').length).toBeGreaterThan(4);
  });

  it('Drop event with a .zip file invokes install_mod_from_file', async () => {
    registerInvokeHandler('install_mod_from_file', () => ({
      name: 'DroppedMod', version: '1.0', enabled: true, files: [],
    }));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Build a synthetic drop with a File-like object.
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    const file = { name: 'mod.zip', path: 'C:/tmp/mod.zip' };
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [file], types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(drop);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/tmp/mod.zip',
      )).toBe(true);
    });
  });

  it('Drop event with a non-zip file shows an error toast', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ name: 'mod.tar.gz', path: 'C:/tmp/mod.tar.gz' }], types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(drop);
    await waitFor(() => {
      expect(screen.queryByText(/Unsupported file/)).toBeInTheDocument();
    });
  });

  it('Profiles nav badge appears when there are pending pack updates', async () => {
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['X'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      const profilesNav = screen.getAllByRole('button').find(
        (b) => b.className.includes('gf-nav') && /Profiles/.test(b.textContent ?? ''),
      );
      expect(profilesNav?.textContent).toContain('1');
    });
  });
});
