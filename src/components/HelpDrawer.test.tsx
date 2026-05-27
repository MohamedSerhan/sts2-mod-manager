import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HelpDrawer } from './HelpDrawer';
import { AllProviders } from '../__test__/providers';

/**
 * HelpDrawer is the topbar `?` slide-out introduced in 1.7.0. It
 * renders the same <HelpContent /> the Settings → Help tab shows.
 * Tests cover the three close paths (X button, backdrop click,
 * Escape key) and that the FAQ content flows through.
 */

function renderDrawer(onClose: () => void, open = true) {
  return render(
    <AllProviders>
      <HelpDrawer open={open} onClose={onClose} />
    </AllProviders>,
  );
}

describe('<HelpDrawer>', () => {
  it('renders nothing when open=false', () => {
    renderDrawer(() => {}, false);
    expect(screen.queryByRole('dialog', { name: /Help/i })).not.toBeInTheDocument();
  });

  it('renders the dialog + Help content when open=true', () => {
    renderDrawer(() => {});
    const dialog = screen.getByRole('dialog', { name: /^Help$/i });
    expect(dialog).toBeInTheDocument();
    // Drawer header has the "Help" h2.
    expect(screen.getByRole('heading', { level: 2, name: /^Help$/i })).toBeInTheDocument();
    // HelpContent renders the Player + Creator + FAQ cards. Probe the
    // FAQ button to confirm the shared content piped through.
    expect(
      screen.getByRole('button', { name: /what is a modpack/i }),
    ).toBeInTheDocument();
  });

  it('closes via the X (Close) button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(onClose);
    const closeBtn = screen.getByRole('button', { name: /^Close$/i });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    renderDrawer(onClose);
    // The backdrop is the .gf-drawer-backdrop div. Click it directly
    // (not bubbled from the drawer body, which stops propagation).
    const backdrop = document.querySelector('.gf-drawer-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicks inside the drawer body do NOT close (stopPropagation)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(onClose);
    // Clicking a FAQ button (deep inside the drawer) should not
    // bubble up to the backdrop's onClick.
    const faqBtn = screen.getByRole('button', { name: /what is a modpack/i });
    await user.click(faqBtn);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    renderDrawer(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('non-Escape keydown does NOT close (covers the e.key === "Escape" guard)', () => {
    const onClose = vi.fn();
    renderDrawer(onClose);
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape listener is removed when the drawer closes', () => {
    // Re-render with open=false and confirm a stray Escape doesn't
    // fire onClose. (Catches a regression where the cleanup function
    // wasn't returned from the effect.)
    const onClose = vi.fn();
    const { rerender } = renderDrawer(onClose);
    rerender(
      <AllProviders>
        <HelpDrawer open={false} onClose={onClose} />
      </AllProviders>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
