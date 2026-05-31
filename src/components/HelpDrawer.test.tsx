import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HelpDrawer } from './HelpDrawer';
import { AllProviders } from '../__test__/providers';

/**
 * HelpDrawer is the topbar `?` slide-out introduced in 1.7.0. It
 * renders the same <HelpContent /> the Settings → Help tab shows.
 * Tests cover the three close paths (X button, backdrop click,
 * Escape key), that the FAQ content flows through, and — since 1.7.0
 * — the focus management it shares with the form modals via
 * useModalA11y (initial focus, aria-modal, Tab focus-trap).
 */

// Mirror of useModalA11y's focusable selector so the trap test can find
// the same elements the hook does.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  it('renders a modal dialog + Help content when open=true', () => {
    renderDrawer(() => {});
    const dialog = screen.getByRole('dialog', { name: /^Help$/i });
    expect(dialog).toBeInTheDocument();
    // Now a proper modal dialog (focus-trapped, backdrop-isolated).
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Drawer header has the "Help" h2.
    expect(screen.getByRole('heading', { level: 2, name: /^Help$/i })).toBeInTheDocument();
    // HelpContent renders the Player + Creator + FAQ cards. Probe the
    // FAQ button to confirm the shared content piped through.
    expect(
      screen.getByRole('button', { name: /what is a modpack/i }),
    ).toBeInTheDocument();
  });

  it('moves initial focus into the drawer on open', () => {
    renderDrawer(() => {});
    const dialog = screen.getByRole('dialog', { name: /^Help$/i });
    // useModalA11y pulls focus inside so keyboard users start in the drawer.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
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

  it('closes on Escape key', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(onClose);
    // Focus starts inside the drawer (useModalA11y), so Escape on the
    // focused element bubbles to the drawer's keydown trap and closes.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('non-Escape keydown does NOT close', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDrawer(onClose);
    await user.keyboard('a');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab focus within the drawer (wraps at both ends)', () => {
    renderDrawer(() => {});
    const dialog = screen.getByRole('dialog', { name: /^Help$/i });
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Tab off the last focusable wraps back to the first.
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Shift+Tab off the first focusable wraps to the last.
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('does not leak a global Escape listener once closed', () => {
    // The drawer's Escape handling now lives on the panel node (mounted
    // only while open), not on document. A stray Escape on document must
    // never fire onClose — open or, here, after the drawer is closed.
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
