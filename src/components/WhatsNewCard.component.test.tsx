import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WhatsNewCard } from './WhatsNewCard';
import { setMockAppVersion } from '../__test__/setup';

/**
 * Tests the component side of WhatsNewCard (the parser is tested
 * separately in WhatsNewCard.test.ts). Focuses on:
 *   - showing the right entry when the app version matches a CHANGELOG
 *     entry (1.3.4 in CHANGELOG.md as of writing).
 *   - dismissing per-version via localStorage.
 *   - falling back to the latest released entry when the running
 *     version has no entry (dev build).
 *
 * The bundled CHANGELOG.md is real, not a fixture, because Vite's `?raw`
 * import inlines it at build time. We rely on the v1.3.4 entry being
 * present — if it's ever removed, this suite needs to track a new
 * release-or-fallback target.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('<WhatsNewCard>', () => {
  it('renders the matching entry for the running app version', async () => {
    setMockAppVersion('1.3.4');
    render(<WhatsNewCard />);
    await waitFor(() => {
      expect(screen.getByText(/What's new in v1\.3\.4/)).toBeInTheDocument();
    });
  });

  it('falls back to the latest released entry when the running version is not in CHANGELOG', async () => {
    setMockAppVersion('99.99.99-dev');
    render(<WhatsNewCard />);
    // The "Showing the latest released notes" footer should appear
    // because the running version is not in CHANGELOG.md.
    await waitFor(() => {
      expect(screen.getByText(/Showing the latest released notes/)).toBeInTheDocument();
    });
  });

  it('dismisses on close click and persists per-version in localStorage', async () => {
    setMockAppVersion('1.3.4');
    const user = userEvent.setup();
    const { unmount } = render(<WhatsNewCard />);
    await waitFor(() => {
      expect(screen.getByText(/What's new in v1\.3\.4/)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Dismiss what's new"));

    await waitFor(() => {
      expect(screen.queryByText(/What's new in v1\.3\.4/)).toBeNull();
    });
    expect(localStorage.getItem('sts2mm-whatsnew-seen:1.3.4')).toBe('true');

    // Remount with same version — should stay dismissed
    unmount();
    render(<WhatsNewCard />);
    // Give the effect a chance to run; the entry should NOT come back.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/What's new in v1\.3\.4/)).toBeNull();
  });

  it('full-changelog button opens an external URL', async () => {
    setMockAppVersion('1.3.4');
    const user = userEvent.setup();
    const opener = await import('@tauri-apps/plugin-opener');
    render(<WhatsNewCard />);
    await waitFor(() => {
      expect(screen.getByText(/What's new in v1\.3\.4/)).toBeInTheDocument();
    });
    await user.click(screen.getByText('Full changelog'));
    expect(opener.openUrl).toHaveBeenCalledWith(
      'https://github.com/MohamedSerhan/sts2-mod-manager/blob/main/CHANGELOG.md',
    );
  });

  it('renders bold changelog text as styled emphasis instead of raw markdown', async () => {
    setMockAppVersion('1.3.8');
    const { container } = render(<WhatsNewCard />);

    await waitFor(() => {
      expect(screen.getByText(/What's new in v1\.3\.8/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/\*\*Browse Modpacks\.\*\*/)).toBeNull();
    const strong = container.querySelector('.gf-whatsnew-strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('Browse Modpacks.');
  });
});
