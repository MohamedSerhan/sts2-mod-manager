/**
 * ModRow tests — extracted from Mods.test.tsx after the 1.7.0 T17
 * Library restructure. The row's primary read is now name + version +
 * storage chip + membership chip + ONE kebab, with everything else in
 * an expandable inline drawer.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModRow, type ModRowProps } from './ModRow';
import { AllProviders } from '../__test__/providers';
import type { ModAuditEntry, ModInfo } from '../types';

const baseMod = (overrides: Partial<ModInfo> = {}): ModInfo => ({
  name: 'BaseLib',
  version: '3.1.2',
  description: 'Base library',
  enabled: true,
  files: ['BaseLib.dll'],
  source: null,
  hash: null,
  dependencies: [],
  size_bytes: 1024,
  folder_name: 'BaseLib',
  mod_id: 'baselib',
  github_url: null,
  nexus_url: null,
  pinned: false,
  min_game_version: null,
  author: 'Alchyr',
  tags: [],
  display_name: null,
  display_description: null,
  ...overrides,
});

// Helper that returns a fresh set of vi.fn() callbacks so we can
// assert independently per test on which one fired.
function callbacks() {
  return {
    onToggleExpand: vi.fn(),
    onToggleStorage: vi.fn(),
    onTogglePin: vi.fn(),
    onCopyVersion: vi.fn(),
    onOpenModsFolder: vi.fn(),
    onEditSources: vi.fn(),
    onFindGithubFromNexus: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onRepair: vi.fn(),
    onRollback: vi.fn(),
    onDelete: vi.fn(),
    onUpdate: vi.fn(),
    onOpenExternalUrl: vi.fn(),
    onToggleMembership: vi.fn(),
  };
}

function makeProps(overrides: Partial<ModRowProps> = {}): ModRowProps {
  return {
    mod: baseMod(),
    disambiguator: null,
    audit: undefined,
    membership: null,
    activeProfile: null,
    isMembershipSaving: false,
    gameRunning: false,
    gameVersion: '0.105.0',
    isUpdating: false,
    isRepairing: false,
    isRollingBack: false,
    anyUpdating: false,
    anyRecoveryInFlight: false,
    expanded: false,
    ...callbacks(),
    ...overrides,
  };
}

function Wrap(props: ModRowProps) {
  return (
    <AllProviders>
      <ModRow {...props} />
    </AllProviders>
  );
}

describe('<ModRow>', () => {
  it('renders name, version, and storage chip in the primary read', () => {
    const props = makeProps();
    render(<Wrap {...props} />);
    const row = screen.getByTestId('mod-row');
    expect(within(row).getByText('BaseLib')).toBeInTheDocument();
    expect(within(row).getByText('v3.1.2')).toBeInTheDocument();
    expect(within(row).getByText('Active in game')).toBeInTheDocument();
  });

  it('renders "Stored" chip when mod.enabled is false', () => {
    render(<Wrap {...makeProps({ mod: baseMod({ enabled: false }) })} />);
    expect(screen.getByText('Stored')).toBeInTheDocument();
  });

  it('renders the membership chip when membership is provided', () => {
    render(<Wrap {...makeProps({ membership: 'in', activeProfile: 'TestPack' })} />);
    expect(screen.getByText('In this modpack')).toBeInTheDocument();
  });

  it('renders no membership chip when membership is null (no active modpack)', () => {
    render(<Wrap {...makeProps({ membership: null })} />);
    expect(screen.queryByText(/in this modpack/i)).toBeNull();
    expect(screen.queryByText(/not in this modpack/i)).toBeNull();
  });

  it('renders "Included, off in this modpack" for membership=includedOff', () => {
    render(<Wrap {...makeProps({ membership: 'includedOff', activeProfile: 'TestPack' })} />);
    expect(screen.getByText('Included, off in this modpack')).toBeInTheDocument();
  });

  it('renders "Not in this modpack" for membership=notIn', () => {
    render(<Wrap {...makeProps({ membership: 'notIn', activeProfile: 'TestPack' })} />);
    expect(screen.getByText('Not in this modpack')).toBeInTheDocument();
  });

  it('clicking the membership chip toggles via onToggleMembership', () => {
    const cb = callbacks();
    render(<Wrap {...makeProps({ membership: 'notIn', activeProfile: 'TestPack' })} {...cb} />);
    // The chip is a <button title="Click to add to TestPack"> wrapping
    // the Not-in-this-modpack badge. Title lookup is unambiguous.
    fireEvent.click(screen.getByTitle(/Click to add to "TestPack"/));
    expect(cb.onToggleMembership).toHaveBeenCalledTimes(1);
  });

  it('membership chip click does not also expand the row drawer', () => {
    const cb = callbacks();
    render(<Wrap {...makeProps({ membership: 'notIn', activeProfile: 'TestPack' })} {...cb} />);
    fireEvent.click(screen.getByTitle(/Click to add to "TestPack"/));
    expect(cb.onToggleExpand).not.toHaveBeenCalled();
  });

  it('renders the disambiguator label when two mods share a display name', () => {
    render(<Wrap {...makeProps({ disambiguator: 'Alice' })} />);
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('does NOT render inline source pills in the collapsed primary area', () => {
    // GitHub / Nexus / Custom URL set, but the row is collapsed — none
    // of the badges should be visible (they live in the drawer).
    const mod = baseMod({
      github_url: 'https://github.com/foo/bar',
      nexus_url: 'https://www.nexusmods.com/sts2/mods/1',
      custom_url: 'https://patreon.com/foo',
    });
    render(<Wrap {...makeProps({ mod, expanded: false })} />);
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText('Nexus')).toBeNull();
    expect(screen.queryByText('Link')).toBeNull();
  });

  it('does NOT render an inline toggle switch (storage moves to kebab)', () => {
    // Solo's complaint: the toggle was the most prominent affordance,
    // pulling users away from modpack-driven workflows. The new row
    // has NO role=switch in its primary area.
    render(<Wrap {...makeProps()} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('clicking the main button fires onToggleExpand', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    // The main button's aria-label includes the display name. Use the
    // /show details/i regex so the test passes whichever direction the
    // accordion is in.
    const main = screen.getByRole('button', { name: /show details for BaseLib/i });
    await user.click(main);
    expect(cb.onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('clicking the kebab trigger does NOT fire onToggleExpand', async () => {
    // Per-row event handling — the kebab is wrapped in a div that
    // stopPropagation()s the click so the parent main button doesn't
    // also fire its onToggleExpand handler.
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    const kebabTrigger = screen.getByRole('button', { name: /mod actions/i });
    await user.click(kebabTrigger);
    expect(cb.onToggleExpand).not.toHaveBeenCalled();
  });

  it('kebab → Activate in game fires onToggleStorage when mod is stored', async () => {
    // Solo's complaint: the toggle button was the most prominent
    // affordance on the row. T17 moves the toggle into the kebab as a
    // labeled item so the row's primary read stays clean.
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ enabled: false }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    // KebabItem's accessible name concatenates the label and the
    // description, so we scope to the .gf-kebab-label span which holds
    // only the label text.
    const labels = screen.getAllByText('Activate in game');
    const itemLabel = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(itemLabel).toBeDefined();
    await user.click(itemLabel!.closest('button')!);
    expect(cb.onToggleStorage).toHaveBeenCalledTimes(1);
  });

  it('kebab → Disable in game fires onToggleStorage when mod is active', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ enabled: true }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const labels = screen.getAllByText('Disable in game');
    const itemLabel = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(itemLabel).toBeDefined();
    await user.click(itemLabel!.closest('button')!);
    expect(cb.onToggleStorage).toHaveBeenCalledTimes(1);
  });

  it('kebab → Freeze fires onTogglePin', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /freeze this mod/i }));
    expect(cb.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('kebab → Unfreeze fires onTogglePin when mod is pinned', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ pinned: true }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /unfreeze this mod/i }));
    expect(cb.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('kebab → Copy version fires onCopyVersion', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /copy version/i }));
    expect(cb.onCopyVersion).toHaveBeenCalledTimes(1);
  });

  it('kebab → Open mods folder fires onOpenModsFolder', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /open mods folder/i }));
    expect(cb.onOpenModsFolder).toHaveBeenCalledTimes(1);
  });

  it('kebab → Edit sources fires onEditSources', async () => {
    // The Repair / Rollback descriptions also mention "Edit sources" so
    // a naive role=menuitem name=/edit sources/ lookup matches three
    // items. Scope by the .gf-kebab-label span to hit the right one.
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const labels = screen.getAllByText(/^Edit sources/);
    const itemLabel = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(itemLabel).toBeDefined();
    await user.click(itemLabel!.closest('button')!);
    expect(cb.onEditSources).toHaveBeenCalledTimes(1);
  });

  it('kebab → Repair fires onRepair when github_url is linked', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ github_url: 'https://github.com/x/y' }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /repair this mod/i }));
    expect(cb.onRepair).toHaveBeenCalledTimes(1);
  });

  it('kebab → Repair is disabled when no github_url is linked', async () => {
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ mod: baseMod({ github_url: null }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const repair = await screen.findByRole('menuitem', { name: /repair this mod/i });
    expect(repair).toBeDisabled();
  });

  it('kebab → Rollback fires onRollback when github_url is linked', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ github_url: 'https://github.com/x/y' }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /roll back one version/i }));
    expect(cb.onRollback).toHaveBeenCalledTimes(1);
  });

  it('kebab → Delete fires onDelete', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /remove mod/i }));
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });

  it('kebab → View on GitHub fires onOpenExternalUrl with the github_url', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, mod: baseMod({ github_url: 'https://github.com/x/y' }) })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /^view on github$/i }));
    expect(cb.onOpenExternalUrl).toHaveBeenCalledWith('https://github.com/x/y');
  });

  it('kebab → Find GitHub from Nexus is only present when nexus is linked and github is not', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(
      <Wrap
        {...makeProps({
          ...cb,
          mod: baseMod({ github_url: null, nexus_url: 'https://www.nexusmods.com/x/y' }),
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /find github from nexus/i }));
    expect(cb.onFindGithubFromNexus).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the drawer when collapsed', () => {
    render(<Wrap {...makeProps({ expanded: false })} />);
    expect(screen.queryByTestId('mod-row-drawer')).toBeNull();
  });

  it('renders the drawer when expanded', () => {
    render(<Wrap {...makeProps({ expanded: true })} />);
    expect(screen.getByTestId('mod-row-drawer')).toBeInTheDocument();
  });

  it('drawer surfaces GitHub + Nexus source pills', () => {
    render(
      <Wrap
        {...makeProps({
          expanded: true,
          mod: baseMod({
            github_url: 'https://github.com/foo/bar',
            nexus_url: 'https://www.nexusmods.com/sts2/mods/1',
          }),
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByText('GitHub')).toBeInTheDocument();
    expect(within(drawer).getByText('Nexus')).toBeInTheDocument();
  });

  it('drawer surfaces an "Unlinked" badge when no source is set', () => {
    render(<Wrap {...makeProps({ expanded: true })} />);
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByText(/Unlinked/i)).toBeInTheDocument();
  });

  it('drawer surfaces a Local badge when source is set but no github/nexus URL', () => {
    render(
      <Wrap
        {...makeProps({
          expanded: true,
          mod: baseMod({ source: 'manual', github_url: null, nexus_url: null }),
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByText(/Local/i)).toBeInTheDocument();
  });

  it('drawer surfaces an "Update available" button that fires onUpdate', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    const audit: ModAuditEntry = {
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_compatible_tag: 'v3.2.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      github_repo: 'x/y',
      latest_release_tag: 'v3.2.0',
      error: null,
      nexus_url: null,
      nexus_version: null,
      nexus_update_available: false,
      update_source: 'github',
    };
    render(
      <Wrap
        {...makeProps({
          ...cb,
          expanded: true,
          mod: baseMod({ github_url: 'https://github.com/x/y' }),
          audit,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /update available → v3\.2\.0/i }));
    expect(cb.onUpdate).toHaveBeenCalledTimes(1);
  });

  it('drawer surfaces a "Frozen" pill when the mod is pinned', () => {
    render(<Wrap {...makeProps({ expanded: true, mod: baseMod({ pinned: true }) })} />);
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByText('Frozen')).toBeInTheDocument();
  });

  it('drawer surfaces a needs-game-version warning when min_game_version is unsatisfied', () => {
    render(
      <Wrap
        {...makeProps({
          expanded: true,
          gameVersion: '0.100.0',
          mod: baseMod({ min_game_version: '0.110.0' }),
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByText(/needs game ≥ v0\.110\.0/i)).toBeInTheDocument();
  });

  it('drawer surfaces an "Open folder" button that fires onOpenModsFolder', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, expanded: true })} />);
    const drawer = screen.getByTestId('mod-row-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^open folder$/i }));
    expect(cb.onOpenModsFolder).toHaveBeenCalledTimes(1);
  });

  it('drawer surfaces an "Edit sources" button that fires onEditSources', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, expanded: true })} />);
    const drawer = screen.getByTestId('mod-row-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^edit sources$/i }));
    expect(cb.onEditSources).toHaveBeenCalledTimes(1);
  });

  it('renders the sourceEditorSlot inside the drawer when provided', () => {
    render(
      <Wrap
        {...makeProps({
          expanded: true,
          sourceEditorSlot: <div data-testid="src-editor">EDITOR</div>,
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    expect(within(drawer).getByTestId('src-editor')).toBeInTheDocument();
  });

  it('does NOT render the sourceEditorSlot when collapsed (drawer absent)', () => {
    render(
      <Wrap
        {...makeProps({
          expanded: false,
          sourceEditorSlot: <div data-testid="src-editor">EDITOR</div>,
        })}
      />,
    );
    expect(screen.queryByTestId('src-editor')).toBeNull();
  });

  it('storage kebab item is disabled when the game is running', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    render(<Wrap {...makeProps({ ...cb, gameRunning: true })} />);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const item = await screen.findByRole('menuitem', { name: /disable in game/i });
    expect(item).toBeDisabled();
    // Clicking a disabled kebab item is a no-op in our KebabMenu
    // implementation. Use fireEvent so we don't have to await jsdom's
    // pointer-events check (userEvent throws on disabled clicks).
    fireEvent.click(item);
    expect(cb.onToggleStorage).not.toHaveBeenCalled();
  });

  it('aria-expanded reflects the expanded prop', () => {
    const { rerender } = render(<Wrap {...makeProps({ expanded: false })} />);
    expect(screen.getByRole('button', { name: /show details/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rerender(<Wrap {...makeProps({ expanded: true })} />);
    expect(screen.getByRole('button', { name: /hide details/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('drawer shows "Skip this update" button when an update is pending', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    const audit: ModAuditEntry = {
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_compatible_tag: 'v3.2.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      github_repo: 'x/y',
      latest_release_tag: 'v3.2.0',
      error: null,
      nexus_url: null,
      nexus_version: null,
      nexus_update_available: false,
      update_source: 'github',
    };
    render(
      <Wrap
        {...makeProps({
          ...cb,
          expanded: true,
          mod: baseMod({ github_url: 'https://github.com/x/y' }),
          audit,
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    await user.click(within(drawer).getByRole('button', { name: /skip this update/i }));
    expect(cb.onSnooze).toHaveBeenCalledTimes(1);
  });

  it('drawer shows "Show update again" button when an update is snoozed', async () => {
    const cb = callbacks();
    const user = userEvent.setup();
    const audit: ModAuditEntry = {
      mod_name: 'BaseLib',
      folder_name: 'BaseLib',
      installed_version: '3.1.2',
      latest_release_with_assets_tag: 'v3.2.0',
      latest_has_assets: true,
      needs_update: true,
      asset_names: [],
      releases_scanned: 1,
      github_auto_detected: false,
      pinned: false,
      github_repo: 'x/y',
      latest_release_tag: 'v3.2.0',
      error: null,
      nexus_url: null,
      nexus_version: null,
      nexus_update_available: false,
      update_source: 'github',
      snoozed: true,
    };
    render(
      <Wrap
        {...makeProps({
          ...cb,
          expanded: true,
          mod: baseMod({ github_url: 'https://github.com/x/y' }),
          audit,
        })}
      />,
    );
    const drawer = screen.getByTestId('mod-row-drawer');
    await user.click(within(drawer).getByRole('button', { name: /show update again/i }));
    expect(cb.onUnsnooze).toHaveBeenCalledTimes(1);
  });

  it('description renders outside the drawer (always visible context)', () => {
    render(
      <Wrap
        {...makeProps({
          mod: baseMod({
            display_description: 'A handy library for mods',
          }),
        })}
      />,
    );
    expect(screen.getByText('A handy library for mods')).toBeInTheDocument();
  });
});
