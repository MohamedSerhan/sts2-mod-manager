export const THEME_STORAGE_KEY = 'sts2mm-theme';

export type ThemeMode = 'dark' | 'light';
export type ThemePreference = ThemeMode | 'auto';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';
const THEME_PREFERENCES: readonly string[] = ['dark', 'light', 'auto'];
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isSupportedThemePreference(value: string | null): value is ThemePreference {
  return value !== null && THEME_PREFERENCES.includes(value);
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadThemePreference(storage: Storage | undefined = getStorage()): ThemePreference {
  if (!storage) return DEFAULT_THEME_PREFERENCE;
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isSupportedThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage write must not crash the theme selector.
  }
}

export function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveThemePreference(preference: ThemePreference): ThemeMode {
  if (preference === 'auto') return prefersLight() ? 'light' : 'dark';
  return preference;
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = mode;
}
