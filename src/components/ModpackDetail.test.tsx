/**
 * ModpackDetail tests — the inline detail view that replaces the
 * modpack list area when a card is clicked (1.7.0 T16), reworked into a
 * two-section layout (1.7.x): "In this modpack" + "Add from your
 * library". Focus on the layout + membership/handler wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModpackDetail } from './ModpackDetail';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModInfo, Profile, ProfileMod, ShareResult } from '../types';
import type { ProfileDrift } from '../hooks/useTauri';

function Wrap(props: React.ComponentProps<typeof ModpackDetail>) {
  return (
    <AllProviders>
      <ModpackDetail {...props} />
    </AllProviders>
  );
}

const profileMod = (overrides: Partial<ProfileMod> = {}): ProfileMod =>
  ({
    name: 'PackMod',
    version: '1.0',
    source: null,
    hash: null,
    files: [],
    enabled: true,
    bundle_url: null,
    folder_name: 'PackMod',
    mod_id: 'PackMod',
    ...overrides,
  });

const modInfo = (overrides: Partial<ModInfo> = {}): ModInfo =>
  ({
    name: 'LibMod',
    version: '2.0',
    description: '',
    enabled: false,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    github_url: null,
    nexus_url: null,
    folder_name: 'LibMod',
    mod_id: 'LibMod',
    pinned: false,
    ...overrides,
  });

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

/** Install the given mods into AppContext via get_installed_mods. */
function installMods(mods: ModInfo[]) {
  registerInvokeHandler('get_installed_mods', () => mods);
}

/** The "Add from your Library" section is collapsed by default; expand it
 *  so its rows are in the DOM. Returns the section element. */
async function expandLibrary(user: ReturnType<typeof userEvent.setup>) {
  const available = await screen.findByTestId('modpack-detail-available');
  await user.click(
    within(available).getByRole('button', { name: /Add from your library/i }),
  );
  return available;
}

describe('<ModpackDetail>', () => {
  // ── Header ────────────────────────────────────────────────────────
  it('renders the header row with name, Back button, and Switch button for inactive profile', async () => {
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
    render(
      <Wrap
        profile={baseProfile({ name: 'Sample' })}
        onBack={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(await screen.findByText(/ACTIVE/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/i })).toBeNull();
  });

  it('clicking Back fires onBack', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onBack={onBack} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Back to modpacks/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders Shared badge + Re-share in header when shareInfo is provided', async () => {
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

  // ── Two-section layout ────────────────────────────────────────────
  it('Section 1 lists the pack mods and Section 2 lists installed mods not in the pack', async () => {
    installMods([
      modInfo({ name: 'PackMod', folder_name: 'PackMod' }),
      modInfo({ name: 'LibMod', folder_name: 'LibMod' }),
    ]);
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });

    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    expect(within(inPack).getByText('PackMod')).toBeInTheDocument();
    expect(within(inPack).queryByText('LibMod')).toBeNull();

    const available = await expandLibrary(user);
    expect(within(available).getByText('LibMod')).toBeInTheDocument();
    expect(within(available).queryByText('PackMod')).toBeNull();
  });

  it('the Add-from-library section is collapsed by default and expands on click', async () => {
    installMods([
      modInfo({ name: 'PackMod', folder_name: 'PackMod' }),
      modInfo({ name: 'LibMod', folder_name: 'LibMod' }),
    ]);
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    const available = await screen.findByTestId('modpack-detail-available');
    // Collapsed: the section + its toggle are present, but the rows aren't.
    expect(within(available).queryByText('LibMod')).toBeNull();
    expect(within(available).queryByTestId('modpack-mod-row-available')).toBeNull();
    const toggle = within(available).getByRole('button', { name: /Add from your library/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Expand → rows appear.
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(available).getByText('LibMod')).toBeInTheDocument();
  });

  it('renders the shared mod-library toolbar (same affordances as All Mods)', async () => {
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    // Install affordances from the shared toolbar are present in the
    // modpack view too.
    expect(screen.getByRole('button', { name: /Open folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import mod/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick add URL/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
  });

  it('Quick add URL in the modpack view auto-adds the installed mod to this pack', async () => {
    // Installing from the modpack view should drop the mod straight into
    // THIS pack (targetPack), not just onto disk.
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: modInfo({ name: 'NewMod', folder_name: 'NewMod', mod_id: 'NewMod' }),
    }));
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });

    await user.click(screen.getByRole('button', { name: /Quick add URL/i }));
    const input = await screen.findByPlaceholderText(/https:\/\/github\.com\/user\/mod/);
    await user.type(input, 'https://github.com/x/y');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const call = getInvokeCalls().find(
        (c) => c.cmd === 'set_profile_mod_membership' && c.args?.modName === 'NewMod',
      );
      expect(call?.args).toMatchObject({
        profileName: 'Sample',
        modName: 'NewMod',
        included: true,
      });
    });
  });

  it('shows the empty in-pack message when the pack has no mods', async () => {
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(
      await screen.findByText(/No mods in this modpack yet/i),
    ).toBeInTheDocument();
  });

  it('hides Section 2 and shows the all-in-pack note when every installed mod is in the pack', async () => {
    installMods([modInfo({ name: 'PackMod', folder_name: 'PackMod' })]);
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await waitFor(() => {
      expect(screen.queryByTestId('modpack-detail-available')).toBeNull();
    });
    expect(screen.getByTestId('modpack-detail-all-in-pack')).toBeInTheDocument();
  });

  it('renders no drag handle and no rank chip anywhere in the detail view', async () => {
    installMods([
      modInfo({ name: 'PackMod', folder_name: 'PackMod' }),
      modInfo({ name: 'LibMod', folder_name: 'LibMod' }),
    ]);
    const { container } = render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByTestId('modpack-detail-in-pack');
    expect(container.querySelector('.gf-load-order-drag')).toBeNull();
    expect(container.querySelector('.gf-load-order-rank-inline')).toBeNull();
    // No membership checkbox either.
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('source badges derive from the matching installed ModInfo', async () => {
    installMods([
      modInfo({ name: 'PackMod', folder_name: 'PackMod', github_url: 'https://github.com/x/y' }),
      modInfo({ name: 'LibMod', folder_name: 'LibMod', nexus_url: 'https://nexusmods.com/z' }),
    ]);
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    expect(within(inPack).getByText('GitHub')).toBeInTheDocument();
    const available = await expandLibrary(user);
    expect(within(available).getByText('Nexus')).toBeInTheDocument();
  });

  // ── Membership: Remove ────────────────────────────────────────────
  it('Remove on an in-pack row calls set_profile_mod_membership with included=false', async () => {
    installMods([modInfo({ name: 'PackMod', folder_name: 'PackMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod', mod_id: 'PackMod' })] })}
        onBack={vi.fn()}
        onLibraryChanged={onLibraryChanged}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /Remove/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership'),
      ).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'set_profile_mod_membership');
    expect(call?.args).toMatchObject({
      profileName: 'Sample',
      modName: 'PackMod',
      folderName: 'PackMod',
      modId: 'PackMod',
      included: false,
    });
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
  });

  // ── Membership: Add ───────────────────────────────────────────────
  it('Add on an available row calls set_profile_mod_membership with included=true', async () => {
    installMods([modInfo({ name: 'LibMod', folder_name: 'LibMod', mod_id: 'LibMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} onLibraryChanged={onLibraryChanged} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership'),
      ).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'set_profile_mod_membership');
    expect(call?.args).toMatchObject({
      profileName: 'Sample',
      modName: 'LibMod',
      folderName: 'LibMod',
      modId: 'LibMod',
      included: true,
    });
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
  });

  // ── Active-pack toggle_mod side effect ────────────────────────────
  it('Add on the ACTIVE pack also calls toggle_mod with enable=true', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    installMods([modInfo({ name: 'LibMod', folder_name: 'LibMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'toggle_mod');
    expect(call?.args).toMatchObject({
      name: 'LibMod',
      folderName: 'LibMod',
      enable: true,
    });
  });

  it('Remove on the ACTIVE pack also calls toggle_mod with enable=false', async () => {
    registerInvokeHandler('get_active_profile', () => 'Sample');
    installMods([modInfo({ name: 'PackMod', folder_name: 'PackMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /Remove/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(true);
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'toggle_mod');
    expect(call?.args).toMatchObject({
      name: 'PackMod',
      folderName: 'PackMod',
      enable: false,
    });
  });

  it('does NOT call toggle_mod when the pack is not active', async () => {
    // active profile defaults to null (inactive Sample).
    installMods([modInfo({ name: 'LibMod', folder_name: 'LibMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(
        getInvokeCalls().some((c) => c.cmd === 'set_profile_mod_membership'),
      ).toBe(true);
    });
    expect(getInvokeCalls().some((c) => c.cmd === 'toggle_mod')).toBe(false);
  });

  // ── Load order ────────────────────────────────────────────────────
  it('Load order button in Section 1 calls onOpenLoadOrder', async () => {
    installMods([modInfo({ name: 'PackMod', folder_name: 'PackMod' })]);
    const onOpenLoadOrder = vi.fn();
    const user = userEvent.setup();
    const profile = baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] });
    render(<Wrap profile={profile} onBack={vi.fn()} onOpenLoadOrder={onOpenLoadOrder} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /Load order/i }));
    expect(onOpenLoadOrder).toHaveBeenCalledWith(profile);
  });

  it('Load order button is disabled when the pack has no mods', async () => {
    const user = userEvent.setup();
    const onOpenLoadOrder = vi.fn();
    render(<Wrap {...baseProps()} onOpenLoadOrder={onOpenLoadOrder} />);
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    const btn = within(inPack).getByRole('button', { name: /Load order/i });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onOpenLoadOrder).not.toHaveBeenCalled();
  });

  // ── Advanced actions (header kebab) ───────────────────────────────
  it('Advanced actions live in the header kebab and fire their handlers', async () => {
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
    // The bottom advanced panel is gone — actions moved to a header kebab.
    expect(screen.queryByTestId('modpack-detail-advanced-panel')).toBeNull();

    // Each selection closes the kebab, so reopen between clicks.
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.getByRole('menuitem', { name: /Delete modpack/i })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Export JSON/i }));
    expect(onExportJson).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Snapshot/i }));
    expect(onSnapshot).toHaveBeenCalledWith('Sample');

    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete modpack/i }));
    expect(onDelete).toHaveBeenCalledWith('Sample');
  });

  it('Repair drift item shows in the kebab only when drift.has_drift is true and fires its handler', async () => {
    const onRepairDrift = vi.fn();
    const drift: ProfileDrift = {
      added: ['Orphan'],
      removed: [],
      toggled: [],
      version_changed: [],
      has_drift: true,
    };
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} drift={drift} onRepairDrift={onRepairDrift} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Repair/i }));
    expect(onRepairDrift).toHaveBeenCalledWith('Sample');
  });

  it('Repair item is omitted from the kebab when no drift is reported', async () => {
    const user = userEvent.setup();
    // onDelete keeps the kebab present so we can assert Repair's absence
    // (a kebab with zero items wouldn't render at all).
    render(<Wrap {...baseProps()} onDelete={vi.fn()} onRepairDrift={vi.fn()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    await user.click(screen.getByRole('button', { name: /Advanced actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Repair/i })).toBeNull();
  });

  // ── Search ────────────────────────────────────────────────────────
  it('search filters both sections by name', async () => {
    installMods([
      modInfo({ name: 'AlphaPack', folder_name: 'AlphaPack' }),
      modInfo({ name: 'BetaLib', folder_name: 'BetaLib' }),
      modInfo({ name: 'GammaLib', folder_name: 'GammaLib' }),
    ]);
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'AlphaPack', folder_name: 'AlphaPack' })] })}
        onBack={vi.fn()}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    const available = await expandLibrary(user);
    // Before filtering: AlphaPack in-pack, BetaLib + GammaLib available.
    expect(within(inPack).getByText('AlphaPack')).toBeInTheDocument();
    expect(within(available).getByText('BetaLib')).toBeInTheDocument();
    expect(within(available).getByText('GammaLib')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'beta');
    // In-pack now hides AlphaPack (no match); available keeps only BetaLib.
    await waitFor(() => {
      expect(within(inPack).queryByText('AlphaPack')).toBeNull();
    });
    expect(within(available).getByText('BetaLib')).toBeInTheDocument();
    expect(within(available).queryByText('GammaLib')).toBeNull();
  });

  // ── Audit summary chips (carried over) ────────────────────────────
  it('audit summary chips are hidden when there is no audit data', async () => {
    render(<Wrap {...baseProps()} />);
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(screen.queryByTestId('modpack-detail-audit')).toBeNull();
  });

  it('missing-source audit chip shows count of mods with no source + no bundle', async () => {
    render(
      <Wrap
        profile={baseProfile({
          name: 'Sample',
          mods: [
            profileMod({ name: 'NoSource', folder_name: 'NoSource', source: null, bundle_url: null }),
            profileMod({ name: 'HasSource', folder_name: 'HasSource', source: 'https://github.com/x/y' }),
          ],
        })}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 2, name: 'Sample' });
    expect(await screen.findByTestId('audit-chip-missing')).toBeInTheDocument();
    expect(screen.getByText(/1 mod missing source/i)).toBeInTheDocument();
  });

  // ── Row presentation edge cases ───────────────────────────────────
  it('shows the Local badge for a mod with a source but no GitHub/Nexus link', async () => {
    installMods([
      modInfo({ name: 'SideloadMod', folder_name: 'SideloadMod', source: 'file:///x', github_url: null, nexus_url: null }),
    ]);
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    const available = await expandLibrary(user);
    expect(within(available).getByText(/^Local$/i)).toBeInTheDocument();
  });

  it('prefers the installed ModInfo display_name over the manifest name', async () => {
    installMods([
      modInfo({ name: 'PackMod', folder_name: 'PackMod', display_name: 'Pretty Pack Name' }),
    ]);
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    expect(within(inPack).getByText('Pretty Pack Name')).toBeInTheDocument();
  });

  it('surfaces an error toast when adding a mod fails', async () => {
    installMods([modInfo({ name: 'LibMod', folder_name: 'LibMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => {
      throw new Error('disk full');
    });
    const user = userEvent.setup();
    render(<Wrap {...baseProps()} />);
    const available = await expandLibrary(user);
    await user.click(within(available).getByRole('button', { name: /^Add$/i }));
    expect(await screen.findByText(/Couldn't add LibMod: disk full/i)).toBeInTheDocument();
  });

  it('surfaces a success toast when removing a mod', async () => {
    installMods([modInfo({ name: 'PackMod', folder_name: 'PackMod' })]);
    registerInvokeHandler('set_profile_mod_membership', () => baseProfile());
    const user = userEvent.setup();
    render(
      <Wrap
        profile={baseProfile({ mods: [profileMod({ name: 'PackMod', folder_name: 'PackMod' })] })}
        onBack={vi.fn()}
      />,
    );
    const inPack = await screen.findByTestId('modpack-detail-in-pack');
    await user.click(within(inPack).getByRole('button', { name: /Remove/i }));
    expect(await screen.findByText(/Removed PackMod from Sample/i)).toBeInTheDocument();
  });
});
