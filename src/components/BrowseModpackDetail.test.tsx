import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { listen as listenMock } from '@tauri-apps/api/event';
import { openUrl as openUrlMock } from '@tauri-apps/plugin-opener';

import { BrowseModpackDetail } from './BrowseModpackDetail';
import { fetchSharedProfile, installSharedProfile } from '../hooks/useTauri';
import type { BrowserCard, Profile } from '../types';
import { AllProviders } from '../__test__/providers';

// Mock the useTauri hook surface this component reaches into. The opener
// plugin is already globally mocked in setup.ts, but we re-grab it via
// `vi.mocked(openUrlMock)` for per-test overrides.
//
// Partial mock pattern — AppContext (loaded via AllProviders) also imports
// from useTauri, so we have to preserve the rest of the module.
vi.mock('../hooks/useTauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTauri')>();
  return {
    ...actual,
    fetchSharedProfile: vi.fn(),
    installSharedProfile: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchSharedProfile);
const installMock = vi.mocked(installSharedProfile);
const openUrl = vi.mocked(openUrlMock);

const card: BrowserCard = {
  owner: 'alice',
  code: 'AA5A-315D-61AE',
  name: 'Cool Pack',
  mod_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
};

const profile: Profile = {
  id: 'profile-cool-pack',
  name: 'Cool Pack',
  game_version: '1.0',
  created_by: 'alice',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  mods: [
    {
      name: 'ModAlpha',
      version: '1.2.3',
      source: null,
      hash: null,
      files: [],
      enabled: true,
      bundle_url: null,
      folder_name: null,
      mod_id: null,
    },
    {
      name: 'ModBeta',
      version: '0.9.0',
      source: null,
      hash: null,
      files: [],
      enabled: true,
      bundle_url: null,
      folder_name: null,
      mod_id: null,
    },
  ],
};

function renderDetail(
  overrides: Partial<{
    card: BrowserCard;
    onClose: () => void;
    onInstalled: () => void;
  }> = {},
) {
  return render(
    <AllProviders>
      <BrowseModpackDetail
        card={overrides.card ?? card}
        onClose={overrides.onClose ?? (() => {})}
        onInstalled={overrides.onInstalled}
      />
    </AllProviders>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  installMock.mockReset();
  openUrl.mockReset();
  // Safe defaults so any unhandled re-render (e.g. StrictMode double-effects,
  // re-renders triggered by toast state updates) still gets a Promise back
  // instead of `undefined.then(...)`. Tests override with `mockResolvedValueOnce`
  // / `mockRejectedValueOnce` as needed.
  fetchMock.mockResolvedValue(profile);
  installMock.mockResolvedValue(profile);
  openUrl.mockResolvedValue(undefined);
});

describe('<BrowseModpackDetail>', () => {
  it('loads the shared profile on mount and renders the mod list with names + versions', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    renderDetail();
    expect(fetchMock).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    // Loading copy is visible before the promise resolves.
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    // After resolution, rows render with name + version.
    expect(await screen.findByText('ModAlpha')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('ModBeta')).toBeInTheDocument();
    expect(screen.getByText('0.9.0')).toBeInTheDocument();
    // Loading copy disappears once profile is set.
    await waitFor(() => {
      expect(screen.queryByText(/Loading/)).toBeNull();
    });
  });

  it('keeps the install button disabled while the profile is still loading', async () => {
    // Never-resolving promise — keeps us in the loading state.
    fetchMock.mockReturnValueOnce(new Promise(() => {}) as Promise<Profile>);
    renderDetail();
    const installBtn = screen.getByRole('button', { name: /Install/i });
    expect(installBtn).toBeDisabled();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('surfaces an error toast when fetchSharedProfile rejects (Error instance)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('manifest 404'));
    renderDetail();
    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't load modpack: manifest 404/),
      ).toBeInTheDocument();
    });
  });

  it('stringifies a non-Error rejection in the load-failure toast', async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    fetchMock.mockRejectedValueOnce('plain-string-boom');
    renderDetail();
    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't load modpack: plain-string-boom/),
      ).toBeInTheDocument();
    });
  });

  it('Install click fires installSharedProfile, surfaces success toast, calls onInstalled + onClose', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    installMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const onInstalled = vi.fn();
    const user = userEvent.setup();
    renderDetail({ onClose, onInstalled });
    // Wait for profile to load so the Install button is enabled.
    await screen.findByText('ModAlpha');
    const installBtn = screen.getByRole('button', { name: /Install/i });
    expect(installBtn).not.toBeDisabled();
    await user.click(installBtn);
    await waitFor(() => {
      expect(installMock).toHaveBeenCalledWith('alice/AA5A-315D-61AE');
    });
    // Success toast carries the card name.
    await waitFor(() => {
      expect(screen.getByText('Installed: Cool Pack')).toBeInTheDocument();
    });
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Install click without onInstalled prop still calls onClose on success', async () => {
    // Covers the `?.()` optional-chain branch where onInstalled is undefined.
    fetchMock.mockResolvedValueOnce(profile);
    installMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDetail({ onClose });
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: /Install/i }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('Install failure surfaces an error toast and does NOT close the modal', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    installMock.mockRejectedValueOnce(new Error('disk full'));
    const onClose = vi.fn();
    const onInstalled = vi.fn();
    const user = userEvent.setup();
    renderDetail({ onClose, onInstalled });
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: /Install/i }));
    await waitFor(() => {
      expect(screen.getByText(/Install failed: disk full/)).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('Install failure stringifies non-Error rejections', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    installMock.mockRejectedValueOnce('kaboom');
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: /Install/i }));
    await waitFor(() => {
      expect(screen.getByText(/Install failed: kaboom/)).toBeInTheDocument();
    });
  });

  it('Install button shows "Installing…" copy and is disabled while pending', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    let resolveInstall!: (p: Profile) => void;
    installMock.mockReturnValueOnce(
      new Promise<Profile>((res) => {
        resolveInstall = res;
      }),
    );
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: /Install/i }));
    // While pending: button text flips to "Installing…" and is disabled.
    const busyBtn = await screen.findByRole('button', { name: /Installing/i });
    expect(busyBtn).toBeDisabled();
    resolveInstall(profile);
  });

  it('install-progress listener renders the current download and progress bar while pending', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    let resolveInstall!: (p: Profile) => void;
    installMock.mockReturnValueOnce(
      new Promise<Profile>((res) => {
        resolveInstall = res;
      }),
    );
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: /Install/i }));
    await screen.findByRole('button', { name: /Installing/i });

    const listenSpy = vi.mocked(listenMock);
    const reg = [...listenSpy.mock.calls].reverse().find((c) => c[0] === 'modpack-install-progress');
    expect(reg).toBeDefined();
    const handler = reg![1] as (e: { payload: unknown }) => void;
    handler({
      payload: {
        profile_name: 'Cool Pack',
        stage: 'downloading',
        current: 2,
        total: 5,
        mod_name: 'BigMod',
      },
    });

    await screen.findByText(/Downloading mod 2 of 5: BigMod/);
    const bar = screen.getByRole('progressbar', { name: /Installing Cool Pack/i });
    expect(bar).toHaveAttribute('aria-valuenow', '40');

    handler({
      payload: {
        profile_name: 'Cool Pack',
        stage: 'done',
        current: 5,
        total: 5,
        mod_name: null,
      },
    });
    await waitFor(() => {
      expect(screen.queryByText(/Downloading mod 2 of 5/)).toBeNull();
    });

    resolveInstall(profile);
  });

  it('Curator @owner button opens https://github.com/{owner} via openUrl (success path)', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('ModAlpha');
    const curatorBtn = screen.getByRole('button', { name: /@alice/ });
    await user.click(curatorBtn);
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://github.com/alice');
    });
    // Success path must not surface any "Couldn't" toast.
    expect(screen.queryByText(/Couldn't/)).toBeNull();
  });

  it('Curator @owner button swallows openUrl rejection (no error toast)', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    openUrl.mockReset();
    openUrl.mockRejectedValueOnce(new Error('no browser'));
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('ModAlpha');
    const curatorBtn = screen.getByRole('button', { name: /@alice/ });
    await user.click(curatorBtn);
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://github.com/alice');
    });
    // Rejection is swallowed — no toast surfaces.
    expect(screen.queryByText(/Couldn't open/)).toBeNull();
    expect(screen.queryByText(/no browser/)).toBeNull();
  });

  it('Cancel footer button calls onClose', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDetail({ onClose });
    await screen.findByText('ModAlpha');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Header X (Close title) button calls onClose', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDetail({ onClose });
    await screen.findByText('ModAlpha');
    await user.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Backdrop click closes the modal', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const { container } = renderDetail({ onClose });
    await screen.findByText('ModAlpha');
    const backdrop = container.querySelector('.gf-modal-back') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Click inside the modal body does NOT close (stopPropagation guard)', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    const onClose = vi.fn();
    const { container } = renderDetail({ onClose });
    await screen.findByText('ModAlpha');
    const modal = container.querySelector('.gf-modal') as HTMLElement;
    expect(modal).toBeTruthy();
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Renders singular "1 mod" copy when card.mod_count === 1', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    renderDetail({ card: { ...card, mod_count: 1 } });
    // Subhead text is split across nodes — match the trailing "1 mod" via
    // a function matcher so the · separator + button neighbor don't interfere.
    await waitFor(() => {
      const sub = document.querySelector('.gf-modal-sub');
      expect(sub).toBeTruthy();
      expect(sub!.textContent).toMatch(/1 mod(?!s)/);
    });
  });

  it('Renders plural "N mods" copy when card.mod_count > 1', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    renderDetail({ card: { ...card, mod_count: 5 } });
    await waitFor(() => {
      const sub = document.querySelector('.gf-modal-sub');
      expect(sub).toBeTruthy();
      expect(sub!.textContent).toMatch(/5 mods/);
    });
  });

  it('skips state updates when the modal is unmounted before fetch resolves', async () => {
    // Covers the `cancelled` branches in the effect: when the cleanup
    // function flips `cancelled=true` before the promise settles, the
    // `if (!cancelled)` guards must skip setProfile/setLoading. We use a
    // deferred promise so we can unmount mid-flight, then resolve.
    let resolveFetch!: (p: Profile) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Profile>((res) => {
        resolveFetch = res;
      }),
    );
    const { unmount } = renderDetail();
    // Unmount immediately — effect cleanup sets cancelled=true.
    unmount();
    // Now resolve — both the .then and .finally guards should noop.
    resolveFetch(profile);
    // Drain microtasks so the promise callbacks actually run.
    await Promise.resolve();
    await Promise.resolve();
    // No exception, no act warnings — the cancelled guards silently
    // swallowed the late resolution. (Coverage records both branches
    // of the `if (!cancelled)` checks now.)
  });

  it('skips error toast when the modal is unmounted before fetch rejects', async () => {
    // Covers the cancelled-branch of the `.catch` guard.
    let rejectFetch!: (e: Error) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Profile>((_res, rej) => {
        rejectFetch = rej;
      }),
    );
    const { unmount } = renderDetail();
    unmount();
    rejectFetch(new Error('too late'));
    await Promise.resolve();
    await Promise.resolve();
    // No "Couldn't load modpack" toast should surface after unmount.
    expect(screen.queryByText(/Couldn't load modpack/)).toBeNull();
  });

  it('Renders the card name in the modal title', async () => {
    fetchMock.mockResolvedValueOnce(profile);
    renderDetail();
    // Wait for the load to settle so React state updates flush inside act.
    await screen.findByText('ModAlpha');
    const title = document.querySelector('.gf-modal-title');
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe('Cool Pack');
  });

  it('renders a "N mods" bundle badge for a ProfileMod with bundle_members', async () => {
    // A shared pack that contains a bundle entry (e.g. a Nexus multi-mod download).
    // The bundle ProfileMod carries bundle_members so the friend browsing the pack
    // can see it's a bundle before installing.
    const profileWithBundle: Profile = {
      ...profile,
      mods: [
        {
          name: 'FantasyPack',
          version: '3.0.0',
          source: null,
          hash: null,
          files: [],
          enabled: true,
          bundle_url: null,
          folder_name: 'FantasyPack',
          mod_id: null,
          bundle_members: ['FantasyCore', 'FantasyArt'],
        },
        {
          name: 'ModAlpha',
          version: '1.2.3',
          source: null,
          hash: null,
          files: [],
          enabled: true,
          bundle_url: null,
          folder_name: null,
          mod_id: null,
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(profileWithBundle);
    renderDetail();
    await screen.findByText('FantasyPack');
    // The bundle row must show a "2 mods" member-count badge.
    expect(screen.getByText(/2 mods/i)).toBeInTheDocument();
    // The normal mod row must NOT show any such badge.
    const rows = document.querySelectorAll('.gf-mod-row');
    // ModAlpha's row must not contain a mods badge.
    const alphaRow = [...rows].find((r) => r.textContent?.includes('ModAlpha'));
    expect(alphaRow).toBeTruthy();
    expect(alphaRow!.querySelector('.gf-pill-github')).toBeNull();
  });
});
