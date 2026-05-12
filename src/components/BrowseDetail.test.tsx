import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrowseDetail } from './BrowseDetail';
import type { GitHubRepo, NexusModInfo } from '../types';

const githubRepo: GitHubRepo = {
  full_name: 'foo/bar',
  name: 'bar',
  description: 'A test repo',
  html_url: 'https://github.com/foo/bar',
  stargazers_count: 42,
  updated_at: '2026-05-01',
  owner: { login: 'foo', avatar_url: '' },
};

const nexusMod: NexusModInfo = {
  mod_id: 103,
  name: 'BaseLib',
  summary: 'Foundation library',
  description: null,
  version: '3.1.2',
  author: 'Alchyr',
  category_id: 1,
  picture_url: null,
};

describe('<BrowseDetail>', () => {
  it('renders the GitHub variant with stars, owner, install + browser buttons', () => {
    const onInstall = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <BrowseDetail
        kind="github"
        repo={githubRepo}
        installing={false}
        onInstall={onInstall}
        onOpenExternal={onOpen}
        onClose={onClose}
      />,
    );
    expect(screen.getAllByText('foo/bar').length).toBeGreaterThan(0);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('by foo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in browser/ })).toBeInTheDocument();
  });

  it('falls back to "No description provided" when the repo has none', () => {
    render(
      <BrowseDetail
        kind="github"
        repo={{ ...githubRepo, description: null }}
        installing={false}
        onInstall={() => {}}
        onOpenExternal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No description provided/)).toBeInTheDocument();
  });

  it('shows "Installing…" when installing=true and disables the button', () => {
    render(
      <BrowseDetail
        kind="github"
        repo={githubRepo}
        installing
        onInstall={() => {}}
        onOpenExternal={() => {}}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /Installing…/ });
    expect(btn).toBeDisabled();
  });

  it('Install + Open buttons fire their handlers', async () => {
    const onInstall = vi.fn();
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowseDetail
        kind="github"
        repo={githubRepo}
        installing={false}
        onInstall={onInstall}
        onOpenExternal={onOpen}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Install/ }));
    expect(onInstall).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Open in browser/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('Close button + backdrop click both call onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <BrowseDetail
        kind="github"
        repo={githubRepo}
        installing={false}
        onInstall={() => {}}
        onOpenExternal={() => {}}
        onClose={onClose}
      />,
    );
    // Two close affordances: the X button (title="Close") + the footer
    // "Close" text button. Click the footer one explicitly.
    const footerClose = screen.getAllByRole('button').find(
      (b) => b.textContent === 'Close' && !b.getAttribute('title'),
    );
    await user.click(footerClose!);
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    await user.click(container.querySelector('.gf-modal-back')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the Nexus variant with author + version + summary', () => {
    render(
      <BrowseDetail
        kind="nexus"
        mod={nexusMod}
        onOpenExternal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('BaseLib')).toBeInTheDocument();
    expect(screen.getByText(/by Alchyr/)).toBeInTheDocument();
    expect(screen.getByText(/v3\.1\.2/)).toBeInTheDocument();
    expect(screen.getByText(/Foundation library/)).toBeInTheDocument();
    // Nexus variant has no Install button (clarifies the "no direct download" UX).
    expect(screen.queryByRole('button', { name: /Install$/ })).toBeNull();
  });

  it('Nexus variant labels by mod_id when name is empty', () => {
    render(
      <BrowseDetail
        kind="nexus"
        mod={{ ...nexusMod, name: null, mod_id: 999 }}
        onOpenExternal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Nexus mod #999')).toBeInTheDocument();
  });
});
