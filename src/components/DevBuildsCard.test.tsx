import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { DevBuildsCard } from './DevBuildsCard';
import { AllProviders } from '../__test__/providers';
import {
  registerInvokeHandler,
  getInvokeCalls,
  setMockAppVersion,
} from '../__test__/setup';

/** Wrap in the full provider stack so useToast + useTranslation resolve. */
function renderCard() {
  return render(
    <AllProviders>
      <DevBuildsCard />
    </AllProviders>,
  );
}

const TWO_BUILDS = [
  {
    pr: 60,
    sha: 'abc1234',
    title: 'Dev build — PR #60 (gabc1234)',
    published_at: '2026-05-28T00:00:00Z',
    windows_installer_url: null,
    assets: [{ name: 'app_universal.dmg', url: 'https://e/a.dmg', platform: 'macOS' }],
  },
  {
    pr: 59,
    sha: '837f5ba',
    title: 'Dev build — PR #59 (g837f5ba)',
    published_at: '2026-05-27T00:00:00Z',
    windows_installer_url: 'https://e/setup.exe',
    assets: [{ name: 'setup.exe', url: 'https://e/setup.exe', platform: 'Windows (installer)' }],
  },
];

describe('DevBuildsCard', () => {
  it('lists builds newest-first, marks the running one, shows no-Windows note', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba'); // running PR59
    registerInvokeHandler('list_dev_builds', () => TWO_BUILDS);
    renderCard();
    await waitFor(() => expect(screen.getByText(/PR #60/)).toBeInTheDocument());
    expect(screen.getByText(/PR #59/)).toBeInTheDocument();
    // PR60 has no windows installer → shows the no-Windows note.
    expect(screen.getByText(/no Windows build/i)).toBeInTheDocument();
    expect(screen.getByText(/current/i)).toBeInTheDocument();
  });

  it('Switch calls install_dev_build with the build installer url', async () => {
    setMockAppVersion('1.6.1-dev.pr60.gabc1234'); // running PR60 so PR59 is switchable
    registerInvokeHandler('list_dev_builds', () => TWO_BUILDS);
    registerInvokeHandler('install_dev_build', () => null);
    const user = userEvent.setup();
    renderCard();
    const switchBtn = await screen.findByRole('button', { name: /switch/i });
    await user.click(switchBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'install_dev_build');
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ installerUrl: 'https://e/setup.exe' });
    });
  });

  it('shows an empty state when there are no dev builds', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => []);
    renderCard();
    await waitFor(() => expect(screen.getByText(/no open dev builds/i)).toBeInTheDocument());
  });

  it('shows an error + retry when listing fails', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => { throw new Error('rate limited'); });
    renderCard();
    await waitFor(() => expect(screen.getByText(/rate limited/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
