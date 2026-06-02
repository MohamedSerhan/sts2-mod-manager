import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RenameModpackModal } from './RenameModpackModal';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { Profile } from '../types';

const profile = (name: string): Profile => ({
  name, game_version: null, created_by: null, mods: [],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

function Wrap(props: Partial<React.ComponentProps<typeof RenameModpackModal>> = {}) {
  return (
    <AllProviders>
      <RenameModpackModal
        profile={profile('Old')}
        existingNames={['Old', 'Taken']}
        onClose={props.onClose ?? (() => {})}
        onRenamed={props.onRenamed ?? (() => {})}
      />
    </AllProviders>
  );
}

describe('<RenameModpackModal>', () => {
  it('renames on save and reports the new name', async () => {
    registerInvokeHandler('rename_profile', (args) => profile(String(args?.newName)));
    const onRenamed = vi.fn();
    render(<Wrap onRenamed={onRenamed} />);
    const input = screen.getByLabelText(/new name/i);
    fireEvent.change(input, { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('Old', 'Fresh'));
    expect(getInvokeCalls().some((c) => c.cmd === 'rename_profile' && c.args?.newName === 'Fresh')).toBe(true);
  });

  it('blocks a colliding name (case-insensitive) without calling the backend', () => {
    render(<Wrap />);
    fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'rename_profile')).toBe(false);
  });

  it('blocks a blank name', () => {
    render(<Wrap />);
    fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    expect(screen.getByText(/can't be empty/i)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'rename_profile')).toBe(false);
  });
});
