import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyTheme,
  isSupportedThemePreference,
  loadThemePreference,
  prefersLight,
  resolveThemePreference,
  saveThemePreference,
} from './theme';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('theme preference', () => {
  it('recognises only dark/light/auto', () => {
    expect(isSupportedThemePreference('dark')).toBe(true);
    expect(isSupportedThemePreference('light')).toBe(true);
    expect(isSupportedThemePreference('auto')).toBe(true);
    expect(isSupportedThemePreference('french')).toBe(false);
    expect(isSupportedThemePreference(null)).toBe(false);
  });

  it('defaults to dark and round-trips a saved preference', () => {
    expect(loadThemePreference()).toBe(DEFAULT_THEME_PREFERENCE);
    saveThemePreference('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(loadThemePreference()).toBe('light');
  });

  it('falls back to dark on an invalid stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'rainbow');
    expect(loadThemePreference()).toBe('dark');
  });

  it('resolves explicit modes verbatim', () => {
    expect(resolveThemePreference('dark')).toBe('dark');
    expect(resolveThemePreference('light')).toBe('light');
  });

  it('resolves auto from prefers-color-scheme', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    expect(prefersLight()).toBe(true);
    expect(resolveThemePreference('auto')).toBe('light');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    expect(resolveThemePreference('auto')).toBe('dark');
  });

  it('applyTheme writes the data-theme attribute', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
