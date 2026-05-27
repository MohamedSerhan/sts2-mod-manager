/**
 * Coverage notes for Profiles.tsx
 * --------------------------------
 *
 * Intentionally-uncovered branches (documented per the task plan):
 *
 *   - `handleApplySub` re-entry guard: the first line `if (applyingSubId)
 *     return;` only fires when a second Apply click races an in-flight
 *     first one. The mock resolves synchronously so the second click
 *     never observes a non-null `applyingSubId` — branch left to age out
 *     as the function refactors.
 *
 *   - `refreshShareAndDrift` `getShareInfo` and `getProfileDrift` catch
 *     paths: both wrap a fire-and-forget lookup. The "outcome" is the
 *     absence of state — already covered indirectly by the no-drift /
 *     no-share-info paths that exercise the surrounding render.
 *
 *   - Inline `setCopiedProfileCode` clipboard `.catch(() => {})` in the
 *     row's copy-chip button (Profiles.tsx around the chip render — line
 *     numbers shift with edits): the duplicate kebab-menu Copy share
 *     code item is already exercised with both success and reject
 *     paths, so the chip-button reject path is a redundant catch.
 *
 *   - `<PublishModal>`'s internal flows live in `PublishModal.test.tsx`.
 *     Here we only test the `onShared` callback wiring + open state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProfilesView } from './Profiles';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { LoadOrderSettingsStatus, ModInfo, Profile } from '../types';

function Wrap(props: React.ComponentProps<typeof ProfilesView> = {}) {
  return (
    <AllProviders>
      <ProfilesView {...props} />
    </AllProviders>
  );
}

/**
 * T16 — open the detail view for a modpack card by clicking it.
 * Throws a loud error if the card can't be found rather than silently
 * skipping (per the testing memory: no `if (btn) { click(btn) }`).
 */
async function openDetailFor(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  const card = await screen.findByRole('button', { name: new RegExp(`Open ${name} modpack`, 'i') });
  await user.click(card);
  // Detail view header has the modpack name as the visible <h2>.
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
  });
}

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'My Pack',
    mods: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    game_version: '0.105.0',
    ...overrides,
  } as Profile);

const baseMod = (overrides: Partial<ModInfo> = {}): ModInfo => ({
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
  note: null,
  custom_url: null,
  display_name: null,
  display_description: null,
  ...overrides,
});

const profileMod = (overrides: Partial<Profile['mods'][number]> = {}): Profile['mods'][number] => ({
  name: 'BaseLib',
  version: '1.0.0',
  source: null,
  hash: null,
  files: ['BaseLib/BaseLib.dll'],
  enabled: true,
  bundle_url: null,
  folder_name: 'BaseLib',
  mod_id: 'BaseLib',
  ...overrides,
});

function seedProfiles(profiles: Profile[]): void {
  registerInvokeHandler('list_profiles_cmd', () => profiles);
}

// jsdom's clipboard support varies by version. Install a concrete
// navigator.clipboard object each time so assertions observe the exact
// writeText mock the UI calls.
let clipboardWrite: ReturnType<typeof vi.fn>;
function installClipboard(fn: (text: string) => Promise<void> = async () => {}) {
  clipboardWrite = vi.fn(fn);
  const clipboard = window.navigator.clipboard ?? navigator.clipboard ?? {};
  Object.defineProperty(clipboard, 'writeText', {
    value: clipboardWrite,
    configurable: true,
    writable: true,
  });
  const proto = Object.getPrototypeOf(clipboard);
  if (proto) {
    Object.defineProperty(proto, 'writeText', {
      value: clipboardWrite,
      configurable: true,
      writable: true,
    });
  }
  for (const target of [navigator, window.navigator]) {
    Object.defineProperty(target, 'clipboard', {
      value: clipboard,
      configurable: true,
    });
  }
}

beforeEach(() => {
  installClipboard();
});

function setupUserWithClipboard(fn: (text: string) => Promise<void> = async () => {}) {
  const user = userEvent.setup();
  installClipboard(fn);
  return user;
}

/** Scope to the confirm-modal foot (the bottom row with the action
 *  buttons). Dodges the X icon in the head and stray buttons elsewhere
 *  on the page. */
async function confirmModal() {
  const foot = await waitFor(() => {
    const f = document.querySelector('.gf-modal-back .gf-modal .gf-modal-foot');
    if (!f) throw new Error('confirm modal foot not mounted');
    return f as HTMLElement;
  });
  return within(foot);
}

describe('<ProfilesView>', () => {
  it('shows the empty state when no profiles exist', async () => {
    seedProfiles([]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/No modpacks yet/i)).toBeInTheDocument();
    });
  });

  // ── 1.7.0 outer Yours/Browse tabs ─────────────────────────────────
  it('outer tab strip: Yours is the default; switching to Browse renders BrowseModpacksView', async () => {
    // The outer tabs absorb the formerly-standalone Browse Modpacks
    // surface into Modpacks. Default tab is Yours (followed +
    // published modpacks). The Browse tab renders the public modpack
    // browser whose heading is "Browse Modpacks".
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('fetch_modpack_browser_page', () => ({
      cards: [],
      page: 1,
      has_next_page: false,
      stale: false,
      fetched_at: Math.floor(Date.now() / 1000),
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    // Yours tab content (existing modpack list)
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    // Click Browse — outer tab
    await user.click(screen.getByRole('button', { name: /^Browse$/i }));
    // The public modpack browser heading appears
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
    // Switch back — the modpack row reappears
    await user.click(screen.getByRole('button', { name: /^Yours$/i }));
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
  });

  it('initialTab=browse opens straight on the Browse tab', async () => {
    // Backward-compat path: legacy view-id 'browse-modpacks' is
    // routed by App.tsx to this view with initialTab='browse'. We
    // verify the prop honoring here.
    registerInvokeHandler('fetch_modpack_browser_page', () => ({
      cards: [],
      page: 1,
      has_next_page: false,
      stale: false,
      fetched_at: Math.floor(Date.now() / 1000),
    }));
    render(<Wrap initialTab="browse" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
  });

  it('renders profile cards with active badge for the active profile', async () => {
    seedProfiles([
      baseProfile({ name: 'Alpha' }),
      baseProfile({ name: 'Gamma' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'Alpha');
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Gamma')).toBeInTheDocument();
    });
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  // The bare "name your modpack" inline form was removed in 1.7.0 — the
  // toolbar's Create modpack button now opens the guided wizard
  // (CreateModpackWizard). The full create flow + name validation +
  // create_profile invoke wiring + toast wording is exercised in
  // CreateModpackWizard.test.tsx; here we only verify that clicking
  // the toolbar button mounts the wizard.
  it('Create modpack button opens the guided wizard', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });

    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    // The wizard mounts with its step-1 "Start from my active mods" tile.
    expect(
      await screen.findByRole('button', { name: /start from my active mods/i }),
    ).toBeInTheDocument();
  });

  it('shows the activity feed when subUpdates carries a pending pack update', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: 'Alpha',
        has_update: true,
        added_mods: [{ name: 'X' }],
        updated_mods: [],
        removed_mods: [],
      },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/modpack has updates|modpacks have updates/i)).toBeInTheDocument();
    });
  });

  it('clicking Apply update on a pending pack invokes apply_subscription_update + success toast', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: 'Alpha',
        has_update: true,
        added_mods: [{ name: 'X' }],
        updated_mods: [],
        removed_mods: [],
      },
    ]);
    registerInvokeHandler('apply_subscription_update', () => baseProfile({ name: 'Alpha' }));
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply update/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Apply update/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'apply_subscription_update' && c.args?.shareId === 's1',
      )).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Synced "Alpha"/)).toBeInTheDocument();
    });
  });

  it('Apply update error path surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: 'Alpha',
        has_update: true,
        added_mods: [],
        updated_mods: [{ name: 'Y' }],
        removed_mods: [],
      },
    ]);
    registerInvokeHandler('apply_subscription_update', () => { throw new Error('rate limit'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply update/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Apply update/ }));
    await waitFor(() => {
      expect(screen.getByText(/Sync failed.*rate limit/)).toBeInTheDocument();
    });
  });

  it('subUpdates with multiple update kinds builds the combined summary', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 's1',
        profile_name: 'Alpha',
        has_update: true,
        added_mods: [{ name: 'A' }],
        updated_mods: [{ name: 'B' }],
        removed_mods: [{ name: 'C' }],
      },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/\+1 added.*1 updated.*-1 removed/)).toBeInTheDocument();
    });
  });

  it('Snapshot active modpack invokes snapshot_profile via the prompt + success toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('snapshot_profile', (args) =>
      baseProfile({ name: String(args?.name), mods: [{ name: 'a' } as any, { name: 'b' } as any] }),
    );
    const origPrompt = window.prompt;
    window.prompt = () => 'Snap-1';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: /Snapshot active modpack/ }));
      await waitFor(() => {
        expect(getInvokeCalls().some(
          (c) => c.cmd === 'snapshot_profile' && c.args?.name === 'Snap-1',
        )).toBe(true);
      });
      await waitFor(() => {
        expect(screen.getByText(/Snapshot "Snap-1" created with 2 mods/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('snapshot_profile error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('snapshot_profile', () => { throw new Error('readonly'); });
    const origPrompt = window.prompt;
    window.prompt = () => 'BadSnap';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: /Snapshot active modpack/ }));
      await waitFor(() => {
        expect(screen.getByText(/Failed to snapshot.*readonly/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  // T16 — Switch is now reached via card → detail view, not from
  // inline row buttons. The detail header shows "Switch to" for
  // non-active modpacks and the activation flow is identical.
  it('Switch to a different profile invokes switch_profile + reports new active', async () => {
    seedProfiles([
      baseProfile({ name: 'A' }),
      baseProfile({ name: 'B' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => ({
      applied: true,
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'B');
    await user.click(screen.getByRole('button', { name: /Switch to/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Switched to modpack "B"/)).toBeInTheDocument();
    });
  });

  it('Switch cancel leaves a drifted active profile untouched', async () => {
    seedProfiles([
      baseProfile({ name: 'A' }),
      baseProfile({ name: 'B' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('get_profile_drift', (args) => ({
      profile_name: args?.name,
      added: ['LooseMod'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: args?.name === 'A',
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'B');
    await user.click(screen.getByRole('button', { name: /Switch to/i }));

    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: /Stay here/i }));

    expect(getInvokeCalls().some((call) => call.cmd === 'switch_profile')).toBe(false);
  });

  it('switch_profile with downloads + missing + failed builds the combined info toast', async () => {
    seedProfiles([
      baseProfile({ name: 'A' }),
      baseProfile({ name: 'B' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => ({
      applied: true,
      downloaded: 3,
      missing_mods: ['Missing1'],
      failed_downloads: ['FailedA'],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'B');
    await user.click(screen.getByRole('button', { name: /Switch to/i }));
    await waitFor(() => {
      expect(screen.getByText(/3 mod\(s\) downloaded/)).toBeInTheDocument();
    });
    expect(screen.getByText(/1 failed: FailedA/)).toBeInTheDocument();
    expect(screen.getByText(/1 still missing: Missing1/)).toBeInTheDocument();
  });

  it('Import-by-code button opens the input form', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
  });

  it('Import-by-code Cancel hides the form', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
    // The form's Cancel button (there's also one in the create form, but it's hidden).
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText(/username\/XXXX/)).toBeNull();
  });

  it('Import from JSON form opens and submits to import_profile_cmd', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('import_profile_cmd', () => baseProfile({ name: 'Imported' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import modpack JSON/ }));
    const textarea = await screen.findByPlaceholderText(/"name":/);
    await user.click(textarea);
    await user.paste('{"name":"X"}');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'import_profile_cmd')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Imported modpack "Imported"/)).toBeInTheDocument();
    });
  });

  it('Import JSON refuses empty input (no invoke)', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import modpack JSON/ }));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'import_profile_cmd')).toBe(false);
  });

  it('Import JSON error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('import_profile_cmd', () => { throw new Error('bad json'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import modpack JSON/ }));
    const textarea = await screen.findByPlaceholderText(/"name":/);
    await user.click(textarea);
    await user.paste('not json');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to import.*bad json/)).toBeInTheDocument();
    });
  });

  it('Import JSON Cancel hides the form', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import modpack JSON/ }));
    expect(screen.getByPlaceholderText(/"name":/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText(/"name":/)).toBeNull();
  });

  it('renders error banner when listProfiles fails', async () => {
    registerInvokeHandler('list_profiles_cmd', () => { throw new Error('disk full'); });
    render(<Wrap />);
    // Error banner renders with the message + a Retry button.
    await waitFor(() => {
      expect(screen.getByText('disk full')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('Retry button on error banner re-invokes list_profiles_cmd', async () => {
    let calls = 0;
    registerInvokeHandler('list_profiles_cmd', () => {
      calls++;
      if (calls === 1) throw new Error('first fail');
      return [baseProfile({ name: 'Recovered' })];
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('first fail')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByText('Recovered')).toBeInTheDocument();
    });
  });

  // T16 — kebab actions moved into the detail view's Advanced panel.
  // The card itself is a single big clickable button; per-row inline
  // kebabs no longer exist. This test now confirms the detail view's
  // Advanced section reveals the same action set.
  it('detail Advanced shows Snapshot/Export/Delete options', async () => {
    seedProfiles([baseProfile({ name: 'Pack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'Pack');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByRole('button', { name: /Snapshot from current/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export JSON/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete modpack/i })).toBeInTheDocument();
  });

  it('renders all modpack metadata on the card (mod count + author)', async () => {
    seedProfiles([baseProfile({
      name: 'Detailed',
      mods: [
        { name: 'A', version: '1.0', source: null, hash: null, files: [], enabled: true, dependencies: [], size_bytes: 0 },
        { name: 'B', version: '1.0', source: null, hash: null, files: [], enabled: false, dependencies: [], size_bytes: 0 },
      ] as any,
      created_by: 'alice',
    })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Detailed')).toBeInTheDocument(); });
    // Cards show the combined mod count rather than enabled/disabled split.
    expect(screen.getByText(/2 mods/)).toBeInTheDocument();
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
  });

  it('renders shared-modpack badge on the card when published', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'Published.json',
    }));
    render(<Wrap />);
    // The card shows the "Shared" pill instead of the raw code; the
    // share code surfaces inside the detail header.
    await waitFor(() => {
      const card = screen.getByRole('button', { name: /Open Published modpack/i });
      expect(within(card).getByText(/Shared/i)).toBeInTheDocument();
    });
  });

  it('renders drift banner when profile drift is reported', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['NewMod'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    // The banner copy contains "has drifted" — unique to the active-profile banner.
    await waitFor(() => {
      expect(screen.getByText(/has drifted/)).toBeInTheDocument();
    });
  });

  it('drift banner Repair button triggers handleRepairDrift (confirm → repair_profile)', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['Orphan1', 'Orphan2'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('repair_profile', () => ({
      applied: true,
      downloaded: 1,
      missing_mods: ['StillMissing'],
      failed_downloads: ['FailedX'],
      disabled_orphans: ['Orphan1', 'Orphan2'],
      deleted_orphans: [],
    }));
    // Backup checkbox is available but unchecked by default.
    registerInvokeHandler('create_backup_cmd', () => '/tmp/backup.zip');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    // The banner's Repair button has a unique title.
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    // Confirm modal opens; click the Repair button in its foot.
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'create_backup_cmd')).toBe(false);
    // Success toast with summary — parts joined by ", " with i18next
    // plurals so the singular reads "1 download failed" instead of the
    // old "1 download(s) failed" lazy-form.
    await waitFor(() => {
      const found = document.body.textContent ?? '';
      expect(found).toContain('disabled 2 extra mods, downloaded 1, 1 download failed, 1 still missing');
    });
  });

  it('drift banner Save changes failure surfaces a Failed-to-save toast (handleSaveDrift catch)', async () => {
    // snapshot_profile rejects → handleSaveDrift catch fires the
    // profiles.toast.saveFailed string with the underlying error.
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['NewMod'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('snapshot_profile', () => { throw new Error('readonly fs'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    await user.click(await screen.findByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to save changes.*readonly fs/)).toBeInTheDocument();
    });
  });

  it('drift banner Save changes snapshots the active profile without repairing disk', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['NewMod'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('snapshot_profile', (args) =>
      baseProfile({
        name: String(args?.name),
        mods: [{ name: 'NewMod', enabled: true } as any],
      }),
    );

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });

    await user.click(await screen.findByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some(
          (c) => c.cmd === 'snapshot_profile' && c.args?.name === 'DriftedPack',
        ),
      ).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(false);
    await waitFor(() => {
      expect(screen.getByText(/Saved changes to "DriftedPack"/)).toBeInTheDocument();
    });
  });

  it('drift banner Repair with no active extras renders the safe body', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: [],
      removed: ['GoneA'],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('repair_profile', () => ({
      applied: true,
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
      disabled_orphans: [],
      deleted_orphans: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    await waitFor(() => {
      expect(screen.getByText(/No active extra mods to disable/)).toBeInTheDocument();
    });
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(true);
    });
    // No backup invoked because the checkbox doesn't render in the no-orphan branch.
    expect(getInvokeCalls().some((c) => c.cmd === 'create_backup_cmd')).toBe(false);
    // Summary fallthrough: no summary parts → "Repaired \"DriftedPack\"" only.
    await waitFor(() => {
      expect(screen.getByText(/^Repaired "DriftedPack"$/)).toBeInTheDocument();
    });
  });

  it('drift Repair cancel via the Cancel button skips invoke', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Cancel' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(false);
  });

  it('drift Repair backup checkbox unchecked skips create_backup_cmd', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('repair_profile', () => ({
      applied: true,
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
      disabled_orphans: ['Orphan'],
      deleted_orphans: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    const checkbox = await screen.findByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'create_backup_cmd')).toBe(false);
  });

  it('drift Repair: create_backup_cmd failure shows toast but proceeds with repair', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('create_backup_cmd', () => { throw new Error('disk full'); });
    registerInvokeHandler('repair_profile', () => ({
      applied: true,
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
      disabled_orphans: ['Orphan'],
      deleted_orphans: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    await user.click(await screen.findByRole('checkbox'));
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(screen.getByText(/Backup failed.*disk full/)).toBeInTheDocument();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(true);
  });

  it('drift Repair: repair_profile failure surfaces error toast', async () => {
    seedProfiles([baseProfile({ name: 'DriftedPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftedPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: [],
      removed: ['X'],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    registerInvokeHandler('repair_profile', () => { throw new Error('repair boom'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(screen.getByText(/Repair failed.*repair boom/)).toBeInTheDocument();
    });
  });

  it('drift Repair with >8 orphans shows the truncated orphan list in confirm body', async () => {
    const orphans = Array.from({ length: 12 }, (_, i) => `Orph${i + 1}`);
    seedProfiles([baseProfile({ name: 'BigDrift' })]);
    registerInvokeHandler('get_active_profile', () => 'BigDrift');
    registerInvokeHandler('get_profile_drift', () => ({
      added: orphans,
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('BigDrift')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and store extra active mods');
    await user.click(repairBanner);
    await waitFor(() => {
      // "Orph1, Orph2, ... Orph8, …4 more"
      expect(screen.getByText(/Orph8.*4 more/)).toBeInTheDocument();
    });
  });

  it('handles snapshot prompt cancel gracefully', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const origPrompt = window.prompt;
    window.prompt = () => null;
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: /Snapshot active modpack/ }));
      expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(false);
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('handles snapshot prompt empty string as cancel', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const origPrompt = window.prompt;
    window.prompt = () => '   ';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: /Snapshot active modpack/ }));
      expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(false);
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('All packs / Published tabs toggle profile filters', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    const publishedBtn = screen.getByRole('button', { name: /Published by you/i });
    await user.click(publishedBtn);
    expect(publishedBtn.className).toContain('active');
    const allPacksBtn = screen.getByRole('button', { name: /^All modpacks/i });
    await user.click(allPacksBtn);
    expect(allPacksBtn.className).toContain('active');
  });

  // ── T16: per-modpack detail view (replaces the standalone Mod
  // Library workspace) ──────────────────────────────────────────────
  // The legacy workspace tests have been migrated to LibraryTable.test.tsx
  // (the extracted reusable per-modpack editor) and ModpackDetail.test.tsx
  // (the inline detail view layout). What stays here are the
  // navigation + integration assertions: clicking a card opens
  // detail, the detail's signal-bump entry path from a sibling view,
  // and so on.
  it('clicking a modpack card opens its detail view; Back returns to the list', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' }), baseProfile({ name: 'Beta' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await screen.findByText('Alpha');
    await user.click(await screen.findByRole('button', { name: /Open Alpha modpack/i }));
    // Detail view rendered — title + Back button visible.
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    // The other modpack card is no longer rendered while we're in detail.
    expect(screen.queryByRole('button', { name: /Open Beta modpack/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Back to modpacks/i }));
    // Both cards visible again.
    expect(await screen.findByRole('button', { name: /Open Alpha modpack/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Beta modpack/i })).toBeInTheDocument();
  });

  it('openActiveModpackSignal opens the active modpack detail directly', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_active_profile', () => 'Stable');
    render(<Wrap openActiveModpackSignal={1} />);
    // Detail view header for the active modpack should render without
    // needing the user to click a card first.
    expect(await screen.findByRole('heading', { level: 2, name: 'Stable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
  });

  // The detail view's Advanced section reveals power actions
  // (Delete, Duplicate, Snapshot, Export, Repair, Load Order). Each
  // is tested in detail in ModpackDetail.test.tsx; here we only
  // assert the disclosure toggles.
  it('detail Advanced section is collapsed by default and toggles open', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'X');
    // Closed by default — the action buttons are not visible.
    expect(screen.queryByRole('button', { name: /Delete modpack/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByRole('button', { name: /Delete modpack/i })).toBeInTheDocument();
    // Re-clicking collapses.
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.queryByRole('button', { name: /Delete modpack/i })).toBeNull();
  });

  // Legacy placeholder retained so the original "Mod library" anchor
  // test name still resolves grep results in commit archeology.
  it.skip('Mod Library opens a dedicated library workspace from a special action row', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' }), baseProfile({ name: 'Beta' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [
        { name: 'Alpha', editable: true },
        { name: 'Beta', editable: true },
      ],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Alpha', included: true, enabled: true, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));

    const user = userEvent.setup();
    const { container } = render(<Wrap />);
    const specialRow = container.querySelector('.gf-profile-special-actions');
    expect(specialRow).not.toBeNull();
    expect(specialRow).toContainElement(await screen.findByRole('button', { name: /Mod library/i }));
    expect(container.querySelector('.gf-page-actions')).not.toContainElement(screen.getByRole('button', { name: /Mod library/i }));
    expect(screen.getByText(/Every mod you've installed\. Toggle which modpacks each one belongs to\./i)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Mod library/i }));

    expect(await screen.findByRole('heading', { name: /Mod library/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    expect((await screen.findAllByText('BaseLib')).length).toBeGreaterThan(0);
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Beta' })).not.toBeChecked();
  });

  it.skip('opens Mod Library directly when requested from another view', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
          ],
        },
      ],
    }));

    render(<Wrap openActiveModpackSignal={1} />);

    expect(await screen.findByRole('heading', { name: /Mod library/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    expect((await screen.findAllByText('BaseLib')).length).toBeGreaterThan(0);
  });

  it.skip('Mod Library action shows the installed count before opening and is marked beta', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('get_installed_mods', () => [
      baseMod({ name: 'BaseLib', folder_name: 'BaseLib' }),
      baseMod({ name: 'AutoPath', folder_name: 'AutoPath', mod_id: 'AutoPath' }),
    ]);

    render(<Wrap />);

    const action = await screen.findByRole('button', { name: /Mod library.*2/i });
    expect(within(action).getByText('Beta')).toBeInTheDocument();
  });

  it.skip('Mod Library toggles membership by folder identity without applying the profile', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Library Only',
          version: '1.2.3',
          folder_name: 'LibraryOnly',
          mod_id: 'LibraryOnly',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile({ name: 'Stable' }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));
    await user.click(await screen.findByRole('checkbox', { name: 'Stable' }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'set_profile_mod_membership',
        args: {
          profileName: 'Stable',
          modName: 'Library Only',
          folderName: 'LibraryOnly',
          modId: 'LibraryOnly',
          included: true,
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/Added Library Only to Stable/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('checkbox', { name: 'Stable' })).toBeChecked();
    expect(getInvokeCalls().filter((call) => call.cmd === 'get_profile_memberships')).toHaveLength(1);
    expect(getInvokeCalls().some((call) => call.cmd === 'switch_profile')).toBe(false);
  });

  it.skip('Mod Library surfaces membership update failures without changing the checkbox', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Library Only',
          version: '1.2.3',
          folder_name: 'LibraryOnly',
          mod_id: 'LibraryOnly',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('set_profile_mod_membership', () => {
      throw new Error('profile locked');
    });

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));
    await user.click(await screen.findByRole('checkbox', { name: 'Stable' }));

    expect(await screen.findByText(/Failed to update membership: profile locked/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Stable' })).not.toBeChecked();
  });

  it.skip('Mod Library disables followed profile membership edits', async () => {
    seedProfiles([baseProfile({ name: 'Friend Pack', created_by: 'alice' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Friend Pack', editable: false }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Friend Pack', included: true, enabled: true, editable: false },
          ],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByRole('checkbox', { name: 'Friend Pack' })).toBeDisabled();
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument();
  });

  it.skip('Mod Library surfaces membership load failures with retry', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    let attempts = 0;
    registerInvokeHandler('get_profile_memberships', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('membership service unavailable');
      }
      return { profiles: [{ name: 'Stable', editable: true }], mods: [] };
    });

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByText(/membership service unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    expect(await screen.findByText(/No installed mods/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it.skip('Mod Library shows display-name overrides, disabled installed state, and no-profile rows', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'raw-manifest-name',
          display_name: 'Readable Name',
          version: '9.9.9',
          folder_name: null,
          mod_id: 'raw-id',
          installed_enabled: false,
          profiles: [],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByText('Readable Name')).toBeInTheDocument();
    expect(screen.getByText('raw-manifest-name')).toBeInTheDocument();
    expect(screen.getByText(/^Stored$/i)).toBeInTheDocument();
    expect(screen.getByText(/No modpacks yet/i)).toBeInTheDocument();
  });

  it.skip('Mod Library separates library storage state from profile membership state', async () => {
    seedProfiles([baseProfile({ name: 'Stable' }), baseProfile({ name: 'Beta' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [
        { name: 'Stable', editable: true },
        { name: 'Beta', editable: true },
      ],
      mods: [
        {
          name: 'Combo Patch',
          version: '1.0.0',
          folder_name: 'ComboPatch',
          mod_id: 'ComboPatch',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: true, enabled: false, editable: true },
          ],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByText('Combo Patch')).toBeInTheDocument();
    expect(screen.getByText(/^Active in game$/i)).toBeInTheDocument();
    expect(screen.getByText(/The mod library shows every installed mod/i)).toBeInTheDocument();
    expect(screen.getByText(/Not in this modpack/i)).toBeInTheDocument();
    expect(screen.getByText(/Included, off in this modpack/i)).toBeInTheDocument();
    expect(screen.getByText('1 modpack')).toBeInTheDocument();
  });

  it.skip('Mod Library stores and activates a mod without changing profile membership', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Loose Active Mod',
          version: '1.0.0',
          folder_name: 'LooseActive',
          mod_id: 'loose-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    await user.click(await screen.findByRole('button', { name: /Store Loose Active Mod \(keep installed but move out of the game folder\)/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'toggle_mod',
        args: {
          name: 'Loose Active Mod',
          folderName: 'LooseActive',
          enable: false,
        },
      });
    });
    expect(screen.getByRole('checkbox', { name: 'Stable' })).not.toBeChecked();
    expect(getInvokeCalls().filter((call) => call.cmd === 'set_profile_mod_membership')).toHaveLength(0);
    expect(await screen.findByText(/^Stored$/i)).toBeInTheDocument();
    expect(await screen.findByText(/Loose Active Mod stored \(kept installed, moved out of the game folder\)/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Activate Loose Active Mod in the game folder/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'toggle_mod',
        args: {
          name: 'Loose Active Mod',
          folderName: 'LooseActive',
          enable: true,
        },
      });
    });
    expect(await screen.findByText(/^Active in game$/i)).toBeInTheDocument();
  });

  it.skip('Mod Library bulk-stores only active mods unused by every profile', async () => {
    seedProfiles([baseProfile({ name: 'Stable' }), baseProfile({ name: 'Beta' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [
        { name: 'Stable', editable: true },
        { name: 'Beta', editable: true },
      ],
      mods: [
        {
          name: 'Unused Active',
          version: '1.0.0',
          folder_name: 'UnusedActive',
          mod_id: 'unused-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Used Active',
          version: '1.0.0',
          folder_name: 'UsedActive',
          mod_id: 'used-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Unused Stored',
          version: '1.0.0',
          folder_name: 'UnusedStored',
          mod_id: 'unused-stored',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => undefined);

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    await user.click(await screen.findByRole('button', { name: /Store 1 unused active mod/i }));

    await waitFor(() => {
      const toggles = getInvokeCalls().filter((call) => call.cmd === 'toggle_mod');
      expect(toggles).toEqual([
        {
          cmd: 'toggle_mod',
          args: {
            name: 'Unused Active',
            folderName: 'UnusedActive',
            enable: false,
          },
        },
      ]);
    });
    const unusedRow = screen.getByText('Unused Active').closest('.gf-profile-library-row') as HTMLElement;
    const usedRow = screen.getByText('Used Active').closest('.gf-profile-library-row') as HTMLElement;
    expect(within(unusedRow).getByText(/^Stored$/i)).toBeInTheDocument();
    expect(within(usedRow).getByText(/^Active in game$/i)).toBeInTheDocument();
    expect(await screen.findByText(/Stored 1 unused active mod/i)).toBeInTheDocument();
  });

  it.skip('Mod Library leaves storage state unchanged when storing one mod fails', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Locked Active Mod',
          version: '1.0.0',
          folder_name: 'LockedActive',
          mod_id: 'locked-active',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', () => {
      throw new Error('disk locked');
    });

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));
    await user.click(await screen.findByRole('button', { name: /Store Locked Active Mod \(keep installed but move out of the game folder\)/i }));

    expect(await screen.findByText(/Failed to move Locked Active Mod: disk locked/i)).toBeInTheDocument();
    expect(screen.getByText(/^Active in game$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Store Locked Active Mod \(keep installed but move out of the game folder\)/i })).toBeEnabled();
  });

  it.skip('Mod Library reports partial failures while storing unused active mods', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: [
        {
          name: 'Stores Cleanly',
          version: '1.0.0',
          folder_name: 'StoresCleanly',
          mod_id: 'stores-cleanly',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Fails To Store',
          version: '1.0.0',
          folder_name: 'FailsToStore',
          mod_id: 'fails-to-store',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
          ],
        },
      ],
    }));
    registerInvokeHandler('toggle_mod', (args) => {
      if (args?.name === 'Fails To Store') {
        throw new Error('busy');
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));
    await user.click(await screen.findByRole('button', { name: /Store 2 unused active mods/i }));

    await waitFor(() => {
      expect(getInvokeCalls().filter((call) => call.cmd === 'toggle_mod')).toHaveLength(2);
    });
    const storedRow = screen.getByText('Stores Cleanly').closest('.gf-profile-library-row') as HTMLElement;
    const failedRow = screen.getByText('Fails To Store').closest('.gf-profile-library-row') as HTMLElement;
    expect(within(storedRow).getByText(/^Stored$/i)).toBeInTheDocument();
    expect(within(failedRow).getByText(/^Active in game$/i)).toBeInTheDocument();
    expect(await screen.findByText(/Stored 1 of 2 unused active mods. Failed: Fails To Store/i)).toBeInTheDocument();
  });

  it.skip('Mod Library caps the initial rendered rows and can reveal more for large libraries', async () => {
    seedProfiles([baseProfile({ name: 'Stable' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Stable', editable: true }],
      mods: Array.from({ length: 105 }, (_, index) => ({
        name: `Library Mod ${index + 1}`,
        version: '1.0.0',
        folder_name: `LibraryMod${index + 1}`,
        mod_id: `LibraryMod${index + 1}`,
        installed_enabled: index % 2 === 0,
        profiles: [
          { profile_name: 'Stable', included: false, enabled: false, editable: true },
        ],
      })),
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    expect(await screen.findByText(/Showing 100 of 105/i)).toBeInTheDocument();
    expect(screen.queryByText('Library Mod 105')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Show 5 more/i }));
    expect(await screen.findByText('Library Mod 105')).toBeInTheDocument();
  });

  it.skip('Mod Library search and sort controls work without changing membership', async () => {
    seedProfiles([baseProfile({ name: 'Stable' }), baseProfile({ name: 'Beta' })]);
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [
        { name: 'Stable', editable: true },
        { name: 'Beta', editable: true },
      ],
      mods: [
        {
          name: 'Zeta Stored',
          version: '1.0.0',
          folder_name: 'zeta-folder',
          mod_id: 'zeta-id',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: false, enabled: false, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Alpha Active',
          version: '1.0.0',
          folder_name: 'alpha-folder',
          mod_id: 'alpha-id',
          installed_enabled: true,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
            { profile_name: 'Beta', included: false, enabled: false, editable: true },
          ],
        },
        {
          name: 'Heavy Used',
          display_name: 'Most Used Patch',
          version: '1.0.0',
          folder_name: 'heavy-folder',
          mod_id: 'heavy-id',
          installed_enabled: false,
          profiles: [
            { profile_name: 'Stable', included: true, enabled: true, editable: true },
            { profile_name: 'Beta', included: true, enabled: true, editable: true },
          ],
        },
      ],
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(await screen.findByRole('button', { name: /Mod Library/i }));

    const titles = () => Array.from(document.querySelectorAll('.gf-profile-library-title'))
      .map((el) => el.textContent?.trim() ?? '');
    expect(await screen.findByText('Alpha Active')).toBeInTheDocument();
    expect(titles()[0]).toContain('Alpha Active');

    await user.selectOptions(screen.getByRole('combobox', { name: /Sort/i }), 'nameDesc');
    expect(titles()[0]).toContain('Zeta Stored');

    await user.selectOptions(screen.getByRole('combobox', { name: /Sort/i }), 'activeFirst');
    expect(titles()[0]).toContain('Alpha Active');

    await user.selectOptions(screen.getByRole('combobox', { name: /Sort/i }), 'storedFirst');
    expect(titles()[0]).toContain('Most Used Patch');

    await user.selectOptions(screen.getByRole('combobox', { name: /Sort/i }), 'profilesMost');
    expect(titles()[0]).toContain('Most Used Patch');
    expect(screen.getByText('2 modpacks')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Search Mod Library/i }), 'zeta-folder');
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('Zeta Stored');
    expect(getInvokeCalls().filter((call) => call.cmd === 'set_profile_mod_membership')).toHaveLength(0);

    await user.clear(screen.getByRole('textbox', { name: /Search Mod Library/i }));
    await user.type(screen.getByRole('textbox', { name: /Search Mod Library/i }), 'missing-library-mod');
    expect(await screen.findByText(/No matching mods/i)).toBeInTheDocument();
  });

  it('opens a profile load-order editor and saves the reordered manifest', async () => {
    const user = userEvent.setup();
    seedProfiles([
      baseProfile({
        name: 'Stable',
        mods: [
          {
            name: 'BaseLib',
            version: '1.0.0',
            source: null,
            hash: null,
            files: ['BaseLib/BaseLib.dll'],
            enabled: true,
            bundle_url: null,
            folder_name: 'BaseLib',
            mod_id: 'BaseLib',
          },
          {
            name: 'Card Art Editor',
            version: '2.0.0',
            source: null,
            hash: null,
            files: ['CardArtEditor/CardArtEditor.dll'],
            enabled: true,
            bundle_url: null,
            folder_name: 'CardArtEditor',
            mod_id: 'CardArtEditor',
          },
        ],
      }),
    ]);
    registerInvokeHandler('set_profile_load_order', (args) => {
      expect(args?.profileName).toBe('Stable');
      expect(args?.orderedMods).toEqual([
        { name: 'Card Art Editor', folderName: 'CardArtEditor', modId: 'CardArtEditor' },
        { name: 'BaseLib', folderName: 'BaseLib', modId: 'BaseLib' },
      ]);
      return {
        profile: baseProfile({ name: 'Stable' }),
        settings_status: 'skipped_inactive',
        settings_path: null,
      };
    });

    render(<Wrap />);
    await openDetailFor(user, 'Stable');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /^Load order$/i }));
    const dialog = await screen.findByRole('dialog', { name: /Load order for Stable/i });
    expect(within(dialog).getByText(/Top loads first/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Move BaseLib down/i }));
    await user.click(within(dialog).getByRole('button', { name: /Move BaseLib up/i }));
    await user.click(within(dialog).getByRole('button', { name: /Move Card Art Editor up/i }));
    await user.click(within(dialog).getByRole('button', { name: /Save order/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((call) => call.cmd === 'set_profile_load_order')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Load order saved for Stable/i)).toBeInTheDocument();
    });
  });

  it('profile load-order rows can be reordered with drag and drop', async () => {
    const user = userEvent.setup();
    seedProfiles([
      baseProfile({
        name: 'Stable',
        mods: [
          profileMod({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib' }),
          profileMod({ name: 'Card Art Editor', folder_name: 'CardArtEditor', mod_id: 'CardArtEditor' }),
        ],
      }),
    ]);
    registerInvokeHandler('set_profile_load_order', (args) => {
      expect(args?.orderedMods).toEqual([
        { name: 'Card Art Editor', folderName: 'CardArtEditor', modId: 'CardArtEditor' },
        { name: 'BaseLib', folderName: 'BaseLib', modId: 'BaseLib' },
      ]);
      return {
        profile: baseProfile({ name: 'Stable' }),
        settings_status: 'skipped_inactive',
        settings_path: null,
      };
    });

    render(<Wrap />);
    await openDetailFor(user, 'Stable');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Load order/i }));
    const dialog = await screen.findByRole('dialog', { name: /Load order for Stable/i });
    const baseRow = within(dialog).getByRole('listitem', { name: /BaseLib.*position 1/i });
    const cardRow = within(dialog).getByRole('listitem', { name: /Card Art Editor.*position 2/i });
    const dataTransfer = {
      data: new Map<string, string>(),
      setData(type: string, value: string) { this.data.set(type, value); },
      getData(type: string) { return this.data.get(type) ?? ''; },
      effectAllowed: '',
      dropEffect: '',
    };

    fireEvent.dragStart(cardRow, { dataTransfer });
    fireEvent.dragOver(baseRow, { dataTransfer });
    fireEvent.dragLeave(baseRow, { dataTransfer });
    fireEvent.dragOver(baseRow, { dataTransfer });
    fireEvent.dragEnd(cardRow, { dataTransfer });
    fireEvent.drop(baseRow, { dataTransfer });
    await user.click(within(dialog).getByRole('button', { name: /Save order/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((call) => call.cmd === 'set_profile_load_order')).toBe(true);
    });
  });

  const loadOrderStatusCases: Array<[LoadOrderSettingsStatus, RegExp]> = [
    ['applied', /applied to settings\.save/i],
    ['skipped_missing', /settings\.save was not found/i],
    ['skipped_multiple', /multiple settings\.save files/i],
    ['skipped_game_running', /STS2 is running/i],
    ['failed', /settings\.save could not be updated/i],
  ];

  it.each(loadOrderStatusCases)('load-order save reports %s settings status', async (status, message) => {
    const user = userEvent.setup();
    seedProfiles([baseProfile({ name: 'Stable', mods: [profileMod()] })]);
    registerInvokeHandler('set_profile_load_order', () => ({
      profile: baseProfile({ name: 'Stable', mods: [profileMod()] }),
      settings_status: status,
      settings_path: status === 'applied' ? 'C:/Users/player/settings.save' : null,
    }));

    render(<Wrap />);
    await openDetailFor(user, 'Stable');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /^Load order$/i }));
    const dialog = await screen.findByRole('dialog', { name: /Load order for Stable/i });
    await user.click(within(dialog).getByRole('button', { name: /Save order/i }));

    await waitFor(() => {
      expect(screen.getByText(message)).toBeInTheDocument();
    });
  });

  it('load-order save backend failures leave the editor open and show an error toast', async () => {
    const user = userEvent.setup();
    seedProfiles([baseProfile({ name: 'Stable', mods: [profileMod()] })]);
    registerInvokeHandler('set_profile_load_order', () => {
      throw new Error('settings denied');
    });

    render(<Wrap />);
    await openDetailFor(user, 'Stable');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /^Load order$/i }));
    const dialog = await screen.findByRole('dialog', { name: /Load order for Stable/i });
    await user.click(within(dialog).getByRole('button', { name: /Save order/i }));

    await waitFor(() => {
      expect(screen.getByText(/Failed to save load order: settings denied/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: /Load order for Stable/i })).toBeInTheDocument();
  });

  it('Share button opens the publish modal when profile is unpublished', async () => {
    seedProfiles([baseProfile({ name: 'Unpublished' })]);
    registerInvokeHandler('get_share_info', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'Unpublished');
    const shareBtn = screen.getAllByRole('button').find(
      (b) => /^Share$/.test(b.textContent?.trim() ?? ''),
    );
    expect(shareBtn).toBeDefined();
    await user.click(shareBtn!);
    // Publish modal renders profile name in its title.
    await waitFor(() => {
      expect(screen.getByText(/Publish Unpublished/)).toBeInTheDocument();
    });
  });

  it('Re-share button label appears when profile is already published', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'Published');
    await waitFor(() => {
      expect(
        screen.getAllByRole('button').some((b) => /Re-?share/i.test(b.textContent ?? '')),
      ).toBe(true);
    });
  });

  it('drift banner shows specific change counts (added/removed/toggled)', async () => {
    seedProfiles([baseProfile({ name: 'DriftPack' })]);
    registerInvokeHandler('get_active_profile', () => 'DriftPack');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['NewA', 'NewB'],
      removed: ['GoneC'],
      toggled: ['ToggleD'],
      version_changed: [{ name: 'E', profile_version: '1.0', disk_version: '2.0' }],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftPack')).toBeInTheDocument(); });
    // The active-profile drift banner shows a "2 new · 1 removed · …" summary line.
    await waitFor(() => {
      expect(screen.getByText(/2 new.*1 removed.*1 toggled/)).toBeInTheDocument();
    });
  });

  // T16 — The per-row drift chip (with "re-share to update subscribers")
  // was inline-row meta on the old list. The card view shows a
  // condensed "Out of sync" chip without the wordy hint; the wordy
  // hint moves into ModpackDetail's audit summary (covered there).
  it.skip('drift row chip (non-active profile) shows out-of-sync detail line', async () => {});

  it('switching profile error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'A' }), baseProfile({ name: 'B' })]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => { throw new Error('boom'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'B');
    await user.click(screen.getByRole('button', { name: /Switch to/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to switch.*boom/)).toBeInTheDocument();
    });
  });

  // T16 — the "Active" badge is on the card now. The detail header
  // for an active modpack omits the Switch button entirely (you
  // can't activate what's already active). Re-apply is covered by
  // the drift banner instead — the implicit auto-Switch from the
  // active-row was a workaround for the old inline-row behavior.
  it.skip('Active profile row shows a re-apply button (RefreshCw icon) and clicking it invokes switch_profile', async () => {});

  it('renders Loading state initially', async () => {
    let resolver!: (v: unknown) => void;
    registerInvokeHandler('list_profiles_cmd', () => new Promise((r) => { resolver = r; }));
    render(<Wrap />);
    expect(screen.getByText(/Loading modpacks/i)).toBeInTheDocument();
    resolver([]);
  });

  it('Published tab empty state when no profiles are published', async () => {
    seedProfiles([baseProfile({ name: 'NotShared' })]);
    registerInvokeHandler('get_share_info', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NotShared')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Published by you/i }));
    await waitFor(() => {
      expect(screen.queryByText(/haven't published/i)).toBeInTheDocument();
    });
  });

  // T16 review fix — Copy chips restored on shared modpack cards.
  // The old per-row Copy buttons disappeared in the card restructure;
  // these tests pin the new chip-based affordance. Each chip is a real
  // <button> that lives inside the card, stopPropagation-guards the
  // card click, copies via navigator.clipboard, and toasts.
  it('Copy share code chip on the card copies the chip code + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = setupUserWithClipboard();
    render(<Wrap />);
    // Wait for the card to render with the Shared badge so we know
    // shareInfoMap has populated and the chip row is mounted.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
    });
    const copyBtn = await screen.findByRole('button', { name: 'Copy share code' });
    await user.click(copyBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    });
    // Toast confirms — uses profiles.toast.shareCodeCopied i18n key.
    await waitFor(() => {
      expect(screen.getByText(/Share code copied/)).toBeInTheDocument();
    });
    // Critical: clicking the chip must NOT navigate into the detail
    // view (stopPropagation guard). The list view stays mounted.
    expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
  });

  it('Copy share link chip on the card copies the install link + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
    });
    const linkBtn = await screen.findByRole('button', { name: 'Copy share link' });
    await user.click(linkBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    // buildShareLink emits an https URL with the code query param.
    const calls = clipboardWrite.mock.calls;
    expect((calls[calls.length - 1]?.[0] as string)).toMatch(/i\.html\?c=/);
    await waitFor(() => {
      expect(screen.getByText(/Install link copied/)).toBeInTheDocument();
    });
  });

  it('Copy share link chip clipboard reject surfaces error toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = setupUserWithClipboard(async () => { throw new Error('blocked'); });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
    });
    const linkBtn = await screen.findByRole('button', { name: 'Copy share link' });
    await user.click(linkBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

  it('Copy share message chip on the card copies the paste-ready message + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE',
      url: '', remote_path: 'Published.json',
    }));
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
    });
    const msgBtn = await screen.findByRole('button', { name: 'Copy share message' });
    await user.click(msgBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    const calls = clipboardWrite.mock.calls;
    expect((calls[calls.length - 1]?.[0] as string)).toMatch(/Join my Slay the Spire 2/);
    await waitFor(() => {
      expect(screen.getByText(/Share message copied/)).toBeInTheDocument();
    });
  });

  it('Copy share message chip clipboard reject surfaces error toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = setupUserWithClipboard(async () => { throw new Error('blocked'); });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Published modpack/i })).toBeInTheDocument();
    });
    const msgBtn = await screen.findByRole('button', { name: 'Copy share message' });
    await user.click(msgBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

  // T16 — Kebab menu actions are gone from the row; they live in the
  // detail view's Advanced panel now. These tests open the detail
  // → expand Advanced → click the action.
  it('Advanced → Duplicate fires duplicate_profile + success toast', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    registerInvokeHandler('duplicate_profile', (args) =>
      baseProfile({ name: String(args?.newName) }),
    );
    const origPrompt = window.prompt;
    window.prompt = () => 'Copy of Original';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await openDetailFor(user, 'Original');
      await user.click(screen.getByRole('button', { name: /Advanced/i }));
      await user.click(screen.getByRole('button', { name: /Duplicate/i }));
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'duplicate_profile')).toBe(true);
      });
      await waitFor(() => {
        expect(screen.getByText(/Duplicated as "Copy of Original"/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Advanced → Duplicate prompt cancel skips invoke', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    const origPrompt = window.prompt;
    window.prompt = () => null;
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await openDetailFor(user, 'Original');
      await user.click(screen.getByRole('button', { name: /Advanced/i }));
      await user.click(screen.getByRole('button', { name: /Duplicate/i }));
      expect(getInvokeCalls().some((c) => c.cmd === 'duplicate_profile')).toBe(false);
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Advanced → Duplicate error path surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    registerInvokeHandler('duplicate_profile', () => { throw new Error('exists'); });
    const origPrompt = window.prompt;
    window.prompt = () => 'Dup';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await openDetailFor(user, 'Original');
      await user.click(screen.getByRole('button', { name: /Advanced/i }));
      await user.click(screen.getByRole('button', { name: /Duplicate/i }));
      await waitFor(() => {
        expect(screen.getByText(/Failed to duplicate.*exists/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Advanced → Export JSON fires export_profile_cmd + success toast', async () => {
    seedProfiles([baseProfile({ name: 'Exportable' })]);
    registerInvokeHandler('export_profile_cmd', () => '{"name":"Exportable","mods":[]}');
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await openDetailFor(user, 'Exportable');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Export JSON/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'export_profile_cmd')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Modpack JSON copied to clipboard/)).toBeInTheDocument();
    });
    expect(clipboardWrite).toHaveBeenCalledWith('{"name":"Exportable","mods":[]}');
  });

  it('Advanced → Export JSON error path surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('export_profile_cmd', () => { throw new Error('locked'); });
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await openDetailFor(user, 'X');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Export JSON/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to export.*locked/)).toBeInTheDocument();
    });
  });

  it('Advanced → Snapshot from current install fires snapshot_profile after prompt', async () => {
    seedProfiles([baseProfile({ name: 'A' })]);
    registerInvokeHandler('snapshot_profile', (args) => baseProfile({ name: String(args?.name) }));
    const origPrompt = window.prompt;
    window.prompt = () => 'Snap-X';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await openDetailFor(user, 'A');
      await user.click(screen.getByRole('button', { name: /Advanced/i }));
      await user.click(screen.getByRole('button', { name: /Snapshot from current/i }));
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(true);
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Advanced → Delete profile opens confirm modal → confirms → invokes delete_profile_cmd + toast', async () => {
    seedProfiles([baseProfile({ name: 'Doomed' })]);
    registerInvokeHandler('delete_profile_cmd', () => null);
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await openDetailFor(user, 'Doomed');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Delete modpack/i }));
    await waitFor(() => {
      expect(screen.getByText(/Delete modpack "Doomed"/)).toBeInTheDocument();
    });
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: /Delete modpack/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'delete_profile_cmd' && c.args?.name === 'Doomed',
      )).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Modpack "Doomed" deleted/)).toBeInTheDocument();
    });
  });

  it('Advanced → Delete profile Cancel skips invoke', async () => {
    seedProfiles([baseProfile({ name: 'SafePack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'SafePack');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Delete modpack/i }));
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Cancel' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'delete_profile_cmd')).toBe(false);
  });

  it('Advanced → Delete profile error path surfaces toast', async () => {
    seedProfiles([baseProfile({ name: 'Stubborn' })]);
    registerInvokeHandler('delete_profile_cmd', () => { throw new Error('busy'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'Stubborn');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Delete modpack/i }));
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: /Delete modpack/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to delete.*busy/)).toBeInTheDocument();
    });
  });

  // Removed: 5 legacy kebab-Copy tests. The per-row kebab menu was
  // replaced by the card-based list (T16); Copy actions now live as
  // inline chips on the shared modpack card, covered by the 5 tests
  // above. The PublishModal's success-view copy buttons are exercised
  // separately in PublishModal.test.tsx.

  it('Import-by-code with a brand-new code installs via the smart router', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    // No matching subscription → smart router falls through to install path.
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'NewPack', mods: [{ name: 'A', source: 'https://github.com/owner/repo' } as any], created_at: '2026-01-01',
      created_by: null,
    }));
    registerInvokeHandler('install_shared_profile', () => baseProfile({ name: 'NewPack' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    // Confirm dialog ("Install this modpack?") renders. Accept it.
    const installConfirm = await screen.findByRole('button', { name: /Install \d+ mod/i });
    await user.click(installConfirm);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'install_shared_profile')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Imported modpack "NewPack"/)).toBeInTheDocument();
    });
  });

  it('Import-by-code Enter key submits via onKeyDown handler', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'EnterPack', mods: [], created_at: '2026-01-01', created_by: null,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE{Enter}');
    // Confirm dialog appears.
    await waitFor(() => {
      expect(screen.getByText(/Install this modpack/)).toBeInTheDocument();
    });
  });

  it('Import-by-code empty trim skips work', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    expect(getInvokeCalls().some((c) => c.cmd === 'fetch_shared_profile_cmd')).toBe(false);
  });

  it('Import-by-code cancel via Cancel button on confirm produces no toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'NewPack', mods: [], created_at: '2026-01-01', created_by: null,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    // Cancel the confirm modal — scope to its foot to dodge the
    // Add-by-code form Cancel button below.
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText(/Imported modpack/)).toBeNull();
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'install_shared_profile')).toBe(false);
  });

  it('Import-by-code error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('get_subscriptions', () => []);
    registerInvokeHandler('fetch_shared_profile_cmd', () => { throw new Error('not found'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to import.*not found/)).toBeInTheDocument();
    });
  });

  it('Import-by-code already-active path re-applies the active pack', async () => {
    seedProfiles([baseProfile({ name: 'Match' })]);
    registerInvokeHandler('get_active_profile', () => 'Match');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'Match' },
    ]);
    // No subUpdates means the smart router re-applies the active profile
    // so missing bundled mods can be restored.
    registerInvokeHandler('check_subscription_updates', () => []);
    registerInvokeHandler('switch_profile', () => ({
      applied: true, downloaded: 0, missing_mods: [], failed_downloads: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Match')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await waitFor(() => {
      expect(screen.getByText(/Re-applied "Match"\./)).toBeInTheDocument();
    });
  });

  it('Import-by-code switch path (subscribed but not active) confirms then activates', async () => {
    seedProfiles([
      baseProfile({ name: 'CurrentActive' }),
      baseProfile({ name: 'OtherInstalled' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'CurrentActive');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'OtherInstalled' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => []);
    registerInvokeHandler('switch_profile', () => ({
      applied: true, downloaded: 0, missing_mods: [], failed_downloads: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OtherInstalled')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    // Smart router pops a "Switch to OtherInstalled?" confirm. Scope the
    // Activate button query to the modal foot to dodge the row's
    // "Switch to" button (which also matches /Activate/ via its title).
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: /Activate$/ }));
    await waitFor(() => {
      expect(screen.getByText(/Switched to "OtherInstalled"/)).toBeInTheDocument();
    });
    // Smart router toast uses outcome.profileName; the row-switch path uses
    // the typed name. Either way we land at this toast, so to prove the
    // smart-router branch fired specifically, check switch_profile was
    // called with the *match* profile, not whatever the row click would've
    // hit. The row's Switch-to button on OtherInstalled is gated by the
    // disabled flag while switching, but we still want to disambiguate.
    expect(getInvokeCalls().some(
      (c) => c.cmd === 'switch_profile' && c.args?.name === 'OtherInstalled',
    )).toBe(true);
  });

  it('Import-by-code pending-update path applies via confirm', async () => {
    seedProfiles([baseProfile({ name: 'MyPack' })]);
    registerInvokeHandler('get_active_profile', () => 'MyPack');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'MyPack' },
    ]);
    registerInvokeHandler('check_subscription_updates', () => [
      {
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'MyPack',
        has_update: true,
        added_mods: [{ name: 'New' }],
        updated_mods: [],
        removed_mods: [],
      },
    ]);
    registerInvokeHandler('apply_subscription_update', () => baseProfile({ name: 'MyPack' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getAllByText('MyPack').length).toBeGreaterThan(0); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    // Confirm modal opens with "Apply pending update?" title — click its Apply.
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: /Apply update/i }));
    await waitFor(() => {
      expect(screen.getByText(/Synced "MyPack"/)).toBeInTheDocument();
    });
  });

  it('renders profile game_version on the row when present', async () => {
    seedProfiles([baseProfile({ name: 'X', game_version: '0.105.0' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.queryByText('0.105.0')).toBeInTheDocument();
  });

  it('renders profile created_by attribution when present', async () => {
    seedProfiles([baseProfile({ name: 'X', created_by: 'alice' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.queryByText(/by alice/)).toBeInTheDocument();
  });

  it('Detail Switch button shows for non-active profile but is omitted for active', async () => {
    seedProfiles([
      baseProfile({ name: 'ActiveP' }),
      baseProfile({ name: 'OtherP' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'ActiveP');
    const user = userEvent.setup();
    render(<Wrap />);

    // Non-active modpack detail surfaces "Switch to".
    await openDetailFor(user, 'OtherP');
    expect(screen.getByRole('button', { name: /Switch to/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back to modpacks/i }));

    // Active modpack detail: Switch is not rendered (you can't activate
    // what's already active). The active badge replaces it.
    await openDetailFor(user, 'ActiveP');
    expect(screen.queryByRole('button', { name: /Switch to/i })).toBeNull();
  });

  it('Snapshot button is in the page header', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /Snapshot active modpack/ })).toBeInTheDocument();
  });

  it('header toolbar toggles: Add modpack code closes Import modpack JSON + Create forms', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    // Open Import modpack JSON first.
    await user.click(screen.getByRole('button', { name: /Import modpack JSON/ }));
    expect(screen.getByPlaceholderText(/"name":/)).toBeInTheDocument();
    // Then click Add modpack code — it should hide Import modpack JSON.
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    expect(screen.queryByPlaceholderText(/"name":/)).toBeNull();
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
  });

  it('header toolbar: Create modpack closes the Add modpack code inline form', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add modpack code/i }));
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    // Inline "Add modpack code" panel collapses, and the guided wizard mounts.
    expect(screen.queryByPlaceholderText(/username\/XXXX/)).toBeNull();
    expect(
      await screen.findByRole('button', { name: /start from my active mods/i }),
    ).toBeInTheDocument();
  });

  it('PublishModal onShared callback patches shareInfoMap (Share label flips to Re-share)', async () => {
    // Start unpublished.
    seedProfiles([baseProfile({ name: 'Fresh' })]);
    registerInvokeHandler('get_share_info', () => null);
    // share_profile invoke succeeds; PublishModal will call onShared with the result.
    registerInvokeHandler('share_profile', () => ({
      owner: 'me', code: 'NEWC-ODE0-0000', url: '', remote_path: 'Fresh.json',
      failed_uploads: [],
    }));
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false, github_token_set: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'Fresh');
    const shareBtn = screen.getAllByRole('button').find(
      (b) => /^Share$/.test(b.textContent?.trim() ?? ''),
    );
    expect(shareBtn).toBeDefined();
    await user.click(shareBtn!);
    // Publish modal opens — find its primary Publish button.
    const publishBtn = await screen.findByRole('button', { name: /^Publish$/ });
    await user.click(publishBtn);
    // Wait for share_profile to fire.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'share_profile')).toBe(true);
    });
    // Close the modal so the detail header re-renders with the patched share info.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    // The detail header's button label flipped from Share to Re-share
    // via the optimistic shareInfoMap patch.
    await waitFor(() => {
      expect(
        screen.getAllByRole('button').some((b) => /Re-share/i.test(b.textContent ?? '')),
      ).toBe(true);
    });
  });

  it('activity feed pluralizes correctly with 2+ pack updates', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' }), baseProfile({ name: 'Beta' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 's1', profile_name: 'Alpha', has_update: true, added_mods: [], updated_mods: [], removed_mods: [] },
      { share_id: 's2', profile_name: 'Beta', has_update: true, added_mods: [], updated_mods: [], removed_mods: [] },
    ]);
    render(<Wrap />);
    // 2 modpacks → "2 modpacks have updates".
    await waitFor(() => {
      expect(screen.getByText(/2 modpacks have updates/)).toBeInTheDocument();
    });
    // Activity row with no added/updated/removed counts falls back to the
    // generic "curator pushed an update" summary (covers the `||` fallback
    // on the filter(Boolean).join).
    expect(screen.getAllByText(/curator pushed an update/).length).toBeGreaterThan(0);
  });

  it('drift banner detail with empty arrays but has_drift falls back to the generic message', async () => {
    seedProfiles([baseProfile({ name: 'GenericDrift' })]);
    registerInvokeHandler('get_active_profile', () => 'GenericDrift');
    registerInvokeHandler('get_profile_drift', () => ({
      added: [],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('GenericDrift')).toBeInTheDocument(); });
    // The fallback string from `... || 'modpack and disk are out of sync'`.
    await waitFor(() => {
      expect(screen.getByText(/modpack and disk are out of sync/)).toBeInTheDocument();
    });
  });

  it.skip('drift row chip pluralizes "versions changed" when version_changed > 1', async () => {
    seedProfiles([baseProfile({ name: 'MultiVer' })]);
    registerInvokeHandler('get_active_profile', () => 'MultiVer');
    registerInvokeHandler('get_profile_drift', () => ({
      added: [],
      removed: [],
      toggled: [],
      version_changed: [
        { name: 'A', profile_version: '1', disk_version: '2' },
        { name: 'B', profile_version: '1', disk_version: '2' },
      ],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('MultiVer')).toBeInTheDocument(); });
    await waitFor(() => {
      expect(screen.getByText(/2 versions changed/)).toBeInTheDocument();
    });
  });

  it.skip('drift row chip handles version_changed = null (uses ?? fallback)', async () => {
    seedProfiles([baseProfile({ name: 'NoVerField' })]);
    registerInvokeHandler('get_active_profile', () => 'NoVerField');
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['x'],
      removed: [],
      toggled: [],
      // version_changed missing entirely (older payloads).
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('NoVerField')).toBeInTheDocument(); });
    // The row chip renders with the "1 new mod" detail; version_changed
    // branch falls to the `?? []` and `?? 0` fallbacks.
    await waitFor(() => {
      expect(screen.getByText(/1 new mod/)).toBeInTheDocument();
    });
  });

  // handleCreate non-Error throw coverage moved to
  // CreateModpackWizard.test.tsx along with the rest of the create
  // flow when the inline form was removed.

  it('non-Error throws fall through to String() formatter (apply sub update)', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 's1', profile_name: 'Alpha', has_update: true, added_mods: [], updated_mods: [], removed_mods: [{ name: 'X' }] },
    ]);
    registerInvokeHandler('apply_subscription_update', () => { throw 'apply-broke'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply update/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Apply update/ }));
    await waitFor(() => {
      expect(screen.getByText(/Sync failed.*apply-broke/)).toBeInTheDocument();
    });
  });

  it('Published tab shows only profiles in shareInfoMap (card-based list)', async () => {
    // T16 review fix — re-enabled after the row → card-list switch.
    // Selectors now target the cards' aria-label ("Open <name> modpack")
    // since the card text alone overlaps the share-code chip text.
    seedProfiles([
      baseProfile({ name: 'Unshared' }),
      baseProfile({ name: 'Shared' }),
    ]);
    registerInvokeHandler('get_share_info', (args: any) => {
      if (args?.name === 'Shared') {
        return { owner: 'me', code: 'AAAA-AAAA-AAAA', url: '', remote_path: 'Shared.json' };
      }
      return null;
    });
    const user = userEvent.setup();
    render(<Wrap />);
    // Default "Following" tab shows both cards.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Open Shared modpack/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Open Unshared modpack/i })).toBeInTheDocument();
    // Switch to Published tab — wait for share info to resolve so the
    // filter has populated shareInfoMap.
    await user.click(screen.getByRole('button', { name: /Published by you/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Open Unshared modpack/i })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /Open Shared modpack/i })).toBeInTheDocument();
  });
});

// ── 1.7.0 v7 — Quick-Add code paste input relocated from Home ──────────
//
// Home is now the single-block launcher; the share-code input lives in
// the Modpacks toolbar above the Yours/Browse tabs.
//
// Behavioral contracts:
//   - The input is ALWAYS visible on the Yours tab toolbar (not gated on
//     a "show code panel" toggle).
//   - It has an aria-label so screen readers can find it.
//   - Add button submits, runs `importShareCodeSmart` (which fetches
//     the manifest and routes to the install / activate / sync /
//     apply-update branch), and the existing toast+confirm pipeline
//     fires per outcome.
//   - The same focus signal that the App fires from ProfileSwitcher's
//     "Add pack" focuses the input.
describe('<ProfilesView> toolbar Quick-Add (relocated from Home v7)', () => {
  it('Quick-Add input is visible in the Modpacks toolbar (no toggle required)', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    // The new input has an aria-label matching the label key.
    expect(
      screen.getByLabelText(/Add a modpack by code/i),
    ).toBeInTheDocument();
    // And an "Add" button right next to it.
    expect(
      screen.getByRole('button', { name: /^Add$/i }),
    ).toBeInTheDocument();
  });

  it('Quick-Add input is hidden on the Browse tab (modpack management lives on Yours)', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('fetch_modpack_browser_page', () => ({
      cards: [],
      page: 1,
      has_next_page: false,
      stale: false,
      fetched_at: Math.floor(Date.now() / 1000),
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    // Sanity — visible on Yours.
    expect(screen.getByLabelText(/Add a modpack by code/i)).toBeInTheDocument();
    // Switch to Browse — the toolbar Quick-Add row hides because
    // it's part of the Yours surface.
    await user.click(screen.getByRole('button', { name: /^Browse$/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Add a modpack by code/i)).toBeNull();
  });

  it('"Add" button is disabled when the input is empty', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    const input = screen.getByLabelText(/Add a modpack by code/i) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: /^Add$/i })).toBeDisabled();
  });

  it('typing a code + clicking Add fires the import-share-code pipeline', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    // Smart-router success path: fetch_shared_profile_cmd returns a
    // manifest, the confirm dialog fires, then install_shared_profile.
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
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });
    const input = screen.getByLabelText(/Add a modpack by code/i);
    await user.type(input, 'alice/AAAA-BBBB-CCCC');
    const addBtn = screen.getByRole('button', { name: /^Add$/i });
    expect(addBtn).toBeEnabled();
    await user.click(addBtn);
    // The smart router triggers fetch_shared_profile_cmd at minimum.
    await waitFor(() => {
      const cmds = getInvokeCalls().map((c) => c.cmd);
      expect(
        cmds.some((c) =>
          c === 'fetch_shared_profile_cmd' ||
          c === 'install_shared_profile' ||
          c === 'get_share_info',
        ),
      ).toBe(true);
    });
  });

  it('pressing Enter in the Quick-Add input also submits', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });
    const input = screen.getByLabelText(/Add a modpack by code/i);
    await user.type(input, 'alice/AAAA-BBBB-CCCC{Enter}');
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'fetch_shared_profile_cmd')).toBe(true);
    });
  });

  it('focusQuickAddSignal bump focuses the toolbar input (used by ProfileSwitcher Add pack)', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    const { rerender } = render(<Wrap focusQuickAddSignal={1} />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    // The effect fires inside a requestAnimationFrame — wait until the
    // input is the active element.
    await waitFor(() => {
      const input = screen.getByLabelText(/Add a modpack by code/i);
      expect(document.activeElement).toBe(input);
    });
    // Bumping the signal re-runs the effect — input remains focusable
    // after another bump.
    rerender(<Wrap focusQuickAddSignal={2} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Add a modpack by code/i)).toBeInTheDocument();
    });
  });

  it('failing import surfaces a "Failed to import" toast (error pipeline preserved)', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    registerInvokeHandler('fetch_shared_profile_cmd', () => { throw new Error('manifest not found'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });
    const input = screen.getByLabelText(/Add a modpack by code/i);
    await user.type(input, 'unknown/AAAA-BBBB-CCCC{Enter}');
    await waitFor(() => {
      expect(screen.getByText(/Failed to import: manifest not found/)).toBeInTheDocument();
    });
  });
});

// ── 1.7.0 T8 — CreateModpackWizard onCreated integration ────────────
//
// The wizard itself is tested in CreateModpackWizard.test.tsx — these
// integration tests pin Profiles.tsx's `onCreated` handler:
//   - Closes the wizard.
//   - Toasts the success message with the created name.
//   - Reloads the profile list so the new modpack shows up immediately.
//   - When sharedNow=true, also fetches the fresh list and opens the
//     PublishModal targeted at the newly created profile.
describe('<ProfilesView> CreateModpackWizard onCreated handler', () => {
  // Drives the wizard from open → name input → click create. Returns
  // when the create button has been clicked; callers wait for the
  // expected post-condition.
  async function completeWizard(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
    shareNow: boolean,
  ): Promise<void> {
    // Step 1.
    await user.click(await screen.findByRole('button', { name: /start from my active mods/i }));
    // Step 2 — Next.
    await user.click(await screen.findByRole('button', { name: /^next$/i }));
    // Step 3 — Continue anyway (skips the health audit).
    await user.click(await screen.findByRole('button', { name: /continue anyway/i }));
    // Step 4 — name + click the appropriate create button. Scope the
    // button lookup to the wizard dialog because the toolbar's Create
    // modpack button is also on the page.
    const nameInput = await screen.findByLabelText(/modpack name/i);
    fireEvent.change(nameInput, { target: { value: name } });
    const dialog = await screen.findByRole('dialog', { name: 'Create modpack' });
    if (shareNow) {
      await user.click(within(dialog).getByRole('button', { name: /create and share now/i }));
    } else {
      await user.click(within(dialog).getByRole('button', { name: /^create modpack$/i }));
    }
  }

  it('sharedNow=false → toasts success, closes wizard, reloads list with new pack visible', async () => {
    // The list-profiles mock returns "Existing" until create_profile
    // fires, after which the next read includes the newly created
    // "Brand New" pack. Drives the loadProfiles() reload that Profiles
    // fires inside onCreated.
    let createdName: string | null = null;
    registerInvokeHandler('list_profiles_cmd', () => {
      const base: Profile[] = [baseProfile({ name: 'Existing' })];
      return createdName ? [...base, baseProfile({ name: createdName })] : base;
    });
    registerInvokeHandler('create_profile', (args) => {
      createdName = String(args?.name);
      return baseProfile({ name: createdName });
    });
    registerInvokeHandler('set_profile_mod_membership', (args) =>
      baseProfile({ name: String(args?.profileName ?? '') }),
    );

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });

    // Open the wizard via the toolbar Create modpack button.
    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    await completeWizard(user, 'Brand New', /* shareNow */ false);

    // The onCreated handler fired the success toast with the trimmed name.
    await waitFor(() => {
      expect(screen.getByText(/Modpack "Brand New" created/)).toBeInTheDocument();
    });
    // The reload picked up the new pack — its card appears in the list.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Open Brand New modpack/i }),
      ).toBeInTheDocument();
    });
    // The wizard itself is gone (step-1 trigger no longer present).
    expect(
      screen.queryByRole('button', { name: /start from my active mods/i }),
    ).toBeNull();
    // PublishModal did NOT open — sharedNow was false.
    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull();
  });

  it('sharedNow=true → fetches fresh list, opens PublishModal for the new pack', async () => {
    // Same setup, but the user clicks "Create and share now". The
    // Profiles onCreated handler must:
    //   - Close the wizard.
    //   - Reload profiles.
    //   - Pull the fresh list a SECOND time via listProfiles and find
    //     the new pack.
    //   - Open the PublishModal targeted at that profile.
    let createdName: string | null = null;
    registerInvokeHandler('list_profiles_cmd', () => {
      const base: Profile[] = [baseProfile({ name: 'Existing' })];
      return createdName ? [...base, baseProfile({ name: createdName })] : base;
    });
    registerInvokeHandler('create_profile', (args) => {
      createdName = String(args?.name);
      return baseProfile({ name: createdName });
    });
    registerInvokeHandler('set_profile_mod_membership', (args) =>
      baseProfile({ name: String(args?.profileName ?? '') }),
    );
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false, github_token_set: true,
    }));

    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });

    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    await completeWizard(user, 'Sharable Pack', /* shareNow */ true);

    // Wizard closes and the success toast fires.
    await waitFor(() => {
      expect(screen.getByText(/Modpack "Sharable Pack" created/)).toBeInTheDocument();
    });
    // PublishModal opens because sharedNow=true — its Publish button is
    // a unique fingerprint not present anywhere else on the page.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Publish$/ })).toBeInTheDocument();
    });
  });

  it('wizard Cancel closes the wizard via the onClose handler (Profiles → setShowCreateWizard(false))', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });
    // Open the wizard.
    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Create modpack' });
    // Click the wizard's Cancel button — fires the onClose prop, which
    // is Profiles.tsx's `() => setShowCreateWizard(false)`.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // Dialog drops out of the DOM.
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Create modpack' }),
      ).toBeNull();
    });
  });

  it('sharedNow=true but the fresh list does NOT contain the name → no PublishModal opens', async () => {
    // Edge case in the onCreated handler: if the second listProfiles
    // call doesn't find the profile (race condition, backend race), we
    // must NOT open PublishModal with a null profile. The conditional
    // `if (profile)` guards that path — exercise it.
    let secondCall = false;
    registerInvokeHandler('list_profiles_cmd', () => {
      // First read for loadProfiles → empty list.
      // Second read inside onCreated → ALSO empty (race).
      if (secondCall) return [];
      secondCall = true;
      return [];
    });
    registerInvokeHandler('create_profile', (args) =>
      baseProfile({ name: String(args?.name) }),
    );
    registerInvokeHandler('set_profile_mod_membership', (args) =>
      baseProfile({ name: String(args?.profileName ?? '') }),
    );

    const user = userEvent.setup();
    render(<Wrap />);
    // Wait for the empty-state header to confirm initial loadProfiles.
    await waitFor(() => {
      expect(screen.getByText(/No modpacks yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Create modpack/i }));
    await completeWizard(user, 'Ghost Pack', /* shareNow */ true);

    // Toast still fires.
    await waitFor(() => {
      expect(screen.getByText(/Modpack "Ghost Pack" created/)).toBeInTheDocument();
    });
    // PublishModal is NOT opened — the fresh list didn't have the pack.
    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull();
  });
});

// ── Profile-list orphan guard + selectedModpack reset ──────────────
//
// Pins the effect at Profiles.tsx ~280: if the open detail view's
// modpack disappears from the loaded list (deleted while detail is
// open, or pumped open before the list resolves), the effect must
// bounce back to the list. That branch covers `setSelectedModpack(null)`
// which is otherwise only reachable via the explicit Back button.
describe('<ProfilesView> orphan-modpack guard', () => {
  it('signal-driven selection of an active profile that is not in the list bounces back to the list', async () => {
    // Race condition: openActiveModpackSignal fires while activeProfile
    // is "Ghost" but the loaded profiles list is just [Alpha]. The
    // signal effect sets selectedModpack='Ghost'; the orphan guard
    // effect notices Ghost isn't in profiles and resets it.
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    registerInvokeHandler('get_active_profile', () => 'Ghost');
    render(<Wrap openActiveModpackSignal={1} />);
    // The list view header is the proof — its "modpack-grid" cards
    // appear when selectedModpack is null. The Ghost detail header
    // never settles because the orphan guard ejects us out.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Open Alpha modpack/i }),
      ).toBeInTheDocument();
    });
    // No detail-view header for Ghost — guard kicked in.
    expect(screen.queryByRole('heading', { level: 2, name: 'Ghost' })).toBeNull();
  });

  it('bouncing back to the list when the selected modpack disappears', async () => {
    // Start with two packs, open Alpha's detail, then delete it. The
    // effect notices Alpha is gone from `profiles` and resets
    // selectedModpack → list re-renders without the detail header.
    const initialProfiles = [baseProfile({ name: 'Alpha' }), baseProfile({ name: 'Beta' })];
    let live = [...initialProfiles];
    registerInvokeHandler('list_profiles_cmd', () => live);
    registerInvokeHandler('delete_profile', (args) => {
      live = live.filter((p) => p.name !== String(args?.name));
      return true;
    });

    const user = userEvent.setup();
    render(<Wrap />);
    // Open Alpha detail.
    await openDetailFor(user, 'Alpha');
    // Inside the detail view, expand Advanced and click Delete. The
    // detail's own onDelete handler also calls setSelectedModpack(null)
    // when it sees the deleted name matches the open one — to isolate
    // the guard effect, we just rely on this happy path which fires
    // the same setSelectedModpack and proves the bounce works.
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    // The Advanced action button label is "Delete modpack..." (with the
    // trailing ellipsis denoting a confirmation step).
    await user.click(screen.getByRole('button', { name: /Delete modpack\.\.\./i }));
    // Confirm the destructive prompt — its confirm button is just
    // "Delete modpack" (no ellipsis).
    const foot = await waitFor(() => {
      const f = document.querySelector('.gf-modal-back .gf-modal .gf-modal-foot');
      if (!f) throw new Error('confirm modal foot not mounted');
      return f as HTMLElement;
    });
    await user.click(within(foot).getByRole('button', { name: /^Delete modpack$/i }));
    // After delete, the list view re-renders without Alpha and without
    // the detail-view heading. Beta is still in the list.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 2, name: 'Alpha' })).toBeNull();
    });
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});

// ── Load-order modal close path ────────────────────────────────────
//
// closeLoadOrderEditor (Profiles.tsx ~312) resets the draft + clears
// the modal when not saving. The save path is already covered by the
// existing modal tests; this fills in the explicit Cancel branch.
// ── Card keyboard navigation + chip wrapper stopPropagation ──────────
describe('<ProfilesView> card keyboard + chip wrapper', () => {
  it('pressing Enter on a modpack card opens its detail view (covers onKeyDown handler)', async () => {
    seedProfiles([baseProfile({ name: 'KeyboardPack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Open KeyboardPack modpack/i }),
      ).toBeInTheDocument();
    });
    // Tab into the card, then press Enter — should fire the keyDown
    // handler's preventDefault + setSelectedModpack branch.
    const card = screen.getByRole('button', { name: /Open KeyboardPack modpack/i });
    card.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: 'KeyboardPack' }),
      ).toBeInTheDocument();
    });
  });

  it('pressing Space on a modpack card opens its detail view (Space branch of onKeyDown)', async () => {
    seedProfiles([baseProfile({ name: 'SpacePack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Open SpacePack modpack/i }),
      ).toBeInTheDocument();
    });
    const card = screen.getByRole('button', { name: /Open SpacePack modpack/i });
    card.focus();
    await user.keyboard(' ');
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: 'SpacePack' }),
      ).toBeInTheDocument();
    });
  });

  it('clicking the bare chip-wrapper area does NOT navigate (covers wrapper stopPropagation)', async () => {
    // The chip wrapper div has an onClick={stopPropagation} that fires
    // when the user clicks the spacing between chips. Without it, the
    // card's outer onClick would still navigate. Click the wrapper
    // directly to exercise the handler.
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = setupUserWithClipboard();
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Open Published modpack/i }),
      ).toBeInTheDocument();
    });
    // Wait for the share-chip row to mount (it only renders after
    // shareInfoMap has the entry).
    const wrapper = await waitFor(() => {
      const w = document.querySelector('.gf-modpack-card-copy-chips');
      if (!w) throw new Error('chip wrapper not mounted');
      return w as HTMLElement;
    });
    await user.click(wrapper);
    // The card's outer button stays on the list view — no detail-view
    // heading appears.
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Published' }),
    ).toBeNull();
  });
});

describe('<ProfilesView> load-order editor close', () => {
  it('Cancel button closes the load-order modal (covers closeLoadOrderEditor)', async () => {
    // The Modpack detail view exposes "Edit load order" inside its
    // Advanced section. Click it, then click Cancel — the dialog
    // closes and the user returns to the detail view.
    seedProfiles([
      baseProfile({
        name: 'OrderPack',
        mods: [profileMod({ name: 'Mod1', folder_name: 'Mod1' })],
      }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'OrderPack');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(await screen.findByRole('button', { name: /^Load order$/i }));
    // Modal mounted — find the modal's Cancel button.
    const dialog = await screen.findByRole('dialog', { name: /Load order for OrderPack/i });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));
    // Modal closes — the dialog drops out of the DOM.
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /Load order for OrderPack/i }),
      ).toBeNull();
    });
  });

  it('moveLoadOrderItem swap reorders the draft (covers moveLoadOrderItem path used by ▲/▼ buttons)', async () => {
    seedProfiles([
      baseProfile({
        name: 'OrderPack',
        mods: [
          profileMod({ name: 'First', folder_name: 'First' }),
          profileMod({ name: 'Second', folder_name: 'Second' }),
        ],
      }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await openDetailFor(user, 'OrderPack');
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(await screen.findByRole('button', { name: /^Load order$/i }));
    // The list renders with rank 1 = First, rank 2 = Second. Click the
    // Down arrow on First to move it to position 2.
    const moveDown = await screen.findByRole('button', { name: /Move First down/i });
    await user.click(moveDown);
    // After the swap, the rank-1 row's name should now be Second.
    const dialog = screen.getByRole('dialog', { name: /Load order for OrderPack/i });
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Second');
    expect(rows[1]).toHaveTextContent('First');
  });
});



