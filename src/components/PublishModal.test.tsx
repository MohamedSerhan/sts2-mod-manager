import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PublishModal } from './PublishModal';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

const profile = {
  name: 'My Pack',
  created_at: '2026-01-01T00:00:00Z',
  mods: [
    { name: 'A', version: '1.0', enabled: true, files: [], source: null, hash: null, dependencies: [], size_bytes: 0 },
    { name: 'B', version: '1.0', enabled: false, files: [], source: null, hash: null, dependencies: [], size_bytes: 0 },
  ],
} as any;

function Wrap(props: Partial<React.ComponentProps<typeof PublishModal>> = {}) {
  return (
    <AllProviders>
      <PublishModal
        open={props.open ?? true}
        profile={props.profile ?? profile}
        isReshare={props.isReshare}
        onClose={props.onClose ?? (() => {})}
        onShared={props.onShared}
        onGoToSettings={props.onGoToSettings ?? (() => {})}
      />
    </AllProviders>
  );
}

/** Loud lookup — fails the test loudly if the Publish/Re-share button is
 *  missing, instead of silently skipping with `if (btn) { ... }`. */
function getPublishButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole('button');
  const btn = buttons.find((b) => /^(Publish|Push update|Re-share)/i.test(b.textContent?.trim() ?? ''));
  if (!btn) {
    throw new Error(
      `Publish button not found. Buttons present: ${buttons.map((b) => `"${b.textContent}"`).join(', ')}`,
    );
  }
  return btn as HTMLButtonElement;
}

describe('<PublishModal>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders nothing when profile is null and open=false', () => {
    const { container } = render(<Wrap profile={null} open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the pre-flight panel for the supplied profile name', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/My Pack/)).toBeInTheDocument();
    });
  });

  it('shows the GitHub-token-missing pre-flight warning when no token is set', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: false,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    render(<Wrap />);
    await waitFor(() => {
      // Some warning copy about a missing GitHub token must surface
      // (possibly more than once — heading + button text).
      expect(screen.queryAllByText(/GitHub.*token|token.*missing/i).length).toBeGreaterThan(0);
    });
  });

  it('shows a Publish button when token is set', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    render(<Wrap />);
    await waitFor(() => {
      // Loud lookup — assert the Publish button is actually present.
      getPublishButton();
    });
  });

  it('Publish click invokes share_profile when dont_ask_again is already true (skips prompt)', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    // dont_ask_again = true short-circuits the listing prompt so a Publish
    // click goes straight to share_profile, matching the curator's stored
    // preference.
    registerInvokeHandler('get_share_dont_ask_again', () => true);
    registerInvokeHandler('share_profile', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const publishBtn = getPublishButton();
    await user.click(publishBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'share_profile')).toBe(true);
    });
  });

  it('isReshare=true calls reshare_profile instead', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => true);
    registerInvokeHandler('reshare_profile', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
    const user = userEvent.setup();
    render(<Wrap isReshare />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const publishBtn = getPublishButton();
    await user.click(publishBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'reshare_profile')).toBe(true);
    });
  });

  it('Open Settings button fires onGoToSettings when shown', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: false,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    const onGoToSettings = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToSettings={onGoToSettings} />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const goBtn = screen.getAllByRole('button').find((b) => /Open Settings|Set token|Settings/i.test(b.textContent ?? ''));
    if (!goBtn) throw new Error('Open Settings button not found');
    await user.click(goBtn);
    expect(onGoToSettings).toHaveBeenCalled();
  });

  it('Close button calls onClose', async () => {
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const xs = screen.getAllByTitle(/Close|Cancel/i);
    await user.click(xs[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the listing prompt after clicking Publish when dont_ask_again is false', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('get_share_dont_ask_again', () => false);
    // share_profile shouldn't actually be invoked in this test (we stop at
    // the prompt step), but register it so an accidental call fails loudly
    // rather than silently returning null.
    const shareCalls: unknown[] = [];
    registerInvokeHandler('share_profile', (args) => {
      shareCalls.push(args);
      return {
        owner: 'alice',
        code: 'AA5A-315D-61AE',
        url: 'https://github.com/alice/sts2mm-profiles',
        remote_path: 'My_Pack.json',
      };
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const publishBtn = getPublishButton();
    await user.click(publishBtn);
    await waitFor(() => {
      expect(screen.getByText(/List this modpack on Browse Modpacks/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Don't ask me again/i)).toBeInTheDocument();
    // The prompt should NOT have published yet — share_profile only fires
    // when the curator clicks Continue.
    expect(shareCalls.length).toBe(0);
  });
});
