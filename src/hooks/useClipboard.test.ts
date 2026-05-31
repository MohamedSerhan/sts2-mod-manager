import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useClipboard } from './useClipboard';
import { AllProviders } from '../__test__/providers';

/**
 * jsdom 27 gotcha: when jsdom exposes a real Clipboard prototype, a
 * `defineProperty` on `navigator.clipboard` itself is shadowed by the
 * proto getter. Install on the proto when present; otherwise fall back
 * to defining `navigator.clipboard` directly. (Same shape as the
 * DiagnosticBundle test — kept in sync intentionally so any future
 * jsdom upgrade only requires one fix here + one there.)
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
  vi.useRealTimers();
});

describe('useClipboard', () => {
  it('writes text to clipboard, flips copied state, and returns true', async () => {
    const write = setClipboard();
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });

    expect(result.current.copied).toBeNull();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.copy('hello world', 'value');
    });

    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledWith('hello world');
    expect(result.current.copied).toBe('value');
  });

  it('clears `copied` after the reset timer fires', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(
      () => useClipboard({ resetMs: 500 }),
      { wrapper: AllProviders },
    );

    await act(async () => {
      await result.current.copy('abc', 'code');
    });
    expect(result.current.copied).toBe('code');

    // Advance past the reset window.
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(result.current.copied).toBeNull();
  });

  it('uses the i18n `common.copied` toast by default', async () => {
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.copy('text', 'k');
    });

    // The default success toast is the i18n string "Copied!". Verifying
    // it lands in the DOM (the ToastProvider renders into document.body)
    // confirms the toast key resolved through react-i18next.
    await waitFor(() => {
      expect(document.body.textContent).toContain('Copied!');
    });
  });

  it('honours a caller-supplied successMessage', async () => {
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });
    await act(async () => {
      await result.current.copy('text', 'k', { successMessage: 'Share code copied' });
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('Share code copied');
    });
  });

  it('suppresses the toast when successMessage=null', async () => {
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });
    await act(async () => {
      await result.current.copy('text', 'k', { successMessage: null });
    });
    // `copied` still flips even with no toast — surfaces with their own
    // visual feedback (PublishModal) want the highlight without a
    // duplicate toast on top.
    expect(result.current.copied).toBe('k');
    // No toast text appeared.
    expect(document.body.textContent).not.toContain('Copied!');
  });

  it('shows the failure toast (with error tail) when writeText throws', async () => {
    setClipboard(async () => { throw new Error('blocked by policy'); });
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.copy('text', 'k');
    });
    expect(ok).toBe(false);
    // `copied` never flipped — failure path doesn't mark the row green.
    expect(result.current.copied).toBeNull();

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Couldn't copy to clipboard/i);
    });
    expect(document.body.textContent).toContain('blocked by policy');
  });

  it('handles a non-Error throw value (String(e) branch)', async () => {
    // Throw a plain string — `e instanceof Error` is false, so the
    // fallback `String(e)` path runs.
    setClipboard(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain-string';
    });
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });

    await act(async () => {
      await result.current.copy('text');
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('plain-string');
    });
  });

  it('resets the timer when copy() is called twice in quick succession', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(
      () => useClipboard({ resetMs: 1000 }),
      { wrapper: AllProviders },
    );

    await act(async () => {
      await result.current.copy('first', 'a');
    });
    expect(result.current.copied).toBe('a');

    // Advance partially, then copy again — the prior timer must NOT
    // fire and clear the new `copied` state.
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    await act(async () => {
      await result.current.copy('second', 'b');
    });
    // First timer would have fired in another 200ms; the new one
    // started fresh and lasts a full 1000ms.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.copied).toBe('b');

    // Past the new timer's window — clear.
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.copied).toBeNull();
  });

  it('uses default kind="value" when caller omits the argument', async () => {
    const { result } = renderHook(() => useClipboard(), { wrapper: AllProviders });
    await act(async () => {
      await result.current.copy('hi');
    });
    expect(result.current.copied).toBe('value');
  });
});
