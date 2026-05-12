import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LaunchSpinner } from './LaunchSpinner';

describe('<LaunchSpinner>', () => {
  it('renders the standard launching message by default', () => {
    render(<LaunchSpinner onCancel={() => {}} />);
    expect(screen.getByText('Launching Slay the Spire 2')).toBeInTheDocument();
    // Default subtitle (mods enabled path)
    expect(screen.getByText(/Verifying mods/)).toBeInTheDocument();
  });

  it('switches to the vanilla copy when vanilla=true', () => {
    render(<LaunchSpinner vanilla onCancel={() => {}} />);
    expect(screen.getByText('Launching Slay the Spire 2 (vanilla)')).toBeInTheDocument();
    expect(screen.getByText(/All mods are temporarily disabled/)).toBeInTheDocument();
  });

  it('fires onCancel when "Hide" is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<LaunchSpinner onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
