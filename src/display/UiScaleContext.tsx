import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyUiScale, clampUiScale, loadUiScale, saveUiScale } from './uiScale';

interface UiScaleContextValue {
  /** Current scale factor (1 = 100%). */
  scale: number;
  /** Set a new factor; clamped to the supported range. */
  setScale: (scale: number) => void;
}

const UiScaleContext = createContext<UiScaleContextValue | null>(null);

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<number>(() => loadUiScale());

  // Validate at the boundary so callers can't push an out-of-range factor
  // through the raw setter (mirrors ThemeContext's guard).
  function setScale(next: number): void {
    setScaleState(clampUiScale(next));
  }

  // Apply + persist on every change, including the initial mount.
  useEffect(() => {
    applyUiScale(scale);
    saveUiScale(scale);
  }, [scale]);

  return (
    <UiScaleContext.Provider value={{ scale, setScale }}>
      {children}
    </UiScaleContext.Provider>
  );
}

export function useUiScale(): UiScaleContextValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error('useUiScale must be used within a UiScaleProvider');
  return ctx;
}
