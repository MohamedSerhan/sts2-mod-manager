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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';
import { getInvokeCalls, registerInvokeHandler, setMockAppVersion } from './__test__/setup';
import { AUTO_ADD_INSTALLS_TO_MODPACK_KEY } from './lib/installPolicy';
import { ROW_MENU_OPEN_EVENT } from './lib/rowMenuConfig';
import { NAVIGATION_LAYOUT_CHANGE_EVENT, NAVIGATION_LAYOUT_STORAGE_KEY } from './display/navigationLayout';
import type { LaunchHealthReport } from './types';

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
    // key before rendering. With this default, the onboarding overlay
    // is NOT in the tree on render, so tests can deterministically skip
    // the `if (skip) await user.click(skip)` dance.
    try { localStorage.setItem('sts2mm-onboarded', 'true'); } catch {}
    try { localStorage.removeItem(NAVIGATION_LAYOUT_STORAGE_KEY); } catch {}
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

  function getTopBarLaunchButton(): HTMLButtonElement {
    const launchBtn = screen.getAllByRole('button').find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    if (!launchBtn) throw new Error('No top-bar modded launch button found');
    return launchBtn as HTMLButtonElement;
  }

  function launchHealthReport(overrides: Partial<LaunchHealthReport> = {}): LaunchHealthReport {
    return {
      active_profile_id: null,
      active_profile_name: null,
      current_game_version: null,
      last_launch_game_version: null,
      profile_game_version: null,
      game_version_changed_since_last_launch: false,
      profile_game_version_changed: false,
      known_incompatible_mods: [],
      dependency_blocked_mods: [],
      previous_failed_mods: [],
      ...overrides,
    };
  }

  it('renders the four primary nav items (1.7.0 IA collapse)', async () => {
    // 1.7.0 — sidebar shrunk from 7 items to 4. Browse Mods became a
    // tab inside Library; Browse Modpacks became a tab inside Modpacks;
    // Help moved to the topbar `?` icon (HelpDrawer) + Settings → Help
    // tab. The primary nav now reads Home / Modpacks / Library / Settings.
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
    expect(getNavButton('Home')).toBeInTheDocument();
    expect(getNavButton('Modpacks')).toBeInTheDocument();
    expect(getNavButton('Mod Library')).toBeInTheDocument();
    expect(getNavButton('Settings')).toBeInTheDocument();
    // Browse Mods / Browse Modpacks / Help should NOT be primary nav
    // buttons any more. Use queryAllByRole + filter to assert absence
    // without throwing for the missing names.
    const sidebarNavs = screen.getAllByRole('button').filter((b) =>
      b.className.includes('gf-nav'),
    );
    const labels = sidebarNavs.map((b) => b.textContent?.trim() ?? '');
    expect(labels).not.toContain('Browse Mods');
    expect(labels).not.toContain('Browse Modpacks');
    // "Help" can appear on the topbar `?` button (aria-label) but
    // must not appear as a primary nav entry.
    expect(labels.find((l) => /^Help$/.test(l))).toBeUndefined();
    // Topbar `?` icon — open the drawer.
    expect(screen.getByRole('button', { name: /^Help$/i })).toBeInTheDocument();
  });

  it('uses Khalid topbar navigation by default and can render the saved left sidebar setting', async () => {
    const first = render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });

    expect(document.querySelector('.gf-sidebar')).toBeNull();
    let nav = document.querySelector('.gf-topnav');
    expect(nav).not.toBeNull();
    let labels = Array.from(nav!.querySelectorAll('.gf-nav-label'))
      .map((el) => el.textContent?.trim() ?? '');
    expect(labels).toEqual(['Home', 'Modpacks', 'Mod Library', 'Settings']);

    first.unmount();
    localStorage.setItem(NAVIGATION_LAYOUT_STORAGE_KEY, 'sidebar');
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });

    expect(document.querySelector('.gf-sidebar')).not.toBeNull();
    nav = document.querySelector('.gf-sidebar');
    labels = Array.from(nav!.querySelectorAll('.gf-nav-label'))
      .map((el) => el.textContent?.trim() ?? '');
    expect(labels).toEqual(['Home', 'Modpacks', 'Mod Library', 'Settings']);
  });

  it('reacts to runtime navigation layout changes from Settings', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
    expect(document.querySelector('.gf-topnav')).not.toBeNull();
    expect(document.querySelector('.gf-sidebar')).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(NAVIGATION_LAYOUT_CHANGE_EVENT, {
        detail: { value: 'sidebar' },
      }));
    });
    await waitFor(() => {
      expect(document.querySelector('.gf-sidebar')).not.toBeNull();
    });

    localStorage.setItem(NAVIGATION_LAYOUT_STORAGE_KEY, 'topbar');
    act(() => {
      window.dispatchEvent(new CustomEvent(NAVIGATION_LAYOUT_CHANGE_EVENT, {
        detail: { value: 'not-a-real-layout' },
      }));
    });
    await waitFor(() => {
      expect(document.querySelector('.gf-topnav')).not.toBeNull();
    });
  });

  it('clicking Library nav swaps the body to the Library (Installed) view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Sidebar item renamed Mods → Library in 1.7.0; default tab is
    // Installed, which shows the existing "All installed mods" page.
    await user.click(getNavButton('Mod Library'));
    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
  });

  it('Mods tab Manage-active-modpack link opens the active modpack detail view', async () => {
    // T16 + review fix — the toolbar "Mod Library" button was removed
    // (its label described the now-dead cross-profile workspace). The
    // page header retains a clearer "Manage active modpack →" link
    // wired to the same handler; clicking it lands on the active
    // modpack's detail view (where its mod editor lives).
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
    registerInvokeHandler('get_active_profile', () => 'Stable');
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
    await user.click(getNavButton('Mod Library'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });

    // Click the page-header "Manage active modpack →" link — this
    // is the only bridge into the modpack detail view from the Mods
    // page (the toolbar duplicate was removed in the T16 review fix).
    const link = await screen.findByRole('button', { name: /manage active modpack/i });
    await user.click(link);

    // Land directly on the active modpack's detail view: H2 with the
    // modpack name + Back-to-list button.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Stable' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    // BaseLib isn't in this pack, so it lives in the (collapsed-by-default)
    // "Add from your Library" section. Expand it to confirm the mod is
    // reachable from the detail view.
    const available = await screen.findByTestId('modpack-detail-available');
    await user.click(
      within(available).getByRole('button', { name: /Add from Mod Library/i }),
    );
    expect((await within(available).findAllByText('BaseLib')).length).toBeGreaterThan(0);
  }, 10000);

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

  it('Library → Browse tab shows the public mod browser', async () => {
    // 1.7.0 — Browse Mods is no longer its own sidebar entry. It now
    // lives as a tab inside the Library view. Navigate Library → click
    // the Browse tab → assert the GitHub sub-tab button is present.
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Mod Library'));
    await user.click(screen.getByRole('button', { name: /^Browse /i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
  });

  it('Modpacks → Browse tab shows the public modpack browser', async () => {
    // 1.7.0 — Browse Modpacks is now a tab inside Modpacks, not a
    // top-level sidebar entry.
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Modpacks'));
    await user.click(screen.getByRole('button', { name: /^Browse /i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
  });

  it('Browse Modpacks empty-state CTA returns user to the Yours tab', async () => {
    // Before 1.7.0 the BrowseModpacks empty-state button routed to
    // the standalone Profiles view. Now it stays inside Modpacks and
    // flips the outer tab back to Yours — same intent, no nav round
    // trip.
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
    await user.click(getNavButton('Modpacks'));
    await user.click(screen.getByRole('button', { name: /^Browse /i }));

    await user.click(await screen.findByRole('button', { name: /Go to Modpacks/i }));

    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  it('clicking Modpacks swaps to the Modpacks view', async () => {
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
    await user.click(getNavButton('Mod Library'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
    await user.click(getNavButton('Home'));
    // 1.7 v7 — Home is the single-block launcher. With no active modpack
    // the empty-state hero shows the "Pick a modpack to play" title.
    // (The old share-code placeholder lives on the Modpacks toolbar now.)
    await waitFor(() => {
      expect(screen.getByText(/Pick a modpack to play/i)).toBeInTheDocument();
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

  it('Launch opens the health modal and does not launch when failed active mods are reported', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      active_profile_name: 'TesterW',
      current_game_version: '0.105.0',
      last_launch_game_version: '0.104.0',
      game_version_changed_since_last_launch: true,
      previous_failed_mods: [{
        name: 'CardsAndRelicsChooser',
        display_name: 'Cards and Relics Chooser',
        version: '1.2.3',
        folder_name: 'CardsAndRelicsChooser',
        mod_id: null,
        reasons: ['assembly_init'],
      }],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());

    expect(await screen.findByText('Review 1 mod that failed last launch')).toBeInTheDocument();
    expect(screen.getByText('Cards and Relics Chooser')).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Launch shows missing dependencies and does not launch when active mods are dependency-blocked', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      dependency_blocked_mods: [{
        name: 'Miyu_character',
        display_name: 'Miyu Character',
        version: '1.0.0',
        folder_name: 'Miyu_character',
        mod_id: 'Miyu_character',
        missing_dependencies: ['STS2-RitsuLib'],
      }],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());

    expect(await screen.findByText('Review 1 mod with missing dependencies')).toBeInTheDocument();
    expect(screen.getByText('Missing dependencies')).toBeInTheDocument();
    expect(screen.getByText('Miyu Character')).toBeInTheDocument();
    expect(screen.getByText('missing STS2-RitsuLib')).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Store blocked mods and launch resolves blockers, refreshes, rechecks, then launches', async () => {
    let healthChecks = 0;
    registerInvokeHandler('get_launch_health', () => {
      healthChecks += 1;
      return launchHealthReport(healthChecks === 1 ? {
        previous_failed_mods: [{
          name: 'BrokenMod',
          display_name: 'Broken Mod',
          version: '2.0.0',
          folder_name: 'BrokenMod',
          mod_id: 'broken.mod',
          reasons: ['reflection_type_load'],
        }],
      } : {});
    });
    registerInvokeHandler('resolve_launch_health_blockers', () => ({
      active_profile_id: 'profile-1',
      moved: [{ name: 'BrokenMod', folder_name: 'BrokenMod', mod_id: 'broken.mod', destination: 'mods_disabled/BrokenMod' }],
      disabled_profile_entries: [{ name: 'BrokenMod', folder_name: 'BrokenMod', mod_id: 'broken.mod', destination: null }],
      failed: [],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Store blocked mods and launch/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'resolve_launch_health_blockers')).toBe(true);
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
    expect(healthChecks).toBeGreaterThanOrEqual(2);
  });

  it('Store blocked mods keeps the modal open and does not launch if blockers remain after recovery', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      dependency_blocked_mods: [{
        name: 'Miyu_character',
        display_name: 'Miyu Character',
        version: '1.0.0',
        folder_name: 'Miyu_character',
        mod_id: 'Miyu_character',
        missing_dependencies: ['STS2-RitsuLib'],
      }],
    }));
    registerInvokeHandler('resolve_launch_health_blockers', () => ({
      active_profile_id: 'profile-1',
      moved: [],
      disabled_profile_entries: [],
      failed: [],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Store blocked mods and launch/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'resolve_launch_health_blockers')).toBe(true);
    });
    expect(screen.getByText('Miyu Character')).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Launch anyway bypasses a launch-health warning', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      active_profile_name: 'TesterW',
      current_game_version: '0.105.0',
      last_launch_game_version: '0.104.0',
      game_version_changed_since_last_launch: true,
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Launch anyway/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
  });

  it('Launch health treats omitted blocker arrays as empty compatibility payloads', async () => {
    registerInvokeHandler('get_launch_health', () => ({
      ...launchHealthReport({
        active_profile_name: 'TesterW',
        current_game_version: '0.105.0',
        profile_game_version: '0.104.0',
        profile_game_version_changed: true,
      }),
      previous_failed_mods: undefined,
      known_incompatible_mods: undefined,
      dependency_blocked_mods: undefined,
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());

    expect(await screen.findByRole('dialog', { name: /STS2 changed since this pack last launched/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Store blocked mods and launch/i })).toBeNull();
  });

  it('Launch health Review in Library dismisses the modal and routes to the Library', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      previous_failed_mods: [{
        name: 'BrokenMod',
        display_name: null,
        version: '2.0.0',
        folder_name: 'BrokenMod',
        mod_id: 'broken.mod',
        reasons: ['reflection_type_load'],
      }],
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Review in Library/i }));

    await waitFor(() => {
      expect(screen.getByText(/All installed mods/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Review 1 mod that failed last launch/i)).not.toBeInTheDocument();
  });

  it('Launch health Cancel dismisses the modal without launching', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      known_incompatible_mods: [{
        name: 'FutureMod',
        display_name: null,
        version: '1.0.0',
        folder_name: 'FutureMod',
        mod_id: null,
        min_game_version: '0.200.0',
      }],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    expect(await screen.findByText(/Review 1 mod that needs a newer STS2 build/i)).toBeInTheDocument();
    const cancelButton = screen
      .getAllByRole('button', { name: /^Cancel$/i })
      .find((button) => button.textContent?.trim() === 'Cancel');
    expect(cancelButton).toBeDefined();
    await user.click(cancelButton!);

    await waitFor(() => {
      expect(screen.queryByText(/Review 1 mod that needs a newer STS2 build/i)).not.toBeInTheDocument();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Store blocked mods reports partial recovery failures and keeps the updated modal open', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      dependency_blocked_mods: [{
        name: 'StillBroken',
        display_name: null,
        version: '1.0.0',
        folder_name: 'StillBroken',
        mod_id: 'StillBroken',
        missing_dependencies: ['BaseLib'],
      }],
    }));
    registerInvokeHandler('resolve_launch_health_blockers', () => ({
      active_profile_id: 'profile-1',
      moved: [{ name: 'OldBroken', folder_name: 'OldBroken', mod_id: 'OldBroken', destination: 'mods_disabled/OldBroken' }],
      disabled_profile_entries: [],
      failed: [{ name: 'StillBroken', folder_name: 'StillBroken', mod_id: 'StillBroken', error: 'locked' }],
    }));
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Store blocked mods and launch/i }));

    expect(await screen.findByText(/Some blocked mods could not be stored: StillBroken/i)).toBeInTheDocument();
    expect(screen.getByText('StillBroken')).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Store blocked mods surfaces resolver failures without closing the modal', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      previous_failed_mods: [{
        name: 'BrokenMod',
        display_name: null,
        version: '2.0.0',
        folder_name: 'BrokenMod',
        mod_id: 'broken.mod',
        reasons: ['reflection_type_load'],
      }],
    }));
    registerInvokeHandler('resolve_launch_health_blockers', () => {
      throw new Error('disk locked');
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());
    await user.click(await screen.findByRole('button', { name: /Store blocked mods and launch/i }));

    expect(await screen.findByText(/Couldn't store blocked mods: disk locked/i)).toBeInTheDocument();
    expect(screen.getByText('BrokenMod')).toBeInTheDocument();
  });

  it('Launch falls back to launching when the health check itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerInvokeHandler('get_launch_health', () => {
      throw new Error('health unavailable');
    });
    registerInvokeHandler('launch_game', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(true);
    });
    warn.mockRestore();
  });

  it('Launch health previews long blocker lists and shows hidden counts', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      active_profile_name: 'Big Pack',
      current_game_version: '0.105.0',
      profile_game_version: '0.104.0',
      profile_game_version_changed: true,
      dependency_blocked_mods: Array.from({ length: 9 }, (_, index) => ({
        name: `Blocked${index + 1}`,
        display_name: index === 0 ? 'Display Blocked 1' : null,
        version: '1.0.0',
        folder_name: `Blocked${index + 1}`,
        mod_id: `Blocked${index + 1}`,
        missing_dependencies: ['BaseLib', 'RitsuLib'],
      })),
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(getTopBarLaunchButton());

    expect(await screen.findByText(/Review 9 mods with missing dependencies/i)).toBeInTheDocument();
    expect(screen.getByText('Display Blocked 1')).toBeInTheDocument();
    expect(screen.queryByText('Blocked9')).not.toBeInTheDocument();
    expect(screen.getByText('+1 more')).toBeInTheDocument();
    expect(screen.getByText(/Big Pack was last used with a different STS2 build/i)).toBeInTheDocument();
    expect(screen.getAllByText(/missing BaseLib, RitsuLib/i).length).toBeGreaterThan(0);
  });

  it('Ctrl+L uses launch health before modded launch', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      known_incompatible_mods: [{
        name: 'FutureMod',
        display_name: 'Future Mod',
        version: '1.0.0',
        folder_name: 'FutureMod',
        mod_id: null,
        min_game_version: '0.200.0',
      }],
    }));
    registerInvokeHandler('launch_game', () => true);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));

    expect(await screen.findByText('Review 1 mod that needs a newer STS2 build')).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Vanilla launch bypasses launch health', async () => {
    registerInvokeHandler('get_launch_health', () => launchHealthReport({
      game_version_changed_since_last_launch: true,
    }));
    registerInvokeHandler('launch_vanilla', () => true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const vanillaBtn = screen.getAllByRole('button').find((b) => /Vanilla.*no mods/i.test(b.textContent ?? ''));
    expect(vanillaBtn).toBeDefined();

    await user.click(vanillaBtn!);

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'launch_vanilla')).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'get_launch_health')).toBe(false);
  });

  it('top-bar modded launch records the active modpack by stable id', async () => {
    registerInvokeHandler('get_active_profile', () => 'Stable');
    registerInvokeHandler('get_active_profile_id', () => 'profile-stable');
    registerInvokeHandler('list_profiles_cmd', () => [{
      id: 'profile-stable',
      name: 'Stable',
      mods: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      created_by: null,
      game_version: null,
    }]);
    registerInvokeHandler('launch_game', () => true);
    localStorage.setItem('sts2mm-modpack-launches', JSON.stringify({ Stable: 1000 }));

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Stable').length).toBeGreaterThan(0);
    });

    const launchBtn = screen.getAllByRole('button').find(
      (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
    );
    expect(launchBtn).toBeDefined();
    await user.click(launchBtn!);

    await waitFor(() => {
      const map = JSON.parse(localStorage.getItem('sts2mm-modpack-launches') ?? '{}');
      expect(map['profile-stable']).toBeGreaterThan(1000);
      expect(map.Stable).toBeUndefined();
    });
  });

  it('shows the active modpack display name instead of its UUID in the app chrome and Home hero', async () => {
    const uuid = '731aeaec-7f3d-4859-baec-16219701e2e7';
    registerInvokeHandler('get_active_profile', () => uuid);
    registerInvokeHandler('get_active_profile_id', () => uuid);
    registerInvokeHandler('list_profiles_cmd', () => [{
      id: uuid,
      name: 'TesterW',
      mods: [{ name: 'BaseLib', enabled: true }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      created_by: null,
      game_version: null,
    }]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('TesterW').length).toBeGreaterThan(0);
    });
    expect(document.body.textContent).not.toContain(uuid);
    await waitFor(() => {
      const launchBtn = screen.getAllByRole('button').find(
        (b) => /^Launch/.test(b.textContent?.trim() ?? '') && !/Vanilla/i.test(b.textContent ?? ''),
      );
      expect(launchBtn).toBeDefined();
      expect(launchBtn).toHaveAttribute('title', expect.stringContaining('TesterW'));
      expect(launchBtn).not.toHaveAttribute('title', expect.stringContaining(uuid));
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

  it('renders the app title in the custom titlebar', async () => {
    // The brand mark + name lives in the titlebar (the standard window
    // chrome location). The 1.7.0 cleanup removed the duplicate
    // "Slay the Spire 2 / MOD MANAGER" sidebar block.
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument();
    });
  });

  it('drag-over → drag-leave does not show dropzone after leave', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Native Tauri drag-enter shows the overlay; drag-leave must hide it.
    await fireTauriEvent('tauri://drag-enter', { paths: ['C:/x.zip'] });
    await waitFor(() => { expect(screen.getByText('Drop to install')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-leave', {});
    await waitFor(() => {
      expect(screen.queryByText('Drop to install')).toBeNull();
    });
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
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // 1.7 v7 — the share-code input moved from Home to the Modpacks
    // toolbar. Navigate there so we have a text input on screen to
    // focus.
    await user.click(getNavButton('Modpacks'));
    const input = await screen.findByLabelText(/Add a modpack by code/i) as HTMLInputElement;
    input.focus();
    // Dispatch keydown from the input target — the App's keyboard handler
    // is on `window`, so the event must bubble.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    // No launch fired since target was an INPUT.
    expect(getInvokeCalls().some((c) => c.cmd === 'launch_game')).toBe(false);
  });

  it('Drag-enter shows the drop overlay', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The overlay shows on Tauri's window-level drag-enter event.
    await fireTauriEvent('tauri://drag-enter', { paths: ['C:/x.zip'] });
    await waitFor(() => {
      expect(screen.queryByText('Drop to install')).toBeInTheDocument();
    });
  });

  it('dropping a zip while viewing a modpack installs to the Library by default', async () => {
    registerInvokeHandler('get_active_profile', () => 'Stable');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0' },
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [],
    }));
    registerInvokeHandler('install_mod_from_file', () => ({
      name: 'Dropped', version: '1.0', description: '', enabled: true, files: [],
      source: null, hash: null, dependencies: [], size_bytes: 0,
      folder_name: 'Dropped', mod_id: 'Dropped', github_url: null, nexus_url: null,
      pinned: false, min_game_version: null, author: null, tags: [],
      display_name: null, display_description: null,
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({
      name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0',
    }));

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Open the Modpacks tab, then the 'Stable' modpack detail.
    await user.click(getNavButton('Modpacks'));
    await user.click(await screen.findByRole('button', { name: /Open Stable modpack/i }));
    await screen.findByRole('heading', { level: 2, name: 'Stable' });

    // Drop a zip: the global handler installs it, but the viewed pack is
    // untouched unless the user explicitly enables auto-add in Settings.
    // Tauri hands us absolute file PATHS (not File objects); basename 'Mod.zip'.
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/downloads/Mod.zip'] });

    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/downloads/Mod.zip',
      )).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  }, 10000);

  it('dropping a zip while viewing a modpack adds to that pack when auto-add is enabled', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    registerInvokeHandler('get_active_profile', () => 'Stable');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0' },
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [],
    }));
    registerInvokeHandler('install_mod_from_file', () => ({
      name: 'Dropped', version: '1.0', description: '', enabled: true, files: [],
      source: null, hash: null, dependencies: [], size_bytes: 0,
      folder_name: 'Dropped', mod_id: 'Dropped', github_url: null, nexus_url: null,
      pinned: false, min_game_version: null, author: null, tags: [],
      display_name: null, display_description: null,
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({
      name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0',
    }));

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(getNavButton('Modpacks'));
    await user.click(await screen.findByRole('button', { name: /Open Stable modpack/i }));
    await screen.findByRole('heading', { level: 2, name: 'Stable' });

    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/downloads/Mod.zip'] });

    await waitFor(() => {
      const call = getInvokeCalls().find(
        (c) => c.cmd === 'set_profile_mod_membership' && c.args?.modName === 'Dropped',
      );
      expect(call?.args).toMatchObject({ profileId: 'Stable', included: true });
    });
  }, 10000);

  it('dropping a zip while viewing a FOLLOWED pack is blocked with a friendly message', async () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'true');
    // A followed (subscribed) pack's manifest isn't ours to edit, so dropping
    // a mod "into" it must not install (which would strand the file in the
    // library) — the global handler shows a friendly toast and stops.
    registerInvokeHandler('get_active_profile', () => 'Stable');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0' },
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [],
    }));
    registerInvokeHandler('install_mod_from_file', () => ({
      name: 'Dropped', version: '1.0', description: '', enabled: true, files: [],
      source: null, hash: null, dependencies: [], size_bytes: 0,
      folder_name: 'Dropped', mod_id: 'Dropped', github_url: null, nexus_url: null,
      pinned: false, min_game_version: null, author: null, tags: [],
      display_name: null, display_description: null,
    }));
    registerInvokeHandler('set_profile_mod_membership', () => ({
      name: 'Stable', mods: [], created_at: '2026-01-01T00:00:00Z', created_by: null, game_version: '0.105.0',
    }));
    // Mark 'Stable' as a followed pack so the drop guard fires.
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'x/AAAA', profile_name: 'Stable' },
    ]);

    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Open the Modpacks tab, then the 'Stable' modpack detail.
    await user.click(getNavButton('Modpacks'));
    await user.click(await screen.findByRole('button', { name: /Open Stable modpack/i }));
    await screen.findByRole('heading', { level: 2, name: 'Stable' });

    // Drop a zip — the followed-pack guard blocks the install and explains.
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/downloads/Mod.zip'] });

    // The friendly toast appears…
    expect(await screen.findByText(/followed modpack/i)).toBeInTheDocument();
    // …and nothing was installed.
    expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(false);
  }, 10000);

  it('dropping supported archives when NOT viewing a modpack just installs them (no membership change)', async () => {
    registerInvokeHandler('install_mod_from_file', (args) => ({
      name: (args?.path as string | undefined)?.includes('rar') ? 'LooseRar' : (args?.path as string | undefined)?.includes('7z') ? 'Loose7z' : 'LooseMod',
      version: '1.0', description: '', enabled: true, files: [],
      source: null, hash: null, dependencies: [], size_bytes: 0,
      folder_name: 'LooseMod', mod_id: 'LooseMod', github_url: null, nexus_url: null,
      pinned: false, min_game_version: null, author: null, tags: [],
      display_name: null, display_description: null,
    }));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // On Home (no modpack open) — drop a zip via Tauri's native event.
    await fireTauriEvent('tauri://drag-drop', {
      paths: ['C:/loose.zip', 'C:/loose.7z', 'C:/loose.rar', 'C:/notes.txt'],
    });

    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/loose.zip',
      )).toBe(true);
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/loose.7z',
      )).toBe(true);
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/loose.rar',
      )).toBe(true);
    });
    expect(screen.getByText(/Unsupported file: notes.txt/i)).toBeInTheDocument();
    // No pack is being viewed, so it must not touch membership.
    expect(getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership')).toBe(false);
  });

  it('Drag-leave hides the drop overlay', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-enter', { paths: ['C:/x.zip'] });
    await waitFor(() => { expect(screen.getByText('Drop to install')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-leave', {});
    await waitFor(() => {
      expect(screen.queryByText('Drop to install')).toBeNull();
    });
  });

  it('HelpDrawer close button closes the drawer (covers App.tsx onClose wiring)', async () => {
    // After opening the drawer via the topbar `?` icon, the close
    // button inside the drawer must fire setShowHelpDrawer(false) — the
    // arrow declared inline at App.tsx:912.
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /^Help$/i }));
    const drawer = await screen.findByRole('dialog', { name: /^Help$/i });
    expect(drawer).toBeInTheDocument();
    // The HelpDrawer's close button has aria-label "Close" (lives
    // inside the drawer head). Click it.
    const closeBtn = within(drawer).getByRole('button', { name: /^Close$/i });
    await user.click(closeBtn);
    // Drawer leaves the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /^Help$/i })).toBeNull();
    });
  });

  it('topbar ? icon opens the HelpDrawer (1.7.0: Help left the sidebar)', async () => {
    // 1.7.0 — Help is no longer a sidebar entry. Clicking the topbar
    // `?` icon opens a slide-out drawer that renders the same
    // <HelpContent /> the Settings → Help tab uses. The drawer is a
    // role=dialog aria-label="Help".
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Drawer should not be open initially.
    expect(screen.queryByRole('dialog', { name: /^Help$/i })).not.toBeInTheDocument();
    // Topbar `?` button is labeled "Help" via aria-label.
    const helpBtn = screen.getByRole('button', { name: /^Help$/i });
    await user.click(helpBtn);
    // Drawer opens with the heading + FAQ content.
    expect(await screen.findByRole('dialog', { name: /^Help$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /what is a modpack/i }),
    ).toBeInTheDocument();
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
      // No game is detected in tests, so the dismiss button reads "Set up later".
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeInTheDocument();
    });
  });

  it('Onboarding overlay can be dismissed via Set up later (no game detected)', async () => {
    localStorage.removeItem('sts2mm-onboarded');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Set up later/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeNull();
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
    // Tauri drag-drop hands us an absolute path string.
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/super.zip'] });
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'install_mod_from_file' && c.args?.path === 'C:/super.zip',
      )).toBe(true);
    });
  });

  it('Drop event with a non-zip file shows an error toast', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/readme.txt'] });
    await waitFor(() => {
      expect(screen.queryByText(/Unsupported file/)).toBeInTheDocument();
    });
    // Unsupported extension is skipped before any install attempt.
    expect(getInvokeCalls().some((c) => c.cmd === 'install_mod_from_file')).toBe(false);
  });

  it('Modpacks nav badge appears when there are pending pack updates', async () => {
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

  it('mod-auto-installed event with replaced shows saved-version toast', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'SuperMod v2',
      file_name: 'super2.zip',
      replaced: 'SuperMod v1',
    });
    await waitFor(() => {
      expect(screen.getByText(/Saved "SuperMod v2" from super2\.zip in Versions\. "SuperMod v1" stays active\./)).toBeInTheDocument();
    });
  });

  it('mod-auto-installed event with incompatible game version shows warning instead of success', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'Stats the Spire',
      file_name: 'stats.zip',
      replaced: null,
      incompatible: {
        min_game_version: '0.110.0',
        user_game_version: '0.105.0',
      },
    });
    await waitFor(() => {
      expect(screen.getByText(/Stats the Spire.*needs game v0\.110\.0.*you have v0\.105\.0/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/auto-installed from stats\.zip/i)).toBeNull();
  });

  it('mod-auto-installed event with incompatible promoted update warns with a game-version fallback', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'Stats the Spire v0.16.2',
      file_name: 'stats.zip',
      replaced: 'Stats the Spire v0.105.0',
      incompatible: {
        min_game_version: '0.110.0',
        user_game_version: '',
      },
    });
    await waitFor(() => {
      expect(screen.getByText(/Stats the Spire v0\.16\.2.*needs game v0\.110\.0.*you have v\?/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Saved "Stats the Spire v0\.16\.2" from stats\.zip in Versions/i)).toBeNull();
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

  it('mod-auto-installed event with preserved_configs fires the preserved-configs toast inline', async () => {
    // The watcher path inlines the preserved-configs list onto the
    // auto-installed event so it doesn't need a separate event round-
    // trip. Three files exercises the "shown list + and N more" path
    // when count > 3, but here we use 2 to exercise the
    // formatPreservedConfigsMessage `n <= 3` branch (no tail).
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'ConfigKeeper',
      file_name: 'ck.zip',
      replaced: null,
      preserved_configs: ['settings.json', 'keymap.json'],
    });
    await waitFor(() => {
      // Two i18n keys: app.toast.autoInstalled + app.toast.preservedConfigs.
      // The second emits a separate toast with the mod name + file list.
      expect(screen.getByText(/Preserved.*settings\.json.*keymap\.json/i)).toBeInTheDocument();
    });
  });

  it('mod-auto-installed event with 5 preserved_configs shows the "and N more" tail', async () => {
    // Exercises formatPreservedConfigsMessage when n > 3 — the file
    // list shows the first three names and appends a tail with the
    // remaining count.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-auto-installed', {
      mod_name: 'BigConfig',
      file_name: 'big.zip',
      replaced: null,
      preserved_configs: ['a.json', 'b.json', 'c.json', 'd.json', 'e.json'],
    });
    await waitFor(() => {
      // Tail formats as "(and 2 more)" or similar i18n string.
      expect(screen.getByText(/and 2 more/i)).toBeInTheDocument();
    });
  });

  it('mod-configs-preserved event fires the preserved-configs toast', async () => {
    // Standalone event for update_mod / repair_mod paths — separate
    // from the watcher's inlined preserved_configs field.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-configs-preserved', {
      mod_name: 'UpdatedMod',
      files: ['settings.json'],
    });
    await waitFor(() => {
      expect(screen.getByText(/Preserved.*settings\.json/i)).toBeInTheDocument();
    });
  });

  it('mod-configs-lost event fires a warning toast naming the lost configs', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-configs-lost', {
      mod_name: 'UpdatedMod',
      files: ['settings.json', 'keymap.json'],
    });
    await waitFor(() => {
      expect(screen.getByText(/re-apply.*settings\.json/i)).toBeInTheDocument();
    });
  });

  it('mod-configs-lost with empty files array fires no toast (early return)', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-configs-lost', { mod_name: 'NoLossMod', files: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/re-apply/i)).toBeNull();
  });

  it('mod-configs-preserved with empty files array fires no toast (early return)', async () => {
    // Defensive early return in the handler — files.length === 0 means
    // there's nothing to surface. Exercise the guard so the early-exit
    // branch is covered.
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('mod-configs-preserved', {
      mod_name: 'NoConfigsMod',
      files: [],
    });
    // No "Preserved" toast for this mod.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Preserved.*NoConfigsMod/i)).toBeNull();
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
    await user.click(getNavButton('Mod Library'));
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

  it('ProfileSwitcher "Add pack" focuses the Modpacks Quick-Add input (full pipeline)', async () => {
    // The companion test above asserts the view-routing half of the
    // wiring. This one closes the focus-pipeline gap flagged in the
    // 1.7.0 Task 15 review: App.tsx bumps `focusModpacksCodeBarSignal`
    // → ProfilesView's effect calls `input.focus()` inside
    // `requestAnimationFrame`. The Profiles unit suite covers the
    // signal-in-isolation case (Profiles.test.tsx: "focusQuickAddSignal
    // bump focuses the toolbar input"); this end-to-end test verifies
    // the App shell actually wires the callback through.
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Start on Library so the switch to Modpacks is observable.
    await user.click(getNavButton('Mod Library'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
    const chip = document.querySelector('button.gf-prof') as HTMLButtonElement | null;
    expect(chip).toBeTruthy();
    await user.click(chip!);
    const addBtn = await screen.findByRole('button', { name: /Add modpack/i });
    await user.click(addBtn);
    // The focus is applied inside `requestAnimationFrame` (Profiles.tsx
    // useEffect), so use waitFor to give the rAF callback time to fire.
    const input = await screen.findByLabelText(/Add a modpack by code/i);
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('ProfileSwitcher "Manage all" routes to the Modpacks view', async () => {
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
    expect(screen.getByText(/Windows Defender may warn on this unsigned installer/)).toBeInTheDocument();
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

  it('app-update banner Install & Restart invokes backend install + relaunch', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    const proc = await import('@tauri-apps/plugin-process');
    const downloadAndInstall = vi.fn(async () => {});
    registerInvokeHandler('install_app_update', () => null);
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
      expect(getInvokeCalls().some((c) => c.cmd === 'install_app_update')).toBe(true);
      expect(proc.relaunch).toHaveBeenCalled();
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    // Success toast from the install path.
    expect(screen.getByText(/Update installed\. Restarting/)).toBeInTheDocument();
  });

  it('app-update banner Install & Restart surfaces error toast on failure', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    registerInvokeHandler('install_app_update', () => { throw new Error('disk full'); });
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

  it('app-update banner is suppressed on a dev build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.6.1-dev.pr59.g837f5ba',
      downloadAndInstall: vi.fn(async () => {}),
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    expect(screen.queryByText(/Mod Manager v9\.9\.9 is available/)).not.toBeInTheDocument();
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
    const appendAnchor = (
      href: string,
      text: string,
      configure?: (anchor: HTMLAnchorElement) => void,
      preventDefault = false,
    ) => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      anchor.textContent = text;
      if (preventDefault) {
        anchor.addEventListener('click', (event) => event.preventDefault());
      }
      configure?.(anchor);
      root.appendChild(anchor);
      return anchor;
    };

    const preventedAnchor = appendAnchor('https://example.test/prevented', 'prevented');
    const preventedEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    preventedEvent.preventDefault();
    preventedAnchor.dispatchEvent(preventedEvent);
    fireEvent.click(appendAnchor('https://example.test/modified', 'modified'), { ctrlKey: true });
    fireEvent.click(appendAnchor('https://example.test/right-click', 'right-click'), { button: 1 });
    fireEvent.click(appendAnchor('https://example.test/download', 'download', (a) => {
      a.setAttribute('download', '');
    }));
    fireEvent.click(root);
    fireEvent.click(appendAnchor('', 'empty'));
    fireEvent.click(appendAnchor('http://[invalid', 'invalid'));
    fireEvent.click(appendAnchor('sts2mm://profile/demo', 'internal'));

    expect(openUrl).not.toHaveBeenCalled();

    fireEvent.click(appendAnchor('mailto:tester@example.com', 'mail'));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('mailto:tester@example.com');
    });
    openUrl.mockClear();

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

  it('Minimize button logs capability errors without crashing (handleTitlebarMin catch)', async () => {
    const user = userEvent.setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWindow.minimize.mockRejectedValueOnce(new Error('no capability'));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const min = screen.getByTitle('Minimize');
    await user.click(min);
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('minimize failed:', expect.any(Error));
    });
    warnSpy.mockRestore();
  });

  it('Close button logs capability errors without crashing (handleTitlebarClose catch)', async () => {
    const user = userEvent.setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockWindow.close.mockRejectedValueOnce(new Error('no capability'));
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const close = screen.getByTitle('Close');
    await user.click(close);
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('close failed:', expect.any(Error));
    });
    warnSpy.mockRestore();
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

  it('deep-link: own published share code points to the existing local modpack', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('check_subscription_updates', () => []);
    registerInvokeHandler('list_profiles_cmd', () => [
      { id: 'profile-1', name: 'Solo Pack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', (args) => (
      args?.name === 'profile-1'
        ? { code: 'AA5A-315D-61AE', owner: 'alice', out_of_sync: false }
        : null
    ));
    registerInvokeHandler('consume_pending_deep_link', () => null);
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    await waitFor(() => {
      expect(screen.getByText(/"Solo Pack" is published by you and already exists in Mod Manager/)).toBeInTheDocument();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'fetch_shared_profile_cmd')).toBe(false);
    expect(getInvokeCalls().some((c) => c.cmd === 'install_shared_profile')).toBe(false);
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

  it('deep-link: cancelled URL can be retried after the dedupe window expires', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let fetches = 0;
    try {
      registerInvokeHandler('get_subscriptions', () => []);
      registerInvokeHandler('consume_pending_deep_link', () => null);
      registerInvokeHandler('fetch_shared_profile_cmd', () => {
        fetches += 1;
        return {
          name: 'RetryPack', mods: [{ name: 'M1' }], created_at: '2026-01-01',
        };
      });
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

      await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
      await screen.findByText(/Install this modpack/i);
      expect(fetches).toBe(1);

      const modalFoot = document.querySelector('.gf-modal-foot') as HTMLElement | null;
      expect(modalFoot).toBeTruthy();
      const cancelBtn = Array.from(modalFoot!.querySelectorAll('button')).find(
        (b) => /^Cancel$/i.test(b.textContent?.trim() ?? ''),
      ) as HTMLButtonElement | undefined;
      expect(cancelBtn).toBeDefined();
      await user.click(cancelBtn!);
      await waitFor(() => {
        expect(screen.queryByText(/Install this modpack/i)).toBeNull();
      });

      await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
      await waitFor(() => {
        expect(fetches).toBe(1);
      });

      now += 2_001;
      await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
      await waitFor(() => {
        expect(fetches).toBe(2);
      });
      expect(await screen.findByText(/Install this modpack/i)).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
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
    // Navigate to Library so we can prove the deep-link bounces us back to Home.
    await user.click(getNavButton('Mod Library'));
    await waitFor(() => { expect(screen.getByText(/All installed mods/i)).toBeInTheDocument(); });
    await fireTauriEvent('sts2mm-open-url', 'sts2mm://import/alice/AA5A-315D-61AE');
    // After route() fires, view should have switched to Home — assert
    // the empty-state hero title (1.7 v7 single-block launcher).
    await waitFor(() => {
      expect(screen.getByText(/Pick a modpack to play/i)).toBeInTheDocument();
    });
  });

  // ── Drop event misc ───────────────────────────────────────────────
  it('Drop event with install_mod_from_file failure surfaces error toast', async () => {
    registerInvokeHandler('install_mod_from_file', () => {
      throw new Error('extract failed');
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/bad.zip'] });
    await waitFor(() => {
      expect(screen.getByText(/Failed to install bad\.zip.*extract failed/)).toBeInTheDocument();
    });
  });

  it('Drop event with no files is a no-op', async () => {
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-drop', { paths: [] });
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

  // (Removed: the Hero "Manage mods" button was deleted in the 1.7
  // launcher-first redesign — the hero now centers on Play with only
  // Switch / Sync / Share / Repair as secondary actions. The sidebar
  // "Mods" nav covers `setActiveView('mods')` already, and that wiring
  // is exercised by every test below that calls getNavButton('Mods').)

  it("Topbar profile chip opens the ProfileSwitcher", async () => {
    // 1.7.0 cleanup: the Home hero's "Switch modpack" button was a
    // duplicate of the always-visible topbar profile chip. Both
    // opened the same ProfileSwitcher popover; the chip is the
    // canonical place because it's visible from every view.
    registerInvokeHandler('get_active_profile', () => 'CurrentPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'CurrentPack', mods: [], created_at: '2026-01-01' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const profileChip = await screen.findByTitle(/Switch modpack/i);
    await user.click(profileChip);
    // ProfileSwitcher's "Add modpack" foot button is the unambiguous
    // signal the popover mounted.
    await screen.findByRole('button', { name: /Add modpack/i });
  });

  it("Library → Browse tab 'Open Settings' button (Nexus key missing) routes to Settings", async () => {
    // Force nexus_get_trending to reject with the special "Nexus API
    // key not set" sentinel so Browse renders its "Open Settings"
    // deep-link button. The Browse view's onGoToSettings prop is now
    // forwarded from ModsView (which itself receives it from App).
    registerInvokeHandler('nexus_get_trending', () => {
      throw new Error('Nexus API key not set');
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // 1.7.0: Browse Mods is a tab inside Library, not its own sidebar entry.
    await user.click(getNavButton('Mod Library'));
    await user.click(screen.getByRole('button', { name: /^Browse /i }));
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

  it('Onboarding player-path "Got it" CTA routes to Home (covers App.tsx onGoToHome arrow)', async () => {
    // The player-path branch ends on a "Got it" CTA which calls
    // finishPlayer → onGoToHome. App.tsx wires that to dismissOnboarding
    // + setActiveView('home') so the user lands on the Play surface.
    registerInvokeHandler('detect_game_path', () => ({
      game_path: 'C:/STS2',
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    localStorage.removeItem('sts2mm-onboarded');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeInTheDocument();
    });
    // Step 1 — detect game.
    await user.click(await screen.findByRole('button', { name: /Try again/i }));
    const continueBtn = await screen.findByRole('button', { name: /^Continue$/i });
    await waitFor(() => expect(continueBtn).not.toBeDisabled());
    await user.click(continueBtn);
    // Audience step — pick the player path.
    await user.click(await screen.findByRole('button', { name: /Play modpacks others made/i }));
    // Player card 1 → Next → player card 2.
    await user.click(await screen.findByRole('button', { name: /^Next$/i }));
    // Final CTA — "Got it" fires finishPlayer → onGoToHome.
    await user.click(await screen.findByRole('button', { name: /^Got it$/i }));
    // Overlay drops out and the Home view is active (its Launch button
    // is unique to Home).
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeNull();
    });
  });

  it('Onboarding creator-path "Create my first modpack" routes to Modpacks + opens Create wizard', async () => {
    // 1.7.0 T8 — branched onboarding flow. The legacy "Follow a friend"
    // choice on step 3 is gone; the new step 2 asks the audience-
    // segmentation question ("Play modpacks others made" vs "Make or
    // share modpacks") and routes to a two-card teaching path. The
    // creator path's final CTA calls onCreateModpack which bumps
    // openCreateWizardSignal so ProfilesView opens its guided wizard.
    registerInvokeHandler('detect_game_path', () => ({
      game_path: 'C:/STS2',
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    localStorage.removeItem('sts2mm-onboarded');
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeInTheDocument();
    });
    // Step 1 — game's not yet detected by default, so click Try again
    // to use the registered detect_game_path mock above.
    const tryAgain = await screen.findByRole('button', { name: /Try again/i });
    await user.click(tryAgain);
    // Now the "Continue" button is enabled.
    const continueBtn = await screen.findByRole('button', { name: /^Continue$/i });
    await waitFor(() => expect(continueBtn).not.toBeDisabled());
    await user.click(continueBtn);
    // Audience step — pick the creator path.
    const creatorBtn = await screen.findByRole('button', { name: /Make or share modpacks/i });
    await user.click(creatorBtn);
    // Creator card 1 → Next → creator card 2.
    await user.click(await screen.findByRole('button', { name: /^Next$/i }));
    // Final CTA — closes onboarding and opens the Create wizard on the
    // Modpacks page.
    await user.click(await screen.findByRole('button', { name: /Create my first modpack/i }));
    // Overlay is gone.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Skip setup/i })).toBeNull();
    });
    // CreateModpackWizard mounted — its step-1 heading is "Start" and
    // it surfaces a "Cancel" button. We use the Cancel button as the
    // unambiguous signal the wizard is present.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    });
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
    registerInvokeHandler('switch_profile', () => ({
      downloaded: 0,
      missing_mods: [],
      activated: true,
    }));
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
      expect(screen.queryByRole('button', { name: /Set up later/i })).toBeInTheDocument();
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

  it('Modpacks PublishModal "Configure later in Settings" routes to Settings', async () => {
    // Trigger flow:
    //   1. Mount with a profile that's not yet shared and github_token_set = false.
    //   2. Navigate to Modpacks, open the modpack detail, and click Share.
    //   3. PublishModal renders the inline ShareSetupPanel (replaces the
    //      old red "GitHub token required" block) with a
    //      "Configure later in Settings" escape-hatch button.
    //   4. Clicking it calls onGoToSettings which is App.tsx's inline
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
    // T16 — Share button lives in the modpack's detail view header now.
    // Click the card first to open detail, then click Share.
    await user.click(screen.getByRole('button', { name: /Open MyPack modpack/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'MyPack' })).toBeInTheDocument();
    });
    const shareBtn = screen.getAllByRole('button').find(
      (b) => /^Share$/.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(shareBtn).toBeDefined();
    await user.click(shareBtn!);
    // ShareSetupPanel renders the "Configure later in Settings" button
    // when tokenSet === false — same end behavior as the old CTA.
    const configureLaterBtn = await screen.findByRole('button', {
      name: /Configure later in Settings/i,
    });
    await user.click(configureLaterBtn);
    // App routed to Settings view.
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
  });

  it("Home's empty-state CTA routes to Modpacks (1.7 v7 single-block launcher)", async () => {
    // The 1.7 v7 Home is a single-block launcher. The "Your other packs"
    // inline section + "View all in Profiles" link were removed; their
    // replacement is the empty-state hero's "Open Modpacks" CTA which
    // calls `onGoToProfiles?.()` → setActiveView('profiles'). Verify
    // that route here.
    registerInvokeHandler('get_active_profile', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('list_profiles_cmd', () => []);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // Empty-state hero shows the "Open Modpacks" primary CTA.
    const openModpacks = await screen.findByRole('button', { name: /^Open Modpacks$/i });
    await user.click(openModpacks);
    await waitFor(() => {
      expect(screen.getByText(/All the modpacks you follow/i)).toBeInTheDocument();
    });
  });

  it("Home's empty-state Browse CTA routes to the Modpacks Browse tab", async () => {
    registerInvokeHandler('get_active_profile', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('list_profiles_cmd', () => []);
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

    await user.click(await screen.findByRole('button', { name: /^Browse modpacks$/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
  });

  it("Home's active-pack Create modpack shortcut opens the guided wizard", async () => {
    registerInvokeHandler('get_active_profile', () => 'Solo Pack');
    registerInvokeHandler('get_active_profile_id', () => 'solo-id');
    registerInvokeHandler('get_installed_mods', () => [{
      name: 'BaseLib',
      version: '1.0.0',
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
      folder_name: 'BaseLib',
      mod_id: 'BaseLib',
      github_url: null,
      nexus_url: null,
      pinned: false,
      min_game_version: null,
      author: null,
      tags: [],
      display_name: null,
      display_description: null,
    }]);
    registerInvokeHandler('list_profiles_cmd', () => [
      {
        id: 'solo-id',
        name: 'Solo Pack',
        game_version: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        mods: [],
      },
    ]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ profile_id: 'solo-id', profile_name: 'Solo Pack', editable: true }],
      mods: [],
    }));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });

    await user.click(await screen.findByRole('button', { name: /^Create modpack$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    });
  });

  it('active profile chip counts mods from the active modpack, not the whole library', async () => {
    registerInvokeHandler('get_active_profile', () => 'Solo Pack');
    registerInvokeHandler('get_active_profile_id', () => 'solo-id');
    registerInvokeHandler('get_installed_mods', () =>
      Array.from({ length: 65 }, (_, i) => ({
        name: `Library ${i + 1}`,
        version: '1',
        enabled: i < 11,
        files: [],
      })),
    );
    registerInvokeHandler('list_profiles_cmd', () => [
      {
        id: 'solo-id',
        name: 'Solo Pack',
        game_version: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        mods: Array.from({ length: 11 }, (_, i) => ({
          name: `Solo ${i + 1}`,
          version: '1',
          source: null,
          hash: null,
          files: [],
          enabled: true,
          bundle_url: null,
          folder_name: `Solo-${i + 1}`,
          mod_id: null,
        })),
      },
    ]);

    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.queryAllByText(/11 active \/ 11 mods/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/11 active \/ 65 mods/)).not.toBeInTheDocument();
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

  it('Drop install error from a non-Error throw stringifies via String() (ternary false branch)', async () => {
    // App.tsx — `err instanceof Error ? err.message : String(err)`.
    // Throw a non-Error (a plain string) so the false branch fires.
    registerInvokeHandler('install_mod_from_file', () => {
      throw 'plain-string-rejection';
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    await fireTauriEvent('tauri://drag-drop', { paths: ['C:/x.zip'] });
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
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Mod Manager v9\.9\.9 is available/)).toBeInTheDocument();
    });
    registerInvokeHandler('install_app_update', () => { throw 'rough-install'; });
    await user.click(screen.getByRole('button', { name: /Install & Restart/i }));
    await waitFor(() => {
      expect(screen.getByText(/Update failed: rough-install/)).toBeInTheDocument();
    });
  });

  it('Modpacks sidebar badge: with no pending updates the badge is hidden', async () => {
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

  it('gameInfo.valid=true renders the mod-count line + an "STS2 detected" topbar status', async () => {
    // Mod count surfaces in the topbar profile chip; that's the
    // canonical place (it changes live with mod state). Detection state
    // is ALSO surfaced as an at-a-glance topbar pill (restored 1.7.0
    // after users said there was no easy way to tell if STS2 was found).
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
      expect(screen.getByText(/0 active \/ 0 mods/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /STS2 detected/i }),
    ).toBeInTheDocument();
  });

  it('topbar shows "STS2 not found" and routes to Settings when the game is undetected', async () => {
    // Default safe-mock get_game_info returns valid:false. The warning
    // pill must surface so the user knows to set the game folder, and
    // clicking it jumps straight to Settings.
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    const status = screen.getByRole('button', { name: /STS2 not found/i });
    expect(status).toBeInTheDocument();
    await user.click(status);
    // Settings view is now active — the Game Path field renders there.
    await waitFor(() => {
      expect(screen.getByText('Game Path')).toBeInTheDocument();
    });
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

  // ── DEV titlebar badge ────────────────────────────────────────────
  it('shows a DEV titlebar badge on a dev build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1-dev.pr60.g150366e');
    render(<App />);
    await waitFor(() => expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument());
    expect(screen.getByText('DEV')).toBeInTheDocument();
  });

  it('shows no DEV titlebar badge on a release build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1');
    render(<App />);
    await waitFor(() => expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument());
    expect(screen.queryByText('DEV')).not.toBeInTheDocument();
  });

  it('opening the row-menu customizer event navigates to Settings', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument());
    act(() => { window.dispatchEvent(new CustomEvent(ROW_MENU_OPEN_EVENT)); });
    expect(await screen.findByRole('heading', { name: /mod menu/i })).toBeInTheDocument();
  });
});
