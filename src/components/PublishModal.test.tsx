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
        onListingChanged={props.onListingChanged}
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

/** Helper: stub `get_installed_mods` for tests that need a live app context. */
function installedModsAre(
  mods: Array<{ name: string; enabled: boolean }>,
) {
  registerInvokeHandler('get_installed_mods', () =>
    mods.map((m) => ({
      name: m.name,
      version: '1.0',
      enabled: m.enabled,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
      pinned: false,
    })),
  );
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

  it('renders nothing when profile is null even if open=true', () => {
    const { container } = render(<Wrap profile={null} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the pre-flight panel with profile name and profile-manifest counts', async () => {
    tokenIsSet(true);
    installedModsAre([
      { name: 'A', enabled: true },
      { name: 'B', enabled: false },
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Publish My Pack/)).toBeInTheDocument();
    });
    // 2 mods total · 1 enabled · 1 disabled — driven by the saved profile
    // manifest so Mod Library membership edits control what gets published.
    await waitFor(() => {
      expect(screen.getByText(/included but disabled/)).toBeInTheDocument();
    });
    expect(screen.getByText(/active/)).toBeInTheDocument();
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  });

  it('explains the sharing repo must stay public while shared codes are active', async () => {
    tokenIsSet(true);
    render(<Wrap />);
    await screen.findByText(/Publish My Pack/);

    expect(document.body.textContent).toContain('Keep it public while sharing with friends');
    expect(document.body.textContent).toContain(
      'deleting it or making it private will make shared codes and bundle downloads stop working',
    );
    expect(document.body.textContent).not.toContain(
      'delete or make it private on GitHub at any time',
    );
  });

  it('preview counts come from saved profile membership, not the entire mod library', async () => {
    // Regression: Mod Library lets users trim a profile down to the mods it
    // references. Publishing must respect that saved manifest instead of
    // re-adding every installed library mod from disk.
    tokenIsSet(true);
    const curated = {
      ...profile,
      mods: [
        { name: 'CuratedOnly', version: '1.0', enabled: true, files: [], source: null, hash: null, dependencies: [], size_bytes: 0 },
      ],
    };
    installedModsAre([
      { name: 'CuratedOnly', enabled: true },
      { name: 'LibraryExtraA', enabled: true },
      { name: 'LibraryExtraB', enabled: false },
    ]);
    render(<Wrap profile={curated} />);
    await screen.findByText(/Publish My Pack/);
    // Saved profile: 1 total · 1 active · 0 disabled. The two extra library
    // mods on disk must not leak into the publish preview.
    await waitFor(() => {
      const stats = Array.from(document.querySelectorAll('.gf-includes-stat'));
      expect(stats.map((s) => s.textContent?.trim())).toEqual(['1', '1']);
    });
    expect(screen.queryByText(/disabled \(/)).toBeNull();
  });

  it('renders the inline ShareSetupPanel when no GitHub token is set', async () => {
    tokenIsSet(false);
    render(<Wrap />);
    // The old red "GitHub token required" warning block is gone — the
    // modal now renders the ShareSetupPanel inline with a plain-language
    // explanation, the token field, and a "Configure later" escape hatch.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Set up sharing' })).toBeInTheDocument();
    });
    // Token field is present so the curator can paste without leaving.
    expect(screen.getByLabelText('Paste your token here')).toBeInTheDocument();
    // The publish button stays disabled while no token has been saved.
    const publishBtn = screen.getByRole('button', { name: /Publish/ });
    expect(publishBtn).toBeDisabled();
    // Old block's "GitHub token required" copy must not surface anymore.
    expect(screen.queryByText('GitHub token required')).toBeNull();
  });

  it('publish button is disabled while token status is still loading (null)', async () => {
    // Slow handler — token status never resolves before assertion.
    registerInvokeHandler('get_api_key_status', () => new Promise(() => {}));
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    expect(publishBtn).toBeDisabled();
  });

  it('treats get_api_key_status rejection as token-missing (renders ShareSetupPanel)', async () => {
    registerInvokeHandler('get_api_key_status', () => {
      throw new Error('boom');
    });
    render(<Wrap />);
    // Status-fetch failure should land the user in the same setup panel,
    // not in a stuck loading state with a disabled Publish button.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Set up sharing' })).toBeInTheDocument();
    });
  });

  it('shows a Publish button when token is set', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    render(<Wrap />);
    await waitFor(() => {
      // Loud lookup — assert the Publish button is actually present.
      getPublishButton();
    });
  });

  it('Publish click invokes share_profile with listPublic=false by default', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
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
      const call = getInvokeCalls().find((c) => c.cmd === 'share_profile');
      expect(call).toBeDefined();
      // Default visibility is "Friends only" → listPublic is explicitly
      // false (not null / undefined) so the backend never has to guess.
      // Notes/links sharing defaults ON (Solo FR, 2026-06-10).
      expect(call!.args).toEqual({ name: 'My Pack', listPublic: false, includeNotes: true });
    });
  });

  it('unchecking "Include your mod notes" publishes with includeNotes=false', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('share_profile', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    await user.click(screen.getByRole('checkbox', { name: /Include your mod notes/i }));
    await user.click(getPublishButton());
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'share_profile');
      expect(call).toBeDefined();
      expect(call!.args).toEqual({ name: 'My Pack', listPublic: false, includeNotes: false });
    });
  });

  it('isReshare=true calls reshare_profile instead', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
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

  it('"Configure later in Settings" still routes to Settings and closes the modal', async () => {
    tokenIsSet(false);
    const onGoToSettings = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onGoToSettings={onGoToSettings} onClose={onClose} />);
    const goBtn = await screen.findByRole('button', { name: /Configure later in Settings/ });
    await user.click(goBtn);
    expect(onGoToSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Configure later in Settings" still closes when onGoToSettings is undefined', async () => {
    // Parents that don't wire a Settings router still get a graceful close —
    // the panel's button no longer requires the optional callback.
    tokenIsSet(false);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AllProviders>
        <PublishModal open profile={profile} onClose={onClose} />
      </AllProviders>,
    );
    const goBtn = await screen.findByRole('button', { name: /Configure later in Settings/ });
    await user.click(goBtn);
    // No callback to call → the modal just closes. No throw.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Save token transitions to the publish flow without closing', async () => {
    // Token starts missing, then set_github_token flips backend state to
    // "set". After save, the modal must re-check status and reveal the
    // pre-flight render (pack name + Publish button) without closing.
    let backendTokenSet = false;
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: backendTokenSet,
    }));
    registerInvokeHandler('set_github_token', () => {
      backendTokenSet = true;
      return true;
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    // Wait for the ShareSetupPanel to mount.
    const tokenInput = await screen.findByLabelText('Paste your token here');
    await user.type(tokenInput, 'ghp_validtoken');
    const saveBtn = screen.getByRole('button', { name: 'Save and continue' });
    await user.click(saveBtn);
    // Transition: the setup panel goes away and the normal pre-flight
    // render (with the pack name field) takes over. Modal must not close.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Set up sharing' })).toBeNull();
    });
    expect(await screen.findByText(/Publish My Pack/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
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
    // Success state: title flips to "Modpack published" and share code is visible.
    await waitForModalTitle('Modpack published');
    expect(screen.getByText(`${shareOk.owner}/${shareOk.code}`)).toBeInTheDocument();
    expect(onShared).toHaveBeenCalledWith(shareOk);
    // Done button surfaces in the footer (not Publish).
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('toggling public listing in the success screen notifies the parent to refresh (state-sync)', async () => {
    // setModpackListing changes the saved manifest's listing state. Without a
    // parent notification, the parent's profile.public goes stale, so
    // reopening Publish would seed the toggle from the old value (appears
    // reverted). The toggle must tell the parent to refresh.
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    registerInvokeHandler('set_modpack_listing', () => null);
    const onListingChanged = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onListingChanged={onListingChanged} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitForModalTitle('Modpack published');

    // The listing toggle starts at "No" (private default). Flip it public.
    await user.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'set_modpack_listing' && c.args?.public === true,
      )).toBe(true);
    });
    await waitFor(() => { expect(onListingChanged).toHaveBeenCalled(); });
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
    await waitForModalTitle('Modpack published');
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
    await waitForModalTitle('Modpack published');
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
    await waitForModalTitle('Modpack published');
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

  // ── Missing-bundles inline recovery (Solo bug) ───────────────────

  /**
   * Build the exact Rust error string the sharing module produces when
   * one or more mods are missing their bundled zip. Mirrors
   * `src-tauri/src/sharing.rs` so the parser stays in lockstep with the
   * source format.
   */
  function missingBundlesError(profileName: string, mods: string[]): string {
    return (
      `Could not publish profile '${profileName}': missing bundles for ` +
      `${mods.length} mod(s): ${mods.join(', ')}. ` +
      'Restore or reinstall these mods, then share again so the manifest can repair them later.'
    );
  }

  it('missing-bundles error: renders inline panel instead of toast', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      throw new Error(
        missingBundlesError('My Pack', ['ModA', 'ModB', 'ModC']),
      );
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    // Inline panel renders with the parsed mod list.
    await screen.findByRole('heading', {
      name: /Some mod uploads didn.t finish/i,
    });
    expect(screen.getByText('ModA')).toBeInTheDocument();
    expect(screen.getByText('ModB')).toBeInTheDocument();
    expect(screen.getByText('ModC')).toBeInTheDocument();
    // Crucially, the raw-error toast must NOT appear — the panel
    // replaces it. Pull every "Failed to publish:" element and assert
    // none of them is present.
    expect(screen.queryByText(/Failed to publish:/)).toBeNull();
  });

  it('missing-bundles panel: Repair → success auto-retries the publish', async () => {
    tokenIsSet(true);
    let publishCalls = 0;
    registerInvokeHandler('share_profile', () => {
      publishCalls++;
      if (publishCalls === 1) {
        throw new Error(missingBundlesError('My Pack', ['BrokenA', 'BrokenB']));
      }
      return shareOk;
    });
    registerInvokeHandler('repair_mod', async (args) => ({
      name: String(args?.name ?? ''),
      version: '1.0',
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByRole('heading', {
      name: /Some mod uploads didn.t finish/i,
    });
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    // Auto-retry kicks in once both repairs succeed → publish lands the
    // success state with the share code.
    await waitForModalTitle('Modpack published');
    expect(publishCalls).toBe(2);
    // Both repairs were attempted.
    const repairCalls = getInvokeCalls().filter((c) => c.cmd === 'repair_mod');
    expect(repairCalls.length).toBe(2);
  });

  it('missing-bundles panel: Cancel closes the modal', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      throw new Error(missingBundlesError('My Pack', ['X']));
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByRole('heading', {
      name: /Some mod uploads didn.t finish/i,
    });
    // Use the panel's Cancel button — the modal footer is hidden while
    // the panel owns the action surface, so there's only one Cancel.
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('missing-bundles panel: re-share path also gets the inline recovery UX', async () => {
    tokenIsSet(true);
    let publishCalls = 0;
    registerInvokeHandler('reshare_profile', () => {
      publishCalls++;
      if (publishCalls === 1) {
        throw new Error(missingBundlesError('My Pack', ['Solo尖塔铭者卡图强化']));
      }
      return shareOk;
    });
    registerInvokeHandler('repair_mod', async (args) => ({
      name: String(args?.name ?? ''),
      version: '1.0',
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
    }));
    const user = userEvent.setup();
    render(<Wrap isReshare />);
    const pushBtn = await screen.findByRole('button', { name: /Push update/ });
    await waitFor(() => { expect(pushBtn).not.toBeDisabled(); });
    await user.click(pushBtn);
    await screen.findByRole('heading', {
      name: /Some mod uploads didn.t finish/i,
    });
    // Chinese mod name from Solo's actual bug report renders unmangled.
    expect(screen.getByText('Solo尖塔铭者卡图强化')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    await waitForModalTitle('Update pushed');
    // Auto-retry called reshare_profile a second time, not share_profile.
    const reshareCalls = getInvokeCalls().filter(
      (c) => c.cmd === 'reshare_profile',
    );
    expect(reshareCalls.length).toBe(2);
    expect(
      getInvokeCalls().some((c) => c.cmd === 'share_profile'),
    ).toBe(false);
  });

  it('missing-bundles panel: partial repair failure keeps panel open without auto-retry', async () => {
    tokenIsSet(true);
    let publishCalls = 0;
    registerInvokeHandler('share_profile', () => {
      publishCalls++;
      throw new Error(missingBundlesError('My Pack', ['Good', 'Bad']));
    });
    registerInvokeHandler('repair_mod', (args) => {
      if (args?.name === 'Bad') throw new Error('locked file');
      return {
        name: String(args?.name ?? ''),
        version: '1.0',
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
      };
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByRole('heading', {
      name: /Some mod uploads didn.t finish/i,
    });
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    // Wait for the failure marker to appear.
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    // Publish should still be at count 1 — auto-retry must not fire
    // when one mod failed (it would just produce the same error).
    expect(publishCalls).toBe(1);
    // Modal title should still say "Publish My Pack" — we never reached
    // the success state.
    expect(screen.queryByText(/Modpack published/)).toBeNull();
    // "Open mod folder" link surfaces for the failed mod.
    expect(
      screen.getByRole('button', { name: /Open mod folder/i }),
    ).toBeInTheDocument();
  });

  it('non-missing-bundles publish error still surfaces the toast (existing path)', async () => {
    // Regression guard: ensures the new pattern matcher doesn't swallow
    // generic publish errors. Network/GitHub failures must still go
    // through the toast like they did before.
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      throw new Error('GitHub API rate limit exceeded (60/hour)');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      expect(
        screen.getByText(/Failed to publish: GitHub API rate limit/),
      ).toBeInTheDocument();
    });
    // The inline panel must NOT appear — this isn't a missing-bundles error.
    expect(
      screen.queryByRole('heading', {
        name: /Some mod uploads didn.t finish/i,
      }),
    ).toBeNull();
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
    expect(document.body.textContent).toContain('Big packs can take several minutes or longer');
    expect(document.body.textContent).not.toContain('This can take a minute or two');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Publishing…' })).toBeDisabled();
    // Header close button is disabled while busy.
    expect(screen.getByTitle('Close')).toBeDisabled();
    resolveShare(shareOk);
    await waitForModalTitle('Modpack published');
  });

  it('busy footer Cancel requests backend publish cancellation', async () => {
    tokenIsSet(true);
    let resolveShare!: (v: typeof shareOk) => void;
    registerInvokeHandler(
      'share_profile',
      () => new Promise<typeof shareOk>((res) => { resolveShare = res; }),
    );
    registerInvokeHandler('cancel_profile_share', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await screen.findByText('Preparing…');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(getInvokeCalls().some(
        (c) => c.cmd === 'cancel_profile_share' && c.args?.name === 'My Pack',
      )).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Canceling...' })).toBeDisabled();
    resolveShare(shareOk);
    await waitForModalTitle('Modpack published');
  });

  it('backend cancellation closes without a failed-publish toast', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => {
      throw new Error('Sharing canceled.');
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/Failed to publish/)).toBeNull();
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
    await waitForModalTitle('Modpack published');
  });

  it('share-progress listener: checking-bundle event renders mod counter + progress bar', async () => {
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
        stage: 'checking-bundle',
        current: 2,
        total: 5,
        mod_name: 'BaseLib',
      },
    });

    await screen.findByText(/Checking mod 2 of 5: BaseLib/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    resolveShare(shareOk);
    await waitForModalTitle('Modpack published');
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
    await screen.findByText(/Uploading modpack manifest/);
    resolveShare(shareOk);
    await waitForModalTitle('Modpack published');
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
    await waitForModalTitle('Modpack published');
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
    await waitForModalTitle('Modpack published');
    return user;
  }

  it('success state: share code value and all three copy buttons are present', async () => {
    await renderInSuccess();
    // Share code value.
    expect(screen.getByText(`${shareOk.owner}/${shareOk.code}`)).toBeInTheDocument();
    // All three copy buttons — loud lookups; silent-skip pattern not used.
    expect(screen.getByRole('button', { name: /Copy code/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy message/ })).toBeInTheDocument();
  });

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
    const firstCall = writeFn.mock.calls[0] as unknown as [string];
    const text = firstCall[0];
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
    const firstCall = writeFn.mock.calls[0] as unknown as [string];
    const text = firstCall[0];
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
    await waitForModalTitle('Modpack published');
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
    await waitForModalTitle('Modpack published');
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

  it('all mods enabled hides the included-but-disabled tail', async () => {
    tokenIsSet(true);
    installedModsAre([{ name: 'OnlyOne', enabled: true }]);
    render(
      <Wrap
        profile={{
          ...profile,
          mods: [
            { name: 'OnlyOne', version: '1.0', enabled: true, files: [], source: null, hash: null, dependencies: [], size_bytes: 0 },
          ],
        } as any}
      />,
    );
    await screen.findByText(/Publish My Pack/);
    expect(screen.queryByText(/included but disabled/)).toBeNull();
    expect(screen.queryByText(/disabled \(will be excluded\)/)).toBeNull();
  });

  it('shows the Visibility selector with two radio options in the publish form', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    // Two radio inputs — Friends only (default) and Public.
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(2);
    // Friends only is selected by default.
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect((radios[1] as HTMLInputElement).checked).toBe(false);
    // Copy for both options is present.
    expect(screen.getByText(/Friends only/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Public/i).length).toBeGreaterThan(0);
  });

  it('selecting Public then Publish calls share_profile with listPublic=true', async () => {
    registerInvokeHandler('get_api_key_status', () => ({
      nexus_api_key_set: false,
      github_token_set: true,
    }));
    registerInvokeHandler('share_profile', () => ({
      owner: 'alice',
      code: 'AA5A-315D-61AE',
      url: 'https://github.com/alice/sts2mm-profiles',
      remote_path: 'My_Pack.json',
    }));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const radios = screen.getAllByRole('radio');
    if (radios.length < 2) {
      throw new Error(`Expected 2 visibility radios, found ${radios.length}`);
    }
    // Click "Public" radio.
    await user.click(radios[1]);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    // Now click Publish.
    const publishBtn = getPublishButton();
    await user.click(publishBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'share_profile');
      expect(call).toBeDefined();
      expect(call!.args).toEqual({ name: 'My Pack', listPublic: true, includeNotes: true });
    });
  });

  it('clicking Public then Friends only re-selects private (covers Friends-only onChange)', async () => {
    tokenIsSet(true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    if (radios.length < 2) {
      throw new Error(`Expected 2 visibility radios, found ${radios.length}`);
    }
    // First select Public so the default-private state is no longer in
    // effect; then re-select the Friends only radio to fire its onChange.
    await user.click(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
    await user.click(radios[0]);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it('pre-selects Public when profile.public is true and publishes with listPublic=true', async () => {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    const user = userEvent.setup();
    render(<Wrap profile={{ ...profile, public: true }} />);
    await waitFor(() => { expect(screen.getByText(/My Pack/)).toBeInTheDocument(); });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    // Public is pre-selected because the profile was previously published
    // with listing=on.
    expect(radios[1].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
    const publishBtn = getPublishButton();
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    await user.click(publishBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'share_profile');
      expect(call).toBeDefined();
      expect(call!.args).toEqual({ name: 'My Pack', listPublic: true, includeNotes: true });
    });
  });

  // ── ListingToggle (success-state Browse Modpacks listing toggle) ───

  /** Drives the publish flow through to success so the ListingToggle is
   *  mounted in the DOM. `visibility` controls whether the toggle starts
   *  in "Yes" (true) or "No" (false) state. */
  async function renderInSuccessWithVisibility(visibility: 'private' | 'public') {
    tokenIsSet(true);
    registerInvokeHandler('share_profile', () => shareOk);
    const user = userEvent.setup();
    render(<Wrap />);
    const publishBtn = await screen.findByRole('button', { name: /Publish/ });
    await waitFor(() => { expect(publishBtn).not.toBeDisabled(); });
    if (visibility === 'public') {
      const radios = screen.getAllByRole('radio') as HTMLInputElement[];
      await user.click(radios[1]);
    }
    await user.click(publishBtn);
    await waitForModalTitle('Modpack published');
    return user;
  }

  /** Find the ListingToggle button (label is "Yes" or "No"). The Done
   *  footer button has a different name, so this lookup is unambiguous. */
  function getListingToggle(): HTMLButtonElement {
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    const btn = buttons.find((b) => /^(Yes|No)$/.test(b.textContent?.trim() ?? ''));
    if (!btn) {
      throw new Error(
        `ListingToggle button (Yes/No) not found. Buttons: ${buttons.map((b) => `"${b.textContent}"`).join(', ')}`,
      );
    }
    return btn;
  }

  it('ListingToggle shows "No" when published with visibility=private', async () => {
    await renderInSuccessWithVisibility('private');
    const btn = getListingToggle();
    expect(btn.textContent?.trim()).toBe('No');
    expect(btn).not.toBeDisabled();
  });

  it('ListingToggle shows "Yes" when published with visibility=public', async () => {
    await renderInSuccessWithVisibility('public');
    const btn = getListingToggle();
    expect(btn.textContent?.trim()).toBe('Yes');
  });

  it('ListingToggle: clicking "No" toggles to "Yes" and toasts "Listed on Browse Modpacks"', async () => {
    registerInvokeHandler('set_modpack_listing', () => null);
    const user = await renderInSuccessWithVisibility('private');
    const btn = getListingToggle();
    expect(btn.textContent?.trim()).toBe('No');
    await user.click(btn);
    await waitFor(() => {
      expect(getListingToggle().textContent?.trim()).toBe('Yes');
    });
    // Backend invoked with (name, public=true).
    const call = getInvokeCalls().find((c) => c.cmd === 'set_modpack_listing');
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ name: 'My Pack', public: true });
    // Success toast surfaces.
    expect(screen.getByText('Listed on Browse Modpacks')).toBeInTheDocument();
  });

  it('ListingToggle: clicking "Yes" toggles to "No" and toasts "Hidden from Browse Modpacks"', async () => {
    registerInvokeHandler('set_modpack_listing', () => null);
    const user = await renderInSuccessWithVisibility('public');
    const btn = getListingToggle();
    expect(btn.textContent?.trim()).toBe('Yes');
    await user.click(btn);
    await waitFor(() => {
      expect(getListingToggle().textContent?.trim()).toBe('No');
    });
    const call = getInvokeCalls().find((c) => c.cmd === 'set_modpack_listing');
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ name: 'My Pack', public: false });
    expect(screen.getByText('Hidden from Browse Modpacks')).toBeInTheDocument();
  });

  it('ListingToggle: button is disabled while set_modpack_listing is in flight (blocks re-clicks)', async () => {
    let resolveListing!: () => void;
    registerInvokeHandler(
      'set_modpack_listing',
      () => new Promise<void>((res) => { resolveListing = () => res(); }),
    );
    const user = await renderInSuccessWithVisibility('private');
    const btn = getListingToggle();
    await user.click(btn);
    // While busy, the button is disabled. Use a loud lookup, then
    // assert it is the same node (no re-mount races) and is disabled.
    await waitFor(() => {
      expect(getListingToggle()).toBeDisabled();
    });
    // Label hasn't flipped yet (state updates only on resolve).
    expect(getListingToggle().textContent?.trim()).toBe('No');
    // Resolve the in-flight call and verify the toggle settles.
    resolveListing();
    await waitFor(() => {
      expect(getListingToggle().textContent?.trim()).toBe('Yes');
    });
    expect(getListingToggle()).not.toBeDisabled();
  });

  it('ListingToggle: setModpackListing rejection surfaces "Failed: …" toast and keeps prior label', async () => {
    registerInvokeHandler('set_modpack_listing', () => {
      throw new Error('rate limit');
    });
    const user = await renderInSuccessWithVisibility('private');
    const btn = getListingToggle();
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/Failed: rate limit/)).toBeInTheDocument();
    });
    // Label stays "No" — failure doesn't flip the optimistic state.
    expect(getListingToggle().textContent?.trim()).toBe('No');
    expect(getListingToggle()).not.toBeDisabled();
  });

  it('ListingToggle: non-Error rejection is stringified into the failure toast', async () => {
    registerInvokeHandler('set_modpack_listing', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'offline';
    });
    const user = await renderInSuccessWithVisibility('private');
    const btn = getListingToggle();
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/Failed: offline/)).toBeInTheDocument();
    });
  });
});
