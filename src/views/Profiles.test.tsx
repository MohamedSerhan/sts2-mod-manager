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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProfilesView } from './Profiles';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { Profile } from '../types';

function Wrap() {
  return (
    <AllProviders>
      <ProfilesView />
    </AllProviders>
  );
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

function seedProfiles(profiles: Profile[]): void {
  registerInvokeHandler('list_profiles_cmd', () => profiles);
}

// jsdom doesn't ship a real Clipboard. Some browsers expose a real
// Clipboard prototype with writeText on the proto; a plain
// defineProperty on the navigator.clipboard instance is shadowed by the
// proto getter. Install on the proto when present; otherwise fall back
// to defining the whole property on navigator. Returns the mock for
// assertions.
let clipboardWrite: ReturnType<typeof vi.fn>;
function installClipboard(fn: (text: string) => Promise<void> = async () => {}) {
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
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
}

beforeEach(() => {
  installClipboard();
});

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
      expect(screen.getByText(/No profiles yet/i)).toBeInTheDocument();
    });
  });

  it('renders profile cards with active badge for the active profile', async () => {
    seedProfiles([
      baseProfile({ name: 'Alpha' }),
      baseProfile({ name: 'Beta' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'Alpha');
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('opens the create form and creates a profile on Create click', async () => {
    seedProfiles([baseProfile({ name: 'Existing' })]);
    registerInvokeHandler('create_profile', (args) => baseProfile({ name: String(args?.name) }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Existing')).toBeInTheDocument(); });

    await user.click(screen.getByRole('button', { name: /New profile/ }));
    const input = await screen.findByPlaceholderText('My Profile');
    await user.type(input, 'Vacation Pack');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'create_profile' && c.args?.name === 'Vacation Pack',
      )).toBe(true);
    });
    // Toast text confirms the success branch ran.
    await waitFor(() => {
      expect(screen.getByText(/Profile "Vacation Pack" created/)).toBeInTheDocument();
    });
  });

  it('Create form Enter key submits via onKeyDown handler', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('create_profile', (args) => baseProfile({ name: String(args?.name) }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /New profile/ }));
    const input = await screen.findByPlaceholderText('My Profile');
    await user.type(input, 'KeyCreated{Enter}');
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'create_profile' && c.args?.name === 'KeyCreated',
      )).toBe(true);
    });
  });

  it('create_profile error surfaces an error toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('create_profile', () => { throw new Error('disk full'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /New profile/ }));
    const input = await screen.findByPlaceholderText('My Profile');
    await user.type(input, 'Bad');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to create profile.*disk full/)).toBeInTheDocument();
    });
  });

  it('Cancel button in the create form hides the input', async () => {
    seedProfiles([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/No profiles yet/i)).toBeInTheDocument();
    });
    const newBtns = screen.getAllByRole('button', { name: /New profile/ });
    await user.click(newBtns[0]);
    expect(screen.getByPlaceholderText('My Profile')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('My Profile')).toBeNull();
  });

  it('refuses to submit when the name is empty (whitespace only)', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /New profile/ }));
    const input = await screen.findByPlaceholderText('My Profile');
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'create_profile')).toBe(false);
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
      expect(screen.getByText(/pack has updates|packs have updates/i)).toBeInTheDocument();
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
    const user = userEvent.setup();
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

  it('Snapshot current invokes snapshot_profile via the prompt + success toast', async () => {
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
      await user.click(screen.getByRole('button', { name: /Snapshot current/ }));
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
      await user.click(screen.getByRole('button', { name: /Snapshot current/ }));
      await waitFor(() => {
        expect(screen.getByText(/Failed to snapshot.*readonly/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

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
    await waitFor(() => { expect(screen.getByText('B')).toBeInTheDocument(); });
    const activate = screen.getAllByRole('button').find((b) => /Switch to/.test(b.textContent ?? ''));
    expect(activate).toBeDefined();
    await user.click(activate!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Switched to profile "B"/)).toBeInTheDocument();
    });
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
    await waitFor(() => { expect(screen.getByText('B')).toBeInTheDocument(); });
    const activate = screen.getAllByRole('button').find((b) => /Switch to/.test(b.textContent ?? ''));
    expect(activate).toBeDefined();
    await user.click(activate!);
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
  });

  it('Import-by-code Cancel hides the form', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Import JSON/ }));
    const textarea = await screen.findByPlaceholderText(/"name":/);
    await user.click(textarea);
    await user.paste('{"name":"X"}');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'import_profile_cmd')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Imported profile "Imported"/)).toBeInTheDocument();
    });
  });

  it('Import JSON refuses empty input (no invoke)', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import JSON/ }));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'import_profile_cmd')).toBe(false);
  });

  it('Import JSON error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('import_profile_cmd', () => { throw new Error('bad json'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Import JSON/ }));
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
    await user.click(screen.getByRole('button', { name: /Import JSON/ }));
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

  it('profile kebab shows Snapshot/Export/Delete options', async () => {
    seedProfiles([baseProfile({ name: 'Pack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Pack')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/i });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
    });
  });

  it('renders all profile metadata (mods count + created_at + author)', async () => {
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
    expect(screen.getByText(/1 enabled/)).toBeInTheDocument();
    expect(screen.getByText(/1 disabled/)).toBeInTheDocument();
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
  });

  it('renders profile with share info (chip with code) when published', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'Published.json',
    }));
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument();
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
      deleted_orphans: ['Orphan1', 'Orphan2'],
    }));
    // Backup checkbox is checked by default; let the create_backup_cmd succeed.
    registerInvokeHandler('create_backup_cmd', () => '/tmp/backup.zip');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    // The banner's Repair button has a unique title.
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
    await user.click(repairBanner);
    // Confirm modal opens; click the Repair button in its foot.
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Repair' }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'repair_profile')).toBe(true);
    });
    // Backup ran (checkbox defaulted on).
    expect(getInvokeCalls().some((c) => c.cmd === 'create_backup_cmd')).toBe(true);
    // Success toast with summary — parts joined by ", " and listed as
    // "removed N orphan mods, downloaded N, N download(s) failed, N still missing".
    await waitFor(() => {
      const found = document.body.textContent ?? '';
      expect(found).toMatch(/Repaired "DriftedPack" — removed 2 orphan mods, downloaded 1, 1 download\(s\) failed, 1 still missing/);
    });
  });

  it('drift banner Repair with no orphans renders the "nothing to delete" body', async () => {
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
      deleted_orphans: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
    await user.click(repairBanner);
    // Body mentions "No orphan files".
    await waitFor(() => {
      expect(screen.getByText(/No orphan files to delete/)).toBeInTheDocument();
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
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
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
      deleted_orphans: ['Orphan'],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
    await user.click(repairBanner);
    // Uncheck the backup checkbox.
    const checkbox = await screen.findByRole('checkbox');
    await user.click(checkbox);
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
      deleted_orphans: ['Orphan'],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('DriftedPack')).toBeInTheDocument(); });
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
    await user.click(repairBanner);
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
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
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
    const repairBanner = await screen.findByTitle('Re-apply manifest and delete orphan mod files');
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
      await user.click(screen.getByRole('button', { name: /Snapshot current/ }));
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
      await user.click(screen.getByRole('button', { name: /Snapshot current/ }));
      expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(false);
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Following / Published tabs toggle visibility', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    const publishedBtn = screen.getByRole('button', { name: /Published by you/i });
    await user.click(publishedBtn);
    expect(publishedBtn.className).toContain('active');
    // Following tab toggles back.
    const followingBtn = screen.getByRole('button', { name: /^Following/i });
    await user.click(followingBtn);
    expect(followingBtn.className).toContain('active');
  });

  it('Share button opens the publish modal when profile is unpublished', async () => {
    seedProfiles([baseProfile({ name: 'Unpublished' })]);
    registerInvokeHandler('get_share_info', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Unpublished')).toBeInTheDocument(); });
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
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
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
    await waitFor(() => {
      expect(screen.getByText(/2 new mods/)).toBeInTheDocument();
    });
  });

  it('drift row chip (non-active profile) shows out-of-sync detail line', async () => {
    seedProfiles([
      baseProfile({ name: 'Active' }),
      baseProfile({ name: 'OtherDrift' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'OtherDrift');
    registerInvokeHandler('get_share_info', (args: any) => {
      if (args?.name === 'OtherDrift') {
        return { owner: 'me', code: 'CODE-CODE-CODE', url: '', remote_path: 'p.json' };
      }
      return null;
    });
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['n1'],
      removed: ['r1'],
      toggled: ['t1'],
      version_changed: [{ name: 'v1', profile_version: '1', disk_version: '2' }],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('OtherDrift')).toBeInTheDocument(); });
    // The row-level drift chip references "re-share to update subscribers" when shareInfo is present.
    await waitFor(() => {
      expect(screen.getByText(/re-share to update subscribers/)).toBeInTheDocument();
    });
  });

  it('switching profile error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'A' }), baseProfile({ name: 'B' })]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => { throw new Error('boom'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('B')).toBeInTheDocument(); });
    const activate = screen.getAllByRole('button').find(
      (b) => /Switch to/i.test(b.textContent ?? ''),
    );
    expect(activate).toBeDefined();
    await user.click(activate!);
    await waitFor(() => {
      expect(screen.getByText(/Failed to switch.*boom/)).toBeInTheDocument();
    });
  });

  it('Active profile row shows a re-apply button (RefreshCw icon) and clicking it invokes switch_profile', async () => {
    seedProfiles([baseProfile({ name: 'Active' })]);
    registerInvokeHandler('get_active_profile', () => 'Active');
    registerInvokeHandler('switch_profile', () => ({
      applied: true,
      downloaded: 0,
      missing_mods: [],
      failed_downloads: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Active')).toBeInTheDocument(); });
    const reapply = screen.getAllByTitle(/Re-apply this profile/i);
    expect(reapply.length).toBeGreaterThan(0);
    await user.click(reapply[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'switch_profile' && c.args?.name === 'Active',
      )).toBe(true);
    });
  });

  it('renders Loading state initially', async () => {
    let resolver!: (v: unknown) => void;
    registerInvokeHandler('list_profiles_cmd', () => new Promise((r) => { resolver = r; }));
    render(<Wrap />);
    expect(screen.getByText(/Loading profiles/i)).toBeInTheDocument();
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

  it('Inline Copy share code button copies the chip code', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument(); });
    const copyBtn = await screen.findByTitle('Copy share code');
    await user.click(copyBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    });
  });

  it('Inline Copy install link button copies the HTTPS bridge URL + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument(); });
    const linkBtn = await screen.findByTitle(/Copy install link/i);
    await user.click(linkBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    {
      const calls = clipboardWrite.mock.calls;
      expect((calls[calls.length - 1]?.[0] as string)).toMatch(/i\.html\?c=/);
    }
    await waitFor(() => {
      expect(screen.getByText(/Install link copied/)).toBeInTheDocument();
    });
  });

  it('Inline Copy install link clipboard reject surfaces error toast', async () => {
    installClipboard(async () => { throw new Error('blocked'); });
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument(); });
    const linkBtn = await screen.findByTitle(/Copy install link/i);
    await user.click(linkBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

  it('Inline Copy share message button copies the paste-ready message + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE',
      url: '', remote_path: 'Published.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument(); });
    const msgBtn = await screen.findByTitle(/Copy share message/i);
    await user.click(msgBtn);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    {
      const calls = clipboardWrite.mock.calls;
      expect((calls[calls.length - 1]?.[0] as string)).toMatch(/Join my Slay the Spire 2/);
    }
    await waitFor(() => {
      expect(screen.getByText(/Share message copied/)).toBeInTheDocument();
    });
  });

  it('Inline Copy share message clipboard reject surfaces error toast', async () => {
    installClipboard(async () => { throw new Error('blocked'); });
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('alice/AA5A-315D-61AE')).toBeInTheDocument(); });
    const msgBtn = await screen.findByTitle(/Copy share message/i);
    await user.click(msgBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

  it('Kebab → Duplicate fires duplicate_profile + success toast', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    registerInvokeHandler('duplicate_profile', (args) =>
      baseProfile({ name: String(args?.newName) }),
    );
    const origPrompt = window.prompt;
    window.prompt = () => 'Copy of Original';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('Original')).toBeInTheDocument(); });
      const kebabs = screen.getAllByRole('button', { name: /More actions/ });
      expect(kebabs.length).toBeGreaterThan(0);
      await user.click(kebabs[0]);
      const dup = await screen.findByRole('menuitem', { name: /Duplicate/ });
      await user.click(dup);
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

  it('Kebab → Duplicate prompt cancel skips invoke', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    const origPrompt = window.prompt;
    window.prompt = () => null;
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('Original')).toBeInTheDocument(); });
      const kebabs = screen.getAllByRole('button', { name: /More actions/ });
      expect(kebabs.length).toBeGreaterThan(0);
      await user.click(kebabs[0]);
      const dup = await screen.findByRole('menuitem', { name: /Duplicate/ });
      await user.click(dup);
      expect(getInvokeCalls().some((c) => c.cmd === 'duplicate_profile')).toBe(false);
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Kebab → Duplicate error path surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    registerInvokeHandler('duplicate_profile', () => { throw new Error('exists'); });
    const origPrompt = window.prompt;
    window.prompt = () => 'Dup';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('Original')).toBeInTheDocument(); });
      const kebabs = screen.getAllByRole('button', { name: /More actions/ });
      await user.click(kebabs[0]);
      const dup = await screen.findByRole('menuitem', { name: /Duplicate/ });
      await user.click(dup);
      await waitFor(() => {
        expect(screen.getByText(/Failed to duplicate.*exists/)).toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Kebab → Export JSON fires export_profile_cmd + success toast', async () => {
    seedProfiles([baseProfile({ name: 'Exportable' })]);
    registerInvokeHandler('export_profile_cmd', () => '{"name":"Exportable","mods":[]}');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Exportable')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]);
    const exportItem = await screen.findByRole('menuitem', { name: /Export JSON/ });
    await user.click(exportItem);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'export_profile_cmd')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Profile JSON copied to clipboard/)).toBeInTheDocument();
    });
    expect(clipboardWrite).toHaveBeenCalledWith('{"name":"Exportable","mods":[]}');
  });

  it('Kebab → Export JSON error path surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('export_profile_cmd', () => { throw new Error('locked'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const exportItem = await screen.findByRole('menuitem', { name: /Export JSON/ });
    await user.click(exportItem);
    await waitFor(() => {
      expect(screen.getByText(/Failed to export.*locked/)).toBeInTheDocument();
    });
  });

  it('Kebab → Snapshot from current install fires snapshot_profile after prompt', async () => {
    seedProfiles([baseProfile({ name: 'A' })]);
    registerInvokeHandler('snapshot_profile', (args) => baseProfile({ name: String(args?.name) }));
    const origPrompt = window.prompt;
    window.prompt = () => 'Snap-X';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
      const kebabs = screen.getAllByRole('button', { name: /More actions/ });
      expect(kebabs.length).toBeGreaterThan(0);
      await user.click(kebabs[0]);
      const snap = await screen.findByRole('menuitem', { name: /Snapshot from current/i });
      await user.click(snap);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(true);
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Kebab → Delete profile opens confirm modal → confirms → invokes delete_profile_cmd + toast', async () => {
    seedProfiles([baseProfile({ name: 'Doomed' })]);
    registerInvokeHandler('delete_profile_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Doomed')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]);
    const del = await screen.findByRole('menuitem', { name: /Delete profile/ });
    await user.click(del);
    await waitFor(() => {
      expect(screen.getByText(/Delete profile "Doomed"/)).toBeInTheDocument();
    });
    await user.click(await screen.findByRole('button', { name: /Delete profile/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'delete_profile_cmd' && c.args?.name === 'Doomed',
      )).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Profile "Doomed" deleted/)).toBeInTheDocument();
    });
  });

  it('Kebab → Delete profile Cancel skips invoke', async () => {
    seedProfiles([baseProfile({ name: 'SafePack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('SafePack')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const del = await screen.findByRole('menuitem', { name: /Delete profile/ });
    await user.click(del);
    const modal = await confirmModal();
    await user.click(modal.getByRole('button', { name: 'Cancel' }));
    expect(getInvokeCalls().some((c) => c.cmd === 'delete_profile_cmd')).toBe(false);
  });

  it('Kebab → Delete profile error path surfaces toast', async () => {
    seedProfiles([baseProfile({ name: 'Stubborn' })]);
    registerInvokeHandler('delete_profile_cmd', () => { throw new Error('busy'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Stubborn')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const del = await screen.findByRole('menuitem', { name: /Delete profile/ });
    await user.click(del);
    await user.click(await screen.findByRole('button', { name: /Delete profile/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to delete.*busy/)).toBeInTheDocument();
    });
  });

  it('Published kebab Copy share code item copies + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]);
    const copyCode = await screen.findByRole('menuitem', { name: /Copy share code/i });
    await user.click(copyCode);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    });
    await waitFor(() => {
      expect(screen.getByText(/Share code copied/)).toBeInTheDocument();
    });
  });

  it('Published kebab Copy share link item copies the HTTPS URL + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const linkItem = await screen.findByRole('menuitem', { name: /Copy share link/i });
    await user.click(linkItem);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    {
      const calls = clipboardWrite.mock.calls;
      expect((calls[calls.length - 1]?.[0] as string)).toMatch(/i\.html\?c=/);
    }
    await waitFor(() => {
      expect(screen.getByText(/Install link copied/)).toBeInTheDocument();
    });
  });

  it('Published kebab Copy share link clipboard reject surfaces error toast', async () => {
    installClipboard(async () => { throw new Error('blocked'); });
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const linkItem = await screen.findByRole('menuitem', { name: /Copy share link/i });
    await user.click(linkItem);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

  it('Published kebab Copy share message item copies + toast', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const msgItem = await screen.findByRole('menuitem', { name: /Copy share message/i });
    await user.click(msgItem);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalled();
    });
    {
      const calls = clipboardWrite.mock.calls;
      expect((calls[calls.length - 1]?.[0] as string)).toMatch(/Join my Slay the Spire 2/);
    }
    await waitFor(() => {
      expect(screen.getByText(/Share message copied/)).toBeInTheDocument();
    });
  });

  it('Published kebab Copy share message clipboard reject surfaces error toast', async () => {
    installClipboard(async () => { throw new Error('blocked'); });
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    await user.click(kebabs[0]);
    const msgItem = await screen.findByRole('menuitem', { name: /Copy share message/i });
    await user.click(msgItem);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy to clipboard/)).toBeInTheDocument();
    });
  });

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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to import.*not found/)).toBeInTheDocument();
    });
  });

  it('Import-by-code already-active path shows the friendly info toast', async () => {
    seedProfiles([baseProfile({ name: 'Match' })]);
    registerInvokeHandler('get_active_profile', () => 'Match');
    registerInvokeHandler('get_subscriptions', () => [
      { share_id: 'alice/AA5A-315D-61AE', profile_name: 'Match' },
    ]);
    // No subUpdates so the smart router returns 'already-active'.
    registerInvokeHandler('check_subscription_updates', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Match')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
    const input = await screen.findByPlaceholderText(/username\/XXXX/);
    await user.type(input, 'alice/AA5A-315D-61AE');
    await user.click(screen.getByRole('button', { name: /^Import$/ }));
    await waitFor(() => {
      expect(screen.getByText(/You're already on "Match"/)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
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

  it('Activate button shows for non-active profile but Re-apply shows for active', async () => {
    seedProfiles([
      baseProfile({ name: 'ActiveP' }),
      baseProfile({ name: 'OtherP' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'ActiveP');
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('ActiveP')).toBeInTheDocument(); });
    expect(screen.queryAllByTitle(/Re-apply/).length).toBeGreaterThan(0);
    const buttons = screen.getAllByRole('button');
    expect(buttons.some((b) => /Switch to/.test(b.textContent ?? ''))).toBe(true);
  });

  it('Snapshot button is in the page header', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /Snapshot current/ })).toBeInTheDocument();
  });

  it('header toolbar toggles: Add by code closes Import JSON + Create forms', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    // Open Import JSON first.
    await user.click(screen.getByRole('button', { name: /Import JSON/ }));
    expect(screen.getByPlaceholderText(/"name":/)).toBeInTheDocument();
    // Then click Add by code — it should hide Import JSON.
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
    expect(screen.queryByPlaceholderText(/"name":/)).toBeNull();
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
  });

  it('header toolbar toggles: New profile closes Import JSON + Add by code forms', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /Add by code/i }));
    expect(screen.getByPlaceholderText(/username\/XXXX/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New profile/ }));
    expect(screen.queryByPlaceholderText(/username\/XXXX/)).toBeNull();
    expect(screen.getByPlaceholderText('My Profile')).toBeInTheDocument();
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
    await waitFor(() => { expect(screen.getByText('Fresh')).toBeInTheDocument(); });
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
    // Close the modal so the row re-renders with the patched share info.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    // The row's button label flipped from Share to Re-share via the
    // optimistic shareInfoMap patch.
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
    // 2 packs → "2 packs have updates".
    await waitFor(() => {
      expect(screen.getByText(/2 packs have updates/)).toBeInTheDocument();
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
    // The fallback string from `... || 'profile and disk are out of sync'`.
    await waitFor(() => {
      expect(screen.getByText(/profile and disk are out of sync/)).toBeInTheDocument();
    });
  });

  it('drift row chip pluralizes "versions changed" when version_changed > 1', async () => {
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

  it('drift row chip handles version_changed = null (uses ?? fallback)', async () => {
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

  it('non-Error throws fall through to String() formatter (handleCreate)', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('create_profile', () => { throw 'plain-string-error'; });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /New profile/ }));
    const input = await screen.findByPlaceholderText('My Profile');
    await user.type(input, 'Bad');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to create profile.*plain-string-error/)).toBeInTheDocument();
    });
  });

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

  it('Published tab shows only profiles in shareInfoMap', async () => {
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
    await waitFor(() => { expect(screen.getByText('Shared')).toBeInTheDocument(); });
    // Switch to Published tab.
    await user.click(screen.getByRole('button', { name: /Published by you/i }));
    // Shared remains, Unshared filtered out.
    await waitFor(() => {
      expect(screen.queryByText('Unshared')).toBeNull();
    });
    expect(screen.getByText('Shared')).toBeInTheDocument();
  });
});
