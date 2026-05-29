import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BrowseModpacksView, dedupeBrowserCards, withTimeout } from './BrowseModpacks';
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

describe('dedupeBrowserCards', () => {
  it('keeps the newer card per (owner, name) and discards the older twin', () => {
    const older = {
      owner: 'NessajHu', code: 'AAAA', name: 'My',
      mod_count: 3, created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-10T00:00:00Z',
    };
    const newer = { ...older, code: 'BBBB', updated_at: '2026-05-16T12:00:00Z' };
    const out = dedupeBrowserCards([older, newer]);
    expect(out).toEqual([newer]);
  });

  it('treats names case- and whitespace-insensitively for the dedup key', () => {
    const a = {
      owner: 'jess', code: 'AAAA', name: 'My Pack',
      mod_count: 1, created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-10T00:00:00Z',
    };
    const b = { ...a, code: 'BBBB', name: '  my pack  ', updated_at: '2026-05-11T00:00:00Z' };
    expect(dedupeBrowserCards([a, b])).toEqual([b]);
  });

  it('preserves cards from different curators with the same pack name', () => {
    const a = {
      owner: 'jess', code: 'AAAA', name: 'My',
      mod_count: 3, created_at: '', updated_at: '2026-05-10T00:00:00Z',
    };
    const b = { ...a, owner: 'bob', code: 'BBBB' };
    expect(dedupeBrowserCards([a, b])).toHaveLength(2);
  });
});

describe('withTimeout', () => {
  it('resolves with the value and clears the timer when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'too slow')).resolves.toBe(7);
  });

  it('propagates the underlying rejection when the promise fails first', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'too slow')).rejects.toThrow('boom');
  });

  it('rejects with the timeout message when the promise stalls past the ceiling', async () => {
    vi.useFakeTimers();
    try {
      // A promise that never settles — only the timeout can resolve the race.
      const stalled = new Promise<number>(() => {});
      const raced = withTimeout(stalled, 1000, 'took too long');
      const expectation = expect(raced).rejects.toThrow('took too long');
      await vi.advanceTimersByTimeAsync(1000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('<BrowseModpacksView>', () => {
  it('marks the modpack browser as beta', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () => makePage({ cards: [] }));

    render(<Wrap />);

    expect(await screen.findByRole('heading', { name: 'Browse Modpacks' })).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

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

  it('collapses duplicate publishes from the same curator down to the newest', async () => {
    registerInvokeHandler('fetch_modpack_browser_page', () =>
      makePage({
        cards: [
          {
            owner: 'NessajHu',
            code: 'AAAA-AAAA-AAAA',
            name: 'My',
            mod_count: 3,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-15T00:00:00Z',
          },
          {
            owner: 'NessajHu',
            code: 'BBBB-BBBB-BBBB',
            name: 'My',
            mod_count: 3,
            created_at: '2026-05-02T00:00:00Z',
            updated_at: '2026-05-16T12:00:00Z',
          },
        ],
      }),
    );

    render(<Wrap />);

    expect(await screen.findAllByText('My')).toHaveLength(1);
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

    fireEvent.click(await screen.findByRole('button', { name: /Go to Modpacks/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /Go to Modpacks/i }));
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

  it('error banner "Try again" re-runs the load and can recover', async () => {
    let call = 0;
    registerInvokeHandler('fetch_modpack_browser_page', () => {
      call += 1;
      if (call === 1) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'GitHub returned 500 server error';
      }
      return makePage({
        cards: [
          {
            owner: 'rescuer',
            code: 'AA5A-315D-61AE',
            name: 'Recovered Pack',
            mod_count: 1,
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          },
        ],
      });
    });

    render(<Wrap />);

    // The error banner mounts a dedicated "Try again" button (the header's
    // is a Refresh button, so this name is unambiguous).
    fireEvent.click(await screen.findByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('Recovered Pack')).toBeInTheDocument();
  });

  it('rate-limit banner "Try again" re-runs the load', async () => {
    let call = 0;
    registerInvokeHandler('fetch_modpack_browser_page', () => {
      call += 1;
      if (call === 1) throw new Error('GitHub search returned 429: API rate limit exceeded');
      return makePage({ cards: [] });
    });

    render(<Wrap />);

    await screen.findByText(/rate-limiting us/i);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    await waitFor(() => {
      expect(screen.queryByText(/rate-limiting us/i)).toBeNull();
    });
    expect(await screen.findByText(/be the first to share/i)).toBeInTheDocument();
  });
});
