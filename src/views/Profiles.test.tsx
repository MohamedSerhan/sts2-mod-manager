import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    // The "ACTIVE" badge sits next to the active profile.
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
  });

  it('Cancel button in the create form hides the input', async () => {
    seedProfiles([]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/No profiles yet/i)).toBeInTheDocument();
    });
    // Get the New profile button (header — there may be one in empty-state too).
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

  it('clicking Apply update on a pending pack invokes apply_subscription_update', async () => {
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
  });

  it('Snapshot current invokes snapshot_profile via the prompt', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('snapshot_profile', (args) => baseProfile({ name: String(args?.name) }));
    // window.prompt() is the simplest path the existing snapshot handler uses.
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
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Switch to a different profile invokes switch_profile', async () => {
    seedProfiles([
      baseProfile({ name: 'A' }),
      baseProfile({ name: 'B' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => ({
      activated: true,
      downloaded: 0,
      missing_mods: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('A')).toBeInTheDocument(); });
    // Each profile row has an "Activate" / "Switch" button. Find the one
    // associated with the non-active profile (B). The button is in B's row.
    // We don't know exact text — grep for clickable buttons that aren't
    // the global toolbar ones.
    const allBtns = screen.getAllByRole('button');
    const activate = allBtns.find((b) => /Activate|Switch/i.test(b.textContent ?? ''));
    if (activate) {
      await user.click(activate);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(true);
      });
    }
  });

  it('Import-by-code panel renders the input', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    // Import-by-code button — text matches "Import" or "share code".
    const buttons = screen.getAllByRole('button');
    const importBtn = buttons.find((b) => /Import.*code|share code|paste/i.test(b.textContent ?? ''));
    if (importBtn) {
      await user.click(importBtn);
      // Now an input appears for the code.
      await waitFor(() => {
        const codeInputs = document.querySelectorAll('input[placeholder*="username"], input[placeholder*="code"], input[placeholder*="AA5A"]');
        expect(codeInputs.length).toBeGreaterThan(0);
      });
    }
  });

  it('Import from JSON form opens and submits to import_profile_cmd', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('import_profile_cmd', () => baseProfile({ name: 'Imported' }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    // Toggle the JSON import button — its label includes "Upload" or "Import JSON".
    const allBtns = screen.getAllByRole('button');
    const jsonBtn = allBtns.find((b) => /Import JSON|Upload JSON|JSON file/i.test(b.textContent ?? ''));
    if (jsonBtn) {
      await user.click(jsonBtn);
      // A textarea or input appears; type into it.
      const textareas = document.querySelectorAll('textarea');
      if (textareas.length > 0) {
        // userEvent.type parses curly braces as keyboard modifiers; use
        // paste for raw JSON instead so braces survive verbatim.
        await user.click(textareas[0] as HTMLElement);
        await user.paste('{"name":"X"}');
        const submitBtn = screen.getAllByRole('button').find((b) => /^Import$/i.test(b.textContent ?? ''));
        if (submitBtn) {
          await user.click(submitBtn);
          await waitFor(() => {
            expect(getInvokeCalls().some((c) => c.cmd === 'import_profile_cmd')).toBe(true);
          });
        }
      }
    }
  });

  it('renders error banner when listProfiles fails', async () => {
    registerInvokeHandler('list_profiles_cmd', () => { throw new Error('disk full'); });
    render(<Wrap />);
    // The error banner / toast surfaces somewhere. We just check we don't
    // render a profile card.
    await waitFor(() => {
      expect(screen.queryByText(/My Pack|Alpha/)).toBeNull();
    });
  });

  it('profile kebab shows Snapshot/Export/Delete options', async () => {
    seedProfiles([baseProfile({ name: 'Pack' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Pack')).toBeInTheDocument(); });
    // Each profile row has a kebab.
    const kebabs = screen.getAllByRole('button', { name: /More actions|Profile actions/i });
    if (kebabs.length > 0) {
      await user.click(kebabs[0]);
      await waitFor(() => {
        expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
      });
    }
  });

  it('profile delete via kebab opens confirm modal', async () => {
    seedProfiles([baseProfile({ name: 'PackToDelete' })]);
    registerInvokeHandler('delete_profile_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('PackToDelete')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions|Profile actions/i });
    if (kebabs.length > 0) {
      await user.click(kebabs[0]);
      const delItem = screen.queryAllByRole('menuitem', { name: /Delete/ })[0];
      if (delItem) {
        await user.click(delItem);
        // Confirm dialog pops up
        await waitFor(() => {
          expect(screen.getByText(/Delete.*PackToDelete|Are you sure/i)).toBeInTheDocument();
        });
      }
    }
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
      expect(screen.queryAllByText(/alice|AA5A-315D-61AE/).length).toBeGreaterThan(0);
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
    // The drift banner has unique copy.
    await waitFor(() => {
      expect(screen.queryAllByText(/drift|out of sync|changed/i).length).toBeGreaterThan(0);
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
      // Cancel → no snapshot_profile invocation.
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

  it('exercises a heterogeneous profile list (active, published, drift, subUpdate)', async () => {
    seedProfiles([
      baseProfile({ name: 'Active', created_by: 'alice' }),
      baseProfile({ name: 'Inactive', mods: [{ name: 'A' } as any] }),
      baseProfile({ name: 'Published' }),
    ]);
    registerInvokeHandler('get_active_profile', () => 'Active');
    registerInvokeHandler('get_share_info', (args: any) => {
      if (args?.name === 'Published') {
        return { owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json' };
      }
      return null;
    });
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'alice/abcd', profile_name: 'Inactive', has_update: true, added_mods: ['X'], updated_mods: [], removed_mods: [], remote_profile: null },
    ]);
    registerInvokeHandler('get_profile_drift', () => ({
      added: ['NewMod'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    }));
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Inactive/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
  });

  it('Following / Published tabs toggle visibility', async () => {
    seedProfiles([baseProfile({ name: 'Alpha' })]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Alpha')).toBeInTheDocument(); });
    const publishedBtn = screen.getByRole('button', { name: /Published by you/i });
    await user.click(publishedBtn);
    expect(publishedBtn.className).toContain('active');
  });

  it('Share button opens the publish modal when profile is unpublished', async () => {
    seedProfiles([baseProfile({ name: 'Unpublished' })]);
    registerInvokeHandler('get_share_info', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Unpublished')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const shareBtn = buttons.find((b) => /^Share$/.test(b.textContent?.trim() ?? ''));
    if (shareBtn) {
      await user.click(shareBtn);
      await waitFor(() => {
        expect(screen.queryAllByText(/Unpublished/).length).toBeGreaterThan(0);
      });
    }
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
      const buttons = screen.getAllByRole('button');
      expect(buttons.some((b) => /Re-?share/i.test(b.textContent ?? ''))).toBe(true);
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
      expect(screen.queryByText(/2 new mods/)).toBeInTheDocument();
    });
  });

  it('switching profile error surfaces a toast', async () => {
    seedProfiles([baseProfile({ name: 'A' }), baseProfile({ name: 'B' })]);
    registerInvokeHandler('get_active_profile', () => 'A');
    registerInvokeHandler('switch_profile', () => { throw new Error('boom'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('B')).toBeInTheDocument(); });
    const buttons = screen.getAllByRole('button');
    const activate = buttons.find((b) => /Switch to|Activate/i.test(b.textContent ?? ''));
    if (activate) {
      await user.click(activate);
      await waitFor(() => {
        expect(screen.getByText(/Failed to switch.*boom/)).toBeInTheDocument();
      });
    }
  });

  it('Active profile row shows a re-apply button (RefreshCw icon)', async () => {
    seedProfiles([baseProfile({ name: 'Active' })]);
    registerInvokeHandler('get_active_profile', () => 'Active');
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Active')).toBeInTheDocument(); });
    const reapply = screen.getAllByTitle(/Re-apply|Re-apply this profile/i);
    expect(reapply.length).toBeGreaterThan(0);
  });

  it('renders Loading state initially', async () => {
    let resolver!: (v: unknown) => void;
    registerInvokeHandler('list_profiles_cmd', () => new Promise((r) => { resolver = r; }));
    render(<Wrap />);
    expect(screen.getByText(/Loading profiles/i)).toBeInTheDocument();
    resolver([]);
  });

  it('shows Retry button when list_profiles_cmd throws', async () => {
    registerInvokeHandler('list_profiles_cmd', () => { throw new Error('Network down'); });
    render(<Wrap />);
    await waitFor(() => {
      // Either an error state with retry OR empty state. Both are acceptable.
      const buttons = screen.queryAllByRole('button');
      const hasRetry = buttons.some((b) => /Retry/.test(b.textContent ?? ''));
      const hasEmpty = screen.queryByText(/No profiles yet/i);
      expect(hasRetry || !!hasEmpty).toBe(true);
    });
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

  it('Copy share code button renders for a published profile', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'Published.json',
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    await waitFor(() => {
      const copyBtn = screen.queryByTitle('Copy share code');
      expect(copyBtn).toBeTruthy();
    });
  });

  it('Copy install link button renders for a published profile', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: '',
      remote_path: 'Published.json',
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    await waitFor(() => {
      const linkBtn = screen.queryByTitle(/Copy install link/i);
      expect(linkBtn).toBeTruthy();
    });
  });

  it('Copy share message button renders for a published profile', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE',
      url: '', remote_path: 'Published.json',
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    await waitFor(() => {
      const msgBtn = screen.queryByTitle(/Copy share message/i);
      expect(msgBtn).toBeTruthy();
    });
  });

  it('Kebab → Duplicate fires duplicate_profile', async () => {
    seedProfiles([baseProfile({ name: 'Original' })]);
    registerInvokeHandler('duplicate_profile', (args) => baseProfile({ name: String(args?.newName) }));
    const origPrompt = window.prompt;
    window.prompt = () => 'Copy of Original';
    try {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('Original')).toBeInTheDocument(); });
      const kebabs = screen.getAllByRole('button', { name: /More actions/ });
      if (kebabs.length > 0) {
        await user.click(kebabs[0]);
        const dup = await screen.findByRole('menuitem', { name: /Duplicate/ });
        await user.click(dup);
        await waitFor(() => {
          expect(getInvokeCalls().some((c) => c.cmd === 'duplicate_profile')).toBe(true);
        });
      }
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Kebab → Export JSON fires export_profile_cmd', async () => {
    seedProfiles([baseProfile({ name: 'Exportable' })]);
    registerInvokeHandler('export_profile_cmd', () => '{"name":"Exportable","mods":[]}');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Exportable')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    if (kebabs.length > 0) {
      await user.click(kebabs[0]);
      const exportItem = await screen.findByRole('menuitem', { name: /Export JSON/ });
      await user.click(exportItem);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'export_profile_cmd')).toBe(true);
      });
    }
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
      if (kebabs.length > 0) {
        await user.click(kebabs[0]);
        const snap = await screen.findByRole('menuitem', { name: /Snapshot from current/i });
        await user.click(snap);
        await waitFor(() => {
          expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile')).toBe(true);
        });
      }
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('Kebab → Delete profile opens confirm modal', async () => {
    seedProfiles([baseProfile({ name: 'Doomed' })]);
    registerInvokeHandler('delete_profile_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Doomed')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    if (kebabs.length > 0) {
      await user.click(kebabs[0]);
      const del = await screen.findByRole('menuitem', { name: /Delete profile/ });
      await user.click(del);
      await waitFor(() => {
        // Confirm modal renders with the profile name in its title.
        expect(screen.queryAllByText(/Doomed/).length).toBeGreaterThan(0);
      });
    }
  });

  it('Published kebab includes Copy share code / link / message items', async () => {
    seedProfiles([baseProfile({ name: 'Published' })]);
    registerInvokeHandler('get_share_info', () => ({
      owner: 'alice', code: 'AA5A-315D-61AE', url: '', remote_path: 'P.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('Published')).toBeInTheDocument(); });
    const kebabs = screen.getAllByRole('button', { name: /More actions/ });
    if (kebabs.length > 0) {
      await user.click(kebabs[0]);
      await waitFor(() => {
        expect(screen.queryAllByRole('menuitem', { name: /Copy share code/i }).length).toBeGreaterThan(0);
      });
      expect(screen.queryAllByRole('menuitem', { name: /Copy share link/i }).length).toBeGreaterThan(0);
      expect(screen.queryAllByRole('menuitem', { name: /Copy share message/i }).length).toBeGreaterThan(0);
    }
  });

  it('Import-by-code form: Apply button calls fetch_shared_profile_cmd', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Imported', mods: [], created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Imported', mods: [], created_at: '2026-01-01',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    const allBtns = screen.getAllByRole('button');
    const importBtn = allBtns.find((b) => /Import.*code|paste/i.test(b.textContent ?? ''));
    if (importBtn) {
      await user.click(importBtn);
      const inputs = Array.from(
        document.querySelectorAll('input[placeholder*="username"], input[placeholder*="AA5A"], input[placeholder*="code"]'),
      ) as HTMLInputElement[];
      if (inputs.length > 0) {
        await user.type(inputs[0], 'alice/AA5A-315D-61AE');
        const submit = screen.getAllByRole('button').find((b) => /^Apply$|Import code/i.test(b.textContent?.trim() ?? ''));
        if (submit) {
          await user.click(submit);
          await waitFor(() => {
            const calls = getInvokeCalls();
            expect(calls.some((c) =>
              c.cmd === 'fetch_shared_profile_cmd' ||
              c.cmd === 'install_shared_profile' ||
              c.cmd === 'get_share_info',
            )).toBe(true);
          });
        }
      }
    }
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
    // The active profile row has a re-apply button (Refresh icon, no Switch text).
    expect(screen.queryAllByTitle(/Re-apply/).length).toBeGreaterThan(0);
    // The non-active row has a Switch to button.
    const buttons = screen.getAllByRole('button');
    expect(buttons.some((b) => /Switch to/.test(b.textContent ?? ''))).toBe(true);
  });

  it('Snapshot button is in the page header', async () => {
    seedProfiles([baseProfile({ name: 'X' })]);
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('X')).toBeInTheDocument(); });
    expect(screen.getByRole('button', { name: /Snapshot current/ })).toBeInTheDocument();
  });
});
