// src/lib/rowMenuConfig.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ROW_MENU_CONFIG,
  DEFAULT_ROW_MENU_ORDER,
  ROW_MENU_OPEN_EVENT,
  ROW_MENU_STORAGE_KEY,
  loadRowMenuConfig,
  moveItem,
  normalizeConfig,
  resolveRowMenuOrder,
  saveRowMenuConfig,
  setShowCustomizeEntry,
  toggleHidden,
  type RowMenuItemId,
} from './rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

describe('constants', () => {
  it('ROW_MENU_OPEN_EVENT has the canonical value', () => {
    expect(ROW_MENU_OPEN_EVENT).toBe('sts2mm:open-row-menu-settings');
  });
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

  it('defaults showCustomizeEntry to true for legacy stored configs (order/hidden only)', () => {
    const out = normalizeConfig({ order: [...DEFAULT_ROW_MENU_ORDER], hidden: [] });
    expect(out.showCustomizeEntry).toBe(true);
  });

  it('preserves an explicit showCustomizeEntry: false', () => {
    const out = normalizeConfig({ order: [...DEFAULT_ROW_MENU_ORDER], hidden: [], showCustomizeEntry: false });
    expect(out.showCustomizeEntry).toBe(false);
  });

  it('treats any non-false showCustomizeEntry value as true', () => {
    expect(normalizeConfig({ showCustomizeEntry: 'nope' }).showCustomizeEntry).toBe(true);
    expect(normalizeConfig({ showCustomizeEntry: true }).showCustomizeEntry).toBe(true);
    expect(normalizeConfig({ showCustomizeEntry: null }).showCustomizeEntry).toBe(true);
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

  it('returns an equal array when from === to', () => {
    const order: RowMenuItemId[] = ['copyVersion', 'openFolder'];
    expect(moveItem([...order], 0, 0)).toEqual([...order]);
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
    const cfg = { order: ['copyVersion', 'freeze', 'openFolder'] as RowMenuItemId[], hidden: ['freeze'] as RowMenuItemId[], showCustomizeEntry: true };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']); // freeze unavailable AND hidden
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['copyVersion', 'openFolder']);
  });

  it('preserves the user order for available, visible ids', () => {
    const cfg = { order: ['openFolder', 'copyVersion'] as RowMenuItemId[], hidden: [] as RowMenuItemId[], showCustomizeEntry: true };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']);
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['openFolder', 'copyVersion']);
  });
});

describe('setShowCustomizeEntry', () => {
  it('pure-updates showCustomizeEntry without mutating the input', () => {
    const off = setShowCustomizeEntry(DEFAULT_ROW_MENU_CONFIG, false);
    expect(off.showCustomizeEntry).toBe(false);
    expect(DEFAULT_ROW_MENU_CONFIG.showCustomizeEntry).toBe(true);

    const on = setShowCustomizeEntry(off, true);
    expect(on.showCustomizeEntry).toBe(true);
  });
});

describe('load/save', () => {
  it('persists and reloads a config', () => {
    const cfg = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'autoDetect');
    saveRowMenuConfig(cfg);
    expect(loadRowMenuConfig()).toEqual(cfg);
  });

  it('round-trips showCustomizeEntry through save/load', () => {
    const cfg = setShowCustomizeEntry(DEFAULT_ROW_MENU_CONFIG, false);
    saveRowMenuConfig(cfg);
    expect(loadRowMenuConfig().showCustomizeEntry).toBe(false);
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
