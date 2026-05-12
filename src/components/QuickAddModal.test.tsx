import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuickAddModal } from './QuickAddModal';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap({ open = true, onClose = () => {} }: { open?: boolean; onClose?: () => void }) {
  return (
    <AllProviders>
      <QuickAddModal open={open} onClose={onClose} />
    </AllProviders>
  );
}

describe('<QuickAddModal>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the URL input + Cancel + Add button when open', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/github\.com\/owner\/repo/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add & install/i })).toBeInTheDocument();
  });

  it('Add button is disabled when input is empty', () => {
    render(<Wrap />);
    expect(screen.getByRole('button', { name: /Add & install/i })).toBeDisabled();
  });

  it.each([
    ['https://github.com/foo/bar', 'foo/bar', 'GH'],
    ['github.com/foo/bar', 'foo/bar', 'GH'],
    ['github:foo/bar', 'foo/bar', 'GH'],
    ['foo/bar', 'foo/bar', 'GH'],
    ['https://nexusmods.com/sts2/mods/123', 'nexusmods.com/sts2/mods/123', 'NEXUS'],
    ['nexus:sts2/mods/123', 'sts2/123', 'NEXUS'],
  ])('detects %s as %s pill', async (input, expected, pill) => {
    const user = userEvent.setup();
    render(<Wrap />);
    const field = screen.getByPlaceholderText(/github\.com\/owner\/repo/);
    await user.type(field, input);
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    expect(screen.getByText(pill)).toBeInTheDocument();
  });

  it('shows the "Unrecognised URL" helper for random input', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await user.type(screen.getByPlaceholderText(/github\.com\/owner\/repo/), 'random nonsense');
    await waitFor(() => {
      expect(screen.getByText(/Unrecognised URL/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Add & install/i })).toBeDisabled();
  });

  it('Cancel button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop closes the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Wrap onClose={onClose} />);
    const backdrop = container.querySelector('.gf-modal-back')!;
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });

  it('Install of a GitHub URL invokes quick_add_mod + refreshes + closes', async () => {
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'github_installed',
      mod_info: { name: 'AutoPath', version: '1.0', enabled: true, files: [] },
    }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    const field = screen.getByPlaceholderText(/github\.com\/owner\/repo/);
    await user.type(field, 'github.com/foo/bar');
    await user.click(screen.getByRole('button', { name: /Add & install/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'quick_add_mod')).toBe(true);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('Install of a Nexus URL opens the files tab + leaves a sticky toast', async () => {
    registerInvokeHandler('quick_add_mod', () => ({
      type: 'nexus_pending',
      nexus_info: { name: 'BaseLib' },
    }));
    const opener = await import('@tauri-apps/plugin-opener');
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await user.type(
      screen.getByPlaceholderText(/github\.com\/owner\/repo/),
      // Full URL — nexusFilesUrl() requires protocol, otherwise new URL()
      // throws and the prompt-to-open-in-browser path is skipped.
      'https://www.nexusmods.com/sts2/mods/103',
    );
    await user.click(screen.getByRole('button', { name: /Add & install/i }));
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        expect.stringContaining('?tab=files'),
      );
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('toasts an error when quick_add_mod throws', async () => {
    registerInvokeHandler('quick_add_mod', () => { throw new Error('rate-limited'); });
    const user = userEvent.setup();
    render(<Wrap />);
    await user.type(screen.getByPlaceholderText(/github\.com\/owner\/repo/), 'github.com/foo/bar');
    await user.click(screen.getByRole('button', { name: /Add & install/i }));
    await waitFor(() => {
      expect(screen.getByText(/Quick add failed.*rate-limited/)).toBeInTheDocument();
    });
  });
});
