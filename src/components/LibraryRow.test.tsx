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
import type { ProfileMembershipMod, ProfileMembershipState } from '../types';

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
    expect(screen.getByText('9.9.9')).toBeInTheDocument();
    expect(screen.getByText('readable-folder')).toBeInTheDocument();
  });

  it('shows the "Active in game" storage badge when installed_enabled is true', () => {
    renderRow({ row: baseMod({ installed_enabled: true }) });
    expect(screen.getByText(/Active in game/i)).toBeInTheDocument();
  });

  it('shows the "Stored" storage badge when installed_enabled is false', () => {
    renderRow({ row: baseMod({ installed_enabled: false }) });
    // The "Stored" badge appears alongside the Activate button — match
    // the badge specifically by its container class.
    const badge = document.querySelector('.gf-profile-library-storage.stored');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/Stored/i);
  });

  it('renders the rank chip "#N" only when inPack && inPackIndex >= 0', () => {
    const { unmount } = renderRow({ inPack: true, inPackIndex: 2 });
    expect(screen.getByText('#3')).toBeInTheDocument();
    unmount();

    renderRow({ inPack: true, inPackIndex: -1 });
    expect(screen.queryByText(/^#/)).toBeNull();
  });

  it('renders the drag-handle GripVertical only for in-pack rows', () => {
    const { container, unmount } = renderRow({ inPack: true, inPackIndex: 0 });
    expect(container.querySelector('.gf-load-order-drag')).not.toBeNull();
    unmount();

    const { container: c2 } = renderRow({ inPack: false, inPackIndex: -1 });
    expect(c2.querySelector('.gf-load-order-drag')).toBeNull();
  });

  it('membership checkbox reflects state.included and is disabled when state.editable is false', () => {
    const { unmount } = renderRow({ state: baseState({ included: true, editable: true }) });
    const checked = screen.getByRole('checkbox', { name: /Toggle BaseLib in Stable/i });
    expect(checked).toBeChecked();
    expect(checked).not.toBeDisabled();
    unmount();

    renderRow({ state: baseState({ included: false, editable: false }) });
    const ro = screen.getByRole('checkbox', { name: /Toggle BaseLib in Stable/i });
    expect(ro).not.toBeChecked();
    expect(ro).toBeDisabled();
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument();
  });

  it('renders the no-modpack-state muted message when state is undefined', () => {
    renderRow({ state: undefined });
    expect(screen.getByText(/This modpack doesn't exist any more/i)).toBeInTheDocument();
  });

  it('clicking the membership checkbox calls onToggleMembership with the row', async () => {
    const { callbacks } = renderRow();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('checkbox', { name: /Toggle BaseLib in Stable/i }),
    );
    expect(callbacks.onToggleMembership).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleMembership.mock.calls[0][0]).toMatchObject({
      name: 'BaseLib',
      folder_name: 'BaseLib',
    });
  });

  it('clicking the Store button calls onToggleStorage with the row', async () => {
    const { callbacks } = renderRow({ row: baseMod({ installed_enabled: true }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Store BaseLib/i }));
    expect(callbacks.onToggleStorage).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleStorage.mock.calls[0][0]).toMatchObject({
      name: 'BaseLib',
    });
  });

  it('shows the Activate button when the mod is stored, and clicking it calls onToggleStorage', async () => {
    const { callbacks } = renderRow({ row: baseMod({ installed_enabled: false }) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Activate BaseLib/i }));
    expect(callbacks.onToggleStorage).toHaveBeenCalledTimes(1);
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

  it('storage button shows the in-flight spinner when storageSaving matches the row key', () => {
    const { container } = renderRow({
      row: baseMod({ folder_name: 'BaseLib' }),
      storageSaving: 'storage::BaseLib',
    });
    // The Refresh icon (animate-spin) appears in the storage button.
    expect(container.querySelector('.gf-profile-library-storage-actions .animate-spin')).not.toBeNull();
  });
});
