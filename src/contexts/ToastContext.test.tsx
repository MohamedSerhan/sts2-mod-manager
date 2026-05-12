import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ToastProvider, useToast } from './ToastContext';

/**
 * The toast system has three load-bearing behaviors:
 *   1. success / error / info / sticky variants render the right icon
 *      and live-region role for screen readers.
 *   2. Non-sticky toasts auto-dismiss after 4s (success/info) or 6s
 *      (error). Sticky toasts wait for `dismiss(id)`.
 *   3. Dismiss button fades them out before unmount.
 *
 * Timer-driven behavior is tested with vi.useFakeTimers so the test
 * suite doesn't sit waiting for real animations.
 */

function ToastTrigger({
  fire,
}: {
  fire: (t: ReturnType<typeof useToast>) => void;
}) {
  const t = useToast();
  return (
    <button onClick={() => fire(t)}>fire</button>
  );
}

describe('<ToastProvider> + useToast', () => {
  it('renders a success toast inside the polite live region', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastTrigger fire={(t) => t.success('Saved')} />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toContain('Saved');
  });

  it('renders an error toast inside the assertive (alert) live region', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastTrigger fire={(t) => t.error('Boom')} />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert.textContent).toContain('Boom');
  });

  it('renders info via the generic toast() method', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastTrigger fire={(t) => t.toast('Hello')} />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('lets the caller dismiss a toast via the returned id', async () => {
    const user = userEvent.setup();
    let lastId = -1;
    render(
      <ToastProvider>
        <ToastTrigger
          fire={(t) => {
            lastId = t.sticky('Click Slow Download on Nexus');
          }}
        />
        <DismissAction id={() => lastId} />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    expect(screen.getByText('Click Slow Download on Nexus')).toBeInTheDocument();
    await user.click(screen.getByText('dismiss'));
    expect(screen.queryByText('Click Slow Download on Nexus')).toBeNull();
  });

  // Timer-driven tests use fireEvent (synchronous) instead of userEvent
  // because user-event's async machinery doesn't compose cleanly with
  // vi.useFakeTimers() — it ends up waiting on real microtasks while we
  // advance the fake clock, and the test stalls.

  it('manual dismiss button fades the toast out and unmounts after the fade', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <ToastTrigger fire={(t) => t.info('A note')} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      // Animation-frame schedules the entry transition — advance past it
      // so the toast is in its steady visible state.
      act(() => {
        vi.advanceTimersByTime(30);
      });
      expect(screen.getByText('A note')).toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Dismiss'));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByText('A note')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-dismisses success toasts after ~4s', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <ToastTrigger fire={(t) => t.success('Saved')} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      act(() => { vi.advanceTimersByTime(3500); });
      expect(screen.getByText('Saved')).toBeInTheDocument();

      // Cross the 4s dismiss threshold — schedules the fade.
      act(() => { vi.advanceTimersByTime(600); });
      // React re-renders, the [leaving] effect schedules the 250ms unmount.
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByText('Saved')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-dismisses errors after 6s (longer than success)', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <ToastTrigger fire={(t) => t.error('Boom')} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByText('Boom')).toBeInTheDocument();

      // Cross the 6s threshold — schedules the fade.
      act(() => { vi.advanceTimersByTime(1100); });
      // Then advance past the 250ms fade unmount.
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByText('Boom')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sticky toasts never auto-dismiss', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <ToastTrigger fire={(t) => t.sticky('Waiting for download…')} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByText('Waiting for download…')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('useToast throws clearly when used without a provider', () => {
    const Boom = () => {
      try {
        useToast();
      } catch (e) {
        return <div>caught: {(e as Error).message}</div>;
      }
      return null;
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      render(<Boom />);
    } finally {
      console.error = origErr;
    }
    expect(screen.getByText(/caught: useToast/)).toBeInTheDocument();
  });
});

function DismissAction({ id }: { id: () => number }) {
  const t = useToast();
  return (
    <button onClick={() => t.dismiss(id())}>dismiss</button>
  );
}
