import { getStorage } from '../lib/safeStorage';

export const SIDEBAR_WIDTH_STORAGE_KEY = 'sts2mm-sidebar-width';

export const DEFAULT_SIDEBAR_WIDTH = 248;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;
/** Keyboard nudge step (px). */
export const SIDEBAR_WIDTH_STEP = 16;

/** Clamp to [MIN, MAX], round to an integer, default on non-finite. */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

export function loadSidebarWidth(storage: Storage | undefined = getStorage()): number {
  if (!storage) return DEFAULT_SIDEBAR_WIDTH;
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function saveSidebarWidth(
  value: number,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(value)));
  } catch {
    // A blocked storage write must not crash the resize handle.
  }
}
