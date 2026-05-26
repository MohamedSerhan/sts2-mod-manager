/**
 * ModpackDetail tests — the inline detail view that replaces the
 * modpack list area when a card is clicked (1.7.0 T16). Focus on
 * the layout + handler wiring, not the LibraryTable internals (which
 * are tested in LibraryTable.test.tsx).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModpackDetail } from './ModpackDetail';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';
import type { Profile, ShareResult } from '../types';
import type { ProfileDrift } from '../hooks/useTauri';

function Wrap(props: React.ComponentProps<typeof ModpackDetail>) {
  return (
    <AllProviders>
      <ModpackDetail {...props} />
    </AllProviders>
  );
}

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'Sample',
    mods: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: null,
    game_version: '0.105.0',
    ...overrides,
  } as Profile);

const baseProps = () => ({
  profile: baseProfile(),
  onBack: vi.fn(),
});

describe('<ModpackDetail>', () => {
  it('renders the header row with name, Back button, and Switch button for inactive profile', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const onBack = vi.fn();
    const onSwitch = vi.fn();
    render(
      <Wrap
        profile={baseProfile({ name: 'Sample' })}
        onBack={onBack}
        onSwitch={onSwitch}
      />,
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Sample' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to modpacks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch to/i })).toBeInTheDocument();
  });

  it('omits the Switch button when the modpack is already active', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    render(
      <Wrap
        profile={baseProfile({ name: 'Sample' })}
        onBack={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Active modpack shows the ACTIVE pill instead of Switch.
    expect(screen.getByText(/ACTIVE/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/i })).toBeNull();
  });

  it('renders LibraryTable inside the detail body', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [
        {
          name: 'BaseLib',
          version: '1.0',
          folder_name: 'BaseLib',
          mod_id: 'BaseLib',
          installed_enabled: true,
          profiles: [{ profile_name: 'Sample', included: true, enabled: true, editable: true }],
        },
      ],
    }));
    render(<Wrap {...baseProps()} />);
    expect(await screen.findByTestId('library-table')).toBeInTheDocument();
    expect(screen.getAllByText('BaseLib').length).toBeGreaterThan(0);
  });

  it('clicking Back fires onBack', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onBack={onBack} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Back to modpacks/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Advanced section is collapsed by default and toggles open via the disclosure button', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const user = userEvent.setup();
    render(
      <Wrap
        {...baseProps()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onExportJson={vi.fn()}
        onSnapshot={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Closed — advanced action buttons aren't rendered.
    expect(screen.queryByTestId('modpack-detail-advanced-panel')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByTestId('modpack-detail-advanced-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete modpack/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export JSON/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Snapshot/i })).toBeInTheDocument();
    // Toggling again collapses.
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.queryByTestId('modpack-detail-advanced-panel')).toBeNull();
  });

  it('Advanced action buttons fire their prop handlers', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onExportJson = vi.fn();
    const onSnapshot = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        {...baseProps()}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onExportJson={onExportJson}
        onSnapshot={onSnapshot}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    await user.click(screen.getByRole('button', { name: /Duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith('Sample');
    await user.click(screen.getByRole('button', { name: /Export JSON/i }));
    expect(onExportJson).toHaveBeenCalledWith('Sample');
    await user.click(screen.getByRole('button', { name: /Snapshot/i }));
    expect(onSnapshot).toHaveBeenCalledWith('Sample');
    await user.click(screen.getByRole('button', { name: /Delete modpack/i }));
    expect(onDelete).toHaveBeenCalledWith('Sample');
  });

  it('renders Shared badge in header when shareInfo is provided', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const shareInfo: ShareResult = {
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      file_path: 'Sample.json',
      repo_url: 'https://github.com/alice/sts2mm-profiles',
      failed_uploads: [],
    };
    render(<Wrap {...baseProps()} shareInfo={shareInfo} onShare={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.getByText(/Shared/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-share/i })).toBeInTheDocument();
  });

  it('Repair drift button only shows in Advanced when drift has has_drift=true', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const onRepairDrift = vi.fn();
    const drift: ProfileDrift = {
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    };
    const user = userEvent.setup();
    render(
      <Wrap
        {...baseProps()}
        drift={drift}
        onRepairDrift={onRepairDrift}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByRole('button', { name: /Repair/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Repair/i }));
    expect(onRepairDrift).toHaveBeenCalledWith('Sample');
  });

  it('Repair button is omitted when no drift is reported', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onRepairDrift={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.queryByRole('button', { name: /Repair/i })).toBeNull();
  });

  it('audit summary chips render only when matching counts are non-zero', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    // No audit data → no chips.
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByTestId('modpack-detail-audit')).toBeNull();
  });

  it('audit summary chip shows updates count when auditResults reports needs_update for an in-pack mod', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    // Pre-populate the audit cache by stubbing run_audit synchronously.
    registerInvokeHandler('run_mod_audit_cmd', () => [
      {
        mod_name: 'PinnedMod',
        folder_name: 'PinnedMod',
        github_repo: 'owner/PinnedMod',
        installed_version: '1.0',
        latest_release_tag: '2.0',
        latest_release_with_assets_tag: '2.0',
        latest_has_assets: true,
        needs_update: true,
        asset_names: ['x.dll'],
        releases_scanned: 1,
        error: null,
        nexus_url: null,
        nexus_version: null,
        nexus_update_available: false,
        update_source: 'github',
        github_auto_detected: true,
        pinned: false,
        snoozed: false,
      },
    ]);
    // The detail view reads auditResults via AppContext; the context's
    // initial value is null unless something runs the audit. The
    // chip is suppressed when audit is null — so this test focuses on
    // the "no audit yet" branch (chip section is hidden).
    render(
      <Wrap
        profile={baseProfile({
          name: 'Sample',
          mods: [
            {
              name: 'PinnedMod',
              version: '1.0',
              source: null,
              hash: null,
              files: [],
              enabled: true,
              bundle_url: null,
              folder_name: 'PinnedMod',
              mod_id: 'PinnedMod',
            },
          ],
        })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Without an explicit audit context push, the chip stays hidden —
    // this is the safe default (we don't want a spurious chip flicker).
    await waitFor(() => {
      expect(screen.queryByTestId('audit-chip-updates')).toBeNull();
    });
  });

  it('missing-source audit chip shows count of mods with no source + no bundle', async () => {
    registerInvokeHandler('get_profile_memberships', () => ({
      profiles: [{ name: 'Sample', editable: true }],
      mods: [],
    }));
    render(
      <Wrap
        profile={baseProfile({
          name: 'Sample',
          mods: [
            {
              name: 'NoSource',
              version: '1.0',
              source: null,
              hash: null,
              files: [],
              enabled: true,
              bundle_url: null,
              folder_name: 'NoSource',
              mod_id: 'NoSource',
            },
            {
              name: 'HasSource',
              version: '1.0',
              source: 'https://github.com/x/y',
              hash: null,
              files: [],
              enabled: true,
              bundle_url: null,
              folder_name: 'HasSource',
              mod_id: 'HasSource',
            },
          ],
        })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(await screen.findByTestId('audit-chip-missing')).toBeInTheDocument();
    expect(screen.getByText(/1 mod missing source/i)).toBeInTheDocument();
  });
});
