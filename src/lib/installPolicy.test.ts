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

  it('preserves current behavior by default', () => {
    expect(loadAutoAddInstallsToModpack()).toBe(true);
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
});
