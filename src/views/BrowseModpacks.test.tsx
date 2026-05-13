import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { BrowseModpacksView } from './BrowseModpacks';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';
import type { BrowserPage } from '../types';

function Wrap() {
  return (
    <AllProviders>
      <BrowseModpacksView />
    </AllProviders>
  );
}

function makePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    cards: [],
    page: 1,
    has_next_page: false,
    stale: false,
    fetched_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('<BrowseModpacksView>', () => {
  it('renders cards on success', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () =>
      makePage({
        cards: [
          {
            owner: 'somebody',
            code: 'AA5A-315D-61AE',
            name: 'My Cool Modpack',
            mod_count: 7,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      }),
    );

    render(<Wrap />);

    expect(await screen.findByText('My Cool Modpack')).toBeInTheDocument();
    // owner appears in the subline (e.g. "@somebody · 7 mods · …")
    expect(screen.getByText(/somebody/)).toBeInTheDocument();
    expect(screen.getByText(/7 mods/)).toBeInTheDocument();
  });

  it('renders the empty state when no cards come back', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () => makePage({ cards: [] }));

    render(<Wrap />);

    expect(
      await screen.findByText(/be the first to share/i),
    ).toBeInTheDocument();
  });

  it('renders the rate-limit banner when the command throws 429', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () => {
      throw new Error('GitHub search returned 429: API rate limit exceeded');
    });

    render(<Wrap />);

    expect(
      await screen.findByText(/rate-limiting us/i),
    ).toBeInTheDocument();
  });

  it('renders the stale banner when result has stale: true', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () =>
      makePage({
        stale: true,
        cards: [
          {
            owner: 'cached-owner',
            code: 'BB6B-426E-72BF',
            name: 'Cached Modpack',
            mod_count: 3,
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-10T00:00:00Z',
          },
        ],
      }),
    );

    render(<Wrap />);

    await waitFor(() => {
      expect(screen.getByText(/cached results/i)).toBeInTheDocument();
    });
  });
});
