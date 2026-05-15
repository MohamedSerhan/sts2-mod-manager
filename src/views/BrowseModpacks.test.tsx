import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BrowseModpacksView } from './BrowseModpacks';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { BrowserPage, Profile } from '../types';

function Wrap({ onGoToProfiles }: { onGoToProfiles?: () => void } = {}) {
  return (
    <AllProviders>
      <BrowseModpacksView onGoToProfiles={onGoToProfiles} />
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

  it('renders a normal error banner for non-rate-limit failures', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'GitHub returned 403 forbidden';
    });

    render(<Wrap />);

    expect(
      await screen.findByText(/GitHub returned 403 forbidden/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/rate-limiting us/i)).toBeNull();
  });

  it('surfaces profile-navigation actions in both empty and populated states', async () => {
    const onGoToProfiles = vi.fn();
    registerInvokeHandler('fetch_modpack_browser_page', () => makePage({ cards: [] }));

    const { unmount } = render(<Wrap onGoToProfiles={onGoToProfiles} />);

    fireEvent.click(await screen.findByRole('button', { name: /Go to Profiles/i }));
    expect(onGoToProfiles).toHaveBeenCalledTimes(1);
    unmount();

    registerInvokeHandler('fetch_modpack_browser_page', () =>
      makePage({
        cards: [
          {
            owner: 'solo',
            code: 'AA5A-315D-61AE',
            name: 'One Mod Pack',
            mod_count: 1,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      }),
    );

    render(<Wrap onGoToProfiles={onGoToProfiles} />);

    expect(await screen.findByText('One Mod Pack')).toBeInTheDocument();
    expect(screen.getByText(/1 mod/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Go to Profiles/i }));
    expect(onGoToProfiles).toHaveBeenCalledTimes(2);
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

  it('opens the detail panel when a card is clicked, fetching the shared profile', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () =>
      makePage({
        cards: [
          {
            owner: 'somebody',
            code: 'AA5A-315D-61AE',
            name: 'Click Me Pack',
            mod_count: 2,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      }),
    );

    const profile: Profile = {
      name: 'Click Me Pack',
      game_version: null,
      created_by: 'somebody',
      mods: [
        {
          name: 'Mod Alpha',
          version: '1.0.0',
          source: null,
          hash: null,
          files: [],
          enabled: true,
          bundle_url: null,
          folder_name: null,
          mod_id: null,
        },
        {
          name: 'Mod Beta',
          version: '2.3.1',
          source: null,
          hash: null,
          files: [],
          enabled: true,
          bundle_url: null,
          folder_name: null,
          mod_id: null,
        },
      ],
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-10T00:00:00Z',
    };
    registerInvokeHandler('fetch_shared_profile_cmd', () => profile);

    render(<Wrap />);

    // Wait for the card to render — loud lookup, no if-guard.
    const card = await screen.findByRole('button', { name: /Click Me Pack/ });
    fireEvent.click(card);

    // The detail panel renders the mod list once fetch resolves.
    expect(await screen.findByText('Mod Alpha')).toBeInTheDocument();
    expect(screen.getByText('Mod Beta')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();

    // And we actually called the backend with the owner/code shape.
    const calls = getInvokeCalls().filter((c) => c.cmd === 'fetch_shared_profile_cmd');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ code: 'somebody/AA5A-315D-61AE' });
  });
});
