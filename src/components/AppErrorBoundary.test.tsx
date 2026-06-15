import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary, RendererErrorReporter } from './AppErrorBoundary';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

function BrokenChild(): ReactElement {
  throw new Error('row render exploded after update');
}

describe('AppErrorBoundary', () => {
  it('renders children normally before an error happens', () => {
    render(
      <AppErrorBoundary
        title="The mod manager hit a display error"
        body="Reload to continue."
        reloadLabel="Reload app"
      >
        <div>Library is visible</div>
      </AppErrorBoundary>,
    );

    expect(screen.getByText('Library is visible')).toBeInTheDocument();
  });

  it('renders a recovery panel and logs the render error instead of blanking the app', async () => {
    registerInvokeHandler('log_frontend_error', () => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(
        <AppErrorBoundary
          title="The mod manager hit a display error"
          body="Reload to continue."
          reloadLabel="Reload app"
        >
          <BrokenChild />
        </AppErrorBoundary>,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(screen.getByRole('alert')).toHaveTextContent('The mod manager hit a display error');
    expect(screen.getByRole('button', { name: /Reload app/i })).toBeInTheDocument();

    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'log_frontend_error');
      expect(call?.args?.message).toContain('row render exploded after update');
      expect(call?.args?.message).toContain('[react.render]');
    });
  });

  it('logs global renderer errors that happen outside React render', async () => {
    registerInvokeHandler('log_frontend_error', () => undefined);
    render(<RendererErrorReporter />);

    fireEvent(
      window,
      new ErrorEvent('error', { error: new Error('async listener exploded') }),
    );

    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', {
      value: new Error('promise exploded'),
    });
    fireEvent(window, rejection);

    await waitFor(() => {
      const messages = getInvokeCalls()
        .filter((c) => c.cmd === 'log_frontend_error')
        .map((c) => String(c.args?.message ?? ''));
      expect(messages.some((m) => m.includes('[window.error]') && m.includes('async listener exploded'))).toBe(true);
      expect(messages.some((m) => m.includes('[window.unhandledrejection]') && m.includes('promise exploded'))).toBe(true);
    });
  });

  it('logs string-only browser errors and circular rejection payloads', async () => {
    registerInvokeHandler('log_frontend_error', () => undefined);
    render(<RendererErrorReporter />);

    fireEvent(
      window,
      new ErrorEvent('error', { message: 'script failed before error object existed' }),
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: circular });
    fireEvent(window, rejection);

    await waitFor(() => {
      const messages = getInvokeCalls()
        .filter((c) => c.cmd === 'log_frontend_error')
        .map((c) => String(c.args?.message ?? ''));
      expect(messages.some((m) => m.includes('script failed before error object existed'))).toBe(true);
      expect(messages.some((m) => m.includes('[object Object]'))).toBe(true);
    });
  });

  it('swallows frontend-log failures so crash reporting cannot recurse', async () => {
    registerInvokeHandler('log_frontend_error', () => {
      throw new Error('logger unavailable');
    });
    render(<RendererErrorReporter />);

    fireEvent(window, new ErrorEvent('error', { error: new Error('original crash') }));

    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'log_frontend_error')).toBe(true);
    });
  });

  it('logs render errors even when React does not provide stack details', async () => {
    registerInvokeHandler('log_frontend_error', () => undefined);
    const error = new Error('message-only render failure');
    error.stack = '';
    const boundary = new AppErrorBoundary({
      title: 'Title',
      body: 'Body',
      reloadLabel: 'Reload',
      children: null,
    });

    boundary.componentDidCatch(error, { componentStack: null } as never);

    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'log_frontend_error');
      expect(call?.args?.message).toContain('message-only render failure');
    });
  });
});
