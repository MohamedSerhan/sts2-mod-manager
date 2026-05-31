import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WhatsNewCard } from './WhatsNewCard';
import { setMockAppVersion } from '../__test__/setup';
import i18n from '../i18n';

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

  it('survives localStorage.getItem throwing (covers the catch around the dismissed-seen lookup)', async () => {
    // Some browsers / OS profiles disable localStorage entirely. The
    // useEffect lookup is wrapped in try/catch and falls back to
    // `setDismissed(false)` so the card still renders. We force the
    // throw by stubbing getItem just for this test.
    setMockAppVersion('1.3.4');
    const origGet = window.localStorage.getItem;
    window.localStorage.getItem = vi.fn(() => {
      throw new Error('SecurityError: localStorage disabled');
    });
    try {
      render(<WhatsNewCard />);
      // Card still renders the current entry — the catch swallowed the
      // throw and reset dismissed→false so the card stays visible.
      await waitFor(() => {
        expect(screen.getByText(/What's new in v1\.3\.4/)).toBeInTheDocument();
      });
    } finally {
      window.localStorage.getItem = origGet;
    }
  });
});

describe('<WhatsNewCard> non-English locale notice', () => {
  afterEach(async () => {
    // Each non-English test bumps i18n.language; reset to en so later
    // suites that assume the default locale don't start in zh-Hans.
    await i18n.changeLanguage('en');
  });

  it('shows the locale notice when the active language is not English', async () => {
    setMockAppVersion('1.3.4');
    await i18n.changeLanguage('zh-Hans');
    render(<WhatsNewCard />);
    await waitFor(() => {
      // The locale notice copy is keyed off whatsNew.localeNotice — in
      // zh-Hans it mentions the maintainer's English-only release notes.
      // We assert the report-button text, which is the unique trigger
      // for the openExternalUrl branch.
      const reportBtn = screen.getByRole('button', { name: /反馈翻译错误|Report a translation mistake/i });
      expect(reportBtn).toBeInTheDocument();
    });
  });

  it('locale-notice "Report a translation issue" button opens the GitHub issue URL', async () => {
    setMockAppVersion('1.3.4');
    await i18n.changeLanguage('zh-Hans');
    const opener = await import('@tauri-apps/plugin-opener');
    vi.mocked(opener.openUrl).mockClear();
    const user = userEvent.setup();
    render(<WhatsNewCard />);
    const reportBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /反馈翻译错误|Report a translation mistake/i });
      return btn;
    });
    await user.click(reportBtn);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?labels=translation',
      );
    });
  });
});
