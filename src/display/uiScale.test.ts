import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_SCALE,
  MIN_UI_SCALE,
  MAX_UI_SCALE,
  UI_SCALE_STORAGE_KEY,
  applyUiScale,
  clampUiScale,
  loadUiScale,
  saveUiScale,
} from './uiScale';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--ui-scale');
});

describe('ui scale', () => {
  it('clamps out-of-range and non-finite values, rounding to 2dp', () => {
    expect(clampUiScale(0.5)).toBe(MIN_UI_SCALE);
    expect(clampUiScale(3)).toBe(MAX_UI_SCALE);
    expect(clampUiScale(1.25)).toBe(1.25);
    expect(clampUiScale(Number.NaN)).toBe(DEFAULT_UI_SCALE);
  });

  it('defaults to 1 and round-trips a saved value', () => {
    expect(loadUiScale()).toBe(DEFAULT_UI_SCALE);
    saveUiScale(1.2);
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.2');
    expect(loadUiScale()).toBe(1.2);
  });

  it('clamps an out-of-range stored value on load', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '9');
    expect(loadUiScale()).toBe(MAX_UI_SCALE);
  });

  it('falls back to the default on an unparseable stored value', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, 'huge');
    expect(loadUiScale()).toBe(DEFAULT_UI_SCALE);
  });

  it('applyUiScale sets the --ui-scale custom property', () => {
    applyUiScale(1.3);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.3');
  });

  it('applyUiScale clears the property at the default scale', () => {
    applyUiScale(1.3);
    applyUiScale(1);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('applyUiScale is a no-op without a document', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(() => applyUiScale(1.2)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('load degrades to default when storage reads throw', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => {},
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as unknown as Storage;
    expect(loadUiScale(hostile)).toBe(DEFAULT_UI_SCALE);
  });

  it('save degrades when storage writes throw', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as unknown as Storage;
    expect(() => saveUiScale(1.2, hostile)).not.toThrow();
  });

  it('treats absent localStorage as no storage', () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(loadUiScale()).toBe(DEFAULT_UI_SCALE);
      expect(() => saveUiScale(1.2)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats storage as unavailable when accessing localStorage throws', () => {
    // Privacy modes can make even *touching* localStorage throw. getStorage()
    // must catch that so load/save degrade to the default instead of crashing.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('localStorage access blocked'); },
    });
    try {
      expect(loadUiScale()).toBe(DEFAULT_UI_SCALE);
      expect(() => saveUiScale(1.2)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});
