import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrowseView } from './Browse';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function Wrap() {
  return (
    <AllProviders>
      <BrowseView />
    </AllProviders>
  );
}

describe('<BrowseView>', () => {
  it('renders the three browse tabs', async () => {
    render(<Wrap />);
    await waitFor(() => {
      // GitHub tab is default; Trending + Latest tabs are siblings.
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Trending|Latest/i).length).toBeGreaterThan(0);
  });

  it('GitHub search invokes search_github_mods', async () => {
    registerInvokeHandler('search_github_mods', () => [
      {
        full_name: 'jadistanbelly/autopath-sts2',
        name: 'autopath-sts2',
        description: 'Auto-path mod',
        html_url: 'https://github.com/jadistanbelly/autopath-sts2',
        stargazers_count: 12,
        updated_at: '2026-05-01T00:00:00Z',
        owner: { login: 'jadistanbelly', avatar_url: '' },
        topics: [],
      },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    const search = await screen.findByPlaceholderText(/Search GitHub|Search/i);
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

  it('Nexus trending tab pulls from nexus_get_trending on click', async () => {
    registerInvokeHandler('nexus_get_trending', () => [
      { mod_id: 1, name: 'Hot Mod', summary: 'A trending mod', version: '1.0' },
    ]);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /GitHub/i })).toBeInTheDocument();
    });
    // Click Trending tab — text appears either as standalone button or
    // with an icon. Use partial match.
    const trendingBtns = screen.getAllByText(/Trending/i);
    await user.click(trendingBtns[0].closest('button') ?? trendingBtns[0]);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'nexus_get_trending')).toBe(true);
    });
  });
});
