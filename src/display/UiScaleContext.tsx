import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  applyFontScale,
  applyUiScale,
  clampFontScale,
  clampUiScale,
  loadFontScale,
  loadUiScale,
  saveFontScale,
  saveUiScale,
} from './uiScale';

interface UiScaleContextValue {
  /** Current scale factor (1 = 100%). */
  scale: number;
  /** Set a new factor; clamped to the supported range. */
  setScale: (scale: number) => void;
  /** Current text-only factor (1 = 100%). */
  fontScale: number;
  /** Set a new text factor; clamped to the supported range. */
  setFontScale: (scale: number) => void;
}

const UiScaleContext = createContext<UiScaleContextValue | null>(null);

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<number>(() => loadUiScale());
  const [fontScale, setFontScaleState] = useState<number>(() => loadFontScale());

  // Validate at the boundary so callers can't push an out-of-range factor
  // through the raw setter (mirrors ThemeContext's guard).
  function setScale(next: number): void {
    setScaleState(clampUiScale(next));
  }

  function setFontScale(next: number): void {
    setFontScaleState(clampFontScale(next));
  }

  // Apply + persist on every change, including the initial mount.
  useEffect(() => {
    applyUiScale(scale);
    saveUiScale(scale);
  }, [scale]);

  useEffect(() => {
    applyFontScale(fontScale);
    saveFontScale(fontScale);
  }, [fontScale]);

  return (
    <UiScaleContext.Provider value={{ scale, setScale, fontScale, setFontScale }}>
      {children}
    </UiScaleContext.Provider>
  );
}

export function useUiScale(): UiScaleContextValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error('useUiScale must be used within a UiScaleProvider');
  return ctx;
}
