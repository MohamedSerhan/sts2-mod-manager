import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SubUpdateDetail } from './SubUpdateDetail';
import type { SubscriptionUpdate } from '../types';

const baseUpdate: SubscriptionUpdate = {
  share_id: 'alice/abcd',
  profile_name: 'Daily Pack',
  has_update: true,
  added_mods: [],
  updated_mods: [],
  removed_mods: [],
  remote_profile: null,
};

describe('<SubUpdateDetail>', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SubUpdateDetail open={false} update={baseUpdate} onClose={() => {}} onApply={() => {}} applying={false} />,
    );
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders nothing when update is null even if open', () => {
    const { container } = render(
      <SubUpdateDetail open update={null} onClose={() => {}} onApply={() => {}} applying={false} />,
    );
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the empty-state body when no mods changed', () => {
    render(
      <SubUpdateDetail open update={baseUpdate} onClose={() => {}} onApply={() => {}} applying={false} />,
    );
    expect(screen.getByText(/already up to date/i)).toBeInTheDocument();
    // Apply button disabled when no changes.
    expect(screen.getByRole('button', { name: /Apply all/ })).toBeDisabled();
  });

  it('renders added / updated / removed rows', () => {
    render(
      <SubUpdateDetail
        open
        update={{
          ...baseUpdate,
          added_mods: ['NewMod'],
          updated_mods: [{ name: 'UpdMod', old_version: '1.0', new_version: '2.0' }],
          removed_mods: ['GoneMod'],
        }}
        onClose={() => {}}
        onApply={() => {}}
        applying={false}
      />,
    );
    expect(screen.getByText('+ ADDED')).toBeInTheDocument();
    expect(screen.getByText('↑ UPDATED')).toBeInTheDocument();
    expect(screen.getByText('− REMOVED')).toBeInTheDocument();
    expect(screen.getByText('NewMod')).toBeInTheDocument();
    expect(screen.getByText('UpdMod')).toBeInTheDocument();
    expect(screen.getByText('GoneMod')).toBeInTheDocument();
    expect(screen.getByText('1.0 → 2.0')).toBeInTheDocument();
    // Header counts the total
    expect(screen.getByText(/3 updates available — Daily Pack/)).toBeInTheDocument();
  });

  it('singular "update" for total=1', () => {
    render(
      <SubUpdateDetail
        open
        update={{ ...baseUpdate, added_mods: ['X'] }}
        onClose={() => {}}
        onApply={() => {}}
        applying={false}
      />,
    );
    expect(screen.getByText(/1 update available/)).toBeInTheDocument();
  });

  it('Apply button calls onApply with share_id', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SubUpdateDetail
        open
        update={{ ...baseUpdate, added_mods: ['X'] }}
        onClose={() => {}}
        onApply={onApply}
        applying={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Apply all/ }));
    expect(onApply).toHaveBeenCalledWith('alice/abcd');
  });

  it('shows "Applying…" and disables Apply when applying=true', () => {
    render(
      <SubUpdateDetail
        open
        update={{ ...baseUpdate, added_mods: ['X'] }}
        onClose={() => {}}
        onApply={() => {}}
        applying
      />,
    );
    expect(screen.getByRole('button', { name: /Applying…/ })).toBeDisabled();
  });

  it('Skip + backdrop both call onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SubUpdateDetail open update={baseUpdate} onClose={onClose} onApply={() => {}} applying={false} />,
    );
    await user.click(screen.getByRole('button', { name: /Skip this update/ }));
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    await user.click(container.querySelector('.gf-modal-back')!);
    expect(onClose).toHaveBeenCalled();
  });
});
