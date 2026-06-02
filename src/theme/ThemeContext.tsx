import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  applyTheme,
  isSupportedThemePreference,
  loadThemePreference,
  resolveThemePreference,
  saveThemePreference,
  type ThemeMode,
  type ThemePreference,
} from './theme';

interface ThemeContextValue {
  preference: ThemePreference;
  mode: ThemeMode;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadThemePreference());
  const [mode, setMode] = useState<ThemeMode>(() => resolveThemePreference(loadThemePreference()));

  // Validate at the boundary so a consumer can't push an unsupported value
  // through the raw state setter (mirrors how language.ts guards its setter).
  function setPreference(next: ThemePreference): void {
    if (!isSupportedThemePreference(next)) return;
    setPreferenceState(next);
  }

  // Apply + persist on every preference change.
  useEffect(() => {
    const resolved = resolveThemePreference(preference);
    setMode(resolved);
    applyTheme(resolved);
    saveThemePreference(preference);
  }, [preference]);

  // While following the OS, react to live light/dark flips.
  useEffect(() => {
    if (preference !== 'auto') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(LIGHT_QUERY);
    const onChange = () => {
      const resolved = resolveThemePreference('auto');
      setMode(resolved);
      applyTheme(resolved);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference]);

  return (
    <ThemeContext.Provider value={{ preference, mode, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
