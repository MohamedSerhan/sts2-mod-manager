import { getStorage } from '../lib/safeStorage';

export const UI_SCALE_STORAGE_KEY = 'sts2mm-ui-scale';

export const DEFAULT_UI_SCALE = 1;
export const MIN_UI_SCALE = 0.8;
export const MAX_UI_SCALE = 1.5;
/** Slider granularity, expressed as a scale factor (5%). */
export const UI_SCALE_STEP = 0.05;

const UI_SCALE_VAR = '--ui-scale';

/** Clamp to [MIN, MAX], round to 2 decimal places, default on non-finite. */
export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_SCALE;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, rounded));
}

export function loadUiScale(storage: Storage | undefined = getStorage()): number {
  if (!storage) return DEFAULT_UI_SCALE;
  try {
    const raw = storage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null) return DEFAULT_UI_SCALE;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clampUiScale(parsed) : DEFAULT_UI_SCALE;
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function saveUiScale(
  value: number,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_SCALE_STORAGE_KEY, String(clampUiScale(value)));
  } catch {
    // A blocked storage write must not crash the scale control.
  }
}

/**
 * Apply the scale by driving the `--ui-scale` custom property on the root
 * element; styles.css consumes it via `:root { zoom: var(--ui-scale, 1) }`.
 * Clearing the property at the default keeps the DOM clean (no inline zoom).
 */
export function applyUiScale(value: number): void {
  if (typeof document === 'undefined') return;
  const scale = clampUiScale(value);
  const root = document.documentElement;
  if (scale === DEFAULT_UI_SCALE) {
    root.style.removeProperty(UI_SCALE_VAR);
  } else {
    root.style.setProperty(UI_SCALE_VAR, String(scale));
  }
}
