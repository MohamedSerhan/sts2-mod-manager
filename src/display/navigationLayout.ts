import { getStorage } from '../lib/safeStorage';

export type NavigationLayout = 'sidebar' | 'topbar';

export const NAVIGATION_LAYOUT_STORAGE_KEY = 'sts2mm-navigation-layout';
export const NAVIGATION_LAYOUT_CHANGE_EVENT = 'sts2mm:navigation-layout-change';
export const DEFAULT_NAVIGATION_LAYOUT: NavigationLayout = 'topbar';

export function isNavigationLayout(value: unknown): value is NavigationLayout {
  return value === 'sidebar' || value === 'topbar';
}

export function loadNavigationLayout(
  storage: Storage | undefined = getStorage(),
): NavigationLayout {
  if (!storage) return DEFAULT_NAVIGATION_LAYOUT;
  try {
    const raw = storage.getItem(NAVIGATION_LAYOUT_STORAGE_KEY);
    return isNavigationLayout(raw) ? raw : DEFAULT_NAVIGATION_LAYOUT;
  } catch {
    return DEFAULT_NAVIGATION_LAYOUT;
  }
}

export function saveNavigationLayout(
  value: NavigationLayout,
  storage: Storage | undefined = getStorage(),
): void {
  if (storage) {
    try {
      storage.setItem(NAVIGATION_LAYOUT_STORAGE_KEY, value);
    } catch {
      // A blocked storage write must not crash the Settings view.
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NAVIGATION_LAYOUT_CHANGE_EVENT, { detail: { value } }));
  }
}
