import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from './sidebarWidth';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('sidebar width', () => {
  it('clamps to the min/max and rounds to an integer', () => {
    expect(clampSidebarWidth(50)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('defaults to 248 and round-trips a saved width', () => {
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(248);
    saveSidebarWidth(300);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('300');
    expect(loadSidebarWidth()).toBe(300);
  });

  it('clamps an out-of-range stored width on load', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '9999');
    expect(loadSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('falls back to the default on a non-numeric stored value', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'wide');
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('degrades when storage throws', () => {
    const hostile = {
      getItem: () => { throw new Error('x'); },
      setItem: () => { throw new Error('x'); },
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as unknown as Storage;
    expect(loadSidebarWidth(hostile)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(() => saveSidebarWidth(300, hostile)).not.toThrow();
  });
});
