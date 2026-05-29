import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { openUrl } from '@tauri-apps/plugin-opener';

import { DiagnosticBundle } from './DiagnosticBundle';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';

/**
 * "Report a bug" modal (reworked from the old support bundle). Builds a
 * redacted text report and either copies it or opens a prefilled GitHub
 * issue. jsdom 27 clipboard gotcha handled via setClipboard().
 */
let clipboardSpy: ReturnType<typeof vi.fn>;

function setClipboard(impl: (text: string) => Promise<void> = async () => {}) {
  clipboardSpy = vi.fn(impl);
  const proto = navigator.clipboard ? Object.getPrototypeOf(navigator.clipboard) : null;
  if (proto && 'writeText' in proto) {
    Object.defineProperty(proto, 'writeText', {
      value: clipboardSpy,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardSpy },
      configurable: true,
    });
  }
  return clipboardSpy;
}

beforeEach(() => {
  setClipboard();
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
});

function Wrap(props: Partial<React.ComponentProps<typeof DiagnosticBundle>> = {}) {
  return (
    <AllProviders>
      <DiagnosticBundle open={props.open ?? true} onClose={props.onClose ?? (() => {})} />
    </AllProviders>
  );
}

function getCopyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Copy report/i }) as HTMLButtonElement;
}

function getOpenButton(): HTMLButtonElement {
  // Primary action — "Open bug report on GitHub", or "Working…" mid-flight.
  const btn = screen
    .getAllByRole('button')
    .find((b) => /Open bug report|Working/i.test(b.textContent ?? ''));
  expect(btn, 'Open bug report button must be in the DOM').toBeDefined();
  return btn as HTMLButtonElement;
}

describe('<DiagnosticBundle> (Report a bug)', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the title, the describe field, and the action buttons', async () => {
    render(<Wrap />);
    expect(screen.getByText('Report a bug')).toBeInTheDocument();
    expect(screen.getByText('What happened?')).toBeInTheDocument();
    expect(getOpenButton()).toBeInTheDocument();
    expect(getCopyButton()).toBeInTheDocument();
  });

  it('Close (X) button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await user.click(screen.getAllByTitle(/Close/i)[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('foot "Close" button also calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    const footClose = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.trim() === 'Close');
    expect(footClose, 'foot Close button must exist').toBeDefined();
    await user.click(footClose!);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop calls onClose, but body clicks do not', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Wrap onClose={onClose} />);
    const backdrop = container.querySelector('.gf-modal-back') as HTMLElement;
    const modal = container.querySelector('.gf-modal') as HTMLElement;
    await user.click(modal);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Copy report builds + copies the redacted report and toasts success', async () => {
    const writeText = setClipboard(async () => {});
    registerInvokeHandler('read_log_tail', () => 'line A\nline B');
    registerInvokeHandler('get_log_path', () => 'C:\\Users\\me\\AppData\\sts2mm.log');

    render(<Wrap />);
    fireEvent.click(getCopyButton());

    const ta = await screen.findByDisplayValue(/STS2 Mod Manager — Bug Report/);
    expect((ta as HTMLTextAreaElement).value).toContain('C:\\Users\\<redacted>');
    expect((ta as HTMLTextAreaElement).value).toContain('line A');
    expect((ta as HTMLTextAreaElement).value).toContain('line B');

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0] as string).toContain('Bug Report');
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeInTheDocument();
    });
  });

  it('includes the typed description in the report', async () => {
    registerInvokeHandler('read_log_tail', () => 'L');
    registerInvokeHandler('get_log_path', () => '/p.log');
    const user = userEvent.setup();
    render(<Wrap />);
    await user.type(
      screen.getByPlaceholderText(/what did you do/i),
      'crashed right after launch',
    );
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toContain('--- What happened ---');
    expect(ta.value).toContain('crashed right after launch');
  });

  it('uses the "no description" placeholder when the field is empty', async () => {
    registerInvokeHandler('read_log_tail', () => 'L');
    registerInvokeHandler('get_log_path', () => '/p.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toContain('(no description provided)');
  });

  it('falls back to an info toast when clipboard.writeText rejects', async () => {
    setClipboard(async () => { throw new Error('blocked'); });
    registerInvokeHandler('read_log_tail', () => 'hello');
    registerInvokeHandler('get_log_path', () => '/tmp/log.txt');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    await waitFor(() => {
      expect(screen.getByText(/scroll the preview to copy manually/i)).toBeInTheDocument();
    });
    expect(await screen.findByDisplayValue(/Bug Report/)).toBeInTheDocument();
  });

  it('toasts an error when report construction throws', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      Object.defineProperty(
        { enabled: true, version: '1.0', pinned: false, github_url: null, nexus_url: null, folder_name: null },
        'name',
        { get() { throw new Error('poisoned-mod'); }, enumerable: true },
      ),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/1 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getCopyButton());
    await waitFor(() => {
      expect(screen.getByText(/Couldn't build the report/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/poisoned-mod/)).toBeInTheDocument();
  });

  it('un-checking the redact toggle leaves home paths un-redacted', async () => {
    registerInvokeHandler('read_log_tail', () => 'tail');
    registerInvokeHandler('get_log_path', () => 'C:\\Users\\alice\\app.log');
    const user = userEvent.setup();
    render(<Wrap />);
    const checkbox = screen.getByRole('checkbox', { name: /Redact home-folder/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toContain('C:\\Users\\alice');
    expect(ta.value).not.toContain('<redacted>');
  });

  it('"Open bug report" (no upload endpoint) copies the full report and opens a clean paste-me issue', async () => {
    // No upload_bug_report handler → the command resolves null (endpoint not
    // configured for this build). We must NOT stuff the full report into the
    // issue URL (GitHub would truncate the logs). Instead the full report goes
    // to the clipboard and the prefilled issue stays short, asking the
    // reporter to paste — so nothing is lost.
    const writeText = setClipboard(async () => {});
    registerInvokeHandler('read_log_tail', () => 'GH body');
    registerInvokeHandler('get_log_path', () => '/x.log');
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getOpenButton());

    // Full report copied to the clipboard…
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0] as string).toContain('STS2 Mod Manager — Bug Report');

    // …and the prefilled issue is the SHORT paste-me body, not a report dump.
    expect(openUrl).toHaveBeenCalledTimes(1);
    const url = vi.mocked(openUrl).mock.calls[0][0] as string;
    expect(url).toMatch(/^https:\/\/github\.com\/MohamedSerhan\/sts2-mod-manager\/issues\/new\?/);
    const body = new URL(url).searchParams.get('body') ?? '';
    expect(body).toContain('clipboard'); // the paste instruction
    expect(body).not.toContain('--- Log tail'); // not the report dump
    expect(body).not.toContain('Truncated to fit GitHub issue URL limits');
    await waitFor(() => {
      expect(screen.getByText(/copied the full report/i)).toBeInTheDocument();
    });
  });

  it('"Open bug report" caps the issue URL only as a last resort (clipboard unavailable)', async () => {
    // When the clipboard is also unavailable we can't ask the reporter to
    // paste, so the report goes into the issue body — and THEN GitHub's URL
    // limit truncates it. This is the last-resort branch.
    setClipboard(async () => { throw new Error('blocked'); });
    registerInvokeHandler('read_log_tail', () => 'x'.repeat(12000));
    registerInvokeHandler('get_log_path', () => '/x.log');
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getOpenButton());
    const url = vi.mocked(openUrl).mock.calls[0][0] as string;
    expect(url.length).toBeLessThanOrEqual(3900);
    expect(new URL(url).searchParams.get('body')).toContain('Truncated to fit GitHub issue URL limits');
    await waitFor(() => {
      expect(screen.getByText(/review and submit it/i)).toBeInTheDocument();
    });
  });

  it('"Open bug report" surfaces a toast when the opener rejects', async () => {
    registerInvokeHandler('read_log_tail', () => 'GH body');
    registerInvokeHandler('get_log_path', () => '/x.log');
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('no browser'));
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getOpenButton());
    expect(await screen.findByText(/no browser/)).toBeInTheDocument();
  });

  it('"Open bug report" uploads the report and links it (no truncation) when the endpoint is configured', async () => {
    // The maintainer endpoint stores the FULL report and returns a view
    // URL; the issue body then just links it, so nothing is truncated — and
    // the user needs no token.
    registerInvokeHandler('read_log_tail', () => 'x'.repeat(12000)); // long → would truncate
    registerInvokeHandler('get_log_path', () => '/x.log');
    registerInvokeHandler('upload_bug_report', () => 'https://reports.example.dev/r/abc123');
    const user = userEvent.setup();
    render(<Wrap />);
    // A typed description flows into the issue body (redacted) alongside
    // the link — covers the "has description" branch.
    await user.type(screen.getByRole('textbox'), 'crash on launch');
    await user.click(getOpenButton());

    expect(openUrl).toHaveBeenCalledTimes(1);
    const url = vi.mocked(openUrl).mock.calls[0][0] as string;
    const body = new URL(url).searchParams.get('body') ?? '';
    // The body carries the user's note + links the uploaded report, and is
    // NOT the truncated full log.
    expect(body).toContain('crash on launch');
    expect(body).toContain('https://reports.example.dev/r/abc123');
    expect(body).not.toContain('Truncated to fit GitHub issue URL limits');
    await waitFor(() => {
      expect(screen.getByText(/full report attached/i)).toBeInTheDocument();
    });
  });

  it('"Open bug report" falls back to clipboard + a clean paste-me issue when the upload throws', async () => {
    // Covers the catch around uploadBugReport: a thrown error (vs a null
    // return) lands on the same lossless fallback — full report to clipboard,
    // short paste-me issue body.
    registerInvokeHandler('read_log_tail', () => 'GH body');
    registerInvokeHandler('get_log_path', () => '/x.log');
    registerInvokeHandler('upload_bug_report', () => { throw new Error('endpoint not configured'); });
    const writeText = setClipboard(async () => {});
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getOpenButton());

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0] as string).toContain('STS2 Mod Manager — Bug Report');
    const url = vi.mocked(openUrl).mock.calls[0][0] as string;
    const body = new URL(url).searchParams.get('body') ?? '';
    expect(body).toContain('clipboard');
    expect(body).not.toContain('--- Log tail');
  });

  it('shows the game version / not-detected status from AppContext', async () => {
    render(<Wrap />);
    const gameRow = (await screen.findByText('Game version')).closest('.gf-diag-item');
    expect(gameRow).not.toBeNull();
    expect(within(gameRow as HTMLElement).getByText(/not detected/i)).toBeInTheDocument();
  });

  it('uses a readonly textarea for the preview', async () => {
    registerInvokeHandler('read_log_tail', () => 'X');
    registerInvokeHandler('get_log_path', () => '/p.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = await screen.findByDisplayValue(/Bug Report/);
    expect(ta).toHaveAttribute('readOnly');
  });

  it('swallows log read failures (empty log + <unknown> source)', async () => {
    registerInvokeHandler('read_log_tail', () => { throw new Error('disk-gone'); });
    registerInvokeHandler('get_log_path', () => { throw new Error('no-path'); });
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toContain('<log empty>');
    expect(ta.value).toContain('Source: <unknown>');
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeInTheDocument();
    });
  });

  it('renders enabled/frozen/links/disabled mods in the report', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'Alpha', version: '1.0', enabled: true, pinned: true, folder_name: 'Alpha', github_url: 'https://github.com/x/a', nexus_url: null },
      { name: 'Beta', version: '2.0', enabled: false, pinned: false, folder_name: 'Beta', github_url: null, nexus_url: 'https://nexusmods.com/b' },
    ]);
    registerInvokeHandler('read_log_tail', () => 'tail');
    registerInvokeHandler('get_log_path', () => '/p.log');
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/2 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toMatch(/✓ Alpha 1\.0 \[frozen\] <https:\/\/github\.com\/x\/a>/);
    expect(ta.value).toMatch(/✗ Beta 2\.0 <https:\/\/nexusmods\.com\/b>/);
  });

  it('includes game version + active modpack load order, and omits the game path', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'D:\\Steam\\steamapps\\common\\STS2',
      mods_path: 'D:\\Steam\\steamapps\\common\\STS2\\Mods',
      disabled_mods_path: null,
      mods_count: 3,
      disabled_count: 1,
      valid: true,
      game_version: '0.105.0',
    }));
    registerInvokeHandler('get_active_profile', () => 'My Build');
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'Core', version: '1.2', enabled: true, pinned: false, folder_name: 'Core', github_url: 'https://github.com/x/core', nexus_url: null },
    ]);
    registerInvokeHandler('list_profiles_cmd', () => [
      {
        name: 'My Build',
        game_version: '0.105.0',
        created_by: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        mods: [
          { name: 'Core', version: '1.2', source: null, hash: null, files: [], enabled: true, bundle_url: null, folder_name: 'Core', mod_id: 'Core' },
        ],
      },
    ]);
    registerInvokeHandler('read_log_tail', () => '');
    registerInvokeHandler('get_log_path', () => '/p.log');

    render(<Wrap />);
    await waitFor(() => {
      const row = screen.getByText('Game version').closest('.gf-diag-item') as HTMLElement;
      expect(within(row).getByText('0.105.0')).toBeInTheDocument();
    });
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).toContain('Game version: 0.105.0');
    expect(ta.value).toContain('Detected: true');
    expect(ta.value).toContain('Mods on disk: 3 (1 disabled)');
    expect(ta.value).toContain('Name: My Build');
    // Load order section with the manifest order + cross-referenced link.
    expect(ta.value).toContain('--- Load order (top loads first) ---');
    expect(ta.value).toMatch(/1\. Core 1\.2 <https:\/\/github\.com\/x\/core>/);
    // The full game install path is NOT included (privacy).
    expect(ta.value).not.toContain('D:\\Steam');
  });

  it('catches non-Error throw values (String(e) branch)', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      Object.defineProperty(
        { enabled: true, version: '1.0', pinned: false, github_url: null, nexus_url: null, folder_name: null },
        'name',
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        { get(): string { throw 'plain-string-throw'; }, enumerable: true },
      ),
    ]);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/1 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getCopyButton());
    await waitFor(() => {
      expect(screen.getByText(/plain-string-throw/)).toBeInTheDocument();
    });
  });

  it('shows "Working…" and disables the actions while a report builds', async () => {
    let resolveLog!: (s: string) => void;
    registerInvokeHandler('read_log_tail', () => new Promise<string>((res) => { resolveLog = res; }));
    registerInvokeHandler('get_log_path', () => '/p.log');
    render(<Wrap />);
    fireEvent.click(getOpenButton());
    await waitFor(() => {
      expect(getOpenButton()).toBeDisabled();
    });
    expect(getOpenButton().textContent).toMatch(/Working/);
    resolveLog('done');
    await waitFor(() => expect(openUrl).toHaveBeenCalled());
  });

  it('redacts classic GitHub PATs (ghp_…)', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    registerInvokeHandler('read_log_tail', () => `Authorization: Bearer ${token}\nother line`);
    registerInvokeHandler('get_log_path', () => '/x.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).not.toContain(token);
    expect(ta.value).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(ta.value).toContain('other line');
  });

  it('redacts gho_/ghu_ tokens too', async () => {
    const ghoToken = 'gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ghuToken = 'ghu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    registerInvokeHandler('read_log_tail', () => `a=${ghoToken} b=${ghuToken}`);
    registerInvokeHandler('get_log_path', () => '/x.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).not.toContain(ghoToken);
    expect(ta.value).not.toContain(ghuToken);
    expect((ta.value.match(/\[REDACTED_GITHUB_TOKEN\]/g) ?? []).length).toBe(2);
  });

  it('redacts fine-grained PATs (github_pat_…)', async () => {
    const pat = 'github_pat_' + 'A'.repeat(82);
    registerInvokeHandler('read_log_tail', () => `secret=${pat}`);
    registerInvokeHandler('get_log_path', () => '/x.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).not.toContain(pat);
    expect(ta.value).toContain('[REDACTED_GITHUB_PAT]');
  });

  it('redacts query-string secret values but keeps the key name', async () => {
    registerInvokeHandler(
      'read_log_tail',
      () => 'GET https://api.example.com/items?api_key=abc123xyz&page=2\n' +
            'GET https://x.test/?ACCESS_TOKEN=BIGSECRET&z=1',
    );
    registerInvokeHandler('get_log_path', () => '/x.log');
    render(<Wrap />);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).not.toContain('abc123xyz');
    expect(ta.value).not.toContain('BIGSECRET');
    expect(ta.value).toContain('api_key=[REDACTED]');
    expect(ta.value).toMatch(/ACCESS_TOKEN=\[REDACTED\]/i);
    expect(ta.value).toContain('page=2');
    expect(ta.value).toContain('z=1');
  });

  it('redacts the user sts2mm-profiles repo owner but keeps public mod links', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'CoolMod', version: '1.0', enabled: true, pinned: false, folder_name: 'CoolMod', github_url: 'https://github.com/author/coolmod', nexus_url: null },
    ]);
    registerInvokeHandler('read_log_tail', () => 'pushed manifest to https://github.com/alice/sts2mm-profiles done');
    registerInvokeHandler('get_log_path', () => '/x.log');
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/1 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    // The user's own sharing repo owner is scrubbed.
    expect(ta.value).toContain('github.com/<redacted>/sts2mm-profiles');
    expect(ta.value).not.toContain('github.com/alice/sts2mm-profiles');
    // A public mod source link is intentionally kept for triage.
    expect(ta.value).toContain('github.com/author/coolmod');
  });

  it('token redaction runs even when redactPaths is OFF', async () => {
    const token = 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    registerInvokeHandler('read_log_tail', () => `Bearer ${token}`);
    registerInvokeHandler('get_log_path', () => 'C:\\Users\\alice\\app.log');
    const user = userEvent.setup();
    render(<Wrap />);
    const checkbox = screen.getByRole('checkbox', { name: /Redact home-folder/i }) as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    fireEvent.click(getCopyButton());
    const ta = (await screen.findByDisplayValue(/Bug Report/)) as HTMLTextAreaElement;
    expect(ta.value).not.toContain(token);
    expect(ta.value).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(ta.value).toContain('C:\\Users\\alice');
  });
});
