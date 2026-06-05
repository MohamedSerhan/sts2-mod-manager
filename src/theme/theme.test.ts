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

  it('resolves auto to dark when matchMedia is unavailable', () => {
    // The default/CI path: jsdom has no matchMedia until the suite mocks it,
    // so prefersLight() must fail closed and auto must resolve to dark.
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersLight()).toBe(false);
    expect(resolveThemePreference('auto')).toBe('dark');
  });

  it('applyTheme writes the data-theme attribute', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves auto to dark when matchMedia itself throws', () => {
    // Some sandboxed/embedded webviews expose matchMedia but throw on
    // invocation. prefersLight() must swallow that and fail closed to dark
    // rather than letting the theme selector crash. (theme.ts line 49.)
    vi.stubGlobal('matchMedia', () => {
      throw new Error('matchMedia blocked');
    });
    expect(prefersLight()).toBe(false);
    expect(resolveThemePreference('auto')).toBe('dark');
  });

  it('falls back to dark when reading from storage throws', () => {
    // A storage object whose getItem throws (e.g. quota/security errors)
    // must not propagate — loadThemePreference fails closed to the default.
    // (theme.ts line 28.)
    const hostileStorage = {
      getItem: () => {
        throw new Error('getItem blocked');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(loadThemePreference(hostileStorage)).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it('treats storage as unavailable when localStorage is absent (not just throwing)', () => {
    // getStorage()'s `typeof localStorage === 'undefined'` guard: some
    // embedded/stripped webviews expose no localStorage at all. load/save
    // must degrade to the default rather than crash. (theme.ts line 16.)
    // Restore in finally so the afterEach's localStorage.clear() still works.
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(loadThemePreference()).toBe(DEFAULT_THEME_PREFERENCE);
      expect(() => saveThemePreference('light')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applyTheme is a no-op when there is no document', () => {
    // Guard for non-DOM contexts importing the theme module — applyTheme
    // must early-return instead of touching document. (theme.ts line 59.)
    // Restore document before the test ends so cleanup/afterEach are safe.
    vi.stubGlobal('document', undefined);
    try {
      expect(() => applyTheme('light')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats storage as unavailable when the localStorage global access throws', () => {
    // Privacy modes can make even *touching* `localStorage` throw a
    // SecurityError. getStorage() must catch that and report "no storage",
    // so load/save degrade to the default instead of crashing. Exercising
    // the default-parameter path here also covers theme.ts line 18.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage access blocked');
      },
    });
    try {
      // No explicit storage arg → forces getStorage() → throwing getter.
      expect(loadThemePreference()).toBe(DEFAULT_THEME_PREFERENCE);
      // saveThemePreference must also no-op rather than throw.
      expect(() => saveThemePreference('light')).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});
