import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AboutCard } from './AboutCard';
import { AllProviders } from '../__test__/providers';
import { setMockAppVersion } from '../__test__/setup';

/** Wrap in the full provider stack so DiagnosticBundle's useApp resolves. */
function Wrapped({
  onCheckForAppUpdate,
  checkingAppUpdate,
}: {
  onCheckForAppUpdate?: () => void | Promise<void>;
  checkingAppUpdate?: boolean;
} = {}) {
  return (
    <AllProviders>
      <AboutCard
        onCheckForAppUpdate={onCheckForAppUpdate}
        checkingAppUpdate={checkingAppUpdate}
      />
    </AllProviders>
  );
}

describe('<AboutCard>', () => {
  it('renders the running app version in the footer', async () => {
    setMockAppVersion('9.9.9');
    render(<Wrapped />);
    await waitFor(() => {
      expect(screen.getByText(/v9\.9\.9/)).toBeInTheDocument();
    });
  });

  it('renders the author link', () => {
    render(<Wrapped />);
    const link = screen.getByText('Mohamed Serhan');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://github.com/MohamedSerhan');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('"Check for updates" delegates to the shared app-update checker', async () => {
    const onCheckForAppUpdate = vi.fn();
    const user = userEvent.setup();
    render(<Wrapped onCheckForAppUpdate={onCheckForAppUpdate} />);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(onCheckForAppUpdate).toHaveBeenCalledTimes(1);
  });

  it('button shows "Checking…" and is disabled while the shared check is in flight', () => {
    render(<Wrapped checkingAppUpdate />);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });

  it('does not delegate while the shared check is in flight', async () => {
    const onCheckForAppUpdate = vi.fn();
    const user = userEvent.setup();
    render(<Wrapped onCheckForAppUpdate={onCheckForAppUpdate} checkingAppUpdate />);
    await user.click(screen.getByRole('button', { name: 'Checking…' }));
    expect(onCheckForAppUpdate).not.toHaveBeenCalled();
  });

  it('"Report a bug" opens the bug-report modal', async () => {
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(screen.getByRole('button', { name: 'Report a bug' }));
    // The bug-report modal mounts with its describe field.
    await waitFor(() => {
      expect(document.querySelector('.gf-modal-back')).not.toBeNull();
    });
    expect(screen.getByText('What happened?')).toBeInTheDocument();
  });

  it('Bug-report modal Close button closes the modal (covers onClose wiring)', async () => {
    // Exercises the inline onClose callback passed to DiagnosticBundle by
    // opening the modal and then clicking its dedicated Close button.
    // After close, the modal back-drop must drop out of the DOM.
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(screen.getByRole('button', { name: 'Report a bug' }));
    // Wait for the modal to mount.
    await waitFor(() => {
      expect(document.querySelector('.gf-modal-back')).not.toBeNull();
    });
    // The DiagnosticBundle modal has a dedicated Close button inside
    // its modal foot. Click it.
    const modal = document.querySelector('.gf-modal-back .gf-modal') as HTMLElement;
    expect(modal).not.toBeNull();
    const closeBtn = Array.from(modal.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Close',
    );
    expect(closeBtn).toBeDefined();
    await user.click(closeBtn!);
    await waitFor(() => {
      expect(document.querySelector('.gf-modal-back')).toBeNull();
    });
  });

  it('falls back to "v—" when getVersion rejects', async () => {
    const app = await import('@tauri-apps/api/app');
    (app.getVersion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    render(<Wrapped />);
    // The footer reads "v—" when getVersion fails; the catch handler
    // swallows the error and leaves appVersion as the empty default.
    await waitFor(() => {
      expect(screen.getByText(/v—/)).toBeInTheDocument();
    });
  });

});
