import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AboutCard } from './AboutCard';
import { AllProviders } from '../__test__/providers';
import { setMockAppVersion } from '../__test__/setup';

/** Wrap in the full provider stack so DiagnosticBundle's useApp resolves. */
function Wrapped() {
  return (
    <AllProviders>
      <AboutCard />
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

  it('"Check for updates" toasts when already on the latest version', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => {
      expect(screen.getByText(/latest version/i)).toBeInTheDocument();
    });
  });

  it('"Check for updates" toasts an error when the check throws', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => {
      expect(screen.getByText(/Update check failed: offline/)).toBeInTheDocument();
    });
  });

  it('button shows "Checking…" + is disabled while the check is in flight', async () => {
    const updater = await import('@tauri-apps/plugin-updater');
    let resolveCheck!: (v: unknown) => void;
    (updater.check as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => { resolveCheck = r; }),
    );
    const user = userEvent.setup();
    render(<Wrapped />);
    const btn = screen.getByRole('button', { name: 'Check for updates' });
    await user.click(btn);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    resolveCheck(null);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
    });
  });

  it('"Generate support bundle" opens the diagnostic modal', async () => {
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(screen.getByRole('button', { name: 'Generate support bundle' }));
    // DiagnosticBundle exposes a dialog with the prompt text "Generate
    // diagnostics bundle". We don't assert deep DOM here; just that the
    // modal opened.
    await waitFor(() => {
      // The diagnostic modal renders some descriptive copy; we look for
      // the title or a known label without locking to a specific phrase.
      const candidates = screen.queryAllByText(/diagnostic|support|bundle/i);
      expect(candidates.length).toBeGreaterThan(1); // toolbar button + modal content
    });
  });
});
