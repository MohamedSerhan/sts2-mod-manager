/**
 * LibraryRow tests — verify the per-mod row renders the right
 * primitives (name + version + storage badge + checkbox + drag handle
 * + rank chip) and that interactions fire the supplied callbacks with
 * the expected arguments.
 *
 * The row is presentation-only; the parent <LibraryTable> owns
 * drag-index state and the Tauri-bound mutation calls. So these tests
 * just spy the callbacks and assert the row's UI signals + handler
 * wiring — no Tauri mock plumbing required.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LibraryRow, type LibraryRowProps } from './LibraryRow';
import { AllProviders } from '../__test__/providers';
import type {
  ModAuditEntry,
  ModInfo,
  ProfileMembershipMod,
  ProfileMembershipState,
} from '../types';

const baseMod = (overrides: Partial<ProfileMembershipMod> = {}): ProfileMembershipMod => ({
  name: 'BaseLib',
  version: '1.2.3',
  folder_name: 'BaseLib',
  mod_id: 'BaseLib',
  display_name: null,
  installed_enabled: true,
  profiles: [],
  ...overrides,
});

const baseState = (
  overrides: Partial<ProfileMembershipState> = {},
): ProfileMembershipState => ({
  profile_name: 'Stable',
  included: true,
  enabled: true,
  editable: true,
  ...overrides,
});

function renderRow(overrides: Partial<LibraryRowProps> = {}) {
  const callbacks = {
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    onToggleMembership: vi.fn(),
    onToggleStorage: vi.fn(),
  };
  const row = overrides.row ?? baseMod();
  const props: LibraryRowProps = {
    row,
    modpackName: 'Stable',
    state: baseState(),
    inPack: true,
    inPackIndex: 0,
    // Default to the load-order context (ModpackDetail) so the drag
    // handle / rank chip / draggable tests below exercise the
    // reorderable path. Library-view tests pass enableReorder=false
    // explicitly.
    enableReorder: true,
    isDragOver: false,
    loadOrderSaving: false,
    membershipSaving: null,
    storageSaving: null,
    ...callbacks,
    ...overrides,
  };
  const utils = render(
    <AllProviders>
      <LibraryRow {...props} />
    </AllProviders>,
  );
  return { ...utils, props, callbacks };
}

describe('<LibraryRow>', () => {
  it('renders the mod display name, raw name when overridden, version, and folder', () => {
    renderRow({
      row: baseMod({
        name: 'raw-manifest-name',
        display_name: 'Readable Name',
        version: '9.9.9',
        folder_name: 'readable-folder',
      }),
    });
    expect(screen.getByText('Readable Name')).toBeInTheDocument();
    expect(screen.getByText('raw-manifest-name')).toBeInTheDocument();
    expect(screen.getByText('v9.9.9')).toBeInTheDocument();
    expect(screen.getByText('readable-folder')).toBeInTheDocument();
  });

  it('does not render the legacy active/stored chip in the primary row (it is a switch now)', () => {
    // The old "Active in game" / "Stored" text chip (.gf-profile-library-storage)
    // was replaced by a dedicated <Toggle> switch. The switch only renders
    // when a `mod` prop is present, so these mod-less renders show neither.
    const { unmount } = renderRow({ row: baseMod({ installed_enabled: true }) });
    expect(document.querySelector('.gf-profile-library-storage')).toBeNull();
    unmount();

    renderRow({ row: baseMod({ installed_enabled: false }) });
    expect(document.querySelector('.gf-profile-library-storage')).toBeNull();
  });

  it('does not render the verbose Store / Activate button (replaced by a compact switch)', () => {
    const { unmount } = renderRow({ row: baseMod({ installed_enabled: true }) });
    expect(screen.queryByRole('button', { name: /Store BaseLib/i })).toBeNull();
    unmount();

    renderRow({ row: baseMod({ installed_enabled: false }) });
    expect(screen.queryByRole('button', { name: /Activate BaseLib/i })).toBeNull();
  });

  it('renders the rank chip "#N" only when enableReorder && inPack && inPackIndex >= 0', () => {
    const { unmount } = renderRow({ enableReorder: true, inPack: true, inPackIndex: 2 });
    expect(screen.getByText('#3')).toBeInTheDocument();
    unmount();

    const { unmount: u2 } = renderRow({ enableReorder: true, inPack: true, inPackIndex: -1 });
    expect(screen.queryByText(/^#/)).toBeNull();
    u2();

    // In-pack but reorder disabled (Library view) → no rank chip.
    renderRow({ enableReorder: false, inPack: true, inPackIndex: 0 });
    expect(screen.queryByText(/^#/)).toBeNull();
  });

  it('renders the drag handle only when enableReorder && inPack && inPackIndex >= 0', () => {
    const { container, unmount } = renderRow({ enableReorder: true, inPack: true, inPackIndex: 0 });
    expect(container.querySelector('.gf-load-order-drag')).not.toBeNull();
    unmount();

    // Not in pack → no handle even with reorder enabled.
    const { container: c2, unmount: u2 } = renderRow({ enableReorder: true, inPack: false, inPackIndex: -1 });
    expect(c2.querySelector('.gf-load-order-drag')).toBeNull();
    u2();

    // In pack but reorder disabled (Library view) → no handle.
    const { container: c3 } = renderRow({ enableReorder: false, inPack: true, inPackIndex: 0 });
    expect(c3.querySelector('.gf-load-order-drag')).toBeNull();
  });

  it('drag handle / rank chip are absent in the Library view (enableReorder=false) even for in-pack rows', () => {
    const { container } = renderRow({ enableReorder: false, inPack: true, inPackIndex: 1 });
    expect(container.querySelector('.gf-load-order-drag')).toBeNull();
    expect(screen.queryByText('#2')).toBeNull();
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('false');
  });

  it('in-pack indicator reflects state.included (read-only status, not a checkbox)', () => {
    const { container, unmount } = renderRow({ state: baseState({ included: true }) });
    const inEl = container.querySelector('.gf-row-inpack');
    expect(inEl).not.toBeNull();
    expect(inEl!.className).toContain('is-in');
    expect(inEl!.textContent).toMatch(/In pack/i);
    // Membership is changed from the kebab now — no checkbox on the row.
    expect(screen.queryByRole('checkbox')).toBeNull();
    unmount();

    const { container: c2 } = renderRow({ state: baseState({ included: false }) });
    const outEl = c2.querySelector('.gf-row-inpack');
    expect(outEl).not.toBeNull();
    expect(outEl!.className).not.toContain('is-in');
    expect(outEl!.textContent).toMatch(/Not in pack/i);
  });

  it('renders the no-modpack-state muted message when state is undefined', () => {
    renderRow({ state: undefined });
    expect(screen.getByText(/This modpack doesn't exist any more/i)).toBeInTheDocument();
  });

  it('membership is changed from the kebab; the indicator itself is static', async () => {
    const { callbacks, container } = renderRow({
      mod: baseModInfo(),
      state: baseState({ included: true }),
    });
    const user = userEvent.setup();
    // Clicking the read-only indicator must NOT mutate membership.
    const inEl = container.querySelector('.gf-row-inpack') as HTMLElement;
    expect(inEl).not.toBeNull();
    await user.click(inEl);
    expect(callbacks.onToggleMembership).not.toHaveBeenCalled();
    // The kebab drives membership instead.
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /remove from/i }));
    expect(callbacks.onToggleMembership).toHaveBeenCalledTimes(1);
  });

  it('drag-start fires onDragStart with the row inPackIndex', () => {
    const { container, callbacks } = renderRow({ inPack: true, inPackIndex: 4 });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card).not.toBeNull();
    fireEvent.dragStart(card);
    expect(callbacks.onDragStart).toHaveBeenCalledTimes(1);
    // 2nd arg is the inPackIndex from the closure.
    expect(callbacks.onDragStart.mock.calls[0][1]).toBe(4);
  });

  it('drag-over / drop / drag-end forward the inPackIndex to the parent', () => {
    const { container, callbacks } = renderRow({ inPack: true, inPackIndex: 2 });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card).not.toBeNull();
    fireEvent.dragOver(card);
    fireEvent.drop(card);
    fireEvent.dragEnd(card);
    expect(callbacks.onDragOver.mock.calls[0][1]).toBe(2);
    expect(callbacks.onDrop.mock.calls[0][1]).toBe(2);
    expect(callbacks.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('drag-leave forwards the inPackIndex', () => {
    const { container, callbacks } = renderRow({ inPack: true, inPackIndex: 1 });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card).not.toBeNull();
    fireEvent.dragLeave(card);
    expect(callbacks.onDragLeave).toHaveBeenCalledTimes(1);
    expect(callbacks.onDragLeave.mock.calls[0][0]).toBe(1);
  });

  it('row is not draggable when loadOrderSaving is true', () => {
    const { container } = renderRow({
      inPack: true,
      inPackIndex: 0,
      loadOrderSaving: true,
    });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('false');
  });

  it('row is draggable=true only when in-pack with index >= 0 and not saving', () => {
    const { container } = renderRow({
      inPack: true,
      inPackIndex: 0,
      loadOrderSaving: false,
    });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('true');
  });

  it('row is not draggable when not inPack (inPack=false, inPackIndex=-1)', () => {
    const { container } = renderRow({ inPack: false, inPackIndex: -1 });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card.getAttribute('draggable')).toBe('false');
  });

  it('isDragOver=true applies the .drag-over class', () => {
    const { container } = renderRow({ isDragOver: true });
    const card = container.querySelector('.gf-profile-library-row') as HTMLElement;
    expect(card.className).toContain('drag-over');
  });

  it('shows a saving spinner on the in-pack indicator while membership is mutating', () => {
    const { container } = renderRow({
      row: baseMod({ folder_name: 'BaseLib' }),
      membershipSaving: 'BaseLib::Stable',
    });
    expect(container.querySelector('.gf-row-inpack .animate-spin')).not.toBeNull();
  });
});

// ── ModRow-style action surface (post-1.7.0 T18 unification) ────────────
//
// LibraryRow absorbed the per-mod kebab + inline audit pill that the
// (now-deleted) ModRow used to expose. These tests cover the new prop
// surface: the kebab items, the update / blocked / frozen / snoozed
// pills, the source-pill row beside the storage button, and the
// HelpHint on the storage chip.

const baseModInfo = (overrides: Partial<ModInfo> = {}): ModInfo => ({
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

const baseAudit = (overrides: Partial<ModAuditEntry> = {}): ModAuditEntry => ({
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
  ...overrides,
});

describe('<LibraryRow> kebab + audit pills', () => {
  it('renders the kebab trigger when a mod prop is supplied', () => {
    renderRow({ mod: baseModInfo() });
    expect(screen.getByRole('button', { name: /mod actions/i })).toBeInTheDocument();
  });

  it('does not render the kebab when mod is omitted (presentation-only mode)', () => {
    renderRow({ mod: undefined });
    expect(screen.queryByRole('button', { name: /mod actions/i })).toBeNull();
  });

  it('kebab no longer carries an Activate / Disable in game item (it is a row switch now)', async () => {
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo({ enabled: false }) });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    // The verbose "Activate / Disable in game" kebab entry was retired —
    // the active/stored switch on the row replaces it.
    expect(screen.queryByRole('menuitem', { name: /in game/i })).toBeNull();
  });

  it('kebab → Freeze fires onTogglePin', async () => {
    const onTogglePin = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onTogglePin });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /freeze this mod/i }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('kebab → Unfreeze fires onTogglePin when pinned', async () => {
    const onTogglePin = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo({ pinned: true }), onTogglePin });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /unfreeze this mod/i }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('kebab → Copy version fires onCopyVersion', async () => {
    const onCopyVersion = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onCopyVersion });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /copy version/i }));
    expect(onCopyVersion).toHaveBeenCalledTimes(1);
  });

  it('kebab → Open mods folder fires onOpenModsFolder', async () => {
    const onOpenModsFolder = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onOpenModsFolder });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /open mods folder/i }));
    expect(onOpenModsFolder).toHaveBeenCalledTimes(1);
  });

  it('kebab → Edit sources fires onEditSources', async () => {
    const onEditSources = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onEditSources });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const labels = screen.getAllByText(/^Edit sources/);
    const itemLabel = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(itemLabel).toBeDefined();
    await user.click(itemLabel!.closest('button')!);
    expect(onEditSources).toHaveBeenCalledTimes(1);
  });

  it('kebab → View on GitHub opens the github_url', async () => {
    const onOpenExternalUrl = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      onOpenExternalUrl,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /^view on github$/i }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://github.com/x/y');
  });

  it('kebab → View on Nexus opens the nexus_url', async () => {
    const onOpenExternalUrl = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ nexus_url: 'https://www.nexusmods.com/sts2/mods/42' }),
      onOpenExternalUrl,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /^view on nexus$/i }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith(
      'https://www.nexusmods.com/sts2/mods/42',
    );
  });

  it('kebab → Find GitHub from Nexus is only shown when nexus is linked + github is not', async () => {
    const onFindGithubFromNexus = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({
        github_url: null,
        nexus_url: 'https://www.nexusmods.com/sts2/mods/9',
      }),
      onFindGithubFromNexus,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /find github from nexus/i }));
    expect(onFindGithubFromNexus).toHaveBeenCalledTimes(1);
  });

  it('kebab → Repair fires onRepair when github_url is linked', async () => {
    const onRepair = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      onRepair,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /repair this mod/i }));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it('kebab → Repair is disabled when github_url is missing', async () => {
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo({ github_url: null }) });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const repair = await screen.findByRole('menuitem', { name: /repair this mod/i });
    expect(repair).toBeDisabled();
  });

  it('kebab → Rollback fires onRollback when github_url is linked', async () => {
    const onRollback = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      onRollback,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /roll back one version/i }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it('row Delete (trash) button fires onDelete and is not in the kebab', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onDelete });
    // Delete moved out of the kebab to a visible trash button.
    await user.click(screen.getByRole('button', { name: /Remove BaseLib/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    expect(screen.queryByRole('menuitem', { name: /remove mod/i })).toBeNull();
  });

  it('kebab → Add to "modpack" / Remove from "modpack" reflects the membership chip and fires onToggleMembership', async () => {
    const onToggleMembership = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo(),
      modpackName: 'TestPack',
      state: baseState({ included: false, enabled: false }),
      onToggleMembership,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(
      screen.getByRole('menuitem', { name: /add to "testpack"/i }),
    );
    expect(onToggleMembership).toHaveBeenCalledTimes(1);
  });

  it('kebab Skip update is shown only when an audit update is pending', async () => {
    const onSnooze = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit(),
      onSnooze,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    const labels = await screen.findAllByText(/^Skip this update$/);
    const labelEl = labels.find((el) => el.className.includes('gf-kebab-label'));
    expect(labelEl).toBeDefined();
    await user.click(labelEl!.closest('button')!);
    expect(onSnooze).toHaveBeenCalledTimes(1);
  });

  it('kebab Show update again is shown only when the audit row is snoozed', async () => {
    const onUnsnooze = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit({ snoozed: true }),
      onUnsnooze,
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /show update again/i }));
    expect(onUnsnooze).toHaveBeenCalledTimes(1);
  });

  it('audit pill — Update available pill renders when audit reports a pending update', () => {
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit(),
    });
    expect(screen.getByText(/Update available → v3\.2\.0/)).toBeInTheDocument();
  });

  it('audit pill — clicking the Update pill fires onUpdate', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit(),
      onUpdate,
    });
    await user.click(screen.getByRole('button', { name: /Update available → v3\.2\.0/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('audit pill — Update blocked pill renders when blocked by game version', () => {
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit({
        latest_release_blocked_by_game_version: true,
      }),
    });
    expect(screen.getByText(/Update blocked by game version/i)).toBeInTheDocument();
  });

  it('audit pill — Frozen pill renders when mod.pinned is true', () => {
    renderRow({
      mod: baseModInfo({ pinned: true }),
    });
    expect(screen.getByText('Frozen')).toBeInTheDocument();
  });

  it('audit pill — Skipped pill renders when audit row is snoozed', () => {
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit({ snoozed: true }),
    });
    expect(screen.getByText(/Skipped/)).toBeInTheDocument();
  });

  it('audit pill — Audit error pill renders when audit row carries an error', () => {
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      audit: baseAudit({ error: 'GitHub 404' }),
    });
    expect(screen.getByText(/Audit error/i)).toBeInTheDocument();
  });

  it('min-game-version warning surfaces when gameVersion < mod.min_game_version', () => {
    renderRow({
      mod: baseModInfo({ min_game_version: '0.110.0' }),
      gameVersion: '0.100.0',
    });
    expect(screen.getByText(/needs game ≥ v0\.110\.0/i)).toBeInTheDocument();
  });

  it('no storage HelpHint in the primary row (the active/stored concept left the row)', () => {
    // The "what does Stored mean?" hint anchored the removed
    // active/stored chip. With that chip gone, the hint goes too.
    const { container } = renderRow({ mod: baseModInfo() });
    expect(container.querySelector('.gf-help-hint')).toBeNull();
  });

  it('GitHub + Nexus source pills render in the row action area when URLs are set', () => {
    renderRow({
      mod: baseModInfo({
        github_url: 'https://github.com/foo/bar',
        nexus_url: 'https://www.nexusmods.com/sts2/mods/12',
      }),
    });
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Nexus')).toBeInTheDocument();
  });

  it('sourceEditorSlot renders inside the row when provided', () => {
    renderRow({
      mod: baseModInfo(),
      sourceEditorSlot: <div data-testid="src-editor">EDITOR</div>,
    });
    expect(screen.getByTestId('src-editor')).toBeInTheDocument();
  });
});

// ── modpackName=null mode (Library view; no per-modpack focus) ──────────

describe('<LibraryRow> modpackName=null mode', () => {
  it('does not render the per-modpack checkbox', () => {
    renderRow({ modpackName: null, state: undefined, inPack: false, inPackIndex: -1 });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('does not render the drag handle when not in a focused pack', () => {
    const { container } = renderRow({
      modpackName: null,
      state: undefined,
      inPack: false,
      inPackIndex: -1,
    });
    expect(container.querySelector('.gf-load-order-drag')).toBeNull();
  });

  it('renders the mod identity but no storage chip or Store button', () => {
    renderRow({ modpackName: null, state: undefined, inPack: false, inPackIndex: -1 });
    // Mod is still identifiable by name + version.
    expect(screen.getByText('BaseLib')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    // The active/stored chip + per-row Store/Activate button are gone.
    expect(document.querySelector('.gf-profile-library-storage')).toBeNull();
    expect(screen.queryByRole('button', { name: /Store BaseLib/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Activate BaseLib/i })).toBeNull();
  });

  it('active/stored switch stays present (and fires onToggleStorage) in null mode', async () => {
    const onToggleStorage = vi.fn();
    const user = userEvent.setup();
    renderRow({
      modpackName: null,
      state: undefined,
      inPack: false,
      inPackIndex: -1,
      mod: baseModInfo({ enabled: false }),
      row: baseMod({ installed_enabled: false }),
      onToggleStorage,
    });
    const sw = screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    expect(onToggleStorage).toHaveBeenCalledTimes(1);
    expect(onToggleStorage.mock.calls[0][0]).toMatchObject({ name: 'BaseLib' });
  });

  it('kebab does not render the modpack membership item when modpackName is null', async () => {
    const user = userEvent.setup();
    renderRow({
      modpackName: null,
      state: undefined,
      inPack: false,
      inPackIndex: -1,
      mod: baseModInfo(),
    });
    await user.click(screen.getByRole('button', { name: /mod actions/i }));
    expect(screen.queryByRole('menuitem', { name: /add to/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /remove from/i })).toBeNull();
  });
});

// ── Active / stored switch (restored 1.7.0) ─────────────────────────────
//
// The verbose "Store / Activate" button and the buried kebab item were
// both retired in favour of a single compact switch on the row. ON = the
// mod is active in the game folder; OFF = it's stored on disk. The switch
// only renders when a ModInfo (`mod`) is supplied.

describe('<LibraryRow> active/stored switch', () => {
  it('renders a switch reflecting installed_enabled and a flipping label', () => {
    const { unmount } = renderRow({
      mod: baseModInfo({ enabled: true }),
      row: baseMod({ installed_enabled: true }),
    });
    const on = screen.getByRole('switch', {
      name: /toggle whether BaseLib is active in game/i,
    });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Active in game')).toBeInTheDocument();
    unmount();

    renderRow({
      mod: baseModInfo({ enabled: false }),
      row: baseMod({ installed_enabled: false }),
    });
    const off = screen.getByRole('switch', {
      name: /toggle whether BaseLib is active in game/i,
    });
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Stored')).toBeInTheDocument();
  });

  it('does not render the switch when no mod prop is supplied', () => {
    renderRow({ mod: undefined });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('clicking the switch fires onToggleStorage with the row', async () => {
    const onToggleStorage = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo(),
      row: baseMod({ name: 'BaseLib', folder_name: 'BaseLib' }),
      onToggleStorage,
    });
    await user.click(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    );
    expect(onToggleStorage).toHaveBeenCalledTimes(1);
    expect(onToggleStorage.mock.calls[0][0]).toMatchObject({
      name: 'BaseLib',
      folder_name: 'BaseLib',
    });
  });

  it('disables the switch while the game is running', () => {
    renderRow({ mod: baseModInfo(), gameRunning: true });
    expect(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    ).toBeDisabled();
  });

  it('disables the switch while any storage mutation is in flight', () => {
    renderRow({ mod: baseModInfo(), storageSaving: 'storage::SomethingElse' });
    expect(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    ).toBeDisabled();
  });

  it('shows a spinner next to the switch while THIS row is flipping storage', () => {
    const { container } = renderRow({
      mod: baseModInfo(),
      row: baseMod({ folder_name: 'BaseLib' }),
      storageSaving: 'storage::BaseLib',
    });
    expect(container.querySelector('.gf-row-status .animate-spin')).not.toBeNull();
  });
});

// ── Row click → Edit sources (4.4) + source-badge isolation ─────────────

describe('<LibraryRow> row click + source badges', () => {
  it('clicking the row body fires onEditSources', async () => {
    const onEditSources = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onEditSources });
    await user.click(screen.getByText('BaseLib'));
    expect(onEditSources).toHaveBeenCalledTimes(1);
  });

  it('Enter and Space on the row fire onEditSources', () => {
    const onEditSources = vi.fn();
    renderRow({ mod: baseModInfo(), onEditSources });
    const card = document.querySelector('[data-testid="library-row"]') as HTMLElement;
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onEditSources).toHaveBeenCalledTimes(2);
  });

  it('clicking a source-badge link does not bubble to the row (stopPropagation)', async () => {
    const onEditSources = vi.fn();
    const user = userEvent.setup();
    renderRow({
      mod: baseModInfo({ github_url: 'https://github.com/x/y' }),
      onEditSources,
    });
    const ghLink = screen.getByText('GitHub').closest('a') as HTMLElement;
    await user.click(ghLink);
    expect(onEditSources).not.toHaveBeenCalled();
  });

  it('clicking the active/stored switch does not open Edit sources', async () => {
    const onEditSources = vi.fn();
    const onToggleStorage = vi.fn();
    const user = userEvent.setup();
    renderRow({ mod: baseModInfo(), onEditSources, onToggleStorage });
    await user.click(
      screen.getByRole('switch', { name: /toggle whether BaseLib is active in game/i }),
    );
    expect(onToggleStorage).toHaveBeenCalledTimes(1);
    expect(onEditSources).not.toHaveBeenCalled();
  });

  it('renders a custom-link badge when only custom_url is set', () => {
    renderRow({
      mod: baseModInfo({ github_url: null, nexus_url: null, custom_url: 'https://example.com' }),
    });
    expect(screen.getByText(/^Link$/)).toBeInTheDocument();
  });
});
