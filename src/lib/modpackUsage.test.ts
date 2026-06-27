import { beforeEach, describe, expect, it } from 'vitest';

import {
  getModpackUsage,
  getModpackLastLaunch,
  recordModpackLaunch,
  renameModpackUsage,
  forgetModpackUsage,
  recentModpacks,
} from './modpackUsage';

const STORAGE_KEY = 'sts2mm-modpack-launches';

describe('modpackUsage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records a launch and reads it back', () => {
    recordModpackLaunch('Alpha');
    const map = getModpackUsage();
    expect(typeof map['Alpha']).toBe('number');
    expect(map['Alpha']).toBeGreaterThan(0);
  });

  it('records stable ids and clears matching legacy name history', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Alpha: 1234 }));
    recordModpackLaunch({ id: 'profile-alpha', name: 'Alpha' });
    const map = getModpackUsage();
    expect(map['profile-alpha']).toBeGreaterThan(1234);
    expect(map.Alpha).toBeUndefined();
  });

  it('records by name when a stable id is absent and ignores blank subjects', () => {
    recordModpackLaunch({ id: null, name: 'NameOnly' });
    recordModpackLaunch('');
    const map = getModpackUsage();
    expect(typeof map.NameOnly).toBe('number');
    expect(map['']).toBeUndefined();
  });

  it('resolves launch timestamps from stable ids and legacy names', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'profile-alpha': 3000,
      Beta: 2000,
    }));
    expect(getModpackLastLaunch({ id: 'profile-alpha', name: 'Alpha' })).toBe(3000);
    expect(getModpackLastLaunch({ id: 'profile-beta', name: 'Beta' })).toBe(2000);
    expect(getModpackLastLaunch({ id: 'profile-gamma', name: 'Gamma' })).toBe(0);
  });

  it('recentModpacks orders newest-first and filters to existing packs', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ Old: 1000, New: 3000, Mid: 2000, Ghost: 4000 }),
    );
    // Ghost was deleted outside the app — it must not surface.
    expect(recentModpacks(['Old', 'New', 'Mid'], 10)).toEqual(['New', 'Mid', 'Old']);
  });

  it('recentModpacks respects the limit', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ A: 1, B: 2, C: 3 }));
    expect(recentModpacks(['A', 'B', 'C'], 2)).toEqual(['C', 'B']);
  });

  it('recentModpacks resolves id-keyed and legacy name-keyed profile history', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'profile-alpha': 3000,
      Beta: 2000,
      Ghost: 9000,
    }));
    expect(recentModpacks([
      { id: 'profile-alpha', name: 'Alpha' },
      { id: 'profile-beta', name: 'Beta' },
    ], 10)).toEqual(['Alpha', 'Beta']);
  });

  it('rename carries the timestamp to the new name', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Before: 1234 }));
    renameModpackUsage('Before', 'After');
    const map = getModpackUsage();
    expect(map['After']).toBe(1234);
    expect(map['Before']).toBeUndefined();
  });

  it('rename of an untracked pack is a no-op', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Other: 1 }));
    renameModpackUsage('Untracked', 'Whatever');
    expect(getModpackUsage()).toEqual({ Other: 1 });
  });

  it('forget removes the entry', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Doomed: 1, Kept: 2 }));
    forgetModpackUsage('Doomed');
    expect(getModpackUsage()).toEqual({ Kept: 2 });
  });

  it('forget removes both stable id and legacy name entries', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'profile-doomed': 10,
      Doomed: 1,
      Kept: 2,
    }));
    forgetModpackUsage({ id: 'profile-doomed', name: 'Doomed' });
    expect(getModpackUsage()).toEqual({ Kept: 2 });
  });

  it('ignores an object subject with no usable id or name', () => {
    recordModpackLaunch({ id: null, name: '' });
    expect(getModpackUsage()).toEqual({});
  });

  it('reads zero for an object subject with no usable keys', () => {
    expect(getModpackLastLaunch({ id: '', name: '' })).toBe(0);
  });

  it('corrupt storage degrades to empty history instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json {{{');
    expect(getModpackUsage()).toEqual({});
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['array', 'not', 'map']));
    expect(getModpackUsage()).toEqual({});
    // Non-numeric timestamps are dropped, numeric ones survive.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ Good: 5, Bad: 'yesterday' }));
    expect(getModpackUsage()).toEqual({ Good: 5 });
  });
});
