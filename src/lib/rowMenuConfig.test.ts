// src/lib/rowMenuConfig.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ROW_MENU_CONFIG,
  DEFAULT_ROW_MENU_ORDER,
  ROW_MENU_STORAGE_KEY,
  loadRowMenuConfig,
  moveItem,
  normalizeConfig,
  resolveRowMenuOrder,
  saveRowMenuConfig,
  toggleHidden,
  type RowMenuItemId,
} from './rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

describe('normalizeConfig', () => {
  it('returns the default config for null/garbage input', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_ROW_MENU_CONFIG);
    expect(normalizeConfig('nope')).toEqual(DEFAULT_ROW_MENU_CONFIG);
    expect(normalizeConfig({})).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('drops unknown ids and de-dupes, then appends missing known ids in default order', () => {
    const out = normalizeConfig({ order: ['freeze', 'freeze', 'bogus', 'copyVersion'], hidden: [] });
    // freeze + copyVersion kept (first occurrence, in given order), rest appended in default order
    expect(out.order[0]).toBe('freeze');
    expect(out.order[1]).toBe('copyVersion');
    expect([...out.order].sort()).toEqual([...DEFAULT_ROW_MENU_ORDER].sort());
    expect(new Set(out.order).size).toBe(DEFAULT_ROW_MENU_ORDER.length);
  });

  it('clamps hidden to known customizable ids', () => {
    const out = normalizeConfig({ order: [...DEFAULT_ROW_MENU_ORDER], hidden: ['freeze', 'delete', 'bogus'] });
    expect(out.hidden).toEqual(['freeze']); // 'delete' is locked, 'bogus' unknown
  });
});

describe('moveItem', () => {
  it('moves an item from one index to another immutably', () => {
    const order: RowMenuItemId[] = ['copyVersion', 'openFolder', 'freeze'];
    const moved = moveItem(order, 2, 0);
    expect(moved).toEqual(['freeze', 'copyVersion', 'openFolder']);
    expect(order).toEqual(['copyVersion', 'openFolder', 'freeze']); // original untouched
  });

  it('returns the same order when indices are out of range', () => {
    const order: RowMenuItemId[] = ['copyVersion', 'openFolder'];
    expect(moveItem(order, -1, 5)).toEqual(order);
  });
});

describe('toggleHidden', () => {
  it('adds then removes an id from hidden', () => {
    const a = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'freeze');
    expect(a.hidden).toContain('freeze');
    const b = toggleHidden(a, 'freeze');
    expect(b.hidden).not.toContain('freeze');
  });

  it('ignores locked ids (delete/customize are not RowMenuItemId — guard at runtime)', () => {
    // @ts-expect-error locked id is not assignable; guard must no-op
    const out = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'delete');
    expect(out.hidden).toEqual(DEFAULT_ROW_MENU_CONFIG.hidden);
  });
});

describe('resolveRowMenuOrder', () => {
  it('returns ordered ids minus hidden, minus unavailable', () => {
    const cfg = { order: ['copyVersion', 'freeze', 'openFolder'] as RowMenuItemId[], hidden: ['freeze'] as RowMenuItemId[] };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']); // freeze unavailable AND hidden
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['copyVersion', 'openFolder']);
  });

  it('preserves the user order for available, visible ids', () => {
    const cfg = { order: ['openFolder', 'copyVersion'] as RowMenuItemId[], hidden: [] as RowMenuItemId[] };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']);
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['openFolder', 'copyVersion']);
  });
});

describe('load/save', () => {
  it('persists and reloads a config', () => {
    const cfg = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'autoDetect');
    saveRowMenuConfig(cfg);
    expect(loadRowMenuConfig()).toEqual(cfg);
  });

  it('returns default when storage is empty or malformed', () => {
    expect(loadRowMenuConfig()).toEqual(DEFAULT_ROW_MENU_CONFIG);
    localStorage.setItem(ROW_MENU_STORAGE_KEY, '{not json');
    expect(loadRowMenuConfig()).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('never throws when storage is unavailable', () => {
    expect(() => saveRowMenuConfig(DEFAULT_ROW_MENU_CONFIG, undefined)).not.toThrow();
    expect(loadRowMenuConfig(undefined)).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });
});
