/**
 * Home view test suite for the 1.7 v7 "single-block launcher" Home.
 *
 * After the v7 reorganization Home is just ONE hero block:
 *   - Active modpack    → name + Play button + contextual pills +
 *                         secondary actions row.
 *   - No active modpack → empty state with ONE primary CTA ("Open
 *                         Modpacks").
 *
 * Other Packs list, About card, Pending Updates banner, and the 3-CTA
 * empty-state pattern all left Home. The empty state keeps a single inline
 * share-code Quick-Add (paste a friend's code without leaving Home); the
 * active hero has none. Surfaces that moved elsewhere:
 *   - Other Packs      → Profiles.test.tsx (Yours tab)
 *   - About card       → Settings.test.tsx (General tab)
 *   - Modpacks toolbar Quick-Add → Profiles.test.tsx
 *
 * Intentionally-uncovered branches (≤ 10 % of total, all defensive):
 *   - `checkSubs` showToast-true success-toast branch. Only fires when
 *     callers pass `showToast=true`, but Home itself only ever calls
 *     `checkSubs()` without that flag on mount.
 *   - `loadShareInfo` cancelled-guard FALSE branch and
 *     `PublishModal.onClose` activeProfile-guard FALSE branch. These
 *     guards survive unmount mid-effect — reaching the FALSE side
 *     would require either unmounting mid-effect or clearing
 *     AppContext state externally; both more invasive than the guards
 *     warrant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HomeView } from './Home';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { importShareCodeSmart } from '../lib/shareImport';

// Mock ONLY the smart-import router so the empty-state Quick-Add's outcome
// branches can be driven directly; buildShareLink/buildShareMessage stay real
// (the active hero's share-code chip uses them).
vi.mock('../lib/shareImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/shareImport')>();
  return { ...actual, importShareCodeSmart: vi.fn() };
});

// jsdom 27+ exposes a real (read-only getter) Clipboard on Navigator —
// a plain defineProperty on the instance is shadowed by the prototype
// getter. Install the stub on the Clipboard *prototype* so every call
// from React routes through our mock; per-test we swap the impl.
let clipboardWrite: ReturnType<typeof vi.fn>;
function installClipboard(fn: (text: string) => Promise<void>) {
  clipboardWrite = vi.fn(fn);
  const proto = navigator.clipboard ? Object.getPrototypeOf(navigator.clipboard) : null;
  if (proto && 'writeText' in proto) {
    Object.defineProperty(proto, 'writeText', {
      value: clipboardWrite,
      configurable: true,
      writable: true,
    });
    return;
  }
  // Fallback for environments that don't ship a Clipboard at all.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
}
beforeEach(() => {
  installClipboard(async () => {});
  vi.mocked(importShareCodeSmart).mockReset();
});

function Wrap(props: Partial<React.ComponentProps<typeof HomeView>> = {}) {
  return (
    <AllProviders>
      <HomeView
        onGoToSettings={props.onGoToSettings ?? (() => {})}
        onGoToMods={props.onGoToMods ?? (() => {})}
        onGoToProfiles={props.onGoToProfiles ?? (() => {})}
        onGoToBrowseModpacks={props.onGoToBrowseModpacks ?? (() => {})}
        onCreateModpack={props.onCreateModpack ?? (() => {})}
        onLaunch={props.onLaunch ?? (() => {})}
      />
    </AllProviders>
  );
}

describe('<HomeView> single-block launcher shape (v7)', () => {
  it('renders the empty-state hero (no modpack active)', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Pick a modpack to play/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Modpacks are saved sets of mods/i),
    ).toBeInTheDocument();
  });

  it('empty-state hero has Open Modpacks + Browse modpacks CTAs', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    render(<Wrap />);
    expect(await screen.findByRole('button', { name: /^Open Modpacks$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Browse modpacks$/i })).toBeInTheDocument();
    // Create-modpack isn't a hero CTA — that lives on the Modpacks page.
    expect(
      screen.queryByRole('button', { name: /^Create modpack$/i }),
    ).toBeNull();
  });

  it('"Browse modpacks" CTA fires onGoToBrowseModpacks', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    const onGoToBrowseModpacks = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToBrowseModpacks={onGoToBrowseModpacks} />);
    await user.click(await screen.findByRole('button', { name: /^Browse modpacks$/i }));
    expect(onGoToBrowseModpacks).toHaveBeenCalledTimes(1);
  });

  it('"Open Modpacks" CTA fires onGoToProfiles', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    const onGoToProfiles = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToProfiles={onGoToProfiles} />);
    await user.click(await screen.findByRole('button', { name: /^Open Modpacks$/i }));
    expect(onGoToProfiles).toHaveBeenCalledTimes(1);
  });

  it('empty-state hero offers an inline share-code Quick-Add (paste a code on Home)', async () => {
    registerInvokeHandler('get_active_profile', () => null);
    render(<Wrap />);
    // Newcomers can paste a friend's code right here instead of navigating to
    // Modpacks first — it routes through the same smart import.
    expect(
      await screen.findByPlaceholderText(/username\/AA5A-315D-61AE/i),
    ).toBeInTheDocument();
    expect(document.querySelector('.gf-quickadd')).not.toBeNull();
  });

  it('does NOT show the Quick-Add once a modpack is active (the launcher hero replaces the empty state)', async () => {
    registerInvokeHandler('get_active_profile', () => 'My Pack');
    render(<Wrap />);
    await screen.findByText('My Pack');
    expect(document.querySelector('.gf-quickadd')).toBeNull();
    expect(screen.queryByPlaceholderText(/username\/AA5A-315D-61AE/i)).toBeNull();
  });

  const ADDED_CODE = 'jess/AA5A-315D-61AE';
  async function typeCodeAndAdd() {
    registerInvokeHandler('get_active_profile', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    const input = (await screen.findByPlaceholderText(/username\/AA5A-315D-61AE/i)) as HTMLInputElement;
    await user.type(input, ADDED_CODE);
    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    return { user, input };
  }

  it.each([
    ['installed', { kind: 'installed', profile: { name: 'JessPack', mods: [{}, {}] } }],
    ['activated', { kind: 'activated', profileName: 'JessPack' }],
    ['reapplied with details', { kind: 'reapplied', profileName: 'JessPack', result: { downloaded: 1, failed_downloads: ['x'], missing_mods: ['y'] } }],
    ['reapplied no changes', { kind: 'reapplied', profileName: 'JessPack', result: { downloaded: 0, failed_downloads: [], missing_mods: [] } }],
    ['synced', { kind: 'synced', profileName: 'JessPack' }],
    ['already-active', { kind: 'already-active', profileName: 'JessPack' }],
  ])('empty-state Quick-Add imports a pasted code (%s) and clears the field', async (_label, outcome) => {
    vi.mocked(importShareCodeSmart).mockResolvedValue(outcome as never);
    const { input } = await typeCodeAndAdd();
    expect(importShareCodeSmart).toHaveBeenCalledWith(
      ADDED_CODE,
      expect.objectContaining({ confirm: expect.anything(), t: expect.anything() }),
    );
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('empty-state Quick-Add keeps the typed code when the import is cancelled', async () => {
    vi.mocked(importShareCodeSmart).mockResolvedValue({ kind: 'cancelled' } as never);
    const { input } = await typeCodeAndAdd();
    await waitFor(() => expect(importShareCodeSmart).toHaveBeenCalled());
    expect(input.value).toBe(ADDED_CODE);
  });

  it('empty-state Quick-Add surfaces an error toast when the import throws', async () => {
    vi.mocked(importShareCodeSmart).mockRejectedValue(new Error('bad code'));
    await typeCodeAndAdd();
    expect(await screen.findByText(/bad code/i)).toBeInTheDocument();
  });

  it('does NOT render an "Other Packs" / "Your other packs" section on Home', async () => {
    // Even with subscriptions in state, no Other-Packs section renders
    // on Home — that lives on the Modpacks page now.
    registerInvokeHandler('get_subscriptions', () => [
      {
        share_id: 'alice/abcd',
        profile_name: 'AlicePack',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      },
    ]);
    render(<Wrap />);
    // Give the subs load a chance to settle so a stale rendering would
    // have surfaced by now.
    await waitFor(() => {
      expect(document.querySelector('.gf-hero')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Your other packs/i)).toBeNull();
    expect(screen.queryByText(/AlicePack/)).toBeNull();
  });

  it('renders the About card in the home footer (author attribution + version)', async () => {
    // User feedback after the v7 strip: the launcher felt empty without
    // the author attribution. AboutCard moved back to a quiet footer at
    // the bottom of Home (below the hero) and stayed in Settings →
    // General as well — two surfaces, two intents (Home = launcher
    // attribution / Settings = where you go to find About info).
    render(<Wrap />);
    await waitFor(() => {
      expect(document.querySelector('.gf-hero')).toBeInTheDocument();
    });
    // AboutCard's signature copy is the author's name; the footer
    // wrapper class scopes the assertion so a future addition of an
    // About link elsewhere wouldn't ghost-pass this test.
    const footer = document.querySelector('.gf-home-footer');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByText('Mohamed Serhan')).toBeInTheDocument();
  });

  it('Home is a single column with the hero as the only main block (besides utility banners)', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(document.querySelector('.gf-hero')).toBeInTheDocument();
    });
    // Exactly one .gf-hero on the page (no secondary cards underneath). The
    // empty-state hero's inline share-code Quick-Add lives *inside* this hero,
    // so it doesn't add a second main block.
    expect(document.querySelectorAll('.gf-hero')).toHaveLength(1);
  });
});

describe('<HomeView> active hero', () => {
  function withActive(profile = 'Daily Pack', overrides: Record<string, unknown> = {}) {
    registerInvokeHandler('get_active_profile', () => profile);
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: profile, mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'A', enabled: true },
      { name: 'B', enabled: true },
      { name: 'C', enabled: false },
    ]);
    registerInvokeHandler('get_subscriptions', () => overrides.subs ?? []);
    registerInvokeHandler(
      'check_subscription_updates',
      () => overrides.updates ?? [],
    );
    registerInvokeHandler(
      'get_share_info',
      () => overrides.shareInfo ?? null,
    );
  }

  it('shows the prominent Play button + active-modpack name', async () => {
    withActive('Daily Pack');
    render(<Wrap />);
    expect(await screen.findByText('Daily Pack')).toBeInTheDocument();
    const play = document.querySelector('.gf-hero-play') as HTMLButtonElement | null;
    expect(play).not.toBeNull();
    expect(play!.textContent).toMatch(/Launch/i);
  });

  it('renders the mod count using the modpack-scoped enabled-mods total', async () => {
    withActive('Daily Pack');
    render(<Wrap />);
    await screen.findByText('Daily Pack');
    await waitFor(() => {
      expect(screen.getByText(/^2 mods$/)).toBeInTheDocument();
    });
  });

  it('renders "Continue with" eyebrow on hero when a modpack is active', async () => {
    withActive('MyPack');
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Continue with/i)).toBeInTheDocument();
    });
  });

  it('navigates via onLaunch when the hero Play button is clicked', async () => {
    withActive('MyPack');
    const onLaunch = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onLaunch={onLaunch} />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const launchBtn = document.querySelector('.gf-hero-play') as HTMLButtonElement | null;
    expect(launchBtn).not.toBeNull();
    await user.click(launchBtn!);
    expect(onLaunch).toHaveBeenCalled();
  });

  it('Ctrl+L shortcut tip is rendered when active profile exists', async () => {
    withActive('MyPack');
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    expect(screen.getByText(/Tip: press/)).toBeInTheDocument();
  });

  it('shows the "Sync available" pill when subUpdates lists the active modpack', async () => {
    withActive('Daily Pack', {
      subs: [
        {
          share_id: 'alice/abcd',
          profile_name: 'Daily Pack',
          last_synced: '2026-05-01',
          last_known_remote_sha: 'sha',
          subscribed_at: '2026-01-01',
        },
      ],
      updates: [
        {
          share_id: 'alice/abcd',
          profile_name: 'Daily Pack',
          has_update: true,
          added_mods: ['New'],
          updated_mods: [],
          removed_mods: [],
          remote_profile: null,
        },
      ],
    });
    render(<Wrap />);
    expect(await screen.findByText(/Sync available/i)).toBeInTheDocument();
  });

  it('hides the "Sync available" pill when subUpdates has no active match', async () => {
    withActive('Daily Pack');
    render(<Wrap />);
    await screen.findByText('Daily Pack');
    expect(screen.queryByText(/Sync available/i)).toBeNull();
  });

  it('shows the "Not yet shared" pill for a local unpublished modpack', async () => {
    withActive('My Local Pack');
    render(<Wrap />);
    await screen.findByText('My Local Pack');
    expect(await screen.findByText(/Not yet shared/i)).toBeInTheDocument();
  });

  it('hides the "Not yet shared" pill once the modpack is published', async () => {
    withActive('My Local Pack', {
      shareInfo: {
        owner: 'alice',
        code: 'AA5A-315D-61AE',
        url: 'https://github.com/alice/sts2mm-profiles',
        remote_path: 'My_Local_Pack.json',
      },
    });
    render(<Wrap />);
    await screen.findByText('My Local Pack');
    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.some((b) => /^Share modpack$/i.test(b.textContent ?? ''))).toBe(false);
    });
    expect(screen.queryByText(/Not yet shared/i)).toBeNull();
  });

});

describe('<HomeView> game-not-detected banner', () => {
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
    expect(settingsBtn).toBeDefined();
    await user.click(settingsBtn!);
    expect(onGoToSettings).toHaveBeenCalled();
  });
});

describe('<HomeView> secondary surface (actions)', () => {
  function withActive(profile = 'Daily Pack', opts: { updates?: unknown[] } = {}) {
    registerInvokeHandler('get_active_profile', () => profile);
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: profile, mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_installed_mods', () => [{ name: 'A', enabled: true }]);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('check_subscription_updates', () => opts.updates ?? []);
    registerInvokeHandler('get_share_info', () => null);
  }

  it('Create modpack fires onCreateModpack', async () => {
    withActive();
    const onCreateModpack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onCreateModpack={onCreateModpack} />);
    await screen.findByText('Daily Pack');
    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    expect(onCreateModpack).toHaveBeenCalledTimes(1);
  });


  it('Review updates appears when packs have pending updates and routes to Modpacks', async () => {
    withActive('Daily Pack', {
      updates: [
        {
          share_id: 'a/b',
          profile_name: 'Other',
          has_update: true,
          added_mods: [],
          updated_mods: [],
          removed_mods: [],
          remote_profile: null,
        },
      ],
    });
    const onGoToProfiles = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToProfiles={onGoToProfiles} />);
    const btn = await screen.findByRole('button', { name: /Review updates \(1\)/i });
    await user.click(btn);
    expect(onGoToProfiles).toHaveBeenCalledTimes(1);
  });
});

describe('<HomeView> active-update sync pipeline', () => {
  function withActiveUpdate() {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_subscriptions', () => [
      {
        share_id: 'alice/abcd',
        profile_name: 'MyPack',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 'alice/abcd',
        profile_name: 'MyPack',
        has_update: true,
        added_mods: ['X', 'Y'],
        updated_mods: [],
        removed_mods: ['Z'],
        remote_profile: null,
      },
    ]);
  }

  it('active-update hero shows the Sync pill + View changes / Sync updates secondary buttons', async () => {
    withActiveUpdate();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Sync available/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /View changes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync updates/i })).toBeInTheDocument();
  });

  it('active-update "View changes" opens the SubUpdateDetail modal', async () => {
    withActiveUpdate();
    const user = userEvent.setup();
    render(<Wrap />);
    const view = await screen.findByRole('button', { name: /View changes/i });
    await user.click(view);
    await waitFor(() => {
      expect(screen.getByText(/3 updates available — MyPack/)).toBeInTheDocument();
    });
  });

  it('active-update "Sync updates" fires apply_subscription_update and shows success toast', async () => {
    withActiveUpdate();
    registerInvokeHandler('apply_subscription_update', () => ({
      name: 'MyPack',
      mods: [],
      created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const sync = await screen.findByRole('button', { name: /Sync updates/i });
    await user.click(sync);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'apply_subscription_update')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Synced modpack "MyPack"/)).toBeInTheDocument();
    });
  });

  it('SubUpdateDetail "Apply all" funnels through handleApplySubUpdate then closes the modal', async () => {
    registerInvokeHandler('get_active_profile', () => 'AlicePack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'AlicePack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['NewMod'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    registerInvokeHandler('apply_subscription_update', () => ({ name: 'AlicePack', mods: [], created_at: '2026-01-01' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Sync available/i)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /View changes/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply all/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Apply all/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'apply_subscription_update')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply all/ })).toBeNull();
    });
  });

  it('apply_subscription_update failure surfaces "Sync failed" toast', async () => {
    withActiveUpdate();
    registerInvokeHandler('apply_subscription_update', () => { throw new Error('network down'); });
    const user = userEvent.setup();
    render(<Wrap />);
    const sync = await screen.findByRole('button', { name: /Sync updates/ });
    await user.click(sync);
    await waitFor(() => {
      expect(screen.getByText(/Sync failed: network down/)).toBeInTheDocument();
    });
  });

  it('initial checkSubs error path is silently swallowed (no error toast on mount)', async () => {
    registerInvokeHandler('check_subscription_updates', () => { throw new Error('boom'); });
    render(<Wrap />);
    await waitFor(() => {
      // The single-block hero still mounts even though the silent
      // background check failed.
      expect(document.querySelector('.gf-hero')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Check failed:/)).toBeNull();
  });

  it('SubUpdateDetail X-button close hits the setUpdateDetail(null) handler', async () => {
    registerInvokeHandler('get_active_profile', () => 'AlicePack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'AlicePack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'AlicePack', has_update: true, added_mods: ['NewMod'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/Sync available/i)).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /View changes/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply all/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Skip this update/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply all/ })).toBeNull();
    });
  });

  it('handleApplySubUpdate non-Error throw → String(e) toast text', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/abcd', profile_name: 'MyPack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'MyPack', has_update: true, added_mods: ['X'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    registerInvokeHandler('apply_subscription_update', () => { throw 'oops-string'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Sync updates/ }));
    await waitFor(() => {
      expect(screen.getByText(/Sync failed: oops-string/)).toBeInTheDocument();
    });
  });
});

describe('<HomeView> ShareCodeChip copy actions', () => {
  function withActiveSharedProfile() {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
  }

  it('clicking "Copy" copies the raw code and flips to "Copied"', async () => {
    withActiveSharedProfile();
    render(<Wrap />);
    const copyBtn = await screen.findByTitle('Click to copy the share code');
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    });
    expect(screen.getByText('Share code copied')).toBeInTheDocument();
    expect(copyBtn.textContent).toMatch(/Copied/);
  });

  it('clicking "Copy link" copies the install bridge URL', async () => {
    withActiveSharedProfile();
    render(<Wrap />);
    const linkBtn = await screen.findByRole('button', { name: /Copy link/i });
    fireEvent.click(linkBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    expect((clipboardWrite.mock.calls[0]?.[0] as string)).toMatch(/^https:\/\/.+\?c=alice/);
    expect(screen.getByText(/Install link copied/)).toBeInTheDocument();
  });

  it('clicking "Copy message" copies the paste-ready share message', async () => {
    withActiveSharedProfile();
    render(<Wrap />);
    const msgBtn = await screen.findByRole('button', { name: /Copy message/i });
    fireEvent.click(msgBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    const arg = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(arg).toMatch(/Join my Slay the Spire 2 modpack "MyPack"/);
    expect(arg).toMatch(/alice\/AA5A-315D-61AE/);
    expect(screen.getByText(/Share message copied/)).toBeInTheDocument();
  });

  it('copy fall-back path: clipboard.writeText rejection surfaces an error toast', async () => {
    withActiveSharedProfile();
    installClipboard(async () => { throw new Error('clipboard blocked'); });
    render(<Wrap />);
    const copyBtn = await screen.findByTitle('Click to copy the share code');
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });
});

describe('<HomeView> Share-this-pack CTA error paths + PublishModal close', () => {
  it('"Share modpack" CTA appears for unpublished active profile', async () => {
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
      expect(buttons.some((b) => /Share modpack/i.test(b.textContent ?? ''))).toBe(true);
    });
  });

  it('publish modal opens when the "Share modpack" CTA is clicked', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const shareBtn = await screen.findByRole('button', { name: /Share modpack/i });
    await user.click(shareBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Publish$/i })).toBeInTheDocument();
    });
  });

  it('"Share modpack" missing-profile path shows "Couldn\'t find this profile" error', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'OtherPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const share = screen.getAllByRole('button').find((b) => /Share modpack/i.test(b.textContent ?? ''));
    await user.click(share!);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't find this modpack on disk\./)).toBeInTheDocument();
    });
  });

  it('"Share modpack" list_profiles_cmd failure surfaces a "Couldn\'t load" toast', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    let breakIt = false;
    registerInvokeHandler('list_profiles_cmd', () => {
      if (breakIt) throw new Error('disk explode');
      return [{ name: 'MyPack', mods: [], created_at: '2026-01-01' }];
    });
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const share = screen.getAllByRole('button').find((b) => /Share modpack/i.test(b.textContent ?? ''));
    breakIt = true;
    await user.click(share!);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load modpack: disk explode/)).toBeInTheDocument();
    });
  });

  it('"Share modpack" non-Error throw → String(e) toast text', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    let breakIt = false;
    registerInvokeHandler('list_profiles_cmd', () => {
      if (breakIt) throw 'list-fail-str';
      return [{ name: 'MyPack', mods: [], created_at: '2026-01-01' }];
    });
    registerInvokeHandler('get_share_info', () => null);
    registerInvokeHandler('get_subscriptions', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    breakIt = true;
    const share = screen.getAllByRole('button').find((b) => /Share modpack/i.test(b.textContent ?? ''));
    await user.click(share!);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load modpack: list-fail-str/)).toBeInTheDocument();
    });
  });

  it('PublishModal X-close runs the share-info refetch + onShared updates the chip', async () => {
    let shareInfo: any = null;
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => shareInfo);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false, github_token_set: true,
    }));
    registerInvokeHandler('share_profile', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json', failed_uploads: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const share = screen.getAllByRole('button').find((b) => /Share modpack/i.test(b.textContent ?? ''));
    await user.click(share!);
    const publishBtn = await screen.findByRole('button', { name: /^Publish$/i });
    shareInfo = {
      owner: 'alice', code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles', remote_path: 'My_Pack.json',
    };
    await user.click(publishBtn);
    await waitFor(() => {
      expect(screen.queryAllByText('alice/AA5A-315D-61AE').length).toBeGreaterThan(0);
    });
    const doneBtn = await screen.findByRole('button', { name: /^Done$/ });
    await user.click(doneBtn);
    await waitFor(() => {
      expect(screen.queryAllByText('alice/AA5A-315D-61AE').length).toBe(1);
    });
  });

  it('PublishModal onClose with a get_share_info failure swallows the error (no crash)', async () => {
    let publishedOnce = false;
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => {
      if (publishedOnce) throw new Error('refetch failed');
      return null;
    });
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false, github_token_set: true,
    }));
    registerInvokeHandler('share_profile', () => {
      publishedOnce = true;
      return {
        owner: 'alice', code: 'AA5A-315D-61AE',
        url: 'https://github.com/alice/sts2mm-profiles', remote_path: 'My_Pack.json',
        failed_uploads: [],
      };
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    const share = screen.getAllByRole('button').find((b) => /Share modpack/i.test(b.textContent ?? ''));
    await user.click(share!);
    const publishBtn = await screen.findByRole('button', { name: /^Publish$/i });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(screen.queryAllByText('alice/AA5A-315D-61AE').length).toBeGreaterThan(0);
    });
    const doneBtn = await screen.findByRole('button', { name: /^Done$/ });
    await user.click(doneBtn);
    await waitFor(() => {
      expect(screen.queryAllByText('alice/AA5A-315D-61AE').length).toBe(1);
    });
  });

  it('getShareInfo failure clears activeProfileShare (catch branch in the share-info effect)', async () => {
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'MyPack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_share_info', () => { throw new Error('share-info down'); });
    registerInvokeHandler('get_subscriptions', () => []);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MyPack')).toBeInTheDocument(); });
    expect(screen.queryByTitle('Click to copy the share code')).toBeNull();
    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.some((b) => /Share modpack/i.test(b.textContent ?? ''))).toBe(true);
    });
  });
});

describe('<HomeView> active modpack with imported sub renders the share chip', () => {
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
      // The share-code chip should render the published code.
      expect(screen.getByText(/AA5A-315D-61AE/)).toBeInTheDocument();
    });
  });

  it('formatShareCode handles colon-separated subscription share IDs without crashing', async () => {
    // active profile = AlicePack; subscription uses ":" instead of "/"
    // — exercises the `s.includes(':') ? ':' : '/'` ternary inside
    // formatShareCode for the active hero's chip path.
    registerInvokeHandler('get_active_profile', () => 'AlicePack');
    registerInvokeHandler('list_profiles_cmd', () => [
      { name: 'AlicePack', mods: [], created_at: '2026-01-01' },
    ]);
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice:abcd1234efgh', profile_name: 'AlicePack', last_synced: '2026-05-01', last_known_remote_sha: 'sha', subscribed_at: '2026-01-01' },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/alice\/abcd-1234-efgh/)).toBeInTheDocument();
    });
  });
});
