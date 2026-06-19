import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LogsViewer } from './LogsViewer';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';

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
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
});

function Wrap() {
  return (
    <AllProviders>
      <LogsViewer />
    </AllProviders>
  );
}

const SAMPLE_LOG = [
  '[2026-05-12 10:00:00 INFO sts2_mod_manager_lib] Startup banner',
  '[2026-05-12 10:00:01 WARN sts2_mod_manager_lib] Could not load Nexus key',
  '[2026-05-12 10:00:02 ERROR sts2_mod_manager_lib] Boom — disk write failed',
  '[2026-05-12 10:00:03 DEBUG sts2_mod_manager_lib] Cache hit qa-fixture/test-mod',
].join('\n');

/**
 * Loud button lookup: throws (failing the test) if no button whose
 * accessible name OR title attribute matches the supplied pattern is
 * in the DOM. Replaces the silent-skip `if (btn) { click(btn) }`
 * pattern which would hide regressions.
 */
function getButton(matcher: RegExp): HTMLButtonElement {
  const all = screen.getAllByRole('button') as HTMLButtonElement[];
  const hit = all.find((b) => {
    const text = b.textContent ?? '';
    const title = b.getAttribute('title') ?? '';
    return matcher.test(text) || matcher.test(title);
  });
  if (!hit) {
    const names = all
      .map((b) => `${b.getAttribute('title') ?? ''}::${b.textContent ?? ''}`)
      .join(' | ');
    throw new Error(`No button matched ${matcher}. Visible buttons: ${names}`);
  }
  return hit;
}

describe('<LogsViewer>', () => {
  it('loads the log tail on mount and renders parsed lines', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Could not load Nexus key/)).toBeInTheDocument();
    expect(screen.getByText(/Boom — disk write failed/)).toBeInTheDocument();
    expect(screen.getByText(/Cache hit qa-fixture/)).toBeInTheDocument();
  });

  it('shows game-launch failures from the STS2 log and stores them on request', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    registerInvokeHandler('get_launch_diagnostics', () => ({
      log_path: 'C:/Users/me/AppData/Roaming/SlayTheSpire2/logs/godot.log',
      game_version: '0.107.1',
      failed_mods: [{
        name: 'Miyu_character',
        version: '1.0.0',
        folder_name: 'Miyu_character',
        mod_id: 'Miyu_character',
        reasons: ['reflection_type_load'],
      }],
    }));
    registerInvokeHandler('quarantine_launch_failures', () => ({
      active_profile_id: 'pack-1',
      moved: [{
        name: 'Miyu_character',
        folder_name: 'Miyu_character',
        mod_id: 'Miyu_character',
        destination: 'C:/Games/STS2/mods_disabled/Miyu_character',
      }],
      disabled_profile_entries: [{
        name: 'Miyu_character',
        folder_name: 'Miyu_character',
        mod_id: 'Miyu_character',
        destination: null,
      }],
      failed: [],
    }));
    const user = userEvent.setup();
    render(<Wrap />);

    expect(await screen.findByText(/Last STS2 launch reported 1 mod load error/i)).toBeInTheDocument();
    expect(screen.getByText(/Detected: Miyu_character/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Store failed mods/i }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'quarantine_launch_failures')).toBe(true);
    });
    expect(await screen.findByText(/Stored 1 failed mod/i)).toBeInTheDocument();
  });

  it('Error filter chip narrows visible lines to ERROR only', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    // Loud lookup — Error chip renders as "Error <count>". Must exist.
    const errBtn = getButton(/^Error\s*\d*$/);
    await user.click(errBtn);

    await waitFor(() => {
      expect(screen.queryByText(/Startup banner/)).toBeNull();
    });
    expect(screen.queryByText(/Could not load Nexus key/)).toBeNull();
    expect(screen.queryByText(/Cache hit qa-fixture/)).toBeNull();
    expect(screen.getByText(/Boom — disk write failed/)).toBeInTheDocument();
  });

  it('Refresh button re-reads the log tail', async () => {
    let counter = 0;
    registerInvokeHandler('read_log_tail', () => {
      counter += 1;
      return SAMPLE_LOG;
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(counter).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const refresh = getButton(/Reload/i);
    await user.click(refresh);

    await waitFor(() => {
      expect(counter).toBeGreaterThan(1);
    });
  });

  it('Open button calls open_log_file (success path)', async () => {
    registerInvokeHandler('read_log_tail', () => 'short');
    registerInvokeHandler('open_log_file', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('short')).toBeInTheDocument();
    });

    const openBtn = getButton(/Open log file\/folder/i);
    await user.click(openBtn);

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_log_file')).toBe(true);
    });
  });

  it('Open button shows toast.error when open_log_file rejects', async () => {
    registerInvokeHandler('read_log_tail', () => 'short');
    registerInvokeHandler('open_log_file', () => {
      throw new Error('no shell');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('short')).toBeInTheDocument();
    });

    const openBtn = getButton(/Open log file\/folder/i);
    await user.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't open log: no shell/)).toBeInTheDocument();
    });
  });

  it('shows toast.error when read_log_tail rejects on mount', async () => {
    registerInvokeHandler('read_log_tail', () => {
      throw new Error('disk gone');
    });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to read logs: disk gone/)).toBeInTheDocument();
    });
  });

  it('Copy button writes raw log to clipboard and toasts success', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const spy = setClipboard(async () => {});
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const copy = getButton(/Copy whole log/i);
    await user.click(copy);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(SAMPLE_LOG);
    });
    expect(await screen.findByText(/Log copied to clipboard/)).toBeInTheDocument();
  });

  it('Copy button shows toast.error when clipboard rejects', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    setClipboard(async () => {
      throw new Error('denied');
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const copy = getButton(/Copy whole log/i);
    await user.click(copy);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy: denied/)).toBeInTheDocument();
    });
  });

  it('Send to support opens a GitHub issue URL through the Tauri opener', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const send = getButton(/Send to support/i);
    await user.click(send);

    expect(openUrl).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(openUrl).mock.calls[0];
    expect(String(url)).toContain('github.com/MohamedSerhan/sts2-mod-manager/issues/new');
    // Body should contain an encoded fragment of one of the sample log lines.
    expect(String(url)).toContain(encodeURIComponent('Boom'));
  });

  it('Send to support caps the GitHub issue URL for noisy logs', async () => {
    const noisyLog = Array.from(
      { length: 150 },
      (_, i) => `[2026-05-16 00:${String(i).padStart(2, '0')}:00 INFO sts2] noisy line ${i} ${'x'.repeat(120)}`,
    ).join('\n');
    registerInvokeHandler('read_log_tail', () => noisyLog);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/noisy line 149/)).toBeInTheDocument();
    });

    await user.click(getButton(/Send to support/i));

    const [url] = vi.mocked(openUrl).mock.calls[0];
    const parsed = new URL(String(url));
    expect(String(url).length).toBeLessThanOrEqual(3900);
    expect(parsed.searchParams.get('body')).toContain('Truncated to fit GitHub issue URL limits');
  });

  it('Send to support surfaces a toast when the opener rejects', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('no browser'));
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const send = getButton(/Send to support/i);
    await user.click(send);

    expect(await screen.findByText(/Couldn't open support issue: no browser/)).toBeInTheDocument();
  });

  it('renders empty-log placeholder when read_log_tail returns nothing', async () => {
    registerInvokeHandler('read_log_tail', () => '');
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByText(/Log is empty — actions in the app will appear here/i),
      ).toBeInTheDocument();
    });
  });

  it('shows Close button when onClose prop is provided and invokes it', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AllProviders>
        <LogsViewer onClose={onClose} />
      </AllProviders>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });
    const closeBtn = getButton(/^Close$/);
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw line when parsed text is empty', async () => {
    // A line with only a timestamp — parse() strips the ts and leading
    // separators, leaving text==='', so the renderer's `l.text || l.raw`
    // fallback (line 175) takes the `l.raw` branch.
    registerInvokeHandler('read_log_tail', () => '[2026-05-12 10:00:00]');
    render(<Wrap />);
    await waitFor(() => {
      // The raw timestamp string should appear via the fallback branch.
      expect(screen.getByText('[2026-05-12 10:00:00]')).toBeInTheDocument();
    });
  });

  it('stringifies non-Error rejection from read_log_tail', async () => {
    registerInvokeHandler('read_log_tail', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain-string-failure';
    });
    render(<Wrap />);
    await waitFor(() => {
      expect(
        screen.getByText(/Failed to read logs: plain-string-failure/),
      ).toBeInTheDocument();
    });
  });

  it('stringifies non-Error rejection from clipboard', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    setClipboard(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'nope';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });
    const copy = getButton(/Copy whole log/i);
    await user.click(copy);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't copy: nope/)).toBeInTheDocument();
    });
  });

  it('stringifies non-Error rejection from open_log_file', async () => {
    registerInvokeHandler('read_log_tail', () => 'short');
    registerInvokeHandler('open_log_file', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'shell-busted';
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('short')).toBeInTheDocument();
    });
    const openBtn = getButton(/Open log file\/folder/i);
    await user.click(openBtn);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open log: shell-busted/)).toBeInTheDocument();
    });
  });

  it('free-text filter input narrows visible lines', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/Filter messages/i);
    expect(input).toBeInTheDocument();
    await user.type(input, 'Nexus');

    await waitFor(() => {
      expect(screen.queryByText(/Startup banner/)).toBeNull();
    });
    expect(screen.queryByText(/Boom — disk write failed/)).toBeNull();
    expect(screen.queryByText(/Cache hit qa-fixture/)).toBeNull();
    expect(screen.getByText(/Could not load Nexus key/)).toBeInTheDocument();
  });

  it('"Send feedback" opens the Nexus Posts page (no GitHub needed)', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send feedback' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
    expect(opened).toHaveLength(1);
    expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
  });
});
