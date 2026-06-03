import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';
import { THEME_STORAGE_KEY } from './theme';

function Probe() {
  const { preference, mode, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="pref">{preference}</span>
      <button onClick={() => setPreference('light')}>light</button>
      <button onClick={() => setPreference('auto')}>auto</button>
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

  it('throws when useTheme is used outside a provider', () => {
    function Bare() { useTheme(); return null; }
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
  });
});
