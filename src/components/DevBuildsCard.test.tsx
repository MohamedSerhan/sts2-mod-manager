import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DevBuildsCard } from './DevBuildsCard';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler, getInvokeCalls, setMockAppVersion } from '../__test__/setup';
// renderCard(): wrap <DevBuildsCard /> in the same providers AboutCard.test.tsx uses.

function renderCard() {
  return render(
    <AllProviders>
      <DevBuildsCard />
    </AllProviders>,
  );
}

const BUILDS = [
  { pr: 61, sha: 'aabbcc7', title: 'Dev build — PR #61 (gaabbcc7)', published_at: '2026-05-29T00:00:00Z',
    windows_installer_url: 'https://e/pr61-setup.exe', manifest_url: 'https://e/pr61/latest.json',
    assets: [
      { name: 'pr61-setup.exe', url: 'https://e/pr61-setup.exe', platform: 'Windows (installer)' },
      { name: 'pr61.dmg', url: 'https://e/pr61.dmg', platform: 'macOS' },
    ] },
  { pr: 60, sha: '150366e', title: 'Dev build — PR #60 (g150366e)', published_at: '2026-05-28T00:00:00Z',
    windows_installer_url: 'https://e/pr60-setup.exe', manifest_url: 'https://e/pr60/latest.json',
    assets: [{ name: 'pr60-setup.exe', url: 'https://e/pr60-setup.exe', platform: 'Windows (installer)' }] },
];

describe('DevBuildsCard', () => {
  it('lists newest-first, marks current, switches via switch_dev_build', async () => {
    setMockAppVersion('1.6.1-dev.pr60.g150366e'); // running PR60
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    registerInvokeHandler('switch_dev_build', () => null);
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText(/PR #61/)).toBeInTheDocument());
    expect(screen.getByText(/PR #60/)).toBeInTheDocument();
    expect(screen.getByText(/current/i)).toBeInTheDocument(); // PR60 marked current
    // Switch the non-current PR61:
    const switchBtn = await screen.findByRole('button', { name: /switch/i });
    await user.click(switchBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'switch_dev_build');
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ manifestUrl: 'https://e/pr61/latest.json' });
    });
  });

  it('search filters the list by PR number', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText(/PR #61/)).toBeInTheDocument());
    await user.type(screen.getByRole('textbox', { name: /search/i }), '60');
    await waitFor(() => expect(screen.queryByText(/PR #61/)).not.toBeInTheDocument());
    expect(screen.getByText(/PR #60/)).toBeInTheDocument();
  });

  it('Downloads disclosure reveals per-platform links', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    vi.mocked(openUrl).mockClear();
    const user = userEvent.setup();
    renderCard();
    const rows = await screen.findAllByRole('listitem');
    const pr61row = rows.find((r) => within(r).queryByText(/PR #61/));
    if (!pr61row) throw new Error('PR #61 row not found');
    // Links are not visible until the disclosure is opened.
    expect(within(pr61row).queryByText('macOS')).not.toBeInTheDocument();
    await user.click(within(pr61row).getByText(/downloads/i));
    const macButton = within(pr61row).getByText('macOS');
    expect(macButton).toBeInTheDocument();
    await user.click(macButton);
    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://e/pr61.dmg');
    });
  });

  it('shows empty + error(+retry) states', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => { throw new Error('rate limited'); });
    renderCard();
    await waitFor(() => expect(screen.getByText(/rate limited/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows an empty state when there are no dev builds', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => []);
    renderCard();
    await waitFor(() => expect(screen.getByText(/no open dev builds/i)).toBeInTheDocument());
  });
});
