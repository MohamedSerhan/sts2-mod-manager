import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUTO_ADD_INSTALLS_TO_MODPACK_KEY,
  loadAutoAddInstallsToModpack,
  saveAutoAddInstallsToModpack,
} from './installPolicy';

describe('install policy preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps new installs in the Mod Library by default', () => {
    expect(loadAutoAddInstallsToModpack()).toBe(false);
  });

  it('persists a disabled auto-add preference', () => {
    saveAutoAddInstallsToModpack(false);

    expect(localStorage.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY)).toBe('false');
    expect(loadAutoAddInstallsToModpack()).toBe(false);
  });

  it('persists an enabled auto-add preference', () => {
    localStorage.setItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY, 'false');

    saveAutoAddInstallsToModpack(true);

    expect(localStorage.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY)).toBe('true');
    expect(loadAutoAddInstallsToModpack()).toBe(true);
  });

  it('uses explicit storage when provided', () => {
    const storage = window.sessionStorage;
    storage.clear();

    saveAutoAddInstallsToModpack(true, storage);

    expect(storage.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY)).toBe('true');
    expect(localStorage.getItem(AUTO_ADD_INSTALLS_TO_MODPACK_KEY)).toBeNull();
    expect(loadAutoAddInstallsToModpack(storage)).toBe(true);
  });

  it('falls back to library-only when browser storage is unavailable', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });

    try {
      expect(loadAutoAddInstallsToModpack()).toBe(false);
      expect(() => saveAutoAddInstallsToModpack(false)).not.toThrow();
    } finally {
      if (originalStorage) {
        Object.defineProperty(window, 'localStorage', originalStorage);
      }
    }
  });
});
