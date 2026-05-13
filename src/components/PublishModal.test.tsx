import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { listen as listenMock } from '@tauri-apps/api/event';
import { openUrl as openUrlMock } from '@tauri-apps/plugin-opener';

import { PublishModal } from './PublishModal';
import type { Profile } from '../types';
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
  // Use 'profile' in props explicitly to allow null override.
  const resolvedProfile = 'profile' in props ? props.profile : profile;
  return (
    <AllProviders>
      <PublishModal
        open={props.open ?? true}
        profile={resolvedProfile as Profile}
        isReshare={props.isReshare}
        onClose={props.onClose ?? (() => {})}
        onShared={props.onShared}
        onGoToSettings={props.onGoToSettings ?? (() => {})}
      />
    </AllProviders>
  );
}

/** Helper to register a token-set status before render. */
function tokenIsSet(value: boolean) {
  registerInvokeHandler('get_api_key_status', () => ({
    nexus_api_key_set: false,
    github_token_set: value,
  }));
}

/** Locate the modal title element (avoids matching toast copy that
 *  repeats the same string in a transient banner). */
async function waitForModalTitle(text: string | RegExp) {
  return waitFor(() => {
    const titles = Array.from(document.querySelectorAll('.gf-modal-title'));
    const match = titles.find((t) =>
      typeof text === 'string' ? t.textContent === text : text.test(t.textContent ?? ''),
    );
    expect(match, `modal title "${text}" not found`).toBeDefined();
    return match as HTMLElement;
  });
}

const shareOk = {
  owner: 'alice',
  code: 'AA5A-315D-61AE',
  file_path: 'profiles/My_Pack.json',
  url: 'https://github.com/alice/sts2mm-profiles/blob/main/profiles/My_Pack.json',
  repo_url: 'https://github.com/alice/sts2mm-profiles',
  failed_uploads: null,
};

describe('<PublishModal>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders nothing when profile is null even if open=true', () => {
    const { container } = render(<Wrap profile={null} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the pre-flight panel with profile name and counts', async () => {
    tokenIsSet(true);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Publish My Pack/)).toBeInTheDocument();
    });
    // 2 mods total · 1 enabled · 1 disabled
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/active/)).toBeInTheDocument();
    expect(screen.getByText(/disabled \(will be excluded\)/)).toBeInTheDocument();
  });

  it('shows the GitHub-token-missing pre-flight warning when no token is set', async () => {
    tokenIsSet(false);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('GitHub token required')).toBeInTheDocument();
    });
    // Publish button must be disabled in the blocked state.
    const publishBtn = screen.getByRole('button', { name: /Publish/ });
    expect(publishBtn).toBeDisabled();
  });

  it('publish button is disabled while token status is still loading (null)', async () => {
    // Slow handler — token status never resolves before assertion.
    registerInvokeHandler('get_api_key_status', () => new Promise(() => {}));
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    expect(publishBtn).toBeDisabled();
  });

  it('treats get_api_key_status rejection as token-missing (block + warning)', async () => {
    registerInvokeHandler('get_api_key_status', () => {
      throw new Error('boom');
    });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('GitHub token required')).toBeInTheDocument();
    });
  });

  it('Open Settings → Accounts CTA fires onGoToSettings and closes modal', async () => {
    tokenIsSet(false);
    const onGoToSettings = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToSettings={onGoToSettings} onClose={onClose} />);
    const goBtn = await screen.findByRole('button', { name: /Open Settings/ });
    await user.click(goBtn);
    expect(onGoToSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT render Open Settings CTA when onGoToSettings is undefined', async () => {
    tokenIsSet(false);
    // Force undefined explicitly.
    render(
      <AllProviders>
        <PublishModal open profile={profile} onClose={() => {}} />
      </AllProviders>,
    );
    await screen.findByText('GitHub token required');
    expect(screen.queryByRole('button', { name: /Open Settings/ })).toBeNull();
  });

  it('Cancel button closes the modal (footer)', async () => {
    tokenIsSet(true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await screen.findByText(/Publish My Pack/);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('header X button closes the modal', async () => {
    tokenIsSet(true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await screen.findByText(/Publish My Pack/);
    const x = screen.getByTitle('Close');
    await user.click(x);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop closes the modal when not busy', async () => {
    tokenIsSet(true);
    const onClose = vi.fn();
    const { container } = render(<Wrap onClose={onClose} />);
    await screen.findByText(/Publish My Pack/);
    const backdrop = container.querySelector('.gf-modal-back') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the modal does not close it', async () => {
    tokenIsSet(true);
    const onClose = vi.fn();
    const { container } = render(<Wrap onClose={onClose} />);
    await screen.findByText(/Publish My Pack/);
    const modal = container.querySelector('.gf-modal') as HTMLElement;
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Publish happy path: invokes share_profile, calls onShared, shows success state', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    const onShared = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onShared={onShared} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'share_profile')).toBe(true);
    });
    // Success state: title flips to "Profile published" and share code is visible.
    await waitForModalTitle('Profile published');
    expect(screen.getByText(`${shareOk.owner}/${shareOk.code}`)).toBeInTheDocument();
    expect(onShared).toHaveBeenCalledWith(shareOk);
    // Done button surfaces in the footer (not Publish).
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('isReshare=true uses reshare_profile and shows update-pushed title', async () => {
    tokenIsSet(true);
    registerInvokeHandler('reshare_profile', () => shareOk);
    const user = userEvent.setup();
    render(<Wrap isReshare />);
    // Title reflects re-share.
    await screen.findByText(/Re-share My Pack\?/);
    const publishBtn = screen.getByRole('button', { name: /Push update/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'reshare_profile')).toBe(true);
    });
    await waitForModalTitle('Update pushed');
  });

  it('partial-fail: surfaces failed_uploads warning + error toast (≤5)', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => ({
      ...shareOk,
      failed_uploads: ['ModA', 'ModB'],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    // Inline warning panel AND toast both contain the failure summary.
    // The panel splits the count and list across separate elements; the
    // toast is a single string. Assert each variant ≥ 1.
    await waitFor(() => {
      // Toast lives outside the modal; this regex matches the joined string.
      expect(screen.getByText(/2 mods failed to upload: ModA, ModB/)).toBeInTheDocument();
    });
    // The inline panel's <b> holds the leading "N mods failed to upload:".
    expect(screen.getByText('2 mods failed to upload:')).toBeInTheDocument();
  });

  it('partial-fail singular: shows "1 mod failed" copy with no +more suffix', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => ({
      ...shareOk,
      failed_uploads: ['SoloMod'],
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    // Toast (single string) confirms the singular wording with no +more.
    const toastEl = await screen.findByText(/1 mod failed to upload: SoloMod/);
    expect(toastEl.textContent).not.toMatch(/\+\d+ more/);
    // Inline panel's <b> uses the same singular phrasing.
    expect(screen.getByText('1 mod failed to upload:')).toBeInTheDocument();
  });

  it('partial-fail >5: truncates list with "+N more" both in panel and toast', async () => {
    tokenIsSet(true);
    const failures = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    registerInvokeHandler('share_profile', () => ({
      ...shareOk,
      failed_uploads: failures,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    // "+2 more" suffix in both panel and toast.
    const matches = screen.getAllByText(/m1, m2, m3, m4, m5, \+2 more/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('publish error surfaces a "Failed to publish" toast and returns to pre-flight state', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      throw new Error('network down');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to publish: network down/)).toBeInTheDocument();
    });
    // Modal stays mounted, pre-flight footer is back (Publish + Cancel).
    expect(screen.getByRole('button', { name: /Publish/ })).toBeInTheDocument();
  });

  it('publish error: non-Error rejection is stringified into the toast', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain-string-failure';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed to publish: plain-string-failure/)).toBeInTheDocument();
    });
  });

  it('shows "Publishing…" busy footer while share_profile is pending', async () => {
    tokenIsSet(true);
    let resolveShare!: (v: typeof shareOk) => void;
    registerInvokeHandler(
      'share_profile',
      () => new Promise<typeof shareOk>((res) => { resolveShare = res; }),
    );
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByText('Preparing…');
    expect(screen.getByRole('button', { name: 'Publishing…' })).toBeDisabled();
    // Header close button is disabled while busy.
    expect(screen.getByTitle('Close')).toBeDisabled();
    resolveShare(shareOk);
    await waitForModalTitle('Profile published');
  });

  it('share-progress listener: bundling event renders mod counter + progress bar', async () => {
    tokenIsSet(true);
    let resolveShare!: (v: typeof shareOk) => void;
    registerInvokeHandler(
      'share_profile',
      () => new Promise<typeof shareOk>((res) => { resolveShare = res; }),
    );
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByText('Preparing…');
    // Find the most recent `listen('share-progress', cb)` registration and
    // feed it a bundling event directly.
    const listenSpy = vi.mocked(listenMock);
    const reg = [...listenSpy.mock.calls].reverse().find((c) => c[0] === 'share-progress');
    expect(reg).toBeDefined();
    const handler = reg![1] as (e: { payload: unknown }) => void;
    handler({
      payload: {
        profile_name: 'My Pack',
        stage: 'bundling',
        current: 3,
        total: 10,
        mod_name: 'BigMod',
      },
    });
    await screen.findByText(/Bundling mod 3 of 10: BigMod/);
    // Then a 'done' event clears the bar — modal stays in busy state.
    handler({
      payload: {
        profile_name: 'My Pack',
        stage: 'done',
        current: 10,
        total: 10,
        mod_name: null,
      },
    });
    await waitFor(() => {
      expect(screen.queryByText(/Bundling mod 3 of 10/)).toBeNull();
    });
    resolveShare(shareOk);
    await waitForModalTitle('Profile published');
  });

  it('share-progress listener: uploading-manifest stage shows manifest copy', async () => {
    tokenIsSet(true);
    let resolveShare!: (v: typeof shareOk) => void;
    registerInvokeHandler(
      'share_profile',
      () => new Promise<typeof shareOk>((res) => { resolveShare = res; }),
    );
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByText('Preparing…');
    const listenSpy = vi.mocked(listenMock);
    const reg = [...listenSpy.mock.calls].reverse().find((c) => c[0] === 'share-progress');
    expect(reg).toBeDefined();
    const handler = reg![1] as (e: { payload: unknown }) => void;
    handler({
      payload: {
        profile_name: 'My Pack',
        stage: 'uploading-manifest',
        current: 0,
        total: 0,
        mod_name: null,
      },
    });
    await screen.findByText(/Uploading profile manifest/);
    resolveShare(shareOk);
    await waitForModalTitle('Profile published');
  });

  it('does not close on backdrop click while busy', async () => {
    tokenIsSet(true);
    let resolveShare!: (v: typeof shareOk) => void;
    registerInvokeHandler(
      'share_profile',
      () => new Promise<typeof shareOk>((res) => { resolveShare = res; }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Wrap onClose={onClose} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByText('Preparing…');
    const backdrop = container.querySelector('.gf-modal-back') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    resolveShare(shareOk);
    await waitForModalTitle('Profile published');
  });

  // ── Success state copy buttons (lines 335-351) ────────────────────

  function patchClipboard(impl: () => Promise<void> = async () => {}) {
    const proto = Object.getPrototypeOf(navigator.clipboard);
    const writeFn = vi.fn(impl);
    Object.defineProperty(proto, 'writeText', {
      value: writeFn,
      configurable: true,
      writable: true,
    });
    return writeFn;
  }

  async function renderInSuccess() {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    return user;
  }

  it('Copy code writes the raw owner/code to clipboard and flips to "Copied"', async () => {
    const writeFn = patchClipboard();
    await renderInSuccess();
    const copyBtn = screen.getByRole('button', { name: /Copy code/ });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeFn).toHaveBeenCalledWith(`${shareOk.owner}/${shareOk.code}`);
    });
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('Copy link writes the install bridge URL to clipboard', async () => {
    const writeFn = patchClipboard();
    await renderInSuccess();
    const copyLink = screen.getByRole('button', { name: /Copy link/ });
    fireEvent.click(copyLink);
    await waitFor(() => {
      expect(writeFn).toHaveBeenCalledTimes(1);
    });
    const text = writeFn.mock.calls[0][0] as string;
    expect(text).toContain(encodeURIComponent(`${shareOk.owner}/${shareOk.code}`));
  });

  it('Copy message writes a multi-line paste-ready message', async () => {
    const writeFn = patchClipboard();
    await renderInSuccess();
    const copyMsg = screen.getByRole('button', { name: /Copy message/ });
    fireEvent.click(copyMsg);
    await waitFor(() => {
      expect(writeFn).toHaveBeenCalledTimes(1);
    });
    const text = writeFn.mock.calls[0][0] as string;
    expect(text).toContain('My Pack');
    expect(text).toContain(shareOk.code);
  });

  it('Copy clipboard rejection surfaces "Could not copy" toast', async () => {
    patchClipboard(async () => { throw new Error('denied'); });
    await renderInSuccess();
    const copy = screen.getByRole('button', { name: /Copy code/ });
    fireEvent.click(copy);
    await waitFor(() => {
      expect(screen.getByText('Could not copy to clipboard')).toBeInTheDocument();
    });
  });

  it('Open repo button calls openUrl with shared.repo_url', async () => {
    await renderInSuccess();
    const openBtn = screen.getByRole('button', { name: /Open my profiles repo on GitHub/ });
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(vi.mocked(openUrlMock)).toHaveBeenCalledWith(shareOk.repo_url);
    });
  });

  it('Open repo: openUrl rejection surfaces a toast', async () => {
    vi.mocked(openUrlMock).mockRejectedValueOnce(new Error('no browser'));
    await renderInSuccess();
    const openBtn = screen.getByRole('button', { name: /Open my profiles repo on GitHub/ });
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open browser: no browser/)).toBeInTheDocument();
    });
  });

  it('Open repo: non-Error rejection is stringified', async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    vi.mocked(openUrlMock).mockImplementationOnce(async () => { throw 'kaboom'; });
    await renderInSuccess();
    const openBtn = screen.getByRole('button', { name: /Open my profiles repo on GitHub/ });
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open browser: kaboom/)).toBeInTheDocument();
    });
  });

  it('hides Open-repo button when share result has no repo_url', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => ({ ...shareOk, repo_url: '' }));
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    expect(screen.queryByRole('button', { name: /Open my profiles repo/ })).toBeNull();
  });

  it('success Done button closes the modal and resets state', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Profile published');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('profile without created_by skips the "curated by" row', async () => {
    tokenIsSet(true);
    render(<Wrap profile={{ ...profile, created_by: null }} />);
    await screen.findByText(/Publish My Pack/);
    expect(screen.queryByText(/curated by/)).toBeNull();
  });

  it('profile with created_by surfaces the "curated by" attribution', async () => {
    tokenIsSet(true);
    render(<Wrap profile={{ ...profile, created_by: 'Alice' }} />);
    await screen.findByText(/curated by/);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('isReshare=true skips the "creates a public repo" consent panel', async () => {
    tokenIsSet(true);
    render(<Wrap isReshare />);
    await screen.findByText(/Re-share My Pack\?/);
    expect(screen.queryByText(/creates a public repo|will create a/)).toBeNull();
  });

  it('all mods enabled hides the "disabled (will be excluded)" tail', async () => {
    tokenIsSet(true);
    const onlyEnabled = {
      ...profile,
      mods: [profile.mods[0]],
    };
    render(<Wrap profile={onlyEnabled} />);
    await screen.findByText(/Publish My Pack/);
    expect(screen.queryByText(/disabled \(will be excluded\)/)).toBeNull();
  });
});
