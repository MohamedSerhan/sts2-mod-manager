import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrowseView } from './Browse';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap({ onGoToSettings }: { onGoToSettings?: () => void } = {}) {
  return (
    <AllProviders>
      <BrowseView onGoToSettings={onGoToSettings} />
    </AllProviders>
  );
}

function ghRepo(over: Partial<{
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  owner: { login: string; avatar_url: string };
}> = {}) {
  return {
    full_name: 'jadistanbelly/autopath-sts2',
    name: 'autopath-sts2',
    description: 'Auto-path mod',
    html_url: 'https://github.com/jadistanbelly/autopath-sts2',
    stargazers_count: 12,
    updated_at: '2026-05-01T00:00:00Z',
    owner: { login: 'jadistanbelly', avatar_url: '' },
    topics: [],
    ...over,
  };
}

function nexusMod(over: Partial<{
  mod_id: number;
  name: string | null;
  summary: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  category_id: number | null;
  picture_url: string | null;
}> = {}) {
  return {
    mod_id: 1,
    name: 'Hot Mod',
    summary: 'A trending mod',
    description: 'Long description',
    version: '1.0.0',
    author: 'someone',
    category_id: 1,
    picture_url: 'https://example.com/pic.png',
    ...over,
  };
}

describe('<BrowseView>', () => {
  it('renders the three browse tabs', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Trending|Latest/i).length).toBeGreaterThan(0);
  });

  it('shows the default empty state when no search has run', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Search for mods to get started/i)).toBeInTheDocument();
    });
  });

  it('GitHub search invokes search_github_mods and renders results', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'search_github_mods' && c.args?.query === 'autopath',
      )).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('autopath-sts2')).toBeInTheDocument();
    });
  });

  it('GitHub search with empty query is a no-op (no invoke)', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    // Type only whitespace, then submit. handleSearch trims and bails early.
    await user.type(search, '   {Enter}');
    // No search_github_mods call should have been logged.
    expect(getInvokeCalls().some((c) => c.cmd === 'search_github_mods')).toBe(false);
    // Empty-state card still showing.
    expect(screen.getByText(/Search for mods to get started/i)).toBeInTheDocument();
  });

  it('GitHub search with no matches shows the "no mods" toast', async () => {
    // toast.info fires only when finalList.length === 0; force a real empty list.
    registerInvokeHandler('search_github_mods', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'nothinghere{Enter}');
    await waitFor(() => {
      expect(screen.getByText(/No mods found/i)).toBeInTheDocument();
    });
  });

  it('GitHub search failure surfaces a toast error', async () => {
    registerInvokeHandler('search_github_mods', () => {
      throw new Error('rate limited');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'boom{Enter}');
    await waitFor(() => {
      expect(screen.getByText(/Search failed:.*rate limited/i)).toBeInTheDocument();
    });
  });

  it('Install button on a GitHub result fires download_github_mod and shows success', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    registerInvokeHandler('download_github_mod', () => ({
      name: 'autopath-sts2',
      folder_name: 'autopath-sts2',
      version: '1.0',
      enabled: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const installBtn = await screen.findByRole('button', { name: /Install/i });
    await user.click(installBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'download_github_mod'
          && c.args?.owner === 'jadistanbelly'
          && c.args?.repo === 'autopath-sts2',
      )).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Installed: autopath-sts2/i)).toBeInTheDocument();
    });
  });

  it('Install failure surfaces a toast error', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    registerInvokeHandler('download_github_mod', () => {
      throw new Error('network down');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const installBtn = await screen.findByRole('button', { name: /Install/i });
    await user.click(installBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to install autopath-sts2:.*network down/i)).toBeInTheDocument();
    });
  });

  it('clicking a GitHub result card opens the BrowseDetail panel and the in-detail Install fires download_github_mod', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    registerInvokeHandler('download_github_mod', () => ({
      name: 'autopath-sts2',
      folder_name: 'autopath-sts2',
      version: '1.0',
      enabled: true,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    // Click the result heading to open BrowseDetail. The heading lives
    // inside the clickable wrapper div.
    const heading = await screen.findByRole('heading', { name: 'autopath-sts2' });
    await user.click(heading);
    // Detail copy: "What happens on install".
    await waitFor(() => {
      expect(screen.getByText(/What happens on install/i)).toBeInTheDocument();
    });
    // BrowseDetail's Install button (button text "Install" inside the modal).
    const installButtons = screen.getAllByRole('button', { name: /Install/i });
    // The card row Install + the detail Install both match; click the
    // last one which is the modal foot.
    expect(installButtons.length).toBeGreaterThan(1);
    await user.click(installButtons[installButtons.length - 1]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'download_github_mod')).toBe(true);
    });
    // After install, onInstall closes the detail panel.
    await waitFor(() => {
      expect(screen.queryByText(/What happens on install/i)).not.toBeInTheDocument();
    });
  });

  it('BrowseDetail "Open in browser" for a GitHub repo calls openUrl with html_url', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const heading = await screen.findByRole('heading', { name: 'autopath-sts2' });
    await user.click(heading);
    const openBtn = await screen.findByRole('button', { name: /Open in browser/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://github.com/jadistanbelly/autopath-sts2',
      );
    });
  });

  it('BrowseDetail close button hides the panel', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const heading = await screen.findByRole('heading', { name: 'autopath-sts2' });
    await user.click(heading);
    await waitFor(() => {
      expect(screen.getByText(/What happens on install/i)).toBeInTheDocument();
    });
    // Two close affordances render: the X icon button (title="Close")
    // and the foot button (text "Close"). The X icon button uses
    // `title` for its accessible name; the foot is plain text. Pick
    // the foot one explicitly so we exercise the bottom-of-modal path.
    const closeBtns = screen.getAllByRole('button', { name: /Close/i });
    // The foot Close is the one whose text content is exactly "Close".
    const footClose = closeBtns.find((b) => b.textContent?.trim() === 'Close');
    expect(footClose).toBeDefined();
    await user.click(footClose!);
    await waitFor(() => {
      expect(screen.queryByText(/What happens on install/i)).not.toBeInTheDocument();
    });
  });

  it('Add by URL button opens the QuickAddModal', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    const addBtn = await screen.findByRole('button', { name: /Add by URL/i });
    await user.click(addBtn);
    // QuickAddModal renders an input or some recognisable text.
    await waitFor(() => {
      // The modal contains a paste URL prompt; match loosely.
      expect(screen.getAllByText(/URL|Paste|Add/i).length).toBeGreaterThan(0);
    });
  });

  it('Nexus trending tab pulls from nexus_get_trending on click and renders cards', async () => {
    registerInvokeHandler('nexus_get_trending', () => [nexusMod()]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    const trendingBtns = screen.getAllByText(/Trending/i);
    const trendingButton = trendingBtns[0].closest('button');
    expect(trendingButton).not.toBeNull();
    await user.click(trendingButton!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'nexus_get_trending')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Hot Mod')).toBeInTheDocument();
    });
  });

  it('Nexus Latest tab pulls from nexus_get_latest_added on click', async () => {
    registerInvokeHandler('nexus_get_latest_added', () => [
      nexusMod({ mod_id: 9, name: 'Fresh Mod', version: null, author: null }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    const latestBtns = screen.getAllByText(/Latest/i);
    const latestButton = latestBtns[0].closest('button');
    expect(latestButton).not.toBeNull();
    await user.click(latestButton!);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'nexus_get_latest_added')).toBe(true);
    });
    // Card renders with "Unknown author" fallback (author is null).
    await waitFor(() => {
      expect(screen.getByText('Fresh Mod')).toBeInTheDocument();
    });
    expect(screen.getByText(/Unknown author/i)).toBeInTheDocument();
  });

  it('Nexus trending error path shows the "Couldn\'t reach Nexus" empty state', async () => {
    registerInvokeHandler('nexus_get_trending', () => {
      throw new Error('rate limited');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach Nexus/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/rate limited/i)).toBeInTheDocument();
  });

  it('Nexus tab without an API key surfaces the key-missing banner and Open Settings calls back', async () => {
    registerInvokeHandler('nexus_get_trending', () => {
      throw new Error('Nexus API key not set');
    });
    const onGoToSettings = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToSettings={onGoToSettings} />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Nexus is hidden/i)).toBeInTheDocument();
    });
    const settingsBtn = screen.getByRole('button', { name: /Open Settings/i });
    await user.click(settingsBtn);
    expect(onGoToSettings).toHaveBeenCalledTimes(1);
  });

  it('Nexus key-missing banner without onGoToSettings hides the Open Settings button', async () => {
    registerInvokeHandler('nexus_get_trending', () => {
      throw new Error('Nexus API key not set');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Nexus is hidden/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Open Settings/i })).not.toBeInTheDocument();
  });

  it('Nexus tab with no mods shows the "No mods returned" empty state', async () => {
    registerInvokeHandler('nexus_get_trending', () => []);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/No mods returned/i)).toBeInTheDocument();
    });
  });

  it('Nexus tab shows loading state before the response resolves', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    registerInvokeHandler('nexus_get_trending', () => new Promise<unknown>((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Loading trending mods/i)).toBeInTheDocument();
    });
    // Resolve so the effect cleans up before unmount.
    resolve?.([]);
  });

  it('Open on Nexus from a Nexus card calls openUrl with the mods URL', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 42, name: 'HotPickFortyTwo' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText('HotPickFortyTwo')).toBeInTheDocument();
    });
    const openBtn = screen.getByRole('button', { name: /Open on Nexus/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/42',
      );
    });
  });

  it('Open on Nexus surfaces toast error when openUrl rejects', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no browser'));
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 7, name: 'Sad Mod' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText('Sad Mod')).toBeInTheDocument();
    });
    const openBtn = screen.getByRole('button', { name: /Open on Nexus/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to open:.*no browser/i)).toBeInTheDocument();
    });
  });

  it('clicking a Nexus card opens the BrowseDetail panel, and Open in browser calls openUrl with the mods URL', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockClear();
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 99, name: 'DetailMod' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    const heading = await screen.findByRole('heading', { name: 'DetailMod' });
    await user.click(heading);
    // Detail copy: "Nexus install".
    await waitFor(() => {
      expect(screen.getByText(/Nexus install/i)).toBeInTheDocument();
    });
    const openInBrowser = screen.getByRole('button', { name: /Open in browser/i });
    await user.click(openInBrowser);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/99',
      );
    });
  });

  it('clicking the QuickAddModal Cancel button closes it', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    const addBtn = await screen.findByRole('button', { name: /Add by URL/i });
    await user.click(addBtn);
    // Modal renders a Cancel button.
    const cancelBtn = await screen.findByRole('button', { name: /Cancel/i });
    await user.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Cancel/i })).not.toBeInTheDocument();
    });
  });

  it('closing the Nexus BrowseDetail panel hides it', async () => {
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 11, name: 'CloseMe' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    const heading = await screen.findByRole('heading', { name: 'CloseMe' });
    await user.click(heading);
    await waitFor(() => {
      expect(screen.getByText(/Nexus install/i)).toBeInTheDocument();
    });
    // Pick the foot Close button (textContent exactly "Close").
    const closeBtns = screen.getAllByRole('button', { name: /Close/i });
    const footClose = closeBtns.find((b) => b.textContent?.trim() === 'Close');
    expect(footClose).toBeDefined();
    await user.click(footClose!);
    await waitFor(() => {
      expect(screen.queryByText(/Nexus install/i)).not.toBeInTheDocument();
    });
  });

  it('GitHub BrowseDetail "Open in browser" swallows openUrl rejection', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const heading = await screen.findByRole('heading', { name: 'autopath-sts2' });
    await user.click(heading);
    const openBtn = await screen.findByRole('button', { name: /Open in browser/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://github.com/jadistanbelly/autopath-sts2',
      );
    });
    // No toast should appear — the .catch(() => {}) swallows it.
    expect(screen.queryByText(/Failed to open/i)).not.toBeInTheDocument();
    // Detail panel stays open.
    expect(screen.getByText(/What happens on install/i)).toBeInTheDocument();
  });

  it('Nexus BrowseDetail "Open in browser" swallows openUrl rejection', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 55, name: 'OpenRej' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    const heading = await screen.findByRole('heading', { name: 'OpenRej' });
    await user.click(heading);
    const openBtn = await screen.findByRole('button', { name: /Open in browser/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://www.nexusmods.com/slaythespire2/mods/55',
      );
    });
    // .catch(() => {}) swallows the rejection.
    expect(screen.queryByText(/Failed to open/i)).not.toBeInTheDocument();
  });

  it('Nexus Latest loading state uses the "latest" copy', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    registerInvokeHandler('nexus_get_latest_added', () => new Promise<unknown>((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<Wrap />);
    const latestBtns = await screen.findAllByText(/Latest/i);
    await user.click(latestBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Loading latest mods/i)).toBeInTheDocument();
    });
    resolve?.([]);
  });

  it('GitHub search with non-Error rejection uses String() coercion in the toast', async () => {
    registerInvokeHandler('search_github_mods', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string failure';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'oops{Enter}');
    await waitFor(() => {
      expect(screen.getByText(/Search failed:.*plain string failure/i)).toBeInTheDocument();
    });
  });

  it('Install with non-Error rejection uses String() coercion in the toast', async () => {
    registerInvokeHandler('search_github_mods', () => [ghRepo()]);
    registerInvokeHandler('download_github_mod', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain install failure';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    const installBtn = await screen.findByRole('button', { name: /Install/i });
    await user.click(installBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to install autopath-sts2:.*plain install failure/i)).toBeInTheDocument();
    });
  });

  it('Nexus tab with non-Error rejection coerces with String() into the error empty state', async () => {
    registerInvokeHandler('nexus_get_trending', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain nexus failure';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach Nexus/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/plain nexus failure/i)).toBeInTheDocument();
  });

  it('Open on Nexus with non-Error rejection uses String() coercion in the toast', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    // eslint-disable-next-line prefer-promise-reject-errors
    (opener.openUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce('plain open failure');
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 8, name: 'StringFail' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText('StringFail')).toBeInTheDocument();
    });
    const openBtn = screen.getByRole('button', { name: /Open on Nexus/i });
    await user.click(openBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to open:.*plain open failure/i)).toBeInTheDocument();
    });
  });

  it('GitHub search where fuzzy drops everything falls back to the raw backend list', async () => {
    // Return one repo whose tokens won't match the query at all so
    // fuzzyRerank yields []. The view should then surface `repos`
    // (the raw backend list) rather than show empty.
    registerInvokeHandler('search_github_mods', () => [
      ghRepo({ full_name: 'zzz/qqq', name: 'qqq', description: 'unrelated' }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    await waitFor(() => {
      expect(screen.getByText('qqq')).toBeInTheDocument();
    });
    // No "No mods found" toast — we did get results from the fallback.
    expect(screen.queryByText(/No mods found/i)).not.toBeInTheDocument();
  });

  it('GitHub card with null description shows the "No description" fallback', async () => {
    // Drives both the fuzzy-rerank text builder (`r.description ?? ''`)
    // and the card body fallback (`repo.description || 'No description'`).
    registerInvokeHandler('search_github_mods', () => [
      ghRepo({ description: null }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search/i);
    await user.type(search, 'autopath{Enter}');
    // The card heading proves the result rendered.
    await waitFor(() => {
      expect(screen.getByText('autopath-sts2')).toBeInTheDocument();
    });
    // And the description fallback is the GitHub-card body copy.
    expect(screen.getByText(/No description/i)).toBeInTheDocument();
  });

  it('Nexus card with null name falls back to "Mod #<id>"', async () => {
    registerInvokeHandler('nexus_get_trending', () => [
      nexusMod({ mod_id: 314, name: null, summary: null, description: null, version: null, author: null, picture_url: null }),
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const trendingBtns = await screen.findAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button')!);
    await waitFor(() => {
      expect(screen.getByText('Mod #314')).toBeInTheDocument();
    });
    // "No description" fallback when both summary and description are null.
    expect(screen.getByText(/No description/i)).toBeInTheDocument();
  });
});
