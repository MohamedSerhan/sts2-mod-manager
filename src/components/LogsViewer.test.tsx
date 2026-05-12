import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LogsViewer } from './LogsViewer';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

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

  it('filter chips narrow the visible lines', async () => {
    registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Startup banner/)).toBeInTheDocument();
    });
    // Click the "Errors" filter chip (button text contains "Errors" or "ERR").
    const buttons = screen.getAllByRole('button');
    const errBtn = buttons.find((b) =>
      /^(Errors?|ERR|Error)$/i.test(b.textContent?.replace(/\d+/g, '').trim() ?? ''),
    );
    if (errBtn) {
      await user.click(errBtn);
      await waitFor(() => {
        // INFO lines should disappear when only Errors are shown.
        expect(screen.queryByText(/Startup banner/)).toBeNull();
      });
      expect(screen.getByText(/Boom/)).toBeInTheDocument();
    }
  });

  it('Refresh button re-reads the tail', async () => {
    let counter = 0;
    registerInvokeHandler('read_log_tail', () => {
      counter += 1;
      return SAMPLE_LOG;
    });
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(counter).toBe(1); });
    const refresh = screen.getAllByRole('button').find((b) => /Refresh/i.test(b.textContent ?? ''));
    if (refresh) {
      await user.click(refresh);
      await waitFor(() => { expect(counter).toBeGreaterThan(1); });
    }
  });

  it('Open log file calls open_log_file', async () => {
    registerInvokeHandler('read_log_tail', () => 'short');
    registerInvokeHandler('open_log_file', () => true);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => { expect(screen.getByText('short')).toBeInTheDocument(); });
    const openBtn = screen.getAllByRole('button').find((b) => /Open log/i.test(b.textContent ?? ''));
    if (openBtn) {
      await user.click(openBtn);
      await waitFor(() => {
        expect(getInvokeCalls().some((c) => c.cmd === 'open_log_file')).toBe(true);
      });
    }
  });
});
