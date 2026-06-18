import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NAVIGATION_LAYOUT,
  loadNavigationLayout,
  NAVIGATION_LAYOUT_CHANGE_EVENT,
  NAVIGATION_LAYOUT_STORAGE_KEY,
  isNavigationLayout,
  saveNavigationLayout,
} from './navigationLayout';

describe('navigation layout preferences', () => {
  it('recognizes only the supported layout values', () => {
    expect(isNavigationLayout('topbar')).toBe(true);
    expect(isNavigationLayout('sidebar')).toBe(true);
    expect(isNavigationLayout('drawer')).toBe(false);
  });

  it('defaults to topbar navigation when storage is empty or invalid', () => {
    expect(loadNavigationLayout(undefined)).toBe(DEFAULT_NAVIGATION_LAYOUT);

    const storage = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    } as Storage;

    storage.set(NAVIGATION_LAYOUT_STORAGE_KEY, 'drawer');
    expect(loadNavigationLayout(mockStorage)).toBe(DEFAULT_NAVIGATION_LAYOUT);

    storage.set(NAVIGATION_LAYOUT_STORAGE_KEY, 'topbar');
    expect(loadNavigationLayout(mockStorage)).toBe('topbar');

    expect(loadNavigationLayout({
      getItem: () => { throw new Error('blocked'); },
    } as unknown as Storage)).toBe(DEFAULT_NAVIGATION_LAYOUT);
  });

  it('loads and saves the sidebar layout choice', () => {
    const storage = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    } as Storage;
    const onLayoutChange = vi.fn();
    window.addEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);

    saveNavigationLayout('sidebar', mockStorage);

    expect(storage.get(NAVIGATION_LAYOUT_STORAGE_KEY)).toBe('sidebar');
    expect(loadNavigationLayout(mockStorage)).toBe('sidebar');
    expect(onLayoutChange).toHaveBeenCalledWith(expect.objectContaining({
      detail: { value: 'sidebar' },
    }));

    window.removeEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);
  });

  it('still broadcasts changes when storage writes are blocked', () => {
    const onLayoutChange = vi.fn();
    window.addEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);

    expect(() => saveNavigationLayout('topbar', {
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage)).not.toThrow();

    expect(onLayoutChange).toHaveBeenCalledWith(expect.objectContaining({
      detail: { value: 'topbar' },
    }));

    window.removeEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);
  });

  it('broadcasts changes even when storage is unavailable', () => {
    const onLayoutChange = vi.fn();
    window.addEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);

    saveNavigationLayout('sidebar', undefined);

    expect(onLayoutChange).toHaveBeenCalledWith(expect.objectContaining({
      detail: { value: 'sidebar' },
    }));

    window.removeEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onLayoutChange);
  });
});
