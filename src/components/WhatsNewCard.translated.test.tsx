import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { setMockAppVersion } from '../__test__/setup';
import i18n from '../i18n';

// Mock the changelog lib so the displayed entry and its translation are fully
// deterministic (decoupled from the real bundled CHANGELOG.md + seed data).
const FIXED_ENTRY = { version: '9.9.9', date: '2026-01-01', body: '### English\n- Original line' };
vi.mock('../lib/changelog', async (orig) => {
  const actual = await orig<typeof import('../lib/changelog')>();
  return {
    ...actual,
    getEntryForVersion: vi.fn(() => FIXED_ENTRY),
    getLatestReleasedEntry: vi.fn(() => FIXED_ENTRY),
    getTranslatedBody: vi.fn(),
  };
});

import { WhatsNewCard } from './WhatsNewCard';
import { getTranslatedBody } from '../lib/changelog';

afterEach(async () => {
  vi.mocked(getTranslatedBody).mockReset();
  await i18n.changeLanguage('en');
});

describe('<WhatsNewCard> translated body', () => {
  it('renders the translated body + disclaimer and links to the release page', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue('### Переведено\n- Переведённая строка');
    await i18n.changeLanguage('ru');
    const opener = await import('@tauri-apps/plugin-opener');
    vi.mocked(opener.openUrl).mockClear();
    const user = userEvent.setup();
    render(<WhatsNewCard />);

    // Translated body text appears; the English original does not.
    const translated = await screen.findByText('Переведённая строка');
    expect(translated).toBeInTheDocument();
    expect(screen.queryByText('Original line')).toBeNull();

    // Disclaimer + view-original link → release page for the entry version.
    const link = screen.getByRole('button', { name: /оригинальный список изменений/i });
    await user.click(link);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://github.com/MohamedSerhan/sts2-mod-manager/releases/tag/v9.9.9',
      );
    });
  });

  it('falls back to the English body + English-only notice when no translation exists', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue(null);
    await i18n.changeLanguage('ru');
    render(<WhatsNewCard />);

    expect(await screen.findByText('Original line')).toBeInTheDocument();
    // The no-translation path shows the existing report-a-mistake affordance.
    expect(
      screen.getByRole('button', { name: /Сообщить об ошибке перевода|Report a translation mistake/i }),
    ).toBeInTheDocument();
    // The translated-path "view original" link is NOT shown here.
    expect(screen.queryByRole('button', { name: /оригинальный список изменений/i })).toBeNull();
  });

  it('shows no locale notice in English', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue(null);
    render(<WhatsNewCard />);
    expect(await screen.findByText('Original line')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report a translation mistake/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view the original English/i })).toBeNull();
  });
});
