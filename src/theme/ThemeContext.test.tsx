import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';
import { THEME_STORAGE_KEY, type ThemePreference } from './theme';

function Probe() {
  const { preference, mode, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="pref">{preference}</span>
      <button onClick={() => setPreference('light')}>light</button>
      <button onClick={() => setPreference('auto')}>auto</button>
      {/* Deliberately push an unsupported value to prove the boundary
          guard rejects it (ThemeContext.tsx line 28). The cast mirrors a
          buggy/legacy caller bypassing the type system. */}
      <button onClick={() => setPreference('rainbow' as ThemePreference)}>invalid</button>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('<ThemeProvider>', () => {
  it('defaults to dark and applies data-theme', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists and applies a manual switch to light', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByText('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('initialises from a stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the OS while on auto', async () => {
    const listeners = new Set<() => void>();
    let matches = false;
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() { return matches; },
      media: q,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByText('auto'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    act(() => { matches = true; listeners.forEach((cb) => cb()); });
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    vi.unstubAllGlobals();
  });

  it('rejects an unsupported preference pushed through setPreference', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    // Establish a known-good value first so we can prove the bad write is
    // dropped rather than just falling back to the initial default.
    await user.click(screen.getByText('light'));
    expect(screen.getByTestId('pref')).toHaveTextContent('light');

    await user.click(screen.getByText('invalid'));
    // Guard (line 28) short-circuits: preference, mode, persisted value and
    // the applied attribute all stay on the last valid choice.
    expect(screen.getByTestId('pref')).toHaveTextContent('light');
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves auto to dark and skips the OS listener when matchMedia is unavailable', () => {
    // Boot straight into auto so the system-listener effect runs, but with
    // no matchMedia present. The effect's guard (line 43) must bail before
    // touching window.matchMedia, leaving a clean dark resolution with no
    // crash and no listener registered.
    localStorage.setItem(THEME_STORAGE_KEY, 'auto');
    vi.stubGlobal('matchMedia', undefined);
    try {
      render(<ThemeProvider><Probe /></ThemeProvider>);
      expect(screen.getByTestId('pref')).toHaveTextContent('auto');
      expect(screen.getByTestId('mode')).toHaveTextContent('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws when useTheme is used outside a provider', () => {
    function Bare() { useTheme(); return null; }
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
  });
});
