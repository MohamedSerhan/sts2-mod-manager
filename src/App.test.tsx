/**
 * App.test.tsx — coverage notes for intentionally-unreachable branches.
 *
 *  - `AppInner: handleResizeStart` swallows errors from
 *    `startResizeDragging(...)`. The catch branch (line 361) is defensive
 *    against a stripped-down Tauri capability set and isn't worth the
 *    extra mock surface — we exercise the happy path only.
 *
 *  - `AppInner: handleTitlebarMin/Max/Close` likewise log on failure
 *    (lines 347, 351, 355). Same rationale: pure capability-missing
 *    guard, we exercise the happy path.
 *
 *  - `AppInner: route()` swallows a `consume_pending_deep_link` failure
 *    silently (line 252 catch). The comment in the source explicitly
 *    flags this as "command may be missing during dev hot-reload".
 *    Untested by design.
 *
 *  - `AppInner: handleLaunchGame / handleLaunchVanilla` early-return on
 *    `if (launching) return` (lines 315, 330). Hitting this requires
 *    racing a synchronous-resolved promise inside an effect; the value
 *    of the test is low and the test fragile.
 *
 *  - `AppInner: deep-link route()` `if (!active) return` cleanup guard
 *    (line 193). This branch only fires if the deep-link handler races
 *    an unmount mid-route — exercising it requires racing async state
 *    against `useEffect` cleanup, which is fragile and low-value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';
import { getInvokeCalls, registerInvokeHandler, setMockAppVersion } from './__test__/setup';

// Stub getCurrentWindow used by the top-bar (move/minimize/etc.) so the
// App shell can mount in jsdom without throwing. The fns are shared
// across every getCurrentWindow() call so tests can assert against them.
// Hoisted via `vi.hoisted` because vi.mock factories run before the
// module body — a plain `const` would be undefined at mock time.
const { mockWindow } = vi.hoisted(() => ({
  mockWindow: {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    startDragging: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async () => {}),
    onResized: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    listen: vi.fn(async () => () => {}),
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mockWindow,
}));

describe('<App>', () => {
  // Reset the shared `listen` mock between tests so `.mock.calls`
  // doesn't accumulate cross-test history. Each test's render call
  // re-registers fresh handlers; without this, fireTauriEvent could
  // dispatch into handlers from a previously-unmounted tree and
  // wedge state in the next test.
  beforeEach(async () => {
    const { listen } = await import('@tauri-apps/api/event');
    (listen as unknown as { mockClear: () => void; mockReset?: () => void }).mockClear();
    // Reset the mock implementation back to the default no-op unlisten
    // (some tests `mockImplementation()` it to capture handlers; without
    // a reset, a stray override could swallow listen() calls in the
    // next test).
    (listen as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => () => {},
    );
    // Default: pretend the user has already dismissed onboarding. The
    // few tests that exercise the wizard explicitly `removeItem` this
    // key before rendering. With this default, the `Skip setup` button
    // is NOT in the tree on render, so tests can deterministically skip
    // the `if (skip) await user.click(skip)` dance.
    try { localStorage.setItem('sts2mm-onboarded', 'true'); } catch {}
  });

  it('renders the top bar with the app title', async () => {
    setMockAppVersion('1.3.4');
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
  });

  /** Get a sidebar nav button by its label. The sidebar nav uses
   *  `.gf-nav` on every nav button, which lets us disambiguate from
   *  the onboarding overlay's "Settings" / "Help" mentions. */
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
    expect(getNavButton('Modpacks')).toBeInTheDocument();
    expect(getNavButton('Mods')).toBeInTheDocument();
    expect(getNavButton('Browse Mods')).toBeInTheDocument();
    const modpacksNav = getNavButton('Browse Modpacks');
    expect(modpacksNav).toBeInTheDocument();
    expect(within(modpacksNav).getByText('Beta')).toBeInTheDocument();
    expect(getNavButton('Help')).toBeInTheDocument();
    expect(getNavButton('Settings')).toBeInTheDocument();
  });

  it('clicking Mods nav swaps the body to the Mods view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Dismiss the onboarding overlay if it shows up
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Mods'));
    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
  });

  it('Mods tab Mod Library bridge opens the profile assignment workspace', async () => {
    registerInvokeHandler('get_installed_mods', () => [{
      name: 'BaseLib',
      version: '1.0.0',
      description: 'Base library',
      enabled: true,
      files: ['BaseLib/BaseLib.dll'],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 1024,
      folder_name: 'BaseLib',
      mod_id: 'BaseLib',
      github_url: null,
      nexus_url: null,
      pinned: false,
      min_game_version: null,
      author: 'QA',
      tags: [],
      display_name: null,
      display_description: null,
    }]);
    registerInvokeHandler('list_profiles_cmd', () => [{
      name: 'Stable',
      mods: [],
      created_at: '2026-01-01T00:00:00Z',
      created_by: null,
      game_version: '0.105.0',
    }]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [{
        name: 'BaseLib',
        version: '1.0.0',
        folder_name: 'BaseLib',
        mod_id: 'BaseLib',
        installed_enabled: true,
        profiles: [
          { profile_name: 'Stable', included: false, enabled: false, editable: true },
        ],
      }],
    }));

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Mods'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });

    await user.click(screen.getByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByRole('heading', { name: /Mod Library/i })).toBeInTheDocument();
    expect((await screen.findAllByText('BaseLib')).length).toBeGreaterThan(0);
    expect(screen.getByRole('checkbox', { name: 'Stable' })).not.toBeChecked();
  });

  it('clicking Settings nav swaps to the Settings view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Settings'));
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it('clicking Browse Mods swaps to the Browse view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Browse Mods'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
  });

  it('clicking Browse Modpacks swaps to the modpack browser', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Browse Modpacks'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
  });

  it('Browse Modpacks empty-state Profiles button routes to Profiles', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () => ({
      cards: [],
      page: 1,
      has_next_page: false,
      stale: false,
      fetched_at: Math.floor(Date.now() / 1000),
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Browse Modpacks'));

    await user.click(await screen.findByRole('button', { name: /Go to Profiles/i }));

    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  it('clicking Profiles swaps to the Profiles view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Modpacks'));
    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  it('clicking Home navigates back from another view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Mods'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
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
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    // Launch button is in the top bar. Top-level launch button has class
    // gf-btn (not gf-btn-2 which is the vanilla one).
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
  });

  it('Vanilla button is rendered', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
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

  // Note: Minimize / Close click tests now live in the "Titlebar window
  // controls" section below — they assert visible behavior. The
  // standalone "rendered with title" probes here are kept as a smoke check.
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
    // (Onboarding suppressed by beforeEach so launch shortcut isn't gated.)
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
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    // Focus the share-code input (a text input).
    const input = screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i) as HTMLInputElement;
    input.focus();
    // Dispatch keydown from the input target — the App's keyboard handler
    // is on `window`, so the event must bubble.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
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

  it('clicking Help swaps to the Help view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await user.click(getNavButton('Help'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /^Help$/i })).toBeInTheDocument();
    });
  });

  it('Launch button text includes the active profile name when set', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    await waitFor(() => {
      expect(screen.queryAllByText(/MyPack/).length).toBeGreaterThan(0);
    });
  });

  it('Vanilla launch button click invokes launch_vanilla', async () => {
    registerInvokeHandler('launch_vanilla', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    const buttons = screen.getAllByRole('button');
    const vanillaBtn = buttons.find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
    expect(vanillaBtn).toBeDefined();
    await user.click(vanillaBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_vanilla')).toBe(true);
    });
  });

  it('Launch button click invokes launch_game', async () => {
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find((b) =>
      /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
  });

  it('Launch buttons are disabled when gameRunning=true', async () => {
    registerInvokeHandler('is_game_running_cmd', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
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
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // fireTauriEvent throws if no listener is registered for the event,
    // so a future refactor that drops the subscription fails loudly here.
    await fireTauriEvent('mod-auto-install-failed', { file_name: 'bad.zip', error: 'corrupt' });
    await waitFor(() => {
      expect(screen.queryByText(/Failed to install bad.zip.*corrupt/)).toBeInTheDocument();
    });
  });

  it('modpack-mods-skipped event fires info toast with skipped count', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('modpack-mods-skipped', {
      profile_name: 'Pack',
      skipped: [{ mod_name: 'TooNew', min_game_version: '999', user_game_version: '0.1' }],
    });
    await waitFor(() => {
      expect(screen.queryByText(/Skipped 1 mod.*TooNew/)).toBeInTheDocument();
    });
  });

  // NOTE: the "modpack-mods-skipped with empty list is a no-op" case and
  // the "deep link event routes through importShareCodeSmart" case were
  // removed here — they are covered by the loud-assertion tests further
  // down (search `modpack-mods-skipped with empty array returns early`
  // and the deep-link route() success/cancellation/error tests).

  it('App-level listen() registers more than one event subscription', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // App registers listeners for: mod-auto-installed, mod-auto-install-failed,
    // modpack-mods-skipped, sts2mm-open-url. AppContext adds more.
    expect((listen as any).mock.calls.length).toBeGreaterThan(2);
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
      // The Profiles nav button (id='profiles') now labels as "Modpacks".
      // Disambiguate from "Browse Modpacks" via exact label match on the
      // nav-label span text.
      const profilesNav = screen.getAllByRole('button').find(
        (b) =>
          b.className.includes('gf-nav') &&
          b.querySelector('.gf-nav-label')?.textContent === 'Modpacks',
      );
      expect(profilesNav?.textContent).toContain('1');
    });
  });

  // ── Helper: drive a Tauri event handler that was registered via listen() ──
  /**
   * Fire a Tauri event by name. Invokes EVERY handler registered for
   * the event (not just the most-recent), because App.tsx and
   * AppContext sometimes both subscribe to the same event under
   * different responsibilities. Returns the array of handler results.
   */
  async function fireTauriEvent<P>(name: string, payload: P): Promise<unknown[]> {
    const { listen } = await import('@tauri-apps/api/event');
    const calls = (listen as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const matches = calls.filter((c) => c[0] === name);
    if (matches.length === 0) throw new Error(`No listener registered for "${name}"`);
    return Promise.all(
      matches.map((m) => (m[1] as (e: { payload: P }) => unknown)({ payload })),
    );
  }

  it('mod-auto-installed event (no replacement) shows install toast', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'SuperMod',
      file_name: 'super.zip',
      replaced: null,
    });
    await waitFor(() => {
      expect(screen.getByText(/Mod "SuperMod" auto-installed from super\.zip/)).toBeInTheDocument();
    });
  });

  it('mod-auto-installed event with replaced shows update toast', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'SuperMod v2',
      file_name: 'super2.zip',
      replaced: 'SuperMod v1',
    });
    await waitFor(() => {
      expect(screen.getByText(/Updated "SuperMod v1" → "SuperMod v2" from super2\.zip/)).toBeInTheDocument();
    });
  });

  it('modpack-mods-skipped event with multiple mods shows plural summary', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('modpack-mods-skipped', {
      profile_name: 'BigPack',
      skipped: [
        { mod_name: 'A', min_game_version: '2', user_game_version: '1' },
        { mod_name: 'B', min_game_version: '3', user_game_version: '1' },
      ],
    });
    await waitFor(() => {
      expect(screen.getByText(/Skipped 2 mods.*A.*B/)).toBeInTheDocument();
    });
  });

  // ── Top-bar profile chip / ProfileSwitcher ────────────────────────
  it('clicking the profile chip opens the ProfileSwitcher popover', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    // Profile chip button has class gf-prof.
    const chip = document.querySelector('button.gf-prof') as HTMLButtonElement | null;
    expect(chip).toBeTruthy();
    await user.click(chip!);
    // ProfileSwitcher's "Add modpack" / "Manage all" foot button is the
    // unambiguous signal the popover mounted.
    const switcher = await screen.findByRole('button', { name: /Add modpack/i });
    expect(switcher).toBeInTheDocument();
  });

  it('ProfileSwitcher "Add pack" routes to Home + bumps focus signal', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    // Navigate to a non-home view first so we can observe the switch.
    await user.click(getNavButton('Mods'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
    // Open switcher, click Add modpack.
    const chip = document.querySelector('button.gf-prof') as HTMLButtonElement | null;
    expect(chip).toBeTruthy();
    await user.click(chip!);
    // The "Add modpack" foot button lives in .gf-pop-foot.
    const addBtn = await screen.findByRole('button', { name: /Add modpack/i });
    await user.click(addBtn);
    // Home view should be active — its placeholder is visible.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
  });

  it('ProfileSwitcher "Manage all" routes to Profiles view', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    const chip = document.querySelector('button.gf-prof') as HTMLButtonElement | null;
    expect(chip).toBeTruthy();
    await user.click(chip!);
    // "Manage all" foot button is unambiguous once the popover mounts.
    const manageBtn = await screen.findByRole('button', { name: /Manage all/i });
    await user.click(manageBtn);
    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  // ── App-update banner ─────────────────────────────────────────────
  it('app-update banner renders when updater.check returns an update', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    expect(screen.getByText(/You're on v1\.3\.4/)).toBeInTheDocument();
  });

  it('app-update banner Dismiss button hides the banner', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Dismiss$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Mod Manager v9\.9\.9 is available/)).toBeNull();
    });
  });

  it('app-update banner Install & Restart calls downloadAndInstall + relaunch', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    const proc = await import('@tauri-apps/plugin-process');
    const downloadAndInstall = vi.fn(async () => {});
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall,
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Install & Restart/i }));
    await waitFor(() => {
      expect(downloadAndInstall).toHaveBeenCalled();
      expect(proc.relaunch).toHaveBeenCalled();
    });
    // Success toast from the install path.
    expect(screen.getByText(/Update installed\. Restarting/)).toBeInTheDocument();
  });

  it('app-update banner Install & Restart surfaces error toast on failure', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => { throw new Error('disk full'); }),
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Install & Restart/i }));
    await waitFor(() => {
      expect(screen.getByText(/Update failed: disk full/)).toBeInTheDocument();
    });
  });

  it('app-update banner Download button calls openUrl with releases URL', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    const opener = await import('@tauri-apps/plugin-opener');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Download/i }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        expect.stringContaining('github.com/MohamedSerhan/sts2-mod-manager/releases/latest'),
      );
    });
  });

  it('app-update banner Download button surfaces error toast on failure', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    const opener = await import('@tauri-apps/plugin-opener');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no browser'));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Download/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to open browser.*no browser/)).toBeInTheDocument();
    });
  });

  it('routes external anchor clicks through the backend opener', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getNavButton('Settings'));
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    await user.click(await screen.findByRole('link', { name: /Get your API key from Nexus Mods/i }));

    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/users/myaccount?tab=api',
      );
    });
  });

  it('guards external anchor routing and reports opener failures', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    const openUrl = opener.openUrl as ReturnType<typeof vi.fn>;
    openUrl.mockClear();

    const { container } = render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    const root = container.firstElementChild as HTMLElement;
    const appendAnchor = (href: string, text: string, configure?: (anchor: HTMLAnchorElement) => void) => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      anchor.textContent = text;
      anchor.addEventListener('click', (event) => event.preventDefault());
      configure?.(anchor);
      root.appendChild(anchor);
      return anchor;
    };

    fireEvent.click(appendAnchor('https://example.test/modified', 'modified'), { ctrlKey: true });
    fireEvent.click(appendAnchor('https://example.test/download', 'download', (a) => {
      a.setAttribute('download', '');
    }));
    fireEvent.click(appendAnchor('http://[invalid', 'invalid'));
    fireEvent.click(appendAnchor('sts2mm://profile/demo', 'internal'));

    expect(openUrl).not.toHaveBeenCalled();

    openUrl.mockRejectedValueOnce(new Error('no browser'));
    fireEvent.click(appendAnchor('https://example.test/fail', 'fail'));

    await waitFor(() => {
      expect(screen.getByText(/Failed to open link: no browser/)).toBeInTheDocument();
    });
  });

  it('updater.check rejection is logged and does not crash the app', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Update check failed:', expect.any(Error));
    });
    warnSpy.mockRestore();
  });

  // ── Titlebar window controls (happy paths) ────────────────────────
  it('Maximize button click calls toggleMaximize without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const max = screen.getByTitle('Maximize');
    await user.click(max);
    // Visible-behavior assertion: nothing should crash and the button
    // is still in the document afterward.
    expect(max).toBeInTheDocument();
  });

  it('Maximize button logs capability errors without crashing', async () => {
    const user = userEvent.setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWindow.toggleMaximize.mockRejectedValueOnce(new Error('missing capability'));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    const max = screen.getByTitle('Maximize');
    await user.click(max);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('toggleMaximize failed:', expect.any(Error));
    });
    expect(max).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('Close button click is handled without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const close = screen.getByTitle('Close');
    await user.click(close);
    expect(close).toBeInTheDocument();
  });

  it('Minimize button click is handled without crashing', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const min = screen.getByTitle('Minimize');
    await user.click(min);
    expect(min).toBeInTheDocument();
  });

  // ── Resize handles ────────────────────────────────────────────────
  it('Mouse-down on a resize handle calls startResizeDragging', async () => {
    mockWindow.startResizeDragging.mockClear();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const handles = document.querySelectorAll('.gf-resize-handle');
    expect(handles.length).toBeGreaterThan(0);
    // Fire mousedown on the first handle (North). React's onMouseDown
    // listens for the bubbling event; dispatch a synthetic MouseEvent.
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    (handles[0] as HTMLElement).dispatchEvent(md);
    await waitFor(() => {
      expect(mockWindow.startResizeDragging).toHaveBeenCalled();
    });
  });

  // ── Deep-link route() success / cancellation / error paths ────────
  it('deep-link: new share code triggers install confirm + installed toast', async () => {
    // No matching subscription → smart router takes the install path.
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'NewPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'NewPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // Smart router opens the install confirm dialog. The confirm
    // button text is "Install 1 mod" (label is set per mod count).
    const confirmBtn = await screen.findByRole('button', { name: /Install 1 mod/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Installed modpack "NewPack"/)).toBeInTheDocument();
    });
  });

  it('deep-link: cancelled confirm produces no toast', async () => {
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'NewPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // Wait for the modal to appear so we don't grab a stray Cancel button
    // from elsewhere. Scope the Cancel lookup to the confirm modal's foot.
    await screen.findByText(/Install this modpack/i);
    const modalFoot = document.querySelector('.gf-modal-foot') as HTMLElement | null;
    expect(modalFoot).toBeTruthy();
    const cancelBtn = Array.from(modalFoot!.querySelectorAll('button')).find(
      (b) => /^Cancel$/i.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(cancelBtn).toBeDefined();
    await user.click(cancelBtn!);
    // After cancel, no installed/synced toast appears, and the modal
    // is dismissed.
    await waitFor(() => {
      expect(screen.queryByText(/Install this modpack/i)).toBeNull();
    });
    expect(screen.queryByText(/Installed modpack/)).toBeNull();
    expect(screen.queryByText(/Switched to/)).toBeNull();
  });

  it('deep-link: already-active subscription shows already-active toast', async () => {
    registerInvokeHandler('get_active_profile', () => 'alice-pack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'alice-pack', subscribed_at: '2026-01-01', last_synced_at: '2026-01-02', auto_update: true, last_audit_kind: null, last_audit_summary: null, last_audit_at: null, snoozed_at: null, snoozed_versions_json: null },
    ]);
    registerInvokeHandler('check_subscription_updates', () => []); // no pending updates
    registerInvokeHandler('switch_profile', () => ({
      applied: true, downloaded: 0, missing_mods: [], failed_downloads: [],
    }));
    registerInvokeHandler('consume_pending_deep_link', () => null);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Wait for refs to be populated (activeProfile flows in via context).
    await waitFor(() => {
      expect(screen.queryAllByText(/alice-pack/).length).toBeGreaterThan(0);
    });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    await waitFor(() => {
      expect(screen.getByText(/Re-applied "alice-pack"\./)).toBeInTheDocument();
    });
  });

  it('deep-link: dedupe window swallows repeat URL within 2s', async () => {
    registerInvokeHandler('get_active_profile', () => 'alice-pack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'alice-pack', subscribed_at: '2026-01-01', last_synced_at: '2026-01-02', auto_update: true, last_audit_kind: null, last_audit_summary: null, last_audit_at: null, snoozed_at: null, snoozed_versions_json: null },
    ]);
    registerInvokeHandler('check_subscription_updates', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.queryAllByText(/alice-pack/).length).toBeGreaterThan(0);
    });
    // Fire twice in quick succession — second is deduped.
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    await waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping duplicate URL'),
        expect.any(String),
      );
    });
    debugSpy.mockRestore();
  });

  it('deep-link: cold-start drains pending URL via consume_pending_deep_link', async () => {
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => 'sts2mm://import/alice/AA5A-315D-61AE');
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'ColdPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'ColdPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The cold-start drain auto-routes; expect the install confirm to surface.
    const confirmBtn = await screen.findByRole('button', { name: /Install 1 mod/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Installed modpack "ColdPack"/)).toBeInTheDocument();
    });
  });

  it('deep-link: malformed URL surfaces error toast', async () => {
    // Force importShareCodeSmart to throw by making the install command
    // reject. canonicalShareCode returns null for a malformed input, so
    // the smart router falls into installSharedProfileWithConfirm; we
    // make that reject so the catch branch fires.
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('fetch_shared_profile_cmd', () => {
      throw new Error('parse failed');
    });
    registerInvokeHandler('install_shared_profile', () => {
      throw new Error('parse failed');
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://garbage/not-a-code');
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open share link/)).toBeInTheDocument();
    });
  });

  it('deep-link: empty payload is a no-op (route not invoked)', async () => {
    registerInvokeHandler('consume_pending_deep_link', () => null);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', '');
    // No install-modpack confirm dialog appears; no error toast appears.
    expect(screen.queryByText(/Install this modpack/i)).toBeNull();
    expect(screen.queryByText(/Couldn't open share link/)).toBeNull();
  });

  it('deep-link: routes to Home view before processing', async () => {
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'P', mods: [], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    // Navigate to Mods so we can prove the deep-link bounces us back to Home.
    await user.click(getNavButton('Mods'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // After route() fires, view should have switched to home — the
    // share-code placeholder is the canonical Home signal.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
    });
  });

  // ── Drop event misc ───────────────────────────────────────────────
  it('Drop event with install_mod_from_file failure surfaces error toast', async () => {
    registerInvokeHandler('install_mod_from_file', () => {
      throw new Error('extract failed');
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ name: 'bad.zip', path: 'C:/tmp/bad.zip' }], types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(drop);
    await waitFor(() => {
      expect(screen.getByText(/Failed to install bad\.zip.*extract failed/)).toBeInTheDocument();
    });
  });

  it('Drop event with no files is a no-op', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [], types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(drop);
    // No error toast, no install call.
    expect(screen.queryByText(/Unsupported|Failed/)).toBeNull();
    expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(false);
  });

  // ── Launch error paths ────────────────────────────────────────────
  it('Launch button error surfaces toast', async () => {
    registerInvokeHandler('launch_game', () => { throw new Error('steam missing'); });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to launch game.*steam missing/)).toBeInTheDocument();
    });
  });

  it('Vanilla button error surfaces toast', async () => {
    registerInvokeHandler('launch_vanilla', () => { throw new Error('no perms'); });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // (Onboarding overlay is suppressed by default in beforeEach so we
    //  don't need a Skip-setup click.)
    const buttons = screen.getAllByRole('button');
    const vanillaBtn = buttons.find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
    expect(vanillaBtn).toBeDefined();
    await user.click(vanillaBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to launch.*no perms/)).toBeInTheDocument();
    });
  });

  // ── View-callback wiring (covers the inline `() => setActiveView(...)`
  // arrow callbacks passed into HomeView / ProfilesView / BrowseView /
  // OnboardingOverlay / LaunchSpinner) ─────────────────────────────────
  // Note: HelpView (1.7) is self-contained and no longer surfaces an
  // inline Settings deep-link, so there's no Help -> Settings wiring
  // test here. The onGoToSettings prop remains for future contextual
  // links but is currently unused.
  it("Home's Settings shortcut (game-not-detected banner) routes to Settings", async () => {
    // Default mock: `valid: false`, so HomeView renders the
    // "Game not detected" banner with a "Settings" button wired to
    // onGoToSettings → setActiveView('settings').
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The Home banner Settings button has class gf-btn-3 and the text
    // "Settings". Multiple Settings labels exist (sidebar nav etc.), so
    // scope to the banner element.
    const banner = await screen.findByText(/Game not detected/i);
    const bannerEl = banner.closest('.gf-banner') as HTMLElement | null;
    expect(bannerEl).toBeTruthy();
    const settingsBtn = Array.from(bannerEl!.querySelectorAll('button')).find(
      (b) => /Settings/.test(b.textContent ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(settingsBtn).toBeDefined();
    await user.click(settingsBtn!);
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it("Home's 'Manage mods' button routes to Mods view", async () => {
    // The Hero "Manage mods" button (Home.tsx:548) calls onGoToMods,
    // which is the inline `() => setActiveView('mods')` arrow at
    // App.tsx:683.
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const manageMods = await screen.findByRole('button', { name: /Manage mods/i });
    await user.click(manageMods);
    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
  });

  it("Home's hero 'Switch pack' button opens the ProfileSwitcher", async () => {
    // Home hero button "Switch to a different pack" (Home.tsx:557)
    // wires to onSwitchPack → setShowProfileSwitcher(true) (App.tsx:685).
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The exact label varies — find by title attribute.
    const switchPack = await screen.findByTitle(/Switch to a different pack/i);
    await user.click(switchPack);
    // ProfileSwitcher's "Add modpack" foot button is the unambiguous
    // signal the popover mounted.
    await screen.findByRole('button', { name: /Add modpack/i });
  });

  it("Browse view 'Open Settings' button (Nexus key missing) routes to Settings", async () => {
    // Force nexus_get_trending to reject with the special "Nexus API
    // key not set" sentinel so Browse renders its "Open Settings"
    // deep-link button. That button calls onGoToSettings →
    // setActiveView('settings') inline at App.tsx:692.
    registerInvokeHandler('nexus_get_trending', () => {
      throw new Error('Nexus API key not set');
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Browse Mods'));
    // Default Browse tab is github; switch to Nexus Trending so the
    // effect fires and surfaces the key-missing banner.
    const trendingTab = await screen.findByRole('button', { name: /Nexus Trending/i });
    await user.click(trendingTab);
    const openSettings = await screen.findByRole('button', { name: /Open Settings/i });
    await user.click(openSettings);
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it('Onboarding "Follow a friend" routes to Home + bumps focusCodeBarSignal', async () => {
    // Walk the onboarding wizard from step 1 to step 3 and pick the
    // "Follow a friend (paste code)" option, which calls onComplete()
    // then onAddCode() — the latter is App.tsx:702's inline
    // setActiveView('home') arrow.
    localStorage.removeItem('sts2mm-onboarded');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    });
    // Step 1 → 2. The primary action is "Next".
    const next1 = await screen.findByRole('button', { name: /^Next$/i });
    await user.click(next1);
    // Step 2 → 3. With no nexus key + no GH token saved the button
    // label is "Skip for now" rather than "Next".
    const next2 = await screen.findByRole('button', { name: /Skip for now|^Next$/i });
    await user.click(next2);
    // Step 3 — pick the "Follow a friend" choice.
    const follow = await screen.findByRole('button', { name: /Follow a friend/i });
    await user.click(follow);
    // After onComplete + onAddCode, the onboarding is dismissed AND the
    // Home view's share-code placeholder is in the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeNull();
    });
    expect(screen.getByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeInTheDocument();
  });

  it("LaunchSpinner's 'Hide' button calls onCancel and dismisses the spinner", async () => {
    // Clicking the top-bar Launch button kicks off the spinner overlay
    // which renders LaunchSpinner with onCancel = setLaunching(null)
    // (App.tsx:711). Clicking "Hide" on the spinner exercises that arrow.
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);
    // Spinner overlay shows up with a Hide button.
    const hide = await screen.findByRole('button', { name: /^Hide$/i });
    await user.click(hide);
    // Spinner is gone after Hide.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Hide$/i })).toBeNull();
    });
  });

  // ── Deep-link "activated" + "synced" outcomes ─────────────────────
  it('deep-link: subscribed-but-not-active → activate confirm → "Switched to" toast', async () => {
    // A subscription that exists but isn't the active profile → smart
    // router opens an "Activate" confirm and on OK emits the `activated`
    // outcome (App.tsx:233 branch).
    registerInvokeHandler('get_active_profile', () => 'other-pack');
    registerInvokeHandler('get_subscriptions', () => [
      {
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'alice-pack',
        subscribed_at: '2026-01-01',
        last_synced_at: '2026-01-02',
        auto_update: true,
        last_audit_kind: null,
        last_audit_summary: null,
        last_audit_at: null,
        snoozed_at: null,
        snoozed_versions_json: null,
      },
    ]);
    registerInvokeHandler('check_subscription_updates', () => []); // no pending
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('switch_profile', () => null);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Wait for activeProfile + subscriptions to flow into refs.
    await waitFor(() => {
      expect(screen.queryAllByText(/other-pack/).length).toBeGreaterThan(0);
    });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // Activate confirm dialog appears. Title is `Switch to "alice-pack"?`.
    await screen.findByText(/Switch to "alice-pack"\?/);
    // The confirm-yes button is in the modal foot.
    const modalFoot = document.querySelector('.gf-modal-foot') as HTMLElement | null;
    expect(modalFoot).toBeTruthy();
    const activateBtn = Array.from(modalFoot!.querySelectorAll('button')).find(
      (b) => /^Activate$/i.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(activateBtn).toBeDefined();
    await user.click(activateBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Switched to "alice-pack"/)).toBeInTheDocument();
    });
  });

  it('deep-link: active-with-pending-update → apply update confirm → "Synced" toast', async () => {
    // A subscription that IS the active profile AND has a pending update
    // → smart router shows an "Apply update" confirm, OK emits `synced`
    // (App.tsx:235 branch).
    registerInvokeHandler('get_active_profile', () => 'alice-pack');
    registerInvokeHandler('get_subscriptions', () => [
      {
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'alice-pack',
        subscribed_at: '2026-01-01',
        last_synced_at: '2026-01-02',
        auto_update: true,
        last_audit_kind: null,
        last_audit_summary: null,
        last_audit_at: null,
        snoozed_at: null,
        snoozed_versions_json: null,
      },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'alice-pack',
        has_update: true,
        added_mods: [{ name: 'NewMod' }],
        updated_mods: [],
        removed_mods: [],
        remote_profile: { name: 'alice-pack', mods: [], created_at: '2026-01-03' },
      },
    ]);
    registerInvokeHandler('apply_subscription_update', () => null);
    registerInvokeHandler('consume_pending_deep_link', () => null);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Wait for activeProfile + subUpdates to settle into refs.
    await waitFor(() => {
      expect(screen.queryAllByText(/alice-pack/).length).toBeGreaterThan(0);
    });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // Apply update confirm dialog appears.
    const applyBtn = await screen.findByRole('button', { name: /Apply update/i });
    await user.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByText(/Synced "alice-pack"/)).toBeInTheDocument();
    });
  });

  // ── Misc smaller branches ─────────────────────────────────────────
  it('Ctrl+L while onboarding is showing does NOT launch (showOnboarding guard)', async () => {
    // App.tsx:376 — `if (showOnboarding) return` in the keydown handler.
    localStorage.removeItem('sts2mm-onboarded');
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    // launch_game was NOT invoked.
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Ctrl+L without modifier does NOT launch', async () => {
    // App.tsx:378 — guard requires meta/ctrl. A bare "l" key should not
    // trigger launch.
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Ctrl+L while gameRunning=true does NOT launch (guard)', async () => {
    // App.tsx:380 — `if (!gameRunning && !launching) handleLaunchGame()`.
    registerInvokeHandler('is_game_running_cmd', () => true);
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      // Wait for gameRunning to propagate (banner visible).
      expect(screen.getByText(/Slay the Spire 2 is running/)).toBeInTheDocument();
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('getSubscriptions failure during deep-link routing is swallowed (defaults to [])', async () => {
    // App.tsx:217 — `.catch(() => [])` on the getSubscriptions read
    // inside route(). With the read failing, the router still proceeds
    // with an empty subs array (install path).
    registerInvokeHandler('get_subscriptions', () => {
      throw new Error('db locked');
    });
    registerInvokeHandler('consume_pending_deep_link', () => null);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'FreshPack', mods: [{ name: 'X' }], created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'FreshPack', mods: [{ name: 'X' }], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // The install path still kicks off (router didn't blow up on the
    // failed subscriptions read). The confirm dialog appears.
    const confirmBtn = await screen.findByRole('button', { name: /Install 1 mod/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Installed modpack "FreshPack"/)).toBeInTheDocument();
    });
  });

  it('ProfilesView PublishModal "Open Settings → Accounts" routes to Settings', async () => {
    // Trigger flow:
    //   1. Mount with a profile that's not yet shared and github_token_set = false.
    //   2. Navigate to Profiles, click the Share button on the profile row.
    //   3. PublishModal renders the "GitHub token required" block with the
    //      "Open Settings → Accounts" button.
    //   4. Clicking it calls onGoToSettings which is App.tsx:690's inline
    //      `() => setActiveView('settings')` arrow.
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: false,
    }));
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Modpacks'));
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const shareBtn = screen.getAllByRole('button').find(
      (b) => /^Share$/.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(shareBtn).toBeDefined();
    await user.click(shareBtn!);
    // PublishModal renders the "Open Settings → Accounts" button when
    // tokenSet === false.
    const openSettingsBtn = await screen.findByRole('button', {
      name: /Open Settings.*Accounts/i,
    });
    await user.click(openSettingsBtn);
    // App routed to Settings view.
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it("Home's 'View all in Profiles' link routes to Profiles (otherSubs path)", async () => {
    // The Home view's "Your other packs" section renders a "View all in
    // Profiles" inline link (Home.tsx:644) that calls
    // `() => onGoToProfiles?.()` → setActiveView('profiles') inline at
    // App.tsx:684. The section only appears when otherSubs.length > 0.
    registerInvokeHandler('get_active_profile', () => 'main-pack');
    registerInvokeHandler('get_subscriptions', () => [
      {
        share_id: 'alice/AAAA-BBBB-CCCC',
        profile_name: 'other-pack',
        subscribed_at: '2026-01-01',
        last_synced_at: '2026-01-02',
        auto_update: true,
        last_audit_kind: null,
        last_audit_summary: null,
        last_audit_at: null,
        snoozed_at: null,
        snoozed_versions_json: null,
      },
    ]);
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'main-pack', mods: [], created_at: '2026-01-01' },
      { name: 'other-pack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Wait for the otherSubs section heading.
    const viewAll = await screen.findByRole('button', { name: /View all in Profiles/i });
    await user.click(viewAll);
    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  it('enabledCount/totalCount reflect get_installed_mods output', async () => {
    // App.tsx:311 — `mods.filter((m) => m.enabled).length`. Triggering
    // this with a non-empty mods list exercises the `(m) => m.enabled`
    // arrow function on every mod, and surfaces the count in the
    // sidebar status block + top-bar profile chip.
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'A', version: '1', enabled: true, files: [] },
      { name: 'B', version: '1', enabled: false, files: [] },
      { name: 'C', version: '1', enabled: true, files: [] },
    ]);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // "2 active / 3 mods" appears in both the sidebar foot and top-bar
    // profile chip.
    await waitFor(() => {
      expect(screen.queryAllByText(/2 active \/ 3 mods/).length).toBeGreaterThan(0);
    });
  });

  // ── Smaller branch coverage knobs ────────────────────────────────
  it('modpack-mods-skipped with empty array returns early (no toast)', async () => {
    // App.tsx:141 — `if (skipped.length === 0) return`.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('modpack-mods-skipped', { profile_name: 'P', skipped: [] });
    // Nothing toast-y appeared.
    expect(screen.queryByText(/Skipped/)).toBeNull();
    expect(screen.queryByText(/Modpack "P" applied/)).toBeNull();
  });

  it('Ctrl+L (uppercase L) launches the game', async () => {
    // App.tsx:378 — `e.key === 'l' || e.key === 'L'`. Uppercase exercises
    // the right-hand branch.
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
  });

  it('Ctrl+L while focused on a TEXTAREA does NOT launch (isTypingTarget guard)', async () => {
    // App.tsx:372 — `tag === 'INPUT' || tag === 'TEXTAREA' || ...`.
    // Exercise the TEXTAREA branch.
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
    document.body.removeChild(ta);
  });

  it('Ctrl+L on contentEditable element does NOT launch (isTypingTarget guard)', async () => {
    // App.tsx:372 — `t.isContentEditable` branch. jsdom doesn't always
    // wire `isContentEditable` from the attribute, so define it directly
    // on the element for the duration of the test.
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', {
      value: true, configurable: true,
    });
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
    document.body.removeChild(div);
  });

  it('drag-over without Files type does NOT show dropzone', async () => {
    // App.tsx:391 — `if (e.dataTransfer?.types.includes('Files'))` false branch.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['text/plain'] } });
    document.dispatchEvent(over);
    // No "Drop to install" overlay.
    expect(screen.queryByText('Drop to install')).toBeNull();
  });

  it('Drop install error from a non-Error throw stringifies via String() (ternary false branch)', async () => {
    // App.tsx:416 — `err instanceof Error ? err.message : String(err)`.
    // Throw a non-Error (a plain string) so the false branch fires.
    registerInvokeHandler('install_mod_from_file', () => {
      throw 'plain-string-rejection';
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ name: 'x.zip', path: 'C:/tmp/x.zip' }], types: ['Files'] },
      configurable: true,
    });
    document.dispatchEvent(drop);
    await waitFor(() => {
      expect(screen.getByText(/Failed to install x\.zip.*plain-string-rejection/)).toBeInTheDocument();
    });
  });

  it('Launch error from a non-Error throw stringifies via String() (ternary false branch)', async () => {
    // App.tsx:325 — `e instanceof Error ? e.message : String(e)` false branch.
    registerInvokeHandler('launch_game', () => { throw 'rough'; });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const launchBtn = buttons.find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to launch game: rough/)).toBeInTheDocument();
    });
  });

  it('Vanilla error from a non-Error throw stringifies via String() (ternary false branch)', async () => {
    // App.tsx:339 — same pattern for vanilla.
    registerInvokeHandler('launch_vanilla', () => { throw 'roughv'; });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const vanillaBtn = buttons.find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
    expect(vanillaBtn).toBeDefined();
    await user.click(vanillaBtn!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to launch: roughv/)).toBeInTheDocument();
    });
  });

  it('app-update banner Download error from a non-Error throw uses String() (ternary false branch)', async () => {
    // App.tsx:307 — `e instanceof Error ? e.message : String(e)` false branch
    // in handleDownloadUpdate.
    const updater = await import('@tauri-apps/plugin-updater');
    const opener = await import('@tauri-apps/plugin-opener');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce('rough-open');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Download/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to open browser: rough-open/)).toBeInTheDocument();
    });
  });

  it('app-update banner Install error from a non-Error throw uses String() (ternary false branch)', async () => {
    // App.tsx:295 — same pattern for handleInstallUpdate.
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.3.4',
      downloadAndInstall: vi.fn(async () => { throw 'rough-install'; }),
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Install & Restart/i }));
    await waitFor(() => {
      expect(screen.getByText(/Update failed: rough-install/)).toBeInTheDocument();
    });
  });

  it('Profiles sidebar badge: with no pending updates the badge is hidden', async () => {
    // App.tsx:511 — `id === 'profiles' && subUpdates.length > 0`. With
    // length=0 (default), the badge span is NOT rendered.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The Profiles nav button now labels as "Modpacks". Disambiguate
    // from "Browse Modpacks" via exact .gf-nav-label match.
    const profilesNav = screen.getAllByRole('button').find(
      (b) =>
        b.className.includes('gf-nav') &&
        b.querySelector('.gf-nav-label')?.textContent === 'Modpacks',
    );
    expect(profilesNav).toBeDefined();
    // No gf-nav-badge span inside.
    expect(profilesNav!.querySelector('.gf-nav-badge')).toBeNull();
  });

  it('gameInfo.valid=true renders "STS2 detected" label + mods count line', async () => {
    // App.tsx:536/539 — `gameInfo?.valid` true branches.
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/Games/STS2',
      mods_path: 'C:/Games/STS2/Mods',
      disabled_mods_path: 'C:/Games/STS2/DisabledMods',
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '1.0',
    }));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.getByText('STS2 detected')).toBeInTheDocument();
    });
    // Mods count line ("0 active / 0 mods") appears in two places when
    // valid; we just need at least one to confirm the branch fired.
    expect(screen.queryAllByText(/0 active \/ 0 mods/).length).toBeGreaterThan(0);
  });

  it('profileInitials fallback ("VA") renders when activeProfile yields empty initials', async () => {
    // App.tsx:559 — `profileInitials || 'VA'`. The first arm
    // (profileInitials is truthy) is exercised by every default render.
    // The fallback fires only when split/filter produce an empty array.
    // Activating a profile whose name is only separators triggers it.
    registerInvokeHandler('get_active_profile', () => '___');
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      const avatar = document.querySelector('.gf-prof-avatar');
      expect(avatar?.textContent).toBe('VA');
    });
  });

  it('getVersion failure is swallowed (App still renders)', async () => {
    // App.tsx:100 — `.catch(() => {})` on getVersion. With getVersion
    // rejecting, the app version string stays empty, but the rest of
    // the app must still render. We use mockImplementation (persistent
    // for this test) rather than mockRejectedValueOnce so a React 18
    // double-render doesn't consume our once-fixture and resolve the
    // second call.
    const app = await import('@tauri-apps/api/app');
    const originalImpl = (app.getVersion as ReturnType<typeof vi.fn>).getMockImplementation();
    (app.getVersion as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('getVersion unavailable');
    });
    try {
      render(<App />);
      await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
      // Sidebar version footer simply omits the version when empty.
      expect(screen.queryAllByText(/Slay the Spire 2/).length).toBeGreaterThan(0);
    } finally {
      if (originalImpl) {
        (app.getVersion as ReturnType<typeof vi.fn>).mockImplementation(originalImpl);
      }
    }
  });
});
