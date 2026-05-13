import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiagnosticBundle } from './DiagnosticBundle';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';

/**
 * jsdom 27 gotcha: when jsdom exposes a real Clipboard prototype, a
 * `defineProperty` on `navigator.clipboard` itself is shadowed by the
 * proto getter. Install on the proto when present; otherwise fall back
 * to defining `navigator.clipboard` directly.
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
});

function Wrap(props: Partial<React.ComponentProps<typeof DiagnosticBundle>> = {}) {
  return (
    <AllProviders>
      <DiagnosticBundle open={props.open ?? true} onClose={props.onClose ?? (() => {})} />
    </AllProviders>
  );
}

function getGenerateButton(): HTMLButtonElement {
  // The primary action button shows "Generate bundle" before generation
  // and "Re-generate" afterwards; both end with the same text family.
  const btn = screen
    .getAllByRole('button')
    .find((b) => /Generate bundle|Re-generate|Generating/i.test(b.textContent ?? ''));
  expect(btn, 'Generate/Re-generate button must be in the DOM').toBeDefined();
  return btn as HTMLButtonElement;
}

describe('<DiagnosticBundle>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the modal title + generate + close buttons', async () => {
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getAllByText(/Generate/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Generate support bundle')).toBeInTheDocument();
  });

  it('Close button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getAllByText(/Generate/i).length).toBeGreaterThan(0);
    });
    const close = screen.getAllByTitle(/Close/i)[0];
    await user.click(close);
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

  it('clicking the modal backdrop calls onClose, but body clicks do not', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Wrap onClose={onClose} />);
    const backdrop = container.querySelector('.gf-modal-back') as HTMLElement;
    const modal = container.querySelector('.gf-modal') as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(modal).not.toBeNull();

    // Click inside the modal — stopPropagation should keep onClose silent.
    await user.click(modal);
    expect(onClose).not.toHaveBeenCalled();

    // Click on the backdrop itself — should propagate to onClose.
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Generate copies bundle to clipboard, shows preview, and toasts success', async () => {
    const writeText = setClipboard(async () => {});
    registerInvokeHandler('read_log_tail', () => 'line A\nline B');
    registerInvokeHandler('get_log_path', () => 'C:\\Users\\me\\AppData\\sts2mm.log');

    render(<Wrap />);
    const gen = getGenerateButton();
    // Use fireEvent (not userEvent) — userEvent advances microtasks in a
    // way that races with clipboard promise resolution in jsdom 27.
    fireEvent.click(gen);

    // Preview textarea appears with the bundle content.
    const ta = await screen.findByDisplayValue(/STS2 Mod Manager — Support Bundle/);
    expect(ta).toBeInTheDocument();
    // Redaction is on by default — the username segment must be scrubbed.
    expect((ta as HTMLTextAreaElement).value).toContain('C:\\Users\\<redacted>');
    expect((ta as HTMLTextAreaElement).value).toContain('line A');
    expect((ta as HTMLTextAreaElement).value).toContain('line B');

    // Clipboard was written with the same content.
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const written = writeText.mock.calls[0][0] as string;
    expect(written).toContain('STS2 Mod Manager');
    expect(written).toContain('line A');

    // Success toast appears.
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeInTheDocument();
    });

    // The action button now reads "Re-generate".
    await waitFor(() => {
      expect(getGenerateButton().textContent).toMatch(/Re-generate/);
    });
  });

  it('Re-generate runs generate() a second time', async () => {
    let calls = 0;
    registerInvokeHandler('read_log_tail', () => { calls += 1; return 'L'; });
    registerInvokeHandler('get_log_path', () => '/var/log/app.log');

    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getGenerateButton());
    await screen.findByDisplayValue(/Support Bundle/);
    expect(calls).toBe(1);

    await user.click(getGenerateButton());
    await waitFor(() => expect(calls).toBe(2));
  });

  it('falls back to info toast when clipboard.writeText rejects', async () => {
    setClipboard(async () => { throw new Error('blocked'); });
    registerInvokeHandler('read_log_tail', () => 'hello');
    registerInvokeHandler('get_log_path', () => '/tmp/log.txt');

    render(<Wrap />);
    fireEvent.click(getGenerateButton());

    await waitFor(() => {
      expect(screen.getByText(/scroll the preview to copy manually/i)).toBeInTheDocument();
    });
    // The preview still rendered even though clipboard failed.
    expect(await screen.findByDisplayValue(/Support Bundle/)).toBeInTheDocument();
  });

  it('toasts an error when bundle construction throws (mods.map blows up)', async () => {
    // A poisoned mod object whose `.name` getter throws — `mods.map(...)`
    // inside generate() will propagate the error to the outer catch.
    registerInvokeHandler('get_installed_mods', () => [
      Object.defineProperty(
        { enabled: true, version: '1.0', pinned: false, github_url: null, nexus_url: null },
        'name',
        { get() { throw new Error('poisoned-mod'); }, enumerable: true },
      ),
    ]);

    const user = userEvent.setup();
    render(<Wrap />);

    // Wait until the AppContext has refreshed and surfaced 1 mod.
    await waitFor(() => {
      expect(screen.getByText(/1 entries/)).toBeInTheDocument();
    });

    await user.click(getGenerateButton());

    await waitFor(() => {
      expect(screen.getByText(/Couldn't build bundle/i)).toBeInTheDocument();
    });
    // Error message includes the original Error.message.
    expect(screen.getByText(/poisoned-mod/)).toBeInTheDocument();
  });

  it('un-checking the redact toggle leaves paths un-redacted in the bundle', async () => {
    registerInvokeHandler('read_log_tail', () => 'tail');
    registerInvokeHandler('get_log_path', () => 'C:\\Users\\alice\\app.log');

    const user = userEvent.setup();
    render(<Wrap />);

    const checkbox = screen.getByRole('checkbox', { name: /Redact home-folder/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await user.click(getGenerateButton());
    const ta = await screen.findByDisplayValue(/Support Bundle/);
    // With redaction off, the literal username survives.
    expect((ta as HTMLTextAreaElement).value).toContain('C:\\Users\\alice');
    expect((ta as HTMLTextAreaElement).value).not.toContain('<redacted>');
  });

  it('"Open GitHub issue" button appears after generation and opens a new issue URL', async () => {
    registerInvokeHandler('read_log_tail', () => 'GH body');
    registerInvokeHandler('get_log_path', () => '/x.log');

    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    const user = userEvent.setup();
    render(<Wrap />);

    // Before generating, the GitHub-issue button is not in the DOM.
    expect(screen.queryByRole('button', { name: /Open GitHub issue/i })).toBeNull();

    await user.click(getGenerateButton());
    const ghBtn = await screen.findByRole('button', { name: /Open GitHub issue/i });
    await user.click(ghBtn);

    expect(winOpen).toHaveBeenCalledTimes(1);
    const url = winOpen.mock.calls[0][0] as string;
    expect(url).toMatch(/^https:\/\/github\.com\/MohamedSerhan\/sts2-mod-manager\/issues\/new\?/);
    expect(url).toContain('title=');
    expect(url).toContain('body=');
    // The body is URL-encoded; check for an encoded fragment from the bundle.
    expect(url).toContain(encodeURIComponent('STS2 Mod Manager'));

    winOpen.mockRestore();
  });

  it('shows valid/not-detected game status from AppContext', async () => {
    render(<Wrap />);
    // Safe defaults set valid=false, so the right-aligned status reads "not detected".
    const gameRow = (await screen.findByText('Game info')).closest('.gf-diag-item');
    expect(gameRow).not.toBeNull();
    expect(within(gameRow as HTMLElement).getByText(/not detected/i)).toBeInTheDocument();
  });

  it('uses readonly textarea for the preview (no manual edits possible)', async () => {
    registerInvokeHandler('read_log_tail', () => 'X');
    registerInvokeHandler('get_log_path', () => '/p.log');
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(getGenerateButton());
    const ta = await screen.findByDisplayValue(/Support Bundle/);
    expect(ta).toHaveAttribute('readOnly');
  });

  it('swallows readLogTail + getLogPath rejections (log appears as empty/<unknown>)', async () => {
    registerInvokeHandler('read_log_tail', () => { throw new Error('disk-gone'); });
    registerInvokeHandler('get_log_path', () => { throw new Error('no-path'); });

    render(<Wrap />);
    fireEvent.click(getGenerateButton());

    const ta = await screen.findByDisplayValue(/Support Bundle/) as HTMLTextAreaElement;
    expect(ta.value).toContain('<log empty>');
    expect(ta.value).toContain('Source: <unknown>');
    // Success toast still fires because clipboard write succeeded.
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeInTheDocument();
    });
  });

  it('renders enabled, pinned, github_url, nexus_url, and disabled mods in the bundle', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      {
        name: 'Alpha', version: '1.0', enabled: true, pinned: true,
        github_url: 'https://github.com/x/a', nexus_url: null,
      },
      {
        name: 'Beta', version: '2.0', enabled: false, pinned: false,
        github_url: null, nexus_url: 'https://nexusmods.com/b',
      },
    ]);
    registerInvokeHandler('read_log_tail', () => 'tail');
    registerInvokeHandler('get_log_path', () => '/p.log');

    render(<Wrap />);
    // Wait for AppContext refresh to populate mods.
    await waitFor(() => {
      expect(screen.getByText(/2 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getGenerateButton());

    const ta = await screen.findByDisplayValue(/Support Bundle/) as HTMLTextAreaElement;
    // Enabled tick + pinned marker + github url for Alpha.
    expect(ta.value).toMatch(/✓ Alpha 1\.0 \[pinned\] <https:\/\/github\.com\/x\/a>/);
    // Disabled marker + nexus url for Beta.
    expect(ta.value).toMatch(/✗ Beta 2\.0 <https:\/\/nexusmods\.com\/b>/);
  });

  it('shows "valid" when gameInfo.valid=true and surfaces the game_path in the bundle', async () => {
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'D:\\Steam\\steamapps\\common\\STS2',
      mods_path: 'D:\\Steam\\steamapps\\common\\STS2\\Mods',
      disabled_mods_path: null,
      mods_count: 3,
      disabled_count: 1,
      valid: true,
      game_version: '0.105.0',
    }));
    registerInvokeHandler('detect_game_path', () => ({
      game_path: 'D:\\Steam\\steamapps\\common\\STS2',
      mods_path: null, disabled_mods_path: null,
      mods_count: 3, disabled_count: 1, valid: true, game_version: '0.105.0',
    }));
    registerInvokeHandler('get_active_profile', () => 'My Build');
    registerInvokeHandler('read_log_tail', () => '');
    registerInvokeHandler('get_log_path', () => '/p.log');

    render(<Wrap />);
    // Game-info row shows "valid" once gameInfo.valid flips to true.
    await waitFor(() => {
      const row = screen.getByText('Game info').closest('.gf-diag-item') as HTMLElement;
      expect(within(row).getByText(/^valid$/i)).toBeInTheDocument();
    });
    // Active-profile row shows the profile name.
    expect(within(screen.getByText('Active profile').closest('.gf-diag-item') as HTMLElement)
      .getByText('My Build')).toBeInTheDocument();

    fireEvent.click(getGenerateButton());
    const ta = await screen.findByDisplayValue(/Support Bundle/) as HTMLTextAreaElement;
    expect(ta.value).toContain('Path: D:\\Steam\\steamapps\\common\\STS2');
    expect(ta.value).toContain('Valid: true');
    expect(ta.value).toContain('Mods on disk: 3 (1 disabled)');
    expect(ta.value).toContain('Name: My Build');
    // Empty logs path renders the placeholder.
    expect(ta.value).toContain('<log empty>');
  });

  it('catches non-Error throw values from generate (String(e) branch)', async () => {
    // Throw a string so `e instanceof Error` is false and the
    // `String(e)` branch runs.
    registerInvokeHandler('get_installed_mods', () => [
      Object.defineProperty(
        { enabled: true, version: '1.0', pinned: false, github_url: null, nexus_url: null },
        'name',
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        { get(): string { throw 'plain-string-throw'; }, enumerable: true },
      ),
    ]);

    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/1 entries/)).toBeInTheDocument();
    });
    fireEvent.click(getGenerateButton());

    await waitFor(() => {
      expect(screen.getByText(/plain-string-throw/)).toBeInTheDocument();
    });
  });

  it('shows "Generating…" label and disables the button while a generate is in flight', async () => {
    let resolveLog!: (s: string) => void;
    registerInvokeHandler('read_log_tail', () => new Promise<string>((res) => { resolveLog = res; }));
    registerInvokeHandler('get_log_path', () => '/p.log');

    render(<Wrap />);
    const btn = getGenerateButton();
    fireEvent.click(btn);

    // While busy, the button is disabled and shows the "Generating…" label.
    await waitFor(() => {
      expect(getGenerateButton()).toBeDisabled();
    });
    expect(getGenerateButton().textContent).toMatch(/Generating/);

    resolveLog('done');
    await screen.findByDisplayValue(/Support Bundle/);
    // After resolution the button re-enables.
    expect(getGenerateButton()).not.toBeDisabled();
  });

  it('disables the generate button while a generate is already in flight (re-entrancy UX guard)', async () => {
    // The defensive `if (busy) return;` inside generate() is marked
    // /* v8 ignore */ because it is unreachable via the UI — the
    // button is `disabled={busy}` and React refuses to dispatch onClick
    // to disabled buttons. This test exercises the UX guard (the
    // disabled attribute) so a regression that drops it would fail.
    let logCalls = 0;
    let resolveLog!: (s: string) => void;
    registerInvokeHandler('read_log_tail', () => {
      logCalls += 1;
      return new Promise<string>((res) => { resolveLog = res; });
    });
    registerInvokeHandler('get_log_path', () => '/p.log');

    render(<Wrap />);
    const btn = getGenerateButton();
    fireEvent.click(btn);

    // Wait until React flushed `disabled={busy}`.
    await waitFor(() => expect(btn).toBeDisabled());
    // A second click while the button is disabled is a no-op — React
    // refuses to dispatch onClick, so generate() is never re-entered.
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(logCalls).toBe(1);

    resolveLog('done');
    await screen.findByDisplayValue(/Support Bundle/);
  });
});
