import { beforeEach, describe, expect, it } from 'vitest';

import {
  getModpackUsage,
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
